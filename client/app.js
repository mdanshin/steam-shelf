import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';

import { currentDeals, normalizeSyncSnapshot, validApiKey, validSteamId } from './core.js';
import { createGatewaySync } from './gateway.js';
import { beginSessionTransition, captureSession, isCurrentSession, transitionForCredentialReplacement, transitionForDisconnect } from './session.js';
import { createIndexedDbStorage, createVault } from './vault.js';

const $ = (selector) => document.querySelector(selector);
const config = window.STEAM_SHELF_FIREBASE_CONFIG;
const state = { user: null, vault: null, credentials: null, controller: null, view: 'library', query: '', sort: 'playtime', catalogs: new Map(), epoch: 0 };
const viewMeta = {
  library: { title: 'Библиотека', kicker: 'МОЯ КОЛЛЕКЦИЯ', empty: 'Откройте настройки и подключите Steam.', sorts: [['playtime','По времени в игре'],['recent','Недавно запущенные'],['name','По названию']] },
  wishlist: { title: 'Желаемое', kicker: 'СПИСОК ЖЕЛАНИЙ', empty: 'Синхронизируйте публичный wishlist.', sorts: [['date','Сначала добавленные недавно'],['discount','По размеру скидки'],['savings','По экономии'],['price','Сначала дешевле']] },
  deals: { title: 'Скидки', kicker: 'STEAM SPECIALS', empty: 'Снимок скидок ещё не опубликован.', sorts: [['savings','По экономии'],['discount','По размеру скидки']] },
  settings: { title: 'Настройки', kicker: 'ЛОКАЛЬНЫЕ ДАННЫЕ', empty: '', sorts: [] },
};
let auth;
let syncSteam;

function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function flash(message, error = false) { const box = $('#flash'); box.textContent = message; box.classList.toggle('error', error); box.hidden = false; clearTimeout(flash.timer); flash.timer = setTimeout(() => { box.hidden = true; }, 6000); }
function money(minor) { return Number.isInteger(minor) ? new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(minor / 100) : 'Цена недоступна'; }
function playtime(minutes) { if (!minutes) return 'Не запускалась'; return minutes < 60 ? `${minutes} мин.` : `${Math.round(minutes / 60)} ч.`; }
function coverUrl(game) { return `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${game.appid}/header.jpg`; }

function card(game) {
  const article = element('article', 'game-card');
  const image = element('img', 'game-cover'); image.src = coverUrl(game); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.addEventListener('error', () => image.removeAttribute('src'));
  const body = element('div', 'game-body');
  const title = element('h2', 'game-title'); const link = element('a', '', game.name || `Steam App ${game.appid}`); link.href = `https://store.steampowered.com/app/${game.appid}/`; link.target = '_blank'; link.rel = 'noopener noreferrer'; title.append(link); body.append(title);
  if (state.view === 'library') {
    const meta = element('div', 'game-meta'); meta.append(element('span', '', `Всего: ${playtime(game.playtimeForever)}`), element('span', '', game.lastPlayedAt ? new Date(game.lastPlayedAt * 1000).toLocaleDateString('ru-RU') : 'Не запускалась')); body.append(meta);
  } else {
    const prices = element('div', 'game-price');
    if (game.discountPercent > 0) prices.append(element('span', 'discount', `−${game.discountPercent}%`));
    if (Number.isInteger(game.originalPriceMinor) && game.originalPriceMinor !== game.priceMinor) prices.append(element('span', 'old-price', money(game.originalPriceMinor)));
    prices.append(element('span', 'price', money(game.priceMinor))); body.append(prices);
    if (Number.isInteger(game.savingsMinor) && game.savingsMinor > 0) body.append(element('div', 'saving', `Экономия ${money(game.savingsMinor)}`));
  }
  article.append(image, body); return article;
}

function sorted(items) {
  const copy = [...items]; const mode = state.sort;
  const compare = (a, b, field, direction = -1) => { const left = Number.isFinite(a[field]) ? a[field] : null; const right = Number.isFinite(b[field]) ? b[field] : null; if (left === null && right !== null) return 1; if (left !== null && right === null) return -1; return left === right ? String(a.name).localeCompare(String(b.name), 'ru') : direction * (left - right); };
  if (mode === 'name') return copy.sort((a,b) => String(a.name).localeCompare(String(b.name), 'ru'));
  if (mode === 'recent') return copy.sort((a,b) => compare(a,b,'lastPlayedAt'));
  if (mode === 'playtime') return copy.sort((a,b) => compare(a,b,'playtimeForever'));
  if (mode === 'date') return copy.sort((a,b) => compare(a,b,'dateAdded'));
  if (mode === 'price') return copy.sort((a,b) => compare(a,b,'priceMinor',1));
  if (mode === 'discount') return copy.sort((a,b) => compare(a,b,'discountPercent'));
  return copy.sort((a,b) => compare(a,b,'savingsMinor'));
}

