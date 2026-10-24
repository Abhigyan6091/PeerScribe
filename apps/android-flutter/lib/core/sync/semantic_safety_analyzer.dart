import '../protocol/event_model.dart';
import '../clinical/patient_projection.dart';

class SemanticDivergence {
  final String conflictType; // 'DIV_TRIAGE_DELTA' | 'DIV_DRUG_ALLERGY'
  final String severity;     // 'CRITICAL' | 'WARNING'
  final String description;
  final Map<String, dynamic> metadata;

  const SemanticDivergence({
    required this.conflictType,
    required this.severity,
    required this.description,
    required this.metadata,
  });
}

class SemanticSafetyAnalyzer {
  /// Analyzes incoming event against current projected patient state to catch
  /// concurrent safety-critical divergences before committing.
  static SemanticDivergence? analyze({
    required ProjectedPatient currentPatient,
    required PeerScribeEvent incomingEvent,
  }) {
    // 1. Triage Delta Divergence Check:
    if (incomingEvent.eventType == 'TRIAGE_STATUS_CHANGED') {
      final incomingCategory = incomingEvent.payload['triage_category']?.toString();
      if (incomingCategory != null &&
          currentPatient.activeTriage != 'UNASSESSED' &&
          incomingCategory != currentPatient.activeTriage) {
        // Triage severity difference: RED vs GREEN is critical
        final isSevereDelta = (incomingCategory == 'RED' && currentPatient.activeTriage == 'GREEN') ||
            (incomingCategory == 'GREEN' && currentPatient.activeTriage == 'RED');

        return SemanticDivergence(
          conflictType: 'DIV_TRIAGE_DELTA',
          severity: isSevereDelta ? 'CRITICAL' : 'WARNING',
          description: 'Concurrent triage divergence: existing is ${currentPatient.activeTriage}, incoming is $incomingCategory.',
          metadata: {
            'existing_triage': currentPatient.activeTriage,
            'incoming_triage': incomingCategory,
            'incoming_actor': incomingEvent.actorId,
            'rationale': incomingEvent.payload['rationale'],
          },
        );
      }
    }

    // 2. Drug-Allergy Collision Check:
    if (incomingEvent.eventType == 'MEDICATION_RECORDED') {
      final drug = incomingEvent.payload['drug_name']?.toString() ?? '';
      for (final allergy in currentPatient.knownAllergies) {
        if (drug.toLowerCase().contains(allergy.toLowerCase()) ||
            allergy.toLowerCase().contains(drug.toLowerCase())) {
          return SemanticDivergence(
            conflictType: 'DIV_DRUG_ALLERGY',
            severity: 'CRITICAL',
            description: 'CRITICAL WARNING: Administered drug "$drug" conflicts with documented allergy "$allergy"!',
            metadata: {
              'drug_name': drug,
              'allergy': allergy,
              'administered_by': incomingEvent.actorId,
            },
          );
        }
      }
    }

    return null;
  }
}
