import { describe, it, expect } from 'vitest'
import {
  WAGE_DOLLARS,
  ARBITRATION_BAXTER_WAGE,
  wage78FromOutcome,
  wage83FromOutcome,
  classAvg1983,
  adjustmentPct,
  adjustedScore,
} from '../src/transform1983'
import { resolveArbitration, ARBITRATION_P_BAXTER } from '../src/arbitration'

/**
 * FROZEN 1983 transform correctness gate (the Vivo/Adirondacks discipline).
 *
 * A hand-computed THREE-GROUP fixture with expected class-average 1983 wage, both-role
 * adjustment %, and adjusted-1978 — all verified by hand and reproduced by the engine
 * BEFORE anything (arbitration wheel, reports) builds on top of the transform. Group C's
 * 1983 wage is the Baxter-branch arbitration wage ($8.67), so the fixture also pins the
 * arbitration → transform seam. This must pass for Slice 3 to be considered done.
 *
 *   w83_avg = (9.00 + 11.00 + 8.67) / 3 = 9.55666…
 *
 *   Group A  base B85/U62  w78=11.69 (increase_top3)  w83=9.00 (agreed)
 *            Union  = ((9.00−11.69)/11.69)×100 = −23.0  → U 39.0   (lower → Union −)
 *            Baxter = ((9.00−9.5567)/9.5567)×100 = −5.8 → B +5.8 → 90.8 (lower → Baxter +)
 *   Group B  base B80/U55  w78=10.69 (current)         w83=11.00 (agreed)
 *            Union  = ((11.00−10.69)/10.69)×100 = +2.9 → U 57.9   (higher → Union +)
 *            Baxter = ((11.00−9.5567)/9.5567)×100 = +15.1 → B −15.1 → 64.9 (higher → Baxter −)
 *   Group C  base B70/U70  w78=12.69 (above_top3)      w83=8.67 (ARBITRATION → Baxter rules)
 *            Union  = ((8.67−12.69)/12.69)×100 = −31.7 → U 38.3   (lower → Union −)
 *            Baxter = ((8.67−9.5567)/9.5567)×100 = −9.3 → B +9.3 → 79.3 (lower → Baxter +)
 */

type Case = {
  label: string
  base: { baxter: number; union: number }
  wages1978: string // round-1 `wages` enum key
  w83: number
  expected: {
    baxterAdj: number; unionAdj: number
    adjBaxter: number; adjUnion: number
  }
}

const W83_AVG = (9.0 + 11.0 + 8.67) / 3

const VECTOR_1983: Case[] = [
  {
    label: 'Group A — agreed low ($9.00), 1978 wage increase_top3',
    base: { baxter: 85, union: 62 }, wages1978: 'increase_top3', w83: 9.0,
    expected: { baxterAdj: 5.8, unionAdj: -23.0, adjBaxter: 90.8, adjUnion: 39.0 },
  },
  {
    label: 'Group B — agreed high ($11.00), 1978 wage current',
    base: { baxter: 80, union: 55 }, wages1978: 'current', w83: 11.0,
    expected: { baxterAdj: -15.1, unionAdj: 2.9, adjBaxter: 64.9, adjUnion: 57.9 },
  },
  {
    label: 'Group C — arbitration Baxter ($8.67), 1978 wage above_top3',
    base: { baxter: 70, union: 70 }, wages1978: 'above_top3', w83: 8.67,
    expected: { baxterAdj: 9.3, unionAdj: -31.7, adjBaxter: 79.3, adjUnion: 38.3 },
  },
]

describe('Baxter 1983 transform conformance (FROZEN gate)', () => {
  it('class-average 1983 wage = 9.5566…', () => {
    const avg = classAvg1983(VECTOR_1983.map(c => c.w83))
    expect(avg).not.toBeNull()
    expect(avg!).toBeCloseTo(W83_AVG, 10)
    expect(avg!).toBeCloseTo(9.556666666, 8)
  })

  for (const c of VECTOR_1983) {
    describe(c.label, () => {
      const w78 = wage78FromOutcome({ wages: c.wages1978 })!
      it('resolves w78 from the 1978 wages enum', () => {
        expect(w78).toBe(WAGE_DOLLARS[c.wages1978])
      })
      it('Baxter adjustment % (vs class-avg) and adjusted-1978', () => {
        const adj = adjustmentPct('baxter', c.w83, w78, W83_AVG)
        expect(adj).toBe(c.expected.baxterAdj)
        expect(adjustedScore(c.base.baxter, adj)).toBeCloseTo(c.expected.adjBaxter, 10)
      })
      it('Union adjustment % (vs own 1978 wage) and adjusted-1978', () => {
        const adj = adjustmentPct('union', c.w83, w78, W83_AVG)
        expect(adj).toBe(c.expected.unionAdj)
        expect(adjustedScore(c.base.union, adj)).toBeCloseTo(c.expected.adjUnion, 10)
      })
    })
  }

  it('no 1983 wage → adjustment 0 (score unchanged) for both roles', () => {
    expect(wage83FromOutcome(null)).toBeNull()
    expect(wage83FromOutcome({})).toBeNull()
    expect(adjustmentPct('baxter', NaN, 11.69, W83_AVG)).toBe(0)
    expect(adjustmentPct('union', NaN, 11.69, W83_AVG)).toBe(0)
  })
})

describe('Baxter 1983 arbitration (seeded, deterministic)', () => {
  it('p = 2/3 constant', () => {
    expect(ARBITRATION_P_BAXTER).toBeCloseTo(2 / 3, 12)
  })
  it('seed 1 → Baxter rules → $8.67 (u < 2/3)', () => {
    const r = resolveArbitration(1, 11.69)
    expect(r.side).toBe('baxter')
    expect(r.wage).toBe(ARBITRATION_BAXTER_WAGE)
    expect(r.wage).toBe(8.67)
    expect(r.u).toBeLessThan(2 / 3)
  })
  it('seed 2 → Union rules → the group’s own 1978 wage (u ≥ 2/3)', () => {
    const r = resolveArbitration(2, 11.69)
    expect(r.side).toBe('union')
    expect(r.wage).toBe(11.69)
    expect(r.u).toBeGreaterThanOrEqual(2 / 3)
  })
  it('is a pure function of the seed (repeatable)', () => {
    expect(resolveArbitration(1, 10.69)).toEqual(resolveArbitration(1, 10.69))
    expect(resolveArbitration(2, 12.69).wage).toBe(12.69)
  })
})
