import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { signInWithCustomToken, signOut } from 'firebase/auth'
import { auth, functions } from '../firebase'
import {
  SortableTable,
  ReportBoard,
  GameHeader,
  ExportModal,
  buildStudentTextExport,
  type SortableColumn,
  type ReportTileConfig,
  type AiTextRow,
} from '@mygames/game-ui'
import { SurplusScatterSVG, type ScatterPoint } from '../components/SurplusScatterSVG'
import { SchemaField, parseForm, type FormValues } from '../phases/OutcomeReporting'
import { baxterSchema, FIELD_LABELS, OPTION_LABELS, type OutcomeSchema } from '../gameConfig'

// ── 1978 scoring scheme (class-level; entered via the report-grid tile) ─────────
// Issues + options are exactly the six enum fields of the 1978 outcome contract.
const ISSUES_1978 = baxterSchema.filter(
  (f): f is { key: string; type: 'enum'; options: string[] } => f.type === 'enum',
)
const TOTAL_OPTIONS = ISSUES_1978.reduce((a, i) => a + i.options.length, 0)

const ROLE_COLS: { key: 'baxter' | 'union'; label: string }[] = [
  { key: 'baxter', label: 'Baxter Management' },
  { key: 'union',  label: 'Local 190' },
]

type Scheme1978 = {
  baxter?: { optionScores?: Record<string, Record<string, number>> }
  union?:  { optionScores?: Record<string, Record<string, number>> }
} | null

// Draft holds raw input strings (blank = unentered) keyed role → issue → option.
type OptionScoresDraft = Record<string, Record<string, string>>
type SchemeDraft = { baxter: OptionScoresDraft; union: OptionScoresDraft }

function draftFromScheme(scheme: Scheme1978): SchemeDraft {
  const build = (role: 'baxter' | 'union'): OptionScoresDraft => {
    const os = scheme?.[role]?.optionScores ?? {}
    const out: OptionScoresDraft = {}
    for (const issue of ISSUES_1978) {
      out[issue.key] = {}
      for (const opt of issue.options) {
        const v = os[issue.key]?.[opt]
        out[issue.key][opt] = (typeof v === 'number' && Number.isFinite(v)) ? String(v) : ''
      }
    }
    return out
  }
  return { baxter: build('baxter'), union: build('union') }
}

function schemeFromDraft(draft: SchemeDraft) {
  const build = (role: 'baxter' | 'union') => {
    const optionScores: Record<string, Record<string, number>> = {}
    for (const issue of ISSUES_1978) {
      for (const opt of issue.options) {
        const raw = (draft[role][issue.key]?.[opt] ?? '').trim()
        if (raw === '') continue
        const n = Number(raw)
        if (Number.isFinite(n)) (optionScores[issue.key] ??= {})[opt] = n
      }
    }
    return { optionScores }
  }
  return { baxter: build('baxter'), union: build('union') }
}

function enteredCount(scheme: Scheme1978, role: 'baxter' | 'union'): number {
  const os = scheme?.[role]?.optionScores ?? {}
  return Object.values(os).reduce((a, m) => a + Object.keys(m).length, 0)
}

// Pareto frontier endpoints (already in MILLIONS; x = WineMaster, y = Home Base) — from the target image.
const WM_FRONTIER: { x: number; y: number }[] = [
  { x: 2.99, y: 0.02 },  // WineMaster-favorable
  { x: 0.01, y: 2.53 },  // HomeBase-favorable
]

// ── Types ─────────────────────────────────────────────────────────────────────

type ReportRow = {
  participant_id: string
  display_name: string
  group_number: number | null
  group_id: string | null
  role: string
  shares: number | null
  vesting: string | null
  board_seat: boolean | null
  liability: number | null
  value_or_cost: number | null
  raw_score: number | null
  text_answers: Record<string, string>
  notes: string | null
}

type QuestionMeta = { field: string; prompt: string; role_target: string }

// ── Vesting sort order ────────────────────────────────────────────────────────

const VESTING_ORDER: Record<string, number> = {
  'Immediate': 0,
  'Pro Rata': 1,
  'End of Second Year': 2,
}

const vestingRank = (v: string | null) => v == null ? Infinity : (VESTING_ORDER[v] ?? 3)

// ── Contract-outcome table columns ───────────────────────────────────────────

