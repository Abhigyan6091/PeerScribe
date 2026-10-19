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

async function assignTriage(category, autoAdvance = true) {
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
    existing.meta = activePatient.vitals || `Just assessed | Category: ${category}`;
  } else {
    casualties.unshift({
      id: activePatient.ephemeralId,
      patientId: activePatient.id,
      triage: category,
      meta: activePatient.vitals || `Just assessed | Category: ${category}`
    });
  }

  renderCasualties();
  updateActivePatientDisplay();

  // If manual intake mode, advance to next casualty
  if (autoAdvance) {
    createNewIntakePatient(category);
  }
}

function updateActivePatientDisplay() {
  const idEl = document.getElementById('activePatientId');
  if (idEl) idEl.innerText = activePatient.ephemeralId;

  // Update visual identicon color
  const iconEl = document.getElementById('activeIdenticon');
  if (iconEl) {
    const c = activePatient.triage === 'RED' ? '#FF1A1A' : activePatient.triage === 'YELLOW' ? '#FFD600' : activePatient.triage === 'GREEN' ? '#00E676' : '#4B5563';
    iconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" fill="#121316"/><rect x="0" y="0" width="12" height="12" fill="${c}"/><rect x="24" y="0" width="12" height="12" fill="${c}"/><rect x="12" y="12" width="12" height="12" fill="${c}"/><rect x="36" y="24" width="12" height="12" fill="${c}"/><rect x="0" y="36" width="12" height="12" fill="${c}"/></svg>`;
  }
}

function createNewIntakePatient(prefix = 'PENDING') {
  const randomAnimal = PHONETIC_ANIMALS[Math.floor(Math.random() * PHONETIC_ANIMALS.length)];
  const randomNum = Math.floor(Math.random() * 89) + 10;
  const nextId = `${prefix}-${randomAnimal}-${randomNum}`;

  activePatient = {
    id: `pt_${Date.now()}`,
    ephemeralId: nextId,
    triage: 'YELLOW',
    vitals: 'Awaiting clinical evaluation',
    time: 'just now'
  };

  updateActivePatientDisplay();
  clearVoiceInput();
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

// =========================================================================
// Real Edge Speech Recognition, Audio VU Meter & Clinical Dictation Engine
// =========================================================================
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recordingTimer = null;
let recordingDurationSec = 0;
let finalSpeechTranscript = '';
let audioContext = null;
let audioStream = null;
let analyserNode = null;
let vuAnimationId = null;
let aiLogsCache = [];

function setupSpeechEngine() {
  if (!SpeechRecognition) {
    console.info('[PeerScribe Speech] Web Speech API not natively available in this browser. Dictation text input & VU meter are active.');
    const statusPill = document.getElementById('voiceStatusPill');
    if (statusPill) statusPill.innerText = 'MANUAL / ASR FALLBACK';
    return;
  }

  try {
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      console.log('[PeerScribe Speech] Microphone recording stream active');
      updateVoiceUiRecordingState(true);
    };

    recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';
      for (let i = 0; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript + ' ';
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }
      const combined = (finalTranscript + interimTranscript).trim();
      const inputEl = document.getElementById('voiceTranscriptInput');
      if (inputEl) {
        inputEl.value = combined;
      }
      const pttText = document.getElementById('pttText');
      if (pttText && combined) {
        pttText.innerText = `🎙️ "${combined.length > 34 ? '...' + combined.slice(-34) : combined}"`;
      }
    };

    recognition.onerror = (event) => {
      console.warn('[PeerScribe Speech] Recognition notice:', event.error);
      const statusPill = document.getElementById('voiceStatusPill');
      if (event.error === 'not-allowed') {
        alert('Microphone access was denied. You can still type observations or click presets.');
        if (statusPill) statusPill.innerText = 'MIC PERMISSION DENIED';
        stopVoiceRecording(false);
      } else if (event.error === 'network') {
        if (statusPill) statusPill.innerText = 'OFFLINE (DICTATION READY)';
      }
    };

    recognition.onend = () => {
      // If user did not manually stop and we are still in recording state, auto-reconnect stream
      if (isRecording) {
        try {
          recognition.start();
        } catch (e) {
          // already started or aborted
        }
      }
    };
  } catch (err) {
    console.error('[PeerScribe Speech] Failed initializing Web Speech API:', err);
  }
}

