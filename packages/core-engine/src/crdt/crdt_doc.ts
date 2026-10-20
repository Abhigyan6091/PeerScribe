import { type VectorClock, incrementClock, mergeClocks, compareClocks } from './vector_clock.ts';
import { sha256 } from '../identity/crypto.ts';

export type TriageCategory = 'RED' | 'YELLOW' | 'GREEN' | 'BLACK';

export interface TriageEvaluation {
  id: string;
  category: TriageCategory;
  protocol: string; // e.g. "START_v1.0.0"
  evaluatedByNode: string;
  timestamp: number;
  logicalClock: number;
  overrideReason?: string | null;
}

export interface VitalSignEntry {
  id: string;
  timestamp: number;
  recordedByNode: string;
  respirationRate?: number;
  radialPulsePresent?: boolean;
  mentalStatus?: 'NORMAL' | 'ALTERED' | 'UNRESPONSIVE';
  capillaryRefillSeconds?: number;
  systolicBp?: number;
  heartRate?: number;
}

export interface InjuryEntry {
  id: string;
  timestamp: number;
  recordedByNode: string;
  anatomicalLocation: string;
  classification: string;
  tourniquetApplied?: boolean;
}

export interface MedicationAdministrationEntry {
  id: string;
  timestamp: number;
  administeredByNode: string;
  drugName: string;
  dosage: string;
  route: string; // IV, IM, Oral, etc.
  medicSignature: string; // Schnorr/Ed25519 signature
}

export interface ClinicalDivergenceFlag {
  id: string;
  conflictType: 'DIV_TRIAGE_DELTA' | 'DIV_DRUG_ALLERGY' | 'DIV_DUPLICATE_ID' | 'DIV_IDENTITY_ATTACH';
  severity: 'CRITICAL' | 'FATAL_RISK' | 'WARNING';
  detectedAt: number;
  conflictingEntries: any[];
  resolved: boolean;
  resolvedBy?: string;
  resolutionTimestamp?: number;
  resolutionNote?: string;
}

export interface CrdtPatientDocument {
  patientId: string;
  operationId: string;
  ephemeralId: string;
  createdAt: number;
  vectorClock: VectorClock;
  triageEvaluations: TriageEvaluation[]; // Multi-Value Register
  vitals: VitalSignEntry[]; // Append-Only Log
  injuries: InjuryEntry[]; // Append-Only Log
  medications: MedicationAdministrationEntry[]; // Append-Only Log
  knownAllergies: string[]; // Observed set
  notes: { id: string; timestamp: number; author: string; text: string }[];
  divergenceFlags: ClinicalDivergenceFlag[];
}

export interface CrdtDelta {
  deltaId: string;
  patientId: string;
  operationId: string;
  originNode: string;
  vectorClock: VectorClock;
  timestamp: number;
  mutations: {
    triage?: TriageEvaluation;
    vital?: VitalSignEntry;
    injury?: InjuryEntry;
    medication?: MedicationAdministrationEntry;
    allergy?: string;
    note?: { id: string; timestamp: number; author: string; text: string };
  }[];
}

/**
 * Initialize a new CRDT patient record.
 */
export function createPatientDocument(
  patientId: string,
  operationId: string,
  ephemeralId: string,
  creatorNodeId: string
): CrdtPatientDocument {
  return {
    patientId,
    operationId,
    ephemeralId,
    createdAt: Date.now(),
    vectorClock: { [creatorNodeId]: 1 },
    triageEvaluations: [],
    vitals: [],
    injuries: [],
    medications: [],
    knownAllergies: [],
    notes: [],
    divergenceFlags: []
  };
}

/**
 * Record a new triage evaluation into the patient document.
 */