type SortKey = 'name' | 'group' | 'role' | 'shares' | 'vesting' | 'board_seat' | 'liability' | 'value_or_cost' | 'raw_score' | 'notes' | 'edit'

const ROLE_LABELS: Record<string, string> = {
  winemaster: 'Winemaster',
  home_base:  'Home Base',
}

function fmt(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}

function fmtSigned(n: number | null): string {
  if (n == null) return '—'
  return (n >= 0 ? '+' : '−') + Math.abs(n).toLocaleString('en-US')
}

const COLUMNS: readonly SortableColumn<ReportRow, SortKey>[] = [
  {
    key: 'name', label: 'Name', headerStyle: { minWidth: 140 }, sticky: 'left',
    render: r => r.display_name,
    compare: (a, b) => a.display_name.localeCompare(b.display_name),
  },
  {
    key: 'group', label: 'Group #',
    render: r => r.group_number ?? '—',
    compare: (a, b) => (a.group_number ?? Infinity) - (b.group_number ?? Infinity),
  },
  {
    key: 'role', label: 'Role',
    render: r => r.role === 'winemaster' ? 'Winemaster' : 'Home Base',
    compare: (a, b) => a.role.localeCompare(b.role),
  },
  {
    key: 'shares', label: 'Shares', nullsLast: true, isNull: r => r.shares === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(r.shares)}</span>,
    compare: (a, b) => (a.shares ?? 0) - (b.shares ?? 0),
  },
  {
    key: 'vesting', label: 'Vesting', nullsLast: true, isNull: r => r.vesting === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => r.vesting ?? '—',
    compare: (a, b) => vestingRank(a.vesting) - vestingRank(b.vesting),
  },
  {
    key: 'board_seat', label: 'Board seat', nullsLast: true, isNull: r => r.board_seat === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => r.board_seat === null ? '—' : r.board_seat ? 'Yes' : 'No',
    compare: (a, b) => (a.board_seat ? 1 : 0) - (b.board_seat ? 1 : 0),
  },
  {
    key: 'liability', label: 'Liability', nullsLast: true, isNull: r => r.liability === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(r.liability)}</span>,
    compare: (a, b) => (a.liability ?? 0) - (b.liability ?? 0),
  },
  {
    key: 'value_or_cost', label: 'Value / Cost', nullsLast: true, isNull: r => r.value_or_cost === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(r.value_or_cost)}</span>,
    compare: (a, b) => (a.value_or_cost ?? 0) - (b.value_or_cost ?? 0),
  },
  {
    key: 'raw_score', label: 'Raw score', nullsLast: true, isNull: r => r.raw_score === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtSigned(r.raw_score)}</span>,
    compare: (a, b) => (a.raw_score ?? 0) - (b.raw_score ?? 0),
  },
  {
    key: 'notes', label: 'Notes', headerStyle: { minWidth: 80 },
    nullsLast: true, isNull: r => !r.notes || !r.notes.trim(),
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => (r.notes && r.notes.trim())
      ? <span style={{ whiteSpace: 'pre-wrap', display: 'inline-block', maxWidth: 220, overflowWrap: 'anywhere' }}>{r.notes}</span>
      : '—',
    compare: (a, b) => (a.notes ?? '').localeCompare(b.notes ?? ''),
  },
]

// ── Page component ────────────────────────────────────────────────────────────

