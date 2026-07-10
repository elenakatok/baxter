import type { Outcome, OutcomeSchema, RoleConfig } from '@mygames/game-engine'
import type { GameDefinition } from '@mygames/game-server'

// ── Role config ───────────────────────────────────────────────────────────────

export const baxterConfig: RoleConfig = {
  roles: [
    { key: 'baxter', label: 'Baxter Management', short: 'B' },
    { key: 'union',  label: 'Local 190',         short: 'U' },
  ],
}

// ── Outcome schema — 1978 contract (six agreed issues) + optional Notes ────────
// All enum; stored values are the option KEYS (frontend maps them to labels).
// Mirrors frontend/src/gameConfig.ts.

export const baxterSchema: OutcomeSchema = [
  { key: 'wages',           type: 'enum', options: ['above_top3', 'current', 'increase_top3'] },
  { key: 'plant_operation', type: 'enum', options: ['higher_autonomy', 'higher_mgmt', 'maintain_autonomy', 'maintain_mgmt'] },
  { key: 'escalator',       type: 'enum', options: ['eliminate', 'maintain', 'reduce'] },
  { key: 'incentive',       type: 'enum', options: ['eliminate', 'maintain', 'reduce', 'individual'] },
  { key: 'location',        type: 'enum', options: ['deloitte', 'elsewhere'] },
  { key: 'transfer',        type: 'enum', options: ['all', 'most', 'some'] },
  { key: 'notes',           type: 'text' },  // optional free-text; blank = '', excluded from scoring
]

// ── 1983 outcome schema — WAGE ONLY (spec §4) ──────────────────────────────────
// The 1983 round negotiates a single continuous 2-decimal hourly wage, NOT the six-issue
// 1978 contract. Wired via roundOutcomeSchemas below so the round-aware submit flow
// validates the 1983 lead outcome ({ wage83 }) against this instead of baxterSchema.
export const baxter1983Schema: OutcomeSchema = [
  { key: 'wage83', type: 'decimal', min: 0, max: 100, step: 0.01 },
]

// ── 1985 outcome schema — OWN six-issue contract (spec §5) ─────────────────────
// 1985 is NOT the 1978 issues/weights (only the wage CONCEPT carries across). It is a
// continuous wage + five discrete option issues with their own fixed scoring (score1985.ts).
// Wired via roundOutcomeSchemas below so the round-aware submit flow validates the 1985 lead
// outcome against this. Option KEYS mirror BAXTER_1985_POINTS/UNION_1985_POINTS in score1985.ts
// and OPTION_LABELS in frontend/src/gameConfig.ts.
export const baxter1985Schema: OutcomeSchema = [
  { key: 'wage85',       type: 'decimal', min: 0, max: 100, step: 0.01 },
  { key: 'incentive85',  type: 'enum', options: ['none', 'above_quota', 'above_penalties'] },
  { key: 'work_rules85', type: 'enum', options: ['mgmt_control', 'jointly_determined'] },
  { key: 'hiring85',     type: 'enum', options: ['layoff_100', 'layoff_50', 'no_priority'] },
  { key: 'notices85',    type: 'enum', options: ['yes', 'no'] },
  { key: 'seniority85',  type: 'enum', options: ['all', 'some', 'none'] },
]

// ── Score sense ───────────────────────────────────────────────────────────────

/** Both roles are value-sense (higher score = better). */
export const baxterScoreSense: Record<string, 'value' | 'cost'> = {
  baxter: 'value',
  union:  'value',
}

// ── 1978 scoring scheme (class-level; stored in config/main.scheme1978) ────────
// Instructor enters ONE per-option score per issue, per role. No weights are
// entered, checked, or used. Blank by default (no pre-seeded values).
type OptionScores = Record<string, Record<string, number>>          // issueId → optionId → score
export type Scheme1978Role = { optionScores?: OptionScores }
export type Scheme1978 = { baxter?: Scheme1978Role; union?: Scheme1978Role }

