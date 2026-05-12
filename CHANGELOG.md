# Changelog

All notable changes to Browd are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

- Cost: 400–700k input tokens on non-trivial multi-site research tasks
  under `visionMode='always'`.
- Hard `isTrusted=false` antibot walls (LinkedIn `/jobs` filters, some
  Cloudflare gates) cannot be defeated by any CDP-driven click; the
  mitigation is `hitl_click_at`.
- Modal overlays on first paint (cookie banners, sign-in prompts) can
  stall progress for a turn or two before the agent decides to dismiss
  them. The replanner usually recovers by trying a different URL or
  invoking a direct nav.

[0.1.13]: https://github.com/wyddy7/browd/releases/tag/v0.1.13
