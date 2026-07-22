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
import { createServer } from 'node:http'
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
// One extra student bootstraps (gets a role) but NEVER attends → a TRUE NO-SHOW (Slice 6): role
// but no group → status no_show → normalized_score −2, raw_score null, EXCLUDED from the z-pool.
const NOSHOW_PID = 'stu-17'

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
// Student callables travel with the emulator _test bypass (participant + instance id, no JWT).
const stu = (name, pid, extra = {}) => callFn(name, { _test: { participant_id: pid, game_instance_id: GID }, ...extra })

// ── Phase-aware role-info (role documents slice) ────────────────────────────────
// getInfoUrls is server-round-derived (reads the instance current_round). Expected
// per-round × per-role document URLs = the configField defaults declared in gameDefinition.
const ROLE_INFO_EXPECT = {
  '1978': {
    baxter: ['/role-info/1978-baxter-case.pdf', '/role-info/1978-baxter-worksheet.xlsx'],
    union:  ['/role-info/1978-union-case.pdf',  '/role-info/1978-union-worksheet.xlsx'],
  },
  '1983': {
    baxter: ['/role-info/1983-baxter-brief.pdf'],
    union:  ['/role-info/1983-union-brief.pdf'],
  },
  '1985': {
    baxter: ['/role-info/1985-baxter-case.pdf', '/role-info/1985-baxter-scoresheet.xlsx'],
    union:  ['/role-info/1985-union-case.pdf',  '/role-info/1985-union-scoresheet.xlsx'],
  },
}
const ALL_ROLE_INFO_URLS = [...new Set(Object.values(ROLE_INFO_EXPECT).flatMap(r => [...r.baxter, ...r.union]))]

// Assert getInfoUrls serves EXACTLY the caller's current-round docs — never the other
// role's, never another round's (round-correct + role-correct).
async function assertRoleInfoServing(round, baxPid, uniPid) {
  const exp = ROLE_INFO_EXPECT[round]
  const otherRounds = Object.keys(ROLE_INFO_EXPECT).filter(r => r !== round)
  const bx = (await stu('getInfoUrls', baxPid)).links.map(l => l.url)
  const un = (await stu('getInfoUrls', uniPid)).links.map(l => l.url)
  assert(bx.length === exp.baxter.length && exp.baxter.every(u => bx.includes(u)),
    `Role-info ${round} — baxter gets its ${exp.baxter.length} ${round} doc(s): ${bx.join(', ')}`)
  assert(un.length === exp.union.length && exp.union.every(u => un.includes(u)),
    `Role-info ${round} — union gets its ${exp.union.length} ${round} doc(s): ${un.join(', ')}`)
  assert(!bx.some(u => u.includes('-union-')), `Role-info ${round} — baxter NEVER sees union docs (role isolation)`)
  assert(!un.some(u => u.includes('-baxter-')), `Role-info ${round} — union NEVER sees baxter docs (role isolation)`)
  assert(!bx.some(u => otherRounds.some(r => u.includes(`/role-info/${r}-`))),
    `Role-info ${round} — baxter sees ONLY round ${round} docs (round-correct switch)`)
  assert(!un.some(u => otherRounds.some(r => u.includes(`/role-info/${r}-`))),
    `Role-info ${round} — union sees ONLY round ${round} docs (round-correct switch)`)
}

// Every placed file must resolve over the frontend origin as a real file — not a 404 and
// not the SPA index.html fallback (the grays binary-404 lesson).
async function assertRoleInfoFilesResolve() {
  for (const u of ALL_ROLE_INFO_URLS) {
    const r = await fetch(`${FE}${u}`)
    const ct = r.headers.get('content-type') ?? ''
    assert(r.status === 200 && !ct.includes('text/html'),
      `Role-info file resolves (no 404, not SPA-fallback): ${u} [${r.status} ${ct}]`)
  }
  // Negative control: a bogus role-info path must NOT resolve as a real file (Vite would
  // otherwise serve index.html with 200) — proves the resolve check above is real.
  const bad = await fetch(`${FE}/role-info/__does_not_exist__.pdf`)
  const badCt = bad.headers.get('content-type') ?? ''
  assert(!(bad.status === 200 && !badCt.includes('text/html')),
    `Role-info resolve check is real — bogus file does NOT resolve as a real file [${bad.status} ${badCt}]`)
}

// The persistent student header must swap its links when the round advances.
async function headerHrefs(page) {
  return page.locator('header nav a').evaluateAll(as => as.map(a => a.getAttribute('href')))
}

// ── Mock classroom callback (Slice 6): stand in for receiveGameResult so the harness can OBSERVE
// the gradebook push. scoreAndRecord's dispatchResults POSTs one GameResult per participant to this
// URL (passed via the _dev emulator override); we collect every posted body. The real prod handshake
// (CALLBACK_SECRET_BAXTER + classroom receiveGameResult) is unchanged — we only redirect the URL. ──
const CALLBACK_SECRET = 'harness-test-secret'
async function startMockCallback() {
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      try { received.push({ auth: req.headers.authorization, result: JSON.parse(body) }) }
      catch { received.push({ auth: req.headers.authorization, result: body }) }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}')
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/receiveGameResult`
  return { url, received, close: () => new Promise(r => server.close(r)) }
}
/** scoreAndRecord with the mock callback wired via the _dev override → fires the gradebook push. */
const scoreAndPush = (callbackUrl) =>
  callFn('scoreAndRecord', { _dev: { game_instance_id: GID, callback_url: callbackUrl, callback_secret: CALLBACK_SECRET } })

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
    id:               d.name.split('/').pop(),
    role:             strVal(d.fields?.role),
    is_lead:          d.fields?.is_lead?.booleanValue ?? false,
    raw_score:        numVal(d.fields?.raw_score),
    normalized_score: numVal(d.fields?.normalized_score),
    group_id:         strVal(d.fields?.group_id),
  }))
}
/** Raw Firestore fields map for one participant (for KC score / Likert response assertions). */
async function readParticipantFields(pid) {
  const res = await fetch(`${FIRESTORE}/game_instances/${GID}/participants/${pid}`, {
    headers: { Authorization: 'Bearer owner' },
  })
  if (!res.ok) return {}
  return (await res.json()).fields ?? {}
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

/** Firestore REST PATCH on a group doc (owner auth). `fields` is the REST document body; `mask`
 *  is the updateMask.fieldPaths list — a masked path absent from `fields` is DELETED. Used by the
 *  Part B arbitration probe to revert its write so the frozen class-average numbers stay intact. */
async function fsPatchGroup(gid, fields, mask) {
  const qs = mask.map(p => `updateMask.fieldPaths=${encodeURIComponent(p)}`).join('&')
  const res = await fetch(`${FIRESTORE}/game_instances/${GID}/groups/${gid}?${qs}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  return res.ok
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

// ── Phase 1a: info → KC gate → 4 graded static MC → reflection → hold (Slice 7) ──

// The four graded static KC questions (correct B/B/C/B). Options are SERVER-SHUFFLED per student,
// so we click by a distinctive label substring (regex) — never by position. KC_WRONG_PID answers
// Q1 with a WRONG option to prove partial scoring (3/4 = 0.75) + denominator 4 (gate excluded).
const KC_STATICS = [
  { n: 1, correct: /Ask what interests or concerns/, wrong: /Restate your own position/ },
  { n: 2, correct: /leave the other side feeling cheated/ },
  { n: 3, correct: /best alternative to a negotiated agreement/ },
  { n: 4, correct: /one-text procedure/ },
]
const KC_WRONG_PID = 'stu-1'

// The three "Looking ahead to 1985" Likert fields (between-rounds, after 1978 / before 1983).
const LIKERT_FIELDS = ['debrief_relationship_1978', 'debrief_trust_future', 'debrief_1985_difficulty']

// Per-role, per-question Likert ratings — chosen so each column's class average (8 baxter + 8 union)
// is a non-integer that is NOT itself a submitted rating, so the Likert-table average assertion
// proves real averaging (not just displaying a value): relationship 3.50, trust 4.50, difficulty 5.50.
const LIKERT_RATINGS = {
  baxter: { debrief_relationship_1978: '5', debrief_trust_future: '6', debrief_1985_difficulty: '4' },
  union:  { debrief_relationship_1978: '2', debrief_trust_future: '3', debrief_1985_difficulty: '7' },
}

async function driveSetup(page, pid) {
  await page.goto(studentUrl(pid))
  await page.waitForSelector('p:has-text("Your role")', { timeout: 60_000 })
  const roleLabel = (await page.locator('h1').first().textContent()) ?? ''
  const role = roleLabel.toLowerCase().includes('baxter') ? 'baxter' : 'union'
  log(pid, `info: "${roleLabel}" (${role}) → Continue`)
  await page.click('button:has-text("Continue")')

  // KC role gate (ungraded, REQUIRED to proceed — excluded from the graded denominator).
  await page.waitForSelector('text=What is your role in this negotiation?', { timeout: 30_000 })
  await page.getByRole('radio', { name: ROLE_RADIO[role], exact: true }).click()
  await page.click('button:has-text("Submit")')

  // FOUR graded static MC (shared, both roles). Submit → see Correct/Incorrect → Continue.
  for (const q of KC_STATICS) {
    await page.waitForSelector(`p:has-text("Concept check — ${q.n} of 4")`, { timeout: 30_000 })
    const label = (pid === KC_WRONG_PID && q.wrong) ? q.wrong : q.correct
    await page.getByRole('radio', { name: label }).click()
    await page.click('button:has-text("Submit")')
    await page.waitForSelector('button:has-text("Continue")', { timeout: 20_000 })
    await page.click('button:has-text("Continue")')
  }

  // ONE ungraded free-text reflection (prep phase, before 1978).
  await page.waitForSelector('p:has-text("Preparation — 1 of 1")', { timeout: 30_000 })
  await page.locator('textarea').fill(`${role} priorities: 1. Wages  2. Job security  3. Work rules`)
  await page.click('button:has-text("Complete")')

  await page.waitForSelector('h1:has-text("Preparation complete")', { timeout: 30_000 })
  log(pid, '◆ hold screen')
  return { page, pid, role }
}

// ── Part C: post-1978 reaffirm/debrief screen (Results) — shown FIRST, before the Likert ──
// After 1978 completes, the student lands on the reaffirm/debrief screen ("Negotiation results")
// with the group + agreed deal + the required free-text reflection. Submitting it advances to the
// "Looking ahead to 1985" Likert set (proving the corrected order: reaffirm → Likert → all-done).
async function driveReaffirm(s) {
  const { page, pid } = s
  await page.waitForSelector('h1:has-text("Negotiation results")', { timeout: 30_000 })
  await page.locator('textarea').first().fill(`${pid}: the negotiation went as expected.`)
  await page.click('button:has-text("Submit")')
  // Must navigate off the reaffirm screen INTO the Likert — proves ordering + a persisted debrief.
  await page.waitForSelector('h1:has-text("Looking ahead to 1985")', { timeout: 15_000 })
  log(pid, '↗ reaffirm/debrief submitted → Likert')
}