function renderCatalog() {
  const data = state.catalogs.get(state.view) || { games: [], syncedAt: null };
  const query = state.query.trim().toLocaleLowerCase('ru');
  const available = state.view === 'deals' ? currentDeals(data.games || []) : (data.games || []);
  const games = sorted(available.filter((game) => !query || String(game.name).toLocaleLowerCase('ru').includes(query)));
  $('#catalog').replaceChildren(...games.slice(0, 600).map(card));
  $('#summary').replaceChildren(element('span', '', `${games.length} из ${available.length}`), element('span', '', data.syncedAt ? `Обновлено ${new Date(data.syncedAt).toLocaleString('ru-RU')}` : 'Ещё не синхронизировано'));
  $('#empty').hidden = games.length > 0; $('#empty-title').textContent = query ? 'Ничего не найдено' : 'Здесь пока пусто'; $('#empty-text').textContent = query ? 'Попробуйте изменить запрос.' : viewMeta[state.view].empty;
}

async function loadView(view) {
  state.view = viewMeta[view] ? view : 'library'; const requested = state.view; const epoch = state.epoch; const meta = viewMeta[requested];
  document.querySelectorAll('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === requested));
  $('#section-title').textContent = meta.title; $('#section-kicker').textContent = meta.kicker; $('#settings-panel').hidden = requested !== 'settings'; $('#catalog-toolbar').hidden = requested === 'settings'; $('#catalog').hidden = requested === 'settings'; $('#summary').hidden = requested === 'settings'; $('#empty').hidden = true; $('#onboarding').hidden = Boolean(state.credentials) || requested === 'settings' || requested === 'deals';
  if (requested === 'settings') return;
  const sort = $('#sort'); sort.replaceChildren(...meta.sorts.map(([value,label]) => { const option = element('option','',label); option.value=value; return option; })); state.sort = meta.sorts[0][0]; $('#sync').hidden = requested === 'deals';
  if (!state.catalogs.has(requested)) {
    const snapshot = requested === 'deals' ? await import('./deals-data.js').then(({ dealsCatalog, dealsSyncedAt }) => ({ games: dealsCatalog, syncedAt: dealsSyncedAt })) : await state.vault.snapshot(requested);
    if (epoch !== state.epoch || requested !== state.view) return;
    state.catalogs.set(requested, snapshot || { games: [], syncedAt: null });
  }
  renderCatalog();
}

async function requestSync(resource, credentials, session) {
  const request = { resource, steamId: credentials.steamId };
  if (resource === 'library') request.apiKey = credentials.apiKey;
  const result = await syncSteam(request, { signal: session.signal, expectedUid: session.uid });
  return normalizeSyncSnapshot(resource, result);
}

async function syncCurrent() {
  const session = captureSession(state);
  if (!session?.credentials) { location.hash = '#settings'; return; }
  const resource = state.view; if (!['library', 'wishlist'].includes(resource)) return;
  const button = $('#sync'); button.disabled = true; button.textContent = 'Синхронизация…';
  try {
    const snapshot = await requestSync(resource, session.credentials, session); if (!isCurrentSession(state, session)) return; await session.vault.saveSnapshot(resource, snapshot); if (!isCurrentSession(state, session)) return; state.catalogs.set(resource, snapshot); if (state.view === resource) renderCatalog(); flash('Данные Steam обновлены.');
  } catch (error) { if (isCurrentSession(state, session)) flash(error.message || 'Синхронизация не выполнена.', true); }
  finally { if (isCurrentSession(state, session)) { button.disabled = false; button.textContent = 'Обновить'; } }
}

async function showUser(user, epoch) {
  const vault = createVault(user.uid, createIndexedDbStorage());
  const credentials = await vault.credentials();
  if (epoch !== state.epoch || state.controller.signal.aborted) return;
  state.user = user; state.vault = vault; state.credentials = credentials;
  resetControls();
  $('#login-screen').hidden = true; $('#app').hidden = false; $('#profile-name').textContent = user.displayName || 'Пользователь'; $('#profile-email').textContent = user.email || '';
  const avatar = $('#profile-avatar'); if (user.photoURL) { avatar.src = user.photoURL; avatar.hidden = false; } else avatar.hidden = true;
  $('#steam-id').value = state.credentials?.steamId || ''; $('#api-key-status').textContent = state.credentials ? 'Ключ сохранён на этом устройстве' : 'Ключ ещё не сохранён'; location.hash = location.hash || '#library'; await loadView(location.hash.slice(1));
}

function resetControls() {
  const syncButton = $('#sync'); syncButton.disabled = false; syncButton.textContent = 'Обновить';
  const settingsSubmit = $('#settings-form button[type="submit"]'); if (settingsSubmit) settingsSubmit.disabled = false;
}

function clearPersonalUi() {
  $('#profile-name').textContent = ''; $('#profile-email').textContent = '';
  const avatar = $('#profile-avatar'); avatar.removeAttribute('src'); avatar.hidden = true;
  $('#steam-id').value = ''; $('#api-key').value = ''; $('#api-key-status').textContent = '';
  $('#search').value = ''; clearCatalogUi();
  $('#flash').textContent = ''; $('#flash').hidden = true;
}

function clearCatalogUi() {
  $('#catalog').replaceChildren(); $('#summary').replaceChildren();
  $('#catalog').hidden = true; $('#summary').hidden = true; $('#catalog-toolbar').hidden = true; $('#empty').hidden = true; $('#onboarding').hidden = false;
}

function clearSession() {
  beginSessionTransition(state);
  state.user = null; state.vault = null; state.credentials = null; state.query = ''; state.catalogs.clear();
  clearPersonalUi(); $('#app').hidden = true; $('#login-screen').hidden = false;
  return state.epoch;
}

$('#google-login').addEventListener('click', async () => { try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (error) { flash(error.message || 'Не удалось войти через Google.', true); } });
$('#logout').addEventListener('click', async () => { clearSession(); await signOut(auth); });
document.querySelectorAll('.nav-button').forEach((button) => button.addEventListener('click', () => { location.hash = button.dataset.view; }));
document.querySelectorAll('[data-go-settings]').forEach((button) => button.addEventListener('click', () => { location.hash = 'settings'; }));
window.addEventListener('hashchange', () => state.user && loadView(location.hash.slice(1)));
$('#search').addEventListener('input', (event) => { state.query = event.target.value; renderCatalog(); });
$('#sort').addEventListener('change', (event) => { state.sort = event.target.value; renderCatalog(); });
$('#sync').addEventListener('click', syncCurrent);
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const current = captureSession(state); if (!current) return; const submit = event.submitter; const steamId = $('#steam-id').value.trim(); const enteredKey = $('#api-key').value.trim(); const apiKey = enteredKey || current.credentials?.apiKey || '';
  if (!validSteamId(steamId) || !validApiKey(apiKey)) { flash('Проверьте SteamID64 и API key.', true); return; }
  const session = transitionForCredentialReplacement(state); if (!session) return; resetControls(); $('#sync').disabled = true;
  submit.disabled = true;
  try {
    const snapshot = await requestSync('library', { steamId, apiKey }, session); if (!isCurrentSession(state, session)) return; await session.vault.replaceConnection({ steamId, apiKey }, snapshot); if (!isCurrentSession(state, session)) return; state.credentials = { steamId, apiKey }; state.catalogs.clear(); state.catalogs.set('library', snapshot); $('#api-key').value = ''; $('#api-key-status').textContent = 'Ключ сохранён на этом устройстве'; flash('Steam подключён, библиотека синхронизирована.'); location.hash = '#library';
  } catch (error) { if (isCurrentSession(state, session)) { state.credentials = current.credentials; flash(error.message || 'Не удалось проверить Steam API key.', true); } }
  finally { if (isCurrentSession(state, session)) resetControls(); }
});
$('#delete-settings').addEventListener('click', async () => {
  if (!confirm('Удалить SteamID, API key и персональные снимки из этого браузера?')) return;
  const vault = state.vault; if (!vault || !state.user) return; const session = transitionForDisconnect(state); state.catalogs.delete('library'); state.catalogs.delete('wishlist'); clearCatalogUi(); resetControls(); $('#steam-id').value = ''; $('#api-key').value = ''; $('#api-key-status').textContent = 'Ключ ещё не сохранён';
  try { await vault.disconnect(); if (isCurrentSession(state, session)) flash('Локальные данные Steam удалены.'); }
  catch (error) { if (isCurrentSession(state, session)) flash(error.message || 'Не удалось удалить локальные данные Steam.', true); }
});

if (!config?.apiKey || !config?.projectId || !config?.appId || !config?.gatewayEndpoint) {
  const button = $('#google-login'); button.disabled = true; const setup = $('#setup-status'); setup.hidden = false; setup.textContent = 'Firebase ещё не настроен. Владелец приложения должен завершить публикацию.';
} else {
  const firebase = initializeApp(config);
  auth = getAuth(firebase);
  syncSteam = createGatewaySync({
    endpoint: config.gatewayEndpoint,
    getToken: async (forceRefresh, expectedUid) => {
      const user = auth.currentUser;
      if (!user || user.uid !== expectedUid) throw new Error('Сессия Google изменилась. Войдите снова.');
      const token = await user.getIdToken(forceRefresh);
      if (auth.currentUser?.uid !== expectedUid) throw new Error('Сессия Google изменилась. Войдите снова.');
      return token;
    },
  });
  onAuthStateChanged(auth, async (user) => {
    const epoch = clearSession();
    if (user) {
      try { await showUser(user, epoch); }
      catch { if (epoch === state.epoch) { const setup = $('#setup-status'); setup.hidden = false; setup.textContent = 'Не удалось открыть локальное хранилище браузера. Разрешите IndexedDB и обновите страницу.'; } }
    }
  });
}
