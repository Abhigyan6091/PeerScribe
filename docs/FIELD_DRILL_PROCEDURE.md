# PeerScribe — Physical Multi-Device Field Drill Procedure

This document provides the standard operating procedure (SOP) and verification checklist for conducting physical multi-device field drill evaluations of PeerScribe across Android mobile smartphones and Windows laptops in an air-gapped, ad-hoc tactical environment.

---

## 1. Tactical Network & Hardware Architecture

The field drill topology evaluates peer-to-peer data synchronization without reliance on external cloud servers, cellular towers, or internet gateways:

```
                      ┌──────────────────────────────────────┐
                      │    Ad-Hoc Wi-Fi Hotspot / Mesh      │
                      │   (No Internet / Zero Cloud Link)    │
                      └──────────────────┬───────────────────┘
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 │                                               │
                 ▼                                               ▼
     ┌───────────────────────┐                       ┌───────────────────────┐
     │  Android Smartphone   │   Bluetooth BLE 5.0   │    Windows Laptop     │
     │  (Field Responder A)  │◄·····················►│ (Incident Commander)  │
     │  IP: 192.168.43.x     │   P2P Beacon Frames   │   IP: 192.168.43.y    │
     │  Port: 4322           │                       │   Port: 4323 (Sync)   │
     └───────────────────────┘                       │   Port: 4321 (Web UI) │
                                                     └───────────────────────┘
```

### Hardware Requirements
- **Node A (Field Unit):** Physical Android smartphone running Android 10+ with Camera, GPS, Bluetooth Low Energy, and Wi-Fi hardware radios.
- **Node B (Command Unit):** Physical Windows laptop running Windows 10/11 with Wi-Fi and Bluetooth.
- **Local Network Medium:** Portable battery-powered Wi-Fi travel router OR mobile hotspot created directly on either device with **cellular mobile data turned OFF**.

---

## 2. Pre-Drill Software Deployment

1. **Windows Commander Laptop:**
   - Launch `PeerScribe-Windows-Setup-v1.1.1.exe` or run the standalone binary.
   - Open browser at `http://localhost:4321`.
   - Verify that tactical dashboard indicates:
     - Sync Daemon: Active on port `4323`.
     - Zero-PIN Handshake: Enabled (`TACTICAL-FIELD` default field key).
     - Storage Engine: SQLite WAL mode initialized in app data directory.

2. **Android Smartphone:**
   - Install `PeerScribe-Android-v1.1.1.apk`.
   - Grant runtime permissions: Camera, Location (Precise), Record Audio, Bluetooth/Nearby Devices.
   - Open PeerScribe.

---

## 3. Step-by-Step Drill Verification Checklist

### Drill Step 1: Zero-PIN Automated Handshake & LAN Pairing
1. On the Android phone, tap the **SYNC** or **DISCOVER** button in the top navigation bar.
2. Confirm the laptop node appears in the discovered peers list via mDNS / UDP broadcast on ports `5353` and `4325`.
3. Tap **⚡ SYNC NOW**.
4. **Verification Pass Criteria:**
   - Both devices execute the X25519 Diffie-Hellman ephemeral key exchange and RFC 5869 HKDF derivation in the background without prompting for a 6-digit PIN.
   - Subsequent clinical bundles transmit under AES-256-GCM AEAD encryption.
   - The connection banner turns green (`CONNECTED / PAIRED`).

### Drill Step 2: Camera Photo Capture & Binary JPEG Sync
1. On the Android phone, open or intake a casualty (e.g., `RED-PANTHER-44`).
2. Tap the **PHOTO/WOUND** button on the clinical dossier action bar.
3. Choose a trauma preset (e.g., `Femur Fracture` or `Thermal Burn`) or capture a photo using the phone's physical camera.
4. Add a clinical caption (e.g., *"Open compound fracture left lower extremity, bleeding controlled with tourniquet"*).
5. Tap **ATTACH PHOTO TO CASUALTY DOSSIER**.
6. Tap **⚡ SYNC NOW** on the mobile client.
7. Switch to the Windows Laptop Dashboard at `http://localhost:4321`:
   - Open the casualty dossier for `RED-PANTHER-44`.
   - Click the **📷 Photos & Trauma Imagery** tab.
8. **Verification Pass Criteria:**
   - The captured wound JPEG photo renders cleanly on the laptop dashboard.
   - Metadata confirms SHA-256 checksum match, capture timestamp, and accurate file size (10–80 KB).
   - Event is durably stored in the laptop's `immutable_events.jsonl` store.

### Drill Step 3: Hardware GNSS Binding & Automated Duty-Cycling
1. On the Android phone app bar, observe the duty-cycle indicator.
2. Switch mode from **FIELD** to **EMERGENCY**:
   - Verify GPS polling increases to continuous 5-second high precision updates.
3. Switch mode to **DORMANT**:
   - Verify that GPS radio listener unregisters to preserve battery during radio silence.
4. **Verification Pass Criteria:**
   - Current geographic coordinates update dynamically on the mobile radar HUD in FIELD/EMERGENCY modes and freeze gracefully in DORMANT mode.

### Drill Step 4: Live Particle Filter Simulation
1. On the Android phone, navigate to the **Radar / Search Heatmap** view.
2. Observe the 500-particle Monte Carlo swarm updating dynamically every second.
3. Note the 50% and 90% confidence search radius rings.
4. Tap **RECORD OPPORTUNISTIC PEER SIGHTING** or supply a peer coordinate fix.
5. **Verification Pass Criteria:**
   - The Bayesian particle filter recalculates particle likelihoods and resamples the swarm.
   - The 90% search radius contracts by at least **20%–35%**, and the HUD reflects the contraction percentage.

### Drill Step 5: On-Device Quantized Whisper Neural Model
1. On the casualty intake screen, tap the **VOICE/INTAKE** button.
2. Select or dictate a tactical emergency casualty observation:
   *"Adult casualty, respiration rate 32 breaths per minute, weak radial pulse, compound femur fracture, altered mental status."*
3. Tap **TRANSCRIBE**.
4. **Verification Pass Criteria:**
   - Speech is decoded 100% locally on-device without cloud connectivity.
   - START triage engine automatically evaluates the observation to **RED (Immediate)**.
   - Casualty state updates immediately in SQLite WAL.

---

## 4. Automated Verification Baseline

All 5 core capabilities tested above are accompanied by automated regression test suites executed in CI and monorepo test commands:
- Monorepo Suite: `npm test`
- Multi-Device Field Drill Simulation: `npm run test:drill`
- Desktop Persistence & Zero-PIN Handshake: `npm run test:electron`
- Mobile Hardware Services & Particle Filter: `flutter test test/hardware_services_test.dart`
