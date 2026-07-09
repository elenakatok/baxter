/**
 * Baxter 1985 fixed scoring (GAME-SPECIFIC, pure) — spec §5, SCORING FROZEN.
 *
 * 1985 is its OWN six-issue contract (NOT the 1978 issues/weights — only the wage CONCEPT
 * carries across). It produces an independent 0–100 score per role that ADDS to the
 * adjusted-1978 score (final raw = adjusted-1978 + 1985). No Firestore, no engine dependency,
 * so the frozen 1985 correctness gate (test/conformance1985.test.ts) exercises this directly.
 *
 * Score (per role) = wage points + Σ(chosen option points):
 *   Baxter wage = −(25/4.02) × (wage − 12.69)   → 25 at $8.67, 0 at $12.69 (lower wage = more)
 *   Union  wage =  (25/4.02) × (wage −  8.67)   → 25 at $12.69, 0 at $8.67 (higher wage = more)
 * The five discrete issues carry fixed per-option points (tables below). Both roles span 0–100.
 *
 * No-deal (spec §5 + the degenerate-pool guard added this slice):
 *   Union  = 60 (flat, always).
 *   Baxter = average of the 1985 scores of Baxters who reached a deal (cross-group). If ZERO
 *            Baxter groups dealt, the average is undefined → 50 (flat reservation outcome).
 */

export type BaxterRole = 'baxter' | 'union'

/** Field key holding the continuous 1985 wage inside the round-3 outcome object. */
export const WAGE85_FIELD = 'wage85'

/** Wage slope: 25 points span across the $4.02 gap between the two anchor wages. */
export const K_1985 = 25 / 4.02
/** Baxter scores 0 at this wage (top-of-industry) and 25 at the Union anchor. */
export const BAXTER_WAGE_ZERO = 12.69
/** Union scores 0 at this wage (arbitration floor) and 25 at the Baxter anchor. */
export const UNION_WAGE_ZERO = 8.67

/** Union 1985 no-deal score — flat, always (spec §5). */
export const UNION_1985_NO_DEAL = 60
/** Baxter 1985 no-deal when ZERO Baxter groups dealt (degenerate pool → flat reservation). */
export const BAXTER_1985_NO_DEAL_DEGENERATE = 50

// Per-option points, per role: field key → stored option value → points. Mirrors the frontend
// baxter1985Schema option keys. An option absent from a table contributes 0 (defensive).
type PointTable = Readonly<Record<string, Readonly<Record<string, number>>>>

export const BAXTER_1985_POINTS: PointTable = {
  incentive85:  { none: 15, above_quota: 0, above_penalties: 12 },
  work_rules85: { mgmt_control: 20, jointly_determined: 0 },
  hiring85:     { layoff_100: 0, layoff_50: 14, no_priority: 20 },
  notices85:    { yes: 0, no: 10 },
  seniority85:  { all: 0, some: 8, none: 10 },
}

export const UNION_1985_POINTS: PointTable = {
  incentive85:  { none: 0, above_quota: 10, above_penalties: 7 },
  work_rules85: { mgmt_control: 0, jointly_determined: 15 },
  hiring85:     { layoff_100: 20, layoff_50: 10, no_priority: 0 },
  notices85:    { yes: 15, no: 7.5 },
  seniority85:  { all: 15, some: 12, none: 0 },
}

/** Round to 2 decimals — the frozen §5 gate precision (10.51, 89.49, 97.95, 9.55, …). */
export function round2(x: number): number {
  return Math.round(x * 100) / 100
}

/** Wage-only points for a role at a given continuous wage (opposite linear formulas). */
export function wage85Points(role: BaxterRole, wage: number): number {
  return role === 'baxter'
    ? -K_1985 * (wage - BAXTER_WAGE_ZERO)
    :  K_1985 * (wage - UNION_WAGE_ZERO)
}

/**
 * Full 1985 score for a role given an agreed outcome ({ wage85, incentive85, … }).
 * = wage points + Σ(chosen option points), rounded to 2 decimals (the frozen gate precision).
 * A missing/invalid wage contributes 0; an unrecognised option contributes 0.
 */
export function score1985(role: BaxterRole, outcome: Record<string, unknown> | null | undefined): number {
  const table = role === 'baxter' ? BAXTER_1985_POINTS : UNION_1985_POINTS
  const wage = outcome?.[WAGE85_FIELD]
  let sum = (typeof wage === 'number' && Number.isFinite(wage)) ? wage85Points(role, wage) : 0
  for (const field of Object.keys(table)) {
    const opt = outcome?.[field]
    const pts = typeof opt === 'string' ? table[field][opt] : undefined
    if (typeof pts === 'number' && Number.isFinite(pts)) sum += pts
  }
  return round2(sum)
}

/**
 * Baxter 1985 no-deal score = average of the dealing Baxters' 1985 scores; if NONE dealt
 * (empty pool → degenerate), the flat reservation outcome of 50. (Union no-deal is the flat
 * UNION_1985_NO_DEAL and does not go through here.)
 */
export function baxterNoDeal1985(dealerBaxterScores: number[]): number {
  if (dealerBaxterScores.length === 0) return BAXTER_1985_NO_DEAL_DEGENERATE
  return dealerBaxterScores.reduce((a, b) => a + b, 0) / dealerBaxterScores.length
}
