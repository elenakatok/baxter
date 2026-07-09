import { useState, useEffect, useCallback, type CSSProperties } from 'react'
import { httpsCallable } from 'firebase/functions'
import { doc, collection, onSnapshot } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { InstructorDashboard as SharedDashboard, type DeadlockResolutionProps, type OutcomeFields, type RoundControlsContext } from '@mygames/game-ui'
import { auth, db, functions, rtdb } from '../firebase'
import { baxterConfig, baxterSchema, WAGE_DOLLARS } from '../gameConfig'
import { openRound2Attendance, beginRound2, resolveArbitration, advanceRound, type ArbitrationResult } from '../api'
import { SchemaField, parseForm, type FormValues } from '../phases/OutcomeReporting'

// ── Role labels from game config ──────────────────────────────────────────────

const roleLabels = Object.fromEntries(
  baxterConfig.roles.map(r => [r.key, r.label])
)

// ── Baxter's own instance-state read (Bug D round-awareness + B-gating) ────────
// The shared dashboard owns instructor auth and its own roster poll, but exposes neither the
// instance's current_round nor a "round 2 begun" marker to the game. Rather than thread round
// through the shared DeadlockResolutionProps/game-ui (Elena: NO shared change), Baxter reads
// the instance doc itself. The instructor's Firebase uid is `instructor_<gameInstanceId>`
// (makeGetInstructorSession), so we derive the instance id from it — no api/roster change.
// The instance doc is readable by the authenticated instructor (games/baxter/firestore.rules).

const BAXTER_ROUNDS = ['1978', '1983', '1985']

type BaxterInstanceState = { currentRound: number; round2Begun: boolean }

function useBaxterInstance(): BaxterInstanceState {
  const [state, setState] = useState<BaxterInstanceState>({ currentRound: 0, round2Begun: false })

  useEffect(() => {
    let unsubDoc: (() => void) | null = null
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (unsubDoc) { unsubDoc(); unsubDoc = null }
      if (!user) { setState({ currentRound: 0, round2Begun: false }); return }
      const gameInstanceId = user.uid.replace(/^instructor_/, '')
      unsubDoc = onSnapshot(
        doc(db, 'game_instances', gameInstanceId),
        (snap) => {
          const cr = snap.data()?.current_round
          const idx = (typeof cr === 'number' && Number.isInteger(cr))
            ? Math.max(0, Math.min(cr, BAXTER_ROUNDS.length - 1))
            : 0
          setState({ currentRound: idx, round2Begun: snap.data()?.round2_begun_at != null })
        },
        () => {},   // read denied / offline — keep last-known state
      )
    })
    return () => { unsubAuth(); if (unsubDoc) unsubDoc() }
  }, [])

  return state
}

// ── Arbitration queue (Slice 3) ────────────────────────────────────────────────
// A 1983 group that ends with NO agreed wage is auto-flagged for arbitration. The flag is
// DERIVED (not stored): status completed/deadlocked at 1983 with no 1983 wage. The instructor
// reads groups directly (authenticated-read rule) to get outcomes_by_round + the 1978 wage,
// since the shared roster poll exposes neither. Resolving writes the wage and clears the flag.

type ArbGroup = {
  id: string
  status: string
  wage83: number | null
  w78: number | null
  arbitration?: { side: 'baxter' | 'union'; wage: number }
}

function useBaxterGroups(): ArbGroup[] {
  const [groups, setGroups] = useState<ArbGroup[]>([])
  useEffect(() => {
    let unsub: (() => void) | null = null
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (unsub) { unsub(); unsub = null }
      if (!user) { setGroups([]); return }
      const gameInstanceId = user.uid.replace(/^instructor_/, '')
      unsub = onSnapshot(
        collection(db, 'game_instances', gameInstanceId, 'groups'),
        (snap) => {
          setGroups(snap.docs.map((g) => {
            const d = g.data() as Record<string, unknown>
            const o1983 = (d['outcomes_by_round'] as Record<string, unknown> | undefined)?.['1983'] as Record<string, unknown> | null | undefined
            const w83 = o1983?.['wage83']
            const wagesOpt = (d['outcome'] as Record<string, unknown> | null)?.['wages']
            const arb = d['arbitration_1983'] as { side: 'baxter' | 'union'; wage: number } | undefined
            return {
              id: g.id,
              status: (d['status'] as string) ?? 'unknown',
              wage83: typeof w83 === 'number' ? w83 : null,
              w78: typeof wagesOpt === 'string' ? (WAGE_DOLLARS[wagesOpt] ?? null) : null,
              arbitration: arb,
            }
          }))
        },
        () => {},
      )
    })
    return () => { unsubAuth(); if (unsub) unsub() }
  }, [])
  return groups
}

