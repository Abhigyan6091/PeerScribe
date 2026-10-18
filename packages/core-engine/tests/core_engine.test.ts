import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateIdentityKeyPair,
  sign,
  verify,
  crc32,
  generateEphemeralId,
  parseScannablePayload,
  encryptProfile,
  decryptProfile,
  extractEmergencySnapshot,
  incrementClock,
  mergeClocks,
  compareClocks,
  createPatientDocument,
  recordTriageEvaluation,
  recordVitals,
  recordMedication,
  applyDelta,
  mergePatientDocuments,
  getActiveTriageCategory,
  encodePacket,
  decodePacket,
  PacketType,
  PacketFlags,
  lz4Compress,
  lz4Decompress,
  fragmentPayload,
  StreamReassembler,
  evaluateAdultStartTriage,
  evaluateJumpStartTriage,
  analyzeSemanticSafety,
  applyDivergenceAnalysis,
  resolveDivergence,
  EmergencyWipeService
} from '../src/index.ts';

test('Identity & Cryptography: Ed25519 signing and verification', () => {
  const keys = generateIdentityKeyPair();
  assert.ok(keys.publicKey.length > 0);
  assert.ok(keys.privateKey.length > 0);

  const message = 'PEERSCRIBE_CRITICAL_OBSERVATION:RED-FALCON-04';
  const signature = sign(keys.privateKey, message);
  assert.ok(signature.length > 0);

  const isValid = verify(keys.publicKey, message, signature);
  assert.equal(isValid, true);

  const isTamperedValid = verify(keys.publicKey, message + '_TAMPERED', signature);
  assert.equal(isTamperedValid, false);
});

test('Identity: Ephemeral Operational ID & Identicon generation', () => {
  const opId = 'op_himalayan_quake';
  const ptId = 'pt_uuid_001';
  const id1 = generateEphemeralId(opId, ptId, 'RED', 4);

  assert.equal(id1.ephemeralId, 'RED-PANTHER-04');
  assert.ok(id1.visualHash.includes('<svg'));
  assert.ok(id1.visualHash.includes('viewBox="0 0 64 64"'));

  const parsed = parseScannablePayload(id1.scannablePayload);
  assert.deepEqual(parsed, {
    operationId: opId,
    patientId: ptId,
    ephemeralId: 'RED-PANTHER-04'
  });
});

test('Personal Vault: AES-256-GCM encryption and Emergency Snapshot', () => {
  const profile = {
    citizenId: 'cit_12345',
    fullName: 'Jane Doe',
    bloodGroup: 'O+' as const,
    allergies: ['Penicillin', 'Peanuts'],
    chronicConditions: ['Type 1 Diabetes'],
    currentMedications: [
      { name: 'Insulin Glargine', dosage: '20 units' }
    ],
    emergencyContacts: [
      { name: 'John Doe', relation: 'Spouse', phone: '+1234567890' }
    ],
    updatedAt: Date.now()
  };

  const passphrase = 'disaster-safe-key-passphrase-2026';
  const encrypted = encryptProfile(profile, passphrase);
  assert.ok(encrypted.cipherTextHex.length > 0);
  assert.ok(encrypted.authTagHex.length > 0);

  const decrypted = decryptProfile(encrypted, passphrase);
  assert.deepEqual(decrypted, profile);

  const snapshot = extractEmergencySnapshot(profile);
  assert.equal(snapshot.bloodGroup, 'O+');
  assert.deepEqual(snapshot.allergies, ['Penicillin', 'Peanuts']);
  assert.deepEqual(snapshot.criticalConditions, ['Type 1 Diabetes']);
  assert.equal(snapshot.currentMedicationsSummary[0], 'Insulin Glargine 20 units');
  assert.equal((snapshot as any).fullName, undefined);
});

test('CRDT: Vector Clocks and causal relationship', () => {
  let c1 = { nodeA: 1, nodeB: 2 };
  let c2 = { nodeA: 1, nodeB: 3 };

  assert.equal(compareClocks(c1, c2), 'ANCESTOR'); // c1 is behind c2
  assert.equal(compareClocks(c2, c1), 'DESCENDANT'); // c2 is ahead of c1

  let c3 = { nodeA: 2, nodeB: 1 };
  assert.equal(compareClocks(c1, c3), 'CONCURRENT'); // Concurrent divergence

  const merged = mergeClocks(c2, c3);
  assert.deepEqual(merged, { nodeA: 2, nodeB: 3 });
});

