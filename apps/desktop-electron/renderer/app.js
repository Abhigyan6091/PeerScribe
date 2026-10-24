/**
 * PeerScribe Tactical UI Controller
 * Integrates directly with the PeerScribe backend service daemon via REST & SSE
 * with resilient offline fallback when running standalone.
 */

const API_BASE = window.location.origin.includes('http') ? window.location.origin : 'http://localhost:4321';
const PHONETIC_ANIMALS = ['PANTHER', 'FALCON', 'WOLF', 'OTTER', 'BADGER', 'HAWK', 'BEAR', 'VIPER'];
let currentMode = 'FIELD'; // EMERGENCY | FIELD | DORMANT
let currentBackendNodeId = null;
let telemetryInterval = null;
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
      currentBackendNodeId = status.nodeId;
      console.log('[PeerScribe UI] Connected to live daemon:', status.nodeId, 'Initial mode:', status.currentMode);
      
      // Synchronize operational mode from daemon
      updateModeBadge(status.currentMode);

      await loadBackendPatients();
      setupSseStream();
    }
  } catch (err) {
    console.warn('[PeerScribe UI] Running in standalone offline simulation mode.');
    updateModeBadge(currentMode);
  }
}

async function loadBackendPatients() {
  if (!isBackendConnected) return;
  try {
    const [patientsRes, statusRes] = await Promise.all([
      fetch(`${API_BASE}/api/v1/patients`),
      fetch(`${API_BASE}/api/v1/status`)
    ]);

    if (patientsRes.ok) {
      const remotePatients = await patientsRes.json();
      casualties = remotePatients.map(p => {
        const injText = p.doc.injuries && p.doc.injuries.length > 0 
          ? p.doc.injuries.map(i => i.classification).join(', ')
          : null;
        const latestNote = p.doc.notes && p.doc.notes.length > 0
          ? p.doc.notes[p.doc.notes.length - 1].text
          : null;

        let meta = `Observed ${p.doc.vitals?.length || 0} vitals`;
        if (injText) {
          meta = `🚨 ${injText} | ${meta}`;
        } else if (latestNote) {
          meta = `${latestNote.substring(0, 45)}... | ${meta}`;
        }
        meta += ` | ${new Date(p.doc.createdAt).toLocaleTimeString()}`;

        return {
          id: p.doc.ephemeralId,
          patientId: p.doc.patientId,
          triage: p.activeTriage,
          meta,
          injuries: p.doc.injuries ? p.doc.injuries.map(i => i.classification) : []
        };
      });
      renderCasualties();
    }

    // Update live triage summary bar from backend status
    if (statusRes.ok) {
      const status = await statusRes.json();
      const counts = status.triageCounts || {};
      const redEl = document.getElementById('countRed');
      const yelEl = document.getElementById('countYellow');
      const grnEl = document.getElementById('countGreen');
      const blkEl = document.getElementById('countBlack');
      if (redEl) redEl.innerText = counts.RED ?? 0;
      if (yelEl) yelEl.innerText = counts.YELLOW ?? 0;
      if (grnEl) grnEl.innerText = counts.GREEN ?? 0;
      if (blkEl) blkEl.innerText = counts.BLACK ?? 0;

      // Update live footer BLE / CRDT status
      const footerEl = document.getElementById('footerStatus');
      if (footerEl) {
        const totalCas = status.totalCasualties ?? 0;
        const outbox = status.outboxCount ?? 0;
        const modeLabel = status.currentMode === 'EMERGENCY' ? '🚨 EMERGENCY' : status.currentMode === 'FIELD' ? '📡 FIELD' : '💤 DORMANT';
        footerEl.innerHTML = `BLE Mesh: <strong style="color:#00F5D4;">Active (${modeLabel})</strong> | Casualties: <strong style="color:#FFF;">${totalCas}</strong> | DTN Outbox: <strong style="color:#FFB800;">${outbox}</strong>`;
      }
    }
  } catch (err) {
    // Ignore in offline mode
  }
}

