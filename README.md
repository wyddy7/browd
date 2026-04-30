# Browd

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./chrome-extension/public/browd-logo-dark.svg">
  <img src="./chrome-extension/public/browd-logo.svg" alt="Browd logo" width="120">
</picture>

Browd is a fork-derived Chromium extension for local AI browser automation.

The project started from Nanobrowser and is being reshaped into a cleaner open-source browser agent: modern chat-first UI, stronger provider routing, and Speech-to-Text that is not tied to one model vendor.

## Status

Early fork cleanup and product direction work is in progress.

Current focus:

- simplify the extension UI;
- keep Speech-to-Text provider-agnostic across Gemini, OpenRouter, and Grok/xAI;
- harden experimental OpenRouter STT and dedicated Grok STT flows with real-browser QA;
- keep local extension development easy to run in Chromium-based browsers.

## Local Setup

Required:

- Node.js `>=22.12.0`
- pnpm `9.15.1`

```bash
pnpm install
pnpm build
```

The built extension is emitted to `dist/`.

## Load Locally

1. Open your browser's extensions page (`chrome://extensions/` in Chrome/Edge, `brave://extensions/` in Brave).
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this repository's `dist/` directory.
5. After each rebuild, reload the extension card.

Development watch mode:

```bash
pnpm dev
```

Background/content-script changes may still require reloading the extension card and reopening the side panel.

## Repository Shape

- `chrome-extension/` — manifest, background worker, browser automation, agent runtime.
- `pages/side-panel/` — main chat UI.
- `pages/options/` — settings UI.
- `pages/content/` — content script.
- `packages/storage/` — storage/settings abstractions.
- `packages/i18n/` — source locales and generated i18n helpers.
- `packages/ui/` — shared UI primitives.

## Attribution

Browd is derived from the Apache-2.0 licensed Nanobrowser project. Upstream copyright and license notices are preserved in this repository.

## License

Currently Apache-2.0, inherited from the upstream project.
