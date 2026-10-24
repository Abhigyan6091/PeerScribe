# PeerScribe: Architecture Decision Records (ADRs)

This document records the foundational architecture decisions governing PeerScribe across both Windows Electron and Android Flutter implementations.

---

## ADR-001: Append-Only Immutable Event Sourcing with Deterministic State Projection

### Status
Accepted

### Context
In partitioned disaster networks, multiple field responders concurrently create, modify, and triage patients across disparate devices without central infrastructure. Traditional CRUD database mutations with Last-Write-Wins (LWW) destroy historical auditability and can silently overwrite critical medical triage (e.g., overriding `RED` with `GREEN`).

### Decision
Represent all system actions as an append-only log of immutable, cryptographically identified events:
1. Every write is an immutable `PeerScribeEvent` containing `event_id`, `operation_id`, `entity_id`, `actor_id`, `actor_sequence`, `lamport_timestamp`, `causal_context`, and typed payload.
2. The current state of patients and operations is a deterministic projection derived by folding the event stream.
3. Event ingestion is strictly idempotent: an event with an existing `event_id` is ignored without error.

### Consequences
- **Positive:** Perfect audit trail; crash resilience; deterministic replay; mathematical commutativity during network reconciliation.
- **Negative:** Requires state projection logic; event store grows over time (mitigated by operation archiving and retention pruning).

---

## ADR-002: Embedded SQLite Storage for Both Desktop (Electron) and Mobile (Flutter)

### Status
Accepted

### Context
PeerScribe nodes must persist every clinical write locally before transmission (Principle P2). We need an embedded, resilient, zero-configuration relational database with broad cross-platform support across Windows (Node.js/Electron) and Android (Dart/Flutter).

### Decision
Use SQLite in Write-Ahead Logging (`WAL`) mode on both platforms:
- **Windows Electron:** Node.js native `DatabaseSync` (`node:sqlite`) or `better-sqlite3`.
- **Android Flutter:** `sqflite` / `sqlite3` Dart package.
- **Unified Relational Schema:**
  - `events`: Immutable log of all events (`event_id PRIMARY KEY`).
  - `patients`: Projected casualty records with active triage category and timestamps.
  - `operations`: Active disaster operations, geofence, and coordinator metadata.
  - `outbox`: Pending sync bundles with priority, hop counter, and TTL.
  - `divergences`: Detected semantic conflicts requiring clinician sign-off.
  - `personal_vault`: Encrypted citizen profile storage.

### Consequences
- **Positive:** ACID guarantees; crash immunity in field conditions; zero dependency on external daemon processes; instant indexed queries.
- **Negative:** SQLite binary bindings must be properly bundled in Electron and Flutter packaging.

---

## ADR-003: Language-Neutral Versioned Wire Protocol (JSON Schema + Binary MTU Framing)

### Status
Accepted

### Context
Windows Electron (TypeScript/Node.js) and Android Flutter (Dart) must communicate directly over LAN without relying on JavaScript-only or Dart-only serialization libraries.

### Decision
Establish an explicitly versioned, language-neutral wire protocol:
1. **Schema Definition:** Formal JSON Schemas in `packages/protocol/schemas/` defining `event.schema.json`, `sync_bundle.schema.json`, and `patient.schema.json`.
2. **Standard Serialization:** UTF-8 JSON envelopes with strictly enforced field types, ISO-8601 UTC timestamps, and RFC 4122 UUIDs.
3. **BLE MTU Optimization:** When transmitting over bandwidth-constrained radios (BLE), payloads are framed with the BitChat 32-byte header, CRC-32 integrity checksums, and optional LZ4 compression.
4. **Cross-Language Test Fixtures:** A shared set of golden JSON event fixtures (`packages/protocol/fixtures/sample_events.json`) consumed by test suites in both TypeScript and Dart to guarantee 100% interoperability.

### Consequences
- **Positive:** Complete cross-platform compatibility; human-readable debugging; independent evolution of client implementations.
- **Negative:** JSON parsing incurs slight CPU overhead relative to Protobuf (negligible for clinical triage event volumes).

---

## ADR-004: Decoupled Personal Medical Vault vs. Ephemeral Disaster Incident Storage

### Status
Accepted

### Context
Principle P10 dictates strict isolation between a citizen's permanent private medical records and ephemeral disaster incident operational data. A citizen's entire medical history must never be broadcast over a disaster mesh.

