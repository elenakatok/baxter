/**
 * Baxter 1978 scoring baseline — SINGLE SOURCE OF TRUTH for the known-good scheme + deal
 * that reproduce the Slice-1 hand-verified result: Baxter 85 / Union 62.
 *
 * Consumed by BOTH:
 *   • the test launcher's "Prefill 1978 scores" button (classroom/tools/launcher/server.mjs),
 *     which writes SCHEME_1978 to a selected instance's config/main.scheme1978; and
 *   • the Baxter day-2 Playwright playthrough (games/baxter/baxter-playthrough.mjs), which
 *     seeds SCHEME_1978 and drives the lead to enter CANONICAL_1978_OUTCOME, then asserts the
 *     scored result equals EXPECTED_1978_SCORES.
 *
 * The scorer (functions/src/gameDefinition.ts → computeScoreBreakdown) sums, per role, the
 * per-option score of the option the group agreed on across the six 1978 issues; blanks = 0.
 * So the pair below is what makes the sum land on 85 / 62:
 *
 *   Baxter agreed-option scores:  10 + 20 + 15 + 15 + 10 + 15 = 85
 *   Union  agreed-option scores:  18 +  8 + 10 +  8 +  8 + 10 = 62
 *
 * NOTE: the ORIGINAL instructor-entered numbers from the Slice-1 manual test were never
 * committed to the repo (they lived only in a live instance's config). These values are a
 * fresh, internally-consistent scheme that reproduces the same 85/62 target for a fixed deal.
 * If the exact historical numbers surface, swap them in here — both consumers update at once.
 */

/** The agreed deal the playthrough's lead enters. Option keys match baxterSchema. */
export const CANONICAL_1978_OUTCOME = {
  wages:           'increase_top3',
  plant_operation: 'maintain_autonomy',
  escalator:       'maintain',
  incentive:       'maintain',
  location:        'deloitte',
  transfer:        'most',
  notes:           '',
}

/** Expected raw_score per role for CANONICAL_1978_OUTCOME under SCHEME_1978. */
export const EXPECTED_1978_SCORES = { baxter: 85, union: 62 }

/**
 * Full class-level 1978 scheme: issueId → optionId → score, per role. Every option carries a
 * plausible score (a realistic instructor scheme), but only the CANONICAL_1978_OUTCOME options
 * feed the sum. Shape matches config/main.scheme1978 = { baxter: { optionScores }, union: {...} }.
 */
export const SCHEME_1978 = {
  baxter: {
    optionScores: {
      wages:           { above_top3: 0,  current: 20, increase_top3: 10 },              // agreed increase_top3 = 10
      plant_operation: { higher_autonomy: 5, higher_mgmt: 25, maintain_autonomy: 20, maintain_mgmt: 22 }, // agreed maintain_autonomy = 20
      escalator:       { eliminate: 20, maintain: 15, reduce: 18 },                     // agreed maintain = 15
      incentive:       { eliminate: 20, maintain: 15, reduce: 17, individual: 22 },     // agreed maintain = 15
      location:        { deloitte: 10, elsewhere: 5 },                                  // agreed deloitte = 10
      transfer:        { all: 8, most: 15, some: 20 },                                  // agreed most = 15
    },
  },
  union: {
    optionScores: {
      wages:           { above_top3: 25, current: 5,  increase_top3: 18 },              // agreed increase_top3 = 18
      plant_operation: { higher_autonomy: 20, higher_mgmt: 4, maintain_autonomy: 8, maintain_mgmt: 6 },   // agreed maintain_autonomy = 8
      escalator:       { eliminate: 2,  maintain: 10, reduce: 6 },                      // agreed maintain = 10
      incentive:       { eliminate: 4,  maintain: 8,  reduce: 6,  individual: 3 },      // agreed maintain = 8
      location:        { deloitte: 8,  elsewhere: 12 },                                 // agreed deloitte = 8
      transfer:        { all: 15, most: 10, some: 4 },                                  // agreed most = 10
    },
  },
}

/** The six 1978 issue ids the scorer sums over (enum fields only; `notes` is excluded). */
export const ISSUE_KEYS_1978 = ['wages', 'plant_operation', 'escalator', 'incentive', 'location', 'transfer']
