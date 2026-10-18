/**
 * PeerScribe Tactical UI Controller
 * Fitts's Law 2-Tap Triage, Semantic Divergence Modal, and Simulated Mesh Relay
 */

const PHONETIC_ANIMALS = ['PANTHER', 'FALCON', 'WOLF', 'OTTER', 'BADGER', 'HAWK', 'BEAR', 'VIPER'];
let currentMode = 'EMERGENCY'; // EMERGENCY | FIELD | DORMANT
let isRecording = false;

// Simulated active state
let activePatient = {
  id: 'pt_001',
  ephemeralId: 'RED-PANTHER-04',
  triage: 'RED',
  vitals: 'RR: 34/min | Radial Pulse: Absent | Mental: Altered',
  time: '1m ago'
};

const casualties = [
  { id: 'RED-PANTHER-04', triage: 'RED', meta: 'RR: 34/min | Radial Pulse: Absent | Mental: Altered | 1m ago' },
  { id: 'YELLOW-OTTER-12', triage: 'YELLOW', meta: 'RR: 20/min | Radial Pulse: Normal | Mental: Alert | 4m ago' },
  { id: 'GREEN-WOLF-02', triage: 'GREEN', meta: 'Ambulatory | Minor laceration left forearm | 9m ago' }
];

// Trigger simulated divergence alert after 3 seconds for demonstration
setTimeout(() => {
  const banner = document.getElementById('divergenceBanner');
  if (banner) banner.style.display = 'block';
}, 3000);

function assignTriage(category) {
  // Update active patient
  activePatient.triage = category;
  
  // Feedback vibration if supported
  if (navigator.vibrate) {
    navigator.vibrate(category === 'RED' ? [100, 50, 100] : [50]);
  }

  // Update list
  const existing = casualties.find(c => c.id === activePatient.ephemeralId);
  if (existing) {
    existing.triage = category;
  } else {
    casualties.unshift({
      id: activePatient.ephemeralId,
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

function toggleVoiceRecording() {
  const ptt = document.getElementById('pttButton');
  const pttText = document.getElementById('pttText');

  if (!isRecording) {
    isRecording = true;
    ptt.classList.add('recording');
    pttText.innerText = 'Listening (Whisper ASR Live)...';

    // Simulate speech-to-structured clinical pipeline after 2.5s
    setTimeout(() => {
      isRecording = false;
      ptt.classList.remove('recording');
      pttText.innerText = 'Observed: RR 32, radial pulse absent -> RED';

      // Automatically evaluate START triage: RR 32 > 30 -> RED
      assignTriage('RED');
      setTimeout(() => {
        pttText.innerText = 'Push To Talk Clinical Observation';
      }, 3500);
    }, 2500);
  }
}

function toggleOperationalMode() {
  const badge = document.getElementById('modeBadge');
  if (currentMode === 'EMERGENCY') {
    currentMode = 'FIELD';
    badge.innerText = 'FIELD';
    badge.style.background = 'var(--mode-field)';
  } else if (currentMode === 'FIELD') {
    currentMode = 'DORMANT';
    badge.innerText = 'DORMANT';
    badge.style.background = 'var(--mode-dormant)';
  } else {
    currentMode = 'EMERGENCY';
    badge.innerText = 'EMERGENCY';
    badge.style.background = 'var(--mode-emergency)';
  }
}

function openDivergenceModal() {
  const modal = document.getElementById('divergenceModal');
  if (modal) modal.style.display = 'flex';
}

function closeDivergenceModal() {
  const modal = document.getElementById('divergenceModal');
  if (modal) modal.style.display = 'none';
}

function resolveConflict(confirmedCategory) {
  const banner = document.getElementById('divergenceBanner');
  if (banner) banner.style.display = 'none';
  closeDivergenceModal();

  assignTriage(confirmedCategory);
  alert(`Clinical divergence resolved: Patient confirmed as ${confirmedCategory} by authorized clinician.`);
}

function triggerEmergencyWipe() {
  const confirmWipe = confirm('⚠️ EMERGENCY WIPE: This will immediately zeroize encryption keys, wipe all local CRDT replicas, and clear patient data. Proceed?');
  if (confirmWipe) {
    casualties.length = 0;
    renderCasualties();
    document.getElementById('activePatientId').innerText = 'WIPED-00';
    document.getElementById('meshStatus').innerText = '0 Peers (Isolated)';
    alert('✅ ZEROIZATION COMPLETE: All memory keys scrubbed, SQLite WAL sanitized, node uninitialized.');
  }
}

// Initial render
renderCasualties();
