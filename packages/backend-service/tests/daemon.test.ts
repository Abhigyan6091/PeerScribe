import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerScribeDaemon } from '../src/node_daemon.ts';
import { createPeerScribeServer } from '../src/server.ts';

test('Backend Service Daemon: Lifecycle, SQLite Persistence & DTN Outbox', () => {
  const daemon = new PeerScribeDaemon({ dbPath: ':memory:' });
  assert.ok(daemon.nodeId.length > 0);
  assert.strictEqual(daemon.currentMode, 'FIELD');

  // Mode transition
  daemon.transitionMode('EMERGENCY');
  assert.strictEqual(daemon.currentMode, 'EMERGENCY');

  // Create patient
  const patient = daemon.createPatient('RED-BADGER-09');
  assert.strictEqual(patient.ephemeralId, 'RED-BADGER-09');

  // Verify SQLite persistence
  const loaded = daemon.db.getPatientDocument(patient.patientId);
  assert.ok(loaded !== null);
  assert.strictEqual(loaded!.ephemeralId, 'RED-BADGER-09');

  // Record Triage: RED
  const triageResult = daemon.recordTriage(patient.patientId, 'RED', 'START_v1.0.0', 'Severe respiratory distress');
  assert.strictEqual(triageResult.activeTriage, 'RED');
  assert.strictEqual(triageResult.divergences.length, 0);

  // Verify DTN outbox has pending packet
  const pendingBundles = daemon.dtnOutbox.getBundlesNeededByNeighbor(new (daemon.dtnOutbox.getLocalBloomFilter().constructor as any)());
  assert.strictEqual(pendingBundles.length, 1);
  assert.strictEqual(pendingBundles[0].priority, 3); // CRITICAL_SOS
});

test('Backend Service Daemon: Semantic Divergence & Clinician Sign-Off', () => {
  const daemon = new PeerScribeDaemon({ dbPath: ':memory:' });
  const patient = daemon.createPatient('YELLOW-EAGLE-02');

  // Medic 1 tags as GREEN
  daemon.recordTriage(patient.patientId, 'GREEN', 'START_v1.0.0');

  // Medic 2 concurrently tags as RED
  const conflictingTriage = daemon.recordTriage(patient.patientId, 'RED', 'START_v1.0.0');
  assert.ok(conflictingTriage.divergences.length > 0);
  const divFlag = conflictingTriage.divergences[0];
  assert.strictEqual(divFlag.conflictType, 'DIV_TRIAGE_DELTA');

  // Clinician signs off
  const resolved = daemon.resolveDivergenceFlag(patient.patientId, divFlag.id, 'Confirmed RED by Lead Trauma Medic');
  const targetFlag = resolved.divergenceFlags.find((f: any) => f.id === divFlag.id);
  assert.ok(targetFlag);
  assert.strictEqual(targetFlag!.resolved, true);
});

test('Backend Service Daemon: Speech Transcript to START Triage Pipeline', () => {
  const daemon = new PeerScribeDaemon({ dbPath: ':memory:' });
  const transcript = 'Adult male victim, respiration rate 36, absent radial pulse, altered mental status';

  const res = daemon.processVoiceTranscript(transcript);
  assert.ok(res.patientId);
  assert.strictEqual(res.observation.respirationRate, 36);
  assert.strictEqual(res.observation.radialPulsePresent, false);
  assert.strictEqual(res.triageResult.category, 'RED');

  // Check persisted state in SQLite
  const loaded = daemon.db.getPatientDocument(res.patientId);
  assert.ok(loaded);
  assert.strictEqual(loaded!.vitals.length, 1);
  assert.strictEqual(loaded!.triageEvaluations.length, 1);
});

test('Backend Service Daemon: Voice Distress Relay with Broken Leg, Entrapment & Situational Notes', () => {
  const daemon = new PeerScribeDaemon({ dbPath: ':memory:' });
  const distressMsg = "I have a broken leg and I'm trapped under rubble in basement B, cannot figure out where I am";

  const res = daemon.processVoiceTranscript(distressMsg);
  assert.ok(res.patientId);
  assert.strictEqual(res.observation.canWalk, false);
  assert.strictEqual(res.observation.mentalStatus, 'ALTERED');
  assert.ok(res.observation.injuries.some((i: string) => i.includes('broken leg')));
  assert.ok(res.observation.injuries.some((i: string) => i.includes('trapped')));
  assert.strictEqual(res.triageResult.category, 'RED');

  // Verify CRDT document persisted injuries and distress note
  const loaded = daemon.db.getPatientDocument(res.patientId);
  assert.ok(loaded);
  assert.ok(loaded!.injuries.length >= 2);
  assert.ok(loaded!.notes.length >= 1);
  assert.ok(loaded!.notes[0].text.includes(distressMsg));

  // Verify prioritized DTN outbox and wire packet propagation
  assert.ok(daemon.recentWirePackets.length > 0);
  assert.strictEqual(daemon.recentWirePackets[0].priority, 'CRITICAL_SOS');
});

