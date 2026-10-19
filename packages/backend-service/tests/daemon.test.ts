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

    // 6. GET /api/v1/patients
    const listRes = await fetch(`${baseUrl}/api/v1/patients`);
    assert.strictEqual(listRes.status, 200);
    const listData = await listRes.json() as any;
    assert.strictEqual(listData.length, 1);
    assert.strictEqual(listData[0].activeTriage, 'YELLOW');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