export default function Reports() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const devGameInstanceId = import.meta.env.DEV
    ? searchParams.get('_dev_game_instance_id')
    : null
  const tokenParam          = searchParams.get('token')
  const gameInstanceIdParam = searchParams.get('game_instance_id')

  const [sessionReady, setSessionReady] = useState(false)
  const [authError,    setAuthError]    = useState<string | null>(null)

  const makeLink = (base: string): string => {
    if (devGameInstanceId) return `${base}?_dev_game_instance_id=${encodeURIComponent(devGameInstanceId)}`
    if (tokenParam && gameInstanceIdParam)
      return `${base}?token=${encodeURIComponent(tokenParam)}&game_instance_id=${encodeURIComponent(gameInstanceIdParam)}`
    return base
  }

  // ── Auth bootstrap ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const establish = async () => {
      await auth.authStateReady()
      if (cancelled) return
      if (auth.currentUser) {
        const expectedUid = devGameInstanceId
          ? `instructor_${devGameInstanceId}`
          : gameInstanceIdParam ? `instructor_${gameInstanceIdParam}` : null
        if (expectedUid && auth.currentUser.uid === expectedUid) { setSessionReady(true); return }
        await signOut(auth)
        if (cancelled) return
      }
      const args = devGameInstanceId
        ? { _dev: { game_instance_id: devGameInstanceId } }
        : tokenParam ? { token: tokenParam } : null
      if (!args) { setAuthError('No launch token found.'); return }
      try {
        const fn = httpsCallable<object, { customToken: string }>(functions, 'getInstructorSession')
        const res = await fn(args)
        if (cancelled) return
        await signInWithCustomToken(auth, res.data.customToken)
        if (cancelled) return
        setSessionReady(true)
      } catch (err) {
        if (cancelled) return
        setAuthError(err instanceof Error ? err.message : 'Failed to establish session.')
      }
    }
    void establish()
    return () => { cancelled = true }
  }, [devGameInstanceId, tokenParam]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Data load ──────────────────────────────────────────────────────────────
  const [rows,      setRows]      = useState<ReportRow[] | null>(null)
  const [questions, setQuestions] = useState<QuestionMeta[]>([])
  const [schema,    setSchema]    = useState<OutcomeSchema | null>(null)
  const [scheme1978, setScheme1978] = useState<Scheme1978>(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  useEffect(() => {
    if (!sessionReady) return
    setLoading(true)
    setError(null)
    const fn = httpsCallable<object, { ok: boolean; rows: ReportRow[]; questions: QuestionMeta[]; schema: OutcomeSchema; scheme1978: Scheme1978 }>(functions, 'getReportData')
    fn({}).then(r => {
      setRows(r.data.rows)
      setQuestions(r.data.questions)
      setSchema(r.data.schema)
      setScheme1978(r.data.scheme1978 ?? null)
      setLoading(false)
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to load report data.')
      setLoading(false)
    })
  }, [sessionReady])

  // ── 1978 scoring-scheme editor (class-level; report-grid entry tile) ─────────
  const [schemeOpen,   setSchemeOpen]   = useState(false)
  const [schemeDraft,  setSchemeDraft]  = useState<SchemeDraft | null>(null)
  const [schemeSaving, setSchemeSaving] = useState(false)
  const [schemeError,  setSchemeError]  = useState<string | null>(null)

  const openScheme = () => {
    setSchemeDraft(draftFromScheme(scheme1978))
    setSchemeError(null)
    setSchemeOpen(true)
  }

  const setScore = (role: 'baxter' | 'union', issue: string, opt: string, val: string) =>
    setSchemeDraft(prev => prev
      ? { ...prev, [role]: { ...prev[role], [issue]: { ...prev[role][issue], [opt]: val } } }
      : prev)

  const saveScheme = async () => {
    if (!schemeDraft) return
    setSchemeSaving(true)
    setSchemeError(null)
    try {
      const payload = schemeFromDraft(schemeDraft)
      const fn = httpsCallable<{ scheme1978: unknown }, { ok: boolean; scheme1978: Scheme1978 }>(functions, 'updateScheme1978')
      const res = await fn({ scheme1978: payload })
      setScheme1978(res.data.scheme1978 ?? null)
      setSchemeOpen(false)
    } catch (err) {
      setSchemeError(err instanceof Error ? err.message : 'Failed to save scoring scheme.')
    } finally {
      setSchemeSaving(false)
    }
  }

  // ── Inline group-contract editor (report-only: writes the group contract and
  //    recomputes each member's raw_score via updateGroupContract; never z-scores) ──
  const [editing,    setEditing]    = useState<{ groupId: string; groupNumber: number | null } | null>(null)
  const [formValues, setFormValues] = useState<FormValues>({})
  const [dealReached, setDealReached] = useState(true)
  const [saving,     setSaving]     = useState(false)
  const [editError,  setEditError]  = useState<string | null>(null)

  const openEditor = (row: ReportRow) => {
    if (!row.group_id || !schema) return
    // A deal is present iff any non-text contract field has a value (no-deal → all null).
    const hasDeal = schema.some(f => f.type !== 'text' && (row as Record<string, unknown>)[f.key] != null)
    const vals: FormValues = {}
    for (const f of schema) {
      const raw = (row as Record<string, unknown>)[f.key]
      vals[f.key] = f.type === 'boolean' ? Boolean(raw) : (raw == null ? '' : String(raw))
    }
    setFormValues(vals)
    setDealReached(hasDeal)
    setEditError(null)
    setEditing({ groupId: row.group_id, groupNumber: row.group_number })
  }

  const saveEditor = async () => {
    if (!editing || !schema) return
    let outcome: Record<string, unknown> | null = null
    if (dealReached) {
      const parsed = parseForm(formValues, schema)
      if (!parsed.ok) { setEditError(parsed.error); return }
      outcome = parsed.outcome
    }
    setSaving(true)
    setEditError(null)
    try {
      const fn = httpsCallable<
        { groupId: string; agreement_reached: boolean; outcome: Record<string, unknown> | null },
        { ok: boolean; rows: ReportRow[] }
      >(functions, 'updateGroupContract')
      const res = await fn({ groupId: editing.groupId, agreement_reached: dealReached, outcome })
      const updated = res.data.rows
      // Refresh the whole group's rows at once; other groups untouched.
      setRows(prev => prev ? prev.map(r => updated.find(u => u.participant_id === r.participant_id) ?? r) : prev)
      setEditing(null)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to save contract.')
    } finally {
      setSaving(false)
    }
  }

  // ── Scatter data — derived from rows, no extra fetch ───────────────────────
  const scatterSvgRef = useRef<SVGSVGElement>(null)

  const scatterPoints: ScatterPoint[] = (() => {
    if (!rows) return []
    const groupMap = new Map<number, { wm: number | null; hb: number | null }>()
    for (const r of rows) {
      if (r.group_number == null || r.raw_score == null) continue
      const entry = groupMap.get(r.group_number) ?? { wm: null, hb: null }
      if (r.role === 'winemaster') entry.wm = entry.wm ?? r.raw_score
      else if (r.role === 'home_base') entry.hb = entry.hb ?? r.raw_score
      groupMap.set(r.group_number, entry)
    }
    return Array.from(groupMap.entries())
      .filter(([, s]) => s.wm !== null && s.hb !== null)
      .map(([n, s]) => ({ x: s.wm!, y: s.hb!, label: `G${n}` }))
      .sort((a, b) => a.label.localeCompare(b.label))
  })()

  // ── Modal state ────────────────────────────────────────────────────────────
  const [contractOpen,  setContractOpen]  = useState(false)
  const [activeExport,  setActiveExport]  = useState<{ title: string; text: string } | null>(null)

  // ── Tile config ────────────────────────────────────────────────────────────
  const finalized = rows?.length ?? 0

  const projectScatter = () => {
    if (!scatterSvgRef.current) return
    const svgHtml = scatterSvgRef.current.outerHTML
    const win = window.open('', 'surplus-scatter', 'width=960,height=600')
    if (!win) return
    win.document.write(`<!DOCTYPE html><html><head><title>Surplus Scatter</title></head><body style="margin:0;padding:1rem;background:#fff;">${svgHtml}</body></html>`)
    win.document.close()
  }

  const baxterEntered = enteredCount(scheme1978, 'baxter')
  const unionEntered  = enteredCount(scheme1978, 'union')

  const tiles: ReportTileConfig[] = [
    {
      id: 'scheme1978',
      title: '1978 Scoring Scheme — option scores',
      preview: (baxterEntered === 0 && unionEntered === 0)
        ? <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Not yet entered</span>
        : <span style={{ fontSize: '0.9rem', color: '#555' }}>
            Baxter {baxterEntered}/{TOTAL_OPTIONS} · Union {unionEntered}/{TOTAL_OPTIONS} scores
          </span>,
      onOpen: openScheme,
      disabled: !sessionReady,
      actionLabel: (baxterEntered || unionEntered) ? 'Edit ↗' : 'Enter ↗',
    },
    {
      id: 'contract-outcomes',
      title: 'Contract Outcomes — per participant',
      preview: rows == null
        ? <span style={{ color: '#888', fontSize: '0.85rem' }}>{loading ? 'Loading…' : 'No data'}</span>
        : <span style={{ fontSize: '0.9rem', color: '#555' }}>
            {finalized} participant{finalized !== 1 ? 's' : ''} finalized
          </span>,
      onOpen: () => setContractOpen(true),
      disabled: !rows || rows.length === 0,
      actionLabel: 'Open ↗',
    },
    {
      id: 'surplus-scatter',
      title: 'Surplus Scatter — WM vs. HB',
      preview: <SurplusScatterSVG points={scatterPoints} frontier={WM_FRONTIER} svgRef={scatterSvgRef} />,
      onOpen: projectScatter,
      disabled: scatterPoints.length === 0,
      actionLabel: 'Project ↗',
    },
    // One tile per text question (6 total: 3 WM + 3 HB).
    ...questions.map(q => {
      const roleLabel = ROLE_LABELS[q.role_target] ?? q.role_target
      const tileTitle = `${roleLabel}: ${q.prompt}`
      const qRows: AiTextRow[] = (rows ?? [])
        .filter(r => r.role === q.role_target && r.text_answers[q.field])
        .map(r => ({ name: r.display_name, raw_score: r.raw_score, answer: r.text_answers[q.field] }))
      const text = buildStudentTextExport(tileTitle, qRows)
      return {
        id: q.field,
        title: tileTitle,
        preview: qRows.length === 0
          ? <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No responses yet.</span>
          : <span style={{ fontSize: '1.25rem', fontWeight: 700, color: '#111' }}>
              {qRows.length} response{qRows.length !== 1 ? 's' : ''}
            </span>,
        onOpen: () => setActiveExport({ title: tileTitle, text }),
        disabled: !rows,
        actionLabel: 'Open ↗',
      } satisfies ReportTileConfig
    }),
  ]

  // ── Render ─────────────────────────────────────────────────────────────────
  if (authError) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <p style={{ color: '#c00' }}>{authError}</p>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <GameHeader />

      <div style={{ padding: '1rem 1.5rem 0.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button
          onClick={() => navigate(makeLink('/dashboard'))}
          style={{ background: 'none', border: '1px solid #ccc', borderRadius: 4, padding: '0.3rem 0.8rem', cursor: 'pointer', fontSize: '0.85rem' }}
        >
          ← Dashboard
        </button>
        <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Reports — Baxter</h2>
      </div>

      <main style={{ flex: 1, padding: '1rem 1.5rem' }}>
        {error && <p style={{ color: '#c00', marginBottom: '1rem' }}>{error}</p>}
        <ReportBoard tiles={tiles} />
      </main>

      {/* ── Contract outcomes modal ── */}
      {contractOpen && (
        <div
          onClick={() => setContractOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '3rem 1rem', zIndex: 1000, overflowY: 'auto',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
              // Viewport-bounded so the wide table scrolls INSIDE the modal instead of
              // stretching it: minWidth:0 lets the flex item shrink below content width.
              width: '100%', maxWidth: 'min(1100px, calc(100vw - 2rem))', minWidth: 0,
              boxSizing: 'border-box', maxHeight: 'calc(100vh - 6rem)', overflowY: 'auto',
              padding: '1.25rem 1.5rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Contract Outcomes — per participant</h3>
              <button
                onClick={() => setContractOpen(false)}
                style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: '#666' }}
              >
                ✕
              </button>
            </div>
            <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 14rem)', border: '1px solid #ddd', borderRadius: 6 }}>
              <SortableTable<ReportRow, SortKey>
                rows={rows ?? []}
                columns={[
                  ...COLUMNS,
                  {
                    key: 'edit', label: '', headerStyle: { cursor: 'default' }, sticky: 'right',
                    render: r => (
                      <button
                        onClick={() => openEditor(r)}
                        disabled={!r.group_id || !schema}
                        style={{ background: 'none', border: '1px solid #ccc', borderRadius: 4, padding: '0.2rem 0.6rem', cursor: 'pointer', fontSize: '0.8rem' }}
                      >
                        Edit
                      </button>
                    ),
                    compare: () => 0,
                  },
                ]}
                getRowKey={r => r.participant_id}
                initialSortKey="group"
                roleLabels={ROLE_LABELS}
                getRowRole={r => r.role}
                emptyMessage="No finalized participants yet."
                wrapHeaders
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Inline group-contract editor ── */}
      {editing && schema && (
        <div
          onClick={() => !saving && setEditing(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '3rem 1rem', zIndex: 1100, overflowY: 'auto',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.3)', width: '100%', maxWidth: 460, padding: '1.25rem 1.5rem' }}
          >
            <h3 style={{ margin: '0 0 1rem', fontSize: '1rem', fontWeight: 600 }}>
              Edit group {editing.groupNumber ?? '—'} contract
            </h3>
            <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#666' }}>
              Applies to the whole group; all members' raw scores recompute.
            </p>

            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={dealReached}
                onChange={e => { setDealReached(e.target.checked); setEditError(null) }}
                disabled={saving}
                style={{ width: 18, height: 18 }}
              />
              Deal reached {dealReached ? '' : '— group walked away (no deal)'}
            </label>

            <div style={{ opacity: dealReached ? 1 : 0.5 }}>
              {schema.map(field => (
                <SchemaField
                  key={field.key}
                  field={field}
                  value={formValues[field.key] ?? (field.type === 'boolean' ? false : '')}
                  onChange={v => { setFormValues(prev => ({ ...prev, [field.key]: v })); setEditError(null) }}
                  disabled={saving || !dealReached}
                />
              ))}
            </div>

            {editError && <p style={{ color: '#c00', margin: '0 0 0.75rem', fontSize: '0.9rem' }}>{editError}</p>}

            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
              <button onClick={saveEditor} disabled={saving} style={{ padding: '0.4rem 1rem', cursor: 'pointer' }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => setEditing(null)} disabled={saving} style={{ padding: '0.4rem 1rem', background: 'none', border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 1978 scoring-scheme editor (class-level; per-option scores, no weights) ── */}
      {schemeOpen && schemeDraft && (
        <div
          onClick={() => !schemeSaving && setSchemeOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '3rem 1rem', zIndex: 1100, overflowY: 'auto',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
              width: '100%', maxWidth: 'min(900px, calc(100vw - 2rem))', boxSizing: 'border-box',
              maxHeight: 'calc(100vh - 6rem)', overflowY: 'auto', padding: '1.25rem 1.5rem',
            }}
          >
            <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem', fontWeight: 600 }}>1978 Scoring Scheme</h3>
            <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#666' }}>
              Enter the score for each option, per role. The 1978 score sums the entered score for
              each option the group agreed on. Blank counts as 0. Weights are not entered.
            </p>

            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
              {ROLE_COLS.map(role => (
                <div key={role.key} style={{ flex: '1 1 340px', minWidth: 300 }}>
                  <h4 style={{ margin: '0 0 0.75rem', fontSize: '0.95rem', fontWeight: 700, borderBottom: '2px solid #D38626', paddingBottom: '0.25rem' }}>
                    {role.label}
                  </h4>
                  {ISSUES_1978.map(issue => (
                    <div key={issue.key} style={{ marginBottom: '0.9rem' }}>
                      <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#333', marginBottom: '0.35rem' }}>
                        {FIELD_LABELS[issue.key] ?? issue.key}
                      </div>
                      {issue.options.map(opt => (
                        <label key={opt} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.15rem 0' }}>
                          <span style={{ fontSize: '0.85rem', color: '#555' }}>
                            {OPTION_LABELS[issue.key]?.[opt] ?? opt}
                          </span>
                          <input
                            type="number"
                            inputMode="decimal"
                            value={schemeDraft[role.key][issue.key]?.[opt] ?? ''}
                            onChange={e => { setScore(role.key, issue.key, opt, e.target.value); setSchemeError(null) }}
                            disabled={schemeSaving}
                            style={{ width: '5.5rem', fontSize: '0.9rem', padding: '0.25rem 0.4rem', border: '1px solid #ccc', borderRadius: 4, textAlign: 'right' }}
                          />
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {schemeError && <p style={{ color: '#c00', margin: '0.75rem 0 0', fontSize: '0.9rem' }}>{schemeError}</p>}

            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
              <button onClick={saveScheme} disabled={schemeSaving} style={{ padding: '0.4rem 1rem', cursor: 'pointer' }}>
                {schemeSaving ? 'Saving…' : 'Save scheme'}
              </button>
              <button onClick={() => setSchemeOpen(false)} disabled={schemeSaving} style={{ padding: '0.4rem 1rem', background: 'none', border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── AI text export modal (shared across all text tiles) ── */}
      {activeExport && (
        <ExportModal
          title={activeExport.title}
          text={activeExport.text}
          onClose={() => setActiveExport(null)}
        />
      )}
    </div>
  )
}
