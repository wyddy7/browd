# Browd T3 — Integration Eval Skeleton

> Plan + skeleton for Playwright-based end-to-end evals. NOT shipped
> tonight; this directory documents the architecture and stubs the
> entry points so a future session can fill it in without rediscovering
> the design.

## Why integration eval

Unit evals (parent dir) test the agent runtime contract — planner
schema, replanner sufficiency-gate, guardrails, HITL trigger — by
calling the components directly with a configured LLM. They cannot
verify:

- Real DOM extraction on representative pages (forms.ts label
  resolution on hh.ru-style markup)
- visionMode='fallback' actually capturing screenshots on real
  domEmpty triggers
- Side-panel rendering correctness (TASK_OK collapse, plan checklist
  state, HITL prompt visibility)
- Tab isolation in real Chromium
- End-to-end token cost / latency on representative tasks

Integration eval covers exactly those gaps.

## Architecture

```
runner/cli.ts            ← node entry point: pnpm test:eval:integration
  ├── loadExtension()    ← Playwright launches Chromium with --load-extension=./dist
  ├── openSidePanel()    ← navigates to chrome-extension://<ext-id>/side-panel/index.html
  ├── for each scenario:
  │     ├── reset extension state
  │     ├── send task via side-panel chat input
  │     ├── poll for TASK_OK or TASK_FAIL event
  │     ├── capture trace + final response
  │     ├── run scripted assertions (DOM diff, captured network calls)
  │     └── grade via grader.ts (LLM-judge using user's configured judge model)
  └── write report to integration/reports/<timestamp>.json
```

Total cost per full suite (5 scenarios): ~$1-2 in real LLM calls.
Total wall-clock: ~10 minutes.

## Scenarios — same 5 from `__evals__/scenarios.md`

| # | Scenario | Real-page fixture |
|---|----------|-------------------|
| 1 | hh.ru apply | Local mirror of an hh.ru vacancy page (saved HTML) served via Playwright route handler |
| 2 | Gmail signin | gmail.com (real, but logged out — must produce sign-in handoff, not credential fill) |
| 3 | Wikipedia population | en.wikipedia.org/wiki/Berlin (real) |
| 4 | Multi-textarea form | Local fixture HTML with 4 textareas, no `id`, label-only |
| 5 | Submit without fill | Local fixture HTML form with required-but-empty field |

Why local fixtures for 1, 4, 5: pages change. Saving an HTML snapshot
makes the eval reproducible across runs.

## Skeleton files (TODO)

- `runner/cli.ts` — Playwright launch + scenario loop entry point
- `runner/extensionDriver.ts` — wraps `chrome-extension://...` page
  interactions: send task via composer, poll for events
- `runner/eventReader.ts` — captures STEP_TRACE + TASK_OK events
  emitted via chrome.runtime.sendMessage by the background SW
- `scenarios/01-hh-apply.ts` … `scenarios/05-submit-without-fill.ts`
- `fixtures/hh-vacancy.html`, `fixtures/multi-textarea.html`,
  `fixtures/required-empty.html`

## Setup notes (when you implement)

- Use `@playwright/test` already-versioned in browd's existing tests
  (if present); otherwise add it as a workspace devDep.
- Extension load: `chromium.launchPersistentContext(userDataDir, {
  args: ['--disable-extensions-except=' + extPath, '--load-extension=' +
  extPath] })`. Persistent context is required because manifest v3
  service workers don't survive headless ephemeral contexts in
  Playwright as of mid-2026.
- Discover extension ID from chrome.management or by parsing
  `chrome://extensions` page. Cache once per launch.
- For event capture: inject a content script into the side-panel page
  that hooks `chrome.runtime.onMessage` and forwards events to a
  WebSocket the runner listens on. Or simpler: write events to
  `localStorage` and poll.

## Out of scope for tonight

- Actual implementation. Stub `package.json` script
  (`test:eval:integration`) currently exits 1 with a pointer to this
  README.
- Scenario fixtures.
- CI integration.

When this gets implemented, update `auto-docs/browd-t3-scope.md`
to mark integration scenarios as "ready".
