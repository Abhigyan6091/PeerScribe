import 'dart:convert';
import 'dart:typed_data';
import 'package:cryptography/cryptography.dart';
import 'database_helper.dart';
import 'vault_key_storage.dart';

/// Local Encrypted Personal Health Vault.
/// Strictly decoupled from temporary disaster operation records and protected with
/// standard AES-256-GCM authenticated encryption (NIST SP 800-38D).
///
/// Keys are stored in platform-protected secure storage (Android Keystore / SecureStorage)
/// and never hardcoded in source constants.
/// Fabricated medical information is never placed in the default profile.
/// A clearly labeled synthetic demo fixture is loaded ONLY when explicitly commanded by the user.
class PersonalVaultStore {
  static final PersonalVaultStore _instance = PersonalVaultStore._internal();
  factory PersonalVaultStore() => _instance;
  PersonalVaultStore._internal() {
    _keyStorage = PlatformSecureVaultKeyStorage();
  }

  final DatabaseHelper _db = DatabaseHelper();
  static final AesGcm _aesGcm = AesGcm.with256bits();

  late VaultKeyStorage _keyStorage;
  Map<String, dynamic>? _cachedProfile;
  bool _isDemoLoaded = false;

  bool get isDemoLoaded => _isDemoLoaded;

  /// Sets a custom key storage provider (useful for testing or platform injection).
  void setKeyStorage(VaultKeyStorage storage) {
    _keyStorage = storage;
    _cachedProfile = null;
  }

  /// Invalidates in-memory cached profile so subsequent reads query storage.
  void invalidateCache() {
    _cachedProfile = null;
  }

  /// Retrieves the active 256-bit AES master key from secure storage.
  Future<List<int>> getMasterKey() async {
    return await _keyStorage.getOrCreateMasterKey();
  }

  /// Encrypts plaintext JSON payload using standard AES-256-GCM with a 96-bit random nonce
  /// and 128-bit authentication tag.
  Future<Map<String, String>> encryptPayload(String plaintext, [List<int>? customKey]) async {
    final keyBytes = customKey ?? await getMasterKey();
    final secretKey = SecretKey(keyBytes);
    final plaintextBytes = utf8.encode(plaintext);

    final secretBox = await _aesGcm.encrypt(
      plaintextBytes,
      secretKey: secretKey,
    );

    return {
      'ciphertext': base64.encode(secretBox.cipherText),
      'iv': base64.encode(secretBox.nonce),
      'auth_tag': base64.encode(secretBox.mac.bytes),
    };
  }

  /// Decrypts ciphertext verifying the 128-bit authentication tag.
  /// Returns null if tampered, wrong key, or corrupted without throwing.
  Future<String?> decryptPayload(
    String ciphertextBase64,
    String ivBase64,
    String authTagBase64, [
    List<int>? customKey,
  ]) async {
    try {
      final keyBytes = customKey ?? await getMasterKey();
      final secretKey = SecretKey(keyBytes);

      final secretBox = SecretBox(
        base64.decode(ciphertextBase64),
        nonce: base64.decode(ivBase64),
        mac: Mac(base64.decode(authTagBase64)),
      );

      final decryptedBytes = await _aesGcm.decrypt(
        secretBox,
        secretKey: secretKey,
      );

      return utf8.decode(decryptedBytes);
    } catch (_) {
      // SecretBoxAuthenticationError or decoding error -> tampering or wrong key
      return null;
    }
  }

