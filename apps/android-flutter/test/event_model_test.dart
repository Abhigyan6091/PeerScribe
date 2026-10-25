import 'package:flutter_test/flutter_test.dart';
import 'package:peerscribe_mobile/core/protocol/event_model.dart';
import 'package:peerscribe_mobile/core/protocol/vector_clock.dart';
import 'package:peerscribe_mobile/core/clinical/patient_projection.dart';

void main() {
  group('PeerScribe Flutter Dart Event Model Tests', () {
    test('serializes and deserializes event matching schema contracts', () {
      final event = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_dart_001',
        operationId: 'OP_FLOOD_2026',
        entityId: 'pt_uuid_001',
        eventType: 'PATIENT_CREATED',
        actorId: 'node_mobile_alpha',
        actorSequence: 1,
        lamportTimestamp: 1,
        causalContext: {'node_mobile_alpha': 1},
        occurredAtUtc: '2026-10-24T15:00:00.000Z',
        payload: {
          'ephemeral_id': 'RED-FALCON-04',
          'sector_geohash': 'u15ek200',
        },
      );

      final jsonStr = event.toJson();
      final decoded = PeerScribeEvent.fromJson(jsonStr);

      expect(decoded.schemaVersion, equals(1));
      expect(decoded.eventId, equals('evt_dart_001'));
      expect(decoded.operationId, equals('OP_FLOOD_2026'));
      expect(decoded.entityId, equals('pt_uuid_001'));
      expect(decoded.eventType, equals('PATIENT_CREATED'));
      expect(decoded.actorId, equals('node_mobile_alpha'));
      expect(decoded.actorSequence, equals(1));
      expect(decoded.lamportTimestamp, equals(1));
      expect(decoded.payload['ephemeral_id'], equals('RED-FALCON-04'));
      expect(decoded.validate().isEmpty, isTrue);
    });

    test('validates VectorClock causal ordering and concurrency', () {
      final clock1 = VectorClock({'A': 2, 'B': 1});
      final clock2 = VectorClock({'A': 2, 'B': 3});
      final clock3 = VectorClock({'A': 3, 'B': 0});

      expect(clock1.compare(clock2.toMap()), equals('ANCESTOR'));
      expect(clock2.compare(clock1.toMap()), equals('DESCENDANT'));
      expect(clock1.compare(clock3.toMap()), equals('CONCURRENT'));
    });

    test('projects patient state deterministically from events stream', () {
      final events = [
        PeerScribeEvent(
          eventId: 'evt_1',
          operationId: 'OP_01',
          entityId: 'pt_01',
          eventType: 'PATIENT_CREATED',
          actorId: 'node_A',
          actorSequence: 1,
          lamportTimestamp: 1,
          occurredAtUtc: '2026-10-24T15:00:00.000Z',
          payload: {'ephemeral_id': 'TAG-4421'},
        ),
        PeerScribeEvent(
          eventId: 'evt_2',
          operationId: 'OP_01',
          entityId: 'pt_01',
          eventType: 'TRIAGE_STATUS_CHANGED',
          actorId: 'node_A',
          actorSequence: 2,
          lamportTimestamp: 2,
          occurredAtUtc: '2026-10-24T15:01:00.000Z',
          payload: {'triage_category': 'YELLOW', 'protocol': 'START'},
        ),
        PeerScribeEvent(
          eventId: 'evt_3',
          operationId: 'OP_01',
          entityId: 'pt_01',
          eventType: 'ALLERGY_RECORDED',
          actorId: 'node_B',
          actorSequence: 1,
          lamportTimestamp: 3,
          occurredAtUtc: '2026-10-24T15:02:00.000Z',
          payload: {'allergy': 'Penicillin'},
        ),
      ];

      final patient = ProjectedPatient.project(events);
      expect(patient, isNotNull);
      expect(patient!.ephemeralId, equals('TAG-4421'));
      expect(patient.activeTriage, equals('YELLOW'));
      expect(patient.knownAllergies, contains('Penicillin'));
    });

    test('rejects malformed events, non-positive sequences, and unsupported schema versions', () {
      final badVersion = PeerScribeEvent(
        schemaVersion: 99,
        eventId: 'evt_bad_01',
        operationId: 'OP_01',
        entityId: 'pt_01',
        eventType: 'PATIENT_CREATED',
        actorId: 'node_A',
        actorSequence: 1,
        lamportTimestamp: 1,
        occurredAtUtc: '2026-10-25T14:00:00.000Z',
        payload: {},
      );
      expect(badVersion.validate().any((e) => e.contains('Unsupported schema_version')), isTrue);

      final emptyId = PeerScribeEvent(
        schemaVersion: 1,
        eventId: '',
        operationId: 'OP_01',
        entityId: 'pt_01',
        eventType: 'PATIENT_CREATED',
        actorId: 'node_A',
        actorSequence: 1,
        lamportTimestamp: 1,
        occurredAtUtc: '2026-10-25T14:00:00.000Z',
        payload: {},
      );
      expect(emptyId.validate().any((e) => e.contains('event_id is required')), isTrue);

      final badSeq = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_bad_seq',
        operationId: 'OP_01',
        entityId: 'pt_01',
        eventType: 'PATIENT_CREATED',
        actorId: 'node_A',
        actorSequence: 0,
        lamportTimestamp: 1,
        occurredAtUtc: '2026-10-25T14:00:00.000Z',
        payload: {},
      );
      expect(badSeq.validate().any((e) => e.contains('actor_sequence must be positive integer')), isTrue);
    });

    test('P0: clinical divergence correctness between RED and GREEN without silent overwrite', () {
      final baseEvent = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_pt_div_01',
        operationId: 'OP_DIV_TEST',
        entityId: 'pt_divergent_flutter',
        eventType: 'PATIENT_CREATED',
        actorId: 'node_base',
        actorSequence: 1,
        lamportTimestamp: 1,
        occurredAtUtc: '2026-10-25T14:00:00.000Z',
        payload: {'ephemeral_id': 'TAG-DIV-FLUTTER'},
      );

      // Replica A assesses RED while disconnected
      final replicaA = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_tri_red_flutter',
        operationId: 'OP_DIV_TEST',
        entityId: 'pt_divergent_flutter',
        eventType: 'TRIAGE_STATUS_CHANGED',
        actorId: 'node_medic_A',
        actorSequence: 1,
        lamportTimestamp: 2,
        occurredAtUtc: '2026-10-25T14:05:00.000Z',
        payload: {'triage_category': 'RED'},
      );

      // Replica B assesses GREEN while disconnected
      final replicaB = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_tri_green_flutter',
        operationId: 'OP_DIV_TEST',
        entityId: 'pt_divergent_flutter',
        eventType: 'TRIAGE_STATUS_CHANGED',
        actorId: 'node_medic_B',
        actorSequence: 1,
        lamportTimestamp: 2,
        occurredAtUtc: '2026-10-25T14:06:00.000Z',
        payload: {'triage_category': 'GREEN'},
      );

      // Step 1: Merged disconnected state (DETECTED)
      final merged = [baseEvent, replicaA, replicaB];
      final projUnresolved = ProjectedPatient.project(merged);

      expect(projUnresolved, isNotNull);
      // Both observations MUST remain in history
      expect(projUnresolved!.triageHistory.length, equals(2));
      expect(projUnresolved.triageHistory.any((t) => t['category'] == 'RED'), isTrue);
      expect(projUnresolved.triageHistory.any((t) => t['category'] == 'GREEN'), isTrue);

      // State 1: DETECTED
      expect(projUnresolved.divergenceState, equals('DETECTED'));
      // UI policy: MUST NOT imply finalized decision
      expect(projUnresolved.activeTriage, equals('UNASSESSED'));
      expect(projUnresolved.triageDisplayLabel, contains('UNRESOLVED DIVERGENCE'));
      expect(projUnresolved.divergentCategories, containsAll(['RED', 'GREEN']));

      // Step 2: Acknowledged by clinician
      final ackEvent = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_ack_flutter',
        operationId: 'OP_DIV_TEST',
        entityId: 'pt_divergent_flutter',
        eventType: 'DIVERGENCE_ACKNOWLEDGED',
        actorId: 'node_supervisor',
        actorSequence: 1,
        lamportTimestamp: 3,
        occurredAtUtc: '2026-10-25T14:10:00.000Z',
        payload: {'flag_id': 'div_flag_01', 'reason': 'Conflicting triage'},
      );
      final projAck = ProjectedPatient.project([...merged, ackEvent]);
      expect(projAck!.divergenceState, equals('ACKNOWLEDGED'));
      expect(projAck.activeTriage, equals('UNASSESSED'));

      // Step 3: Authorized clinician resolution
      final resolveEvent = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_resolve_flutter',
        operationId: 'OP_DIV_TEST',
        entityId: 'pt_divergent_flutter',
        eventType: 'DIVERGENCE_RESOLVED',
        actorId: 'node_trauma_director',
        actorSequence: 2,
        lamportTimestamp: 4,
        occurredAtUtc: '2026-10-25T14:15:00.000Z',
        payload: {
          'flag_id': 'div_flag_01',
          'resolved_category': 'RED',
          'clinician_signoff_note': 'Director confirmed RED',
        },
      );
      final projResolved = ProjectedPatient.project([...merged, ackEvent, resolveEvent]);
      expect(projResolved!.divergenceState, equals('RESOLVED'));
      expect(projResolved.activeTriage, equals('RED'));
      expect(projResolved.triageDisplayLabel, equals('RED'));
      expect(projResolved.divergenceFlags.first['resolved'], isTrue);
    });
  });
}