export function recordTriageEvaluation(
  doc: CrdtPatientDocument,
  nodeId: string,
  category: TriageCategory,
  protocol: string,
  overrideReason?: string | null
): { updatedDoc: CrdtPatientDocument; delta: CrdtDelta } {
  const updatedClock = incrementClock(doc.vectorClock, nodeId);
  const evaluation: TriageEvaluation = {
    id: `tri_${sha256(`${doc.patientId}:${nodeId}:${Date.now()}`).substring(0, 12)}`,
    category,
    protocol,
    evaluatedByNode: nodeId,
    timestamp: Date.now(),
    logicalClock: updatedClock[nodeId],
    overrideReason
  };

  const updatedDoc: CrdtPatientDocument = {
    ...doc,
    vectorClock: updatedClock,
    triageEvaluations: [...doc.triageEvaluations, evaluation]
  };

  const delta: CrdtDelta = {
    deltaId: `delta_${sha256(`${evaluation.id}:${Date.now()}`).substring(0, 12)}`,
    patientId: doc.patientId,
    operationId: doc.operationId,
    originNode: nodeId,
    vectorClock: updatedClock,
    timestamp: Date.now(),
    mutations: [{ triage: evaluation }]
  };

  return { updatedDoc, delta };
}

/**
 * Record vital signs into the patient CRDT document.
 */
export function recordVitals(
  doc: CrdtPatientDocument,
  nodeId: string,
  vitalsData: Omit<VitalSignEntry, 'id' | 'timestamp' | 'recordedByNode'>
): { updatedDoc: CrdtPatientDocument; delta: CrdtDelta } {
  const updatedClock = incrementClock(doc.vectorClock, nodeId);
  const entry: VitalSignEntry = {
    id: `vit_${sha256(`${doc.patientId}:${nodeId}:${Date.now()}`).substring(0, 12)}`,
    timestamp: Date.now(),
    recordedByNode: nodeId,
    ...vitalsData
  };

  const updatedDoc: CrdtPatientDocument = {
    ...doc,
    vectorClock: updatedClock,
    vitals: [...doc.vitals, entry]
  };

  const delta: CrdtDelta = {
    deltaId: `delta_${sha256(`${entry.id}:${Date.now()}`).substring(0, 12)}`,
    patientId: doc.patientId,
    operationId: doc.operationId,
    originNode: nodeId,
    vectorClock: updatedClock,
    timestamp: Date.now(),
    mutations: [{ vital: entry }]
  };

  return { updatedDoc, delta };
}

/**
 * Record medication administration with authorized signature.
 */
export function recordMedication(
  doc: CrdtPatientDocument,
  nodeId: string,
  medData: Omit<MedicationAdministrationEntry, 'id' | 'timestamp' | 'administeredByNode'>
): { updatedDoc: CrdtPatientDocument; delta: CrdtDelta } {
  const updatedClock = incrementClock(doc.vectorClock, nodeId);
  const entry: MedicationAdministrationEntry = {
    id: `med_${sha256(`${doc.patientId}:${nodeId}:${Date.now()}`).substring(0, 12)}`,
    timestamp: Date.now(),
    administeredByNode: nodeId,
    ...medData
  };

  const updatedDoc: CrdtPatientDocument = {
    ...doc,
    vectorClock: updatedClock,
    medications: [...doc.medications, entry]
  };

  const delta: CrdtDelta = {
    deltaId: `delta_${sha256(`${entry.id}:${Date.now()}`).substring(0, 12)}`,
    patientId: doc.patientId,
    operationId: doc.operationId,
    originNode: nodeId,
    vectorClock: updatedClock,
    timestamp: Date.now(),
    mutations: [{ medication: entry }]
  };

  return { updatedDoc, delta };
}

/**
 * Record a clinical injury or physical trauma entry.
 */
export function recordInjury(
  doc: CrdtPatientDocument,
  nodeId: string,
  anatomicalLocation: string,
  classification: string,
  tourniquetApplied = false
): { updatedDoc: CrdtPatientDocument; delta: CrdtDelta } {
  const updatedClock = incrementClock(doc.vectorClock, nodeId);
  const entry: InjuryEntry = {
    id: `inj_${sha256(`${doc.patientId}:${nodeId}:${Date.now()}:${Math.random()}`).substring(0, 12)}`,
    timestamp: Date.now(),
    recordedByNode: nodeId,
    anatomicalLocation,
    classification,
    tourniquetApplied
  };

  const updatedDoc: CrdtPatientDocument = {
    ...doc,
    vectorClock: updatedClock,
    injuries: [...(doc.injuries || []), entry]
  };

  const delta: CrdtDelta = {
    deltaId: `delta_${sha256(`${entry.id}:${Date.now()}`).substring(0, 12)}`,
    patientId: doc.patientId,
    operationId: doc.operationId,
    originNode: nodeId,
    vectorClock: updatedClock,
    timestamp: Date.now(),
    mutations: [{ injury: entry }]
  };

  return { updatedDoc, delta };
}