/** The six 1978 issue ids — exactly the enum fields of the outcome schema (never invent new ids). */
export const ISSUE_KEYS_1978: string[] = baxterSchema
  .filter(f => f.type === 'enum')
  .map(f => f.key)

// ── 1978 scorer (GAME-SPECIFIC) ───────────────────────────────────────────────
// 1978 score (per role) = Σ over the six agreed issues of the instructor-entered
// per-option score for the option the group agreed on. Weights are NOT used.
// Blank / missing option scores count as 0. Walk-away (null outcome) = 0 — no-deal
// min+5, ratification, 1983/1985, and cross-group passes are LATER SLICES.
export function computeScoreBreakdown(
  roleKey: string,
  outcome: Outcome | null,
  configData?: Record<string, unknown>,
): { value_or_cost: number; raw_score: number } {
  if (outcome === null) return { value_or_cost: 0, raw_score: 0 }

  const scheme = configData?.['scheme1978'] as Scheme1978 | undefined
  const optionScores = scheme?.[roleKey as 'baxter' | 'union']?.optionScores ?? {}

  let sum = 0
  for (const issue of ISSUE_KEYS_1978) {
    const agreedOption = outcome[issue] as string | undefined
    if (agreedOption == null) continue
    const s = optionScores[issue]?.[agreedOption]
    if (typeof s === 'number' && Number.isFinite(s)) sum += s
  }
  return { value_or_cost: sum, raw_score: sum }
}

export function computeRawScore(roleKey: string, outcome: Outcome | null, configData?: Record<string, unknown>): number {
  return computeScoreBreakdown(roleKey, outcome, configData).raw_score
}

// ── GameDefinition (full contract for game-server factories) ─────────────────

