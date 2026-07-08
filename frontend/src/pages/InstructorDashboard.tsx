import { useState, useEffect, useCallback, type CSSProperties } from 'react'
import { httpsCallable } from 'firebase/functions'
import { doc, onSnapshot } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { InstructorDashboard as SharedDashboard, type DeadlockResolutionProps, type OutcomeFields, type RoundControlsContext } from '@mygames/game-ui'
import { auth, db, functions, rtdb } from '../firebase'
import { baxterConfig, baxterSchema } from '../gameConfig'
import { openRound2Attendance, beginRound2 } from '../api'
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
    if (notBegun) {
      return (
        <span style={rowStyle}>
          <span style={hintStyle}>Regenerate the code, let students re-confirm, then:</span>
          <button onClick={handleBegin} disabled={busy || !sessionReady} style={{ padding: '0.35rem 0.9rem' }}>
            {busy ? 'Beginning…' : 'Begin 1983'}
          </button>
          {info && <span style={hintStyle}>{info}</span>}
          {error && <span style={errStyle}>{error}</span>}
        </span>
      )
    }
    return null
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
