# discovery-eval

An **open-ended exploration eval harness** for Claude Code.

> **Question:** given everything an analyst walks in with (KPI mart + data dictionary + event calendar), does Claude **reproducibly** pinpoint changes we *don't yet know about* — quiet changes that no mart aggregates and no calendar event explains?

It runs K independent discovery agents in parallel over a frozen window; a synthesis pass clusters their findings (robust/weak/singleton/fragile), tallies failure modes, and scores recall. A **case mode** also replays past incidents whose cause is settled: agents get only the symptom and must work out what happened.

> Experiment data (real log values, case files, the full experiment log) is not in this repo. It holds the harness code, the method, generalized conclusions (`FINDINGS.md`) and a synthetic example case.

## Layout

| File | Content |
|---|---|
| `scripts/discovery-eval.workflow.js` | The harness (Claude Code Workflow script) — scan mode + case mode |
| `scripts/build-case-args.py` | Case files → case-mode args JSON (`--with-pack`, `--with-evidence`, `--variant`) |
| `scripts/pack.py` | Precomputed decomposition (pack): daily mart rows compared as period means |
| `scripts/evidence.py` | Rule-based evidence checks: platform ratio contrast, baseline check, deploy check, independent source |
| `scripts/audit-runs.py` | Run transcript audit: answer-leak scan + which axes were actually queried (retrieval) |
| `scripts/calibration-sheet.py` | Judge calibration: build a blind labeling sheet → agreement between human labels and the AI judge |
| `.claude/agents/discovery-case-agent.md` | Case-replay agent (data query and schema tools only) |
| `skill.md` | Skill definition + parameter table + preregistered predictions |
| `cases/README.md`, `cases/example.json` | How case replay works and the case-file schema (synthetic example) |
| `FINDINGS.md` | What the experiments showed (generalized, no service-specific numbers) |

MCP tool names (`build_druid_query`, `trino_query`, `daily_stat_mart`, …) and data source names (`client-view`, `server-playback`, …) are generic stand-ins for those of the test environment. To point the harness at another log system, adapt the `server` arg, the agent's tool list, and the source mapping in `pack.py` / `evidence.py`.

## Install

Clone the repo into any folder. The scripts locate `cases/` relative to their own path, so they don't depend on the working directory.

```bash
git clone https://github.com/june1ee/discovery-eval.git <install path>
export DISCOVERY_EVAL=<install path>   # used by the examples below (optional)
```

To use it as a skill, link it into the Claude Code skills folder (optional):

```bash
ln -s "$DISCOVERY_EVAL" ~/.claude/skills/discovery-eval
```

## Running

Invoke it with Claude Code's **Workflow tool** (multi-agent orchestration must be opted into). From a session opened in any folder, pass the **absolute path of the install location** as `scriptPath`:

```
Workflow({ scriptPath: "<install path>/scripts/discovery-eval.workflow.js",
           args: { k: 5, windowStart: "2026-05-27", windowEnd: "2026-06-09", n: 4 } })
```

Case-replay args can be built from anywhere too:

```bash
python3 "$DISCOVERY_EVAL/scripts/build-case-args.py" --k 3 c05 c08 > case-args.json
```

One caveat: the case-replay agent (`discovery-case-agent`) is a project agent, so it is only recognized **in sessions opened at the install path**. To use it from other folders, copy or link it into `~/.claude/agents/`:

```bash
ln -s "$DISCOVERY_EVAL/.claude/agents/discovery-case-agent.md" ~/.claude/agents/
```

When replaying cases from another folder's session, first check that the project's memory and CLAUDE.md don't contain the incident's answer (a leak path — see contamination controls in `cases/README.md`).

Full parameters, arm design and failure modes: `skill.md`. Case replay: `cases/README.md`.

## How the harness works (`scripts/discovery-eval.workflow.js`)

A Claude Code **Workflow script** (`meta` + body). It launches agents concurrently with `parallel()` and forces structured output with `agent(prompt, {schema})`. Two-stage pipeline:

```
             ┌─ discover#1 ─┐
args ───────►├─ discover#2 ─┤──► [normalize] ──► synthesize ──► report
(K parallel) ├─    …        │    (unify          (single opus    (clusters /
             └─ discover#K ─┘     findings)       judge)          failure_modes /
                                                                  recall)
```

