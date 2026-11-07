// discovery-eval — K-run open-ended discovery harness.
// Invoke with the Workflow tool: Workflow({ scriptPath: "<this file>", args: {...} })
// args (all optional): { k, windowStart, windowEnd, n, goal, discoveryModel, synthesisModel, hints,
//                         baseline, server, calendar, mart_tools, dictionary, calendar_mode, directives }
//   k            number of independent discovery runs (default 5)
//   windowStart  frozen window start, YYYY-MM-DD KST inclusive
//   windowEnd    frozen window end,   YYYY-MM-DD KST inclusive  (pick COMPLETE days only)
//   n            how many findings each agent must return (default 4)
//   goal         the open-ended objective handed to each agent
//   discoveryModel  model for the discovery agents (default 'sonnet'). VERIFIED from transcripts: all
//                arms so far (baseline / calendar / n=8) ran discovery on claude-sonnet-4-6, so this is
//                the control default. Pass discoveryModel:'opus' explicitly for a model-comparison arm.
//   synthesisModel  model for the synthesis/judge pass (default 'opus'). VERIFIED from transcripts:
//                every prior synthesis ran on claude-opus-4-8 (it had inherited the opus session model).
//                Pinned explicitly so the judge stays CONSTANT across arms regardless of session model.
//   hints        'none' (clean experiment) | 'traps' (hardened: pre-warn about known pitfalls)
//   baseline     [{metric,direction,title}] analyst ground-truth for recall scoring
//   server       MCP server label to remind agents which tools to use (default 'log-analytics')
//   service      one-phrase description of the service under study (default 'a short-form video service')
//   calendar     null (default) | [{start, summary}] exogenous event context (campaigns, holidays,
//                experiments, seasonal events — e.g. from list_calendar_events). Injected IDENTICALLY
//                into every discovery agent AND the synthesis scorer. Fetch it ONCE in the parent and
//                pass it as static text so it is byte-identical across runs (don't let agents each
//                call the calendar tool — that reintroduces variance). NOT a KPI mart, so it does not
//                violate the no-pre-computed-KPI premise; it is the analyst's walking-in context.
//   mart_tools   'banned' (default, current behavior) | 'allowed'. When 'allowed', discovery agents
//                may use query_metrics / query_metrics_trend / query_top_contents (the KPI marts) IN
//                ADDITION to raw tools. Flips the core premise from "raw only" to "full stack".
//   dictionary   'none'/null (default) | a metric dictionary as inline CONTENT (multi-line string) OR
//                a path string. Injected so agents can route metric identity through canonical
//                definitions + spot same-named DECOY metrics. Path-like single-line values are exposed
//                as "read this file"; everything else is injected verbatim.
//   calendar_mode 'context' (default, current behavior: calendar injected as interpret/downweight
//                context) | 'exclusion_filter' (calendar is an exclusion filter — do NOT spend budget
//                confirming events; demote fully-explained moves to a separate section).
//   directives   'none' (default) | 'full_stack' — activates the embedded full-stack directive set
//                (resource hierarchy, calendar-as-exclusion-filter, trust-mart-as-map-not-territory)
//                and switches the output contract to split unexplained_findings / calendar_explained.
//                Intended to be paired with mart_tools:'allowed' + dictionary + calendar_mode unset
//                (full_stack already embeds the exclusion-filter directive).
//   mode         'scan' (default: everything above) | 'case' — replay past incidents whose cause is settled.
//                Case mode reads only k, discoveryModel, synthesisModel, server, cases, agent_type.
//   cases        (case mode) array of case objects = cases/<id>.json with its snapshot file inlined as
//                `snapshot` (scripts/build-case-args.py builds it). Runs see only symptom/window/calendar.
//   with_pack    (case mode) set by build-case-args --with-pack; each case's `pack` text joins the run prompt.
//   agent_type   (case mode) subagent type for runs (default 'discovery-case-agent', data tools only).
//                null = default workflow agent, which can reach wiki/internal posts/calendar — smoke tests only.
//
// WHY the constraints (defaults): the original premise is "given only query tools, no pre-computed
// KPIs." So by default discovery agents are barred from query_metrics / query_metrics_trend /
// query_top_contents (those are KPI marts), and NO trap warnings are given, so the failure-mode tally
// is honest. mart_tools:'allowed' + dictionary + directives:'full_stack' is the OPPOSITE arm: it hands
// agents the full analyst toolkit to test whether marts+dictionary fix the routing/identity failures.

export const meta = {
  name: 'discovery-eval-k',
  description: 'Open-ended discovery eval: K independent agents hunt for notable service changes over a frozen window using only raw query tools, then findings are clustered for reproducibility, scored for failure modes, and recall vs an analyst baseline.',
  phases: [
    { title: 'Discover', detail: 'K independent agents find notable changes with only raw query + schema tools' },
    { title: 'Synthesize', detail: 'cluster findings across runs -> reproducibility, failure modes, recall vs baseline' },
    { title: 'Replay', detail: 'case mode: K independent runs per past incident, symptom + window + at-the-time calendar only' },
    { title: 'Grade', detail: 'case mode: binary rubric + should-not checks against the settled answer and frozen snapshot' },
  ],
}

