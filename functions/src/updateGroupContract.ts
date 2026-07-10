import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { validateOutcome, type Outcome } from '@mygames/game-engine'
import { extractInstructorGameId, resolveRoundSlot, setRoundOutcome } from '@mygames/game-server'
import { computeScoreBreakdown, baxterGameDef, baxter1985Schema } from './gameDefinition'
import { buildReportRows, VALID_ROLES, type ReportRow } from './getReportData'

// Round index for the 1985 keyed outcome slot (outcomes_by_round['1985']).
const IDX_1985 = (baxterGameDef.rounds ?? []).indexOf('1985')

/**
 * Instructor-only. Edits a group's agreed contract for one round (1978 OR 1985) from the Reports
 * page and recomputes every group member's raw_score.
 *
 * REPORT-ONLY by design — it writes the group contract and each member's raw_score / value_or_cost,
 * and NOTHING else. It never touches normalized_score, finalized_at, or the classroom push. Z-score
 * re-normalization and gradebook delivery are a separate slice (Score & Record, deliberately not
 * invoked here).
 *
 * The instance is derived from the instructor's auth (same as getReportData / finalizeInstance) —
 * the client cannot target another instance by passing an id.
 *
 * Input:  { groupId, agreement_reached, outcome?, round? }
 *   - round defaults to '1978' (backward-compatible with the original 1978-only editor).
 *   - agreement_reached === false → no-deal: stored outcome null. For 1978 the flat round-1 slot is
 *     cleared (members score the walk-away path); for 1985 outcomes_by_round['1985'] is set null.
 *   - agreement_reached === true  → outcome validated against that round's schema (1978 six-issue or
 *     baxter1985Schema).
 * Output: { ok, rows } — the FULL rebuilt ReportRow[] (same shape as getReportData) so the report
 *         refreshes consistently, including cross-group bases that can shift when this group's
 *         deal status changes (the 1978 no-deal min+5, and the 1985 Baxter no-deal dealer-average).
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
  // Which round's contract is being edited. Default '1978' keeps every existing caller unchanged.
  const round = (data['round'] as string | undefined) ?? '1978'
  if (round !== '1978' && round !== '1985') {
    throw new HttpsError('invalid-argument', `round must be '1978' or '1985' (got '${round}').`)
  }

  // Resolve the contract to store. No-deal → null (walk-away). Deal → validated against the round's
  // schema (1978 six-issue vs. the 1985 own six-issue contract).
  const schema = round === '1985' ? baxter1985Schema : baxterGameDef.outcomeSchema
  let outcome: Outcome | null = null
  if (agreement_reached) {
    const provided = data['outcome']
    if (provided === null || typeof provided !== 'object' || Array.isArray(provided)) {
      throw new HttpsError('invalid-argument', 'outcome must be an object when agreement_reached is true.')
    }
    const check = validateOutcome(schema, provided as Outcome)
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

    if (round === '1985') {
      // 1985 lives in the keyed slot outcomes_by_round['1985'] (Option-1 derive). A single dotted-
      // path write leaves the 1978 flat outcome + sibling rounds untouched; per-round agreement
      // derives from null-ness (no separate flag). This un-corrupts a group mis-recorded as no-deal
      // when a single non-lead reject terminated a real 1985 deal.
      const slot = resolveRoundSlot(baxterGameDef.rounds, IDX_1985 < 0 ? 0 : IDX_1985)
      await groupRef.update(setRoundOutcome(slot, outcome as Record<string, unknown> | null))

      // Rebuild rows FIRST — buildReportRows re-reads the fresh outcomes_by_round and recomputes the
      // cross-group Baxter 1985 no-deal dealer-average, so `total_score` is the terminal figure.
      const rows: ReportRow[] = await buildReportRows(instanceRef, gameInstanceId)

      // Write each edited-group member's raw_score = their terminal total (report-only; the pushed
      // z-score is Score & Record's job). Mirrors the 1978 path's "recompute this group's members".
      const batch = db.batch()
      for (const r of rows) {
        if (r.group_id === groupId && r.total_score != null) {
          batch.update(instanceRef.collection('participants').doc(r.participant_id), { raw_score: r.total_score })
          r.raw_score = r.total_score  // keep the returned row consistent with what was just written
        }
      }
      await batch.commit()
      return { ok: true as const, rows }
    }

    // ── round === '1978' (unchanged behaviour) ────────────────────────────────────
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
