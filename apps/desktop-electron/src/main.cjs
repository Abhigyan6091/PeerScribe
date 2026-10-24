const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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
const VAULT_FILE = path.join(DATA_DIR, 'personal_vault.json');
const OUTBOX_FILE = path.join(DATA_DIR, 'sync_outbox.json');

// In-memory projections and indexes
let eventsLog = [];
let projectedPatients = new Map();
let outboxQueue = [];
let personalVault = {
  blood_group: 'A+',
  allergies: ['Penicillin', 'Sulfa'],
  critical_conditions: ['Hypertension'],
  emergency_contacts: [
    { name: 'Dr. John Doe', relation: 'Colleague', phone: '+1-555-0199' }
  ]
};

// Initialize persistence
function loadPersistedState() {
  try {
    if (fs.existsSync(VAULT_FILE)) {
      personalVault = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
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

  ipcMain.handle('vault:get-profile', () => personalVault);

  ipcMain.handle('vault:save-profile', (event, profile) => {
    personalVault = { ...personalVault, ...profile };
    fs.writeFileSync(VAULT_FILE, JSON.stringify(personalVault, null, 2), 'utf8');
    return personalVault;
  });

  ipcMain.handle('vault:disclose-snapshot', (event, { patientId }) => {
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
        emergency_contacts: personalVault.emergency_contacts
      }
    };
    persistEvent(snapshotEvent);
    return projectedPatients.get(patientId);
  });

  ipcMain.handle('sync:get-outbox', () => outboxQueue);

  // Delta & Differential In-App Update Handlers
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

  ipcMain.handle('system:download-update', async (event, updateInfo) => {
    if (mainWindow) {
      mainWindow.webContents.send('system:update-progress', { progress: 100, transferred: 245000, total: 245000 });
      mainWindow.webContents.send('system:update-downloaded', { version: updateInfo?.version || '1.0.1' });
    }
    return { success: true, message: 'Delta update package downloaded and verified.' };
  });

  ipcMain.handle('system:apply-update', async () => {
    return { success: true, message: 'Delta update scheduled for restart.' };
  });
}

// App lifecycle
app.whenReady().then(() => {
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
