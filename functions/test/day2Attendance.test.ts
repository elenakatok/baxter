import { describe, it, expect } from 'vitest'
import { decideGroupDay2 } from '../src/day2Attendance'

// A Baxter group: 2 baxter + 2 union; one is the lead. Round-2 presence + the round's reporting
// role decide the action. The lead this round must be a PRESENT member of `reporterRole`.
const ROLES = ['baxter', 'union'] as const
const members = {
  baxter: ['b1', 'b2'],
  union:  ['u1', 'u2'],
}
const present = (...ids: string[]) => new Set(ids)

describe('decideGroupDay2 — (a) NORMAL (lead already the present reporter-role member)', () => {
  it('reporter=baxter, baxter lead present → normal, no re-assignment', () => {
    const action = decideGroupDay2(ROLES, members, present('b1', 'b2', 'u1', 'u2'), 'b1', 'baxter')
    expect(action).toEqual({ kind: 'normal' })
  })

  it('reporter=union, union lead present → normal', () => {
    const action = decideGroupDay2(ROLES, members, present('b1', 'u2'), 'u2', 'union')
    expect(action).toEqual({ kind: 'normal' })
  })
})

describe('decideGroupDay2 — (b) REASSIGN to the reporting role', () => {
  it('Baxter 1983/1985: reporter=union, current lead is baxter → flip to a present union member', () => {
    // The canonical rotation: 1978 lead is Baxter (b1); cutting into 1983 the reporter is Local.
    const action = decideGroupDay2(ROLES, members, present('b1', 'b2', 'u1', 'u2'), 'b1', 'union')
    expect(action).toEqual({ kind: 'reassign', oldLeadId: 'b1', newLeadId: 'u1' })
  })

  it('reporter=union, baxter lead, first union member ABSENT → promote the present union partner', () => {
    // u1 absent, u2 present → the present Local partner leads (day-2-absence on the reporting side).
    const action = decideGroupDay2(ROLES, members, present('b1', 'u2'), 'b1', 'union')
    expect(action).toEqual({ kind: 'reassign', oldLeadId: 'b1', newLeadId: 'u2' })
  })

  it('reporter=union, current union lead ABSENT → promote the present union partner', () => {
    const action = decideGroupDay2(ROLES, members, present('b1', 'u1'), 'u2', 'union')
    expect(action).toEqual({ kind: 'reassign', oldLeadId: 'u2', newLeadId: 'u1' })
  })

  it('promotes a deterministic present reporter-role member (first in member order)', () => {
    const wide = { baxter: ['b1'], union: ['u1', 'u2', 'u3'] }
    // reporter=union; u1 absent, u2 present → promote u2 (first present in order).
    const action = decideGroupDay2(ROLES, wide, present('b1', 'u2', 'u3'), 'b1', 'union')
    expect(action).toEqual({ kind: 'reassign', oldLeadId: 'b1', newLeadId: 'u2' })
  })
})

describe('decideGroupDay2 — (c) DEGENERATE (a whole role missing — both sides required)', () => {
  it('reporting role entirely absent → degenerate (no present member to lead)', () => {
    // reporter=union but both union absent → union missing.
    const action = decideGroupDay2(ROLES, members, present('b1', 'b2'), 'b1', 'union')
    expect(action).toEqual({ kind: 'degenerate', missingRoles: ['union'] })
  })

  it('the non-reporting role entirely absent → still degenerate (needs both sides to negotiate)', () => {
    // reporter=union, union present, but baxter entirely absent → baxter missing.
    const action = decideGroupDay2(ROLES, members, present('u1', 'u2'), 'b1', 'union')
    expect(action).toEqual({ kind: 'degenerate', missingRoles: ['baxter'] })
  })

  it('both roles entirely absent → degenerate lists both roles', () => {
    const action = decideGroupDay2(ROLES, members, present(), 'b1', 'union')
    expect(action).toEqual({ kind: 'degenerate', missingRoles: ['baxter', 'union'] })
  })
})
