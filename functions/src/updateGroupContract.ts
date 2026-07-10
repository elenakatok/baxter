import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { validateOutcome, type Outcome } from '@mygames/game-engine'
import { extractInstructorGameId } from '@mygames/game-server'
import { computeScoreBreakdown, baxterGameDef } from './gameDefinition'
import { buildReportRows, VALID_ROLES, type ReportRow } from './getReportData'

/**
 * Instructor-only. Edits a group's agreed 1978 contract from the Reports page and recomputes every
 * group member's raw_score through that member's own role formula.
 *
 * REPORT-ONLY by design — it writes the group contract and each member's raw_score / value_or_cost,
 * and NOTHING else. It never touches normalized_score, finalized_at, or the classroom push. Z-score
 * re-normalization and gradebook delivery are a separate slice (Score & Record, deliberately not
 * invoked here).
 *
 * The instance is derived from the instructor's auth (same as getReportData / finalizeInstance) —
 * the client cannot target another instance by passing an id.
 *
 * Input:  { groupId, agreement_reached, outcome? }
 *   - agreement_reached === false → no-deal: stored outcome null, every member scores the walk-away
 *     path (raw 0), owned by the game's computeScoreBreakdown null-guard.
 *   - agreement_reached === true  → outcome validated against the canonical 1978 schema.
 * Output: { ok, rows } — the FULL rebuilt ReportRow[] (same shape as getReportData) so the report
 *         refreshes consistently, including the cross-group 1978 no-deal base which can shift for
 *         other groups when this group's ratified/deal status changes.
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
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    const groupRef = instanceRef.collection('groups').doc(groupId)

    const groupSnap = await groupRef.get()
    if (!groupSnap.exists) {
      throw new HttpsError('not-found', `Group ${groupId} not found.`)
    }

    // 1. Persist the 1978 contract on the GROUP doc — single write, flat round-1 slot.
    await groupRef.update({ outcome, agreement_reached })

    // 2. Recompute + write each member's 1978 raw_score / value_or_cost through their OWN role
    //    formula (report-only; the terminal z-score is Score & Record's job).
    const [membersSnap, configSnap] = await Promise.all([
      instanceRef.collection('participants').where('group_id', '==', groupId).get(),
      instanceRef.collection('config').doc('main').get(),
    ])
    const configData = (configSnap.data() ?? {}) as Record<string, unknown>

    const batch = db.batch()
    for (const pdoc of membersSnap.docs) {
      const d = pdoc.data() as Record<string, unknown>
      const role = d['role'] as string | undefined
      if (!role || !VALID_ROLES.has(role)) continue
      if (d['finalized_at'] == null) continue
      const { value_or_cost, raw_score } = computeScoreBreakdown(role, outcome, configData)
      batch.update(pdoc.ref, { raw_score, value_or_cost })
    }
    await batch.commit()

    // 3. Rebuild the FULL report-row set so the report refreshes consistently (cross-group 1978
    //    no-deal base can shift for other groups when this group's deal/ratification changes).
    const rows: ReportRow[] = await buildReportRows(instanceRef, gameInstanceId)
    return { ok: true as const, rows }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[updateGroupContract] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})
