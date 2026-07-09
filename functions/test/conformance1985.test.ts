import { describe, it, expect } from 'vitest'
import {
  score1985,
  wage85Points,
  baxterNoDeal1985,
  UNION_1985_NO_DEAL,
  BAXTER_1985_NO_DEAL_DEGENERATE,
} from '../src/score1985'

/**
 * FROZEN 1985 scoring conformance gate (the Vivo/Adirondacks discipline).
 *
 * Reproduces spec §5's frozen vectors EXACTLY before anything (reports, gradebook push) builds
 * on top of the 1985 score. Deal A/B are the spec's internal worked examples; do not alter them.
 * This gate must PASS for Slice 4 to be considered done.
 *
 *   Wage @ $8.67   → Baxter 25, Union 0
 *   Wage @ $12.69  → Baxter 0,  Union 25
 *   Deal A (wage 11.00; incentive above-quota, joint rules, 100% hiring, notices yes, seniority all)
 *          → Baxter 10.51, Union 89.49
 *   Deal B (wage 9.00; incentive none, mgmt rules, no-priority hiring, notices no, seniority none)
 *          → Baxter 97.95, Union 9.55
 *   Ideal deal → Baxter 100, Union 100
 *
 * Plus the no-deal rules (spec §5 + the degenerate-pool guard added this slice):
 *   Union no-deal = 60 (flat). Baxter no-deal = avg of dealing Baxters; 0 dealers → 50.
 */

// The five discrete issues at their spec-labelled option keys.
const DEAL_A = { wage85: 11.00, incentive85: 'above_quota', work_rules85: 'jointly_determined', hiring85: 'layoff_100', notices85: 'yes', seniority85: 'all' }
const DEAL_B = { wage85: 9.00,  incentive85: 'none',        work_rules85: 'mgmt_control',       hiring85: 'no_priority', notices85: 'no',  seniority85: 'none' }
// Ideal = each role's best option on every issue (opposite for the two roles), each at its own
// best wage. Baxter's ideal and Union's ideal are DIFFERENT contracts — scored separately.
const IDEAL_BAXTER = { wage85: 8.67,  incentive85: 'none',        work_rules85: 'mgmt_control',       hiring85: 'no_priority', notices85: 'no',  seniority85: 'none' }
const IDEAL_UNION  = { wage85: 12.69, incentive85: 'above_quota', work_rules85: 'jointly_determined', hiring85: 'layoff_100', notices85: 'yes', seniority85: 'all' }

describe('Baxter 1985 scoring conformance (FROZEN gate — spec §5)', () => {
  it('wage anchors: $8.67 → Baxter 25 / Union 0', () => {
    expect(wage85Points('baxter', 8.67)).toBeCloseTo(25, 6)
    expect(wage85Points('union', 8.67)).toBeCloseTo(0, 6)
  })
  it('wage anchors: $12.69 → Baxter 0 / Union 25', () => {
    expect(wage85Points('baxter', 12.69)).toBeCloseTo(0, 6)
    expect(wage85Points('union', 12.69)).toBeCloseTo(25, 6)
  })

  it('Deal A → Baxter 10.51, Union 89.49', () => {
    expect(score1985('baxter', DEAL_A)).toBe(10.51)
    expect(score1985('union', DEAL_A)).toBe(89.49)
  })
  it('Deal B → Baxter 97.95, Union 9.55', () => {
    expect(score1985('baxter', DEAL_B)).toBe(97.95)
    expect(score1985('union', DEAL_B)).toBe(9.55)
  })
  it('Ideal deal → Baxter 100, Union 100', () => {
    expect(score1985('baxter', IDEAL_BAXTER)).toBe(100)
    expect(score1985('union', IDEAL_UNION)).toBe(100)
  })

  it('both roles span 0–100 across all frozen deals', () => {
    for (const d of [DEAL_A, DEAL_B, IDEAL_BAXTER, IDEAL_UNION]) {
      for (const role of ['baxter', 'union'] as const) {
        const s = score1985(role, d)
        expect(s).toBeGreaterThanOrEqual(0)
        expect(s).toBeLessThanOrEqual(100)
      }
    }
  })
})

describe('Baxter 1985 no-deal (FROZEN gate — spec §5 + degenerate guard)', () => {
  it('Union no-deal = 60 (flat)', () => {
    expect(UNION_1985_NO_DEAL).toBe(60)
  })
  it('Baxter no-deal = average of dealing Baxters', () => {
    expect(baxterNoDeal1985([97.95])).toBeCloseTo(97.95, 6)
    expect(baxterNoDeal1985([10.51, 97.95])).toBeCloseTo((10.51 + 97.95) / 2, 6)
    expect(baxterNoDeal1985([100, 50, 0])).toBeCloseTo(50, 6)
  })
  it('DEGENERATE guard — 0 Baxter dealers → 50 (flat reservation, NOT an empty average)', () => {
    expect(baxterNoDeal1985([])).toBe(50)
    expect(BAXTER_1985_NO_DEAL_DEGENERATE).toBe(50)
    // Distinct from the normal path: a single dealer at 50 is coincidental, not the guard.
    expect(baxterNoDeal1985([50])).toBe(50)
  })
})
