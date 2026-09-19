# Steam Shelf

Публичное клиентское приложение для личной библиотеки Steam, wishlist и общей витрины скидок. LostFilm-кода и данных здесь нет.

Публичная страница проекта: https://danshin.ms/steam-shelf/

GitHub Pages публикует рабочий интерфейс. Google-вход обслуживает бесплатный Firebase Authentication, а ограниченный gateway на `api.danshin.ms` запрашивает Steam API, потому что Steam не разрешает эти запросы напрямую из браузера через CORS. SteamID64, API key и персональные snapshots остаются в IndexedDB устройства и не сохраняются gateway.

## Возможности

- вход через Google с Firebase Authentication;
- локальное account-scoped хранилище IndexedDB для каждого Firebase user ID;
- SteamID64 и персональный Steam Web API key остаются на устройстве пользователя;
- API key передаётся gateway только во время ручной синхронизации и не сохраняется им;
- gateway проверяет Firebase ID token, принимает только library/wishlist и ограничивает частоту синхронизаций;
- общая витрина Steam Specials с точными ценами в копейках;
- количество отзывов и процент положительных оценок Steam в wishlist;
- настраиваемый минимум отзывов в разделах «Скидки» и «Желаемое»: любое целое число от 0, где 0 отключает ограничение; при пороге выше 0 игры без данных об отзывах скрываются, настройка запоминается в браузере и работает вместе с остальными фильтрами;
- Steam API key не попадает в URL, Firestore, GitHub или LocalStorage.

## Публичный клиент

Клиент собирается в `site/`:

```bash
npm ci
npm run build:client
```

Firebase-конфигурация веб-приложения находится в `site/firebase-config.js`. Она является публичным идентификатором Firebase-проекта, а не серверным секретом. Google provider должен разрешать домены `danshin.ms` и `mdanshin.github.io`.

Gateway разворачивается отдельно на loopback-порту `8001` за точным nginx route `/steam-shelf/v1/sync`:

```bash
npm --prefix gateway ci --omit=dev
QUOTA_DB_PATH=.tmp/gateway-limits.sqlite node gateway/server.js
```

Production unit и nginx snippets находятся в `deploy/`. Gateway не требует Firebase Blaze, Firestore, Firebase App Check или service-account key: подпись короткоживущего Firebase ID token проверяется по публичным Google JWK. Выход или отзыв доступа может оставлять уже выпущенный token действительным до истечения его срока, не более одного часа.

## Локальный серверный вариант

Требуется Node.js 24+ и Python для обновления общей витрины скидок.

1. Скопируйте `.env.example` в `.env.local`.
2. Создайте OAuth 2.0 Client ID типа **Web application** в Google Cloud Console.
3. Добавьте redirect URI: `http://127.0.0.1:4180/auth/google/callback`.
4. Запишите client ID и client secret в `.env.local`.
5. Сгенерируйте отдельный ключ шифрования:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

6. Запустите:

```bash
npm start
```

Откройте `http://127.0.0.1:4180`. После Google-входа откройте «Настройки», добавьте SteamID64 и собственный Web API key, затем синхронизируйте библиотеку и wishlist.

## Проверка

После обновления gateway и клиента нажмите «Обновить» в разделе «Желаемое»: старые локальные снимки не содержат статистику отзывов. При недоступности статистики приложение показывает «Отзывы не загружены», сохраняя игры и цены. Отзывы запрашиваются через Steam Store Browse пакетами по 50 игр, без дополнительных ключей доступа.

```bash
npm test
npm run check
```

## Обновление скидок

```bash
npm run sync:deals
```

Синхронизатор сохраняет прежний snapshot при ошибке и публикует новый только после полной проверки выдачи Steam.

## Граница безопасности

- `.env.local`, SQLite и runtime-файлы исключены из Git.
- Серверный вариант в `server.js` рассчитан только на локальный loopback и не используется публичным клиентом; production gateway находится в `gateway/server.js`.
- `STEAM_KEY_ENCRYPTION_SECRET` нельзя менять без миграции: иначе существующие API keys невозможно расшифровать.
- Делайте зашифрованные резервные копии SQLite и ключа отдельно.
- Google OAuth credentials и ключ шифрования не должны попадать в клиентский JavaScript, Git или логи.
- Gateway не журналирует request body, Authorization, Firebase UID, SteamID64, Steam API key или ответы Steam. Короткие лимиты хранятся в памяти, а дневные лимиты переживают restart в SQLite только под SHA-256-хешем Firebase UID.
- IndexedDB не является аппаратным хранилищем секретов: расширения браузера, XSS или доступ к профилю браузера могут раскрыть локальный API key. Используйте отдельный Steam Web API key и удаляйте локальные данные на чужом устройстве.
