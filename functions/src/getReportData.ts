import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import type { Outcome } from '@mygames/game-engine'
import {
  extractInstructorGameId,
  clampRoundIndex,
  resolveRoundSlot,
  getRoundOutcome,
} from '@mygames/game-server'
import { computeRawScore, baxterGameDef } from './gameDefinition'
import { isRatified1978, baxterNoDeal1978 } from './ratification1978'
import { effectiveWage78, effectiveWage78OrStatusQuo, wage83FromOutcome, classAvg1983, adjustmentPct, type BaxterRole } from './transform1983'
import { score1985, baxterNoDeal1985, UNION_1985_NO_DEAL } from './score1985'

// Exported so updateGroupContract can build identical rows without duplicating these.
export const VALID_ROLES = new Set(['baxter', 'union'])

// Free-text questions that get a per-question report (Winemaster format). TWO for Baxter:
//   1. the prepDefaults issue-ranking reflection (format 'text', role_target 'all'), and
//   2. the post-1978 'debrief_reflection' — a FIXED reflection the shared Results/reaffirm screen
//      writes for every student ("Reflect on your negotiation experience."). It is NOT a prepDefaults
//      question, so it is appended here explicitly. Both are open-response; the graded MC (format
//      'multiple_choice') are auto-graded and deliberately get NO text report (matches Winemaster).
export const TEXT_QUESTIONS = [
  ...(baxterGameDef.prepDefaults ?? [])
    .filter(q => q.format === 'text' && !q.hidden)
    .map(q => ({ field: q.field, prompt: q.prompt, role_target: q.role_target })),
  { field: 'debrief_reflection', prompt: 'Reflect on your negotiation experience.', role_target: 'all' },
]

export const TEXT_FIELDS = TEXT_QUESTIONS.map(q => q.field)

// Likert (1–7) debrief questions ("Looking ahead to 1985") — surfaced for the Likert TABLE report.
// Distinct from TEXT_QUESTIONS (format 'text'); ordered by their declared `order` so the report
// columns read relationship → trust → expected difficulty. Answers persist as top-level participant
// fields (LookingAhead writes each q.field), read here the same way text answers are.
export const LIKERT_QUESTIONS = (baxterGameDef.prepDefaults ?? [])
  .filter(q => q.format === 'likert' && !q.hidden)
  .slice()
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  .map(q => ({ field: q.field, prompt: q.prompt, role_target: q.role_target }))

export const LIKERT_FIELDS = LIKERT_QUESTIONS.map(q => q.field)

const def = baxterGameDef
const ROUNDS = def.rounds ?? []
const IDX_1983 = ROUNDS.indexOf('1983')
const IDX_1985 = ROUNDS.indexOf('1985')

export type Arb1983 = { side: 'baxter' | 'union'; wage: number } | null

/**
 * One report row per finalized, role-bearing participant, carrying EVERY per-round Baxter figure
 * the three reports (1978 / 1983 / 1985) render. Per-round scores mirror scoreAndRecord's math
 * (same pure functions) so `total` equals the participant's terminal raw_score.
 */
export type ReportRow = {
  participant_id: string
  display_name: string
  group_number: number | null
  /** Group doc id — the edit target for updateGroupContract (group_number is only a display index). */
  group_id: string | null
  role: string
  /** Terminal raw_score as stored on the participant doc (= `total` when 1985 has been scored). */
  raw_score: number | null
  /** Keyed by question field; only present when the student submitted a non-empty answer. */
  text_answers: Record<string, string>
  /** Likert (1–7) ratings keyed by debrief question field; present only when the student answered. */
  likert_answers: Record<string, string>

  // ── 1978 ──────────────────────────────────────────────────────────────────
  /** The group's agreed 1978 six-issue contract (null = no deal). Populates the edit form + report. */
  outcome_1978: Record<string, unknown> | null
  /** Whether the group reached a 1978 deal (Notes: Deal / No deal). */
  agreement_1978: boolean
  /** Whether the 1978 deal RATIFIED (Deloitte + Transfer≥Most). A reached-but-unratified deal is
   *  scored/displayed as a no-deal ("No deal (failed ratification)"). false when no deal reached. */
  ratified_1978: boolean
  /** The group's 1978 wage — negotiated, or the $10.69 status-quo for a no-deal OR failed-ratify
   *  group (Part B / Part 3.9: a void contract keeps the current wage). */
  wage_1978: number
  /** The 1978 base score (ratified deal sum, or the 1978 no-deal value). */
  score_1978: number | null
  /** Optional free-text Notes from the 1978 outcome ('' or null when blank/no deal). */
  notes: string | null

  // ── 1983 ──────────────────────────────────────────────────────────────────
  /** The group's 1983 wage — negotiated OR arbitrated (null until 1983 resolves). */
  wage_1983: number | null
  /** Arbitration record when the 1983 wage was set by arbitration (else null). */
  arb_1983: Arb1983
  /** Adjusted-1978 score after the 1983 wage transform (null until 1983 applies). */
  score_1983: number | null

  // ── 1985 ──────────────────────────────────────────────────────────────────
  /** The group's agreed 1985 six-issue contract (null = no deal). */
  outcome_1985: Record<string, unknown> | null
  /** The independent 1985 score (null until 1985 applies). */
  score_1985: number | null
  /** TOTAL = adjusted-1978 + 1985 (equals the terminal raw_score). */
  total_score: number | null
}