/** Per-group "Resolve arbitration" button (plain — the cosmetic wheel is a later slice). */
function BaxterArbitrationQueue() {
  const groups = useBaxterGroups()
  const [busy, setBusy]     = useState<string | null>(null)
  const [errById, setErr]   = useState<Record<string, string>>({})
  const [doneById, setDone] = useState<Record<string, ArbitrationResult>>({})

  // Flagged = finished 1983 (completed/deadlocked) with no agreed wage. A group that has a
  // 1983 wage (agreed OR just arbitrated) drops out of the queue.
  const flagged = groups.filter(g => g.wage83 == null && (g.status === 'completed' || g.status === 'deadlocked'))

  const handleResolve = (groupId: string) => {
    if (busy) return
    setBusy(groupId)
    setErr(prev => { const n = { ...prev }; delete n[groupId]; return n })
    resolveArbitration(groupId)
      .then(res => setDone(prev => ({ ...prev, [groupId]: res })))
      .catch(e => setErr(prev => ({ ...prev, [groupId]: e instanceof Error ? e.message : 'Arbitration failed.' })))
      .finally(() => setBusy(null))
  }

  const recentlyResolved = groups.filter(g => g.arbitration != null && g.wage83 != null)
  if (flagged.length === 0 && recentlyResolved.length === 0) return null

  return (
    <div style={arbBoxStyle}>
      <strong style={{ fontSize: '0.9rem' }}>Arbitration queue</strong>
      {flagged.length === 0 && <span style={hintStyle}>No groups awaiting arbitration.</span>}
      {flagged.map(g => (
        <div key={g.id} style={arbRowStyle}>
          <span style={{ fontFamily: 'monospace' }}>{g.id}</span>
          <span style={hintStyle}>1978 wage {g.w78 != null ? `$${g.w78.toFixed(2)}` : '—'}</span>
          <button onClick={() => handleResolve(g.id)} disabled={busy != null} style={{ padding: '0.3rem 0.8rem' }}>
            {busy === g.id ? 'Resolving…' : 'Resolve arbitration'}
          </button>
          {doneById[g.id] && (
            <span style={{ color: '#1a7f37', fontSize: '0.85rem' }}>
              {doneById[g.id].side === 'baxter' ? 'Baxter rules' : 'Union rules'} → ${doneById[g.id].wage.toFixed(2)}
            </span>
          )}
          {errById[g.id] && <span style={errStyle}>{errById[g.id]}</span>}
        </div>
      ))}
      {recentlyResolved.map(g => (
        <div key={g.id} style={arbRowStyle}>
          <span style={{ fontFamily: 'monospace' }}>{g.id}</span>
          <span style={{ color: '#57606a', fontSize: '0.85rem' }}>
            resolved: {g.arbitration!.side === 'baxter' ? 'Baxter rules' : 'Union rules'} → ${g.arbitration!.wage.toFixed(2)}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * "Proceed to 1985" — the 1983→1985 proceed gate (Slice 4). Same-session continuation, so it
 * calls the generic advanceRound (re-opens every group to negotiate 1985; no re-attendance). Held
 * until EVERY 1983 group is completed AND no group is still awaiting arbitration — spec §6 requires
 * all 1983 adjustments final before the class advances.
 */
function BaxterProceedTo1985({ sessionReady, allCompleted, reload }: { sessionReady: boolean; allCompleted: boolean; reload: () => void }) {
  const groups = useBaxterGroups()
  const [busy, setBusy]   = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pendingArb = groups.some(g => g.wage83 == null && (g.status === 'completed' || g.status === 'deadlocked'))
  if (!allCompleted || pendingArb) return null

  const handle = () => {
    if (!sessionReady || busy) return
    setBusy(true); setError(null)
    advanceRound()
      .then(() => reload())
      .catch(e => setError(e instanceof Error ? e.message : 'Could not proceed to 1985.'))
      .finally(() => setBusy(false))
  }
  return (
    <span style={rowStyle}>
      <button onClick={handle} disabled={busy || !sessionReady} style={{ padding: '0.35rem 0.9rem' }}>
        {busy ? 'Proceeding…' : 'Proceed to 1985 →'}
      </button>
      {error && <span style={errStyle}>{error}</span>}
    </span>
  )
}

// ── Deadlock resolution control (schema-driven — the 1978 six-issue contract) ──

function baxterDefaultForm(): FormValues {
  const out: FormValues = {}
  for (const field of baxterSchema) {
    if (field.type === 'enum')      out[field.key] = field.options[0]
    else if (field.type === 'text') out[field.key] = ''
    else                            out[field.key] = ''
  }
  return out
}

function BaxterDeadlockControl({ submitting, error, onSubmit, roundId }: DeadlockResolutionProps & { roundId: string }) {
  // Round-aware (Bug D): the 1983 round is scored on wages alone, so its deadlock resolution
  // shows a WAGE-ONLY form; 1978 keeps the full six-issue form. Frontend-only — no shared
  // game-ui / DeadlockResolutionProps change. The submitted payload is still built from the
  // FULL schema (the five non-wage 1978 issues stay at their `baxterDefaultForm` defaults)
  // because the server's submitInstructorOutcome validates every non-no-deal outcome against
  // the full six-issue outcomeSchema; only the wage is instructor-edited, which is what 1983
  // scoring consumes.
  const wageOnly = roundId === '1983'
  const editFields = wageOnly ? baxterSchema.filter(f => f.key === 'wages') : baxterSchema

  const [values, setValues] = useState<FormValues>(baxterDefaultForm)
  const [noDeal, setNoDeal] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const handleSubmit = () => {
    if (noDeal) { onSubmit({ no_deal: true }); return }
    const result = parseForm(values)
    if (!result.ok) { setFormError(result.error); return }
    setFormError(null)
    onSubmit(result.outcome as OutcomeFields)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {!noDeal && editFields.map(field => (
        <SchemaField
          key={field.key}
          field={field}
          value={values[field.key] ?? (field.type === 'boolean' ? false : '')}
          onChange={v => { setValues(prev => ({ ...prev, [field.key]: v })); setFormError(null) }}
          disabled={submitting}
        />
      ))}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.25rem' }}>
        <button onClick={handleSubmit} disabled={submitting}>
          {submitting ? '…' : noDeal ? 'Confirm No Deal' : 'Lock Deal'}
        </button>
        <button onClick={() => setNoDeal(v => !v)} disabled={submitting} style={{ background: 'none', border: '1px solid #ccc' }}>
          {noDeal ? 'Enter deal terms instead' : 'No deal'}
        </button>
      </div>
      {formError && <p style={{ color: '#c00', fontSize: '0.8rem', margin: 0 }}>{formError}</p>}
      {error && <p style={{ color: '#c00', fontSize: '0.8rem', margin: 0 }}>{error}</p>}
    </div>
  )
}

// ── Submit instructor outcome ─────────────────────────────────────────────────

async function submitInstructorOutcome(groupId: string, outcome: OutcomeFields): Promise<void> {
  const fn = httpsCallable(functions, 'submitInstructorOutcome')
  await fn({ group_id: groupId, outcome })
}

// ── Day-2 re-attendance controls (Slice 2.7) ──────────────────────────────────
// Injected into the shared round strip via renderRoundControls. Overrides ONLY the
// 1978 and 1983 rounds; returns null elsewhere (and once 1983 is underway) so the
// generic "Proceed to next round" gate handles the rest.

const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }
const errStyle: CSSProperties = { color: '#c00', fontSize: '0.85rem' }
const hintStyle: CSSProperties = { fontSize: '0.85rem', color: '#57606a' }
const arbBoxStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.5rem',
  padding: '0.6rem 0.8rem', border: '1px solid #e5c07b', background: '#fdf6e3', borderRadius: 6,
}
const arbRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }

function BaxterDay2Controls({ ctx, round2Begun }: { ctx: RoundControlsContext; round2Begun: boolean }) {
  const { rounds, currentRound, sessionReady, groups, reload } = ctx
  const roundId = rounds[currentRound]
  const [busy, setBusy]   = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo]   = useState<string | null>(null)

  const handleOpen = () => {
    if (!sessionReady || busy) return
    setBusy(true); setError(null); setInfo(null)
    openRound2Attendance()
      .then(() => reload())
      .catch(e => setError(e instanceof Error ? e.message : 'Could not open round 2 attendance.'))
      .finally(() => setBusy(false))
  }

  const handleBegin = () => {
    if (!sessionReady || busy) return
    setBusy(true); setError(null); setInfo(null)
    beginRound2()
      .then(res => {
        const n = (a: string) => res.groups.filter(g => g.action === a).length
        setInfo(`1983 begun — ${n('reopened')} reopened, ${n('reassigned')} lead-reassigned, ${n('deadlocked')} flagged for resolution.`)
        reload()
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Could not begin 1983.'))
      .finally(() => setBusy(false))
  }

  // 1978 → Button 1: advance to 1983 attendance without re-opening groups.
  // Gated (#1): shown only once EVERY group has resolved round 1 ('completed'). The server
  // openRound2Attendance enforces the same gate, but showing the button before round 1 is
  // finished is confusing, so it is hidden until then.
  if (roundId === '1978') {
    const roundComplete = groups.length > 0 && groups.every(g => g.status === 'completed')
    if (!roundComplete) return null
    return (
      <span style={rowStyle}>
        <button onClick={handleOpen} disabled={busy || !sessionReady} style={{ padding: '0.35rem 0.9rem' }}>
          {busy ? 'Opening…' : 'Open Round 2 Attendance →'}
        </button>
        {error && <span style={errStyle}>{error}</span>}
      </span>
    )
  }

  // 1983 → Button 2: the absence cutoff. Shown only in the window AFTER Button 1 advanced the
  // round (groups still 'completed' from 1978) and BEFORE beginRound2 has run. Gating on the
  // persistent round2_begun_at marker — not merely "all completed" — keeps the button from
  // re-appearing once the 1983 round finishes (groups return to 'completed'), which previously
  // let a re-click re-deadlock already-resolved groups (the "Begin 1983" loop, Bug B).
  if (roundId === '1983') {
    const notBegun = !round2Begun && groups.length > 0 && groups.every(g => g.status === 'completed')
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        {notBegun && (
          <span style={rowStyle}>
            <span style={hintStyle}>Regenerate the code, let students re-confirm, then:</span>
            <button onClick={handleBegin} disabled={busy || !sessionReady} style={{ padding: '0.35rem 0.9rem' }}>
              {busy ? 'Beginning…' : 'Begin 1983'}
            </button>
            {info && <span style={hintStyle}>{info}</span>}
            {error && <span style={errStyle}>{error}</span>}
          </span>
        )}
        {/* Auto-flagged arbitration queue — appears once groups finish 1983 with no agreed wage. */}
        <BaxterArbitrationQueue />
        {/* Proceed to 1985 once every 1983 group is completed and no arbitration is pending. */}
        <BaxterProceedTo1985
          sessionReady={sessionReady}
          allCompleted={groups.length > 0 && groups.every(g => g.status === 'completed')}
          reload={reload}
        />
      </div>
    )
  }

  return null
}

// ── Page component ────────────────────────────────────────────────────────────

export default function InstructorDashboard() {
  const { currentRound, round2Begun } = useBaxterInstance()

  // Inject the current round id into Baxter's deadlock form so it can render wage-only for
  // 1983 (Bug D). Wrapped in useCallback so the shared dashboard sees a stable component
  // reference that only changes when the round changes.
  const DeadlockControl = useCallback(
    (props: DeadlockResolutionProps) => (
      <BaxterDeadlockControl {...props} roundId={BAXTER_ROUNDS[currentRound] ?? BAXTER_ROUNDS[0]} />
    ),
    [currentRound],
  )

  return (
    <SharedDashboard
      title="Instructor Dashboard — Baxter"
      roleLabels={roleLabels}
      DeadlockResolutionControl={DeadlockControl}
      submitInstructorOutcome={submitInstructorOutcome}
      functions={functions}
      auth={auth}
      rtdb={rtdb}
      settingsRoute="/settings"
      reportsRoute="/reports"
      scoreAndRecord={{ callableName: 'scoreAndRecord', label: 'Score & Record' }}
      renderRoundControls={ctx => <BaxterDay2Controls ctx={ctx} round2Begun={round2Begun} />}
    />
  )
}
