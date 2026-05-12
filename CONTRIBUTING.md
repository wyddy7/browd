# Contributing to Browd

Issues and pull requests are welcome. Breaking changes between
versions are expected — the agent loop is still being shaped.

## Local setup

```bash
git clone https://github.com/wyddy7/browd
cd browd
pnpm install
pnpm build
```

Then in Chrome / Edge / Brave:

1. Open `chrome://extensions/`.
2. Toggle **Developer mode**.
3. **Load unpacked** → pick the repo's `dist/` directory.
4. Open **Options → Models** and add at least one provider key. Any
   OpenAI-compatible endpoint works — OpenRouter routes Anthropic /
   Google / Meta / local through a single key.

Watch mode:

```bash
pnpm dev
```

Background or content-script changes require reloading the extension
card after each rebuild.

## Repo shape

```
chrome-extension/   manifest, background service worker, agent runtime
  src/background/agent/
    agents/         runReactAgent, navigator, planner, executor
    actions/        tool implementations + Zod schemas
    tools/          LangGraph adapter (tool-call budgets, dupGuard)
    guardrails/     loop detector, failure classifier, approval policy
    state/          task-state classifier
    __evals__/      scenario harness
    __tests__/      unit tests
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

The AI-agent contract for the runtime lives in `CLAUDE.md` (and the
`AGENTS.md` symlink). Read it before touching
`chrome-extension/src/background/agent/**` — there are non-obvious
MV3 service-worker constraints (no `DOMParser`, no
`node:async_hooks`) and architectural contracts around tab
isolation, untrusted-content wrap, and the Plan-and-Execute
StateGraph.

## Testing

Three layers, run in this order before pushing:

```bash
pnpm type-check                          # tsc --noEmit across workspaces
pnpm -F chrome-extension test            # unit tests + pure-unit evals (~1 s)
pnpm build                               # production bundle in dist/
```

Optional gated LLM-cost evals (need provider keys + `RUN_EVALS=1`):

```bash
pnpm -F chrome-extension test:eval
```

## Pull request expectations

- **Small, scoped commits.** Branch-per-slice is preferred over a
  single large PR. The recent history reshapes the agent loop one
  guard at a time; that's the cadence to mirror.
- **No bundled changes.** If a PR touches the agent runtime AND
  unrelated UI polish, expect a request to split it.
- **Include a runtime trace** in agent-runtime bug reports. The side
  panel exposes a trace export — attach the relevant turn(s) rather
  than a screenshot of the UI.
- **Don't refactor the legacy `Planner+Navigator` loop** (selectable
  via Options → Agent Mode → Legacy). It's the fallback for the
  unified LangGraph mode and stays untouched until the eval set is
  broader.

## Reporting bugs

Use the GitHub Issue templates. Include:

- Browd version (from `chrome://extensions/`).
- Browser + version.
- Provider + model in use.
- The task you typed, the page URL it was meant to run on.
- The trace export from the side panel, or at minimum a copy of the
  agent's last 3–5 tool calls.

Issues without a reproducer or trace will be closed with a request
for one.

## Security

Security-sensitive reports — please email rather than file a public
issue. See [`SECURITY.md`](SECURITY.md) for the contact and the
out-of-scope list.

## License

By contributing, you agree your contribution is licensed under
**Apache-2.0**, matching the rest of the repository.
