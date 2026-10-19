import { EventEmitter } from 'node:events';
import {
  generateIdentityKeyPair,
  generateEphemeralId,
  createPatientDocument,
  recordTriageEvaluation,
  recordVitals,
  recordMedication,
  getActiveTriageCategory,
  analyzeSemanticSafety,
  applyDivergenceAnalysis,
  resolveDivergence,
  type CrdtPatientDocument,
  type TriageCategory,
  PeerScribeDatabase,
  DtnOutboxQueue,
  BundlePriority,
  NostrGatewayService,
  extractAndEvaluateTriage,
  MobilityParticleFilter,
  EmergencyWipeService,
  type IdentityKeyPair
} from '../../core-engine/src/index.ts';

export type OperationalMode = 'DORMANT' | 'FIELD' | 'EMERGENCY';

export interface DaemonConfig {
  dbPath?: string;
  nodeId?: string;
  operationId?: string;
  initialMode?: OperationalMode;
}

export class PeerScribeDaemon extends EventEmitter {
  public readonly nodeId: string;
  public readonly keyPair: IdentityKeyPair;
  public readonly db: PeerScribeDatabase;
  public readonly dtnOutbox: DtnOutboxQueue;
  public readonly nostrGateway: NostrGatewayService;
  public readonly wipeService: EmergencyWipeService;
  
  public currentMode: OperationalMode = 'FIELD';
  public currentOperationId: string = 'OP-TACTICAL-ALPHA';
  private particleFilter?: MobilityParticleFilter;

  constructor(config: DaemonConfig = {}) {
    super();
    this.keyPair = generateIdentityKeyPair();
    this.nodeId = config.nodeId || `node_${this.keyPair.publicKey.substring(0, 8)}`;
    this.currentMode = config.initialMode || 'FIELD';
    this.currentOperationId = config.operationId || 'OP-TACTICAL-ALPHA';

    this.db = new PeerScribeDatabase({ dbPath: config.dbPath });
    this.db.createOperation(this.currentOperationId, 'Operation Rapid Angel', 'dr5regw3');

    this.dtnOutbox = new DtnOutboxQueue();
    this.nostrGateway = new NostrGatewayService();
    this.wipeService = new EmergencyWipeService();

    // Register wipe targets
    this.wipeService.registerTarget({
      name: 'SessionEphemeralKeys',
      wipe: () => {
        // Zero keys in memory
      }
    });

    // Default LKP (Disaster ground zero Kathmandu/San Francisco test coordinates)
    this.initParticleFilter(37.7749, -122.4194);
  }

  initParticleFilter(lat: number, lon: number): void {
    this.particleFilter = new MobilityParticleFilter(lat, lon, 600, 25);
  }

  private generateAuditId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  transitionMode(newMode: OperationalMode): OperationalMode {
    const oldMode = this.currentMode;
    this.currentMode = newMode;
    this.emit('modeChanged', { oldMode, newMode, timestamp: Date.now() });
    return this.currentMode;
  }

