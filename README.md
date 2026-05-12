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
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License"></a>
</p>

---

## Why Browd

- **Open-source alternative to OpenAI Operator and Claude Computer-use.** Apache-2.0, no $200/month paywall, no waitlist, no cloud-side queue. Install the extension, point it at any provider you already pay for.
- **Runs in your own browser, with your own sessions.** Proprietary browser agents drive a remote Chromium against fresh, logged-out sessions — you exchange credentials, paste cookies, or do without authenticated tasks entirely. Browd runs the agent loop inside Chrome / Edge / Brave on your machine, against the sessions you're already logged into. GitHub, Gmail, LinkedIn, your dashboards — Browd sees them the same way you do.
- **Bring your own keys, any provider.** Models are configured per role (Planner / Navigator / Judge) and routed through OpenRouter or any OpenAI-compatible endpoint. Anthropic, Google, Meta, local — one extension, no vendor lock.
- **Adapts the plan after every step, not once at the start.** A replanner node decides continue-or-finish on each turn — if the page is different from what the planner expected, the plan is rewritten before the next tool call. Most browser-agent flows commit to a static plan and recover poorly when reality diverges.

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

## Known limits

These are the constraints currently shipping. They are documented up front rather than buried, because the fixes are larger than the value:

- **Cost.** A non-trivial multi-site research task typically uses 400–700k input tokens against `visionMode='always'`. Each turn re-attaches one fresh screenshot at ~10–14k tokens, compounding linearly with turn count. On Claude via OpenRouter that's roughly $0.50–$1.50 per such task. For "find one specific thing on one site" the cost is closer to ~$0.15–$0.30. Bring your own budget, watch the live token ring.
- **Hard `isTrusted=false` antibot walls.** Any CDP / extension-driven click generates `isTrusted=false` MouseEvents. Hard-gated sites (LinkedIn `/jobs` filters, some Cloudflare gates, Google Images result tiles) silently no-op those clicks. Browd detects the loop within three attempts and offers `hitl_click_at` — the agent pauses and asks you to click the blocked element yourself, then continues.
- **Visible freeze during heavy-vision steps.** Between LLM calls the side panel can sit idle for 20–30 s while the model processes the screenshot + state message. The agent is working; the UI just doesn't paint progress until the next tool call returns.
- **Not a research tool.** Browd is a *browser-resident agent* for concrete tasks on concrete pages, not a Deep Research / scraper substitute. For "synthesise information across N sites" Tavily + Playwright on the backend is typically cheaper and better. The positioning matters — using Browd for ten consecutive web searches is the expensive way to get a mediocre answer.

## Contributing

Local setup, repo layout, testing commands, and pull-request expectations live in [`CONTRIBUTING.md`](CONTRIBUTING.md). The AI-agent contract for working in `chrome-extension/src/background/agent/` is in [`CLAUDE.md`](CLAUDE.md).

## Acknowledgments

Browd is derived from [Nanobrowser](https://github.com/nanobrowser/nanobrowser), released under Apache-2.0. The Plan-and-Execute agent topology, LangGraph.js integration, and Chrome Web Store packaging path here diverge from upstream, but the inherited foundation — side-panel architecture, Planner+Navigator pipeline, untrusted-content wrap, and i18n scaffolding — is theirs.

The unified agent runtime uses [LangGraph.js](https://github.com/langchain-ai/langgraphjs)'s `createReactAgent` and `StateGraph`. URL → markdown extraction goes through [Jina Reader](https://r.jina.ai/) by default with a [linkedom](https://github.com/WebReflection/linkedom) fallback.

## License

Apache-2.0 — see [LICENSE](LICENSE). Upstream copyright and license notices are preserved in this repository.
