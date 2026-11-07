---
name: discovery-eval
description: "An open-ended exploration eval harness that measures whether Claude, given only a data source, finds noteworthy changes on its own. Runs K independent agents with raw query tools only, collects findings in a fixed schema, and scores reproducibility (clustering), failure modes, and recall against a human baseline. Also replays past incidents with settled causes (case mode). Triggers: /discovery-eval, exploration eval, discovery eval, agent exploration measurement, reproducibility measurement, autonomous anomaly-detection evaluation, 'finds it by itself', K-run, eval harness, case replay"
---

# discovery-eval — Open-ended discovery agent harness

**Question it answers:** *Given only raw query tools (Druid/Trino) and a schema/dictionary — no pre-built KPI marts, no anomaly lists, no dashboards — can Claude find what's worth attention on its own, and does it do so **reproducibly**?*

It runs **K independent discovery agents** over a **frozen window** with the same open-ended goal, forces each to emit a fixed findings schema, then a synthesis pass clusters findings across runs and scores three things:

1. **Reproducibility** — which findings recur across runs (`robust` ≥ K/2 · `weak` · `singleton`). The headline metric; needs no ground truth.
2. **Failure modes** — rate of known traps (below).
3. **Recall vs analyst baseline** — fraction of a human's ground-truth findings recovered.

## How to run

The harness is a Workflow script. Invoke it with the **Workflow tool** (the human must opt into multi-agent orchestration):

```
Workflow({ scriptPath: "<install path>/scripts/discovery-eval.workflow.js",
           args: { k: 5, windowStart: "2026-05-27", windowEnd: "2026-06-09", n: 4 } })
```

`<install path>` is wherever the repo is cloned (absolute path); it works from a session opened in any folder. It runs in the background and notifies on completion; watch live with `/workflows`. It writes nothing outside the session dir.