export const baxterGameDef: GameDefinition = {
  game_id: 'baxter',
  roles:   baxterConfig,
  scoreSense: baxterScoreSense,
  composition: { baxter: 2, union: 2 },
  // Multi-round (staging skeleton): three sequential negotiations. Round 1 (1978)
  // is the existing single-outcome round with the Slice-1 scorer. Rounds 1983/1985
  // are advanceable phases with no content/scoring yet (later slices).
  rounds: ['1978', '1983', '1985'],
  outcomeSchema: baxterSchema,
  // 1983 negotiates a wage only; 1985 has its own six-issue contract; 1978 uses baxterSchema.
  roundOutcomeSchemas: { '1983': baxter1983Schema, '1985': baxter1985Schema },
  // Ratification mechanic per round (Bug E). 1978 and 1985 are ULTIMATUMS: the receiver gets one
  // accept/reject; reject → terminal no-deal (routes to the existing no-deal handling). 1985 REUSES
  // the exact general mechanic Bug E built — DECLARATION ONLY, no new mechanic code (Slice 4).
  // 1983 stays on the standard accept/redo loop (omitted → 'unanimous').
  roundOutcomeMechanics: { '1978': 'ultimatum', '1985': 'ultimatum' },
  computeRawScore,
  computeScoreBreakdown,
  reservations: { baxter: 0, union: 0 },  // unused by the 1978 sum scorer (no surplus/reservation model)
  corsOrigins: ['https://baxter.mygames.live'],
  classroom: { callbackSecretId: 'CLASSROOM_CALLBACK_SECRET' },
  // perRoleCap omitted → factory uses eligible.length (no cap, place every extra).
  // deadlockThreshold omitted → factory defaults to 5.

  // Settings page config fields. Role-name + phase-aware role-info defaults.
  // Round-scoped keys resolve to the bundled /role-info/ documents; each is
  // instructor-swappable via the Settings page (Elena's config-keys decision).
  configFields: [
    { key: 'baxter_role_name',          kind: 'string', default: 'Baxter Management' },
    { key: 'union_role_name',           kind: 'string', default: 'Local 190'         },
    // 1978
    { key: 'baxter_1978_case_url',      kind: 'url', default: '/role-info/1978-baxter-case.pdf'       },
    { key: 'baxter_1978_worksheet_url', kind: 'url', default: '/role-info/1978-baxter-worksheet.xlsx' },
    { key: 'union_1978_case_url',       kind: 'url', default: '/role-info/1978-union-case.pdf'        },
    { key: 'union_1978_worksheet_url',  kind: 'url', default: '/role-info/1978-union-worksheet.xlsx'  },
    // 1983
    { key: 'baxter_1983_brief_url',     kind: 'url', default: '/role-info/1983-baxter-brief.pdf'      },
    { key: 'union_1983_brief_url',      kind: 'url', default: '/role-info/1983-union-brief.pdf'       },
    // 1985
    { key: 'baxter_1985_case_url',       kind: 'url', default: '/role-info/1985-baxter-case.pdf'        },
    { key: 'baxter_1985_scoresheet_url', kind: 'url', default: '/role-info/1985-baxter-scoresheet.xlsx' },
    { key: 'union_1985_case_url',        kind: 'url', default: '/role-info/1985-union-case.pdf'         },
    { key: 'union_1985_scoresheet_url',  kind: 'url', default: '/role-info/1985-union-scoresheet.xlsx'  },
  ],

  // Flat fallback (round-unaware). Baxter declares every round in roleInfoLinksByRound
  // below, so this is only reached if current_round somehow points at an undeclared
  // round; it mirrors round 1 (1978) as a safe default.
  roleInfoLinks: [
    { roleKey: 'baxter', links: [
      { key: 'baxter_1978_case_url',      label: 'Role packet'       },
      { key: 'baxter_1978_worksheet_url', label: 'Scoring worksheet' },
    ]},
    { roleKey: 'union', links: [
      { key: 'union_1978_case_url',      label: 'Role packet'       },
      { key: 'union_1978_worksheet_url', label: 'Scoring worksheet' },
    ]},
  ],

  // Phase-aware role-info (Option-1 derive). getInfoUrls serves the caller's role's links
  // for the instance's current round; each role NEVER sees the other role's documents.
  roleInfoLinksByRound: {
    '1978': [
      { roleKey: 'baxter', links: [
        { key: 'baxter_1978_case_url',      label: 'Role packet'       },
        { key: 'baxter_1978_worksheet_url', label: 'Scoring worksheet' },
      ]},
      { roleKey: 'union', links: [
        { key: 'union_1978_case_url',      label: 'Role packet'       },
        { key: 'union_1978_worksheet_url', label: 'Scoring worksheet' },
      ]},
    ],
    '1983': [
      { roleKey: 'baxter', links: [
        { key: 'baxter_1983_brief_url', label: '1983 round brief' },
      ]},
      { roleKey: 'union', links: [
        { key: 'union_1983_brief_url', label: '1983 round brief' },
      ]},
    ],
    '1985': [
      { roleKey: 'baxter', links: [
        { key: 'baxter_1985_case_url',       label: 'Role packet'   },
        { key: 'baxter_1985_scoresheet_url', label: 'Scoring sheet' },
      ]},
      { roleKey: 'union', links: [
        { key: 'union_1985_case_url',       label: 'Role packet'   },
        { key: 'union_1985_scoresheet_url', label: 'Scoring sheet' },
      ]},
    ],
  },

  // KC content (Slice 7). The mandatory role-identification gate (one per role, system +
  // ungraded, grading:'assigned_role' — exactly one per role, enforced by validateKCGate) plus:
  //   • FOUR graded static MC (role_target:'all' → SHARED across both roles), correct B/B/C/B,
  //     denominator 4 (negotiation-on-the-merits: interests, ongoing relationship, BATNA, one-text).
  //   • ONE ungraded free-text reflection (category:'preparation') — ranks the student's issues.
  //   • THREE ungraded 1–7 Likert items (category:'debrief', type:'likert') — the "Looking ahead to
  //     1985" between-rounds set, served by getDebriefQuestions and rendered AFTER 1978 / before 1983
  //     by the LookingAhead phase (excluded from the graded denominator and from the terminal Results).
  prepDefaults: [
    {
      field: 'kc_gate_baxter', type: 'mc', system: true,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'assigned_role', role_target: 'baxter',
      prompt: 'What is your role in this negotiation?',
      placeholder: '', order: 0, hidden: false, deletable: false,
      options: [
        { value: 'baxter', label: 'Baxter Management — the Adam Baxter Company management team' },
        { value: 'union',  label: 'Local 190 — the union bargaining committee' },
      ],
      explanation: 'You are Baxter Management, negotiating the contract on behalf of the company.',
    },
    {
      field: 'kc_gate_union', type: 'mc', system: true,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'assigned_role', role_target: 'union',
      prompt: 'What is your role in this negotiation?',
      placeholder: '', order: 0, hidden: false, deletable: false,
      options: [
        { value: 'baxter', label: 'Baxter Management — the Adam Baxter Company management team' },
        { value: 'union',  label: 'Local 190 — the union bargaining committee' },
      ],
      explanation: 'You are Local 190, negotiating the contract on behalf of the union membership.',
    },

    // ── FOUR graded static MC (SHARED — role_target:'all'; correct B/B/C/B; denominator 4) ──
    {
      field: 'kc_q1_merits', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'B', role_target: 'all',
      prompt: 'At the bargaining table, the other side opens by stating a firm demand and criticizing your team’s proposal rather than discussing underlying concerns. Which response best reflects a principled approach to redirecting the conversation toward the merits?',
      placeholder: '', order: 10, hidden: false, deletable: false,
      options: [
        { value: 'A', label: 'Restate your own position more forcefully so they know you won’t be moved' },
        { value: 'B', label: 'Ask what interests or concerns their demand is meant to address, and treat it as one option to be examined rather than accepted or rejected' },
        { value: 'C', label: 'Counter their criticism by pointing out the weaknesses in their position' },
        { value: 'D', label: 'Break off talks until they agree to bargain more reasonably' },
      ],
      explanation: 'A principled approach redirects a demand or attack into a question about the interests behind it, treating each position as one option to be examined against the merits rather than something to accept or reject outright.',
    },
    {
      field: 'kc_q2_relationship', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'B', role_target: 'all',
      prompt: 'Because Baxter and Local 190 operate under a permanent working agreement and expect to keep dealing with each other for years, a negotiator is weighing how hard to push for maximum short-term advantage. What does this ongoing relationship most directly imply for tactics at the table?',
      placeholder: '', order: 11, hidden: false, deletable: false,
      options: [
        { value: 'A', label: 'The long relationship is irrelevant once a specific contract is being negotiated' },
        { value: 'B', label: 'Tactics that win concessions now but leave the other side feeling cheated can damage a relationship both sides will depend on in future rounds' },
        { value: 'C', label: 'Whichever side has more leverage this round should extract as much as possible while it can' },
        { value: 'D', label: 'Trust between the parties removes any need to rely on objective standards' },
      ],
      explanation: 'When the parties expect to keep dealing with each other, short-term wins bought by leaving the other side feeling cheated can damage a relationship both sides will depend on in later rounds.',
    },
    {
      field: 'kc_q3_batna', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'C', role_target: 'all',
      prompt: 'Suppose one side believes it holds the stronger position going into these talks. According to the principle of negotiating on the merits, how should the weaker party most effectively increase its influence over the outcome?',
      placeholder: '', order: 12, hidden: false, deletable: false,
      options: [
        { value: 'A', label: 'Match the stronger party’s shows of power with threats of its own' },
        { value: 'B', label: 'Concede early to preserve goodwill for later rounds' },
        { value: 'C', label: 'Improve and rely on its best alternative to a negotiated agreement, and press to have principles and objective standards govern the discussion' },
        { value: 'D', label: 'Insist that the stronger party make the first offer on every issue' },
      ],
      explanation: 'The weaker party gains influence by improving and relying on its best alternative to a negotiated agreement and by pressing for principles and objective standards to govern the discussion, rather than trading threats.',
    },
    {
      field: 'kc_q4_onetext', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'B', role_target: 'all',
      prompt: 'Imagine the two teams have dug into opposing plans and communication has soured, with each concession only inviting demands for more. Which method is specifically intended to break this dynamic by having a neutral draft a single proposal, invite criticism from both sides, and revise it repeatedly before asking for a yes-or-no decision?',
      placeholder: '', order: 13, hidden: false, deletable: false,
      options: [
        { value: 'A', label: 'Positional bargaining' },
        { value: 'B', label: 'The one-text procedure' },
        { value: 'C', label: 'Pattern bargaining' },
        { value: 'D', label: 'A guaranteed-annual-wage clause' },
      ],
      explanation: 'The one-text procedure has a neutral draft a single proposal, invite criticism from both sides, and revise it repeatedly before asking for a single yes-or-no decision — breaking the escalation of dug-in positional bargaining.',
    },

    // ── ONE ungraded free-text reflection (category:'preparation', SHARED) ──
    {
      field: 'prep_issue_ranking', type: 'text', system: false,
      category: 'preparation', format: 'text', role_target: 'all',
      prompt: 'For the Baxter negotiation, make a list of the issues your role faces. Put them in rank order, with 1 being the most important.',
      placeholder: 'e.g. 1. Wages  2. Job security  3. …', order: 20, hidden: false, deletable: true,
    },

    // ── THREE ungraded 1–7 Likert items (category:'debrief', type:'likert', SHARED) ──
    // "Looking ahead to 1985" — served by getDebriefQuestions, rendered AFTER 1978 / before 1983.
    {
      field: 'debrief_relationship_1978', type: 'likert', system: false,
      category: 'debrief', format: 'likert', role_target: 'all',
      prompt: 'How would you characterize the working relationship between the two sides at the end of the 1978 negotiation?',
      placeholder: '', order: 30, hidden: false, deletable: true,
      options: [
        { value: '1', label: 'Very poor' },
        { value: '2', label: '' }, { value: '3', label: '' }, { value: '4', label: '' },
        { value: '5', label: '' }, { value: '6', label: '' },
        { value: '7', label: 'Very good' },
      ],
    },
    {
      field: 'debrief_trust_future', type: 'likert', system: false,
      category: 'debrief', format: 'likert', role_target: 'all',
      prompt: 'How much do you trust the other side in future negotiations?',
      placeholder: '', order: 31, hidden: false, deletable: true,
      options: [
        { value: '1', label: 'Not at all' },
        { value: '2', label: '' }, { value: '3', label: '' }, { value: '4', label: '' },
        { value: '5', label: '' }, { value: '6', label: '' },
        { value: '7', label: 'Completely' },
      ],
    },
    {
      field: 'debrief_1985_difficulty', type: 'likert', system: false,
      category: 'debrief', format: 'likert', role_target: 'all',
      prompt: 'How difficult do you expect the 1985 negotiation to be compared with 1978?',
      placeholder: '', order: 32, hidden: false, deletable: true,
      options: [
        { value: '1', label: 'Much easier' },
        { value: '2', label: '' }, { value: '3', label: '' }, { value: '4', label: '' },
        { value: '5', label: '' }, { value: '6', label: '' },
        { value: '7', label: 'Much harder' },
      ],
    },
  ],

  // BU-phase: content fields not used by backend factories; populated in BU slices.
  content: {
    infoPDFs:      {} as Record<string, { private: string; public?: string }>,
    kcQuestions:   [],
    prepQuestions: [],
    scenarioText:  {},
  },
}
