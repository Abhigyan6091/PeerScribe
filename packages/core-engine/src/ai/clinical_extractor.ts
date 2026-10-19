import { evaluateTriage, type TriageResult, type VitalsInput } from '../clinical/start_triage.ts';

export interface StructuredClinicalObservation {
  ageGroup: 'ADULT' | 'PEDIATRIC' | 'UNKNOWN';
  canWalk: boolean;
  isBreathingSpontaneous: boolean;
  breathingAfterAirwayOpen?: boolean;
  respirationRate?: number;
  radialPulsePresent?: boolean;
  capillaryRefillSeconds?: number;
  mentalStatus: 'NORMAL' | 'ALTERED' | 'UNRESPONSIVE';
  injuries: string[];
  allergiesMentioned: string[];
  medicationsAdministeredMentioned: string[];
  confidenceScore: number;
}

// Spoken number word mapping (for natural speech recognition)
const WORD_TO_NUMBER: Record<string, number> = {
  'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
  'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
  'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
  'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'twenty': 20,
  'twenty one': 21, 'twenty-one': 21, 'twenty two': 22, 'twenty-two': 22,
  'twenty three': 23, 'twenty-three': 23, 'twenty four': 24, 'twenty-four': 24,
  'twenty five': 25, 'twenty-five': 25, 'twenty six': 26, 'twenty-six': 26,
  'twenty seven': 27, 'twenty-seven': 27, 'twenty eight': 28, 'twenty-eight': 28,
  'twenty nine': 29, 'twenty-nine': 29, 'thirty': 30,
  'thirty one': 31, 'thirty-one': 31, 'thirty two': 32, 'thirty-two': 32,
  'thirty three': 33, 'thirty-three': 33, 'thirty four': 34, 'thirty-four': 34,
  'thirty five': 35, 'thirty-five': 35, 'thirty six': 36, 'thirty-six': 36,
  'thirty seven': 37, 'thirty-seven': 37, 'thirty eight': 38, 'thirty-eight': 38,
  'thirty nine': 39, 'thirty-nine': 39, 'forty': 40,
  'forty one': 41, 'forty-one': 41, 'forty two': 42, 'forty-two': 42,
  'forty three': 43, 'forty-three': 43, 'forty four': 44, 'forty-four': 44,
  'forty five': 45, 'forty-five': 45, 'fifty': 50, 'sixty': 60, 'seventy': 70,
  'eighty': 80, 'ninety': 90, 'one hundred': 100
};

// Sort multi-word keys first so 'thirty two' matches before 'thirty' or 'two'
const SORTED_WORD_ENTRIES = Object.entries(WORD_TO_NUMBER).sort((a, b) => b[0].length - a[0].length);

function normalizeSpokenNumbers(text: string): string {
  let normalized = text.toLowerCase();
  for (const [word, num] of SORTED_WORD_ENTRIES) {
    const reg = new RegExp(`\\b${word}\\b`, 'gi');
    normalized = normalized.replace(reg, String(num));
  }
  return normalized;
}

/**
 * On-Device Clinical Information Extractor.
 * Parses natural spoken audio transcripts into strict structured clinical observations.
 * Adheres strictly to Principle P5: Extracts observations only; does NOT prescribe.
 */
