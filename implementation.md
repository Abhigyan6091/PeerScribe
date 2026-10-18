# PeerScribe: Master Phase-Wise Implementation Plan & Technical Blueprint
**An Offline-First, Peer-to-Peer Clinical Coordination & Emergency Mesh System for Zero-Connectivity and Disaster Environments**

---

## 1. Executive Overview & System Philosophy

### 1.1 The Core Thesis
Conventional clinical systems depend on an implicit assumption: **continuous network infrastructure and central database availability**. In disasters (earthquakes, mass-casualty incidents, floods, remote conflict zones), this assumption fails catastrophically:
- Cellular towers collapse or saturate.
- Central hospital servers become unreachable.
- Paper triage tags detach, get soiled, or lack temporal audit trails.
- Responders face sensory overload, physical fatigue, and partitioned working groups.

**PeerScribe operates on an inverse architectural invariant:**
> **"Connectivity is required solely for propagation, never for basic operation."**

Every device running PeerScribe—whether an Android smartphone, iOS device, ruggedized Windows tablet, or Linux field workstation—acts as an **autonomous, full logical replica**. There is **no permanent central database**. State is local-first, durable, conflict-resilient, and opportunistically propagated across physical space through local mesh peer-to-peer (BLE / Wi-Fi) and global delay-tolerant relays (Nostr).

```
                      +-----------------------------+
                      |         PEERSCRIBE          |
                      |   Unified Logical Node      |
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
                       |  Local Storage & State    |
                       |  (SQLite + CRDT Engine)   |
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

### 1.2 The Ten Invariant Architectural Principles
These ten principles are inviolable constraints governing every line of code across all phases:

| # | Invariant Principle | Architectural Implementation |
|---|---------------------|------------------------------|
| **P1** | **No Central Database** | Every node carries a self-contained SQLite + CRDT replica; no single point of failure exists. |
| **P2** | **Local Persistence First** | Writes hit durable disk storage (`WAL` mode SQLite) before any network transmission or memory-only broadcast. |
| **P3** | **Zero-Connectivity Independence** | 100% of triage, observation logging, vitals recording, and local AI queries execute without network packets. |
| **P4** | **CRDT Convergence ≠ Clinical Resolution** | Mathematical state convergence (LWW/CRDT) does not equate to clinical agreement. Semantic divergence must be surfaced to human medics. |
| **P5** | **AI Extracts, Never Prescribes** | Edge SLMs parse unstructured speech/text into validated JSON schemas. SLMs are strictly forbidden from autonomous dosage or drug prescription. |
| **P6** | **Deterministic Safety Rules** | Clinical triage protocols (START, JumpSTART) run on audited deterministic state machines, not probabilistic model weights. |
| **P7** | **Minimal Sync Units & Local Audio** | Raw audio recordings remain strictly on the recording device. Only structured cryptographic delta bundles are propagated. |
| **P8** | **Dynamic Gateway Roles** | Any node encountering internet connectivity instantaneously and ephemerally serves as a Nostr sync gateway for the mesh. |
| **P9** | **Tri-Modal Power Adaptation** | Devices transition between *Dormant*, *Field*, and *Emergency* modes to balance sensor/radio drain against tactical utility. |
| **P10**| **Strict Profile / Incident Isolation**| A citizen's personal encrypted medical record is cryptographically isolated from ephemeral disaster incident operational data. |

---

## 2. Dynamic Operational Modes & Node Lifecycle

To prevent catastrophic battery exhaustion during field operations while ensuring zero-latency responsiveness during acute disasters, PeerScribe implements a strict state machine across three operational profiles:

```
    +-------------------+
    |    1. DORMANT     |  Everyday citizen state; GPS/BLE/AI OFF.
    +---------+---------+  Personal profile encrypted at rest.
              |
              | User approaches risk zone / field drill
              v
    +-------------------+
    |     2. FIELD      |  Periodic GNSS sampling (every 3-5m).
    +---------+---------+  BLE background discovery active; AI on-demand.
              |
              | Incident triggered / SOS sent / Triage initiated
              v
    +-------------------+
    |   3. EMERGENCY    |  High-frequency GNSS; BLE + Wi-Fi P2P sync.
    +-------------------+  Nostr gateway enabled on connectivity.
