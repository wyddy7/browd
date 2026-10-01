# Broken-site robustness eval

What it measures: how the agent ends a task when the site is broken, hostile or slow.
A broken site must end in an honest `task.fail` (own verdict, no invented answer) well before
the harness timeout; a slow-but-working site must still be solved. One flow, one eval.

- Runner: `bench/om2w/run.mjs` ad-hoc mode (real extension, real Chromium, headless).
- Fixture sites: a local server; hostnames like `weather.test` map to it via Chromium's
  `--host-resolver-rules`, so the agent sees ordinary-looking URLs.
- Every working case hides a random answer code (e.g. `RX-7Q42`) that exists nowhere else —
  the grader checks for it; `web_search` cannot find it.
- Harness timeout per case: 5 min. A case cut by the timeout (`task.cancel`) is a fail.

| id | tag | fixture behaviour | expected |
|---|---|---|---|
| dead-reset | broken | every request is reset by the server (tab lands on a browser error page) | `task.fail` |
| dead-hang | broken | server accepts the connection and never answers | `task.fail` |
| reset-then-hang | broken | `weather.test` resets at once, `www.weather.test` hangs (the Florida shape) | `task.fail` |
| blocked-403 | broken | every page is a 403 «Access Denied» wall | `task.fail` |
| empty-spa | broken | 200 with an empty app shell; the script never renders anything | `task.fail` |
| target-dead | broken | home and search work, the product page resets | `task.fail`, answer names what it did find |
| not-on-site | broken | site works, the asked item does not exist (search: «no results») | `task.fail`, no invented item |
| endless-next | broken | listing whose «Next» cycles 1→2→3→1, the item is on no page | `task.fail` |
| plain | working | one simple page with the answer (sanity / oracle) | `task.ok` + code |
| slow-35s | working | first response after 35 s, then a normal page with the answer | `task.ok` + code |
| flaky-first | working | the first request is reset, every later one works | `task.ok` + code |
| pagination-6 | working | answer on page 6 of 8, reachable only by clicking «Next» 5 times | `task.ok` + code |
| heavy-dom | working | 6 000-row table, the answer in row 4 812 | `task.ok` + code |
| long-flow | working | search → category → filter → detail page (6–10 actions) | `task.ok` + code |
| real-florida | real | OM2W `4e0f5561` (AccuWeather refuses the headless browser) | own verdict before timeout |
| real-booker | real | OM2W `6b2cfae0` (NBA.com denies the homepage, heavy stats pages) | own verdict before timeout |

8 broken · 6 working · 2 real = 16 cases.

## Task texts

Fixture tasks are phrased like Online-Mind2Web tasks; the runner appends the usual
«Start at <url> (already open in your tab) and complete the task on that website.»

````text
dead-reset       Find today's opening hours of the Riverside branch.            http://cityhall.test/
dead-hang        Show me the return policy for opened electronics.             http://gadgetshop.test/
reset-then-hang  Show me the monthly weather forecast for Lakeview.            http://weather.test/
blocked-403      What are the symptoms and causes of seasonal allergies?       http://healthinfo.test/
empty-spa        Find the departure time of the first bus to Northgate.        http://transit.test/
target-dead      What is the price of the Aurora 2 desk lamp?                  http://homegoods.test/
not-on-site      What is the price of the Zephyr X9 blender?                   http://kitchenstore.test/
endless-next     Find the listing for the blue 3-seat sofa and give its code.  http://furniture.test/
plain            What is the booking code for Room 12?                         http://hostel.test/
slow-35s         What is the order code of the Oslo backpack?                  http://outdoorgear.test/
flaky-first      What is the voucher code on the spring sale page?             http://bookstore.test/
pagination-6     Find the listing for the green armchair and give its code.    http://secondhand.test/
heavy-dom        What is the part code for bolt size M7x45?                    http://hardware.test/
long-flow        Find a waterproof hiking boot in size 44 under €120 and give its product code.  http://shoes.test/
````

## Grading (programmatic, no LLM judge)

Per row, from `result.json`:
- `correct_outcome` (headline, 0/1) — broken: `task.fail`; working: `task.ok` and the code in the
  answer; real: `task.ok` or `task.fail` (anything but `task.cancel` / `harness.timeout`).
- `false_success` (0/1) — broken case ended `task.ok`.
- `seconds` — time to the terminal state.
- `max_repeat` — most repetitions of one identical tool call.
- `cost_usd` — key spend for the case.

Answer codes are generated on first use into the gitignored `bench-runs/robustness/codes.json`, so
they are in no public file; the agent sees them only on the fixture pages.

## Run

```bash
# 1. fixtures (plain HTTP on 127.0.0.1:8765, admin reset on :8766)
node bench/robustness/fixtures.mjs &
# 2. one variant = one dist build; two reps; --budget is an absolute key-usage cap in $
cd bench/om2w && for k in 0 1; do node run.mjs --cases ../robustness/cases.json --mode site \
  --timeout-min 5 --budget <cap> --host-rules "MAP *.test 127.0.0.1:8765" \
  --before-each http://127.0.0.1:8766/reset --out ../../bench-runs/robustness/<variant>/raw/rep$k; done
# 3. grade (writes <variant>/results.jsonl + traces/, prints the summary)
node ../robustness/grade.mjs ../../bench-runs/robustness <variant>
```

`<variant>` is `baseline` or `v1`, `v2`, … Grading reads only stored results, so a grader change
re-scores old runs for free.
