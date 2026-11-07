#!/usr/bin/env python3
"""usage: calibration-sheet.py make <sheet.md> <key.json> <run_dir>:<label> ...
       calibration-sheet.py score <sheet.md> <key.json>

make  — a blind labeling sheet: each run's question, settled answer, required checks and the run's
        own output, with the judge's verdict left out. The verdicts go to key.json; keep it unopened.
score — read the filled sheet and report per-item and per-run agreement with the judge.
"""
import json
import pathlib
import random
import re
import sys

CASES = pathlib.Path(__file__).resolve().parent.parent / "cases"
CUT = 380


def clip(s, n=CUT):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[:n] + "…"


def load_dir(run_dir):
    run_dir = pathlib.Path(run_dir)
    labels = {m.stem.replace(".meta", ""): json.loads(m.read_text()).get("description", "")
              for m in run_dir.glob("agent-*.meta.json")}
    results = {}
    for line in (run_dir / "journal.jsonl").open():
        d = json.loads(line)
        if d.get("type") == "result":
            results[labels.get(f"agent-{d['agentId']}", "")] = d["result"]
    return results


def make(sheet, key_path, picks):
    cache, items = {}, []
    for pick in picks:
        run_dir, label = pick.rsplit(":", 1)
        res = cache.setdefault(run_dir, load_dir(run_dir))
        case_id, n = label.split("#")
        grade = next(r for r in res[f"grade:{case_id}"]["per_run"] if r["run"] == int(n))
        items.append({"label": label, "run_dir": run_dir, "case": json.loads((CASES / f"{case_id}.json").read_text()),
                      "out": res[label], "judge": grade})
    random.Random(20261029).shuffle(items)
    key, lines = {}, ["# 판정자 보정 라벨 시트", "",
                      "각 실행을 정답과 필수 항목에 대 보고 체크하세요. `[ ]` 를 `[x]` 로 바꾸면 됩니다. AI 판정자의 결과는 일부러 뺐습니다.",
                      "필수 항목(★)을 전부 충족하고 금지 주장이 없으면 통과입니다. 애매하면 메모에 적어 주세요.", ""]
    for i, it in enumerate(items, 1):
        rid, c, out = f"R{i:02d}", it["case"], it["out"]
        key[rid] = {"label": it["label"], "run_dir": it["run_dir"], "judge": it["judge"]}
        lines += [f"## {rid} — {c['title']}", "", f"**질문 (실행에게 준 증상)**: {c['symptom']}", "",
                  f"**정답**: {c['answer']['summary']}", ""]
        lines.append("**실행의 결론**: " + f"[{out['conclusion']['classification']}, {out['conclusion']['confidence']}] "
                     + clip(out["conclusion"]["summary"], 700))
        lines.append("")
        for h in out.get("hypotheses", [])[:4]:
            lines.append(f"- 가설 ({h['status']}): {clip(h['hypothesis'], 200)}")
            lines.append(f"  - 근거: {clip(h['evidence'])}")
            if h.get("control_used"):
                lines.append(f"  - 대조: {clip(h['control_used'], 200)}")
        lines += ["", "**체크**"]
        for r in c["rubric"]:
            lines.append(f"- {r['id']}{'★' if r['must'] else ''} {r['check']} — [ ] 충족 [ ] 미충족")
        lines.append("- 금지 주장 중 하나라도 결론·주 가설로 내세웠나: "
                     + " / ".join(f"{s['id']} {s['claim']}" for s in c["should_not"]) + " — [ ] 예 [ ] 아니오")
        lines += ["- **종합** — [ ] 통과 [ ] 탈락", "- 메모: ", ""]
    pathlib.Path(sheet).write_text("\n".join(lines))
    pathlib.Path(key_path).write_text(json.dumps(key, ensure_ascii=False, indent=1))
    print(f"{len(items)} runs → {sheet}")


def checked(line, word):
    return re.search(r"\[[xX]\]\s*" + re.escape(word), line) is not None


def score(sheet, key_path):
    key = json.loads(pathlib.Path(key_path).read_text())
    human, rid = {}, None
    for line in pathlib.Path(sheet).read_text().splitlines():
        m = re.match(r"## (R\d+)", line)
        if m:
            rid = m.group(1)
            human[rid] = {"items": {}, "sn": None, "pass": None}
            continue
        m = re.match(r"- (R\d)★? ", line)
        if rid and m:
            human[rid]["items"][m.group(1)] = True if checked(line, "충족") else False if checked(line, "미충족") else None
        elif rid and line.startswith("- 금지 주장"):
            human[rid]["sn"] = True if checked(line, "예") else False if checked(line, "아니오") else None
        elif rid and line.startswith("- **종합**"):
            human[rid]["pass"] = True if checked(line, "통과") else False if checked(line, "탈락") else None
    agree_items = total_items = agree_runs = total_runs = 0
    for rid, k in sorted(key.items()):
        h, j = human.get(rid, {}), k["judge"]
        jpass = {x["id"]: x["pass"] for x in j["rubric"]}
        diffs = []
        for item, hv in h.get("items", {}).items():
            if hv is None or item not in jpass:
                continue
            total_items += 1
            agree_items += hv == jpass[item]
            if hv != jpass[item]:
                diffs.append(f"{item} 사람 {'충족' if hv else '미충족'} / AI {'충족' if jpass[item] else '미충족'}")
        case = json.loads((CASES / f"{k['label'].split('#')[0]}.json").read_text())
        must = [r["id"] for r in case["rubric"] if r["must"]]
        jrun = all(jpass.get(m) for m in must) and not any(x["violated"] for x in j["should_not"])
        if h.get("pass") is not None:
            total_runs += 1
            agree_runs += h["pass"] == jrun
        print(f"{rid} {k['label']}: 사람 {h.get('pass')} / AI {jrun}" + (f" · {'; '.join(diffs)}" if diffs else ""))
    if total_runs:
        print(f"\n실행 통과·탈락 일치 {agree_runs}/{total_runs}, 항목 일치 {agree_items}/{total_items}")


def main():
    if len(sys.argv) >= 5 and sys.argv[1] == "make":
        make(sys.argv[2], sys.argv[3], sys.argv[4:])
    elif len(sys.argv) == 4 and sys.argv[1] == "score":
        score(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
