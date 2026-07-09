import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { computeZScoresByRole, zScoresSampleSD, isValidRole, type ScoringRecord, type Outcome } from '@mygames/game-engine'
import {
  extractInstructorGameId,
  buildScoringRecord,
  dispatchResults,
  toGameResult,
  getRoundOutcome,
  resolveRoundSlot,
  clampRoundIndex,
  type CompletedGroup,
  type GameResult,
  type PushSummary,
} from '@mygames/game-server'
import { baxterGameDef } from './gameDefinition'
import { wage78FromOutcome, wage83FromOutcome, classAvg1983, adjustmentPct, type BaxterRole } from './transform1983'
import { score1985, baxterNoDeal1985, UNION_1985_NO_DEAL } from './score1985'
import { isRatified1978, baxterNoDeal1978 } from './ratification1978'

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
    const [groupsSnap, participantsSnap, configSnap, instanceSnap] = await Promise.all([
      instanceRef.collection('groups').get(),
      instanceRef.collection('participants').get(),
      instanceRef.collection('config').doc('main').get(),
      instanceRef.get(),
    ])
    const completedGroups = new Map<string, CompletedGroup>()
    for (const gdoc of groupsSnap.docs) {
      const d = gdoc.data()
      completedGroups.set(gdoc.id, {
        outcome: (d['outcome'] as Outcome | null) ?? null,
        agreement_reached: Boolean(d['agreement_reached']),
      })
    }
    const configData = (configSnap.data() ?? {}) as Record<string, unknown>

    // ── 1983 score-transform pre-pass (GAME-SPECIFIC, cross-group, NOT gate-frozen) ────
    // 1983 produces no independent score — it ADJUSTS the 1978 score (spec §4). The class-
    // average 1983 wage is computed HERE, in the re-runnable scorer, so a late-arriving
    // arbitration wage never leaves a stale average behind (Elena-locked). Round 1 flat
    // `outcome` still holds the 1978 deal (Option-1 derive), so w78 reads from it; w83 reads
    // the round-2 keyed slot. The transform applies only once the class has advanced to 1983+.
    const IDX_1983 = (def.rounds ?? []).indexOf('1983')
    const slot1983 = resolveRoundSlot(def.rounds, IDX_1983 < 0 ? 0 : IDX_1983)
    const groupWages = new Map<string, { w78: number | null; w83: number | null }>()
    for (const gdoc of groupsSnap.docs) {
      const d = gdoc.data()
      const w83 = IDX_1983 >= 0 ? wage83FromOutcome(getRoundOutcome(d, slot1983)) : null
      groupWages.set(gdoc.id, { w78: wage78FromOutcome(d['outcome'] as Record<string, unknown> | null), w83 })
    }
    const w83Avg = classAvg1983([...groupWages.values()].map(g => g.w83))
    const currentIdx = clampRoundIndex((def.rounds ?? []).length, instanceSnap.data()?.['current_round'])
    const transformActive = IDX_1983 >= 0 && currentIdx >= IDX_1983 && w83Avg !== null

    // Per-participant signed adjustment (percentage-points), keyed by pid. Empty when the
    // transform is inactive → the final pass below is skipped and scoring is byte-identical.
    const adjByPid = new Map<string, number>()
    if (transformActive) {
      for (const pdoc of participantsSnap.docs) {
        const pd = pdoc.data()
        const role = pd['role']
        const gid = pd['group_id']
        if ((role !== 'baxter' && role !== 'union') || typeof gid !== 'string') continue
        const gw = groupWages.get(gid)
        if (!gw || gw.w83 == null || gw.w78 == null) continue
        adjByPid.set(pdoc.id, adjustmentPct(role as BaxterRole, gw.w83, gw.w78, w83Avg as number))
      }
    }

    // ── 1985 additive pre-pass (GAME-SPECIFIC, cross-group, SCORING FROZEN §5) ──────────
    // 1985 is its OWN six-issue contract producing an independent 0–100 score that ADDS to the
    // adjusted-1978 (final raw = adjusted-1978 + 1985). No-deal (null round-3 outcome): Union = 60
    // flat; Baxter = average of the dealing Baxters' 1985 scores, with a degenerate-pool guard →
    // 50 when ZERO Baxter groups dealt (spec §5 + this slice). The Baxter no-deal average is
    // computed HERE, in the re-runnable scorer, so a late 1985 deal never leaves a stale average.
    const IDX_1985 = (def.rounds ?? []).indexOf('1985')
    const slot1985 = resolveRoundSlot(def.rounds, IDX_1985 < 0 ? 0 : IDX_1985)
    const apply1985 = IDX_1985 >= 0 && currentIdx >= IDX_1985
    const score1985ByPid = new Map<string, number>()
    if (apply1985) {
      // Per-group 1985 outcome (null = no deal: never reported OR an ultimatum reject).
      const group1985 = new Map<string, Record<string, unknown> | null>()
      for (const gdoc of groupsSnap.docs) {
        group1985.set(gdoc.id, (getRoundOutcome(gdoc.data(), slot1985) as Record<string, unknown> | null) ?? null)
      }
      // Baxter no-deal value = avg of the dealing groups' Baxter 1985 scores (degenerate → 50).
      const dealerBaxterScores: number[] = []
      for (const o of group1985.values()) if (o != null) dealerBaxterScores.push(score1985('baxter', o))
      const baxterNoDeal = baxterNoDeal1985(dealerBaxterScores)
      for (const pdoc of participantsSnap.docs) {
        const pd = pdoc.data()
        const role = pd['role']
        const gid = pd['group_id']
        if ((role !== 'baxter' && role !== 'union') || typeof gid !== 'string') continue
        const o = group1985.get(gid) ?? null
        const s = o != null
          ? score1985(role as BaxterRole, o)
          : (role === 'union' ? UNION_1985_NO_DEAL : baxterNoDeal)
        score1985ByPid.set(pdoc.id, s)
      }
    }

    // Combined per-participant offset onto the 1978 base: 1983 adjustment (percentage-points) +
    // 1985 score. Empty → the final pass is skipped and scoring is byte-identical to base.
    const offsetByPid = new Map<string, number>()
    for (const pid of new Set([...adjByPid.keys(), ...score1985ByPid.keys()])) {
      offsetByPid.set(pid, (adjByPid.get(pid) ?? 0) + (score1985ByPid.get(pid) ?? 0))
    }

    // First pass: ScoringRecord[] for role-bearing participants.
    const records: ScoringRecord[] = []
    for (const pdoc of participantsSnap.docs) {
      const record = buildScoringRecord(pdoc.id, pdoc.data() as Record<string, unknown>, completedGroups)
      if (record !== null) records.push(record)
    }

    // ── 1978 ratification + no-deal pre-pass (GAME-SPECIFIC, cross-group, spec §3) ──────
    // Ratification is a HARD DETERMINISTIC rule: a 1978 deal counts only if Location=Deloitte AND
    // Transfer≥Most (isRatified1978). A deal that FAILS ratification is scored as a 1978 NO-DEAL —
    // identical to an explicit walk-away / ultimatum-reject. 1978 no-deal: Baxter = (minimum 1978
    // score among Baxters who reached AND ratified a deal) + 5 [cross-group]; Union = 0. The min
    // uses ONLY ratified Baxter deals (a group's flat round-1 `outcome` holds the 1978 deal).
    const ratifiedBaxterScores: number[] = []
    for (const cg of completedGroups.values()) {
      if (isRatified1978(cg.outcome)) ratifiedBaxterScores.push(def.computeRawScore('baxter', cg.outcome, configData))
    }
    // A Baxter needs the no-deal value iff its group did not reach a ratified deal.
    const hasBaxterNoDeal = participantsSnap.docs.some(pd => {
      const d = pd.data(); const gid = d['group_id']
      const ratified = typeof gid === 'string' && completedGroups.has(gid) && isRatified1978(completedGroups.get(gid)!.outcome)
      return d['role'] === 'baxter' && !ratified
    })
    // Baxter 1978 no-deal value (min ratified + 5), or the flat reservation 50 when nobody ratified
    // (degenerate pool — Elena-decided, mirrors the 1985 zero-dealer guard). Only computed when a
    // Baxter actually needs it.
    const baxterNoDeal1978Value = hasBaxterNoDeal ? baxterNoDeal1978(ratifiedBaxterScores) : null

    // 1978 base scorer: a RATIFIED deal keeps its summed option score; a no-deal / failed-
    // ratification group scores as no-deal (Baxter min+5, Union 0). Replaces the plain option-sum
    // scorer. Per-role pools, sample SD, cost-sense, no_show→-2, walk-away in-pool otherwise.
    const scorer = (role: string, outcome: Outcome | null) => {
      if (isRatified1978(outcome as Record<string, unknown> | null)) return def.computeRawScore(role, outcome, configData)
      return role === 'baxter' ? (baxterNoDeal1978Value as number) : 0
    }
    const finalizedBase = computeZScoresByRole(records, def.roles, def.scoreSense, scorer)

    // Final pass: raw_score = 1978 base + offset (1983 adjustment + 1985 score), then re-z within
    // role over the final raws (both Baxter roles are 'value'; scoreSense honoured for generality).
    // No-show/late (raw_score null) pass through untouched. Empty offset → finalized === base.
    // NOTE: terminal z-scoring with the degenerate-pool guard + the once-only gradebook push land
    // in Slice 6; this re-runnable scorer keeps re-z'ing on every click exactly as it did for 1983.
    let finalized = finalizedBase
    if (offsetByPid.size > 0) {
      const finalRawByPid = new Map<string, number>()
      for (const f of finalizedBase) {
        if (f.raw_score == null) continue
        finalRawByPid.set(f.participant_id, f.raw_score + (offsetByPid.get(f.participant_id) ?? 0))
      }
      const zByPid = new Map<string, number>()
      for (const roleKey of def.roles.roles.map(r => r.key)) {
        const pool = finalizedBase.filter(f => f.role === roleKey && f.raw_score != null)
        const sense = def.scoreSense[roleKey] ?? 'value'
        const signed = pool.map(f => {
          const a = finalRawByPid.get(f.participant_id) as number
          return sense === 'cost' ? -a : a
        })
        const zs = zScoresSampleSD(signed)
        pool.forEach((f, i) => zByPid.set(f.participant_id, zs[i]))
      }
      finalized = finalizedBase.map(f => f.raw_score == null ? f : {
        ...f,
        raw_score: finalRawByPid.get(f.participant_id) ?? f.raw_score,
        normalized_score: zByPid.get(f.participant_id) ?? f.normalized_score,
      })
    }

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