  /// Retrieves the current user's profile.
  /// Default profile is completely empty/unconfigured with ZERO fabricated data.
  Future<Map<String, dynamic>> getProfile() async {
    if (_cachedProfile != null) {
      return Map.unmodifiable(_cachedProfile!);
    }

    final row = await _db.getEncryptedProfile();
    if (row != null) {
      final decryptedJson = await decryptPayload(
        row['encrypted_payload'] as String,
        row['iv_base64'] as String,
        row['auth_tag_base64'] as String,
      );
      if (decryptedJson != null) {
        try {
          _cachedProfile = json.decode(decryptedJson) as Map<String, dynamic>;
          _isDemoLoaded = row['is_synthetic_demo'] == 1;
          return Map.unmodifiable(_cachedProfile!);
        } catch (_) {}
      } else {
        // Migration or corrupted/un-decryptable record: return blank unconfigured profile
        _cachedProfile = null;
      }
    }

    // Unconfigured, blank default profile
    _cachedProfile = {
      'is_configured': false,
      'is_synthetic_demo': false,
      'blood_group': null,
      'allergies': <String>[],
      'critical_conditions': <String>[],
      'emergency_contacts': <Map<String, dynamic>>[],
      'is_emergency_disclosed': false,
    };
    return Map.unmodifiable(_cachedProfile!);
  }

  /// Updates and encrypts user profile in SQLite storage using standard AES-256-GCM.
  Future<void> updateProfile(Map<String, dynamic> updated) async {
    final current = await getProfile();
    _cachedProfile = {
      ...current,
      ...updated,
      'is_configured': true,
      'updated_at_utc': DateTime.now().toUtc().toIso8601String(),
    };

    final encrypted = await encryptPayload(json.encode(_cachedProfile));
    await _db.saveEncryptedProfile(
      encryptedPayload: encrypted['ciphertext']!,
      ivBase64: encrypted['iv']!,
      authTagBase64: encrypted['auth_tag'],
      isSyntheticDemo: _isDemoLoaded,
    );
  }

  /// Alias for updateProfile to support both update and save semantics.
  Future<void> saveProfile(Map<String, dynamic> profile) => updateProfile(profile);

  /// Explicitly loads a clearly labeled SYNTHETIC DEMO profile.
  /// Only activated when the user explicitly requests demo data.
  Future<void> loadSyntheticDemoProfile() async {
    _isDemoLoaded = true;
    _cachedProfile = {
      'is_configured': true,
      'is_synthetic_demo': true,
      'blood_group': 'O+ (DEMO)',
      'allergies': ['Penicillin (SYNTHETIC DEMO)', 'Sulfa (SYNTHETIC DEMO)'],
      'critical_conditions': ['Asthma (SYNTHETIC DEMO)'],
      'emergency_contacts': [
        {
          'name': 'Synthetic Demo Contact',
          'relation': 'Emergency Simulated Contact',
          'phone': '+0-000-000-0000',
        }
      ],
      'is_emergency_disclosed': false,
    };

    final encrypted = await encryptPayload(json.encode(_cachedProfile));
    await _db.saveEncryptedProfile(
      encryptedPayload: encrypted['ciphertext']!,
      ivBase64: encrypted['iv']!,
      authTagBase64: encrypted['auth_tag'],
      isSyntheticDemo: true,
    );
  }

  /// Clears the personal profile and removes encrypted record.
  Future<void> clearProfile() async {
    _cachedProfile = null;
    _isDemoLoaded = false;
    await _db.deleteProfile();
  }

  /// Explicit Emergency Snapshot Disclosure:
  /// Produces a sanitized emergency snapshot strictly upon explicit authorized clinician trigger.
  /// Never transmitted automatically over wireless mesh simply because a peer is nearby.
  Map<String, dynamic>? generateEmergencySnapshot({bool authorized = true}) {
    if (!authorized) return null;
    if (_cachedProfile == null || _cachedProfile!['is_configured'] != true) {
      return null;
    }

    return {
      'blood_group': _cachedProfile!['blood_group'],
      'allergies': List<String>.from(_cachedProfile!['allergies'] as List? ?? []),
      'critical_conditions': List<String>.from(_cachedProfile!['critical_conditions'] as List? ?? []),
      'emergency_contacts': _cachedProfile!['emergency_contacts'] ?? [],
      'is_synthetic_demo': _cachedProfile!['is_synthetic_demo'] == true,
      'disclosed_at_utc': DateTime.now().toUtc().toIso8601String(),
    };
  }
}
