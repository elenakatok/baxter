/**
 * Verifies the "all-absent" guard logic added to beginRound2 (Slice 1 day-2 fix). The guard
 * counts, over every processable group, how many could be OPENED (normal | reassign) vs flagged
 * DEGENERATE (a whole role absent). If nothing could be opened yet at least one group is
 * degenerate, beginRound2 must refuse to commit the mass-deadlock and instead surface a legible
 * failed-precondition — the signal of a premature click before students re-confirmed attendance.
 *
 * This drives the REAL pure decision core (decideGroupDay2) and reproduces the callable's
 * opened/degenerate counting so the guard predicate is checked against genuine action kinds.
 */
import { describe, it, expect } from 'vitest'
import { decideGroupDay2, type Day2GroupAction } from '../src/day2Attendance'

const ROLES = ['baxter', 'union'] as const
const members = { baxter: ['b1', 'b2'], union: ['u1', 'u2'] }
const present = (...ids: string[]) => new Set(ids)

/** Reproduces beginRound2's post-loop counting + guard predicate over a set of groups. */
function guardFires(groups: Array<{ present: Set<string>; lead: string }>): boolean {
  let opened = 0
  let degenerate = 0
  for (const g of groups) {
    const action: Day2GroupAction = decideGroupDay2(ROLES, members, g.present, g.lead)
    if (action.kind === 'degenerate') degenerate++
    else opened++ // normal | reassign
  }
  return opened === 0 && degenerate > 0
}

describe('beginRound2 all-absent guard', () => {
  it('FIRES (blocks) when every group is degenerate — a premature click, no one re-attended', () => {
    // Two groups, both with a whole role absent (only baxter present in each).
    expect(guardFires([
      { present: present('b1', 'b2'), lead: 'b1' },
      { present: present('b1'),       lead: 'b1' },
    ])).toBe(true)
  })

  it('FIRES when the single group is fully absent (nobody present)', () => {
    expect(guardFires([{ present: present(), lead: 'b1' }])).toBe(true)
  })

  it('does NOT fire when at least one group can be opened (mixed) → commit proceeds', () => {
    expect(guardFires([
      { present: present('b1', 'u1'), lead: 'b1' }, // normal → opened
      { present: present('b1'),       lead: 'b1' }, // union absent → degenerate
    ])).toBe(false)
  })

  it('does NOT fire when all groups open normally', () => {
    expect(guardFires([
      { present: present('b1', 'u1'), lead: 'b1' },
      { present: present('b2', 'u2'), lead: 'u2' },
    ])).toBe(false)
  })

  it('does NOT fire on a lead-absent reassign (group still opens)', () => {
    // b1 lead absent but b2 present + union present → reassign, counts as opened.
    expect(guardFires([{ present: present('b2', 'u1'), lead: 'b1' }])).toBe(false)
  })
})
