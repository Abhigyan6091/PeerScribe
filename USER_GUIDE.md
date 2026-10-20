# PeerScribe: Comprehensive Field & User Operational Guide
*Tactical Offline-First Disaster Triage, Edge AI Clinical Intake & P2P Mesh Synchronization*

---

## 1. Executive Overview & Mental Model

### What is PeerScribe?
**PeerScribe** is a mission-critical tactical medical application designed for mass-casualty incidents, structural collapses, battlefield trauma, and natural disasters where **cellular towers, power grids, and central cloud servers are completely dead**.

### The Core Mental Model
In standard disaster apps, data is sent to a central cloud server. In PeerScribe:
1. **Zero Central Server:** Every phone or laptop is an autonomous, self-sufficient mesh node with its own local SQLite WAL database and CRDT (Conflict-Free Replicated Data Type) engine.
2. **P2P Mesh Synchronization:** When first responders, citizen volunteers, and tactical medics walk within Bluetooth Low Energy (BLE) or Wi-Fi range (30–100m) of each other, their devices silently exchange encrypted 32-byte wire packets in a "bucket brigade."
3. **Principle P5 (AI Extracts, Never Prescribes):** Speech-to-Text and Edge NLP extract structured observations (e.g., respiration rate, radial pulse, broken bones) from voice dictation, but **all clinical triage decisions are computed 100% deterministically by audited START triage decision trees**—preventing lethal AI hallucinations.
4. **Anti-Capture Emergency Wipe:** In hostile territory or upon mission termination, a single tap cryptographically zeroizes encryption keys, wipes the SQLite database, and cleans in-memory state.

---

## 2. Quick Start: Launching the App

### Starting the Daemon & Web Interface
Open your terminal in the `PeerScribe` folder and run:

```bash
# 1. Start the PeerScribe node daemon and local tactical web server
npm run start
```

You will see the tactical terminal banner:
```
===============================================================
  PEERSCRIBE FIELD NODE DAEMON (BitChat P2P + Nostr)
===============================================================
  Status:       ONLINE & READY
  Node ID:      node_e19fcc94
  Sector:       u15ek200 (27.7172° N, 85.3240° E)
  Storage:      SQLite WAL Engine initialized (Zero-Central DB)
  Web UI:       http://localhost:4321
  Telemetry:    http://localhost:4321/api/v1/telemetry/packets
===============================================================
```

