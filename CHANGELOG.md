# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed

- Совместимость с OpenClaw 2026.9.3: конфиг читается через `config.current()` / `replaceConfigFile` (в рантайме плагинов убраны `loadConfig`/`writeConfigFile`), с откатом на старый API. Раньше исходящая отправка через `outbound.sendText/sendPayload` падала с `config.loadConfig is not a function`.
- Тесты на OpenClaw 2026.9.6 снова зелёные. `dmPolicy`/`groupPolicy` с дефолтами строятся на zod самого плагина: обёртка `.optional().default()` над enum-ами SDK ломалась («expected nonoptional»), когда плагин и gateway подтягивали разные копии zod (4.4 в каталоге плагина против 4.6 у gateway); значения сверяются с SDK тестом. Заглушка `IncomingMessage` в webhook-тестах получила `socket`, как у настоящего запроса.
- Команды бота регистрируются через `PATCH /me/commands` с телом `{commands:[…]}`: прежний `PATCH /me` MAX отвечает 404 `method.not.found`, так что `channels.max.commands` фактически не применялись. Удалены `MaxBotPatch` и `editMyInfo`; `setMyCommands` возвращает `BotCommandsInfo`.
- `message_callback`: плагин брал `callback.message`, которого в API нет (`message` — сосед `callback` в апдейте), поэтому ответ на нажатие кнопки уходил в `{chat_id: user_id}` вместо реального чата диалога/группы. Теперь recipient берётся из `update.message.recipient`, откат на пользователя — только если сообщение с клавиатурой удалено (`message: null`); `user_locale` пробрасывается. Нажатие кнопки бота в группе считается обращением к боту и не отсекается требованием упоминания. Типы `MessageCallbackUpdate`/`MaxCallback` приведены к схеме; тесты на живой фикстуре (DM) и групповой recipient.

### Changed

- Таймаут одиночного запроса поднят с 10 до 30 секунд (long polling не затронут, у него свой таймаут).
- Клиентский дедлайн теперь бросает типизированную `MaxRequestTimeoutError` с фазой (`awaiting-response`/`reading-body`), а текстовая отправка (`sendMaxMessage`) при таком таймауте делает один безопасный повтор на новом соединении.
- Диагностика: медленные (> 5 с) и оборвавшиеся запросы, а также медленные (> 2 с) или неудавшиеся установки соединения логируются с таймингом фаз, не раскрывая тело запроса.
- Уход с SDK-подпутей, закрываемых гейтом 2026-10-01: webhook читает тело через `readJsonWebhookBodyOrReject` из `plugin-sdk/webhook-ingress` (вместо `readJsonBodyWithLimit` из `infra-runtime`; ошибки размера/таймаута/обрыва/битого JSON — 413/408/400), тип `DmPolicy` импортируется из `plugin-sdk/config-contracts` (вместо `config-runtime`).
- Входящие медиа передаются агенту упорядоченными фактами `media` (`toInboundMediaFacts` из `plugin-sdk/channel-inbound`) вместо устаревших `MediaPath/MediaPaths/MediaUrl/MediaUrls/MediaType/MediaTypes` (снимаются гейтом 2026-10-01). Каждому вложению — локальный путь, `contentType`, имя файла и `messageId`; подписанные ссылки CDN MAX в контекст не попадают. Заодно исчез рассинхрон индексов, когда у части вложений не было `contentType`.
- `devDependencies.openclaw` поднят до `^2026.9.6`, lockfile обновлён; в CI добавлен прогон typecheck+test на последней опубликованной версии OpenClaw, в том числе с минимальной zod 4.4.3.
- Контакт-вложение отправляется полями из схемы `ContactAttachmentRequestPayload` в snake_case — `name`, `contact_id`, `vcf_phone`, `vcf_info` (раньше camelCase без `name`; сервер принимал обе формы, но документирована только snake_case). Тесты на payload всех трёх веток.
- `getMessages` принимает `before`/`after` (Unix-время, мс) вместо устаревших `from`/`to`; добавлен `getMessageById` (`GET /messages/{messageId}`).
- Контракт с Bot API сверен с `schema.yaml`: из подписки (`GET /updates types`, `POST /subscriptions update_types`) и типов убрано несуществующее событие `message_chat_created`; удалены тип кнопки `chat` и поле `intent` (не входят в `Button`, `intent` больше не отправляется); кнопка `open_app` адресуется полем `web_app` (прежний `url` переносится туда, `url` не отправляется), поддержан `payload`; в известные `update_type` добавлены `bot_admin_permissions_changed` и `comment_*`; `MaxVideoInfo.thumbnail` — объект `{url}`; `MaxRecipient.post_id`; `MaxSubscription` без `version/secret` (secret — только в теле `POST /subscriptions`). Тест сверяет подписку со списком `Update` из схемы.

## 0.6.1 - 2026-07-18

### Changed

- Удален устаревший вызов `GET /chats`: список групп теперь строится только из локального реестра событий.
- Маршрутизация вложений приведена к опубликованным форматам MAX: изображение и видео с неподдерживаемыми расширениями отправляются как файлы.
- `tokenFile` теперь используется и при разрешении учетной записи, без перехода по символическим ссылкам.

## 0.6.0 - 2026-07-14

### Added

- Public contribution, security, conduct, and support guidance.
- Continuous integration for formatting, linting, type checking, and tests.

### Changed

- Package metadata now includes search keywords, license, and supported Node.js version.
