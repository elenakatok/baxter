/**
 * Baxter 1978 ratification gate + no-deal scoring (GAME-SPECIFIC, pure) — spec §3.
 *
 * RATIFICATION is a HARD DETERMINISTIC RULE (Gary-confirmed, Elena-locked) — NO probability,
 * NO roll. §3's original 0.99/0 probabilistic description is SUPERSEDED. After a 1978 deal
 * locks, the union ratifies iff BOTH keys of the agreed contract pass:
 *   • Location of New Plant = Deloitte           → stored enum key 'deloitte'  (else 'elsewhere' fails)
 *   • Transfer of Local 190 ≥ Most               → stored enum key 'all' OR 'most' (else 'some' fails)
 * Both pass → ratified → the negotiated 1978 score stands. Either fails → NOT ratified → the deal
 * is scored as a 1978 NO-DEAL, exactly like an explicit walk-away/ultimatum-reject.
 *
 * Stored values compared: the ENUM KEYS from baxterSchema (frontend/src/gameConfig.ts) — NOT the
 * human-readable labels. location ∈ {'deloitte','elsewhere'}; transfer ∈ {'all','most','some'}.
 *
 * 1978 NO-DEAL scoring (spec §3, both triggers — reject AND failed ratification — score identically):
 *   • Baxter = (minimum 1978 score among Baxters who reached AND ratified a deal) + 5. Cross-group.
 *   • Union  = 0 (flat).
 *   • DEGENERATE (zero ratified Baxter deals): "min + 5" is undefined. The spec states NO fallback.
 *     We do NOT invent one — baxterNoDeal1978 THROWS so the caller surfaces it (open question for
 *     Elena; mirrors the 1985 flat-reservation resolution, which 1978 lacks). See scoreAndRecord.
 */

/** 1978 outcome field keys + the passing values for the two ratification tests. */
export const RATIFY_LOCATION_KEY = 'location'
export const RATIFY_LOCATION_PASS = 'deloitte'                    // 'elsewhere' → fails
export const RATIFY_TRANSFER_KEY = 'transfer'
export const RATIFY_TRANSFER_PASS: ReadonlySet<string> = new Set(['all', 'most']) // ≥ Most; 'some' → fails

/** +5 offset applied to the minimum ratified Baxter score for the 1978 Baxter no-deal. */
export const BAXTER_1978_NO_DEAL_BONUS = 5

/**
 * Deterministic ratification (HARD RULE): Location = Deloitte AND Transfer ≥ Most.
 * A null/absent outcome (no deal reached) is NOT a ratified deal → false.
 */
export function isRatified1978(outcome: Record<string, unknown> | null | undefined): boolean {
  if (outcome == null) return false
  return outcome[RATIFY_LOCATION_KEY] === RATIFY_LOCATION_PASS
    && RATIFY_TRANSFER_PASS.has(outcome[RATIFY_TRANSFER_KEY] as string)
}

/** Thrown when the 1978 Baxter no-deal is needed but NO Baxter reached a ratified deal. */
export class BaxterNoDeal1978Degenerate extends Error {
  constructor() {
    // TODO(Elena): the spec defines no fallback for "min ratified Baxter + 5" when zero Baxters
    // ratified a deal. Do NOT invent a number here — this is an open design question (the 1985
    // degenerate case resolved to a flat reservation value; 1978 has none). Surfaced, not silenced.
    super('1978 Baxter no-deal is undefined: zero Baxters reached a ratified deal (min+5 has no base). Elena must define a fallback.')
    this.name = 'BaxterNoDeal1978Degenerate'
  }
}

/**
 * Baxter 1978 no-deal score = (minimum ratified Baxter deal score) + 5.
 * @param ratifiedBaxterScores summed 1978 scores of every Baxter that reached a RATIFIED deal.
 * THROWS BaxterNoDeal1978Degenerate on an empty pool (no invented number — flag for Elena).
 */
export function baxterNoDeal1978(ratifiedBaxterScores: number[]): number {
  if (ratifiedBaxterScores.length === 0) throw new BaxterNoDeal1978Degenerate()
  return Math.min(...ratifiedBaxterScores) + BAXTER_1978_NO_DEAL_BONUS
}
