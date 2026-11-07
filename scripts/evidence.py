#!/usr/bin/env python3
"""usage: evidence.py pipeline <case-id>   print the mongodb_raw_aggregate pipeline (daily_stat_mart)
       evidence.py text <case-id>       render cases/evidence/<case-id>.json (the pipeline's `data`, verbatim) as checks

Deterministic checks for the four misreadings seen in case replays (appendix I): platform compared in
absolutes instead of as a ratio, a deploy rejected or blamed without matching its rollout, a baseline that is
itself unusual, and an "artifact" call with no independent source. Same recipe for every case; inputs are
`reported`, `window` and the at-the-time `calendar` only.
"""
import datetime
import json
import pathlib
import re
import statistics
import sys

CASES = pathlib.Path(__file__).resolve().parent.parent / "cases"
REF_DAYS = 28
ONSET = 0.10        # a day counts as moved when it is ≥10% off its weekday reference, two days running
BASE_UNUSUAL = 0.15  # baseline ≥15% off its weekday reference is flagged
SAME = 5.0          # percentage-point gap below which two changes are called "the same"
# Counterpart measured by a separate pipeline (client log vs server tracking log).
COUNTERPART = {"client-view": ("server-playback", ["validPlayUv"]), "server-playback": ("client-view", ["viewUv"]),
               "client-reaction": ("server-reaction", None), "server-reaction": ("client-reaction", None)}


def day(s):
    return datetime.date.fromisoformat(s)


def shift(s, n):
    return (day(s) + datetime.timedelta(days=n)).isoformat()


def utc_start(kst):
    return {"$date": f"{shift(kst, -1)}T15:00:00Z"}


def owns(ds, m):
    if ds == "client-view":
        return m.startswith("view")
    if ds == "server-playback":
        return "Play" in m or m.startswith("play")
    return ds.endswith("reaction") and re.match(r"(like|comment|share|friendAdd|bookmark)", m) is not None


def series_spec(case):
    rep = case["reported"]
    specs = {(ds, m) for ds in rep["sources"] for m in rep["metrics"] if owns(ds, m)}
    for ds in rep["sources"]:
        cds, cm = COUNTERPART.get(ds, (None, None))
        if cds and cds not in rep["sources"]:
            specs |= {(cds, m) for m in (cm or rep["metrics"])}
    return sorted(specs)


def pipeline(case):
    specs = series_spec(case)
    start = min(case["window"]["start"], shift(case["reported"]["baseline"][0], -REF_DAYS))
    return [
        {"$match": {
            "platform": {"$in": ["ios", "android"]},
            "dataSource": {"$in": sorted({ds for ds, _ in specs})},
            "metric": {"$in": sorted({m for _, m in specs})},
            "date": {"$gte": utc_start(start), "$lte": utc_start(case["window"]["end"])},
            "entryChannel": "all",
            "$or": [{"sourcePage": "all"}, {"sourcePage": None, "viewMode": "all"}],
        }},
        {"$addFields": {"d": {"$dateToString": {"date": {"$toDate": "$date"}, "format": "%Y-%m-%d", "timezone": "Asia/Seoul"}}}},
        {"$group": {"_id": {"p": "$platform", "ds": "$dataSource", "m": "$metric"}, "daily": {"$push": {"d": "$d", "v": "$value"}}}},
        {"$sort": {"_id.ds": 1, "_id.m": 1, "_id.p": 1}},
    ]


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def pct(a, b):
    return None if not a or b is None else (b - a) / a * 100


def fp(x):
    return "—" if x is None else f"{x:+.1f}%"


def span_mean(daily, lo, hi):
    return mean(v for d, v in daily.items() if lo <= d <= hi)


def weekday_ref(daily, base_start):
    lo = shift(base_start, -REF_DAYS)
    by = {}
    for d, v in daily.items():
        if lo <= d < base_start:
            by.setdefault(day(d).weekday(), []).append(v)
    return {w: statistics.median(vs) for w, vs in by.items()}


def devs(daily, ref, lo, hi):
    return [(d, v / ref[day(d).weekday()] - 1) for d, v in sorted(daily.items())
            if lo <= d <= hi and ref.get(day(d).weekday())]


def weekday_mean(daily, lo, hi):
    by = {}
    for d, v in daily.items():
        if lo <= d <= hi:
            by.setdefault(day(d).weekday(), []).append(v)
    return {w: statistics.mean(vs) for w, vs in by.items()}


def onset(daily, b0, b1, p0, p1, direction):
    # Reference = the baseline's own weekdays when it spans a week, else the weeks before it.
    ref = weekday_mean(daily, b0, b1) if (day(b1) - day(b0)).days >= 6 else weekday_ref(daily, b0)
    ds = devs(daily, ref, p0, p1)
    for (d1, x1), (_, x2) in zip(ds, ds[1:]):
        if min(x1 * direction, x2 * direction) >= ONSET:
            return d1, x1
    return None, None


def rollout(calendar, period_end):
    # "Android 3.2 rollout expanded (40%)", "iOS 3.1.0 배포 시작 (3.1 배포율 2%)" → per platform: dates with share.
    out = {"ios": [], "android": []}
    for e in calendar:
        if e["start"] > period_end:
            continue
        for part in e["summary"].split(" / "):
            m = re.match(r"(iOS|Android|And)\b.*?(\d+\.\d+)[.\d]*\s.*(?:배포|rollout|deploy).*?([\d.]+)%", part)
            if m:
                out["ios" if m.group(1) == "iOS" else "android"].append((e["start"], float(m.group(3)), m.group(2)))
    return out


