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
const PIDS = ['stu-1', 'stu-2', 'stu-3', 'stu-4']

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

// ── 1978 negotiation: group reveal → off-platform → report canonical deal ───────

async function drive1978Negotiation(students) {
  banner('1978 negotiation → canonical deal')
  // group reveal
  await Promise.all(students.map(async s => {
    await s.page.waitForSelector('h1:has-text("Your negotiation group")', { timeout: 60_000 })
    log(s.pid, 'group reveal')
  }))
  // one Start click; the rest auto-advance (or click as fallback)
  await students[0].page.click('button:has-text("Start negotiation")')
  await students[0].page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 20_000 })
  for (const s of students.slice(1)) {
    const flipped = await s.page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 12_000 }).then(() => true).catch(() => false)
    if (!flipped) { await s.page.click('button:has-text("Start negotiation")'); await s.page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 12_000 }) }
    log(s.pid, 'off-platform')
  }
  // Everyone taps "We've finished" so the lead reaches the report form and non-leads reach confirm.
  await Promise.all(students.map(s => s.page.click("button:has-text(\"We've finished\")").catch(() => {})))

  // Identify the lead from Firestore.
  const parts = await readParticipants()
  const leadId = parts.find(p => p.is_lead)?.id ?? students[0].pid
  const lead = students.find(s => s.pid === leadId) ?? students[0]
  const nonLeads = students.filter(s => s !== lead)
  log(lead.pid, `lead — filling canonical 1978 deal`)

  await lead.page.waitForSelector('h1:has-text("Report outcome")', { timeout: 30_000 })
  // Six enum <select>s in baxterSchema order; fill by option VALUE (the stored key).
  const order = ['wages', 'plant_operation', 'escalator', 'incentive', 'location', 'transfer']
  const selects = lead.page.locator('select')
  for (let i = 0; i < order.length; i++) {
    await selects.nth(i).selectOption(CANONICAL_1978_OUTCOME[order[i]])
  }
  await lead.page.click('button:has-text("Review & submit")')
  await lead.page.waitForSelector('h1:has-text("Confirm outcome")', { timeout: 10_000 })
  await lead.page.click('button:has-text("Yes, submit")')

  // Non-leads confirm.
  await Promise.all(nonLeads.map(async s => {
    await s.page.waitForSelector('h1:has-text("Confirm")', { timeout: 30_000 })
    await s.page.click('button:has-text("Confirm")')
    log(s.pid, 'confirmed')
  }))
  const gs = await pollGroupsStatus(g => g.every(x => x.status === 'completed'))
  assert(gs.every(x => x.status === 'completed'), '1978 group reaches "completed"')
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

  // 4. 1978 negotiation → canonical deal → completed.
  await drive1978Negotiation(students)

  // 5. Score & Record → assert Baxter 85 / Union 62.
  await inst('scoreAndRecord')
  await sleep(1500)
  {
    const parts = await readParticipants()
    const bax = parts.filter(p => p.role === 'baxter')
    const uni = parts.filter(p => p.role === 'union')
    log('score', parts.map(p => `${p.id}:${p.role}=${p.raw_score}`).join('  '))
    assert(bax.length > 0 && bax.every(p => p.raw_score === EXPECTED_1978_SCORES.baxter), `Scoring — every Baxter = ${EXPECTED_1978_SCORES.baxter}`)
    assert(uni.length > 0 && uni.every(p => p.raw_score === EXPECTED_1978_SCORES.union),  `Scoring — every Union = ${EXPECTED_1978_SCORES.union}`)
  }

  // #1 (part b): now that round 1 is completed, the gate button appears → drive it.
  await dash.reload(); await sleep(2500)
  await dash.waitForSelector('button:has-text("Open Round 2 Attendance")', { timeout: 15_000 })
  assert(true, '#1 — "Open Round 2 Attendance" SHOWN after all round-1 groups complete')
  await dash.click('button:has-text("Open Round 2 Attendance")')
  log('instr', 'clicked "Open Round 2 Attendance" (→ 1983)')

  // BUG A: each completed-1978 student must re-route LIVE to the day-2 attendance-code screen.
  banner('Bug A — re-route to day-2 code screen')
  await Promise.all(students.map(async s => {
    await s.page.waitForSelector('h1:has-text("Enter attendance code")', { timeout: 30_000 })
  }))
  assert(true, 'Bug A — all completed-1978 students routed to the day-2 code screen (not results)')

  // 6. Instructor generates the 1983 code; students re-attend.
  const { code: code83 } = await inst('generateAttendanceCode')
  log('instr', `1983 attendance code: ${code83}`)
  await Promise.all(students.map(async s => {
    await s.page.locator('input').fill(code83)
    await s.page.click('button[type="submit"]')
  }))

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

  // TODO(Slice 3): once the wage-only 1983 report form exists, drive the 1983 lead through it
  // and assert the form shows ONLY the wage field. The 1983 form is not built yet, so we stop at
  // the 1983 "Go negotiate" screen (the resume is already proven above) rather than assert on it.
  console.log('\n  TODO(Slice 3): assert wage-only 1983 report form — not built yet, not run.')

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
