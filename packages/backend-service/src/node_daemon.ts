import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { LanSyncService } = require('../../../apps/desktop-electron/src/lan_sync.cjs');
import {
  generateIdentityKeyPair,
  generateEphemeralId,
  createPatientDocument,
  recordTriageEvaluation,
  recordVitals,
  recordMedication,
  recordInjury,
  recordNote,
  getActiveTriageCategory,
  analyzeSemanticSafety,
  isAllergyCollision,
  LiveNostrRelayPool,
  applyDivergenceAnalysis,
  resolveDivergence,
  type CrdtPatientDocument,
  type TriageCategory,
  PeerScribeDatabase,
  DtnOutboxQueue,
  BundlePriority,
  NostrGatewayService,
  extractAndEvaluateTriage,
  extractWithDualEngine,
  OfflineWhisperEngine,
  type WhisperTranscriptionResult,
  MobilityParticleFilter,
  EmergencyWipeService,
  type IdentityKeyPair,
  encodePacket,
  PacketType,
  PacketFlags,
  crc32,
  createNostrMeshEvent,
  sha256,
  type EmergencyMedicalSnapshot,
  type ResponderRole,
  hasCapability
} from '../../core-engine/src/index.ts';

export type OperationalMode = 'DORMANT' | 'FIELD' | 'EMERGENCY';

export interface DaemonConfig {
  dbPath?: string;
  nodeId?: string;
  operationId?: string;
  initialMode?: OperationalMode;
  initialRole?: ResponderRole;
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
  rawWireHex?: string;
  decodedPayload?: any;
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
  private whisperEngine = new OfflineWhisperEngine();
  public nodeId: string;
  public keyPair: IdentityKeyPair;
  public readonly db: PeerScribeDatabase;
  public dtnOutbox: DtnOutboxQueue;
  public readonly nostrGateway: NostrGatewayService;
  public readonly wipeService: EmergencyWipeService;
  
  public currentMode: OperationalMode = 'FIELD';
  public currentRole: ResponderRole = 'MEDICAL_RESPONDER';
  public currentOperationId: string = 'OP-TACTICAL-ALPHA';
  public sectorGeohash: string = 'u15ek200';
  private particleFilter?: MobilityParticleFilter;

  // Real-time Telemetry Ring Buffers
  public recentWirePackets: WirePacketTelemetry[] = [];
  public recentNostrEvents: any[] = [];
  public recentActivityLogs: ActivityLogEntry[] = [];

  // LAN Mesh Sync & Outbox Exchange Engine
  public readonly lanSync: any;
  public lanSyncEventsLog: any[] = [];
  public lanSyncOutbox: any[] = [];

