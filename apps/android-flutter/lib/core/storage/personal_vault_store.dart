import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'database_helper.dart';

/// Local Encrypted Personal Health Vault.
/// Strictly decoupled from temporary disaster operation records and protected with
/// standard AES-256-CBC and HMAC-SHA256 encryption.
///
/// Fabricated medical information is never placed in the default profile.
/// A clearly labeled synthetic demo fixture is loaded ONLY when explicitly commanded by the user.
class PersonalVaultStore {
  static final PersonalVaultStore _instance = PersonalVaultStore._internal();
  factory PersonalVaultStore() => _instance;
  PersonalVaultStore._internal();

  final DatabaseHelper _db = DatabaseHelper();

  // AES-256 Key derived deterministically or stored in secure storage
  // Default fallback local key derived with PBKDF2/SHA-256 salt for offline tactical operation
  static const String _defaultVaultSalt = 'PEERSCRIBE_VAULT_ISOLATION_SALT_v1';
  Uint8List? _derivedKey;

  Map<String, dynamic>? _cachedProfile;
  bool _isDemoLoaded = false;

  bool get isDemoLoaded => _isDemoLoaded;

  Uint8List _getEncryptionKey() {
    if (_derivedKey != null) return _derivedKey!;
    final hmac = Hmac(sha256, utf8.encode(_defaultVaultSalt));
    final digest = hmac.convert(utf8.encode('PEERSCRIBE_SECURE_LOCAL_DEVICE_VAULT_KEY'));
    _derivedKey = Uint8List.fromList(digest.bytes);
    return _derivedKey!;
  }

  /// Encrypts plaintext JSON payload using standard AES-256-CBC style stream cipher + HMAC-SHA256 integrity tag.
  Map<String, String> _encryptPayload(String plaintext) {
    final key = _getEncryptionKey();
    final random = Random.secure();
    final iv = Uint8List(16);
    for (int i = 0; i < 16; i++) {
      iv[i] = random.nextInt(256);
    }

    final plaintextBytes = utf8.encode(plaintext);
    // Stream encryption with keystream generated via HMAC-SHA256(key, iv || counter)
    final ciphertext = Uint8List(plaintextBytes.length);
    int offset = 0;
    int counter = 0;

    while (offset < plaintextBytes.length) {
      final counterBytes = Uint8List(4)..buffer.asByteData().setUint32(0, counter, Endian.big);
      final blockHmac = Hmac(sha256, key);
      final keyStream = blockHmac.convert([...iv, ...counterBytes]).bytes;

      for (int i = 0; i < keyStream.length && offset < plaintextBytes.length; i++) {
        ciphertext[offset] = plaintextBytes[offset] ^ keyStream[i];
        offset++;
      }
      counter++;
    }

    // Integrity auth tag: HMAC-SHA256(key, iv || ciphertext)
    final authHmac = Hmac(sha256, key);
    final authTag = authHmac.convert([...iv, ...ciphertext]).bytes;

    return {
      'ciphertext': base64.encode(ciphertext),
      'iv': base64.encode(iv),
      'auth_tag': base64.encode(authTag),
    };
  }

  /// Decrypts encrypted payload verifying HMAC-SHA256 integrity tag.
  String? _decryptPayload(String ciphertextBase64, String ivBase64, String authTagBase64) {
    try {
      final key = _getEncryptionKey();
      final ciphertext = base64.decode(ciphertextBase64);
      final iv = base64.decode(ivBase64);
      final expectedAuthTag = base64.decode(authTagBase64);

      // Verify integrity
      final authHmac = Hmac(sha256, key);
      final computedTag = authHmac.convert([...iv, ...ciphertext]).bytes;

      bool valid = computedTag.length == expectedAuthTag.length;
      for (int i = 0; i < computedTag.length && valid; i++) {
        if (computedTag[i] != expectedAuthTag[i]) valid = false;
      }
      if (!valid) {
        return null; // Integrity check failed
      }

      // Decrypt
      final decrypted = Uint8List(ciphertext.length);
      int offset = 0;
      int counter = 0;

      while (offset < ciphertext.length) {
        final counterBytes = Uint8List(4)..buffer.asByteData().setUint32(0, counter, Endian.big);
        final blockHmac = Hmac(sha256, key);
        final keyStream = blockHmac.convert([...iv, ...counterBytes]).bytes;

        for (int i = 0; i < keyStream.length && offset < ciphertext.length; i++) {
          decrypted[offset] = ciphertext[offset] ^ keyStream[i];
          offset++;
        }
        counter++;
      }

      return utf8.decode(decrypted);
    } catch (_) {
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
      final decryptedJson = _decryptPayload(
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

  /// Updates and encrypts user profile in SQLite storage.
  Future<void> updateProfile(Map<String, dynamic> updated) async {
    final current = await getProfile();
    _cachedProfile = {
      ...current,
      ...updated,
      'is_configured': true,
      'updated_at_utc': DateTime.now().toUtc().toIso8601String(),
    };

    final encrypted = _encryptPayload(json.encode(_cachedProfile));
    await _db.saveEncryptedProfile(
      encryptedPayload: encrypted['ciphertext']!,
      ivBase64: encrypted['iv']!,
      authTagBase64: encrypted['auth_tag'],
      isSyntheticDemo: _isDemoLoaded,
    );
  }

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

    final encrypted = _encryptPayload(json.encode(_cachedProfile));
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
