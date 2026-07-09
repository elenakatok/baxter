/**
 * Baxter TERMINAL z-score (GAME-SPECIFIC, pure) — spec §6, the final scoring step.
 *
 * After 1985 resolves, each student's FINAL RAW (adjusted-1978 + 1985) is normalized ONCE,
 * WITHIN role, into a z-score. Two separate pools: all Baxters together, all Unions together.
 * Uses SAMPLE standard deviation (÷ N−1) — matching Elena's Excel STDEV, NOT population (÷ N) —
 * via the engine's zScoresSampleSD (which also guards the degenerate pool: n≤1 or zero-spread → 0).
 *
 * Pool membership (spec §6 + Elena's standing rule):
 *   • WALK-AWAY (reached the table, no deal) → carries a real raw_score → STAYS IN the pool.
 *   • TRUE NO-SHOW / late → raw_score is null → EXCLUDED from the pool (mean/SD ignore it; its
 *     normalized_score of −2 / null is assigned elsewhere, not here).
 *
 * This module does NOT auto-assign an absent student's present-partner z-score — per Elena's
 * standing rule that inheritance is applied MANUALLY by the instructor, not by the platform.
 */

import { zScoresSampleSD } from '@mygames/game-engine'

/** A participant's final raw for terminal normalization. raw_score null → no-show/late (excluded). */
export type FinalRaw = { participant_id: string; role: string; raw_score: number | null }

/**
 * Terminal z-scores keyed by participant_id, computed WITHIN each role over the pool of
 * non-null final raws (sample SD, ÷ N−1). Participants with a null raw_score are excluded and
 * do NOT appear in the returned map. scoreSense negates 'cost' roles into the z-input so that
 * "higher z = better" holds for every role (both Baxter roles are 'value').
 */
export function terminalZByRole(
  finals: FinalRaw[],
  roleKeys: string[],
  scoreSense: Record<string, 'value' | 'cost'>,
): Map<string, number> {
  const zByPid = new Map<string, number>()
  for (const roleKey of roleKeys) {
    const pool = finals.filter(f => f.role === roleKey && f.raw_score != null)
    const sense = scoreSense[roleKey] ?? 'value'
    const signed = pool.map(f => sense === 'cost' ? -(f.raw_score as number) : (f.raw_score as number))
    const zs = zScoresSampleSD(signed)
    pool.forEach((f, i) => zByPid.set(f.participant_id, zs[i]))
  }
  return zByPid
}
