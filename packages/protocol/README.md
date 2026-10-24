# @peerscribe/protocol

Language-neutral canonical event schemas, wire bundle contracts, golden test fixtures, and deterministic state projection algorithms for PeerScribe decentralized tactical mesh nodes.

---

## 1. Overview

PeerScribe coordinates clinical operations in austere, disconnected environments (disaster response, mass-casualty incidents, search & rescue). Nodes running on **Windows (Electron)** and **Android (Flutter)** interact as symmetric peers without requiring a central database or permanent server.

To guarantee zero silent overwrites of safety-critical data, all operations and patient records are modeled as an **append-only log of immutable, signed operational events**.

---

## 2. Directory Structure

```text
packages/protocol/
├── schemas/
│   ├── event.schema.json         # Formal JSON Schema (Draft-07) for canonical events
│   ├── sync_bundle.schema.json   # Wire format schema for P2P bundle exchanges
│   └── patient.schema.json       # Projected clinical patient state schema
├── fixtures/
│   └── sample_events.json        # Golden fixtures consumed by TS and Dart test suites
├── src/
│   └── index.ts                  # TypeScript types, schema validators, state projection
├── tests/
│   └── protocol.test.ts          # Automated validation and projection unit tests
├── package.json
└── README.md
```

---

## 3. Canonical Event Specification

Every operational mutation is represented as a `PeerScribeEvent`:

```json
{
  "schema_version": 1,
  "event_id": "evt_tri_004_immediate_red",
  "operation_id": "OP_2026_KATHMANDU_QUAKE",
  "entity_id": "pt_uuid_001",
  "event_type": "TRIAGE_STATUS_CHANGED",
  "actor_id": "node_desktop_alpha",
  "actor_sequence": 3,
  "lamport_timestamp": 4,
  "causal_context": {
    "node_desktop_alpha": 3,
    "node_mobile_bravo": 1
  },
  "occurred_at_utc": "2026-10-24T15:03:00.000Z",
  "payload": {
    "triage_category": "RED",
    "protocol": "START_ADULT_v1.0",
    "rationale": "Respiratory compromise: rate is 34/min with absent radial pulse"
  }
}
```

### Event Types
- `PATIENT_CREATED`: Ephemeral tag allocation and initial sector assignment.
- `OBSERVATION_RECORDED`: Responders' freeform tactical notes or speech-to-text extractions.
- `VITALS_RECORDED`: Respiration rate, pulse presence, mental status, CRT, blood pressure.
- `INJURY_RECORDED`: Anatomical location, fracture classification, tourniquet applications.
- `ALLERGY_RECORDED`: Critical allergen disclosures (Penicillin, Latex, NSAIDs).
- `TRIAGE_STATUS_CHANGED`: START/JumpSTART triage status classification (`RED`, `YELLOW`, `GREEN`, `BLACK`).
- `MEDICATION_RECORDED`: Administered drugs, dosages, routes, and authorized clinician signatures.
- `LOCATION_OBSERVED`: GPS coordinate sighting with circular error probable (CEP).
- `SOS_CREATED`: Urgent evacuation or tactical assistance broadcast.
- `VAULT_SNAPSHOT_ATTACHED`: Explicit emergency disclosure of locally stored personal health profile.
- `DIVERGENCE_ACKNOWLEDGED`: Semantic divergence detected (e.g. concurrent RED vs GREEN conflict).
- `DIVERGENCE_RESOLVED`: Authorized clinician signoff resolving clinical divergence.

---

## 4. Deterministic State Projection

Replicas order events deterministically:
1. `lamport_timestamp` ASC (causal order)
2. `actor_id` ASC (lexicographical tie-breaker)
3. `event_id` ASC (unique tie-breaker)

All field additions are additive (e.g. vitals history, injury lists, medication administration records, and known allergies cannot be deleted by subsequent writes).

---

## 5. Running Tests

```bash
node --experimental-strip-types --test packages/protocol/tests/protocol.test.ts
```
