import { useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { InstructorDashboard as SharedDashboard, type DeadlockResolutionProps, type OutcomeFields } from '@mygames/game-ui'
import { auth, functions, rtdb } from '../firebase'
import { baxterConfig, baxterSchema } from '../gameConfig'
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
    />
  )
}
