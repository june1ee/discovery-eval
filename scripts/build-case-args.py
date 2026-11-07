#!/usr/bin/env python3
"""usage: build-case-args.py [--k N] [--variant NAME] [--with-pack] [case-id-prefix ...]   (no prefix = every case)

--variant overlays cases/<id>.json `variants.NAME` onto the case; cases without it are skipped.
--with-pack adds the precomputed decomposition (scripts/pack.py text) to each run's prompt.
--with-evidence adds the rule-based checks (scripts/evidence.py text) ahead of it.
"""
import argparse
import importlib.util
import json
import pathlib

CASES = pathlib.Path(__file__).resolve().parent.parent / "cases"
def _module(name):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pack, evidence = _module("pack"), _module("evidence")


def load(path, variant=None, with_pack=False, with_evidence=False):
    case = json.loads(path.read_text())
    if variant:
        case.update(case["variants"][variant])
    case.pop("variants", None)
    blocks = []
    if with_evidence:
        blocks.append(evidence.text(case, json.loads((CASES / "evidence" / f"{case['id']}.json").read_text())))
    if with_pack:
        blocks.append(pack.text(case, json.loads((CASES / "packs" / f"{case['id']}.json").read_text())))
    if blocks:
        case["pack"] = "\n\n".join(blocks)
    case["snapshot"] = json.loads((CASES / case["snapshot_file"]).read_text())
    return case


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--k", type=int, default=3)
    p.add_argument("--variant")
    p.add_argument("--with-pack", action="store_true")
    p.add_argument("--with-evidence", action="store_true")
    p.add_argument("ids", nargs="*")
    a = p.parse_args()
    paths = sorted(CASES.glob("c*.json"))
    if a.ids:
        paths = [x for x in paths if any(x.stem.startswith(i) for i in a.ids)]
    if a.variant:
        paths = [x for x in paths if a.variant in json.loads(x.read_text()).get("variants", {})]
    if not paths:
        raise SystemExit(f"no case matches {a.ids}")
    print(json.dumps({"mode": "case", "k": a.k, "variant": a.variant, "with_pack": a.with_pack or a.with_evidence,
                      "with_evidence": a.with_evidence,
                      "cases": [load(x, a.variant, a.with_pack, a.with_evidence) for x in paths]},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
