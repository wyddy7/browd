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
  `packages/storage/lib/settings/types.ts`).
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
- **Tab isolation contract (T2f-tab-iso).** In `agentMode='unified'`
  the Executor opens an `agentTab` via `BrowserContext.openAgentTab()`
  on TASK_START. `getCurrentPage()` resolves to that tab even if
  the user switches focus. State message renders `<agent-tab>` (full
  DOM) and `<user-tabs>` (id/url/title only, marked read-only).
  Cross-over to a user tab happens only via `take_over_user_tab(tabId, reason)`
  Action — explicit, never implicit. Title prefix `[Browd] ` is
  injected so the user sees which tab is the agent's.
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
- **ApprovalPolicy runs in BOTH modes (T-hitl-unified, 2026-08-06).**
  `checkApproval` used to have exactly one call site —
  `agents/navigator.ts` — which is the *legacy* pipeline, so in
  `agentMode='unified'` (the default) submits and credential fills
  reached the page with no prompt at all. The gate now also runs in
  unified mode as the third guard inside `actionToTool`
  (`tools/langGraphAdapter.ts`), next to the tool-call budget and the
  duplicate guard; the implementation is built in `runReactAgent`
  where the browser context and `hitlController` are in scope.
  Ordering matters: approval runs LAST, so a call already blocked by
  budget or dup never raises a prompt for an action that was not going
  to run. Two behaviours worth knowing: an unanswered prompt (5-min
  timeout) fails **closed** — the action does not run; and an `edit`
  decision comes back to the model as a rejection carrying the user's
  corrected arguments, because the wrapper cannot rewrite tool input
  in place. **Credentials are refused, not approved (owner decision
  2026-08-06):** a password / CVV / card / PIN field returns `handOff: true`,
  and the gate refuses before any prompt, telling the model to ask the owner to
  type it — same shape as the `hitl_click_at` handoff. Two reasons: an agent
  typing credentials is not something to approve, and focusing such a field is
  exactly what makes password-manager extensions inject the frame that
  force-detaches the debugger. We were fighting to enable something we should
  not be doing. The policy itself is three layers — action name + args
  (model cannot reword past it), page state, then the `intent` regex
  as a widener only. Never let a gate rest on `intent` alone: that
  string is written by the LLM.
  **Approval memory (2026-08-06):** one approval covers retries of the
  same intent for the rest of the task — key is
  `action | host | args-without-intent`, held in the closure of
  `guardrails/approvalGate.ts` so its lifetime is exactly one task
  (T2q forbids replaying consent across tasks; no eviction needed).
  `intent` is excluded on purpose — caching on model-authored text
  would let a reworded new action inherit an old approval. Only
  `approve` is cached; a rejection must stay uncached so the model is
  told why each time. Auto-approvals emit a TRACE event — an approval
  the user cannot see is worse than asking twice.
- **PERCEPTION MUST NEVER LIE (2026-08-06). Hard rule.**
  `PageState.perception` (`{verdict, capturedAt, urlSource, error}`) is
  **required**, so no snapshot can reach the model without stating how it
  was obtained. `page.ts::_updateState` no longer returns the cached
  state when a capture fails: it returns `verdict:'unavailable'` with the
  element tree CLEARED and `url`/`title` re-read from `chrome.tabs.get`.
  The tabs API is the one channel that stays truthful when the debugger
  cannot attach, so it is the authority for "where am I". The state
  message renders a `<browser-state-error>` block whenever the verdict is
  not `fresh`, and the element list is declared unusable.
  Cause: the old silent cache-fallback let the model read a stale URL as
  current, "know" it had already navigated, skip `go_to_url`, and burn all
  25 recursion rounds typing into an element that did not exist. Frontier
  agents do the same thing — browser-use surfaces `<browser_state_error>`,
  Anthropic returns tool failures as `is_error`. **Never reintroduce a
  silent cache fallback; if a capture fails, say so.**
- **Never attach the debugger to a tab that is still navigating (2026-08-06).**
  `chrome.tabs.update` resolves when navigation STARTS. `openAgentTab` used to
  return right after it, so the debugger attached to the OUTGOING document.
  Every navigation inside `openAgentTab` is now followed by `waitForTabSettled`
  (bounded 8s). `status === 'complete'` ALONE is ambiguous — the outgoing
  document also reports it — so callers that just requested a navigation pass
  `expectNavigationFrom` (the pre-navigation URL) and the wait demands evidence
  the document changed (`loading` seen, `pendingUrl` present, or URL moved off
  the old one) before accepting `complete`.
- **Debugger-binding lifecycle (2026-08-06, third pass — real mechanics).**
  `ExtensionTransport.connectTab` is just `chrome.debugger.attach`; commands are
  `chrome.debugger.sendCommand`; `close()` fires a NON-awaited detach. Chrome
  denies attach/commands when ANY frame in the tab belongs to a different
  extension (Chromium `debugger_api.cc` walks every RenderFrameHost) — that is
  what `Cannot access a chrome-extension:// URL of different extension` means.
  Two triggers: a foreign new-tab override at anchor time, and a
  password-manager-style iframe injected the moment a credential field gets
  focus — the latter also FORCE-DETACHES a live session (`chrome.debugger.onDetach`,
  reason `target_closed`), and a naive re-attach fails with the very error it
  is curing while the frame persists. **The agent does not delete that frame**
  (owner decision 2026-08-06): removing another extension's DOM from the user's
  page to unblock ourselves is disproportionate, and credential fields are now
  refused outright, so the injection is rarely summoned at all. The node's
  contract now: (1) `onDetach`
  is wired `index.ts` → `BrowserContext.handleDebuggerDetached` →
  `Page.markBindingLost`, so `attached` is truthful and no zombie puppeteer
  connection survives; (2) every detach path awaits an explicit
  `chrome.debugger.detach` so re-attach cannot race the transport's
  fire-and-forget one; (3) `attachPuppeteer` tears down the raw attachment if
  the handshake fails (a dangling session makes every later attach die with
  "Another debugger is already attached"); (4) `_reattachIfStale` on the
  foreign-frame error class removes foreign `chrome-extension://` iframes via
  `chrome.scripting` (which Chrome does NOT block) and retries attach exactly
  once; (5) if the environment stays blocked, the state is honest-unavailable
  with the mechanic named (`describeBindingLoss`), never a stale snapshot.
  Recovery point is lazy — `Page._updateState`, which runs before every LLM
  step. Tests: `browser/__tests__/debuggerBindingLifecycle.test.ts`.
- **Agent tab must be drivable (2026-08-06).** `openAgentTab` anchors on
  the user's active tab, which can be a page the debugger cannot attach
  to — most often `chrome://newtab/` replaced by *another extension*, so
  the real URL is `chrome-extension://<other-id>/…`. `isAttachableUrl`
  (exported from `browser/context.ts`) gates this: an unattachable anchor
  is moved to `about:blank`, which is attachable, empty, and carries an
  honest URL. An explicit `initialUrl` still wins. A normal page is left
  alone — it is the user's tab, not ours to navigate.
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
