import { type CrdtPatientDocument, type ClinicalDivergenceFlag, type TriageCategory } from '../crdt/crdt_doc.ts';
import { sha256 } from '../identity/crypto.ts';

// Common drug class and synonym mapping
const ALLERGY_SYNONYMS: Record<string, string[]> = {
  penicillin: ['penicillin', 'amoxicillin', 'ampicillin', 'augmentin', 'piperacillin', 'zosyn'],
  sulfa: ['sulfa', 'sulfamethoxazole', 'bactrim', 'septra'],
  morphine: ['morphine', 'ms contin', 'oramorph'],
  fentanyl: ['fentanyl', 'sublimaze', 'duragesic'],
  nsaid: ['nsaid', 'ibuprofen', 'motrin', 'advil', 'naproxen', 'aleve', 'ketorolac', 'toradol', 'aspirin']
};

/**
 * Check if a medication matches a documented allergy or drug class.
 */
function isAllergyCollision(drugName: string, allergyName: string): boolean {
  const normDrug = drugName.toLowerCase().trim();
  const normAllergy = allergyName.toLowerCase().trim();

  if (normDrug.includes(normAllergy) || normAllergy.includes(normDrug)) {
    return true;
  }

  for (const [, synonyms] of Object.entries(ALLERGY_SYNONYMS)) {
    const allergyMatch = synonyms.some(s => normAllergy.includes(s));
    const drugMatch = synonyms.some(s => normDrug.includes(s));
    if (allergyMatch && drugMatch) {
      return true;
    }
  }

  return false;
}

/**
 * Level 2 Semantic Safety Analyzer.
 * Inspects CRDT patient document for clinical divergence and safety collisions.
 */
export function analyzeSemanticSafety(doc: CrdtPatientDocument): ClinicalDivergenceFlag[] {
  const flags: ClinicalDivergenceFlag[] = [];

  // Rule 1: DIV_TRIAGE_DELTA (Concurrent opposing triage evaluations)
  if (doc.triageEvaluations.length > 1) {
    const latestTimestamp = Math.max(...doc.triageEvaluations.map(t => t.timestamp));
    // Find evaluations made within 15 minutes of the most recent evaluation
    const recent = doc.triageEvaluations.filter(t => latestTimestamp - t.timestamp < 15 * 60 * 1000);
    
    const uniqueCategories = new Set(recent.map(t => t.category));
    if (uniqueCategories.size > 1) {
      // Divergence detected!
      const flagId = `div_tri_${sha256(Array.from(uniqueCategories).sort().join(':')).substring(0, 12)}`;
      flags.push({
        id: flagId,
        conflictType: 'DIV_TRIAGE_DELTA',
        severity: 'CRITICAL',
        detectedAt: Date.now(),
        conflictingEntries: recent,
        resolved: false
      });
    }
  }

  // Rule 2: DIV_DRUG_ALLERGY (Administered medication collides with allergy)
  for (const med of doc.medications) {
    for (const allergy of doc.knownAllergies) {
      if (isAllergyCollision(med.drugName, allergy)) {
        const flagId = `div_med_${sha256(`${med.drugName}:${allergy}`).substring(0, 12)}`;
        flags.push({
          id: flagId,
          conflictType: 'DIV_DRUG_ALLERGY',
          severity: 'FATAL_RISK',
          detectedAt: Date.now(),
          conflictingEntries: [
            { medication: med },
            { allergy }
          ],
          resolved: false
        });
      }
    }
  }

  return flags;
}

/**
 * Update patient document with newly detected divergence flags.
 */
export function applyDivergenceAnalysis(doc: CrdtPatientDocument): CrdtPatientDocument {
  const newFlags = analyzeSemanticSafety(doc);
  if (newFlags.length === 0) return doc;

  const existingFlagMap = new Map(doc.divergenceFlags.map(f => [f.id, f]));
  for (const flag of newFlags) {
    if (!existingFlagMap.has(flag.id)) {
      existingFlagMap.set(flag.id, flag);
    }
  }

  return {
    ...doc,
    divergenceFlags: Array.from(existingFlagMap.values())
  };
}

/**
 * Resolve a divergence flag with authorized clinician sign-off.
 */
export function resolveDivergence(
  doc: CrdtPatientDocument,
  flagId: string,
  clinicianNodeId: string,
  resolutionNote: string,
  finalCategory?: TriageCategory
): CrdtPatientDocument {
  const updatedFlags = doc.divergenceFlags.map(f => {
    if (f.id === flagId) {
      return {
        ...f,
        resolved: true,
        resolvedBy: clinicianNodeId,
        resolutionTimestamp: Date.now(),
        resolutionNote
      };
    }
    return f;
  });

  let updatedDoc: CrdtPatientDocument = {
    ...doc,
    divergenceFlags: updatedFlags
  };

  if (finalCategory) {
    const resolutionEvaluation = {
      id: `tri_res_${sha256(`${flagId}:${Date.now()}`).substring(0, 12)}`,
      category: finalCategory,
      protocol: 'CLINICAL_RESOLUTION_MANUAL',
      evaluatedByNode: clinicianNodeId,
      timestamp: Date.now(),
      logicalClock: (doc.vectorClock[clinicianNodeId] || 0) + 1,
      overrideReason: `Resolved conflict ${flagId}: ${resolutionNote}`
    };

    updatedDoc = {
      ...updatedDoc,
      triageEvaluations: [...updatedDoc.triageEvaluations, resolutionEvaluation]
    };
  }

  return updatedDoc;
}