export function extractStructuredObservation(rawTranscript: string): StructuredClinicalObservation {
  const text = normalizeSpokenNumbers(rawTranscript);

  // 1. Ambulatory Status
  let canWalk = false;
  if (
    text.includes('walking') || text.includes('ambulatory') || text.includes('can walk') ||
    text.includes('walks') || text.includes('able to walk') || text.includes('able to stand') ||
    text.includes('walking wounded')
  ) {
    // Check for negation: "cannot walk", "unable to walk"
    if (!text.includes('cannot walk') && !text.includes('unable to walk') && !text.includes('not walking') && !text.includes('cant walk')) {
      canWalk = true;
    }
  }

  // 2. Spontaneous Breathing & Airway Check
  let isBreathingSpontaneous = true;
  let breathingAfterAirwayOpen: boolean | undefined = undefined;

  const noBreathingPhrases = [
    'not breathing', 'no breathing', 'stopped breathing', 'apneic', 'apnoea',
    'no respirations', 'zero respirations', 'respiratory arrest', 'not respiring', 'no breaths'
  ];
  if (noBreathingPhrases.some(p => text.includes(p))) {
    isBreathingSpontaneous = false;
    if (text.includes('airway opened') || text.includes('opened airway') || text.includes('repositioned airway') || text.includes('head tilt')) {
      if (text.includes('resumed') || text.includes('breathing started') || text.includes('breaths resumed') || text.includes('starts breathing')) {
        breathingAfterAirwayOpen = true;
      } else {
        breathingAfterAirwayOpen = false;
      }
    }
  }

  // 3. Respiration Rate (Digits or converted words)
  let respirationRate: number | undefined;
  if (isBreathingSpontaneous) {
    const rrMatch = text.match(
      /(?:respiratory\s*rate|respiration\s*rate|breathing\s*rate|respirations?|breathing|breaths?|rr|rate)\s*(?:is|at|of|count|around|approx|approximately)?\s*(\d{1,2})/i
    ) || text.match(
      /\b(\d{1,2})\s*(?:breaths|respirations|breaths\s*per\s*minute|bpm)\b/i
    );

    if (rrMatch) {
      respirationRate = parseInt(rrMatch[1], 10);
    }
  }

  // 4. Perfusion / Radial Pulse / Capillary Refill
  let radialPulsePresent: boolean | undefined;
  const absentPulsePhrases = [
    'absent pulse', 'pulse absent', 'pulse is absent', 'weak pulse', 'pulse is weak',
    'no radial pulse', 'absent radial pulse', 'radial pulse absent', 'radial pulse is absent',
    'absent radial', 'radial absent', 'radial is absent', 'no radial',
    'no pulse', 'pulseless', 'cannot feel pulse', 'cant feel pulse', 'no palpable pulse',
    'thready pulse', 'feeble pulse', 'faint pulse', 'no carotid pulse', 'cannot find pulse'
  ];
  const presentPulsePhrases = [
    'strong pulse', 'normal pulse', 'radial pulse present', 'radial pulse is present',
    'pulse present', 'pulse is present', 'radial present', 'radial is present',
    'pulse normal', 'pulse is normal', 'good pulse', 'palpable pulse',
    'radial pulse is normal', 'radial pulse normal', 'pulse felt'
  ];

  if (absentPulsePhrases.some(p => text.includes(p))) {
    radialPulsePresent = false;
  } else if (presentPulsePhrases.some(p => text.includes(p))) {
    radialPulsePresent = true;
  }

  // Capillary refill
  let capillaryRefillSeconds: number | undefined;
  const capMatch = text.match(/cap(?:illary)?\s*refill\s*(?:is|at|of)?\s*(\d+)/i);
  if (capMatch) {
    capillaryRefillSeconds = parseInt(capMatch[1], 10);
  } else if (text.includes('delayed refill') || text.includes('cap refill delayed') || text.includes('capillary refill delayed') || text.includes('refill delayed') || text.includes('cap refill > 2') || text.includes('delayed capillary')) {
    capillaryRefillSeconds = 4;
  } else if (text.includes('normal refill') || text.includes('cap refill normal') || text.includes('capillary refill normal') || text.includes('brisk refill') || text.includes('brisk capillary')) {
    capillaryRefillSeconds = 1;
  }

  // 5. Mental Status
  let mentalStatus: 'NORMAL' | 'ALTERED' | 'UNRESPONSIVE' = 'NORMAL';
  const unresponsivePhrases = [
    'unresponsive', 'comatose', 'unconscious', 'no response', 'not responding', 'passed out'
  ];
  const alteredPhrases = [
    'confused', 'disoriented', 'altered', 'cannot follow commands', 'unable to follow commands',
    'slurred speech', 'incoherent', 'not following commands', 'cant follow commands'
  ];
  const normalPhrases = [
    'follows simple commands', 'follows commands', 'alert', 'oriented', 'conscious', 'normal mental status'
  ];

  if (unresponsivePhrases.some(p => text.includes(p))) {
    mentalStatus = 'UNRESPONSIVE';
  } else if (alteredPhrases.some(p => text.includes(p))) {
    mentalStatus = 'ALTERED';
  } else if (normalPhrases.some(p => text.includes(p))) {
    mentalStatus = 'NORMAL';
  }

  // 6. Common Injury Detections
  const injuries: string[] = [];
  const injuryPatterns = [
    /open (?:femur|tibia|arm|leg|bone) fracture/gi,
    /compound fracture/gi,
    /severe (?:bleeding|hemorrhage)/gi,
    /arterial (?:bleeding|bleed)/gi,
    /head (?:trauma|injury)/gi,
    /crush (?:injury|trauma)/gi,
    /burns?(?:\s*(?:first|second|third)\s*degree)?/gi,
    /lacerations?/gi,
    /pneumothorax/gi,
    /amputation/gi,
    /gunshot(?: wound)?/gi,
    /shrapnel(?: wound)?/gi,
    /penetrating (?:chest|abdominal) trauma/gi
  ];
  for (const pattern of injuryPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      injuries.push(...matches.map(m => m.trim()));
    }
  }

  // 7. Age Group
  let ageGroup: 'ADULT' | 'PEDIATRIC' | 'UNKNOWN' = 'ADULT';
  if (
    text.includes('child') || text.includes('infant') || text.includes('pediatric') ||
    text.includes('baby') || text.includes('toddler') || text.includes('boy') || text.includes('girl')
  ) {
    ageGroup = 'PEDIATRIC';
  }

  // 8. Allergies Mentioned
  const allergiesMentioned: string[] = [];
  if (text.includes('penicillin') && (text.includes('allergic') || text.includes('allergy'))) allergiesMentioned.push('Penicillin');
  if (text.includes('sulfa') && (text.includes('allergic') || text.includes('allergy'))) allergiesMentioned.push('Sulfa');
  if (text.includes('latex') && (text.includes('allergic') || text.includes('allergy'))) allergiesMentioned.push('Latex');
  if (text.includes('aspirin') && (text.includes('allergic') || text.includes('allergy'))) allergiesMentioned.push('Aspirin');

  // 9. Medications Mentioned as Administered
  const medicationsAdministeredMentioned: string[] = [];
  if (text.includes('morphine')) medicationsAdministeredMentioned.push('Morphine');
  if (text.includes('amoxicillin')) medicationsAdministeredMentioned.push('Amoxicillin');
  if (text.includes('fentanyl')) medicationsAdministeredMentioned.push('Fentanyl');
  if (text.includes('tourniquet')) medicationsAdministeredMentioned.push('Tourniquet');
  if (text.includes('naloxone') || text.includes('narcan')) medicationsAdministeredMentioned.push('Naloxone');
  if (text.includes('epinephrine')) medicationsAdministeredMentioned.push('Epinephrine');

  return {
    ageGroup,
    canWalk,
    isBreathingSpontaneous,
    breathingAfterAirwayOpen,
    respirationRate,
    radialPulsePresent,
    capillaryRefillSeconds,
    mentalStatus,
    injuries,
    allergiesMentioned,
    medicationsAdministeredMentioned,
    confidenceScore: 0.95
  };
}

/**
 * Pipeline Bridge: Feeds structured extracted observation directly into the
 * deterministic clinical triage rules engine.
 */
export function extractAndEvaluateTriage(transcript: string): { observation: StructuredClinicalObservation; triageResult: TriageResult } {
  const observation = extractStructuredObservation(transcript);

  const vitalsInput: VitalsInput = {
    canWalk: observation.canWalk,
    isBreathingSpontaneous: observation.isBreathingSpontaneous,
    breathingAfterAirwayOpen: observation.breathingAfterAirwayOpen,
    respirationRate: observation.respirationRate,
    radialPulsePresent: observation.radialPulsePresent,
    capillaryRefillSeconds: observation.capillaryRefillSeconds,
    mentalStatus: observation.mentalStatus,
    ageYears: observation.ageGroup === 'PEDIATRIC' ? 6 : 30
  };

  const triageResult = evaluateTriage(vitalsInput);

  return {
    observation,
    triageResult
  };
}