/**
 * Record a freeform situational narrative or distress transmission note.
 */
export function recordNote(
  doc: CrdtPatientDocument,
  nodeId: string,
  text: string
): { updatedDoc: CrdtPatientDocument; delta: CrdtDelta } {
  const updatedClock = incrementClock(doc.vectorClock, nodeId);
  const entry = {
    id: `note_${sha256(`${doc.patientId}:${nodeId}:${Date.now()}:${Math.random()}`).substring(0, 12)}`,
    timestamp: Date.now(),
    author: nodeId,
    text
  };

  const updatedDoc: CrdtPatientDocument = {
    ...doc,
    vectorClock: updatedClock,
    notes: [...(doc.notes || []), entry]
  };

  const delta: CrdtDelta = {
    deltaId: `delta_${sha256(`${entry.id}:${Date.now()}`).substring(0, 12)}`,
    patientId: doc.patientId,
    operationId: doc.operationId,
    originNode: nodeId,
    vectorClock: updatedClock,
    timestamp: Date.now(),
    mutations: [{ note: entry }]
  };

  return { updatedDoc, delta };
}

/**
 * Apply a remote CRDT delta to a local patient document (Idempotent).
 */
export function applyDelta(doc: CrdtPatientDocument, delta: CrdtDelta): CrdtPatientDocument {
  if (doc.patientId !== delta.patientId) {
    throw new Error(`Patient ID mismatch: local ${doc.patientId} vs delta ${delta.patientId}`);
  }

  const mergedClock = mergeClocks(doc.vectorClock, delta.vectorClock);

  // De-duplicate triage entries by ID
  const existingTriageIds = new Set(doc.triageEvaluations.map(t => t.id));
  const newTriage = [...doc.triageEvaluations];

  // De-duplicate vitals entries by ID
  const existingVitalIds = new Set(doc.vitals.map(v => v.id));
  const newVitals = [...doc.vitals];

  // De-duplicate medications entries by ID
  const existingMedIds = new Set(doc.medications.map(m => m.id));
  const newMedications = [...doc.medications];

  // De-duplicate injuries entries by ID
  const existingInjuryIds = new Set((doc.injuries || []).map(i => i.id));
  const newInjuries = [...(doc.injuries || [])];

  // De-duplicate notes entries by ID
  const existingNoteIds = new Set((doc.notes || []).map(n => n.id));
  const newNotes = [...(doc.notes || [])];

  // De-duplicate allergies
  const allergiesSet = new Set(doc.knownAllergies);

  for (const mut of delta.mutations) {
    if (mut.triage && !existingTriageIds.has(mut.triage.id)) {
      newTriage.push(mut.triage);
      existingTriageIds.add(mut.triage.id);
    }
    if (mut.vital && !existingVitalIds.has(mut.vital.id)) {
      newVitals.push(mut.vital);
      existingVitalIds.add(mut.vital.id);
    }
    if (mut.medication && !existingMedIds.has(mut.medication.id)) {
      newMedications.push(mut.medication);
      existingMedIds.add(mut.medication.id);
    }
    if (mut.injury && !existingInjuryIds.has(mut.injury.id)) {
      newInjuries.push(mut.injury);
      existingInjuryIds.add(mut.injury.id);
    }
    if (mut.note && !existingNoteIds.has(mut.note.id)) {
      newNotes.push(mut.note);
      existingNoteIds.add(mut.note.id);
    }
    if (mut.allergy) {
      allergiesSet.add(mut.allergy);
    }
  }

  // Sort logs causally by timestamp
  newTriage.sort((a, b) => a.timestamp - b.timestamp);
  newVitals.sort((a, b) => a.timestamp - b.timestamp);
  newMedications.sort((a, b) => a.timestamp - b.timestamp);
  newInjuries.sort((a, b) => a.timestamp - b.timestamp);
  newNotes.sort((a, b) => a.timestamp - b.timestamp);

  return {
    ...doc,
    vectorClock: mergedClock,
    triageEvaluations: newTriage,
    vitals: newVitals,
    medications: newMedications,
    injuries: newInjuries,
    notes: newNotes,
    knownAllergies: Array.from(allergiesSet)
  };
}

