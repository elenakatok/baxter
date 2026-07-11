/**
 * Baxter day-2 re-attendance orchestration callables (Slice 2.7) — the two-button
 * instructor sequence for moving the class from 1978 into 1983 while re-confirming who is
 * still in the room. GAME-SPECIFIC: both callables COMPOSE general primitives
 * (clampRoundIndex / resolveRoundSlot / presenceAtSlot / reopenGroupPatch) and the pure
 * decideGroupDay2 branch core; neither modifies shared machinery.
 *
 *  Button 1  openRound2Attendance — advance current_round 1978→1983 WITHOUT re-opening
 *            groups. Students then re-confirm attendance for the new round (the instructor
 *            regenerates the code via the existing generateAttendanceCode); their round-2
 *            presence lands in attendance_by_round because current_round is now 1983.
 *
 *  Button 2  beginRound2 — the ABSENCE CUTOFF. One atomic pass: read round-2 presence and,
 *            per group, re-open (normal) / promote-a-present-partner-then-re-open (lead
 *            absent) / flag deadlocked (a whole role missing). See decideGroupDay2.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import {
  extractInstructorGameId,
  clampRoundIndex,
  resolveRoundSlot,
  presenceAtSlot,
  setRoundPresence,
  reopenGroupPatch,
} from '@mygames/game-server'
import { baxterGameDef } from './gameDefinition'
import { decideGroupDay2 } from './day2Attendance'

const CORS = baxterGameDef.corsOrigins
const ROLE_KEYS = baxterGameDef.roles.roles.map((r) => r.key)
const ROUNDS = baxterGameDef.rounds ?? []
const IDX_1978 = ROUNDS.indexOf('1978')
const IDX_1983 = ROUNDS.indexOf('1983')
const IDX_1985 = ROUNDS.indexOf('1985')

/**
 * Baxter's per-round REPORTING side — which role holds the group lead (reports the outcome; the
 * other side confirms). 1978 = Baxter Management (assigned at matching); 1983 & 1985 = Local 190.
 * Every shared gate + the frontend follow the lead FLAG purely (no role assumption), so rotating
 * the reporter is just moving the lead flag. beginRound2 (1978→1983) flips the lead to this role;
 * advanceRound (1983→1985) preserves it, so one reassignment covers both Local-led rounds.
 * Falls back to the first role for any unlisted round (parity with matching's default lead).
 */
const REPORTER_ROLE_BY_ROUND: Record<string, string> = { '1978': 'baxter', '1983': 'union', '1985': 'union' }
const reporterRoleForRound = (roundId: string): string => REPORTER_ROLE_BY_ROUND[roundId] ?? ROLE_KEYS[0]

/**
 * Button 1 — "Open Round 2 Attendance". Advances the class from 1978 to 1983 by bumping the
 * round pointer ONLY; groups stay 'completed' (closed) so students re-confirm attendance
 * rather than negotiate. This is the day-2 counterpart to the general advanceRound, minus
 * the re-open (which is deferred to Button 2). Same all-groups-resolved gate as advanceRound.
 *
 * Guarded to the 1978→1983 hop only (currentIdx must be the 1978 index) so a stray second
 * click can never skip the class straight past 1983 into 1985.
 */
export const openRound2Attendance = onCall({ cors: CORS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined
  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    const [instanceSnap, groupsSnap] = await Promise.all([
      instanceRef.get(),
      instanceRef.collection('groups').get(),
    ])

    const currentIdx = clampRoundIndex(ROUNDS.length, instanceSnap.data()?.['current_round'])
    if (currentIdx !== IDX_1978) {
      throw new HttpsError(
        'failed-precondition',
        `Round 2 attendance can only be opened from the 1978 round (current: ${ROUNDS[currentIdx]}).`,
      )
    }

    // Gate cloned from advanceRound: every group must have resolved 1978 before advancing.
    if (groupsSnap.empty) {
      throw new HttpsError('failed-precondition', 'No groups yet — cannot open round 2 attendance.')
    }
    for (const g of groupsSnap.docs) {
      if (g.data()['status'] !== 'completed') {
        throw new HttpsError(
          'failed-precondition',
          `Group ${g.id} has not resolved 1978 — resolve all groups before opening round 2.`,
        )
      }
    }

    // Advance the round pointer WITHOUT re-opening. Groups stay 'completed'; students
    // re-confirm attendance for 1983 (current_round is now 1983, so Slice-2.6 records the
    // round-2 slot). Re-open happens at Button 2 (beginRound2), after the absence cutoff.
    await instanceRef.set({ current_round: IDX_1983 }, { merge: true })
    return { ok: true as const, current_round: IDX_1983, round_id: ROUNDS[IDX_1983] }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[openRound2Attendance] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})

/**
 * Button 2 — "Begin 1983". The absence cutoff. Anyone not present in round-2 attendance by
 * now is absent for day 2 (absence = no round-2 presence record; no positive flag needed).
 *
 * One atomic batch over every group so a degenerate group never briefly shows 'negotiating'
 * before being flagged. Per group (decideGroupDay2):
 *   normal     → re-open (reopenGroupPatch), lead unchanged.
 *   reassign   → promote the present same-role partner (is_lead flip + lead_participant_id),
 *                then re-open. Silent — no confirmation, no notification.
 *   degenerate → do NOT re-open; flag status:'deadlocked' (+ reason) for manual instructor
 *                resolution via the existing submitInstructorOutcome path. A deadlocked group
 *                blocks the all-groups-resolved advance gate exactly as a normal deadlock does.
 *
 * Idempotent: only 'completed' groups are processed, so a second click (or a re-run after
 * 1983 negotiation has started) is a no-op and never resets in-progress work.
 */
