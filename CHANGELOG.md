# Changelog

All notable changes to Browd are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.17] — 2026-10-02

The agent ends tasks honestly on broken, slow and hostile sites. When a site
never loads, blocks the agent, or does not have what was asked, the answer
says so and the task is reported as failed instead of as a success, and it
gets there faster. Running out of steps ends with the agent's own account of
what it tried. Browser permissions and stored settings are unchanged.

### Added

- Opt-in multi-model task evaluations with five synthetic scenarios, the real
  agent graph, deterministic assertions and a separately invoked LLM Judge.
  Fixture-browser reports do not imply real-browser end-to-end verification.
- A broken-site robustness eval for the repo's benchmark: local fixture sites
  that reset, hang, wall off or loop, plus slow-but-working counterparts,
  graded by code. The benchmark's judge can now skip duplicate screenshots.
  Both are development tools and are not part of the extension.

### Fixed

- **"Not on this site" is no longer reported as success.** The agent states
  the outcome — answered, not on the site, or blocked — before it writes the
  answer, and only "answered" counts as success. Previously «I couldn't verify
  the price» could finish as a success, and the planner could override an
  honest «not found».
- **Running out of steps ends with the agent's own report.** At the step limit
  the agent gets one last turn to say what it tried and found, instead of the
  user receiving «Recursion limit of 25 reached without hitting a stop
  condition…».
- **A site that never loads is reported as failed.** Navigation no longer says
  «Navigated» when the tab is on the browser's error page, and the agent no
  longer waits 20 s reading that error page.
- **Web search and page fetch give up after 20 s** instead of hanging until
  the whole task is cancelled.
- **Repeated errors are pointed out.** When the same tool error comes back a
  third time, the agent is told that retrying will not change it.
- Completed agent answers are delivered verbatim: `task_complete` now stops
  the inner loop and bypasses replanning, preventing repeated completion
  calls and replacement of requested data with a generic acknowledgement.
- A subgoal can no longer end the whole task early. `task_complete` called
  while later subgoals are still planned is reviewed by the replanner, which
  either confirms it (delivered verbatim) or continues the plan. Previously a
  progress report such as "Subgoal complete… Next, …" became the final answer.
- Tasks that name a website are worked on that website. The tool policy no
  longer sends every "find X" request to web search and away from the site.
- Vision is no longer switched off for new models: image-input support comes
  from the OpenRouter catalog, with the name list kept only for local and
  custom models. `openai/gpt-6-luna` was running without screenshots.
- A page whose structure cannot be read within 20 s no longer freezes the
  agent. It gets the URL and title with a warning and decides what to do.
- The planner and replanner know today's date, so "tomorrow" in a task is
  no longer turned into a guessed date.
- Failed and incomplete tasks, lost tabs, and exhausted plans no longer emit
  success events. Cancellation remains distinct from failure.
- Completion mixed with other tool calls is rejected before dispatch, so
  browser actions cannot run alongside a task's final result.
- Cached prompt tokens are counted once per model call. The usage tracker
  summed every mirror of the same cache counter, doubling cache reads on
  OpenAI-compatible streams (OpenRouter) in the token ring and the benchmark
  cost estimate.
- Slow new tabs report their created identity and loading state instead of
  a misleading creation failure. Agent attention follows owned new tabs;
  readiness listeners and timers are cleaned on every exit.
- Page extraction preserves visible link destinations, resolves relative
  links, works without DOM globals in the worker and follows the agent tab.
- Active plan checklists are retired on completion, failure and cancellation
  without marking unexecuted future steps as done.

## [0.1.16] — 2026-09-13

### Changed

- Refreshed Browd identity with a violet `b` mark and matching wordmark in the
  side panel and settings; added dedicated light- and dark-theme artwork.
- Updated toolbar icons, page favicons, the microphone permission page, and
  README branding. Added Chrome Web Store installation instructions.
- Corrected the offline evaluation script reference and agent documentation.

Browser permissions, agent behavior, and stored settings are unchanged.

