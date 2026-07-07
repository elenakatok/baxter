import { useEffect, useRef, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'
import { submitLeadOutcome, submitConfirmation, type CallArgs } from '../api'
import { labelFor } from '@mygames/game-engine/roles'
import {
  baxterConfig,
  baxterSchema,
  FIELD_LABELS,
  formatField,
  labelForOption,
  type OutcomeField as FieldDef,
  type OutcomeSchema,
} from '../gameConfig'

// ── Types ─────────────────────────────────────────────────────────────────────

type Confirmation = 'pending' | 'confirmed' | 'rejected'
type OutcomeFields = Record<string, unknown>

type GroupData = {
  status: string
  lead_outcome: OutcomeFields | null
  // Firestore Timestamp or null — we only check truthiness (non-null = submitted)
  lead_reported_at: object | null
  confirmations: Record<string, Confirmation>
  baxter_participants: string[]
  union_participants: string[]
  lead_participant_id: string
  reset_count: number | undefined
  agreement_reached: boolean | null
}

type Props = {
  groupId: string
  participantId: string
  gameInstanceId: string
  isLead: boolean
  args: CallArgs
  onComplete: () => void
}

// ── Schema-driven form helpers ─────────────────────────────────────────────────

export type FormValues = Record<string, string | boolean>

function defaultFormValues(): FormValues {
  const out: FormValues = {}
  for (const field of baxterSchema) {
    if (field.type === 'integer')      out[field.key] = ''
    else if (field.type === 'enum')    out[field.key] = field.options[0]
    else if (field.type === 'text')    out[field.key] = ''
    else                               out[field.key] = false
  }
  return out
}

type ParseOk  = { ok: true;  outcome: OutcomeFields }
type ParseErr = { ok: false; error: string }

export function parseForm(values: FormValues, schema: OutcomeSchema = baxterSchema): ParseOk | ParseErr {
  const outcome: OutcomeFields = {}
  for (const field of schema) {
    if (field.type === 'integer') {
      const raw = values[field.key] as string
      const n   = Number(raw)
      const lbl = FIELD_LABELS[field.key] ?? field.key
      if (raw === '' || isNaN(n) || !Number.isInteger(n)) {
        return { ok: false, error: `${lbl} is required.` }
      }
      if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) {
        return {
          ok: false,
          error: `${lbl} must be between ${(field.min ?? 0).toLocaleString()} and ${(field.max ?? 0).toLocaleString()}.`,
        }
      }
      outcome[field.key] = n
    } else if (field.type === 'enum') {
      outcome[field.key] = values[field.key]
    } else if (field.type === 'text') {
      // Optional free-text — blank is valid, stored as '' (never undefined), excluded from scoring.
      outcome[field.key] = (values[field.key] as string) ?? ''
    } else {
      outcome[field.key] = values[field.key]
    }
  }
  return { ok: true, outcome }
}

// ── Sub-component: renders one schema field as an input ────────────────────────

export function SchemaField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FieldDef
  value: string | boolean
  onChange: (v: string | boolean) => void
  disabled: boolean
}) {
  const lbl = FIELD_LABELS[field.key] ?? field.key

  if (field.type === 'integer') {
    return (
      <div style={fieldRowStyle}>
        <label style={fieldLabelStyle}>{lbl}</label>
        <input
          type="number"
          min={field.min}
          max={field.max}
          step={1}
          value={value as string}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          style={inputStyle}
        />
        <span style={{ fontSize: '0.8rem', color: '#888' }}>
          {(field.min ?? 0).toLocaleString()} – {(field.max ?? 0).toLocaleString()}
        </span>
      </div>
    )
  }

  if (field.type === 'enum') {
    return (
      <div style={fieldRowStyle}>
        <label style={fieldLabelStyle}>{lbl}</label>
        <select
          value={value as string}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          style={inputStyle}
        >
          {field.options.map(opt => (
            <option key={opt} value={opt}>{labelForOption(field.key, opt)}</option>
          ))}
        </select>
      </div>
    )
  }

  if (field.type === 'text') {
    return (
      <div style={fieldRowStyle}>
        <label style={fieldLabelStyle}>Notes</label>
        <textarea
          value={value as string}
          placeholder="Optional — any terms not captured above"
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          rows={3}
          style={{ ...inputStyle, maxWidth: '100%', resize: 'vertical' as const }}
        />
      </div>
    )
  }

  // boolean → checkbox
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
      <input
        type="checkbox"
        id={`field-${field.key}`}
        checked={value as boolean}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
        style={{ width: 18, height: 18 }}
      />
      <label htmlFor={`field-${field.key}`} style={fieldLabelStyle}>{lbl}</label>
    </div>
  )
}