### Decision
Decouple personal records into an encrypted vault and generate isolated emergency snapshots:
1. **Personal Vault:** Encrypted at rest using AES-256-GCM with PBKDF2 key derivation (10,000 iterations). Contains full history, confidential notes, and chronic conditions. Never synchronized across peers.
2. **Emergency Medical ID Snapshot:** A privacy-preserving subset (`bloodGroup`, `criticalAllergies`, `emergencyContacts`). Only attached to an operational casualty record when explicitly authorized by the responder or citizen.

### Consequences
- **Positive:** Zero risk of personal medical history leakage over disaster radios; compliance with healthcare privacy invariants.
- **Negative:** Responders must explicitly initiate the snapshot attachment workflow.

---

## ADR-005: Deterministic Triage Protocol Engine & Human-in-the-Loop Divergence Resolution

### Status
Accepted

### Context
Edge language models (SLMs) can hallucinate, making autonomous AI triage assignment unsafe (Principle P5 & P6). Furthermore, concurrent assessments by separated medics must not be resolved by simple timestamp ordering.

### Decision
1. **AI Extracts, Never Prescribes:** Edge ASR and language models only extract raw observation facts (respiration rate digits, pulse presence, trauma keywords).
2. **Audited Rule Engine:** Triage categories (`RED`, `YELLOW`, `GREEN`, `BLACK`) are computed strictly by deterministic state machines implementing the adult START and pediatric JumpSTART protocols.
3. **Semantic Safety Analyzer:** Detects clinical collisions:
   - `DIV_TRIAGE_DELTA`: Opposing triage categories for the same casualty. UI defaults to most acute category (`RED`) until human sign-off.
   - `DIV_DRUG_ALLERGY`: Administered medication collides with documented allergies. Surfaces a high-priority audible/visual alert.
4. **Authorized Human Sign-Off:** Requires a human clinician to tap the resolution button, creating an auditable `DIVERGENCE_RESOLVED` event.

### Consequences
- **Positive:** Zero risk of model hallucination corrupting triage; clinical safety guarantees; full legal audit trail.
- **Negative:** Requires clinician attention to resolve flagged disagreements.

---

## ADR-006: Local P2P Synchronization Transport via LAN WebSocket + Outbox Queue

### Status
Accepted

### Context
Before full multi-radio mesh (BLE, Wi-Fi Direct, Nostr) is deployed across all operating systems, a reliable, bidirectional, zero-internet local transport must be validated between Windows and Android on the same field hotspot.

### Decision
1. **LAN WebSocket Transport:** Both Electron and Flutter implement a bidirectional WebSocket peer synchronization channel.
2. **Store-and-Forward Outbox:** Local edits are queued in an on-disk `outbox` table with priority (`CRITICAL_SOS` > `CLINICAL_DELTA` > `ROUTINE`), TTL (48 hours), and hop counter (max 15).
3. **Vector Clock & Reconciliation Handshake:** When peers connect, they exchange vector clocks / known event hashes, transmit missing events in a `SyncBundle`, and acknowledge receipts.
4. **Transport Independence:** The synchronization manager and event ingestion pipeline are completely decoupled from the physical transport, allowing BLE and Nostr relays to be swapped in seamlessly.

### Consequences
- **Positive:** Works out of the box on standard field Wi-Fi routers and mobile hotspots without special OS root permissions; transport-agnostic core.
- **Negative:** Requires devices to connect to a shared Wi-Fi SSID or mobile hotspot.

---

## ADR-007: GitHub Actions CI/CD with Windows Electron & Android Flutter Packaging

### Status
Accepted

### Context
The user requires reproducible, downloadable Windows and Android applications built via an automated pipeline with strict test gating preventing untested code from releasing.

### Decision
1. **Independent CI Matrix:**
   - Windows job (`windows-latest`): Tests TypeScript core, builds Electron application, packages `.exe` installer and `.zip` portable package.
   - Android job (`ubuntu-latest`): Installs Flutter SDK, runs `flutter test`, builds installable Android APK (`.apk`).
   - Shared Protocol job: Validates JSON schemas and cross-platform fixtures.
2. **Downloadable CI Artifacts:** Every successful run on PRs and pushes uploads downloadable test artifacts.
3. **Semantic Release Workflow:** Gated release pipeline (`.github/workflows/release.yml`) triggered by `v*` tags or manual `workflow_dispatch`, generating verifiable build manifests (`SOURCE_MANIFEST.json`) and SHA-256 checksums (`SHA256SUMS.txt`).

### Consequences
- **Positive:** Automated quality gates; verifiable release artifacts; zero developer friction for multi-platform distribution.
- **Negative:** Requires GitHub Actions runner minutes for Windows and Android packaging.