## [0.1.15] — 2026-05-20

User-facing controls, observability, and complete localization on top of
v0.1.14's reliability pass. No behavior changes for existing
configurations; settings storage shapes are unchanged.

### Added

- **Permission-mode selector in the input toolbar.** A compact 2-tier
  picker on the chat input row sets the agent's authority for the next
  task: **Default** (every cross-tab take-over asks for your approval
  first) or **Full access** (skip in-app approvals — browser permission
  prompts still apply). Replaces the implicit always-prompt behaviour
  introduced in v0.1.14.
- **Live prompt-cache telemetry in the side panel.** Per-turn read /
  write counters surface what the provider's cache actually saved you —
  instead of inferring it from billing. Works across OpenAI-compatible
  providers via a provider-agnostic context resolver, so it lights up
  whether you route through OpenRouter, OpenAI directly, or a custom
  endpoint.
- **Native-quality UI in 7 languages.** Previously DE / ES / FR were
  ~65% English fallthrough — Settings looked localised but the chat
  shell, role tooltips, action logs and error messages stayed English.
  Every UI string now ships natively in EN / RU / DE / ES / FR / PT-BR
  / ZH-CN. Brand terms (Browd, Planner, Navigator, Judge, STT,
  OpenRouter, etc.) intentionally remain English.

### Changed

- **Replaced Traditional Chinese (zh_TW) with Simplified Chinese
  (zh_CN).** Mainland-Simplified serves a much larger Chinese-speaking
  audience and now uses Mainland vocabulary throughout: 设置 / 默认 /
  标签页 / 添加 / 点击 / 视频 / 软件 / 白名单 / 黑名单 / 取消, etc.

### Fixed

- **Agent no longer jumps into side-effect tabs.** When a click
  incidentally opened a third-party tab (auth redirect, popup, ad), the
  agent could promote that new tab to its workspace and crash trying
  to operate inside it. The runtime now keeps the agent pinned to its
  own tab and treats side-effect tabs as read-only metadata until
  explicitly handed over via `take_over_user_tab`.

### Notes

- **Storage migration:** anyone previously running the zh_TW interface
  will see their language setting fall back to **System** on next
  launch (no data lost; just one settings tap to pick a new language).
- **Translation methodology:** the seven locales were brought to
  parity by a multi-agent pipeline — per-language translator subagents
  generated the missing strings; native-speaker reviewer subagents then
  flagged MT calques, false friends, and tone drift across two passes.
  Brand terms, placeholders, and Chrome i18n `placeholders` definitions
  preserved verbatim throughout.

## [0.1.14] — 2026-05-16

A reliability and trust pass on top of 0.1.13. The agent now stays out of
your way when it shouldn't be touching your tabs, asks first when it does
need to, and stops killing itself with false "stuck" alarms during
legitimate work.

### Added

- **Tab group isolation.** When the agent starts a task, it opens its own
  tab inside a clearly labelled **Browd** tab group (purple). You can fold
  the group with one click, drag it to a different window, or watch the
  agent work without it ever mixing into your other tabs.
