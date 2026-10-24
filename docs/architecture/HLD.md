# PeerScribe: High-Level Design (HLD)

## 1. System Vision & Architecture Philosophy

PeerScribe is an offline-first, decentralized, peer-to-peer clinical coordination and triage system designed for zero-connectivity environments—such as earthquake zones, collapsed infrastructure, mass-casualty incidents (MCIs), and remote field clinics.

### The Inverted Infrastructure Invariant
Traditional health and emergency systems depend on continuous cellular or hospital database access. In disasters, this assumption fails. PeerScribe operates on an inverse principle:
> **"Local devices are autonomous, complete logical replicas. Connectivity is required solely for state propagation, never for basic clinical operation."**

```text
                        PEERSCRIBE UNIFIED SYSTEM
                                    |
                    +---------------+---------------+
                    |                               |
          Windows Desktop App               Android Mobile App
          (Electron + Node SQLite)          (Flutter + Dart Sqflite)
                    |                               |
                    +---------------+---------------+
                                    |
                    Shared Wire Protocol & Event Bus
                                    |
            +-----------------------+-----------------------+
            |                       |                       |
    Local Persistence         Event Sourcing           Identity & Vault
    (Encrypted SQLite WAL)  (Append-Only Event Store) (AES-256-GCM Isolation)
            |                       |                       |
            +-----------------------+-----------------------+
                                    |
                      Sync Manager & Outbox Engine
                                    |
                     +--------------+--------------+
                     |                             |
                 Local P2P                     Global Relay
             LAN WebSocket / BLE           Nostr Gateway (Kind 20042)
                     |                             |
                     +--------------+--------------+
                                    |
                           Neighbor Mesh Nodes
```

---

## 2. Platform Targets

