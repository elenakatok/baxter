import { useEffect, useRef, useState, type CSSProperties } from 'react'
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
import {
  baxterSchema,
  baxter1985Schema,
  FIELD_LABELS,
  OPTION_LABELS,
  WAGE_DOLLARS,
  labelForOption,
  type OutcomeSchema,
} from '../gameConfig'

// ── 1978 scoring scheme (class-level; entered via the report-grid tile) ─────────
// Issues + options are exactly the six enum fields of the 1978 outcome contract.
const ISSUES_1978 = baxterSchema.filter(
  (f): f is { key: string; type: 'enum'; options: string[] } => f.type === 'enum',
)
const TOTAL_OPTIONS = ISSUES_1978.reduce((a, i) => a + i.options.length, 0)
// The five discrete 1985 issues (the wage is rendered as its own money column).
const ISSUES_1985 = baxter1985Schema.filter(
  (f): f is { key: string; type: 'enum'; options: string[] } => f.type === 'enum',
)

const ROLE_COLS: { key: 'baxter' | 'union'; label: string }[] = [
  { key: 'baxter', label: 'Baxter Management' },
  { key: 'union',  label: 'Local 190' },
]

// Baxter role display labels (NOT Winemaster/Home Base).
const ROLE_LABELS: Record<string, string> = {
  baxter: 'Baxter Management',
  union:  'Local 190',
}
const roleLabel = (role: string) => ROLE_LABELS[role] ?? role

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

// ── Types ─────────────────────────────────────────────────────────────────────

type Arb1983 = { side: 'baxter' | 'union'; wage: number } | null

type ReportRow = {
  participant_id: string
  display_name: string
  group_number: number | null
  group_id: string | null
  role: string
  raw_score: number | null
  text_answers: Record<string, string>
  likert_answers: Record<string, string>
  // 1978
  outcome_1978: Record<string, unknown> | null
  agreement_1978: boolean
  wage_1978: number
  score_1978: number | null
  notes: string | null
  // 1983
  wage_1983: number | null
  arb_1983: Arb1983
  score_1983: number | null
  // 1985
  outcome_1985: Record<string, unknown> | null
  score_1985: number | null
  total_score: number | null
}

type QuestionMeta = { field: string; prompt: string; role_target: string }

// ── Formatting helpers ─────────────────────────────────────────────────────────

const money = (n: number | null | undefined): string =>
  typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : '—'

const fmtScore = (n: number | null | undefined): string =>
  typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : '—'

const optCell = (row: ReportRow, key: string): string => {
  const o = row.outcome_1978
  return o && o[key] != null ? labelForOption(key, o[key]) : '—'
}
const opt1985Cell = (row: ReportRow, key: string): string => {
  const o = row.outcome_1985
  return o && o[key] != null ? labelForOption(key, o[key]) : '—'
}
const num = (n: number | null): number => (typeof n === 'number' && Number.isFinite(n) ? n : -Infinity)

// Default form value for a field that has NO stored value — the case a NO-DEAL group hits (it has
// no contract to seed from). Every control MUST start at its displayed value so an untouched field
// submits that value, not '' (which fails schema validation — the no-deal→deal editor bug):
//   enum → first/displayed option · decimal/integer (the wage) → the status-quo current wage
//   text → '' (optional; blank is valid) · boolean → false
function defaultFieldValue(field: OutcomeSchema[number]): string | boolean {
  if (field.type === 'enum')    return field.options[0]
  if (field.type === 'boolean') return false
  if (field.type === 'decimal' || field.type === 'integer') return String(WAGE_DOLLARS.current)
  return ''
}

// ── Shared leading columns (Name / Group # / Role) ──────────────────────────────