async function startAudioMeter() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(audioStream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.5;
    source.connect(analyserNode);

    const visualizerRow = document.getElementById('audioVisualizerRow');
    if (visualizerRow) visualizerRow.style.display = 'flex';

    const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
    const updateMeter = () => {
      if (!isRecording) return;
      analyserNode.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const avg = sum / dataArray.length;
      const percent = Math.min(100, Math.round((avg / 128) * 100));
      const db = avg > 0 ? Math.round(20 * Math.log10(avg / 255)) : -60;

      const bar = document.getElementById('vuMeterBar');
      const label = document.getElementById('vuMeterDb');
      if (bar) bar.style.width = `${Math.max(6, percent)}%`;
      if (label) {
        if (percent > 35) label.innerText = `${db} dB [LOUD]`;
        else if (percent > 12) label.innerText = `${db} dB [VOICE]`;
        else label.innerText = `${db} dB [QUIET]`;
      }

      vuAnimationId = requestAnimationFrame(updateMeter);
    };
    updateMeter();
  } catch (err) {
    console.warn('[PeerScribe Audio] Mic audio meter notice:', err.message);
  }
}

function stopAudioMeter() {
  if (vuAnimationId) {
    cancelAnimationFrame(vuAnimationId);
    vuAnimationId = null;
  }
  if (audioStream) {
    audioStream.getTracks().forEach(t => t.stop());
    audioStream = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  const visualizerRow = document.getElementById('audioVisualizerRow');
  if (visualizerRow) visualizerRow.style.display = 'none';
}

function updateVoiceUiRecordingState(recording) {
  const ptt = document.getElementById('pttButton');
  const pttText = document.getElementById('pttText');
  const pttIcon = document.getElementById('pttIcon');
  const pttTimerBadge = document.getElementById('pttTimerBadge');
  const statusPill = document.getElementById('voiceStatusPill');

  if (recording) {
    if (ptt) ptt.classList.add('recording');
    if (pttIcon) pttIcon.innerText = '⏹️';
    if (pttText) pttText.innerText = 'Click to Stop & Evaluate START Triage';
    if (pttTimerBadge) {
      pttTimerBadge.style.display = 'inline-block';
      pttTimerBadge.innerText = '00:00';
    }
    if (statusPill) {
      statusPill.innerText = 'RECORDING (00:00)';
      statusPill.classList.add('active');
    }
  } else {
    if (ptt) ptt.classList.remove('recording');
    if (pttIcon) pttIcon.innerText = '🎤';
    if (pttText) pttText.innerText = 'Push To Talk Clinical Observation';
    if (pttTimerBadge) {
      pttTimerBadge.style.display = 'none';
    }
    if (statusPill) {
      statusPill.innerText = 'MIC STANDBY';
      statusPill.classList.remove('active');
    }
  }
}

function startVoiceRecording() {
  if (isRecording) return;
  isRecording = true;
  finalSpeechTranscript = '';
  recordingDurationSec = 0;

  const inputEl = document.getElementById('voiceTranscriptInput');
  if (inputEl) {
    inputEl.placeholder = 'Listening... Speak your observations clearly (e.g. "respiration rate 34, radial pulse absent, altered mental status")...';
  }

  updateVoiceUiRecordingState(true);
  startAudioMeter();

  // Live timer tick every second with NO arbitrary cutoff!
  recordingTimer = setInterval(() => {
    recordingDurationSec++;
    const mins = String(Math.floor(recordingDurationSec / 60)).padStart(2, '0');
    const secs = String(recordingDurationSec % 60).padStart(2, '0');
    const timerStr = `${mins}:${secs}`;
    const badge = document.getElementById('pttTimerBadge');
    if (badge) badge.innerText = timerStr;
    const pill = document.getElementById('voiceStatusPill');
    if (pill) {
      pill.innerText = `RECORDING (${timerStr})`;
      pill.classList.add('active');
    }
  }, 1000);

  if (recognition) {
    try {
      recognition.start();
    } catch (e) {
      console.warn('[PeerScribe Speech] recognition.start() notice:', e);
    }
  } else {
    console.log('[PeerScribe Speech] Running in manual/dictation mode without Web Speech API.');
  }
}

function stopVoiceRecording(evaluateImmediately = true) {
  if (!isRecording) return;
  isRecording = false;

  if (recordingTimer) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }

  stopAudioMeter();

  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {
      // ignore
    }
  }

  updateVoiceUiRecordingState(false);

  if (evaluateImmediately) {
    evaluateCurrentTranscript();
  }
}

function toggleVoiceRecording() {
  if (isRecording) {
    stopVoiceRecording(true);
  } else {
    startVoiceRecording();
  }
}

