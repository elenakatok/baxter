import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { computeZScoresByRole, isValidRole, type ScoringRecord, type Outcome } from '@mygames/game-engine'
import {
  extractInstructorGameId,
  buildScoringRecord,
  dispatchResults,
  toGameResult,
  type CompletedGroup,
  type GameResult,
  type PushSummary,
} from '@mygames/game-server'
import { baxterGameDef } from './gameDefinition'

// Same per-game secret finalize uses, so the CLI provisions it for this function too.
const classroomCallbackSecret = defineSecret('CLASSROOM_CALLBACK_SECRET')

/** Resolves the classroom callback URL + secret (prod env, with emulator _dev override). */
function resolveCallbackConfig(data: Record<string, unknown>, isEmulator: boolean): { url: string; secret: string } {
  const dev = isEmulator && data['_dev'] != null ? (data['_dev'] as Record<string, unknown>) : null
  return {
    url: (dev?.['callback_url'] as string | undefined) ?? process.env.CLASSROOM_CALLBACK_URL ?? '',
    secret: (dev?.['callback_secret'] as string | undefined) ?? process.env.CLASSROOM_CALLBACK_SECRET ?? '',
  }
}

const def = baxterGameDef

/**
 * "Score & Record" — instructor-only, ALWAYS available, fully re-runnable.
 *
 * Every call does a complete recompute of the whole pool from the CURRENT group
 * outcomes (so post-finalize edits made via updateGroupContract are picked up,
 * because raw is re-derived from group.outcome — not read from stored raw_score)
 * and re-pushes the freshly computed set to the gradebook, overwriting in place.
 *
 * Deliberately DIFFERS from the shared finalizeInstance in exactly two ways:
 *   1. NO finalized_at early-return guard — every click recomputes, never re-pushes
 *      stale stored scores.
 *   2. NO "all groups complete" precondition — runs on current state anytime.
 *      Unresolved/unreported groups carry their floor: a member in a group whose
 *      outcome is null scores as walk-away (raw 0, in pool); a participant with no
 *      valid role / never matched gets the no-show floor (raw null, normalized -2,
 *      excluded from the pool). Both behaviours come straight from the existing
 *      engine pipeline (buildScoringRecord + computeZScoresByRole), unchanged.
 *
 * The recompute pipeline is pure and idempotent (z-score over current outcomes,
 * no accumulation), so repeated clicks with unchanged inputs yield identical grades.
 * Pushes the in-memory computed set (no re-read → no finalize→push visibility race).
 * Does NOT send instructor_adjusted_score, so the classroom's manual override
 * (nulled only on create, never on update) survives every re-push.
 *
 * This is a per-game callable (mirrors updateGroupContract) so it deploys without a
 * game-server release and never touches grays.
 */
export const scoreAndRecord = onCall({ cors: def.corsOrigins, secrets: [classroomCallbackSecret] }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)
  const { url: callbackUrl, secret: callbackSecret } = resolveCallbackConfig(data, isEmulator)

  const push = async (records: GameResult[]): Promise<PushSummary> => {
    if (!callbackUrl) {
      console.warn('[scoreAndRecord] CLASSROOM_CALLBACK_URL not configured — scores written, push skipped')
      return { total: 0, succeeded: 0, failed: [] }
    }
    const summary = await dispatchResults(records, callbackUrl, callbackSecret)
    console.log('[scoreAndRecord] push summary:', JSON.stringify(summary))
    return summary
  }

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    // ── Full recompute from CURRENT state — no guard, no precondition ──────────
    // Build group_id → {outcome, agreement_reached} for EVERY group (resolved or
    // not). An unresolved group has outcome null → its members score as walk-away.
    const groupsSnap = await instanceRef.collection('groups').get()
    const completedGroups = new Map<string, CompletedGroup>()
    for (const gdoc of groupsSnap.docs) {
      const d = gdoc.data()
      completedGroups.set(gdoc.id, {
        outcome: (d['outcome'] as Outcome | null) ?? null,
        agreement_reached: Boolean(d['agreement_reached']),
      })
    }

    const [participantsSnap, configSnap] = await Promise.all([
      instanceRef.collection('participants').get(),
      instanceRef.collection('config').doc('main').get(),
    ])
    const configData = (configSnap.data() ?? {}) as Record<string, unknown>

    // First pass: ScoringRecord[] for role-bearing participants.
    const records: ScoringRecord[] = []
    for (const pdoc of participantsSnap.docs) {
      const record = buildScoringRecord(pdoc.id, pdoc.data() as Record<string, unknown>, completedGroups)
      if (record !== null) records.push(record)
    }

    // Normalize: per-role pools, sample SD, cost-sense, no_show→-2, walk-away in-pool.
    const scorer = (role: string, outcome: Outcome | null) => def.computeRawScore(role, outcome, configData)
    const finalized = computeZScoresByRole(records, def.roles, def.scoreSense, scorer)

    const recordMap = def.computeScoreBreakdown
      ? new Map(records.map(r => [r.participant_id, r]))
      : null

    // Write scores (overwrite each run): raw_score, normalized_score, kc, finalized_at, value_or_cost.
    const now = FieldValue.serverTimestamp()
    const batch = db.batch()
    for (const f of finalized) {
      const rec = recordMap?.get(f.participant_id)
      const breakdown = (def.computeScoreBreakdown && rec)
        ? def.computeScoreBreakdown(rec.role, rec.outcome, configData)
        : null
      batch.update(instanceRef.collection('participants').doc(f.participant_id), {
        raw_score: f.raw_score,
        normalized_score: f.normalized_score,
        knowledge_check_score: f.knowledge_check_score,
        finalized_at: now,
        ...(breakdown !== null ? { value_or_cost: breakdown.value_or_cost } : {}),
      })
    }

    // Second pass: participants without a valid role → -2 floor (same predicate the push uses).
    const scoredIds = new Set(finalized.map(f => f.participant_id))
    const rolelessPids: string[] = []
    for (const pdoc of participantsSnap.docs) {
      if (scoredIds.has(pdoc.id)) continue
      const role = pdoc.data()['role']
      if (typeof role === 'string' && isValidRole(def.roles, role)) continue
      batch.update(instanceRef.collection('participants').doc(pdoc.id), {
        raw_score: null, normalized_score: -2, finalized_at: now,
      })
      rolelessPids.push(pdoc.id)
    }

    // Instance marker (so getReportData's finalized_at filter + dashboard state see it).
    batch.set(instanceRef, { finalized_at: now, finalized: true }, { merge: true })
    await batch.commit()

    // Push the JUST-computed set (no re-read → no visibility race). Overwrites by
    // deterministic doc id classroom-side; does not include instructor_adjusted_score.
    const computed = new Map<string, Record<string, unknown>>()
    for (const f of finalized) {
      computed.set(f.participant_id, {
        raw_score: f.raw_score,
        normalized_score: f.normalized_score,
        knowledge_check_score: f.knowledge_check_score,
      })
    }
    for (const pid of rolelessPids) {
      const doc = participantsSnap.docs.find(d => d.id === pid)
      computed.set(pid, {
        raw_score: null,
        normalized_score: -2,
        knowledge_check_score: (doc?.data()['knowledge_check_score'] ?? null) as number | null,
      })
    }
    const pushRecords: GameResult[] = participantsSnap.docs
      .filter(d => computed.has(d.id))
      .map(d => toGameResult(gameInstanceId, d.id, { ...d.data(), ...computed.get(d.id)! }, def.roles))

    const summary = await push(pushRecords)
    return { ok: true as const, scored: finalized.length + rolelessPids.length, push: summary }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[scoreAndRecord] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})
