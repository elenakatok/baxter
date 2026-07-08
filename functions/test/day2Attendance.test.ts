import { describe, it, expect } from 'vitest'
import { decideGroupDay2 } from '../src/day2Attendance'

// A Baxter group: 2 baxter + 2 union; one is the lead. Round-2 presence decides the action.
const ROLES = ['baxter', 'union'] as const
const members = {
  baxter: ['b1', 'b2'],
  union:  ['u1', 'u2'],
}
const present = (...ids: string[]) => new Set(ids)

describe('decideGroupDay2 — (a) NORMAL', () => {
  it('all four present, lead present → normal, no re-assignment', () => {
    const action = decideGroupDay2(ROLES, members, present('b1', 'b2', 'u1', 'u2'), 'b1')
    expect(action).toEqual({ kind: 'normal' })
  })

  it('each role has one present, and the lead is among the present → normal', () => {
    // b1 (lead) present, b2 absent, u1 present, u2 absent — every role still represented.
    const action = decideGroupDay2(ROLES, members, present('b1', 'u1'), 'b1')
    expect(action).toEqual({ kind: 'normal' })
  })

  it('lead is in the non-first role and present → normal', () => {
    const action = decideGroupDay2(ROLES, members, present('b2', 'u2'), 'u2')
    expect(action).toEqual({ kind: 'normal' })
  })
})

describe('decideGroupDay2 — (b) REASSIGN', () => {
  it('lead absent, same-role partner present, other role present → promote partner', () => {
    // b1 (lead) absent, b2 present, u1 present.
    const action = decideGroupDay2(ROLES, members, present('b2', 'u1'), 'b1')
    expect(action).toEqual({ kind: 'reassign', oldLeadId: 'b1', newLeadId: 'b2' })
  })

  it('lead in the union role absent, union partner present → promote union partner', () => {
    const action = decideGroupDay2(ROLES, members, present('b1', 'u1'), 'u2')
    expect(action).toEqual({ kind: 'reassign', oldLeadId: 'u2', newLeadId: 'u1' })
  })

  it('promotes a deterministic present same-role partner (first in member order)', () => {
    const wide = { baxter: ['b1', 'b2', 'b3'], union: ['u1'] }
    // lead b1 absent; b2 absent; b3 present → promote b3.
    const action = decideGroupDay2(ROLES, wide, present('b3', 'u1'), 'b1')
    expect(action).toEqual({ kind: 'reassign', oldLeadId: 'b1', newLeadId: 'b3' })
  })
})

describe('decideGroupDay2 — (c) DEGENERATE', () => {
  it('a whole role absent (both union gone), lead in the present role → degenerate', () => {
    const action = decideGroupDay2(ROLES, members, present('b1', 'b2'), 'b1')
    expect(action).toEqual({ kind: 'degenerate', missingRoles: ['union'] })
  })

  it("a whole role absent AND that role held the lead → degenerate (lead's role missing)", () => {
    // lead u1 absent, u2 absent → union entirely missing.
    const action = decideGroupDay2(ROLES, members, present('b1', 'b2'), 'u1')
    expect(action).toEqual({ kind: 'degenerate', missingRoles: ['union'] })
  })

  it('both roles entirely absent → degenerate lists both roles', () => {
    const action = decideGroupDay2(ROLES, members, present(), 'b1')
    expect(action).toEqual({ kind: 'degenerate', missingRoles: ['baxter', 'union'] })
  })

  it('degenerate takes precedence over an absent lead (never reassigns into a missing role)', () => {
    // baxter role entirely absent (b1 lead + b2 both gone); union present. Missing role wins.
    const action = decideGroupDay2(ROLES, members, present('u1', 'u2'), 'b1')
    expect(action).toEqual({ kind: 'degenerate', missingRoles: ['baxter'] })
  })
})
