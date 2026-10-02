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

Task/model comparison: see `docs/model-evaluations.md`. The opt-in
`pnpm -F chrome-extension test:eval:models` runs real models + Judge against
the real graph with a fixture browser. Normal tests stay offline. Judge is
not a runtime gate; hard assertions cannot be overridden by its verdict.

Live-web benchmark (Online-Mind2Web subset, graded by the official WebJudge):
`bench/om2w/README.md`. Needs a built `dist/` and an OpenRouter key in the
gitignored `.env.bench.local`; run output lands in the gitignored `bench-runs/`.

Broken-site robustness eval (local fixture sites that reset, hang, wall off or
loop, plus slow-but-working counterparts; graded by code, no judge):
`bench/robustness/CASES.md`. Same runner and key; costs about $0.004 per case.

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

### Automated QA — prefer this to clicking by hand

`bench/om2w/run.mjs` drives the real built extension with no human in the loop:
`node bench/om2w/run.mjs --task "<task>" --url <start page>` runs one task in a fresh
Chromium profile and writes the answer, every tool call, the plan, a screenshot per
step and the event log under `bench-runs/`. The same runner does the Online-Mind2Web
benchmark (see Commands). How it works, and the traps already paid for:

- Playwright `launchPersistentContext` with `--load-extension=dist` (MV3 workers do not
  survive ephemeral contexts), `channel: 'chromium'` so it runs Chrome's new headless,
  which loads extensions. Headless is the default because a headed window steals focus
  and switches macOS Spaces on every task; `--headed` is for sites whose anti-bot wall
  rejects headless (the 2026-09-27 benchmark ran headed). Uses Playwright's own Chromium.
- Write `llm-api-keys` / `agent-models` / `general-settings` / `firewall-settings` into
  `chrome.storage.local` from an extension page — the worker handle Playwright returns
  has no `chrome.storage`.