const cfg = args ?? {}
const K = cfg.k ?? 5
const windowStart = cfg.windowStart ?? '2026-05-27'
const windowEnd = cfg.windowEnd ?? '2026-06-09'
const n = cfg.n ?? 4
const goal = cfg.goal ?? `Find the ${n} most notable, real changes in the service during this window`
const discoveryModel = cfg.discoveryModel ?? 'sonnet'
// Judge pinned to opus so it stays CONSTANT across all arms (past + future), not drifting with the
// session model. VERIFIED from transcripts: every prior synthesis ran on claude-opus-4-8.
const synthesisModel = cfg.synthesisModel ?? 'opus'
const hints = cfg.hints ?? 'none'
const server = cfg.server ?? 'log-analytics'
const service = cfg.service ?? 'a short-form video service'
const calendar = cfg.calendar ?? null
const martTools = cfg.mart_tools ?? 'banned'
const dictionary = cfg.dictionary ?? null
const directives = cfg.directives ?? 'none'
// full_stack embeds the exclusion-filter directive, so it implies that calendar_mode regardless of arg.
const calendarMode = directives === 'full_stack' ? 'exclusion_filter' : (cfg.calendar_mode ?? 'context')
const fullStack = directives === 'full_stack'
// Definition-stability package (2026-06-16). Targets the definition-fragile metric family the full-stack
// arm exposed (C3 completion-rate denominator, C11 plays-per-session-vs-viewer, C13 iOS share, C10 playtime-vs-duration):
// metrics with no canonical aggregation where noise masquerades as signal depending on who computes it.
// 'fixed' (default under full_stack) binds BOTH discovery agents and the judge to one comparison protocol
// (same-day-of-week, de-seasonalized, regression-slope over endpoint-pair) + canonical metric definitions,
// and lets the judge return a 'fragile' verdict. 'off' (default otherwise) reproduces prior arms byte-for-byte.
const comparisonProtocol = cfg.comparison_protocol ?? (fullStack ? 'fixed' : 'off')
const fixedProtocol = comparisonProtocol === 'fixed'
// full_stack tests whether calendar+dictionary fix the routing/identity failures — both are prerequisites.
if (fullStack && !(calendar && calendar.length)) throw new Error("directives:'full_stack' requires a non-empty `calendar` arg")
if (fullStack && !dictionary) throw new Error("directives:'full_stack' requires a `dictionary` arg (path or inline content)")
// recall baseline: only changes the calendar CANNOT explain belong here — a calendar-explained move would
// reward surfacing what is already known. A real recall GT must be built COLD by a human, not derived from
// agent output. Pass `baseline` to override; the default is a placeholder from the first test window.
const baseline = cfg.baseline ?? [
  { metric: 'uploads', direction: 'down', title: 'uploads decline across all categories' },
]

// precision ground truth: per-claim human labels for "of what agents surfaced, how much is useful".
// useful = factuality:real AND novelty:novel AND materiality:!=negligible. When provided, the judge scores
// each scored finding against it at the INSTANCE level (not cluster — a cluster's runs can differ in
// magnitude/attribution). null => judge falls back to self-assessment (prior arms byte-identical).
// Match a finding to a GT row by (metric, direction, segment) semantically. This default seed is the
// full-stack arm's appendix-C/D verdicts (blind re-query + external anchor); REVIEW & edit per arm.
const precisionGT = cfg.precision_gt ?? null

const calendarBody = calendar && calendar.length
  ? calendar.map(e => `- ${e.start}${e.end && e.end !== e.start ? `..${e.end}` : ''}: ${e.summary}`).join('\n')
  : ''

// 'context' (default) reproduces the original wording byte-for-byte. Under full_stack the
// exclusion-filter INSTRUCTION lives solely in DIRECTIVE 2, so here we emit only the event list.
// (Standalone 'exclusion_filter' mode — directives:'none' — still carries its own instruction line.)
const calendarBlock = calendar && calendar.length ? (
  fullStack
    ? `
SERVICE EVENT CALENDAR (exogenous events — campaigns, holidays, experiments, seasonal events):
${calendarBody}`
    : calendarMode === 'exclusion_filter'
    ? `
SERVICE EVENT CALENDAR (exogenous events — campaigns, holidays, experiments, seasonal events):
${calendarBody}
Treat this as an EXCLUSION FILTER, not a checklist: do NOT spend discovery budget confirming these events appear in the data. A change FULLY explained by a calendar entry is NOT a finding — demote it to a one-line acknowledgment in the "explained" section. Reserve finding slots for changes the calendar CANNOT explain. When a real change coincides with a calendar event, test whether the event fully accounts for the MAGNITUDE — residual unexplained movement IS a finding.`
    : `
SERVICE EVENT CALENDAR (exogenous context — campaigns, holidays, experiments, seasonal events that may affect metrics):
${calendarBody}
Use this to INTERPRET what you find: a move explained by a calendar event is expected, not a novel discovery — note the link and downweight it. A real change with NO calendar explanation is more noteworthy. The calendar is not exhaustive; absence of an event does not make a move automatically novel (e.g. weekly weekend cycles are not on it).`
) : ''