export const beginRound2 = onCall({ cors: CORS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined
  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    const [instanceSnap, groupsSnap, participantsSnap] = await Promise.all([
      instanceRef.get(),
      instanceRef.collection('groups').get(),
      instanceRef.collection('participants').get(),
    ])

    const currentIdx = clampRoundIndex(ROUNDS.length, instanceSnap.data()?.['current_round'])
    const slot = resolveRoundSlot(ROUNDS, currentIdx)
    // Must be at 1983 (Button 1 already advanced the pointer). Round-1 resolves to a flat slot.
    if (slot.kind !== 'keyed' || currentIdx !== IDX_1983) {
      throw new HttpsError(
        'failed-precondition',
        'Open Round 2 Attendance first, then Begin 1983.',
      )
    }
    if (groupsSnap.empty) {
      throw new HttpsError('failed-precondition', 'No groups to begin.')
    }

    // Round-2 present set: a participant is present iff they re-confirmed attendance for the
    // 1983 slot (Slice-2.6 keyed presence). Absent day-2 students are simply not in the set.
    const presentIds = new Set<string>()
    for (const p of participantsSnap.docs) {
      if (presenceAtSlot(p.data(), slot)) presentIds.add(p.id)
    }

    const batch = db.batch()
    const summary: Array<{ group_id: string; action: string; detail?: unknown }> = []
    let openedCount = 0      // reopened + reassigned (groups that could actually play 1983)
    let degenerateCount = 0  // flagged deadlocked because a whole role was absent
    for (const g of groupsSnap.docs) {
      const gdata = g.data()
      // Idempotency: only groups still closed from 1978 ('completed') are cut over. Skip any
      // already re-opened/deadlocked so a re-run never resets in-progress 1983 work.
      if (gdata['status'] !== 'completed') {
        summary.push({ group_id: g.id, action: 'skipped' })
        continue
      }

      const membersByRole: Record<string, string[]> = {}
      for (const role of ROLE_KEYS) {
        membersByRole[role] = (gdata[`${role}_participants`] as string[] | undefined) ?? []
      }
      const leadId = gdata['lead_participant_id'] as string
      // Reporting side for the round we are cutting INTO (1983): Local 190. decideGroupDay2 flips
      // the lead to a present Local member, so Local reports 1983 (and 1985, which advanceRound
      // inherits). If a Local member is absent it promotes a present Local partner (same machinery).
      const reporterRole = reporterRoleForRound(ROUNDS[currentIdx])
      const action = decideGroupDay2(ROLE_KEYS, membersByRole, presentIds, leadId, reporterRole)

      if (action.kind === 'degenerate') {
        batch.update(g.ref, {
          status: 'deadlocked',
          day2_deadlock_reason: 'absent_role',
          day2_missing_roles: action.missingRoles,
        })
        degenerateCount++
        summary.push({ group_id: g.id, action: 'deadlocked', detail: action.missingRoles })
      } else if (action.kind === 'reassign') {
        batch.update(g.ref, { ...reopenGroupPatch(), lead_participant_id: action.newLeadId })
        batch.update(instanceRef.collection('participants').doc(action.newLeadId), { is_lead: true })
        batch.update(instanceRef.collection('participants').doc(action.oldLeadId), { is_lead: false })
        openedCount++
        summary.push({
          group_id: g.id,
          action: 'reassigned',
          detail: { from: action.oldLeadId, to: action.newLeadId },
        })
      } else {
        batch.update(g.ref, reopenGroupPatch())
        openedCount++
        summary.push({ group_id: g.id, action: 'reopened' })
      }
    }

    // Carry the day-2 present set forward to 1985. There is NO separate 1985 re-attendance
    // step (1983→1985 uses the generic advanceRound, which does not stamp presence), so the
    // 1983 present set IS the active roster for the rest of the session. Stamping the 1985
    // keyed slot here means submitLeadOutcome's presence filter finds the present set for 1985
    // and excludes anyone absent for day 2. Without it, 1985 has no presence records at all,
    // the filter falls back to the full non-lead set, and a single day-2-absent member sits
    // in the required-confirmation set forever — the group reaches a deal but can never commit.
    if (IDX_1985 >= 0) {
      const slot1985 = resolveRoundSlot(ROUNDS, IDX_1985)
      const present1985 = FieldValue.serverTimestamp()
      for (const pid of presentIds) {
        batch.update(instanceRef.collection('participants').doc(pid), setRoundPresence(slot1985, present1985))
      }
    }

    // All-absent guard: if every processable ('completed') group came back degenerate and NOT
    // ONE could be opened, this is almost certainly a premature click — the code was
    // regenerated but students have not re-confirmed 1983 attendance yet. Do NOT commit the
    // mass-deadlock (which would strand every group and set round2_begun_at, hiding the
    // button). Surface a legible failed-precondition instead so the instructor can wait for
    // re-attendance and click Begin 1983 again.
    if (openedCount === 0 && degenerateCount > 0) {
      throw new HttpsError(
        'failed-precondition',
        'No groups could be opened — all students are absent for round 2. Regenerate the ' +
          'attendance code, have students re-confirm, then Begin 1983 again.',
      )
    }

    // Persistent "round 2 has begun" marker on the instance doc. The dashboard gates the
    // "Begin 1983" button on this (not on transient group statuses) so it never re-appears
    // after the 1983 round finishes and re-opens groups back to 'completed' (Bug B loop).
    batch.set(instanceRef, { round2_begun_at: FieldValue.serverTimestamp() }, { merge: true })

    await batch.commit()
    return { ok: true as const, round_id: ROUNDS[currentIdx], groups: summary }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[beginRound2] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})
