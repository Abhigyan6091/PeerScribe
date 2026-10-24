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
  });
}