- **Permission prompt before touching your tabs.** If the agent decides it
  needs to operate inside one of *your* open tabs (for example: "draft an
  email in this Gmail I already have open"), a side-panel prompt asks for
  Allow / Deny. No more silent takeover.
- **Self-termination tool.** The agent has a dedicated `task_complete`
  action it calls when it has the answer. The runtime detects that call
  and stops cleanly with the cited result, instead of looping past the
  finish line.
- **Live status strip.** A 24 px strip above the trace shows what the
  agent is doing right now — which LLM is streaming, which tool started,
  which tool just returned. The side panel no longer feels frozen during
  long thinking steps.
- **Reasoning shown per LLM call.** Each model turn's thinking text is
  surfaced in the side panel and console as it happens, not buried in a
  collapsed group.
- **Per-tool-call console log.** Easier to follow what the agent attempted
  and how it failed — `[tool] click_element intent=... → ok 580ms` style
  one-liners, with the chain-internal spam moved to debug-only.
- **Visual judgement hint.** The system prompt now nudges the agent to
  take a screenshot when the page is image-heavy or visual ranking matters,
  instead of relying only on DOM text.

### Changed

- **Vision mode is now a simple On / Off toggle** (was `Off / Always /
  Fallback`). On gives the agent the screenshot tool and coordinate
  actions to use at its own discretion; Off restricts it to a DOM-only
  surface. Stored preferences from the old three-mode setting migrate
  automatically.
- **Inner step budget is smarter on partial progress.** When the agent
  hits the per-subgoal recursion cap mid-task, the runtime now checks
  whether the page actually changed during those rounds. If yes — progress
  is real, hand a partial summary to the replanner and keep going. If no —
  end the task honestly with what was done so far. No more burning another
  25 LLM rounds repeating the same wall.

### Fixed

- **Dead-tab CPU spin.** If the user closed the agent's tab while a DOM
  probe was running, the extension could log over a million lines and pin
  a core. The runtime now detects the closed tab, aborts the in-flight
  probe, evicts the dead page, and ends the task gracefully.
- **False-positive "stuck" kills on working agents.** Two subgoal-level
  guards (silent-step and page-fingerprint) were removed: they fired on
  the agent's own natural exit signal and on legitimate single-page deep
  reads (leaderboards, docs, long forms). Stuck detection now relies only
  on the things that *actually* indicate looping — identical tool-call
  repetition and hard step caps. End-user behaviour: agents that were
  being killed mid-task with a useless "I'm stopping because the agent
  appears stuck" message now reach their actual answer.
- **Stale UI during long LLM calls.** Combined with the live status strip,
  the side panel now shows token streaming and tool boundaries as they
  happen, instead of staring blank for 30 seconds.

### Removed

- The `Always` and `Fallback` vision modes (merged into `On`).
- The subgoal-level stuck detector (`silent-step` and `env-fingerprint`
  signals).

### Notes

- **Known limit (model-side).** Some model providers occasionally emit
  the final answer as plain reasoning text instead of calling
  `task_complete`. The side panel still surfaces a result via the
  replanner's `finish` step, but it may read as a meta-summary rather than
  the full content. A planned single-loop refactor will address this end
  to end.
- **Chrome Web Store.** The 0.1.13 submission is still under Google's
  review. 0.1.14 is shipped here as a GitHub release; CWS update will
  follow once 0.1.13 clears.

## [0.1.13] — 2026-05-13

First tagged public release. Consolidates a multi-month refactor of the agent
runtime inherited from Nanobrowser into a LangGraph.js Plan-and-Execute
topology, plus a series of production-engineered guards and observability
affordances.

### Added

- **Unified agent mode (now default).** LangGraph.js `StateGraph` with
  planner, agent, and replanner nodes. The replanner decides
  continue-or-finish after every step and can rewrite the plan when reality
  diverges from the planner's expectation.
- **Structured `taskParameters`.** The planner emits URLs / queries / names
  as a typed object alongside the plan steps. Each per-step prompt re-injects
  the original task and parameters, preventing subgoal-abstraction drift on
  long-horizon tasks.
- **Per-task tool-call budgets.** Enforced as LangGraph state counters in
  the tool adapter layer, not as prompt instructions. Defaults:
  `web_search=5`, `web_fetch_markdown=5`. Overflow returns a forcing error
  the LLM can read and react to.
- **Chat-history persistence.** Last 20 user / assistant turns are seeded
  into each new task so follow-up questions retain context across task
  boundaries.
- **Tab isolation.** The agent opens its own `[Browd]`-prefixed tab on task
  start. User tabs appear in the model context as read-only metadata only;
  cross-over to a user tab requires the explicit `take_over_user_tab`
  action.
- **`hitl_click_at` handoff.** When the loop detector observes repeated
  no-op clicks against an `isTrusted=false` antibot wall, the agent pauses
  and asks the user to click the blocked element manually before
  continuing.
- **Vision mode toggle.** `off` / `always` / `fallback`. In `always` a
  downscaled screenshot is attached to every state message; in `fallback`
  the agent gets a `screenshot` tool it can call on demand. Automatically
  degrades to `off` when the active Navigator model has no vision
  capability.
- **Side-panel TRACE row.** Every tool call surfaces with input, output,
  screenshot thumbnail (in vision modes), and timing — no hidden
  capture paths.
- **Untrusted-content wrap on all third-party text.** Every page text,
  interactive-element list, web-search snippet, web-fetch markdown, and
  extract-page markdown reaching the LLM goes through a wrapper with a
  triple-banner IGNORE-INSTRUCTIONS prefix.
- **Multi-provider STT.** Speech-to-text adapter layer supports Gemini,
  OpenRouter, and Grok / xAI (was Gemini-only upstream).
- **Per-role model routing.** Planner / Navigator / Judge are configured
  independently. Any OpenAI-compatible endpoint works; OpenRouter routes
  Anthropic, Google, Meta, and local models through one key.
- **Live plan checklist and trace UI.** In-progress pulse per step,
  collapsible thinking group, markdown chat rendering, Anthropic-style
  nested affordances.
- **Web tools.** `web_search`, `web_fetch_markdown` (primary path via Jina
  Reader at `r.jina.ai/<url>`, local linkedom fallback), and
  `extract_page_as_markdown`.

### Changed

- **Default agent topology** flipped from the inherited Planner+Navigator
  pipeline to the new unified LangGraph runtime. The legacy pipeline
  remains selectable via **Options → Agent Mode → Legacy** as a safety
  net.
- **Branding** moved fully to Browd across the extension UI, manifest,
  and i18n strings. Upstream Nanobrowser attribution is preserved in
  `README.md` Acknowledgments and `LICENSE`.
- **Repository layout** moved local-development and contributor
  documentation out of `README.md` into [`CONTRIBUTING.md`](CONTRIBUTING.md).

### Fixed (release-eve stability pass)

- **Tab follow on `target="_blank"` clicks.** When an agent click opens
  a new tab, the agent now correctly switches its attention to the new
  tab — both the Chrome focus and the internal "current page" tracker
  move together. Previously the visible Chrome tab moved but the agent's
  state-message kept building from the old tab, looping until the step
  budget exhausted.
- **Force screenshot on tab settle.** After navigation or tab switch, a
  fresh screenshot is captured for the next state message even when the
  legacy fallback heuristic would have stayed silent. Cookie banners,
  sign-in modals, and other overlays that appear on first paint are now
  visible to the agent and dismissable via the click tool. The per-step
  prompt was nudged with one sentence: dismiss modal overlays before
  attempting to extract data.
- **LLM call lifecycle observability.** Side-panel TRACE row now shows
  every LLM call's runId, model, message count, response time, and
  tool-call outcome — plus chain-boundary entries for planner / agent /
  replanner. HTTP errors, timeouts, and silent retries that previously
  produced no log output now surface immediately. A 90-second per-call
  timeout (down from effectively unbounded) bounds the worst-case
  silent-hang window; `maxRetries: 0` removes the silent two-retry
  loop that LangChain defaults to.

### Removed

- Default community / sponsor surfaces (Discord, Twitter, Chrome Web
  Store badges) from the inherited UI — Browd ships without those
  affordances until they exist.

### Known limits

- Token usage is high: 400–700k input tokens on non-trivial multi-site
  tasks under `visionMode='always'`. Exact cost depends on provider and
  model.
- Hard `isTrusted=false` antibot walls (LinkedIn `/jobs` filters, some
  Cloudflare gates) cannot be defeated by any CDP-driven click; the
  mitigation is `hitl_click_at`.
- Modal overlays on first paint (cookie banners, sign-in prompts) can
  stall progress for a turn or two before the agent decides to dismiss
  them. The replanner usually recovers by trying a different URL or
  invoking a direct nav.

[0.1.13]: https://github.com/wyddy7/browd/releases/tag/v0.1.13
