# Case replay (case mode)

Agents re-investigate a past incident whose cause is settled, given only its symptom, and are graded against the settled answer. This is an alternative ground-truth path to a recall answer key (B) built by a human sweeping the same period. It only measures incident types already seen, so it overestimates performance on new types — B was postponed, not abandoned.

The real case files are not in this repo. `example.json` is a synthetic example showing the schema.

## Case kinds (`kind`)

- `root_cause` — the cause is settled. Grading includes cause attribution.
- `classification` — only the verdict (real change vs measurement issue) is settled.
- `open` — the cause is not settled. Only the decomposition and forbidden claims are graded.

## Case file (`cNN-*.json`)

| Field | Seen by | Content |
|---|---|---|
| `id`, `title`, `kind` | judge | |
| `symptom` | runs, judge | the symptom sentence the report showed |
| `window` | runs, judge | `{start, end}` allowed query range (KST) |
| `calendar` | runs, judge | `[{start, end?, summary}]` **only what was knowable at the time**. No cause explanations written after the fact |
| `answer` | judge | `{summary, ...}` the settled answer |
| `answer_axes` | judge | axes where the cause is visible |
| `rubric` | judge | `[{id, check, must}]` binary grading items. All `must` passed + no `should_not` violation = pass |
| `should_not` | judge | `[{id, claim}]` claims that are violations if put forward as the conclusion or leading hypothesis |
| `snapshot_file` | judge | path to the frozen mart values used for grading (`snapshots/…`) |
| `reported` | pack, evidence | `{sources, metrics, baseline:[s,e], period:[s,e]}` the report's metrics and comparison periods |
| `focus` | audit | `{start, end}` the range where the cause is visible |
| `axis_checks` | audit | `[{axis, key, group, in_focus, range_includes, rules:[{tool, re, not, result}]}]` patterns over query inputs and responses |
| `leak_markers` | audit | incident-specific expressions (regex) that count as a leak if they appear in a run's context |
| `variants` | build | `{name: {fields to overlay}}` for measuring the effect of an environment fix separately |

- `snapshots/` — mart values frozen at grading time. When the source is recomputed retroactively, values pulled later change the answer. `as_reported` holds the report's input values at the time.
- `packs/<id>.json`, `evidence/<id>.json` — the `data` of running the aggregation pipelines printed by `pack.py pipeline` / `evidence.py pipeline`, verbatim.

## Contamination controls

1. Runs use the `.claude/agents/discovery-case-agent.md` agent type (recognized only in sessions opened at the install path — to use it from other folders, copy or link it into `~/.claude/agents/`). It has data query and schema tools only (no wiki, internal posts, calendar, release notes or local files).
2. Run from a session opened at the install path when possible. From another folder's session, first check that the project's memory and CLAUDE.md don't contain the incident's answer.
3. After a run, `scripts/audit-runs.py <workflow transcript dir>` scans each run's context and tool responses for `leak_markers`. The judge sees only the final output, so it can't catch a run that read the answer from a document. Narrow markers to incident-specific expressions, not common words (common words hit unrelated documents and give false positives).
4. A run agent's first message carries the orchestrator session's request text and gitStatus (recent commit subjects) verbatim. Keep incident clues out of the message that launches runs and out of this repo's commit messages.
5. If a cause explanation with a date gets into the metric dictionary, every run of that incident is contaminated. Keep time-bound notes in the service calendar.

## Running

```bash
python3 <install path>/scripts/build-case-args.py --k 3 c05 c08 > case-args.json   # works from any folder
```

Then in the session: `Workflow({ scriptPath: "<install path>/scripts/discovery-eval.workflow.js", args: <contents of case-args.json> })`. If the args are too large to pass inline, run it as a child from a wrapper workflow that embeds the args as a constant: `workflow({scriptPath}, ARGS)`.

`audit-runs.py` counts retrieval from the actual data queries in the transcript. Each key axis has a `group`, and every group must be seen for retrieval to be true (axes in the same group are alternative paths to the same evidence). An axis value present in an unfiltered response counts as seen (`result` rule). The judge's `considered_true_cause` is lenient — one axis is enough — so report the audit value, and read the example calls in the output when a number looks off. LEAKED runs are excluded from the pass tally and reported separately.

**Variants**: `build-case-args.py --variant <name>` overlays `variants.<name>` (e.g. adding the app version to deploy entries in the calendar). Compare against the default run with the same cases and k; if the variant moves the wording toward the answer, read it only as an upper bound for "if the environment had been accurate".

**Precomputed pack**: with `--with-pack`, the decomposition table from `pack.py text` joins the run prompt. It is one rule for every case — using only the report's metrics and comparison periods as input, it compares every platform × surface × entry channel × view mode row of the mart by period means and lists the largest changes first. It never reads the answer fields.

**Evidence checks**: with `--with-evidence`, the rule-based checks from `evidence.py text` go ahead of the pack — platform contrast (each change + the cross-platform ratio), baseline check (baseline and period vs the same weekdays in the prior 4 weeks), deploy check (calendar rollout share vs per-platform change and onset), independent source (the same activity in the other log pipeline). Inputs are `reported`, `window` and the at-the-time calendar only.

**Judge calibration**: `calibration-sheet.py make <sheet.md> <key.json> <run_dir>:<label> …` builds a labeling sheet with the judge's verdicts hidden; after a human fills it in, `calibration-sheet.py score <sheet.md> <key.json>` measures agreement with the AI judge. Don't open `key.json` until labeling is done. (The sheet's form text is in Korean; `score` parses those labels.)

Results: per case `pass_rate`, `pass_at_k`, `pass_all_k` (passed all k times — the value to put in a report), `retrieval_rate` (judge-based — replace with the audit value), `ranking_rate` (is the final conclusion right). High retrieval with low ranking means an interpretation problem; both low means an exploration-scope problem.