Now open your web browser (Chrome, Edge, Safari, or Firefox) and navigate to:
$$\text{\bf http://localhost:4321}$$

---

## 3. Screen Layout & Interface Tour

The user interface is optimized for **Fitts's Law (large 64px+ touch targets for trembling or gloved hands)** and **WCAG AAA ultra-high contrast for blinding glare and smoky environments**:

```
+-------------------------------------------------------------+
| [●] PEERSCRIBE                              [ 📡 FIELD ⟳ ]  |  <-- Top Tactical Bar & Mode
+-------------------------------------------------------------+
| District 4 Disaster Response #001                           |
| Sector Geohash: u15ek200 | 27.7172° N, 85.3240° E           |  <-- Operation Context Card
| [Node: node_e19fcc94 | FIELD] [FIELD] [EMERGENCY] [DORMANT] |
+-------------------------------------------------------------+
| 🚨 CLINICAL DIVERGENCE DETECTED (Click to Resolve)          |  <-- Semantic Conflict Banner
+-------------------------------------------------------------+
| Active Casualty: RED-PANTHER-04               [IDENTICON]   |  <-- Active Intake Card
| [ RED / IMM ] [ YELLOW / DEL ] [ GREEN / MIN ] [ BLACK / EXP] |  <-- Two-Tap START Buttons
|                                                             |
| [ 🎤 Push To Talk Clinical Observation         00:00 ]      |  <-- Push-to-Talk Voice Bar
| [  ▂▃▅▆▇  Audio VU Meter: 0.0 dB (Standby)          ]      |
|                                                             |
| [ Text Dictation / Speech Input Box                        ] |
| [ 🚨 Adult RR 36 ] [ 🦴 Broken Leg Trapped ] [ 💊 Morphine ]|  <-- Preset Quick Chips
| [ EVALUATE OBSERVATION ]  [ CLEAR ]                         |
|                                                             |
| [START TRIAGE RESULT & PARSED VITALS CARD                  ]|  <-- Extractor Breakdown
+-------------------------------------------------------------+
| CASUALTY FEED (Sorted by Severity: RED -> YELLOW -> GREEN)  |
| • RED-PANTHER-04  | 🚨 broken leg, trapped | 10:14:04 PM    |  <-- Live Casualty List
| • YELLOW-OTTER-12 | RR: 20/min, Pulse Normal | 10:11:00 PM  |
+-------------------------------------------------------------+
| [▼] LIVE BITCHAT TELEMETRY & PACKET INSPECTOR               |
| [Wire (8)] [Audit (12)] [DTN (4)] [AI (3)] [Nostr] [Console]|  <-- Telemetry Inspector
+-------------------------------------------------------------+
| BLE Mesh: Connected (Hop 1/15)      [ EMERGENCY WIPE ]      |  <-- Panic Zeroization
+-------------------------------------------------------------+
```

---

## 4. Feature-by-Feature Operational Guide

### Feature 1: Two-Tap START Triage (Manual Assessment)

When you walk up to a casualty and evaluate them manually:

1. Look at the **Active Casualty Card** at the top. Notice the assigned **Phonetic Ephemeral ID** (e.g., `RED-PANTHER-04`).
2. Directly tap one of the **4 Giant Colored START Buttons**:
   - **`[ RED / IMMEDIATE ]`**: Life threat. Respiration $>30$ or $<10$, absent radial pulse, severe bleeding, or altered mental status.
   - **`[ YELLOW / DELAYED ]`**: Serious injury, non-ambulatory, but stable vitals (normal breathing, palpable pulse, follows simple commands).
   - **`[ GREEN / MINOR ]`**: "Walking wounded." Ambulatory casualties with minor lacerations.
   - **`[ BLACK / EXPECTANT ]`**: Apneic (not breathing even after manual airway opening) or catastrophic non-survivable trauma.
3. **Automatic Auto-Advance:** Once you tap a triage button:
   - The diagnosis is immediately saved to the SQLite database.
   - An encrypted 32-byte BitChat binary packet is queued in the DTN outbox and broadcast over BLE.
   - The card automatically creates and advances to the next phonetic casualty (e.g., `YELLOW-FALCON-89`), allowing you to triage a mass-casualty crowd in seconds.

---

### Feature 2: Push-To-Talk Voice Dictation & Edge AI Extraction

When both your hands are busy holding a pressure dressing or checking vitals, use hands-free speech recognition.

#### How to Record Speech:
1. **Option A (Mouse / Touch):** Click or tap the large dark bar labeled:  
   **`🎤 Push To Talk Clinical Observation`**.
2. **Option B (Keyboard Hotkey):** Press the **`V`** key on your keyboard to instantly start or stop recording.
3. **Visual Confirmation:**
   - The button turns pulsing cyan/red: `🔴 DICTATING OBSERVATION (CLICK TO STOP)`.
   - The timer counts up: `00:03`, `00:04`...
   - The **Decibel VU Meter** bounces dynamically with your voice levels.
   - Your speech appears live in the text box below.
4. **Stop Recording:** Tap the bar again (or press `V`).
5. **Evaluate:** Click the bright green **`[ EVALUATE OBSERVATION ]`** button.

#### What to Say (Example Phrases):
- *"Adult male victim, respiratory rate 36, absent radial pulse, altered mental status"*  
  $\rightarrow$ Extracted as: `RR: 36`, `Radial: ABSENT`, `Mental: ALTERED` $\rightarrow$ Evaluated as: **`RED (IMMEDIATE)`**.
- *"Walking wounded, alert, minor scrape on left arm"*  
  $\rightarrow$ Extracted as: `Can Walk: TRUE` $\rightarrow$ Evaluated as: **`GREEN (MINOR)`**.
- *"Patient not breathing, opened airway, breathing has resumed"*  
  $\rightarrow$ Extracted as: `Airway Opened: TRUE`, `Resumed: TRUE` $\rightarrow$ Evaluated as: **`RED (IMMEDIATE)`**.
- *"Patient not breathing, opened airway, still no breathing"*  
  $\rightarrow$ Extracted as: `Apneic` $\rightarrow$ Evaluated as: **`BLACK (EXPECTANT)`**.

#### Using the Preset Fast-Input Chips:
If you want to test or simulate observations quickly without speaking:
- Tap any chip above the evaluate button:
  - `🚨 Adult RR 36 (RED)`
  - `⚠️ Walking Wounded (GREEN)`
  - `⚡ Apneic Airway (BLACK)`
  - `🦴 Broken Leg Trapped (RED/SOS)`
  - `💊 Morphine 5mg IV`
  - `⚠️ Penicillin Allergy`
- Click **`[ EVALUATE OBSERVATION ]`** to process it through the engine.

---

### Feature 3: Situational Distress Relay (Trapped, Broken Bones, Disoriented)

What if a citizen, volunteer, or patient transmits a message that isn't clinical vitals, but a distress situation?
> *"I have a broken leg and I'm trapped under rubble in basement B, cannot figure out where I am!"*

#### How PeerScribe handles this:
1. **Intelligent Extraction:**
   - **Broken Bones:** Recognizes `broken leg`, `broken hip`, `compound fracture`, `fractured bone` $\rightarrow$ automatically flags `canWalk = false`.
   - **Entrapment:** Recognizes `trapped under rubble`, `pinned down`, `stuck in basement` $\rightarrow$ records physical entrapment.
   - **Disorientation:** Recognizes `cannot figure out`, `don't know where I am`, `lost` $\rightarrow$ flags `mentalStatus = 'ALTERED'`.
2. **Automatic Escalation:**
   - Evaluated as **`RED (IMMEDIATE)`** under START protocol because the patient is non-ambulatory with altered situational awareness.
3. **Full Narrative Preservation:**
   - The entire spoken sentence is permanently attached to the casualty's CRDT document as a **`[VOICE DISTRESS TRANSMISSION]`** note.
4. **`CRITICAL_SOS` Wire Framing:**
   - The message is encoded with BitChat priority **`0x03 (SOS_PRIORITY)`**, placing it at the front of the DTN store-and-forward queue to leapfrog ordinary logs.
5. **Rescue Team Visibility:**
   - On every nearby medic's screen, the casualty feed immediately updates with:
     `RED-PANTHER-04 | 🚨 broken leg, trapped under rubble | 10:14 PM`
   - Medics can read the exact note to know what tools (hydraulic jaws, tourniquet, splints) are required.

---

### Feature 4: Tri-Modal Operational Power Switcher (Battery Adaptation)

In prolonged disaster missions lasting days, devices must balance battery life against radio responsiveness.

PeerScribe features three distinct operating profiles:

| Mode | Battery Drain Target | Telemetry Polling | Radio & AI State | UI Accent |
| :--- | :--- | :--- | :--- | :--- |
| **`FIELD`** (Default) | $< 2.0\%$ / hour | Standard (Every 3.0s) | BLE mesh active, on-demand AI | **Tactical Blue** |
| **`EMERGENCY`** | High Alert ($< 7.0\%$/hr) | Rapid (Every 1.2s) | Aggressive beaconing, Nostr WAN sync active | **High-Alert Red** |
| **`DORMANT`** | Ultra-Low ($< 0.3\%$/hr) | Throttled (Every 15.0s) | Background radios throttled, WAN idle | **Slate Gray** |

#### How to Switch Modes:
- **Option 1 (Quick Pills):** In the **Operation Context Card**, click any of the mode pills:  
  **`[ FIELD ]`**, **`[ EMERGENCY ]`**, or **`[ DORMANT ]`**.
- **Option 2 (Header Badge):** Click the top right **`[ 📡 FIELD ⟳ ]`** badge to cycle sequentially:  
  `FIELD → EMERGENCY → DORMANT → FIELD`.
- **Waking from DORMANT:** When in DORMANT mode, a dark banner appears across the top:  
  *"💤 DORMANT POWER-SAVE ACTIVE: Background radios & telemetry throttled. Tap to Wake (FIELD)"*. Simply tap this banner to awaken the node.

---

### Feature 5: Clinical Divergence & Semantic Safety Resolution

#### What is Clinical Divergence?
In offline disasters, two disconnected medics may assess the same patient without connectivity:
- *Medic A* tags `RED-PANTHER-04` as **`RED (Immediate)`** due to altered breathing.
- *Medic B* (5 minutes later) tags `RED-PANTHER-04` as **`YELLOW (Delayed)`** after bleeding stops.

In ordinary apps, the last update blindly overwrites the first (Last-Write-Wins), which could cause a critical patient to be left behind to die.

#### How PeerScribe Resolves It:
1. **Level 2 Semantic Safety Analyzer:** The core engine detects that two medics assigned conflicting triage levels to the same patient.
2. **Pulsing Alert Banner:** A flashing red banner appears at the top of the app:  
   **`🚨 CLINICAL DIVERGENCE DETECTED — Medic A and Medic B recorded opposing triage levels. Human sign-off required.`**
3. **Resolving the Conflict:**
   - Tap the red banner to open the **Resolution Modal**.
   - Review both medics' assessments, timestamps, and notes side-by-side.
   - As the authorized lead clinician, tap either:
     - **`[ CONFIRM AS RED (IMMEDIATE) ]`**
     - **`[ CONFIRM AS YELLOW (DELAYED) ]`**
   - The divergence is resolved, an auditable signature is committed to SQLite WAL, and the resolution syncs across all peer devices.

---

### Feature 6: Live BitChat Telemetry & Packet Inspector

At the bottom of the screen is the **BitChat Packet & Protocol Inspector**. Tap **`[HIDE ▲]` / `[SHOW ▼]`** to toggle it.

This tool provides 100% transparency into the peer-to-peer wire protocol across 6 tabs:

1. **`[ Wire Packets ]`**:
   - Inspects the actual **32-byte BitChat binary wire frames**.
   - Shows CRC-32 checksums, magic headers (`0x5053`), hop limits (`0/15`), sector geohashes (`u15ek200`), and raw hexadecimal byte previews.
2. **`[ Clinical Audit Trail ]`**:
   - Shows the append-only SQLite WAL audit log.
   - Every single intake, vital recording, triage decision, and medication administration is stamped with an immutable entry ID and node public key.
3. **`[ DTN Outbox ]`**:
   - Displays the **Delay-Tolerant Store-and-Forward bundle queue**.
   - Watch packets wait in the outbox until another peer node comes into radio range.
4. **`[ Edge AI Extractor ]`**:
   - Compares the **raw spoken audio transcript** against the **extracted structured clinical JSON**.
   - Shows extraction confidence scores (0.95), rule rationale, and SQLite commit receipts.
5. **`[ Nostr Kind 20042 ]`**:
   - Shows encrypted mesh bundles packaged for Nostr relays (Kind 20042) with ChaCha20-Poly1305 / AES-GCM AEAD ciphertext.
6. **`[ Console Stream ]`**:
   - Live stream of all internal daemon events, particle filter sightings, and security state changes.

---

### Feature 7: Emergency Wipe (Anti-Capture Zeroization)

In tactical operations where equipment is about to be captured or an operation terminates:

1. Look at the bottom right of the screen for the red outlined button: **`[ EMERGENCY WIPE ]`**.
2. Tap the button. A native browser confirmation modal appears:  
   *`⚠️ EMERGENCY WIPE: This will immediately zeroize encryption keys, wipe all local CRDT replicas, and clear patient data. Proceed?`*
3. Tap **OK**.
4. **What Happens in under 5 milliseconds:**
   - **Volatile RAM Scrub:** All private keys and session buffers in memory are overwritten with CSPRNG entropy and zeroed out.
   - **SQLite WAL Sanitized:** `DELETE FROM patient_documents`, `clinical_audit_trail`, `dtn_outbox`, `peer_registry`, and `operations` followed by `VACUUM` to overwrite disk blocks.
   - **Identity Key Regeneration:** A brand-new Ed25519 identity keypair and Node ID are generated from scratch. Past signatures can never be linked to the device.
   - **UI Zeroization:** All casualty lists, active casualty intake cards, telemetry caches, and badges immediately reset to `0` / `WIPED-00`.
   - **Peer Broadcast:** An `emergencyWiped` SSE event is emitted across all connected clients.

---

## 5. End-to-End Field Walkthrough Scenarios

### Scenario A: Triaging 3 Casualties After an Earthquake
1. Walk up to Casualty 1 (walking, scrape on hand):
   - Tap **`[ GREEN / MINOR ]`**.
   - Card advances to next patient automatically.
2. Walk up to Casualty 2 (lying on ground, breathing heavily at 34 breaths/min):
   - Press **`V`** and say: *"Adult male, respirations 34, radial pulse weak, confused."*
   - Press **`V`** to stop, then tap **`[ EVALUATE OBSERVATION ]`**.
   - The AI extractor detects respiratory distress ($>30$) and classifies them as **`RED`**.
   - The packet is prioritized and broadcast over BLE mesh.
3. Walk up to Casualty 3 (unconscious, not breathing):
   - Open airway manually. Still no breathing.
   - Tap **`[ BLACK / EXPECTANT ]`**.
4. Scroll down to the **Casualty Feed**:
   - Notice all 3 casualties are sorted cleanly: Casualty 2 (RED) at the very top, Casualty 1 (GREEN) and Casualty 3 (BLACK) below.

### Scenario B: Rescuing a Trapped Victim
1. You receive a P2P packet relayed across 3 hops from a citizen node.
2. In the casualty feed, a card shows:
   `RED-VIPER-04 | 🚨 broken leg, trapped in basement | 10:18 PM`
3. Click on the casualty card:
   - The intake station loads their record.
   - You read their note: *"Trapped under concrete in basement B, broken leg, can't figure out where I am."*
4. Check the **Telemetry Inspector $\rightarrow$ Wire Packets**:
   - See the sector geohash `u15ek200` stamped in the header.
   - Dispatch the rescue squad with heavy lifting equipment directly to Sector `u15ek200`.

---

## 6. Keyboard Shortcuts & Field Tips

| Shortcut / Action | Function | Purpose |
| :--- | :--- | :--- |
| **`V` Key** | Toggle Push-to-Talk Recording | Hands-free dictation without touching the screen. |
| **Click Casualty in Feed** | Select Casualty as Active Target | Load any previous casualty to inspect vitals or update triage. |
| **Tap Mode Badge** | Cycle `FIELD → EMERGENCY → DORMANT` | Fast operational profile adjustment. |
| **Tap Divergence Banner** | Open Conflict Resolution Modal | Adjudicate conflicting diagnoses between medics. |
| **Preset Chips** | Instant Clinical Dictation Input | Instant demonstration and simulation of clinical observations. |

---

*PeerScribe Core Engine &copy; 2026. Built with Zero-Centralization Architecture for Disaster Medicine and Search & Rescue.*
