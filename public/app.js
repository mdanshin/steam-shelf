import { createCatalogLifecycle, currentDeals } from './catalog-lifecycle.js';

const $ = (selector) => document.querySelector(selector);
const normalizeSteamId = (value) => String(value ?? '').replace(/[^0-9]/g, '');
function steamIdProblem(value) {
  const digits = normalizeSteamId(value);
  if (!digits || /^7656119\d{10}$/.test(digits)) return '';
  if (digits.length !== 17) return `Введено ${digits.length} цифр из 17.`;
  return 'SteamID64 должен начинаться с 7656119.';
}
const lifecycle = createCatalogLifecycle();
const state = { me: null, view: 'library', catalogs: lifecycle.catalogs, query: '', sort: 'playtime' };
const viewMeta = {
  library: { title: 'Библиотека', kicker: 'МОЯ КОЛЛЕКЦИЯ', empty: 'Синхронизируйте аккаунт, чтобы увидеть игры.', sorts: [['playtime','По времени в игре'],['recent','Недавно запущенные'],['name','По названию']] },
  wishlist: { title: 'Желаемое', kicker: 'СПИСОК ЖЕЛАНИЙ', empty: 'Синхронизируйте список желаемого. Профиль Steam должен быть публичным.', sorts: [['date','Сначала добавленные недавно'],['discount','По размеру скидки'],['savings','По экономии'],['price','Сначала дешевле']] },
  deals: { title: 'Скидки', kicker: 'STEAM SPECIALS', empty: 'Снимок скидок ещё не опубликован.', sorts: [['savings','По экономии'],['discount','По размеру скидки'],['end','Скоро закончатся']] },
  settings: { title: 'Настройки', kicker: 'ПРИВАТНОСТЬ И ДОСТУП', empty: '', sorts: [] },
};

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...options.headers };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET' && state.me?.csrfToken) {
    headers['X-CSRF-Token'] = state.me.csrfToken;
    headers.Origin = location.origin;
  }
  const response = await fetch(path, { cache: 'no-store', ...options, headers });
  const value = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value?.error || 'Операция не выполнена'), { status: response.status });
  return value;
}

function flash(message, error = false) {
  const box = $('#flash');
  box.textContent = message;
  box.classList.toggle('error', error);
  box.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { box.hidden = true; }, 5000);
}
function money(minor) { return Number.isInteger(minor) ? new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(minor / 100) : 'Цена недоступна'; }
function playtime(minutes) {
  if (!minutes) return 'Не запускалась';
  if (minutes < 60) return `${minutes} мин.`;
  return `${Math.round(minutes / 60)} ч.`;
}
function coverUrl(game) { return `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${game.appid}/header.jpg`; }
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function card(game) {
  const article = element('article', 'game-card');
  const image = element('img', 'game-cover');
  image.src = coverUrl(game); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
  image.addEventListener('error', () => { image.removeAttribute('src'); });
  const body = element('div', 'game-body');
  const title = element('h2', 'game-title');
  const link = element('a', '', game.name || `Steam App ${game.appid}`);
  link.href = `https://store.steampowered.com/app/${game.appid}/`; link.target = '_blank'; link.rel = 'noopener noreferrer';
  title.append(link); body.append(title);
  if (state.view === 'library') {
    const meta = element('div', 'game-meta');
    meta.append(element('span', '', `Всего: ${playtime(game.playtimeForever)}`), element('span', '', game.lastPlayedAt ? new Date(game.lastPlayedAt * 1000).toLocaleDateString('ru-RU') : 'Не запускалась'));
    body.append(meta);
  } else {
    const prices = element('div', 'game-price');
    if (game.discountPercent > 0) prices.append(element('span', 'discount', `−${game.discountPercent}%`));
    if (Number.isInteger(game.originalPriceMinor) && game.originalPriceMinor !== game.priceMinor) prices.append(element('span', 'old-price', money(game.originalPriceMinor)));
    prices.append(element('span', 'price', money(game.priceMinor)));
    body.append(prices);
    if (Number.isInteger(game.savingsMinor) && game.savingsMinor > 0) body.append(element('div', 'saving', `Экономия ${money(game.savingsMinor)}`));
  }
  article.append(image, body);
  return article;
}

