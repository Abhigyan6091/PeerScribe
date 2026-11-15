import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Typed exception thrown when secure key storage operations fail.
class VaultKeyStorageException implements Exception {
  final String message;
  final Object? cause;
  const VaultKeyStorageException(this.message, [this.cause]);

  @override
  String toString() => 'VaultKeyStorageException: $message${cause != null ? ' (cause: $cause)' : ''}';
}

/// Abstract Key Storage interface for the Personal Health Profile Vault.
/// Ensures standard per-installation key management without hardcoding keys or passphrases.
abstract class VaultKeyStorage {
  Future<List<int>> getOrCreateMasterKey();
  Future<void> clearMasterKey();
}

/// Production Android Keystore-backed implementation using FlutterSecureStorage.
class PlatformSecureVaultKeyStorage implements VaultKeyStorage {
  static const String _keyAlias = 'peerscribe_vault_master_key_v1';
  final FlutterSecureStorage _storage;

  PlatformSecureVaultKeyStorage({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  @override
  Future<List<int>> getOrCreateMasterKey() async {
    String? existingBase64;
    try {
      existingBase64 = await _storage.read(key: _keyAlias);
    } catch (e) {
      throw VaultKeyStorageException('Failed to read master key from secure storage', e);
    }

    if (existingBase64 != null && existingBase64.isNotEmpty) {
      try {
        final decoded = base64.decode(existingBase64);
        if (decoded.length == 32) {
          return decoded;
        }
        throw const FormatException('Persisted master key length is not 32 bytes');
      } catch (e) {
        throw VaultKeyStorageException('Corrupted master key in secure storage', e);
      }
    }

    // Generate random 256-bit (32-byte) key using CSPRNG
    final random = Random.secure();
    final newKey = Uint8List(32);
    for (int i = 0; i < 32; i++) {
      newKey[i] = random.nextInt(256);
    }

    try {
      await _storage.write(key: _keyAlias, value: base64.encode(newKey));
    } catch (e) {
      throw VaultKeyStorageException('Failed to persist newly generated master key to secure storage', e);
    }

    // Verify key persistence
    try {
      final verified = await _storage.read(key: _keyAlias);
      if (verified == null || verified != base64.encode(newKey)) {
        throw const VaultKeyStorageException('Secure storage persistence verification failed after write');
      }
    } catch (e) {
      if (e is VaultKeyStorageException) rethrow;
      throw VaultKeyStorageException('Verification read failed for secure storage key', e);
    }

    return newKey;
  }

  @override
  Future<void> clearMasterKey() async {
    try {
      await _storage.delete(key: _keyAlias);
    } catch (e) {
      throw VaultKeyStorageException('Failed to clear master key from secure storage', e);
    }
  }
}

/// In-Memory Key Storage for isolated unit and integration testing.
class InMemoryVaultKeyStorage implements VaultKeyStorage {
  List<int>? _key;

  InMemoryVaultKeyStorage([List<int>? initialKey]) {
    if (initialKey != null) {
      _key = List<int>.from(initialKey);
    }
  }

  @override
  Future<List<int>> getOrCreateMasterKey() async {
    if (_key != null) return _key!;
    final random = Random.secure();
    final newKey = Uint8List(32);
    for (int i = 0; i < 32; i++) {
      newKey[i] = random.nextInt(256);
    }
    _key = newKey;
    return _key!;
  }

  @override
  Future<void> clearMasterKey() async {
    _key = null;
  }
}

/// File-backed Key Storage for testing restart survival on host/desktop environments.
class FileVaultKeyStorage implements VaultKeyStorage {
  final String filePath;

  FileVaultKeyStorage(this.filePath);

  @override
  Future<List<int>> getOrCreateMasterKey() async {
    final file = File(filePath);
    if (await file.exists()) {
      final contents = await file.readAsBytes();
      if (contents.length == 32) {
        return contents;
      }
    }

    final random = Random.secure();
    final newKey = Uint8List(32);
    for (int i = 0; i < 32; i++) {
      newKey[i] = random.nextInt(256);
    }

    await file.parent.create(recursive: true);
    await file.writeAsBytes(newKey, flush: true);
    return newKey;
  }

  @override
  Future<void> clearMasterKey() async {
    final file = File(filePath);
    if (await file.exists()) {
      await file.delete();
    }
  }
}
