# openclaw-max – плагин MAX для OpenClaw

Канал-плагин для подключения AI-ассистента [OpenClaw](https://openclaw.ai) к мессенджеру [MAX](https://max.ru) (ex-VK Teams / ICQ New).

Версия 0.7.1, изменения — в [CHANGELOG.md](CHANGELOG.md). Проверено на OpenClaw 2026.9.6 и схеме MAX Bot API 0.0.33.

## Что это

Плагин позволяет общаться с OpenClaw-ботом через мессенджер MAX — так же, как через Telegram. Поддерживает:

- Приём и отправку текстовых сообщений (MAX-диалект markdown: `++подчёркивание++`, упоминания `max://user/id`)
- Вложения (фото, видео, аудио, файлы, стикеры, контакты, геолокация)
- Inline-кнопки: callback / link / message / clipboard / open_app / request_contact / request_geo_location
- Контракт OpenClaw `presentation`: заголовок, текст, context, divider, таблицы и графики (моноширинно), кнопки и select → inline-клавиатура; нажатия approval/ask_user/command/callback возвращаются в gateway
- Закрепление сообщений (pin/unpin) и `delivery.pin` для отправляемых сообщений
- Long polling (с персистентным marker) и Webhook на HTTP-сервере gateway (секрет, мгновенный ACK, дедупликация повторов) — см. «Webhook»
- Реестр чатов из событий bot_added/bot_started (замена deprecated GET /chats)
- Ретраи на 429/сетевые сбои и `attachment.not.ready`
- Мультиаккаунт
- DM-security и pairing

## TLS: сертификат Минцифры (важно!)

С июля 2026 MAX Bot API живёт на `platform-api2.max.ru` с сертификатом, выпущенным
Russian Trusted Sub CA (Минцифры), которого нет в стандартном доверенном наборе Node.js.
Плагин решает это сам: все запросы к API идут через выделенный undici-dispatcher,
в CA-набор которого добавлены Russian Trusted Root/Sub CA (встроены в пакет,
`src/russian-trusted-ca.ts`). Доверие ограничено только соединениями плагина —
процесс-wide trust store не трогается, `NODE_EXTRA_CA_CERTS` не требуется.

## Структура проекта

```
openclaw-max/
├── index.ts                    # Точка входа (defineChannelPluginEntry) → dist/index.js
├── setup-entry.ts              # Точка входа setup-режима (defineSetupPluginEntry) → dist/setup-entry.js
├── openclaw.plugin.json        # Манифест плагина
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── channel.ts              # maxPlugin: сборка адаптеров канала
│   ├── channel-config.ts       # Аккаунты, включение/удаление, CLI setup
│   ├── channel-policy.ts       # DM-политика, группы (requireMention, tools), pairing
│   ├── channel-directory.ts    # Нормализация целей, directory (self/peers/groups)
│   ├── channel-outbound.ts     # sendText/sendPayload/sendMedia, presentation, pin
│   ├── channel-lifecycle.ts    # Старт/стоп аккаунта, статус, probe, аудит групп
│   ├── channel-agent-prompt.ts # Подсказки агенту (стикеры, location, кнопки…)
│   ├── monitor.ts              # Точка входа приёма: выбор транспорта
│   ├── monitor-types.ts        # Опции монитора, статус, подписанные update_type
│   ├── polling.ts              # Long polling (marker), снятие чужих подписок
│   ├── webhook-runner.ts       # Webhook-режим: секрет, подписка, сверка, запуск очереди
│   ├── webhook-queue.ts        # Webhook: очередь апдейтов, обработка в задаче аккаунта
│   ├── webhook.ts              # Webhook: роут gateway, secret, быстрый ACK, дедупликация
│   ├── dispatch.ts             # Разбор update'ов по update_type
│   ├── inbound.ts              # Gate DM/групп, контекст, запуск агента
│   ├── inbound-attachments.ts  # Скачивание и описание входящих вложений
│   ├── callbacks.ts            # Нажатия кнопок, approval/ask_user
│   ├── deliver.ts              # Доставка ответа: чанки, альбомы, pin
│   ├── stream-draft.ts         # Edit-стриминг (streamMode: partial)
│   ├── send.ts                 # Send-хелперы (sendWithBody, кнопки, медиа, pin)
│   ├── actions.ts              # message-tool actions (send/edit/delete/pin/…)
│   ├── presentation.ts         # Рендер presentation и callback-конверты
│   ├── api.ts                  # HTTP-клиент MAX API (retry, TLS, upload, лимитер)
│   ├── types.ts                # TypeScript-типы MAX Bot API
│   ├── russian-trusted-ca.ts   # Встроенные сертификаты Минцифры
│   ├── format.ts               # Конвертация markdown в MAX-диалект
│   ├── media-temp.ts           # Временные файлы медиа, очистка имён
│   ├── state.ts                # Персист: marker, реестр чатов, секрет webhook
│   ├── accounts.ts             # Резолвинг аккаунтов из конфига
│   ├── config-schema.ts        # Zod-схема конфига
│   ├── model-buttons.ts        # Кнопки выбора модели
│   ├── onboarding.ts           # Setup wizard
│   ├── sticker-cache.ts        # Кэш кодов стикеров
│   └── __fixtures__/           # Снимок схемы MAX (max-schema-<версия>.yaml)
└── scripts/
    ├── test-api.mjs            # Проверка токена и API
    ├── test-send.mjs           # Тест send + edit + delete
    ├── check-cycles.mjs        # Проверка циклических импортов src/
    └── update-schema.mjs       # Обновление снимка схемы MAX
```

## Установка

### 1. Создать бота в MAX

1. Зайти на [business.max.ru](https://business.max.ru/self) (нужно юрлицо/ИП)
2. Создать профиль организации и пройти верификацию
3. Раздел **Чат-боты** → **Создать** (название, лого 500x500, описание)
4. Дождаться модерации (до 48ч по рабочим дням)
5. После модерации: **Чат-боты → Интеграция → Получить токен**

### 2. Установить плагин

Через ClawHub (рекомендуется):

```bash
openclaw plugins install clawhub:@aspalagin/openclaw-max
```

Через npm:

```bash
openclaw plugins install npm:@aspalagin/openclaw-max
```

Вручную из исходников (для разработки):

```bash
cd ~/.openclaw/extensions
git clone https://github.com/aspalagin/openclaw-max openclaw-max
cd openclaw-max && npm install && npm run build
```

### 3. Настроить конфиг

Добавить секцию в `~/.openclaw/openclaw.json`:

```jsonc
{
  "channels": {
    "max": {
      // Токен бота из business.max.ru → Чат-боты → Интеграция
      "botToken": "ваш_токен_бота",

      // Список user_id, которым разрешено писать боту
      // Узнать свой user_id: написать боту, посмотреть в логах
      "allowFrom": ["12345678"],

      // Политика DM-доступа:
      // "allowlist" — только из allowFrom (по умолчанию)
      // "open" — любой может писать
      // "pairing" — новые контакты проходят pairing-код
      "dmPolicy": "allowlist"
    }
  }
}
```

### 4. Перезапустить gateway

```bash
openclaw gateway restart
```

## Настройка — описание полей

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `botToken` | string | да | API-токен бота (или env `MAX_BOT_TOKEN`) |
| `allowFrom` | string[] | да* | Список разрешённых user_id |
| `dmPolicy` | string | нет | Политика DM: pairing (по умолчанию) / allowlist / open / disabled |
| `groupPolicy` | string | нет | Политика групп: allowlist (по умолчанию) / open / disabled |
| `groups` | object | нет | Пер-групповые настройки (requireMention, tools, …) |
| `transport` | string | нет | `polling` / `webhook`; по умолчанию `webhook`, если задан `webhookUrl`, иначе `polling` |
| `webhookUrl` | string | нет | Публичный HTTPS-адрес для MAX; включает webhook-режим (см. «Webhook») |
| `webhookSecretFile` | string | нет | Файл с секретом вебхука (как `tokenFile`) |
| `webhookSecret` | string | нет | Секрет вебхука строкой; если не задан ни он, ни файл — генерируется и хранится в state-файле аккаунта |
| `webhookPath` | string | нет | Путь роута на gateway, если отличается от pathname `webhookUrl` (по умолчанию `/max/webhook`) |
| `streamMode` | string | нет | off (по умолчанию) / partial / block |
| `mediaMaxMb` | number | нет | Лимит скачивания медиа, МБ (по умолчанию 20) |
| `markSeen` | boolean | нет | Слать mark_seen на входящие (по умолчанию true) |
| `commands` | array | нет | Команды бота `[{name, description}]` — регистрируются через PATCH /me/commands (до 32) |

\* Обязательно при `dmPolicy: "allowlist"`.

## Webhook

По умолчанию плагин получает события long polling'ом. В webhook-режиме MAX сам
присылает `POST` на публичный адрес, а плагин обслуживает его роутом на
HTTP-сервере gateway (тот же порт, что и Control UI; отдельный сервер не
поднимается).

### Требования MAX

- Только HTTPS на порту 443 с сертификатом доверенного CA (самоподписанный не подойдёт).
- Ответ 200 не позже чем через 30 с. Плагин отвечает сразу после проверки
  секрета и формы тела, а обработку (агент может думать минутами) ведёт асинхронно.
- При неудаче MAX повторяет доставку до 10 раз с растущим интервалом, а после
  8 часов без успеха **сам снимает подписку**. Повторы одного и того же
  обновления плагин отсекает (LRU по `update_type` + `timestamp` + `mid`/`callback_id`).
- Каждый запрос несёт заголовок `X-Max-Bot-Api-Secret`; без совпадения — 401.
- **Пока подписка активна, long polling у MAX не работает.** Поэтому в
  polling-режиме плагин при старте удаляет найденную подписку (с warning в логе).

### Как устроено

1. При старте аккаунта регистрируется роут `auth: "plugin"`, `match: "exact"` на
   пути `webhookPath` → pathname `webhookUrl` → `/max/webhook`. Не удалось
   зарегистрировать (например, путь занят другим плагином) — старт аккаунта падает.
2. `GET /subscriptions`: подписки этого бота на другие URL удаляются
   (`DELETE /subscriptions?url=`).
3. `POST /subscriptions {url, update_types, secret}` — на каждом старте, чтобы
   секрет и список событий совпадали с текущим конфигом.
4. При остановке роут снимается, **подписка остаётся**: рестарт gateway не
   теряет события (MAX повторит недоставленные). Чтобы выключить webhook,
   переключите `transport: "polling"` — плагин удалит подписку при старте, —
   или удалите её вручную `DELETE /subscriptions?url=<webhookUrl>`.
5. Пока аккаунт работает, раз в 12 минут `GET /subscriptions` сверяет, что
   подписка на `webhookUrl` жива. Если MAX её снял (8 часов недоставки —
   упал туннель или gateway), плагин пересоздаёт её `POST /subscriptions` и
   пишет warning; ошибка сети при проверке только логируется. Таймер
   останавливается вместе с аккаунтом.
6. **Обработка идёт в задаче аккаунта, а не в HTTP-запросе.** Обработчик роута
   проверяет секрет, тело и дубликат, сразу отвечает `200 {"ok":true}` и только
   кладёт апдейт в очередь аккаунта. Задача аккаунта (та же, что держит роут)
   забирает апдейты и вызывает обработку: в одном чате строго по порядку,
   разные чаты — параллельно, не больше 4 одновременно. Причина: gateway
   выдаёт HTTP-обработчику допуск работы только на время запроса; запуск
   агента из контекста уже завершённого запроса отвергается как
   `GatewayDrainingError: Gateway is draining` (так было в 0.7.0). При
   остановке аккаунта начатые апдейты дорабатывают (до 3 с ожидания), а
   принятые, но не начатые передаются следующему старту аккаунта в этом же
   процессе — MAX их уже не повторит.

Секрет берётся из `webhookSecret`, иначе из `webhookSecretFile`, иначе
генерируется один раз и сохраняется в `~/.openclaw/max/state-<account>.json`
(переживает рестарты). Формат MAX: 5–256 символов `A-Z a-z 0-9 _ -`.

### Пример (эта установка)

Публичный адрес `https://max.kotbanzai.com/max/webhook` проксируется Cloudflare
Tunnel на `http://127.0.0.1:18789` (наружу открыт только путь `/max/webhook`).

```bash
umask 077
head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9_-' | head -c 48 \
  > /root/.openclaw/secrets/max-webhook-secret
```

```json
{
  "channels": {
    "max": {
      "tokenFile": "/root/.openclaw/secrets/gateway-max-bot-token",
      "transport": "webhook",
      "webhookUrl": "https://max.kotbanzai.com/max/webhook",
      "webhookSecretFile": "/root/.openclaw/secrets/max-webhook-secret"
    }
  }
}
```

### Порядок включения

1. Сначала задеплоить эту версию плагина и **полностью перезапустить gateway**
   с новым кодом, оставаясь в polling-режиме. Старые версии плагина при
   `webhookUrl` подписывались, но роут не регистрировали — бот глох.
2. Затем добавить в конфиг `transport`/`webhookUrl`/`webhookSecretFile`
   (поля `transport` и `webhookSecretFile` знает только новая схема) и
   перезапустить канал/gateway. Подписку создаёт сам плагин при старте.
3. Проверить: `GET /subscriptions` показывает ровно один URL, в логе
   `MAX webhook subscribed`, сообщение боту доходит до агента.

Пошаговый runbook деплоя 0.7.0 на этой установке (бэкапы, проверки, откаты):
`/root/.openclaw/workspace-arseniy/deliverables/max-plugin-upgrade-20260926/deploy-runbook.md`
(рабочий каталог ассистента, вне репозитория).

Откат: `transport: "polling"` (или убрать `webhookUrl`) и перезапуск — подписка
удаляется при старте polling. Если плагин не стартует, снять подписку руками:
`curl -X DELETE "https://platform-api2.max.ru/subscriptions?url=<webhookUrl>" -H "Authorization: <token>"`.

## Использование

### Как написать боту

1. Найти бота в MAX по нику (например `@idИНН_bot`)
2. Нажать **Старт** или отправить любое сообщение
3. Бот ответит, если ваш `user_id` в `allowFrom`

### Как узнать свой user_id

Написать боту, затем посмотреть в логах OpenClaw:

```bash
openclaw logs --follow
# В логах будет: sender.user_id: 12345678
```

Или запустить тест-скрипт:

```bash
MAX_BOT_TOKEN=xxx node scripts/test-api.mjs
# В разделе updates будет виден ваш user_id
```

### allowFrom и pairing

- **allowlist** (по умолчанию): только user_id из списка могут общаться с ботом
- **open**: любой пользователь MAX может писать боту
- **pairing**: новый пользователь получает код, который нужно подтвердить у владельца

## Мультиаккаунт

Можно подключить несколько ботов MAX — например, рабочий и личный:

```jsonc
{
  "channels": {
    "max": {
      // Аккаунт по умолчанию
      "botToken": "токен_основного_бота",
      "allowFrom": ["12345678"],

      // Дополнительные аккаунты
      "accounts": {
        "zaya": {
          "botToken": "токен_второго_бота",
          "allowFrom": ["87654321"],
          "dmPolicy": "open"
        }
      }
    }
  }
}
```

Обращение к конкретному аккаунту:

```
openclaw --account zaya send "Привет из второго бота"
```

## Разработка

### Требования

- Node.js 22+
- OpenClaw 2026.9.6+ (devDependency, SDK-подпути `openclaw/plugin-sdk/*`)

### Сборка

```bash
cd openclaw-max
npm ci
npm run build          # tsc → dist/index.js, dist/setup-entry.js, dist/src/*.js (без тестов)
```

`build` собирает и при ошибках типов (`--noEmitOnError false`), поэтому перед ним
запускайте `npm run typecheck`.

### Проверки (как в CI)

```bash
npm run format:check   # prettier
npm run lint           # eslint, 0 ошибок и 0 предупреждений
npm run check:cycles   # циклические импорты между модулями src/
npm run typecheck
npm test               # vitest, включая сверку со схемой MAX
```

### Схема MAX Bot API

`src/schema-conformance.test.ts` сверяет подписку, типы update/кнопок/вложений и
тела запросов со снимком `src/__fixtures__/max-schema-<версия>.yaml`
([max-messenger/api-schema](https://github.com/max-messenger/api-schema)).
Обновить снимок:

```bash
npm run schema:update               # последний коммит репозитория схемы
npm run schema:update -- <commit>   # конкретный коммит, тег или ветка
npm test
```

Скрипт заменяет старый снимок новым (имя по `info.version`) и пишет в заголовок
файла коммит и дату. Упавший тест сверки означает, что плагин отправляет или ждёт
то, чего в новой схеме нет: поправить код или тип, затем закоммитить снимок.

### Тест API (проверка что токен работает)

```bash
# Проверить бота: GET /me + GET /updates
MAX_BOT_TOKEN=xxx node scripts/test-api.mjs

# С отправкой тестового сообщения в чат
MAX_BOT_TOKEN=xxx node scripts/test-api.mjs <chat_id>
```

### Тест отправки (send + edit + delete)

```bash
# Полный цикл: отправить → подождать → отредактировать → подождать → удалить
MAX_BOT_TOKEN=xxx node scripts/test-send.mjs <chat_id> "Текст сообщения"
```

## Поддержка

- Вопросы по использованию и предложения: [GitHub Issues](https://github.com/aspalagin/openclaw-max/issues)
- Сообщения об уязвимостях: [Security policy](SECURITY.md)
- Правила участия: [CONTRIBUTING.md](CONTRIBUTING.md)

## MAX Bot API — краткая справка

Базовый URL: `https://platform-api2.max.ru` (старый `platform-api.max.ru` отключается 19.07.2026).

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET /me | Информация о боте | user_id, name, username, commands |
| PATCH /me/commands | Команды бота | commands (полная замена списка, до 32) |
| GET /updates | Long polling | marker, timeout, types |
| POST /messages | Отправить | ?chat_id или ?user_id |
| PUT /messages | Редактировать | ?message_id (до 24ч) |
| DELETE /messages | Удалить | ?message_id (до 24ч) |
| POST /answers | Ответ на callback | ?callback_id |
| GET /chats/{id}/members/me | Членство бота | is_admin (нужно для получения событий групп) |
| PUT/DELETE /chats/{id}/pin | Закрепить/открепить | message_id |
| GET /videos/{token} | Playback-ссылки видео | urls может быть null, пока видео обрабатывается |
| POST /uploads | URL для загрузки медиа | type=image/video/audio/file |

Авторизация: заголовок `Authorization: <token>`
Лимит: 30 запросов/сек
Документация: [dev.max.ru/docs-api](https://dev.max.ru/docs-api)

Примечания:
- `GET /chats` объявлен deprecated (июнь 2026) — плагин собирает чаты в собственный реестр из событий.
- В группах long polling доставляет события только боту-администратору (проверяется в `openclaw channels status --audit`).
- Webhook: только HTTPS:443 с доверенным сертификатом; MAX ждёт HTTP 200 не дольше 30с (плагин отвечает мгновенно, обработка асинхронная).

## Авторы

- **[Petlevoy](https://github.com/petlevoy)** - отец проекта
- **Яков** (@Helpdesk_VP_bot) — архитектура, координация
- **Банзай** (@KotBanzaiBot) — реализация модулей, типы, тесты
- **openclaw-max subagent** — интеграция с OpenClaw Plugin SDK
