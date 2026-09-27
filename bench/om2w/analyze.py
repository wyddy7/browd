"""Summarise judged Online-Mind2Web runs for Browd.

Usage: python3 analyze.py <run_dir> [<run_dir> ...]  -> prints a markdown report block per run.
Reads result.json per task, judged.jsonl (GPT judge) and judged_fable*.jsonl (Claude judge) if present,
and not_executable.json (task ids blocked by the site: geo-block / bot wall), written by hand after review.
"""
import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent
SUBSET = {t["task_id"]: t for t in json.loads((HERE / "subset30.json").read_text())}
BROWSER_TOOLS = {
    "click_element", "fill_field_by_label", "input_text", "go_to_url", "scroll_to_bottom", "scroll_to_top",
    "scroll_down", "scroll_up", "send_keys", "select_dropdown_option", "click_at", "type_at", "open_tab",
    "switch_tab", "extract_page_as_markdown", "screenshot", "go_back", "scroll_to_text", "get_dropdown_options",
    "wait", "take_over_user_tab", "search_google",
}
WEB_TOOLS = {"web_search", "web_fetch_markdown"}


def read_jsonl(paths):
    rows = {}
    for p in paths:
        for line in p.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                rows[r["task_id"]] = r
    return rows


def report(run: Path):
    results = {json.loads(p.read_text())["task_id"]: json.loads(p.read_text()) for p in run.glob("*/result.json")}
    gpt = read_jsonl([run / "judged.jsonl"] if (run / "judged.jsonl").exists() else [])
    fable = read_jsonl(sorted(run.glob("judged_fable*.jsonl")))
    blocked = set(json.loads((run / "not_executable.json").read_text())) if (run / "not_executable.json").exists() else set()
    ids = [i for i in SUBSET if i in results]
    mode = next(iter(results.values())).get("mode", "?") if results else "?"
    print(f"\n## Run `{run.name}` (mode: {mode}) — {len(ids)} tasks")
    denom = [i for i in ids if i not in blocked]
    for name, judged in (("GPT-6 Sol (WebJudge)", gpt), ("Claude Fable (WebJudge protocol)", fable)):
        if not judged:
            continue
        passed = [i for i in denom if judged.get(i, {}).get("label") == 1]
        per_level = Counter(SUBSET[i]["level"] for i in passed)
        tot_level = Counter(SUBSET[i]["level"] for i in denom)
        lv = ", ".join(f"{l} {per_level[l]}/{tot_level[l]}" for l in ("easy", "medium", "hard"))
        print(f"- **{name}: {len(passed)}/{len(denom)} ({100 * len(passed) / max(1, len(denom)):.0f}%)** — {lv}; excluded as not executable: {len(blocked & set(ids))}")
    both = [i for i in denom if i in gpt and i in fable]
    if both:
        agree = sum(gpt[i]["label"] == fable[i]["label"] for i in both)
        print(f"- judge agreement: {agree}/{len(both)} ({100 * agree / len(both):.0f}%)")
    # baselines on the same executable tasks (2025 human labels, sites as they were then)
    agents = list(SUBSET[ids[0]]["human_labels"]) if ids else []
    line = []
    for a in agents:
        v = [SUBSET[i]["human_labels"][a] for i in denom]
        line.append(f"{a} {v.count('1')}/{len(v)}")
    print("- baselines on the same tasks (human labels, 2025): " + "; ".join(line))
    tool_use = Counter()
    offsite = []
    for i in ids:
        tools = results[i].get("tools", {})
        tool_use.update(tools)
        if not (set(tools) & BROWSER_TOOLS) and set(tools) & WEB_TOOLS:
            offsite.append(i)
    print(f"- tasks solved/attempted with no browser action (web_search/fetch only): {len(offsite)}")
    print(f"- tool calls: {dict(tool_use.most_common())}")
    states = Counter(results[i]["terminal_state"] for i in ids)
    secs = sorted(results[i]["seconds"] for i in ids)
    print(f"- terminal states: {dict(states)}; median time {secs[len(secs) // 2]}s, max {secs[-1]}s")
    judge_cost = sum(r.get("judge_cost_usd", 0) for r in gpt.values())
    print(f"- GPT judge cost: ${judge_cost:.3f}")
    print("\n| lvl | task | GPT | Fable | state | tools | answer (start) |\n|---|---|---|---|---|---|---|")
    for i in ids:
        r = results[i]
        g = "—" if i not in gpt else ("✅" if gpt[i]["label"] else "❌")
        f = "—" if i not in fable else ("✅" if fable[i]["label"] else "❌")
        if i in blocked:
            g = f = "🚫"
        tools = ",".join(f"{k}×{v}" for k, v in r.get("tools", {}).items() if k != "task_complete")
        ans = (r.get("final_result_response") or "").replace("\n", " ").replace("|", "/")[:90]
        print(f"| {r['level'][0]} | {r['task'][:60]} | {g} | {f} | {r['terminal_state']} | {tools} | {ans} |")


for d in sys.argv[1:]:
    report(Path(d))
