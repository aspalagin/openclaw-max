# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed

- Совместимость с OpenClaw 2026.9.3: конфиг читается через `config.current()` / `replaceConfigFile` (в рантайме плагинов убраны `loadConfig`/`writeConfigFile`), с откатом на старый API. Раньше исходящая отправка через `outbound.sendText/sendPayload` падала с `config.loadConfig is not a function`.

### Changed

- Таймаут одиночного запроса поднят с 10 до 30 секунд (long polling не затронут, у него свой таймаут).
- Клиентский дедлайн теперь бросает типизированную `MaxRequestTimeoutError` с фазой (`awaiting-response`/`reading-body`), а текстовая отправка (`sendMaxMessage`) при таком таймауте делает один безопасный повтор на новом соединении.
- Диагностика: медленные (> 5 с) и оборвавшиеся запросы, а также медленные (> 2 с) или неудавшиеся установки соединения логируются с таймингом фаз, не раскрывая тело запроса.

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