test('CRDT: Disconnected replicas concurrent updates and deterministic merge', () => {
  const patientId = 'pt_quake_99';
  const opId = 'op_quake_2026';
  const ephemeralId = 'YELLOW-OTTER-12';

  // Base document initialized by Medic A
  const baseDoc = createPatientDocument(patientId, opId, ephemeralId, 'medic_A');

  // Disconnected partition: Medic A records vitals and sets triage to YELLOW
  const stepA1 = recordVitals(baseDoc, 'medic_A', {
    respirationRate: 22,
    radialPulsePresent: true,
    mentalStatus: 'NORMAL'
  });
  const stepA2 = recordTriageEvaluation(stepA1.updatedDoc, 'medic_A', 'YELLOW', 'START_ADULT_v1.0');
  const replicaA = stepA2.updatedDoc;

  // Disconnected partition: Medic B encounters same patient, records an injury and sets triage to RED
  const stepB1 = recordTriageEvaluation(baseDoc, 'medic_B', 'RED', 'START_ADULT_v1.0', 'Severe hemorrhage observed');
  const replicaB = stepB1.updatedDoc;

  // Network link restored: Merge replicas
  const mergedDoc = mergePatientDocuments(replicaA, replicaB);

  // Both evaluations must be preserved (multi-value state) - NO SILENT OVERWRITE!
  assert.equal(mergedDoc.triageEvaluations.length, 2);
  assert.equal(mergedDoc.vitals.length, 1);
  assert.equal(mergedDoc.vitals[0].respirationRate, 22);

  // Active triage category must default to RED (most acute) for safety
  const activeTriage = getActiveTriageCategory(mergedDoc);
  assert.equal(activeTriage, 'RED');

  // Causal vector clock reflects both replicas
  assert.equal(mergedDoc.vectorClock.medic_A, 3);
  assert.equal(mergedDoc.vectorClock.medic_B, 1);
});

test('BitChat Wire Protocol: Binary packet encoding, LZ4 compression and CRC32 verification', () => {
  const rawPayload = Buffer.from('DISASTER_OBSERVATION_DATA:'.repeat(20)); // > 100 bytes to trigger compression
  const packet = encodePacket(PacketType.CRDT_SYNC_BUNDLE, rawPayload, {
    hopCount: 1,
    maxTtl: 10,
    sequenceNumber: 42,
    geohash: 'u15ek200',
    senderPubkeyHash: '0123456789abcdef'
  });

  // Verify header size is exactly 32 bytes
  assert.ok(packet.length > 32);

  const decoded = decodePacket(packet);
  assert.equal(decoded.header.type, PacketType.CRDT_SYNC_BUNDLE);
  assert.equal(decoded.header.hopCount, 1);
  assert.equal(decoded.header.maxTtl, 10);
  assert.equal(decoded.header.sequenceNumber, 42);
  assert.equal(decoded.header.geohash, 'u15ek200');
  assert.equal(decoded.header.senderPubkeyHash, '0123456789abcdef');
  assert.ok((decoded.header.flags & PacketFlags.LZ4_COMPRESSED) !== 0);

  // Uncompress payload and verify equality
  const decompressed = lz4Decompress(decoded.payload, rawPayload.length);
  assert.deepEqual(decompressed, rawPayload);
});

test('BitChat Wire Protocol: MTU chunking and stream reassembly', () => {
  const largeData = Buffer.from('CHUNK_TEST_PAYLOAD_'.repeat(30)); // 570 bytes
  const streamId = 'stream_ble_001';
  const chunks = fragmentPayload(streamId, largeData, 128); // 128 bytes max per BLE packet

  assert.equal(chunks.length, 5); // 5 chunks

  const reassembler = new StreamReassembler();
  let result: Buffer | null = null;

  // Ingest chunks out-of-order (simulating radio packet reordering)
  result = reassembler.ingestChunk(chunks[2]);
  assert.equal(result, null);
  result = reassembler.ingestChunk(chunks[0]);
  assert.equal(result, null);
  result = reassembler.ingestChunk(chunks[4]);
  assert.equal(result, null);
  result = reassembler.ingestChunk(chunks[1]);
  assert.equal(result, null);
  result = reassembler.ingestChunk(chunks[3]); // Final chunk arrives

  assert.ok(result !== null);
  assert.deepEqual(result, largeData);
});