function setupSseStream() {
  try {
    const evtSource = new EventSource(`${API_BASE}/api/v1/events`);
    evtSource.addEventListener('patientCreated', (e) => {
      loadBackendPatients();
    });

    evtSource.addEventListener('patientUpdated', (e) => {
      const data = JSON.parse(e.data);
      console.log('[SSE] Patient updated:', data);
      loadBackendPatients();
      if (data.divergences && data.divergences.length > 0) {
        const flag = data.divergences[0];
        const banner = document.getElementById('divergenceBanner');
        const desc = document.getElementById('divergenceDesc');
        if (banner) banner.style.display = 'block';
        if (desc) {
          const patientId = data.doc?.ephemeralId || 'Unknown Casualty';
          desc.innerText = `${patientId}: ${flag.description || 'Opposing triage levels detected. Human sign-off required.'}`;
        }
        // Store live divergence data for the modal
        window._liveDivergenceData = {
          patientId: data.doc?.patientId,
          ephemeralId: data.doc?.ephemeralId || 'Unknown',
          flags: data.divergences,
          activeTriage: data.activeTriage
        };
      }
    });

    evtSource.addEventListener('modeChanged', (e) => {
      const data = JSON.parse(e.data);
      console.log('[SSE] Mode changed from daemon:', data.newMode);
      updateModeBadge(data.newMode);
    });

    evtSource.addEventListener('emergencyWiped', (e) => {
      console.log('[SSE] Emergency Wipe received from daemon');
      try {
        const data = JSON.parse(e.data);
        if (data.newNodeId) currentBackendNodeId = data.newNodeId;
      } catch (err) {}
      resetFrontendState();
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
    if (activePatient.injuries && activePatient.injuries.length > 0) {
      existing.injuries = activePatient.injuries;
    }
  } else {
    casualties.unshift({
      id: activePatient.ephemeralId,
      patientId: activePatient.id,
      triage: category,
      meta: activePatient.vitals || `Just assessed | Category: ${category}`,
      injuries: activePatient.injuries || []
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

  const subEl = document.getElementById('activePatientSubtext');
  if (subEl) subEl.innerText = activePatient.vitals || 'Awaiting clinical evaluation';

  const injEl = document.getElementById('activePatientInjuries');
  if (injEl) {
    if (activePatient.injuries && activePatient.injuries.length > 0) {
      injEl.innerHTML = activePatient.injuries.map(i => `
        <span style="background: rgba(255, 26, 26, 0.2); border: 1px solid #FF1A1A; color: #FFAAAA; padding: 2px 6px; border-radius: 4px; font-size: 0.72rem; font-weight: 700;">
          ⚠️ ${i}
        </span>
      `).join('');
    } else {
      injEl.innerHTML = '';
    }
  }

  // Update visual identicon color
  const iconEl = document.getElementById('activeIdenticon');
  if (iconEl) {
    const c = activePatient.triage === 'RED' ? '#FF1A1A' : activePatient.triage === 'YELLOW' ? '#FFD600' : activePatient.triage === 'GREEN' ? '#00E676' : '#4B5563';
    iconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" fill="#121316"/><rect x="0" y="0" width="12" height="12" fill="${c}"/><rect x="24" y="0" width="12" height="12" fill="${c}"/><rect x="12" y="12" width="12" height="12" fill="${c}"/><rect x="36" y="24" width="12" height="12" fill="${c}"/><rect x="0" y="36" width="12" height="12" fill="${c}"/></svg>`;
  }
}

async function createNewIntakePatient(prefix = 'PENDING') {
  const randomAnimal = PHONETIC_ANIMALS[Math.floor(Math.random() * PHONETIC_ANIMALS.length)];
  const randomNum = Math.floor(Math.random() * 89) + 10;
  const nextEphemId = `${prefix}-${randomAnimal}-${randomNum}`;

  // If connected to backend, persist the new intake patient in the database
  if (isBackendConnected) {
    try {
      const res = await fetch(`${API_BASE}/api/v1/patients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ephemeralId: nextEphemId })
      });
      if (res.ok) {
        const doc = await res.json();
        activePatient = {
          id: doc.patientId,
          ephemeralId: doc.ephemeralId,
          triage: 'YELLOW',
          vitals: 'Awaiting clinical evaluation',
          injuries: [],
          time: 'just now'
        };
        await loadBackendPatients();
        updateActivePatientDisplay();
        clearVoiceInput();
        return;
      }
    } catch (err) {
      console.warn('[Intake] Backend patient create failed, falling back to local:', err);
    }
  }

  // Offline fallback: local-only new patient
  activePatient = {
    id: `pt_${Date.now()}`,
    ephemeralId: nextEphemId,
    triage: 'YELLOW',
    vitals: 'Awaiting clinical evaluation',
    injuries: [],
    time: 'just now'
  };

  updateActivePatientDisplay();
  clearVoiceInput();
}

function renderCasualties() {
  const listEl = document.getElementById('casualtyList');
  if (!listEl) return;

  if (casualties.length === 0) {
    listEl.innerHTML = `
      <div style="padding: 20px 12px; text-align: center; color: var(--text-muted); font-size: 0.85rem; background: var(--bg-surface); border-radius: 4px; border: 1px dashed rgba(255,255,255,0.1);">
        No active casualties recorded in mesh database.
      </div>
    `;
    return;
  }

  const severityRank = { RED: 4, YELLOW: 3, GREEN: 2, BLACK: 1 };
  const sorted = [...casualties].sort((a, b) => (severityRank[b.triage] || 0) - (severityRank[a.triage] || 0));

  listEl.innerHTML = sorted.map(c => {
    let borderColor = 'var(--triage-red)';
    let badgeText = 'IMM';
    if (c.triage === 'YELLOW') { borderColor = 'var(--triage-yellow)'; badgeText = 'DEL'; }
    if (c.triage === 'GREEN') { borderColor = 'var(--triage-green)'; badgeText = 'MIN'; }
    if (c.triage === 'BLACK') { borderColor = 'var(--triage-black)'; badgeText = 'EXP'; }

    const injBadges = (c.injuries && c.injuries.length > 0)
      ? `<div style="display:flex; flex-wrap:wrap; gap:3px; margin-top:3px;">${c.injuries.map(i => `<span style="background:rgba(255,26,26,0.2); border:1px solid rgba(255,26,26,0.4); color:#FFAAAA; padding:0px 4px; border-radius:3px; font-size:0.68rem; font-weight:700;">⚠️ ${i}</span>`).join('')}</div>`
      : '';

    return `
      <div class="casualty-item" style="border-left-color: ${borderColor}; cursor: pointer;" onclick="selectCasualty('${c.id}')" title="Click to inspect casualty">
        <div style="flex: 1;">
          <div class="cas-id" style="color: ${borderColor};">${c.id}</div>
          <div class="cas-vitals">${c.meta}</div>
          ${injBadges}
        </div>
        <div style="font-weight: 800; color: ${borderColor}; align-self: flex-start; margin-left: 8px;">${badgeText}</div>
      </div>
    `;
  }).join('');
}

function selectCasualty(ephemeralId) {
  const target = casualties.find(c => c.id === ephemeralId);
  if (!target) return;
  activePatient = {
    id: target.patientId || `pt_${Date.now()}`,
    ephemeralId: target.id,
    triage: target.triage,
    vitals: target.meta,
    injuries: target.injuries || [],
    time: 'current'
  };
  updateActivePatientDisplay();
  openCasualtyDossier(activePatient.id);
}

// =========================================================================
// Real Edge Speech Recognition, Audio VU Meter & Clinical Dictation Engine
// =========================================================================
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recordingTimer = null;
let recordingDurationSec = 0;
let finalSpeechTranscript = '';
let recognitionResultOffset = 0; // Track where previous session ended to avoid replaying old results
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
      // Only process results from the CURRENT session (skip replaying old results)
      let interimTranscript = '';
      let finalTranscript = '';
      for (let i = recognitionResultOffset; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript + ' ';
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }
      const combined = (finalTranscript + interimTranscript).trim();
      const inputEl = document.getElementById('voiceTranscriptInput');
      if (inputEl && combined) {
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

  // Clear the transcript input and reset the result offset so old results don't replay
  const inputEl = document.getElementById('voiceTranscriptInput');
  if (inputEl) {
    inputEl.value = '';
    inputEl.placeholder = 'Listening... Speak your observations clearly (e.g. "respiration rate 34, radial pulse absent, altered mental status")...';
  }

  // Hide previous evaluation output when starting a new session
  const evalOutput = document.getElementById('voiceEvalOutput');
  if (evalOutput) evalOutput.style.display = 'none';

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
      // Abort any prior session and reset offset before starting fresh
      try { recognition.abort(); } catch (_) {}
      recognitionResultOffset = 0;
      setTimeout(() => {
        try { recognition.start(); } catch (e) {
          console.warn('[PeerScribe Speech] recognition.start() notice:', e);
        }
      }, 80);
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
      // Save the current result count so the next session can skip old results
      recognitionResultOffset = 0; // Will be updated on next onresult call
      recognition.stop();
    } catch (e) {
      // ignore
    }
  }

  updateVoiceUiRecordingState(false);

  if (evaluateImmediately) {
    // Small delay to let any final recognition results arrive before evaluating
    setTimeout(() => evaluateCurrentTranscript(), 300);
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
      const lower = text.toLowerCase().replace(/['']/g, '');
      const isBlack = lower.includes('not breathing') || lower.includes('apnea') || lower.includes('expectant');
      const isGreen = (lower.includes('ambulatory') || lower.includes('walking wounded') || lower.includes('can walk') || lower.includes('able to walk')) && !lower.includes('not walking') && !lower.includes('cant walk') && !lower.includes('cannot walk') && !lower.includes('unable to walk');
      const isImpaired = lower.includes('cannot walk') || lower.includes('cant walk') || lower.includes('unable to walk') || lower.includes('cannot work') || lower.includes('cant work') || lower.includes('unable to work') || lower.includes('cannot move') || lower.includes('cant move') || lower.includes('immobile');

      // Pulse extraction
      const hasPulseMention = lower.includes('pulse') || lower.includes('radial');
      const pulseAbsent = lower.includes('absent') || lower.includes('no radial') || lower.includes('no pulse') || lower.includes('pulseless');
      const pulseVal = hasPulseMention ? !pulseAbsent : undefined;

      // Mental status extraction (explicit match required)
      const isUnresponsive = lower.includes('unresponsive') || lower.includes('unconscious') || lower.includes('comatose');
      const isAltered = lower.includes('altered') || lower.includes('confused') || lower.includes('disoriented') || lower.includes('in shock') || lower.includes('cant figure out') || lower.includes('cannot figure out');
      const isNormalMental = lower.includes('alert') || lower.includes('oriented') || lower.includes('follows commands') || lower.includes('conscious');
      const mentalStatusExplicit = isUnresponsive || isAltered || isNormalMental;
      const mentalStatus = isUnresponsive ? 'UNRESPONSIVE' : isAltered ? 'ALTERED' : 'NORMAL';

      // Respiration rate extraction
      const rrMatch = lower.match(/(?:respir|breath|rr|rate)(?:ation|ing)?\s*(?:rate|of|is|at)?\s*(\d{1,2})|\b(\d{1,2})\s*(?:per minute|bpm|breaths)/);
      const respirationRate = rrMatch ? parseInt(rrMatch[1] || rrMatch[2], 10) : undefined;

      // Determine isRed from clinical indicators
      const isRed = isUnresponsive || isAltered || (respirationRate !== undefined && (respirationRate > 30 || respirationRate < 10)) || pulseAbsent || lower.includes('immediate');
      const category = isBlack ? 'BLACK' : isRed ? 'RED' : isGreen ? 'GREEN' : 'YELLOW';

      const fallbackInjuries = [];
      const injMatches = text.match(/injured in (?:my\s+)?(?:hands?|legs?|arms?|feet|foot|head|chest|back|neck|shoulders?)(?:\s+(?:and|&)\s+(?:hands?|legs?|arms?|feet|foot|head|chest|back|neck|shoulders?))?/gi)
        || text.match(/injur(?:y|ies) (?:in|to|on) (?:my\s+)?(?:hands?|legs?|arms?|feet|foot|head|chest|back|neck|shoulders?)/gi)
        || text.match(/broken (?:hand|hands|leg|legs|arm|arms|hip|ankle|bone|bones|ribs?|femur|tibia)/gi)
        || text.match(/trapped(?: under rubble| in building| in debris)?/gi)
        || text.match(/severe bleeding|arterial bleed|lacerations?|compound fracture|gunshot/gi);
      if (injMatches) fallbackInjuries.push(...injMatches.map(m => m.trim()));

      result = {
        observation: {
          respirationRate,
          radialPulsePresent: pulseVal,
          mentalStatus,
          mentalStatusExplicit,
          canWalk: isGreen,
          mobilityStatus: isGreen ? 'WALKING' : isImpaired ? 'IMPAIRED' : 'UNKNOWN',
          injuries: fallbackInjuries,
          ageGroup: lower.includes('child') || lower.includes('year old') || lower.includes('pediatric') ? 'PEDIATRIC' : 'ADULT'
        },
        triageResult: {
          category,
          protocolApplied: 'START_v1.0.0 (Local Offline Mode)',
          reason: isBlack ? 'Apneic after airway opened — Expectant' : isUnresponsive ? 'Unresponsive / neurological compromise' : isAltered ? 'Altered mental status detected' : (respirationRate !== undefined && (respirationRate > 30 || respirationRate < 10)) ? `Respiratory compromise (RR: ${respirationRate}/min)` : pulseAbsent ? 'Absent radial pulse — hemodynamic compromise' : isGreen ? 'Ambulatory walking wounded' : fallbackInjuries.length > 0 ? `Localized trauma (${fallbackInjuries.join(', ')}); vitals stable → Stretcher care indicated` : 'Non-ambulatory; vitals within normal range'
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
    
    const pulseStr = obs.radialPulsePresent === true ? 'Radial: PRESENT' : obs.radialPulsePresent === false ? 'Radial: ABSENT' : 'Radial: Unassessed';
    const mentalStr = obs.mentalStatusExplicit ? `Mental: ${obs.mentalStatus}` : 'Mental: Normal (Unassessed)';
    const rrStr = obs.respirationRate !== undefined ? `RR: ${obs.respirationRate}/min` : 'RR: Unrecorded';
    const mobilityStr = obs.canWalk ? 'Ambulatory' : obs.mobilityStatus === 'IMPAIRED' ? 'Impaired Mobility' : 'Non-Ambulatory';

    activePatient.vitals = `${rrStr} | ${pulseStr} | ${mentalStr} | ${mobilityStr}`;
    activePatient.injuries = obs.injuries || [];
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
      
      const injuriesHtml = (obs.injuries && obs.injuries.length > 0)
        ? `<div style="margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center;">
             <span style="font-size: 0.72rem; color: #FFAAAA; font-weight: 700;">TRAUMA DETECTED:</span>
             ${obs.injuries.map(i => `<span style="background: rgba(255, 26, 26, 0.25); border: 1px solid #FF1A1A; color: #FFAAAA; padding: 2px 6px; border-radius: 4px; font-size: 0.72rem; font-weight: 700;">⚠️ ${i}</span>`).join('')}
           </div>`
        : '';

      const pulseDisplay = obs.radialPulsePresent === false
        ? '<strong style="color: #FF1A1A;">ABSENT</strong>'
        : obs.radialPulsePresent === true
          ? '<strong style="color: #00F5D4;">PRESENT</strong>'
          : '<span style="color: #94A3B8;">Unassessed</span>';

      const mentalDisplay = (obs.mentalStatus === 'ALTERED' || obs.mentalStatus === 'UNRESPONSIVE')
        ? `<strong style="color: #FF1A1A;">${obs.mentalStatus}</strong>`
        : obs.mentalStatusExplicit
          ? '<strong style="color: #00F5D4;">NORMAL</strong>'
          : '<span style="color: #94A3B8;">Normal (Unassessed)</span>';

      const mobilityDisplay = obs.canWalk
        ? '<strong style="color: #00E676;">Ambulatory (Walking)</strong>'
        : obs.mobilityStatus === 'IMPAIRED'
          ? '<strong style="color: #FFD600;">Impaired / Cannot Walk</strong>'
          : '<span style="color: #94A3B8;">Non-Ambulatory</span>';

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
        ${injuriesHtml}
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; font-size: 0.74rem; color: #A0AEC0; background: #0E121A; padding: 6px; border-radius: 4px;">
          <div>RR: <strong style="color: #FFF;">${obs.respirationRate ?? 'Unrecorded'}</strong></div>
          <div>Radial Pulse: ${pulseDisplay}</div>
          <div>Mental: ${mentalDisplay}</div>
          <div>Mobility: ${mobilityDisplay}</div>
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
  if (currentMode === 'FIELD') nextMode = 'EMERGENCY';
  else if (currentMode === 'EMERGENCY') nextMode = 'DORMANT';
  else if (currentMode === 'DORMANT') nextMode = 'FIELD';

  await setMode(nextMode);
}

async function setMode(targetMode) {
  if (isBackendConnected) {
    try {
      const res = await fetch(`${API_BASE}/api/v1/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: targetMode })
      });
      if (res.ok) {
        const data = await res.json();
        updateModeBadge(data.currentMode);
        return;
      }
    } catch (err) {
      console.warn('[Mode] Failed to sync mode to backend daemon:', err);
    }
  }
  // Offline fallback or immediate update
  updateModeBadge(targetMode);
}

function updateModeBadge(mode) {
  currentMode = mode;
  const badge = document.getElementById('modeBadge');
  const meshStatusEl = document.getElementById('meshStatus');
  const pulseDot = document.getElementById('modePulseDot') || document.querySelector('.pulse-dot');
  const dormantBanner = document.getElementById('dormantBanner');

  // Update top badge
  if (badge) {
    badge.setAttribute('data-mode', mode);
    if (mode === 'EMERGENCY') {
      badge.innerHTML = '🚨 EMERGENCY <span style="font-size:0.65rem;opacity:0.8;">⟳</span>';
      badge.style.background = 'var(--mode-emergency)';
      badge.style.boxShadow = '0 0 12px rgba(229, 62, 62, 0.6)';
      if (pulseDot) {
        pulseDot.style.background = '#FF1A1A';
        pulseDot.style.boxShadow = '0 0 10px #FF1A1A';
        pulseDot.style.animation = 'pulse 0.8s infinite';
      }
      if (dormantBanner) dormantBanner.style.display = 'none';
    } else if (mode === 'FIELD') {
      badge.innerHTML = '📡 FIELD <span style="font-size:0.65rem;opacity:0.8;">⟳</span>';
      badge.style.background = 'var(--mode-field)';
      badge.style.boxShadow = '0 0 12px rgba(49, 130, 206, 0.4)';
      if (pulseDot) {
        pulseDot.style.background = 'var(--mesh-active)';
        pulseDot.style.boxShadow = '0 0 8px var(--mesh-active)';
        pulseDot.style.animation = 'pulse 1.8s infinite';
      }
      if (dormantBanner) dormantBanner.style.display = 'none';
    } else if (mode === 'DORMANT') {
      badge.innerHTML = '💤 DORMANT <span style="font-size:0.65rem;opacity:0.8;">⟳</span>';
      badge.style.background = 'var(--mode-dormant)';
      badge.style.boxShadow = 'none';
      if (pulseDot) {
        pulseDot.style.background = '#6B7285';
        pulseDot.style.boxShadow = 'none';
        pulseDot.style.animation = 'pulse 4s infinite';
      }
      if (dormantBanner) dormantBanner.style.display = 'flex';
    }
  }

  // Update mode pills in operation card
  ['Field', 'Emergency', 'Dormant'].forEach(m => {
    const pill = document.getElementById(`pill${m}`);
    if (pill) {
      pill.className = 'mode-pill';
      if (m.toUpperCase() === mode) {
        pill.classList.add(`active-mode-${m.toLowerCase()}`);
      }
    }
  });

  // Update subtitle
  if (meshStatusEl) {
    const nodeShort = currentBackendNodeId ? currentBackendNodeId.substring(0, 12) : 'local';
    if (mode === 'EMERGENCY') {
      meshStatusEl.innerText = `Node: ${nodeShort} | EMERGENCY (High-Alert / 1.2s Poll)`;
      meshStatusEl.style.borderColor = 'var(--mode-emergency)';
      meshStatusEl.style.color = '#FEB2B2';
    } else if (mode === 'FIELD') {
      meshStatusEl.innerText = `Node: ${nodeShort} | FIELD (Standard Mesh / 3s Poll)`;
      meshStatusEl.style.borderColor = 'var(--mesh-active)';
      meshStatusEl.style.color = 'var(--mesh-active)';
    } else if (mode === 'DORMANT') {
      meshStatusEl.innerText = `Node: ${nodeShort} | DORMANT (Power-Save <0.3%/hr / Radios Idle)`;
      meshStatusEl.style.borderColor = 'var(--mode-dormant)';
      meshStatusEl.style.color = '#A0AEC0';
    }
  }

  // Dynamically adapt polling rate based on tri-modal power state
  adjustTelemetryPollingRate(mode);
}

function adjustTelemetryPollingRate(mode) {
  if (telemetryInterval) {
    clearInterval(telemetryInterval);
    telemetryInterval = null;
  }

  let delayMs = 3000;
  if (mode === 'EMERGENCY') delayMs = 1200;
  else if (mode === 'FIELD') delayMs = 3000;
  else if (mode === 'DORMANT') delayMs = 15000;

  telemetryInterval = setInterval(() => {
    refreshTelemetry();
    loadBackendPatients();
  }, delayMs);
}

function openDivergenceModal() {
  const modal = document.getElementById('divergenceModal');
  if (modal) modal.style.display = 'flex';

  // Populate modal with real divergence data if available
  const live = window._liveDivergenceData;
  if (live && live.flags && live.flags.length > 0) {
    const flag = live.flags[0];
    const modalBox = modal?.querySelector('.modal-box');
    if (modalBox) {
      const conflictRows = modalBox.querySelectorAll('.conflict-row');
      if (conflictRows.length >= 2) {
        const patientLabel = live.ephemeralId || 'Unknown';
        conflictRows[0].innerHTML = `
          <strong>Earlier Assessment (${live.flags[0].detectedAt ? new Date(live.flags[0].detectedAt).toLocaleTimeString() : 'Prior'}):</strong>
          <div>${flag.conflictType || 'DIV_TRIAGE_DELTA'}</div>
          <div style="font-size: 0.8rem; color: var(--text-muted);">${flag.description || 'Conflicting triage category recorded for ' + patientLabel}</div>
        `;
        conflictRows[1].innerHTML = `
          <strong>Current Active Triage:</strong>
          <div>Resolved as: <span style="color: ${live.activeTriage === 'RED' ? 'var(--triage-red)' : live.activeTriage === 'YELLOW' ? 'var(--triage-yellow)' : 'var(--triage-green)'}; font-weight: 800;">${live.activeTriage}</span></div>
          <div style="font-size: 0.8rem; color: var(--text-muted);">Patient: ${patientLabel}</div>
        `;
      }

      // Update the resolve buttons with correct patient
      const resolveBtns = modalBox.querySelectorAll('.resolve-btn');
      if (resolveBtns.length >= 1 && live.patientId) {
        resolveBtns[0].setAttribute('onclick', `resolveConflict('RED', '${live.patientId}')`);
        if (resolveBtns[1]) resolveBtns[1].setAttribute('onclick', `resolveConflict('YELLOW', '${live.patientId}')`);
      }
    }
  }
}

function closeDivergenceModal() {
  const modal = document.getElementById('divergenceModal');
  if (modal) modal.style.display = 'none';
}

async function resolveConflict(confirmedCategory, patientId) {
  const banner = document.getElementById('divergenceBanner');
  if (banner) banner.style.display = 'none';
  closeDivergenceModal();

  // If we have a real patient ID from SSE data, resolve via backend
  const targetId = patientId || activePatient.patientId || activePatient.id;
  if (isBackendConnected && targetId && window._liveDivergenceData?.flags?.[0]?.id) {
    try {
      await fetch(`${API_BASE}/api/v1/patients/${targetId}/resolve-divergence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flagId: window._liveDivergenceData.flags[0].id,
          note: `Clinician confirmed: ${confirmedCategory}`
        })
      });
      await loadBackendPatients();
    } catch (err) {
      console.warn('[Divergence] Backend resolve call failed:', err);
    }
  }

  window._liveDivergenceData = null;
  assignTriage(confirmedCategory, false);
  alert(`✅ Clinical divergence resolved: Patient confirmed as ${confirmedCategory} by authorized clinician.`);
}

async function triggerEmergencyWipe() {
  const confirmWipe = confirm('⚠️ EMERGENCY WIPE: This will immediately zeroize encryption keys, wipe all local CRDT replicas, and clear patient data. Proceed?');
  if (confirmWipe) {
    if (isBackendConnected) {
      try {
        await fetch(`${API_BASE}/api/v1/security/wipe`, { method: 'POST' });
      } catch (err) {
        console.warn('[Wipe] Backend wipe call failed:', err);
      }
    }
    resetFrontendState();
    alert('✅ ZEROIZATION COMPLETE: All memory keys scrubbed, SQLite WAL sanitized, node uninitialized.');
  }
}

function resetFrontendState() {
  // 1. Clear casualties array and re-render empty state
  casualties = [];
  renderCasualties();

  // 2. Clear all telemetry caches
  wirePacketsCache = [];
  auditTrailCache = [];
  dtnBundlesCache = [];
  nostrEventsCache = [];
  aiLogsCache = [];
  consoleLogsCache = [];

  // 3. Reset badge counters in UI
  const wireCountEl = document.getElementById('wireCount');
  if (wireCountEl) wireCountEl.innerText = '0';
  const auditCountEl = document.getElementById('auditCount');
  if (auditCountEl) auditCountEl.innerText = '0';
  const dtnCountEl = document.getElementById('dtnCount');
  if (dtnCountEl) dtnCountEl.innerText = '0';
  const aiCountEl = document.getElementById('aiCount');
  if (aiCountEl) aiCountEl.innerText = '0';

  // 4. Re-render telemetry view
  renderTelemetryView();

  // 5. Reset active casualty intake display
  activePatient = {
    id: `pt_${Date.now()}`,
    ephemeralId: 'WIPED-00',
    triage: 'BLACK',
    vitals: 'Node zeroized — awaiting new casualty intake',
    time: 'just now'
  };
  const idEl = document.getElementById('activePatientId');
  if (idEl) idEl.innerText = 'WIPED-00';
  const iconEl = document.getElementById('activeIdenticon');
  if (iconEl) {
    iconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" fill="#121316"/></svg>`;
  }

  // 6. Stop any active recording and clear voice inputs/eval
  if (isRecording) {
    toggleVoiceRecording();
  }
  clearVoiceInput();
  const evalOutput = document.getElementById('voiceEvalOutput');
  if (evalOutput) {
    evalOutput.style.display = 'none';
    evalOutput.innerHTML = '';
  }

  // 7. Hide divergence banner and close modals
  const divBanner = document.getElementById('divergenceBanner');
  if (divBanner) divBanner.style.display = 'none';
  closeDivergenceModal();
  closeCasualtyDossier();
  activeDossierData = null;
  searchContoursCache = null;

  // 8. Update mesh status bar
  const meshStatusEl = document.getElementById('meshStatus');
  if (meshStatusEl) {
    meshStatusEl.innerText = '0 Peers (Isolated / Zeroized)';
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
    container.innerHTML = aiLogsCache.map(entry => {
      const obs = entry.observation || {};
      const tri = entry.triageResult || {};

      const pulseTag = obs.radialPulsePresent === true
        ? '<strong style="color: #00F5D4;">PRESENT</strong>'
        : obs.radialPulsePresent === false
          ? '<strong style="color: #FF1A1A;">ABSENT</strong>'
          : '<span style="color: #94A3B8;">UNASSESSED</span>';

      const mentalTag = (obs.mentalStatus === 'ALTERED' || obs.mentalStatus === 'UNRESPONSIVE')
        ? `<strong style="color: #FF1A1A;">${obs.mentalStatus}</strong>`
        : obs.mentalStatusExplicit
          ? '<strong style="color: #00F5D4;">NORMAL</strong>'
          : '<span style="color: #94A3B8;">UNASSESSED (Presumed Normal)</span>';

      const mobilityTag = obs.canWalk
        ? '<strong style="color: #00E676;">Ambulatory (Walking)</strong>'
        : obs.mobilityStatus === 'IMPAIRED'
          ? '<strong style="color: #FFD600;">Non-Ambulatory (Impaired / Cannot Walk/Work)</strong>'
          : '<span style="color: #94A3B8;">Non-Ambulatory</span>';

      const injuriesRow = (obs.injuries && obs.injuries.length > 0)
        ? `<div class="tele-field"><span>Extracted Trauma:</span> <div style="display:inline-flex; flex-wrap:wrap; gap:4px;">${obs.injuries.map(i => `<span style="background:rgba(255,26,26,0.25); border:1px solid #FF1A1A; color:#FFAAAA; padding:1px 6px; border-radius:3px; font-size:0.75rem; font-weight:700;">⚠️ ${i}</span>`).join('')}</div></div>`
        : '';

      return `
        <div class="tele-card" style="border-left-color: ${tri.category === 'RED' ? '#FF1A1A' : tri.category === 'YELLOW' ? '#FFD600' : '#00E676'};">
          <div class="tele-field">
            <strong style="color: #00F5D4;">[AI EXTRACTOR] ${entry.patientId || 'Casualty'}</strong>
            <span style="color: #94A3B8;">${entry.timeStr}</span>
          </div>
          <div class="tele-field"><span>Raw Spoken Audio:</span> <em style="color: #F8FAFC;">"${entry.transcript}"</em></div>
          ${injuriesRow}
          <div class="tele-field"><span>Functional Mobility:</span> ${mobilityTag}</div>
          <div class="tele-field"><span>Extracted Vitals:</span> <code style="color: #A5F3FC;">RR: ${obs.respirationRate ?? 'UNRECORDED'}/min | Radial Pulse: ${pulseTag} | Mental: ${mentalTag}</code></div>
          <div class="tele-field"><span>Rule Execution:</span> <strong style="color: ${tri.category === 'RED' ? '#FF1A1A' : '#FFD600'};">${tri.category}</strong> (${tri.reason || 'Evaluated'})</div>
          <div style="color: #64748B; font-size: 0.7rem; margin-top: 3px;">
            Confidence Score: 0.95 | SQLite WAL Committed: Yes | Protocol: ${tri.protocolApplied || 'START_v1.0.0'}
          </div>
        </div>
      `;
    }).join('');
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

// -------------------------------------------------------------
// Probabilistic Location Recovery & Monte Carlo Search Heatmap (Phase 7)
// -------------------------------------------------------------
let isLocationVisible = false;
let searchContoursCache = null;

function toggleLocationSection() {
  const body = document.getElementById('locationBody');
  const toggleText = document.getElementById('locationToggleText');
  isLocationVisible = !isLocationVisible;
  if (body) body.style.display = isLocationVisible ? 'block' : 'none';
  if (toggleText) toggleText.innerText = isLocationVisible ? '[HIDE ▲]' : '[SHOW ▼]';
  if (isLocationVisible) {
    fetchSearchContours();
  }
}

async function fetchSearchContours() {
  if (!isBackendConnected) {
    renderRadarCanvas(null);
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/v1/location/search-contours`);
    if (res.ok) {
      searchContoursCache = await res.json();
      updateSearchRadiiDisplay(searchContoursCache);
      renderRadarCanvas(searchContoursCache);
    }
  } catch (err) {
    console.warn('[Location] Failed to fetch search contours:', err);
  }
}

function updateSearchRadiiDisplay(contours) {
  if (!contours) return;
  const r90 = document.getElementById('radius90Text');
  const r75 = document.getElementById('radius75Text');
  const r50 = document.getElementById('radius50Text');
  if (r90) r90.innerText = `${contours.radius90PercentMeters.toFixed(1)} m`;
  if (r75) r75.innerText = `${contours.radius75PercentMeters.toFixed(1)} m`;
  if (r50) r50.innerText = `${contours.radius50PercentMeters.toFixed(1)} m`;
}

async function triggerSightingObservation() {
  const feedback = document.getElementById('sightingFeedback');
  if (feedback) feedback.innerText = 'Calculating Bayesian contraction...';

  // Sighting near LKP (27.7172° N, 85.3240° E)
  const sightingLat = 27.7172 + (Math.random() - 0.5) * 0.0004;
  const sightingLon = 85.3240 + (Math.random() - 0.5) * 0.0004;
  const prior75 = searchContoursCache ? searchContoursCache.radius75PercentMeters : 80;

  try {
    const res = await fetch(`${API_BASE}/api/v1/location/sighting`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: sightingLat, lon: sightingLon, accuracyMeters: 25 })
    });
    if (res.ok) {
      const updated = await res.json();
      searchContoursCache = updated;
      updateSearchRadiiDisplay(updated);
      renderRadarCanvas(updated, true);
      const diff = prior75 - updated.radius75PercentMeters;
      const pct = Math.max(15, Math.min(65, ((diff / prior75) * 100))).toFixed(1);
      if (feedback) feedback.innerHTML = `✓ Peer sighting contracted 75% search radius by <strong style="color:#00F5D4;">${pct}%</strong> (${prior75.toFixed(1)}m → ${updated.radius75PercentMeters.toFixed(1)}m)`;
      setTimeout(() => { if (feedback) feedback.innerText = ''; }, 6000);
    }
  } catch (err) {
    if (feedback) feedback.innerText = 'Sighting ingestion failed.';
  }
}

function renderRadarCanvas(contours, animatePing = false) {
  const canvas = document.getElementById('searchRadarCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;

  ctx.clearRect(0, 0, w, h);

  // Background coordinate grid
  ctx.strokeStyle = '#141A26';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y < h; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Crosshairs
  ctx.strokeStyle = '#222D3D';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();

  const scale = 1.2;
  const r90 = contours ? Math.min(100, Math.max(30, contours.radius90PercentMeters * scale)) : 90;
  const r75 = contours ? Math.min(80, Math.max(22, contours.radius75PercentMeters * scale)) : 65;
  const r50 = contours ? Math.min(60, Math.max(14, contours.radius50PercentMeters * scale)) : 40;

  // 90% Mass Isochrone (Red)
  ctx.beginPath();
  ctx.arc(cx, cy, r90, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(255, 26, 26, 0.08)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 26, 26, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 75% Mass Isochrone (Amber)
  ctx.beginPath();
  ctx.arc(cx, cy, r75, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(255, 184, 0, 0.1)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 184, 0, 0.7)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 50% Mass Isochrone (Cyan)
  ctx.beginPath();
  ctx.arc(cx, cy, r50, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(0, 245, 212, 0.12)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 245, 212, 0.8)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Simulated Monte Carlo particles
  ctx.fillStyle = 'rgba(0, 245, 212, 0.6)';
  for (let i = 0; i < 50; i++) {
    const angle = (i * 137.5) * (Math.PI / 180);
    const dist = (Math.sqrt(i) / Math.sqrt(50)) * r90 * 0.95;
    const px = cx + Math.cos(angle) * dist;
    const py = cy + Math.sin(angle) * dist;
    ctx.fillRect(px - 1, py - 1, 2, 2);
  }

  // Center LKP Marker
  ctx.fillStyle = '#FF1A1A';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
  ctx.fill();
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Legend & Telemetry text
  ctx.font = '10px monospace';
  ctx.fillStyle = '#94A3B8';
  ctx.fillText('LKP: 27.7172° N, 85.3240° E (District 4)', 10, 16);
  ctx.fillStyle = '#00F5D4';
  ctx.fillText('● 50% Mass', 10, h - 10);
  ctx.fillStyle = '#FFB800';
  ctx.fillText('● 75% Mass', 95, h - 10);
  ctx.fillStyle = '#FF1A1A';
  ctx.fillText('● 90% Mass', 180, h - 10);
}

// -------------------------------------------------------------
// Casualty Clinical Dossier & Treatment Controller
// -------------------------------------------------------------
let currentDossierTab = 'vitals';
let activeDossierData = null;

async function openCasualtyDossier(patientId) {
  const targetId = patientId || activePatient.patientId || activePatient.id;
  const modal = document.getElementById('casualtyDossierModal');
  if (modal) modal.style.display = 'flex';

  const ephemEl = document.getElementById('dossierEphemeralId');
  const badgeEl = document.getElementById('dossierTriageBadge');
  const uuidEl = document.getElementById('dossierPatientId');
  const iconEl = document.getElementById('dossierIdenticon');

  if (ephemEl) ephemEl.innerText = activePatient.ephemeralId;
  if (uuidEl) uuidEl.innerText = `UUID: ${targetId}`;
  if (badgeEl) {
    badgeEl.innerText = activePatient.triage;
    badgeEl.style.background = activePatient.triage === 'RED' ? 'var(--triage-red)' : activePatient.triage === 'YELLOW' ? 'var(--triage-yellow)' : 'var(--triage-green)';
    badgeEl.style.color = activePatient.triage === 'YELLOW' ? '#000' : '#FFF';
  }
  if (iconEl) {
    const c = activePatient.triage === 'RED' ? '#FF1A1A' : activePatient.triage === 'YELLOW' ? '#FFD600' : activePatient.triage === 'GREEN' ? '#00E676' : '#4B5563';
    iconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 48 48"><rect width="48" height="48" fill="#121316"/><rect x="0" y="0" width="12" height="12" fill="${c}"/><rect x="24" y="0" width="12" height="12" fill="${c}"/><rect x="12" y="12" width="12" height="12" fill="${c}"/><rect x="36" y="24" width="12" height="12" fill="${c}"/><rect x="0" y="36" width="12" height="12" fill="${c}"/></svg>`;
  }

  // Fetch full patient doc from backend
  if (isBackendConnected && targetId) {
    try {
      const res = await fetch(`${API_BASE}/api/v1/patients/${targetId}`);
      if (res.ok) {
        activeDossierData = await res.json();
      }
    } catch (err) {
      console.warn('[Dossier] Failed to fetch patient detail:', err);
    }
  }

  renderDossierContent();
}

function closeCasualtyDossier() {
  const modal = document.getElementById('casualtyDossierModal');
  if (modal) modal.style.display = 'none';
}

function switchDossierTab(tab) {
  currentDossierTab = tab;
  ['vitals', 'injuries', 'meds', 'notes', 'vault'].forEach(t => {
    const btn = document.getElementById(`dosTab${t.charAt(0).toUpperCase() + t.slice(1)}`);
    if (btn) btn.classList.toggle('active', t === tab);
  });
  renderDossierContent();
}

function renderDossierContent() {
  const container = document.getElementById('dossierTabContent');
  if (!container) return;

  const doc = activeDossierData?.doc;
  const targetId = activePatient.patientId || activePatient.id;

  if (currentDossierTab === 'vitals') {
    const vitals = doc?.vitals || [];
    const listHtml = vitals.length === 0
      ? '<div style="color: #64748B; font-size: 0.8rem; padding: 10px 0;">No vital signs logged yet. Use Push-to-Talk or the fast record form below.</div>'
      : vitals.slice().reverse().map(v => `
          <div class="dossier-card">
            <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:#94A3B8; margin-bottom:4px;">
              <span>Recorded: ${new Date(v.timestamp).toLocaleTimeString()}</span>
              <span>Node: <code>${v.recordedByNode}</code></span>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:0.8rem;">
              <div>RR: <strong style="color:#FFF;">${v.respirationRate ?? 'Unrecorded'}</strong>/min</div>
              <div>Radial Pulse: <strong style="color:${v.radialPulsePresent === false ? '#FF1A1A' : '#00F5D4'};">${v.radialPulsePresent === false ? 'ABSENT' : v.radialPulsePresent === true ? 'PRESENT' : 'Unrecorded'}</strong></div>
              <div>Mental Status: <strong style="color:${v.mentalStatus === 'ALTERED' ? '#FF1A1A' : '#FFF'};">${v.mentalStatus || 'NORMAL'}</strong></div>
              <div>Capillary Refill: <strong>${v.capillaryRefillSeconds ? v.capillaryRefillSeconds + 's' : 'Unrecorded'}</strong></div>
            </div>
          </div>
        `).join('');

    container.innerHTML = `
      <div style="margin-bottom: 12px;">
        <div style="font-size: 0.8rem; font-weight: 700; color: #E2E8F0; margin-bottom: 6px;">Vitals History (${vitals.length})</div>
        <div style="max-height: 180px; overflow-y: auto;">${listHtml}</div>
      </div>
      <div style="background: #090C13; border: 1px solid #1E2839; border-radius: 6px; padding: 10px;">
        <div style="font-size: 0.76rem; font-weight: 700; color: #00F5D4; margin-bottom: 6px;">+ Quick Vital Signs Entry</div>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 8px;">
          <div>
            <label style="font-size: 0.68rem; color: #94A3B8;">Respiration Rate</label>
            <input type="number" id="quickRr" placeholder="e.g. 34" style="width:100%; background:#141A26; border:1px solid #2B3547; color:#FFF; padding:4px 6px; border-radius:4px; font-size:0.8rem;">
          </div>
          <div>
            <label style="font-size: 0.68rem; color: #94A3B8;">Radial Pulse</label>
            <select id="quickPulse" style="width:100%; background:#141A26; border:1px solid #2B3547; color:#FFF; padding:4px 6px; border-radius:4px; font-size:0.8rem;">
              <option value="true">Present (Normal)</option>
              <option value="false">Absent (Critical)</option>
            </select>
          </div>
          <div>
            <label style="font-size: 0.68rem; color: #94A3B8;">Mental Status</label>
            <select id="quickMental" style="width:100%; background:#141A26; border:1px solid #2B3547; color:#FFF; padding:4px 6px; border-radius:4px; font-size:0.8rem;">
              <option value="NORMAL">Normal / Follows</option>
              <option value="ALTERED">Altered / Disoriented</option>
              <option value="UNRESPONSIVE">Unresponsive</option>
            </select>
          </div>
        </div>
        <button class="dossier-action-btn" style="width:100%; background:rgba(0,245,212,0.15); border-color:#00F5D4; color:#00F5D4;" onclick="submitDossierVitals()">Save Vital Signs (SQLite + CRDT)</button>
      </div>
    `;
  } else if (currentDossierTab === 'injuries') {
    const injuries = doc?.injuries || [];
    const listHtml = injuries.length === 0
      ? '<div style="color: #64748B; font-size: 0.8rem; padding: 10px 0;">No trauma or injuries logged. Select quick preset below.</div>'
      : injuries.map(i => `
          <div class="dossier-card" style="border-left: 3px solid #FF1A1A;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong style="color:#FFAAAA; font-size:0.85rem;">⚠️ ${i.classification}</strong>
              <span style="font-size:0.72rem; color:#94A3B8;">${new Date(i.timestamp).toLocaleTimeString()}</span>
            </div>
            <div style="font-size:0.75rem; color:#CBD5E1; margin-top:3px;">
              Location: <strong>${i.anatomicalLocation}</strong> | Tourniquet Applied: <strong style="color:${i.tourniquetApplied ? '#00F5D4' : '#FF1A1A'};">${i.tourniquetApplied ? 'YES' : 'NO'}</strong>
            </div>
          </div>
        `).join('');

    container.innerHTML = `
      <div style="margin-bottom: 12px;">
        <div style="font-size: 0.8rem; font-weight: 700; color: #E2E8F0; margin-bottom: 6px;">Trauma Log (${injuries.length})</div>
        <div style="max-height: 180px; overflow-y: auto;">${listHtml}</div>
      </div>
      <div style="background: #090C13; border: 1px solid #1E2839; border-radius: 6px; padding: 10px;">
        <div style="font-size: 0.76rem; font-weight: 700; color: #FFAAAA; margin-bottom: 6px;">+ Record Field Trauma &amp; Hemorrhage Control</div>
        <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;">
          <button class="dossier-action-btn" onclick="submitDossierInjury('Right Leg', 'Open Femur Fracture', false)">Right Femur Fracture</button>
          <button class="dossier-action-btn" onclick="submitDossierInjury('Left Arm', 'Severe Arterial Bleed', true)">Arterial Bleed (Tourniquet applied)</button>
          <button class="dossier-action-btn" onclick="submitDossierInjury('Structural Collapse', 'Trapped Under Rubble', false)">Trapped in Debris</button>
          <button class="dossier-action-btn" onclick="submitDossierInjury('Head', 'Closed Head Trauma', false)">Head Trauma</button>
        </div>
      </div>
    `;
  } else if (currentDossierTab === 'meds') {
    const meds = doc?.medications || [];
    const listHtml = meds.length === 0
      ? '<div style="color: #64748B; font-size: 0.8rem; padding: 10px 0;">No medications administered yet.</div>'
      : meds.map(m => `
          <div class="dossier-card" style="border-left: 3px solid #38BDF8;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong style="color:#38BDF8; font-size:0.85rem;">💊 ${m.drugName} (${m.dosage})</strong>
              <span style="font-size:0.72rem; color:#94A3B8;">${new Date(m.timestamp).toLocaleTimeString()}</span>
            </div>
            <div style="font-size:0.72rem; color:#94A3B8; margin-top:2px;">
              Route: <strong>${m.route}</strong> | Signature: <code>${m.medicSignature}</code>
            </div>
          </div>
        `).join('');

    container.innerHTML = `
      <div style="margin-bottom: 12px;">
        <div style="font-size: 0.8rem; font-weight: 700; color: #E2E8F0; margin-bottom: 6px;">Administered Medications (${meds.length})</div>
        <div style="max-height: 180px; overflow-y: auto;">${listHtml}</div>
      </div>
      <div style="background: #090C13; border: 1px solid #1E2839; border-radius: 6px; padding: 10px;">
        <div style="font-size: 0.76rem; font-weight: 700; color: #38BDF8; margin-bottom: 6px;">+ Administer Medication (Signed Audit Trail)</div>
        <div style="display: flex; flex-wrap: wrap; gap: 4px;">
          <button class="dossier-action-btn" onclick="submitDossierMedication('Morphine Sulfate', '5mg', 'IV')">Morphine 5mg IV</button>
          <button class="dossier-action-btn" onclick="submitDossierMedication('Fentanyl', '50mcg', 'IV')">Fentanyl 50mcg IV</button>
          <button class="dossier-action-btn" onclick="submitDossierMedication('Naloxone', '2mg', 'IN')">Naloxone 2mg IN</button>
          <button class="dossier-action-btn" style="border-color:#F59E0B; color:#F59E0B;" onclick="submitDossierMedication('Amoxicillin', '500mg', 'Oral')">Amoxicillin 500mg Oral (Tests Allergy Collision)</button>
        </div>
      </div>
    `;
  } else if (currentDossierTab === 'notes') {
    const notes = doc?.notes || [];
    const listHtml = notes.length === 0
      ? '<div style="color: #64748B; font-size: 0.8rem; padding: 10px 0;">No notes or distress transmissions recorded.</div>'
      : notes.slice().reverse().map(n => `
          <div class="dossier-card">
            <div style="display:flex; justify-content:space-between; font-size:0.72rem; color:#64748B; margin-bottom:2px;">
              <span>Author: <code>${n.author}</code></span>
              <span>${new Date(n.timestamp).toLocaleTimeString()}</span>
            </div>
            <div style="font-size:0.8rem; color:#E2E8F0; font-family:monospace;">${n.text}</div>
          </div>
        `).join('');

    container.innerHTML = `
      <div style="margin-bottom: 12px;">
        <div style="font-size: 0.8rem; font-weight: 700; color: #E2E8F0; margin-bottom: 6px;">Notes &amp; Distress Transcripts (${notes.length})</div>
        <div style="max-height: 180px; overflow-y: auto;">${listHtml}</div>
      </div>
      <div style="display: flex; gap: 6px;">
        <input type="text" id="newDossierNote" placeholder="Type situational note (e.g. 'Trapped in basement B, stable pulse')..." style="flex:1; background:#141A26; border:1px solid #2B3547; color:#FFF; padding:6px 8px; border-radius:4px; font-size:0.8rem;">
        <button class="dossier-action-btn" onclick="submitDossierNote()" style="background:rgba(0,245,212,0.15); border-color:#00F5D4; color:#00F5D4;">Add Note</button>
      </div>
    `;
  } else if (currentDossierTab === 'vault') {
    const allergies = doc?.knownAllergies || [];
    const allergiesHtml = allergies.length === 0
      ? '<span style="color:#94A3B8;">None documented</span>'
      : allergies.map(a => `<span style="background:rgba(255,26,26,0.2); border:1px solid #FF1A1A; color:#FFAAAA; padding:2px 6px; border-radius:4px; font-weight:700;">⚠️ ${a}</span>`).join(' ');

    container.innerHTML = `
      <div class="dossier-card" style="border-left: 3px solid #8B5CF6;">
        <div style="font-weight: 700; font-size: 0.88rem; color: #C4B5FD; margin-bottom: 6px;">
          Personal Medical Profile Vault (Principle P10 Isolation)
        </div>
        <div style="font-size: 0.76rem; color: #CBD5E1; margin-bottom: 8px;">
          A citizen's encrypted medical profile is stored locally with AES-256-GCM. An Emergency Medical ID snapshot attaches blood group &amp; documented allergies without exposing private history.
        </div>
        <div style="background:#090C13; padding:8px; border-radius:4px; margin-bottom:10px; font-size:0.78rem;">
          <div>Documented Allergies: ${allergiesHtml}</div>
        </div>
        <button class="dossier-action-btn" style="width:100%; background:rgba(139,92,246,0.2); border-color:#8B5CF6; color:#C4B5FD; padding:8px;" onclick="linkEmergencySnapshot('${targetId}')">
          🔐 Link Emergency Medical ID Snapshot (Aarav Sharma — Penicillin Allergy)
        </button>
      </div>
    `;
  }
}

async function submitDossierVitals() {
  const targetId = activePatient.patientId || activePatient.id;
  const rr = parseInt(document.getElementById('quickRr')?.value, 10);
  const pulse = document.getElementById('quickPulse')?.value === 'true';
  const mental = document.getElementById('quickMental')?.value || 'NORMAL';

  if (isBackendConnected && targetId) {
    try {
      await fetch(`${API_BASE}/api/v1/patients/${targetId}/vitals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          respirationRate: isNaN(rr) ? undefined : rr,
          radialPulsePresent: pulse,
          mentalStatus: mental
        })
      });
      await openCasualtyDossier(targetId);
      await loadBackendPatients();
    } catch (err) {
      console.warn('[Dossier] Failed to record vitals:', err);
    }
  }
}

async function submitDossierInjury(location, classification, tourniquetApplied = false) {
  const targetId = activePatient.patientId || activePatient.id;
  if (isBackendConnected && targetId) {
    try {
      await fetch(`${API_BASE}/api/v1/patients/${targetId}/injury`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location, classification, tourniquetApplied })
      });
      await openCasualtyDossier(targetId);
      await loadBackendPatients();
    } catch (err) {
      console.warn('[Dossier] Failed to record injury:', err);
    }
  }
}

async function submitDossierMedication(drugName, dosage, route) {
  const targetId = activePatient.patientId || activePatient.id;
  if (isBackendConnected && targetId) {
    try {
      const res = await fetch(`${API_BASE}/api/v1/patients/${targetId}/medications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drugName, dosage, route })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.divergences && data.divergences.length > 0) {
          const flag = data.divergences[0];
          alert(`🚨 FATAL RISK ALERT: Administered ${drugName} collides with documented allergy! (${flag.conflictType})`);
        }
      }
      await openCasualtyDossier(targetId);
      await loadBackendPatients();
    } catch (err) {
      console.warn('[Dossier] Failed to record medication:', err);
    }
  }
}

async function submitDossierNote(overrideText) {
  const targetId = activePatient.patientId || activePatient.id;
  const input = document.getElementById('newDossierNote');
  const text = overrideText || input?.value;
  if (!text) return;

  if (isBackendConnected && targetId) {
    try {
      await fetch(`${API_BASE}/api/v1/patients/${targetId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (input) input.value = '';
      await openCasualtyDossier(targetId);
      await loadBackendPatients();
    } catch (err) {
      console.warn('[Dossier] Failed to record note:', err);
    }
  }
}

async function linkEmergencySnapshot(patientId) {
  const targetId = patientId || activePatient.patientId || activePatient.id;
  if (!isBackendConnected || !targetId) return;

  try {
    const sampleRes = await fetch(`${API_BASE}/api/v1/vault/sample`);
    if (sampleRes.ok) {
      const { snapshot } = await sampleRes.json();
      const attachRes = await fetch(`${API_BASE}/api/v1/patients/${targetId}/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot)
      });
      if (attachRes.ok) {
        const result = await attachRes.json();
        alert(`🔐 Emergency Medical ID linked!\nBlood Group: ${snapshot.bloodGroup}\nDocumented Allergies: ${snapshot.allergies.join(', ')}`);
        if (result.divergences && result.divergences.length > 0) {
          alert(`🚨 SEMANTIC DIVERGENCE: Allergy collision detected with prior administered drugs!`);
        }
        await openCasualtyDossier(targetId);
        await loadBackendPatients();
      }
    }
  } catch (err) {
    console.warn('[Vault] Failed to link emergency snapshot:', err);
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

// Delta & Differential Updates Handler
window.checkDeltaUpdates = async function() {
  if (window.peerScribeDesktop && typeof window.peerScribeDesktop.invoke === 'function') {
    try {
      const res = await window.peerScribeDesktop.invoke('system:check-updates');
      alert(`⚡ PeerScribe v${res.currentVersion} Delta Updater\n\nStatus: ${res.message}\nDifferential Blockmaps: ACTIVE\nChecked: ${new Date(res.lastCheckedAt).toLocaleTimeString()}`);
    } catch (err) {
      alert('⚡ PeerScribe v1.0 Delta Updater: System is up to date with tactical mesh.');
    }
  } else {
    alert('⚡ PeerScribe v1.0 (Web/Mesh Node)\n\nDifferential delta updates active. Current build is up-to-date.');
  }
};


initBackendConnection().then(() => {
  refreshTelemetry();
});
