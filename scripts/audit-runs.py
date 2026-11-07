#!/usr/bin/env python3
"""usage: audit-runs.py <workflow transcript dir> [--json]

Audits case-mode runs from their transcripts, which the grader never sees:
- leaks: hindsight about the case in the run's context or tool results
  (cases/<id>.json `leak_markers` plus GLOBAL_MARKERS)
- axes: which `axis_checks` the run actually queried (tool input, or `result` for unfiltered calls). retrieval = every `key` group was queried (axes sharing a `group` are alternatives),
  inside the focus window when the check says `in_focus`. Pattern matching on tool inputs,
  so it is an approximation — read the hits when a number looks off. With a pack in the prompt,
  `retrieval_with_pack` also counts axes the pack already shows.
"""
import itertools
import json
import pathlib
import re
import sys

CASES = pathlib.Path(__file__).resolve().parent.parent / "cases"
# Wording of the report's own AI write-ups — a run quoting these has read past interpretations.
GLOBAL_MARKERS = [r"원인 후보", r"원인 확인 필요"]  # Korean phrasing of the test reports' write-ups; replace for your reports
SNIPPET = 70
# Tools whose dates bound a contiguous range; others (e.g. Trino day IN (...)) list discrete days.
RANGE_TOOLS = re.compile(r"daily_stat_mart|druid|query_metrics")
# Only data queries count as looking along an axis — not dictionary reads or the run's own answer.
QUERY_TOOLS = re.compile(r"daily_stat_mart|druid|trino|query_metrics|query_top|log_query|mongodb")


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(x.get("text", "") if isinstance(x, dict) else str(x) for x in content)
    return json.dumps(content, ensure_ascii=False) if content is not None else ""


def load_run(path):
    calls, context, results, names = [], [], [], {}
    for line in path.open():
        d = json.loads(line)
        msg = d.get("message") if isinstance(d.get("message"), dict) else {}
        content = msg.get("content")
        if d.get("type") == "attachment":
            att = d.get("attachment", {})
            kind = att.get("type", "?") if isinstance(att, dict) else "?"
            # structured_output is the run's own answer, not something it was handed.
            if kind != "structured_output":
                context.append((f"context:{kind}", json.dumps(att, ensure_ascii=False)))
        elif d.get("type") == "user" and isinstance(content, str):
            context.append(("prompt", content))
        elif isinstance(content, list):
            for x in content:
                if x.get("type") == "tool_use":
                    tool, arg = x["name"].split("__")[-1], json.dumps(x.get("input", {}), ensure_ascii=False)
                    names[x["id"]] = (tool, arg)
                    calls.append((tool, arg))
                elif x.get("type") == "tool_result":
                    results.append((x.get("tool_use_id"), text_of(x.get("content"))))
    return calls, context, [(names.get(t, ("?", "")), body) for t, body in results]


def is_task(kind, text):
    return kind == "prompt" and "computed task" in text[:80]


def scan_leaks(context, results, markers):
    # The computed task (symptom, window, at-the-time calendar) is given on purpose; markers it contains can't be tested.
    task = "\n".join(t for k, t in context if is_task(k, t))
    live = [m for m in markers if not re.search(m, task)]
    sources = [(k, t) for k, t in context if not is_task(k, t)]
    sources += [(f"tool:{tool} {arg[:60]}", body) for (tool, arg), body in results]
    hits = []
    for where, body in sources:
        for m in live:
            hit = re.search(m, body)
            if hit:
                s = body[max(0, hit.start() - SNIPPET): hit.end() + SNIPPET].replace("\n", " ")
                hits.append({"where": where, "marker": m, "snippet": s})
    return hits, [m for m in markers if m not in live]


def call_dates(arg):
    dates = set(re.findall(r"20\d\d-\d\d-\d\d", arg))
    year = re.search(r"year\s*=\s*'(\d{4})'", arg)
    month = re.search(r"month\s*(?:=\s*'(\d{2})'|IN\s*\(([^)]*)\))", arg, re.I)
    day = re.search(r"\bday\s*(?:=\s*'(\d{2})'|IN\s*\(([^)]*)\))", arg, re.I)
    if month and day:
        months = [month.group(1)] if month.group(1) else re.findall(r"'(\d{2})'", month.group(2))
        days = [day.group(1)] if day.group(1) else re.findall(r"'(\d{2})'", day.group(2))
        y = year.group(1) if year else "2026"
        dates |= {f"{y}-{m}-{d}" for m, d in itertools.product(months, days)}
    return sorted(dates)


