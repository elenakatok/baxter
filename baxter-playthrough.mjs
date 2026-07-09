/**
 * Baxter day-2 EMULATOR play-through — 4 students (2 Baxter + 2 Local 190), 1 group.
 *
 * A real-browser Playwright regression harness for the day-2 flow. Adapted from Winemaster's
 * wm-playthrough.mjs, but retargeted from LIVE to the local EMULATOR: students bootstrap via
 * the DEV `?_pid=&_gid=` _test bypass (no classroom tokens), the instructor is driven via the
 * `_dev` emulator bypass on the callables + the real dashboard buttons for the two day-2 gates,
 * and all reads hit the emulator Firestore REST endpoint.
 *
 * It walks: setup → 1978 attendance → match → 1978 negotiation to a canonical deal → Score &
 * Record → "Open Round 2 Attendance" → 1983 re-attendance → "Begin 1983" → 1983 negotiation,
 * asserting today's fixed bugs as REGRESSIONS so they fail loudly if they come back:
 *   • Bug A — a student who completed 1978 is routed to the day-2 CODE screen (not stranded on results).
 *   • Bug F — on round-2 pre-Begin, the student sees a WAITING state with NO clickable Start button;
 *             it advances only AFTER "Begin 1983" re-opens the group.
 *   • #1   — "Open Round 2 Attendance" is HIDDEN until every round-1 group is completed.
 *   • B    — "Begin 1983" does not re-appear once the round has begun.
 *   • Scoring — the canonical 1978 deal resolves to Baxter 85 / Union 62.
 *   • 1983 wage-only form — TODO (Slice 3 has not built it yet); marked, not failed.
 *
 * ── ONE-COMMAND RUN ──────────────────────────────────────────────────────────
 *   0. One-time: install playwright at the Baxter repo root (it's a declared devDependency,
 *      chromium is already cached): from games/baxter →  npm install
 *   1. Start emulators + Vite dev server (one terminal):
 *        games/baxter/start-local.sh
 *   2. Run the play-through (another terminal), from the Baxter repo root (where playwright resolves):
 *        cd games/baxter && node baxter-playthrough.mjs
 *   Env: HEADED=1 to watch the browsers; SLOWMO=80 to slow clicks.
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  SCHEME_1978,
  CANONICAL_1978_OUTCOME,
  EXPECTED_1978_SCORES,
} from './scoring/scheme1978-baseline.mjs'

// ── Config ─────────────────────────────────────────────────────────────────────

const PROJECT       = 'baxter-mygames-live'
const FE            = process.env.FE_BASE   ?? 'http://localhost:5173'
const FUNCTIONS     = process.env.FN_BASE   ?? `http://localhost:5005/${PROJECT}/us-central1`
const FIRESTORE     = process.env.FS_BASE   ?? `http://localhost:8082/v1/projects/${PROJECT}/databases/(default)/documents`
const HEADED        = process.env.HEADED === '1'
const SLOWMO        = process.env.SLOWMO ? Number(process.env.SLOWMO) : 0

// A fresh instance id per run so re-runs never collide. (Date.now is fine in a plain script.)
const GID = process.env.GID ?? `pt-${Date.now()}`
// FOUR groups (Slice 5): 16 students → 8 Baxter + 8 Local 190 → four groups of 2+2.
//   • Two RATIFIED DEALER groups (A,B) reach a 1978 deal that PASSES ratification (canonical:
//     Location=Deloitte, Transfer=Most). They drive the 1983 transform (A agrees $9.50; B no-deals
//     → arbitration $8.67) and the 1985 round (A deals Deal B; B ultimatum-rejects).
//   • One REJECTER group (C) hits the 1978 ULTIMATUM reject → terminal no-deal (Bug E). Idle after.
//   • One FAILED-RATIFICATION dealer (D) reaches a 1978 DEAL but with Transfer=Some → NOT ratified
//     → scored as a 1978 no-deal (Slice 5), exactly like C. Idle in 1983/1985.
// C and D both exercise the 1978 no-deal scoring (Baxter = min RATIFIED-Baxter + 5; Union = 0);
// D also proves the min uses ONLY ratified deals (its own lower deal sum is excluded).
const PIDS = [
  'stu-1', 'stu-2', 'stu-3', 'stu-4', 'stu-5', 'stu-6', 'stu-7', 'stu-8',
  'stu-9', 'stu-10', 'stu-11', 'stu-12', 'stu-13', 'stu-14', 'stu-15', 'stu-16',
]

const ROLE_RADIO = {
  baxter: 'Baxter Management — the Adam Baxter Company management team',
  union:  'Local 190 — the union bargaining committee',
}

// ── Tiny test harness ──────────────────────────────────────────────────────────

let PASS = 0, FAIL = 0
const sleep  = ms => new Promise(r => setTimeout(r, ms))
const log    = (tag, msg) => console.log(`[${tag}] ${msg}`)
const banner = msg => console.log('\n' + '─'.repeat(66) + '\n' + msg + '\n' + '─'.repeat(66))
function assert(cond, name) {
  if (cond) { PASS++; console.log(`  ✓ ASSERT: ${name}`) }
  else      { FAIL++; console.log(`  ✗ ASSERT FAILED: ${name}`) }
}

// ── On-failure diagnostics (DIAGNOSTIC ONLY — never affects pass/fail) ──────────
// On any assertion timeout/throw, or any run that ends with failures, dump each live
// page's actual visible <h1> heading + URL and a full-page screenshot, so a failing run
// tells us definitively which screen every student/the dashboard is stuck on.

let browser = null
const students = []           // { page, pid, role } — populated as students are set up
let dash = null               // instructor dashboard page
const ARTIFACT_DIR = path.resolve(process.cwd(), 'playthrough-artifacts', GID)

async function headingText(page) {
  try {
    const hs = (await page.locator('h1').allTextContents()).map(h => h.trim()).filter(Boolean)
    return hs.length ? hs.join(' | ') : '(no <h1> visible)'
  } catch { return '(could not read <h1>)' }
}

async function dumpDiagnostics(reason) {
  console.log('\n' + '═'.repeat(66))
  console.log('DIAGNOSTIC DUMP — ' + reason)
  console.log('═'.repeat(66))
  try { mkdirSync(ARTIFACT_DIR, { recursive: true }) } catch { /* best effort */ }
  const targets = [
    ...students.map(s => ({ label: s.pid, page: s.page })),
    ...(dash ? [{ label: 'dashboard', page: dash }] : []),
  ]
  for (const { label, page } of targets) {
    if (!page) continue
    const heading = await headingText(page)
    let url = '(unknown)'; try { url = page.url() } catch { /* page may be closed */ }
    let shot = path.join(ARTIFACT_DIR, `${label}.png`)
    try { await page.screenshot({ path: shot, fullPage: true }) } catch (e) { shot = `(screenshot failed: ${e.message})` }
    console.log(`  [${label}]  heading: ${heading}`)
    console.log(`  ${' '.repeat(label.length)}   url: ${url}`)
    console.log(`  ${' '.repeat(label.length)}   shot: ${shot}`)
  }
  console.log('═'.repeat(66) + '\n')
}

