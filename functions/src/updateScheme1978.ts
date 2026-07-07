import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import { baxterGameDef } from './gameDefinition'

/**
 * Instructor-only. Writes the class-level 1978 scoring scheme to
 * game_instances/{id}/config/main.scheme1978 (same doc/pattern as all class-level
 * config). The scheme is one per-option score column per role — NO weights are
 * entered, checked, or stored (the platform does not check weights at all).
 *
 * The scorer (gameDefinition.computeScoreBreakdown) reads this via configData and
 * sums the entered score for each agreed option. Blank/missing scores count as 0.
 *
 * Instance is derived from the instructor's auth (same as getReportData /
 * updateGroupContract) — the client cannot target another instance.
 *
 * Input:  { scheme1978: { baxter: { optionScores: {issue:{option:number}} }, union: {...} } }
 * Output: { ok, scheme1978 } — the sanitized scheme actually stored.
 */

const ROLE_KEYS = ['baxter', 'union'] as const
type RoleKey = typeof ROLE_KEYS[number]

type OptionScores = Record<string, Record<string, number>>

// Valid issue → option ids, straight from the canonical outcome schema (enum fields only).
// Anything not in here is dropped, so junk keys can never reach the stored scheme.
const ISSUE_OPTIONS: Record<string, Set<string>> = Object.fromEntries(
  baxterGameDef.outcomeSchema
    .filter((f): f is { key: string; type: 'enum'; options: string[] } => f.type === 'enum')
    .map(f => [f.key, new Set(f.options)]),
)

/** Rebuild a sanitized optionScores from client input: known issue/option ids only, finite numbers only. */
function sanitizeOptionScores(raw: unknown): OptionScores {
  const out: OptionScores = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [issue, opts] of Object.entries(raw as Record<string, unknown>)) {
    const validOpts = ISSUE_OPTIONS[issue]
    if (!validOpts || !opts || typeof opts !== 'object') continue
    for (const [optionId, val] of Object.entries(opts as Record<string, unknown>)) {
      if (!validOpts.has(optionId)) continue
      const n = typeof val === 'number' ? val : Number(val)
      if (Number.isFinite(n)) {
        (out[issue] ??= {})[optionId] = n
      }
    }
  }
  return out
}

export const updateScheme1978 = onCall({ cors: baxterGameDef.corsOrigins }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const provided = data['scheme1978']
  if (!provided || typeof provided !== 'object' || Array.isArray(provided)) {
    throw new HttpsError('invalid-argument', 'scheme1978 must be an object.')
  }

  // Rebuild server-side: one optionScores map per role. No weight validation (per spec,
  // the platform does not check weights — instructor enters only the score column).
  const clean: Record<RoleKey, { optionScores: OptionScores }> = {
    baxter: { optionScores: {} },
    union:  { optionScores: {} },
  }
  for (const role of ROLE_KEYS) {
    const roleObj = (provided as Record<string, unknown>)[role]
    const os = (roleObj && typeof roleObj === 'object')
      ? (roleObj as Record<string, unknown>)['optionScores']
      : undefined
    clean[role].optionScores = sanitizeOptionScores(os)
  }

  try {
    const db = admin.firestore()
    const ref = db
      .collection('game_instances').doc(gameInstanceId)
      .collection('config').doc('main')

    await ref.set({ scheme1978: clean }, { merge: true })
    return { ok: true as const, scheme1978: clean }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[updateScheme1978] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})
