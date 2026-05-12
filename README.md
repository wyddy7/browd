<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./chrome-extension/public/browd-logo-dark.svg">
    <img src="./chrome-extension/public/browd-logo.svg" alt="Browd" width="180">
  </picture>
</h1>

<p align="center">
  <strong>Browser-resident AI agent.</strong> Lives in your Chromium side panel, uses your real session — not a headless cloud VM.
</p>

<p align="center">
  <a href="https://github.com/wyddy7/browd"><img src="https://img.shields.io/badge/GitHub-wyddy7%2Fbrowd-181717?logo=github" alt="GitHub"></a>
  <img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/Manifest-V3-orange" alt="MV3">
  <img src="https://img.shields.io/badge/status-experimental-yellow" alt="experimental">
</p>

---

## What Browd actually does

You type something into the side panel — *"apply to the first AI Engineer job on hh.ru with my resume"*, *"open the page for the Shutterstock image of the dog"*, *"check the LM Arena leaderboard for the top open-source model right now"* — and a LangGraph.js Plan-and-Execute agent runs the task **inside one of your own browser tabs**, using whatever sessions you're already logged into. No headless replay, no cloud VM, no copy-paste of credentials.

Forked from Nanobrowser (Apache-2.0) and reshaped over T2d → T2i:

- Unified LangGraph.js ReAct + replanner loop (default `agentMode='unified'`)
- Plan-and-Execute StateGraph — planner emits structured `taskParameters` (URLs / queries / names), each subgoal runs a focused ReAct step, replanner decides continue-or-finish
- Tab isolation: agent works in its own `[Browd]`-prefixed tab; user tabs visible as metadata only; cross-over only via the explicit `take_over_user_tab` action
- Coordinate clicking via grid-overlay screenshots, with a `hitl_click_at` escape hatch for `isTrusted=false` antibot walls
- Untrusted-content wrap on every third-party page text reaching the LLM
- Provider-agnostic STT (Gemini / OpenRouter / Grok)
- Multi-provider Planner / Navigator / Judge routing via OpenRouter

Legacy Planner+Navigator pipeline is still selectable via Options → Agent Mode for fallback.

## Install (local dev build)

```bash
git clone https://github.com/wyddy7/browd
cd browd
pnpm install
pnpm build
```

Then in your Chromium-based browser:

1. Open the extensions page (`chrome://extensions` in Chrome/Edge/Brave).
2. Toggle **Developer mode**.
3. **Load unpacked** → pick this repo's `dist/` directory.
4. Pin Browd to your toolbar, click the icon to open the side panel.
5. Add your provider keys in **Options → Models** (any OpenAI-compatible endpoint works — OpenRouter is convenient for routing Anthropic/Google/Meta/local through one key).

Watch mode for development:

```bash
pnpm dev
```

Background and content-script changes require reloading the extension card after a rebuild.

## Known limits — read this before you complain

Browd is **experimental**. These are the failure modes that survived the T2i release gate; they ship as known limits rather than blockers because the fixes are larger than the value:

- **Cost.** A non-trivial multi-site research task typically uses 400–700k input tokens against `visionMode='always'`. Each turn re-attaches one fresh screenshot at ~10–14k tokens, compounding linearly with turn count. On Claude via OpenRouter that's roughly $0.50–$1.50 per such task. For "find one specific thing on one site" the cost is closer to ~$0.15–$0.30. Bring your own budget, watch the live token ring.
- **Hard `isTrusted=false` antibot walls.** Any CDP / extension-driven click generates `isTrusted=false` MouseEvents. Hard-gated sites (LinkedIn `/jobs` filters, some Cloudflare gates, Google Images result tiles) silently no-op those clicks. Browd detects the loop within three attempts and offers `hitl_click_at` — the agent pauses and asks you to click the blocked element yourself, then continues.
- **Visible freeze during heavy-vision steps.** Between LLM calls the side panel can sit idle for 20–30 s while the model processes the screenshot + state message. The agent is working; the UI just doesn't paint progress until the next tool call returns.
- **Not a research tool.** Browd is a *browser-resident agent* for concrete tasks on concrete pages, not a Deep Research / scraper substitute. For "synthesise information across N sites" Tavily + Playwright on the backend is typically cheaper and better. The positioning matters — using Browd for ten consecutive web searches is the expensive way to get a mediocre answer.

## Repo shape

```
chrome-extension/   manifest, background service worker, agent runtime
  src/background/agent/
    agents/         runReactAgent, navigator, planner, executor
    actions/        tool implementations + Zod schemas
    tools/          LangGraph adapter (T2g budget + T2i dupGuard live here)
    guardrails/     loop detector, failure classifier, approval policy
    state/          task-state classifier
    __evals__/      T3 scenario harness (3 of 5 shipped)
    __tests__/      unit tests, ~150 of them
  src/background/browser/
                    page abstraction over puppeteer + CDP
pages/
  side-panel/       chat UI
  options/          settings UI
  content/          content script
packages/
  storage/          chrome.storage abstractions, settings models
  i18n/             locales + generated type bindings
  ui/               shared primitives
```

Local AI-agent project contract lives in `CLAUDE.md` / `AGENTS.md` (symlink).

## Testing

Three layers, run roughly in this order before pushing:

```bash
pnpm type-check                          # tsc --noEmit across workspaces
pnpm -F chrome-extension test            # 148 unit tests + pure-unit evals (~1 s)
pnpm build                               # production bundle in dist/
```

Optional gated LLM-cost evals (need provider keys + `RUN_EVALS=1`):

```bash
pnpm -F chrome-extension test:eval
```

## Attribution & license

Derived from [Nanobrowser](https://github.com/nanobrowser/nanobrowser), Apache-2.0. Upstream copyright and license notices are preserved in this repository.

Browd's own changes are likewise released under **Apache-2.0**.
