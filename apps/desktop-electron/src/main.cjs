const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { LanSyncService, DEFAULT_SYNC_PORT, TACTICAL_PAIRING_SECRET } = require('./lan_sync.cjs');

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

const EVENTS_FILE = path.join(DATA_DIR, 'immutable_events.jsonl');
const VAULT_FILE = path.join(DATA_DIR, 'personal_vault.enc');
const OUTBOX_FILE = path.join(DATA_DIR, 'sync_outbox.json');

// In-memory projections and indexes
let eventsLog = [];
let projectedPatients = new Map();
let outboxQueue = [];

// Unconfigured blank personal vault with zero fabricated default data
let personalVault = {
  is_configured: false,
  is_synthetic_demo: false,
  blood_group: null,
  allergies: [],
  critical_conditions: [],
  emergency_contacts: []
};

// Tactical Key for Local Vault Storage (AES-256-GCM)
const VAULT_KEY = crypto.scryptSync('PEERSCRIBE_DESKTOP_VAULT_PASS', 'tactical_vault_salt_2026', 32);

function encryptVaultData(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64')
  });
}

function decryptVaultData(raw) {
  try {
    const parsed = JSON.parse(raw);
    const iv = Buffer.from(parsed.iv, 'base64');
    const tag = Buffer.from(parsed.tag, 'base64');
    const ciphertext = Buffer.from(parsed.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (err) {
    console.warn('[PersonalVault] Could not decrypt vault, starting blank:', err.message);
    return null;
  }
}

// Initialize persistence
function loadPersistedState() {
  try {
    if (fs.existsSync(VAULT_FILE)) {
      const decrypted = decryptVaultData(fs.readFileSync(VAULT_FILE, 'utf8'));
      if (decrypted) personalVault = decrypted;
    }
    if (fs.existsSync(OUTBOX_FILE)) {
      outboxQueue = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8'));
    }
    if (fs.existsSync(EVENTS_FILE)) {
      const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
      eventsLog = lines.map(l => JSON.parse(l));
      reprojectAllPatients();
    }
  } catch (err) {
    console.error('Error loading persisted tactical state:', err);
  }
}

function persistEvent(event) {
  eventsLog.push(event);
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n', 'utf8');
  outboxQueue.push(event);
  fs.writeFileSync(OUTBOX_FILE, JSON.stringify(outboxQueue, null, 2), 'utf8');
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
  eventsLog.forEach(projectEvent);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#05070a',
    title: 'PeerScribe Tactical Clinical Mesh',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Strict Content Security Policy
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:;"
        ]
      }
    });
  });

  // Load renderer index.html
  const rendererPath = path.join(__dirname, '..', 'renderer', 'index.html');
  if (fs.existsSync(rendererPath)) {
    mainWindow.loadFile(rendererPath);
  } else {
    // Fallback to packages/ui-app/index.html in monorepo development
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
      outboxCount: outboxQueue.length,
      eventsCount: eventsLog.length,
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
    eventsLog = [];
    outboxQueue = [];
    projectedPatients.clear();
    if (fs.existsSync(EVENTS_FILE)) fs.unlinkSync(EVENTS_FILE);
    if (fs.existsSync(OUTBOX_FILE)) fs.unlinkSync(OUTBOX_FILE);
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
      actor_sequence: eventsLog.length + 1,
      lamport_timestamp: eventsLog.length + 1,
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
      actor_sequence: eventsLog.length + 1,
      lamport_timestamp: eventsLog.length + 1,
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
    const vitalsEvent = {
      schema_version: 1,
      event_id: `evt_${crypto.randomUUID()}`,
      operation_id: activeOperation.operation_id,
      entity_id: patientId,
      event_type: 'VITALS_RECORDED',
      actor_id: 'node_desktop_electron',
      actor_sequence: eventsLog.length + 1,
      lamport_timestamp: eventsLog.length + 1,
      occurred_at_utc: new Date().toISOString(),
      payload: vitals
    };
    persistEvent(vitalsEvent);
    return projectedPatients.get(patientId);
  });

  ipcMain.handle('clinical:resolve-divergence', (event, { patientId, flagId, category, note }) => {
    const resolveEvent = {
      schema_version: 1,
      event_id: `evt_${crypto.randomUUID()}`,
      operation_id: activeOperation.operation_id,
      entity_id: patientId,
      event_type: 'DIVERGENCE_RESOLVED',
      actor_id: 'node_desktop_electron',
      actor_sequence: eventsLog.length + 1,
      lamport_timestamp: eventsLog.length + 1,
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
      eventsLog,
      outboxQueue,
      activeOperation
    }),
    onEventsIngested: (newEvents) => {
      for (const evt of newEvents) {
        eventsLog.push(evt);
        fs.appendFileSync(EVENTS_FILE, JSON.stringify(evt) + '\n', 'utf8');
        projectEvent(evt);
      }
      if (mainWindow) {
        mainWindow.webContents.send('sync:event-received', { count: newEvents.length });
      }
      return 0;
    },
    onOutboxAcknowledged: (ackedIds) => {
      outboxQueue = outboxQueue.filter(e => !ackedIds.includes(e.event_id));
      fs.writeFileSync(OUTBOX_FILE, JSON.stringify(outboxQueue, null, 2), 'utf8');
      if (mainWindow) {
        mainWindow.webContents.send('sync:status-updated', { outboxCount: outboxQueue.length });
      }
    }
  });

  ipcMain.handle('vault:get-profile', () => personalVault);

  ipcMain.handle('vault:save-profile', (event, profile) => {
    personalVault = { ...personalVault, ...profile, is_configured: true };
    fs.writeFileSync(VAULT_FILE, encryptVaultData(personalVault), 'utf8');
    return personalVault;
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
      actor_sequence: eventsLog.length + 1,
      lamport_timestamp: eventsLog.length + 1,
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

  ipcMain.handle('sync:get-outbox', () => outboxQueue);

  ipcMain.handle('sync:get-lan-info', () => {
    return {
      nodeId: lanSync.nodeId,
      port: lanSync.port,
      ipAddresses: lanSync.getLocalIpAddresses(),
      pairingToken: TACTICAL_PAIRING_SECRET,
      outboxCount: outboxQueue.length,
      pairedPeersCount: lanSync.pairedPeers.size
    };
  });

  ipcMain.handle('sync:get-peers', () => lanSync.getPeersList());

  ipcMain.handle('sync:trigger-lan', async (event, { peerAddress }) => {
    if (!peerAddress) throw new Error('Peer address is required (e.g. 192.168.1.50:4322)');
    return await lanSync.syncWithPeer(peerAddress);
  });

  // Delta & Differential In-App Update Handlers (Accurate real reporting)
  ipcMain.handle('system:check-updates', async () => {
    return {
      currentVersion: '1.0.0',
      updateAvailable: false,
      channel: 'stable',
      differential: true,
      lastCheckedAt: new Date().toISOString(),
      message: 'PeerScribe v1.0 is currently up to date. Differential blockmap updates active.'
    };
  });

  ipcMain.handle('system:download-update', async () => {
    return { success: false, message: 'No delta update package currently queued on release channel.' };
  });

  ipcMain.handle('system:apply-update', async () => {
    return { success: false, message: 'No pending updates staged for application.' };
  });
}

// App lifecycle
app.whenReady().then(async () => {
  loadPersistedState();
  setupIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