function sorted(items) {
  const copy = [...items];
  const mode = state.sort;
  const unknownLast = (left, right, field, direction = -1) => {
    const a = Number.isFinite(left[field]) && left[field] > 0 ? left[field] : null;
    const b = Number.isFinite(right[field]) && right[field] > 0 ? right[field] : null;
    if (a === null && b !== null) return 1; if (a !== null && b === null) return -1;
    return a === b ? String(left.name).localeCompare(String(right.name), 'ru') : direction * (a - b);
  };
  if (mode === 'name') return copy.sort((a,b) => String(a.name).localeCompare(String(b.name),'ru'));
  if (mode === 'recent') return copy.sort((a,b) => unknownLast(a,b,'lastPlayedAt'));
  if (mode === 'playtime') return copy.sort((a,b) => unknownLast(a,b,'playtimeForever'));
  if (mode === 'date') return copy.sort((a,b) => unknownLast(a,b,'dateAdded'));
  if (mode === 'price') return copy.sort((a,b) => unknownLast(a,b,'priceMinor',1));
  if (mode === 'discount') return copy.sort((a,b) => unknownLast(a,b,'discountPercent'));
  if (mode === 'end') return copy.sort((a,b) => unknownLast(a,b,'discountEndAt',1));
  return copy.sort((a,b) => unknownLast(a,b,'savingsMinor'));
}

function renderCatalog() {
  const data = state.catalogs.get(state.view) || { games: [], syncedAt: null };
  const query = state.query.trim().toLocaleLowerCase('ru');
  const available = state.view === 'deals' ? currentDeals(data.games || []) : (data.games || []);
  const games = sorted(available.filter((game) => !query || String(game.name).toLocaleLowerCase('ru').includes(query)));
  $('#catalog').replaceChildren(...games.slice(0, 600).map(card));
  $('#summary').replaceChildren(
    element('span', '', `${games.length} из ${available.length}`),
    element('span', '', data.syncedAt ? `Обновлено ${new Date(data.syncedAt).toLocaleString('ru-RU')}` : 'Ещё не синхронизировано'),
  );
  $('#empty').hidden = games.length > 0;
  $('#empty-title').textContent = query ? 'Ничего не найдено' : 'Здесь пока пусто';
  $('#empty-text').textContent = query ? 'Попробуйте изменить запрос.' : viewMeta[state.view].empty;
}

