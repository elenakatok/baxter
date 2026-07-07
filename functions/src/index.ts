import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import {
  makeGetInstructorSession,
  makeAssignRole,
  makeCompletePrep,
  makeConfirmReady,
  makeGenerateAttendanceCode,
  makeVerifyAttendanceCode,
  makeGetRoster,
  makeSyncRoster,
  makeTriggerMatching,
  makeStartNegotiation,
  makeSubmitLeadOutcome,
  makeSubmitConfirmation,
  makeSubmitInstructorOutcome,
  makeFinalizeInstance,
  makePushResultsToClassroom,
  makeGetGameConfig,
  makeUpdateGameConfig,
  validateKCGate,
  makeGetStudentPrepQuestions,
  makeGetDebriefQuestions,
  makeSubmitKnowledgeCheck,
  makeSubmitStaticKnowledgeCheckQuestion,
  makeGetInfoUrls,
} from '@mygames/game-server'
import { baxterGameDef } from './gameDefinition'

admin.initializeApp()

// ── KC gate validation (runs at cold start — loud failure if gate is misconfigured) ──
const _kcGateError = validateKCGate(
  baxterGameDef.roles.roles.map(r => r.key),
  baxterGameDef.prepDefaults ?? [],
)
if (_kcGateError) throw new Error(`Baxter KC gate validation failed: ${_kcGateError}`)

// ── Game endpoints (onCall, via game-server factories + Baxter definition) ─

export const getInstructorSession  = makeGetInstructorSession(baxterGameDef)
export const assignRole             = makeAssignRole(baxterGameDef)
export const completePrep           = makeCompletePrep(baxterGameDef)
export const confirmReady           = makeConfirmReady(baxterGameDef)
export const generateAttendanceCode = makeGenerateAttendanceCode(baxterGameDef)
export const verifyAttendanceCode   = makeVerifyAttendanceCode(baxterGameDef)
export const getRoster              = makeGetRoster(baxterGameDef)
export const syncRoster             = makeSyncRoster(baxterGameDef)
export const triggerMatching            = makeTriggerMatching(baxterGameDef)
export const startNegotiation           = makeStartNegotiation(baxterGameDef)
export const submitLeadOutcome          = makeSubmitLeadOutcome(baxterGameDef)
export const submitConfirmation         = makeSubmitConfirmation(baxterGameDef)
export const submitInstructorOutcome    = makeSubmitInstructorOutcome(baxterGameDef)
export const finalizeInstance       = makeFinalizeInstance(baxterGameDef)
export const pushResultsToClassroom = makePushResultsToClassroom(baxterGameDef)
export const getGameConfig          = makeGetGameConfig(baxterGameDef)
export const updateGameConfig       = makeUpdateGameConfig(baxterGameDef)
export const getStudentPrepQuestions            = makeGetStudentPrepQuestions(baxterGameDef)
export const getDebriefQuestions                = makeGetDebriefQuestions(baxterGameDef)
export const submitKnowledgeCheck               = makeSubmitKnowledgeCheck(baxterGameDef)
export const submitStaticKnowledgeCheckQuestion = makeSubmitStaticKnowledgeCheckQuestion(baxterGameDef)
export const getInfoUrls                        = makeGetInfoUrls(baxterGameDef)
export { getReportData } from './getReportData'
export { updateGroupContract } from './updateGroupContract'
export { scoreAndRecord } from './scoreAndRecord'

// ── Non-game onRequest endpoints (kept as-is; not converted) ──────────────────

const CORS_ORIGINS = new Set(['https://baxter.mygames.live'])

export const health = onRequest((req, res) => {
  const origin = req.headers.origin ?? ''
  if (CORS_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.set('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') { res.status(204).send(''); return }
  res.json({ ok: true, game: 'baxter' })
})

// Emulator-only dev seed functions — onRequest, not game endpoints.
export { seedMatchTest, seedGroupForTest } from './seedFunctions'
