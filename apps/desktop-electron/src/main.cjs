const { app, BrowserWindow, ipcMain, session, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { LanSyncService, DEFAULT_SYNC_PORT } = require('./lan_sync.cjs');
const { getOrCreateVaultKey, encryptVault, decryptVault } = require('./vault_crypto.cjs');
const { TacticalStorageEngine } = require('./persistence_store.cjs');

// Tactical Node Identity & Local Store
let mainWindow = null;
let appMode = 'FIELD'; // DORMANT | FIELD | EMERGENCY | FINALIZING
let activeOperation = {
  operation_id: 'OP_LOCAL_DEFAULT',
  name: 'Disaster Field Mesh Operation',
  started_at: new Date().toISOString(),
  status: 'ACTIVE'
};

const DATA_DIR = path.join(app.getPath('userData'), 'peerscribe_tactical');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const VAULT_FILE = path.join(DATA_DIR, 'personal_vault.enc');
const KEY_FILE = path.join(DATA_DIR, 'vault.key');

// Crash-Consistent Persistence Engine
const storageEngine = new TacticalStorageEngine(DATA_DIR);

// In-memory clinical projection
let projectedPatients = new Map();

// Personal vault state: UNCONFIGURED | DECRYPTED | KEY_UNAVAILABLE | CORRUPTED
let vaultState = 'UNCONFIGURED';
let personalVault = {
  is_configured: false,
  is_synthetic_demo: false,
  blood_group: null,
  allergies: [],
  critical_conditions: [],
  emergency_contacts: []
};

// Protected Key for Local Vault Storage (AES-256-GCM via Windows DPAPI / safeStorage)
let vaultKey = null;
function getVaultKey() {
  if (!vaultKey) {
    vaultKey = getOrCreateVaultKey(KEY_FILE, { safeStorage });
  }
  return vaultKey;
}

function encryptVaultData(data) {
  return encryptVault(data, getVaultKey());
}

function decryptVaultData(raw) {
  return decryptVault(raw, getVaultKey());
}

function loadPersistedVault() {
  if (fs.existsSync(VAULT_FILE)) {
    try {
      const raw = fs.readFileSync(VAULT_FILE, 'utf8');
      const decrypted = decryptVaultData(raw);
      if (decrypted) {
        personalVault = decrypted;
        vaultState = 'DECRYPTED';
      } else {
        vaultState = 'CORRUPTED';
      }
    } catch (err) {
      console.error('[PersonalVault] Failed to decrypt existing vault:', err.message);
      vaultState = 'CORRUPTED';
    }
  } else {
    vaultState = 'UNCONFIGURED';
  }
}

// Initialize persistence
function loadPersistedState() {
  try {
    loadPersistedVault();
    storageEngine.recoverState();
    reprojectAllPatients();
  } catch (err) {
    console.error('Error loading persisted tactical state:', err);
  }
}

function persistEvent(event) {
  storageEngine.persistEvent(event);
  projectEvent(event);
}

function projectEvent(event) {
  let patient = projectedPatients.get(event.entity_id);
  if (!patient && event.event_type === 'PATIENT_CREATED') {
    patient = {
      patient_id: event.entity_id,
      operation_id: event.operation_id,
      ephemeral_id: event.payload.ephemeral_id || 'PAT-01',
      active_triage: 'UNASSESSED',
      created_at_utc: event.occurred_at_utc,
      updated_at_utc: event.occurred_at_utc,
      vitals: [],
      injuries: [],
      medications: [],
      known_allergies: [],
      notes: [],
      divergence_flags: []
    };
    projectedPatients.set(event.entity_id, patient);
  }

  if (!patient) return;
  patient.updated_at_utc = event.occurred_at_utc;

  switch (event.event_type) {
    case 'VITALS_RECORDED':
      patient.vitals.push({ event_id: event.event_id, ...event.payload });
      break;
    case 'INJURY_RECORDED':
      patient.injuries.push({ event_id: event.event_id, ...event.payload });
      break;
    case 'MEDICATION_RECORDED':
      patient.medications.push({ event_id: event.event_id, ...event.payload });
      break;
    case 'ALLERGY_RECORDED':
      if (event.payload.allergy && !patient.known_allergies.includes(event.payload.allergy)) {
        patient.known_allergies.push(event.payload.allergy);
      }
      break;
    case 'TRIAGE_STATUS_CHANGED':
      patient.active_triage = event.payload.triage_category || patient.active_triage;
      break;
    case 'VAULT_SNAPSHOT_ATTACHED':
      if (Array.isArray(event.payload.allergies)) {
        event.payload.allergies.forEach(a => {
          if (!patient.known_allergies.includes(a)) patient.known_allergies.push(a);
        });
      }
      patient.notes.push({
        event_id: event.event_id,
        text: `[EMERGENCY ID] Blood: ${event.payload.blood_group} | Allergies: ${(event.payload.allergies || []).join(', ')}`
      });
      break;
    case 'DIVERGENCE_ACKNOWLEDGED':
      patient.divergence_flags.push({ flag_id: event.payload.flag_id || event.event_id, resolved: false, ...event.payload });
      break;
    case 'DIVERGENCE_RESOLVED':
      patient.active_triage = event.payload.resolved_category || patient.active_triage;
      patient.divergence_flags.forEach(f => {
        if (f.flag_id === event.payload.flag_id || !event.payload.flag_id) {
          f.resolved = true;
          f.resolved_by = event.actor_id;
          f.resolution_note = event.payload.clinician_signoff_note;
        }
      });
      break;
  }
}

function reprojectAllPatients() {
  projectedPatients.clear();
  for (const event of storageEngine.eventsLog) {
    projectEvent(event);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0a0d14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  // Strict CSP Header
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: http: https:;"
        ]
      }
    });
  });

  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    const devPath = path.resolve(__dirname, '..', '..', '..', 'packages', 'ui-app', 'index.html');
    mainWindow.loadFile(devPath);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Setup IPC Handlers