/**
 * Build the full report-row set for an instance. Shared by getReportData and updateGroupContract
 * so both return byte-identical rows (and so a post-edit refresh recomputes the cross-group
 * 1978 no-deal base for EVERY group, not just the edited one). Reads groups + participants +
 * config + attendance + the round pointer, then computes each participant's per-round figures
 * with the same pure functions scoreAndRecord uses.
 */
export async function buildReportRows(
  instanceRef: admin.firestore.DocumentReference,
  gameInstanceId: string,
): Promise<ReportRow[]> {
  const rtdb = admin.database()

  const [participantsSnap, groupsSnap, configSnap, instanceSnap, attendingSnap] = await Promise.all([
    instanceRef.collection('participants').get(),
    instanceRef.collection('groups').get(),
    instanceRef.collection('config').doc('main').get(),
    instanceRef.get(),
    rtdb.ref(`game_instances/${gameInstanceId}/attendance`).get(),
  ])

  const configData = (configSnap.data() ?? {}) as Record<string, unknown>
  const attending = (attendingSnap.val() ?? {}) as Record<string, { display_name?: string } | null>
  const currentIdx = clampRoundIndex(ROUNDS.length, instanceSnap.data()?.['current_round'])

  // Stable 1-based group numbers by sorted doc id (matches every other Baxter surface).
  const sortedGroups = groupsSnap.docs.slice().sort((a, b) => a.id.localeCompare(b.id))
  const groupNumberMap = new Map<string, number>(sortedGroups.map((g, i) => [g.id, i + 1]))

  // ── Per-group per-round data ────────────────────────────────────────────────
  const slot1983 = resolveRoundSlot(ROUNDS, IDX_1983 < 0 ? 0 : IDX_1983)
  const slot1985 = resolveRoundSlot(ROUNDS, IDX_1985 < 0 ? 0 : IDX_1985)

  type GroupInfo = {
    outcome1978: Record<string, unknown> | null
    ratified: boolean
    w78: number | null
    wage78Display: number
    w83: number | null
    arb: Arb1983
    outcome1985: Record<string, unknown> | null
  }
  const groupInfo = new Map<string, GroupInfo>()
  for (const gdoc of groupsSnap.docs) {
    const d = gdoc.data() as Record<string, unknown>
    const outcome1978 = (d['outcome'] as Record<string, unknown> | null) ?? null
    const rawArb = d['arbitration_1983'] as { side?: unknown; wage?: unknown } | undefined
    const arb: Arb1983 = rawArb && (rawArb.side === 'baxter' || rawArb.side === 'union') && typeof rawArb.wage === 'number'
      ? { side: rawArb.side, wage: rawArb.wage }
      : null
    groupInfo.set(gdoc.id, {
      outcome1978,
      ratified: isRatified1978(outcome1978),
      w78: effectiveWage78(outcome1978),
      wage78Display: effectiveWage78OrStatusQuo(outcome1978),
      w83: IDX_1983 >= 0 ? wage83FromOutcome(getRoundOutcome(d, slot1983)) : null,
      arb,
      outcome1985: IDX_1985 >= 0 ? getRoundOutcome(d, slot1985) : null,
    })
  }

  // ── Cross-group aggregates (mirror scoreAndRecord) ──────────────────────────
  const ratifiedBaxterScores: number[] = []
  for (const gi of groupInfo.values()) {
    if (gi.ratified) ratifiedBaxterScores.push(computeRawScore('baxter', gi.outcome1978 as Outcome | null, configData))
  }
  const baxterNoDeal1978Value = baxterNoDeal1978(ratifiedBaxterScores)

  const w83Avg = classAvg1983([...groupInfo.values()].map(gi => gi.w83))
  const transformActive = IDX_1983 >= 0 && currentIdx >= IDX_1983 && w83Avg !== null

  const apply1985 = IDX_1985 >= 0 && currentIdx >= IDX_1985
  const dealerBaxter1985: number[] = []
  for (const gi of groupInfo.values()) if (gi.outcome1985 != null) dealerBaxter1985.push(score1985('baxter', gi.outcome1985))
  const baxterNoDeal1985Value = baxterNoDeal1985(dealerBaxter1985)

  // ── Per-participant rows ────────────────────────────────────────────────────
  const rows: ReportRow[] = []
  for (const pdoc of participantsSnap.docs) {
    const d = pdoc.data() as Record<string, unknown>
    if (d['finalized_at'] == null) continue
    const role = d['role'] as string | undefined
    if (!role || !VALID_ROLES.has(role)) continue
    if (d['raw_score'] === null || d['raw_score'] === undefined) continue

    const groupId = (d['group_id'] as string | undefined) ?? null
    const gi = groupId ? groupInfo.get(groupId) : undefined

    const rtdbName = attending[pdoc.id]?.display_name?.trim()
    const fsName   = ((d['display_name'] ?? d['name'] ?? '') as string).trim()
    const display_name = rtdbName || fsName || `${pdoc.id.slice(0, 8)}…`

    const text_answers: Record<string, string> = {}
    for (const field of TEXT_FIELDS) {
      const val = d[field]
      if (typeof val === 'string' && val.trim()) text_answers[field] = val.trim()
    }
    // Likert ratings (stored as strings '1'–'7' by LookingAhead) — same top-level read as text.
    const likert_answers: Record<string, string> = {}
    for (const field of LIKERT_FIELDS) {
      const val = d[field]
      if (val != null && String(val).trim()) likert_answers[field] = String(val).trim()
    }

    // 1978 base: a ratified deal keeps its summed score; a no-deal / failed-ratification group
    // scores as the 1978 no-deal (Baxter min-ratified+5 / degenerate 50; Union 0).
    const outcome1978 = gi?.outcome1978 ?? null
    const ratified = gi?.ratified ?? false
    const score_1978 = ratified
      ? computeRawScore(role, outcome1978 as Outcome | null, configData)
      : (role === 'baxter' ? baxterNoDeal1978Value : 0)

    // 1983 adjustment (percentage-points) onto the 1978 base — same gate scoreAndRecord uses.
    const w78 = gi?.w78 ?? null
    const w83 = gi?.w83 ?? null
    const adj = (transformActive && w83 != null && w78 != null)
      ? adjustmentPct(role as BaxterRole, w83, w78, w83Avg as number)
      : 0
    const score_1983 = transformActive ? score_1978 + adj : null

    // 1985 score + total (= terminal raw). Union no-deal 60; Baxter no-deal = dealer avg / 50.
    const outcome1985 = gi?.outcome1985 ?? null
    const score_1985 = apply1985
      ? (outcome1985 != null
          ? score1985(role as BaxterRole, outcome1985)
          : (role === 'union' ? UNION_1985_NO_DEAL : baxterNoDeal1985Value))
      : null
    const base1983 = score_1983 ?? score_1978
    const total_score = apply1985 ? base1983 + (score_1985 as number) : null

    rows.push({
      participant_id: pdoc.id,
      display_name,
      group_number: groupId ? (groupNumberMap.get(groupId) ?? null) : null,
      group_id: groupId,
      role,
      raw_score: d['raw_score'] as number,
      text_answers,
      likert_answers,
      outcome_1978: outcome1978,
      agreement_1978: outcome1978 != null,
      ratified_1978: ratified,
      wage_1978: gi?.wage78Display ?? effectiveWage78OrStatusQuo(null),
      score_1978,
      notes: outcome1978 ? ((outcome1978['notes'] as string | undefined) ?? null) : null,
      wage_1983: w83 ?? (gi?.arb ? gi.arb.wage : null),
      arb_1983: gi?.arb ?? null,
      score_1983,
      outcome_1985: outcome1985,
      score_1985,
      total_score,
    })
  }

  // Sort by group number then display name for a predictable default order.
  rows.sort((a, b) => {
    const gn = (a.group_number ?? Infinity) - (b.group_number ?? Infinity)
    if (gn !== 0) return gn
    return a.display_name.localeCompare(b.display_name)
  })
  return rows
}

export const getReportData = onCall({ cors: def.corsOrigins }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  try {
    const instanceRef = admin.firestore().collection('game_instances').doc(gameInstanceId)
    const configSnap = await instanceRef.collection('config').doc('main').get()
    const configData = (configSnap.data() ?? {}) as Record<string, unknown>

    const rows = await buildReportRows(instanceRef, gameInstanceId)

    // Authoritative contract schema, straight from the game definition — the report page renders
    // its inline editor from THIS, never the (drift-prone) client mirror. scheme1978: the class-
    // level 1978 scoring scheme (or null if never entered) so the report-grid entry tile can load
    // current values without a second round-trip.
    return {
      ok: true as const,
      rows,
      questions: TEXT_QUESTIONS,
      likertQuestions: LIKERT_QUESTIONS,
      schema: def.outcomeSchema,
      scheme1978: (configData['scheme1978'] ?? null) as unknown,
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[getReportData] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})
