import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { validateOutcome, type Outcome } from '@mygames/game-engine'
import { extractInstructorGameId } from '@mygames/game-server'
import { computeScoreBreakdown, baxterGameDef } from './gameDefinition'
import { VALID_ROLES, TEXT_FIELDS, type ReportRow } from './getReportData'

/**
 * Instructor-only. Edits a group's agreed contract from the Reports page and
 * recomputes every group member's raw_score through that member's own role formula.
 *
 * REPORT-ONLY by design — it writes the group contract and each member's
 * raw_score / value_or_cost, and NOTHING else. It never touches normalized_score,
 * finalized_at, or the classroom push. Z-score re-normalization and gradebook
 * delivery are a separate slice (re-finalize, deliberately not invoked here).
 *
 * The instance is derived from the instructor's auth (same as getReportData /
 * finalizeInstance) — the client cannot target another instance by passing an id.
 *
 * Input:  { groupId, agreement_reached, outcome? }
 *   - agreement_reached === false → no-deal: stored outcome is null, every member
 *     scores through the walk-away path (raw_score 0), owned entirely by the
 *     game's computeScoreBreakdown null-guard. No special-casing here.
 *   - agreement_reached === true  → outcome validated against the canonical schema
 *     (unknown / mis-typed / out-of-range fields rejected).
 * Output: { ok, rows } — the updated ReportRow[] for this group (same shape as
 *         getReportData rows) so the caller can refresh the whole group at once.
 *
 * Idempotent: re-running with the same input yields the same stored state.
 */
export const updateGroupContract = onCall({ cors: baxterGameDef.corsOrigins }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const groupId = data['groupId']
  if (typeof groupId !== 'string' || !groupId) {
    throw new HttpsError('invalid-argument', 'groupId is required.')
  }
  const agreement_reached = data['agreement_reached']
  if (typeof agreement_reached !== 'boolean') {
    throw new HttpsError('invalid-argument', 'agreement_reached must be a boolean.')
  }

  // Resolve the contract to store. No-deal → null (walk-away). Deal → validated outcome.
  let outcome: Outcome | null = null
  if (agreement_reached) {
    const provided = data['outcome']
    if (provided === null || typeof provided !== 'object' || Array.isArray(provided)) {
      throw new HttpsError('invalid-argument', 'outcome must be an object when agreement_reached is true.')
    }
    const check = validateOutcome(baxterGameDef.outcomeSchema, provided as Outcome)
    if (!check.valid) {
      throw new HttpsError('invalid-argument', `Invalid contract: ${check.errors.join(' ')}`)
    }
    outcome = provided as Outcome
  }

  try {
    const db = admin.firestore()
    const rtdb = admin.database()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    const groupRef = instanceRef.collection('groups').doc(groupId)

    const groupSnap = await groupRef.get()
    if (!groupSnap.exists) {
      throw new HttpsError('not-found', `Group ${groupId} not found.`)
    }

    // 1. Persist the contract on the GROUP doc — single write, nested-object convention.
    await groupRef.update({ outcome, agreement_reached })

    // 2. Read everything needed to recompute + rebuild this group's rows.
    const [membersSnap, groupsSnap, configSnap, attendingSnap] = await Promise.all([
      instanceRef.collection('participants').where('group_id', '==', groupId).get(),
      instanceRef.collection('groups').get(),
      instanceRef.collection('config').doc('main').get(),
      rtdb.ref(`game_instances/${gameInstanceId}/attendance`).get(),
    ])

    const configData = (configSnap.data() ?? {}) as Record<string, unknown>
    const attending = (attendingSnap.val() ?? {}) as Record<string, { display_name?: string } | null>

    // Same 1-based group numbering getReportData uses (sorted by doc id).
    const sortedGroups = groupsSnap.docs.slice().sort((a, b) => a.id.localeCompare(b.id))
    const idx = sortedGroups.findIndex(g => g.id === groupId)
    const group_number = idx >= 0 ? idx + 1 : null

    // 3. Recompute each member through their OWN role formula; batch-write raw_score + value_or_cost.
    const batch = db.batch()
    const rows: ReportRow[] = []

    for (const pdoc of membersSnap.docs) {
      const d = pdoc.data() as Record<string, unknown>
      const role = d['role'] as string | undefined
      // Mirror getReportData's row predicate: finalized participants with a valid role.
      if (!role || !VALID_ROLES.has(role)) continue
      if (d['finalized_at'] == null) continue

      const { value_or_cost, raw_score } = computeScoreBreakdown(role, outcome, configData)
      batch.update(pdoc.ref, { raw_score, value_or_cost })

      const rtdbName = attending[pdoc.id]?.display_name?.trim()
      const fsName   = ((d['display_name'] ?? d['name'] ?? '') as string).trim()
      const display_name = rtdbName || fsName || `${pdoc.id.slice(0, 8)}…`

      const text_answers: Record<string, string> = {}
      for (const field of TEXT_FIELDS) {
        const val = d[field]
        if (typeof val === 'string' && val.trim()) text_answers[field] = val.trim()
      }

      rows.push({
        participant_id: pdoc.id,
        display_name,
        group_number,
        group_id: groupId,
        role,
        shares:     outcome ? (outcome['shares']     as number)  : null,
        vesting:    outcome ? (outcome['vesting']    as string)  : null,
        board_seat: outcome ? (outcome['board_seat'] as boolean) : null,
        liability:  outcome ? (outcome['liability']  as number)  : null,
        value_or_cost,
        raw_score,
        text_answers,
        notes: outcome ? ((outcome['notes'] as string | undefined) ?? null) : null,
      })
    }

    await batch.commit()

    rows.sort((a, b) => a.display_name.localeCompare(b.display_name))
    return { ok: true as const, rows }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[updateGroupContract] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})
