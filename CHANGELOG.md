# Changelog

All notable changes to this project are documented in this file.

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
