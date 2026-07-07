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

// ── Scoring (PLACEHOLDER) ─────────────────────────────────────────────────────
//
// BAXTER-PLACEHOLDER-SCORING
// Real 1978 scoring — instructor-entered per-issue weights (sum to 100 per role)
// and per-option scores, summed over the six agreed issues — is a LATER SLICE
// (see Baxter_Game_Specification_v1.md §3). Until then this returns a constant so
// the finalize / score-and-record / gradebook-push path can be exercised
// end-to-end. Do NOT treat these numbers as meaningful.
//
export function computeScoreBreakdown(
  _roleKey: string,
  _outcome: Outcome | null,
  _configData?: Record<string, unknown>,
): { value_or_cost: number; raw_score: number } {
  // BAXTER-PLACEHOLDER-SCORING — constant zero for every role/outcome, deal or walk-away.
  return { value_or_cost: 0, raw_score: 0 }
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
  outcomeSchema: baxterSchema,
  computeRawScore,
  computeScoreBreakdown,
  reservations: { baxter: 0, union: 0 },  // BAXTER-PLACEHOLDER-SCORING (no reservation model yet)
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