const trapHint = hints === 'traps' ? `
KNOWN TRAPS (do not report these as findings):
- Enriched sources may LAG and return EMPTY for recent windows -> fall back to realtime, never report "traffic collapsed".
- Weekend dips in UV/plays are weekly SEASONALITY, not a change.
- eventType vocabulary differs per datasource -> probe each.` : ''

// Metric dictionary is injected VERBATIM into every agent (byte-identical, like calendar). The parent
// must inline file content before passing it — the sandbox can't read files, and a per-agent "read this
// file" instruction would reintroduce variance. So a path-like value is a usage error: read it in the
// orchestrator (Read tool) and pass the text.
const dictIsPath = typeof dictionary === 'string' && !dictionary.includes('\n') && /^[~./]|\.(md|json|ya?ml|csv|tsv|txt)$/i.test(dictionary.trim())
if (dictionary && dictIsPath) throw new Error("`dictionary` must be inline content, not a path — read the file in the orchestrator and pass its text (per-agent file reads are forbidden, same principle as calendar)")
const dictionaryBlock = dictionary ? `
METRIC DICTIONARY (route metric identity through this — canonical definition + watch for same-named DECOY metrics):
${dictionary}` : ''

// Tool-access ground rules. 'banned' (default) reproduces the original two lines exactly.
const landscapeRule = martTools === 'allowed'
  ? `- A pre-built KPI mart and curated metrics exist for the KNOWN landscape. No one tells you which CHANGES matter — that you must find.`
  : `- No one will tell you where to look. There are NO pre-built KPI marts, anomaly lists, or curated dashboards.`
const toolRule = martTools === 'allowed'
  ? `- You have the FULL analyst toolkit. The KPI mart tools (query_metrics, query_metrics_trend, query_top_contents) ARE available — use them to map the known landscape fast. A pre-aggregated daily mart tool daily_stat_mart(start_date, end_date, dataSources, surfaces, platform, metrics) is ALSO available. You ALSO have raw query + schema-discovery tools: list_druid_datasources, describe_druid_datasource, list_trino_tables, describe_trino_table, search_data_dictionary, get_data_dictionary_page, build_druid_query, druid_native_query, trino_query, trino_custom_query. Note trino_custom_query takes an explicit catalog+schema and is NOT limited to the default schema — use the schema-discovery tools to learn which catalogs/schemas/sources exist rather than assuming this list of tool names bounds where the data lives.`
  : `- You may ONLY use raw query + schema-discovery tools: list_druid_datasources, describe_druid_datasource, list_trino_tables, describe_trino_table, search_data_dictionary, get_data_dictionary_page, build_druid_query, druid_native_query, trino_query, trino_custom_query.
- You MUST NOT use the convenience KPI tools query_metrics, query_metrics_trend, or query_top_contents. Construct every breakdown yourself from raw queries.`

const directiveBlock = fullStack ? `

FULL-STACK DIRECTIVES:
DIRECTIVE 1 — Resource hierarchy: cheap tools buy you budget; spend that budget on the unknown. Use the mart/KPI tools to establish the known landscape FAST. Do NOT re-derive from raw what the mart already answers. Every query saved there MUST be reinvested in raw-tool drill-downs across dimensions and metrics the marts do NOT cover — unusual dimension combinations, ratios and rates (not just volumes), per-segment slices, and especially quiet monotonic changes that produce no spike.
DIRECTIVE 2 — Calendar is an exclusion filter, not a checklist. Do not spend discovery budget confirming that calendar events exist in the data. A change fully explained by a calendar entry is NOT a finding — demote it to a one-line acknowledgment in the "explained" section. Findings slots are reserved for changes the calendar CANNOT explain. When a real change coincides with a calendar event, test whether the event fully accounts for the magnitude — residual unexplained movement IS a finding.
DIRECTIVE 3 — Trust the mart/dictionary as a map, not as the territory. (a) route metric identity through the dictionary (canonical definition + decoy check) whenever it covers the metric; (b) allocate a meaningful share of queries to dimensions/sources the mart does not aggregate; (c) if a mart number and a raw cross-check disagree, flag the discrepancy itself as a finding candidate; (d) never conclude "no change" merely because the mart has no metric for that area.
DIRECTIVE 4 — The list of tool NAMES you were given does not define the boundary of the data. Do not assume the sources you happen to query first are the whole universe. Before concluding a metric "did not change" — or that an area has no signal — actively enumerate what actually exists: run the schema-discovery tools (list_druid_datasources, list_trino_tables, search_data_dictionary, and trino_custom_query against catalogs/schemas you have not yet listed) to map the reachable surface, and check whether metrics or sources you have NOT visited could carry a change. Reaching a source but never visiting it is a coverage gap, not a safe omission; "I only looked where I started" is an incomplete sweep. When the same metric can be measured in more than one place and they disagree, that divergence is itself a finding candidate.` : ''

