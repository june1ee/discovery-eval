# What the experiments showed

Conclusions from running the harness on a real service's logs (a short-form video service), written up without service-specific numbers, metric names or incident details. The only numbers kept are results of the eval itself (pass counts, retrieval rates, etc.).

## 1. The premise changed: raw-only → full-stack

The first question was "given only raw query tools and a schema, with no KPI mart, does the agent find things on its own?" Adding a dictionary changed the premise. A real analyst walks in with a mart, a data dictionary and an event calendar. So handing all of that over is the standard condition, and the question becomes: **"given everything we already know, does it reproducibly pinpoint what we don't know yet — quiet changes no mart has and no calendar explains?"** Raw-only stops being the main experiment and becomes an ablation that measures how much worse things get without what we know.

Under this premise, **calendar-explained changes must not go into the recall answer key.** One decline we had put there turned out to line up exactly with an experiment ending — an operational artifact — and was withdrawn. Keeping it as an answer is self-contradictory: it rewards "find what is already explained".

## 2. Scan mode (open exploration of a frozen window, K=5)

| arm | condition | result in short |
|---|---|---|
| baseline | raw-only, n=4 | the false positive of reporting weekend dips as incidents came out robust (3/5) |
| calendar | + calendar | attributions converged, but a new failure appeared: calendar events filling the slots ("calendar crowding") |
| n=8 calendar | + calendar, n=8 | +21% queries yet capture of the missed signal went only 1/5 → 2/5, sub-linear — budget is not the lever |
| full-stack | mart + dictionary + calendar as exclusion filter, n=8 | every run that caught the signal correctly told apart the same-named decoy metric; zero empty-source misreads |

- **The root cause of the missed signal was metric identity confusion.** A metric with the same name existed in two sources (one declining, one flat and much larger), and agents were fooled by the name. More budget didn't fix it; the dictionary did.
- **But a dictionary is a guardrail, not a compass** (disambiguation ≠ attention). Even with it, capture stopped at 3/5. One run never looked there, and one actually misread the decoy as a rise.
- **Real ≠ useful.** Against a human-reviewed GT, 74% of agent claims (14/19) were true in the data, yet far fewer had action value (real ∧ novel ∧ ¬negligible; standard precision 37.5%). More than half of what was true was already known (explained) or trivial (negligible) → three label axes are needed: factuality × novelty × materiality.
- **located_via is self-reported, so it tells only half the story.** Discovery paths came out raw 80% / mart 20% / dictionary 0. The dictionary did block the decoy, yet the dictionary tag stayed at 0: runs recorded it as "a pitfall avoided", not as "a discovery path".
- **The definition-fragile metric family.** Metrics with no canonical aggregation — completion-rate denominator, session-vs-user depth, platform share, playtime vs duration — turn noise into signal depending on who computes them. Runs picked different denominators and reached conflicting conclusions, and **the judge reproduced the same fragility** (it recomputed on its own basis and marked runs as false positives). → `comparison_protocol: fixed` binds discovery agents and the judge to the same comparison protocol, and changes that flip with the basis are separated out as `fragile`.

### Coverage blind spot (the completeness axis)

All five full-stack runs explored only inside the data universe they saw first. They visited reachable other catalogs and marts zero times — not for lack of tools, but because they didn't go. Causes, by contribution:

1. The prompt's list of tool names anchored the boundary — "the given tool list = the universe to explore".
2. The dictionary centered on the same universe, reinforcing it.
3. A "find N" goal stops exploration the moment N is filled (satisficing). Nothing asked "did you find everything?".
4. Digging deeper in a familiar well always looks cheaper than drilling a new one.

The fix is DIRECTIVE 4, but **naming the destination is hint injection**, which makes "did it find this on its own?" unmeasurable. So it went in only as a neutral boundary-widening instruction: "the tool names you were given ≠ the data's boundary; enumerate the reachable surface with schema-discovery tools before concluding". This is a **completeness** axis that precision/recall can't catch, and it needs its own metric (coverage of sources visited).

## 3. Case mode (7 past incidents with settled causes, k=3)

| condition | pass | answer-axis retrieval (direct) | answer-axis retrieval (incl. pack) | conclusion correct |
|---|---|---|---|---|
| default | 9/21 | 14/21 | — | 12/21 |
| + precomputed decomposition (pack) | 10/21 | 17/21 | 19/21 | 10/21 |

- In the default run, 2/7 cases passed all k times (pass_all_k), both of the `open` kind that doesn't require getting the cause right. No case that asks for cause attribution passed all runs at k=3.
- **Most default-run failures were "didn't look at the answer axis"** (7 of 12 failures). There were three paths to not looking.
  - A large tool response led the agent to pin the filter to `all` — tool response size cuts exploration scope.
  - It picked a different source from the one the report used.
  - It never went below the mart's grain (hourly, referer, snapshots).
- **A pack raises retrieval but barely moves the pass rate.** The main failure shifted from "didn't look" (7 → 2) to "looked and misread" (4 → 9). The recurring misreadings:
  - comparing absolute values instead of the cross-platform **ratio**;
  - rejecting a deploy hypothesis only because there's no step on the deploy date (ignoring the rollout curve);
  - using an unusual stretch as the baseline;
  - calling it a "pure logging artifact" on one piece of evidence.
- The pack itself sometimes overlapped with a trap. Its period-mean recipe led an agent to use a surge week as the baseline, and promoting large changes the pack showed into conclusions increased forbidden-claim violations (3 → 5).
- `evidence.py` (evidence checks) computes these four misreadings with rules that don't depend on the case.
- **One piece of calendar wording changed the conclusion.** The deploy event's name and the app version were written separately, so agents split the same deploy into two hypotheses and rejected one. Writing the version alongside it stabilized cause attribution. The problem was the input's wording, not the agent's reasoning.

### What we learned about the measurement tools

- **The judge's "did it look at the answer axis" is lenient.** Seeing one axis makes it true. An audit that counts the actual queries in the transcript in code (`audit-runs.py`) is more accurate. Answer axes are now grouped, and retrieval is true only when every group is seen.
- **The judge sees only the final output.** So it can't catch a run that read the answer from a document — the first trial run did exactly that. Leak markers have to be searched across the run's whole context. Markers that are common words hit unrelated documents and give false positives.
- **The workflow passes the orchestrator's request text verbatim to child agents.** Mixing incident descriptions into the message that launches runs, or into commit messages, is a leak path.
- **Everything leans on a single judge (opus).** The next step is to measure agreement with human labels using a blind labeling sheet (`calibration-sheet.py`).

## Known limitations

1. The scan-mode recall baseline is a self-baseline made by Claude, not by a human. A real human baseline (B) must be built by sweeping the same window cold.
2. One judge — the reproducibility of clustering and verdicts hasn't been measured yet.
3. magnitude, located_via, query_count and the like are self-reported by agents. Case mode partly replaces this with transcript audits.
4. Case mode only measures incident types already seen, so it overestimates performance on new types.