```

### 2.1 Mode Resource Matrix
| Subsystem | Dormant Mode | Field Mode | Emergency Mode |
| :--- | :--- | :--- | :--- |
| **GNSS / GPS** | Disabled (`OFF`) | Periodic (120s duty cycle or 50m geofence) | Continuous / High Precision (5s updates) |
| **Bluetooth Low Energy** | Disabled (`OFF`) | Background Advertising & Listening | Aggressive Beaconing & Peer Handshakes |
| **Local Wi-Fi / P2P** | Disabled (`OFF`) | Opportunistic Hotspot Detection | High-Bandwidth Socket Mesh Active |
| **Edge AI Subsystem** | Dormant / Offloaded | On-demand voice button | Hot-cached in memory for instant transcription |
| **CRDT Synchronization**| Suspended | Event-driven on peer discovery | Continuous opportunistic push-pull queue |
| **Nostr Gateway Mode** | Disabled | Idle listener | Automatic store-and-forward proxy on WAN ping |
| **Data Retention** | Permanent user profile | Active Operation Working Buffer | Aggressive Append-Only Audit Trail |

---

## 3. Data Architecture, Schema & Distributed State

### 3.1 Dual-Storage Strategy
PeerScribe decouples durable relational queries from distributed delta replication through a dual-engine architecture:
1. **Durable Relational Storage (SQLite + SQLCipher):**
   - High-performance local indexing, full-text search, spatial queries, and ACID guarantees.
   - Encrypted with AES-256 via SQLCipher using device-derived key material.
2. **CRDT Distributed State Layer (Automerge / Yjs):**
   - Representation of clinical documents as Conflict-Free Replicated Data Types.
   - Causal tree history allowing arbitrary offline bifurcations and deterministic merges.

```
+-------------------------------------------------------------------------+
|                         PeerScribe Local Replica                        |
+------------------------------------+------------------------------------+
|         SQLite / SQLCipher         |             CRDT Engine            |
+------------------------------------+------------------------------------+
| - Patient fast search indices      | - Multi-device Triage State Tree   |
| - Pre-compiled START protocol rules| - Append-only Vitals & Notes Causal|
| - Map vector tiles & elevation data| - Dynamic Participant Capabilities |
| - Particle filter motion matrices  | - Cryptographic Sync Bundle Deltas |
+------------------------------------+------------------------------------+
```

### 3.2 Core Entity Models & Schemas

#### A. Ephemeral Patient Identity Model
Mass-casualty incidents (MCIs) involve incapacitated or unidentified patients. Conventional national ID or hospital MRN models fail. PeerScribe generates an **Ephemeral Operational Identity**:
- **Format:** `[COLOR]-[PHONETIC_ANIMAL]-[1-99]` (e.g., `RED-FALCON-04`, `YELLOW-BADGER-12`).
- **Visual Hash:** Deterministic 4x4 identicon generated from `SHA256(OperationID + PatientUUID)`.
- **Bar/QR/Thermal Tag:** Compact printable or scannable payload carrying ephemeral ID and node pubkey.
- **Re-Identification Linkage:** Encrypted pointer added if the patient's identity is subsequently confirmed.

#### B. The Incident / Operation Model
```json
{
  "$schema": "https://peerscribe.org/schemas/operation.v1.json",
  "operation_id": "op_20261019_himalayan_quake_01",
  "name": "District 4 Urban Collapse Response",
  "status": "ACTIVE", // ACTIVE | FINALIZING | ARCHIVED | PURGED
  "created_at": 1792377000,
  "coordinator_pubkey": "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3z5q206xs92hrvs993",
  "retention_policy": {
    "archive_after_hours": 72,
    "secure_wipe_after_days": 14
  },
  "geofence": {
    "center": [27.7172, 85.3240],
    "radius_meters": 5000
  }
}
```

#### C. The Clinical Patient State (CRDT Document)
```json
{
  "patient_id": "pt_uuid_9f83a210",
  "ephemeral_id": "RED-FALCON-04",
  "operation_id": "op_20261019_himalayan_quake_01",
  "created_at": 1792377120,
  "created_by": "node_pubkey_a1",
  "personal_profile_snapshot_ref": null,
  "triage": {
    "category": "RED", // RED (Immediate), YELLOW (Delayed), GREEN (Minor), BLACK (Expectant)
    "protocol": "START_ADULT_v1.2",
    "evaluated_by": "node_pubkey_a1",
    "timestamp": 1792377150,
    "override_reason": null
  },
  "vitals": [
    {
      "event_id": "evt_v_01",
      "timestamp": 1792377145,
      "recorded_by": "node_pubkey_a1",
      "respiration_rate": 34,
      "radial_pulse_present": false,
      "mental_status": "ALTERED",
      "capillary_refill_seconds": 3.2
    }
  ],
  "injuries": [
    {
      "id": "inj_01",
      "anatomical_location": "RIGHT_FEMUR",
      "classification": "OPEN_FRACTURE",
      "tourniquet_applied": false,
      "timestamp": 1792377148
    }
  ],
  "medications_administered": [
    {
      "admin_id": "med_admin_01",
      "drug_name": "Morphine Sulfate",
      "dosage": "5mg",
      "route": "IV",
      "administered_by": "node_pubkey_a1",
      "timestamp": 1792377200,
      "authorized_medic_signature": "sig_hex_991..."
    }
  ],
  "known_allergies": ["Penicillin", "Sulfa"],
  "divergence_flags": []
}
```

#### D. Sync Bundle Schema (The Universal Wire Protocol)
```json
{
  "bundle_id": "sb_7781b490",
  "operation_id": "op_20261019_himalayan_quake_01",
  "origin_node": "03a1f820c784...",
  "hop_count": 2,
  "timestamp": 1792377210,
  "vector_clock": {
    "node_a": 14,
    "node_b": 9
  },
  "crdt_delta_bytes": "base64_encoded_compressed_automerge_changeset",
  "payload_hash": "sha256_hex_...",
  "signature": "schnorr_sig_hex_..."
}
```

---

## 4. The Edge AI Subsystem & Deterministic Safety Layers

### 4.1 Speech-to-Structured-Clinical Pipeline
The application processes field audio through a deterministic pipeline that forbids hallucinations from corrupting clinical state:

```
+--------------------------------------------------------------------------+
|                        EDGE AI CLINICAL PIPELINE                         |
+--------------------------------------------------------------------------+
| 1. Field Audio Input (Push-to-Talk 16kHz PCM WAV)                        |
|    |                                                                     |
|    v                                                                     |
| 2. Local Whisper-Tiny / Small ASR Engine (ONNX Runtime / Sherpa-ONNX)    |
|    Output: "Adult male, rapid breathing 34, no radial pulse, open femur" |
|    |                                                                     |
|    v                                                                     |
| 3. Quantized SLM Information Extractor (SmolLM-360M / Qwen2.5-0.5B Int4) |
|    Task: Strict JSON entity extraction with zero speculative completion   |
|    |                                                                     |
|    v                                                                     |
| 4. Schema Validator (Strict Pydantic / Zod / JSON-Schema verification)   |
|    Invalid JSON -> Dropped with immediate audio re-prompt                |
|    |                                                                     |
|    v                                                                     |
| 5. Deterministic Clinical Triage Engine (Audited Code / START Machine)  |
|    Calculates triage classification based on validated vitals facts     |
|    |                                                                     |
|    v                                                                     |
| 6. Human-in-the-Loop 1-Tap Confirmation Screen                           |
|    Large High-Contrast Review Modal -> Medic taps "Accept"               |
|    |                                                                     |
|    v                                                                     |
| 7. Commit to SQLite WAL & Automerge CRDT Document                        |
+--------------------------------------------------------------------------+
```

### 4.2 Deterministic START Triage Decision Tree (Protocol Engine)
The Edge SLM **never** decides whether a patient is RED, YELLOW, GREEN, or BLACK. The extracted vitals are passed to the deterministic START protocol engine:

```
                     Can the patient walk?
                            |
           +----------------+----------------+
           | YES                             | NO
           v                                 v
     [ GREEN / MINOR ]             Is patient breathing?
                                             |
                            +----------------+----------------+
                            | NO                              | YES
                            v                                 v
                    Open the airway.                  Respiration Rate?
                            |                                 |
                     Breathing now?                   +-------+-------+
                     |            |                   |               |
                     v            v                   v               v
               [ RED / IMM ]  [ BLACK ]            > 30/min        < 30/min
                                                      |               |
                                                      v               v
                                                [ RED / IMM ]   Radial Pulse?
                                                                      |
                                                             +--------+--------+
                                                             | NO              | YES
                                                             v                 v
                                                       [ RED / IMM ]    Mental Status?
                                                                               |
                                                                      +--------+--------+
                                                                      | Altered        | Follows Simple
                                                                      v                v
                                                                [ RED / IMM ]    [ YELLOW / DEL ]
```

### 4.3 Safety Invariant: The "No Doctor Nearby" Escalation Protocol
If a device role is set to `Citizen / Participant` or `First Responder (Non-Clinician)` and no authorized clinician is reachable:
1. **Model Lockdown:** The SLM interface disables treatment recommendation prompts.
2. **Deterministic Emergency Action Cards:** The UI presents pre-compiled, peer-reviewed emergency first-aid protocols (e.g., Direct Pressure Hemorrhage Control, Recovery Position, Tourniquet Application).
3. **Escalation Packet Generation:** An automated priority SOS bundle is constructed with GPS and vital stats, flagged with `REQUIRES_CLINICAL_TAKEOVER = true` and broadcast across all P2P radios.

---

## 5. Semantic Divergence: Technical Convergence vs. Clinical Resolution

### 5.1 The CRDT Convergence Fallacy
A standard CRDT (Automerge, Yjs) mathematically resolves concurrent updates using causal order or Last-Write-Wins (LWW). 
**In clinical emergencies, LWW can be fatal:**
- *Medic A* (disconnected) diagnoses Patient #4 as **RED (Immediate)** due to respiratory collapse.
- *Medic B* (disconnected 5 seconds later) re-checks walking wounded and tags Patient #4 as **GREEN (Minor)** due to identity tag confusion.
- Standard CRDT will silently overwrite Medic A's evaluation with Medic B's timestamped update. **Patient #4 dies of asphyxiation waiting in the delayed zone.**

### 5.2 The 3-Tier Conflict Resolution Architecture

```
                                Concurrent Edits
                                        |
                                        v
                    +---------------------------------------+
                    | Level 1: CRDT Causal Multi-Value State|
                    | Preserves both edits; no silent drop  |
                    +-------------------+-------------------+
                                        |
                                        v
                    +---------------------------------------+
                    | Level 2: Semantic Safety Analyzer     |
                    | Checks clinical divergence rules      |
                    +-------------------+-------------------+
                                        |
                 +----------------------+----------------------+
                 | No Clinical Conflict                        | Clinical Conflict Detected
                 v                                             v
        Auto-Merged Cleanly                         +-----------------------+
        (e.g., Vitals append)                       | Level 3: Divergence UI|
                                                    | Loud visual banner;   |
                                                    | human sign-off needed |
                                                    +-----------------------+