// ── Emulator callable + Firestore helpers ──────────────────────────────────────

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { throw new Error(`${name} → HTTP ${res.status}: ${text.slice(0, 200)}`) }
  if (json.error) throw new Error(`${name} → ${json.error.message ?? JSON.stringify(json.error)}`)
  return json.result
}
// Instructor calls travel with the emulator _dev bypass (no JWT needed in the emulator).
const inst = (name, extra = {}) => callFn(name, { _dev: { game_instance_id: GID }, ...extra })

async function fsGetDocs(collection) {
  const res = await fetch(`${FIRESTORE}/game_instances/${GID}/${collection}?pageSize=100`, {
    headers: { Authorization: 'Bearer owner' },
  })
  if (!res.ok) return []
  return (await res.json()).documents ?? []
}
const strVal = f => f?.stringValue ?? ''
const numVal = f => (f?.integerValue != null ? parseInt(f.integerValue, 10) : (f?.doubleValue ?? null))

async function readParticipants() {
  const docs = await fsGetDocs('participants')
  return docs.map(d => ({
    id:        d.name.split('/').pop(),
    role:      strVal(d.fields?.role),
    is_lead:   d.fields?.is_lead?.booleanValue ?? false,
    raw_score: numVal(d.fields?.raw_score),
    group_id:  strVal(d.fields?.group_id),
  }))
}
async function readGroupStatus() {
  const docs = await fsGetDocs('groups')
  return docs.map(d => ({ id: d.name.split('/').pop(), status: strVal(d.fields?.status) }))
}
async function pollGroupsStatus(pred, maxMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const gs = await readGroupStatus()
    if (gs.length && pred(gs)) return gs
    await sleep(1000)
  }
  return readGroupStatus()
}

// Full group read incl. the 1983 keyed wage + arbitration marker + the 1985 wage (nested
// mapValue in REST).
async function readGroupsFull() {
  const docs = await fsGetDocs('groups')
  return docs.map(d => {
    const o1983 = d.fields?.outcomes_by_round?.mapValue?.fields?.['1983']?.mapValue?.fields
    const o1985 = d.fields?.outcomes_by_round?.mapValue?.fields?.['1985']?.mapValue?.fields
    const arb   = d.fields?.arbitration_1983?.mapValue?.fields
    return {
      id: d.name.split('/').pop(),
      status: strVal(d.fields?.status),
      agreement: d.fields?.agreement_reached?.booleanValue ?? null,
      wage83: o1983?.wage83 != null ? numVal(o1983.wage83) : null,
      wage85: o1985?.wage85 != null ? numVal(o1985.wage85) : null,
      arbSide: arb?.side ? strVal(arb.side) : null,
      arbWage: arb?.wage != null ? numVal(arb.wage) : null,
    }
  })
}
async function pollGroupsFull(pred, maxMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const gs = await readGroupsFull()
    if (gs.length && pred(gs)) return gs
    await sleep(1000)
  }
  return readGroupsFull()
}

/** Map browser students → their group, tagging each with is_lead/role from Firestore. */
function groupStudents(studs, parts) {
  const byPid = Object.fromEntries(parts.map(p => [p.id, p]))
  const groups = {}
  for (const s of studs) {
    const p = byPid[s.pid]
    if (!p?.group_id) continue
    ;(groups[p.group_id] ??= []).push({ ...s, is_lead: p.is_lead, role: p.role })
  }
  return groups
}
const near = (a, b, tol = 0.05) => typeof a === 'number' && Math.abs(a - b) <= tol

// ── Student page URL (DEV _test bypass) ─────────────────────────────────────────

const studentUrl = pid => `${FE}/?_pid=${pid}&_gid=${GID}&_session=tab`
const dashboardUrl = () => `${FE}/dashboard?_dev_game_instance_id=${encodeURIComponent(GID)}&_session=tab`

// ── Phase 1a: info → KC gate → (prep auto-skips) → hold ─────────────────────────

async function driveSetup(page, pid) {
  await page.goto(studentUrl(pid))
  await page.waitForSelector('p:has-text("Your role")', { timeout: 60_000 })
  const roleLabel = (await page.locator('h1').first().textContent()) ?? ''
  const role = roleLabel.toLowerCase().includes('baxter') ? 'baxter' : 'union'
  log(pid, `info: "${roleLabel}" (${role}) → Continue`)
  await page.click('button:has-text("Continue")')

  // KC role gate (Baxter has no graded static KC → completing the gate finishes KC; prep is empty → auto-skips).
  await page.waitForSelector('text=What is your role in this negotiation?', { timeout: 30_000 })
  await page.getByRole('radio', { name: ROLE_RADIO[role], exact: true }).click()
  await page.click('button:has-text("Submit")')

  await page.waitForSelector('h1:has-text("Preparation complete")', { timeout: 30_000 })
  log(pid, '◆ hold screen')
  return { page, pid, role }
}

// ── Phase 1b: hold → confirmation → attendance code → waiting room ──────────────

async function driveToWaiting(s, code) {
  const { page, pid } = s
  await page.click('button:has-text("in class")')
  await page.waitForSelector('h1:has-text("Ready to negotiate?")', { timeout: 20_000 })
  await page.click("button:has-text(\"Yes, I'm ready\")")
  await page.waitForSelector('h1:has-text("Enter attendance code")', { timeout: 20_000 })
  await page.locator('input').fill(code)
  await page.click('button[type="submit"]')
  await page.waitForSelector('h1:has-text("Waiting to be matched")', { timeout: 30_000 })
  log(pid, '★ waiting room')
}