// Definition-stability package. Injected into discovery agents AND the judge (same text) so the comparison
// basis is fixed on both sides — empirically, the same metric scored differently per side purely from
// aggregation choice (endpoint-pair vs period-sum vs same-DOW). 'off' emits nothing (prior arms unchanged).
const comparisonProtocolBlock = fixedProtocol ? `

COMPARISON PROTOCOL (mandatory — a change is only a finding if it survives this; otherwise it is FRAGILE, not real):
- NEVER claim a trend from an endpoint pair (e.g. "day A vs day B"). Two days can differ purely by day-of-week or a one-off event. A trend claim REQUIRES a day-by-day series.
- Metrics with strong weekly cycles (UV, plays, ratios-per-user/session, share-of-total) MUST be compared same-day-of-week (weekday↔weekday, weekend↔weekend) across ≥3 weeks, OR by fitting a slope to the daily series and checking the trend is not within day-of-week noise.
- Exclude/flag calendar-event days (campaign sends, holidays, instrumentation deploys) from baselines — they are not representative.
- A move that flips direction or vanishes depending on the comparison basis (period-sum vs same-DOW, or denominator choice) is FRAGILE by definition — report it in data_caveats, NOT as a scored finding.
- For each finding, set aggregation_basis = the exact comparison you used (e.g. "same-DOW weekday, 3wk", "daily slope over window", "period-sum"), so the basis is auditable.` : ''

// Canonical metric definitions: a POINTER, not a copy. The single source of truth is the MCP server's metric
// dictionary; hardcoding the defs here would fork them and drift. So agents are pointed at the dictionary
// and only the disputes to resolve THROUGH it are named — the answers are not restated.
const canonicalDefsBlock = fixedProtocol ? `

CANONICAL METRIC DEFINITIONS — single source of truth is the metric dictionary, NOT your memory:
- Before computing any metric, look up its canonical definition via search_data_dictionary("metric dictionary") (or the metric's name/alias) and get_data_dictionary_page. Use the source + eventType + filter + grain it specifies, verbatim. Do NOT reconstruct a definition from memory or a plausible proxy.
- The dictionary carries the resolutions for the historically-disputed metrics — route these THROUGH it rather than guessing: completion rate (numerator/denominator: which events?), consumption depth (which UV denominator?), preview (which of the two sources?), playtime vs duration. If you use a proxy because the canonical isn't directly queryable, label it a proxy and do not treat its magnitude as canonical.
- If the dictionary lacks a metric, say so and state the exact numerator/denominator you chose — never invent a denominator silently.
- platform share / share-of-total (not necessarily in the dictionary): compute as SUM(part)/SUM(whole) over the SAME daily series and judge by slope, never by two hand-picked days.` : ''

// 'banned'+'context'+no-directives reproduces the original closing line byte-for-byte.
const closingLine = fullStack
  ? `Return ONLY the structured output. Put the ${n} strongest changes the calendar CANNOT explain into unexplained_findings (scored), each tagged with located_via = which resource located it (mart_shortcut | dictionary_routing | raw_exploration). Put calendar-explained moves into calendar_explained as one-liners (unscored). Also return the pitfalls you hit and data caveats. Report mart_query_count = calls to the KPI/aggregate mart tools (query_metrics / query_metrics_trend / query_top_contents / daily_stat_mart) and raw_query_count = calls to raw query tools (build_druid_query / druid_native_query / trino_query / trino_custom_query), counted separately. Set is_seasonality=true on anything that is merely a weekly cycle.`
  : `Return ONLY the structured findings: the ${n} strongest REAL changes, plus which pitfalls you hit and any data caveats. Set is_seasonality=true on anything that is merely a weekly cycle. query_count = number of query tool calls you made.`

// aggregation_basis is required only under the fixed comparison protocol, so 'off' arms stay byte-identical.
const aggBasisField = fixedProtocol ? { aggregation_basis: { type: 'string' } } : {}
const aggBasisReq = fixedProtocol ? ['aggregation_basis'] : []

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['findings', 'pitfalls_encountered', 'data_caveats', 'query_count'],
  properties: {
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['title','metric','dimension','segment','direction','magnitude','backing_query','confidence','is_seasonality','rationale', ...aggBasisReq],
      properties: {
        title: { type: 'string' }, metric: { type: 'string' }, dimension: { type: 'string' },
        segment: { type: 'string' }, direction: { type: 'string', enum: ['up','down','flat','anomaly'] },
        magnitude: { type: 'string' }, backing_query: { type: 'string' },
        confidence: { type: 'string', enum: ['high','med','low'] },
        is_seasonality: { type: 'boolean' }, rationale: { type: 'string' }, ...aggBasisField,
      },
    } },
    pitfalls_encountered: { type: 'array', items: { type: 'string' } },
    data_caveats: { type: 'array', items: { type: 'string' } },
    query_count: { type: 'integer' },
  },
}

