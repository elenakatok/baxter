import React, { useEffect, useRef, useState } from 'react'
import { doc, getDoc, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, rtdb, functions } from '../firebase'
import { assignRole, confirmReady, verifyAttendanceCode, CLASSROOM_URL } from '../api'
import {
  useStudentSession,
  KnowledgeCheck,
  InfoPage,
  PrepQuestions,
  GameHeader,
  WaitingRoom,
  GroupReveal,
  OffPlatformHolding,
  Results,
  typography,
  colors,
  layout,
  spacing,
} from '@mygames/game-ui'
import type { BootstrapArgs, InfoPageLink } from '@mygames/game-ui'
import OutcomeReporting from '../phases/OutcomeReporting'
import { baxterConfig, baxterSchema, FIELD_LABELS, formatField } from '../gameConfig'

// ── Phase state ───────────────────────────────────────────────────────────────

type GamePhase =
  | { name: 'loading' }
  | { name: 'error';           message: string }
  | { name: 'info';            roleLabel: string; links: InfoPageLink[]; publicLink: { label: string; url: string } | null }
  | { name: 'kc' }
  | { name: 'prep' }
  | { name: 'hold' }
  | { name: 'confirmation' }
  | { name: 'attendance-code' }
  | { name: 'waiting-room' }
  | { name: 'group-reveal';    groupId: string }
  | { name: 'day2-hold';       groupId: string }
  | { name: 'off-platform';    groupId: string }
  | { name: 'outcome-reporting'; groupId: string; isLead: boolean }
  | { name: 'results';         groupId: string }

// ── Phase routing ─────────────────────────────────────────────────────────────

type GetInfoUrlsResult = {
  ok: boolean
  roleLabel: string
  links: InfoPageLink[]
  publicLink: { label: string; url: string } | null
}

// Baxter's round list (mirrors functions/src/gameDefinition.ts `rounds`). Round-scoped
// presence + round-index clamping below mirror game-server's pure getRoundPresence /
// clampRoundIndex (v0.11.0). We re-implement the tiny pure logic here rather than importing
// @mygames/game-server, which is a Cloud-Functions (firebase-admin) package that cannot be
// bundled into a browser build. Semantics are identical for Baxter's rounds.
const BAXTER_ROUNDS = ['1978', '1983', '1985'] as const

/** Clamp a stored (possibly missing/garbage) round pointer to a valid index. */
function clampRoundIndex(stored: unknown): number {
  const i = (typeof stored === 'number' && Number.isInteger(stored)) ? stored : 0
  return Math.max(0, Math.min(i, BAXTER_ROUNDS.length - 1))
}

/**
 * Is this participant present for the given round (Option-1 derive)?
 * Round 1 (idx 0) uses the flat `attendance_confirmed_at` flag (unchanged); rounds 2+ use
 * the keyed `attendance_by_round[roundId]` map written by verifyAttendanceCode when the
 * instance's current_round has advanced.
 */
function isPresentForRound(p: Record<string, unknown>, roundIdx: number): boolean {
  if (roundIdx <= 0) return p['attendance_confirmed_at'] != null
  const roundId = BAXTER_ROUNDS[roundIdx]
  const map = (p['attendance_by_round'] ?? {}) as Record<string, unknown>
  return map[roundId] != null
}