### `args` (all optional — defaults reproduce the first test run)
| arg | default | meaning |
|---|---|---|
| `k` | 5 | number of independent discovery runs |
| `windowStart` / `windowEnd` | 2026-05-27 / 2026-06-09 | **frozen** window, KST inclusive. **Pick COMPLETE days only** — exclude today/yesterday or partial data reads as a traffic drop (trap #2). |
| `n` | 4 | findings each agent must return |
| `goal` | "Find the N most notable, real changes…" | the open-ended objective |
| `discoveryModel` | `sonnet` | model for discovery agents. **Verified from transcripts:** all arms so far (baseline/calendar/n=8) ran discovery on `claude-sonnet-4-6` — this is the control default. Pass `discoveryModel: "opus"` explicitly for a model-comparison arm. |
| `synthesisModel` | `opus` | model for the synthesis/judge pass. **Verified from transcripts:** every prior synthesis ran on `claude-opus-4-8` (it had inherited the opus session). Pinned explicitly so the judge stays **constant across arms** regardless of your session model — don't let it drift. |
| `hints` | `none` | `none` = clean experiment. `traps` = hardened variant that pre-warns about pitfalls — use to show mitigation, NOT for the honest failure-mode tally. |
| `baseline` | uploads↓ (placeholder) | `[{metric,direction,title}]` analyst ground-truth for **recall**. Re-derive per window. Only *unexplained* changes belong here — a move that lines up with a calendar event (e.g. an experiment ending) is an explained operational artifact, and putting it in the baseline rewards surfacing what is already known. A real recall GT (B) must be built COLD by a human, not derived from agent output (else false negatives are unmeasurable). |
| `precision_gt` | `null` | Per-claim **human-labeled** precision ground truth: `[{claim_id, metric, direction, segment, factuality(real/artifact/false_positive/unverified), novelty(explained/novel), materiality(actionable/marginal/negligible), useful}]`. When provided, the judge scores each scored finding **at instance level** (not cluster — runs differ in magnitude/attribution) against it and emits `precision_vs_gt` (useful/scored, per-run, full instance list). `useful = real ∧ novel ∧ ¬negligible`. null ⇒ self-assessment fallback (prior arms byte-identical). (The seed GT from the original test data is not included in this repo.) This answers the analyst's morning question: "of 8 findings, how many are worth acting on?" |
| `server` | `log-analytics` | MCP server name (swap to point at another log system) |
| `service` | `a short-form video service` | one-phrase description of the service, used in the agent prompt |
| `calendar` | `null` | `[{start, summary}]` exogenous event context (campaigns, holidays, experiments, seasonality) — e.g. from `list_calendar_events`. Injected **identically** into every discovery agent **and** the synthesis scorer. **Fetch once in the parent** and pass as static text so it's byte-identical across runs — don't let agents each call the calendar tool (reintroduces variance). Not a KPI mart, so it doesn't break the premise; it's the analyst's walking-in context. Tests whether agents correctly separate *explained* moves (downweight) from genuinely *unexplained* real changes. |
| `mart_tools` | `banned` | `banned` = current behavior (raw tools only). `allowed` = discovery agents may also use the KPI mart tools (`query_metrics*`) to map the known landscape fast. **Flips the core premise** from "raw only" to "full stack". |
| `dictionary` | `none` | A metric dictionary as **inline content** (string), injected verbatim into every agent. Lets agents route metric identity through canonical definitions + spot same-named **decoy** metrics (e.g. the two "preview" metrics). **Must be content, not a path** — read the file in the orchestrator (Read tool) and pass the text, same byte-identical principle as `calendar` (a path arg fails fast). |
| `calendar_mode` | `context` | `context` = current behavior (calendar injected as interpret/downweight context). `exclusion_filter` = calendar is an **exclusion filter**: don't spend budget confirming events; demote fully-explained moves to a separate section, reserve finding slots for the unexplained. (`directives: "full_stack"` forces this regardless.) |
| `directives` | `none` | `full_stack` activates the embedded **full-stack directive set** (resource hierarchy · calendar-as-exclusion-filter · trust-mart-as-map-not-territory) and switches the output contract to split `unexplained_findings` (scored, each tagged `located_via`) / `calendar_explained` (unscored one-liners). Pair with `mart_tools: "allowed"` + `dictionary`. |
| `comparison_protocol` | `fixed` under `full_stack`, else `off` | **Definition-stability package** (added after the full-stack arm exposed the *definition-fragile metric family* — completion-rate denominator, plays-per-session-vs-viewer, iOS share, playtime-vs-duration: metrics with no canonical aggregation where noise reads as signal depending on who computes it). `fixed` injects a **mandatory comparison protocol** (same-day-of-week / daily-slope, never an endpoint pair; exclude calendar-event days; a move that flips with the basis is FRAGILE → `data_caveats`, not a scored finding) + **canonical metric definitions** into BOTH the discovery agents AND the judge (the judge re-introduced the same fragility when free to pick its own basis), adds a required `aggregation_basis` field per finding, and lets the judge return a `fragile` cluster verdict. `off` reproduces prior arms byte-for-byte. Independent of `directives`; pass `comparison_protocol: "off"` to disable even under full_stack, or `"fixed"` to enable on a raw-only arm. |

### The full-stack arm (one line, once the data dictionary + mart tools are ready)

```
Workflow({ scriptPath: "<install path>/scripts/discovery-eval.workflow.js",
           args: { k: 5, windowStart: "2026-05-27", windowEnd: "2026-06-09", n: 8,
                   mart_tools: "allowed", dictionary: <inline dictionary text>, directives: "full_stack",
                   calendar: [ ...from list_calendar_events ] } })
```

This is the **opposite** of the original premise: instead of "find signal with no help," it hands agents the full analyst toolkit (marts + dictionary + calendar-as-filter) and tests whether that **fixes the failures the raw-only arms exposed** — metric-identity/decoy routing, calendar-event crowding, and the quiet-decline blind spot. The example reproduces the **n=8 calendar arm's control conditions** (same window, K=5, n=8, sonnet) plus the three full-stack inputs — so its results diff cleanly against that control. `directives: "full_stack"` **requires** both `calendar` and `dictionary` (fails fast otherwise), forces `calendar_mode: exclusion_filter`, and emits the split `unexplained_findings` / `calendar_explained` contract with `mart_query_count` + `raw_query_count`. Defaults preserve every prior arm: omit these args and baseline/calendar/n=8 are re-runnable byte-identically.

The synthesis scorer is **full-stack-aware**: when `directives: "full_stack"` it drops `used-forbidden-KPI-tool` from the failure modes (KPI tools are permitted), counts how many runs leaked a calendar-explained move into their top scored slot (scores prediction 2), and tallies the `located_via` distribution.

## Two rules that keep the experiment honest

1. **No KPI shortcuts.** Discovery agents are barred from `query_metrics` / `query_metrics_trend` / `query_top_contents` — those *are* pre-computed KPI marts and violate the premise. Everything is built from `build_druid_query` / `druid_native_query` / `trino_query` + schema discovery.
2. **No trap warnings by default** (`hints: "none"`). Pre-warning contaminates the failure-mode measurement. Run `hints: "traps"` separately as the mitigation arm.

## Failure-mode checklist (the gold for analysis)

Discovered empirically on the original test data; the synthesis pass tallies these:

| Mode | What it looks like | Why it bites |
|---|---|---|
| **empty-source-misread** | an enriched (batch) source **lags and returns empty** for recent windows; agent reports "plays→0, traffic collapsed" | catastrophic false positive; the demographic-bearing sources are exactly the ones that lag |
| **seasonality-as-finding** | weekend UV/play dips reported as an incident | weekly cycle, not a change |
| **wrong-event-vocabulary** | `eventType` differs per source (e.g. `start`/`complete` in a playback stream vs `upload`/`update` in a content stream); reused filter returns empty | agent must probe each source, not assume uniformity |
| **used-forbidden-KPI-tool** | agent reaches for `query_metrics*` | breaks the premise |
| **hallucinated-number** | magnitude with no backing query | unverifiable |
| **dictionary-miss** | `search_data_dictionary` returns `[]` for a reasonable query | can't be leaned on as a crutch |

## Findings schema (per run)

`{ findings: [{ title, metric, dimension, segment, direction(up/down/flat/anomaly), magnitude, backing_query, confidence, is_seasonality, rationale }], pitfalls_encountered[], data_caveats[], query_count }`

## Reading the output

The workflow returns `{ k, runsReturned, window, perRun[], report }`. In `report`:
- `clusters[].verdict` — **robust** findings are your trustworthy signal; **singletons** are agent noise or lucky stumbles. The robust:singleton ratio is the reproducibility headline.
- `clusters[].likely_false_positive` — should catch the seasonality/empty-source traps.
- `failure_modes[]` — trap tally with `runs_affected`.
- `recall_vs_baseline.recall_pct` — vs the human baseline.

## Method notes

- **Frozen window is non-negotiable.** "Right now" makes runs irreproducible and invites the partial-data trap.
- To compare models/cost, run twice with different `discoveryModel` and diff `perRun.query_count` + reproducibility. Keep `synthesisModel` fixed (default `opus`) so the judge is constant across the comparison.
- A human baseline is per-window: time-box an analyst on the same window/goal, record findings, pass as `baseline`.
- See `scripts/discovery-eval.workflow.js` for the full prompt + schemas.

## Full-stack arm (pending) — pre-registered predictions

Recorded **before** the arm is ever run (data dictionary + mart tools not yet ready), so the result can be scored against a prior commitment rather than a post-hoc story. Arm = `mart_tools: "allowed"` + `dictionary` + `directives: "full_stack"`, same frozen window, K=5, calendar injected, n=8, sonnet (matching the n=8 calendar control).

1. **previews capture ≥ 4/5** — the dictionary resolves the metric-identity/decoy collision that capped capture at 1/5 (raw) and 2/5 (n=8). This is the headline test.
2. **calendar-event headlines ≤ 1/5** — the exclusion-filter directive stops agents promoting fully-explained moves (a push-campaign spike, an experiment teardown, a holiday peak) into scored slots; they land in `calendar_explained` instead.
3. **tokens & queries below the n=8 calendar arm** — the n=8 calendar arm is the n-matched control (**849k tok / 170 queries**, sonnet). The resource-hierarchy directive (marts map the known landscape cheaply, freeing budget) should cut total queries/tokens below that control at the same n=8. Watch `mart_query_count` vs `raw_query_count`: Directive 1 predicts a few cheap mart calls + the bulk reinvested into raw drill-downs.
4. **≥ 1 new quiet finding** not surfaced by any prior arm — budget reinvested in raw drill-downs surfaces a quiet monotonic change (no spike) that baseline/calendar/n=8 all missed.

Prior-arm reference points (sonnet): baseline 50% recall / previews 1/5 / weekend-FP 3/5; calendar 100% fleet recall but previews 1/5 / attribution converged / +new FP "calendar crowding"; n=8 previews 2/5 / +21% queries / +5% tokens / surfaced pre-window completion-rate collapse.