const nameCol = (): SortableColumn<ReportRow, string> => ({
  key: 'name', label: 'Name', headerStyle: { minWidth: 140 }, sticky: 'left',
  render: r => r.display_name,
  compare: (a, b) => a.display_name.localeCompare(b.display_name),
})
const groupCol = (): SortableColumn<ReportRow, string> => ({
  key: 'group', label: 'Group #',
  render: r => r.group_number ?? '—',
  compare: (a, b) => (a.group_number ?? Infinity) - (b.group_number ?? Infinity),
})
const roleCol = (): SortableColumn<ReportRow, string> => ({
  key: 'role', label: 'Role',
  render: r => roleLabel(r.role),
  compare: (a, b) => a.role.localeCompare(b.role),
})
const numCell = (n: number | null | undefined) =>
  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtScore(n ?? null)}</span>

// Shared trailing Edit column — opens the round-aware group-contract editor (1978 or 1985).
const editCol = (onEdit: (r: ReportRow) => void, canEdit: boolean): SortableColumn<ReportRow, string> => ({
  key: 'edit', label: '', headerStyle: { cursor: 'default' }, sticky: 'right',
  render: r => (
    <button
      onClick={() => onEdit(r)}
      disabled={!r.group_id || !canEdit}
      style={{ background: 'none', border: '1px solid #ccc', borderRadius: 4, padding: '0.2rem 0.6rem', cursor: 'pointer', fontSize: '0.8rem' }}
    >
      Edit
    </button>
  ),
  compare: () => 0,
})

// ── 1978 report columns (six issues + wage + raw score + notes) ────────────────
function columns1978(onEdit: (r: ReportRow) => void, canEdit: boolean): SortableColumn<ReportRow, string>[] {
  return [
    nameCol(), groupCol(), roleCol(),
    ...ISSUES_1978.map(issue => ({
      key: `i_${issue.key}`, label: FIELD_LABELS[issue.key] ?? issue.key,
      render: (r: ReportRow) => optCell(r, issue.key),
      compare: (a: ReportRow, b: ReportRow) => optCell(a, issue.key).localeCompare(optCell(b, issue.key)),
    } satisfies SortableColumn<ReportRow, string>)),
    {
      key: 'wage78', label: 'Wage',
      render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(r.wage_1978)}</span>,
      compare: (a, b) => a.wage_1978 - b.wage_1978,
    },
    {
      key: 'score78', label: 'Raw score', nullsLast: true, isNull: r => r.score_1978 == null,
      render: r => numCell(r.score_1978),
      compare: (a, b) => num(a.score_1978) - num(b.score_1978),
    },
    {
      key: 'notes78', label: 'Notes',
      render: r => r.agreement_1978 ? 'Deal' : 'No deal',
      compare: (a, b) => Number(a.agreement_1978) - Number(b.agreement_1978),
    },
    editCol(onEdit, canEdit),
  ]
}

// ── 1983 report columns (1983 wage + adjusted score) ───────────────────────────
const columns1983: SortableColumn<ReportRow, string>[] = [
  nameCol(), groupCol(), roleCol(),
  {
    key: 'wage83', label: '1983 Wage',
    render: r => r.wage_1983 == null
      ? '—'
      : <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {money(r.wage_1983)}{r.arb_1983 ? <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}> (arbitrated)</span> : null}
        </span>,
    compare: (a, b) => num(a.wage_1983) - num(b.wage_1983),
  },
  {
    key: 'score83', label: 'Adjusted score', nullsLast: true, isNull: r => r.score_1983 == null,
    render: r => numCell(r.score_1983),
    compare: (a, b) => num(a.score_1983) - num(b.score_1983),
  },
]

