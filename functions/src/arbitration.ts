/**
 * Baxter 1983 arbitration draw (GAME-SPECIFIC, pure).
 *
 * A 1983 group that ends with NO agreed wage goes to arbitration (spec §4). The instructor
 * works the flagged queue one group at a time; the draw FIRES AT BUTTON-CLICK (not pre-decided):
 *   p = 2/3 → Baxter's rules win → wage = $8.67
 *   1/3     → Union's rules win  → wage = the group's own 1978 negotiated wage (unchanged)
 *
 * The RNG is SEEDABLE so the play-through harness (and any sim) resolves deterministically —
 * the draw is a pure function of a 32-bit seed. Production seeds from crypto at click time;
 * the emulator harness passes a fixed seed. This module has NO Firestore or presentation
 * dependency, so the later cosmetic "wheel" slice wraps `resolveArbitration` unchanged — the
 * wheel is a pure presentation layer over this exact result.
 */
import { ARBITRATION_BAXTER_WAGE } from './transform1983'

/** Probability the draw lands on Baxter's rules. */
export const ARBITRATION_P_BAXTER = 2 / 3

/** Deterministic 32-bit PRNG (mulberry32). Same seed → same first draw, forever. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type ArbitrationSide = 'baxter' | 'union'
export type ArbitrationResult = { side: ArbitrationSide; wage: number; u: number }

/**
 * Resolve one group's arbitration from a seed and its 1978 wage.
 * u ∈ [0,1): u < 2/3 → Baxter rules → $8.67 ; else → Union rules → w78.
 */
export function resolveArbitration(seed: number, w78: number): ArbitrationResult {
  const u = mulberry32(seed)()
  return u < ARBITRATION_P_BAXTER
    ? { side: 'baxter', wage: ARBITRATION_BAXTER_WAGE, u }
    : { side: 'union', wage: w78, u }
}
