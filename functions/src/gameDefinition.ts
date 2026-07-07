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
  computeRawScore,
  computeScoreBreakdown,
  reservations: { baxter: 0, union: 0 },  // unused by the 1978 sum scorer (no surplus/reservation model)
  corsOrigins: ['https://baxter.mygames.live'],
  classroom: { callbackSecretId: 'CLASSROOM_CALLBACK_SECRET' },
  // perRoleCap omitted → factory uses eligible.length (no cap, place every extra).
  // deadlockThreshold omitted → factory defaults to 5.

  // Settings page config fields. Role-name + role-info defaults.
  // Role PDFs/worksheets are a later slice (Gary's content); paths are placeholders.
  configFields: [
    { key: 'baxter_role_name',     kind: 'string', default: 'Baxter Management' },
    { key: 'union_role_name',      kind: 'string', default: 'Local 190'         },
    { key: 'baxter_sheet_url',     kind: 'url',    default: '/role-info/baxter.pdf'           },
    { key: 'baxter_worksheet_url', kind: 'url',    default: '/role-info/baxterWorksheet.xlsx' },
    { key: 'union_sheet_url',      kind: 'url',    default: '/role-info/union.pdf'            },
    { key: 'union_worksheet_url',  kind: 'url',    default: '/role-info/unionWorksheet.xlsx'  },
  ],

  // Info page links — keys match configFields above.
  roleInfoLinks: [
    { roleKey: 'baxter', links: [
      { key: 'baxter_sheet_url',     label: 'Role sheet' },
      { key: 'baxter_worksheet_url', label: 'Worksheet'  },
    ]},
    { roleKey: 'union', links: [
      { key: 'union_sheet_url',     label: 'Role sheet' },
      { key: 'union_worksheet_url', label: 'Worksheet'  },
    ]},
  ],

  // KC content is OPEN (spec §8). Ship ONLY the mandatory role-identification gate
  // (one per role, system + ungraded) so validateKCGate passes. Graded KC + prep
  // reflection questions are a later slice.
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
  ],

  // BU-phase: content fields not used by backend factories; populated in BU slices.
  content: {
    infoPDFs:      {} as Record<string, { private: string; public?: string }>,
    kcQuestions:   [],
    prepQuestions: [],
    scenarioText:  {},
  },
}