### 2.1 Windows Desktop (Electron)
- **Framework:** Electron 35+ / Node.js 22+ with TypeScript.
- **Process Model:** Secure two-process architecture:
  - **Main Process:** Privileged background service, local SQLite storage engine (WAL mode), WebSocket server/client sync listener, secure key storage, IPC dispatcher.
  - **Preload Bridge:** Strictly isolates renderer with `contextIsolation: true`, `nodeIntegration: false`, and validated IPC channels via `window.peerScribeElectron`.
  - **Renderer Process:** High-contrast tactical UI (Fitts's law touch targets, WCAG AAA dark theme, real-time telemetry inspector, visual particle filter radar canvas).
- **Packaging:** Windows NSIS Setup Installer (`.exe`) and portable standalone archive (`.zip`) packaged with `electron-builder`.

### 2.2 Android Mobile (Flutter)
- **Framework:** Flutter 3.24+ / Dart 3.5+.
- **Process Model:** Reactive, single-codebase Flutter mobile client with feature-first separation:
  - **Persistence:** Local SQLite database via `sqflite` with identical relational schema and outbox table.
  - **Sync Manager:** Background WebSocket listener & client connector matching the shared wire protocol.
  - **Sensors:** Hardware GPS integration (periodic duty-cycle, disabled in Dormant mode) and push-to-talk microphone access only on active user invocation.
  - **UI/UX:** High-stress tactical interface (min 64px thumb targets, Two-Tap Triage, high contrast dark theme, live divergence alert banners).
- **Packaging:** Installable Android APK (`.apk`) compiled via Gradle.

---

## 3. Core Architectural Subsystems

### 3.1 Immutable Event Sourcing & Causal Replication
State is represented as an append-only log of immutable, cryptographically signed operational events:
- `PATIENT_CREATED`: Assigns temporary operational identifier (`[COLOR]-[ANIMAL]-[DIGIT]`, e.g. `RED-PANTHER-04`).
- `OBSERVATION_RECORDED`: Natural speech or structured observation recorded by a responder.
- `VITALS_RECORDED`: Respiration rate, radial pulse status, mental status, systolic BP, capillary refill.
- `INJURY_RECORDED`: Anatomical trauma, compound fractures, tourniquet application status.
- `MEDICATION_RECORDED`: Administered drug, dosage, route, authorized medic signature.
- `TRIAGE_EVALUATED`: Protocol evaluation (START/JumpSTART) and category assignment (`RED`, `YELLOW`, `GREEN`, `BLACK`).
- `VAULT_SNAPSHOT_ATTACHED`: Isolated personal medical snapshot (blood type, critical allergies) linked without exposing private historical medical vaults.
- `DIVERGENCE_FLAGGED`: Identified clinical collision or triage disagreement.
- `DIVERGENCE_RESOLVED`: Authorized clinician sign-off resolving a conflict.

Each event includes:
- Globally unique `event_id` (`UUIDv4`).
- `operation_id` scoping the incident.
- `actor_id` and monotonic `actor_sequence`.
- `lamport_timestamp` and vector clock causal context.
- UTC timestamp.
- Structured, typed payload.

### 3.2 Dual-Storage Strategy
1. **Append-Only Event Store:** Immutable log of all local and received events. Enables deterministic replay, crash recovery, and state projection.
2. **Projected State Store (SQLite):** Indexed relational tables (`patients`, `operations`, `outbox`, `audit_trail`, `divergences`) computed deterministically from the event stream for instant UI queries.

### 3.3 Semantic Divergence vs. Mathematical Convergence
Standard Last-Write-Wins (LWW) or pure CRDT convergence mathematically resolves concurrent updates by picking the latest timestamp. In clinical triage, this can be fatal:
- *Medic A* tags a non-breathing casualty as `RED`.
- *Medic B* (concurrently offline) mistakenly tags the same casualty as `GREEN`.
- Mathematical LWW would silently overwrite Medic A's `RED` evaluation, leading to patient death.

**PeerScribe 3-Tier Resolution:**
1. **Tier 1 (CRDT / Multi-Value State):** Both evaluations are preserved in the event log.
2. **Tier 2 (Semantic Safety Analyzer):** Deterministically inspects newly ingested events for clinical divergence:
   - `DIV_TRIAGE_DELTA`: Concurrent opposing triage assessments. The UI temporarily defaults to the most acute category (`RED`) for safety.
   - `DIV_DRUG_ALLERGY`: Administered drug collides with a known or newly disclosed allergy (e.g., penicillin/amoxicillin).
3. **Tier 3 (Clinician Review & Sign-Off):** Surfaces a high-priority flashing banner. An authorized clinician selects the verified status, generating a formal `DIVERGENCE_RESOLVED` event.

### 3.4 Personal Medical Profile Vault vs. Operational Incident Data (Principle P10)
- Citizens store their personal medical history (blood group, chronic conditions, regular prescriptions, emergency contacts) encrypted locally with AES-256-GCM using a device-derived master key.
- Under disaster conditions, PeerScribe generates an **Emergency Medical ID Snapshot** containing only safety-critical fields (blood group, life-threatening allergies, emergency contact phone).
- The personal vault is **never** broadcast across the mesh. Only an explicit, authorized snapshot attachment attaches allergy metadata to an ephemeral casualty record.

### 3.5 Sequential Monte Carlo (Particle Filter) Location Recovery (Phase 7)
- Tracks isolated or disconnected responders/victims without GPS by propagating a swarm of 500–2,000 particles based on kinematic Brownian motion and terrain speed bounds.
- Upon ingesting an opportunistic peer sighting or radio beacon, Bayesian re-weighting and resampling contracts the 50%, 75%, and 90% search radii by >35–50%, rendering live isochrones on an offline radar heatmap canvas.

### 3.6 Edge AI Speech Ingestion Pipeline (Principle P5)
- Push-to-Talk audio is transcribed locally (using on-device Whisper or Web Speech API).
- Structured extraction parses natural speech into typed observations (respiration rate, radial pulse present/absent, mental status, injuries).
- **Critical Safety Constraint:** The AI model is strictly prohibited from autonomous prescription or dosage calculation. Extracted vitals are fed into the deterministic, audited START/JumpSTART protocol engine.