```

### 5.3 Semantic Divergence Rules Table
The `SemanticSafetyAnalyzer` continuously inspects newly merged CRDT documents against these deterministic safety invariants:

| Conflict ID | Condition Trigger | Safety Severity | UI Action | Resolution Mechanism |
| :--- | :--- | :--- | :--- | :--- |
| **DIV_TRIAGE_DELTA** | Concurrently merged triage categories differ (e.g., RED vs YELLOW). | **CRITICAL** | Flashing Red Banner + Haptic buzz | Strict human clinical sign-off; defaults view to the most acute status until resolved. |
| **DIV_DRUG_ALLERGY** | `medications_administered` contains drug $D$ while `known_allergies` contains $D$ or known drug class. | **FATAL RISK** | Full-screen High-Priority Modal | Audible alert; displays administering medic identity and timestamp for immediate counter-agent administration. |
| **DIV_DUPLICATE_ID** | Two separate intake events register the same ephemeral phonetic ID at different coordinates (>100m). | **WARNING** | Amber Banner | Automatically appends alphanumeric discriminator (`RED-FALCON-04A` / `RED-FALCON-04B`) and prompts photos. |
| **DIV_IDENTITY_ATTACH**| Conflicting citizen personal profiles attached to the same operational patient. | **HIGH** | Split-screen comparison card | Coordinator role authorization required to unlink/relink. |

---

## 6. Hybrid Mesh Networking: Local P2P & Nostr Global Relays

### 6.1 Multi-Tier Radio Architecture
PeerScribe prevents radio battery burnout and solves the "7-Hop Degradation" problem (where deep Bluetooth meshes suffer packet collapse beyond 5–7 hops) by combining local broadcast mesh with opportunistic wide-area gateways:

```
[ Isolated Field Mesh ]                           [ Command Center ]
+----------+      BLE Beacon      +----------+
| Device A | -------------------> | Device B |
+----+-----+                      +----+-----+
     |                                 |
     | Wi-Fi Direct Sync               | BLE Store & Forward
     v                                 v
+----+-----+                      +----+-----+          Internet
| Device C |                      | Device D | =======================+
+----------+                      | (Gateway)|                        |
                                  +----------+                        v
                                                              +---------------+
                                                              |  Nostr Relay  |
                                                              |  (NIP-01/44)  |
                                                              +-------+-------+
                                                                      |
                                                                      v
                                                              +---------------+
                                                              | Base Hospital |
                                                              | Replica Node  |
                                                              +---------------+
```

### 6.2 Local Transport: BLE & Wi-Fi Direct
1. **Discovery (BLE Advertising):**
   - Service UUID: `0000PS01-0000-1000-8000-00805F9B34FB`
   - Manufacturer Data contains: `[OpID_Hash (4 bytes)][NodePubKey (8 bytes)][StateVectorClock_Hash (4 bytes)][Battery/Mode (1 byte)]`.
   - Compares remote state vector hash with local state; triggers connection only if delta is detected.
2. **Payload Transfer (Local Wi-Fi / WebSockets):**
   - For bundles > 512 bytes, nodes initiate high-speed Wi-Fi Direct, Local Hotspot, or direct TCP sockets over LAN.
   - Streaming compressed Automerge binary changesets.

### 6.3 Store-and-Forward (DTN) Queue
If Device B is neither connected to Device D nor has Internet, it stores Device A's sync bundles in an on-disk **Outbox Queue**:
- **TTL (Time to Live):** 48 hours default (configurable per operation).
- **Hop Counter:** Incremented on each forwarding peer; dropped if hop count exceeds 15 (mesh loop protection).
- **Anti-Entropy Bloom Filter:** Nodes exchange a 128-byte Bloom filter of known `bundle_id`s during handshake to suppress redundant transmissions.

### 6.4 The Nostr Global Relay Layer
When any node (Device D) detects active cellular or satellite internet:
1. **Dynamic Ephemeral Gateway Promotion:** The node marks itself as `GATEWAY_ACTIVE`.
2. **Encrypted Bundle Packaging (NIP-44):** The local CRDT deltas are packaged into standard Nostr events:
   - **Kind:** `20042` (Ephemeral Encrypted Mesh Sync Bundle).
   - **Tags:** `["e", Operation_ID_Hash]`, `["p", Recipient_Group_Pubkey]`.
   - **Content:** Encrypted with operation shared secret via ChaCha20-Poly1305 (NIP-44).
3. **Relay Fanout:** Published across pre-configured public and field-deployed tactical relays (e.g., portable Raspberry Pi running `nostr-rs-relay`).
4. **Zero-Knowledge Transport:** The Nostr relays have zero access to patient identities or clinical content.

### 6.5 BitChat Architectural Parallels & Direct Technical Mapping
PeerScribe’s offline-first mesh and relay synchronization subsystem directly references and extends the proven, battle-tested paradigms of the **BitChat** open-source ecosystem (`permissionlesstech/bitchat` for iOS/macOS and `permissionlesstech/bitchat-android` for Android). 

While BitChat was created as a decentralized, peer-to-peer, censorship-resistant messaging tool, PeerScribe adapts its communication primitives to the high-stakes, safety-critical requirements of emergency clinical coordination.

```
+-----------------------------------------------------------------------------------------------+
|                       BITCHAT vs. PEERSCRIBE ARCHITECTURAL MAPPING                            |
+-----------------------------------+-----------------------------------------------------------+
| BitChat Primitive (P2P Messaging) | PeerScribe Adaptation (Clinical Coordination)             |
+-----------------------------------+-----------------------------------------------------------+
| 1. Dual-Transport Architecture    | Same dual-transport: BLE Mesh for local field triage +     |
|    (BLE multi-hop mesh + Nostr)   | Nostr relay mesh for hospital gateway bridging.           |
|                                   |                                                           |
| 2. Noise Protocol Framework (XX)  | Noise XX handshake used for mutual medic/device authn;    |
|    (X25519 + ChaCha20-Poly1305)   | generates authenticated sessions for CRDT sync deltas.    |
|                                   |                                                           |
| 3. Binary Packet Framing with     | BitChat binary framing adapted for CRDT changesets:       |
|    LZ4 payload compression        | compact binary envelopes compressed with LZ4 to fit BLE.  |
|                                   |                                                           |
| 4. Geohash-Based Spatial Routing  | Incidents & operations indexed by Geohash (precision 5-7);|
|    (Location-scoped channels)     | Nostr relays filter sync bundles by disaster geofence.    |
|                                   |                                                           |
| 5. Emergency Wipe / Panic Zeroize | Hardened instant zeroization: securely wipes private keys,|
|    (Triple-tap / command purge)   | clinical patient cache, and SQLCipher db on physical risk.|
|                                   |                                                           |
| 6. Source Manifest Integrity      | BitChat reproducible build & SHA-256 source manifest      |
|    (Cryptographic build audit)    | integrated into multi-version CI/CD pipeline.             |
+-----------------------------------+-----------------------------------------------------------+
```

#### 1. Dual-Transport State Machine (BLE Mesh + Nostr Fallback)
Following BitChat’s design:
- Nodes run an autonomous background state machine that discovers nearby peers via BLE advertising packets without prior pairing.
- If a route through intermediate nodes exists (up to 7 hops in BitChat; bounded to 15 hops in PeerScribe with loop detection), data is transferred peer-to-peer.
- When an active Internet route (WAN) is detected on any node, it automatically routes sync bundles to configured Nostr relays using ephemeral Nostr keypairs, exactly as BitChat relays chat envelopes over decentralized Nostr relays.

#### 2. Noise Protocol Framework (Noise XX Handshake)
PeerScribe adopts BitChat's end-to-end encryption model:
- BitChat utilizes the **Noise Protocol Framework** pattern `Noise_XX_25519_ChaChaPoly_SHA256` for establishing peer-to-peer direct sessions without relying on centralized Public Key Infrastructure (PKI).
- When Medic Device A discovers Medic Device B over BLE:
  1. `-> e` (Initiator ephemeral public key).
  2. `<- e, ee, s, es` (Responder ephemeral key, DH, encrypted static identity key, DH).
  3. `-> s, se` (Initiator encrypted static identity key, DH).
- Once completed, both devices share symmetric session keys with **Perfect Forward Secrecy (PFS)**. Even if a field device is physically captured later, past clinical transmissions cannot be decrypted.

#### 3. Compact Binary Framing & BLE MTU Fragmentation (with LZ4)
Bluetooth LE advertisements and GATT attributes face strict Maximum Transmission Unit (MTU) limits (typically 20 bytes legacy to 512 bytes with MTU exchange).
Following BitChat’s packet structure, PeerScribe frames CRDT deltas into a lightweight binary wire protocol:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| Magic (0x5053)| Version (0x01)| Packet Type   | Flags (Compres)|
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| Hop Count     | Max TTL       | Sequence Number               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| Operation Geohash (8 bytes, ASCII)                            |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| Sender Ephemeral Pubkey Hash (8 bytes)                        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| Payload Length (2 bytes)      | CRC-32 / Poly1305 MAC (4 bytes)|
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| Payload: LZ4-Compressed Encrypted CRDT Delta / Vitals Chunk  ...
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```
- **Compression Rule:** Any payload over 100 bytes is automatically compressed via **LZ4** prior to encryption, reducing transmission airtime and radio energy by up to 55%.
- **Chunking Engine:** Payloads exceeding the negotiated BLE MTU are fragmented into indexed chunks (`ChunkIndex` / `TotalChunks`) and reassembled at the receiving replica before ingestion into Automerge.