// ── Day-2 re-attendance: wait for the live re-route to the code screen, then enter the code ──
// Corrected product behavior (Elena's manual walk + the confirmation re-entrancy fix): after the
// instructor clicks "Open Round 2 Attendance", the reactive router moves the student straight from
// their 1978 results to the "Enter attendance code" screen. There is NO "Preparation complete"
// hold and NO "Ready to negotiate?" confirmation in the day-2 path — that confirmation is
// round-1-only. So we simply wait for the code screen (allowing time for the live re-route) and
// submit. If the product ever bounced a re-attending student to confirmation again, this WOULD
// time out — that's intentional: the harness asserts the corrected flow, it does not paper over it.
async function reAttend(page, pid, code) {
  await page.waitForSelector('h1:has-text("Enter attendance code")', { timeout: 30_000 })
  await page.locator('input').fill(code)
  await page.click('button[type="submit"]')
  log(pid, 're-attended for 1983')
}

// ── 1978 negotiation: 2 groups ACCEPT (deal), 1 group ULTIMATUM-REJECTS ─────────

const ISSUE_ORDER = ['wages', 'plant_operation', 'escalator', 'incentive', 'location', 'transfer']

// A 1978 deal that FAILS ratification: Transfer=Some (< Most) so the deterministic gate rejects it,
// plus wages=above_top3 to give it a DISTINCT (lower) Baxter deal sum (80) than the ratified deals
// (85) — so the harness can prove the min+5 excludes this unratified deal (it scores 90, not 85/80).
const FAIL_RATIFY_1978_OUTCOME = { ...CANONICAL_1978_OUTCOME, wages: 'above_top3', transfer: 'some' }

/** Lead fills the six 1978 <select>s with a given outcome (does NOT submit). */
async function fill1978(leadPage, outcome) {
  await leadPage.waitForSelector('h1:has-text("Report outcome")', { timeout: 30_000 })
  const selects = leadPage.locator('select')
  for (let i = 0; i < ISSUE_ORDER.length; i++) {
    await selects.nth(i).selectOption(outcome[ISSUE_ORDER[i]])
  }
}
const fillCanonical1978 = leadPage => fill1978(leadPage, CANONICAL_1978_OUTCOME)

/** Lead reports a 1978 deal (fills + reviews + submits); non-leads all Confirm (accept). */
async function drive1978Deal(members, outcome) {
  const lead = members.find(m => m.is_lead) ?? members[0]
  const nonLeads = members.filter(m => m !== lead)
  await fill1978(lead.page, outcome)
  await lead.page.click('button:has-text("Review & submit")')
  await lead.page.waitForSelector('h1:has-text("Confirm outcome")', { timeout: 10_000 })
  await lead.page.click('button:has-text("Yes, submit")')
  await Promise.all(nonLeads.map(async s => {
    await s.page.waitForSelector('h1:has-text("Confirm")', { timeout: 30_000 })
    await s.page.click('button:has-text("Confirm")')
  }))
}

// ── 1985 six-issue contract (Slice 4) — one wage input + five option selects (schema order) ──
const SELECT_ORDER_1985 = ['incentive85', 'work_rules85', 'hiring85', 'notices85', 'seniority85']
// The two frozen conformance deals (spec §5). Deal B → Baxter 97.95 / Union 9.55; Deal A → 10.51 / 89.49.
const DEAL_A_1985 = { wage85: '11.00', incentive85: 'above_quota', work_rules85: 'jointly_determined', hiring85: 'layoff_100',  notices85: 'yes', seniority85: 'all' }
const DEAL_B_1985 = { wage85: '9.00',  incentive85: 'none',        work_rules85: 'mgmt_control',       hiring85: 'no_priority', notices85: 'no',  seniority85: 'none' }

/** Lead fills the 1985 wage input + five option selects with a contract (does NOT submit). */
async function fill1985(leadPage, contract) {
  await leadPage.waitForSelector('h1:has-text("Report outcome")', { timeout: 30_000 })
  await leadPage.locator('input[type="number"]').fill(contract.wage85)
  const selects = leadPage.locator('select')
  for (let i = 0; i < SELECT_ORDER_1985.length; i++) {
    await selects.nth(i).selectOption(contract[SELECT_ORDER_1985[i]])
  }
}