async function routeToPhase(
  participantId: string,
  gameInstanceId: string,
  currentRound: number,
  round2Begun: boolean,
): Promise<GamePhase> {
  const snap = await getDoc(
    doc(db, 'game_instances', gameInstanceId, 'participants', participantId),
  )
  const d = (snap.data() ?? {}) as Record<string, unknown>

  if (d.prep_status !== 'complete') {
    if (d.knowledge_check_score != null) return { name: 'prep' }
    const fn = httpsCallable<object, GetInfoUrlsResult>(functions, 'getInfoUrls')
    const { data } = await fn({})
    return {
      name:       'info',
      roleLabel:  data.roleLabel,
      links:      data.links,
      publicLink: data.publicLink ?? null,
    }
  }

  // prep_status === 'complete' — Phase 2 routing
  if (!d.confirmed_ready_at)    return { name: 'hold' }

  // Round-scoped attendance gate (Bug A, keystone). Presence is per-round: a student who
  // completed round 1 but has NOT re-confirmed attendance for the ADVANCED round must return
  // to the attendance flow — and this check runs BEFORE the group-status routing below,
  // so it takes precedence over the completed→results branch that otherwise strands a
  // day-1-completed student on their 1978 results when the class moves to 1983.
  if (!isPresentForRound(d, currentRound)) {
    // Round 1 keeps the existing two-step confirmation→code flow (unchanged). Rounds 2+
    // (day 2) go straight to the code screen — the student already confirmed-ready in round 1
    // and confirmed_ready_at persists, so re-confirming readiness would be redundant.
    return currentRound <= 0 ? { name: 'confirmation' } : { name: 'attendance-code' }
  }

  if (!d.group_id)              return { name: 'waiting-room' }

  const groupId = d.group_id as string
  const groupSnap = await getDoc(
    doc(db, 'game_instances', gameInstanceId, 'groups', groupId),
  )
  const g = groupSnap.data() ?? {}
  const status = g['status'] as string | undefined

  if (status === 'matched')    return { name: 'group-reveal', groupId }
  if (status === 'negotiating') return { name: 'off-platform', groupId }
  if (status === 'reporting' || status === 'deadlocked') {
    return { name: 'outcome-reporting', groupId, isLead: d.is_lead === true }
  }
  if (status === 'completed') {
    // Bug F: in a day-2 round (currentRound > 0), a 'completed' group whose day-2 re-open has
    // NOT run yet (round2_begun_at unset) is still closed from the previous round — Begin 1983
    // has not been clicked. Route to the day-2 waiting hold, NOT results, and NOT the shared
    // GroupReveal whose "Start negotiation" button would 400 against a not-yet-reopened group.
    // Once the round has begun, a 'completed' group means this round is genuinely resolved.
    if (currentRound > 0 && !round2Begun) return { name: 'day2-hold', groupId }
    return { name: 'results', groupId }
  }

  return { name: 'waiting-room' }
}

// ── Baxter-specific outcome formatter ─────────────────────────────────────────

function formatBaxterOutcome(
  outcome: Record<string, unknown> | null,
  agreementReached: boolean,
): React.ReactNode {
  if (!agreementReached || outcome == null) {
    return (
      <p style={{ fontSize: '1.05rem', color: colors.textSecondary, marginBottom: layout.pagePad }}>
        No deal reached.
      </p>
    )
  }
  return (
    <div style={{
      background:   '#f0f7ff',
      border:       '1px solid #b3d4f5',
      borderRadius: '4px',
      padding:      '0.75rem 1rem',
      marginBottom: layout.pagePad,
    }}>
      {baxterSchema.map(field => (
        <div key={field.key} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.2rem 0' }}>
          <span style={{ color: colors.textSecondary, marginRight: '1rem' }}>
            {FIELD_LABELS[field.key] ?? field.key}
          </span>
          <span>{formatField(field, outcome[field.key])}</span>
        </div>
      ))}
    </div>
  )
}

// ── Day-2 pre-negotiation hold (Bug F) ────────────────────────────────────────
// After re-attending for a day-2 round, the group is still 'completed' from the prior round
// until the instructor clicks "Begin 1983" (which re-opens it straight to 'negotiating' via
// reopenGroupPatch). This screen replaces the shared GroupReveal for day-2 rounds: it shows a
// waiting state with NO start button — gating on the group's ACTUAL status, the same signal
// startNegotiation requires — and hands off only once the group is genuinely re-opened. That
// removes the early "Start negotiation" click that 400s against a not-yet-reopened group.

