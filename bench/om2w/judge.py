"""Grade a Browd Online-Mind2Web run with the official WebJudge (vendored, MIT).

Usage: uv run --with openai --with pillow python judge.py <run_dir> [--model openai/gpt-6-sol] [--stop-usd 4.7]
       ... judge.py <run_dir> --codex gpt-6-astra [--only id1,id2]   # same protocol through the local
       Codex CLI on a ChatGPT login: no API spend, writes judged_codex_<model>.jsonl
       [--effort low|medium|high]  Codex reasoning effort (default medium)
       [--dedup]                   judge each byte-identical screenshot once (first occurrence kept)
       [--tag name]                suffix for the output file, so a repeat judging does not resume the first
Writes <run_dir>/judged.jsonl (one line per task) and prints a summary.
The only change to the method: the engine talks to OpenRouter, drops `temperature`
(reasoning judges reject it) and lifts the 512-token cap, which a reasoning model
can spend entirely on hidden reasoning and return an empty verdict.
"""
import asyncio
import hashlib
import json
import os
import re
import sys
import threading
import time
from pathlib import Path

from openai import OpenAI

sys.path.insert(0, str(Path(__file__).parent / "vendor"))
from webjudge_online_mind2web import WebJudge_Online_Mind2Web_eval  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SCORE_THRESHOLD = 3  # the paper's default