// full_stack output contract: unexplained_findings (scored, tagged by locating resource) + calendar_explained (unscored one-liners).
// query_count is split into mart vs raw so we can measure Directive-1 budget reinvestment (cheap marts -> raw drill-downs).
const FULLSTACK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['unexplained_findings', 'calendar_explained', 'pitfalls_encountered', 'data_caveats', 'mart_query_count', 'raw_query_count'],
  properties: {
    unexplained_findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['title','metric','dimension','segment','direction','magnitude','backing_query','confidence','is_seasonality','located_via','rationale', ...aggBasisReq],
      properties: {
        title: { type: 'string' }, metric: { type: 'string' }, dimension: { type: 'string' },
        segment: { type: 'string' }, direction: { type: 'string', enum: ['up','down','flat','anomaly'] },
        magnitude: { type: 'string' }, backing_query: { type: 'string' },
        confidence: { type: 'string', enum: ['high','med','low'] },
        is_seasonality: { type: 'boolean' },
        located_via: { type: 'string', enum: ['mart_shortcut','dictionary_routing','raw_exploration'] },
        rationale: { type: 'string' }, ...aggBasisField,
      },
    } },
    calendar_explained: { type: 'array', items: { type: 'string' } },
    pitfalls_encountered: { type: 'array', items: { type: 'string' } },
    data_caveats: { type: 'array', items: { type: 'string' } },
    mart_query_count: { type: 'integer' },  // calls to query_metrics / query_metrics_trend / query_top_contents
    raw_query_count: { type: 'integer' },   // calls to build_druid_query / druid_native_query / trino_query / trino_custom_query
  },
}

const DISCOVERY_SCHEMA = fullStack ? FULLSTACK_SCHEMA : FINDINGS_SCHEMA

const CLUSTER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['clusters','failure_modes','recall_vs_baseline','summary'],
  properties: {
    clusters: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['canonical_finding','metric','direction','support_count','run_indices','magnitude_range','verdict','likely_false_positive','notes'],
      properties: {
        canonical_finding: { type: 'string' }, metric: { type: 'string' }, direction: { type: 'string' },
        support_count: { type: 'integer' }, run_indices: { type: 'array', items: { type: 'integer' } },
        magnitude_range: { type: 'string' },
        verdict: { type: 'string', enum: fixedProtocol ? ['robust','weak','singleton','fragile'] : ['robust','weak','singleton'] },
        likely_false_positive: { type: 'boolean' }, notes: { type: 'string' },
      },
    } },
    failure_modes: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['mode','runs_affected','description'],
      properties: { mode: { type: 'string' }, runs_affected: { type: 'array', items: { type: 'integer' } }, description: { type: 'string' } },
    } },
    recall_vs_baseline: {
      type: 'object', additionalProperties: false,
      required: ['baseline_total','recovered','missed','recall_pct'],
      properties: { baseline_total: { type: 'integer' }, recovered: { type: 'integer' }, missed: { type: 'array', items: { type: 'string' } }, recall_pct: { type: 'number' } },
    },
    ...(precisionGT ? { precision_vs_gt: {
      type: 'object', additionalProperties: false,
      required: ['scored_total','useful','marginal','not_useful','precision_pct','per_run','instances'],
      properties: {
        scored_total: { type: 'integer' },         // all scored findings (instance level)
        useful: { type: 'integer' },                // real ∧ novel ∧ !negligible
        marginal: { type: 'integer' },              // real but marginal materiality
        not_useful: { type: 'integer' },            // artifact / FP / explained / negligible
        precision_pct: { type: 'number' },          // useful / scored_total
        per_run: { type: 'array', items: {          // per-run precision (instance scoring, not a cluster stamp)
          type: 'object', additionalProperties: false,
          required: ['run','scored','useful','precision_pct'],
          properties: { run: { type: 'integer' }, scored: { type: 'integer' }, useful: { type: 'integer' }, precision_pct: { type: 'number' } },
        } },
        instances: { type: 'array', items: {        // GT match for each finding
          type: 'object', additionalProperties: false,
          required: ['run','title','matched_gt','factuality','novelty','materiality','useful'],
          properties: {
            run: { type: 'integer' }, title: { type: 'string' },
            matched_gt: { type: 'string' },           // matched GT claim_id, or 'unmatched'
            factuality: { type: 'string', enum: ['real','artifact','false_positive','unverified'] },
            novelty: { type: 'string', enum: ['explained','novel'] },
            materiality: { type: 'string', enum: ['actionable','marginal','negligible'] },
            useful: { type: 'boolean' },
          },
        } },
      },
    } } : {}),
    summary: { type: 'string' },
  },
}

const discoveryPrompt = `You are a data analyst investigating ${service}'s log analytics (${server}). All times are KST.

OBJECTIVE: ${goal}.
WINDOW (frozen, inclusive): ${windowStart} -> ${windowEnd}. Use exactly these dates, no other window.

GROUND RULES:
${landscapeRule}
${toolRule}
- Method: discover what data exists -> form hypotheses -> break metrics down by dimensions you choose (category, sourcePage, gender/age, hashtag, os, creatorUserType, eventType, etc.) -> CONFIRM each candidate with a day-by-day series before trusting it.
- Localize each finding to the dimension/segment driving it. Report magnitude as a concrete % or before->after numbers.
${trapHint}${calendarBlock}${dictionaryBlock}${directiveBlock}${comparisonProtocolBlock}${canonicalDefsBlock}
${closingLine}`

