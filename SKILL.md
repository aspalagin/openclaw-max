---
name: MAX
description: Канал-плагин для подключения OpenClaw к мессенджеру MAX (max.ru). Поддерживает отправку и получение текстовых сообщений, медиа, inline-кнопки (callback/link/message/clipboard/open_app), pin/unpin, форматирование в MAX-диалекте markdown. Работает в режимах long polling и webhook. Используй когда нужно отправить сообщение через мессенджер MAX или обработать входящие сообщения из MAX.
---

# MAX — плагин для OpenClaw

Канал-плагин для интеграции OpenClaw с мессенджером [MAX](https://max.ru) через Bot API (`platform-api2.max.ru`).

## Что делает

- **Текстовые сообщения** — отправка и получение; исходящий markdown конвертируется в MAX-диалект (`++подчёркивание++`)
- **Медиа** — фото, видео, аудио (включая m4a/heic с iPhone), файлы, стикеры, контакты, геолокация
- **Inline-кнопки** — callback, link, message (suggested replies), clipboard, open_app, request_contact, request_geo_location
- **Pin/unpin** — закрепление сообщений в чатах
- **Long polling** — с персистентным marker (рестарты без потери/дублей событий)
- **Webhook** — HTTPS c обязательным secret (X-Max-Bot-Api-Secret), мгновенный ACK, последовательная обработка
- **Команды бота** — регистрация через PATCH /me из `channels.max.commands`
- **Мультиаккаунт**, DM-security (pairing/allowlist/open), пер-групповые политики

TLS-сертификат Минцифры для platform-api2.max.ru встроен в плагин — дополнительная настройка не нужна.

## Установка

```bash
cd ~/.openclaw/extensions
git clone https://github.com/aspalagin/openclaw-max openclaw-max
cd openclaw-max && npm install && npm run build
```

## Настройка

В `~/.openclaw/openclaw.json`:

```jsonc
{
  "channels": {
    "max": {
      "enabled": true,
      "botToken": "ТОКЕН_БОТА",          // или env MAX_BOT_TOKEN
      "dmPolicy": "pairing",              // pairing | allowlist | open | disabled
      "allowFrom": ["12345678"],
      "commands": [
        { "name": "status", "description": "Статус ассистента" }
      ]
    }
  }
}
```

Webhook-режим: добавить `"webhookUrl": "https://ваш-домен/max"` (только HTTPS:443,
сертификат должен быть доверенным; secret генерируется автоматически).

## Примеры использования

### Отправка сообщения

```bash
openclaw message send --channel max --target "144660345" --message "Привет из OpenClaw!"
```

Цели: числовой chat_id/user_id, `user:<id>` (адресация в личку), `@username`/публичная ссылка (только публичные каналы/чаты — резолв через GET /chats/{link}; для обычных групп используйте числовой chat_id).

### Кнопки (из message-tool агента)

```
message(action="send", target="CHAT_ID", message="Выберите:",
        buttons=[[{"text":"Да","type":"callback","payload":"yes"},
                  {"text":"Подробнее","type":"message"}]])
```

### Pin

```
message(action="pin", target="CHAT_ID", messageId="MID")
message(action="unpin", target="CHAT_ID")
```

## Требования

- OpenClaw 2026.x (plugin SDK)
- Node.js >= 20

## Поддержка

- Issues: https://github.com/aspalagin/openclaw-max/issues
