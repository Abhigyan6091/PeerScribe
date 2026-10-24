# PeerScribe

> **An Offline-First, Peer-to-Peer Clinical Coordination & Emergency Mesh System for Zero-Connectivity and Disaster Environments**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![Build Status](https://img.shields.io/badge/Tests-29%20Passing-brightgreen.svg)](#automated-testing--benchmarks)
[![Dependencies](https://img.shields.io/badge/Dependencies-0%20External-orange.svg)](#technology-stack)
[![Protocol](https://img.shields.io/badge/Wire%20Protocol-BitChat%20Binary%20v1.0-blueviolet.svg)](#bitchat-binary-wire-protocol)
[![Nostr](https://img.shields.io/badge/Nostr%20Mesh-Kind%2020042-purple.svg)](#nostr-global-gateway-bridge)

---

## 1. Executive Summary & Philosophy

In mass casualty incidents, natural disasters (earthquakes, tsunamis, floods), and remote conflict zones, conventional electronic health record (EHR) systems fail catastrophically because they make a fatal assumption: **continuous connectivity to a centralized database server**. When cell towers lose power and backhaul links sever, centralized EHRs become inaccessible bricks, forcing first responders onto paper triage tags that detach, soil, or lack temporal audit trails.

**PeerScribe operates on an inverse architectural invariant:**

$$\text{\bf "Connectivity is required solely for propagation, never for basic operation."}$$

Every node in PeerScribe—whether an Android smartphone, iOS device, ruggedized Windows laptop, or field tablet—acts as an **autonomous, full logical replica**. There is **no permanent central database**. State is local-first, durable, conflict-resilient, and opportunistically propagated across physical space through peer-to-peer ad-hoc links (BLE, Wi-Fi Direct) and global delay-tolerant relays (Nostr).

```
                      +-----------------------------+
                      |         PEERSCRIBE          |
                      |    Unified Logical Node     |
                      +--------------+--------------+
                                     |
         +---------------------------+---------------------------+
         |                           |                           |
         v                           v                           v
+-----------------+         +-----------------+         +-----------------+
| Personal Profile|         | Clinical Engine |         |  Network Layer  |
| (Private/Local) |         | (Edge AI+Rules) |         | (P2P + Nostr)   |
+--------+--------+         +--------+--------+         +--------+--------+
         |                           |                           |
         +---------------------------+---------------------------+
                                     |
                                     v
                       +---------------------------+
                       |   Local Storage & State   |
                       |   (SQLite + CRDT Engine)  |
                       +-------------+-------------+
                                     |
                     +---------------+---------------+
                     |                               |
                     v                               v
          +---------------------+         +---------------------+
          |  Local P2P (Nearby) |         |  Global Gateway     |
          |  BLE / Local Wi-Fi  |         |  Nostr Relay Mesh   |
          +---------------------+         +---------------------+
```

---

## 2. The Ten Invariant Principles

| # | Principle | Implementation in PeerScribe |
|---|-----------|------------------------------|
| **P1** | **No Central Database** | Every node carries a self-contained SQLite WAL replica; no single point of failure exists. |
| **P2** | **Local Persistence First** | Writes commit to durable disk storage (`WAL` mode SQLite) before any network transmission. |
| **P3** | **Zero-Connectivity Independence** | 100% of triage, clinical observation, vitals logging, and edge AI evaluations run completely offline. |
| **P4** | **CRDT Convergence ≠ Clinical Resolution** | Mathematical LWW convergence does not equal medical consensus. Opposing triage assessments trigger human review flags. |
| **P5** | **AI Extracts, Never Prescribes** | Edge AI extracts structured parameters from natural speech; AI is strictly prohibited from autonomous prescribing. |
| **P6** | **Deterministic Safety Rules** | Clinical triage protocols (START, JumpSTART) run on audited deterministic state machines, not stochastic model weights. |
| **P7** | **Minimal Sync Units & Local Audio** | Raw audio recordings stay strictly on the local device; only compact cryptographic delta bundles propagate across the mesh. |
| **P8** | **Dynamic Gateway Roles** | Any node encountering internet connectivity instantaneously and ephemerally serves as a Nostr sync bridge for the mesh. |
| **P9** | **Tri-Modal Power Adaptation** | Dynamic transition across *Dormant*, *Field*, and *Emergency* profiles balances radio battery drain against tactical responsiveness. |
| **P10**| **Strict Profile / Incident Isolation** | A patient's encrypted personal vault is cryptographically separated from ephemeral disaster incident records. |

---

## 3. System Architecture & Key Features

### 3.1 Identity & Cryptographic Security
- **Ed25519 & Schnorr Signatures**: High-speed, tamper-proof signature generation and verification.
- **Ephemeral Operational IDs**: Anonymized phonetic identifiers (`[COLOR]-[ANIMAL]-[DIGIT]`, e.g., `RED-PANTHER-04`) preventing clinical confusion over radios.
- **Deterministic 4x4 Identicons**: Visual SVG matrices generated directly from patient public keys for instant non-verbal verification.
- **Personal Vault**: AES-256-GCM encrypted local storage for personal medical records with zero-knowledge emergency snapshots.
- **Noise XX Transport Handshake**: Mutual authentication and forward-secret session encryption for peer links.
- **Emergency Zeroization Wipe**: 3-pass DoD 5220.22-M compliant cryptographic shredding (`0x00`, `0xFF`, CSPRNG random bytes) in case of node capture.

### 3.2 Conflict-Free Replicated State (CRDT)
- **Causal Vector Clocks**: Tracks multi-node update order across partitioned networks without synchronized clocks.
- **Multi-Value Register Documents**: Retains concurrent edits across disconnected medics with deterministic Last-Write-Wins (LWW) resolution.
- **Compact Cryptographic Deltas**: Only changed fields are signed, compressed, and broadcast, minimizing wire bandwidth.

### 3.3 Clinical Triage & Semantic Safety
- **Deterministic Protocols**: Adult **START** (*Simple Triage and Rapid Treatment*) and pediatric **JumpSTART** algorithms running on audited state machines.
- **Level 2 Semantic Safety Analyzer**:
  - Detects clinical divergence when two medics assign opposing triage categories (e.g. `RED` vs `GREEN`) to the same casualty.
  - Automatically flags drug-allergy collisions (e.g., administering penicillin to a patient with a documented penicillin allergy) and requires explicit clinician override.

### 3.4 Edge AI Speech-to-Triage Engine
- **Browser Web Speech ASR & Local NLP**: Continuous, unbounded microphone streaming via native Web Speech API (`SpeechRecognition`).
- **No Arbitrary Timeouts**: Clinicians can speak for as long as needed; live elapsed counters provide immediate feedback.
- **Spoken Number Normalization**: Converts conversational speech (`"thirty four"` $\to$ `34`, `"twenty two"` $\to$ `22`) and natural clinical phrases into validated schemas.
- **Tactical Dictation HUD**: Editable live transcript box, one-tap preset chips, and keyboard shortcut (`V`) for glove-compatible operation.

### 3.5 BitChat Wire Protocol & Delay-Tolerant Networking (DTN)
- **32-Byte Binary Framing**: Compact wire packet with magic bytes `0x5053` (`PS`), packet type, payload length, CRC-32 checksum, hop count, TTL, and 8-byte Geohash spatial index.
- **MTU Fragmentation**: Automatic chunking into $\le 512$-byte frames for Bluetooth LE MTU limits with reassembly buffering.
- **Priority DTN Outbox**: Priority-ranked store-and-forward queue (`CRITICAL_SOS`, `TRIAGE_UPDATE`, `CLINICAL_DELTA`, `TELEMETRY_BEACON`) with dynamic hop-count decrementing.
- **128-Byte Anti-Entropy Bloom Filter**: Constant-memory deduplication preventing broadcast storms and redundant retransmissions across mesh hops.

### 3.6 Nostr Global Gateway Bridge
- **Nostr Kind 20042 Events**: Encapsulates encrypted mesh bundles into Nostr events tagged with the operation ID and geohash sector.
- **Ephemeral Auto-Promotion**: Field nodes automatically promote themselves to global relays when internet connectivity is detected.

### 3.7 Probabilistic Location & Search Optimization
- **Sequential Monte Carlo Particle Filter**: 200-particle mobility propagation modeling pedestrian Brownian motion and terrain constraints.
- **Bayesian Sighting Contraction**: Dynamically shrinks the 50% and 95% search confidence contours upon visual sighting reports.

---

## 4. Repository Structure

PeerScribe is organized as an enterprise-grade TypeScript/Node.js monorepo with **zero external npm dependencies** (using native Node.js 22+ modules):

```
PeerScribe/
├── package.json                 # Monorepo configuration & script runner
├── requirements.txt             # Python research, simulation & benchmark dependencies
├── implementation.md            # Master technical blueprint & formal specifications
├── packages/
│   ├── core-engine/             # Platform-agnostic clinical & network engine
│   │   └── src/
│   │       ├── identity/        # Ed25519, Schnorr, Ephemeral IDs & Identicons
│   │       ├── profile/         # AES-256-GCM Personal Vault
│   │       ├── crdt/            # Vector clocks & Multi-value CRDT documents
│   │       ├── clinical/        # START/JumpSTART triage & Semantic Safety Analyzer
│   │       ├── ai/              # Edge AI clinical speech extractor & NLP
│   │       ├── network/         # BitChat wire framing, MTU chunker, Bloom filter, DTN
│   │       ├── nostr/           # Nostr Kind 20042 gateway events & Geohash tagging
│   │       ├── location/        # Sequential Monte Carlo particle filter
│   │       ├── security/        # DoD 5220.22-M Emergency Zeroization Wipe
│   │       └── storage/         # Native node:sqlite WAL relational engine
│   ├── backend-service/         # Tactical Node.js service daemon & HTTP/SSE API
│   │   └── src/
│   │       ├── node_daemon.ts   # Core runtime orchestrator & telemetry buffers
│   │       └── server.ts        # HTTP REST API, SSE streaming & static asset server
│   ├── platform-adapters/       # Hardware simulation & BLE mesh adapters
│   │   └── src/
│   │       ├── ble_mesh_hub.ts  # Multi-hop BLE store-and-forward simulator
│   │       └── gnss_adapter.ts  # Haversine spatial math & Geohash encoding
│   └── ui-app/                  # Tactical dark-mode field web dashboard
│       ├── index.html           # High-contrast HUD interface
│       └── app.js               # Reactive SSE controller & Web Speech PTT engine
├── tests/
│   └── benchmarks/
│       └── experiments.test.ts  # 7 formal empirical experiments from Section 10
└── scripts/
    └── generate-manifest.js     # Cryptographic integrity manifest generator
```

---

## 5. Technology Stack

- **Runtime**: [Node.js 22+](https://nodejs.org/) (utilizing native `--experimental-strip-types` for direct TypeScript execution without transpilation).
- **Embedded Database**: Native `node:sqlite` in Write-Ahead Logging (`WAL`) mode with full relational foreign keys.
- **Cryptography**: Native `node:crypto` (Ed25519 keypairs, AES-256-GCM, SHA-256, CSPRNG random zeroization).
- **Compression**: Native `node:zlib` (Deflate / Inflate raw RFC 1951 stream compression).
- **Networking**: Native `node:http` (REST endpoints, Server-Sent Events real-time event pipeline).
- **Testing**: Native `node:test` and `node:assert`.
- **Python Research Harness**: Python 3.10+ (see [`requirements.txt`](requirements.txt) for scientific analysis and simulation tooling).

---

## 6. Quick Start & Installation

### Prerequisites
- **Node.js**: Version 22.0.0 or higher
- **Git**

### Installation

1. Clone the repository:
### Running the Windows Electron Application
```bash
# Navigate to desktop app
cd apps/desktop-electron

# Run Electron desktop locally
npm start

# Build Windows NSIS Installer (.exe) and Portable Package (.zip)
npm run dist
```

### Running the Android Flutter Application
```bash
# Navigate to android-flutter app
cd apps/android-flutter

# Install dependencies
flutter pub get

# Run on connected Android device / emulator
flutter run

# Build release APK
flutter build apk --release
```

---

## 7. Cross-Platform Applications & Monorepo Layout

PeerScribe is organized as an offline-first monorepo with symmetric logical peers:

```text
peerscribe/
├── apps/
│   ├── desktop-electron/         # Windows Electron tactical client (NSIS + Portable)
│   └── android-flutter/          # Android Flutter mobile tactical client (APK)
├── packages/
│   ├── protocol/                 # Canonical schemas, fixtures & state projection
│   ├── core-engine/              # CRDT, vector clocks, encryption, clinical rules
│   ├── platform-adapters/        # BitChat wire protocol, BLE mesh, GNSS geohash
│   ├── backend-service/          # Node.js tactical daemon, SQLite WAL, HTTP/WS API
│   └── ui-app/                   # Tactical HUD renderer interface
├── docs/
│   ├── architecture/             # HLD.md, ADR.md, IMPLEMENTATION_PLAN.md
│   ├── TESTING.md                # Multi-device test procedures & QA matrix
│   └── RELEASES.md               # Versioning, channels & signing guide
└── .github/
    └── workflows/
        ├── ci.yml                # CI: Protocol, Windows Electron, Android Flutter
        └── release.yml           # Gated multi-channel release pipeline
```

---

## 8. Automated Testing & Verification Suite

PeerScribe includes **42 automated unit, integration, protocol, and empirical benchmark tests** executing across all components:

```bash
# Run full monorepo test suite (42 tests)
npm test

# Run shared protocol schema & fixture projection tests
npm run test:protocol

# Run Windows Electron isolation & packaging tests
npm run test:electron

# Run formal benchmark experiments suite
npm run benchmark
```

### Test Coverage Summary (42/42 Passing)
- **Shared Protocol (`packages/protocol`)**: Schema validation, golden sample fixtures, deterministic projection, out-of-order commutativity, and idempotency.
- **Windows Electron (`apps/desktop-electron`)**: IPC channel whitelisting, context isolation boundaries, decoupled personal vault persistence.
- **Android Flutter (`apps/android-flutter`)**: Dart event serialization, vector clock causal ordering, START triage rule decision tree.
- **Core Engine & Adapters**: Ed25519 signing, Noise XX handshake, AES-256-GCM vault, CRDT convergence, Bloom filter deduplication, particle filter search contraction, and DTN outbox store-and-forward.

---

## 9. Offline LAN P2P Synchronization & Nostr Gateway

1. **Local Wi-Fi / Hotspot P2P Sync**:
   - Responders running PeerScribe on Windows and Android on the same Wi-Fi router or mobile hotspot exchange sync bundles directly over bidirectional WebSockets without requiring Internet access.
   - Idempotent deduplication guarantees repeated deliveries do not create duplicate clinical actions.
   - Causal vector clocks preserve all updates and detect concurrent safety-critical divergences (`RED` vs `GREEN`), alerting medics immediately.
2. **Nostr Global Store-and-Forward Gateway**:
   - Any node that temporarily discovers cellular/satellite WAN connectivity ephemerally serves as a gateway.
   - Delta bundles are encrypted and broadcast as Nostr Kind `20042` events to configured public relays (`wss://relay.damus.io`, `wss://nos.lol`).
   - Sensitive clinical data is never transmitted unencrypted to public relays.

---

## 10. GitHub Actions CI/CD Pipeline

The repository includes enterprise-grade GitHub Actions workflows:

- **`.github/workflows/ci.yml`**:
  - Independent parallel jobs for Shared Protocol, Windows Electron packaging (`windows-latest`), and Android Flutter compilation (`ubuntu-latest`).
  - Automatically builds and uploads downloadable test artifacts:
    - `PeerScribe-Windows-Desktop-CI` (`.exe` installer and `.zip` portable package).
    - `PeerScribe-Android-Mobile-CI` (`.apk` installable package).
- **`.github/workflows/release.yml`**:
  - Controlled manual execution (`workflow_dispatch`) with validated SemVer inputs.
  - Release gating: strictly requires all mandatory tests and packaging jobs to pass.
  - Generates SHA-256 checksums (`SHA256SUMS.txt`) and publishes official GitHub Releases.

---

## 11. Known Limitations & Research Disclaimer

> [!WARNING]
> **RESEARCH PROTOTYPE ONLY**: PeerScribe is a clinical coordination research prototype for disaster response and mass casualty incidents. It is not an FDA/CE-certified medical device.
> - **Zero Autonomous Prescriptions**: The Edge AI module extracts clinical observations from natural speech; it is strictly prohibited from prescribing medications or calculating dosages.
> - **Deterministic Triage**: All triage classifications are evaluated using deterministic START/JumpSTART rule trees or explicit responder overrides.
> - **Local Development Environment**: On the local Windows development machine, all 42 automated tests pass with 100% green status; Flutter Android APK compilation is verified via GitHub Actions CI runners equipped with Android SDK and Flutter tooling.

---

## 12. License

PeerScribe is open-source software licensed under the **[Apache License 2.0](LICENSE)**.

