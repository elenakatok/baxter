/**
 * Baxter day-2 re-attendance orchestration — the PURE decision core of the "Begin 1983"
 * absence cutoff (Slice 2.7). GAME-SPECIFIC: this composes the general round-scoped
 * attendance primitives (Slice 2.6 presence) and the general re-open patch (Slice 2.7);
 * it does not modify any shared machinery.
 *
 * The platform has exactly ONE lead per group (`lead_participant_id` / a single
 * `is_lead:true` participant). The lead reports the group's outcome; everyone else
 * confirms. The day-2 spec's "each role's designated lead" language maps onto that single
 * group lead: what matters per group is (1) is any whole role missing, and (2) is the
 * single group lead present.
 *
 * Per group, exactly ONE of three actions (kept pure so the branch matrix unit-tests
 * without Firestore; the callable in index.ts wires reads/writes around it):
 *
 *  (a) NORMAL     — every role has ≥1 present student AND the group lead is present.
 *                   Re-open unchanged.
 *  (b) REASSIGN   — every role has ≥1 present student but the group lead is ABSENT.
 *                   Promote a present same-role partner to lead, then re-open. Because the
 *                   lead's own role has ≥1 present (else we'd be in (c)) and the lead is one
 *                   of that role's members, a present same-role partner is guaranteed.
 *  (c) DEGENERATE — at least one role has ZERO present students (a whole role missing).
 *                   Do NOT re-open; the caller flags status:'deadlocked' for manual
 *                   instructor resolution.
 *
 * Absence needs no positive flag: a student is absent for day 2 iff they have no round-2
 * presence record (handled by the caller via the Slice-2.6 presence read). Absent students
 * are simply excluded from `presentIds` here.
 */

/** The three per-group outcomes of the absence cutoff. */
export type Day2GroupAction =
  | { kind: 'normal' }
  | { kind: 'reassign'; oldLeadId: string; newLeadId: string }
  | { kind: 'degenerate'; missingRoles: string[] }

/**
 * Decide a single group's day-2 action from its membership, the round-2 present set, and
 * its current lead. Pure — no Firestore, no side effects.
 *
 * @param roleKeys       ordered role keys for the game (e.g. ['baxter','union'])
 * @param membersByRole  role key → the group's participant ids for that role
 * @param presentIds     participant ids present in round-2 attendance
 * @param leadId         the group's current lead_participant_id
 */
export function decideGroupDay2(
  roleKeys: readonly string[],
  membersByRole: Record<string, readonly string[]>,
  presentIds: ReadonlySet<string>,
  leadId: string,
): Day2GroupAction {
  // (c) DEGENERATE first: any role with zero present members means a whole role is missing.
  const missingRoles = roleKeys.filter(
    (role) => !(membersByRole[role] ?? []).some((pid) => presentIds.has(pid)),
  )
  if (missingRoles.length > 0) {
    return { kind: 'degenerate', missingRoles }
  }

  // Every role now has ≥1 present student.
  if (presentIds.has(leadId)) {
    return { kind: 'normal' } // (a)
  }

  // (b) REASSIGN: the group lead is absent. Promote a present partner from the lead's own
  // role. The lead's role has ≥1 present (it passed the degenerate check) and the lead is
  // absent, so a present same-role partner exists. Fall back to any present member if the
  // lead id isn't found in the role map (data anomaly) so the group still stays playable.
  const leadRole = roleKeys.find((role) => (membersByRole[role] ?? []).includes(leadId))
  const candidateRoles = leadRole ? [leadRole] : roleKeys
  for (const role of candidateRoles) {
    const promoted = (membersByRole[role] ?? []).find((pid) => pid !== leadId && presentIds.has(pid))
    if (promoted) return { kind: 'reassign', oldLeadId: leadId, newLeadId: promoted }
  }
  // Unreachable given the degenerate guard, but keep total: no present partner anywhere.
  return { kind: 'degenerate', missingRoles: roleKeys.slice() }
}