if (cfg.mode === 'case') {
  const cases = cfg.cases
  if (!Array.isArray(cases) || !cases.length) throw new Error("mode:'case' requires `cases` — case objects with `snapshot` inlined (scripts/build-case-args.py)")
  const caseK = cfg.k ?? 3
  const caseAgentType = cfg.agent_type === undefined ? 'discovery-case-agent' : cfg.agent_type

  const CASE_RUN_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['observation_reproduced', 'conclusion', 'hypotheses', 'axes_examined', 'pitfalls_encountered', 'data_caveats', 'query_count'],
    properties: {
      observation_reproduced: { type: 'string' },
      conclusion: {
        type: 'object', additionalProperties: false, required: ['classification', 'summary', 'confidence'],
        properties: {
          classification: { type: 'string', enum: ['real_behavior', 'measurement_artifact', 'mixed', 'undetermined'] },
          summary: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'med', 'low'] },
        },
      },
      hypotheses: { type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['hypothesis', 'status', 'evidence', 'control_used', 'backing_query'],
        properties: {
          hypothesis: { type: 'string' }, status: { type: 'string', enum: ['supported', 'refuted', 'inconclusive'] },
          evidence: { type: 'string' }, control_used: { type: 'string' }, backing_query: { type: 'string' },
        },
      } },
      axes_examined: { type: 'array', items: { type: 'string' } },
      pitfalls_encountered: { type: 'array', items: { type: 'string' } },
      data_caveats: { type: 'array', items: { type: 'string' } },
      query_count: { type: 'integer' },
    },
  }

  const CASE_GRADE_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['per_run', 'summary'],
    properties: {
      per_run: { type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['run', 'rubric', 'should_not', 'considered_true_cause', 'top_hypothesis_correct', 'used_non_data_evidence', 'notes'],
        properties: {
          run: { type: 'integer' },
          rubric: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['id', 'pass', 'reason'],
            properties: { id: { type: 'string' }, pass: { type: 'boolean' }, reason: { type: 'string' } },
          } },
          should_not: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['id', 'violated', 'reason'],
            properties: { id: { type: 'string' }, violated: { type: 'boolean' }, reason: { type: 'string' } },
          } },
          considered_true_cause: { type: 'boolean' },
          top_hypothesis_correct: { type: 'boolean' },
          used_non_data_evidence: { type: 'boolean' },
          notes: { type: 'string' },
        },
      } },
      summary: { type: 'string' },
    },
  }

  const caseCalendar = c => c.calendar && c.calendar.length
    ? c.calendar.map(e => `- ${e.start}${e.end && e.end !== e.start ? `..${e.end}` : ''}: ${e.summary}`).join('\n')
    : '(none recorded)'

  const casePrompt = c => `You are a data analyst investigating ${service}'s log analytics (${server}). All times are KST.

A metric report raised the observation below. Establish from the data what actually happened.
OBSERVATION: ${c.symptom}
WINDOW (frozen, inclusive): ${c.window.start} -> ${c.window.end}. Query only dates inside it.

SERVICE EVENT CALENDAR as known at the time (candidates to test, not explanations):
${caseCalendar(c)}
${c.pack ? `\n${c.pack}\n` : ''}
METHOD:
- First rebuild the reported numbers from the data. If they do not reproduce, that gap is evidence — find out why.
- Keep competing hypotheses open, including "the measurement changed, not the behavior". Test each against a control: another platform, app version, entry channel, or an independent source of the same quantity.
- Judge change from a day-by-day series and same-day-of-week comparison, never from two endpoints. A baseline that sits inside an unusual stretch does not show a change.
- For a calendar event, check that its timing and exposure (which segments, what rollout share) line up with where and how much the metric moved. Coincidence in time is not enough.
- Separate population (UV), volume (counts) and intensity (per user). When a ratio moves, check numerator and denominator separately — they may come from different sources.
- Look up a metric's definition in the data dictionary before computing it; do not invent a denominator.
- If the data cannot settle the cause, say so instead of asserting one.

Return ONLY the structured output. List hypotheses with the leading one first. axes_examined = every dimension and source you actually broke the data down by.`

  const gradePrompt = (c, runs) => `You are grading ${runs.length} independent investigations of one past incident whose answer is settled. Grade from the answer and the frozen snapshot below; do not run queries.

CASE: ${c.title} (kind: ${c.kind})
OBSERVATION given to the runs: ${c.symptom}
ANSWER: ${JSON.stringify(c.answer)}
WHERE THE CAUSE IS VISIBLE (answer_axes): ${JSON.stringify(c.answer_axes)}
RUBRIC (binary; must=true items are required): ${JSON.stringify(c.rubric)}
SHOULD NOT (asserting any of these is a violation): ${JSON.stringify(c.should_not)}
FROZEN SNAPSHOT (mart values; use it to check the runs' numbers): ${JSON.stringify(c.snapshot ?? null)}

RUNS (JSON; index = run number):
${JSON.stringify(runs.map((r, i) => ({ run: i + 1, ...r })))}

For EACH run:
- rubric: pass/fail every rubric id with a one-line reason. Pass only when the run's own evidence shows it, not when it merely names the idea. A number the snapshot contradicts fails the item it supports.
- should_not: violated=true when the run asserts the claim as its conclusion or leading hypothesis. Raising it and refuting it is not a violation.
- considered_true_cause: the run broke the data down along at least one answer_axes item, whether or not it concluded correctly.
- top_hypothesis_correct: the run's leading conclusion agrees with ANSWER.summary. For kind "open": it reaches what the answer establishes and asserts no cause the answer rules out.
- used_non_data_evidence: the run relied on documents, posts, notes or past write-ups instead of data.
Then summarize what separated passing runs from failing ones.`

  const graded = await pipeline(cases,
    c => parallel(Array.from({ length: caseK }, (_, i) => () =>
      agent(casePrompt(c), {
        label: `${c.id}#${i + 1}`, phase: 'Replay', schema: CASE_RUN_SCHEMA, model: discoveryModel,
        ...(caseAgentType ? { agentType: caseAgentType } : {}),
      })
    )).then(rs => rs.filter(Boolean)),
    (runs, c) => runs.length
      ? agent(gradePrompt(c, runs), { label: `grade:${c.id}`, phase: 'Grade', schema: CASE_GRADE_SCHEMA, model: synthesisModel }).then(g => ({ c, runs, g }))
      : { c, runs, g: null },
  )

  // Scored in code, not by the judge: a run passes only with every must item and no should-not violation.
  const scored = graded.filter(Boolean).map(({ c, runs, g }) => {
    const must = c.rubric.filter(r => r.must).map(r => r.id)
    const perRun = (g?.per_run ?? []).map(r => {
      const passed = r.rubric.filter(x => x.pass).map(x => x.id)
      const violations = r.should_not.filter(x => x.violated).map(x => x.id)
      return {
        run: r.run, pass: must.every(id => passed.includes(id)) && !violations.length, passed, violations,
        considered_true_cause: r.considered_true_cause, top_hypothesis_correct: r.top_hypothesis_correct,
        used_non_data_evidence: r.used_non_data_evidence,
      }
    })
    const n = perRun.length
    const rate = f => (n ? perRun.filter(f).length / n : 0)
    return {
      id: c.id, kind: c.kind, runs: n,
      pass_at_k: perRun.some(r => r.pass), pass_all_k: n > 0 && perRun.every(r => r.pass), pass_rate: rate(r => r.pass),
      retrieval_rate: rate(r => r.considered_true_cause), ranking_rate: rate(r => r.top_hypothesis_correct),
      contaminated_runs: perRun.filter(r => r.used_non_data_evidence).map(r => r.run),
      query_counts: runs.map(r => r.query_count),
      perRun, grade: g,
    }
  })
  log(scored.map(s => `${s.id}: pass ${Math.round(s.pass_rate * 100)}% (retrieval ${Math.round(s.retrieval_rate * 100)}%)`).join(' · '))
  return { mode: 'case', k: caseK, variant: cfg.variant ?? null, with_pack: !!cfg.with_pack, with_evidence: !!cfg.with_evidence, discoveryModel, synthesisModel, agent_type: caseAgentType, cases: scored }
}