**Stage 1 — Discover (`discoveryModel`, default sonnet).** K agents run in parallel and independently with an **identical prompt** (they can't see each other — the core of measuring reproducibility). The prompt is **assembled from conditional blocks** according to the arm. Under schema enforcement, each agent fills N findings + pitfalls + data_caveats + query_count.

#### Prompt assembly blocks (conditional)

| Block | When enabled | What it injects |
|---|---|---|
| **`landscapeRule` / `toolRule`** | Always (branches on `mart_tools`) | Tool access rules. `banned` = raw queries only (no KPI mart, the raw-only premise) / `allowed` = mart allowed too (the full-stack premise). |
| **`calendarBlock`** | When `calendar` is given | The event calendar (campaigns, holidays, experiments, seasonality) as **identical text** to every agent. `calendar_mode:context` = context for interpretation (explained moves are downweighted) / `exclusion_filter` = an exclusion filter (don't spend budget confirming explained moves; demote them to a separate section and reserve finding slots for *unexplained* changes). full_stack forces the latter. |
| **`dictionaryBlock`** | When `dictionary` is given | An inline metric dictionary. Lets agents route metric identity through canonical definitions and tell apart **same-named decoy metrics** (e.g. two "preview" metrics). Must be content, not a path (fails fast). |
| **`directiveBlock`** | `directives:full_stack` | **Directives**: ① resource hierarchy (map the known landscape cheaply with the mart → reinvest the saved budget in raw drill-downs) ② calendar = exclusion filter ③ the mart/dictionary is a map, not the territory (a mismatch is itself a finding candidate) ④ the list of tool names ≠ the boundary of the data (enumerate the reachable surface with schema-discovery tools before concluding). Output also splits into `unexplained_findings` (scored) / `calendar_explained` (unscored). |
| **`comparisonProtocolBlock` + `canonicalDefsBlock`** | `comparison_protocol:fixed` (default under full_stack) | **Definition-stability package.** The former = a fixed comparison protocol (no endpoint pairs · same-DOW/slope · exclude calendar days from baselines · a move that flips with the basis is FRAGILE → `data_caveats`). The latter = look up canonical metric definitions in the dictionary (completion-rate denominator, session-vs-user depth denominator stated, share = daily slope, playtime ≠ duration). **Stops definition-fragile metrics from passing noise off as signal.** |

**Stage 2 — Synthesize (`synthesisModel`, default opus, held constant across arms).** It takes all K outputs and does ① semantic clustering → verdict (`robust` ≥K/2 / `weak` / `singleton` / `fragile`) ② failure-mode tally ③ **recall** against the analyst baseline ④ **precision** (when a GT is given). The judge is **bound to the same comparison protocol and canonical definitions** as discovery (this stops the judge from picking its own aggregation and misjudging a run — which actually happened).

#### Measuring precision / recall

Both come from **the same ground truth (GT) with different denominators**:
- **recall** = (findings ∩ GT) / all GT — "share of the GT caught". The baseline is the `baseline` arg (the *unexplained* changes an analyst set). ⚠️ To measure false negatives, the recall GT (B) must be built **cold by a human, without seeing agent output**.
- **precision** = useful / all scored — "share of what was surfaced that is useful". Given `precision_gt` (per-claim human labels), the judge scores at the **instance level** (not by stamping a cluster — runs differ in magnitude and attribution). `useful = real ∧ novel ∧ ¬negligible`. Without a GT it falls back to self-assessment.
  - Three label axes: **factuality** (real/artifact/false_positive/unverified) × **novelty** (explained = calendar, seasonality, mart / novel) × **materiality** (actionable/marginal/negligible).

### Key parameters (full table in `skill.md`)

| param | default | effect |
|---|---|---|
| `k` / `n` | 5 / 4 | independent runs / findings per run |
| `windowStart`·`windowEnd` | 05-27~06-09 | **frozen window** (complete days only, avoids the partial-data trap) |
| `discoveryModel`·`synthesisModel` | sonnet · opus | discovery / judge model (verified from transcripts and pinned) |
| `mart_tools` | `banned` | `allowed` permits KPI mart tools → flips the premise from raw-only to full-stack |
| `dictionary` | none | inline metric dictionary (for decoys; **content, not a path** — fails fast) |
| `calendar` | null | event calendar (fetched once by the parent → injected identically into every agent) |
| `directives` | none | `full_stack`: directives + split `unexplained_findings`/`calendar_explained` output |
| `comparison_protocol` | `fixed` under full_stack | definition-stability package: fixed comparison protocol (same-DOW, slope) + canonical metric definitions + `fragile` verdict. `off` reproduces earlier arms byte-identically |
| `mode` | `scan` | `case` = case replay (`cases/README.md`) |

### Design invariants
- **Byte-identical reproduction:** every newer parameter is a no-op at its default → earlier arms reproduce as-is with default args.
- **Premise guards:** under `banned`, `query_metrics*` is forbidden (KPIs are a pre-aggregated mart and break the raw-only premise). `hints:none` (no trap pre-warnings → the failure-mode measurement isn't contaminated).
- Writes nothing outside the session directory. Runs in the background and notifies on completion.

## Key takeaways

- **A dictionary is a guardrail against identity confusion (decoys), not a tool that directs exploration** — disambiguation ≠ attention.
- **Real but useless** — a finding can be correct in the data and still be useless if it's already known or a wrong pick → factuality × novelty labels are a must.
- **The definition-fragile metric family** (completion-rate denominator, session-vs-user depth, share, playtime vs duration) — without a canonical aggregation protocol, noise turns into signal no matter who computes it. Grading Claude with Claude reproduced the same fragility in the judge → `comparison_protocol: fixed` binds both sides to one protocol.
- **In case replay, getting agents to look at the right axis does not by itself get the conclusion right** — a precomputed decomposition raises answer-axis retrieval, but the pass rate barely moves and failures shift from "didn't look" to "looked and misread". Details in `FINDINGS.md`.