function Day2Hold({
  groupId,
  participantId,
  gameInstanceId,
  onNegotiate,
  onReport,
}: {
  groupId:        string
  participantId:  string
  gameInstanceId: string
  onNegotiate:    () => void
  onReport:       (isLead: boolean) => void
}) {
  const onNegotiateRef = useRef(onNegotiate)
  const onReportRef    = useRef(onReport)
  onNegotiateRef.current = onNegotiate
  onReportRef.current    = onReport

  useEffect(() => {
    const groupRef = doc(db, 'game_instances', gameInstanceId, 'groups', groupId)
    return onSnapshot(groupRef, (snap) => {
      if (!snap.exists()) return
      const g = snap.data() as Record<string, unknown>
      const status = g['status'] as string | undefined
      // Re-opened for the new round → straight into the negotiation (reopenGroupPatch sets
      // 'negotiating' directly, so there is no 'matched'/Start-button step in a day-2 round).
      if (status === 'negotiating') { onNegotiateRef.current(); return }
      // Instructor intervention (e.g. an absence deadlock flagged by Begin 1983) → reporting view.
      if (status === 'reporting' || status === 'deadlocked') {
        onReportRef.current((g['lead_participant_id'] as string | undefined) === participantId)
      }
      // 'completed' (still closed) → keep waiting; no start action is offered.
    })
  }, [groupId, gameInstanceId, participantId])

  return (
    <main style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
      <h1 style={{ marginTop: 0 }}>You&apos;re checked in</h1>
      <p style={{ lineHeight: 1.6, marginBottom: spacing.gapSm }}>
        Waiting for your instructor to begin the 1983 negotiation.
      </p>
      <p style={{ color: colors.textSecondary }}>
        Stay on this page — it will advance automatically once your group is re-opened.
      </p>
    </main>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Play() {
  const p       = new URLSearchParams(window.location.search)
  const token   = p.get('token')
  const testPid = import.meta.env.DEV ? p.get('_pid') : null
  const testGid = import.meta.env.DEV ? p.get('_gid') : null

  const [phase, setPhase]             = useState<GamePhase>({ name: 'loading' })
  const [currentRound, setCurrentRound] = useState(0)
  const [headerLinks, setHeaderLinks] = useState<InfoPageLink[] | null>(null)
  const [confError,   setConfError]   = useState<string | null>(null)
  const [confLoading, setConfLoading] = useState(false)
  const [codeValue,   setCodeValue]   = useState('')
  const [codeError,   setCodeError]   = useState<string | null>(null)
  const [codeLoading, setCodeLoading] = useState(false)

  // ── Session lifecycle ────────────────────────────────────────────────────

  const session = useStudentSession({
    auth,
    token,
    testIds: (testPid && testGid) ? { participantId: testPid, gameInstanceId: testGid } : null,
    bootstrap: async (args: BootstrapArgs) => {
      const r = await assignRole(args)
      return {
        participantId:  r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken:    r.customToken,
      }
    },
  })

  // ── Phase routing + header-link population ────────────────────────────────
  // Bug A: the router is now REACTIVE to the instance's current_round. We subscribe to the
  // instance doc and re-run routeToPhase whenever the round pointer changes, so a student
  // stranded on their round-1 results re-evaluates the moment the instructor clicks "Open
  // Round 2 Attendance" and moves to the day-2 attendance-code screen live (or on refresh).
  // Within a round, current_round is stable, so routing still runs once per round and the
  // per-phase components self-advance exactly as before — round-1 behaviour is unchanged.

  useEffect(() => {
    if (session.kind !== 'ready') return
    const { participantId, gameInstanceId } = session
    let cancelled = false
    let lastRound: number | null = null
    let headerLoaded = false

    const loadHeader = (p: GamePhase) => {
      if (headerLoaded) return
      headerLoaded = true
      if (p.name === 'info') { setHeaderLinks(p.links); return }
      const fn = httpsCallable<object, GetInfoUrlsResult>(functions, 'getInfoUrls')
      fn({}).then(({ data }) => { if (!cancelled) setHeaderLinks(data.links) }).catch(() => {})
    }

    const evaluate = async (roundIdx: number, round2Begun: boolean) => {
      let p: GamePhase
      try {
        p = await routeToPhase(participantId, gameInstanceId, roundIdx, round2Begun)
      } catch (err) {
        if (!cancelled) setPhase({ name: 'error', message: err instanceof Error ? err.message : 'Failed to load session.' })
        return
      }
      if (cancelled) return
      setPhase(p)
      loadHeader(p)
    }

    const unsub = onSnapshot(
      doc(db, 'game_instances', gameInstanceId),
      (snap) => {
        const idx = clampRoundIndex(snap.data()?.current_round)
        const round2Begun = snap.data()?.round2_begun_at != null
        setCurrentRound(idx)              // keep render-scope round fresh (waiting-room routing)
        if (idx === lastRound) return     // only re-route when the round pointer actually changes
        lastRound = idx
        void evaluate(idx, round2Begun)
      },
      () => {
        // Instance doc unreadable (e.g. firestore rule not yet deployed) — fall back to
        // round 1 once so a normal round-1 student is never blocked. Live day-2 re-routing
        // requires the instance read rule (games/baxter/firestore.rules).
        if (lastRound === null) { lastRound = 0; void evaluate(0, false) }
      },
    )

    return () => { cancelled = true; unsub() }
  }, [session])

  // ── Render: pre-session states (no header) ────────────────────────────────

  if (session.kind === 'loading' || (session.kind === 'ready' && phase.name === 'loading')) {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p>Loading…</p>
      </main>
    )
  }

  if (session.kind === 'no-token') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily, maxWidth: '480px', margin: '2rem auto' }}>
        <h2 style={{ marginBottom: '0.75rem' }}>Baxter</h2>
        <p>Please launch Baxter from the classroom to join a session.</p>
        <p style={{ marginTop: '1.5rem' }}><a href={CLASSROOM_URL}>← Go to classroom</a></p>
      </main>
    )
  }

  if (session.kind === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p style={{ color: '#c00' }}>{session.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  if (phase.name === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p style={{ color: '#c00' }}>{phase.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  const { participantId, gameInstanceId } = session

  // ── P2 inline handlers ────────────────────────────────────────────────────

  const handleConfirmReady = () => {
    setConfLoading(true)
    setConfError(null)
    confirmReady({})
      .then(() => setPhase({ name: 'attendance-code' }))
      .catch((err: unknown) => {
        setConfError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
        setConfLoading(false)
      })
  }

  const handleAttendanceCode = (e: React.FormEvent) => {
    e.preventDefault()
    const code = codeValue.trim()
    if (code.length < 4) return
    setCodeLoading(true)
    setCodeError(null)
    verifyAttendanceCode({}, code)
      .then(() => setPhase({ name: 'waiting-room' }))
      .catch((err: unknown) => {
        setCodeError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
        setCodeLoading(false)
      })
  }

  // ── Render: session ready — header persists across all phases ─────────────

  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <GameHeader studentLinks={headerLinks} />

      {phase.name === 'info' && (
        <InfoPage
          roleLabel={phase.roleLabel}
          links={phase.links}
          publicLink={phase.publicLink}
          onContinue={() => setPhase({ name: 'kc' })}
        />
      )}

      {phase.name === 'kc' && (
        <KnowledgeCheck
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          functions={functions}
          db={db}
          onComplete={() => setPhase({ name: 'prep' })}
        />
      )}

      {phase.name === 'prep' && (
        <PrepQuestions
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          functions={functions}
          db={db}
          onComplete={() => setPhase({ name: 'hold' })}
        />
      )}

      {phase.name === 'hold' && (
        <main style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Preparation complete</h1>
          <p style={{ lineHeight: 1.6, marginBottom: spacing.gapSm }}>
            When class begins and your instructor starts the session, you&apos;ll see who
            you&apos;ve been matched with.
          </p>
          <p style={{ color: colors.textSecondary, marginBottom: layout.pagePad }}>
            You can close this tab and come back later — your work has been saved.
          </p>
          <button onClick={() => setPhase({ name: 'confirmation' })}>
            I&apos;m in class — continue
          </button>
        </main>
      )}

      {phase.name === 'confirmation' && (
        <main style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Ready to negotiate?</h1>
          <p style={{ lineHeight: 1.6, marginBottom: spacing.gapSm }}>
            You&apos;ll be paired with other students for a face-to-face negotiation.
            Only continue if you are in class and ready to negotiate right now.
          </p>
          {confError && (
            <p style={{ color: '#c00', marginBottom: spacing.gapSm }}>{confError}</p>
          )}
          <div style={{ display: 'flex', gap: spacing.gapBtn }}>
            <button onClick={handleConfirmReady} disabled={confLoading}>
              {confLoading ? 'Confirming…' : "Yes, I'm ready"}
            </button>
            <button
              onClick={() => setPhase({ name: 'hold' })}
              disabled={confLoading}
              style={{ background: 'none', border: '1px solid #ccc' }}
            >
              Not now
            </button>
          </div>
        </main>
      )}

      {phase.name === 'attendance-code' && (
        <main style={{ padding: layout.pagePad, maxWidth: '540px', margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Enter attendance code</h1>
          <p style={{ lineHeight: 1.6, marginBottom: layout.pagePad }}>
            Enter the code your instructor is displaying.
          </p>
          <form onSubmit={handleAttendanceCode}>
            <input
              value={codeValue}
              onChange={e => setCodeValue(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="e.g. ABJKM"
              autoFocus
              autoCapitalize="characters"
              spellCheck={false}
              disabled={codeLoading}
              style={{
                fontSize:     '2rem',
                letterSpacing: '0.25em',
                width:         '100%',
                padding:       '0.5rem 0.75rem',
                boxSizing:     'border-box',
                fontFamily:    'monospace',
                textTransform: 'uppercase',
              }}
            />
            {codeError && (
              <p style={{ color: '#c00', marginTop: '0.75rem' }}>{codeError}</p>
            )}
            <button
              type="submit"
              disabled={codeLoading || codeValue.trim().length < 4}
              style={{ marginTop: spacing.gapMd }}
            >
              {codeLoading ? 'Checking…' : 'Submit'}
            </button>
          </form>
        </main>
      )}

      {phase.name === 'waiting-room' && (
        <WaitingRoom
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          db={db}
          rtdb={rtdb}
          // Round 1: the shared GroupReveal + "Start negotiation" flow (unchanged). Day-2 rounds
          // (Bug F): the group is re-attended but not yet re-opened, so go to the day-2 hold —
          // never the GroupReveal Start button, which would 400 pre-Begin-1983.
          onMatched={(groupId) => setPhase(currentRound > 0 ? { name: 'day2-hold', groupId } : { name: 'group-reveal', groupId })}
        />
      )}

      {phase.name === 'day2-hold' && (
        <Day2Hold
          groupId={phase.groupId}
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          onNegotiate={() => setPhase({ name: 'off-platform', groupId: phase.groupId })}
          onReport={(isLead) => setPhase({ name: 'outcome-reporting', groupId: phase.groupId, isLead })}
        />
      )}

      {phase.name === 'group-reveal' && (
        <GroupReveal
          groupId={phase.groupId}
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          roleConfig={baxterConfig}
          db={db}
          rtdb={rtdb}
          functions={functions}
          onContinue={() => setPhase({ name: 'off-platform', groupId: phase.groupId })}
        />
      )}

      {phase.name === 'off-platform' && (
        <OffPlatformHolding
          groupId={phase.groupId}
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          db={db}
          onReportOutcome={(isLead) => setPhase({ name: 'outcome-reporting', groupId: phase.groupId, isLead })}
        />
      )}

      {phase.name === 'outcome-reporting' && (
        <OutcomeReporting
          groupId={phase.groupId}
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          isLead={phase.isLead}
          args={{}}
          onComplete={() => setPhase({ name: 'results', groupId: phase.groupId })}
        />
      )}

      {phase.name === 'results' && (
        <Results
          groupId={phase.groupId}
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          roleConfig={baxterConfig}
          formatOutcome={formatBaxterOutcome}
          db={db}
          rtdb={rtdb}
          functions={functions}
        />
      )}
    </div>
  )
}