- The background accepts the `side-panel-connection` port only from the exact
  `side-panel/index.html` URL: open it as a tab, wrap `chrome.runtime.connect` via
  `addInitScript` to tap the React app's own port, and post `new_task` with an explicit
  `tabId` (the side panel's "active tab" would be itself).
- HITL requests arrive as runtime messages `browd:hitl:request`; answer with
  `{type:'hitl_decision', id, decision}` on the port. Automated runs always reject.
- Service-worker console: `--sw-log` adds `--remote-debugging-port` and reads
  `Runtime.consoleAPICalled` over the worker's CDP WebSocket — that is how the
  `_updateState` hang was pinned.
- Deny `google.com` in the firewall for automated runs: repeated agent searches from one
  IP hit Google's captcha wall within minutes.
- Result fields worth grepping: `terminal_state`, `premature_stop_suspect` (answer text
  says work remains — the signature of the subgoal-ends-task bug), `tools`, `seconds`.

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
- `visionMode='off'|'on'` — independent switch, only honoured under
  `agentMode='unified'`. `'on'` exposes the full tool surface
  (`screenshot()`, coordinate actions, DOM tools, take_over_user_tab);
  the LLM decides when to capture a frame. `'off'` strips the
  `screenshot()` tool and the coordinate tools, leaving a pure DOM
  surface. State messages are always text-only — the runtime never
  auto-attaches images. Mirrors browser-use, Stagehand, OpenAI
  Operator, and Anthropic computer-use, all of which let the agent
  drive its own perception loop. Executor degrades `'on'` to
  `'off'` at runtime when the Navigator model has no vision
  capability (`modelSupportsVision` in
  `packages/storage/lib/settings/types.ts`). The OpenRouter catalog's
  `input_modalities` (cached by `openrouterModels.ts`) answers first;
  the name-hint list is only a fallback for local runtimes and custom
  endpoints. Never decide model capabilities from a name list alone —
  it silently disabled vision for `gpt-6-*` (2026-09-27).
- **Tool policy: the site first.** When the task names a website or the
  page is already open, the agent works on that site; `web_search` is for
  open-web questions that name no site. A "search first, never open a tab"
  rule once sent every "find X" task away from the site it was about.
- Screenshot capture path: every `screenshot()` call MUST go through
  the `Action.call()` pipeline so it lands in `globalTracer` and the
  side-panel TRACE / chat thumbnail. Do not bypass with a direct
  `getState(useVision=true)` call — hidden capture paths are
  explicitly rejected.
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
- **Current architecture: Plan-and-Execute (provisional, slated for
  migration).** `runReactAgent` builds a `StateGraph` with planner →
  agent → replanner nodes. A no-tool-call AIMessage inside the inner
  `createReactAgent` step is the EXPECTED exit signal (natural ReAct
  termination per LangGraph.js semantics), not a failure. Migration
  to single-loop (one `createReactAgent` as the top-level loop +
  `task_complete` / `replan` as schema-forced sentinel tools) is
  planned as a separate tier — this is the 2026 industry convergence
  across browser-use (github.com/browser-use/browser-use), Anthropic
  computer-use (docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool),
  and OpenAI Computer-Using Agent (openai.com/index/computer-using-agent).
  Until migration ships, do not add new guards that try to "detect"
  a silent inner-step exit — that signal is the framework's
  termination, not a stall.
- **Authoritative completion.** `task_complete` runs through `Action.call`,
  returns a validated `ActionResult` (`isDone`, `success`, verbatim answer),
  and becomes a LangGraph `returnDirect` tool with a typed result artifact.
  Its schema has a required `outcome` — `answered` / `not_on_site` /
  `blocked`, no default, placed before `response` — and only `answered` is
  a success. The replanner's finish uses the same field and definition
  (anything the user asked for that the response does not contain is not
  `answered`). A boolean `success` that defaulted to true and was defined as
  «false only when blocked» reported «I couldn't verify…» as success on the
  2026-10-01 robustness eval.
  `TaskOutcome` is the graph's only terminal state. The agent routes directly
  to END when it exists; replanning is only for nonterminal subgoals.
  `task_complete` from the **last** planned subgoal is terminal. From an
  earlier subgoal it is a `proposal`: the replanner sees it and either
  confirms it (`finish` + `outcome=answered` → the proposal, verbatim) or
  continues the plan. Reason: on the 2026-09-27 Online-Mind2Web run subgoal
  agents called it after subgoal 1 with progress reports and ended 6 tasks
  early. A finish right after a not-answered proposal cannot come out as
  completed (`reviewedStatus` in `taskOutcome.ts`). Never infer completion from model tool-call arguments, text
  prefixes, a nonempty answer, or an exhausted plan. Failed/incomplete results emit TASK_FAIL;
  user cancellation emits TASK_CANCEL. Completion must be a standalone tool
  call: mixed batches are rejected before any tool executes. Offline tests
  exercise the actual LangGraph runtime with a scripted provider transport.
- **Step limit ends with a final turn (issue #10).** A subgoal's inner ReAct
  graph runs with `recursionLimit: 25`. When it is reached, `agents/finalTurn.ts`
  gives the model one more turn with `task_complete` as the only tool; the
  result follows the completion rules above (last subgoal → terminal, earlier
  → proposal). A forced final that is not `answered`, or a final turn with no
  completion, counts as a failed subgoal for the replanner, so the
  consecutive-failure guard ends a plan whose every step runs out — its message
  carries the last attempt's own report. The transcript passed to the final
  turn is cut at the first unanswered tool call, matched by message type: a
  streamed graph stores `AIMessageChunk`, not `AIMessage`, and the provider
  rejects an unanswered call («No tool output found for function call …»).
  LangGraph's «Recursion limit of N reached…» text never reaches the user —
  neither from a subgoal nor from the task-level limit. This replaced the
  page-fingerprint soft-fail (T2p-3).
- **Tab isolation contract (T2f-tab-iso).** In `agentMode='unified'`
  the Executor anchors the user's active tab via `BrowserContext.openAgentTab()`
  on TASK_START and groups it. `getCurrentPage()` resolves to that tab even if
  the user switches focus. State message renders `<agent-tab>` (full
  DOM) and `<user-tabs>` (id/url/title only, marked read-only).
  Cross-over to a user tab happens only via `take_over_user_tab(tabId, reason)`
  Action — explicit, never implicit. Title prefix `[Browd] ` is
  injected so the user sees which tab is the agent's.
  - `openTab` separates creation from readiness: once created, it returns
    the tab ID and `ready`/`loading`/`unavailable`, never a generic retryable
    creation failure. Owned new tabs become the agent's attention target;
    debugger attachment is lazy. Grouping failure preserves the old anchor.
    `tabReadiness.ts` owns event/timer cleanup on all exit paths.
  - **Side-effect new-tab handling (fixed 2026-05-17, commit `094f56f`).**
    `click_element` / `click_at` / `type_at` previously auto-switched
    to any new tab spawned by the click (target="_blank", window.open).
    That promoted the new tab to `_agentTabId` via context.ts
    T2o-agent-tab-follow, and the LLM could then close its own anchor
    and crash with "agent tab no longer reachable" (test28-31). All
    three handlers now use the shared `detectSideEffectNewTab` helper
    in `actions/builder.ts` — they only REPORT the new tab id with an
    explicit `take_over_user_tab(id, "<why>")` hint and never switch.
    Cross-over decision moves to the LLM via the standard action.
- **Permission posture — Default vs Full access.** The side-panel
  input toolbar shows a `PermissionModeSelector` pill driving the
  `generalSettings.permissionMode: 'default' | 'full'` field.
  `take_over_user_tab` reads it per call and skips its HITL approval
  prompt when posture is `'full'`. `hitl_click_at` always prompts
  regardless — that gate exists for isTrusted-blocked buttons where
  the user IS the only solution (no automation can bypass). Add new
  HITL gates by checking `(await generalSettingsStore.getSettings()).permissionMode`
  at decision time, mirroring the take-over handler.
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
  Terminal outcomes retire the active pinned checklist with an empty plan
  event. Never mark unexecuted future subgoals done to make a counter reach N/N.
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
- **Screenshot timing is LLM-owned.** The runtime no longer
  auto-attaches images on any cadence. Under `visionMode='on'` the
  `screenshot()` tool is in the registry and the system prompt
  tells the model when it's worth calling (DOM empty / DOM-fault
  retry / post-navigation verify / non-DOM surfaces). This matches
  browser-use, Stagehand, OpenAI Operator and Anthropic computer-use.
  Do not reintroduce auto-capture heuristics — the adaptive triple
  (`always` / `fallback` / `off`) collapsed into `on` / `off` for
  this reason. The `pendingForceScreenshot` flag set by `switchTab` /
  `navigateTo` is preserved for a future cookie-overlay / tab-settle
  surface (e.g. prompt hint) but is intentionally unread today.

## Page State Deadline

`Page.getState` gives the DOM-tree build `STATE_BUILD_DEADLINE_MS` (20 s,
`browser/stateDeadline.ts`). On the deadline it aborts the build and returns
URL and title with **no** interactive elements plus `stateNote`, which the
state message renders as `<page-state-warning>`. Empty elements on purpose:
a stale selector map would send clicks to the wrong element. The degraded
state is not cached. Tab-gone aborts still reject as `TabGoneError`.

## Agent Spider (content script)

`pages/content/` hosts the agent spider (`src/spider/`: `engine.ts` commands and
modes, `rig.ts` body and drawing, `brain.ts` behaviour by the agent's mood,
`stickers.ts` torn-out words, `motion.ts` glides — every move starts and stops without a kick, `reader.ts`, `overlay.ts`). `Page` talks only to the
`PagePresence` interface (`browser/presence.ts`); `browser/spider.ts`
(`SpiderBridge`) implements it and reads agent events from the one subscription in
`background/index.ts` through `browser/agentMood.ts`. During a burst of navigations it waits in the chat panel: `side-panel/src/spiderPanel.ts` runs the same engine there (alias `@spider`); the move between page and panel is one flight drawn by both, mapped by `browser/portal.ts`. Full contract, checks and
open questions: `docs/agent-spider.md`. Never break its invariants: the site's DOM
is never modified (torn words, marks and holes are canvas drawing), the host
element is never touched after creation (`readClickSignature` hashes `outerHTML`),
every bridge call is capped and swallows its errors, captures never contain it,
legs are never drawn longer than their bones and never meet (e2e C12/C23), benchmark runs disable it
(`spider-settings.enabled = false`). E2E: `bench/spider/e2e.mjs` (overlay, no
model) and `bench/spider/pipeline.mjs` (real agent on a scripted localhost model, $0).

## In-product notices (side panel)

`pages/side-panel/src/notices/`: a feature intro or "what's new" notice, shown once
to new and existing users alike — `noticesStore` (`packages/storage`, key
`browd-notices`) keeps the seen ids; an id missing there is shown the next time
its trigger fires (`open` = the panel opened, `task-start`). To add one: an entry
in `registry.ts` with a new id (a changed text needs a new id), its strings in
every locale, and an `anchor` (`data-notice-anchor` on the control) if it is
about a control — the notice grows out of that control and folds back into it
(`springBox.ts`, motion-morph springs; `prefers-reduced-motion` = no motion). It is
a low bar docked over the composer, its full width, two lines: title + actions,
then one line of text (owner 👤 03.10: «широким и низким, 2 строки … не в углу»).
First notice: `spider-hello` at the first task with the spider on. Checked by
`bench/spider/pipeline.mjs` P14 (the task is sent through the panel composer, so
the panel sees the task's events).

## MV3 Service Worker Gotchas

These fail at runtime even when build passes. happy-dom in tests
provides them; the actual SW does not.

- **No `DOMParser` / `document` / `window`.** Use `linkedom`
  (`parseHTML(html).document`) for HTML-to-DOM in the SW. For URL →
  markdown prefer Jina Reader (`https://r.jina.ai/<url>`) — server
  renders + extracts, no DOM in SW. Local fallback in
  `chrome-extension/src/background/agent/tools/webTools.ts`.
  Pass a parsed node, not an HTML string, into Turndown: its browser build
  otherwise calls global `document`. Worker regressions must exercise that
  distribution, not its Node DOM fallback. Visible-text extraction includes
  visible link destinations and targets the agent page, not user focus.
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
- `pages/content/` — content script (top frame only; hosts the agent spider).
- `packages/storage/` — Chrome storage abstractions and settings models.
- `packages/i18n/` — source locales and generated i18n helpers.
- `packages/ui/` — shared UI primitives.

Do not edit generated outputs:

- `dist/**`
- `build/**`
- `packages/i18n/lib/**`
- workspace `dist/**`

## Branding

The approved violet `b` artwork lives in `assets/brand/browd-master.png`.
Use `chrome-extension/public/browd-logo.png` for in-product identity on the light
theme and `browd-logo-dark.png` (same silhouette, lifted lightness) on the dark theme; `icon-{16,32,48,128}.png` are the manifest exports. The shared
`.browd-brand` / `.browd-wordmark` styles keep header identity consistent.
Keep gradients inside the brand artwork and preserve neutral product controls.
Export notes and provenance live in `assets/brand/README.md`.

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
