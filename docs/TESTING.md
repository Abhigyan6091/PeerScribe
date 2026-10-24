# PeerScribe: Testing Guide & Quality Assurance Matrix

This document defines the comprehensive testing methodology, reproducible test procedures, and verification protocols for the PeerScribe decentralized clinical coordination system.

---

## 1. Test Suite Architecture

PeerScribe employs a multi-tiered test pyramid spanning language-neutral protocol validation, embedded persistence integrity, distributed replication stress tests, and high-stress HCI evaluation:

```text
+--------------------------------------------------------------------------+
|                            TEST ARCHITECTURE                             |
+--------------------------------------------------------------------------+
| 1. Shared Protocol & Schema Conformance (JSON Schema & Fixtures)        |
| 2. Local Persistence & Crash Resilience (SQLite WAL ACID & Outbox)       |
| 3. Distributed Replication, Idempotency & Vector Clock Reconciliation    |
| 4. Semantic Safety & Clinical Divergence (Opposing Triage & Allergies)   |
| 5. Edge AI & Deterministic Triage Rule Accuracy (START/JumpSTART)        |
| 6. Probabilistic Search Monte Carlo Heatmap & Contraction Tests          |
| 7. Multi-Target Packaging & CI Verification (Electron + Flutter)         |
+--------------------------------------------------------------------------+
```

---

## 2. Executing Automated Tests

### 2.1 Core Engine, Protocol & Backend Tests (Node.js)
```bash
# Run all automated TypeScript tests & formal research benchmarks
npm test

# Run shared protocol validation only
npm run test:protocol

# Run daemon & API integration tests only
npm run test:daemon

# Run formal research benchmark suite (Exps 1-7)
npm run benchmark
```

### 2.2 Android Mobile Tests (Flutter / Dart)
```bash
cd apps/android-flutter

# Run Dart unit, protocol, and widget tests
flutter test

# Run static analysis and formatting check
flutter analyze
dart format --set-exit-if-changed .
```

---

## 3. Key Test Scenarios & Protocols

### 3.1 Cross-Platform Protocol Compatibility (Dart & TypeScript)
* **Objective:** Ensure Windows Electron and Android Flutter serialize and deserialize the exact same event formats without schema drift.
* **Procedure:**
  1. The test suite loads `packages/protocol/fixtures/sample_events.json`.
  2. Events are parsed, validated against `event.schema.json`, serialized, and compared with golden outputs.
  3. Tests verify rejection of malformed payloads (missing `event_id`, invalid ISO timestamps, unknown event types).

### 3.2 Offline Local Persistence & Crash Recovery
* **Objective:** Verify Principle P2 ("Writes hit durable storage before network transmission").
* **Procedure:**
  1. Initialize local SQLite database in WAL mode.
  2. Create an operational casualty and record vital signs while completely disconnected.
  3. Terminate process abruptly.
  4. Re-open database and assert all events, active triage status, and outbox bundles are 100% intact.

### 3.3 Idempotent Ingestion & Duplicate Suppression
* **Objective:** Ensure repeated delivery of identical sync bundles never duplicates clinical actions or creates phantom records.
* **Procedure:**
  1. Generate an observation event `evt_obs_001`.
  2. Ingest the event into the local node 10 times consecutively.
  3. Assert the local event log length equals exactly 1.
  4. Assert the patient vitals count equals exactly 1.

### 3.4 Concurrent Safety-Critical Divergence (`DIV_TRIAGE_DELTA`)
* **Objective:** Verify that concurrent conflicting updates are never silently overwritten by Last-Write-Wins.
* **Procedure:**
  1. Two isolated nodes start with identical patient state (Patient #4).
  2. Node A tags Patient #4 as `RED` (Immediate) due to respiratory rate 36.
  3. Node B concurrently tags Patient #4 as `GREEN` (Minor walking wounded).
  4. Nodes reconnect and exchange missing events.
  5. Both events are preserved in the causal event stream.
  6. The `SemanticSafetyAnalyzer` flags `DIV_TRIAGE_DELTA` (Critical severity).
  7. The active status defaults to `RED` for safety until a human clinician signs off.
  8. Authorized clinician signs off as `RED`, committing an auditable `DIVERGENCE_RESOLVED` event.

### 3.5 Drug-Allergy Collision Detection (`DIV_DRUG_ALLERGY`)
* **Objective:** Verify instant detection when an administered drug matches a known allergy.
* **Procedure:**
  1. Record medication `Amoxicillin 500mg Oral` for a casualty.
  2. Attach an Emergency Medical ID snapshot documenting an allergy to `Penicillin`.
  3. Assert `SemanticSafetyAnalyzer` identifies drug class collision within < 5ms.
  4. Full-screen divergence alert modal is triggered with immediate counter-agent warnings.

---

## 4. Multi-Device Local LAN Verification Procedure

To verify live synchronization between a Windows PC and an Android phone on the same Wi-Fi network / field hotspot:

1. **Connect Devices:** Connect both Windows PC and Android phone to the same local Wi-Fi router or Android mobile hotspot (no active Internet connection required).
2. **Start Desktop Node:** Launch PeerScribe on Windows. The status bar displays local IP and WebSocket port (e.g., `ws://192.168.1.100:4321/ws/p2p`).
3. **Connect Mobile Client:** Open PeerScribe on Android. Tap *Pair Local Peer*, enter the PC's IP address (or scan QR code).
4. **Isolate & Create Records:** Disconnect Wi-Fi on Android. Intake a new casualty (`RED-FALCON-01`) on Android. Intake a casualty (`YELLOW-BEAR-04`) on Windows.
5. **Reconnect:** Re-enable Wi-Fi. Observe automatic handshake.
6. **Verify Convergence:** Both devices display both casualties. Outbox counts drop to 0. Audit trail lists origin device public keys.