#### 4. Geohash-Based Spatial Routing
BitChat implements location-based channels by mapping GPS coordinates to geohash strings, allowing users in the same physical area to discover and communicate over Nostr relays.
PeerScribe generalizes this:
- Every active disaster operation is bound to a bounding geohash (e.g., `u15ek` for ~5km radius or `u15ek2` for ~1km precision).
- When publishing sync bundles over Nostr relays (Kind `20042`), bundles are tagged with `["g", geohash]`.
- Nodes subscribing to updates from the field issue Nostr filter requests matching their regional geohash prefix. This eliminates global relay spam and ensures devices only download updates relevant to their tactical sector.

#### 5. Emergency Wipe & Anti-Capture Zeroization
In disaster, conflict, or high-risk zones, devices risk physical theft or hostile capture. Borrowing BitChat's "Emergency Wipe" philosophy:
- **Trigger Mechanisms:**
  1. High-stress UI gesture (e.g., 5-tap emergency sequence on the header status badge).
  2. Tactical wipe broadcast command received from an authenticated Incident Coordinator.
  3. Tamper detection (e.g., failed device PIN attempts exceeded in Emergency Mode).
- **Zeroization Pipeline:**
  - Instantly overwrites the in-memory master encryption key with pseudorandom bytes.
  - Drops SQLCipher database encryption keys from volatile memory.
  - Executes `PRAGMA cipher_memory_security = ON;` and issues a secure disk scrub of SQLite database files.
  - Wipes all local CRDT history, unsent DTN outbox queues, and audio cache, returning the app to an uninitialized factory state.

---

## 7. Probabilistic Location Recovery & Search Heatmap Engine

### 7.1 The Isolated Individual Problem
In mass disasters, wounded individuals or separated responders lose all connectivity. GPS readings freeze at the Last Known Position (LKP). Drawing a naive fixed-radius circle ($R = v \times \Delta t$) is useless in rugged terrain, urban collapse, or mountainous areas.

### 7.2 Sequential Monte Carlo (Particle Filter) Model
PeerScribe runs an on-device particle filter simulation estimating the probability distribution $p(x_t \mid z_{1:t})$:

$$x_t = (p_x, p_y, v_x, v_y, \text{mobility\_state})$$

```
                   Last Known Position (GPS)
                              |
                              v
        Initialize N = 2,000 Particles around LKP
                              |
                              v
    +---------------------------------------------------+
    | Iterative Time Step Propagation (dt = 60s)        |
    | - Terrain Cost Grid (Slope, Water, Obstacles)     |
    | - Road / Trail Biasing (Walkways attract particles|
    | - Mobility State (Injured: 0.5 km/h, Normal: 4km/h|
    +-------------------------+-------------------------+
                              |
                              v
    +---------------------------------------------------+
    | Bayesian Measurement Weighting (On New Evidence)  |
    | - Sighting by passing responder BLE beacon        |
    | - Heard audio distress report / SOS               |
    | - Elevation constraint from barometric altimeter  |
    +-------------------------+-------------------------+
                              |
                              v
        Generate 2D Gaussian Kernel Density Heatmap
                              |
                              v
        Render Tactical Offline Map Isochrones (50%, 75%, 90%)
```

```
 Tactical Search Heatmap Output
 +---------------------------------------------------+
 |  [ LKP ]                                          |
 |     \                                             |
 |      \ (River - impassable obstacle: 0 particles) |
 |       ~~~~~~~~~~~~~~~                             |
 |       \                                           |
 |        \=====[ High Prob Trail: 65% ]===========> |
 |               [ Medium Prob Clearing: 25% ]       |
 |                                                   |
 | [Legend: Red = 90% Mass | Amber = 75% | Blue = 50%|
 +---------------------------------------------------+
```

---

## 8. High-Stress HCI & Ergonomic Design System

### 8.1 Physical and Cognitive Stress Invariants
First responders operate under severe impairments:
- **Gloves & Tremors:** Thick nitrile, neoprene, or firefighter gloves; shaking hands from adrenaline.
- **Visual Glare & Darkness:** Blinding sunlight, smoke, or pitch blackness with headlamps.
- **Cognitive Tunnel Vision:** Inability to read paragraphs or navigate multi-level nested menus.

### 8.2 The Ergonomic Design Tokens
```css
/* PeerScribe High-Stress Design System Tokens */
:root {
  /* Touch target rule: Fitts's law compliant for gloved thumbs */
  --min-touch-target: 64px;
  --touch-target-large: 80px;

  /* Contrast ratio: Ultra-high contrast (WCAG AAA+ compliant) */
  --bg-primary: #0A0A0C;
  --bg-surface: #18191E;
  --border-thick: 3px solid #FFFFFF;
  
  /* Triage Palette: Immediate color discrimination under poor lighting */
  --triage-red: #FF1A1A;     /* Immediate life threat */
  --triage-yellow: #FFB800;  /* Delayed */
  --triage-green: #00E676;   /* Minor / Walking Wounded */
  --triage-black: #424242;   /* Deceased / Expectant */
  
  /* Divergence Alert */
  --divergence-flashing: #FF0055;
  
  /* Typography */
  --font-family: 'Inter', -apple-system, sans-serif;
  --font-weight-heavy: 800;
  --font-size-triage-badge: 2.5rem;
}
```

