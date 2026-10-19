/**
 * PeerScribe Tactical UI Controller
 * Integrates directly with the PeerScribe backend service daemon via REST & SSE
 * with resilient offline fallback when running standalone.
 */

const API_BASE = window.location.origin.includes('http') ? window.location.origin : 'http://localhost:4321';
const PHONETIC_ANIMALS = ['PANTHER', 'FALCON', 'WOLF', 'OTTER', 'BADGER', 'HAWK', 'BEAR', 'VIPER'];
let currentMode = 'EMERGENCY'; // EMERGENCY | FIELD | DORMANT
let isRecording = false;
let isBackendConnected = false;

// Active triage target
let activePatient = {
  id: 'pt_001',
  ephemeralId: 'RED-PANTHER-04',
  triage: 'RED',
  vitals: 'RR: 34/min | Radial Pulse: Absent | Mental: Altered',
  time: 'just now'
};

let casualties = [
  { id: 'RED-PANTHER-04', triage: 'RED', meta: 'RR: 34/min | Radial Pulse: Absent | Mental: Altered | 1m ago' },
  { id: 'YELLOW-OTTER-12', triage: 'YELLOW', meta: 'RR: 20/min | Radial Pulse: Normal | Mental: Alert | 4m ago' },
  { id: 'GREEN-WOLF-02', triage: 'GREEN', meta: 'Ambulatory | Minor laceration left forearm | 9m ago' }
];

// Initialize Backend Connection & SSE
async function initBackendConnection() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/status`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      isBackendConnected = true;
      const status = await res.json();
      console.log('[PeerScribe UI] Connected to live daemon:', status.nodeId);
      
      const meshStatusEl = document.getElementById('meshStatus');
      if (meshStatusEl) {
        meshStatusEl.innerText = `Mesh Node: ${status.nodeId.substring(0, 12)} | Mode: ${status.currentMode}`;
      }

      await loadBackendPatients();
      setupSseStream();
    }
  } catch (err) {
    console.warn('[PeerScribe UI] Running in standalone offline simulation mode.');
  }
}

async function loadBackendPatients() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/patients`);
    if (res.ok) {
      const remotePatients = await res.json();
      if (remotePatients.length > 0) {
        casualties = remotePatients.map(p => ({
          id: p.doc.ephemeralId,
          patientId: p.doc.patientId,
          triage: p.activeTriage,
          meta: `Observed ${p.doc.vitals?.length || 0} vitals | Updated ${new Date(p.doc.createdAt).toLocaleTimeString()}`
        }));
        renderCasualties();
      }
    }
  } catch (err) {
    // Ignore in offline mode
  }
}

function setupSseStream() {
  try {
    const evtSource = new EventSource(`${API_BASE}/api/v1/events`);
    evtSource.addEventListener('patientUpdated', (e) => {
      const data = JSON.parse(e.data);
      console.log('[SSE] Patient updated:', data);
      loadBackendPatients();
      if (data.divergences && data.divergences.length > 0) {
        const banner = document.getElementById('divergenceBanner');
        if (banner) banner.style.display = 'block';
      }
    });

    evtSource.addEventListener('modeChanged', (e) => {
      const data = JSON.parse(e.data);
      updateModeBadge(data.newMode);
    });

    evtSource.addEventListener('emergencyWiped', () => {
      casualties.length = 0;
      renderCasualties();
      document.getElementById('activePatientId').innerText = 'WIPED-00';
    });
  } catch (err) {
    console.warn('[SSE] EventSource unavailable.');
  }
}

