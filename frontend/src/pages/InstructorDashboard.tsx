import { useState, type CSSProperties } from 'react'
import { httpsCallable } from 'firebase/functions'
import { InstructorDashboard as SharedDashboard, type DeadlockResolutionProps, type OutcomeFields, type RoundControlsContext } from '@mygames/game-ui'
import { auth, functions, rtdb } from '../firebase'
import { baxterConfig, baxterSchema } from '../gameConfig'
import { openRound2Attendance, beginRound2 } from '../api'
import { SchemaField, parseForm, type FormValues } from '../phases/OutcomeReporting'

// ── Role labels from game config ──────────────────────────────────────────────

const roleLabels = Object.fromEntries(
  baxterConfig.roles.map(r => [r.key, r.label])
)

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

function BaxterDeadlockControl({ submitting, error, onSubmit }: DeadlockResolutionProps) {
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
      {!noDeal && baxterSchema.map(field => (
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

function BaxterDay2Controls({ ctx }: { ctx: RoundControlsContext }) {
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
  if (roundId === '1978') {
    return (
      <span style={rowStyle}>
        <button onClick={handleOpen} disabled={busy || !sessionReady} style={{ padding: '0.35rem 0.9rem' }}>
          {busy ? 'Opening…' : 'Open Round 2 Attendance →'}
        </button>
        {error && <span style={errStyle}>{error}</span>}
      </span>
    )
  }

  // 1983 → Button 2: the absence cutoff. Shown only while groups are still closed
  // (all 'completed'); once begun, fall back to the generic proceed gate.
  if (roundId === '1983') {
    const notBegun = groups.length > 0 && groups.every(g => g.status === 'completed')
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
  return (
    <SharedDashboard
      title="Instructor Dashboard — Baxter"
      roleLabels={roleLabels}
      DeadlockResolutionControl={BaxterDeadlockControl}
      submitInstructorOutcome={submitInstructorOutcome}
      functions={functions}
      auth={auth}
      rtdb={rtdb}
      settingsRoute="/settings"
      reportsRoute="/reports"
      scoreAndRecord={{ callableName: 'scoreAndRecord', label: 'Score & Record' }}
      renderRoundControls={ctx => <BaxterDay2Controls ctx={ctx} />}
    />
  )
}
