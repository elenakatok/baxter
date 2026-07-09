import { describe, it, expect } from 'vitest'
import {
  isRatified1978,
  baxterNoDeal1978,
  BaxterNoDeal1978Degenerate,
  RATIFY_LOCATION_PASS,
  RATIFY_TRANSFER_PASS,
  BAXTER_1978_NO_DEAL_BONUS,
} from '../src/ratification1978'

/**
 * FROZEN 1978 ratification + no-deal conformance gate (the Vivo/Adirondacks discipline).
 *
 * Ratification is a HARD DETERMINISTIC rule (spec §3, superseding the 0.99/0 probabilistic text):
 * Location = Deloitte AND Transfer ≥ Most. Compared against the ACTUAL stored enum keys from
 * baxterSchema — location ∈ {'deloitte','elsewhere'}, transfer ∈ {'all','most','some'} — NOT the
 * human-readable labels. 1978 no-deal: Baxter = min ratified Baxter score + 5; Union = 0; and the
 * degenerate (zero ratified) case THROWS rather than inventing a number.
 */

describe('Baxter 1978 ratification gate (FROZEN — deterministic, real stored enum keys)', () => {
  it('compares against the real stored keys (deloitte / all|most), not labels', () => {
    expect(RATIFY_LOCATION_PASS).toBe('deloitte')
    expect([...RATIFY_TRANSFER_PASS].sort()).toEqual(['all', 'most'])
  })

  it('RATIFIES iff Location=Deloitte AND Transfer ≥ Most', () => {
    expect(isRatified1978({ location: 'deloitte', transfer: 'all' })).toBe(true)
    expect(isRatified1978({ location: 'deloitte', transfer: 'most' })).toBe(true)
  })

  it('FAILS ratification when either key fails', () => {
    expect(isRatified1978({ location: 'deloitte', transfer: 'some' })).toBe(false)   // Transfer < Most
    expect(isRatified1978({ location: 'elsewhere', transfer: 'all' })).toBe(false)    // Location ≠ Deloitte
    expect(isRatified1978({ location: 'elsewhere', transfer: 'some' })).toBe(false)   // both fail
  })

  it('a null / absent / partial outcome is NOT a ratified deal', () => {
    expect(isRatified1978(null)).toBe(false)
    expect(isRatified1978(undefined)).toBe(false)
    expect(isRatified1978({})).toBe(false)
    expect(isRatified1978({ location: 'deloitte' })).toBe(false)                       // transfer missing
  })

  it('is a pure predicate of only the two keys (other issues do not matter)', () => {
    const base = { wages: 'above_top3', plant_operation: 'higher_mgmt', escalator: 'reduce', incentive: 'individual' }
    expect(isRatified1978({ ...base, location: 'deloitte', transfer: 'most' })).toBe(true)
    expect(isRatified1978({ ...base, location: 'deloitte', transfer: 'some' })).toBe(false)
  })
})

describe('Baxter 1978 no-deal scoring (FROZEN — min ratified + 5, degenerate throws)', () => {
  it('+5 bonus constant', () => {
    expect(BAXTER_1978_NO_DEAL_BONUS).toBe(5)
  })
  it('Baxter no-deal = minimum ratified Baxter score + 5', () => {
    expect(baxterNoDeal1978([85])).toBe(90)
    expect(baxterNoDeal1978([85, 85])).toBe(90)
    expect(baxterNoDeal1978([85, 72, 90])).toBe(77)   // min 72 + 5
  })
  it('DEGENERATE — zero ratified deals THROWS (no invented number, no NaN)', () => {
    expect(() => baxterNoDeal1978([])).toThrow(BaxterNoDeal1978Degenerate)
    // The thrown message flags it as an open question rather than silently producing a value.
    expect(() => baxterNoDeal1978([])).toThrow(/zero Baxters reached a ratified deal/i)
  })
})
