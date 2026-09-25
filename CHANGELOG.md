# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed

- Совместимость с OpenClaw 2026.9.3: конфиг читается через `config.current()` / `replaceConfigFile` (в рантайме плагинов убраны `loadConfig`/`writeConfigFile`), с откатом на старый API. Раньше исходящая отправка через `outbound.sendText/sendPayload` падала с `config.loadConfig is not a function`.
- Тесты на OpenClaw 2026.9.6 снова зелёные. `dmPolicy`/`groupPolicy` с дефолтами строятся на zod самого плагина: обёртка `.optional().default()` над enum-ами SDK ломалась («expected nonoptional»), когда плагин и gateway подтягивали разные копии zod (4.4 в каталоге плагина против 4.6 у gateway); значения сверяются с SDK тестом. Заглушка `IncomingMessage` в webhook-тестах получила `socket`, как у настоящего запроса.
- Команды бота регистрируются через `PATCH /me/commands` с телом `{commands:[…]}`: прежний `PATCH /me` MAX отвечает 404 `method.not.found`, так что `channels.max.commands` фактически не применялись. Удалены `MaxBotPatch` и `editMyInfo`; `setMyCommands` возвращает `BotCommandsInfo`.
- `message_callback`: плагин брал `callback.message`, которого в API нет (`message` — сосед `callback` в апдейте), поэтому ответ на нажатие кнопки уходил в `{chat_id: user_id}` вместо реального чата диалога/группы. Теперь recipient берётся из `update.message.recipient`, откат на пользователя — только если сообщение с клавиатурой удалено (`message: null`); `user_locale` пробрасывается. Нажатие кнопки бота в группе считается обращением к боту и не отсекается требованием упоминания. Типы `MessageCallbackUpdate`/`MaxCallback` приведены к схеме; тесты на живой фикстуре (DM) и групповой recipient.
- Цели `@username` и ссылки max.ru больше не резолвятся через `GET /chats/{link}`: такого варианта нет в схеме, живой вызов отвечает `chat.not.found`. `resolveMaxTarget` сразу бросает понятную ошибку («MAX API does not resolve @username … use a numeric chat_id … or user:<id>») без запроса к API; `MaxApi.getChat` принимает только числовой id. SKILL.md обновлён.

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
- `describeMessageTool` объявляет реальные capabilities `presentation` и `delivery-pin` без приведения типов (раньше — несуществующее `"buttons"` через `as unknown as`). Действие `send` инструмента message рендерит `presentation` той же политикой (текст режется по 4000, клавиатура на последнем куске) и закрепляет отправленное сообщение по `delivery.pin`/`pin=true` для всех вариантов отправки; необязательный pin при ошибке не роняет отправку (`pinned:false`, `pinError`), обязательный (`required`) — роняет.
- README: в списке возможностей — `presentation`, `delivery.pin` и webhook на HTTP-сервере gateway.
- Внутреннее: импорты новых модулей отсортированы по правилам eslint, число предупреждений lint вернулось к уровню до этапа (74, ошибок 0).
- Уход с устаревших SDK-подпутей: `retryAsync` импортируется из `plugin-sdk/runtime-env` (вместо `retry-runtime`, приватного с июля 2026), `jsonResult` — из `plugin-sdk/tool-results` (вместо широкого barrel `agent-runtime`).

### Added

