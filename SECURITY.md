# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.8.x | Yes — security fixes land in the latest 0.8 release and on `main` |
| 0.7.x and older | No — upgrade to 0.8 |

0.8.0 closes several issues present in 0.7.x and older: local files outside the allowed media roots could be sent, `message`-tool actions could act in any chat of the bot, group sender lists (`groupAllowFrom`, `groups.<id>.allowFrom`) were not enforced, and debug logs carried message text. See the [changelog](CHANGELOG.md) for details.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/aspalagin/openclaw-max/security/advisories/new) and include a clear reproduction, impact, and suggested mitigation if available.

If private reporting is unavailable, open a minimal issue that asks for a private contact path without exposing technical details.
