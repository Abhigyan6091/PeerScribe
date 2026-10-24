# PeerScribe: Master Implementation Plan & Engineering Blueprint

This document specifies the technical execution plan for delivering the tested Windows Electron and Android Flutter applications, shared wire protocol, and automated GitHub Actions CI/CD pipeline.

---

## 1. Roadmap & Phase Breakdown

```text
+---------------------------------------------------------------------------------------------------------+
|                                    PEERSCRIBE MVP IMPLEMENTATION PLAN                                   |
+-------------------+--------------------+--------------------+--------------------+----------------------+
| Phase A:          | Phase B:           | Phase C:           | Phase D:           | Phase E:             |
| Audit, Architecture| Shared Protocol    | Windows Electron   | Android Flutter    | CI/CD Pipeline &     |
| & ADR Alignment   | Package & Fixtures | Application        | Application        | Verifiable Releases  |
+-------------------+--------------------+--------------------+--------------------+----------------------+
```

---

### Phase A: Repository Audit & Architecture Baseline [COMPLETED]
- [x] Complete repository inspection (Node 26, npm 11, existing core-engine, platform-adapters, backend-service, ui-app).
- [x] Environment tooling assessment (Local host has Node.js; Flutter/Java to be compiled via GitHub Actions CI runner).
- [x] Create High-Level Design document (`docs/architecture/HLD.md`).
- [x] Create Architecture Decision Records (`docs/architecture/ADR.md`).
- [x] Create Testing Guide (`docs/TESTING.md`) and Release Strategy (`docs/RELEASES.md`).
- [x] Check out dedicated feature branch: `feat/cross-platform-mvp`.

---

### Phase B: Shared Protocol Package & Golden Fixtures [IN PROGRESS]
- [ ] Create `packages/protocol/` workspace package.
- [ ] Codify JSON Schemas:
  - `event.schema.json` (Canonical immutable event model).
  - `sync_bundle.schema.json` (Wire sync packet and vector clock).
  - `patient.schema.json` (Projected clinical casualty state).
- [ ] Create golden cross-platform test fixtures (`packages/protocol/fixtures/sample_events.json`).
- [ ] Implement TypeScript validation and serialization helpers in `packages/protocol/src/index.ts`.
- [ ] Write automated protocol test suite (`packages/protocol/tests/protocol.test.ts`) validating schema conformance, idempotency, and version compatibility.

---

### Phase C: Windows Desktop Electron Application
- [ ] Create `apps/desktop-electron/` project structure.
- [ ] Implement Electron Main Process (`src/main.ts` / `src/main.cjs`):
  - Strict security flags: `contextIsolation: true`, `nodeIntegration: false`, restrictive CSP.
  - Local embedded SQLite persistence (`node:sqlite` / `DatabaseSync`).
  - Secure IPC handlers for clinical actions, vitals, triage, and synchronization.
  - Embedded LAN WebSocket server and client sync engine.
- [ ] Implement Preload Bridge (`src/preload.ts`) exposing typed `window.peerScribeElectron`.
- [ ] Bundle tactical renderer UI (`packages/ui-app`) with responsive desktop layout.
- [ ] Configure `electron-builder.yml` for Windows NSIS installer (`.exe`) and portable standalone (`.zip`).
- [ ] Write automated IPC and persistence tests (`tests/electron_ipc.test.ts`).

---

### Phase D: Android Mobile Flutter Application
- [ ] Create `apps/android-flutter/` project structure with clean feature-first architecture.
- [ ] Codify Dart event models matching the shared protocol (`lib/core/protocol/event_model.dart`, `sync_bundle.dart`, `vector_clock.dart`).
- [ ] Implement local SQLite persistence with `sqflite` (`lib/core/storage/database_helper.dart`):
  - Append-only `events` table with unique constraint on `event_id`.
  - Projected `patients` and `operations` tables.
  - Priority `outbox` queue for DTN store-and-forward.
- [ ] Implement `SyncManager` (`lib/core/sync/sync_manager.dart`):
  - Bidirectional LAN WebSocket client & server synchronization.
  - Idempotent event ingestion and duplicate suppression.
  - Missing event reconciliation via vector clocks.
- [ ] Implement `SemanticSafetyAnalyzer` (`lib/core/sync/semantic_safety_analyzer.dart`) detecting `DIV_TRIAGE_DELTA` and `DIV_DRUG_ALLERGY`.
- [ ] Implement `StartTriageEngine` (`lib/core/clinical/start_triage_engine.dart`) implementing adult START and pediatric JumpSTART rules.
- [ ] Build high-stress tactical UI in Flutter (`lib/ui/`):
  - WCAG AAA high-contrast dark theme (`#090A0D`), min 64px thumb-zone touch targets.
  - Two-Tap Triage station (`RED`, `YELLOW`, `GREEN`, `BLACK`).
  - Active casualty feed with severity sorting.
  - Casualty Clinical Dossier & Treatment modal (Vitals, Trauma, Medications, Notes, Emergency Medical ID).
  - Semantic Divergence resolution banner and modal.
  - Probabilistic Search & Location recovery screen.
- [ ] Write comprehensive Dart automated tests (`test/event_model_test.dart`, `test/sync_manager_test.dart`, `test/crdt_divergence_test.dart`, `test/start_triage_test.dart`).

---

### Phase E: GitHub Actions CI/CD Pipeline & Verifiable Builds
- [ ] Modernize `.github/workflows/ci.yml`:
  - Job 1: Shared Protocol and Core Engine verification.
  - Job 2: Windows Electron test and packaging (`windows-latest` runner, producing setup installer and portable zip).
  - Job 3: Android Flutter test and packaging (`ubuntu-latest` runner with Flutter SDK, producing installable APK).
  - Downloadable CI build artifacts uploaded on every PR and push.
- [ ] Modernize `.github/workflows/release.yml`:
  - Triggered by `v*` tags or manual `workflow_dispatch` with semantic version input.
  - Strict release gates: all tests and static analysis must pass.
  - Produces signed release checksums (`SHA256SUMS.txt`) and BitChat verifiable source manifest (`SOURCE_MANIFEST.json`).
  - Publishes official GitHub Release with attached downloadable binaries.
- [ ] Update documentation (`README.md`, `docs/TESTING.md`, `docs/RELEASES.md`).

---

## 2. Acceptance Verification Matrix

| Milestone | Target Acceptance Criterion | Verification Method |
| :--- | :--- | :--- |
| **Protocol Compatibility** | Dart and TypeScript clients serialize and deserialize identical event fixtures without error. | `npm test` on `packages/protocol` & `flutter test` |
| **Local Persistence** | All writes hit local SQLite disk storage before network transmission; records survive restart. | SQLite transaction test suite |
| **Idempotent Ingestion** | Duplicate delivery of the same event ID never creates duplicate clinical actions. | Replication test suite |
| **Semantic Divergence** | Concurrent triage changes (RED vs GREEN) or drug-allergy collisions are detected and require human sign-off. | Level 2 Safety Analyzer tests |
| **Windows Packaging** | Electron app compiles into Windows installer and portable archive. | `electron-builder` build check |
| **Android Packaging** | Flutter app compiles into installable Android APK. | GitHub Actions CI `flutter build apk` |
| **CI/CD Reliability** | Zero broken workflows; all required checks must pass before release publication. | GitHub Actions workflow validation |