test('Clinical Engine: Deterministic START triage rule decision tree', () => {
  // Walking patient -> GREEN
  const r1 = evaluateAdultStartTriage({ canWalk: true, isBreathingSpontaneous: true });
  assert.equal(r1.category, 'GREEN');

  // Apneic, breathing restored on airway open -> RED
  const r2 = evaluateAdultStartTriage({ canWalk: false, isBreathingSpontaneous: false, breathingAfterAirwayOpen: true });
  assert.equal(r2.category, 'RED');

  // Apneic, airway open still not breathing -> BLACK
  const r3 = evaluateAdultStartTriage({ canWalk: false, isBreathingSpontaneous: false, breathingAfterAirwayOpen: false });
  assert.equal(r3.category, 'BLACK');

  // Breathing fast (34/min) -> RED
  const r4 = evaluateAdultStartTriage({ canWalk: false, isBreathingSpontaneous: true, respirationRate: 34 });
  assert.equal(r4.category, 'RED');

  // Respiration normal (18), but absent radial pulse -> RED
  const r5 = evaluateAdultStartTriage({ canWalk: false, isBreathingSpontaneous: true, respirationRate: 18, radialPulsePresent: false });
  assert.equal(r5.category, 'RED');

  // Normal vitals, follows commands -> YELLOW
  const r6 = evaluateAdultStartTriage({
    canWalk: false,
    isBreathingSpontaneous: true,
    respirationRate: 18,
    radialPulsePresent: true,
    capillaryRefillSeconds: 1.5,
    mentalStatus: 'NORMAL'
  });
  assert.equal(r6.category, 'YELLOW');
});

test('Clinical Safety: Level 2 Semantic Safety Analyzer detects divergence & drug-allergy collision', () => {
  let doc = createPatientDocument('pt_collision_01', 'op_quake', 'RED-BEAR-07', 'medic_A');
  doc.knownAllergies = ['Penicillin'];

  // Record Penicillin administration
  const medStep = recordMedication(doc, 'medic_A', {
    drugName: 'Amoxicillin',
    dosage: '500mg',
    route: 'Oral',
    medicSignature: 'sig_medic_a'
  });
  doc = medStep.updatedDoc;

  // Add conflicting triage evaluations
  doc.triageEvaluations.push({
    id: 'tri_1',
    category: 'RED',
    protocol: 'START',
    evaluatedByNode: 'medic_A',
    timestamp: Date.now() - 1000,
    logicalClock: 2
  });
  doc.triageEvaluations.push({
    id: 'tri_2',
    category: 'YELLOW',
    protocol: 'START',
    evaluatedByNode: 'medic_B',
    timestamp: Date.now() - 500,
    logicalClock: 3
  });

  // Run Semantic Safety Analyzer
  const docWithFlags = applyDivergenceAnalysis(doc);
  assert.equal(docWithFlags.divergenceFlags.length, 2);

  const allergyFlag = docWithFlags.divergenceFlags.find(f => f.conflictType === 'DIV_DRUG_ALLERGY');
  assert.ok(allergyFlag);
  assert.equal(allergyFlag.severity, 'FATAL_RISK');

  const triageFlag = docWithFlags.divergenceFlags.find(f => f.conflictType === 'DIV_TRIAGE_DELTA');
  assert.ok(triageFlag);
  assert.equal(triageFlag.severity, 'CRITICAL');

  // Authorized clinician resolves triage divergence to RED
  const resolvedDoc = resolveDivergence(
    docWithFlags,
    triageFlag.id,
    'coordinator_dr_smith',
    'Confirmed patient had tension pneumothorax, maintaining RED',
    'RED'
  );

  const updatedTriageFlag = resolvedDoc.divergenceFlags.find(f => f.id === triageFlag.id);
  assert.equal(updatedTriageFlag?.resolved, true);
  assert.equal(updatedTriageFlag?.resolvedBy, 'coordinator_dr_smith');
});

test('Security: Emergency Wipe zeroization service', () => {
  const wipeService = new EmergencyWipeService();
  const sensitiveBuffer = Buffer.from('CONFIDENTIAL_MEDIC_PRIVATE_KEY_DATA');
  wipeService.registerKeyBuffer(sensitiveBuffer);

  let cachePurged = false;
  wipeService.registerTarget({
    name: 'PatientCache',
    wipe: () => { cachePurged = true; }
  });

  const receipt = wipeService.executeEmergencyWipe();
  assert.equal(receipt.success, true);
  assert.equal(receipt.entropyPasses, 3);
  assert.equal(cachePurged, true);

  // Verify memory buffer was zeroized (all 0s)
  const isAllZeroes = sensitiveBuffer.every(byte => byte === 0);
  assert.equal(isAllZeroes, true);
});
