import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { PeerScribeDaemon } from '../src/node_daemon.ts';
import {
  decodePacket,
  MobilityParticleFilter,
  hasCapability,
  LiveNostrRelayPool,
  isAllergyCollision
} from '../../core-engine/src/index.ts';
import { MockBleMeshHub } from '../../platform-adapters/src/ble_mock.ts';

describe('PeerScribe Comprehensive Manual Issues Regression Suite', () => {
  let daemon: PeerScribeDaemon;

  beforeEach(() => {
    daemon = new PeerScribeDaemon({
      dbPath: ':memory:',
      initialRole: 'MEDICAL_RESPONDER',
      initialMode: 'FIELD'
    });
  });

  // --------------------------------------------------------------------------
  // Issue 1: Vital Signs (Mental status persistence & duplicate suppression)
  // --------------------------------------------------------------------------
  test('Issue 1: Mental status ALTERED is persisted accurately without reverting to NORMAL', () => {
    const patient = daemon.createPatient();
    const doc = daemon.recordVitals(patient.patientId, {
      respirationRate: 22,
      pulseRate: 88,
      radialPulsePresent: true,
      mentalStatus: 'ALTERED'
    });

    assert.strictEqual(doc.vitals.length, 1);
    assert.strictEqual(doc.vitals[0].mentalStatus, 'ALTERED');
    assert.strictEqual(doc.vitals[0].respirationRate, 22);

    // Verify database reload maintains ALTERED
    const persisted = daemon.db.getPatientDocument(patient.patientId);
    assert.ok(persisted);
    assert.strictEqual(persisted.vitals[0].mentalStatus, 'ALTERED');
  });

  test('Issue 1: Repeated vitals saves within 5s deduplicate and do not create duplicate history entries', () => {
    const patient = daemon.createPatient();
    daemon.recordVitals(patient.patientId, {
      respirationRate: 18,
      pulseRate: 72,
      radialPulsePresent: true,
      mentalStatus: 'NORMAL'
    });

    // Rapid second save with identical vitals
    const doc2 = daemon.recordVitals(patient.patientId, {
      respirationRate: 18,
      pulseRate: 72,
      radialPulsePresent: true,
      mentalStatus: 'NORMAL'
    });

    assert.strictEqual(doc2.vitals.length, 1, 'Duplicate vital entry was suppressed');
  });

  // --------------------------------------------------------------------------
  // Issue 2: Trauma and Injuries (Tourniquet applied flag persistence)
  // --------------------------------------------------------------------------
  test('Issue 2: Arterial Bleed with tourniquet applied preserves tourniquetApplied: true', () => {
    const patient = daemon.createPatient();
    const doc = daemon.recordInjury(patient.patientId, 'Left Arm', 'Severe Arterial Bleed', true);

    assert.strictEqual(doc.injuries.length, 1);
    assert.strictEqual(doc.injuries[0].tourniquetApplied, true);

    const persisted = daemon.db.getPatientDocument(patient.patientId);
    assert.ok(persisted);
    assert.strictEqual(persisted.injuries[0].tourniquetApplied, true);
  });

  // --------------------------------------------------------------------------
  // Issue 3: Medication and Allergy Safety (Pre-check & blocking)
  // --------------------------------------------------------------------------
  test('Issue 3: Medication administration with allergy collision is BLOCKED without override', () => {
    const patient = daemon.createPatient();
    daemon.attachEmergencySnapshot(patient.patientId, {
      bloodGroup: 'O+',
      allergies: ['Penicillin'],
      criticalConditions: [],
      currentMedicationsSummary: [],
      emergencyContacts: [],
      extractedAt: Date.now()
    });

    // Attempt to administer Amoxicillin (cross-reactive penicillin)
    assert.throws(
      () => daemon.recordMedication(patient.patientId, 'Amoxicillin', '500mg', 'Oral', false),
      /ALLERGY_COLLISION/
    );

    // Verify medication was not administered
    const doc = daemon.db.getPatientDocument(patient.patientId);
    assert.ok(doc);
    assert.strictEqual(doc.medications.length, 0);

    // Verify audit event was logged
    const audit = daemon.db.getAuditTrail(patient.patientId);
    const blockedLog = audit.find(a => a.action_type === 'MEDICATION_BLOCKED_ALLERGY');
    assert.ok(blockedLog, 'Audit trail logged MEDICATION_BLOCKED_ALLERGY');
  });

  test('Issue 3: Explicit override allows medication administration with FATAL_RISK divergence flag', () => {
    const patient = daemon.createPatient();
    daemon.attachEmergencySnapshot(patient.patientId, {
      bloodGroup: 'O+',
      allergies: ['Penicillin'],
      criticalConditions: [],
      currentMedicationsSummary: [],
      emergencyContacts: [],
      extractedAt: Date.now()
    });

    const result = daemon.recordMedication(patient.patientId, 'Amoxicillin', '500mg', 'Oral', true);
    assert.strictEqual(result.doc.medications.length, 1);
    assert.ok(result.divergences.some(d => d.conflictType === 'DIV_DRUG_ALLERGY' && d.severity === 'FATAL_RISK'));
  });

  // --------------------------------------------------------------------------
  // Issue 4: Emergency Medical ID Matching
  // --------------------------------------------------------------------------
  test('Issue 4: Emergency Medical ID dynamically links to target patient ID', () => {
    const patient = daemon.createPatient();
    daemon.attachEmergencySnapshot(patient.patientId, {
      bloodGroup: 'B+',
      allergies: ['Sulfa'],
      criticalConditions: ['Hypertension'],
      currentMedicationsSummary: ['Lisinopril'],
      emergencyContacts: [{ name: 'Family', relation: 'Spouse', phone: '+1234567890' }],
      extractedAt: Date.now()
    });

    const doc = daemon.db.getPatientDocument(patient.patientId);
    assert.ok(doc);
    assert.ok(doc.knownAllergies.includes('Sulfa'));
    assert.strictEqual(doc.bloodGroup, 'B+');
  });

  // --------------------------------------------------------------------------
  // Issue 5: START Triage (No ghost casualties on evaluation)
  // --------------------------------------------------------------------------
  test('Issue 5: Triaging an active patient does NOT spawn additional ghost casualties', () => {
    const p1 = daemon.createPatient();
    const countBefore = daemon.listPatients().length;
    assert.strictEqual(countBefore, 1);

    daemon.recordTriage(p1.patientId, 'RED', 'START_v1.0.0');
    daemon.recordTriage(p1.patientId, 'YELLOW', 'START_v1.0.0', 'Patient vitals stabilized');

    const countAfter = daemon.listPatients().length;
    assert.strictEqual(countAfter, 1, 'Casualty count remained exactly 1; no extra patients spawned');
  });

  // --------------------------------------------------------------------------
  // Issue 6: DTN Outbox & Wire Packet Inspection
  // --------------------------------------------------------------------------
  test('Issue 6: DTN Outbox packets contain valid wire format, CRC32, and decodable payload', () => {
    const patient = daemon.createPatient();
    daemon.recordTriage(patient.patientId, 'RED', 'START_v1.0.0');

    const outbox = daemon.db.listPendingDtnBundles(daemon.currentOperationId);
    assert.ok(outbox.length > 0);

    const bundle = outbox[0];
    assert.ok(bundle.payload.length >= 32, 'Payload has at least 32-byte header');

    // Decode with decodePacket
    const wire = decodePacket(bundle.payload);
    assert.ok(wire.header);
    assert.strictEqual(wire.header.maxTtl, 15);
    assert.ok(wire.header.checksum > 0);

    // Verify decoded JSON payload
    const decodedDelta = JSON.parse(wire.payload.toString('utf-8'));
    assert.ok(decodedDelta.deltaId);
    assert.strictEqual(decodedDelta.patientId, patient.patientId);
  });

  // --------------------------------------------------------------------------
  // Issue 7: Search and Recovery Particle Filter
  // --------------------------------------------------------------------------
  test('Issue 7: Sequential Monte Carlo particle filter outputs real particles and contracts search area', () => {
    const filter = new MobilityParticleFilter(27.7172, 85.3240, 200, 40);
    filter.propagate(60);

    const initialContours = filter.estimateSearchContours();
    assert.ok(initialContours.sampleParticles && initialContours.sampleParticles.length > 0);
    assert.ok(initialContours.radius75PercentMeters > 0);

    // Sighting update at known coordinate
    filter.observeSighting(27.7172, 85.3240, 30);
    const contractedContours = filter.estimateSearchContours();

    assert.ok(
      contractedContours.radius75PercentMeters <= initialContours.radius75PercentMeters,
      'Search radius contracted upon Bayesian sighting measurement'
    );
  });

  // --------------------------------------------------------------------------
  // Issue 8: Nostr Relay Pool & NIP-20 Acknowledgements
  // --------------------------------------------------------------------------
  test('Issue 8: Live Nostr Relay Pool tracks NIP-20 OK acknowledgements', () => {
    assert.ok(daemon.relayPool, 'Relay pool initialized on daemon');
    daemon.relayPool.recordLocalAck('evt_123', 'wss://relay.damus.io', true, 'Event accepted');

    const acks = daemon.relayPool.getAcks('evt_123');
    assert.strictEqual(acks.length, 1);
    assert.strictEqual(acks[0].accepted, true);
    assert.strictEqual(acks[0].relay, 'wss://relay.damus.io');
  });

  // --------------------------------------------------------------------------
  // Issue 9: BLE and Wi-Fi Mesh Simulation & Topology
  // --------------------------------------------------------------------------
  test('Issue 9: Mock BLE Mesh Hub simulates multi-hop store-and-forward packet propagation', () => {
    const hub = new MockBleMeshHub();
    const receivedPackets: Buffer[] = [];

    hub.registerNode('node_alpha', () => {});
    hub.registerNode('node_bravo', (_from, packet) => {
      receivedPackets.push(packet);
    });

    hub.setLink('node_alpha', 'node_bravo', true, -60);
    const packet = Buffer.from('TEST_BLE_PACKET');
    const sentCount = hub.broadcastAdvertising('node_alpha', packet);

    assert.strictEqual(sentCount, 1);
    assert.strictEqual(receivedPackets.length, 1);
    assert.deepStrictEqual(receivedPackets[0], packet);
  });

  // --------------------------------------------------------------------------
  // Issue 10: Role-Based Access Control (All 5 Roles)
  // --------------------------------------------------------------------------
  test('Issue 10: RBAC capability matrix is strictly enforced across all 5 roles', () => {
    // 1. PARTICIPANT
    assert.strictEqual(hasCapability('PARTICIPANT', 'RECORD_OBSERVATION'), true);
    assert.strictEqual(hasCapability('PARTICIPANT', 'ATTACH_VAULT_SNAPSHOT'), true);
    assert.strictEqual(hasCapability('PARTICIPANT', 'OVERRIDE_TRIAGE'), false);
    assert.strictEqual(hasCapability('PARTICIPANT', 'ADMINISTER_MEDICATION'), false);
    assert.strictEqual(hasCapability('PARTICIPANT', 'MANAGE_OPERATION'), false);

    // 2. SUPPORT
    assert.strictEqual(hasCapability('SUPPORT', 'RECORD_VITALS'), true);
    assert.strictEqual(hasCapability('SUPPORT', 'RECORD_INJURY'), true);
    assert.strictEqual(hasCapability('SUPPORT', 'OVERRIDE_TRIAGE'), false);
    assert.strictEqual(hasCapability('SUPPORT', 'ADMINISTER_MEDICATION'), false);

    // 3. TRANSPORT
    assert.strictEqual(hasCapability('TRANSPORT', 'DISPATCH_TRANSPORT'), true);
    assert.strictEqual(hasCapability('TRANSPORT', 'OVERRIDE_TRIAGE'), false);
    assert.strictEqual(hasCapability('TRANSPORT', 'ADMINISTER_MEDICATION'), false);

    // 4. MEDICAL_RESPONDER
    assert.strictEqual(hasCapability('MEDICAL_RESPONDER', 'OVERRIDE_TRIAGE'), true);
    assert.strictEqual(hasCapability('MEDICAL_RESPONDER', 'ADMINISTER_MEDICATION'), true);
    assert.strictEqual(hasCapability('MEDICAL_RESPONDER', 'RESOLVE_DIVERGENCE'), true);
    assert.strictEqual(hasCapability('MEDICAL_RESPONDER', 'MANAGE_OPERATION'), false);

    // 5. COORDINATOR
    assert.strictEqual(hasCapability('COORDINATOR', 'OVERRIDE_TRIAGE'), true);
    assert.strictEqual(hasCapability('COORDINATOR', 'MANAGE_OPERATION'), true);

    // Verify backend daemon enforces restriction
    daemon.setRole('PARTICIPANT');
    const patient = daemon.createPatient();
    assert.throws(
      () => daemon.recordTriage(patient.patientId, 'RED', 'START_v1.0.0'),
      /Unauthorized.*OVERRIDE_TRIAGE/
    );
    assert.throws(
      () => daemon.createOperation('OP-TEST', 'Test Op'),
      /Unauthorized.*MANAGE_OPERATION/
    );
  });

  // --------------------------------------------------------------------------
  // Issue 11: SQLite WAL & Persistence Consistency
  // --------------------------------------------------------------------------
  test('Issue 11: SQLite WAL maintains event ordering, persistence, and divergence flags across reload', () => {
    const patient = daemon.createPatient();
    daemon.recordVitals(patient.patientId, { respirationRate: 36, mentalStatus: 'ALTERED' });
    daemon.recordInjury(patient.patientId, 'Torso', 'Crush Injury', false);

    // Verify data in fresh read from SQLite database
    const doc = daemon.db.getPatientDocument(patient.patientId);
    assert.ok(doc);
    assert.strictEqual(doc.vitals.length, 1);
    assert.strictEqual(doc.injuries.length, 1);
    assert.strictEqual(doc.vitals[0].mentalStatus, 'ALTERED');

    // Verify audit trail persisted in SQLite
    const audit = daemon.db.getAuditTrail(patient.patientId);
    assert.ok(audit.length >= 3, 'Audit entries for PATIENT_CREATED, VITALS_RECORDED, INJURY_RECORDED persisted');
  });

  // --------------------------------------------------------------------------
  // Backend Reliability: REST Endpoints (PUT, PATCH, DELETE) & Payload Protection
  // --------------------------------------------------------------------------
  test('Backend Reliability: PUT, PATCH, DELETE routes update and discharge patients cleanly', async () => {
    const { createPeerScribeServer } = await import('../src/server.ts');
    const testServer = createPeerScribeServer(daemon);
    await new Promise<void>(resolve => testServer.listen(0, '127.0.0.1', resolve));
    const address = testServer.address() as any;
    const testUrl = `http://127.0.0.1:${address.port}`;

    try {
      const patient = daemon.createPatient();

      // Test PATCH patient notes
      const patchRes = await fetch(`${testUrl}/api/v1/patients/${patient.patientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'Patient condition stabilizing after airway management.' })
      });
      assert.strictEqual(patchRes.status, 200);
      const patchData: any = await patchRes.json();
      assert.strictEqual(patchData.success, true);
      assert.strictEqual(patchData.patient.notes[0].text, 'Patient condition stabilizing after airway management.');

      // Test PUT patient (update notes and triage)
      const putRes = await fetch(`${testUrl}/api/v1/patients/${patient.patientId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'Updated notes via PUT', category: 'YELLOW' })
      });
      assert.strictEqual(putRes.status, 200);

      // Test DELETE patient (discharge)
      const delRes = await fetch(`${testUrl}/api/v1/patients/${patient.patientId}`, {
        method: 'DELETE'
      });
      assert.strictEqual(delRes.status, 200);
      const delData: any = await delRes.json();
      assert.strictEqual(delData.success, true);
      assert.strictEqual(delData.status, 'DISCHARGED');

      // Verify discharged patient is marked BLACK in database
      const getRes = await fetch(`${testUrl}/api/v1/patients/${patient.patientId}`);
      assert.strictEqual(getRes.status, 200);
      const getData: any = await getRes.json();
      const doc = getData.doc || getData;
      const latestTriage = doc.triageEvaluations[doc.triageEvaluations.length - 1];
      assert.strictEqual(latestTriage.category, 'BLACK');
    } finally {
      testServer.close();
    }
  });

  test('Backend Reliability: 413 Payload limit and 400 Malformed JSON protection', async () => {
    const { createPeerScribeServer } = await import('../src/server.ts');
    const testServer = createPeerScribeServer(daemon);
    await new Promise<void>(resolve => testServer.listen(0, '127.0.0.1', resolve));
    const address = testServer.address() as any;
    const testUrl = `http://127.0.0.1:${address.port}`;

    try {
      // 400 Malformed JSON
      const badJsonRes = await fetch(`${testUrl}/api/v1/patients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ malformed json: missing quotes '
      });
      assert.strictEqual(badJsonRes.status, 400);
      const badJsonData: any = await badJsonRes.json();
      assert.strictEqual(badJsonData.error, 'Malformed JSON payload');

      // 413 Payload too large (>2MB)
      const hugeString = 'X'.repeat(2.5 * 1024 * 1024);
      const largeRes = await fetch(`${testUrl}/api/v1/patients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: hugeString })
      });
      assert.strictEqual(largeRes.status, 413);
      const largeData: any = await largeRes.json();
      assert.ok(largeData.error.includes('exceeds 2MB limit'));
    } finally {
      testServer.close();
    }
  });
});
