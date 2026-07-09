import { useEffect, useRef, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'
import { submitLeadOutcome, submitConfirmation, type CallArgs } from '../api'
import { labelFor } from '@mygames/game-engine/roles'
import {
  SchemaField as UiSchemaField,
  parseForm as uiParseForm,
  defaultFormValues as uiDefaultFormValues,
  OutcomeCard as UiOutcomeCard,
  type OutcomeFormLabels,
  type OutcomeFormSchema,
  type OutcomeFormValues,
  type ParseOk,
  type ParseErr,
} from '@mygames/game-ui'
import {
  baxterConfig,
  baxterSchema,
  baxter1983Schema,
  baxter1985Schema,
  FIELD_LABELS,
  formatField,
  labelForOption,
  type OutcomeField,
  type OutcomeSchema,
} from '../gameConfig'

// Per-round outcome schema. 1983 negotiates a wage only; 1985 is its own six-issue contract;
// every other round (1978) uses the six-issue baxterSchema.
function schemaForRound(roundId: string | undefined): OutcomeFormSchema {
  if (roundId === '1983') return baxter1983Schema
  if (roundId === '1985') return baxter1985Schema
  return baxterSchema
}

// ── Baxter label hooks for the shared outcome-form renderer ────────────────────
const baxterLabels: OutcomeFormLabels = {
  fieldLabel:  key => FIELD_LABELS[key] ?? key,
  optionLabel: (key, value) => labelForOption(key, value),
  formatValue: (field, value) => formatField(field as OutcomeField, value),
}

// Baxter-bound re-exports of the shared renderer (labels baked in) so this module's
// existing consumers (this page + the instructor dashboard) keep their import site.
export type FormValues = OutcomeFormValues
export function SchemaField(props: {
  field: OutcomeSchema[number]
  value: string | boolean
  onChange: (v: string | boolean) => void
  disabled: boolean
}) {
  return <UiSchemaField {...props} labels={baxterLabels} />
}
export function parseForm(values: FormValues, schema: OutcomeFormSchema = baxterSchema): ParseOk | ParseErr {
  return uiParseForm(values, schema, baxterLabels)
}

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
  // Day-2 absence cutoff (Slice 2.7): set by beginRound2 when a group is flagged deadlocked
  // because a whole role was absent for the round, rather than a genuine negotiation impasse.
  day2_deadlock_reason?: string | null
  day2_missing_roles?: string[] | null
  // 1983 arbitration (Slice 3): written by resolveArbitration when a no-agreement 1983 group is
  // resolved at the front of class. Its presence flips this view from "No deal" to the wage.
  arbitration_1983?: { side: 'baxter' | 'union'; wage: number } | null
}

type Props = {
  groupId: string
  participantId: string
  gameInstanceId: string
  isLead: boolean
  args: CallArgs
  onComplete: () => void
  /** Current round id. 1983 negotiates a wage only; all other rounds use the six-issue form. */
  roundId?: string
}

// ── Read-only outcome card (schema-aware: six-issue 1978 or wage-only 1983) ────
function OutcomeCard({ schema, outcome }: { schema: OutcomeFormSchema; outcome: OutcomeFields }) {
  return <UiOutcomeCard schema={schema} outcome={outcome} labels={baxterLabels} />
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function OutcomeReporting({
  groupId,
  participantId,
  gameInstanceId,
  isLead,
  args,
  onComplete,
  roundId,
}: Props) {
  // 1983 = wage only; 1985 = its own six-issue contract; every other round = the six-issue 1978.
  const schema: OutcomeFormSchema = schemaForRound(roundId)
  const [groupData,     setGroupData]     = useState<GroupData | null>(null)
  const [formValues,    setFormValues]    = useState<FormValues>(() => uiDefaultFormValues(schema))
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
          setFormValues(uiDefaultFormValues(schema))
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
    const result = parseForm(formValues, schema)
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
    // Cause-aware copy (Bug C). An ABSENCE deadlock (a whole role missing for day 2, flagged
    // by beginRound2) is not a negotiation impasse, so it must NOT show the "couldn't agree
    // after 5 attempts" message. The couldn't-agree copy is kept only for a real deadlock.
    const absenceDeadlock = groupData.day2_deadlock_reason === 'absent_role'
    return (
      <main style={mainStyle}>
        <p style={subtitleStyle}>You are {roleLabel}</p>
        <h1 style={h1Style}>Instructor intervention needed</h1>
        <p style={{ fontSize: '1.05rem', lineHeight: 1.6, color: '#555' }}>
          {absenceDeadlock
            ? 'A member of your group was absent for this round, so it can’t be negotiated. Your instructor will resolve the outcome. Stay on this screen.'
            : 'Your group could not agree after 5 attempts. Your instructor will enter the outcome manually. Stay on this screen.'}
        </p>
      </main>
    )
  }

  // ── Completed ─────────────────────────────────────────────────────────────────
  if (status === 'completed') {
    // 1983 arbitration flip (Slice 3): a no-agreement 1983 group shows "No deal" UNTIL the
    // instructor resolves its arbitration. resolveArbitration writes arbitration_1983 (+ the
    // 1983 wage) to this group doc; the live snapshot above then re-renders this branch, so the
    // view flips from "No deal" to the arbitrated wage without a reload.
    const arb = roundId === '1983' ? groupData.arbitration_1983 : null
    return (
      <main style={mainStyle}>
        <p style={subtitleStyle}>You are {roleLabel}</p>
        <h1 style={h1Style}>Outcome locked</h1>
        {arb != null ? (
          <>
            <p style={{ fontSize: '1.05rem', color: '#555', marginBottom: '0.5rem' }}>
              Your 1983 wage was set by <strong>arbitration</strong> — {arb.side === 'baxter' ? "Baxter's rules" : "the Union's rules"} applied.
            </p>
            <OutcomeCard schema={schema} outcome={{ wage83: arb.wage }} />
          </>
        ) : groupData.agreement_reached && lead_outcome != null ? (
          <OutcomeCard schema={schema} outcome={lead_outcome} />
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
          <OutcomeCard schema={schema} outcome={pendingDeal} />
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
            ? <OutcomeCard schema={schema} outcome={lead_outcome} />
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
          {schema.map(field => (
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
            <OutcomeCard schema={schema} outcome={lead_outcome} />
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
        ? <OutcomeCard schema={schema} outcome={lead_outcome} />
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
// (field/outcome-card styles now live in the shared @mygames/game-ui OutcomeForm.)
