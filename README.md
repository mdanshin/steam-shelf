# Steam Shelf

Отдельное серверное приложение для личной библиотеки Steam, wishlist и общей витрины скидок. LostFilm-кода и данных здесь нет.

Публичная страница проекта: https://mdanshin.github.io/steam-shelf/

GitHub Pages публикует только статическую презентацию. Персональный Steam Shelf запускается локально: Pages не выполняет Node.js, OAuth callback и SQLite и не может безопасно хранить пользовательские Steam API keys.

## Возможности

- вход через Google OAuth 2.0 Authorization Code + PKCE/state;
- отдельные аккаунты и серверные HttpOnly-сессии;
- SteamID64 и персональный Steam Web API key для каждого пользователя;
- API keys шифруются AES-256-GCM до записи в SQLite;
- личные snapshots библиотеки и wishlist изолированы по user ID;
- общая витрина Steam Specials с точными ценами в копейках;
- Steam API key не возвращается браузеру, не попадает в URL и не хранится в LocalStorage.

## Локальная настройка

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
- Эта версия рассчитана на прямой локальный запуск на доверенном loopback-интерфейсе. Не размещайте её за reverse proxy: приложение намеренно не доверяет `X-Forwarded-For`, а значит прокси объединит клиентов в один rate-limit bucket. Для публичного размещения сначала добавьте отдельную проверенную конфигурацию доверенного прокси и TLS.
- `STEAM_KEY_ENCRYPTION_SECRET` нельзя менять без миграции: иначе существующие API keys невозможно расшифровать.
- Делайте зашифрованные резервные копии SQLite и ключа отдельно.
- Google OAuth credentials и ключ шифрования не должны попадать в клиентский JavaScript, Git или логи.
