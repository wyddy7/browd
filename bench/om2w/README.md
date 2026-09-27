# Online-Mind2Web harness for Browd

Runs the built extension (`dist/`) on live websites from the
[Online-Mind2Web](https://github.com/OSU-NLP-Group/Online-Mind2Web) benchmark and grades the
trajectories with the benchmark's own judge, WebJudge.

## Pieces

| File | What it does |
|---|---|
| `subset30.json` | 30 tasks, 10 easy / 10 medium / 10 hard, drawn with seed `20260927`. Task text, start site and level come from the public Online-Mind2Web task list; each task carries the benchmark's 2025 human labels for six reference agents. |
| `run.mjs` | Playwright launches Chromium with the extension, writes provider/model/settings into `chrome.storage`, opens the start site, and posts `new_task` through the side-panel port. Records events, tool calls, HITL requests and a screenshot per step. HITL requests are always rejected — a benchmark run never submits forms, bookings or purchases. |
| `judge.py` | Official WebJudge (vendored in `vendor/`, MIT) against OpenRouter. Changes: no `temperature`, a 3000-token cap instead of 512 (reasoning judges can spend 512 on hidden reasoning and return nothing), and at most 3 requests in flight (OpenRouter reserves the worst-case cost of each in-flight request against the key). |
| `analyze.py` | Scores per run and judge, judge agreement, per-level split, the six reference agents on the same tasks, tool usage, per-task table. |

## Run

```bash
pnpm build                                   # from the repo root
cd bench/om2w && npm install && npx playwright install chromium
printf 'OPENROUTER_API_KEY=...\nBENCH_MODEL=openai/gpt-6-luna\n' > ../../.env.bench.local   # gitignored
node run.mjs --mode site                     # or --mode as-shipped; --only <ids>; --sw-log for worker console
uv run --with openai --with pillow python judge.py ../../bench-runs/<run> --model openai/gpt-6-sol
python3 analyze.py ../../bench-runs/<run>
```

Ad-hoc: `node run.mjs --task "<any task>" --url <start page>` — one task, no judge; read
`result.json` (answer, tools, `premature_stop_suspect`) and the screenshots.

Regression without a judge: rerun only the tasks that showed a bug (`--only <8-char id prefixes>`)
and check the field that encodes it, e.g. `premature_stop_suspect` for the subgoal-ends-task bug.

Modes: `as-shipped` sends the task text verbatim; `site` appends one sentence naming the start site
("Start at <url> (already open in your tab) and complete the task on that website"), which is how
Online-Mind2Web harnesses usually frame a task.

Tasks the site itself refuses (geo-block, bot wall) are listed by hand in
`<run>/not_executable.json` and left out of the denominator, as the benchmark's label 2 does.

## Caveats

- Screenshots are viewport-only. The agent reads the whole DOM, so a judge can miss evidence below
  the fold.
- Reference agents were labelled by humans in 2025 on the sites as they were then; Browd runs are
  graded by WebJudge on the sites as they are now. Read the comparison as a rough scale, not a
  controlled A/B.

Online-Mind2Web task data: CC-BY-4.0, OSU NLP Group. WebJudge code: MIT, OSU NLP Group.