  constructor(config: DaemonConfig = {}) {
    super();
    this.keyPair = generateIdentityKeyPair();
    this.nodeId = config.nodeId || `node_${this.keyPair.publicKey.slice(-8)}`;
    this.currentMode = config.initialMode || 'FIELD';
    this.currentRole = config.initialRole || 'MEDICAL_RESPONDER';
    this.currentOperationId = config.operationId || 'OP-TACTICAL-ALPHA';

    this.db = new PeerScribeDatabase({ dbPath: config.dbPath });
    this.db.createOperation(this.currentOperationId, 'Operation Rapid Angel', this.sectorGeohash);

    this.dtnOutbox = new DtnOutboxQueue();
    this.nostrGateway = new NostrGatewayService();
    this.relayPool = new LiveNostrRelayPool(
      this.currentOperationId,
      this.sharedMeshSecret,
      ['wss://relay.damus.io', 'wss://nostr.mom'],
      this.nostrGateway
    );
    this.wipeService = new EmergencyWipeService();

    // Initialize LAN Mesh Sync Service
    this.lanSync = new LanSyncService({
      port: 4323,
      nodeId: this.nodeId,
      getState: () => ({
        eventsLog: this.lanSyncEventsLog,
        outboxQueue: this.lanSyncOutbox,
        activeOperation: { operation_id: this.currentOperationId, name: 'Disaster Field Operation' }
      }),
      onEventsIngested: (newEvents: any[], originNodeId: string) => {
        let inserted = 0;
        let divergencesCount = 0;
        for (const evt of newEvents) {
          const alreadyProcessed = this.lanSyncEventsLog.some(e => e.event_id === evt.event_id);
          if (!alreadyProcessed) {
            this.lanSyncEventsLog.push(evt);
            inserted++;
          }
          try {
            this.applyInboundEventToState(evt, originNodeId);
          } catch (e: any) {
            console.error(`[Daemon] Error applying inbound event ${evt.event_type}:`, e.message);
          }
        }
        return divergencesCount;
      },
      onOutboxAcknowledged: (ackedIds: string[]) => {
        this.lanSyncOutbox = this.lanSyncOutbox.filter(e => !ackedIds.includes(e.event_id));
        this.logActivity('CRDT', `Acknowledged ${ackedIds.length} outbox events by peer`, { ackedIds });
      }
    });

    this.lanSync.startServer().then(() => {
      if (this.lanSync.server && typeof this.lanSync.server.unref === 'function') {
        this.lanSync.server.unref();
      }
    }).catch((err: any) => {
      console.warn('[Daemon] LanSyncService server notice:', err.message);
    });

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
        this.lanSyncEventsLog = [];
        this.lanSyncOutbox = [];
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

  public generateAuditId(): string {
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
  setRole(newRole: ResponderRole): ResponderRole {
    const oldRole = this.currentRole;
    this.currentRole = newRole;
    console.log(`\x1b[35m[ROLE CHANGE]\x1b[0m Node role changed from ${oldRole} -> \x1b[1m${newRole}\x1b[0m`);
    this.logActivity('SECURITY', `Role Transition: ${oldRole} -> ${newRole}`, { oldRole, newRole });
    this.emit('roleChanged', { oldRole, newRole, timestamp: Date.now() });
    return this.currentRole;
  }

  createOperation(opId: string, name: string, sectorGeohash?: string): void {
    if (!hasCapability(this.currentRole, 'MANAGE_OPERATION')) {
      const auditId = this.generateAuditId();
      this.db.logAuditEvent(auditId, 'SYSTEM', 'AUTHORIZATION_FAILED', this.nodeId, {
        action: 'MANAGE_OPERATION',
        role: this.currentRole,
        reason: `Role ${this.currentRole} lacks MANAGE_OPERATION capability`
      });
      throw new Error(`Unauthorized: Role ${this.currentRole} lacks MANAGE_OPERATION capability`);
    }
    this.db.createOperation(opId, name, sectorGeohash);
    this.logActivity('CRDT', `Created Operation: ${opId} (${name})`, { opId, name, sectorGeohash });
  }

  switchOperation(opId: string): void {
    const op = this.db.getOperation(opId);
    if (!op) throw new Error(`Operation ${opId} does not exist`);
    const oldOp = this.currentOperationId;
    this.currentOperationId = opId;
    if (op.sector_geohash) this.sectorGeohash = op.sector_geohash;
    console.log(`\x1b[35m[OPERATION SWITCH]\x1b[0m Switched from ${oldOp} -> \x1b[1m${opId}\x1b[0m`);
    this.logActivity('CRDT', `Switched Active Operation: ${oldOp} -> ${opId}`, { oldOp, newOp: opId });
    this.emit('operationChanged', { oldOperationId: oldOp, newOperationId: opId });
  }

  finalizeOperation(opId: string): void {
    if (!hasCapability(this.currentRole, 'MANAGE_OPERATION')) {
      const auditId = this.generateAuditId();
      this.db.logAuditEvent(auditId, 'SYSTEM', 'AUTHORIZATION_FAILED', this.nodeId, {
        action: 'MANAGE_OPERATION',
        role: this.currentRole,
        reason: `Role ${this.currentRole} lacks MANAGE_OPERATION capability`
      });
      throw new Error(`Unauthorized: Role ${this.currentRole} lacks MANAGE_OPERATION capability`);
    }
    this.db.updateOperationStatus(opId, 'FINALIZING');
    this.logActivity('SECURITY', `Operation Status: ${opId} -> FINALIZING`, { opId });
  }

  archiveOperation(opId: string): any {
    if (!hasCapability(this.currentRole, 'MANAGE_OPERATION')) {
      const auditId = this.generateAuditId();
      this.db.logAuditEvent(auditId, 'SYSTEM', 'AUTHORIZATION_FAILED', this.nodeId, {
        action: 'MANAGE_OPERATION',
        role: this.currentRole,
        reason: `Role ${this.currentRole} lacks MANAGE_OPERATION capability`
      });
      throw new Error(`Unauthorized: Role ${this.currentRole} lacks MANAGE_OPERATION capability`);
    }
    const archiveInfo = this.db.archiveOperationData(opId);
    this.logActivity('SECURITY', `Operation Archived: ${opId}`, archiveInfo);
    return archiveInfo;
  }

  listOperations(): any[] {
    return this.db.listOperations();
  }


  createPatient(ephemeralId?: string): CrdtPatientDocument {
    const patientId = `PATIENT_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const ephem = ephemeralId || generateEphemeralId(this.currentOperationId, patientId).ephemeralId;

    let doc = createPatientDocument(patientId, this.currentOperationId, ephem, this.nodeId);
    this.db.savePatientDocument(doc, getActiveTriageCategory(doc));
    
    const auditId = this.generateAuditId();
    this.db.logAuditEvent(auditId, patientId, 'PATIENT_CREATED', this.nodeId, { ephemeralId: ephem });

    // Track in LAN mesh sync outbox
    const intakeEvt = {
      schema_version: 1,
      event_id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      operation_id: this.currentOperationId,
      entity_id: patientId,
      event_type: 'PATIENT_CREATED',
      actor_id: this.nodeId,
      actor_sequence: this.lanSyncEventsLog.length + 1,
      lamport_timestamp: this.lanSyncEventsLog.length + 1,
      occurred_at_utc: new Date().toISOString(),
      payload: {
        ephemeral_id: ephem,
        sector_geohash: this.sectorGeohash
      }
    };
    this.lanSyncEventsLog.push(intakeEvt);
    this.lanSyncOutbox.push(intakeEvt);

    console.log(`\x1b[32m[PATIENT INTAKE]\x1b[0m Created casualty: \x1b[1m${ephem}\x1b[0m (ID: ${patientId})`);
    this.logActivity('CRDT', `Casualty Created: ${ephem}`, { patientId, ephemeralId: ephem, auditId });

    this.emit('patientCreated', doc);
    return doc;
  }

  public resolvePatient(patientId: string, autoCreate = false): CrdtPatientDocument | null {
    let doc = this.db.getPatientDocument(patientId);
    if (!doc) {
      const all = this.listPatients();
      const match = all.find(p => p.doc.patientId === patientId || p.doc.ephemeralId === patientId);
      if (match) return match.doc;
      if (autoCreate || patientId === 'pt_001' || patientId.startsWith('pt_')) {
        return this.createPatient('RED-PANTHER-04');
      }
    }
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
      rawWireHex: wirePacket.toString('hex').toUpperCase(),
      decodedPayload: delta,
      senderPubkeyHash: this.keyPair.publicKey.substring(0, 16)
    };

    this.recentWirePackets.unshift(wireTelemetry);
    if (this.recentWirePackets.length > 30) this.recentWirePackets.pop();

    // 2. DTN Store-and-Forward Outbox (Memory Queue + Durable SQLite WAL table)
    const dtnBundle = {
      bundleId: delta.deltaId,
      operationId: this.currentOperationId,
      priority,
      hopCount: 0,
      maxHops: 15,
      createdAt: Date.now(),
      ttlMs: 3600000,
      payload: wirePacket
    };
    this.dtnOutbox.enqueue(dtnBundle);
    this.db.enqueueDtnBundle(dtnBundle);

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

    // Also track in LAN mesh sync outbox as standardized protocol schema v1 events
    if (delta && Array.isArray(delta.mutations)) {
      for (const m of delta.mutations) {
        let eventType = 'OBSERVATION_RECORDED';
        let payload: any = {};
        if (m.triage) {
          eventType = 'TRIAGE_STATUS_CHANGED';
          payload = {
            triage_category: m.triage.category,
            protocol: m.triage.protocol,
            rationale: m.triage.overrideReason || ''
          };
        } else if (m.vital) {
          eventType = 'VITALS_RECORDED';
          payload = {
            respiration_rate: m.vital.respirationRate,
            radial_pulse_present: m.vital.radialPulsePresent,
            mental_status: m.vital.mentalStatus,
            heart_rate: m.vital.heartRate,
            systolic_bp: m.vital.systolicBp,
            capillary_refill_seconds: m.vital.capillaryRefillSeconds
          };
        } else if (m.injury) {
          eventType = 'INJURY_RECORDED';
          payload = {
            location: m.injury.anatomicalLocation,
            classification: m.injury.classification,
            tourniquet_applied: m.injury.tourniquetApplied
          };
        } else if (m.medication) {
          eventType = 'MEDICATION_RECORDED';
          payload = {
            drug_name: m.medication.drugName,
            dosage: m.medication.dosage,
            route: m.medication.route
          };
        } else if (m.note) {
          eventType = 'OBSERVATION_RECORDED';
          payload = { text: m.note.text };
        } else if (m.allergy) {
          eventType = 'ALLERGY_RECORDED';
          payload = { allergy: m.allergy };
        }

        const standardEvent = {
          schema_version: 1,
          event_id: `evt_${delta.deltaId}_${Math.random().toString(36).substring(2, 6)}`,
          operation_id: this.currentOperationId,
          entity_id: patientId,
          event_type: eventType,
          actor_id: this.nodeId,
          actor_sequence: this.lanSyncEventsLog.length + 1,
          lamport_timestamp: this.lanSyncEventsLog.length + 1,
          occurred_at_utc: new Date().toISOString(),
          payload
        };
        this.lanSyncEventsLog.push(standardEvent);
        this.lanSyncOutbox.push(standardEvent);
      }
    }

    return { wireTelemetry, nostrEvent };
  }

  /**
   * Applies an inbound event received from a peer node into the local SQLite and CRDT state.
   */
  public applyInboundEventToState(evt: any, originNodeId: string): void {
    if (!evt || !evt.entity_id || !evt.event_type) return;

    let doc = this.db.getPatientDocument(evt.entity_id);

    if (evt.event_type === 'PATIENT_CREATED') {
      if (!doc) {
        doc = createPatientDocument(
          evt.entity_id,
          evt.operation_id || this.currentOperationId,
          evt.payload?.ephemeral_id || `PAT-${evt.entity_id.slice(-4)}`,
          evt.actor_id || originNodeId
        );
        this.db.savePatientDocument(doc, 'UNASSESSED');
        this.emit('patientCreated', doc);
      }
      this.logActivity('CRDT', `Inbound casualty registered: ${doc.ephemeralId}`, { originNodeId, patientId: doc.patientId });
      return;
    }

    // Auto-create doc if not present yet
    if (!doc) {
      doc = createPatientDocument(
        evt.entity_id,
        evt.operation_id || this.currentOperationId,
        evt.payload?.ephemeral_id || `PAT-${evt.entity_id.slice(-4)}`,
        originNodeId
      );
      this.db.savePatientDocument(doc, 'UNASSESSED');
      this.emit('patientCreated', doc);
    }

    let updated = false;

    switch (evt.event_type) {
      case 'TRIAGE_STATUS_CHANGED':
      case 'TRIAGE_RECORDED': {
        const cat = evt.payload?.triage_category || evt.payload?.category;
        if (cat && ['RED', 'YELLOW', 'GREEN', 'BLACK'].includes(cat)) {
          const evalEntry = {
            id: evt.event_id || `triage_${Date.now()}`,
            category: cat,
            protocol: evt.payload?.protocol || 'START_v1.0.0',
            evaluatedByNode: evt.actor_id || originNodeId,
            timestamp: Date.now(),
            logicalClock: evt.lamport_timestamp || 1,
            overrideReason: evt.payload?.overrideReason || evt.payload?.rationale || 'Synced from mesh peer'
          };
          doc.triageEvaluations.push(evalEntry);
          this.db.savePatientDocument(doc, cat);
          updated = true;
        }
        break;
      }
      case 'VITALS_RECORDED': {
        const vitalsEntry = {
          id: evt.event_id || `vitals_${Date.now()}`,
          timestamp: Date.now(),
          recordedByNode: evt.actor_id || originNodeId,
          respirationRate: evt.payload?.respirationRate ?? evt.payload?.respiration_rate,
          radialPulsePresent: evt.payload?.radialPulsePresent ?? evt.payload?.radial_pulse_present,
          mentalStatus: evt.payload?.mentalStatus ?? evt.payload?.mental_status,
          capillaryRefillSeconds: evt.payload?.capillaryRefillSeconds,
          systolicBp: evt.payload?.systolicBp ?? evt.payload?.systolic_bp,
          heartRate: evt.payload?.heartRate ?? evt.payload?.heart_rate
        };
        doc.vitals.push(vitalsEntry);
        this.db.savePatientDocument(doc, getActiveTriageCategory(doc));
        updated = true;
        break;
      }
      case 'INJURY_RECORDED': {
        const injuryEntry = {
          id: evt.event_id || `inj_${Date.now()}`,
          timestamp: Date.now(),
          recordedByNode: evt.actor_id || originNodeId,
          anatomicalLocation: evt.payload?.anatomicalLocation || evt.payload?.location || 'General Trauma',
          classification: evt.payload?.classification || evt.payload?.description || 'Injury',
          tourniquetApplied: Boolean(evt.payload?.tourniquetApplied || evt.payload?.tourniquet_applied)
        };
        doc.injuries.push(injuryEntry);
        this.db.savePatientDocument(doc, getActiveTriageCategory(doc));
        updated = true;
        break;
      }
      case 'MEDICATION_RECORDED': {
        const medEntry = {
          id: evt.event_id || `med_${Date.now()}`,
          timestamp: Date.now(),
          administeredByNode: evt.actor_id || originNodeId,
          drugName: evt.payload?.drugName || evt.payload?.drug_name || '',
          dosage: evt.payload?.dosage || '',
          route: evt.payload?.route || 'IV',
          medicSignature: evt.payload?.signature || 'VERIFIED'
        };
        doc.medications.push(medEntry);
        this.db.savePatientDocument(doc, getActiveTriageCategory(doc));
        updated = true;
        break;
      }
      case 'ALLERGY_RECORDED': {
        const allergy = evt.payload?.allergy;
        if (allergy && !doc.knownAllergies.includes(allergy)) {
          doc.knownAllergies.push(allergy);
          this.db.savePatientDocument(doc, getActiveTriageCategory(doc));
          updated = true;
        }
        break;
      }
      case 'OBSERVATION_RECORDED': {
        const noteText = evt.payload?.text || evt.payload?.note || '';
        if (noteText) {
          doc.notes.push({
            id: evt.event_id || `note_${Date.now()}`,
            timestamp: Date.now(),
            author: evt.actor_id || originNodeId,
            text: noteText
          });
          this.db.savePatientDocument(doc, getActiveTriageCategory(doc));
          updated = true;
        }
        break;
      }
      case 'VAULT_SNAPSHOT_ATTACHED': {
        if (Array.isArray(evt.payload?.allergies)) {
          for (const a of evt.payload.allergies) {
            if (!doc.knownAllergies.includes(a)) doc.knownAllergies.push(a);
          }
        }
        doc.notes.push({
          id: evt.event_id || `vault_${Date.now()}`,
          timestamp: Date.now(),
          author: evt.actor_id || originNodeId,
          text: `[EMERGENCY ID] Blood: ${evt.payload?.blood_group || evt.payload?.bloodGroup || 'UNKNOWN'} | Allergies: ${(evt.payload?.allergies || []).join(', ')}`
        });
        this.db.savePatientDocument(doc, getActiveTriageCategory(doc));
        updated = true;
        break;
      }
      case 'DIVERGENCE_ACKNOWLEDGED':
      case 'DIVERGENCE_RESOLVED': {
        this.db.savePatientDocument(doc, getActiveTriageCategory(doc));
        updated = true;
        break;
      }
    }

    if (updated) {
      this.db.logAuditEvent(this.generateAuditId(), doc.patientId, `PEER_SYNC_${evt.event_type}`, originNodeId, evt.payload);
      this.emit('patientUpdated', { patientId: doc.patientId, doc });
    }
  }

  async probePeer(peerAddress: string): Promise<any> {
    return await this.lanSync.probePeer(peerAddress);
  }

  async pairWithPeer(peerAddress: string, pairingPin: string): Promise<any> {
    const session = await this.lanSync.pairWithPeer(peerAddress, pairingPin);
    this.logActivity('CRDT', `Paired with peer node ${session.serverNodeId} (${peerAddress})`, {
      peerAddress,
      serverNodeId: session.serverNodeId
    });
    return session;
  }

  async syncWithPeer(peerAddress: string, pairingPin?: string): Promise<any> {
    const result = await this.lanSync.syncWithPeer(peerAddress, pairingPin);
    this.logActivity('CRDT', `Synchronized with peer ${peerAddress}: Sent ${result.eventsSent}, Received ${result.eventsReceived}`, result);
    return result;
  }

  getLanSyncInfo(): any {
    return {
      nodeId: this.lanSync.nodeId,
      port: this.lanSync.port,
      ipAddresses: this.lanSync.getLocalIpAddresses(),
      pairingPin: this.lanSync.getPairingPin(),
      peers: this.lanSync.getPeersList(),
      outboxCount: this.lanSyncOutbox.length
    };
  }

  setPairingPin(pin: string): string {
    return this.lanSync.setPairingPin(pin);
  }

  recordTriage(
    patientId: string,
    category: TriageCategory,
    protocol = 'START_v1.0.0',
    overrideReason?: string
  ): { doc: CrdtPatientDocument; activeTriage: TriageCategory; divergences: any[]; wireTelemetry: WirePacketTelemetry } {
    if (!hasCapability(this.currentRole, 'OVERRIDE_TRIAGE')) {
      const auditId = this.generateAuditId();
      this.db.logAuditEvent(auditId, patientId, 'AUTHORIZATION_FAILED', this.nodeId, {
        action: 'OVERRIDE_TRIAGE',
        role: this.currentRole,
        reason: `Role ${this.currentRole} lacks OVERRIDE_TRIAGE capability`
      });
      throw new Error(`Unauthorized: Role ${this.currentRole} lacks OVERRIDE_TRIAGE capability`);
    }
    let doc = this.resolvePatient(patientId, true)!;
    patientId = doc.patientId;

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
    vitalsInput: {
      respirationRate?: number;
      pulseRate?: number;
      radialPulsePresent?: boolean;
      mentalStatus?: 'NORMAL' | 'ALTERED' | 'UNRESPONSIVE';
      spO2?: number;
      systolicBp?: number;
      capillaryRefillSeconds?: number;
    }
  ): CrdtPatientDocument {
    let doc = this.resolvePatient(patientId, true)!;
    patientId = doc.patientId;

    const { updatedDoc, delta } = recordVitals(doc, this.nodeId, {
      respirationRate: vitalsInput.respirationRate,
      radialPulsePresent: vitalsInput.radialPulsePresent,
      mentalStatus: vitalsInput.mentalStatus,
      heartRate: vitalsInput.pulseRate,
      systolicBp: vitalsInput.systolicBp,
      capillaryRefillSeconds: vitalsInput.capillaryRefillSeconds
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
    route = 'IV',
    forceOverride = false
  ): { doc: CrdtPatientDocument; divergences: any[] } {
    if (!hasCapability(this.currentRole, 'ADMINISTER_MEDICATION')) {
      const auditId = this.generateAuditId();
      this.db.logAuditEvent(auditId, patientId, 'AUTHORIZATION_FAILED', this.nodeId, {
        action: 'ADMINISTER_MEDICATION',
        role: this.currentRole,
        reason: `Role ${this.currentRole} lacks ADMINISTER_MEDICATION capability`
      });
      throw new Error(`Unauthorized: Role ${this.currentRole} lacks ADMINISTER_MEDICATION capability`);
    }
    let doc = this.resolvePatient(patientId, true)!;
    patientId = doc.patientId;

    // Safety pre-check: verify against known patient allergies before administration
    if (doc.knownAllergies && doc.knownAllergies.length > 0) {
      for (const allergy of doc.knownAllergies) {
        if (isAllergyCollision(drugName, allergy)) {
          if (!forceOverride) {
            const auditId = this.generateAuditId();
            this.db.logAuditEvent(auditId, patientId, 'MEDICATION_BLOCKED_ALLERGY', this.nodeId, {
              drugName,
              allergy,
              dosage,
              route,
              reason: `FATAL RISK: ${drugName} collides with documented allergy to ${allergy}`
            });
            throw new Error(`ALLERGY_COLLISION: ${drugName} conflicts with documented allergy (${allergy}). Administration blocked without explicit clinician override.`);
          }
        }
      }
    }

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
    if (!hasCapability(this.currentRole, 'RESOLVE_DIVERGENCE')) {
      const auditId = this.generateAuditId();
      this.db.logAuditEvent(auditId, patientId, 'AUTHORIZATION_FAILED', this.nodeId, {
        action: 'RESOLVE_DIVERGENCE',
        role: this.currentRole,
        reason: `Role ${this.currentRole} lacks RESOLVE_DIVERGENCE capability`
      });
      throw new Error(`Unauthorized: Role ${this.currentRole} lacks RESOLVE_DIVERGENCE capability`);
    }
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

  recordInjury(
    patientId: string,
    location: string,
    classification: string,
    tourniquetApplied = false
  ): CrdtPatientDocument {
    let doc = this.resolvePatient(patientId, true)!;
    patientId = doc.patientId;

    const { updatedDoc, delta } = recordInjury(doc, this.nodeId, location, classification, tourniquetApplied);
    const activeTriage = getActiveTriageCategory(updatedDoc);
    this.db.savePatientDocument(updatedDoc, activeTriage);
    this.db.logAuditEvent(this.generateAuditId(), patientId, 'INJURY_RECORDED', this.nodeId, { location, classification, tourniquetApplied });

    this.packageAndPropagateDelta(delta, patientId, updatedDoc.ephemeralId, BundlePriority.CLINICAL_DELTA, 'CLINICAL_DELTA');
    this.emit('patientUpdated', { doc: updatedDoc, activeTriage });
    return updatedDoc;
  }

  recordNote(
    patientId: string,
    text: string
  ): CrdtPatientDocument {
    let doc = this.resolvePatient(patientId, true)!;
    patientId = doc.patientId;

    const { updatedDoc, delta } = recordNote(doc, this.nodeId, text);
    const activeTriage = getActiveTriageCategory(updatedDoc);
    this.db.savePatientDocument(updatedDoc, activeTriage);
    this.db.logAuditEvent(this.generateAuditId(), patientId, 'NOTE_RECORDED', this.nodeId, { text });

    const priority = activeTriage === 'RED' ? BundlePriority.CRITICAL_SOS : BundlePriority.CLINICAL_DELTA;
    const priorityName = activeTriage === 'RED' ? 'CRITICAL_SOS' : 'CLINICAL_DELTA';
    this.packageAndPropagateDelta(delta, patientId, updatedDoc.ephemeralId, priority, priorityName);
    this.emit('patientUpdated', { doc: updatedDoc, activeTriage });
    return updatedDoc;
  }

  attachEmergencySnapshot(
    patientId: string,
    snapshot: EmergencyMedicalSnapshot
  ): { doc: CrdtPatientDocument; activeTriage: TriageCategory | 'UNASSESSED'; divergences: any[] } {
    let doc = this.resolvePatient(patientId, true)!;
    patientId = doc.patientId;

    // Attach allergies from emergency snapshot
    const mergedAllergies = Array.from(new Set([...(doc.knownAllergies || []), ...(snapshot.allergies || [])]));
    doc.knownAllergies = mergedAllergies;
    if (snapshot.bloodGroup) doc.bloodGroup = snapshot.bloodGroup;

    // Attach emergency snapshot summary note
    const summary = `[EMERGENCY MEDICAL ID ATTACHED] Blood Group: ${snapshot.bloodGroup || 'UNKNOWN'} | Allergies: ${(snapshot.allergies || []).join(', ') || 'None'} | Conditions: ${(snapshot.criticalConditions || []).join(', ') || 'None'}`;
    const { updatedDoc: docWithNote, delta } = recordNote(doc, this.nodeId, summary);
    doc = docWithNote;

    // Check for drug allergy collision or semantic divergence
    const divergences = analyzeSemanticSafety(doc);
    const analyzedDoc = applyDivergenceAnalysis(doc);
    const activeTriage = getActiveTriageCategory(analyzedDoc);

    this.db.savePatientDocument(analyzedDoc, activeTriage);
    this.db.logAuditEvent(this.generateAuditId(), patientId, 'VAULT_SNAPSHOT_ATTACHED', this.nodeId, {
      bloodGroup: snapshot.bloodGroup,
      allergies: snapshot.allergies,
      divergences
    });

    this.packageAndPropagateDelta(delta, patientId, analyzedDoc.ephemeralId, BundlePriority.CLINICAL_DELTA, 'CLINICAL_DELTA');
    this.logActivity('SECURITY', `Attached Medical ID to ${analyzedDoc.ephemeralId}`, { bloodGroup: snapshot.bloodGroup, allergies: snapshot.allergies });
    this.emit('patientUpdated', { doc: analyzedDoc, activeTriage, divergences });
    return { doc: analyzedDoc, activeTriage, divergences };
  }

  async transcribeAudio(audioBuffer: Buffer | Uint8Array | Float32Array): Promise<WhisperTranscriptionResult> {
    return await this.whisperEngine.transcribeAudio(audioBuffer);
  }

  async processVoiceAudio(audioBuffer: Buffer | Uint8Array | Float32Array, patientId?: string): Promise<any> {
    const whisperResult = await this.whisperEngine.transcribeAudio(audioBuffer);
    const clinicalResult = this.processVoiceTranscript(whisperResult.transcript, patientId);
    return {
      whisper: whisperResult,
      ...clinicalResult
    };
  }

  processVoiceTranscript(transcript: string, patientId?: string): any {
    const aiResult = extractWithDualEngine(transcript, { preferSlm: true });
    
    let targetDoc: CrdtPatientDocument | null = null;

    if (patientId) {
      // 1. Direct lookup by patient ID (primary key)
      targetDoc = this.db.getPatientDocument(patientId);

      // 2. Fallback: search all patients by ephemeral ID prefix (handles pt_xxx frontend IDs)
      if (!targetDoc) {
        const allPatients = this.listPatients();
        const byEphemeral = allPatients.find(p => p.doc.patientId === patientId || p.doc.ephemeralId === patientId);
        if (byEphemeral) targetDoc = byEphemeral.doc;
      }
    }

    // 3. If no patient found (truly new voice intake), use the active/most-recent patient or create one
    if (!targetDoc) {
      const existingPatients = this.listPatients();
      if (existingPatients.length > 0) {
        // Attach to most recently updated patient if no specific ID given
        targetDoc = existingPatients[0].doc;
      } else {
        targetDoc = this.createPatient();
      }
    }

    // 1. Record vitals if mentioned
    if (aiResult.observation.respirationRate || aiResult.observation.radialPulsePresent !== undefined) {
      this.recordVitals(targetDoc.patientId, {
        respirationRate: aiResult.observation.respirationRate,
        radialPulsePresent: aiResult.observation.radialPulsePresent
      });
    }

    // 2. Record extracted injuries if mentioned (e.g. broken leg, compound fracture, trapped)
    if (aiResult.observation.injuries && aiResult.observation.injuries.length > 0) {
      for (const inj of aiResult.observation.injuries) {
        this.recordInjury(targetDoc.patientId, 'General Trauma', inj);
      }
    }

    // 3. Always attach raw situational voice transcript as a clinical distress note
    this.recordNote(targetDoc.patientId, `[VOICE DISTRESS TRANSMISSION] "${transcript}"`);

    // 4. Record START Triage outcome
    const triageReason = aiResult.triageResult.rationale || (
      aiResult.observation.injuries.length > 0
        ? `Edge AI parsed: ${aiResult.observation.injuries.join(', ')}`
        : 'Extracted via Edge AI speech input'
    );
    const triageOutcome = this.recordTriage(
      targetDoc.patientId,
      aiResult.triageResult.category,
      aiResult.triageResult.protocol || 'START_v1.0.0',
      triageReason
    );

    console.log(`\x1b[36m[EDGE AI SPEECH]\x1b[0m Parsed: "${transcript}" -> START Triage: \x1b[1m${aiResult.triageResult.category}\x1b[0m (${triageReason})`);
    this.logActivity('AI', `Voice Extracted -> Triage: ${aiResult.triageResult.category}`, {
      transcript,
      vitals: aiResult.observation,
      injuries: aiResult.observation.injuries
    });

    return {
      patientId: targetDoc.patientId,
      observation: aiResult.observation,
      triageResult: {
        category: aiResult.triageResult.category,
        protocolApplied: aiResult.triageResult.protocol || 'START_v1.0.0',
        reason: triageReason
      },
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
      currentRole: this.currentRole,
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

  async close(): Promise<void> {
    if (this.lanSync && typeof this.lanSync.stopServer === 'function') {
      try {
        await this.lanSync.stopServer();
      } catch (_) {}
    }
    if (this.db) {
      try {
        this.db.close();
      } catch (_) {}
    }
  }
}
