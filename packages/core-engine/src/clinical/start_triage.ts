import { type TriageCategory } from '../crdt/crdt_doc.ts';

export interface VitalsInput {
  canWalk: boolean;
  isBreathingSpontaneous: boolean;
  breathingAfterAirwayOpen?: boolean;
  respirationRate?: number;
  radialPulsePresent?: boolean;
  capillaryRefillSeconds?: number;
  mentalStatus?: 'NORMAL' | 'ALTERED' | 'UNRESPONSIVE';
  ageYears?: number;
  // Pediatric JumpSTART specifics
  hasPeripheralPulse?: boolean;
  breathingAfter5RescueBreaths?: boolean;
}

export interface TriageResult {
  protocol: 'START_ADULT_v1.0' | 'JUMPSTART_PEDIATRIC_v1.0';
  category: TriageCategory;
  rationale: string;
  evaluatedAt: number;
}

/**
 * Deterministic adult START (Simple Triage and Rapid Treatment) protocol engine.
 */
export function evaluateAdultStartTriage(vitals: VitalsInput): TriageResult {
  const evaluatedAt = Date.now();

  // Step 1: Ambulatory check
  if (vitals.canWalk) {
    return {
      protocol: 'START_ADULT_v1.0',
      category: 'GREEN',
      rationale: 'Patient is ambulatory (minor / walking wounded).',
      evaluatedAt
    };
  }

  // Step 2: Spontaneous breathing check
  if (!vitals.isBreathingSpontaneous) {
    if (vitals.breathingAfterAirwayOpen === true) {
      return {
        protocol: 'START_ADULT_v1.0',
        category: 'RED',
        rationale: 'Breathing restored after manual airway positioning.',
        evaluatedAt
      };
    } else {
      return {
        protocol: 'START_ADULT_v1.0',
        category: 'BLACK',
        rationale: 'Apneic; not breathing despite manual airway opening (expectant / deceased).',
        evaluatedAt
      };
    }
  }

  // Step 3: Respiration rate evaluation
  if (vitals.respirationRate !== undefined) {
    if (vitals.respirationRate > 30 || vitals.respirationRate < 10) {
      return {
        protocol: 'START_ADULT_v1.0',
        category: 'RED',
        rationale: `Respiratory compromise: rate is ${vitals.respirationRate}/min (normal: 10-30).`,
        evaluatedAt
      };
    }
  }

  // Step 4: Perfusion evaluation (radial pulse & capillary refill)
  if (vitals.radialPulsePresent === false || (vitals.capillaryRefillSeconds !== undefined && vitals.capillaryRefillSeconds > 2)) {
    return {
      protocol: 'START_ADULT_v1.0',
      category: 'RED',
      rationale: 'Hemodynamic compromise: radial pulse absent or capillary refill > 2.0s.',
      evaluatedAt
    };
  }

  // Step 5: Mental status evaluation
  if (vitals.mentalStatus === 'ALTERED' || vitals.mentalStatus === 'UNRESPONSIVE') {
    return {
      protocol: 'START_ADULT_v1.0',
      category: 'RED',
      rationale: 'Neurological deficit: altered mental status or inability to follow commands.',
      evaluatedAt
    };
  }

  // Step 6: Delayed care
  return {
    protocol: 'START_ADULT_v1.0',
    category: 'YELLOW',
    rationale: 'Non-ambulatory but normal respiration (10-30), adequate perfusion, and follows simple commands.',
    evaluatedAt
  };
}

/**
 * Deterministic pediatric JumpSTART protocol engine.
 */
export function evaluateJumpStartTriage(vitals: VitalsInput): TriageResult {
  const evaluatedAt = Date.now();

  // Step 1: Able to walk
  if (vitals.canWalk) {
    return {
      protocol: 'JUMPSTART_PEDIATRIC_v1.0',
      category: 'GREEN',
      rationale: 'Pediatric patient is ambulatory.',
      evaluatedAt
    };
  }

  // Step 2: Spontaneous breathing
  if (!vitals.isBreathingSpontaneous) {
    if (vitals.breathingAfterAirwayOpen) {
      return {
        protocol: 'JUMPSTART_PEDIATRIC_v1.0',
        category: 'RED',
        rationale: 'Breathing resumed after pediatric airway positioning.',
        evaluatedAt
      };
    }

    // Check peripheral pulse for 5 rescue breaths
    if (vitals.hasPeripheralPulse && vitals.breathingAfter5RescueBreaths) {
      return {
        protocol: 'JUMPSTART_PEDIATRIC_v1.0',
        category: 'RED',
        rationale: 'Breathing resumed after 5 pediatric rescue breaths.',
        evaluatedAt
      };
    }

    return {
      protocol: 'JUMPSTART_PEDIATRIC_v1.0',
      category: 'BLACK',
      rationale: 'Apneic without peripheral pulse or failed recovery after rescue breaths.',
      evaluatedAt
    };
  }

  // Step 3: Pediatric respiratory rate (<15 or >45)
  if (vitals.respirationRate !== undefined) {
    if (vitals.respirationRate < 15 || vitals.respirationRate > 45) {
      return {
        protocol: 'JUMPSTART_PEDIATRIC_v1.0',
        category: 'RED',
        rationale: `Pediatric respiratory rate out of range: ${vitals.respirationRate}/min (normal: 15-45).`,
        evaluatedAt
      };
    }
  }

  // Step 4: Perfusion check (palpable pulse)
  if (vitals.hasPeripheralPulse === false && vitals.radialPulsePresent === false) {
    return {
      protocol: 'JUMPSTART_PEDIATRIC_v1.0',
      category: 'RED',
      rationale: 'Absent peripheral pulse.',
      evaluatedAt
    };
  }

  // Step 5: Mental status (AVPU: Alert, Verbal, Pain, Unresponsive)
  if (vitals.mentalStatus === 'ALTERED' || vitals.mentalStatus === 'UNRESPONSIVE') {
    return {
      protocol: 'JUMPSTART_PEDIATRIC_v1.0',
      category: 'RED',
      rationale: 'Inappropriate response to pain or unresponsive.',
      evaluatedAt
    };
  }

  return {
    protocol: 'JUMPSTART_PEDIATRIC_v1.0',
    category: 'YELLOW',
    rationale: 'Non-ambulatory child with stable vitals and appropriate mental status.',
    evaluatedAt
  };
}

/**
 * Unified triage evaluator automatically branching based on age.
 */
export function evaluateTriage(vitals: VitalsInput): TriageResult {
  if (vitals.ageYears !== undefined && vitals.ageYears < 8) {
    return evaluateJumpStartTriage(vitals);
  }
  return evaluateAdultStartTriage(vitals);
}