/**
 * Deterministically merge two replica documents of the same patient.
 */
export function mergePatientDocuments(docA: CrdtPatientDocument, docB: CrdtPatientDocument): CrdtPatientDocument {
  if (docA.patientId !== docB.patientId) {
    throw new Error(`Cannot merge different patients: ${docA.patientId} vs ${docB.patientId}`);
  }

  const mergedClock = mergeClocks(docA.vectorClock, docB.vectorClock);

  // Union triage evaluations
  const triageMap = new Map<string, TriageEvaluation>();
  docA.triageEvaluations.forEach(t => triageMap.set(t.id, t));
  docB.triageEvaluations.forEach(t => triageMap.set(t.id, t));
  const mergedTriage = Array.from(triageMap.values()).sort((a, b) => a.timestamp - b.timestamp);

  // Union vitals
  const vitalsMap = new Map<string, VitalSignEntry>();
  docA.vitals.forEach(v => vitalsMap.set(v.id, v));
  docB.vitals.forEach(v => vitalsMap.set(v.id, v));
  const mergedVitals = Array.from(vitalsMap.values()).sort((a, b) => a.timestamp - b.timestamp);

  // Union medications
  const medsMap = new Map<string, MedicationAdministrationEntry>();
  docA.medications.forEach(m => medsMap.set(m.id, m));
  docB.medications.forEach(m => medsMap.set(m.id, m));
  const mergedMeds = Array.from(medsMap.values()).sort((a, b) => a.timestamp - b.timestamp);

  // Union injuries
  const injuriesMap = new Map<string, InjuryEntry>();
  (docA.injuries || []).forEach(i => injuriesMap.set(i.id, i));
  (docB.injuries || []).forEach(i => injuriesMap.set(i.id, i));
  const mergedInjuries = Array.from(injuriesMap.values()).sort((a, b) => a.timestamp - b.timestamp);

  // Union notes
  const notesMap = new Map<string, { id: string; timestamp: number; author: string; text: string }>();
  (docA.notes || []).forEach(n => notesMap.set(n.id, n));
  (docB.notes || []).forEach(n => notesMap.set(n.id, n));
  const mergedNotes = Array.from(notesMap.values()).sort((a, b) => a.timestamp - b.timestamp);

  // Union allergies
  const mergedAllergies = Array.from(new Set([...docA.knownAllergies, ...docB.knownAllergies]));

  // Union divergence flags
  const flagsMap = new Map<string, ClinicalDivergenceFlag>();
  docA.divergenceFlags.forEach(f => flagsMap.set(f.id, f));
  docB.divergenceFlags.forEach(f => flagsMap.set(f.id, f));

  return {
    ...docA,
    vectorClock: mergedClock,
    triageEvaluations: mergedTriage,
    vitals: mergedVitals,
    medications: mergedMeds,
    injuries: mergedInjuries,
    notes: mergedNotes,
    knownAllergies: mergedAllergies,
    divergenceFlags: Array.from(flagsMap.values())
  };
}

/**
 * Get active triage category. If multiple concurrent evaluations exist,
 * returns the most acute category as a safety fallback until clinician resolution.
 */
export function getActiveTriageCategory(doc: CrdtPatientDocument): TriageCategory | 'UNASSESSED' {
  if (doc.triageEvaluations.length === 0) return 'UNASSESSED';
  
  // Severity order (RED > YELLOW > GREEN > BLACK)
  const severityScore: Record<TriageCategory, number> = {
    RED: 4,
    YELLOW: 3,
    GREEN: 2,
    BLACK: 1
  };

  // Find latest evaluations (within 10 minutes of latest)
  const latestTimestamp = Math.max(...doc.triageEvaluations.map(t => t.timestamp));
  const recentEvaluations = doc.triageEvaluations.filter(t => latestTimestamp - t.timestamp < 10 * 60 * 1000);

  if (recentEvaluations.length === 0) {
    return doc.triageEvaluations[doc.triageEvaluations.length - 1].category;
  }

  // Safety rule: if there is disagreement, default to the most critical (highest score)
  recentEvaluations.sort((a, b) => severityScore[b.category] - severityScore[a.category]);
  return recentEvaluations[0].category;
}