// ── Between-rounds "Looking ahead to 1985" Likert set (after 1978, before 1983) ──
async function driveLookingAhead(s) {
  const { page, pid, role } = s
  await page.waitForSelector('h1:has-text("Looking ahead to 1985")', { timeout: 30_000 })
  for (const field of LIKERT_FIELDS) {
    // Click the label wrapping this role's rating (robust for controlled React radios — fires onChange).
    const rating = LIKERT_RATINGS[role][field]
    await page.locator(`label:has(input[name="${field}"][value="${rating}"])`).click()
  }
  await page.click('button:has-text("Submit")')
  // The submit MUST navigate off the Likert screen (persisted). A silent validation bounce would
  // leave the heading up → this times out loudly instead of masking a failed write.
  await page.waitForSelector('h1:has-text("Looking ahead to 1985")', { state: 'detached', timeout: 15_000 })
  log(pid, '↗ Looking-ahead Likert submitted')
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

/** Lead reports a 1978 deal (fills + reviews + submits); non-leads all Confirm (accept). Used for
 *  RATIFYING deals only (group D's failing deal is driven explicitly with warning checks). */
async function drive1978Deal(members, outcome) {
  const lead = members.find(m => m.is_lead) ?? members[0]
  const nonLeads = members.filter(m => m !== lead)
  await fill1978(lead.page, outcome)
  await lead.page.click('button:has-text("Review & submit")')
  await lead.page.waitForSelector('h1:has-text("Confirm outcome")', { timeout: 10_000 })
  // Part R (assertion 3) — the Management LEAD's submit dialog never reveals the union
  // ratification gate (the warning is union-confirm-only; Management must not see the keys).
  assert(await lead.page.locator('text=/fail ratification/i').count() === 0,
    '1978 ratify-warn — Management submit dialog does NOT reveal the ratification gate (no key leak)')
  await lead.page.click('button:has-text("Yes, submit")')
  await Promise.all(nonLeads.map(async s => {
    await s.page.waitForSelector('h1:has-text("Confirm")', { timeout: 30_000 })
    await s.page.click('button:has-text("Confirm")')
    // Part R (assertion 2) — a RATIFYING deal (Deloitte + Transfer≥Most) shows NO warning, even
    // to a Union confirmer: clicking Confirm commits directly (no "Are you sure?" step appears).
    if (s.role === 'union') {
      const warned = await s.page.waitForSelector('h1:has-text("Are you sure")', { timeout: 2_000 })
        .then(() => true).catch(() => false)
      assert(!warned, '1978 ratify-warn — Union confirming a RATIFYING deal is NOT warned (Deloitte + Transfer≥Most)')
    }
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
  // Fix 2 — the 1978 reject is ALSO confirm-gated (same shared OutcomeReporting flow, ultimatum
  // round): the first Reject click opens "Are you sure?" and does NOT terminate; the explicit
  // confirm click is what ends it. This proves the guard covers 1978, not just 1985.
  await rejecter.page.click('button:has-text("Reject")')
  await rejecter.page.waitForSelector('h1:has-text("Are you sure")', { timeout: 10_000 })
  assert(true, 'Fix 2 — 1978 Reject is confirm-gated too ("Are you sure?" before the terminal no-deal)')
  {
    const c0 = (await readGroupsFull()).find(x => x.id === rejectGid)
    assert(c0?.status !== 'completed',
      'Fix 2 — 1978 reject WITHOUT confirm does NOT terminate the negotiation (group still open)')
  }
  await rejecter.page.click('button:has-text("Yes, reject")')
  log(rejectGid, `rejecter ${rejecter.pid} confirmed Reject (1978 ultimatum)`)
  await pollGroupsFull(g => g.find(x => x.id === rejectGid)?.status === 'completed', 30_000)

  // ── DEGENERATE probe (Slice 5): score NOW — C is a no-deal Baxter but ZERO groups have a
  // ratified deal yet → "min ratified + 5" has no base → Baxter no-deal = 50 (flat reservation,
  // Elena-decided; mirrors the 1985 zero-dealer guard). Union stays 0. (Re-runnable: once A/B
  // ratify below, C flips 50 → 90.) ──
  await inst('scoreAndRecord')
  await sleep(1500)
  {
    const parts = await readParticipants()
    const cBax = parts.filter(p => p.group_id === rejectGid && p.role === 'baxter').map(p => p.raw_score)
    const cUni = parts.filter(p => p.group_id === rejectGid && p.role === 'union').map(p => p.raw_score)
    assert(cBax.length > 0 && cBax.every(s => near(s, 50)),
      '1978 DEGENERATE — 0 ratified deals → Baxter no-deal = 50 (flat reservation, Elena-decided)')
    assert(cUni.length > 0 && cUni.every(s => s === 0),
      '1978 DEGENERATE — 0 ratified deals → Union no-deal = 0')
  }

  // ── RATIFIED dealers (A,B): canonical deal (Location=Deloitte, Transfer=Most) → ratifies ──
  await Promise.all(ratifiedGids.map(async gid => {
    await drive1978Deal(groups[gid], CANONICAL_1978_OUTCOME)
    log(gid, 'ratified dealer — canonical 1978 deal accepted')
  }))

  // ── FAILED-RATIFICATION dealer (D): a real DEAL, but Transfer=Some → gate rejects → no-deal.
  // Driven EXPLICITLY to exercise the Union pre-commit ratification warning (Part R). ──
  {
    const members = groups[failRatifyGid]
    const lead = members.find(m => m.is_lead) ?? members[0]
    assert(lead.role === 'baxter', '1978 ratify-warn — group D lead is Management (reports the deal)')
    const unionNon  = members.filter(m => m !== lead && m.role === 'union')
    const baxterNon = members.filter(m => m !== lead && m.role === 'baxter')

    await fill1978(lead.page, FAIL_RATIFY_1978_OUTCOME)
    await lead.page.click('button:has-text("Review & submit")')
    await lead.page.waitForSelector('h1:has-text("Confirm outcome")', { timeout: 10_000 })
    assert(await lead.page.locator('text=/fail ratification/i').count() === 0,
      '1978 ratify-warn — Management submit of a FAILING deal still does NOT reveal the ratification gate (no key leak)')
    await lead.page.click('button:has-text("Yes, submit")')

    // Assertion 1 — a UNION confirmer of this failing deal is WARNED (naming the reason); "No, go
    // back" cancels with NO commit; confirming THROUGH the warning commits.
    const u0 = unionNon[0]
    await u0.page.waitForSelector('h1:has-text("Confirm the outcome")', { timeout: 30_000 })
    await u0.page.click('button:has-text("Confirm")')
    await u0.page.waitForSelector('h1:has-text("Are you sure")', { timeout: 10_000 })
    assert(await u0.page.locator('text=/fail ratification/i').count() > 0,
      '1978 ratify-warn — Union confirming a FAILING deal is WARNED before commit, naming the reason (ratification)')
    await u0.page.click('button:has-text("No, go back")')
    await u0.page.waitForSelector('h1:has-text("Confirm the outcome")', { timeout: 10_000 })
    assert((await readGroupsFull()).find(x => x.id === failRatifyGid)?.status !== 'completed',
      '1978 ratify-warn — "No, go back" cancels the warning: the group is NOT committed')
    await u0.page.click('button:has-text("Confirm")')
    await u0.page.waitForSelector('h1:has-text("Are you sure")', { timeout: 10_000 })
    await u0.page.click('button:has-text("Yes, confirm")')
    assert(true, '1978 ratify-warn — confirming THROUGH the warning proceeds (a failed-ratification no-deal is a valid outcome)')

    // Remaining union confirmers: warned → confirm through. Management (baxter) confirmer: NO
    // warning (assertion 3 — the union ratification keys are never shown to Management).
    for (const s of unionNon.slice(1)) {
      await s.page.waitForSelector('h1:has-text("Confirm the outcome")', { timeout: 30_000 })
      await s.page.click('button:has-text("Confirm")')
      await s.page.waitForSelector('h1:has-text("Are you sure")', { timeout: 10_000 })
      await s.page.click('button:has-text("Yes, confirm")')
    }
    for (const s of baxterNon) {
      await s.page.waitForSelector('h1:has-text("Confirm the outcome")', { timeout: 30_000 })
      await s.page.click('button:has-text("Confirm")')
      const warned = await s.page.waitForSelector('h1:has-text("Are you sure")', { timeout: 3_000 })
        .then(() => true).catch(() => false)
      assert(!warned, '1978 ratify-warn — Management (baxter) confirmer of the FAILING deal is NOT warned (info asymmetry preserved)')
    }
  }
  log(failRatifyGid, 'failed-ratification dealer — 1978 DEAL accepted through the Union ratification warning (Transfer=Some → NOT ratified)')

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

// ── Save-unchanged UI coverage (the exact editor-binding repro) ─────────────────
// The bug that slipped through: the editor selects came up BLANK (state not bound from the row's
// outcome), so Save sent empty strings → "field must be one of […], got ''". These drive the REAL
// browser Save path (open → save) — a data-level updateGroupContract call would NOT catch it:
//   (a) open a populated (dealer) editor, change NOTHING, Save → SUCCEEDS + persists the shown values.
//   (b) change ONE field, Save → all six persist (the changed one + the five untouched).
// Exercised for BOTH the 1978 and 1985 editors.
const ISSUE_KEYS_BY_ROUND = {
  '1978': ['wages', 'plant_operation', 'escalator', 'incentive', 'location', 'transfer'],
  '1985': ['incentive85', 'work_rules85', 'hiring85', 'notices85', 'seniority85'],  // + wage85 (number)
}
async function driveSaveUnchanged(reports, round) {
  const tile = `${round} Report`
  const enums = ISSUE_KEYS_BY_ROUND[round]
  const outcomeOf = r => (round === '1978' ? r?.outcome_1978 : r?.outcome_1985)
  const outcomeForGroup = async gnum =>
    outcomeOf((await inst('getReportData')).rows.find(r => r.group_number === gnum))

  await reports.getByText(tile, { exact: true }).click()
  await reports.waitForSelector(`h3:has-text("${tile}")`, { timeout: 15_000 })

  // Open a DEALER row's editor (Notes cell == exactly "Deal" — the populated form the bug corrupted)
  // and return the group number the modal title reports (== getReportData group_number).
  const openDealerEditor = async () => {
    const row = reports.getByRole('row').filter({ has: reports.getByRole('cell', { name: 'Deal', exact: true }) }).first()
    await row.getByRole('button', { name: 'Edit' }).click()
    await reports.waitForSelector(`h3:has-text("${round} contract")`, { timeout: 15_000 })
    const title = await reports.locator(`h3:has-text("${round} contract")`).innerText()
    return parseInt(title.match(/group\s+(\d+)/i)[1], 10)
  }
  const saveClosed = async () =>
    reports.getByRole('button', { name: 'Save', exact: true }).click()
      .then(() => reports.waitForSelector(`h3:has-text("${round} contract")`, { state: 'detached', timeout: 15_000 }))
      .then(() => true).catch(() => false)

  // (a) Save with NO changes → succeeds + persists the displayed values (nothing blanked).
  const gnumA = await openDealerEditor()
  const beforeA = await outcomeForGroup(gnumA)
  const closedA = await saveClosed()
  assert(closedA,
    `Save-unchanged/${round} (a) — editor Save with NO changes SUCCEEDS (modal closes, no "must be one of … got ''" error)`)
  const afterA = await outcomeForGroup(gnumA)
  assert(afterA != null && enums.every(k => afterA[k] === beforeA[k]) && (round === '1978' || near(afterA.wage85, beforeA.wage85)),
    `Save-unchanged/${round} (a) — all displayed fields PERSIST unchanged after the no-op Save (no field blanked)`)

  // (b) Change ONE field → all six persist (the changed one + the five untouched).
  const gnumB = await openDealerEditor()
  const beforeB = await outcomeForGroup(gnumB)
  const changedKey = enums[0]
  const sel = reports.locator('select').first()  // the editor's first enum select (report table has none)
  const optVals = await sel.locator('option').evaluateAll(os => os.map(o => o.value))
  const newVal = optVals.find(v => v && v !== beforeB[changedKey])
  await sel.selectOption(newVal)
  const closedB = await saveClosed()
  assert(closedB, `Save-unchanged/${round} (b) — one-field-changed Save SUCCEEDS`)
  const afterB = await outcomeForGroup(gnumB)
  const untouched = enums.filter(k => k !== changedKey)
  assert(afterB != null && afterB[changedKey] === newVal
      && untouched.every(k => afterB[k] === beforeB[k]) && (round === '1978' || near(afterB.wage85, beforeB.wage85)),
    `Save-unchanged/${round} (b) — changed field saved (${changedKey}=${newVal}) AND all five untouched fields persist`)

  await reports.getByRole('button', { name: '✕' }).click()  // close the report modal
}

// ── No-deal → deal UI coverage (the editor's PRIMARY purpose: rescuing a no-deal group) ─────────
// A no-deal group has no stored contract, so the editor seeds every field to its DEFAULT (first
// option / status-quo wage). The exact repro: open a no-deal group's editor, check "Deal reached",
// leave the dropdowns at their displayed defaults, Save → must succeed (untouched fields submit
// their real defaults, not ''). Then change ONE field → that field + the untouched defaults persist.
// Each sub-test reloads (re-fetch) + reverts the group to no-deal so a no-deal row always remains.
async function driveNoDealToDeal(reports, round) {
  const enums = ISSUE_KEYS_BY_ROUND[round]
  const outcomeOf = r => (round === '1978' ? r?.outcome_1978 : r?.outcome_1985)
  const rowForGroup = async gnum => (await inst('getReportData')).rows.find(r => r.group_number === gnum)

  const freshReport = async () => {
    await reports.reload()
    await reports.waitForSelector('text=/\\d+ participants? ·/', { timeout: 30_000 })  // rows loaded
    await reports.getByText(`${round} Report`, { exact: true }).click()
    await reports.waitForSelector(`h3:has-text("${round} Report")`, { timeout: 15_000 })
  }
  // Open a NO-DEAL row's editor (Notes cell == exactly "No deal") + return its group number.
  const openNoDealEditor = async () => {
    const row = reports.getByRole('row').filter({ has: reports.getByRole('cell', { name: 'No deal', exact: true }) }).first()
    await row.getByRole('button', { name: 'Edit' }).click()
    await reports.waitForSelector(`h3:has-text("${round} contract")`, { timeout: 15_000 })
    const title = await reports.locator(`h3:has-text("${round} contract")`).innerText()
    return parseInt(title.match(/group\s+(\d+)/i)[1], 10)
  }
  const shownSelectVals = async () => {
    const out = {}
    for (let i = 0; i < enums.length; i++) out[enums[i]] = await reports.locator('select').nth(i).inputValue()
    return out
  }
  const saveClosed = async () =>
    reports.getByRole('button', { name: 'Save', exact: true }).click()
      .then(() => reports.waitForSelector(`h3:has-text("${round} contract")`, { state: 'detached', timeout: 15_000 }))
      .then(() => true).catch(() => false)
  const revertToNoDeal = async gnum => {
    const gid = (await rowForGroup(gnum))?.group_id
    if (gid) await inst('updateGroupContract', { groupId: gid, agreement_reached: false, round })
  }
  // The editor's own "Deal reached" checkbox (scoped by its label — the page has other checkboxes).
  const dealBox = () => reports.locator('label:has-text("Deal reached") input[type="checkbox"]')

  // (a) No-deal → check "Deal reached", change NOTHING, Save → succeeds with displayed defaults.
  await freshReport()
  const gA = await openNoDealEditor()
  assert((await dealBox().isChecked()) === false,
    `No-deal→deal/${round} — a no-deal group's editor opens with "Deal reached" UNCHECKED`)
  await dealBox().check()
  const defaultsA = await shownSelectVals()
  const closedA = await saveClosed()
  assert(closedA,
    `No-deal→deal/${round} (a) — check "Deal reached" + Save with UNTOUCHED defaults SUCCEEDS (the exact repro; no "must be one of … got ''")`)
  const afterA = outcomeOf(await rowForGroup(gA))
  assert(afterA != null && enums.every(k => afterA[k] === defaultsA[k]) && (round === '1978' || near(afterA.wage85, 10.69)),
    `No-deal→deal/${round} (a) — the displayed DEFAULTS persist (untouched fields saved their real defaults, not '')`)
  await revertToNoDeal(gA)  // restore so a no-deal row remains for (b) + downstream

  // (b) No-deal → check Deal reached, change ONE field, Save → that field + untouched defaults persist.
  await freshReport()
  const gB = await openNoDealEditor()
  await dealBox().check()
  const changedKey = enums[0]
  const sel = reports.locator('select').first()  // editor's first enum select (report table has none)
  const optVals = await sel.locator('option').evaluateAll(os => os.map(o => o.value))
  const cur = await sel.inputValue()
  const newVal = optVals.find(v => v && v !== cur)
  const defaultsB = await shownSelectVals()
  await sel.selectOption(newVal)
  const closedB = await saveClosed()
  assert(closedB, `No-deal→deal/${round} (b) — one-field-changed no-deal→deal Save SUCCEEDS`)
  const afterB = outcomeOf(await rowForGroup(gB))
  const untouched = enums.filter(k => k !== changedKey)
  assert(afterB != null && afterB[changedKey] === newVal
      && untouched.every(k => afterB[k] === defaultsB[k]) && (round === '1978' || near(afterB.wage85, 10.69)),
    `No-deal→deal/${round} (b) — changed field (${changedKey}=${newVal}) saved AND all untouched DEFAULTS persist`)
  await revertToNoDeal(gB)
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

// ── Latecomer placement + first-round GATE (Latecomer_Placement_Spec_v1, baxter) ──
// Appended after the full playthrough (seedGroupForTest wipes GID, so it cannot
// disturb the assertions above). Drives verifyAttendanceCode via callables + REST.
// The GATE is round-based: the SAME matched group places a latecomer in round 1
// (current_round 0 → slot 'flat') but NOT in round 2 (current_round 1 → 'keyed').

async function restPatch(path, fields, mask) {
  const q = mask.map(p => `updateMask.fieldPaths=${encodeURIComponent(p)}`).join('&')
  const res = await fetch(`${FIRESTORE}/${path}?${q}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  return res.ok
}
const ISO = () => new Date().toISOString()
const seedMatched = (gid, bax, uni, lead) =>
  callFn('seedGroupForTest', { game_instance_id: GID, group_id: gid, lead_id: lead, baxter_participants: bax, union_participants: uni })
const setRound = idx => restPatch(`game_instances/${GID}`, { current_round: { integerValue: String(idx) } }, ['current_round'])
const setGroupStatus = (gid, status) => restPatch(`game_instances/${GID}/groups/${gid}`, { status: { stringValue: status } }, ['status'])
const seedLatecomer = (pid, role) => restPatch(`game_instances/${GID}/participants/${pid}`, {
  participant_id: { stringValue: pid }, game_instance_id: { stringValue: GID },
  role: { stringValue: role }, confirmed_ready_at: { timestampValue: ISO() },
}, ['participant_id', 'game_instance_id', 'role', 'confirmed_ready_at'])
const markReady = pid => restPatch(`game_instances/${GID}/participants/${pid}`, { confirmed_ready_at: { timestampValue: ISO() } }, ['confirmed_ready_at'])
const genCode = () => inst('generateAttendanceCode')
const enterCode = (pid, code) => stu('verifyAttendanceCode', pid, { code })
async function lateState(pid) {
  const f = await readParticipantFields(pid)
  return { group_id: strVal(f.group_id) || null, absent: f.latecomer_absent?.booleanValue ?? false }
}

async function runLatecomerGate() {
  banner('LATECOMER placement + first-round GATE (Baxter)')

  // TEST 2 — round 1 (current_round 0), matched group → PLACED, like the negotiation games.
  await seedMatched('glr1', ['b1'], ['u1'], 'b1')
  await setRound(0)
  await seedLatecomer('lx', 'baxter')
  await enterCode('lx', (await genCode()).code)
  const lx = await lateState('lx')
  assert(lx.group_id === 'glr1', `Baxter 2 — round 1 latecomer PLACED into the matched group [${lx.group_id}]`)

  // TEST 3 — round 1, no joinable group (negotiating) → terminal message, not the spinner.
  await seedMatched('glr3', ['b2'], ['u2'], 'b2')
  await setGroupStatus('glr3', 'negotiating')   // not 'matched' → not joinable
  await setRound(0)
  await seedLatecomer('ly', 'baxter')
  await enterCode('ly', (await genCode()).code)
  const ly = await lateState('ly')
  assert(ly.group_id === null && ly.absent === true,
    `Baxter 3 — round 1, no joinable group → latecomer_absent set (terminal message), never placed`)

  // TEST 4 — THE GATE. Round 2 (current_round 1). The SAME matched, joinable group that
  // placed in round 1 must NOT place now; the block must not run at all.
  await seedMatched('glr4', ['b3'], ['u3'], 'b3')
  await setRound(1)                              // ROUND 2 (1983)
  await seedLatecomer('lz', 'baxter')
  const code2 = (await genCode()).code
  await enterCode('lz', code2)
  const lz = await lateState('lz')
  assert(lz.group_id === null && lz.absent === false,
    `Baxter 4 — round 2 GATE: placement did NOT run — no group_id AND NOT latecomer_absent (same group placed in round 1)`)

  // TEST 5 — round 2, a returning student WITH group_id → placement never considered.
  await markReady('b3')                          // seedGroupForTest omits confirmed_ready_at
  await enterCode('b3', code2)
  const b3 = await lateState('b3')
  assert(b3.group_id === 'glr4' && b3.absent === false,
    `Baxter 5 — round 2 returning student keeps their group_id, never placed or marked absent`)
}

async function main() {
  banner(`Baxter day-2 EMULATOR play-through — instance ${GID}`)
  console.log(`Frontend ${FE} · Functions ${FUNCTIONS} · Firestore ${FIRESTORE}\n`)

  // 0. Seed the known-good 1978 scheme (shared single source with the launcher's Prefill).
  await inst('updateScheme1978', { scheme1978: SCHEME_1978 })
  log('seed', 'scheme1978 written (85/62 baseline)')

  // Anti-backgrounding flags: with ~18 pages open, Chromium backgrounds/freezes the non-focused
  // dashboard tab and STALLS its setTimeout-driven reveal animation. These keep every page's timers
  // live regardless of focus (harness-only; the real single-tab instructor dashboard never freezes).
  browser = await chromium.launch({
    headless: !HEADED,
    slowMo: SLOWMO,
    args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  })

  // 1. Setup the 16 attending students (sequential → deterministic 8 Baxter / 8 Local 190 balance).
  for (const pid of PIDS) {
    const ctx = await browser.newContext()
    students.push(await driveSetup(await ctx.newPage(), pid))
  }
  const roles = students.map(s => s.role)
  log('setup', `roles: ${roles.join(', ')}`)

  // 1b. Setup ONE extra student (Slice 6 no-show): it bootstraps a role via driveSetup but is NEVER
  //     added to `students`, so it never attends, never matches, and stays group-less → a TRUE
  //     no-show at scoring time (normalized −2, raw null, excluded from the z-pool).
  const noShow = await driveSetup(await (await browser.newContext()).newPage(), NOSHOW_PID)
  log('setup', `no-show ${noShow.pid} (${noShow.role}) bootstrapped — will NOT attend`)

  // ── Slice 7: pre-1978 KC is SHARED (4 graded MC + 1 reflection), graded denom 4, gate excluded ──
  banner('Slice 7 — pre-1978 Knowledge Check (shared 4 MC + 1 reflection) + grading')
  {
    const baxPid = students.find(s => s.role === 'baxter').pid
    const uniPid = students.find(s => s.role === 'union').pid
    for (const [pid, role] of [[baxPid, 'baxter'], [uniPid, 'union']]) {
      const { questions } = await stu('getStudentPrepQuestions', pid)
      const gate   = questions.filter(q => q.category === 'knowledge_check' && q.system)
      const kcMc   = questions.filter(q => q.category === 'knowledge_check' && !q.system && q.type === 'mc')
      const refl   = questions.filter(q => q.category === 'preparation' && q.type === 'text')
      const likert = questions.filter(q => q.type === 'likert')
      assert(gate.length === 1,   `KC — ${role} sees exactly ONE role-gate question (ungraded, required)`)
      assert(kcMc.length === 4,   `KC — ${role} sees 4 graded MC (shared, role_target:all)`)
      assert(refl.length === 1,   `KC — ${role} sees 1 ungraded reflection (before 1978)`)
      assert(likert.length === 0, `KC — ${role} sees NO Likert before 1978 (debrief excluded from prep)`)
      assert(kcMc.every(q => q.correct_value == null), `KC — ${role} answer keys are stripped from the student payload`)
    }
    // Shared: both roles get the IDENTICAL non-system field set (role_target:all).
    const fieldsFor = async pid => (await stu('getStudentPrepQuestions', pid)).questions.filter(q => !q.system).map(q => q.field).sort()
    const bF = await fieldsFor(baxPid), uF = await fieldsFor(uniPid)
    assert(JSON.stringify(bF) === JSON.stringify(uF), 'KC — Baxter and Union get the IDENTICAL shared question set (role_target:all)')

    // Grading: KC_WRONG_PID answered Q1 wrong → 3/4 = 0.75; a fully-correct student → 1.0.
    // 0.75 (not 0.8) proves denominator = 4 — the ungraded role gate is NOT counted.
    const wrongScore = numVal((await readParticipantFields(KC_WRONG_PID)).knowledge_check_score)
    const rightPid   = students.find(s => s.pid !== KC_WRONG_PID).pid
    const rightScore = numVal((await readParticipantFields(rightPid)).knowledge_check_score)
    assert(wrongScore === 0.75, `KC grading — one wrong of four → 0.75 (denominator 4, gate excluded) [${KC_WRONG_PID}=${wrongScore}]`)
    assert(rightScore === 1,    `KC grading — all four correct → 1.0 [${rightPid}=${rightScore}]`)
  }

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

  // ── Part 2 — per-round REPORTING side (Baxter-local lead reassignment) ──────────────────────
  // 1978 reporter = Baxter Management: the lead assigned at matching (first role) reports; Local
  // confirms. (1983/1985 flip to Local at Begin 1983 — asserted in those sections below.)
  {
    const p1978 = await readParticipants()
    for (const gid of [...ratifiedGids, failRatifyGid, rejectGid]) {
      const lead = p1978.find(x => x.group_id === gid && x.is_lead)
      assert(lead?.role === 'baxter',
        `Part 2 — 1978 reporter is Baxter Management (group ${gid} lead is a Baxter member)`)
    }
  }

  // ── Slice 7: between-rounds "Looking ahead to 1985" Likert set (after 1978, before 1983) ──
  banner('Slice 7 — Looking-ahead Likert (after 1978, before 1983)')
  {
    const baxPid = students.find(s => s.role === 'baxter').pid
    const uniPid = students.find(s => s.role === 'union').pid
    for (const [pid, role] of [[baxPid, 'baxter'], [uniPid, 'union']]) {
      const { questions } = await stu('getDebriefQuestions', pid)
      const likert = questions.filter(q => q.type === 'likert')
      assert(likert.length === 3, `Likert — ${role} gets 3 debrief Likert items (shared)`)
      assert(likert.every(q => q.format === 'likert' && q.correct_value == null && q.grading == null),
        `Likert — ${role} items are UNGRADED (no correct_value / no grading)`)
      assert(likert.every(q => (q.options?.length ?? 0) === 7), `Likert — ${role} items are 1–7 scales`)
    }
  }
  // ── Part C — post-1978 flow order: 1) reaffirm/debrief → 2) Likert → 3) all-done ──
  banner('Part C — post-1978 flow order (reaffirm/debrief → Likert → all-done)')
  // 1) REAFFIRM/DEBRIEF FIRST. Every student lands on "Negotiation results" and submits the
  //    required reflection, which advances them into the Likert (proving reaffirm precedes Likert).
  await Promise.all(students.map(s => driveReaffirm(s)))
  assert(true, 'Part C — reaffirm/debrief screen (group + deal + reflection) shown FIRST, before the Likert')
  {
    const f = await readParticipantFields(students[0].pid)
    assert(f.debrief_submitted_at != null, 'Part C — reaffirm/debrief persisted (debrief_submitted_at set) before the Likert')
  }
  // 2) THEN the Likert. Render + submit in-browser — proves it comes AFTER reaffirm and BEFORE 1983.
  await Promise.all(students.map(s => driveLookingAhead(s)))
  assert(true, 'Part C — Likert ("Looking ahead to 1985") shown SECOND (after reaffirm/debrief) + submitted before Open Round 2')
  {
    const f = await readParticipantFields(students[0].pid)
    assert(f.looking_ahead_submitted_at != null, 'Likert — response persisted (looking_ahead_submitted_at set)')
    assert(LIKERT_FIELDS.every(field => strVal(f[field]) === LIKERT_RATINGS[students[0].role][field]),
      'Likert — all three ratings stored on the participant doc')
  }
  // 3) THEN the all-done screen, with the new "Part 2 … next class" line.
  {
    const s0 = students[0]
    await s0.page.waitForSelector('h1:has-text("You\'re all done")', { timeout: 15_000 })
    const body = (await s0.page.locator('main').innerText()).replace(/\s+/g, ' ')
    assert(/Part 2 of this negotiation will take place during the next class/.test(body),
      'Part C — all-done screen adds the "Part 2 … during the next class" line')
    assert(/close this tab/i.test(body), 'Part C — all-done keeps the existing "you can close this tab" text')
  }

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

  // ── Phase-aware role-info: 1978 (current_round=0, before Open Round 2 Attendance) ──
  banner('Role documents — 1978 phase serving + file resolution + header')
  {
    const baxStu = students.find(s => s.role === 'baxter')
    const uniStu = students.find(s => s.role === 'union')
    await assertRoleInfoServing('1978', baxStu.pid, uniStu.pid)
    await assertRoleInfoFilesResolve()
    assert(true, 'Role-info — all 10 placed documents resolve over the frontend origin (no 404)')
    // Persistent header shows the 1978 docs for a baxter student now (captured for the round-change proof).
    await baxStu.page.waitForSelector('header nav a[href*="1978-baxter"]', { timeout: 20_000 })
    const h1978 = await headerHrefs(baxStu.page)
    assert(h1978.some(h => h && h.includes('/role-info/1978-baxter')),
      `Role-info header — baxter student header shows the 1978 docs in 1978: ${h1978.join(', ')}`)
    assert(!h1978.some(h => h && (h.includes('1983-') || h.includes('1985-'))),
      'Role-info header — baxter student header shows ONLY 1978 docs in 1978 (no later-round links)')
  }

  // #1 (part b): now that round 1 is completed, the gate button appears → drive it.
  await dash.reload(); await sleep(2500)
  await dash.waitForSelector('button:has-text("Open Round 2 Attendance")', { timeout: 15_000 })
  assert(true, '#1 — "Open Round 2 Attendance" SHOWN after all round-1 groups complete')
  // ── Part 3.10 baseline — in 1978 (current_round 0) a finished group's members read "Completed"
  // on the dashboard roster. The relabel must NOT touch this: only the day-2 pre-negotiation window.
  {
    const completed = await dash.locator('[data-testid="roster-table"] [data-status="Completed"]').count()
    assert(completed >= 16,
      `Part 3.10 baseline — 1978 finished members read "Completed" (relabel off in-round) [${completed}]`)
  }
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
  // ── Part 1 (day-2 absence) — one non-lead UNION member of the 1985-dealing group (A) is a
  // DAY-2 ABSENTEE: they finished 1978 + submitted the Likert, then NEVER re-confirm attendance
  // for 1983/1985. Group A has 2 union members, so removing one leaves it non-degenerate. The
  // reported bug: this absent member sat in the 1985 required-confirmation set forever, so the
  // group reached a 1985 deal but could never commit. The fix (beginRound2 stamps 1985 presence
  // for the present set only) must exclude them → the group commits on the present confirmations.
  const gidA_p1 = ratifiedGids[0]
  const partsForAbsence = await readParticipants()
  const absentee = students.find(s => {
    const p = partsForAbsence.find(x => x.id === s.pid)
    return p && p.group_id === gidA_p1 && p.role === 'union' && !p.is_lead
  })
  assert(absentee != null, 'Part 1 setup — a non-lead union member of the 1985-dealing group (A) is the day-2 absentee')
  const presentStudents = students.filter(s => s !== absentee)
  await Promise.all(presentStudents.map(s => reAttend(s.page, s.pid, code83)))
  assert(true, 'Bug A — all PRESENT completed-1978 students re-attended for 1983 (not stranded on results)')

  // BUG F: on round-2 pre-Begin, students see a WAITING hold with NO clickable Start button.
  banner('Bug F — pre-Begin waiting state, no Start button')
  await Promise.all(presentStudents.map(async s => {
    await s.page.waitForSelector('h1:has-text("checked in")', { timeout: 30_000 })
    const startVisible = await s.page.locator('button:has-text("Start negotiation")').isVisible().catch(() => false)
    assert(!startVisible, `Bug F — ${s.pid}: NO "Start negotiation" button before Begin 1983`)
  }))

  // B: "Begin 1983" is shown now; click it. Afterwards it must NOT reappear.
  await dash.reload(); await sleep(2500)
  await dash.waitForSelector('button:has-text("Begin 1983")', { timeout: 15_000 })
  assert(true, 'B — "Begin 1983" shown after Open Round 2 Attendance')
  // ── Part 3.10 — DAY-2 PRE-NEGOTIATION window: the class has advanced to 1983 (Open Round 2
  // Attendance) but "Begin 1983" has NOT re-opened the groups yet, so members still carry their
  // 1978 'completed'. The dashboard relabels that carried "Completed" → "Prepared" for present
  // members; no stale "Completed" remains. (Baxter-local flag; hosting-only relabel.)
  {
    await dash.waitForSelector('[data-testid="roster-table"]', { timeout: 15_000 })
    const prepared  = await dash.locator('[data-testid="roster-table"] [data-status="Prepared"]').count()
    const completed = await dash.locator('[data-testid="roster-table"] [data-status="Completed"]').count()
    assert(prepared >= 16 && completed === 0,
      `Part 3.10 — day-2 pre-negotiation: carried "Completed" reads "Prepared", none stale "Completed" [prepared=${prepared} completed=${completed}]`)
  }
  await dash.click('button:has-text("Begin 1983")')
  log('instr', 'clicked "Begin 1983" (re-opens groups → negotiating)')

  // ── Part 1 — the absence-cutoff (beginRound2) must carry the PRESENT set forward to 1985 so the
  // 1985 required-confirmation set excludes the day-2 absentee. Assert the presence bookkeeping:
  // the absentee has NO 1983 presence (they never re-confirmed), while present group-A members now
  // carry a STAMPED 1985 presence (attendance_by_round.1985) — the fix that lets 1985 commit without them.
  {
    const has1985 = async pid => {
      const f = await readParticipantFields(pid)
      return f.attendance_by_round?.mapValue?.fields?.['1985'] != null
    }
    const has1983 = async pid => {
      const f = await readParticipantFields(pid)
      return f.attendance_by_round?.mapValue?.fields?.['1983'] != null
    }
    // "Begin 1983" runs beginRound2 server-side async — poll until it commits (present group-A
    // members gain the stamped 1985 presence) before asserting the presence bookkeeping.
    const presentA = presentStudents.filter(s => partsForAbsence.find(x => x.id === s.pid)?.group_id === gidA_p1)
    let stamped = []
    for (let i = 0; i < 20; i++) {
      stamped = await Promise.all(presentA.map(s => has1985(s.pid)))
      if (presentA.length > 0 && stamped.every(Boolean)) break
      await sleep(1000)
    }
    assert(presentA.length > 0 && stamped.every(Boolean),
      'Part 1 — beginRound2 STAMPS 1985 presence for every PRESENT group-A member (day-2 present set carried to 1985)')
    assert(!(await has1983(absentee.pid)) && !(await has1985(absentee.pid)),
      'Part 1 — day-2 absentee has NO 1983 AND NO 1985 presence (correctly excluded from the active roster)')
  }

  // BUG F (resume): the hold advances into the 1983 negotiation once the group is re-opened.
  await Promise.all(presentStudents.map(async s => {
    await s.page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 30_000 })
  }))
  assert(true, 'Bug F — present students advance into the 1983 negotiation after Begin 1983')

  await dash.reload(); await sleep(2500)
  {
    const stillThere = await dash.locator('button:has-text("Begin 1983")').isVisible().catch(() => false)
    assert(!stillThere, 'B — "Begin 1983" does NOT reappear once the round has begun')
    // Part 3.10 — once "Begin 1983" re-opens the groups (round2Begun), the pre-negotiation window
    // CLOSES: members read their live "Negotiating" status, not the relabel. Proves the relabel is
    // scoped to the between-rounds window (Completed → Prepared → Negotiating across the boundaries).
    const negotiating = await dash.locator('[data-testid="roster-table"] [data-status="Negotiating"]').count()
    assert(negotiating >= 16,
      `Part 3.10 — after Begin 1983 the roster shows live "Negotiating" (relabel window closed) [${negotiating}]`)
  }

  // ── Phase-aware role-info: 1983 (current_round=1) — round-correct switch ──
  {
    const baxStu = students.find(s => s.role === 'baxter')
    const uniStu = students.find(s => s.role === 'union')
    await assertRoleInfoServing('1983', baxStu.pid, uniStu.pid)
    assert(true, 'Role-info — advancing to 1983 switched both roles to the 1983 docs (round-correct)')
  }

  // ── Slice 3 + 1983 redo-loop: A redo→deal a wage, B no-deals, C (rejecter) idle ──
  banner('1983 negotiation — group A redo→deal a wage, group B no-deals')
  // Everyone (present) taps "We've finished" to reach the 1983 report / confirm screens.
  await Promise.all(presentStudents.map(s => s.page.click("button:has-text(\"We've finished\")").catch(() => {})))

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
  // Part 2 — 1983 reporting side FLIPPED to Local 190 at "Begin 1983" (beginRound2 reassigned the
  // group lead from the Baxter side to a present Local member). The Local lead reports; Baxter confirms.
  assert(leadA.role === 'union',
    `Part 2 — 1983 reporter is Local 190 (lead flipped to the Local side at Begin 1983) [lead role=${leadA.role}]`)
  // Part 2 + day-2 absence — the day-2-absent Local member is NOT the promoted lead; a PRESENT Local
  // partner was promoted instead (reassignment applied to the new reporting side).
  assert(leadA.pid !== absentee.pid,
    'Part 2 + day-2 absence — the absent Local member was NOT made lead; a present Local partner was promoted')
  // Part 1 — group A carries the day-2 absentee: drive the 1983 accept/redo loop over the PRESENT
  // non-leads only (the absentee is not in 1983's presence-filtered required set, so it never blocks).
  const presentNonA = nonA.filter(m => m.pid !== absentee.pid)
  assert(presentNonA.some(m => m.role === 'baxter'),
    'Part 2 — 1983 Baxter Management side CONFIRMS (present non-lead includes a Baxter member)')
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
  await presentNonA[0].page.waitForSelector('h1:has-text("Confirm")', { timeout: 30_000 })
  // Fix 2 — reject is confirm-gated in 1983 too, but here it is NON-terminal (accept/redo loop):
  // the confirm copy says the outcome goes back to the lead, and confirming triggers the redo.
  await presentNonA[0].page.click('button:has-text("Reject")')
  await presentNonA[0].page.waitForSelector('h1:has-text("Are you sure")', { timeout: 10_000 })
  assert(true, 'Fix 2 — 1983 Reject is confirm-gated (non-terminal: confirm sends the outcome back to the lead)')
  await presentNonA[0].page.click('button:has-text("Yes, reject")')
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
  await Promise.all(presentNonA.map(async (s, i) => {
    await s.page.waitForSelector('h1:has-text("Confirm")', { timeout: 30_000 })
    await s.page.click('button:has-text("Confirm")')
    // Part R (assertion 4) — 1983 has NO ratification gate: confirming shows NO warning (Confirm
    // commits directly). Checked on the first confirmer.
    if (i === 0) {
      const warned = await s.page.waitForSelector('h1:has-text("Are you sure")', { timeout: 2_000 })
        .then(() => true).catch(() => false)
      assert(!warned, '1978 ratify-warn — NO ratification warning in 1983 (no gate outside 1978)')
    }
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
    // Part D — the queue row identifies the group by NUMBER ("Group N"), NOT the raw UUID.
    const rowText = await dash.locator('div:has(> button:has-text("Resolve arbitration"))').first().innerText().catch(() => '')
    assert(/Group\s+\d+/.test(rowText) && !rowText.includes(gidB),
      `Part D — arbitration queue row shows the GROUP NUMBER, not the UUID [row="${rowText.replace(/\s+/g, ' ').trim()}"]`)
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

  // ── Slice 8: arbitration REVEAL animation (cosmetic wrapper over resolveArbitration) ──
  banner('arbitration reveal — cosmetic animation of the ALREADY-DECIDED outcome')
  {
    await dash.bringToFront()
    await dash.reload(); await sleep(2500)
    // 1) BAXTER outcome via the dashboard "▶ Play reveal" button. Reads the STORED (real) side +
    //    wage that resolveArbitration wrote for group B above (Baxter / $8.67) — integration path.
    const playBtn = dash.locator('button:has-text("Play reveal")').first()
    assert(await playBtn.isVisible().catch(() => false), 'Reveal — "▶ Play reveal" button shown for the resolved group')
    await playBtn.click()
    assert(await dash.locator('[data-el="stage"]').isVisible().catch(() => false), 'Reveal — component MOUNTS (stage renders) on play, no error')
    await dash.waitForSelector('[data-el="cardVerdict"]:has-text("Management Prevails")', { timeout: 12_000 })
    const baxWage = (await dash.locator('[data-el="cardWage"]').textContent())?.trim()
    assert(baxWage === '$8.67 / hr', `Reveal — BAXTER verdict "Management Prevails" + fixed $8.67 award [got "${baxWage}"]`)
    assert(near(arb.wage, 8.67) && baxWage === `$${arb.wage.toFixed(2)} / hr`,
      'Reveal — displayed wage EQUALS the wage resolveArbitration wrote (read from the group doc, not recomputed)')
    await dash.click('button:has-text("Dismiss")')
    await dash.waitForSelector('[data-el="stage"]', { state: 'detached', timeout: 8_000 })

    // 2) UNION outcome via the emulator-only "Test union reveal" button (same ref.playVerdict the
    //    resolve fires; the seeded run only produces one Baxter outcome). The wage is INJECTED per
    //    group (here $9.50) and must render as a real number — NOT the {{unionWage}} placeholder.
    const unionBtn = dash.locator('button:has-text("Test union reveal")')
    assert(await unionBtn.isVisible().catch(() => false), 'Reveal — emulator "Test union reveal" seam present')
    await unionBtn.click()
    await dash.waitForSelector('[data-el="stage"]', { timeout: 8_000 })
    await dash.waitForSelector('[data-el="cardVerdict"]:has-text("The Union Prevails")', { timeout: 12_000 })
    const uniWage = (await dash.locator('[data-el="cardWage"]').textContent())?.trim()
    assert(uniWage === '$9.50 / hr', `Reveal — UNION verdict "The Union Prevails" + INJECTED wage $9.50 [got "${uniWage}"]`)
    assert(!/\{\{|unionWage/.test(uniWage ?? ''), 'Reveal — Union wage is the injected number, NOT the {{unionWage}} placeholder')
    await dash.click('button:has-text("Dismiss")')
    await dash.waitForSelector('[data-el="stage"]', { state: 'detached', timeout: 8_000 })
  }
  // Mechanics UNCHANGED: the animation is a pure wrapper — resolveArbitration still decided
  // Baxter/$8.67 (seed 1) and wrote wage83 8.67; the reveal added no change to RNG / wage / scoring.
  assert(arb.side === 'baxter' && near(arb.wage, 8.67) && near(g83b.find(x => x.id === gidB)?.wage83, 8.67),
    'Reveal — resolveArbitration mechanics UNCHANGED (seed 1 → Baxter/$8.67, wage83 intact)')

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

  // ── Part B — a 1978-NO-DEAL group arbitrates 1983 with the $10.69 status-quo wage ──
  // Group C reached NO 1978 deal (null outcome), so under Part B its 1978 wage is the status-quo
  // $10.69: arbitration must NOT block on "resolve 1978 first", and the Union branch pays $10.69.
  // We PROBE C's arbitration here (C is completed with no 1983 wage) with a Union-forcing seed,
  // then REVERT its 1983 slot so the frozen A/B class-average transform numbers below are unaffected
  // (C stays no-1983-wage into 1985, exactly as the existing assertions expect).
  {
    let arbC = null, blocked = null
    try { arbC = await inst('resolveArbitration', { group_id: rejectGid, seed: 2 }) }  // seed 2 → Union branch
    catch (e) { blocked = e instanceof Error ? e.message : String(e) }
    assert(blocked === null,
      `Part B — 1978-no-deal group arbitrates with NO "resolve 1978 first" block [${blocked ?? 'no block'}]`)
    assert(arbC && arbC.side === 'union' && near(arbC.wage, 10.69),
      `Part B — Union-branch arbitration pays the $10.69 status-quo 1978 wage [side=${arbC?.side} wage=${arbC?.wage}]`)
    // Revert the probe write: clear outcomes_by_round (removes wage83) + delete arbitration_1983.
    await fsPatchGroup(rejectGid, { outcomes_by_round: { mapValue: { fields: {} } } }, ['outcomes_by_round', 'arbitration_1983'])
    const cAfter = (await readGroupsFull()).find(x => x.id === rejectGid)
    assert(cAfter?.wage83 == null,
      'Part B — arbitration probe reverted (C back to no 1983 wage; frozen class-average numbers intact)')
  }

  // Proceed 1983→1985 (same-session generic advanceRound: re-opens every group; day-2 presence
  // carries forward so students flow straight into 1985 with no re-attendance).
  const adv = await inst('advanceRound')
  log('instr', `advanceRound → round ${adv.current_round} (${adv.round_id})`)
  await Promise.all(presentStudents.map(s => s.page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 30_000 })))
  assert(adv.round_id === '1985', 'Proceed — advanceRound moved the class to 1985 (present students re-flow into the negotiation)')

  // ── Phase-aware role-info: 1985 (current_round=2) — incl. the self-scoring sheets + header update ──
  {
    const baxStu = students.find(s => s.role === 'baxter')
    const uniStu = students.find(s => s.role === 'union')
    await assertRoleInfoServing('1985', baxStu.pid, uniStu.pid)
    assert(true, 'Role-info — advancing to 1985 switched both roles to the 1985 docs (case + self-scoring sheet)')
    // Persistent header must have SWAPPED to the 1985 docs on the round change (re-fetch on advance).
    await baxStu.page.waitForSelector('header nav a[href*="1985-baxter"]', { timeout: 20_000 })
    const h1985 = await headerHrefs(baxStu.page)
    assert(h1985.some(h => h && h.includes('/role-info/1985-baxter')),
      `Role-info header — baxter student header UPDATED to the 1985 docs after advancing: ${h1985.join(', ')}`)
    assert(!h1985.some(h => h && (h.includes('1978-') || h.includes('1983-'))),
      'Role-info header — the header no longer shows the earlier rounds\' docs (links swapped, not appended)')
  }
  // Everyone (present) taps "We've finished" to reach the 1985 report / confirm screens.
  await Promise.all(presentStudents.map(s => s.page.click("button:has-text(\"We've finished\")").catch(() => {})))

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

  // ── Fix 2 — reject-confirm: a terminal (ultimatum) reject must NOT commit on the first click ──
  // The receiver clicks Reject → a confirm step ("Are you sure?") appears; the group stays OPEN.
  await nonB85[0].page.click('button:has-text("Reject")')
  await nonB85[0].page.waitForSelector('h1:has-text("Are you sure")', { timeout: 10_000 })
  assert(true, 'Fix 2 — 1985 Reject opens a confirmation step ("Are you sure?"), does not commit on the first click')
  {
    const b0 = (await readGroupsFull()).find(x => x.id === gidB)
    assert(b0?.status !== 'completed' && b0?.wage85 == null,
      'Fix 2 — reject WITHOUT confirm does NOT terminate the 1985 negotiation (group still open, no no-deal recorded)')
  }
  // "No, go back" is a real escape hatch — it returns to the outcome-review screen, still open.
  await nonB85[0].page.click('button:has-text("No, go back")')
  await nonB85[0].page.waitForSelector('h1:has-text("Confirm the outcome")', { timeout: 10_000 })
  assert(true, 'Fix 2 — "No, go back" returns to the outcome-review screen (an accidental Reject is recoverable)')
  {
    const b1 = (await readGroupsFull()).find(x => x.id === gidB)
    assert(b1?.status !== 'completed',
      'Fix 2 — after cancelling the reject, the group is STILL open (no no-deal was written)')
  }
  // Now reject FOR REAL: Reject → confirm. Only the explicit second click ends the negotiation.
  await nonB85[0].page.click('button:has-text("Reject")')
  await nonB85[0].page.waitForSelector('h1:has-text("Are you sure")', { timeout: 10_000 })
  await nonB85[0].page.click('button:has-text("Yes, reject")')
  {
    const gs = await pollGroupsFull(g => g.find(x => x.id === gidB)?.status === 'completed', 30_000)
    const b = gs.find(x => x.id === gidB)
    assert(b?.status === 'completed' && b?.wage85 == null,
      'Fix 2 — reject WITH confirm DOES terminate (only the explicit second click ends it as no-deal)')
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
  // Part 1 — group A still carries the day-2 absentee. Only the PRESENT non-leads confirm; the
  // absentee never re-attended so it is not in the 1985 required-confirmation set. BEFORE the fix
  // this group would hang at "all present confirmed but not committed" (the absentee stuck the set).
  const gA85 = groups85[gidA]; const leadA85 = gA85.find(m => m.is_lead) ?? gA85[0]; const nonA85 = gA85.filter(m => m !== leadA85)
  // Part 2 — 1985 reporter is STILL Local 190: advanceRound (1983→1985) preserves the lead flag, so
  // the Local lead set at Begin 1983 carries into 1985 with no extra reassignment. Baxter confirms.
  assert(leadA85.role === 'union',
    `Part 2 — 1985 reporter is Local 190 (Local lead carried forward by advanceRound) [lead role=${leadA85.role}]`)
  const presentNonA85 = nonA85.filter(m => m.pid !== absentee.pid)
  assert(presentNonA85.some(m => m.role === 'baxter'),
    'Part 2 — 1985 Baxter Management side CONFIRMS (present non-lead includes a Baxter member)')
  assert(nonA85.some(m => m.pid === absentee.pid) && presentNonA85.length === nonA85.length - 1,
    'Part 1 — the day-2 absentee is STILL a roster member of the 1985-dealing group A (present non-leads are one fewer)')
  await fill1985(leadA85.page, DEAL_B_1985)
  await leadA85.page.click('button:has-text("Review & submit")')
  await leadA85.page.waitForSelector('h1:has-text("Confirm outcome")', { timeout: 10_000 })
  await leadA85.page.click('button:has-text("Yes, submit")')
  await Promise.all(presentNonA85.map(async (s, i) => {
    await s.page.waitForSelector('h1:has-text("Confirm")', { timeout: 30_000 })
    await s.page.click('button:has-text("Confirm")')
    // Part R (assertion 4) — 1985 has NO ratification gate: confirming shows NO warning.
    if (i === 0) {
      const warned = await s.page.waitForSelector('h1:has-text("Are you sure")', { timeout: 2_000 })
        .then(() => true).catch(() => false)
      assert(!warned, '1978 ratify-warn — NO ratification warning in 1985 (no gate outside 1978)')
    }
  }))
  {
    // Part 1 — the group COMMITS on the present confirmations alone (status completed + wage85
    // stored) even though the absentee never confirmed. This is the core fix: a day-2-absent
    // member no longer blocks round completion.
    const gs = await pollGroupsFull(g => { const a = g.find(x => x.id === gidA); return a?.status === 'completed' && a?.wage85 != null }, 30_000)
    assert(near(gs.find(x => x.id === gidA)?.wage85, 9.00),
      '1985 six-issue form SUBMITS — group A wage85 = $9.00 stored (continuous, server-validated)')
    assert(gs.find(x => x.id === gidA)?.status === 'completed',
      'Part 1 — group A COMPLETES 1985 on the PRESENT confirmations alone; the day-2 absentee did NOT block round completion')
    const absF = await readParticipantFields(absentee.pid)
    assert(absF.attendance_by_round?.mapValue?.fields?.['1985'] == null,
      'Part 1 — the absentee never gained 1985 presence, yet the group still committed (excluded, not silently marked present)')
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
    // Part 1 — the day-2 ABSENTEE is a group-A union member: it is scored WITH the committed deal
    // (52.85), not dropped to a no-show floor. Proves the group both completed AND scored the deal.
    const absRaw = parts.find(p => p.id === absentee.pid)?.raw_score
    assert(near(absRaw, 52.85, 0.1),
      `Part 1 — the day-2 absentee is scored with group A's committed 1985 deal (raw 52.85) [got ${absRaw}]`)
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

  // ══ TERMINAL (Slice 6) — z-score ONCE within role (sample SD ÷N−1) + gradebook push ═══════
  banner('terminal — z-score (two pools, sample SD ÷N−1) + fire the gradebook push once')
  const cb = await startMockCallback()
  await scoreAndPush(cb.url)   // the ONE terminal scoreAndRecord that fires the push (callback wired)
  await sleep(2000)
  {
    const parts = await readParticipants()
    const roleBearing = parts.filter(p => p.role === 'baxter' || p.role === 'union')

    // (a) Two-pool z with SAMPLE SD (÷N−1), proven DISTINCT from population SD (÷N). Each role is
    //     normalized only within its own pool of non-null final raws.
    const zProof = (roleKey) => {
      const pool = parts.filter(p => p.role === roleKey && p.raw_score != null)
      const n = pool.length
      const mean = pool.reduce((a, p) => a + p.raw_score, 0) / n
      const ss = pool.reduce((a, p) => a + (p.raw_score - mean) ** 2, 0)
      const sampSD = Math.sqrt(ss / (n - 1))   // ÷N−1 (Excel STDEV)
      const popSD  = Math.sqrt(ss / n)          // ÷N
      const probe = pool.find(p => Math.abs(p.raw_score - mean) > 0.5)
      const zSamp = (probe.raw_score - mean) / sampSD
      const zPop  = (probe.raw_score - mean) / popSD
      assert(near(probe.normalized_score, zSamp, 0.001),
        `Terminal z — ${roleKey} normalized = SAMPLE-SD z (÷N−1) within its own pool (n=${n})`)
      assert(Math.abs(probe.normalized_score - zPop) > 0.02,
        `Terminal z — ${roleKey} normalized is NOT population-SD z (÷N=${zPop.toFixed(4)}) — provably ÷N−1`)
      return n
    }
    const nBax = zProof('baxter')
    const nUni = zProof('union')

    // (b) TRUE NO-SHOW → normalized −2, raw null.
    const ns = parts.find(p => p.id === NOSHOW_PID)
    assert(ns && ns.normalized_score === -2 && ns.raw_score == null,
      'Terminal — true no-show → normalized_score = −2, raw_score = null')

    // (c) No-show EXCLUDED from the pools: the two pools sum to 16 (the attending students), NOT 17.
    assert(nBax === 8 && nUni === 8,
      `Terminal — no-show EXCLUDED from pool (Baxter n=${nBax}, Union n=${nUni}; the no-show is in neither)`)

    // (d) WALK-AWAY INCLUDED: group C (ultimatum reject → reached table, no deal) carries a real raw
    //     and a real z (not −2/null), so it is counted in the n=8 Baxter pool above.
    const cWalk = parts.filter(p => p.group_id === rejectGid && p.role === 'baxter')
    assert(cWalk.length > 0 && cWalk.every(p => p.raw_score != null && p.normalized_score != null && p.normalized_score !== -2),
      'Terminal — walk-away (group C: reached table / no deal) INCLUDED in the pool (real raw + real z)')

    // (e) The push fired ONCE, at the terminal step, with the z-scored payload over the EXISTING
    //     dispatchResults → receiveGameResult handshake (only the URL was redirected to the mock).
    assert(cb.received.length === roleBearing.length,
      `Terminal push — fired once: ${cb.received.length} GameResults posted (16 scored + 1 no-show = ${roleBearing.length})`)
    assert(cb.received.length > 0 && cb.received.every(r => r.auth === `Bearer ${CALLBACK_SECRET}`),
      'Terminal push — every POST carried the callback secret (existing handshake, URL-redirected only)')
    const probe = roleBearing.find(p => p.role === 'baxter' && p.group_id === gidA)
    const pushed = cb.received.map(r => r.result).find(r => r.participant_id === probe.id)
    assert(pushed && pushed.status === 'completed' && near(pushed.normalized_score, probe.normalized_score, 1e-9),
      'Terminal push — payload carries the REAL z-scored normalized_score (matches stored), status completed')
  }
  await cb.close()

  // ══ Parts A / B / E / F — three Baxter reports, edit-contract save, no-deal wage, scatter ═══════
  banner('Parts A/B/E/F — Baxter reports (labels/columns), edit-contract SAVE, no-deal wage, scatter')
  {
    // ── Data-level (getReportData): rows carry every per-round Baxter figure (Parts B + E + F) ──
    const rd = await inst('getReportData')
    const rows = rd.rows ?? []
    assert(rows.length === 16, `Reports — getReportData returns all 16 finalized participants [${rows.length}]`)

    // Part B — the 1978-no-deal group (C, rejecter) shows wage $10.69 + "No deal" in the 1978 report.
    const cRows = rows.filter(r => r.group_id === rejectGid)
    assert(cRows.length > 0 && cRows.every(r => near(r.wage_1978, 10.69) && r.agreement_1978 === false),
      `Part B — 1978-no-deal group shows wage $10.69 + "No deal" in the 1978 report [${cRows.map(r => r.wage_1978).join(',')}]`)

    // Parts 3.8 + 3.9 — the FAILED-RATIFICATION dealer (D: reached a 1978 DEAL with wages=above_top3
    // [$12.69 nominal] but Transfer=Some → NOT ratified). The deal is void, so the report must show
    // it as a NO-DEAL: agreement reached but NOT ratified, and its EFFECTIVE 1978 wage is the $10.69
    // status quo (NOT the nominal $12.69 the dead contract named).
    const dRows = rows.filter(r => r.group_id === failRatifyGid)
    assert(dRows.length > 0 && dRows.every(r => r.agreement_1978 === true && r.ratified_1978 === false),
      'Part 3.8 — failed-ratification group: agreement reached (true) but NOT ratified (false)')
    assert(dRows.length > 0 && dRows.every(r => near(r.wage_1978, 10.69)),
      `Part 3.9 — failed-ratification 1978 wage = $10.69 status quo, NOT the nominal $12.69 [${dRows.map(r => r.wage_1978).join(',')}]`)

    // Part E/1978 — a ratified dealer (group A) carries its agreed options + $11.69 wage + score 85.
    const aBax = rows.find(r => r.group_id === gidA && r.role === 'baxter')
    assert(aBax && aBax.outcome_1978 && aBax.outcome_1978.location === 'deloitte' && aBax.outcome_1978.transfer === 'most',
      'Part E/1978 — dealer row carries the agreed six-issue 1978 outcome')
    assert(aBax && near(aBax.wage_1978, 11.69) && aBax.score_1978 === 85,
      `Part E/1978 — dealer 1978 wage $11.69 + raw score 85 [wage=${aBax?.wage_1978} score=${aBax?.score_1978}]`)

    // Part E/1983 — group A carries its 1983 wage ($9.50) + adjusted score (80.4 Baxter).
    assert(aBax && near(aBax.wage_1983, 9.50) && near(aBax.score_1983, 80.4),
      `Part E/1983 — dealer 1983 wage $9.50 + adjusted score 80.4 [wage=${aBax?.wage_1983} adj=${aBax?.score_1983}]`)

    // Part E/1985 — group A carries its six-issue 1985 contract + 1985 score 97.95 + TOTAL 178.35;
    //   and TOTAL equals the terminal raw_score for every scored row (report ⇄ gradebook consistency).
    assert(aBax && aBax.outcome_1985 && near(aBax.score_1985, 97.95) && near(aBax.total_score, 178.35),
      `Part E/1985 — dealer 1985 score 97.95 + TOTAL 178.35 [1985=${aBax?.score_1985} total=${aBax?.total_score}]`)
    assert(rows.every(r => r.total_score == null || near(r.total_score, r.raw_score, 0.01)),
      'Part E — every report TOTAL equals the participant terminal raw_score (report matches the gradebook)')

    // Part F — scatter data: each group yields one point (Baxter total vs Union total).
    const groupTotals = new Map()
    for (const r of rows) {
      if (r.group_number == null || r.total_score == null) continue
      const e = groupTotals.get(r.group_number) ?? {}
      if (r.role === 'baxter') e.b = r.total_score; else if (r.role === 'union') e.u = r.total_score
      groupTotals.set(r.group_number, e)
    }
    const points = [...groupTotals.values()].filter(e => e.b != null && e.u != null)
    assert(points.length >= 1, `Part F — scatter has data (${points.length} group points: Baxter total vs Union total)`)

    // ── UI-level (reports page): Baxter labels/titles + populated edit form + scatter renders ──
    const reports = await (await browser.newContext()).newPage()
    await reports.goto(`${FE}/reports?_dev_game_instance_id=${encodeURIComponent(GID)}&_session=tab`)
    await reports.waitForSelector('text=1978 Report', { timeout: 30_000 })
    // Wait for the page's getReportData to RESOLVE (each report tile shows the finalized count once
    // rows load) so the assertions below run against loaded data, not the transient loading state
    // (rows null → disabled tiles + an empty scatter).
    await reports.waitForSelector('text=/\\d+ participants? ·/', { timeout: 30_000 })

    // Part F — the scatter tile renders WITH data (points present), not the empty placeholder.
    assert(await reports.locator('text=/N = \\d+ group/').count() > 0,
      'Part F — scatter renders WITH data (point-count label present), not an empty grid')
    assert(await reports.locator('text=No completed groups yet.').count() === 0,
      'Part F — scatter is NOT the empty "No completed groups yet" placeholder')

    // Part E/1978 — open the 1978 Report: Baxter labels/columns, NO Winemaster labels/roles.
    await reports.getByText('1978 Report', { exact: true }).click()
    await reports.waitForSelector('h3:has-text("1978 Report")', { timeout: 15_000 })
    for (const label of ['Location of New Plant', 'Transfer of Local 190', 'Escalator Clause', 'Raw score', 'Notes']) {
      assert(await reports.locator(`th:has-text("${label}")`).count() > 0, `Part E/1978 — column "${label}" present`)
    }
    for (const gone of ['Shares', 'Vesting', 'Board seat', 'Liability']) {
      assert(await reports.locator(`th:has-text("${gone}")`).count() === 0, `Part E/1978 — Winemaster column "${gone}" REMOVED`)
    }
    assert(await reports.locator('td:has-text("Baxter Management")').count() > 0
        && await reports.locator('td:has-text("Local 190")').count() > 0,
      'Part E — roles render as Baxter Management / Local 190 (not Winemaster / Home Base)')

    // Part 3.8 (rendered) — the failed-ratification group's Notes cell reads "No deal (failed
    // ratification)", NOT "Deal" (the deal is void). The distinct third label must appear in the table.
    assert(await reports.locator('td:has-text("No deal (failed ratification)")').count() > 0,
      'Part 3.8 (rendered) — 1978 Report Notes shows "No deal (failed ratification)" for the void deal (not "Deal")')

    // Part A — edit the first row's (group 1 = ratified dealer A) 1978 contract. The form MUST be
    // POPULATED from the agreed outcome (the bug: selects came up blank → Save sent empty strings).
    await reports.locator('button:has-text("Edit")').first().click()
    await reports.waitForSelector('h3:has-text("Edit group")', { timeout: 15_000 })
    const sel = reports.locator('select')  // schema order: wages,plant,escalator,incentive,location,transfer
    const locVal = await sel.nth(4).inputValue()
    const trVal  = await sel.nth(5).inputValue()
    assert(locVal === 'deloitte' && trVal === 'most',
      `Part A — edit form is POPULATED from the agreed 1978 contract (location=${locVal}, transfer=${trVal}), not blank`)
    // Change escalator maintain → eliminate, Save, and assert it persists + rescores server-side.
    await sel.nth(2).selectOption('eliminate')
    await reports.click('button:has-text("Save")')
    await reports.waitForSelector('h3:has-text("Edit group")', { state: 'detached', timeout: 15_000 })
    let g1 = null
    for (let i = 0; i < 15; i++) {
      const r2 = await inst('getReportData')
      g1 = (r2.rows ?? []).find(r => r.group_id === gidA && r.role === 'baxter')
      if (g1 && g1.outcome_1978?.escalator === 'eliminate') break
      await sleep(1000)
    }
    assert(g1 && g1.outcome_1978?.escalator === 'eliminate',
      `Part A — edit SAVED + persisted (escalator now "${g1?.outcome_1978?.escalator}")`)
    assert(g1 && g1.score_1978 === 90,
      `Part A — Save recomputed the group's raw score (Baxter 85 → 90 after escalator maintain→eliminate) [${g1?.score_1978}]`)

    // Part E/1983 + 1985 — the other two report modals render with their Baxter titles/columns.
    await reports.getByRole('button', { name: '✕' }).click()  // close the 1978 report modal
    await reports.getByText('1983 Report', { exact: true }).click()
    await reports.waitForSelector('h3:has-text("1983 Report")', { timeout: 15_000 })
    assert(await reports.locator('th:has-text("1983 Wage")').count() > 0
        && await reports.locator('th:has-text("Adjusted score")').count() > 0,
      'Part E/1983 — 1983 Report shows "1983 Wage" + "Adjusted score" columns')
    await reports.getByRole('button', { name: '✕' }).click()
    await reports.getByText('1985 Report', { exact: true }).click()
    await reports.waitForSelector('h3:has-text("1985 Report")', { timeout: 15_000 })
    assert(await reports.locator('th:has-text("TOTAL score")').count() > 0
        && await reports.locator('th:has-text("1985 score")').count() > 0
        && await reports.locator('th:has-text("Work Rules")').count() > 0,
      'Part E/1985 — 1985 Report shows the six 1985 issues + "1985 score" + "TOTAL score"')

    // Fix 1 (UI wiring) — the 1985 Report now carries a per-group Edit column; opening it shows the
    // 1985 six-issue form (wage + five selects), mirroring the 1978 editor. (The data-level edit +
    // rescore is exercised below via updateGroupContract round:'1985'.)
    assert(await reports.locator('th:has-text("Notes")').count() > 0
        && await reports.locator('button:has-text("Edit")').count() > 0,
      'Fix 1 — 1985 Report has a Notes (Deal/No deal) column + per-group Edit buttons')
    await reports.locator('button:has-text("Edit")').first().click()
    await reports.waitForSelector('h3:has-text("1985 contract")', { timeout: 15_000 })
    assert(await reports.locator('select').count() === 5 && await reports.locator('input[type=number]').count() === 1,
      'Fix 1 — the 1985 editor renders the six-issue 1985 form (one wage field + five option selects)')
    await reports.getByRole('button', { name: 'Cancel' }).click()
  }

  // ══ Fixes 1 + 3 — 1985 no-deal recovery (editable) + dashboard no-deal early-warning flag ═══════
  banner('Fixes 1 + 3 — 1985 editable (updateGroupContract round:1985) + dashboard no-deal flag')
  {
    // Group B rejected its 1985 ultimatum → recorded NO DEAL. This is the exact production bug: a
    // single non-lead reject locked a would-be deal as no-deal, and there was NO instructor fix.
    const bNum = (await inst('getReportData')).rows.find(r => r.group_id === gidB)?.group_number

    // ── Fix 3 — the dashboard FLAGS group B's 1985 no-deal (before scoring/grades lock) ──
    await dash.reload(); await sleep(2500)
    await dash.waitForSelector('text=/No-deal 1985/', { timeout: 15_000 })
    const flagBox = dash.locator('div:has(> strong:has-text("No-deal 1985"))').first()
    assert(await flagBox.count() > 0,
      'Fix 3 — dashboard shows a no-deal early-warning flag at 1985 (visible before Score & Record)')
    assert(await flagBox.locator(`text=Group ${bNum}`).count() > 0,
      `Fix 3 — the flag names the group that ended 1985 no-deal (Group ${bNum})`)

    // ── Fix 1 — the instructor edits group B's 1985 no-deal into the deal it actually reached ──
    const before = (await inst('getReportData')).rows.filter(r => r.group_id === gidB)
    assert(before.every(r => r.outcome_1985 == null),
      'Fix 1 — group B starts as a 1985 NO-DEAL (outcomes_by_round[1985] absent) before the edit')

    // DEAL_A_1985 as a server payload (decimal wage numeric; enums as stored option keys). Scores:
    //   Baxter 1985 = 10.51  (wage −(25/4.02)(11−12.69)=10.51; all five options score 0)
    //   Union  1985 = 89.49  (wage (25/4.02)(11−8.67)=14.49 + 10+15+20+15+15)
    const DEAL_A_1985_NUM = { wage85: 11.0, incentive85: 'above_quota', work_rules85: 'jointly_determined', hiring85: 'layoff_100', notices85: 'yes', seniority85: 'all' }
    const edit = await inst('updateGroupContract', { groupId: gidB, agreement_reached: true, round: '1985', outcome: DEAL_A_1985_NUM })
    const bBax = (edit.rows ?? []).find(r => r.group_id === gidB && r.role === 'baxter')
    const bUni = (edit.rows ?? []).find(r => r.group_id === gidB && r.role === 'union')
    assert(bBax?.outcome_1985 != null && near(bBax.outcome_1985.wage85, 11.0),
      'Fix 1 — updateGroupContract(round:1985) WROTE outcomes_by_round[1985] on the group (wage85 $11.00)')
    // Recompute from the reservation/no-deal path → the REAL negotiated deal score (adjusted-1978 +
    //   1985 deal): Baxter 89.6 + 10.51 = 100.11; Union 36.2 + 89.49 = 125.69.
    assert(near(bBax?.score_1985, 10.51) && near(bBax?.total_score, 100.11),
      `Fix 1 — group B Baxter recomputes to the DEAL score (1985 10.51, TOTAL 100.11), not the no-deal fallback [1985=${bBax?.score_1985} total=${bBax?.total_score}]`)
    assert(near(bUni?.score_1985, 89.49) && near(bUni?.total_score, 125.69),
      `Fix 1 — group B Union recomputes to the DEAL score (1985 89.49, TOTAL 125.69) [1985=${bUni?.score_1985} total=${bUni?.total_score}]`)

    // Persistence — the group doc + the members' report-only raw_score both reflect the recorded deal.
    const gAfter = (await readGroupsFull()).find(x => x.id === gidB)
    assert(near(gAfter?.wage85, 11.0),
      'Fix 1 — outcomes_by_round[1985] PERSISTED on the group doc (survives a fresh read)')
    const bMembers = (await readParticipants()).filter(p => p.group_id === gidB)
    assert(bMembers.filter(p => p.role === 'baxter').every(p => near(p.raw_score, 100.11))
        && bMembers.filter(p => p.role === 'union').every(p => near(p.raw_score, 125.69)),
      'Fix 1 — group B members\' raw_score recomputed to the deal total (report-only rescore, like the 1978 editor)')

    // ── Fix 3 (live) — the no-deal flag CLEARS once the group is edited into a deal ──
    await dash.reload(); await sleep(2500)
    assert(await dash.locator('text=/No-deal 1985/').count() === 0,
      'Fix 3 — the no-deal flag CLEARS after the group is edited into a 1985 deal (live; the warning resolves)')

    // ── 1978 editor no-regression — round DEFAULTS to 1978; re-saving group A\'s 1978 contract with
    //    NO round arg still hits the 1978 path (idempotent) and leaves A\'s 1985 deal untouched. ──
    const aBefore = (await inst('getReportData')).rows.find(r => r.group_id === gidA && r.role === 'baxter')
    const reA = await inst('updateGroupContract', { groupId: gidA, agreement_reached: true, outcome: aBefore.outcome_1978 })
    const aAfter = (reA.rows ?? []).find(r => r.group_id === gidA && r.role === 'baxter')
    assert(aAfter && aAfter.score_1978 === aBefore.score_1978 && aAfter.outcome_1985 != null
        && near(aAfter.total_score, aBefore.total_score, 0.01),
      '1978 editor NO-REGRESSION — default round=1978 round-trips (score_1978 unchanged, group A 1985 deal untouched)')
  }

  // ══ Save-unchanged UI coverage — open editor, Save with no change → succeeds + persists ═════════
  // (Both editors now have dealer rows: 1978 = A/B/D; 1985 = A + B, B edited into a deal above.)
  banner('Save-unchanged — 1978 + 1985 editors: no-op Save succeeds & persists; one-field change persists all six')
  {
    const reports = await (await browser.newContext()).newPage()
    await reports.goto(`${FE}/reports?_dev_game_instance_id=${encodeURIComponent(GID)}&_session=tab`)
    await reports.waitForSelector('text=1978 Report', { timeout: 30_000 })
    await reports.waitForSelector('text=/\\d+ participants? ·/', { timeout: 30_000 })  // rows loaded
    await driveSaveUnchanged(reports, '1978')
    await driveSaveUnchanged(reports, '1985')
  }

  // ══ No-deal → deal — rescue a NO-DEAL group via the editor with fields at their defaults ═══════
  // The editor's PRIMARY purpose. No-deal groups available: 1978 = C; 1985 = C + D.
  banner('No-deal → deal — 1978 + 1985 editors: check "Deal reached" + Save with default dropdowns')
  {
    const reports = await (await browser.newContext()).newPage()
    await reports.goto(`${FE}/reports?_dev_game_instance_id=${encodeURIComponent(GID)}&_session=tab`)
    await reports.waitForSelector('text=1978 Report', { timeout: 30_000 })
    await reports.waitForSelector('text=/\\d+ participants? ·/', { timeout: 30_000 })
    await driveNoDealToDeal(reports, '1978')
    await driveNoDealToDeal(reports, '1985')
  }

  // ══ Settings — 10 phase-aware Info Links (grouped by round), NO Reservation Prices ═══════════
  banner('Settings — phase-aware Info Links (10, by round), no Reservation Prices, edit-override')
  {
    // The 10 configField defaults (must match gameDefinition.configFields + the real files).
    const DEFAULTS = {
      '1978': {
        baxter_1978_case_url:      '/role-info/1978-baxter-case.pdf',
        baxter_1978_worksheet_url: '/role-info/1978-baxter-worksheet.xlsx',
        union_1978_case_url:       '/role-info/1978-union-case.pdf',
        union_1978_worksheet_url:  '/role-info/1978-union-worksheet.xlsx',
      },
      '1983': {
        baxter_1983_brief_url: '/role-info/1983-baxter-brief.pdf',
        union_1983_brief_url:  '/role-info/1983-union-brief.pdf',
      },
      '1985': {
        baxter_1985_case_url:       '/role-info/1985-baxter-case.pdf',
        baxter_1985_scoresheet_url: '/role-info/1985-baxter-scoresheet.xlsx',
        union_1985_case_url:        '/role-info/1985-union-case.pdf',
        union_1985_scoresheet_url:  '/role-info/1985-union-scoresheet.xlsx',
      },
    }
    const sectionTitle = r => `Info Links — ${r}`  // em-dash, matches App.tsx exactly

    const settings = await (await browser.newContext()).newPage()
    await settings.goto(`${FE}/settings?_dev_game_instance_id=${encodeURIComponent(GID)}&_session=tab`)
    await settings.waitForSelector('h1:has-text("Settings — Baxter")', { timeout: 30_000 })
    await settings.waitForSelector(`text=${sectionTitle('1978')}`, { timeout: 30_000 })

    // NO Reservation Prices section (baked into scoring), NO bare/flat "Info Links" section.
    assert(await settings.getByText('Reservation Prices', { exact: true }).count() === 0,
      'Settings — Reservation Prices section REMOVED for Baxter')
    assert(await settings.getByText('Info Links', { exact: true }).count() === 0,
      'Settings — old flat "Info Links" section GONE (replaced by the round-grouped sections)')

    // The three round sections, the 10 fields pre-filled with the correct defaults, all resolve.
    const seenDefaults = []
    for (const round of ['1978', '1983', '1985']) {
      assert(await settings.getByText(sectionTitle(round), { exact: true }).count() > 0,
        `Settings — "Info Links — ${round}" section present (grouped by round)`)
      await settings.getByText(sectionTitle(round), { exact: true }).click()  // expand
      const keys = Object.keys(DEFAULTS[round])
      await settings.waitForFunction(k => {
        const el = document.querySelector('#cfg-' + k)
        return el && el.value && el.value.length > 0
      }, keys[0], { timeout: 20_000 })
      for (const [key, def] of Object.entries(DEFAULTS[round])) {
        const val = await settings.locator('#cfg-' + key).inputValue()
        assert(val === def, `Settings — ${round} ${key} pre-filled with default ${def} [${val}]`)
        seenDefaults.push(def)
      }
      await settings.getByText(sectionTitle(round), { exact: true }).click()  // collapse
    }
    // The old flat keys must NOT be rendered as fields anywhere.
    for (const oldKey of ['baxter_sheet_url', 'baxter_worksheet_url', 'union_sheet_url', 'union_worksheet_url']) {
      assert(await settings.locator('#cfg-' + oldKey).count() === 0, `Settings — old flat field ${oldKey} REMOVED`)
    }
    // Every shown default resolves to a real file (no 404, not the SPA fallback).
    for (const u of seenDefaults) {
      const r = await fetch(`${FE}${u}`)
      const ct = r.headers.get('content-type') ?? ''
      assert(r.status === 200 && !ct.includes('text/html'),
        `Settings — default resolves to a real file: ${u} [${r.status} ${ct}]`)
    }

    // Edit-override: change the 1985 Baxter case path, Save, and confirm the student is served it.
    await settings.getByText(sectionTitle('1985'), { exact: true }).click()  // expand 1985 only
    await settings.waitForFunction(() => {
      const el = document.querySelector('#cfg-baxter_1985_case_url')
      return el && el.value && el.value.length > 0
    }, null, { timeout: 20_000 })
    const EDITED = '/role-info/1985-baxter-case.pdf?edited=1'  // distinctive + still resolves
    await settings.locator('#cfg-baxter_1985_case_url').fill(EDITED)
    await settings.getByRole('button', { name: 'Save' }).click()  // only 1985 open → the one Save
    await settings.waitForSelector('text=/Saved \\d{1,2}:\\d{2}/', { timeout: 15_000 })
    const baxStu = students.find(s => s.role === 'baxter')
    const served = (await stu('getInfoUrls', baxStu.pid)).links.map(l => l.url)
    assert(served.includes(EDITED),
      `Settings — editing baxter_1985_case_url OVERRIDES the served 1985 Baxter doc [${served.join(', ')}]`)
    // And a non-edited 1985 doc still serves its default (edit is scoped to the one key).
    assert(served.includes('/role-info/1985-baxter-scoresheet.xlsx'),
      'Settings — untouched 1985 Baxter scoresheet still serves its default (edit is per-key)')
  }

  // ══ Question reports — 2 free-text (Winemaster format) + Likert table (new) ═════════════════════
  banner('Question reports — free-text (issue-ranking + debrief reflection) + Likert table + averages')
  {
    const rd = await inst('getReportData')
    const rows = rd.rows ?? []
    const qs   = rd.questions ?? []
    const lqs  = rd.likertQuestions ?? []

    // ── Enumeration: exactly the 2 free-text questions get reports; the graded MC do NOT ──
    const qFields = qs.map(q => q.field).sort()
    assert(qFields.length === 2 && qFields.includes('prep_issue_ranking') && qFields.includes('debrief_reflection'),
      `Text reports — exactly the 2 FREE-TEXT questions get reports (issue-ranking + debrief reflection) [${qFields.join(',')}]`)
    assert(!qs.some(q => q.field.startsWith('kc_')),
      'Text reports — the graded MC (kc_*) get NO text report (matches Winemaster: MC is auto-graded)')
    assert(lqs.length === 3, `Likert — 3 Likert questions surfaced by getReportData [${lqs.length}]`)

    // ── Persistence: every finalized student carries both text answers + all 3 Likert ratings ──
    assert(rows.length === 16, `Reports — 16 finalized rows [${rows.length}]`)
    assert(rows.every(r => (r.text_answers?.prep_issue_ranking ?? '').length > 0),
      'Persisted — every student\'s issue-ranking response is stored + read back from getReportData')
    assert(rows.every(r => (r.text_answers?.debrief_reflection ?? '').length > 0),
      'Persisted — every student\'s debrief-reflection response is stored + read back')
    assert(rows.every(r => lqs.every(q => r.likert_answers?.[q.field] != null)),
      'Persisted — every student\'s 3 Likert ratings are stored + read back')

    // Expected per-question averages, computed from the STORED ratings (verifies the UI averaging).
    const expAvg = {}
    for (const q of lqs) {
      const vals = rows.map(r => Number(r.likert_answers[q.field])).filter(n => Number.isFinite(n))
      expAvg[q.field] = vals.reduce((a, b) => a + b, 0) / vals.length
    }
    log('likert', lqs.map(q => `${q.field}=${expAvg[q.field].toFixed(2)}`).join('  '))

    // ── UI: reports page renders both text tiles + the Likert table ──
    const reports = await (await browser.newContext()).newPage()
    await reports.goto(`${FE}/reports?_dev_game_instance_id=${encodeURIComponent(GID)}&_session=tab`)
    await reports.waitForSelector('text=1978 Report', { timeout: 30_000 })
    await reports.waitForSelector('text=/\\d+ participants? ·/', { timeout: 30_000 })

    // Text report 1 — issue ranking (title == the prompt). ExportModal shows each response WITH role.
    await reports.getByText('make a list of the issues', { exact: false }).first().click()
    await reports.waitForSelector('pre', { timeout: 15_000 })
    {
      const body = await reports.locator('pre').innerText()
      assert(/16 responses/.test(body), 'Text report (issue-ranking) — shows all 16 responses')
      assert(body.includes('Baxter Management ·') && body.includes('Local 190 ·'),
        'Text report (issue-ranking) — each response is labelled with the student role (Baxter Management / Local 190)')
      assert(/baxter priorities:/.test(body) && /union priorities:/.test(body),
        'Text report (issue-ranking) — shows the submitted free-text responses')
    }
    await reports.getByRole('button', { name: /Close/ }).click()

    // Text report 2 — debrief reflection (title "Reflect on your negotiation experience.").
    await reports.getByText('Reflect on your negotiation experience', { exact: false }).first().click()
    await reports.waitForSelector('pre', { timeout: 15_000 })
    {
      const body = await reports.locator('pre').innerText()
      assert(/16 responses/.test(body) && /the negotiation went as expected/.test(body),
        'Text report (debrief reflection) — shows the submitted debrief responses')
      assert(body.includes('Baxter Management ·') && body.includes('Local 190 ·'),
        'Text report (debrief reflection) — each response is labelled with the student role')
    }
    await reports.getByRole('button', { name: /Close/ }).click()

    // Likert table — students × 3 questions + per-question averages.
    await reports.getByText('Looking Ahead to 1985 — Likert ratings', { exact: false }).first().click()
    await reports.waitForSelector('h3:has-text("Looking Ahead to 1985 — Likert ratings")', { timeout: 15_000 })
    // 16 student data rows + a bottom Average row.
    const bodyRows = reports.locator('tbody tr')
    assert(await bodyRows.count() === 17, `Likert table — 16 student rows + 1 average row [${await bodyRows.count()}]`)
    // One known student's row shows its exact 3 stored ratings.
    const s0 = rows.find(r => r.participant_id === students[0].pid)
    if (s0) {
      const tr = reports.locator(`tbody tr:has(td:has-text(${JSON.stringify(s0.display_name)}))`).first()
      const tds = tr.locator('td')  // [name, role, q0, q1, q2]
      for (let i = 0; i < lqs.length; i++) {
        const cell = (await tds.nth(i + 2).innerText()).trim()
        assert(cell === s0.likert_answers[lqs[i].field],
          `Likert table — ${s0.display_name} ${lqs[i].field} rating = ${s0.likert_answers[lqs[i].field]} [${cell}]`)
      }
    }
    // The Average row: first cell "Average" (colSpan 2), then one average per question column.
    const avgCells = reports.locator('tbody tr:has(td:has-text("Average")) td')
    for (let i = 0; i < lqs.length; i++) {
      const cell = (await avgCells.nth(i + 1).innerText()).trim()
      assert(cell === expAvg[lqs[i].field].toFixed(2),
        `Likert table — ${lqs[i].field} per-question AVERAGE = ${expAvg[lqs[i].field].toFixed(2)} [${cell}]`)
    }
  }

  // Latecomer placement + first-round gate — appended so seedGroupForTest's wipe
  // cannot disturb the playthrough assertions above.
  await runLatecomerGate()

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
