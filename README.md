# openclaw-max – плагин MAX для OpenClaw

Канал-плагин для подключения AI-ассистента [OpenClaw](https://openclaw.ai) к мессенджеру [MAX](https://max.ru) (ex-VK Teams / ICQ New).

## Что это

Плагин позволяет общаться с OpenClaw-ботом через мессенджер MAX — так же, как через Telegram. Поддерживает:

- Приём и отправку текстовых сообщений (MAX-диалект markdown: `++подчёркивание++`, упоминания `max://user/id`)
- Вложения (фото, видео, аудио, файлы, стикеры, контакты, геолокация)
- Inline-кнопки: callback / link / message / clipboard / open_app / request_contact / request_geo_location
- Закрепление сообщений (pin/unpin)
- Long polling (с персистентным marker) и Webhook (с обязательным secret и мгновенным ACK)
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
├── index.ts                    # Точка входа плагина
├── openclaw.plugin.json        # Манифест плагина
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── types.ts                # TypeScript-типы MAX Bot API
│   ├── api.ts                  # HTTP-клиент MAX API (retry, TLS, upload)
│   ├── russian-trusted-ca.ts   # Встроенные сертификаты Минцифры
│   ├── send.ts                 # Send-хелперы (текст, медиа, кнопки, pin)
│   ├── format.ts               # Конвертация markdown в MAX-диалект
│   ├── monitor.ts              # Long polling / диспетчеризация update'ов
│   ├── webhook.ts              # Webhook-приёмник (secret, быстрый ACK)
│   ├── state.ts                # Персист: marker поллинга + реестр чатов
│   ├── channel.ts              # OpenClaw channel adapter
│   ├── accounts.ts             # Резолвинг аккаунтов из конфига
│   ├── actions.ts              # message-tool actions (send/edit/delete/pin/…)
│   ├── config-schema.ts        # Zod-схема конфига
│   ├── model-buttons.ts        # Кнопки выбора модели
│   ├── onboarding.ts           # Setup wizard
│   └── sticker-cache.ts        # Кэш кодов стикеров
└── scripts/
    ├── test-api.mjs            # Проверка токена и API
    └── test-send.mjs           # Тест send + edit + delete
```

## Установка

### 1. Создать бота в MAX

1. Зайти на [business.max.ru](https://business.max.ru/self) (нужно юрлицо/ИП)
2. Создать профиль организации и пройти верификацию
3. Раздел **Чат-боты** → **Создать** (название, лого 500x500, описание)
4. Дождаться модерации (до 48ч по рабочим дням)
5. После модерации: **Чат-боты → Интеграция → Получить токен**

### 2. Установить плагин

```bash
# Скопировать папку плагина в extensions
cp -r openclaw-max ~/.openclaw/extensions/openclaw-max

# Загрузить плагин
openclaw plugins load ~/.openclaw/extensions/openclaw-max
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
      "dmSecurity": "allowlist"
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
| `webhookUrl` | string | нет | Включает webhook-режим вместо long polling |
| `webhookSecret` | string | нет | Секрет вебхука (автогенерируется, если не задан) |
| `streamMode` | string | нет | off (по умолчанию) / partial / block |
| `mediaMaxMb` | number | нет | Лимит скачивания медиа, МБ (по умолчанию 20) |
| `markSeen` | boolean | нет | Слать mark_seen на входящие (по умолчанию true) |
| `commands` | array | нет | Команды бота `[{name, description}]` — регистрируются через PATCH /me (до 32) |

\* Обязательно при `dmPolicy: "allowlist"`.

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
          "dmSecurity": "open"
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

- Node.js 18+ (встроенный fetch)
- TypeScript 5+

### Сборка

```bash
cd openclaw-max
npm install
npm run build          # npx tsc
```

### Проверка типов

```bash
npx tsc --noEmit
```

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

### Запуск polling вручную

```typescript
import { startPolling } from "./polling.js";

const stop = startPolling("мой_токен", async (update) => {
  console.log("От:", update.message.sender?.user_id);
  console.log("Текст:", update.message.body.text);
});

// Остановить через 60 сек:
setTimeout(stop, 60_000);
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
| PATCH /me | Обновить бота | name, description, commands (регистрация команд) |
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

- **[Petlevoy]([url](https://github.com/petlevoy))** - отец проекта
- **Яков** (@Helpdesk_VP_bot) — архитектура, координация
- **Банзай** (@KotBanzaiBot) — реализация модулей, типы, тесты
- **openclaw-max subagent** — интеграция с OpenClaw Plugin SDK