### 8.3 Screen Architecture: The Two-Tap Rule
No clinical action in PeerScribe shall require more than **two physical taps**:

```
+----------------------------------------------------------+
| RED-FALCON-04                       [ MODE: EMERGENCY ]  |
| Dist: 12m | Last Seen: 1m ago                            |
+----------------------------------------------------------+
|                                                          |
|                    CURRENT STATUS:                       |
|                   [ RED / IMMEDIATE ]                    |
|                                                          |
+----------------------------------------------------------+
|  [ RED ]               [ YELLOW ]                        |
|  Immediate             Delayed                           |
|  (Min 72px)            (Min 72px)                        |
|                                                          |
|  [ GREEN ]             [ BLACK ]                         |
|  Minor                 Expectant                         |
|  (Min 72px)            (Min 72px)                        |
+----------------------------------------------------------+
|                                                          |
|    (( PUSH TO TALK CLINICAL OBSERVATION )) (Min 84px)    |
|                                                          |
+----------------------------------------------------------+
```

---

## 9. Comprehensive Phase-Wise Implementation Roadmap

```
+---------------------------------------------------------------------------------------------------------+
|                                   PEERSCRIBE IMPLEMENTATION PHASES                                      |
+-------------------+--------------------+--------------------+--------------------+----------------------+
| Phase 0: Setup &  | Phase 1: Core Data | Phase 2: Clinical  | Phase 3: Edge AI   | Phase 4: High-Stress |
| Architecture      | & CRDT Engine      | Deterministic Logic| Inference Engine   | Tactical UI          |
+-------------------+--------------------+--------------------+--------------------+----------------------+
| Phase 5: Local P2P| Phase 6: Nostr     | Phase 7: Location  | Phase 8: Hardening | Phase 9: Deployment  |
| Mesh & DTN Sync   | Global Gateway     | & Particle Filter  | & Research Evals   | & Field Readiness    |
+-------------------+--------------------+--------------------+--------------------+----------------------+
```

---

### Phase 0: Project Inception, Environment & Architecture Setup
**Objective:** Establish workspace structure, typing contracts, developer tooling, and baseline libraries.

- **Tasks:**
  1. Configure modular project structure separating `core-engine` (logic/crdt/models) from `adapters` (native platform hardware APIs) and `ui`.
  2. Set up code formatting, linter, TypeScript strict configurations, and unit test runner (Vitest).
  3. Define protocol buffer / JSON schemas for cross-platform data interchange.
  4. Create mocking harnesses for Bluetooth Low Energy, GPS geolocation, and microphone PCM streaming.
- **Deliverables:**
  - Compiling monorepo skeleton.
  - Baseline documentation & CI pipeline.
- **Acceptance Criteria:**
  - Zero linting errors; automated tests pass across clean environment.

---

### Phase 1: Core Data Engine & Local CRDT Storage Layer
**Objective:** Deliver the resilient, offline-first local storage combining encrypted SQLite and distributed CRDT synchronization.

- **Tasks:**
  1. **SQLite Database Architecture:**
     - Initialize SQLite with Write-Ahead Logging (`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`).
     - Schema setup: `operations`, `patients`, `events`, `vitals`, `location_breadcrumbs`, `sync_outbox`.
  2. **Personal Profile Cryptographic Vault:**
     - Implement AES-GCM encrypted local storage for citizen profile (blood group, allergies, medications, next of kin).
     - Build export mechanism for limited Emergency Snapshot generation.
  3. **Ephemeral Identity Generator:**
     - Phonetic tri-word generator (`[COLOR]-[ANIMAL]-[DIGIT]`).
     - Deterministic identicon generation and thermal printing layout renderer.
  4. **CRDT Engine Integration:**
     - Integrate Automerge (or Yjs) document model for collaborative patient state.
     - Implement delta serializer/deserializer to convert CRDT changesets into binary sync bundles.
  5. **Vector Clock & State Tracking:**
     - Causal state vector calculation per operation replica.
     - Missing delta range detection algorithm (`diff_state(local_vector, remote_vector)`).
- **Deliverables:**
  - `src/core/storage/db.ts`
  - `src/core/storage/crdt_manager.ts`
  - `src/core/identity/ephemeral_id.ts`
  - `src/core/profile/personal_vault.ts`
- **Acceptance Criteria:**
  - Concurrent simulated writes to two offline replicas merge deterministically with zero data loss upon syncing.
  - Database survives sudden process termination during writes without corruption.

---

### Phase 2: Deterministic Clinical Logic & Safety Layer
**Objective:** Implement audited, deterministic clinical algorithms and the semantic conflict resolution engine.

- **Tasks:**
  1. **Deterministic Triage Rule Engine:**
     - Encode START (Simple Triage and Rapid Treatment) for adults.
     - Encode JumpSTART for pediatric patients.
     - Versioned rule registry allowing auditability (`START_v1.0.0`).
  2. **Semantic Divergence Analyzer (`SemanticSafetyAnalyzer`):**
     - Inspection of newly merged CRDT patient states.
     - Detect conflicting triage classifications from different medics.
     - Detect medication administration vs. documented allergy collisions.
     - Mark divergence flags in patient document without dropping either update.
  3. **Medication & Treatment Audit Ledger:**
     - Structured recording of drug, dose, route, timestamp, and medic signature.
     - Strict validation forbidding un-signed or free-text drug recommendations.
  4. **Citizen Emergency Assistance Mode:**
     - Pre-compiled deterministic first-aid decision trees for laypersons.
- **Deliverables:**
  - `src/core/clinical/triage_rules.ts`
  - `src/core/clinical/semantic_safety.ts`
  - `src/core/clinical/medication_ledger.ts`
- **Acceptance Criteria:**
  - 100% test coverage over START triage edge cases.
  - Injecting a simulated penicillin dose into a patient with a penicillin allergy flag triggers a `DIV_DRUG_ALLERGY` event in under 5 milliseconds.

---

### Phase 3: Edge AI Audio Transcription & Structured Extraction
**Objective:** Implement on-device speech-to-structured-clinical data pipeline with strict schema enforcement.

- **Tasks:**
  1. **Audio Capture Subsystem:**
     - 16kHz mono PCM stream recorder with push-to-talk state machine and silence trimming.
  2. **Local ASR Engine Integration:**
     - Whisper-Tiny integration via ONNX Runtime / Sherpa-ONNX / WebAssembly.
     - Target inference latency < 1.2s for a 5-second audio snippet.
  3. **Constrained SLM Information Extraction:**
     - Embed lightweight quantized small language model (e.g. SmolLM-360M-Instruct Int4 / Qwen2.5-0.5B-Instruct).
     - Formulate structured prompt forcing strict JSON output matching `ClinicalObservationSchema`.
  4. **Strict Schema Validation & Grammar Filtering:**
     - Zod / JSON Schema validation on raw SLM output string.
     - Fallback / retry logic: if output fails validation, isolate unparsed text into a raw note draft without mutating structured vitals.
- **Deliverables:**
  - `src/core/ai/audio_recorder.ts`
  - `src/core/ai/asr_whisper.ts`
  - `src/core/ai/slm_extractor.ts`
  - `src/core/ai/schema_validator.ts`
- **Acceptance Criteria:**
  - No internet connection required.
  - Zero hallucinated fields admitted to the database; every extracted attribute strictly conforms to schema.

---

### Phase 4: High-Stress Tactical UI & Ergonomic Experience
**Objective:** Build high-contrast, thumb-zone optimized interfaces meeting the physical constraints of disaster response.