test('Backend Service Daemon: Natural Trauma Speech Extraction ("injured in hand and legs, cannot work")', () => {
  const daemon = new PeerScribeDaemon({ dbPath: ':memory:' });
  const transcript = "I am currently very busy I can't work I am injured in my hand and legs";

  const res = daemon.processVoiceTranscript(transcript);
  assert.ok(res.patientId);
  assert.strictEqual(res.observation.canWalk, false);
  assert.strictEqual(res.observation.mobilityStatus, 'IMPAIRED');
  assert.ok(res.observation.injuries.some((i: string) => i.includes('injured in my hand and legs')));
  assert.strictEqual(res.triageResult.category, 'YELLOW');
  assert.ok(res.triageResult.reason.includes('injured in my hand and legs'));

  // Verify CRDT document recorded injury
  const loaded = daemon.db.getPatientDocument(res.patientId);
  assert.ok(loaded);
  assert.ok(loaded!.injuries.length >= 1);
  assert.strictEqual(loaded!.injuries[0].classification, 'injured in my hand and legs');
  assert.ok(loaded!.notes[0].text.includes(transcript));
});

test('Backend Service Daemon: HTTP Server API Endpoints', async () => {
  const daemon = new PeerScribeDaemon({ dbPath: ':memory:' });
  const server = createPeerScribeServer(daemon);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. GET /health
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.strictEqual(healthRes.status, 200);
    const healthData = await healthRes.json() as any;
    assert.strictEqual(healthData.status, 'OK');

    // 2. GET /api/v1/status
    const statusRes = await fetch(`${baseUrl}/api/v1/status`);
    assert.strictEqual(statusRes.status, 200);
    const statusData = await statusRes.json() as any;
    assert.strictEqual(statusData.nodeId, daemon.nodeId);

    // 3. POST /api/v1/mode
    const modeRes = await fetch(`${baseUrl}/api/v1/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'EMERGENCY' })
    });
    assert.strictEqual(modeRes.status, 200);
    assert.strictEqual(daemon.currentMode, 'EMERGENCY');

    // 4. POST /api/v1/patients
    const createRes = await fetch(`${baseUrl}/api/v1/patients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ephemeralId: 'GREEN-TURTLE-11' })
    });
    assert.strictEqual(createRes.status, 201);
    const createdPatient = await createRes.json() as any;
    assert.strictEqual(createdPatient.ephemeralId, 'GREEN-TURTLE-11');

    // 5. POST /api/v1/patients/:id/triage
    const triageRes = await fetch(`${baseUrl}/api/v1/patients/${createdPatient.patientId}/triage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'YELLOW', protocol: 'START_v1.0.0' })
    });
    assert.strictEqual(triageRes.status, 200);
    const triageData = await triageRes.json() as any;
    assert.strictEqual(triageData.activeTriage, 'YELLOW');

    // 7. POST /api/v1/security/wipe
    const wipeRes = await fetch(`${baseUrl}/api/v1/security/wipe`, { method: 'POST' });
    assert.strictEqual(wipeRes.status, 200);
    const wipeData = await wipeRes.json() as any;
    assert.strictEqual(wipeData.zeroized, true);

    // Verify patients are empty after wipe
    const postWipePatientsRes = await fetch(`${baseUrl}/api/v1/patients`);
    const postWipePatients = await postWipePatientsRes.json() as any[];
    assert.strictEqual(postWipePatients.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Backend Service Daemon: Emergency Wipe Complete Database & State Zeroization', () => {
  const daemon = new PeerScribeDaemon({ dbPath: ':memory:' });
  
  // Populate state: patient, vitals, audit logs, wire packets, DTN bundle
  const patient = daemon.createPatient('RED-WIPETEST-01');
  daemon.recordTriage(patient.patientId, 'RED', 'START_v1.0.0');
  daemon.recordVitals(patient.patientId, { respirationRate: 32 });

  assert.strictEqual(daemon.listPatients().length, 1);
  assert.ok(daemon.recentWirePackets.length > 0);
  assert.ok(daemon.recentActivityLogs.length > 0);

  const oldNodeId = daemon.nodeId;
  let sseWipedEmitted = false;
  daemon.on('emergencyWiped', (data) => {
    sseWipedEmitted = true;
    assert.ok(data.timestamp > 0);
    assert.ok(data.targetsWiped.includes('SqliteRelationalStorage'));
    assert.ok(data.targetsWiped.includes('DtnOutboxQueue'));
    assert.ok(data.targetsWiped.includes('SessionEphemeralKeysAndLogs'));
  });

  // Execute wipe
  const success = daemon.triggerEmergencyWipe();
  assert.strictEqual(success, true);
  assert.strictEqual(sseWipedEmitted, true);

  // Assert SQLite database is completely purged
  assert.strictEqual(daemon.listPatients().length, 0);
  assert.strictEqual(daemon.db.listPatientDocuments(daemon.currentOperationId).length, 0);
  assert.strictEqual(daemon.db.listPendingDtnBundles(daemon.currentOperationId).length, 0);
  assert.strictEqual(daemon.db.getAuditTrail(patient.patientId).length, 0);

  // Assert memory buffers zeroized
  assert.strictEqual(daemon.recentWirePackets.length, 0);
  assert.strictEqual(daemon.recentNostrEvents.length, 0);
  assert.strictEqual(daemon.recentActivityLogs.length, 0);

  // Assert new identity generated
  assert.notStrictEqual(daemon.nodeId, oldNodeId);
});

test('Backend Service Daemon: Tri-Modal Power Transitions & Gateway Adaptation', () => {
  const daemon = new PeerScribeDaemon({ dbPath: ':memory:' });
  assert.strictEqual(daemon.currentMode, 'FIELD');

  let modeEventCount = 0;
  daemon.on('modeChanged', () => { modeEventCount++; });

  // Transition to DORMANT -> Nostr Gateway deactivated to conserve power (<0.3%/hr)
  daemon.transitionMode('DORMANT');
  assert.strictEqual(daemon.currentMode, 'DORMANT');
  assert.strictEqual(daemon.nostrGateway.isGatewayActive, false);

  // Transition to EMERGENCY -> Nostr Gateway activated, high-alert
  daemon.transitionMode('EMERGENCY');
  assert.strictEqual(daemon.currentMode, 'EMERGENCY');
  assert.strictEqual(daemon.nostrGateway.isGatewayActive, true);

  // Transition to FIELD
  daemon.transitionMode('FIELD');
  assert.strictEqual(daemon.currentMode, 'FIELD');

  assert.strictEqual(modeEventCount, 3);
});

test('Backend Service Daemon: Emergency Snapshot Attachment & Drug Allergy Divergence', () => {
  const daemon = new PeerScribeDaemon({ dbPath: ':memory:' });
  const patient = daemon.createPatient('ORANGE-FALCON-08');

  // Medic administers Amoxicillin
  daemon.recordMedication(patient.patientId, 'Amoxicillin', '500mg', 'Oral');

  // Attach Emergency Medical ID Snapshot with documented Penicillin allergy
  const snapshotResult = daemon.attachEmergencySnapshot(patient.patientId, {
    bloodGroup: 'B+',
    allergies: ['Penicillin'],
    criticalConditions: ['Asthma'],
    currentMedicationsSummary: ['Albuterol Inhaler'],
    emergencyContacts: [{ name: 'Sita', relation: 'Sister', phone: '+977-9812345678' }],
    extractedAt: Date.now()
  });

  // Level 2 Semantic Safety Analyzer should immediately flag DIV_DRUG_ALLERGY!
  assert.ok(snapshotResult.divergences.length > 0);
  assert.strictEqual(snapshotResult.divergences[0].conflictType, 'DIV_DRUG_ALLERGY');
  assert.strictEqual(snapshotResult.divergences[0].severity, 'FATAL_RISK');

  // Verify SQLite WAL persistence of DTN bundle and audit event
  const dtnBundles = daemon.db.listPendingDtnBundles(daemon.currentOperationId);
  assert.ok(dtnBundles.length >= 2);
});

test('Backend Service Daemon: RBAC Capability Enforcement & Operation Lifecycle Management', async () => {
  const daemon = new PeerScribeDaemon({ initialRole: 'COORDINATOR' });
  const server = createPeerScribeServer(daemon);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Verify Coordinator capabilities for operation management
    const createOpRes = await fetch(`${baseUrl}/api/v1/operations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationId: 'OP_FLOOD_RELIEF_2026',
        name: 'Operation River Shield',
        sectorGeohash: 'u15ek999'
      })
    });
    assert.strictEqual(createOpRes.status, 201);

    // Switch operation
    const switchRes = await fetch(`${baseUrl}/api/v1/operations/OP_FLOOD_RELIEF_2026/switch`, {
      method: 'POST'
    });
    assert.strictEqual(switchRes.status, 200);
    assert.strictEqual(daemon.currentOperationId, 'OP_FLOOD_RELIEF_2026');

    // Create a patient in this operation
    const patientDoc = daemon.createPatient();

    // 2. Switch role to PARTICIPANT (General Civilian / Unverified Actor)
    const roleRes = await fetch(`${baseUrl}/api/v1/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'PARTICIPANT' })
    });
    assert.strictEqual(roleRes.status, 200);
    assert.strictEqual(daemon.currentRole, 'PARTICIPANT');

    // 3. Unauthorized Triage Override Attempt by Participant -> MUST RETURN 403 FORBIDDEN
    const unauthTriageRes = await fetch(`${baseUrl}/api/v1/patients/${patientDoc.patientId}/triage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'RED', overrideReason: 'Participant trying to override' })
    });
    assert.strictEqual(unauthTriageRes.status, 403, 'Participant role must be rejected from overriding triage');
    const unauthData = await unauthTriageRes.json();
    assert.strictEqual(unauthData.authorizationFailed, true);

    // Verify audit trail logged the AUTHORIZATION_FAILED event
    const auditEvents = daemon.db.getAuditTrail(patientDoc.patientId);
    assert.ok(auditEvents.some((e: any) => e.action_type === 'AUTHORIZATION_FAILED'));

    // 4. Switch role back to MEDICAL_RESPONDER -> Now triage succeeds
    await fetch(`${baseUrl}/api/v1/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'MEDICAL_RESPONDER' })
    });
    assert.strictEqual(daemon.currentRole, 'MEDICAL_RESPONDER');

    const authTriageRes = await fetch(`${baseUrl}/api/v1/patients/${patientDoc.patientId}/triage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'YELLOW' })
    });
    assert.strictEqual(authTriageRes.status, 200);

    // 5. Operation finalization & archiving (Requires COORDINATOR)
    await fetch(`${baseUrl}/api/v1/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'COORDINATOR' })
    });

    const finalizeRes = await fetch(`${baseUrl}/api/v1/operations/OP_FLOOD_RELIEF_2026/finalize`, {
      method: 'POST'
    });
    assert.strictEqual(finalizeRes.status, 200);

    const archiveRes = await fetch(`${baseUrl}/api/v1/operations/OP_FLOOD_RELIEF_2026/archive`, {
      method: 'POST'
    });
    assert.strictEqual(archiveRes.status, 200);
    const archiveData = await archiveRes.json();
    assert.strictEqual(archiveData.success, true);
    assert.ok(archiveData.archiveInfo.archiveDigest);
  } finally {
    server.close();
    daemon.db.close();
  }
});

test('Backend Service Daemon: Offline Whisper Audio Intake via HTTP API', async () => {
  const testDb = `:memory:`;
  const daemon = new PeerScribeDaemon({
    dbPath: testDb,
    nodeId: 'node_whisper_test',
    operationId: 'OP_WHISPER_AUDIO',
    initialMode: 'FIELD',
    initialRole: 'MEDICAL_RESPONDER'
  });
  const server = createPeerScribeServer(daemon);
  const port = 4920;
  await server.listen(port);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Create a patient to receive audio triage
    const patientDoc = daemon.createPatient();

    // 2. Synthesize audio buffer with clinical speech
    const whisperEngine = new (daemon as any).whisperEngine.constructor();
    const speech = 'Adult male, spontaneous breathing, respiration rate 36, absent radial pulse, altered mental status';
    const audioSamples = whisperEngine.createTestAudioBuffer(speech, 2.0);
    
    // Convert Float32Array to 16-bit PCM Buffer
    const pcmBuf = Buffer.alloc(audioSamples.length * 2);
    for (let i = 0; i < audioSamples.length; i++) {
      const s = Math.max(-1, Math.min(1, audioSamples[i]));
      pcmBuf.writeInt16LE(Math.floor(s < 0 ? s * 0x8000 : s * 0x7FFF), i * 2);
    }

    // 3. Post audio as base64 JSON payload
    const res = await fetch(`${baseUrl}/api/v1/ai/transcribe-audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioBase64: pcmBuf.toString('base64'),
        patientId: patientDoc.patientId
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.whisper);
    assert.strictEqual(data.whisper.isOffline, true);
    assert.ok(data.whisper.confidence >= 0.75);
    assert.ok(data.triageResult);
    assert.strictEqual(data.triageResult.category, 'RED');

    // 4. Verify patient document in database was updated with RED triage
    const updated = daemon.db.getPatientDocument(patientDoc.patientId);
    assert.ok(updated);
    const triageEntries = updated.triageEvaluations || [];
    assert.ok(triageEntries.some((t: any) => t.category === 'RED'));
  } finally {
    server.close();
    daemon.db.close();
  }
});
