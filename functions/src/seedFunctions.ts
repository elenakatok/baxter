import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'

// Emulator-only: seed participants and RTDB presence for triggerMatching tests.
export const seedMatchTest = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(404).json({ error: 'Not found' })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  // Accept both flat { ... } and v2 onCall-style { data: { ... } } bodies from test helpers.
  const body = (req.body?.data ?? req.body) as { game_instance_id?: unknown; participants?: unknown }

  if (typeof body.game_instance_id !== 'string' || !body.game_instance_id) {
    res.status(400).json({ error: 'game_instance_id required' })
    return
  }
  if (!Array.isArray(body.participants)) {
    res.status(400).json({ error: 'participants array required' })
    return
  }

  type SeedP = { id: string; role: 'baxter' | 'union' }
  const gameInstanceId = body.game_instance_id
  const participants = body.participants as SeedP[]

  const db = admin.firestore()
  const rtdb = admin.database()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)
  const now = Timestamp.now()

  // Clear existing participants and groups for a clean test run.
  const [existingPs, existingGs] = await Promise.all([
    instanceRef.collection('participants').get(),
    instanceRef.collection('groups').get(),
  ])
  if (existingPs.size > 0 || existingGs.size > 0) {
    const clearBatch = db.batch()
    for (const d of existingPs.docs) clearBatch.delete(d.ref)
    for (const d of existingGs.docs) clearBatch.delete(d.ref)
    await clearBatch.commit()
  }
  await rtdb.ref(`presence/${gameInstanceId}`).remove()

  // Seed participant docs and RTDB presence.
  const seedBatch = db.batch()
  const presenceData: Record<string, unknown> = {}
  for (const p of participants) {
    seedBatch.set(instanceRef.collection('participants').doc(p.id), {
      participant_id: p.id,
      game_instance_id: gameInstanceId,
      role: p.role,
      prep_status: 'complete',
      attendance_confirmed_at: now,
      confirmed_ready_at: now,
    })
    presenceData[p.id] = { online: true, last_seen: now.toMillis() }
  }
  await seedBatch.commit()
  await rtdb.ref(`presence/${gameInstanceId}`).set(presenceData)

  res.json({ ok: true, seeded: participants.length })
})

// Emulator-only: seed a matched group directly (bypass triggerMatching) for B4a outcome tests.
// Creates participant docs with group_id/is_lead stamped and a group doc in 'matched' state.
export const seedGroupForTest = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(404).json({ error: 'Not found' })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  // Accept both flat { ... } and v2 onCall-style { data: { ... } } bodies from test helpers.
  const body = (req.body?.data ?? req.body) as {
    game_instance_id?: unknown
    group_id?: unknown
    lead_id?: unknown
    baxter_participants?: unknown
    union_participants?: unknown
  }

  if (typeof body.game_instance_id !== 'string' || !body.game_instance_id) {
    res.status(400).json({ error: 'game_instance_id required' }); return
  }
  if (typeof body.group_id !== 'string' || !body.group_id) {
    res.status(400).json({ error: 'group_id required' }); return
  }
  if (typeof body.lead_id !== 'string' || !body.lead_id) {
    res.status(400).json({ error: 'lead_id required' }); return
  }
  if (!Array.isArray(body.baxter_participants) || !Array.isArray(body.union_participants)) {
    res.status(400).json({ error: 'baxter_participants and union_participants arrays required' }); return
  }

  const gameInstanceId = body.game_instance_id
  const groupId = body.group_id
  const leadId = body.lead_id
  const baxterPids = body.baxter_participants as string[]
  const unionPids = body.union_participants as string[]

  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)
  const now = Timestamp.now()

  // Clear any existing state for this game instance.
  const [existingPs, existingGs] = await Promise.all([
    instanceRef.collection('participants').get(),
    instanceRef.collection('groups').get(),
  ])
  if (existingPs.size > 0 || existingGs.size > 0) {
    const clearBatch = db.batch()
    for (const d of existingPs.docs) clearBatch.delete(d.ref)
    for (const d of existingGs.docs) clearBatch.delete(d.ref)
    await clearBatch.commit()
  }

  // Write group doc.
  const groupRef = instanceRef.collection('groups').doc(groupId)
  await groupRef.set({
    group_id: groupId,
    game_instance_id: gameInstanceId,
    baxter_participants: baxterPids,
    union_participants: unionPids,
    lead_participant_id: leadId,
    outcome: null,
    status: 'matched',
    matched_at: now,
  })

  // Write participant docs.
  const batch = db.batch()
  for (const pid of baxterPids) {
    batch.set(instanceRef.collection('participants').doc(pid), {
      participant_id: pid,
      game_instance_id: gameInstanceId,
      role: 'baxter',
      group_id: groupId,
      is_lead: pid === leadId,
      attendance_confirmed_at: now,
    })
  }
  for (const pid of unionPids) {
    batch.set(instanceRef.collection('participants').doc(pid), {
      participant_id: pid,
      game_instance_id: gameInstanceId,
      role: 'union',
      group_id: groupId,
      is_lead: false,
      attendance_confirmed_at: now,
    })
  }
  await batch.commit()

  res.json({ ok: true, group_id: groupId, lead_id: leadId })
})