def load_key():
    for line in (ROOT / ".env.bench.local").read_text().splitlines():
        if line.startswith("OPENROUTER_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("OPENROUTER_API_KEY missing")


def key_usage():
    import urllib.request

    req = urllib.request.Request("https://openrouter.ai/api/v1/key", headers={"Authorization": f"Bearer {load_key()}"})
    return json.load(urllib.request.urlopen(req))["data"]["usage"]


class Engine:
    def __init__(self, model):
        self.model = model
        self.client = OpenAI(api_key=load_key(), base_url="https://openrouter.ai/api/v1")
        self.cost = 0.0
        # WebJudge fires every screenshot at once; OpenRouter reserves the worst-case cost of each
        # in-flight request against the key and answers 402 when the sum exceeds the balance.
        self.gate = threading.Semaphore(3)

    def generate(self, messages, max_new_tokens=512, temperature=0, model=None, **kwargs):
        for attempt in range(3):
            try:
                with self.gate:
                    r = self.client.chat.completions.create(
                        model=self.model,
                        messages=messages,
                        max_completion_tokens=3000,
                        extra_body={"usage": {"include": True}},
                    )
                self.cost += (r.usage.model_extra or {}).get("cost") or 0
                content = r.choices[0].message.content or ""
                if content.strip():
                    return [content]
            except Exception as e:  # noqa: BLE001
                print(f"  judge call failed ({type(e).__name__}): {str(e)[:160]}")
                time.sleep(3 * (attempt + 1))
        return [""]


class CodexEngine:
    """Same WebJudge messages, sent through `codex exec` (ChatGPT subscription) instead of OpenRouter.

    System text and user text become one prompt; data-URI images become temp files passed with -i
    in their original order. Read-only sandbox, ephemeral session, empty working directory.
    """

    def __init__(self, model, effort="medium"):
        import tempfile

        self.model = model
        self.effort = effort
        self.cost = 0.0
        self.workdir = Path(tempfile.mkdtemp(prefix="codex-judge-"))
        self.gate = threading.Semaphore(3)

    def generate(self, messages, **kwargs):
        import base64
        import subprocess
        import tempfile

        parts, images = [], []
        with tempfile.TemporaryDirectory(dir=self.workdir) as tmp:
            for m in messages:
                content = m["content"]
                items = content if isinstance(content, list) else [{"type": "text", "text": content}]
                label = "SYSTEM INSTRUCTIONS" if m["role"] == "system" else "USER"
                texts = []
                for it in items:
                    if it.get("type") == "text":
                        texts.append(it["text"])
                    elif it.get("type") == "image_url":
                        data = it["image_url"]["url"].split(",", 1)[1]
                        f = Path(tmp) / f"img{len(images) + 1}.jpg"
                        f.write_bytes(base64.b64decode(data))
                        images.append(str(f))
                        texts.append(f"[Image {len(images)} attached]")
                parts.append(f"{label}:\n" + "\n".join(texts))
            prompt = (
                "You are a grader. Do not run any commands or tools; answer directly in text.\n\n"
                + "\n\n".join(parts)
            )
            out = Path(tmp) / "answer.txt"
            cmd = ["codex", "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", tmp,
                   "-m", self.model, "-c", f'model_reasoning_effort="{self.effort}"', "-o", str(out)]
            for f in images:
                cmd += ["-i", f]
            # `-i` takes several files; without `--` the prompt is read as one more image.
            cmd += ["--", prompt]
            for attempt in range(3):
                with self.gate:
                    # stdin closed: `codex exec` otherwise also waits on an inherited stdin.
                    p = subprocess.run(cmd, capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL)
                if out.exists() and out.read_text().strip():
                    return [out.read_text()]
                print(f"  codex call failed (exit {p.returncode}): {p.stderr.strip().splitlines()[-1:] }")
                time.sleep(3 * (attempt + 1))
        return [""]


def main():
    run = Path(sys.argv[1])
    codex = sys.argv[sys.argv.index("--codex") + 1] if "--codex" in sys.argv else None
    model = codex or (sys.argv[sys.argv.index("--model") + 1] if "--model" in sys.argv else "openai/gpt-6-sol")
    effort = sys.argv[sys.argv.index("--effort") + 1] if "--effort" in sys.argv else "medium"
    dedup = "--dedup" in sys.argv
    tag = sys.argv[sys.argv.index("--tag") + 1] if "--tag" in sys.argv else ""
    engine = CodexEngine(model, effort) if codex else Engine(model)
    only = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv else None
    stop_usd = float(sys.argv[sys.argv.index("--stop-usd") + 1]) if "--stop-usd" in sys.argv else 4.7
    suffix = ("_dedup" if dedup else "") + (f"_{effort}" if codex and effort != "medium" else "") + (f"_{tag}" if tag else "")
    out = run / (f"judged_codex_{codex}{suffix}.jsonl" if codex else f"judged{suffix}.jsonl")
    ne = run / "not_executable.json"
    blocked = set(json.loads(ne.read_text())) if ne.exists() else set()
    done = {json.loads(l)["task_id"] for l in out.read_text().splitlines()} if out.exists() else set()
    for d in sorted(p for p in run.iterdir() if (p / "result.json").exists()):
        r = json.loads((d / "result.json").read_text())
        if r["task_id"] in done or r["task_id"] in blocked:
            continue
        if only and not any(r["task_id"].startswith(o) for o in only):
            continue
        used = 0.0 if codex else key_usage()
        if used >= stop_usd:
            print(f"budget stop: key usage ${used:.3f} >= ${stop_usd}")
            break
        shots = sorted((d / "trajectory").glob("*.png"), key=lambda p: int(re.findall(r"\d+", p.name)[0]))
        total_shots = len(shots)
        if dedup:
            # A looping agent leaves runs of identical screenshots. Each would get the same score,
            # and above-threshold copies take MAX_IMAGE slots in the final call from later frames.
            seen, unique = set(), []
            for p in shots:
                h = hashlib.md5(p.read_bytes()).hexdigest()
                if h not in seen:
                    seen.add(h)
                    unique.append(p)
            shots = unique
        actions = list(r["action_history"])
        if r.get("final_result_response"):
            actions.append(f"final answer: {r['final_result_response']}")
        before = engine.cost
        messages, text, system_msg, record, key_points = asyncio.run(
            WebJudge_Online_Mind2Web_eval(r["task"], actions, [str(p) for p in shots], engine, SCORE_THRESHOLD)
        )
        verdict = engine.generate(messages)[0]
        if not verdict or not verdict.strip():
            # A failed judge call (e.g. key limit, 403) returns no text. Writing it
            # as label 0 would count a provider error as an agent failure and
            # make a rerun skip the task. Stop instead; a rerun resumes here.
            print(f"judge returned no verdict for {r['task_id']}; stopping without recording it")
            break
        try:
            label = 1 if "success" in verdict.lower().split("status:")[1] else 0
        except IndexError:
            label = 0
        row = {
            "task_id": r["task_id"],
            "level": r["level"],
            "mode": r.get("mode"),
            "label": label,
            "terminal_state": r["terminal_state"],
            "verdict": verdict,
            "key_points": key_points,
            "judge_cost_usd": round(engine.cost - before, 5),
            "judge_model": model,
            "judge_effort": effort if codex else None,
            "screenshots": total_shots,
            "screenshots_judged": len(shots),
        }
        with out.open("a") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"{r['level']:6} {'PASS' if label else 'fail'} ${row['judge_cost_usd']:.4f} shots={len(shots)}/{total_shots} | {r['task'][:70]}")
    rows = [json.loads(l) for l in out.read_text().splitlines()]
    print(f"judged={len(rows)} pass={sum(x['label'] for x in rows)} judge_cost_total=${sum(x['judge_cost_usd'] for x in rows):.4f}")


if __name__ == "__main__":
    main()
