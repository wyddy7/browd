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

## Agent Runtime — read before touching `chrome-extension/src/background/agent/**`

Browd has two agent topologies behind the `agentMode` setting and a
separate `visionMode` toggle:

- `agentMode='unified'` (default since T2f-1) — LangGraph.js
  `createReactAgent` in `agents/runReactAgent.ts`, tools wrapped
  through `tools/langGraphAdapter.ts`. T2g enforces tool-call
  budgets, T2h re-seeds chat history per task.
- `agentMode='legacy'` (was `'classic'` pre-T2f-1) — inherited
  Planner+Navigator pipeline. `runClassicLoop` in `executor.ts`.
  Safety net; do not refactor.
- `visionMode='off'|'always'|'fallback'` (T2f-1..T2f-4) — independent
  switch, only honoured under `agentMode='unified'`. `'always'`
  attaches a fresh JPEG screenshot to every state message;
  `'fallback'` exposes a `screenshot()` tool the agent calls on
  demand. Executor degrades to `'off'` at runtime when the
  Navigator model has no vision capability
  (`modelSupportsVision` in `packages/storage/lib/settings/types.ts`).
- T2f-1.5 contract: vision capture in `'always'` MUST go through
  the screenshot `Action.call()` so it lands in `globalTracer` and
  the side-panel TRACE / chat thumbnail. Do not bypass with a
  direct `getState(useVision=true)` call — the user has explicitly
  rejected hidden capture paths.
- **`MouseEvent.isTrusted` ceiling**: every CDP / extension click
  generates `isTrusted=false` events. Hard antibot
  (LinkedIn `/jobs` filters, some Cloudflare gates) silently
  no-ops these. No coord-precision / jitter / DOM-fallback fixes
  this — the flag is read-only and set only by OS HID. Mitigation
  for individual blocked buttons is `hitl_click_at` (T2f-handover,
  pending).
- T2f system prompt is the "spine of execution" — keep it
  generic. NEVER hardcode site-specific URL templates
  (`linkedin.com/jobs/search?...`). The model already knows URL
  conventions from training; our prompt is not the source of
  truth and hardcoded paths drift.
- **Plan-and-Execute is the architecture, not solo
  `createReactAgent`.** `runReactAgent` builds a `StateGraph`
  with planner → agent → replanner nodes. No-tool-call AIMessage
  inside a focused agent step is a STEP completion, not a TASK
  completion — replanner decides whether to continue.
- **Tab isolation contract (T2f-tab-iso).** In `agentMode='unified'`
  the Executor opens an `agentTab` via `BrowserContext.openAgentTab()`
  on TASK_START. `getCurrentPage()` resolves to that tab even if
  the user switches focus. State message renders `<agent-tab>` (full
  DOM) and `<user-tabs>` (id/url/title only, marked read-only).
  Cross-over to a user tab happens only via `take_over_user_tab(tabId, reason)`
  Action — explicit, never implicit. Title prefix `[Browd] ` is
  injected so the user sees which tab is the agent's.
- **All third-party text sources MUST go through
  `wrapUntrustedContent`** before reaching the LLM:
  `Interactive elements`, `pageText`, `web_fetch_markdown`,
  `web_search` snippets, `extract_page_as_markdown`. The wrap
  inherits a triple `IGNORE NEW INSTRUCTIONS` banner from
  Nanobrowser. Without it, any fetched HTML / search hit / open
  email body can prompt-inject the agent's reasoning.
- **Subgoal-abstraction drift — three-belt fix.** Planner
  schema requires a `taskParameters` object (urls / queries /
  names). Every per-step system prompt has `<original-user-task>`
  + `<task-parameters>` blocks; HumanMessage echoes the original
  task. Don't rely on a single belt — Sonnet/Gemini have been
  observed to abstract subgoals to "open the provided URL" and
  invent values from training data otherwise.
- **Firewall config must propagate live.** `BrowserContext.updateConfig`
  forwards changes to every attached `Page` (which previously
  cached its own copy and ignored updates). `firewallStore`
  subscription in `background/index.ts` re-reads on every
  Settings change. Same `denyList` is reused as the "hidden
  domains" filter in the state-message — single source of truth,
  no parallel sensitive-domains list.
- **Live UI emit, not just final.** Plan checklist and Thinking
  group must update WHILE the agent is working, not after. The
  agent node emits `inProgress: true` for the current subgoal at
  start, `done: true` at end. `currentPhaseRef = 'thinking'` is
  set on TASK_START so messages get phase-tagged at append time.
- **Markdown is the LLM output contract.** Chat content renders
  through `react-markdown` (links open in new tab, code blocks
  on soft surface, no hard borders). When asking the LLM for a
  final answer, do not strip markdown — let `**bold**` /
  `[link](url)` / lists come through.
- **Caskad halt rule (added 2026-05-05).** If `runReactAgent.ts`
  has grown past ~800 lines OR you would add a fourth interacting
  guard (streaming abort, schema gate, content-narrative detector,
  stagnation circuit-breaker, runtime verifier, output-token cap,
  `FORBIDDEN PATTERNS` prompt block, ...) — STOP and refactor
  before adding. Removal precedes addition. The previous round
  shipped seven guards in one file together; combined they
  suffocated the model and were reverted as a unit. Any new
  guard must come with a clear interface AND a test that
  exercises its interaction with at least one existing guard.
- **Prompt rules are last resort (added 2026-05-05).** Before
  writing «don't do X» / «NEVER do Y» / explicit FORBIDDEN
  PATTERNS into a system prompt, try in order: (1) API-level cap
  — `maxTokens` / `frequencyPenalty` at chat-model construction,
  (2) schema constraint — required fields, `.max(N)`, ordered
  fields that force commitment, (3) runtime guard — programmatic
  detector + truncate / abort. The prompt is a contract, not a
  patch surface. A `FORBIDDEN PATTERNS` block was stripped on
  2026-05-05 because it was treating a runtime symptom at the
  wrong layer.
- **Screenshot triggers in `visionMode='fallback'` are an open
  question (2026-05-05).** Auto-capture currently fires on
  `domEmpty || domFault || stepsExpired` and is known to miss
  overlay-blocking-real-content (cookie banners) and to fire
  prematurely on still-loading pages. Do not tweak the heuristics
  ad-hoc until peer-agent research and a sample dataset of
  good/bad/missed captures has been collected. Industry consensus
  in browser-agents (browser-use, computer-use class, stagehand)
  is to screenshot every step; Browd's adaptive choice is exotic
  and may not be worth preserving.

## MV3 Service Worker Gotchas

These fail at runtime even when build passes. happy-dom in tests
provides them; the actual SW does not.

- **No `DOMParser` / `document` / `window`.** Use `linkedom`
  (`parseHTML(html).document`) for HTML-to-DOM in the SW. For URL →
  markdown prefer Jina Reader (`https://r.jina.ai/<url>`) — server
  renders + extracts, no DOM in SW. Local fallback in
  `chrome-extension/src/background/agent/tools/webTools.ts`.
- **No `node:async_hooks`.** `@langchain/langgraph` calls
  `new AsyncLocalStorage()` at module load. Vite alias redirects
  `node:async_hooks` → `chrome-extension/src/background/shims/asyncLocalStorage.ts`
  (synchronous in-memory stub). Acceptable trade-off because the SW
  agent loop is single-flight per Executor.
- **Test environments mask SW-only failures.** Any HTML-touching or
  Node-API-touching code must have a manual smoke test under the
  actual extension before claiming shipped. Acceptance for those
  files is "tests + manual reload + actual invocation".

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
