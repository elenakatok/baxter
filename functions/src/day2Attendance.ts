/**
 * Baxter day-2 re-attendance orchestration — the PURE decision core of the "Begin 1983"
 * absence cutoff (Slice 2.7). GAME-SPECIFIC: this composes the general round-scoped
 * attendance primitives (Slice 2.6 presence) and the general re-open patch (Slice 2.7);
 * it does not modify any shared machinery.
 *
 * The platform has exactly ONE lead per group (`lead_participant_id` / a single
 * `is_lead:true` participant). The lead reports the group's outcome; everyone else
 * confirms. Every shared gate (submitLeadOutcome / submitConfirmation) and the frontend
 * routing follow that flag PURELY — they never assume a role — so the REPORTING SIDE is
 * changed simply by moving the lead flag. Baxter's reporting side rotates by round:
 * 1978 = Baxter Management (assigned at matching), 1983 & 1985 = Local 190. The 1978→1983
 * cutover (beginRound2) flips the lead to the round's `reporterRole`; advanceRound (1983→1985)
 * preserves the lead, so Local leads both later rounds off this single reassignment.
 *
 * Per group, exactly ONE of three actions (kept pure so the branch matrix unit-tests
 * without Firestore; the callable in index.ts wires reads/writes around it):
 *
 *  (a) NORMAL     — every role has ≥1 present student AND the current lead is ALREADY a
 *                   present member of `reporterRole`. Re-open unchanged.
 *  (b) REASSIGN   — every role has ≥1 present student but the current lead is NOT a present
 *                   member of `reporterRole` (wrong side for this round, or absent). Promote a
 *                   present `reporterRole` member to lead, then re-open. The degenerate guard
 *                   below guarantees `reporterRole` has ≥1 present member.
 *  (c) DEGENERATE — at least one role has ZERO present students (a whole role missing). The
 *                   group cannot negotiate (both sides required); do NOT re-open — the caller
 *                   flags status:'deadlocked' for manual instructor resolution.
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
 * Decide a single group's day-2 action from its membership, the round-2 present set, its
 * current lead, and the round's REPORTING role. Pure — no Firestore, no side effects.
 *
 * @param roleKeys       ordered role keys for the game (e.g. ['baxter','union'])
 * @param membersByRole  role key → the group's participant ids for that role
 * @param presentIds     participant ids present in round-2 attendance
 * @param leadId         the group's current lead_participant_id
 * @param reporterRole   the role that must hold the lead this round (Baxter: 'union' for 1983/1985)
 */
export function decideGroupDay2(
  roleKeys: readonly string[],
  membersByRole: Record<string, readonly string[]>,
  presentIds: ReadonlySet<string>,
  leadId: string,
  reporterRole: string,
): Day2GroupAction {
  // (c) DEGENERATE first: any role with zero present members means a whole role is missing —
  // the group cannot negotiate (both sides required), independent of which side reports.
  const missingRoles = roleKeys.filter(
    (role) => !(membersByRole[role] ?? []).some((pid) => presentIds.has(pid)),
  )
  if (missingRoles.length > 0) {
    return { kind: 'degenerate', missingRoles }
  }

  // Every role now has ≥1 present student. The lead this round must be a PRESENT member of the
  // reporting role. If the current lead already satisfies that → (a) NORMAL, re-open unchanged.
  const reporterMembers = membersByRole[reporterRole] ?? []
  if (reporterMembers.includes(leadId) && presentIds.has(leadId)) {
    return { kind: 'normal' }
  }

  // (b) REASSIGN: the current lead is on the wrong side for this round (or absent). Promote the
  // first present member of the reporting role. The degenerate guard above guarantees one exists.
  const promoted = reporterMembers.find((pid) => presentIds.has(pid))
  if (promoted) return { kind: 'reassign', oldLeadId: leadId, newLeadId: promoted }

  // Unreachable given the degenerate guard, but keep total.
  return { kind: 'degenerate', missingRoles: [reporterRole] }
}