def covers(tool, dates, start, end):
    if not dates:
        return False
    if RANGE_TOOLS.search(tool) and len(dates) >= 2:
        return dates[0] <= end and dates[-1] >= start
    return any(start <= d <= end for d in dates)


def rule_ok(rule, tool, arg, body):
    if "tool" in rule and not re.search(rule["tool"], tool):
        return False
    # "result": the axis shows up in what came back, for calls that fetched every row unfiltered.
    if "result" in rule and not re.search(rule["result"], body):
        return False
    res = rule.get("re", [])
    if any(not re.search(r, arg, re.I) for r in ([res] if isinstance(res, str) else res)):
        return False
    return not ("not" in rule and re.search(rule["not"], arg, re.I))


def check_axes(results, case, pack=""):
    focus = case.get("focus", {})
    seen = {}
    for chk in case.get("axis_checks", []):
        hits = []
        for (tool, arg), body in results:
            if not QUERY_TOOLS.search(tool) or not any(rule_ok(r, tool, arg, body) for r in chk["rules"]):
                continue
            dates = call_dates(arg)
            if chk.get("in_focus") and not covers(tool, dates, focus["start"], focus["end"]):
                continue
            if "range_includes" in chk and not covers(tool, dates, chk["range_includes"], chk["range_includes"]):
                continue
            hits.append(f"{tool} {arg[:90]}")
        # With a precomputed pack the axis may already be in the prompt; tool and date limits don't apply there.
        in_pack = bool(pack) and any(
            all(re.search(r, pack, re.I) for r in ([x] if isinstance(x, str) else x))
            for rule in chk["rules"] for x in [rule.get("re") or rule.get("result")] if x)
        seen[chk["axis"]] = {"key": chk.get("key", False), "group": chk.get("group", chk["axis"]),
                             "calls": len(hits), "in_pack": in_pack, "first": hits[0] if hits else None}
    return seen


def retrieved(axes, use_pack=False):
    # Every key group must be seen; key axes sharing a group are alternatives for the same evidence.
    groups = {}
    for a in axes.values():
        if a["key"]:
            groups[a["group"]] = groups.get(a["group"], False) or a["calls"] > 0 or (use_pack and a["in_pack"])
    return all(groups.values()) if groups else None


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    report = []
    for meta_path in sorted(pathlib.Path(sys.argv[1]).glob("agent-*.meta.json")):
        meta = json.loads(meta_path.read_text())
        # Run as a child via workflow(), the phase reads "▸ <name>" instead of "Replay".
        if meta.get("workflowPhase") != "Replay" and meta.get("agentType") != "discovery-case-agent":
            continue
        label = meta.get("description", "")
        case_path = CASES / f"{label.split('#')[0]}.json"
        case = json.loads(case_path.read_text()) if case_path.exists() else {}
        calls, context, results = load_run(meta_path.with_name(meta_path.name.replace(".meta.json", ".jsonl")))
        hits, untestable = scan_leaks(context, results, case.get("leak_markers", []) + GLOBAL_MARKERS)
        pack = next((t for k, t in context if is_task(k, t) and "PRECOMPUTED DECOMPOSITION" in t), "")
        axes = check_axes(results, case, pack)
        report.append({
            "run": label, "leaked": bool(hits), "leaks": hits, "markers_in_task": untestable,
            "retrieval": retrieved(axes) if axes else None,
            "retrieval_with_pack": retrieved(axes, use_pack=True) if pack and axes else None,
            "axes": axes, "query_calls": sum(1 for t, _ in calls if QUERY_TOOLS.search(t)),
        })
    if "--json" in sys.argv:
        print(json.dumps(report, ensure_ascii=False, indent=1))
        return
    for r in report:
        ret = "n/a (no axis_checks)" if r["retrieval"] is None else r["retrieval"]
        wp = "" if r["retrieval_with_pack"] is None else f" · with pack={r['retrieval_with_pack']}"
        print(f"{r['run']}: {'LEAKED' if r['leaked'] else 'clean'} · retrieval={ret}{wp} · query calls {r['query_calls']}")
        for h in r["leaks"]:
            print(f"  leak [{h['marker']}] {h['where']}\n    …{h['snippet']}…")
        for name, a in r["axes"].items():
            print(f"  {'*' if a['key'] else ' '} {name}: {a['calls']}" + (" (in pack)" if a["in_pack"] else "")
                  + (f"  e.g. {a['first']}" if a["first"] else ""))
        if r["markers_in_task"]:
            print(f"  untestable (marker is in the task text): {r['markers_in_task']}")


if __name__ == "__main__":
    main()
