---
name: MAX
description: Канал-плагин для подключения OpenClaw к мессенджеру MAX (max.ru). Поддерживает отправку и получение текстовых сообщений, медиа, inline-кнопки, форматирование. Работает в режимах long polling и webhook. Используй когда нужно отправить сообщение через мессенджер MAX или обработать входящие сообщения из MAX.
---

# MAX — плагин для OpenClaw

Канал-плагин для интеграции OpenClaw с мессенджером [MAX](https://max.ru) (бывший VK Teams / Mail.ru для бизнеса).

## Что делает

Плагин позволяет OpenClaw отправлять и получать сообщения через мессенджер MAX, поддерживая полный набор возможностей платформы:

- **Текстовые сообщения** — отправка и получение текстов
- **Медиа** — фото, видео, документы, голосовые сообщения
- **Inline-кнопки** — интерактивные кнопки под сообщениями
- **Форматирование** — поддержка Markdown/HTML разметки
- **Long polling** — получение сообщений через постоянное соединение
- **Webhook** — получение сообщений через HTTP-запросы
- **Мультиаккаунт** — работа с несколькими ботами одновременно

## Установка

```bash
openclaw plugin install openclaw-max
```

Или вручную:

```bash
cd ~/.openclaw/extensions
git clone https://github.com/openclaw/max openclaw-max
```

## Настройка

### 1. Получение токена

1. Создайте бота в [MAX Bot API](https://max.ru/bots)
2. Скопируйте полученный токен

### 2. Конфигурация

Добавьте в `~/.openclaw/config.yaml`:

```yaml
plugins:
  channels:
    max:
      - name: my_max_bot
        token: YOUR_BOT_TOKEN
        mode: polling  # или webhook
        webhook_url: https://your-domain.com/webhook/max  # для webhook режима
```

### 3. Переменные окружения

```bash
export MAX_BOT_TOKEN=your_token_here
```

## Требования

- OpenClaw >= 0.5.0
- Node.js >= 18.0.0
- Доступ к MAX Bot API

## Примеры использования

### Отправка сообщения

```bash
openclaw message send --channel max --target "user@max.ru" --message "Привет из OpenClaw!"
```

### Отправка с кнопками

```bash
openclaw message send \
  --channel max \
  --target "user@max.ru" \
  --message "Выберите действие:" \
  --buttons '[{"text": "Да", "callback": "yes"}, {"text": "Нет", "callback": "no"}]'
```

### Отправка файла

```bash
openclaw message send \
  --channel max \
  --target "user@max.ru" \
  --media /path/to/file.pdf \
  --caption "Документ во вложении"
```

### Использование в Python-скриптах

```python
from openclaw import OpenClaw

claw = OpenClaw()
await claw.message.send(
    channel="max",
    target="user@max.ru",
    message="Привет!",
    buttons=[
        {"text": "Кнопка 1", "callback": "btn1"},
        {"text": "Кнопка 2", "callback": "btn2"}
    ]
)
```

### Обработка входящих сообщений

```python
from openclaw import plugin

@plugin.on_message(channel="max")
async def handle_max_message(message):
    print(f"Сообщение от {message.from_user}: {message.text}")
    await message.reply("Получено!")
```

## Лицензия

MIT License

## Поддержка

- Issues: https://github.com/openclaw/max/issues
- Telegram: @Helpdesk_VP_bot, @KotBanzaiBot
