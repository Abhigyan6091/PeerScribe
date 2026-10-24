import '../protocol/event_model.dart';

class ProjectedPatient {
  final String patientId;
  final String operationId;
  final String ephemeralId;
  String activeTriage;
  final String createdAtUtc;
  String updatedAtUtc;
  final Map<String, int> vectorClock;
  final List<Map<String, dynamic>> vitals;
  final List<Map<String, dynamic>> injuries;
  final List<Map<String, dynamic>> medications;
  final List<String> knownAllergies;
  final List<Map<String, dynamic>> notes;
  final List<Map<String, dynamic>> divergenceFlags;

  ProjectedPatient({
    required this.patientId,
    required this.operationId,
    required this.ephemeralId,
    this.activeTriage = 'UNASSESSED',
    required this.createdAtUtc,
    required this.updatedAtUtc,
    required this.vectorClock,
    required this.vitals,
    required this.injuries,
    required this.medications,
    required this.knownAllergies,
    required this.notes,
    required this.divergenceFlags,
  });

  static ProjectedPatient? project(List<PeerScribeEvent> events) {
    if (events.isEmpty) return null;

    // Deterministic sort: Lamport timestamp ASC -> actorId ASC -> eventId ASC
    final sorted = List<PeerScribeEvent>.from(events)..sort((a, b) {
      if (a.lamportTimestamp != b.lamportTimestamp) {
        return a.lamportTimestamp.compareTo(b.lamportTimestamp);
      }
      if (a.actorId != b.actorId) {
        return a.actorId.compareTo(b.actorId);
      }
      return a.eventId.compareTo(b.eventId);
    });

    final creation = sorted.firstWhere(
      (e) => e.eventType == 'PATIENT_CREATED',
      orElse: () => sorted.first,
    );

    final patient = ProjectedPatient(
      patientId: creation.entityId,
      operationId: creation.operationId,
      ephemeralId: creation.payload['ephemeral_id']?.toString() ?? 'TAG-UNKNOWN',
      activeTriage: 'UNASSESSED',
      createdAtUtc: creation.occurredAtUtc,
      updatedAtUtc: creation.occurredAtUtc,
      vectorClock: {},
      vitals: [],
      injuries: [],
      medications: [],
      knownAllergies: [],
      notes: [],
      divergenceFlags: [],
    );

    for (final evt in sorted) {
      patient.updatedAtUtc = evt.occurredAtUtc;
      final currentSeq = patient.vectorClock[evt.actorId] ?? 0;
      if (evt.actorSequence > currentSeq) {
        patient.vectorClock[evt.actorId] = evt.actorSequence;
      }

      switch (evt.eventType) {
        case 'VITALS_RECORDED':
          patient.vitals.add({'event_id': evt.eventId, 'timestamp': evt.occurredAtUtc, ...evt.payload});
          break;
        case 'INJURY_RECORDED':
          patient.injuries.add({'event_id': evt.eventId, 'timestamp': evt.occurredAtUtc, ...evt.payload});
          break;
        case 'MEDICATION_RECORDED':
          patient.medications.add({'event_id': evt.eventId, 'timestamp': evt.occurredAtUtc, ...evt.payload});
          break;
        case 'ALLERGY_RECORDED':
          final allergy = evt.payload['allergy']?.toString();
          if (allergy != null && !patient.knownAllergies.contains(allergy)) {
            patient.knownAllergies.add(allergy);
          }
          break;
        case 'OBSERVATION_RECORDED':
          patient.notes.add({'event_id': evt.eventId, 'timestamp': evt.occurredAtUtc, 'text': evt.payload['text'] ?? ''});
          break;
        case 'VAULT_SNAPSHOT_ATTACHED':
          final snapshotAllergies = evt.payload['allergies'] as List?;
          if (snapshotAllergies != null) {
            for (final a in snapshotAllergies) {
              final aStr = a.toString();
              if (!patient.knownAllergies.contains(aStr)) {
                patient.knownAllergies.add(aStr);
              }
            }
          }
          patient.notes.add({
            'event_id': evt.eventId,
            'timestamp': evt.occurredAtUtc,
            'text': '[EMERGENCY ID] Blood: ${evt.payload['blood_group']} | Allergies: ${(evt.payload['allergies'] as List?)?.join(', ') ?? 'None'}'
          });
          break;
        case 'TRIAGE_STATUS_CHANGED':
          final cat = evt.payload['triage_category']?.toString();
          if (cat != null) patient.activeTriage = cat;
          break;
        case 'DIVERGENCE_ACKNOWLEDGED':
          patient.divergenceFlags.add({
            'flag_id': evt.payload['flag_id'] ?? evt.eventId,
            'resolved': false,
            ...evt.payload,
          });
          break;
        case 'DIVERGENCE_RESOLVED':
          final resCat = evt.payload['resolved_category']?.toString();
          if (resCat != null) patient.activeTriage = resCat;
          for (final f in patient.divergenceFlags) {
            if (f['flag_id'] == evt.payload['flag_id'] || evt.payload['flag_id'] == null) {
              f['resolved'] = true;
              f['resolved_by'] = evt.actorId;
              f['resolution_note'] = evt.payload['clinician_signoff_note'];
            }
          }
          break;
      }
    }

    return patient;
  }
}