// ── Sub-component: renders the 4-field outcome as a summary card ───────────────

function OutcomeCard({ outcome }: { outcome: OutcomeFields }) {
  return (
    <div style={outcomeCardStyle}>
      {baxterSchema.map(field => (
        <div key={field.key} style={outcomeRowStyle}>
          <span style={outcomeLabelStyle}>{FIELD_LABELS[field.key] ?? field.key}</span>
          <span>{formatField(field, outcome[field.key])}</span>
        </div>
      ))}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function OutcomeReporting({
  groupId,
  participantId,
  gameInstanceId,
  isLead,
  args,
  onComplete,
}: Props) {
  const [groupData,     setGroupData]     = useState<GroupData | null>(null)
  const [formValues,    setFormValues]    = useState<FormValues>(defaultFormValues)
  const [pendingDeal,   setPendingDeal]   = useState<OutcomeFields | null>(null)
  const [pendingNoDeal, setPendingNoDeal] = useState(false)
  const [submitting,    setSubmitting]    = useState(false)
  const [formError,     setFormError]     = useState<string | null>(null)
  const [actionError,   setActionError]   = useState<string | null>(null)

  const calledComplete  = useRef(false)
  const onCompleteRef   = useRef(onComplete)
  onCompleteRef.current = onComplete

  // ── Firestore snapshot ──────────────────────────────────────────────────────
  useEffect(() => {
    return onSnapshot(
      doc(db, 'game_instances', gameInstanceId, 'groups', groupId),
      snap => {
        if (!snap.exists()) return
        const d = snap.data() as GroupData
        setGroupData(d)
        if (d.status === 'completed' && !calledComplete.current) {
          calledComplete.current = true
          onCompleteRef.current()
        }
        // After a reset, clear form so lead can re-enter cleanly
        if (d.lead_reported_at == null && d.status === 'reporting') {
          setFormValues(defaultFormValues())
          setFormError(null)
          setActionError(null)
          setPendingDeal(null)
          setPendingNoDeal(false)
        }
      },
    )
  }, [groupId, gameInstanceId])

  // ── Shared submit wrapper ────────────────────────────────────────────────────
  const withSubmit = (fn: () => Promise<unknown>) => {
    setSubmitting(true)
    setActionError(null)
    fn()
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : 'Something went wrong.')
      })
      .finally(() => setSubmitting(false))
  }

  // ── Lead handlers ─────────────────────────────────────────────────────────
  const handleFieldChange = (key: string, v: string | boolean) => {
    setFormValues(prev => ({ ...prev, [key]: v }))
    setFormError(null)
  }

  const handleSubmitForm = () => {
    const result = parseForm(formValues)
    if (!result.ok) { setFormError(result.error); return }
    setPendingDeal(result.outcome)
    setFormError(null)
  }

  const handleNoDeal = () => {
    setPendingNoDeal(true)
    setFormError(null)
    setActionError(null)
  }

  const handleCancelPending = () => {
    setPendingDeal(null)
    setPendingNoDeal(false)
  }

  const handleConfirmDeal = () => {
    const outcome = pendingDeal
    setPendingDeal(null)
    withSubmit(() => submitLeadOutcome(args, outcome))
  }

  const handleConfirmNoDeal = () => {
    setPendingNoDeal(false)
    withSubmit(() => submitLeadOutcome(args, null))
  }

  // ── Non-lead handlers ─────────────────────────────────────────────────────
  const handleConfirm = () => withSubmit(() => submitConfirmation(args, true))
  const handleReject  = () => withSubmit(() => submitConfirmation(args, false))

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (!groupData) {
    return <main style={mainStyle}><p>Loading…</p></main>
  }

  const { status, lead_outcome, lead_reported_at, confirmations } = groupData
  const resetCount = groupData.reset_count ?? 0

  const roleKey   = groupData.baxter_participants.includes(participantId) ? 'baxter' : 'union'
  const roleLabel = labelFor(baxterConfig, roleKey)

  const confirmedCount = Object.values(confirmations ?? {}).filter(v => v === 'confirmed').length
  const totalCount     = Object.keys(confirmations ?? {}).length

  // ── Deadlock ─────────────────────────────────────────────────────────────────
  if (status === 'deadlocked') {
    return (
      <main style={mainStyle}>
        <p style={subtitleStyle}>You are {roleLabel}</p>
        <h1 style={h1Style}>Instructor intervention needed</h1>
        <p style={{ fontSize: '1.05rem', lineHeight: 1.6, color: '#555' }}>
          Your group could not agree after 5 attempts. Your instructor will enter the outcome manually.
          Stay on this screen.
        </p>
      </main>
    )
  }

  // ── Completed ─────────────────────────────────────────────────────────────────
  if (status === 'completed') {
    return (
      <main style={mainStyle}>
        <p style={subtitleStyle}>You are {roleLabel}</p>
        <h1 style={h1Style}>Outcome locked</h1>
        {groupData.agreement_reached && lead_outcome != null ? (
          <OutcomeCard outcome={lead_outcome} />
        ) : (
          <p style={{ fontSize: '1.05rem', color: '#555' }}>No deal reached.</p>
        )}
      </main>
    )
  }

  // ── Lead view ─────────────────────────────────────────────────────────────────
  if (isLead) {
    // Confirm dialog — deal
    if (pendingDeal != null) {
      return (
        <main style={mainStyle}>
          <p style={subtitleStyle}>You are {roleLabel}</p>
          <h1 style={h1Style}>Confirm outcome</h1>
          <p style={{ marginBottom: '0.5rem', fontSize: '0.95rem', color: '#555' }}>You entered:</p>
          <OutcomeCard outcome={pendingDeal} />
          <p style={{ marginBottom: '1rem', fontSize: '0.95rem' }}>Is that correct?</p>
          {actionError && <p style={errorStyle}>{actionError}</p>}
          <div style={btnRowStyle}>
            <button onClick={handleConfirmDeal} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Yes, submit'}
            </button>
            <button onClick={handleCancelPending} disabled={submitting} style={ghostBtnStyle}>
              No, go back
            </button>
          </div>
        </main>
      )
    }

    // Confirm dialog — no deal
    if (pendingNoDeal) {
      return (
        <main style={mainStyle}>
          <p style={subtitleStyle}>You are {roleLabel}</p>
          <h1 style={h1Style}>Confirm no deal</h1>
          <p style={{ marginBottom: '1rem' }}>
            Submit <strong>no deal</strong> — confirm your group walked away?
          </p>
          {actionError && <p style={errorStyle}>{actionError}</p>}
          <div style={btnRowStyle}>
            <button onClick={handleConfirmNoDeal} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Yes, no deal'}
            </button>
            <button onClick={handleCancelPending} disabled={submitting} style={ghostBtnStyle}>
              No, go back
            </button>
          </div>
        </main>
      )
    }

    // Submitted — waiting for group confirmations
    if (lead_reported_at != null) {
      return (
        <main style={mainStyle}>
          <p style={subtitleStyle}>You are {roleLabel}</p>
          <h1 style={h1Style}>Waiting for your group</h1>
          {lead_outcome != null
            ? <OutcomeCard outcome={lead_outcome} />
            : <p style={{ fontSize: '1.05rem', marginBottom: '1rem' }}>You reported: <strong>No deal</strong></p>}
          <p style={{ color: '#555' }}>
            {confirmedCount} of {totalCount} group member{totalCount !== 1 ? 's' : ''} confirmed.
          </p>
          {actionError && <p style={errorStyle}>{actionError}</p>}
        </main>
      )
    }

    // Entry form
    return (
      <main style={mainStyle}>
        <p style={subtitleStyle}>You are {roleLabel}</p>
        <h1 style={h1Style}>Report outcome</h1>
        {resetCount > 0 && (
          <div style={resetBannerStyle}>
            A group member disagreed — coordinate and re-enter the outcome.
          </div>
        )}
        <div style={{ marginBottom: '1rem' }}>
          {baxterSchema.map(field => (
            <SchemaField
              key={field.key}
              field={field}
              value={formValues[field.key] ?? (field.type === 'boolean' ? false : '')}
              onChange={v => handleFieldChange(field.key, v)}
              disabled={submitting}
            />
          ))}
        </div>
        {formError   && <p style={errorStyle}>{formError}</p>}
        {actionError && <p style={errorStyle}>{actionError}</p>}
        <div style={btnRowStyle}>
          <button onClick={handleSubmitForm} disabled={submitting}>
            Review &amp; submit
          </button>
          <button onClick={handleNoDeal} disabled={submitting} style={ghostBtnStyle}>
            No deal
          </button>
        </div>
      </main>
    )
  }

  // ── Non-lead view ─────────────────────────────────────────────────────────────

  // Waiting for lead to submit (or post-reset waiting)
  if (lead_reported_at == null) {
    return (
      <main style={mainStyle}>
        <p style={subtitleStyle}>You are {roleLabel}</p>
        <h1 style={h1Style}>Waiting for the outcome</h1>
        <p style={{ fontSize: '1.05rem', lineHeight: 1.6, color: '#555' }}>
          {resetCount > 0
            ? 'A disagreement was logged. The lead is re-entering the outcome.'
            : 'Your group lead is reporting the negotiation result. Stay on this page.'}
        </p>
      </main>
    )
  }

  const myConf = confirmations[participantId]

  // Pending: show outcome for review
  if (myConf === 'pending') {
    return (
      <main style={mainStyle}>
        <p style={subtitleStyle}>You are {roleLabel}</p>
        <h1 style={h1Style}>Confirm the outcome</h1>
        {lead_outcome != null ? (
          <>
            <p style={{ marginBottom: '0.5rem', fontSize: '0.95rem', color: '#555' }}>
              Your lead reported:
            </p>
            <OutcomeCard outcome={lead_outcome} />
          </>
        ) : (
          <p style={{ fontSize: '1.05rem', marginBottom: '1rem' }}>
            Your lead reported: <strong>No deal</strong>
          </p>
        )}
        <p style={{ color: '#555', marginBottom: '1.5rem' }}>Does this match what you negotiated?</p>
        {actionError && <p style={errorStyle}>{actionError}</p>}
        <div style={btnRowStyle}>
          <button onClick={handleConfirm} disabled={submitting}>
            {submitting ? '…' : 'Confirm'}
          </button>
          <button onClick={handleReject} disabled={submitting} style={ghostBtnStyle}>
            Reject
          </button>
        </div>
      </main>
    )
  }

  // Already responded — waiting for others
  return (
    <main style={mainStyle}>
      <p style={subtitleStyle}>You are {roleLabel}</p>
      <h1 style={h1Style}>Waiting for your group</h1>
      {lead_outcome != null
        ? <OutcomeCard outcome={lead_outcome} />
        : <p style={{ fontSize: '1.05rem', marginBottom: '1rem' }}>You confirmed: <strong>No deal</strong></p>}
      <p style={{ color: '#555' }}>
        {confirmedCount} of {totalCount} member{totalCount !== 1 ? 's' : ''} confirmed.
      </p>
    </main>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const mainStyle = {
  padding: '2rem',
  maxWidth: '640px',
  margin: '0 auto',
  fontFamily: 'sans-serif',
}

const h1Style = { marginTop: 0 }

const subtitleStyle = {
  color: '#555',
  marginTop: 0,
  marginBottom: '1.25rem',
}

const errorStyle = {
  color: '#c00',
  marginBottom: '0.75rem',
}

const resetBannerStyle = {
  color: '#c00',
  background: '#fff5f5',
  padding: '0.6rem 0.8rem',
  borderRadius: 4,
  marginBottom: '1rem',
  fontSize: '0.95rem',
}

const btnRowStyle = {
  display: 'flex',
  gap: '0.75rem',
  flexWrap: 'wrap' as const,
  alignItems: 'center',
}

const ghostBtnStyle = {
  background: 'none',
  border: '1px solid #ccc',
}

const outcomeCardStyle = {
  background: '#f0f7ff',
  border: '1px solid #b3d4f5',
  borderRadius: 4,
  padding: '0.75rem 1rem',
  marginBottom: '1rem',
}

const outcomeRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  padding: '0.2rem 0',
}

const outcomeLabelStyle = {
  color: '#555',
  marginRight: '1rem',
}

const fieldRowStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '0.25rem',
  marginBottom: '1rem',
}

const fieldLabelStyle = {
  fontSize: '0.9rem',
  fontWeight: 600,
  color: '#333',
}

const inputStyle = {
  fontSize: '1rem',
  padding: '0.4rem 0.6rem',
  border: '1px solid #ccc',
  borderRadius: 4,
  maxWidth: '16rem',
}
