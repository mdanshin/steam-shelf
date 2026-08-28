const EXPECTED_ENDPOINT = 'https://api.danshin.ms/steam-shelf/v1/sync';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const messages = new Map([
  [400, 'Проверьте SteamID64 и API key.'],
  [401, 'Сессия Google истекла. Войдите снова.'],
  [403, 'Синхронизация недоступна для этого аккаунта.'],
  [409, 'Эта синхронизация уже выполняется.'],
  [413, 'Запрос слишком большой.'],
  [415, 'Некорректный формат запроса.'],
  [422, 'Steam отклонил API key или данные профиля недоступны.'],
  [429, 'Слишком много запросов. Попробуйте позже.'],
  [502, 'Steam временно недоступен. Попробуйте позже.'],
  [504, 'Steam не ответил вовремя. Попробуйте позже.'],
]);

async function parseResponse(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('Сервер вернул слишком большой ответ.');
  if (!response.body) throw new Error('Сервер вернул некорректный ответ.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Сервер вернул слишком большой ответ.');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error('Сервер вернул некорректный ответ.'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Сервер вернул некорректный ответ.');
  return payload;
}

function awaitWithAbort(producer, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(producer).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export function createGatewaySync({ endpoint, getToken, fetchImpl = fetch }) {
  if (endpoint !== EXPECTED_ENDPOINT || typeof getToken !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('A trusted gateway configuration is required');

  return async function sync(request, { signal, expectedUid } = {}) {
    if (typeof expectedUid !== 'string' || !expectedUid) throw new Error('Сессия Google изменилась. Войдите снова.');
    const timeout = AbortSignal.timeout(65_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      requestSignal.throwIfAborted();
      const token = await awaitWithAbort(() => getToken(attempt === 1, expectedUid), requestSignal);
      requestSignal.throwIfAborted();
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: requestSignal,
      });
      const payload = await parseResponse(response);
      if (response.ok) return payload;
      if (response.status === 401 && attempt === 0) continue;
      throw new Error(messages.get(response.status) || 'Синхронизация не выполнена.');
    }
    throw new Error(messages.get(401));
  };
}
