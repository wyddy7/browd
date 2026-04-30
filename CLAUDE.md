# Browd Agent Contract

This file is the canonical instruction file for AI coding agents working in this repository. `AGENTS.md` is a symlink to this file.

## Project

Browd is a fork-derived Chromium extension for local AI browser automation. It started from Nanobrowser, but this repository is intended to diverge in branding, product UI, and provider architecture.

Primary goals:

- Build a clean open-source showcase extension under the Browd brand.
- Keep the chat/side-panel experience calm, modern, and useful.
- Support flexible model routing through providers such as OpenRouter.
- Decouple Speech-to-Text from Gemini-only assumptions.

## Commands

Use `pnpm` only.

```bash
pnpm install
pnpm dev
pnpm build
pnpm type-check
pnpm lint
pnpm -F chrome-extension test
pnpm zip
```

Prefer scoped commands when working in one workspace:

```bash
pnpm -F pages/side-panel build
pnpm -F pages/options build
pnpm -F chrome-extension build
pnpm -F packages/storage type-check
```

## Local Extension QA

Production build output is `dist/`.

1. Run `pnpm build`.
2. Open the browser extensions page (`chrome://extensions/` in Chrome/Edge, `brave://extensions/` in Brave).
3. Enable Developer mode.
4. Load unpacked extension from `dist/`.
5. After rebuilding, reload the extension card and reopen the side panel.

`pnpm dev` can be used for watch builds, but background/content-script changes may still require extension reload.

## Repository Shape

- `chrome-extension/` — manifest, background service worker, agent runtime, browser automation.
- `pages/side-panel/` — main chat UI.
- `pages/options/` — settings UI.
- `pages/content/` — content script.
- `packages/storage/` — Chrome storage abstractions and settings models.
- `packages/i18n/` — source locales and generated i18n helpers.
- `packages/ui/` — shared UI primitives.

Do not edit generated outputs:

- `dist/**`
- `build/**`
- `packages/i18n/lib/**`
- workspace `dist/**`

## Branding

User-facing surfaces should say Browd, not Nanobrowser, unless referencing upstream attribution, license history, or migration notes.

Preserve Apache-2.0 attribution requirements while removing upstream community, sponsor, and store copy from the active public surface.

## Frontend Direction

Use a chat-first product interface:

- calm dark shell;
- compact, legible settings;
- restrained accent color;
- no legacy blue-heavy Nanobrowser styling;
- no generic AI gradients or decorative card walls.

## Provider And STT Rules

Planner/Navigator model routing already supports multiple providers, including OpenRouter.

Speech-to-Text must be provider-agnostic:

```text
selected STT model
-> provider lookup
-> STT adapter resolver
-> provider-specific adapter
-> transcript
-> chat input
```

Rules:

- Do not hardcode STT to `provider.type === "gemini"`.
- Preserve direct Gemini STT behavior while adding adapters.
- OpenRouter STT is experimental and must fail clearly when a model or endpoint rejects audio.
- Do not log API keys, Authorization headers, full audio base64, or raw audio request bodies.
- Allowed logs: provider type, model ID, MIME type, audio byte length, HTTP status, sanitized error.

## i18n

Edit source locale JSON under `packages/i18n/locales/**`.

Do not edit generated files under `packages/i18n/lib/**`.

Use existing key prefixes:

- `chat_` — chat UI
- `options_` — settings UI
- `bg_` — background service worker
- `permissions_` — permission UI
- `errors_` — shared/global errors

## Git Workflow

Work in small commits. Prefer branch-per-slice:

- cleanup/docs;
- branding;
- UI restyle;
- STT adapter refactor;
- OpenRouter STT.

Before committing code changes, run the narrowest useful check and `pnpm build` when extension behavior changes.