phase('Discover')
const rawRuns = (await parallel(
  Array.from({ length: K }, (_, i) => () =>
    agent(discoveryPrompt, { label: `discover#${i + 1}`, phase: 'Discover', schema: DISCOVERY_SCHEMA, model: discoveryModel })
  )
)).filter(Boolean)
// Normalize so downstream (synthesis + perRun) sees a uniform `findings` list + `query_count` regardless of arm.
const runs = rawRuns.map(r => fullStack
  ? { ...r, findings: r.unexplained_findings || [], query_count: (r.mart_query_count || 0) + (r.raw_query_count || 0) }
  : r)
log(`${runs.length}/${K} discovery runs returned structured findings`)

phase('Synthesize')
const half = Math.ceil(runs.length / 2)

// Under full_stack: KPI tools are permitted, so 'used-forbidden-KPI-tool' is not a failure mode; add full-stack-specific scoring.
const failureModeList = fullStack
  ? `seasonality-reported-as-finding, empty-source-misread-as-collapse, wrong-event-vocabulary, hallucinated-number-without-query. (NOTE: the KPI mart tools query_metrics / query_metrics_trend / query_top_contents are PERMITTED in this arm, so do NOT count their use as a failure.)`
  : `seasonality-reported-as-finding, empty-source-misread-as-collapse, wrong-event-vocabulary, used-forbidden-KPI-tool, hallucinated-number-without-query.`

const fullStackTasks = fullStack ? `
4) CALENDAR DEMOTION: each run was told to keep calendar-explained moves OUT of unexplained_findings (its scored slots) and put them in calendar_explained instead. For each run, inspect its TOP unexplained_finding and judge whether it is actually fully explained by a calendar event (the runs each carry calendar_explained_count and located_via). Count how many of the ${runs.length} runs leaked a calendar-explained move into their top scored slot. Report this in summary as "calendar-leak: X/${runs.length}".
5) LOCATED_VIA: tally the located_via distribution across all scored findings (mart_shortcut vs dictionary_routing vs raw_exploration) and report it in summary — this measures whether budget was reinvested into raw exploration (Directive 1) vs leaning on the mart.` : ''