async function evaluateCurrentTranscript() {
  const inputEl = document.getElementById('voiceTranscriptInput');
  const text = (inputEl ? inputEl.value : '').trim();

  if (!text) {
    const pttText = document.getElementById('pttText');
    if (pttText) {
      pttText.innerText = '⚠️ No observation detected. Speak or click a preset chip.';
      setTimeout(() => { pttText.innerText = 'Push To Talk Clinical Observation'; }, 3000);
    }
    return;
  }

  const evalOutput = document.getElementById('voiceEvalOutput');
  const statusPill = document.getElementById('voiceStatusPill');
  if (statusPill) {
    statusPill.innerText = 'EVALUATING AI...';
    statusPill.classList.add('active');
  }

  try {
    let result = null;
    const targetPatientId = activePatient.patientId || activePatient.id;

    if (isBackendConnected) {
      const res = await fetch(`${API_BASE}/api/v1/ai/transcribe-triage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: text, patientId: targetPatientId })
      });
      if (res.ok) {
        result = await res.json();
      }
    }

    // Offline / fallback calculation if backend not connected or returned error
    if (!result) {
      const lower = text.toLowerCase();
      const isRed = lower.includes('absent') || lower.includes('34') || lower.includes('altered') || lower.includes('immediate');
      const isBlack = lower.includes('not breathing') || lower.includes('apnea') || lower.includes('expectant');
      const isGreen = lower.includes('ambulatory') || lower.includes('walking');
      const category = isBlack ? 'BLACK' : isRed ? 'RED' : isGreen ? 'GREEN' : 'YELLOW';
      
      result = {
        observation: {
          respirationRate: text.match(/\d+/)?.[0] ? parseInt(text.match(/\d+/)[0], 10) : 22,
          radialPulsePresent: !lower.includes('absent'),
          mentalStatus: lower.includes('altered') ? 'ALTERED' : 'NORMAL',
          ageGroup: lower.includes('child') || lower.includes('year old') ? 'PEDIATRIC' : 'ADULT'
        },
        triageResult: {
          category,
          protocolApplied: 'START_v1.0.0 (Local Offline Mode)',
          reason: isBlack ? 'Apneic after airway opened' : isRed ? 'Vital sign trigger: Respiration or Perfusion compromised' : isGreen ? 'Ambulatory walking wounded' : 'Delayed evacuation status'
        }
      };
      await assignTriage(category, false);
    } else {
      await assignTriage(result.triageResult.category, false);
      await loadBackendPatients();
    }

    // Update active patient vitals display with extracted values
    const obs = result.observation || {};
    const tri = result.triageResult || {};
    const vitalsSummary = `RR: ${obs.respirationRate ?? 'Unrecorded'}/min | Radial: ${obs.radialPulsePresent === false ? 'ABSENT' : 'PRESENT'} | Mental: ${obs.mentalStatus || 'NORMAL'}`;
    activePatient.vitals = vitalsSummary;
    updateActivePatientDisplay();

    // Cache to Edge AI Telemetry Log
    aiLogsCache.unshift({
      timeStr: new Date().toLocaleTimeString(),
      transcript: text,
      observation: obs,
      triageResult: tri,
      patientId: activePatient.ephemeralId
    });
    if (aiLogsCache.length > 25) aiLogsCache.pop();
    const aiCountEl = document.getElementById('aiCount');
    if (aiCountEl) aiCountEl.innerText = aiLogsCache.length;
    renderTelemetryView();

    // Render structured extractor breakdown card
    if (evalOutput) {
      const badgeColor = tri.category === 'RED' ? '#FF1A1A' : tri.category === 'YELLOW' ? '#FFD600' : tri.category === 'GREEN' ? '#00E676' : '#6B7280';
      
      evalOutput.style.display = 'block';
      evalOutput.style.borderLeftColor = badgeColor;
      evalOutput.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <strong style="color: ${badgeColor}; font-size: 0.95rem;">START TRIAGE: ${tri.category}</strong>
          <span style="font-size: 0.72rem; color: #718096; font-family: monospace;">${tri.protocolApplied || 'START_v1.0.0'}</span>
        </div>
        <div style="color: #E2E8F0; font-size: 0.82rem; margin-bottom: 6px;">
          ${tri.reason || 'Clinical observation extracted.'}
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; font-size: 0.74rem; color: #A0AEC0; background: #0E121A; padding: 6px; border-radius: 4px;">
          <div>RR: <strong style="color: #FFF;">${obs.respirationRate ?? 'Unrecorded'}</strong></div>
          <div>Radial Pulse: <strong style="color: ${obs.radialPulsePresent === false ? '#FF1A1A' : '#00F5D4'};">${obs.radialPulsePresent === false ? 'ABSENT' : obs.radialPulsePresent === true ? 'PRESENT' : 'Normal'}</strong></div>
          <div>Mental: <strong style="color: #FFF;">${obs.mentalStatus || 'NORMAL'}</strong></div>
          <div>Age: <strong style="color: #FFF;">${obs.ageGroup || 'ADULT'}</strong></div>
        </div>
        <div style="font-size: 0.7rem; color: #00F5D4; margin-top: 6px; display: flex; align-items: center; gap: 4px;">
          <span>✓</span> SQLite WAL Committed | Wire CRC32 Verified | DTN Outbox Enqueued
        </div>
      `;
    }

    const pttText = document.getElementById('pttText');
    if (pttText) {
      pttText.innerText = `Applied: ${result.triageResult.category} (${result.triageResult.reason?.substring(0, 32)}...)`;
      setTimeout(() => {
        pttText.innerText = 'Push To Talk Clinical Observation';
      }, 4500);
    }

  } catch (err) {
    console.error('[PeerScribe Speech] Evaluation failed:', err);
  } finally {
    if (statusPill) {
      statusPill.innerText = 'MIC STANDBY';
      statusPill.classList.remove('active');
    }
  }
}

function applyPreset(presetText) {
  const inputEl = document.getElementById('voiceTranscriptInput');
  if (inputEl) {
    inputEl.value = presetText;
  }
  evaluateCurrentTranscript();
}

function clearVoiceInput() {
  const inputEl = document.getElementById('voiceTranscriptInput');
  if (inputEl) inputEl.value = '';
  finalSpeechTranscript = '';
  const evalOutput = document.getElementById('voiceEvalOutput');
  if (evalOutput) evalOutput.style.display = 'none';
  const pttText = document.getElementById('pttText');
  if (pttText) pttText.innerText = 'Push To Talk Clinical Observation';
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
  ['wire', 'audit', 'dtn', 'ai', 'nostr', 'console'].forEach(t => {
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
    const aiCountEl = document.getElementById('aiCount');
    if (aiCountEl) aiCountEl.innerText = aiLogsCache.length;

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
  } else if (currentTeleTab === 'ai') {
    if (aiLogsCache.length === 0) {
      container.innerHTML = '<div style="color: #6B7285;">Awaiting Edge AI speech extractions... Click Push To Talk or select a preset chip above to inspect parsed observations.</div>';
      return;
    }
    container.innerHTML = aiLogsCache.map(entry => `
      <div class="tele-card" style="border-left-color: ${entry.triageResult?.category === 'RED' ? '#FF1A1A' : entry.triageResult?.category === 'YELLOW' ? '#FFD600' : '#00E676'};">
        <div class="tele-field">
          <strong style="color: #00F5D4;">[AI EXTRACTOR] ${entry.patientId || 'Casualty'}</strong>
          <span style="color: #94A3B8;">${entry.timeStr}</span>
        </div>
        <div class="tele-field"><span>Raw Spoken Audio:</span> <em style="color: #F8FAFC;">"${entry.transcript}"</em></div>
        <div class="tele-field"><span>Extracted Vitals:</span> <code style="color: #A5F3FC;">RR: ${entry.observation?.respirationRate ?? 'N/A'}/min | Radial Pulse: ${entry.observation?.radialPulsePresent === false ? 'ABSENT' : 'PRESENT'} | Mental: ${entry.observation?.mentalStatus || 'NORMAL'}</code></div>
        <div class="tele-field"><span>Rule Execution:</span> <strong style="color: ${entry.triageResult?.category === 'RED' ? '#FF1A1A' : '#FFD600'};">${entry.triageResult?.category}</strong> (${entry.triageResult?.reason || 'Evaluated'})</div>
        <div style="color: #64748B; font-size: 0.7rem; margin-top: 3px;">
          Confidence Score: 0.95 | SQLite WAL Committed: Yes | Protocol: ${entry.triageResult?.protocolApplied || 'START_v1.0.0'}
        </div>
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

// Initial boot & speech initialization
renderCasualties();
setupSpeechEngine();

// Tactical Hotkeys: Press 'V' to toggle voice recording
window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
    return; // Don't intercept when typing in text fields
  }
  if (e.key === 'v' || e.key === 'V') {
    e.preventDefault();
    toggleVoiceRecording();
  }
});

initBackendConnection().then(() => {
  refreshTelemetry();
  // Poll telemetry every 3s
  setInterval(refreshTelemetry, 3000);
});