async function loadView(view) {
  state.view = viewMeta[view] ? view : 'library';
  const requestedView = state.view;
  const requestRevision = lifecycle.revision();
  const meta = viewMeta[requestedView];
  document.querySelectorAll('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
  $('#section-title').textContent = meta.title; $('#section-kicker').textContent = meta.kicker;
  $('#settings-panel').hidden = state.view !== 'settings';
  $('#catalog-toolbar').hidden = state.view === 'settings';
  $('#catalog').hidden = state.view === 'settings'; $('#summary').hidden = state.view === 'settings'; $('#empty').hidden = true;
  $('#onboarding').hidden = state.me.settings.hasApiKey || state.view === 'settings' || state.view === 'deals';
  if (state.view === 'settings') return;
  const sort = $('#sort'); sort.replaceChildren(...meta.sorts.map(([value,label]) => { const option = element('option','',label); option.value=value; return option; }));
  state.sort = meta.sorts[0][0];
  $('#sync').hidden = state.view === 'deals';
  if (!state.catalogs.has(requestedView)) {
    $('#catalog').replaceChildren(element('p', '', 'Загрузка…'));
    try {
      const snapshot = await api(`/api/catalog/${requestedView}`);
      if (!lifecycle.canStore(requestedView, requestRevision)) return;
      state.catalogs.set(requestedView, snapshot);
    } catch (error) {
      if (!lifecycle.canStore(requestedView, requestRevision)) return;
      flash(error.message, true);
      state.catalogs.set(requestedView, { games: [], syncedAt: null });
    }
  }
  if (state.view === requestedView) renderCatalog();
}

async function syncCurrent() {
  if (!state.me.settings.hasApiKey) return loadView('settings');
  const requestedView = state.view;
  const requestRevision = lifecycle.revision();
  const button = $('#sync'); button.disabled = true; button.textContent = 'Синхронизация…';
  try {
    const snapshot = await api(`/api/sync/${requestedView}`, { method: 'POST' });
    if (!lifecycle.canStore(requestedView, requestRevision)) return;
    state.catalogs.set(requestedView, snapshot);
    if (lifecycle.canRender(requestedView, state.view)) renderCatalog();
    flash(`${viewMeta[requestedView].title}: данные обновлены`);
  } catch (error) { flash(error.message, true); }
  finally { button.disabled = false; button.textContent = 'Обновить'; }
}

function showApp(me) {
  state.me = me;
  $('#login-screen').hidden = true; $('#app').hidden = false;
  $('#profile-name').textContent = me.user.name; $('#profile-email').textContent = me.user.email;
  const avatar = $('#profile-avatar'); if (me.user.picture) avatar.src = me.user.picture; else avatar.hidden = true;
  $('#steam-id').value = me.settings.steamId || '';
  $('#api-key-status').textContent = me.settings.hasApiKey ? `Сохранён: ${me.settings.apiKeyMask}` : 'Ключ ещё не сохранён';
  location.hash = location.hash || '#library';
  loadView(location.hash.slice(1));
}

document.querySelectorAll('.nav-button').forEach((button) => button.addEventListener('click', () => { location.hash = button.dataset.view; }));
document.querySelectorAll('[data-go-settings]').forEach((button) => button.addEventListener('click', () => { location.hash = 'settings'; }));
window.addEventListener('hashchange', () => loadView(location.hash.slice(1)));
$('#search').addEventListener('input', (event) => { state.query = event.target.value; renderCatalog(); });
$('#sort').addEventListener('change', (event) => { state.sort = event.target.value; renderCatalog(); });
$('#sync').addEventListener('click', syncCurrent);
$('#steam-id').addEventListener('input', (event) => { const digits = normalizeSteamId(event.target.value); if (event.target.value !== digits) event.target.value = digits; event.target.setCustomValidity(steamIdProblem(digits)); });
$('#logout').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); location.reload(); } catch (error) { flash(error.message, true); } });
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.submitter; submit.disabled = true;
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ steamId: normalizeSteamId($('#steam-id').value), apiKey: $('#api-key').value.trim() }) });
    const me = await api('/api/me'); state.me = me; $('#api-key').value = ''; $('#api-key-status').textContent = `Сохранён: ${me.settings.apiKeyMask}`;
    lifecycle.invalidatePersonal(); flash('Steam подключён. Теперь можно синхронизировать коллекцию.');
  } catch (error) { flash(error.message, true); } finally { submit.disabled = false; }
});
$('#delete-settings').addEventListener('click', async () => {
  if (!confirm('Удалить SteamID, зашифрованный API key и отключить синхронизацию?')) return;
  try { await api('/api/settings', { method: 'DELETE' }); lifecycle.invalidatePersonal(); state.me = await api('/api/me'); $('#steam-id').value=''; $('#api-key').value=''; $('#api-key-status').textContent='Ключ ещё не сохранён'; if (state.view !== 'settings' && state.view !== 'deals') renderCatalog(); flash('Подключение Steam удалено.'); }
  catch (error) { flash(error.message, true); }
});

async function bootstrap() {
  try {
    const status = await api('/api/status');
    if (!status.googleConfigured) {
      const login = $('#google-login');
      login.removeAttribute('href'); login.setAttribute('aria-disabled', 'true');
      const setup = $('#setup-status');
      setup.hidden = false;
      setup.textContent = 'Сервер запущен. Чтобы включить вход, добавьте GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET в .env.local.';
      return;
    }
    await showApp(await api('/api/me'));
  } catch (error) { if (error.status !== 401) flash(error.message, true); }
}
bootstrap();
