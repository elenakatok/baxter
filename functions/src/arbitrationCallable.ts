/**
 * Baxter 1983 arbitration callable (GAME-SPECIFIC) — "Resolve arbitration".
 *
 * The instructor works the auto-flagged 1983 arbitration queue ONE GROUP AT A TIME. This
 * callable is the plain per-group mechanic: NO wheel graphic, NO sound, NO animation. The
 * RNG FIRES HERE, at button-click (not pre-decided), and is SEEDABLE so the play-through
 * harness resolves deterministically (emulator passes a fixed `seed`; production seeds from
 * crypto). On resolve it writes the resulting wage to the group's 1983 slot and returns the
 * outcome (which side's rules won + the wage) as plain data.
 *
 * The later cosmetic "wheel" slice is a PURE PRESENTATION wrapper over this exact callable —
 * it changes nothing here; it only animates the already-computed result.
 */
import { randomInt } from 'crypto'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import {
  extractInstructorGameId,
  clampRoundIndex,
  resolveRoundSlot,
  getRoundOutcome,
  setRoundOutcome,
} from '@mygames/game-server'
import { baxterGameDef } from './gameDefinition'
import { resolveArbitration as drawArbitration } from './arbitration'
import { wage78OrStatusQuo, wage83FromOutcome, WAGE83_FIELD } from './transform1983'

const CORS = baxterGameDef.corsOrigins
const ROUNDS = baxterGameDef.rounds ?? []
const IDX_1983 = ROUNDS.indexOf('1983')

export const resolveArbitration = onCall({ cors: CORS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined
  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const groupId = data['group_id']
  if (typeof groupId !== 'string' || !groupId) {
    throw new HttpsError('invalid-argument', 'group_id is required.')
  }

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    const [instanceSnap, gSnap] = await Promise.all([
      instanceRef.get(),
      instanceRef.collection('groups').doc(groupId).get(),
    ])
    if (!gSnap.exists) throw new HttpsError('not-found', 'Group not found.')
    const gdata = gSnap.data()!

    const currentIdx = clampRoundIndex(ROUNDS.length, instanceSnap.data()?.['current_round'])
    if (IDX_1983 < 0 || currentIdx !== IDX_1983) {
      throw new HttpsError('failed-precondition', 'Arbitration is only available during the 1983 round.')
    }

    // Only groups that ENDED 1983 with NO agreed wage arbitrate. A group still negotiating
    // (not completed/deadlocked) or one that already has a 1983 wage (agreed OR arbitrated)
    // is refused — the queue derives exactly this predicate, so a stale click is a no-op.
    const status = gdata['status']
    const slot = resolveRoundSlot(ROUNDS, IDX_1983)
    const existingWage = wage83FromOutcome(getRoundOutcome(gdata, slot))
    if (existingWage != null) {
      throw new HttpsError('failed-precondition', 'This group already has a 1983 wage — nothing to arbitrate.')
    }
    if (status !== 'completed' && status !== 'deadlocked') {
      throw new HttpsError('failed-precondition', 'This group has not finished 1983 yet.')
    }

    // The Union branch pays the group's OWN 1978 wage. A group that reached NO 1978 deal keeps the
    // status-quo contract, so its 1978 wage is $10.69 (Part B) — every group now always has a 1978
    // wage, so arbitration never blocks on "resolve 1978 first".
    const w78 = wage78OrStatusQuo(gdata['outcome'] as Record<string, unknown> | null)

    // Seed: fixed (deterministic) from the emulator harness; crypto-random at click in prod.
    const seed = (isEmulator && typeof data['seed'] === 'number')
      ? (data['seed'] as number)
      : randomInt(0, 0xffffffff)
    const result = drawArbitration(seed, w78)

    await instanceRef.collection('groups').doc(groupId).update({
      ...setRoundOutcome(slot, { [WAGE83_FIELD]: result.wage }),
      status: 'completed',
      arbitration_1983: {
        side: result.side,
        wage: result.wage,
        resolved_at: FieldValue.serverTimestamp(),
      },
    })

    return {
      ok: true as const,
      group_id: groupId,
      side: result.side,
      wage: result.wage,
      w78,
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[resolveArbitration] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})
