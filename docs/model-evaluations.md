# Task evaluations

## What is executable

📄 `pnpm -F chrome-extension test:eval:models` runs the real `runReactAgent`
graph, prompts and completion/navigation actions with **real candidate and
Judge model calls, but a fixture browser**. It is not browser end-to-end QA.
All page data is synthetic; no account, cookies or personal browsing data is
read. DOM extraction and readiness have separate offline regressions.

Five scenarios, identical for every candidate:

1. Extract a heading, text and full link destination.
2. Follow a link and explain its content in Russian with a source.
3. Open exactly one tab when creation reports `loading`.
4. Select the cheapest product in the requested category, ignoring a cheaper
   unrelated accessory.
5. Ask for missing shop/category information rather than claim shopping success.

The fixture exposes `go_to_url`, `open_tab`, `extract_page_as_markdown`, `wait`
and the real `task_complete`. Navigation is restricted to fixture URLs. Wait
and extraction are fixture actions, not real browser timing/DOM tests.
The fifth scenario expects an honest incomplete task result (`TASK_FAIL`),
which is a successful evaluation of that scenario, not successful shopping.

## Paid opt-in

Set `OPENROUTER_API_KEY` securely in the shell environment. It is not read from
extension storage or other projects. Choose currently available tool-capable
model IDs yourself; no silently selected default or model upgrade occurs.

```sh
export EVAL_MODELS='<candidate-model-id-1>,<candidate-model-id-2>'
export EVAL_JUDGE_MODEL='<judge-model-id>'
pnpm -F chrome-extension test:eval:models
```

Replace the placeholders. Candidates use the same model for planning,
execution and replanning. Prefer a separate Judge to reduce self-evaluation
bias; model identities are always included in the report. Judge runs only
after execution, never in the extension's normal control loop.

- Two or three distinct candidates; `EVAL_REPEATS=1` by default, allowed 1–3.
- `EVAL_MAX_REQUESTS=8` candidate HTTP attempts per scenario, allowed 3–12;
  one additional Judge request. No automatic provider retries.
- Every response is capped at 2048 output tokens; input requests above
  120,000 characters are rejected before transport. This is a size bound,
  not a precise input-token bound.
- 30-second request timeout; 120-second overall scenario deadline.
- Default two-model run has at most **90 HTTP attempts** across five tasks.
  Limits bound requests, not dollars: use a provider-side key spending limit.
- Ordinary `pnpm -F chrome-extension test` makes **no paid eval calls**.
  Missing paid-run configuration fails at startup, not a false green skip.

## Reading results

JSON reports are written to gitignored `test-runs/model-evals-<timestamp>.json`.
They contain per-model counts, scenario/repeat, observed fixture evidence,
final response, hard assertions, Judge verdict and confidence, duration and
provider-reported usage. Missing token/cost data is `null`, not an estimate.
Unexpected execution errors and unavailable/malformed Judge verdicts fail.

A run passes only when **every hard assertion passes AND Judge passes with
confidence ≥ 0.7**. Judge confidence is a model's self-report, not calibrated
accuracy. It cannot waive a wrong URL, extra tab or missing required field.
There is no “4 of 5 is good enough” release exemption in this runner.

📄 Offline tests exercise all five scenarios through the actual graph with a
scripted model transport and exercise the real Judge invocation adapter. They
also test hard-check/Judge disagreement and the HTTP budget boundary. These
are runner correctness tests, not evidence that any named live model passes.

## Still separate

The old `test:eval` component checks remain available. Its historical stub
scenarios are not a task benchmark. `test:eval:integration` still explicitly
reports that the real Chromium extension runner is unimplemented.

Before release, reload the production extension build and invoke extraction
in the actual MV3 worker; verify links, slow navigation and retired plan UI.
Only one Browd copy should be enabled. Never infer live browser success from
these fixture tests or from a passing build.