  createPatient(ephemeralId?: string): CrdtPatientDocument {
    const patientId = `PATIENT_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const ephem = ephemeralId || generateEphemeralId(this.currentOperationId, patientId).ephemeralId;

    let doc = createPatientDocument(patientId, this.currentOperationId, ephem, this.nodeId);
    this.db.savePatientDocument(doc, getActiveTriageCategory(doc));
    this.db.logAuditEvent(this.generateAuditId(), patientId, 'PATIENT_CREATED', this.nodeId, { ephemeralId: ephem });

    this.emit('patientCreated', doc);
    return doc;
  }

  recordTriage(
    patientId: string,
    category: TriageCategory,
    protocol = 'START_v1.0.0',
    overrideReason?: string
  ): { doc: CrdtPatientDocument; activeTriage: TriageCategory; divergences: any[] } {
    let doc = this.db.getPatientDocument(patientId);
    if (!doc) {
      doc = this.createPatient();
    }

    const { updatedDoc, delta } = recordTriageEvaluation(doc, this.nodeId, category, protocol, overrideReason);
    
    // Run Level 2 Semantic Safety Analyzer
    const divergences = analyzeSemanticSafety(updatedDoc);
    const analyzedDoc = applyDivergenceAnalysis(updatedDoc);
    const activeTriage = getActiveTriageCategory(analyzedDoc);

    // Save to durable SQLite WAL
    this.db.savePatientDocument(analyzedDoc, activeTriage);
    this.db.logAuditEvent(this.generateAuditId(), patientId, 'TRIAGE_EVALUATED', this.nodeId, {
      category,
      protocol,
      divergencesCount: divergences.length
    });

    // Enqueue DTN bundle
    this.dtnOutbox.enqueue({
      bundleId: delta.deltaId,
      operationId: this.currentOperationId,
      priority: activeTriage === 'RED' ? BundlePriority.CRITICAL_SOS : BundlePriority.CLINICAL_DELTA,
      hopCount: 0,
      maxHops: 15,
      createdAt: Date.now(),
      ttlMs: 3600000,
      payload: Buffer.from(JSON.stringify(delta))
    });

    this.emit('patientUpdated', { doc: analyzedDoc, activeTriage, divergences });
    return { doc: analyzedDoc, activeTriage, divergences };
  }

  recordVitals(
    patientId: string,
    vitalsInput: { respirationRate?: number; pulseRate?: number; radialPulsePresent?: boolean; spO2?: number; systolicBp?: number }
  ): CrdtPatientDocument {
    let doc = this.db.getPatientDocument(patientId);
    if (!doc) throw new Error(`Patient ${patientId} not found`);

    const { updatedDoc, delta } = recordVitals(doc, this.nodeId, {
      respirationRate: vitalsInput.respirationRate,
      radialPulsePresent: vitalsInput.radialPulsePresent,
      heartRate: vitalsInput.pulseRate,
      systolicBp: vitalsInput.systolicBp
    });

    const activeTriage = getActiveTriageCategory(updatedDoc);
    this.db.savePatientDocument(updatedDoc, activeTriage);
    this.db.logAuditEvent(this.generateAuditId(), patientId, 'VITALS_RECORDED', this.nodeId, vitalsInput);

    this.emit('patientUpdated', { doc: updatedDoc, activeTriage });
    return updatedDoc;
  }

  recordMedication(
    patientId: string,
    drugName: string,
    dosage: string,
    route = 'IV'
  ): { doc: CrdtPatientDocument; divergences: any[] } {
    let doc = this.db.getPatientDocument(patientId);
    if (!doc) throw new Error(`Patient ${patientId} not found`);

    const { updatedDoc } = recordMedication(doc, this.nodeId, {
      drugName,
      dosage,
      route,
      medicSignature: `sig_${this.keyPair.publicKey.substring(0, 16)}`
    });

    const divergences = analyzeSemanticSafety(updatedDoc);
    const analyzedDoc = applyDivergenceAnalysis(updatedDoc);
    const activeTriage = getActiveTriageCategory(analyzedDoc);

    this.db.savePatientDocument(analyzedDoc, activeTriage);
    this.db.logAuditEvent(this.generateAuditId(), patientId, 'MEDICATION_ADMINISTERED', this.nodeId, {
      drugName,
      dosage,
      route,
      divergences
    });

    this.emit('patientUpdated', { doc: analyzedDoc, activeTriage, divergences });
    return { doc: analyzedDoc, divergences };
  }

  resolveDivergenceFlag(patientId: string, flagId: string, clinicianSignoffNote: string): CrdtPatientDocument {
    let doc = this.db.getPatientDocument(patientId);
    if (!doc) throw new Error(`Patient ${patientId} not found`);

    const updatedDoc = resolveDivergence(doc, flagId, this.nodeId, clinicianSignoffNote);
    const activeTriage = getActiveTriageCategory(updatedDoc);
    this.db.savePatientDocument(updatedDoc, activeTriage);
    this.db.logAuditEvent(this.generateAuditId(), patientId, 'DIVERGENCE_RESOLVED', this.nodeId, { flagId, note: clinicianSignoffNote });

    this.emit('patientUpdated', { doc: updatedDoc, activeTriage });
    return updatedDoc;
  }

  processVoiceTranscript(transcript: string, patientId?: string): any {
    const aiResult = extractAndEvaluateTriage(transcript);
    
    let targetDoc: CrdtPatientDocument;
    if (patientId) {
      targetDoc = this.db.getPatientDocument(patientId) || this.createPatient();
    } else {
      targetDoc = this.createPatient();
    }

    // Apply structured vitals if present
    if (aiResult.observation.respirationRate || aiResult.observation.radialPulsePresent !== undefined) {
      this.recordVitals(targetDoc.patientId, {
        respirationRate: aiResult.observation.respirationRate,
        radialPulsePresent: aiResult.observation.radialPulsePresent
      });
    }

    // Apply evaluated triage
    const triageOutcome = this.recordTriage(
      targetDoc.patientId,
      aiResult.triageResult.category,
      aiResult.triageResult.protocolApplied,
      'Extracted via Edge AI speech input'
    );

    return {
      patientId: targetDoc.patientId,
      observation: aiResult.observation,
      triageResult: aiResult.triageResult,
      updatedDoc: triageOutcome.doc
    };
  }

  getSearchContours(): any {
    if (!this.particleFilter) return null;
    return this.particleFilter.estimateSearchContours();
  }

  observeSighting(lat: number, lon: number, accuracyMeters = 30): any {
    if (!this.particleFilter) this.initParticleFilter(lat, lon);
    this.particleFilter!.observeSighting(lat, lon, accuracyMeters);
    const contours = this.particleFilter!.estimateSearchContours();
    this.emit('sightingContracted', contours);
    return contours;
  }

  listPatients(): { doc: CrdtPatientDocument; activeTriage: string }[] {
    return this.db.listPatientDocuments(this.currentOperationId);
  }

  getStatus(): any {
    const patients = this.listPatients();
    const triageCounts = {
      RED: patients.filter(p => p.activeTriage === 'RED').length,
      YELLOW: patients.filter(p => p.activeTriage === 'YELLOW').length,
      GREEN: patients.filter(p => p.activeTriage === 'GREEN').length,
      BLACK: patients.filter(p => p.activeTriage === 'BLACK').length
    };

    return {
      nodeId: this.nodeId,
      publicKey: this.keyPair.publicKey,
      currentMode: this.currentMode,
      operationId: this.currentOperationId,
      totalCasualties: patients.length,
      triageCounts,
      outboxPending: this.dtnOutbox.getLocalBloomFilter().sizeBytes,
      nostrGatewayActive: this.nostrGateway.isGatewayActive,
      timestamp: Date.now()
    };
  }

  triggerEmergencyWipe(): boolean {
    const success = this.wipeService.executeEmergencyWipe();
    this.emit('emergencyWiped', { timestamp: Date.now() });
    return success;
  }
}