- **Tasks:**
  1. **Design System & High-Contrast Tokens:**
     - Global CSS / design tokens conforming to Section 8.
     - Large touch targets (minimum 64px, thumb-zone primary controls).
  2. **Active Operation Dashboard:**
     - Rapid casualty list sorted by triage category (RED first).
     - Ephemeral ID cards with high-contrast color banners and phonetic titles.
  3. **Two-Tap Triage Interface:**
     - Single-handed thumb buttons for RED, YELLOW, GREEN, BLACK.
     - Push-to-Talk floating action button with live waveform and instant transcription preview.
  4. **Semantic Divergence Alert Component:**
     - Unignorable divergence banner highlighting medic conflict.
     - Split-screen timeline comparison showing Medic A vs Medic B observations with single-tap clinician sign-off.
  5. **Dormant / Field / Emergency Mode Switcher:**
     - Accessible operational mode toggle with battery impact warning.
- **Deliverables:**
  - `src/ui/styles/tokens.css`
  - `src/ui/components/TriageCard.tsx`
  - `src/ui/components/DivergenceModal.tsx`
  - `src/ui/components/VoiceInputBar.tsx`
  - `src/ui/views/OperationView.tsx`
- **Acceptance Criteria:**
  - UI usable in simulated gloved condition (large target hit verification).
  - High contrast passes WCAG AAA standards in sunlight and dark testing.

---

### Phase 5: Local P2P Mesh Networking & Store-and-Forward DTN
**Objective:** Implement multi-hop opportunistic synchronization over Bluetooth Low Energy and Wi-Fi Direct.

- **Tasks:**
  1. **BLE Advertising & Discovery Engine:**
     - Custom BLE GATT service & advertising payload broadcasting state vector hashes.
     - Background peer table maintenance (`KnownPeers` cache).
  2. **High-Speed Socket Synchronization:**
     - Establish direct Wi-Fi / local socket connections between discovered nodes.
     - Exchange state vectors, compute delta sets, and stream compressed sync bundles.
  3. **Store-and-Forward Outbox (DTN Layer):**
     - On-disk queue storing bundles for unreachable peers.
     - Bloom filter exchange to suppress duplicate bundle relaying.
     - Hop limit counter (maximum 15 hops) preventing infinite broadcast loops.
  4. **Network Partition Recovery:**
     - Reconnection reconciliation algorithm guaranteeing eventual consistency across split-mesh clusters.
- **Deliverables:**
  - `src/core/network/ble_discovery.ts`
  - `src/core/network/socket_sync.ts`
  - `src/core/network/dtn_queue.ts`
  - `src/core/network/bloom_filter.ts`
- **Acceptance Criteria:**
  - Simulated 3-node bucket brigade (Node A -> Node B -> Node C, where A and C never see each other) successfully transmits patient triage update from A to C via B in store-and-forward mode.

---

### Phase 6: Nostr Global Relay Layer & Ephemeral Internet Gateway
**Objective:** Bridge isolated local meshes to global command centers via opportunistic gateways and Nostr relays.

- **Tasks:**
  1. **WAN Connectivity Observer:**
     - Automatic detection of cellular/satellite internet ping.
     - Ephemeral promotion of node to Gateway status without user configuration.
  2. **Sync Bundle Cryptography (NIP-44 / AES-GCM):**
     - Encrypt sync bundle payloads using shared operation secret or recipient coordinator pubkey.
     - Compute Schnorr signature on Nostr events.
  3. **Nostr Relay Client Protocol (NIP-01 / NIP-44):**
     - Connect to tactical and public Nostr relay endpoints via WebSockets.
     - Publish Kind `20042` events for outgoing local bundles.
     - Subscribe to operation tags and ingest incoming bundles into local CRDT engine.
  4. **Deduplication & Relay Outage Tolerance:**
     - Idempotent ingest pipeline ignoring already-applied bundle IDs.
     - Relay failover list with exponential backoff reconnects.
- **Deliverables:**
  - `src/core/nostr/gateway_manager.ts`
  - `src/core/nostr/crypto_nip44.ts`
  - `src/core/nostr/relay_client.ts`
- **Acceptance Criteria:**
  - An encrypted bundle published by a gateway node is received by a remote base hospital replica over Nostr, decrypted, and merged into the hospital's clinical view.

---

### Phase 7: Probabilistic Location Recovery & Search Heatmap
**Objective:** Implement on-device Monte Carlo particle filter simulation to locate disconnected victims and lost responders.

- **Tasks:**
  1. **Location Breadcrumb & Dead-Reckoning Ingest:**
     - High-efficiency logging of GNSS fixes, barometric altitude, and pedometer steps.
     - Recording of Last Known Position (LKP) prior to disconnection.
  2. **Particle Filter Motion Engine:**
     - Initialize 2,000 particles distributed normally around LKP.
     - Kinematic state updates taking into account elapsed time and estimated speed (walking/running/trapped).
     - Incorporate cost-grid terrain constraints (penalizing steep slopes, forbidding water bodies).
  3. **Bayesian Observation Fusion:**
     - Update particle weights when a passing peer records a BLE probe sighting or acoustic signature.
     - Resampling step (Sequential Importance Resampling - SIR).
  4. **Tactical Heatmap & Isochrone Visualizer:**
     - Compute 2D kernel density estimation from particle swarm.
     - Render 50%, 75%, and 90% probability search contours on offline vector map tiles.
- **Deliverables:**
  - `src/core/location/particle_filter.ts`
  - `src/core/location/terrain_cost.ts`
  - `src/ui/components/SearchHeatmap.tsx`
- **Acceptance Criteria:**
  - Particle simulation executes on-device in under 50ms per step.
  - Ingesting a simulated sighting updates and contracts the search area appropriately.

---

### Phase 8: System Hardening, Cross-Platform Packaging & Research Benchmarking
**Objective:** Package the shared core for deployment and execute the rigorous empirical research evaluation suite.

- **Tasks:**
  1. **Cross-Platform Adapters Implementation:**
     - Android / iOS hardware wrapper bindings (Bluetooth, GPS, Audio, FileSystem).
     - Desktop (Windows / Linux) builds with keyboard shortcuts for dispatchers.
  2. **Security & Privacy Audit:**
     - Penetration testing: verify Nostr relays cannot inspect unencrypted patient data.
     - Verify complete cryptographic zeroization upon operation archival and wipe.
  3. **Execution of Experimental Research Suite (as defined in Section 10).**
- **Deliverables:**
  - Complete cross-platform executable targets.
  - Automated benchmark test harness.
  - Formal experimental evaluation report.

---

## 10. Formal Research Evaluation & Experimental Protocols

To substantiate PeerScribe as a scientific contribution in distributed systems and clinical informatics, the system must be evaluated across seven empirical experiments:

```
+----------------------------------------------------------------------------------------------------+
|                                    FORMAL RESEARCH BENCHMARKS                                      |
+-------------------+--------------------+--------------------+--------------------+-----------------+
| Exp 1: CRDT       | Exp 2: P2P Multi-  | Exp 3: Nostr       | Exp 4: Edge AI     | Exp 5: HCI      |
| Convergence &     | Hop Latency &      | Gateway Bridging   | Accuracy & Schema  | High-Stress     |
| Partition Test    | Store-and-Forward  | Throughput         | Validity           | Ergonomics      |
+-------------------+--------------------+--------------------+--------------------+-----------------+
|                   | Exp 6: Probabilistic Search             | Exp 7: Battery Duty-Cycle          |
|                   | Area Containment vs Ground Truth        | Profiles across Modes              |
+-------------------+-----------------------------------------+------------------------------------+
```

