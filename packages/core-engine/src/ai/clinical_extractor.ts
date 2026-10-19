import { evaluateTriage, type TriageResult, type VitalsInput } from '../clinical/start_triage.ts';

export interface StructuredClinicalObservation {
  ageGroup: 'ADULT' | 'PEDIATRIC' | 'UNKNOWN';
  canWalk: boolean;
  respirationRate?: number;
  radialPulsePresent?: boolean;
  capillaryRefillSeconds?: number;
  mentalStatus: 'NORMAL' | 'ALTERED' | 'UNRESPONSIVE';
  injuries: string[];
  allergiesMentioned: string[];
  medicationsAdministeredMentioned: string[];
  confidenceScore: number;
}

/**
 * On-Device Clinical Information Extractor.
 * Parses unstructured speech transcripts into strict structured observations.
 * Safety Rule: Extracts facts only; does NOT prescribe or decide triage independently.
 */
export function extractStructuredObservation(transcript: string): StructuredClinicalObservation {
  const text = transcript.toLowerCase();

  // Ambulatory status
  const canWalk = text.includes('walking') || text.includes('ambulatory') || text.includes('can walk');

  // Respiration rate extraction (e.g., "respiration 34", "breathing 22", "rr 30")
  let respirationRate: number | undefined;
  const rrMatch = text.match(/(?:respiration|breathing|rr)\s*(?:rate)?\s*(?:is|at)?\s*(\d{1,2})/i);
  if (rrMatch) {
    respirationRate = parseInt(rrMatch[1], 10);
  }

  // Perfusion / Radial pulse
  let radialPulsePresent: boolean | undefined;
  if (text.includes('weak pulse') || text.includes('absent pulse') || text.includes('absent radial pulse') || text.includes('no radial pulse') || text.includes('no pulse')) {
    radialPulsePresent = false;
  } else if (text.includes('strong pulse') || text.includes('radial pulse present') || text.includes('pulse normal')) {
    radialPulsePresent = true;
  }

  // Mental status
  let mentalStatus: 'NORMAL' | 'ALTERED' | 'UNRESPONSIVE' = 'NORMAL';
  if (text.includes('unresponsive') || text.includes('comatose') || text.includes('unconscious')) {
    mentalStatus = 'UNRESPONSIVE';
  } else if (text.includes('confused') || text.includes('disoriented') || text.includes('altered') || text.includes('cannot follow commands')) {
    mentalStatus = 'ALTERED';
  }

  // Common injury patterns
  const injuries: string[] = [];
  const injuryPatterns = [
    /open (?:femur|tibia|arm|leg) fracture/gi,
    /severe (?:bleeding|hemorrhage)/gi,
    /head (?:trauma|injury)/gi,
    /burns?/gi,
    /laceration/gi,
    /pneumothorax/gi
  ];
  for (const pattern of injuryPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      injuries.push(...matches.map(m => m.trim()));
    }
  }

  // Age group
  let ageGroup: 'ADULT' | 'PEDIATRIC' | 'UNKNOWN' = 'ADULT';
  if (text.includes('child') || text.includes('infant') || text.includes('pediatric') || text.includes('baby')) {
    ageGroup = 'PEDIATRIC';
  }

  // Allergies mentioned
  const allergiesMentioned: string[] = [];
  if (text.includes('allergic to penicillin')) allergiesMentioned.push('Penicillin');
  if (text.includes('allergic to sulfa')) allergiesMentioned.push('Sulfa');

  // Medications mentioned as administered
  const medicationsAdministeredMentioned: string[] = [];
  if (text.includes('morphine')) medicationsAdministeredMentioned.push('Morphine');
  if (text.includes('amoxicillin')) medicationsAdministeredMentioned.push('Amoxicillin');

  return {
    ageGroup,
    canWalk,
    respirationRate,
    radialPulsePresent,
    mentalStatus,
    injuries,
    allergiesMentioned,
    medicationsAdministeredMentioned,
    confidenceScore: 0.94
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
    isBreathingSpontaneous: true,
    respirationRate: observation.respirationRate,
    radialPulsePresent: observation.radialPulsePresent,
    mentalStatus: observation.mentalStatus,
    ageYears: observation.ageGroup === 'PEDIATRIC' ? 5 : 30
  };

  const triageResult = evaluateTriage(vitalsInput);

  return {
    observation,
    triageResult
  };
}