def text(case, rows):
    rep, cal = case["reported"], case.get("calendar", [])
    (b0, b1), (p0, p1) = rep["baseline"], rep["period"]
    data = {(r["_id"]["p"], r["_id"]["ds"], r["_id"]["m"]): {x["d"]: x["v"] for x in r["daily"]} for r in rows}
    reported = [(ds, m) for ds, m in series_spec(case) if ds in rep["sources"] and m in rep["metrics"]]
    counter = [(ds, m) for ds, m in series_spec(case) if (ds, m) not in reported]
    change = {k: pct(span_mean(v, b0, b1), span_mean(v, p0, p1)) for k, v in data.items()}

    out = [f"EVIDENCE CHECKS — computed by fixed rules for every report (platform totals; period {p0}..{p1} vs baseline {b0}..{b1}). "
           "These are measurements, not conclusions; weigh them against what you find."]

    out.append("1) Platform contrast (each platform's change, and the iOS/Android ratio change — a ratio removes what both share):")
    for ds, m in reported + counter:
        ci, ca = change.get(("ios", ds, m)), change.get(("android", ds, m))
        ratio = None if ci is None or ca is None else ((1 + ci / 100) / (1 + ca / 100) - 1) * 100
        tag = "" if ci is None or ca is None else (" → both alike" if abs(ci - ca) < SAME else " → mostly " + ("iOS" if abs(ci) > abs(ca) else "Android"))
        out.append(f"   {ds} {m}: iOS {fp(ci)}, Android {fp(ca)}, iOS/Android ratio {fp(ratio)}{tag}")

    out.append(f"2) Baseline check (baseline and period vs the same weekdays in the {REF_DAYS} days before the baseline; "
               f"a baseline ≥{BASE_UNUSUAL:.0%} off is unusual — if the period is off the same way, the level moved before the baseline):")
    for ds, m in reported:
        parts = []
        for p in ("ios", "android"):
            daily = data.get((p, ds, m), {})
            ref = weekday_ref(daily, b0)
            off = mean([x for _, x in devs(daily, ref, b0, b1)])
            poff = mean([x for _, x in devs(daily, ref, p0, p1)])
            parts.append(f"{p} baseline {fp(None if off is None else off * 100)}"
                         + (" UNUSUAL" if off is not None and abs(off) >= BASE_UNUSUAL else "")
                         + f" / period {fp(None if poff is None else poff * 100)}")
        out.append(f"   {ds} {m}: " + ", ".join(parts))

    ro = rollout(cal, p1)
    out.append(f"3) Deploy check (calendar rollout share vs where and when the metric moved; onset = first period day of two running ≥{ONSET:.0%} off the baseline weekdays, in the direction of the change):")
    if not ro["ios"] and not ro["android"]:
        out.append("   no rollout share in the calendar for this window — judge deploys by the platform contrast in 1) only")
    else:
        ds, m = next(x for x in reported if x[1] == rep["metrics"][0])
        for p in ("ios", "android"):
            r = ro[p]
            first10 = next((d for d, s, _ in r if s >= 10), None)
            latest = r[-1] if r else None
            daily = data.get((p, ds, m), {})
            direction = -1 if (change.get((p, ds, m)) or 0) < 0 else 1
            od, ox = onset(daily, b0, b1, p0, p1, direction)
            out.append(f"   {p}: rollout share by {p1} {latest[1]:.0f}% (v{latest[2]}), ≥10% from {first10 or '—'}; "
                       f"{m} {fp(change.get((p, ds, m)))}, onset {od or 'none'}" + (f" ({fp(ox * 100)})" if od else "") if latest else
                       f"   {p}: no rollout share in the calendar; {m} {fp(change.get((p, ds, m)))}, onset {od or 'none'}")
        si, sa = (ro["ios"][-1][1] if ro["ios"] else 0), (ro["android"][-1][1] if ro["android"] else 0)
        ci, ca = change.get(("ios", ds, m)), change.get(("android", ds, m))
        if si and sa and ci is not None and ca is not None:
            hi, lo = max(si, sa), min(si, sa)
            if hi >= 2 * lo and abs(ci - ca) < SAME:
                out.append(f"   → exposure differs {hi / lo:.1f}× between platforms but the change is alike: rollout and movement do not track")
            elif hi >= 2 * lo:
                more = "iOS" if si > sa else "Android"
                out.append(f"   → the more-exposed platform ({more}) moved " + ("more" if abs(ci if more == 'iOS' else ca) > abs(ca if more == 'iOS' else ci) else "less"))
            else:
                out.append("   → exposure is similar on both platforms: compare onset dates with each platform's ≥10% rollout date instead")

    out.append("4) Independent source (same activity measured by the other pipeline — if it moves too, the change is not only a logging artifact):")
    for ds, m in counter:
        out.append(f"   {ds} {m}: iOS {fp(change.get(('ios', ds, m)))}, Android {fp(change.get(('android', ds, m)))}")
    if not counter:
        out.append("   (the reported metrics already span both pipelines — compare them in 1)")
    return "\n".join(out)


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("pipeline", "text"):
        raise SystemExit(__doc__)
    case = json.loads(next(CASES.glob(f"{sys.argv[2]}*.json")).read_text())
    if sys.argv[1] == "pipeline":
        print(json.dumps(pipeline(case)))
    else:
        print(text(case, json.loads((CASES / "evidence" / f"{case['id']}.json").read_text())))


if __name__ == "__main__":
    main()
