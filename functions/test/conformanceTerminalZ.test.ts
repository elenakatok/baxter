import { describe, it, expect } from 'vitest'
import { terminalZByRole, type FinalRaw } from '../src/terminalScore'

/**
 * FROZEN terminal z-score conformance gate (spec §6 — the final scoring step).
 *
 * A hand-computed two-role fixture proving EVERY piece-1/piece-2 rule:
 *   • Two pools — Baxters normalized within the Baxter pool, Unions within the Union pool.
 *   • SAMPLE SD (÷ N−1), NOT population (÷ N) — proven by contrasting the two.
 *   • Degenerate pool (n=1) → z = 0.
 *   • TRUE NO-SHOW (raw_score null) → EXCLUDED from the pool (absent from the returned map; the
 *     pool mean/SD ignore it).
 *   • WALK-AWAY (a real raw_score, no deal) → INCLUDED in the pool (its presence sets n and mean).
 *
 * Baxter pool = [80, 90(walk-away), 100]  (n=3):
 *   mean = 90; sample var = (100+0+100)/(3−1) = 100 → sample SD = 10 → z = [−1, 0, +1].
 *   population var = 200/3 = 66.67 → pop SD = 8.165 → z = [−1.2247, 0, +1.2247].
 *   The ±1 (sample) vs ±1.2247 (population) gap is the ÷N−1-not-÷N proof. And bax-lo = −1 (not the
 *   −0.707 an n=2 pool of [80,100] would give) proves the walk-away (90) IS counted in the pool.
 * Union pool = [40]  (n=1) → degenerate guard → z = 0.
 * bax-noshow (raw null) → excluded → NOT in the map.
 */

const ROLES = ['baxter', 'union']
const SENSE = { baxter: 'value', union: 'value' } as const

const FIXTURE: FinalRaw[] = [
  { participant_id: 'bax-lo',     role: 'baxter', raw_score: 80 },   // ratified deal (low)
  { participant_id: 'bax-walk',   role: 'baxter', raw_score: 90 },   // WALK-AWAY — real no-deal score, in pool
  { participant_id: 'bax-hi',     role: 'baxter', raw_score: 100 },  // ratified deal (high)
  { participant_id: 'uni-solo',   role: 'union',  raw_score: 40 },   // n=1 pool → degenerate
  { participant_id: 'bax-noshow', role: 'baxter', raw_score: null }, // TRUE NO-SHOW → excluded
]

describe('Baxter terminal z-score (FROZEN — spec §6, sample SD ÷N−1)', () => {
  const z = terminalZByRole(FIXTURE, ROLES, SENSE)

  it('two separate pools — Baxters within Baxter pool, Unions within Union pool', () => {
    // The lone Union (40) is normalized only against Unions (→ 0), never dragged into the Baxter pool.
    expect(z.get('uni-solo')).toBe(0)
    // Baxter z's are symmetric about the Baxter mean (90), untouched by the Union pool.
    expect(z.get('bax-lo')! + z.get('bax-hi')!).toBeCloseTo(0, 12)
  })

  it('SAMPLE SD (÷N−1): Baxter [80,90,100] → z = [−1, 0, +1]', () => {
    expect(z.get('bax-lo')).toBeCloseTo(-1, 12)
    expect(z.get('bax-walk')).toBeCloseTo(0, 12)
    expect(z.get('bax-hi')).toBeCloseTo(1, 12)
  })

  it('is ÷N−1, NOT ÷N — the population-SD z would be ±1.2247, which we are NOT', () => {
    const popZHi = (100 - 90) / Math.sqrt(200 / 3) // ≈ 1.2247 (÷N)
    expect(popZHi).toBeCloseTo(1.22474, 4)
    expect(z.get('bax-hi')).toBeCloseTo(1, 12)          // sample-SD value
    expect(Math.abs((z.get('bax-hi') as number) - popZHi)).toBeGreaterThan(0.2) // provably different
  })

  it('DEGENERATE pool (n=1) → z = 0', () => {
    expect(z.get('uni-solo')).toBe(0)
  })

  it('TRUE NO-SHOW (raw null) → EXCLUDED from the pool (not in the map)', () => {
    expect(z.has('bax-noshow')).toBe(false)
    // And its exclusion is what makes the Baxter pool n=3 with mean 90 — proven by the ±1 above.
  })

  it('WALK-AWAY (real raw) → INCLUDED: pool is n=3, so bax-lo = −1 (not the −0.707 of an n=2 pool)', () => {
    expect(z.get('bax-walk')).toBeCloseTo(0, 12)        // present in the map = in the pool
    expect(z.get('bax-lo')).toBeCloseTo(-1, 12)         // n=3 (walk-away counted), not n=2's −0.707
    // Sanity: had the walk-away been dropped, [80,100] sample SD = √200 ≈ 14.14 → bax-lo ≈ −0.707.
    const n2 = (80 - 90) / Math.sqrt(((80 - 90) ** 2 + (100 - 90) ** 2) / 1)
    expect(n2).toBeCloseTo(-0.70711, 4)
    expect(z.get('bax-lo')).not.toBeCloseTo(n2, 3)
  })

  it('empty / all-null pool → empty map (no NaN)', () => {
    expect(terminalZByRole([], ROLES, SENSE).size).toBe(0)
    expect(terminalZByRole([{ participant_id: 'x', role: 'baxter', raw_score: null }], ROLES, SENSE).size).toBe(0)
  })
})