### Detailed Evaluation Matrices

#### Experiment 1: CRDT Convergence Under Pathological Partitions
- **Setup:** 5 simulated replicas, 20 concurrent patients, simulated network partition cycles (3 minutes split, 30 seconds reconnect).
- **Injected Events:** 1,000 concurrent updates (vitals, triage changes, note additions).
- **Target Metrics:**
  - Convergence correctness: 100% identical state across all nodes post-reconciliation.
  - Zero dropped clinical updates.
  - Time to convergence < 1.5s after network link restoration.

#### Experiment 2: Multi-Hop P2P & DTN Store-and-Forward
- **Setup:** Linear topology ($A \to B \to C \to D$) and mesh star topology with intermittent physical separation.
- **Target Metrics:**
  - Packet delivery ratio > 98% with DTN outbox active.
  - Discovery latency via BLE < 4.0s.
  - Transmission overhead < 20% metadata relative to CRDT payload bytes.

#### Experiment 3: Nostr Global Gateway Bridging
- **Setup:** Disconnected cluster of 4 nodes with 1 node receiving intermittent LTE connectivity (30 seconds every 10 minutes).
- **Target Metrics:**
  - Latency from local generation to remote hospital ingestion < 800ms upon gateway connection.
  - Zero duplicate bundle applications across multiple redundant gateways.

#### Experiment 4: Edge AI Speech Extraction & Schema Accuracy
- **Setup:** 100 recorded emergency audio prompts spoken with background noise (sirens, rotor wash, shouting).
- **Target Metrics:**
  - Word Error Rate (WER) on Whisper-Tiny < 12% on clinical terminology.
  - JSON schema conformance rate: 100% (invalid extractions rejected, 0% corruption).
  - SLM inference latency < 2.0s on standard mobile hardware.

#### Experiment 5: HCI High-Stress Ergonomic Testing
- **Setup:** 20 test participants operating under simulated stress (heavy work gloves, vibration table, bright sunlight, 60 bpm auditory pacer).
- **Comparison:** PeerScribe vs. Conventional 15-field Digital Medical Web Form.
- **Target Metrics:**
  - Time-to-Triage reduction > 65% (target < 8 seconds per patient).
  - Tapping error rate < 3% with gloved hands.
  - 100% detection rate of Semantic Divergence alerts.

#### Experiment 6: Probabilistic Search Model Validation
- **Setup:** 50 simulated missing-person paths generated from actual search-and-rescue terrain GPS traces.
- **Comparison:** PeerScribe Particle Filter vs. Naive Static Radial Distance Model.
- **Target Metrics:**
  - 90% Probability Mass Area reduction of > 50% compared to circular radius, saving critical search hours.
  - Contraction of search area within 2 seconds of ingesting an opportunistic peer sighting.

#### Experiment 7: Battery Duty-Cycling Profile
- **Setup:** Continuous monitoring on standard 4,000 mAh smartphone battery over 24 hours.
- **Target Metrics:**
  - Dormant Mode: < 0.3% battery drain per hour.
  - Field Mode: < 2.5% battery drain per hour.
  - Emergency Mode: < 8.0% battery drain per hour (allowing > 12 hours continuous tactical field operation).

---

## 11. Multi-Version Release Strategy & CI/CD Pipeline Architecture

To support field deployments across disparate hardware (rugged Android tablets, frontline responder iPhones, Windows field dispatch stations, Linux mobile gateways), PeerScribe implements a multi-version release strategy and verifiable CI/CD pipeline directly modeled on the standards established by BitChat.

```
+----------------------------------------------------------------------------------------------------+
|                             PEERSCRIBE MULTI-VERSION CI/CD PIPELINE                                |
+-----------------------------+-------------------------------+--------------------------------------+
| Release Channel             | Trigger & Frequency           | Target Output & Distribution         |
+-----------------------------+-------------------------------+--------------------------------------+
| 1. Nightly / Alpha          | Every PR / Push to `main`     | Automated test suite, lint, coverage |
|                             |                               | Containerized development builds     |
| 2. Tactical Field Beta      | Push to `beta` branch /       | Disaster simulation exercise builds  |
|                             | Tag `vX.Y.Z-beta.N`           | Signed APK, Portable Desktop Exe     |
| 3. Stable / Clinical LTS    | Tagged release `vX.Y.Z`       | Clinically validated production      |
|                             |                               | Full Source Manifest + Binaries      |
+-----------------------------+-------------------------------+--------------------------------------+
```

### 11.1 Multi-Target Build Matrix
The pipeline automates builds across four distinct deployment targets:

1. **Android (Frontline Handhelds):**
   - Minimum SDK: API 26 (Android 8.0 Oreo - covers >96% of active global devices).
   - Target SDK: API 35 (Android 15).
   - Containerized deterministic Docker build (`ghcr.io/peerscribe/android-builder`) ensuring reproducible Gradle compilations matching `permissionlesstech/bitchat-android`.
2. **iOS / macOS (Field Responders & Tactical iPad Command):**
   - Target: iOS 16.0+, macOS 13.0+ (Universal binary for Intel & Apple Silicon).
   - Headless `xcodebuild` runner with code signing via GitHub secrets.
3. **Desktop (Windows x64 / Linux x64):**
   - Portable standalone binaries and installers (Windows `.msi`, Linux `.AppImage`).
   - Optimized for base camp dispatch stations, satellite comms tents, and ambulance dash systems.
4. **Offline Progressive Web App (PWA / WebBluetooth):**
   - Static asset compilation running in modern Chromium browsers.
   - Leverages WebBluetooth APIs and WebAssembly Automerge/Whisper runtimes for instant zero-install tactical coordination.

### 11.2 BitChat-Standard Cryptographic Source Manifest & Verifiable Builds
In disaster zones and hostile environments, supply-chain attacks or malicious binary modifications could result in intercepted medical information or false coordinates. 

Borrowing BitChat’s cryptographic source manifest protocol, every release workflow automatically computes and publishes a `SOURCE_MANIFEST.json` and `SHA256SUMS.asc`:

```json
{
  "project": "PeerScribe",
  "version": "v1.0.0",
  "release_tag": "v1.0.0",
  "git_commit": "7a3f8190dbe248677c784712e091565538e1b934",
  "git_tree": "3e9b1c97a5b3f...",
  "build_timestamp": "2026-10-19T04:45:00Z",
  "builder": "GitHub Actions (ubuntu-24.04)",
  "source_files": [
    {
      "path": "packages/core-engine/src/clinical/protocols/start.ts",
      "sha256": "4b92ec179093bf7c320d4f590453d86504a919e83ecf2bb8b6a37880d8591ef1"
    },
    {
      "path": "packages/core-engine/src/crdt/automerge.ts",
      "sha256": "a712f5e3bc9b0106cd4d6731e84738596645391d848149e62e1858a8a4b08709"
    }
  ],
  "artifact_checksums": {
    "PeerScribe-v1.0.0-android.apk": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "PeerScribe-v1.0.0-desktop-win-x64.zip": "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
    "PeerScribe-v1.0.0-desktop-linux.AppImage": "3457b9ac61f95304bc2e8251e604f7c13ca78fc58cf3558d1979b009e51c8a16"
  },
  "manifest_signature": "schnorr_signature_hex_over_manifest_hash"
}
```

### 11.3 Automated Pipeline Workflows
The CI/CD system is organized into four purpose-built GitHub Actions workflows located in `.github/workflows/`:

