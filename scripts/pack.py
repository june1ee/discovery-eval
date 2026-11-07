#!/usr/bin/env python3
"""usage: pack.py pipeline <case-id>   print the mongodb_raw_aggregate pipeline (collection daily_stat_mart)
       pack.py text <case-id>       render cases/packs/<case-id>.json (the pipeline's `data`, saved verbatim) as prompt text

The precomputed decomposition is one recipe for every case: the report's own metrics, every
platform × sourcePage × entryChannel × viewMode row in the mart, period vs baseline daily means.
It reads only `reported` and `window` — never the answer — so it is what a report could show daily.
"""
import datetime
import json
import pathlib
import sys

CASES = pathlib.Path(__file__).resolve().parent.parent / "cases"
TOP = 14
DAILY_TOP = 6


def utc_start(kst_date):
    # Mart dates are KST midnight stored as 15:00Z of the previous day.
    d = datetime.date.fromisoformat(kst_date) - datetime.timedelta(days=1)
    return {"$date": f"{d.isoformat()}T15:00:00Z"}


def in_range(lo, hi):
    return {"$and": [{"$gte": ["$d", lo]}, {"$lte": ["$d", hi]}]}


def pipeline(case):
    rep, win = case["reported"], case["window"]
    return [
        {"$match": {
            "platform": {"$in": ["ios", "android"]},
            "dataSource": {"$in": rep["sources"]},
            "metric": {"$in": rep["metrics"]},
            "date": {"$gte": utc_start(win["start"]), "$lte": utc_start(win["end"])},
        }},
        {"$addFields": {"d": {"$dateToString": {"date": {"$toDate": "$date"}, "format": "%Y-%m-%d", "timezone": "Asia/Seoul"}}}},
        {"$group": {
            "_id": {"p": "$platform", "ds": "$dataSource", "sp": "$sourcePage", "ec": "$entryChannel", "vm": "$viewMode", "m": "$metric"},
            "b": {"$avg": {"$cond": [in_range(*rep["baseline"]), "$value", None]}},
            "r": {"$avg": {"$cond": [in_range(*rep["period"]), "$value", None]}},
            "daily": {"$push": {"d": "$d", "v": "$value"}},
        }},
        {"$addFields": {"absd": {"$abs": {"$ifNull": [{"$subtract": ["$r", "$b"]}, 0]}}}},
        {"$sort": {"absd": -1}},
        {"$limit": TOP},
        {"$project": {"_id": 1, "b": {"$round": ["$b", 1]}, "r": {"$round": ["$r", 1]}, "daily": 1}},
    ]


def fmt(v):
    if v is None:
        return "—"
    if abs(v) >= 1e6:
        return f"{v / 1e6:.2f}M"
    if abs(v) >= 1e4:
        return f"{v / 1e3:.1f}K"
    return f"{v:,.4g}" if abs(v) < 10 else f"{v:,.0f}"


def axes(i):
    return "/".join("-" if i.get(k) in (None, "") else i[k] for k in ("sp", "ec", "vm"))


def text(case, rows):
    rep = case["reported"]
    seen, uniq = set(), []
    for row in rows:
        i = row["_id"]
        daily = tuple(sorted((x["d"], x["v"]) for x in row["daily"]))
        sig = (i["p"], i["ds"], i["m"], daily)
        if sig in seen:  # client-log rows repeat under viewMode all/tab when one mode carries everything
            continue
        seen.add(sig)
        uniq.append((row, dict(daily)))
    lines = [
        f"PRECOMPUTED DECOMPOSITION — the same recipe for every report: the reported metrics ({', '.join(rep['metrics'])}) "
        f"from {', '.join(rep['sources'])}, every platform × sourcePage/entryChannel/viewMode row of the daily mart, "
        f"period {rep['period'][0]}..{rep['period'][1]} vs baseline {rep['baseline'][0]}..{rep['baseline'][1]} (daily means), "
        f"largest absolute changes first. It is a starting map, not a conclusion — verify it and go deeper where it points.",
        "platform | source | sourcePage/entryChannel/viewMode | metric | baseline | period | change",
    ]
    for row, _ in uniq:
        i, b, r = row["_id"], row["b"], row["r"]
        pct = f"{(r - b) / b * 100:+.1f}%" if b and r is not None else "—"
        lines.append(f"{i['p']} | {i['ds']} | {axes(i)} | {i['m']} | {fmt(b)} | {fmt(r)} | {pct}")
    lines.append(f"Daily values, top {DAILY_TOP}:")
    for row, daily in uniq[:DAILY_TOP]:
        i = row["_id"]
        vals = ", ".join(f"{d[5:]} {fmt(v)}" for d, v in sorted(daily.items()))
        lines.append(f"{i['p']} {i['ds']} {axes(i)} {i['m']}: {vals}")
    return "\n".join(lines)


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("pipeline", "text"):
        raise SystemExit(__doc__)
    path = next(CASES.glob(f"{sys.argv[2]}*.json"))
    case = json.loads(path.read_text())
    if sys.argv[1] == "pipeline":
        print(json.dumps(pipeline(case)))
    else:
        print(text(case, json.loads((CASES / "packs" / f"{case['id']}.json").read_text())))


if __name__ == "__main__":
    main()