async function drive1978Negotiation(students) {
  banner('1978 negotiation → 2 RATIFIED dealers (A,B), 1 REJECTER (C), 1 FAILED-RATIFICATION dealer (D)')
  // group reveal
  await Promise.all(students.map(async s => {
    await s.page.waitForSelector('h1:has-text("Your negotiation group")', { timeout: 60_000 })
    log(s.pid, 'group reveal')
  }))
  // one Start click per group; the rest auto-advance (or click as fallback)
  await students[0].page.click('button:has-text("Start negotiation")')
  await students[0].page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 20_000 })
  for (const s of students.slice(1)) {
    const flipped = await s.page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 12_000 }).then(() => true).catch(() => false)
    if (!flipped) { await s.page.click('button:has-text("Start negotiation")'); await s.page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 12_000 }) }
  }
  // Everyone taps "We've finished" so leads reach the report form and non-leads reach confirm.
  await Promise.all(students.map(s => s.page.click("button:has-text(\"We've finished\")").catch(() => {})))

  const parts = await readParticipants()
  const groups = groupStudents(students, parts)
  const gids = Object.keys(groups).sort()
  // Deterministic role split: last group = rejecter (C); second-last = failed-ratification dealer
  // (D); the rest = ratified dealers (A,B). (4 groups → ratified=[g0,g1], D=g2, C=g3.)
  const rejectGid = gids[gids.length - 1]
  const failRatifyGid = gids[gids.length - 2]
  const ratifiedGids = gids.filter(g => g !== rejectGid && g !== failRatifyGid)
  log('1978', `${gids.length} groups — ratified=${ratifiedGids.join(',')} · failRatify=${failRatifyGid} · rejecter=${rejectGid}`)

  // ── REJECTER group (C) FIRST (Bug E ultimatum) — its reject is a no-deal BEFORE any deal ──
  // Lead reports an offer, ONE receiver REJECTS → TERMINAL no-deal (no reset/redo/second offer).
  const rMembers = groups[rejectGid]
  const rLead = rMembers.find(m => m.is_lead) ?? rMembers[0]
  const rNonLeads = rMembers.filter(m => m !== rLead)
  await fill1978(rLead.page, CANONICAL_1978_OUTCOME)
  await rLead.page.click('button:has-text("Review & submit")')
  await rLead.page.waitForSelector('h1:has-text("Confirm outcome")', { timeout: 10_000 })
  await rLead.page.click('button:has-text("Yes, submit")')
  const rejecter = rNonLeads[0]
  await rejecter.page.waitForSelector('h1:has-text("Confirm")', { timeout: 30_000 })
  await rejecter.page.click('button:has-text("Reject")')
  log(rejectGid, `rejecter ${rejecter.pid} clicked Reject (1978 ultimatum)`)
  await pollGroupsFull(g => g.find(x => x.id === rejectGid)?.status === 'completed', 30_000)

  // ── DEGENERATE probe (Slice 5): score NOW — C is a no-deal Baxter but ZERO groups have a
  // ratified deal yet → "min ratified + 5" is undefined → scoreAndRecord MUST error (not NaN). ──
  let degenThrew = false
  try { await inst('scoreAndRecord') } catch { degenThrew = true }
  assert(degenThrew,
    '1978 DEGENERATE guard — scoreAndRecord ERRORS when a Baxter no-deal exists but 0 ratified deals (no silent NaN; Elena fallback TBD)')

  // ── RATIFIED dealers (A,B): canonical deal (Location=Deloitte, Transfer=Most) → ratifies ──
  await Promise.all(ratifiedGids.map(async gid => {
    await drive1978Deal(groups[gid], CANONICAL_1978_OUTCOME)
    log(gid, 'ratified dealer — canonical 1978 deal accepted')
  }))

  // ── FAILED-RATIFICATION dealer (D): a real DEAL, but Transfer=Some → gate rejects → no-deal ──
  await drive1978Deal(groups[failRatifyGid], FAIL_RATIFY_1978_OUTCOME)
  log(failRatifyGid, 'failed-ratification dealer — 1978 DEAL accepted (Transfer=Some → NOT ratified)')

  // Wait: ratified dealers completed (deal); rejecter + failed-ratify completed.
  const gs = await pollGroupsFull(g =>
    [...ratifiedGids, failRatifyGid, rejectGid].every(id => g.find(x => x.id === id)?.status === 'completed'), 40_000)
  const rj = gs.find(x => x.id === rejectGid)
  assert(ratifiedGids.every(id => gs.find(x => x.id === id)?.status === 'completed' && gs.find(x => x.id === id)?.agreement === true),
    '1978 ACCEPT — ratified dealer groups reach a "completed" DEAL')
  assert(gs.find(x => x.id === failRatifyGid)?.status === 'completed' && gs.find(x => x.id === failRatifyGid)?.agreement === true,
    '1978 FAILED-RATIFY dealer reaches a "completed" DEAL (agreement true — ratification is a scoring rule, not a lock rule)')
  assert(rj?.status === 'completed' && rj?.agreement === false,
    '1978 ULTIMATUM REJECT — reject reaches TERMINAL no-deal (completed, no agreement; not reset/deadlocked)')
  // No redo / no second offer: the reject lead must NOT be sitting on a fresh report form.
  const leadOnReportForm = await rLead.page.locator('h1:has-text("Report outcome")').isVisible().catch(() => false)
  assert(!leadOnReportForm,
    '1978 ULTIMATUM REJECT — no redo: reject lead is NOT returned to the report form (no second offer)')

  const dealerMemberPids = ratifiedGids.flatMap(id => groups[id].map(m => m.pid))
  return { ratifiedGids, failRatifyGid, rejectGid, dealerMemberPids }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  banner(`Baxter day-2 EMULATOR play-through — instance ${GID}`)
  console.log(`Frontend ${FE} · Functions ${FUNCTIONS} · Firestore ${FIRESTORE}\n`)

  // 0. Seed the known-good 1978 scheme (shared single source with the launcher's Prefill).
  await inst('updateScheme1978', { scheme1978: SCHEME_1978 })
  log('seed', 'scheme1978 written (85/62 baseline)')

  browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO })

  // 1. Setup all 4 students (sequential → deterministic 2 Baxter / 2 Local 190 role balance).
  for (const pid of PIDS) {
    const ctx = await browser.newContext()
    students.push(await driveSetup(await ctx.newPage(), pid))
  }
  const roles = students.map(s => s.role)
  log('setup', `roles: ${roles.join(', ')}`)

  // 2. Instructor generates the 1978 attendance code; students confirm to the waiting room.
  const { code } = await inst('generateAttendanceCode')
  log('instr', `1978 attendance code: ${code}`)
  await Promise.all(students.map(s => driveToWaiting(s, code)))

  // 3. Open the instructor dashboard (its own context) — used for #1/B assertions + the two gates.
  dash = await (await browser.newContext()).newPage()
  await dash.goto(dashboardUrl())
  await dash.waitForSelector('text=Round 1', { timeout: 30_000 }).catch(() => {})

  // #1 (part a): before round 1 is completed, "Open Round 2 Attendance" must be HIDDEN.
  await inst('triggerMatching')
  await pollGroupsStatus(g => g.some(x => x.status !== 'completed') || g.length > 0, 15_000)
  await dash.reload(); await sleep(2500)
  {
    const visible = await dash.locator('button:has-text("Open Round 2 Attendance")').isVisible().catch(() => false)
    assert(!visible, '#1 — "Open Round 2 Attendance" HIDDEN before round-1 groups complete')
  }

  // 4. 1978 negotiation → 2 ratified dealers (A,B), 1 rejecter (C), 1 failed-ratify dealer (D).
  const { ratifiedGids, failRatifyGid, rejectGid, dealerMemberPids } = await drive1978Negotiation(students)

  // 5. Score & Record → RATIFIED dealers score Baxter 85 / Union 62 (their negotiated score stands).
  //    Both no-deal groups (C reject + D failed-ratification) score the 1978 NO-DEAL: Baxter =
  //    min RATIFIED-Baxter (85) + 5 = 90; Union = 0. D's own deal sum is 80 (Transfer=Some) — the
  //    min EXCLUDES it (uses only ratified deals), so C and D both land on 90, NOT 85 (which is what
  //    a bug that included D's 80 would give: 80+5) and NOT D's negotiated 80.
  await inst('scoreAndRecord')
  await sleep(1500)
  {
    const parts = await readParticipants()
    const dealers = parts.filter(p => dealerMemberPids.includes(p.id))
    const bax = dealers.filter(p => p.role === 'baxter')
    const uni = dealers.filter(p => p.role === 'union')
    const raws = (gid, role) => parts.filter(p => p.group_id === gid && p.role === role).map(p => p.raw_score)
    const allEq = (arr, exp) => arr.length > 0 && arr.every(s => s === exp)
    log('score', parts.map(p => `${p.id}:${p.role}=${p.raw_score}`).join('  '))
    // RATIFIED deal → negotiated score stands.
    assert(bax.length > 0 && bax.every(p => p.raw_score === EXPECTED_1978_SCORES.baxter), `Ratified — every ratified-dealer Baxter = ${EXPECTED_1978_SCORES.baxter}`)
    assert(uni.length > 0 && uni.every(p => p.raw_score === EXPECTED_1978_SCORES.union),  `Ratified — every ratified-dealer Union = ${EXPECTED_1978_SCORES.union}`)
    // FAILED-RATIFICATION deal → scored as NO-DEAL (Baxter 90 = min-ratified 85 + 5; Union 0), NOT
    // the negotiated deal (Baxter 80 / Union ≠0). This is the core Slice-5 ratification assertion.
    assert(allEq(raws(failRatifyGid, 'baxter'), 90), '1978 FAILED-RATIFY → no-deal — Baxter = min-ratified 85 + 5 = 90 (NOT its negotiated deal sum 80)')
    assert(allEq(raws(failRatifyGid, 'union'), 0),  '1978 FAILED-RATIFY → no-deal — Union = 0 (NOT its negotiated deal score)')
    // Explicit REJECT → same no-deal scoring.
    assert(allEq(raws(rejectGid, 'baxter'), 90), '1978 REJECT → no-deal — Baxter = min-ratified 85 + 5 = 90')
    assert(allEq(raws(rejectGid, 'union'), 0),  '1978 REJECT → no-deal — Union = 0')
  }

  // #1 (part b): now that round 1 is completed, the gate button appears → drive it.
  await dash.reload(); await sleep(2500)
  await dash.waitForSelector('button:has-text("Open Round 2 Attendance")', { timeout: 15_000 })
  assert(true, '#1 — "Open Round 2 Attendance" SHOWN after all round-1 groups complete')
  await dash.click('button:has-text("Open Round 2 Attendance")')
  log('instr', 'clicked "Open Round 2 Attendance" (→ 1983)')

  // 6. Instructor generates the 1983 code UP FRONT — matching the manual flow order
  //    (advance → GENERATE 1983 code → students see the code screen → students ENTER it).
  const { code: code83 } = await inst('generateAttendanceCode')
  log('instr', `1983 attendance code: ${code83}`)

  // BUG A: each completed-1978 student must re-route OFF the results screen for day-2
  //        re-attendance. reAttend() drives through any hold/confirmation to the code screen,
  //        then enters the 1983 code — so a student stranded on results (the Bug-A regression)
  //        would never reach the code screen and this fails loudly.
  banner('Bug A — re-route off results → day-2 re-attendance')
  await Promise.all(students.map(s => reAttend(s.page, s.pid, code83)))
  assert(true, 'Bug A — all completed-1978 students re-attended for 1983 (not stranded on results)')

  // BUG F: on round-2 pre-Begin, students see a WAITING hold with NO clickable Start button.
  banner('Bug F — pre-Begin waiting state, no Start button')
  await Promise.all(students.map(async s => {
    await s.page.waitForSelector('h1:has-text("checked in")', { timeout: 30_000 })
    const startVisible = await s.page.locator('button:has-text("Start negotiation")').isVisible().catch(() => false)
    assert(!startVisible, `Bug F — ${s.pid}: NO "Start negotiation" button before Begin 1983`)
  }))

  // B: "Begin 1983" is shown now; click it. Afterwards it must NOT reappear.
  await dash.reload(); await sleep(2500)
  await dash.waitForSelector('button:has-text("Begin 1983")', { timeout: 15_000 })
  assert(true, 'B — "Begin 1983" shown after Open Round 2 Attendance')
  await dash.click('button:has-text("Begin 1983")')
  log('instr', 'clicked "Begin 1983" (re-opens groups → negotiating)')

  // BUG F (resume): the hold advances into the 1983 negotiation once the group is re-opened.
  await Promise.all(students.map(async s => {
    await s.page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 30_000 })
  }))
  assert(true, 'Bug F — students advance into the 1983 negotiation after Begin 1983')

  await dash.reload(); await sleep(2500)
  {
    const stillThere = await dash.locator('button:has-text("Begin 1983")').isVisible().catch(() => false)
    assert(!stillThere, 'B — "Begin 1983" does NOT reappear once the round has begun')
  }

  // ── Slice 3 + 1983 redo-loop: A redo→deal a wage, B no-deals, C (rejecter) idle ──
  banner('1983 negotiation — group A redo→deal a wage, group B no-deals')
  // Everyone taps "We've finished" to reach the 1983 report / confirm screens.
  await Promise.all(students.map(s => s.page.click("button:has-text(\"We've finished\")").catch(() => {})))

  const parts83 = await readParticipants()
  const groups83 = groupStudents(students, parts83)
  // A/B are the two RATIFIED dealer groups (they have a 1978 wage); C (rejecter) + D (failed-ratify)
  // stay idle here and complete 1983 as no-deals below so the class can proceed to 1985.
  const [gidA, gidB] = ratifiedGids
  log('1983', `group A=${gidA} (redo→$9.50) · group B=${gidB} (no deal→arbitration) · idle C=${rejectGid} D=${failRatifyGid}`)

  // Group A — wage-only form: assert ONLY the wage field renders. Then exercise the 1983
  // STANDARD ACCEPT/REDO loop (unchanged — 1983 is NOT ultimatum): first offer $9.50 is
  // REJECTED → the round RESETS (lead re-reports) → re-offer $9.50 → all accept → deal.
  const gA = groups83[gidA]; const leadA = gA.find(m => m.is_lead) ?? gA[0]; const nonA = gA.filter(m => m !== leadA)
  await leadA.page.waitForSelector('h1:has-text("Report outcome")', { timeout: 30_000 })
  {
    const selectCount = await leadA.page.locator('select').count()
    const numInputs   = await leadA.page.locator('input[type="number"]').count()
    assert(selectCount === 0 && numInputs === 1,
      '1983 wage-only form RENDERS (one numeric wage field, none of the six 1978 selects)')
  }
  // First offer → one receiver REJECTS.
  await leadA.page.locator('input[type="number"]').fill('9.50')
  await leadA.page.click('button:has-text("Review & submit")')
  await leadA.page.waitForSelector('h1:has-text("Confirm outcome")', { timeout: 10_000 })
  await leadA.page.click('button:has-text("Yes, submit")')
  await nonA[0].page.waitForSelector('h1:has-text("Confirm")', { timeout: 30_000 })
  await nonA[0].page.click('button:has-text("Reject")')
  // 1983 stays on the accept/REDO loop → reject RESETS: the lead is sent back to re-report.
  const redoOffered = await leadA.page.waitForSelector('h1:has-text("Report outcome")', { timeout: 20_000 })
    .then(() => true).catch(() => false)
  assert(redoOffered,
    '1983 STANDARD LOOP — a reject RESETS the round (lead re-reports; redo loop intact, NOT terminal)')
  // Re-offer the same wage → ALL receivers (incl. the earlier rejecter, now pending again) accept.
  await leadA.page.locator('input[type="number"]').fill('9.50')
  await leadA.page.click('button:has-text("Review & submit")')
  await leadA.page.waitForSelector('h1:has-text("Confirm outcome")', { timeout: 10_000 })
  await leadA.page.click('button:has-text("Yes, submit")')
  await Promise.all(nonA.map(async s => {
    await s.page.waitForSelector('h1:has-text("Confirm")', { timeout: 30_000 })
    await s.page.click('button:has-text("Confirm")')
  }))
  log('1983', `group A lead ${leadA.pid} re-offered $9.50 after a reject; all accepted`)

  // Group B — no deal (forces the arbitration path).
  const gB = groups83[gidB]; const leadB = gB.find(m => m.is_lead) ?? gB[0]; const nonB = gB.filter(m => m !== leadB)
  await leadB.page.waitForSelector('h1:has-text("Report outcome")', { timeout: 30_000 })
  await leadB.page.click('button:has-text("No deal")')
  await leadB.page.waitForSelector('h1:has-text("Confirm no deal")', { timeout: 10_000 })
  await leadB.page.click('button:has-text("Yes, no deal")')
  await Promise.all(nonB.map(async s => {
    await s.page.waitForSelector('h1:has-text("Confirm")', { timeout: 30_000 })
    await s.page.click('button:has-text("Confirm")')
  }))
  log('1983', `group B lead ${leadB.pid} reported NO DEAL; non-leads confirmed`)

  // Target the two dealer groups specifically (the rejecter C stays 'negotiating', idle).
  const g83 = await pollGroupsFull(g => {
    const a = g.find(x => x.id === gidA), b = g.find(x => x.id === gidB)
    return near(a?.wage83, 9.50) && b?.status === 'completed' && b?.wage83 == null
  }, 40_000)
  assert(near(g83.find(x => x.id === gidA)?.wage83, 9.50),
    '1983 wage-only form SUBMITS — group A wage83 = $9.50 stored (continuous, server-validated)')
  assert(g83.find(x => x.id === gidB)?.wage83 == null,
    '1983 no-deal — group B ended with NO agreed wage')

  // Pre-resolution: a group-B student correctly sees "No deal" (awaiting arbitration) — CORRECT.
  const bStudent = groups83[gidB][0]
  {
    await bStudent.page.waitForSelector('h1:has-text("Outcome locked")', { timeout: 30_000 })
    const txt = await bStudent.page.locator('main').innerText()
    assert(/no deal/i.test(txt) && !/\$/.test(txt),
      'Arbitrated-view — group B student sees "No deal" BEFORE arbitration (correct pre-resolution state)')
  }

  // ── Arbitration: group B auto-flagged → seeded resolve → $8.67 (Baxter branch) ──
  banner('arbitration — group B auto-flagged → seeded resolve')
  await dash.reload(); await sleep(2500)
  {
    const btnVisible = await dash.locator('button:has-text("Resolve arbitration")').isVisible().catch(() => false)
    assert(btnVisible, 'Arbitration — group B is AUTO-FLAGGED (Resolve button shown on the dashboard queue)')
  }
  const arb = await inst('resolveArbitration', { group_id: gidB, seed: 1 })
  assert(arb.side === 'baxter' && near(arb.wage, 8.67),
    'Arbitration — seed 1 → Baxter rules → wage $8.67 (deterministic seeded RNG)')
  const g83b = await pollGroupsFull(g => near(g.find(x => x.id === gidB)?.wage83, 8.67), 15_000)
  assert(near(g83b.find(x => x.id === gidB)?.wage83, 8.67),
    'Arbitration — group B 1983 slot now holds the arbitrated $8.67')

  // Post-resolution: the group-B student's LIVE view FLIPS from "No deal" to the arbitrated wage
  // (the arbitration_1983 write reaches the open OutcomeReporting snapshot — no reload).
  {
    await bStudent.page.waitForFunction(
      () => /8\.67/.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 20_000 },
    ).catch(() => {})
    const txt = await bStudent.page.locator('main').innerText()
    assert(/8\.67/.test(txt) && /arbitration/i.test(txt) && !/no deal reached/i.test(txt),
      'Arbitrated-view — group B student view FLIPS to the arbitrated $8.67 (no longer "No deal")')
  }

  // ── Score-transform: Score & Record → adjusted-1978 (cross-group w83_avg) ───────
  banner('score-transform — Score & Record → adjusted-1978')
  await inst('scoreAndRecord')
  await sleep(1500)
  {
    // w83_avg = ($9.50 + $8.67)/2 = $9.085. Both groups' 1978 wage = increase_top3 = $11.69, base 85/62.
    //   Group A ($9.50):  Baxter 80.4  Union 43.3     Group B ($8.67):  Baxter 89.6  Union 36.2
    const parts = await readParticipants()
    const byGroup = {}
    for (const p of parts) {
      if (p.group_id !== gidA && p.group_id !== gidB) continue
      ;((byGroup[p.group_id] ??= {})[p.role] ??= []).push(p.raw_score)
    }
    log('xform', parts.filter(p => p.group_id === gidA || p.group_id === gidB)
      .map(p => `${p.id}:${p.group_id === gidA ? 'A' : 'B'}/${p.role}=${p.raw_score}`).join('  '))
    const check = (gid, role, exp) => {
      const arr = byGroup[gid]?.[role] ?? []
      return arr.length > 0 && arr.every(s => near(s, exp))
    }
    assert(check(gidA, 'baxter', 80.4), 'Transform — group A Baxter adjusted-1978 = 80.4')
    assert(check(gidA, 'union',  43.3), 'Transform — group A Union adjusted-1978 = 43.3')
    assert(check(gidB, 'baxter', 89.6), 'Transform — group B Baxter adjusted-1978 = 89.6')
    assert(check(gidB, 'union',  36.2), 'Transform — group B Union adjusted-1978 = 36.2')
  }

  // ══ 1985 (Slice 4) — own six-issue contract, ultimatum, additive final ═══════════
  // Groups C (1978-rejecter) and D (1978 failed-ratification) have stayed idle through 1983. To
  // advance the whole class to 1985 (advanceRound requires EVERY group completed), both complete
  // 1983 as NO-DEALS. They get NO 1983 wage → excluded from w83_avg (the transform numbers above
  // are unaffected), and their 1983 arbitrations are deliberately LEFT UNRESOLVED (resolving would
  // give a wage and shift the average). C and D both carry a 1978 NO-DEAL base of 90 (min-ratified
  // 85 + 5), so their 1985 numbers below are 90 + the 1985 component.
  banner('1985 — proceed 1983→1985, then own six-issue contract (ultimatum + additive final)')
  {
    for (const gid of [rejectGid, failRatifyGid]) {
      const g = groups83[gid]; const lead = g.find(m => m.is_lead) ?? g[0]; const non = g.filter(m => m !== lead)
      await lead.page.waitForSelector('h1:has-text("Report outcome")', { timeout: 30_000 })
      await lead.page.click('button:has-text("No deal")')
      await lead.page.waitForSelector('h1:has-text("Confirm no deal")', { timeout: 10_000 })
      await lead.page.click('button:has-text("Yes, no deal")')
      await Promise.all(non.map(async s => {
        await s.page.waitForSelector('h1:has-text("Confirm")', { timeout: 30_000 })
        await s.page.click('button:has-text("Confirm")')
      }))
    }
    await pollGroupsFull(g => [gidA, gidB, rejectGid, failRatifyGid].every(id => g.find(x => x.id === id)?.status === 'completed'), 30_000)
    log('1983', `groups C (${rejectGid}) + D (${failRatifyGid}) no-dealed 1983 → all four completed; ready to proceed`)
  }

  // Proceed 1983→1985 (same-session generic advanceRound: re-opens every group; day-2 presence
  // carries forward so students flow straight into 1985 with no re-attendance).
  const adv = await inst('advanceRound')
  log('instr', `advanceRound → round ${adv.current_round} (${adv.round_id})`)
  await Promise.all(students.map(s => s.page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 30_000 })))
  assert(adv.round_id === '1985', 'Proceed — advanceRound moved the class to 1985 (students re-flow into the negotiation)')
  // Everyone taps "We've finished" to reach the 1985 report / confirm screens.
  await Promise.all(students.map(s => s.page.click("button:has-text(\"We've finished\")").catch(() => {})))

  const parts85 = await readParticipants()
  const groups85 = groupStudents(students, parts85)

  // Group B — ULTIMATUM (1985 inherits Bug E's mechanic by declaration): lead offers a contract,
  // ONE receiver REJECTS → TERMINAL no-deal (NO redo, NO second offer), distinct from 1983's loop.
  const gB85 = groups85[gidB]; const leadB85 = gB85.find(m => m.is_lead) ?? gB85[0]; const nonB85 = gB85.filter(m => m !== leadB85)
  await leadB85.page.waitForSelector('h1:has-text("Report outcome")', { timeout: 30_000 })
  {
    const selectCount = await leadB85.page.locator('select').count()
    const numInputs   = await leadB85.page.locator('input[type="number"]').count()
    assert(selectCount === 5 && numInputs === 1,
      '1985 six-issue form RENDERS (one wage field + five option selects — its OWN contract, not 1978/1983)')
  }
  await fill1985(leadB85.page, DEAL_A_1985)
  await leadB85.page.click('button:has-text("Review & submit")')
  await leadB85.page.waitForSelector('h1:has-text("Confirm outcome")', { timeout: 10_000 })
  await leadB85.page.click('button:has-text("Yes, submit")')
  await nonB85[0].page.waitForSelector('h1:has-text("Confirm")', { timeout: 30_000 })
  await nonB85[0].page.click('button:has-text("Reject")')
  {
    const gs = await pollGroupsFull(g => g.find(x => x.id === gidB)?.status === 'completed', 30_000)
    const b = gs.find(x => x.id === gidB)
    // The per-round no-deal for rounds 2+ is represented by the KEYED 1985 slot being committed
    // null (the flat agreement_reached is round-1 scoped under Option-1 derive — B still reads
    // true from its 1978 deal). So the terminal signal is: status completed + no 1985 wage.
    assert(b?.status === 'completed' && b?.wage85 == null,
      '1985 ULTIMATUM REJECT — reject reaches TERMINAL no-deal (round-3 slot committed null, status completed)')
    const leadOnForm = await leadB85.page.locator('h1:has-text("Report outcome")').isVisible().catch(() => false)
    assert(!leadOnForm,
      '1985 ULTIMATUM REJECT — no redo: lead is NOT returned to the report form (distinct from 1983 redo)')
  }

  // DEGENERATE pass — score BEFORE any group deals 1985 (B rejected → no-deal; A, C, D idle). The
  // re-runnable scorer must apply the 1985 degenerate-pool guard: Baxter no-deal = 50, Union = 60.
  await inst('scoreAndRecord')
  await sleep(1500)
  {
    const parts = await readParticipants()
    const raws = (gid, role) => parts.filter(p => p.group_id === gid && p.role === role).map(p => p.raw_score)
    const all = (arr, exp) => arr.length > 0 && arr.every(s => near(s, exp, 0.1))
    const tag = gid => gid === gidA ? 'A' : gid === gidB ? 'B' : gid === rejectGid ? 'C' : 'D'
    log('1985°', parts.filter(p => [gidA, gidB, rejectGid, failRatifyGid].includes(p.group_id))
      .map(p => `${p.id}:${tag(p.group_id)}/${p.role}=${p.raw_score}`).join('  '))
    // C and D carry a 1978 NO-DEAL base of 90 (min-ratified 85 + 5); no 1983 wage → no adjustment.
    //   C/D Baxter = 90 + 50 (1985 degenerate) = 140    C/D Union = 0 + 60 = 60
    for (const [gid, lbl] of [[rejectGid, 'C'], [failRatifyGid, 'D']]) {
      assert(all(raws(gid, 'baxter'), 140),
        `1985 DEGENERATE guard — 0 dealers → Baxter no-deal 50; group ${lbl} = 1978-no-deal 90 + 50 = 140`)
      assert(all(raws(gid, 'union'), 60),
        `1985 Union no-deal = 60; group ${lbl} Union = 1978-no-deal 0 + 60 = 60`)
    }
    // Group B (ratified 1978) Baxter = adjusted-1978 (89.6) + 50 degenerate = 139.6.
    assert(all(raws(gidB, 'baxter'), 139.6),
      '1985 DEGENERATE — group B Baxter = adjusted-1978 89.6 + 50 = 139.6')
  }

  // Group A DEALS 1985 (Deal B → Baxter 97.95, Union 9.55). One dealer now exists.
  const gA85 = groups85[gidA]; const leadA85 = gA85.find(m => m.is_lead) ?? gA85[0]; const nonA85 = gA85.filter(m => m !== leadA85)
  await fill1985(leadA85.page, DEAL_B_1985)
  await leadA85.page.click('button:has-text("Review & submit")')
  await leadA85.page.waitForSelector('h1:has-text("Confirm outcome")', { timeout: 10_000 })
  await leadA85.page.click('button:has-text("Yes, submit")')
  await Promise.all(nonA85.map(async s => {
    await s.page.waitForSelector('h1:has-text("Confirm")', { timeout: 30_000 })
    await s.page.click('button:has-text("Confirm")')
  }))
  {
    const gs = await pollGroupsFull(g => { const a = g.find(x => x.id === gidA); return a?.status === 'completed' && a?.wage85 != null }, 30_000)
    assert(near(gs.find(x => x.id === gidA)?.wage85, 9.00),
      '1985 six-issue form SUBMITS — group A wage85 = $9.00 stored (continuous, server-validated)')
  }

  // NORMAL pass — re-score with one dealer (A). final raw = adjusted-1978 + 1985.
  await inst('scoreAndRecord')
  await sleep(1500)
  {
    const parts = await readParticipants()
    const raws = (gid, role) => parts.filter(p => p.group_id === gid && p.role === role).map(p => p.raw_score)
    const all = (arr, exp) => arr.length > 0 && arr.every(s => near(s, exp, 0.1))
    const tag = gid => gid === gidA ? 'A' : gid === gidB ? 'B' : gid === rejectGid ? 'C' : 'D'
    log('1985', parts.filter(p => [gidA, gidB, rejectGid, failRatifyGid].includes(p.group_id))
      .map(p => `${p.id}:${tag(p.group_id)}/${p.role}=${p.raw_score}`).join('  '))
    // Group A dealt Deal B (Baxter 97.95 / Union 9.55). adjusted-1978 A = Baxter 80.4 / Union 43.3.
    assert(all(raws(gidA, 'baxter'), 178.35),
      'Additive final — group A Baxter = adjusted-1978 80.4 + 1985 deal 97.95 = 178.35 (score matches gate)')
    assert(all(raws(gidA, 'union'), 52.85),
      'Additive final — group A Union = adjusted-1978 43.3 + 1985 deal 9.55 = 52.85')
    // Union no-deal still 60: group B Union = adjusted 36.2 + 60 = 96.2.
    assert(all(raws(gidB, 'union'), 96.2),
      '1985 Union no-deal = 60 — group B Union = adjusted-1978 36.2 + 60 = 96.2')
    // Baxter no-deal is now the AVG OF DEALERS (A = 97.95), NOT the degenerate 50. Groups C and D
    // (both 1978 no-deal base 90) FLIP 140 → 90 + 97.95 = 187.95, proving the full pipeline
    // 1978-no-deal → 1983-adjust (none) → 1985-add stacks correctly and re-runs to the normal path.
    for (const [gid, lbl] of [[rejectGid, 'C'], [failRatifyGid, 'D']]) {
      assert(all(raws(gid, 'baxter'), 187.95),
        `Additive final — group ${lbl} Baxter = 1978-no-deal 90 + 1985 avg-of-dealers 97.95 = 187.95 (flips 140→187.95)`)
    }
  }

  banner(`RESULT — ${PASS} passed, ${FAIL} failed`)
  // Any non-throwing assertion failures still get a full page/heading/screenshot dump.
  if (FAIL > 0) await dumpDiagnostics(`${FAIL} assertion(s) failed`)
  if (!HEADED) await browser.close()
  else { console.log('HEADED mode — leaving browser open. Ctrl+C to exit.'); await sleep(600_000); await browser.close() }
  process.exit(FAIL === 0 ? 0 : 1)
}

// A thrown error (e.g. a waitForSelector TIMEOUT — "the stuck student") lands here: dump every
// live page's heading + screenshot before exiting so we can see which screen each is stuck on.
main().catch(async err => {
  console.error('\nFatal:', err?.message ?? err)
  await dumpDiagnostics('fatal error / timeout: ' + (err?.message ?? err)).catch(() => {})
  try { if (browser && !HEADED) await browser.close() } catch { /* ignore */ }
  process.exit(1)
})