function setupIpcHandlers() {
  ipcMain.handle('system:get-status', () => {
    return {
      mode: appMode,
      activeOperation,
      outboxCount: storageEngine.outboxQueue.length,
      eventsCount: storageEngine.eventsLog.length,
      patientsCount: projectedPatients.size,
      divergencesCount: Array.from(projectedPatients.values())
        .flatMap(p => p.divergence_flags)
        .filter(f => !f.resolved).length,
      storagePath: DATA_DIR
    };
  });

  ipcMain.handle('system:set-mode', (event, mode) => {
    appMode = mode;
    return { success: true, mode: appMode };
  });

  ipcMain.handle('system:wipe-data', () => {
    storageEngine.wipeOperationalData();
    projectedPatients.clear();
    return { success: true };
  });

  ipcMain.handle('operation:get-active', () => activeOperation);

  ipcMain.handle('operation:create', (event, opData) => {
    activeOperation = {
      operation_id: `OP_${Date.now()}`,
      name: opData.name || 'New Disaster Field Operation',
      started_at: new Date().toISOString(),
      status: 'ACTIVE'
    };
    return activeOperation;
  });

  ipcMain.handle('patient:list', () => Array.from(projectedPatients.values()));

  ipcMain.handle('patient:get', (event, patientId) => projectedPatients.get(patientId) || null);

  ipcMain.handle('patient:create', (event, payload) => {
    const patientId = `pt_${crypto.randomUUID()}`;
    const newEvent = {
      schema_version: 1,
      event_id: `evt_${crypto.randomUUID()}`,
      operation_id: activeOperation.operation_id,
      entity_id: patientId,
      event_type: 'PATIENT_CREATED',
      actor_id: 'node_desktop_electron',
      actor_sequence: storageEngine.eventsLog.length + 1,
      lamport_timestamp: storageEngine.eventsLog.length + 1,
      occurred_at_utc: new Date().toISOString(),
      payload: {
        ephemeral_id: payload.ephemeral_id || `TAG-${Math.floor(1000 + Math.random() * 9000)}`,
        sector_geohash: payload.sector || 'TACTICAL-SEC-1'
      }
    };
    persistEvent(newEvent);
    return projectedPatients.get(patientId);
  });

  ipcMain.handle('clinical:change-triage', (event, { patientId, category, rationale }) => {
    const patient = projectedPatients.get(patientId);
    if (!patient) throw new Error('Patient not found');

    const triageEvent = {
      schema_version: 1,
      event_id: `evt_${crypto.randomUUID()}`,
      operation_id: activeOperation.operation_id,
      entity_id: patientId,
      event_type: 'TRIAGE_STATUS_CHANGED',
      actor_id: 'node_desktop_electron',
      actor_sequence: storageEngine.eventsLog.length + 1,
      lamport_timestamp: storageEngine.eventsLog.length + 1,
      occurred_at_utc: new Date().toISOString(),
      payload: {
        triage_category: category,
        protocol: 'START_ADULT_v1.0',
        rationale: rationale || 'Manual clinical assessment'
      }
    };
    persistEvent(triageEvent);
    return projectedPatients.get(patientId);
  });

  ipcMain.handle('clinical:record-vitals', (event, { patientId, vitals }) => {
    const patient = projectedPatients.get(patientId);
    if (!patient) throw new Error('Patient not found');

    const vitalsEvent = {
      schema_version: 1,
      event_id: `evt_${crypto.randomUUID()}`,
      operation_id: activeOperation.operation_id,
      entity_id: patientId,
      event_type: 'VITALS_RECORDED',
      actor_id: 'node_desktop_electron',
      actor_sequence: storageEngine.eventsLog.length + 1,
      lamport_timestamp: storageEngine.eventsLog.length + 1,
      occurred_at_utc: new Date().toISOString(),
      payload: {
        heart_rate: vitals.heart_rate,
        respiratory_rate: vitals.respiratory_rate,
        systolic_bp: vitals.systolic_bp,
        spo2: vitals.spo2,
        avpu_scale: vitals.avpu_scale || 'ALERT'
      }
    };
    persistEvent(vitalsEvent);
    return projectedPatients.get(patientId);
  });

  ipcMain.handle('clinical:record-injury', (event, { patientId, injury }) => {
    const patient = projectedPatients.get(patientId);
    if (!patient) throw new Error('Patient not found');

    const injuryEvent = {
      schema_version: 1,
      event_id: `evt_${crypto.randomUUID()}`,
      operation_id: activeOperation.operation_id,
      entity_id: patientId,
      event_type: 'INJURY_RECORDED',
      actor_id: 'node_desktop_electron',
      actor_sequence: storageEngine.eventsLog.length + 1,
      lamport_timestamp: storageEngine.eventsLog.length + 1,
      occurred_at_utc: new Date().toISOString(),
      payload: {
        body_part: injury.body_part,
        injury_type: injury.injury_type,
        severity: injury.severity || 'MODERATE'
      }
    };
    persistEvent(injuryEvent);
    return projectedPatients.get(patientId);
  });

  ipcMain.handle('clinical:resolve-divergence', (event, { patientId, flagId, category, note }) => {
    const patient = projectedPatients.get(patientId);
    if (!patient) throw new Error('Patient not found');

    const resolveEvent = {
      schema_version: 1,
      event_id: `evt_${crypto.randomUUID()}`,
      operation_id: activeOperation.operation_id,
      entity_id: patientId,
      event_type: 'DIVERGENCE_RESOLVED',
      actor_id: 'node_desktop_electron',
      actor_sequence: storageEngine.eventsLog.length + 1,
      lamport_timestamp: storageEngine.eventsLog.length + 1,
      occurred_at_utc: new Date().toISOString(),
      payload: {
        flag_id: flagId,
        resolved_category: category,
        clinician_signoff_note: note
      }
    };
    persistEvent(resolveEvent);
    return projectedPatients.get(patientId);
  });

  // Lan Sync Instance
  const lanSync = new LanSyncService({
    port: 4323,
    nodeId: 'node_desktop_electron',
    getState: () => ({
      eventsLog: storageEngine.eventsLog,
      outboxQueue: storageEngine.outboxQueue,
      activeOperation
    }),
    onEventsIngested: (newEvents) => {
      for (const evt of newEvents) {
        storageEngine.persistEvent(evt);
        projectEvent(evt);
      }
      if (mainWindow) {
        mainWindow.webContents.send('sync:event-received', { count: newEvents.length });
        mainWindow.webContents.send('sync:status-updated', { outboxCount: storageEngine.outboxQueue.length });
      }
      return 0;
    },
    onOutboxAcknowledged: (ackedIds) => {
      storageEngine.acknowledgeEvents(ackedIds);
      if (mainWindow) {
        mainWindow.webContents.send('sync:status-updated', { outboxCount: storageEngine.outboxQueue.length });
      }
    }
  });

  ipcMain.handle('vault:get-profile', () => {
    if (vaultState === 'CORRUPTED') {
      return {
        error: 'VAULT_CORRUPTED',
        message: 'Personal profile vault is corrupted or authentication tag mismatch. Existing data preserved.',
        is_configured: true,
        vaultState
      };
    }
    if (vaultState === 'KEY_UNAVAILABLE') {
      return {
        error: 'KEY_UNAVAILABLE',
        message: 'Platform secure storage key is unavailable. Profile data is preserved on disk.',
        is_configured: true,
        vaultState
      };
    }
    return { ...personalVault, vaultState };
  });

  ipcMain.handle('vault:save-profile', (event, profile) => {
    if (vaultState === 'CORRUPTED' || vaultState === 'KEY_UNAVAILABLE') {
      throw new Error(`Cannot save profile: Personal vault is in ${vaultState} state. Preserving existing encrypted data. An explicit reset is required.`);
    }
    personalVault = { ...personalVault, ...profile, is_configured: true };
    fs.writeFileSync(VAULT_FILE, encryptVaultData(personalVault), 'utf8');
    vaultState = 'DECRYPTED';
    return personalVault;
  });

  ipcMain.handle('vault:reset', () => {
    if (fs.existsSync(VAULT_FILE)) {
      fs.unlinkSync(VAULT_FILE);
    }
    personalVault = {
      is_configured: false,
      is_synthetic_demo: false,
      blood_group: null,
      allergies: [],
      critical_conditions: [],
      emergency_contacts: []
    };
    vaultState = 'UNCONFIGURED';
    return { success: true };
  });

  ipcMain.handle('vault:load-demo', () => {
    personalVault = {
      is_configured: true,
      is_synthetic_demo: true,
      blood_group: 'O+ (DEMO)',
      allergies: ['Penicillin (SYNTHETIC DEMO)', 'Sulfa (SYNTHETIC DEMO)'],
      critical_conditions: ['Asthma (SYNTHETIC DEMO)'],
      emergency_contacts: [
        { name: 'Synthetic Demo Contact', relation: 'Simulated', phone: '+0-000-000-0000' }
      ]
    };
    fs.writeFileSync(VAULT_FILE, encryptVaultData(personalVault), 'utf8');
    vaultState = 'DECRYPTED';
    return personalVault;
  });

  ipcMain.handle('vault:disclose-snapshot', (event, { patientId }) => {
    if (!personalVault.is_configured) {
      throw new Error('Personal profile vault has not been configured.');
    }
    const snapshotEvent = {
      schema_version: 1,
      event_id: `evt_${crypto.randomUUID()}`,
      operation_id: activeOperation.operation_id,
      entity_id: patientId,
      event_type: 'VAULT_SNAPSHOT_ATTACHED',
      actor_id: 'node_desktop_electron',
      actor_sequence: storageEngine.eventsLog.length + 1,
      lamport_timestamp: storageEngine.eventsLog.length + 1,
      occurred_at_utc: new Date().toISOString(),
      payload: {
        blood_group: personalVault.blood_group,
        allergies: personalVault.allergies,
        critical_conditions: personalVault.critical_conditions,
        emergency_contacts: personalVault.emergency_contacts,
        is_synthetic_demo: personalVault.is_synthetic_demo
      }
    };
    persistEvent(snapshotEvent);
    return projectedPatients.get(patientId);
  });

  ipcMain.handle('sync:get-outbox', () => storageEngine.outboxQueue);

  ipcMain.handle('sync:get-lan-info', () => {
    return {
      nodeId: lanSync.nodeId,
      port: lanSync.port,
      ipAddresses: lanSync.getLocalIpAddresses(),
      pairingPin: lanSync.getPairingPin(),
      outboxCount: storageEngine.outboxQueue.length,
      pairedPeersCount: lanSync.activeSessions.size
    };
  });

  ipcMain.handle('sync:pair-peer', async (event, { peerAddress, pairingPin }) => {
    if (!peerAddress || !pairingPin) throw new Error('Peer address and pairing PIN are required');
    return await lanSync.pairWithPeer(peerAddress, pairingPin);
  });

  ipcMain.handle('sync:get-peers', () => Array.from(lanSync.activeSessions.values()).map(s => ({
    sessionId: s.sessionId,
    peerId: s.peerId,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt
  })));

  ipcMain.handle('sync:trigger-lan', async (event, { peerAddress, pairingPin }) => {
    return await lanSync.syncWithPeer(peerAddress, pairingPin);
  });

  // Start LAN service
  lanSync.startServer().catch(err => console.error('Failed to start LAN sync server:', err));
}

// App Lifecycle
app.whenReady().then(() => {
  loadPersistedState();
  setupIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
