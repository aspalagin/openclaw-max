---
name: MAX
description: Канал-плагин для подключения OpenClaw к мессенджеру MAX (max.ru). Отправка и получение текста, медиа, голосовых, пересланных сообщений, inline-кнопки (callback/link/message/clipboard/open_app), pin/unpin, markdown в диалекте MAX. Работает через webhook или long polling. Используй, когда нужно отправить сообщение через MAX или обработать входящие сообщения из MAX.
---

# MAX — плагин для OpenClaw

Канал-плагин для интеграции OpenClaw с мессенджером [MAX](https://max.ru) через Bot API (`platform-api2.max.ru`).

## Что делает

- **Текст** — отправка и получение; исходящий markdown переводится в диалект MAX (`++подчёркивание++`). Если MAX отверг разметку, сообщение уходит обычным текстом.
- **Медиа** — фото, видео, аудио, файлы, стикеры, контакты, геолокация; несколько вложений — альбомами до 12.
- **Голосовые** — входящие распознаёт ядро (`tools.media.audio`) или берётся транскрипт MAX; голосовой ответ уходит аудиовложением MAX.
- **Пересылки и цитаты** — агент видит пересланные сообщения и цитату сообщения, на которое ответили.
- **Inline-кнопки** — callback, link, message (подсказки ответа), clipboard, open_app, request_contact, request_geo_location; меню `/think`, `/fast` и других команд кнопками.
- **Pin/unpin** — закрепление в группах и каналах.
- **Webhook** (рекомендуется MAX для боевой работы) и **long polling**; события webhook переживают рестарт gateway.
- **Команды бота** — регистрация через `PATCH /me/commands` из `channels.max.commands`.
- **Несколько аккаунтов**, политики доступа для личных сообщений (pairing/allowlist/open/disabled) и групп.

TLS-сертификат Минцифры для `platform-api2.max.ru` встроен в плагин и используется только для его соединений — отдельная настройка не нужна.

## Установка

Через ClawHub:

```bash
openclaw plugins install clawhub:@aspalagin/openclaw-max
```

Через npm (имя с областью; пакет `openclaw-max` без области — другой проект):

```bash
openclaw plugins install npm:@aspalagin/openclaw-max
```

## Настройка

В `~/.openclaw/openclaw.json`:

```jsonc
{
  "channels": {
    "max": {
      "enabled": true,
      "tokenFile": "/home/you/.openclaw/secrets/max-bot-token", // абсолютный путь, обычный файл; или botToken (строка или SecretRef), или env MAX_BOT_TOKEN
      "dmPolicy": "pairing",                            // pairing | allowlist | open | disabled
      "allowFrom": ["12345678"],
      "commands": [
        { "name": "status", "description": "Статус ассистента" }
      ]
    }
  }
}
```

Webhook: `"webhookUrl": "https://bot.example.com/max/webhook"` (только HTTPS на порту 443 с доверенным сертификатом) и `"webhookSecretFile"`; без секрета плагин сгенерирует его сам и сохранит в каталоге состояния. Роут поднимается на HTTP-сервере gateway, подписку создаёт плагин. Подробности и порядок включения — README, раздел «Транспорты: webhook и long polling».

## Примеры

### Отправка сообщения

```bash
openclaw message send --channel max --target "user:12345678" --message "Привет из OpenClaw!"
```

Цели: `user:<id>` — личный диалог с пользователем; числовой `chat_id` — группа или канал (например, `-70000000000001`). `@username` и ссылки max.ru не поддерживаются: MAX Bot API их не разрешает, плагин сразу отвечает понятной ошибкой.

### Кнопки

```
message(action="send", target="CHAT_ID", message="Выберите:",
        buttons=[[{"text":"Да","type":"callback","payload":"yes"},
                  {"text":"Подробнее","type":"message"}]])
```

### Файлы, голосовые, тихая отправка

```
message(action="sendAttachment", target="CHAT_ID", path="report.pdf", caption="Отчёт")
message(action="sendAttachment", target="CHAT_ID", buffer="data:text/plain;base64,SGVsbG8=", filename="hello.txt")
message(action="send", target="CHAT_ID", path="reply.ogg", asVoice=true)
message(action="send", target="CHAT_ID", message="Без уведомления", silent=true)
```

- `asVoice=true` с аудиофайлом (`mp3`, `m4a`, `wav`, `ogg`, `opus`) отправляет аудиосообщение MAX, а не файл. Если MAX отказал в аудио, те же байты уходят файлом.
- `buffer` — содержимое в base64 или data URL, с `filename` и `contentType`; лимит размера — `mediaMaxMb` (по умолчанию 20 МБ). Если заданы и путь, и `buffer`, отправляется файл по пути.
- `silent=true` — без push-уведомления. В каналы MAX сообщения всегда уходят с уведомлением.
- Несколько вложений: `attachments=[{"path": …}, {"buffer": …, "filename": …}]` — фото и видео альбомами до 12, аудио и файлы по одному; в ответе `messageIds`, неудачные — в `mediaErrors`.

### Ограничение локальных файлов

Отправить можно только файлы из каталогов, которые OpenClaw разрешает агенту: его рабочий каталог и media-каталоги gateway. Путь вне них отклоняется ошибкой `Local media path is not under an allowed directory`; выход через `..` и символические ссылки тоже закрыт. Нужен файл извне — сначала скопировать его в рабочий каталог. Если у агента чтение с хоста, путь может быть любым, но ядро пропускает только проверенные по содержимому типы (изображения, аудио, видео, PDF, документы Office, архивы, текст `.txt`/`.md`/`.csv`/`.json`/`.yaml`); отказ — `Host-local media sends only allow …`.

### В каких чатах работают действия

`send`, `sendAttachment`, `sticker`, `edit`, `delete`, `pin`, `unpin` выполняются в текущем чате, по запросу владельца или в чатах, которые допускает политика доступа канала (`channels.max.actionScope`, по умолчанию `admitted`; `current` — только текущий чат; `off` — без проверки). Отказ — ошибка инструмента до любого изменения в MAX: сообщить о нём, не пытаться повторить в другом чате.

### Pin

```
message(action="pin", target="CHAT_ID", messageId="MID")
message(action="unpin", target="CHAT_ID")
```

В личных диалогах MAX не поддерживает закрепление: плагин не вызывает API и возвращает `pinned: false` с причиной.

## Требования

- OpenClaw ≥ 2026.9.6
- Node.js ≥ 22

## Поддержка

- Issues: https://github.com/aspalagin/openclaw-max/issues
