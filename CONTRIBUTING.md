# Contributing to openclaw-max

Thanks for improving the MAX channel for OpenClaw.

## Before opening a pull request

1. Open an issue first for substantial changes, so the approach can be discussed.
2. Keep each pull request focused on one problem.
3. Do not include credentials, access tokens, chat identifiers, or production data.
4. Add or update tests when behavior changes.

## Local checks

Use Node.js 22 or newer, then run:

```bash
npm install --ignore-scripts
npm run format
npm run lint
npm run typecheck
npm test
```

## Pull request notes

Describe the user-visible change, relevant MAX Bot API behavior, and how you tested it. Keep documentation in Russian when editing existing Russian-language documentation.
