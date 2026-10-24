# PeerScribe: Release Management & Distribution Strategy

This document details the release process, versioning conventions, build artifacts, code-signing guidelines, and GitHub Actions release workflows for PeerScribe.

---

## 1. Release Channels & Semantic Versioning

PeerScribe adheres to [Semantic Versioning 2.0.0](https://semver.org/) (`vMAJOR.MINOR.PATCH[-PRERELEASE]`):

| Channel | Tag Pattern | Target Audience | Trigger & Distribution |
| :--- | :--- | :--- | :--- |
| **Nightly / Alpha** | Push to `main` | Developers, internal simulation | Automated CI build; downloadable GitHub Actions artifacts. |
| **Tactical Field Beta** | `vX.Y.Z-beta.N` | Field drill responders, SAR teams | Manual `workflow_dispatch` or beta tag; tagged GitHub Pre-Release. |
| **Stable Clinical LTS** | `vX.Y.Z` | Production disaster deployments | Formal tag on `main`; signed GitHub Release with source manifest. |

---

## 2. Release Artifacts

Every official release publishes verified, reproducible build packages:

| Platform | Target Artifact | Format | Description |
| :--- | :--- | :--- | :--- |
| **Windows Desktop** | `PeerScribe-Setup-vX.Y.Z.exe` | NSIS Executable | Standard Windows desktop installer with desktop shortcut and uninstaller. |
| **Windows Desktop** | `PeerScribe-Portable-vX.Y.Z.zip` | Portable Zip | Standalone portable executable requiring zero administrator privileges. |
| **Android Mobile** | `PeerScribe-vX.Y.Z.apk` | Android APK | Sideloadable Android application package (API 24+ / Android 7.0 to 15). |
| **Integrity Hashes** | `SHA256SUMS.txt` | Text / Checksums | Cryptographic SHA-256 hashes for all published binaries. |
| **Source Manifest** | `SOURCE_MANIFEST.json` | JSON | BitChat-standard verifiable build manifest detailing all source file hashes. |

---

## 3. Code Signing & Security Notice

### 3.1 Windows Desktop Code Signing
- **Test / Beta Builds:** Distributed unsigned. Windows SmartScreen may show an initial unrecognized publisher prompt (*"Windows protected your PC"*). Users click *"More info"* → *"Run anyway"*.
- **Production Releases:** Digitally signed using an EV Code Signing Certificate configured in GitHub Secrets (`WINDOWS_SIGNING_CERT_BASE64`, `WINDOWS_SIGNING_PASSWORD`).

### 3.2 Android APK Signing
- **CI / Test Builds:** Signed with the standard Android debug keystore.
- **Production Releases:** Signed with the official release keystore configured via GitHub Secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`).
- **In-Tree Policy:** Never commit `.jks`, `.keystore`, `.pfx`, or private keys directly to git.

---

## 4. GitHub Actions Release Workflow Execution

### 4.1 Automated Tagged Release
1. Ensure all features and tests pass on `main`.
2. Tag the release commit:
   ```bash
   git tag -a v1.0.0 -m "PeerScribe Release v1.0.0: Offline Mesh Clinical Coordination"
   git push origin v1.0.0
   ```
3. The `.github/workflows/release.yml` workflow automatically:
   - Validates branch integrity and SemVer format.
   - Executes all mandatory test suites across the matrix.
   - Compiles the Windows Electron installer & portable zip.
   - Compiles the Android Flutter APK.
   - Generates `SHA256SUMS.txt` and `SOURCE_MANIFEST.json`.
   - Publishes the GitHub Release with attached downloadable assets.

### 4.2 Manual Workflow Dispatch
1. Navigate to **Actions** → **Multi-Version Release Pipeline**.
2. Click **Run workflow**.
3. Enter the target version (e.g. `1.0.0` or `1.0.0-beta.1`).
4. Select the release channel and click **Run workflow**.
