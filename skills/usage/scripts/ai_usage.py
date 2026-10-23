#!/usr/bin/env python3
"""Print AI provider usage limits (Codex, Claude, and others) from the CodexBar CLI.

Runs `codexbar usage --format json` and prints one line per provider.
Without --provider, codexbar reads the providers that are enabled in its config.

Exit 0 when at least one provider gives usage, 2 when none does.
"""
import argparse
import datetime as dt
import json
import shutil
import subprocess
import sys

TIMEOUT_S = 90
WINDOW_NAMES = {300: "5h", 10080: "week"}


def parse_time(iso):
    return dt.datetime.fromisoformat(iso.replace("Z", "+00:00")) if iso else None


def fmt_time(t, now):
    t = t.astimezone()
    return t.strftime("%H:%M") if t.date() == now.date() else t.strftime("%d %b %H:%M")


def window(name, w, pace=None):
    return {"name": name, "used_percent": w.get("usedPercent"), "window_minutes": w.get("windowMinutes"),
            "resets_at": w.get("resetsAt"),
            "lasts_to_reset": pace.get("willLastToReset") if pace else None}


def normalise(entry):
    out = {"provider": entry.get("provider"), "source": entry.get("source")}
    if entry.get("error"):
        out["error"] = entry["error"].get("message") or str(entry["error"])
        return out
    usage = entry.get("usage") or {}
    labels = entry.get("rateWindowLabels") or {}
    pace = entry.get("pace") or {}
    windows = []
    for slot in ("primary", "secondary", "tertiary"):
        w = usage.get(slot)
        if w:
            # Session/Weekly are time spans; other labels (Antigravity "Gemini Models") name a model family.
            label = labels.get(slot)
            name = (WINDOW_NAMES.get(w.get("windowMinutes")) if label in (None, "Session", "Weekly") else None) \
                or label or slot
            windows.append(window(name, w, pace.get(slot)))
    seen = {(w["used_percent"], w["resets_at"]) for w in windows}
    for extra in usage.get("extraRateWindows") or []:
        w = extra.get("window")
        if extra.get("usageKnown", True) and w and (w.get("usedPercent"), w.get("resetsAt")) not in seen:
            windows.append(window(extra.get("title") or extra.get("id"), w))
    out["windows"] = windows
    out["updated_at"] = usage.get("updatedAt")
    credits = (entry.get("resetCredits") or {}).get("available")
    if credits:
        out["reset_credits"] = credits
    if entry.get("diagnostic"):
        out["note"] = entry["diagnostic"]
    return out


def line(p, now):
    if "error" in p:
        return f"{p['provider']} error: {p['error']}"
    if not p["windows"]:
        return f"{p['provider']} no usage data (source {p['source']})"
    parts = []
    for w in p["windows"]:
        text = f"{w['name']} {w['used_percent']:.0f}%" if w["used_percent"] is not None else f"{w['name']} ?"
        reset = parse_time(w["resets_at"])
        if reset:
            text += f" (resets {fmt_time(reset, now)})"
        if w["lasts_to_reset"] is False:
            text += " runs out before reset"
        parts.append(text)
    updated = parse_time(p.get("updated_at"))
    parts.append(f"source {p['source']}" + (f" {fmt_time(updated, now)}" if updated else ""))
    if p.get("reset_credits"):
        parts.append(f"{p['reset_credits']} reset credits")
    return f"{p['provider']} " + " · ".join(parts)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", help="one codexbar provider id, for example codex or claude. Default: enabled providers")
    ap.add_argument("--json", action="store_true", help="print normalised JSON")
    args = ap.parse_args()

    exe = shutil.which("codexbar")
    if not exe:
        print("ai usage unavailable: codexbar CLI not on PATH", file=sys.stderr)
        return 2
    cmd = [exe, "usage", "--format", "json", "--no-color"]
    if args.provider:
        cmd += ["--provider", args.provider]
    try:
        run = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        print(f"ai usage unavailable: codexbar gave no answer in {TIMEOUT_S}s", file=sys.stderr)
        return 2
    try:
        entries = json.loads(run.stdout)
    except json.JSONDecodeError:
        err = [l for l in run.stderr.splitlines() if "libcurl" not in l]
        print("ai usage unavailable: codexbar printed no JSON. " + " ".join(err[-3:]), file=sys.stderr)
        return 2

    providers = [normalise(e) for e in entries]
    if args.json:
        print(json.dumps(providers, indent=2))
    else:
        now = dt.datetime.now().astimezone()
        for p in providers:
            print(line(p, now))
    return 0 if any(p.get("windows") for p in providers) else 2


if __name__ == "__main__":
    sys.exit(main())
