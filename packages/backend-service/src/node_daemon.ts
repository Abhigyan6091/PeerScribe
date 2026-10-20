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
  type IdentityKeyPair,
  encodePacket,
  PacketType,
  PacketFlags,
  crc32,
  createNostrMeshEvent,
  sha256
} from '../../core-engine/src/index.ts';

export type OperationalMode = 'DORMANT' | 'FIELD' | 'EMERGENCY';

export interface DaemonConfig {
  dbPath?: string;
  nodeId?: string;
  operationId?: string;
  initialMode?: OperationalMode;
}

export interface WirePacketTelemetry {
  id: string;
  timestamp: number;
  timeStr: string;
  packetType: string;
  bundleId: string;
  priority: string;
  magic: string;
  crc32Hex: string;
  hopCount: number;
  maxTtl: number;
  geohash: string;
  wireSize: number;
  wireHexPreview: string;
  senderPubkeyHash: string;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: number;
  timeStr: string;
  subsystem: 'CRDT' | 'SQLITE' | 'WIRE' | 'DTN' | 'NOSTR' | 'AI' | 'SECURITY';
  title: string;
  details: any;
}

export class PeerScribeDaemon extends EventEmitter {
  public nodeId: string;
  public keyPair: IdentityKeyPair;
  public readonly db: PeerScribeDatabase;
  public dtnOutbox: DtnOutboxQueue;
  public readonly nostrGateway: NostrGatewayService;
  public readonly wipeService: EmergencyWipeService;
  
  public currentMode: OperationalMode = 'FIELD';
  public currentOperationId: string = 'OP-TACTICAL-ALPHA';
  public sectorGeohash: string = 'u15ek200';
  private particleFilter?: MobilityParticleFilter;

  // Real-time Telemetry Ring Buffers
  public recentWirePackets: WirePacketTelemetry[] = [];
  public recentNostrEvents: any[] = [];
  public recentActivityLogs: ActivityLogEntry[] = [];

  constructor(config: DaemonConfig = {}) {
    super();
    this.keyPair = generateIdentityKeyPair();
    this.nodeId = config.nodeId || `node_${this.keyPair.publicKey.slice(-8)}`;
    this.currentMode = config.initialMode || 'FIELD';
    this.currentOperationId = config.operationId || 'OP-TACTICAL-ALPHA';

    this.db = new PeerScribeDatabase({ dbPath: config.dbPath });
    this.db.createOperation(this.currentOperationId, 'Operation Rapid Angel', this.sectorGeohash);

    this.dtnOutbox = new DtnOutboxQueue();
    this.nostrGateway = new NostrGatewayService();
    this.wipeService = new EmergencyWipeService();

    // Register comprehensive wipe targets
    this.wipeService.registerTarget({
      name: 'SqliteRelationalStorage',
      wipe: () => {
        this.db.purgeAllData();
        this.db.createOperation(this.currentOperationId, 'Operation Rapid Angel', this.sectorGeohash);
      }
    });

    this.wipeService.registerTarget({
      name: 'DtnOutboxQueue',
      wipe: () => {
        this.dtnOutbox = new DtnOutboxQueue();
      }
    });

    this.wipeService.registerTarget({
      name: 'SessionEphemeralKeysAndLogs',
      wipe: () => {
        this.recentWirePackets = [];
        this.recentNostrEvents = [];
        this.recentActivityLogs = [];
        this.nostrGateway.clear();
        if (this.particleFilter) {
          this.initParticleFilter(27.7172, 85.3240);
        }
      }
    });

    this.wipeService.registerTarget({
      name: 'IdentityKeyPairRegeneration',
      wipe: () => {
        this.keyPair = generateIdentityKeyPair();
        this.nodeId = `node_${this.keyPair.publicKey.slice(-8)}`;
      }
    });

    this.initParticleFilter(27.7172, 85.3240);
  }

  initParticleFilter(lat: number, lon: number): void {
    this.particleFilter = new MobilityParticleFilter(lat, lon, 600, 25);
  }

  public logActivity(subsystem: ActivityLogEntry['subsystem'], title: string, details: any): void {
    const entry: ActivityLogEntry = {
      id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now(),
      timeStr: new Date().toLocaleTimeString(),
      subsystem,
      title,
      details
    };
    this.recentActivityLogs.unshift(entry);
    if (this.recentActivityLogs.length > 50) this.recentActivityLogs.pop();
    this.emit('activityLogged', entry);
  }

  private generateAuditId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  transitionMode(newMode: OperationalMode): OperationalMode {
    const oldMode = this.currentMode;
    this.currentMode = newMode;
    if (newMode === 'DORMANT') {
      this.nostrGateway.setInternetConnectivity(false);
    } else if (newMode === 'EMERGENCY') {
      this.nostrGateway.setInternetConnectivity(true);
    }
    console.log(`\x1b[35m[MODE CHANGE]\x1b[0m Node transitioned from ${oldMode} -> \x1b[1m${newMode}\x1b[0m`);
    this.logActivity('SECURITY', `Mode Transition: ${oldMode} -> ${newMode}`, { oldMode, newMode });
    this.emit('modeChanged', { oldMode, newMode, timestamp: Date.now() });
    return this.currentMode;
  }