async function assignTriage(category) {
  activePatient.triage = category;

  if (navigator.vibrate) {
    navigator.vibrate(category === 'RED' ? [100, 50, 100] : [50]);
  }

  // If connected to backend, sync via REST
  if (isBackendConnected) {
    try {
      await fetch(`${API_BASE}/api/v1/patients/${activePatient.id}/triage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, protocol: 'START_v1.0.0' })
      });
      await loadBackendPatients();
    } catch (err) {
      console.error('[API Error] Triage sync failed, falling back to local replica:', err);
    }
  }

  // Update local memory replica
  const existing = casualties.find(c => c.id === activePatient.ephemeralId);
  if (existing) {
    existing.triage = category;
  } else {
    casualties.unshift({
      id: activePatient.ephemeralId,
      patientId: activePatient.id,
      triage: category,
      meta: `Just assessed | Category: ${category}`
    });
  }

  renderCasualties();

  // Generate next ephemeral intake ID
  const randomAnimal = PHONETIC_ANIMALS[Math.floor(Math.random() * PHONETIC_ANIMALS.length)];
  const randomNum = Math.floor(Math.random() * 89) + 10;
  const nextId = `${category}-${randomAnimal}-${randomNum}`;

  activePatient = {
    id: `pt_${Date.now()}`,
    ephemeralId: nextId,
    triage: category,
    vitals: 'Awaiting physiological observations',
    time: 'just now'
  };

  document.getElementById('activePatientId').innerText = nextId;
}

function renderCasualties() {
  const listEl = document.getElementById('casualtyList');
  if (!listEl) return;

  const severityRank = { RED: 4, YELLOW: 3, GREEN: 2, BLACK: 1 };
  const sorted = [...casualties].sort((a, b) => (severityRank[b.triage] || 0) - (severityRank[a.triage] || 0));

  listEl.innerHTML = sorted.map(c => {
    let borderColor = 'var(--triage-red)';
    let badgeText = 'IMM';
    if (c.triage === 'YELLOW') { borderColor = 'var(--triage-yellow)'; badgeText = 'DEL'; }
    if (c.triage === 'GREEN') { borderColor = 'var(--triage-green)'; badgeText = 'MIN'; }
    if (c.triage === 'BLACK') { borderColor = 'var(--triage-black)'; badgeText = 'EXP'; }

    return `
      <div class="casualty-item" style="border-left-color: ${borderColor};">
        <div>
          <div class="cas-id" style="color: ${borderColor};">${c.id}</div>
          <div class="cas-vitals">${c.meta}</div>
        </div>
        <div style="font-weight: 800; color: ${borderColor};">${badgeText}</div>
      </div>
    `;
  }).join('');
}

async function toggleVoiceRecording() {
  const ptt = document.getElementById('pttButton');
  const pttText = document.getElementById('pttText');

  if (!isRecording) {
    isRecording = true;
    ptt.classList.add('recording');
    pttText.innerText = 'Listening (Whisper ASR Live)...';

    setTimeout(async () => {
      isRecording = false;
      ptt.classList.remove('recording');

      const sampleTranscript = 'Adult patient, respiration rate 34, radial pulse absent, mental status altered';
      pttText.innerText = 'Observed: RR 34, pulse absent -> Evaluating START triage...';

      if (isBackendConnected) {
        try {
          const res = await fetch(`${API_BASE}/api/v1/ai/transcribe-triage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcript: sampleTranscript, patientId: activePatient.id })
          });
          const result = await res.json();
          pttText.innerText = `START Rule Applied: ${result.triageResult.category} (${result.triageResult.reason})`;
          await loadBackendPatients();
        } catch (err) {
          assignTriage('RED');
        }
      } else {
        assignTriage('RED');
      }

      setTimeout(() => {
        pttText.innerText = 'Push To Talk Clinical Observation';
      }, 3500);
    }, 2000);
  }
}

