import { type RoleConfig } from '@mygames/game-engine/roles'
import { type OutcomeField, type OutcomeSchema } from '@mygames/game-engine/outcome'

export type { RoleConfig, OutcomeField, OutcomeSchema }

export const baxterConfig: RoleConfig = {
  roles: [
    { key: 'baxter', label: 'Baxter Management', short: 'B' },
    { key: 'union',  label: 'Local 190',         short: 'U' },
  ],
}

// ── 1978 contract — six agreed issues (all enum) + optional Notes ──────────────
// Mirrors functions/src/gameDefinition.ts. Stored values are the option KEYS below;
// human-readable labels live in OPTION_LABELS and are shown in the UI only.
export const baxterSchema: OutcomeSchema = [
  { key: 'wages',           type: 'enum', options: ['above_top3', 'current', 'increase_top3'] },
  { key: 'plant_operation', type: 'enum', options: ['higher_autonomy', 'higher_mgmt', 'maintain_autonomy', 'maintain_mgmt'] },
  { key: 'escalator',       type: 'enum', options: ['eliminate', 'maintain', 'reduce'] },
  { key: 'incentive',       type: 'enum', options: ['eliminate', 'maintain', 'reduce', 'individual'] },
  { key: 'location',        type: 'enum', options: ['deloitte', 'elsewhere'] },
  { key: 'transfer',        type: 'enum', options: ['all', 'most', 'some'] },
  { key: 'notes',           type: 'text' },  // optional free-text; blank = '', excluded from scoring
]

// ── 1983 contract — WAGE ONLY (a single continuous 2-decimal hourly wage) ──────
// Mirrors functions/src/gameDefinition.ts baxter1983Schema. Distinct from the 1978
// six-issue contract; the 1983 round negotiates just this number.
export const baxter1983Schema: OutcomeSchema = [
  { key: 'wage83', type: 'decimal', min: 0, max: 100, step: 0.01 },
]

// The dollar figure each 1978 `wages` option represents (mirrors OPTION_LABELS.wages).
// Used to display a group's 1978 wage in the arbitration queue and (server-side) as the
// Union-branch arbitration wage.
export const WAGE_DOLLARS: Readonly<Record<string, number>> = {
  above_top3:    12.69,
  current:       10.69,
  increase_top3: 11.69,
}

export const FIELD_LABELS: Readonly<Record<string, string>> = {
  wages:           'Wages & Benefits',
  plant_operation: 'Plant Operation',
  escalator:       'Escalator Clause',
  incentive:       'Group Incentive System',
  location:        'Location of New Plant',
  transfer:        'Transfer of Local 190',
  notes:           'Notes',
  wage83:          'New hourly wage ($)',
}

// Human-readable option labels: field key → { stored value → display label }.
// The select shows the label; the KEY is what gets stored/scored.
export const OPTION_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  wages: {
    above_top3:    'Above top-3 avg ($12.69)',
    current:       'Current ($10.69, status quo)',
    increase_top3: 'Increase to top-3 avg ($11.69)',
  },
  plant_operation: {
    higher_autonomy:   'Higher prod + labor autonomy',
    higher_mgmt:       'Higher prod + mgmt control',
    maintain_autonomy: 'Maintain prod + labor autonomy',
    maintain_mgmt:     'Maintain prod + mgmt control',
  },
  escalator: {
    eliminate: 'Eliminate',
    maintain:  'Maintain',
    reduce:    'Reduce',
  },
  incentive: {
    eliminate:  'Eliminate',
    maintain:   'Maintain',
    reduce:     'Reduce',
    individual: 'Individual Incentives',
  },
  location: {
    deloitte:  'Deloitte',
    elsewhere: 'Somewhere else',
  },
  transfer: {
    all:  'All members',
    most: 'Most members',
    some: 'Some members (significant downsizing)',
  },
}

export function labelForOption(fieldKey: string, value: unknown): string {
  const v = value as string
  return OPTION_LABELS[fieldKey]?.[v] ?? v
}

export function formatField(field: OutcomeField, value: unknown): string {
  if (field.type === 'enum')    return labelForOption(field.key, value)
  if (field.type === 'boolean') return (value as boolean) ? 'Yes' : 'No'
  if (field.type === 'integer') return (value as number).toLocaleString('en-US')
  if (field.type === 'decimal') {
    const n = value as number
    return typeof n === 'number' && Number.isFinite(n)
      ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : String(value)
  }
  return String(value)
}