  createPatient(ephemeralId?: string): CrdtPatientDocument {
    const patientId = `PATIENT_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const ephem = ephemeralId || generateEphemeralId(this.currentOperationId, patientId).ephemeralId;

    let doc = createPatientDocument(patientId, this.currentOperationId, ephem, this.nodeId);
    this.db.savePatientDocument(doc, getActiveTriageCategory(doc));
    
    const auditId = this.generateAuditId();
    this.db.logAuditEvent(auditId, patientId, 'PATIENT_CREATED', this.nodeId, { ephemeralId: ephem });

    console.log(`\x1b[32m[PATIENT INTAKE]\x1b[0m Created casualty: \x1b[1m${ephem}\x1b[0m (ID: ${patientId})`);
    this.logActivity('CRDT', `Casualty Created: ${ephem}`, { patientId, ephemeralId: ephem, auditId });

    this.emit('patientCreated', doc);
    return doc;
  }

  private packageAndPropagateDelta(
    delta: any,
    patientId: string,
    ephemeralId: string,
    priority: typeof BundlePriority[keyof typeof BundlePriority],
    priorityName: string
  ): { wireTelemetry: WirePacketTelemetry; nostrEvent: any } {
    const payloadBuf = Buffer.from(JSON.stringify(delta));

    // 1. BitChat Binary Wire Packet (32-byte header + CRC-32)
    const wirePacket = encodePacket(
      priority === BundlePriority.CRITICAL_SOS ? PacketType.SOS_PRIORITY : PacketType.CRDT_SYNC_BUNDLE,
      payloadBuf,
      {
        hopCount: 0,
        maxTtl: 15,
        sequenceNumber: Math.floor(Math.random() * 1000) + 1,
        geohash: this.sectorGeohash,
        senderPubkeyHash: this.keyPair.publicKey.substring(0, 16)
      }
    );

    const wireCrc = crc32(wirePacket.subarray(0, 28));
    const wireTelemetry: WirePacketTelemetry = {
      id: `pkt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now(),
      timeStr: new Date().toLocaleTimeString(),
      packetType: priority === BundlePriority.CRITICAL_SOS ? 'SOS_PRIORITY (0x03)' : 'CRDT_SYNC_BUNDLE (0x01)',
      bundleId: delta.deltaId,
      priority: priorityName,
      magic: '0x5053 (PS)',
      crc32Hex: `0x${wireCrc.toString(16).toUpperCase()}`,
      hopCount: 0,
      maxTtl: 15,
      geohash: this.sectorGeohash,
      wireSize: wirePacket.length,
      wireHexPreview: wirePacket.subarray(0, 32).toString('hex').toUpperCase(),
      senderPubkeyHash: this.keyPair.publicKey.substring(0, 16)
    };

    this.recentWirePackets.unshift(wireTelemetry);
    if (this.recentWirePackets.length > 30) this.recentWirePackets.pop();

    // 2. DTN Store-and-Forward Outbox
    this.dtnOutbox.enqueue({
      bundleId: delta.deltaId,
      operationId: this.currentOperationId,
      priority,
      hopCount: 0,
      maxHops: 15,
      createdAt: Date.now(),
      ttlMs: 3600000,
      payload: wirePacket
    });

    // 3. BitChat Nostr Kind 20042 Mesh Sync Event
    const nostrSecret = Buffer.alloc(32, 0x5a); // Shared tactical cluster secret
    const nostrEvent = createNostrMeshEvent(
      this.currentOperationId,
      this.sectorGeohash,
      payloadBuf,
      nostrSecret,
      this.keyPair.privateKey
    );
    this.recentNostrEvents.unshift(nostrEvent);
    if (this.recentNostrEvents.length > 20) this.recentNostrEvents.pop();

    // Terminal Logging
    console.log(`\x1b[36m[CRDT DELTA]\x1b[0m Casualty: \x1b[1m${ephemeralId}\x1b[0m | Delta: ${delta.deltaId}`);
    console.log(`  \x1b[33m↳ [SQLite WAL]\x1b[0m Committed patient_documents & clinical_audit_trail to disk`);
    console.log(`  \x1b[35m↳ [BitChat Wire]\x1b[0m 32-byte header | CRC32: ${wireTelemetry.crc32Hex} | Geohash: ${this.sectorGeohash} | Total: ${wirePacket.length}B`);
    console.log(`  \x1b[34m↳ [DTN Outbox]\x1b[0m Enqueued priority: \x1b[1m${priorityName}\x1b[0m (Hop 0/15)`);
    console.log(`  \x1b[32m↳ [Nostr Gateway]\x1b[0m Packaged Kind 20042 event (ID: ${nostrEvent.id.substring(0, 16)}...)`);

    this.logActivity('WIRE', `Packaged Wire Packet: ${wireTelemetry.packetType}`, {
      crc32: wireTelemetry.crc32Hex,
      wireSize: wireTelemetry.wireSize,
      wireHex: wireTelemetry.wireHexPreview
    });
    this.logActivity('DTN', `DTN Outbox Queued: ${delta.deltaId}`, { priority: priorityName, hops: '0/15' });
    this.logActivity('NOSTR', `Nostr Kind 20042 Generated`, { eventId: nostrEvent.id, geohash: this.sectorGeohash });

    return { wireTelemetry, nostrEvent };
  }

  recordTriage(
    patientId: string,
    category: TriageCategory,
    protocol = 'START_v1.0.0',
    overrideReason?: string
  ): { doc: CrdtPatientDocument; activeTriage: TriageCategory; divergences: any[]; wireTelemetry: WirePacketTelemetry } {
    let doc = this.db.getPatientDocument(patientId);
    if (!doc) {
      doc = this.createPatient();
      patientId = doc.patientId;
    }

    const { updatedDoc, delta } = recordTriageEvaluation(doc, this.nodeId, category, protocol, overrideReason);
    
    // Level 2 Semantic Safety Analyzer
    const divergences = analyzeSemanticSafety(updatedDoc);
    const analyzedDoc = applyDivergenceAnalysis(updatedDoc);
    const activeTriage = getActiveTriageCategory(analyzedDoc);

    // Save to SQLite WAL
    this.db.savePatientDocument(analyzedDoc, activeTriage);
    const auditId = this.generateAuditId();
    this.db.logAuditEvent(auditId, patientId, 'TRIAGE_EVALUATED', this.nodeId, {
      category,
      protocol,
      divergencesCount: divergences.length
    });

    const priority = activeTriage === 'RED' ? BundlePriority.CRITICAL_SOS : BundlePriority.CLINICAL_DELTA;
    const priorityName = activeTriage === 'RED' ? 'CRITICAL_SOS' : 'CLINICAL_DELTA';

    const { wireTelemetry } = this.packageAndPropagateDelta(delta, patientId, analyzedDoc.ephemeralId, priority, priorityName);

    this.emit('patientUpdated', { doc: analyzedDoc, activeTriage, divergences, wireTelemetry });
    return { doc: analyzedDoc, activeTriage, divergences, wireTelemetry };
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

    this.packageAndPropagateDelta(delta, patientId, updatedDoc.ephemeralId, BundlePriority.CLINICAL_DELTA, 'CLINICAL_DELTA');

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

    const { updatedDoc, delta } = recordMedication(doc, this.nodeId, {
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

    this.packageAndPropagateDelta(delta, patientId, analyzedDoc.ephemeralId, BundlePriority.CLINICAL_DELTA, 'CLINICAL_DELTA');

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

    console.log(`\x1b[32m[DIVERGENCE RESOLVED]\x1b[0m Patient: ${doc.ephemeralId} | Confirmed by: ${this.nodeId}`);
    this.logActivity('CRDT', `Divergence Resolved: ${doc.ephemeralId}`, { flagId, note: clinicianSignoffNote });

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

    if (aiResult.observation.respirationRate || aiResult.observation.radialPulsePresent !== undefined) {
      this.recordVitals(targetDoc.patientId, {
        respirationRate: aiResult.observation.respirationRate,
        radialPulsePresent: aiResult.observation.radialPulsePresent
      });
    }

    const triageOutcome = this.recordTriage(
      targetDoc.patientId,
      aiResult.triageResult.category,
      aiResult.triageResult.protocolApplied,
      'Extracted via Edge AI speech input'
    );

    console.log(`\x1b[36m[EDGE AI SPEECH]\x1b[0m Parsed: "${transcript}" -> START Triage: \x1b[1m${aiResult.triageResult.category}\x1b[0m`);
    this.logActivity('AI', `Voice Extracted -> Triage: ${aiResult.triageResult.category}`, {
      transcript,
      vitals: aiResult.observation
    });

    return {
      patientId: targetDoc.patientId,
      observation: aiResult.observation,
      triageResult: aiResult.triageResult,
      updatedDoc: triageOutcome.doc,
      wireTelemetry: triageOutcome.wireTelemetry
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
    console.log(`\x1b[35m[PARTICLE SIGHTING]\x1b[0m Bayesian contraction -> 75% radius: ${contours.radius75PercentMeters.toFixed(1)}m`);
    this.logActivity('LOCATION' as any, `Sighting Contracted Search Radius`, contours);
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
      sectorGeohash: this.sectorGeohash,
      totalCasualties: patients.length,
      triageCounts,
      outboxCount: this.db.listPendingDtnBundles(this.currentOperationId).length,
      wirePacketsCount: this.recentWirePackets.length,
      nostrGatewayActive: this.nostrGateway.isGatewayActive,
      timestamp: Date.now()
    };
  }

  triggerEmergencyWipe(): boolean {
    const receipt = this.wipeService.executeEmergencyWipe();
    console.log(`\x1b[41m\x1b[37m[EMERGENCY WIPE]\x1b[0m All memory keys zeroized, state scrubbed: ${receipt.targetsWiped.join(', ')}\x1b[0m`);
    this.emit('emergencyWiped', {
      timestamp: Date.now(),
      targetsWiped: receipt.targetsWiped,
      newNodeId: this.nodeId
    });
    return receipt.success;
  }
}