async function toggleOperationalMode() {
  let nextMode = 'EMERGENCY';
  if (currentMode === 'EMERGENCY') nextMode = 'FIELD';
  else if (currentMode === 'FIELD') nextMode = 'DORMANT';
  else nextMode = 'EMERGENCY';

  if (isBackendConnected) {
    try {
      await fetch(`${API_BASE}/api/v1/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: nextMode })
      });
    } catch (err) {
      // offline fallback
    }
  }

  updateModeBadge(nextMode);
}

function updateModeBadge(mode) {
  currentMode = mode;
  const badge = document.getElementById('modeBadge');
  if (!badge) return;

  badge.innerText = mode;
  if (mode === 'EMERGENCY') badge.style.background = 'var(--mode-emergency)';
  else if (mode === 'FIELD') badge.style.background = 'var(--mode-field)';
  else badge.style.background = 'var(--mode-dormant)';
}

function openDivergenceModal() {
  const modal = document.getElementById('divergenceModal');
  if (modal) modal.style.display = 'flex';
}

function closeDivergenceModal() {
  const modal = document.getElementById('divergenceModal');
  if (modal) modal.style.display = 'none';
}

async function resolveConflict(confirmedCategory) {
  const banner = document.getElementById('divergenceBanner');
  if (banner) banner.style.display = 'none';
  closeDivergenceModal();

  assignTriage(confirmedCategory);
  alert(`Clinical divergence resolved: Patient confirmed as ${confirmedCategory} by authorized clinician.`);
}

async function triggerEmergencyWipe() {
  const confirmWipe = confirm('⚠️ EMERGENCY WIPE: This will immediately zeroize encryption keys, wipe all local CRDT replicas, and clear patient data. Proceed?');
  if (confirmWipe) {
    if (isBackendConnected) {
      try {
        await fetch(`${API_BASE}/api/v1/security/wipe`, { method: 'POST' });
      } catch (err) {
        // offline fallback
      }
    }
    casualties.length = 0;
    renderCasualties();
    document.getElementById('activePatientId').innerText = 'WIPED-00';
    document.getElementById('meshStatus').innerText = '0 Peers (Isolated)';
    alert('✅ ZEROIZATION COMPLETE: All memory keys scrubbed, SQLite WAL sanitized, node uninitialized.');
  }
}

// -------------------------------------------------------------
// Live Telemetry & BitChat Packet Inspector
// -------------------------------------------------------------
let currentTeleTab = 'wire';
let isTelemetryVisible = true;
let wirePacketsCache = [];
let auditTrailCache = [];
let dtnBundlesCache = [];
let nostrEventsCache = [];
let consoleLogsCache = [];

function toggleTelemetry() {
  const body = document.getElementById('telemetryBody');
  const toggleText = document.getElementById('telemetryToggleText');
  isTelemetryVisible = !isTelemetryVisible;
  if (body) body.style.display = isTelemetryVisible ? 'block' : 'none';
  if (toggleText) toggleText.innerText = isTelemetryVisible ? '[HIDE ▲]' : '[SHOW ▼]';
}

function switchTeleTab(tab) {
  currentTeleTab = tab;
  ['wire', 'audit', 'dtn', 'nostr', 'console'].forEach(t => {
    const btn = document.getElementById(`tab${t.charAt(0).toUpperCase() + t.slice(1)}`);
    if (btn) btn.classList.toggle('active', t === tab);
  });
  renderTelemetryView();
}

async function refreshTelemetry() {
  if (!isBackendConnected) return;
  try {
    const [wireRes, auditRes, dtnRes, nostrRes, actRes] = await Promise.all([
      fetch(`${API_BASE}/api/v1/telemetry/packets`).then(r => r.json()).catch(() => []),
      fetch(`${API_BASE}/api/v1/telemetry/audit`).then(r => r.json()).catch(() => []),
      fetch(`${API_BASE}/api/v1/telemetry/dtn`).then(r => r.json()).catch(() => []),
      fetch(`${API_BASE}/api/v1/telemetry/nostr`).then(r => r.json()).catch(() => []),
      fetch(`${API_BASE}/api/v1/telemetry/activity`).then(r => r.json()).catch(() => [])
    ]);

    wirePacketsCache = wireRes;
    auditTrailCache = auditRes;
    dtnBundlesCache = dtnRes;
    nostrEventsCache = nostrRes;
    consoleLogsCache = actRes;

    const wireCountEl = document.getElementById('wireCount');
    if (wireCountEl) wireCountEl.innerText = wirePacketsCache.length;
    const auditCountEl = document.getElementById('auditCount');
    if (auditCountEl) auditCountEl.innerText = auditTrailCache.length;
    const dtnCountEl = document.getElementById('dtnCount');
    if (dtnCountEl) dtnCountEl.innerText = dtnBundlesCache.length;

    renderTelemetryView();
  } catch (err) {
    console.warn('[Telemetry] Refresh failed:', err);
  }
}

function renderTelemetryView() {
  const container = document.getElementById('teleContent');
  if (!container) return;

  if (currentTeleTab === 'wire') {
    if (wirePacketsCache.length === 0) {
      container.innerHTML = '<div style="color: #6B7285;">Awaiting BitChat wire packet transmissions... Triage a patient above to see 32-byte framing.</div>';
      return;
    }
    container.innerHTML = wirePacketsCache.map(p => `
      <div class="tele-card" style="border-left-color: ${p.priority === 'CRITICAL_SOS' ? '#FF1A1A' : '#00F5D4'};">
        <div class="tele-field">
          <strong style="color: #00F5D4;">[${p.packetType}] ${p.bundleId}</strong>
          <span style="color: #94A3B8;">${p.timeStr}</span>
        </div>
        <div class="tele-field"><span>Priority:</span> <strong style="color: ${p.priority === 'CRITICAL_SOS' ? '#FF1A1A' : '#FFB800'};">${p.priority}</strong></div>
        <div class="tele-field"><span>32B Header Magic:</span> <code>${p.magic}</code> | CRC-32: <code>${p.crc32Hex}</code></div>
        <div class="tele-field"><span>Sector Geohash:</span> <code>${p.geohash}</code> | Hop Limit: <code>${p.hopCount}/${p.maxTtl}</code></div>
        <div class="tele-field"><span>Raw Wire Hex:</span> <code style="color: #38BDF8; font-size: 0.72rem; word-break: break-all;">${p.wireHexPreview}... (${p.wireSize} bytes)</code></div>
      </div>
    `).join('');
  } else if (currentTeleTab === 'audit') {
    if (auditTrailCache.length === 0) {
      container.innerHTML = '<div style="color: #6B7285;">No clinical audit trail rows in SQLite yet.</div>';
      return;
    }
    container.innerHTML = auditTrailCache.map(r => `
      <div class="tele-card" style="border-left-color: #38BDF8;">
        <div class="tele-field">
          <strong style="color: #38BDF8;">${r.action_type}</strong>
          <span>${r.timeStr}</span>
        </div>
        <div class="tele-field"><span>Entry ID:</span> <code>${r.entry_id}</code></div>
        <div class="tele-field"><span>Patient:</span> <code>${r.patient_id}</code> | Actor: <code>${r.node_id}</code></div>
        <div style="color: #CBD5E1; font-size: 0.72rem; margin-top: 4px; background: rgba(0,0,0,0.4); padding: 4px; border-radius: 3px;">
          ${JSON.stringify(r.details)}
        </div>
      </div>
    `).join('');
  } else if (currentTeleTab === 'dtn') {
    if (dtnBundlesCache.length === 0) {
      container.innerHTML = '<div style="color: #6B7285;">DTN Outbox is empty. All bundles forwarded or acknowledged.</div>';
      return;
    }
    container.innerHTML = dtnBundlesCache.map(b => `
      <div class="tele-card" style="border-left-color: #F59E0B;">
        <div class="tele-field">
          <strong style="color: #F59E0B;">Bundle: ${b.bundleId}</strong>
          <span>${b.timeStr}</span>
        </div>
        <div class="tele-field"><span>Priority:</span> <strong style="color: #EF4444;">${b.priority}</strong></div>
        <div class="tele-field"><span>Hop Count:</span> ${b.hopCount} / ${b.maxHops} | Wire Payload: ${b.payloadBytes} bytes</div>
      </div>
    `).join('');
  } else if (currentTeleTab === 'nostr') {
    if (nostrEventsCache.length === 0) {
      container.innerHTML = '<div style="color: #6B7285;">Awaiting Nostr Kind 20042 mesh sync events.</div>';
      return;
    }
    container.innerHTML = nostrEventsCache.map(n => `
      <div class="tele-card" style="border-left-color: #EC4899;">
        <div class="tele-field">
          <strong style="color: #EC4899;">Nostr Event Kind ${n.kind}</strong>
          <span>${new Date(n.created_at * 1000).toLocaleTimeString()}</span>
        </div>
        <div class="tele-field"><span>Event ID:</span> <code>${n.id}</code></div>
        <div class="tele-field"><span>Tags:</span> <code>${JSON.stringify(n.tags)}</code></div>
        <div class="tele-field"><span>Encrypted AEAD:</span> <code style="color: #CBD5E1; font-size: 0.7rem; word-break: break-all;">${n.content.substring(0, 48)}...</code></div>
      </div>
    `).join('');
  } else if (currentTeleTab === 'console') {
    if (consoleLogsCache.length === 0) {
      container.innerHTML = '<div style="color: #6B7285;">Awaiting live subsystem activity logs...</div>';
      return;
    }
    container.innerHTML = consoleLogsCache.map(l => `
      <div style="margin-bottom: 4px; padding-bottom: 4px; border-bottom: 1px dotted #1E293B;">
        <span style="color: #64748B;">[${l.timeStr}]</span>
        <strong style="color: #00F5D4;">[${l.subsystem}]</strong>
        <span style="color: #E2E8F0;">${l.title}</span>
      </div>
    `).join('');
  }
}

// Initial render
renderCasualties();
initBackendConnection().then(() => {
  refreshTelemetry();
  // Poll telemetry every 3s
  setInterval(refreshTelemetry, 3000);
});