- `capabilities.unsend` и `capabilities.reply` (`DELETE /messages` и ответы через `link.type=reply` уже поддерживались, но не объявлялись).
- Webhook-ingress на HTTP-сервере gateway: роут регистрируется из жизненного цикла аккаунта через `registerPluginHttpRoute` (`plugin-sdk/webhook-ingress`: `auth: "plugin"`, `match: "exact"`, `pluginId`/`source`, `replaceExisting`, `throwOnFailure`) и обслуживается `handleMaxWebhookRequest`. Путь — `webhookPath`, иначе pathname `webhookUrl`, иначе `/max/webhook` (раньше `/max`). Секрет `X-Max-Bot-Api-Secret` сверяется timing-safe до чтения тела (401), тело без `update_type` — 400, валидное обновление получает 200 сразу, обработка идёт асинхронно с логированием ошибок (раньше ответ ждал `onUpdate` и при ошибке отдавал 500, провоцируя повторы MAX). Повторные доставки отсекаются LRU на 1000 ключей `(update_type, timestamp, mid|callback_id)`. Тесты: регистрация роута с mock, 200/400/401/405, дедупликация, сквозной прогон через настоящий `node:http` и `fetch`.
- Режимы транспорта `transport: "polling" | "webhook"` (по умолчанию `webhook`, если задан `webhookUrl`, иначе `polling`). В webhook-режиме polling не запускается: после регистрации роута плагин делает `GET /subscriptions`, удаляет подписки этого бота на другие URL и вызывает `POST /subscriptions {url, update_types, secret}`; при остановке подписка сохраняется, чтобы рестарт не терял события (снимается переходом на `polling` или вручную `DELETE /subscriptions?url=`). В polling-режиме активная подписка (при ней MAX не отдаёт `GET /updates`) удаляется с предупреждением. Статус webhook-аккаунта публикуется без `lastTransportActivityAt`, как у Telegram webhook, чтобы тихий канал не считался stale-socket. Секрет: `webhookSecret`, новый `webhookSecretFile` (обычный файл, не symlink) или сгенерированный один раз и сохранённый в state-файле аккаунта; формат проверяется по схеме MAX (5–256 символов `[A-Za-z0-9_-]`). Схема конфига и `openclaw.plugin.json`: `transport`, `webhookSecretFile`, `transport="webhook"` требует `webhookUrl`; тест сверяет поля манифеста с zod-схемой.
- README: раздел «Webhook» — требования MAX (HTTPS:443, 200 за 30 с, до 10 повторов, автоотписка через 8 часов, секрет в заголовке, при подписке не работает long polling), устройство роута и подписки, конфиг для этой установки (`https://max.kotbanzai.com/max/webhook`, секрет файлом), порядок включения (сначала деплой и рестарт с новым кодом в polling-режиме) и откат; обновлены таблица полей и SKILL.md.
- Контракт `presentation` в исходящем пути: адаптер объявляет `presentationCapabilities` (кнопки, select, context, divider, таблицы и графики; лимиты MAX: текст кнопки ≤128, payload ≤1024 байт, ≤30 рядов, ≤210 кнопок, текст ≤4000) и `renderPresentation`: title/tone → жирный заголовок с эмодзи тона, text/context/divider → MAX markdown, table/chart → моноширинный блок, `buttons` → `inline_keyboard` по 3 в ряд (url и web-app с URL → `link`; command/callback/approval/question → `callback` с приватным payload), `select` → ряды callback-кнопок по 2; неотрисованные кнопки остаются подписями в тексте. `sendPayload` режет текст длиннее 4000 символов (клавиатура на последнем куске) и сам рендерит payload, если presentation дошла до него неотрисованной; ответы агента (`deliverMaxReply`) проходят ту же политику через `renderPresentationForDelivery`. `delivery.pin`: `deliveryCapabilities.pin` + `pinDeliveredMessage` → `PUT /chats/{chatId}/pin` c проверкой `assertDirectAdapterHandoff` перед каждым запросом; для `user:<id>` chat id диалога берётся из `GET /messages/{mid}`. Ответ агента с `delivery.pin` закрепляет первое доставленное сообщение.
- Обратный путь presentation-кнопок на `message_callback`: approval → `resolveApprovalOverGateway` с явным `approvalKind` (`plugin-sdk/approval-gateway-runtime`), вариант `ask_user` → `questionGatewayRuntime.resolveOption` (`plugin-sdk/question-gateway-runtime`), итог — всплывающее уведомление через `POST /answers`. Нажимать approval могут только отправители, явно перечисленные в `allowFrom` (для вопросов достаточно `*`). Command-кнопка возвращается текстом команды и идёт штатным путём нативных команд; непрозрачный callback приходит агенту как `callback_data: <value>` и не разбирается как slash-команда. Payload обычных `channelData.max.buttons` по-прежнему приходит текстом без изменений. Тесты round-trip: рендер → нажатие в форме живой фикстуры → `dispatchUpdate`.
- Расшифровка голосовых от MAX: если у аудио-вложения есть `transcription` (сосед `payload` в `AudioAttachment`), агент получает `[Voice transcript: …]` в тексте, а медиа-факт помечается `transcribed: true` (`ChannelInboundMediaInput`), чтобы ядро не запускало STT повторно. Файл по-прежнему скачивается; без расшифровки (`null`, пусто) — прежний путь через STT ядра.

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