1. **`ci.yml` (Continuous Integration Matrix):**
   - Triggers on all pull requests and pushes to `main` and `beta`.
   - Matrix runs across Ubuntu, macOS, and Windows.
   - Executes linting, TypeScript strict type checks, unit tests, and code coverage analysis.
2. **`release.yml` (Multi-Version Release Pipeline):**
   - Triggers on tag pushes matching `v*` (e.g., `v1.0.0`, `v1.0.0-beta.1`).
   - Compiles cross-platform artifacts (Android APK, Windows ZIP, Linux AppImage, PWA bundle).
   - Generates release notes, attaches binaries, and publishes GitHub releases.
3. **`source-manifest.yml` (Cryptographic Build Integrity):**
   - Automatically executed prior to releasing assets.
   - Walks all tracked Git repository files, generates deterministic SHA-256 hashes, and signs the manifest.
4. **`research-benchmarks.yml` (Automated Research Regression Suite):**
   - Scheduled nightly or on release candidate tags.
   - Runs automated simulations for the 7 empirical research experiments (CRDT partition convergence, DTN multi-hop delivery, SLM schema validity, particle filter search area).
   - Fails the build if any regression drops below the target benchmark thresholds.

---

## 12. Target Directory & Monorepo Architecture

```
PeerScribe/
├── .github/                      # CI/CD workflows & linters
├── docs/                         # Architecture diagrams & protocol specifications
├── packages/
│   ├── core-engine/              # Shared, pure platform-agnostic TypeScript logic
│   │   ├── src/
│   │   │   ├── clinical/         # START triage, rules, semantic divergence analyzer
│   │   │   │   ├── protocols/    # Versioned triage engines (start.ts, jumpstart.ts)
│   │   │   │   ├── divergence.ts # Clinical semantic divergence analyzer
│   │   │   │   └── ledger.ts     # Medication administration ledger
│   │   │   ├── crdt/             # Distributed state management
│   │   │   │   ├── schema.ts     # Patient & Operation CRDT document definitions
│   │   │   │   ├── automerge.ts  # Automerge document lifecycle & delta compression
│   │   │   │   └── vectors.ts    # Causal vector clock calculations
│   │   │   ├── storage/          # Local persistence
│   │   │   │   ├── db.ts         # SQLite WAL connection manager
│   │   │   │   ├── migrations/   # Relational schema migrations
│   │   │   │   └── vault.ts      # SQLCipher / AES-GCM personal profile vault
│   │   │   ├── identity/         # Ephemeral identity generator & keys
│   │   │   │   ├── phonetic.ts   # Phonetic tri-word generator (RED-FALCON-04)
│   │   │   │   ├── visual_hash.ts# Identicon generator
│   │   │   │   └── crypto.ts     # Device Schnorr / secp256k1 key management
│   │   │   ├── network/          # Local mesh & DTN store-and-forward
│   │   │   │   ├── ble_types.ts  # BLE GATT & advertising interfaces
│   │   │   │   ├── dtn_queue.ts  # Outbox store-and-forward persistence
│   │   │   │   └── sync_wire.ts  # Universal binary bundle framing
│   │   │   ├── nostr/            # Global gateway relay transport
│   │   │   │   ├── client.ts     # WebSocket Nostr client
│   │   │   │   ├── nip44.ts      # End-to-end encrypted event payload
│   │   │   │   └── gateway.ts    # Ephemeral gateway promotion logic
│   │   │   ├── location/         # Probabilistic search & tracking
│   │   │   │   ├── particle.ts   # Sequential Monte Carlo particle filter
│   │   │   │   ├── terrain.ts    # Cost grid & barrier collision
│   │   │   │   └── heatmap.ts    # Kernel density estimation calculator
│   │   │   └── ai/               # On-device Edge AI pipelines
│   │   │       ├── asr.ts        # Whisper ASR integration
│   │   │       ├── slm.ts        # Small quantized language model driver
│   │   │       └── validator.ts  # Strict schema enforcement
│   │   └── package.json
│   │
│   ├── platform-adapters/        # Native hardware adapters (Mobile / Desktop)
│   │   ├── src/
│   │   │   ├── ble_adapter.ts    # WebBluetooth / React Native BLE / Noble adapter
│   │   │   ├── gnss_adapter.ts   # Geolocation & Barometer adapter
│   │   │   └── audio_adapter.ts  # PCM 16kHz microphone stream adapter
│   │   └── package.json
│   │
│   └── ui-app/                   # Cross-Platform High-Stress UI Application
│       ├── src/
│       │   ├── components/       # Touch-target optimized components
│       │   │   ├── TriageButton.tsx
│       │   │   ├── DivergenceAlert.tsx
│       │   │   ├── PushToTalkBar.tsx
│       │   │   ├── PatientCard.tsx
│       │   │   └── SearchMap.tsx
│       │   ├── styles/           # High-contrast tactical design tokens
│       │   │   ├── tokens.css
│       │   │   └── high_contrast.css
│       │   ├── views/            # Screen views
│       │   │   ├── OperationDashboard.tsx
│       │   │   ├── TriageActionView.tsx
│       │   │   ├── SearchHeatmapView.tsx
│       │   │   └── PersonalProfileVault.tsx
│       │   ├── App.tsx
│       │   └── main.tsx
│       └── package.json
│
├── tests/
│   ├── benchmarks/               # Formal research evaluation test suite (Exps 1-7)
│   ├── unit/                     # Unit tests for core algorithms
│   └── integration/              # Multi-node network mesh simulations
├── implementation.md             # This master implementation plan
└── package.json
```

---

## 13. Risk Matrix & Engineering Mitigation Strategies

| Risk Description | Probability | Impact | Engineering Mitigation Strategy |
| :--- | :--- | :--- | :--- |
| **Mesh Broadcast Storm** (unbounded loop of duplicate bundles exhausting bandwidth) | High | Critical | Strict Hop Limit (15 max) + 128-byte Bloom filter exchange during handshake + bundle dedup cache in SQLite. |
| **SLM Hallucination** (fabricating injuries or invalid drug dosages) | Medium | Fatal | Strict separation: SLM parses JSON facts only. Triage is 100% computed by deterministic code. Model is forbidden from prescribing. |
| **Battery Depletion** during extended field operations | High | Severe | Dynamic 3-mode power controller (Section 2). Geofenced and periodic GNSS; aggressive duty-cycling of radios. |
| **Radio Fragmentation Across OSs** (iOS BLE background limitations vs Android) | High | Major | Dual discovery mechanism: BLE for beacons/advertisement + local Wi-Fi hotspot/mDNS fallback for data synchronization. |
| **Relay Snooping on Patient Data** | Medium | Severe | Zero-Knowledge Relays: NIP-44 end-to-end encryption with operation-scoped ephemeral keys; raw audio never leaves local node. |
| **Clinical Overwrite via LWW** | Medium | Critical | Multi-value CRDT state + `SemanticSafetyAnalyzer` detecting concurrent clinical disagreements and enforcing human sign-off. |

---

## 14. Immediate Next Steps & Milestone Execution

1. **Review and Lock Implementation Blueprint:** Verify architectural alignment with all project stakeholders.
2. **Phase 1 Initiation:** Scaffold the core repository, initialize SQLite schema, and construct the Automerge CRDT state replication harness.
3. **Continuous Benchmarking & CI/CD Pipeline:** Bind all development directly to the seven empirical evaluation metrics defined in Section 10 and maintain multi-version build integrity as specified in Section 11.