// Bind the judge to the SAME comparison protocol + canonical defs as the agents — empirically the judge
// re-introduced the very definition-fragility it was scoring (computed iOS share as period-sum, declared a
// run's endpoint-pair read an FP) when left free to pick its own basis.
const judgeProtocolBlock = fixedProtocol ? `

SCORING PROTOCOL (you are bound to the SAME comparison rules the agents were):
- Judge a trend by the daily SERIES (slope / same-day-of-week), NEVER by an endpoint pair or a single period-sum. If you and a run computed a metric on different bases (e.g. you used period-sum, the run used two days), that is NOT grounds to call the run an FP — it means the metric is FRAGILE.
- Use the canonical metric definitions (completion rate = completed plays with playtime>=duration; depth denominator stated; platform-share by daily slope; playtime≠duration). Do not re-derive with a proxy.
- A cluster whose direction/magnitude depends on the comparison basis or denominator = verdict "fragile" (real numbers, but no canonical aggregation makes it scoreable). Reserve "fragile" for this; keep "robust/weak/singleton" for changes that survive the protocol.
- Do not over-trust a finding's confidence/backing_query/rationale; re-judge from metric+direction+segment against the protocol.` : ''

const synthPrompt = `You are scoring a discovery-agent eval. ${runs.length} independent agents each investigated the SAME frozen window (${windowStart} -> ${windowEnd}) with the SAME prompt, and returned structured findings.${fullStack ? ` This is a FULL-STACK arm: agents had KPI mart tools + a metric dictionary + the calendar as an exclusion filter, and returned unexplained_findings (scored) separately from calendar_explained (one-liners). Each scored finding carries located_via (mart_shortcut | dictionary_routing | raw_exploration).` : ''}${judgeProtocolBlock}

RUNS (JSON; index = run number):
${JSON.stringify(runs.map((r, i) => ({ run: i + 1, ...r })))}

ANALYST BASELINE (real changes a good run should recover):
${JSON.stringify(baseline)}
${calendar && calendar.length ? `\nSERVICE EVENT CALENDAR the runs were given (use it to judge whether attributions are correct and whether calendar-explained moves were properly downweighted${fullStack ? '/demoted' : ''}):\n${calendar.map(e => `- ${e.start}: ${e.summary}`).join('\n')}\n` : ''}
Do the following and return the structured report:
1) CLUSTER semantically-equivalent findings across runs (same metric + direction + segment = one cluster, even if worded differently). Per cluster: support_count = number of DISTINCT runs that surfaced it; run_indices; magnitude_range across runs; verdict = "robust" if support_count >= ${half}, "weak" if 2..${half - 1}, "singleton" if 1${fixedProtocol ? `, OVERRIDDEN to "fragile" (regardless of support_count) if the change does not survive the SCORING PROTOCOL above — i.e. it depends on comparison basis/denominator, or rests on an endpoint pair rather than a daily series` : ''}. Set likely_false_positive=true for weekend/weekly seasonality or misreads of an empty/lagging datasource (e.g. a metric reported as collapsed to ~0).
2) FAILURE MODES: tally traps hit across runs - ${failureModeList} List runs_affected for each observed mode.
3) RECALL vs baseline: for each baseline item, recovered if >=1 run surfaced it; recall_pct = recovered/baseline_total.${fullStackTasks}${precisionGT ? `
6) PRECISION vs ground truth: a human-labeled precision GT is provided below. For EACH scored finding of EACH run (instance level — do NOT stamp a whole cluster's label onto every member; runs differ in magnitude/attribution), match it to a GT row by (metric, direction, segment) semantically, copy that row's factuality/novelty/materiality, and set useful = (factuality=="real" AND novelty=="novel" AND materiality!="negligible"). If a finding matches no GT row, set matched_gt="unmatched", judge it yourself against the same rule, and flag it in notes (an unmatched finding means the GT may be incomplete). Fill precision_vs_gt: scored_total = total scored findings across runs; useful/marginal/not_useful counts; precision_pct = useful/scored_total; per_run breakdown; and the full instances list. This measures "of what agents surfaced, how much is genuinely useful" — the analyst's morning question.

PRECISION GROUND TRUTH (human-labeled; match by metric+direction+segment):
${JSON.stringify(precisionGT)}` : ''}`

const report = await agent(synthPrompt, { label: 'synthesize', phase: 'Synthesize', schema: CLUSTER_SCHEMA, model: synthesisModel })

return {
  k: K, runsReturned: runs.length, window: `${windowStart} -> ${windowEnd}`, discoveryModel, synthesisModel, hints,
  mart_tools: martTools, calendar_mode: calendarMode, directives, comparison_protocol: comparisonProtocol, dictionary: dictionary ? (dictIsPath ? dictionary.trim() : 'inline') : null,
  precision_gt: precisionGT ? `${precisionGT.length} labeled claims` : null,
  perRun: runs.map((r, i) => ({
    run: i + 1, findingCount: r.findings.length, query_count: r.query_count, pitfalls: r.pitfalls_encountered,
    ...(fullStack ? {
      mart_query_count: r.mart_query_count, raw_query_count: r.raw_query_count,
      calendar_explained_count: (r.calendar_explained || []).length,
      located_via: r.findings.map(f => f.located_via),
    } : {}),
  })),
  report,
}
