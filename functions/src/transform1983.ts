/**
 * Baxter 1983 score-transform (GAME-SPECIFIC, pure).
 *
 * 1983 produces NO independent score. It produces a WAGE that ADJUSTS each side's 1978
 * score (spec §4). This module is the pure, hand-verifiable core: no Firestore, no engine
 * dependency, so the frozen 1983 correctness gate (test/conformance1983.test.ts) exercises
 * it directly. The re-runnable scorer (scoreAndRecord) wires these functions over the live
 * per-group outcomes; the class-average 1983 wage is computed there (NOT gate-frozen) so a
 * late-arriving arbitration wage never leaves a stale average behind (spec §4 / Elena-locked).
 *
 *   Union  adjustment % = ((w83 − w78)      / w78)      × 100   (vs the group's OWN 1978 wage)
 *   Baxter adjustment % = ((w83 − w83_avg)  / w83_avg)  × 100   (vs the CLASS-AVG 1983 wage)
 *
 * Take |adjustment %| rounded to 1 decimal, then apply BY DIRECTION:
 *   1983 wage LOWER than the reference → Baxter +, Union −
 *   1983 wage HIGHER than the reference → Baxter −, Union +
 *   Adjusted-1978 = 1978 score ± adjustment.
 */

/** 1978 `wages` enum option → the hourly dollar figure shown in its UI label (gameConfig). */
export const WAGE_DOLLARS: Readonly<Record<string, number>> = {
  above_top3:    12.69, // Above top-3 avg
  current:       10.69, // Current (status quo)
  increase_top3: 11.69, // Increase to top-3 avg
}

/** Arbitration wage when Baxter's rules win (avg of the three highest-paid industry leaders). */
export const ARBITRATION_BAXTER_WAGE = 8.67

/** Field key holding the continuous 1983 wage inside the round-2 outcome object. */
export const WAGE83_FIELD = 'wage83'

/** Round to 1 decimal (the adjustment-magnitude precision). */
export function round1(x: number): number {
  return Math.round(x * 10) / 10
}

/** The group's 1978 negotiated wage (dollars) from its round-1 outcome. null → unknown. */
export function wage78FromOutcome(outcome: Record<string, unknown> | null | undefined): number | null {
  const opt = outcome?.['wages']
  if (typeof opt !== 'string') return null
  const d = WAGE_DOLLARS[opt]
  return typeof d === 'number' ? d : null
}

/** The group's 1983 wage (dollars) from its round-2 outcome ({ wage83 }). null → no agreed wage. */
export function wage83FromOutcome(outcome: Record<string, unknown> | null | undefined): number | null {
  const w = outcome?.[WAGE83_FIELD]
  return typeof w === 'number' && Number.isFinite(w) ? w : null
}

/** Class-average 1983 wage across every group that HAS a wage (nulls excluded). Empty → null. */
export function classAvg1983(wages: Array<number | null>): number | null {
  const present = wages.filter((w): w is number => typeof w === 'number' && Number.isFinite(w))
  if (present.length === 0) return null
  return present.reduce((a, b) => a + b, 0) / present.length
}

export type BaxterRole = 'baxter' | 'union'

/**
 * Signed adjustment (percentage-points) applied to a role's 1978 score.
 *   Union reference  = the group's own 1978 wage (w78).
 *   Baxter reference = the class-average 1983 wage (w83Avg).
 * magnitude = |((w83 − ref) / ref) × 100| rounded to 1 decimal.
 * Direction: w83 LOWER than ref → Baxter +, Union − ; HIGHER → Baxter −, Union +.
 * A non-positive / missing reference → 0 (no adjustment).
 */
export function adjustmentPct(role: BaxterRole, w83: number, w78: number, w83Avg: number): number {
  const ref = role === 'union' ? w78 : w83Avg
  if (!(typeof ref === 'number' && ref > 0) || !Number.isFinite(w83)) return 0
  const mag = round1(Math.abs(((w83 - ref) / ref) * 100))
  if (mag === 0) return 0
  const higher = w83 > ref
  if (role === 'union') return higher ? mag : -mag
  return higher ? -mag : mag // baxter
}

/** Adjusted-1978 score = 1978 base ± adjustment (full precision; the 1-dp lives in the adj). */
export function adjustedScore(base1978: number, adjPct: number): number {
  return base1978 + adjPct
}
