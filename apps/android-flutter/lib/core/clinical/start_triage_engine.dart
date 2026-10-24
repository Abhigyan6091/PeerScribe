/// Deterministic START (Simple Triage and Rapid Treatment) Protocol Engine.
class StartTriageEngine {
  static const String categoryRed = 'RED';
  static const String categoryYellow = 'YELLOW';
  static const String categoryGreen = 'GREEN';
  static const String categoryBlack = 'BLACK';

  /// Evaluates deterministic START triage based on physiological parameters.
  static Map<String, dynamic> evaluateStart({
    required bool canWalk,
    required bool breathing,
    bool airwayRepositionedBreathing = false,
    int? respirationRate,
    bool radialPulsePresent = true,
    double? capillaryRefillSeconds,
    bool followsSimpleCommands = true,
  }) {
    // Step 1: Able to walk?
    if (canWalk) {
      return {
        'category': categoryGreen,
        'protocol': 'START_ADULT_v1.0',
        'rationale': 'Patient is ambulatory (walking wounded).',
      };
    }

    // Step 2: Spontaneous breathing?
    if (!breathing) {
      if (!airwayRepositionedBreathing) {
        return {
          'category': categoryBlack,
          'protocol': 'START_ADULT_v1.0',
          'rationale': 'Apneic after airway positioning (Expectant/Deceased).',
        };
      } else {
        return {
          'category': categoryRed,
          'protocol': 'START_ADULT_v1.0',
          'rationale': 'Breathing restored only upon airway repositioning.',
        };
      }
    }

    // Step 3: Respiratory Rate
    if (respirationRate != null) {
      if (respirationRate > 30 || respirationRate < 10) {
        return {
          'category': categoryRed,
          'protocol': 'START_ADULT_v1.0',
          'rationale': 'Severe respiratory compromise (Rate: $respirationRate/min).',
        };
      }
    }

    // Step 4: Perfusion Check
    if (!radialPulsePresent || (capillaryRefillSeconds != null && capillaryRefillSeconds > 2.0)) {
      return {
        'category': categoryRed,
        'protocol': 'START_ADULT_v1.0',
        'rationale': 'Impaired perfusion: absent radial pulse or CRT > 2s.',
      };
    }

    // Step 5: Mental Status Check
    if (!followsSimpleCommands) {
      return {
        'category': categoryRed,
        'protocol': 'START_ADULT_v1.0',
        'rationale': 'Altered mental status: unable to follow simple commands.',
      };
    }

    // All vital thresholds passed
    return {
      'category': categoryYellow,
      'protocol': 'START_ADULT_v1.0',
      'rationale': 'Non-ambulatory but hemodynamically stable. Delayed evacuation.',
    };
  }
}
