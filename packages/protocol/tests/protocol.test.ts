import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateEvent,
  validateSyncBundle,
  projectPatientState
} from '../src/index.ts';
import type {
  PeerScribeEvent,
  PeerScribeSyncBundle
} from '../src/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesPath = path.resolve(__dirname, '../fixtures/sample_events.json');

describe('PeerScribe Shared Protocol Specification', () => {
  const sampleEvents: PeerScribeEvent[] = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

  it('successfully validates all golden sample events from fixture', () => {
    assert.ok(sampleEvents.length >= 8, 'Should have at least 8 golden sample events');
    for (const evt of sampleEvents) {
      const result = validateEvent(evt);
      assert.strictEqual(
        result.valid,
        true,
        `Event ${evt.event_id} failed validation: ${result.errors.join(', ')}`
      );
      assert.strictEqual(result.errors.length, 0);
    }
  });

  it('rejects events missing mandatory fields or having invalid schema_version', () => {
    // Unsupported schema version
    const badVersion = { ...sampleEvents[0], schema_version: 2 };
    const res1 = validateEvent(badVersion);
    assert.strictEqual(res1.valid, false);
    assert.ok(res1.errors.some(e => e.includes('Unsupported schema_version')));

    // Missing event_id
    const missingId = { ...sampleEvents[0], event_id: '' };
    const res2 = validateEvent(missingId);
    assert.strictEqual(res2.valid, false);
    assert.ok(res2.errors.some(e => e.includes('event_id is required')));

    // Invalid event_type
    const invalidType = { ...sampleEvents[0], event_type: 'NON_EXISTENT_TYPE' };
    const res3 = validateEvent(invalidType);
    assert.strictEqual(res3.valid, false);
    assert.ok(res3.errors.some(e => e.includes('Unknown event_type')));

    // Non-positive sequence
    const badSeq = { ...sampleEvents[0], actor_sequence: 0 };
    const res4 = validateEvent(badSeq);
    assert.strictEqual(res4.valid, false);
    assert.ok(res4.errors.some(e => e.includes('actor_sequence must be a positive integer')));

    // Invalid ISO timestamp
    const badDate = { ...sampleEvents[0], occurred_at_utc: 'not-a-date' };
    const res5 = validateEvent(badDate);
    assert.strictEqual(res5.valid, false);
    assert.ok(res5.errors.some(e => e.includes('occurred_at_utc must be a valid ISO-8601')));
  });

  it('validates a well-formed SyncBundle and rejects corrupted bundles', () => {
    const validBundle: PeerScribeSyncBundle = {
      schema_version: 1,
      bundle_id: 'bundle_test_001',
      operation_id: 'OP_2026_KATHMANDU_QUAKE',
      origin_node_id: 'node_alpha',
      priority: 'CRITICAL_SOS',
      hop_count: 0,
      max_hops: 5,
      created_at_utc: new Date().toISOString(),
      vector_clock: { node_alpha: 3 },
      events: [sampleEvents[0], sampleEvents[1]]
    };

    const validRes = validateSyncBundle(validBundle);
    assert.strictEqual(validRes.valid, true);

    const corruptBundle = {
      ...validBundle,
      events: [sampleEvents[0], { ...sampleEvents[1], schema_version: 99 }]
    };
    const corruptRes = validateSyncBundle(corruptBundle);
    assert.strictEqual(corruptRes.valid, false);
    assert.ok(corruptRes.errors.some(e => e.includes('Event at index 1 invalid')));
  });

  it('deterministically projects patient state from the sample events stream', () => {
    const projected = projectPatientState(sampleEvents);
    assert.ok(projected !== null);
    assert.strictEqual(projected.patient_id, 'pt_uuid_001');
    assert.strictEqual(projected.operation_id, 'OP_2026_KATHMANDU_QUAKE');
    assert.strictEqual(projected.ephemeral_id, 'RED-FALCON-04');
    // Active triage after divergence resolution should be RED
    assert.strictEqual(projected.active_triage, 'RED');

    // Vitals recorded
    assert.strictEqual(projected.vitals.length, 1);
    assert.strictEqual(projected.vitals[0].respiration_rate, 34);

    // Injuries recorded
    assert.strictEqual(projected.injuries.length, 1);
    assert.strictEqual(projected.injuries[0].anatomical_location, 'RIGHT_FEMUR');

    // Medications recorded
    assert.strictEqual(projected.medications.length, 1);
    assert.strictEqual(projected.medications[0].drug_name, 'Morphine Sulfate');

    // Known allergies imported from snapshot
    assert.ok(projected.known_allergies.includes('Penicillin'));
    assert.ok(projected.known_allergies.includes('Sulfa'));

    // Divergence resolved status
    assert.strictEqual(projected.divergence_flags.length, 1);
    assert.strictEqual(projected.divergence_flags[0].resolved, true);
    assert.strictEqual(projected.divergence_flags[0].resolved_by, 'node_desktop_alpha');
  });

  it('guarantees idempotency and out-of-order commutativity in projection', () => {
    // Shuffle the events
    const shuffled = [...sampleEvents].reverse();
    const projShuffled = projectPatientState(shuffled);

    // Duplicate all events
    const duplicated = [...sampleEvents, ...sampleEvents];
    const projDuplicated = projectPatientState(duplicated);

    const original = projectPatientState(sampleEvents);

    assert.deepStrictEqual(projShuffled?.patient_id, original?.patient_id);
    assert.deepStrictEqual(projShuffled?.active_triage, original?.active_triage);
    assert.deepStrictEqual(projShuffled?.ephemeral_id, original?.ephemeral_id);
    assert.deepStrictEqual(projDuplicated?.patient_id, original?.patient_id);
    assert.deepStrictEqual(projDuplicated?.active_triage, original?.active_triage);
  });

  it('correctly manages concurrent clinical divergence between RED and GREEN without silent overwrite', () => {
    const basePatientEvent: PeerScribeEvent = {
      schema_version: 1,
      event_id: 'evt_div_pt_01',
      operation_id: 'OP_DIV_TEST',
      entity_id: 'pt_divergent_01',
      event_type: 'PATIENT_CREATED',
      actor_id: 'node_base',
      actor_sequence: 1,
      lamport_timestamp: 1,
      occurred_at_utc: '2026-10-25T14:00:00.000Z',
      payload: { ephemeral_id: 'TAG-DIV-01' }
    };

    // Replica A assesses RED while disconnected
    const replicaAEvent: PeerScribeEvent = {
      schema_version: 1,
      event_id: 'evt_triage_red_replica_a',
      operation_id: 'OP_DIV_TEST',
      entity_id: 'pt_divergent_01',
      event_type: 'TRIAGE_STATUS_CHANGED',
      actor_id: 'node_medic_A',
      actor_sequence: 1,
      lamport_timestamp: 2,
      occurred_at_utc: '2026-10-25T14:05:00.000Z',
      payload: { triage_category: 'RED', rationale: 'Severe respiratory compromise' }
    };

    // Replica B assesses GREEN while disconnected
    const replicaBEvent: PeerScribeEvent = {
      schema_version: 1,
      event_id: 'evt_triage_green_replica_b',
      operation_id: 'OP_DIV_TEST',
      entity_id: 'pt_divergent_01',
      event_type: 'TRIAGE_STATUS_CHANGED',
      actor_id: 'node_medic_B',
      actor_sequence: 1,
      lamport_timestamp: 2,
      occurred_at_utc: '2026-10-25T14:06:00.000Z',
      payload: { triage_category: 'GREEN', rationale: 'Walking wounded, ambulatory' }
    };

    // 1. After synchronization, both observations are merged into the event log
    const mergedEvents = [basePatientEvent, replicaAEvent, replicaBEvent];
    const projUnresolved = projectPatientState(mergedEvents);

    assert.ok(projUnresolved !== null);
    // Both observations MUST remain in history (no silent discard)
    assert.strictEqual(projUnresolved.triage_history.length, 2);
    assert.ok(projUnresolved.triage_history.some(t => t.category === 'RED'));
    assert.ok(projUnresolved.triage_history.some(t => t.category === 'GREEN'));

    // State 1: DETECTED
    assert.strictEqual(projUnresolved.divergence_state, 'DETECTED');
    // Display policy: MUST NOT imply finalized decision (active_triage must not be finalized)
    assert.strictEqual(projUnresolved.active_triage, 'UNASSESSED');
    assert.ok(projUnresolved.triage_display_label.includes('UNRESOLVED DIVERGENCE'));
    assert.ok(projUnresolved.divergent_categories.includes('RED'));
    assert.ok(projUnresolved.divergent_categories.includes('GREEN'));

    // State 2: ACKNOWLEDGED (Clinician acknowledges awareness of conflict)
    const ackEvent: PeerScribeEvent = {
      schema_version: 1,
      event_id: 'evt_ack_div_01',
      operation_id: 'OP_DIV_TEST',
      entity_id: 'pt_divergent_01',
      event_type: 'DIVERGENCE_ACKNOWLEDGED',
      actor_id: 'node_medic_supervisor',
      actor_sequence: 1,
      lamport_timestamp: 3,
      occurred_at_utc: '2026-10-25T14:10:00.000Z',
      payload: {
        flag_id: 'flag_red_vs_green',
        conflict_type: 'CONCURRENT_TRIAGE_CONFLICT',
        severity: 'CRITICAL',
        reason: 'Medic A tagged RED and Medic B tagged GREEN while disconnected'
      }
    };
    const projAck = projectPatientState([...mergedEvents, ackEvent]);
    assert.strictEqual(projAck?.divergence_state, 'ACKNOWLEDGED');
    assert.strictEqual(projAck?.active_triage, 'UNASSESSED');

    // State 3: RESOLVED (Authorized clinician performs assessment and signs off)
    const resolveEvent: PeerScribeEvent = {
      schema_version: 1,
      event_id: 'evt_resolve_div_01',
      operation_id: 'OP_DIV_TEST',
      entity_id: 'pt_divergent_01',
      event_type: 'DIVERGENCE_RESOLVED',
      actor_id: 'node_trauma_lead',
      actor_sequence: 2,
      lamport_timestamp: 4,
      occurred_at_utc: '2026-10-25T14:15:00.000Z',
      payload: {
        flag_id: 'flag_red_vs_green',
        resolved_category: 'RED',
        clinician_signoff_note: 'Patient decompensated with tension pneumothorax. Confirmed RED.'
      }
    };
    const projResolved = projectPatientState([...mergedEvents, ackEvent, resolveEvent]);
    assert.strictEqual(projResolved?.divergence_state, 'RESOLVED');
    assert.strictEqual(projResolved?.active_triage, 'RED');
    assert.strictEqual(projResolved?.triage_display_label, 'RED');
    assert.strictEqual(projResolved?.divergence_flags[0].resolved, true);
    assert.strictEqual(projResolved?.divergence_flags[0].resolved_by, 'node_trauma_lead');
  });
});