// ── 1985 report columns (six 1985 issues + carried-in 1983 + 1985 + TOTAL) ─────
function columns1985(onEdit: (r: ReportRow) => void, canEdit: boolean): SortableColumn<ReportRow, string>[] {
  return [
    nameCol(), groupCol(), roleCol(),
    {
      key: 'wage85', label: FIELD_LABELS['wage85'] ?? 'Hourly wage ($)',
      render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{r.outcome_1985 ? money(r.outcome_1985['wage85'] as number) : '—'}</span>,
      compare: (a, b) => num((a.outcome_1985?.['wage85'] as number) ?? null) - num((b.outcome_1985?.['wage85'] as number) ?? null),
    },
    ...ISSUES_1985.map(issue => ({
      key: `j_${issue.key}`, label: FIELD_LABELS[issue.key] ?? issue.key,
      render: (r: ReportRow) => opt1985Cell(r, issue.key),
      compare: (a: ReportRow, b: ReportRow) => opt1985Cell(a, issue.key).localeCompare(opt1985Cell(b, issue.key)),
    } satisfies SortableColumn<ReportRow, string>)),
    {
      key: 'notes85', label: 'Notes',
      render: r => r.outcome_1985 != null ? 'Deal' : 'No deal',
      compare: (a, b) => Number(a.outcome_1985 != null) - Number(b.outcome_1985 != null),
    },
    {
      key: 'carry83', label: '1983 score (carried in)', nullsLast: true, isNull: r => r.score_1983 == null,
      render: r => numCell(r.score_1983),
      compare: (a, b) => num(a.score_1983) - num(b.score_1983),
    },
    {
      key: 'score85', label: '1985 score', nullsLast: true, isNull: r => r.score_1985 == null,
      render: r => numCell(r.score_1985),
      compare: (a, b) => num(a.score_1985) - num(b.score_1985),
    },
    {
      key: 'total', label: 'TOTAL score', nullsLast: true, isNull: r => r.total_score == null,
      render: r => <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtScore(r.total_score)}</strong>,
      compare: (a, b) => num(a.total_score) - num(b.total_score),
    },
    editCol(onEdit, canEdit),
  ]
}

