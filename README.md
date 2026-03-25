# openclaw-max – плагин MAX для OpenClaw

Канал-плагин для подключения AI-ассистента [OpenClaw](https://openclaw.ai) к мессенджеру [MAX](https://max.ru) (ex-VK Teams / ICQ New).

## Что это

Плагин позволяет общаться с OpenClaw-ботом через мессенджер MAX — так же, как через Telegram. Поддерживает:

- Приём и отправку текстовых сообщений
- Вложения (фото, видео, аудио, файлы)
- Inline-кнопки (callback / link)
- Форматирование (markdown / HTML)
- Long polling и Webhook
- Мультиаккаунт
- DM-security и pairing

## Структура проекта

```
openclaw-max/
├── index.ts                # Точка входа плагина
├── openclaw.plugin.json    # Манифест плагина
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── types.ts            # TypeScript-типы MAX Bot API
│   ├── polling.ts          # Long polling (приём обновлений)
│   ├── api.ts              # HTTP-клиент MAX API (send/edit/delete/upload)
│   ├── sender.ts           # Высокоуровневые send-хелперы
│   ├── channel.ts          # OpenClaw channel adapter
│   ├── config.ts           # Резолвинг аккаунтов из конфига
│   ├── media.ts            # Скачивание входящих вложений
│   └── buttons.ts          # Inline-кнопки и callback-ответы
└── scripts/
    ├── test-api.mjs        # Проверка токена и API
    └── test-send.mjs       # Тест send + edit + delete
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
| `botToken` | string | да | API-токен бота |
| `allowFrom` | string[] | да* | Список разрешённых user_id |
| `dmSecurity` | string | нет | Политика: allowlist / open / pairing |

\* Обязательно при `dmSecurity: "allowlist"` (по умолчанию).

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

## MAX Bot API — краткая справка

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET /me | Информация о боте | user_id, name, username |
| GET /updates | Long polling | marker, timeout, types |
| POST /messages | Отправить | ?chat_id или ?user_id |
| PUT /messages | Редактировать | ?message_id (до 24ч) |
| DELETE /messages | Удалить | ?message_id (до 24ч) |
| POST /answers | Ответ на callback | ?callback_id |

Авторизация: заголовок `Authorization: <token>`
Лимит: 30 запросов/сек
Документация: [dev.max.ru/docs-api](https://dev.max.ru/docs-api)

## Авторы

- **Яков** (@Helpdesk_VP_bot) — архитектура, координация
- **Банзай** (@KotBanzaiBot) — реализация модулей, типы, тесты
- **openclaw-max subagent** — интеграция с OpenClaw Plugin SDK

## Ссылки

- **GitHub:** https://github.com/aspalagin/openclaw-max
- **MAX Bot API:** https://dev.max.ru/docs-api
- **OpenClaw:** https://openclaw.ai
