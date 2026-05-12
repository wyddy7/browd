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

## Testing

Browd ships three layers of automated checks. Tests live in dedicated
`__tests__/` and `__evals__/` directories — nothing is scattered into
random source files.

### 1. Unit tests — `__tests__/` neighbours

Component-level tests run via vitest with happy-dom. Pure functions:
no LLM calls, no `chrome.storage`, no real browser. ~140 tests,
~1 second total.

Locations follow the "tests next to code" convention:

```
chrome-extension/src/background/agent/__tests__/
chrome-extension/src/background/agent/guardrails/__tests__/
chrome-extension/src/background/agent/hitl/__tests__/
chrome-extension/src/background/agent/state/__tests__/
chrome-extension/src/background/agent/verification/__tests__/
chrome-extension/src/background/agent/skills/__tests__/
chrome-extension/src/background/agent/tools/__tests__/
chrome-extension/src/background/browser/dom/__tests__/
chrome-extension/src/background/services/__tests__/
chrome-extension/src/background/services/guardrails/__tests__/
```

Run all unit tests:

```bash
pnpm -F chrome-extension test
```

### 2. Unit evals — `__evals__/`

Single dedicated directory:

```
chrome-extension/src/background/agent/__evals__/
├── runner.ts                        # Scenario type + helpers
├── grader.ts                        # LLM-as-judge wrapper
├── runEvals.test.ts                 # vitest harness
├── scenarios.md                     # Behaviour spec for the 5 scenarios
├── scenarios/                       # Per-scenario implementations
│   ├── plannerExtractsParameters.ts
│   ├── replannerSufficiencyGate.ts
│   ├── streamingRepetitionGuardFires.ts
│   ├── hitlSensitiveActionTrigger.ts
│   └── finalAnswerPlausibility.ts
└── integration/                     # Integration eval skeleton + plan
    └── README.md
```

**Pure-unit evals** (no LLM, no `chrome.storage`) run inside the regular
test suite — `streaming-repetition-guard-fires` and
`hitl-sensitive-action-trigger` execute on every `pnpm test`.

**LLM-cost evals** (real LLM calls — `planner-extracts-parameters`
and friends) are gated behind `RUN_EVALS=1`. Some need `chrome.storage`
and run in the integration runner only; others would work in vitest
once happy-dom shims are added.

Run LLM-cost evals manually (cost: ~$0.001-0.01 per scenario, varies
by your configured Planner / Judge models):

```bash
pnpm -F chrome-extension test:eval
```

The grader needs a Judge model configured in `Settings → Models →
Judge` — if none, it falls back to your Navigator model with a
logged warning.

### 3. Integration evals — `__evals__/integration/` (skeleton)

End-to-end checks on a real Chromium with the loaded extension via
Playwright. Currently a planning document — `pnpm test:eval:integration`
exits 1 with a pointer to the README. When implemented this layer
verifies real DOM extraction, vision capture, side-panel rendering,
tab isolation, and full task plausibility.

### Running everything before a PR

```bash
pnpm install
pnpm type-check                     # tsc --noEmit across all workspaces
pnpm -F chrome-extension test       # unit + pure-unit evals (~1s)
pnpm build                          # production bundle in dist/
```

Optional, when the change touches agent runtime:

```bash
pnpm -F chrome-extension test:eval  # LLM-cost evals (manual gate)
```

## Attribution

Browd is derived from the Apache-2.0 licensed Nanobrowser project. Upstream copyright and license notices are preserved in this repository.

## License

Currently Apache-2.0, inherited from the upstream project.