type ReportKind = '1978' | '1983' | '1985'

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
  const [likertQuestions, setLikertQuestions] = useState<QuestionMeta[]>([])
  const [schema,    setSchema]    = useState<OutcomeSchema | null>(null)
  const [scheme1978, setScheme1978] = useState<Scheme1978>(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  useEffect(() => {
    if (!sessionReady) return
    setLoading(true)
    setError(null)
    const fn = httpsCallable<object, { ok: boolean; rows: ReportRow[]; questions: QuestionMeta[]; likertQuestions: QuestionMeta[]; schema: OutcomeSchema; scheme1978: Scheme1978 }>(functions, 'getReportData')
    fn({}).then(r => {
      setRows(r.data.rows)
      setQuestions(r.data.questions)
      setLikertQuestions(r.data.likertQuestions ?? [])
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

  // ── Inline group-contract editor (report-only: edits the 1978 or 1985 contract and recomputes
  //    each member's raw_score via updateGroupContract; never z-scores). Round-aware: the 1985
  //    editor lets an instructor record the deal a group actually reached when a single non-lead
  //    reject mis-locked the group as no-deal (outcomes_by_round['1985'] = null). ──
  const [editing,    setEditing]    = useState<{ groupId: string; groupNumber: number | null; round: '1978' | '1985' } | null>(null)
  const [formValues, setFormValues] = useState<FormValues>({})
  const [dealReached, setDealReached] = useState(true)
  const [saving,     setSaving]     = useState(false)
  const [editError,  setEditError]  = useState<string | null>(null)

  // The schema for the round being edited: server 1978 schema, or the client 1985 mirror (1985 is
  // never returned by getReportData — it is not the 1978 contract).
  const editSchema: OutcomeSchema | null =
    editing == null ? null : editing.round === '1985' ? baxter1985Schema : schema

  const openEditor = (row: ReportRow, round: '1978' | '1985') => {
    const sch = round === '1985' ? baxter1985Schema : schema
    if (!row.group_id || !sch) return
    // Bind the form from the row's carried contract for THAT round so the selects show and submit
    // the real agreed options.
    const o = (round === '1985' ? row.outcome_1985 : row.outcome_1978) ?? {}
    const vals: FormValues = {}
    for (const f of sch) {
      const raw = (o as Record<string, unknown>)[f.key]
      // Stored value → seed from it (dealer path, unchanged). Absent → seed the field's DEFAULT
      // (first option / status-quo wage), NEVER '', so a no-deal group's untouched controls submit
      // their displayed defaults instead of empty strings.
      vals[f.key] = raw == null
        ? defaultFieldValue(f)
        : (f.type === 'boolean' ? Boolean(raw) : String(raw))
    }
    setFormValues(vals)
    setDealReached(round === '1985' ? row.outcome_1985 != null : row.agreement_1978)
    setEditError(null)
    setEditing({ groupId: row.group_id, groupNumber: row.group_number, round })
  }

  const saveEditor = async () => {
    if (!editing || !editSchema) return
    let outcome: Record<string, unknown> | null = null
    if (dealReached) {
      const parsed = parseForm(formValues, editSchema)
      if (!parsed.ok) { setEditError(parsed.error); return }
      outcome = parsed.outcome
    }
    setSaving(true)
    setEditError(null)
    try {
      const fn = httpsCallable<
        { groupId: string; agreement_reached: boolean; outcome: Record<string, unknown> | null; round: '1978' | '1985' },
        { ok: boolean; rows: ReportRow[] }
      >(functions, 'updateGroupContract')
      const res = await fn({ groupId: editing.groupId, agreement_reached: dealReached, outcome, round: editing.round })
      // The server rebuilds the FULL row set (cross-group no-deal bases can shift), so replace
      // wholesale rather than merging by participant.
      setRows(res.data.rows)
      setEditing(null)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to save contract.')
    } finally {
      setSaving(false)
    }
  }

  // ── Scatter data — total score per role, one point per group ────────────────
  const scatterSvgRef = useRef<SVGSVGElement>(null)

  const scatterPoints: ScatterPoint[] = (() => {
    if (!rows) return []
    const groupMap = new Map<number, { baxter: number | null; union: number | null }>()
    for (const r of rows) {
      if (r.group_number == null) continue
      const score = r.total_score ?? r.raw_score
      if (score == null) continue
      const entry = groupMap.get(r.group_number) ?? { baxter: null, union: null }
      if (r.role === 'baxter') entry.baxter = entry.baxter ?? score
      else if (r.role === 'union') entry.union = entry.union ?? score
      groupMap.set(r.group_number, entry)
    }
    return Array.from(groupMap.entries())
      .filter(([, s]) => s.baxter !== null && s.union !== null)
      .map(([n, s]) => ({ x: s.baxter!, y: s.union!, label: `G${n}` }))
      .sort((a, b) => a.label.localeCompare(b.label))
  })()

  // ── Modal state ────────────────────────────────────────────────────────────
  const [activeReport, setActiveReport] = useState<ReportKind | null>(null)
  const [activeExport,  setActiveExport]  = useState<{ title: string; text: string } | null>(null)
  const [likertOpen,    setLikertOpen]    = useState(false)

  // ── Likert table data ("Looking ahead to 1985") ─────────────────────────────
  // Rows = students who answered ≥1 Likert item (with role); one column per Likert question;
  // a per-question AVERAGE across responders. Ratings persist as '1'–'7' strings.
  const likertRows = (rows ?? [])
    .filter(r => likertQuestions.some(q => r.likert_answers[q.field] != null))
    .slice()
    .sort((a, b) => (a.role.localeCompare(b.role)) || a.display_name.localeCompare(b.display_name))
  const likertRespondents = likertRows.length
  const likertAverages: Record<string, number | null> = {}
  for (const q of likertQuestions) {
    const vals = likertRows
      .map(r => Number(r.likert_answers[q.field]))
      .filter(n => Number.isFinite(n))
    likertAverages[q.field] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  }

  // ── Tile config ────────────────────────────────────────────────────────────
  const finalized = rows?.length ?? 0

  const projectScatter = () => {
    if (!scatterSvgRef.current) return
    const svgHtml = scatterSvgRef.current.outerHTML
    const win = window.open('', 'surplus-scatter', 'width=960,height=600')
    if (!win) return
    win.document.write(`<!DOCTYPE html><html><head><title>Score Scatter</title></head><body style="margin:0;padding:1rem;background:#fff;">${svgHtml}</body></html>`)
    win.document.close()
  }

  const baxterEntered = enteredCount(scheme1978, 'baxter')
  const unionEntered  = enteredCount(scheme1978, 'union')

  const reportPreview = (kind: ReportKind) =>
    rows == null
      ? <span style={{ color: '#888', fontSize: '0.85rem' }}>{loading ? 'Loading…' : 'No data'}</span>
      : <span style={{ fontSize: '0.9rem', color: '#555' }}>{finalized} participant{finalized !== 1 ? 's' : ''} · {kind}</span>

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
      id: 'report-1978', title: '1978 Report', preview: reportPreview('1978'),
      onOpen: () => setActiveReport('1978'),
      disabled: !rows || rows.length === 0, actionLabel: 'Open ↗',
    },
    {
      id: 'report-1983', title: '1983 Report', preview: reportPreview('1983'),
      onOpen: () => setActiveReport('1983'),
      disabled: !rows || rows.length === 0, actionLabel: 'Open ↗',
    },
    {
      id: 'report-1985', title: '1985 Report', preview: reportPreview('1985'),
      onOpen: () => setActiveReport('1985'),
      disabled: !rows || rows.length === 0, actionLabel: 'Open ↗',
    },
    {
      id: 'score-scatter',
      title: 'Score Scatter — Baxter vs. Local 190',
      preview: <SurplusScatterSVG points={scatterPoints} svgRef={scatterSvgRef} />,
      onOpen: projectScatter,
      disabled: scatterPoints.length === 0,
      actionLabel: 'Project ↗',
    },
    // One tile per FREE-TEXT question (Baxter: the shared issue-ranking reflection). Mirrors the
    // Winemaster export format (buildStudentTextExport → ExportModal). Baxter's question is
    // role_target 'all' (asked of BOTH roles), so — unlike Winemaster's per-role questions — the
    // tile includes every student who answered and prefixes each response with the student's role
    // (Baxter Management / Local 190). A per-role question (role_target 'baxter'/'union') keeps the
    // Winemaster single-role behaviour.
    ...questions.map(q => {
      const shared = q.role_target === 'all'
      const tileTitle = shared ? q.prompt : `${ROLE_LABELS[q.role_target] ?? q.role_target}: ${q.prompt}`
      const qRows: AiTextRow[] = (rows ?? [])
        .filter(r => (shared || r.role === q.role_target) && r.text_answers[q.field])
        .map(r => ({
          // Fold the role into the name so the shared export format still shows it per student.
          name: shared ? `${roleLabel(r.role)} · ${r.display_name}` : r.display_name,
          raw_score: r.raw_score,
          answer: r.text_answers[q.field],
        }))
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
    // Likert TABLE report ("Looking ahead to 1985") — Baxter-specific (Winemaster has no Likert):
    // rows = students (with role), columns = the 3 debrief Likert questions, cells = 1–7 rating,
    // bottom row = per-question average. Only shown once there are Likert questions.
    ...(likertQuestions.length > 0 ? [{
      id: 'likert-table',
      title: 'Looking Ahead to 1985 — Likert ratings',
      preview: likertRespondents === 0
        ? <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No responses yet.</span>
        : <span style={{ fontSize: '1.25rem', fontWeight: 700, color: '#111' }}>
            {likertRespondents} respondent{likertRespondents !== 1 ? 's' : ''}
          </span>,
      onOpen: () => setLikertOpen(true),
      disabled: !rows || likertRespondents === 0,
      actionLabel: 'Open ↗',
    } satisfies ReportTileConfig] : []),
  ]

  // Columns + title for the active report modal.
  const reportColumns =
    activeReport === '1978' ? columns1978(r => openEditor(r, '1978'), !!schema)
    : activeReport === '1983' ? columns1983
    : activeReport === '1985' ? columns1985(r => openEditor(r, '1985'), true)
    : []
  const reportTitle =
    activeReport === '1978' ? '1978 Report'
    : activeReport === '1983' ? '1983 Report'
    : activeReport === '1985' ? '1985 Report'
    : ''
  const reportSort =
    activeReport === '1978' ? 'group'
    : activeReport === '1983' ? 'group'
    : 'total'

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

      {/* ── Per-round report modal (1978 / 1983 / 1985) ── */}
      {activeReport && (
        <div
          onClick={() => setActiveReport(null)}
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
              width: '100%', maxWidth: 'min(1200px, calc(100vw - 2rem))', minWidth: 0,
              boxSizing: 'border-box', maxHeight: 'calc(100vh - 6rem)', overflowY: 'auto',
              padding: '1.25rem 1.5rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>{reportTitle}</h3>
              <button
                onClick={() => setActiveReport(null)}
                style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: '#666' }}
              >
                ✕
              </button>
            </div>
            <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 14rem)', border: '1px solid #ddd', borderRadius: 6 }}>
              <SortableTable<ReportRow, string>
                rows={rows ?? []}
                columns={reportColumns}
                getRowKey={r => r.participant_id}
                initialSortKey={reportSort}
                roleLabels={ROLE_LABELS}
                getRowRole={r => r.role}
                emptyMessage="No finalized participants yet."
                wrapHeaders
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Inline group-contract editor (round-aware: 1978 or 1985) ── */}
      {editing && editSchema && (
        <div
          onClick={() => !saving && setEditing(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '3rem 1rem', zIndex: 1200, overflowY: 'auto',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.3)', width: '100%', maxWidth: 460, padding: '1.25rem 1.5rem' }}
          >
            <h3 style={{ margin: '0 0 1rem', fontSize: '1rem', fontWeight: 600 }}>
              Edit group {editing.groupNumber ?? '—'} — {editing.round} contract
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
              {editSchema.map(field => (
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
            padding: '3rem 1rem', zIndex: 1200, overflowY: 'auto',
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

      {/* ── Likert table modal ("Looking ahead to 1985") — students × 3 questions + averages ── */}
      {likertOpen && (
        <div
          onClick={() => setLikertOpen(false)}
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
              width: '100%', maxWidth: 'min(1000px, calc(100vw - 2rem))', minWidth: 0,
              boxSizing: 'border-box', maxHeight: 'calc(100vh - 6rem)', overflowY: 'auto',
              padding: '1.25rem 1.5rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Looking Ahead to 1985 — Likert ratings (1–7)</h3>
              <button
                onClick={() => setLikertOpen(false)}
                style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: '#666' }}
              >
                ✕
              </button>
            </div>
            <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 14rem)', border: '1px solid #ddd', borderRadius: 6 }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.85rem' }}>
                <thead>
                  <tr>
                    <th style={likertTh('left')}>Name</th>
                    <th style={likertTh('left')}>Role</th>
                    {likertQuestions.map(q => (
                      <th key={q.field} style={likertTh('center')} title={q.prompt}>{q.prompt}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {likertRows.map(r => (
                    <tr key={r.participant_id}>
                      <td style={likertTd('left')}>{r.display_name}</td>
                      <td style={likertTd('left')}>{roleLabel(r.role)}</td>
                      {likertQuestions.map(q => (
                        <td key={q.field} style={likertTd('center')}>{r.likert_answers[q.field] ?? '—'}</td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <td style={likertFoot('left')} colSpan={2}>Average</td>
                    {likertQuestions.map(q => (
                      <td key={q.field} style={likertFoot('center')}>
                        {likertAverages[q.field] == null ? '—' : likertAverages[q.field]!.toFixed(2)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Likert table cell styles ────────────────────────────────────────────────────
const likertTh = (align: 'left' | 'center'): CSSProperties => ({
  textAlign: align, padding: '0.5rem 0.75rem', borderBottom: '2px solid #D38626',
  fontWeight: 700, fontSize: '0.8rem', color: '#333', position: 'sticky', top: 0, background: '#fff',
})
const likertTd = (align: 'left' | 'center'): CSSProperties => ({
  textAlign: align, padding: '0.4rem 0.75rem', borderBottom: '1px solid #eee',
  fontVariantNumeric: 'tabular-nums',
})
const likertFoot = (align: 'left' | 'center'): CSSProperties => ({
  textAlign: align, padding: '0.5rem 0.75rem', borderTop: '2px solid #ccc',
  fontWeight: 700, fontVariantNumeric: 'tabular-nums', background: '#faf7f2',
})
