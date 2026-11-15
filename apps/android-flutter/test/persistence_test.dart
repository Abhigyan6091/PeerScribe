import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:peerscribe_mobile/core/storage/database_helper.dart';
import 'package:peerscribe_mobile/core/storage/personal_vault_store.dart';
import 'package:peerscribe_mobile/core/storage/vault_key_storage.dart';
import 'package:peerscribe_mobile/core/protocol/event_model.dart';

void main() {
  // Initialize sqflite FFI for local host and CI execution
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;

  late Directory tempDir;
  late String dbPath;
  late DatabaseHelper dbHelper;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('peerscribe_sqlite_test_');
    dbPath = '${tempDir.path}${Platform.pathSeparator}test_tactical.db';
    dbHelper = DatabaseHelper();
    dbHelper.setDatabasePath(dbPath);
    await dbHelper.initDatabase();
  });

  tearDown(() async {
    await dbHelper.close();
    if (tempDir.existsSync()) {
      try {
        tempDir.deleteSync(recursive: true);
      } catch (_) {}
    }
  });

  group('P0: Android Durable SQLite Persistence Tests', () {
    test('1 & 2: create an event and persist it durably to SQLite', () async {
      final event = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_test_persistence_001',
        operationId: 'OP_TEST_DURABILITY',
        entityId: 'pt_test_001',
        eventType: 'PATIENT_CREATED',
        actorId: 'node_test_medic',
        actorSequence: 1,
        lamportTimestamp: 1,
        occurredAtUtc: '2026-10-25T12:00:00.000Z',
        payload: {
          'ephemeral_id': 'RED-HAWK-99',
          'sector_geohash': 'u15ek200',
        },
      );

      final inserted = await dbHelper.insertEvent(event);
      expect(inserted, isTrue);

      final events = await dbHelper.getAllEvents();
      expect(events.length, equals(1));
      expect(events.first.eventId, equals('evt_test_persistence_001'));
      expect(events.first.payload['ephemeral_id'], equals('RED-HAWK-99'));

      final patientEvents = await dbHelper.getEventsForPatient('pt_test_001');
      expect(patientEvents.length, equals(1));
      expect(patientEvents.first.eventId, equals('evt_test_persistence_001'));
    });

    test('3 & 4: close and reopen database, verify event remains in SQLite disk storage', () async {
      final event = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_test_restart_002',
        operationId: 'OP_TEST_RESTART',
        entityId: 'pt_test_002',
        eventType: 'TRIAGE_STATUS_CHANGED',
        actorId: 'node_test_medic',
        actorSequence: 2,
        lamportTimestamp: 2,
        occurredAtUtc: '2026-10-25T12:01:00.000Z',
        payload: {
          'triage_category': 'RED',
          'protocol': 'START',
        },
      );

      await dbHelper.insertEvent(event);

      // Explicitly close the SQLite database connection
      await dbHelper.close();

      // Reopen the exact same SQLite database file from disk
      final reopenedHelper = DatabaseHelper();
      reopenedHelper.setDatabasePath(dbPath);
      await reopenedHelper.initDatabase();

      final persistedEvents = await reopenedHelper.getAllEvents();
      expect(persistedEvents.length, equals(1));
      expect(persistedEvents.first.eventId, equals('evt_test_restart_002'));
      expect(persistedEvents.first.payload['triage_category'], equals('RED'));

      await reopenedHelper.close();
    });

    test('5: verify outbox survives database close and restart', () async {
      final event1 = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_outbox_001',
        operationId: 'OP_TEST_OUTBOX',
        entityId: 'pt_test_003',
        eventType: 'VITALS_RECORDED',
        actorId: 'node_test_medic',
        actorSequence: 1,
        lamportTimestamp: 1,
        occurredAtUtc: '2026-10-25T12:02:00.000Z',
        payload: {'rr': 32, 'pulse': false},
      );

      final event2 = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_outbox_002',
        operationId: 'OP_TEST_OUTBOX',
        entityId: 'pt_test_003',
        eventType: 'INJURY_RECORDED',
        actorId: 'node_test_medic',
        actorSequence: 2,
        lamportTimestamp: 2,
        occurredAtUtc: '2026-10-25T12:03:00.000Z',
        payload: {'location': 'CHEST', 'classification': 'PENETRATING_TRAUMA'},
      );

      await dbHelper.insertEvent(event1);
      await dbHelper.insertEvent(event2);

      // Verify outbox has 2 events initially
      var outbox = await dbHelper.getOutbox();
      expect(outbox.length, equals(2));

      // Simulate app crash / restart: close and reopen
      await dbHelper.close();

      final restartedHelper = DatabaseHelper();
      restartedHelper.setDatabasePath(dbPath);
      await restartedHelper.initDatabase();

      // Outbox must remain intact with both events
      outbox = await restartedHelper.getOutbox();
      expect(outbox.length, equals(2));
      expect(outbox.map((e) => e.eventId), containsAll(['evt_outbox_001', 'evt_outbox_002']));

      // Now acknowledge only event1
      await restartedHelper.acknowledgeOutboxEvents(['evt_outbox_001']);

      // Only event2 must remain in outbox
      outbox = await restartedHelper.getOutbox();
      expect(outbox.length, equals(1));
      expect(outbox.first.eventId, equals('evt_outbox_002'));

      await restartedHelper.close();
    });

    test('6: verify duplicate event insertion is rejected (idempotency)', () async {
      final event = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_duplicate_target',
        operationId: 'OP_TEST_DEDUP',
        entityId: 'pt_test_004',
        eventType: 'PATIENT_CREATED',
        actorId: 'node_test_medic',
        actorSequence: 1,
        lamportTimestamp: 1,
        occurredAtUtc: '2026-10-25T12:04:00.000Z',
        payload: {'ephemeral_id': 'TAG-DEDUP'},
      );

      // First insertion must succeed
      final firstInsert = await dbHelper.insertEvent(event);
      expect(firstInsert, isTrue);

      // Second insertion with identical eventId must be rejected
      final secondInsert = await dbHelper.insertEvent(event);
      expect(secondInsert, isFalse);

      final events = await dbHelper.getAllEvents();
      expect(events.length, equals(1));

      final outbox = await dbHelper.getOutbox();
      expect(outbox.length, equals(1));
    });

    test('7: verify an unsuccessful network attempt does not delete queued events', () async {
      final event = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_failed_network_test',
        operationId: 'OP_TEST_NETWORK_FAIL',
        entityId: 'pt_test_005',
        eventType: 'ALLERGY_RECORDED',
        actorId: 'node_test_medic',
        actorSequence: 1,
        lamportTimestamp: 1,
        occurredAtUtc: '2026-10-25T12:05:00.000Z',
        payload: {'allergy': 'Sulfa'},
      );

      await dbHelper.insertEvent(event);
      var outbox = await dbHelper.getOutbox();
      expect(outbox.length, equals(1));

      // Simulate network transmission failure
      await dbHelper.markOutboxAttemptFailed(
        ['evt_failed_network_test'],
        reason: 'HTTP 504 Gateway Timeout or SocketException',
      );

      // Outbox MUST NOT have deleted the queued event
      outbox = await dbHelper.getOutbox();
      expect(outbox.length, equals(1));
      expect(outbox.first.eventId, equals('evt_failed_network_test'));

      // Event also remains in immutable log
      final allEvents = await dbHelper.getAllEvents();
      expect(allEvents.length, equals(1));
    });

    test('8: verify personal profile data is separate from operational data', () async {
      // 1. Save an encrypted personal profile
      await dbHelper.saveEncryptedProfile(
        encryptedPayload: 'ENCRYPTED_BLOB_BASE64_XYZ',
        ivBase64: 'IV_BASE64_123',
        authTagBase64: 'TAG_BASE64_456',
        isSyntheticDemo: false,
      );

      // 2. Insert operational casualty event
      final event = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_operational_data_001',
        operationId: 'OP_TACTICAL_FLOOD',
        entityId: 'pt_casualty_99',
        eventType: 'PATIENT_CREATED',
        actorId: 'node_field_medic',
        actorSequence: 1,
        lamportTimestamp: 1,
        occurredAtUtc: '2026-10-25T12:06:00.000Z',
        payload: {'ephemeral_id': 'YELLOW-OTTER-55'},
      );
      await dbHelper.insertEvent(event);

      // Verify both exist
      expect((await dbHelper.getAllEvents()).length, equals(1));
      expect((await dbHelper.getOutbox()).length, equals(1));
      final profileBefore = await dbHelper.getEncryptedProfile();
      expect(profileBefore, isNotNull);
      expect(profileBefore!['encrypted_payload'], equals('ENCRYPTED_BLOB_BASE64_XYZ'));

      // 3. Trigger operational data wipe (e.g. end of mission or radio silence cleanup)
      await dbHelper.wipeAllOperationalData();

      // Operational data must be wiped clean
      expect((await dbHelper.getAllEvents()).isEmpty, isTrue);
      expect((await dbHelper.getOutbox()).isEmpty, isTrue);

      // Personal Profile MUST REMAIN completely intact in its separate table
      final profileAfter = await dbHelper.getEncryptedProfile();
      expect(profileAfter, isNotNull);
      expect(profileAfter!['encrypted_payload'], equals('ENCRYPTED_BLOB_BASE64_XYZ'));
      expect(profileAfter['iv_base64'], equals('IV_BASE64_123'));
    });

    test('PersonalVaultStore: default profile is unconfigured and does not contain fabricated data', () async {
      final vault = PersonalVaultStore();
      vault.setKeyStorage(InMemoryVaultKeyStorage());
      await vault.clearProfile();

      final profile = await vault.getProfile();
      // Must not contain hardcoded "Maya Sharma", "Penicillin", or fabricated records
      expect(profile['is_configured'], isFalse);
      expect(profile['is_synthetic_demo'], isFalse);
      expect(profile['blood_group'], isNull);
      expect((profile['allergies'] as List).isEmpty, isTrue);
      expect((profile['critical_conditions'] as List).isEmpty, isTrue);
      expect((profile['emergency_contacts'] as List).isEmpty, isTrue);

      // Emergency snapshot without user configuration must return null
      final snapshot = vault.generateEmergencySnapshot();
      expect(snapshot, isNull);

      // Explicitly load synthetic demo profile when commanded
      await vault.loadSyntheticDemoProfile();
      final demoProfile = await vault.getProfile();
      expect(demoProfile['is_configured'], isTrue);
      expect(demoProfile['is_synthetic_demo'], isTrue);
      expect(demoProfile['blood_group'], contains('DEMO'));

      final demoSnapshot = vault.generateEmergencySnapshot();
      expect(demoSnapshot, isNotNull);
      expect(demoSnapshot!['is_synthetic_demo'], isTrue);
    });

    test('P0-2: AES-256-GCM Personal Vault roundtrip, tampering rejection, wrong key, and restart persistence', () async {
      final keyStorage = InMemoryVaultKeyStorage();
      final vault = PersonalVaultStore();
      vault.setKeyStorage(keyStorage);
      await vault.clearProfile();

      // 1. Verify key generation
      final masterKey = await keyStorage.getOrCreateMasterKey();
      expect(masterKey.length, equals(32), reason: 'Master key must be exactly 256 bits (32 bytes)');

      // 2. Roundtrip encryption & decryption
      final testProfile = {
        'blood_group': 'O-',
        'allergies': ['Penicillin', 'Sulfa'],
        'critical_conditions': ['Severe Asthma'],
        'emergency_contacts': [{'name': 'Contact A', 'phone': '1234'}],
      };
      await vault.saveProfile(testProfile);

      final loadedProfile = await vault.getProfile();
      expect(loadedProfile['is_configured'], isTrue);
      expect(loadedProfile['blood_group'], equals('O-'));
      expect(loadedProfile['allergies'], contains('Penicillin'));

      // 3. Verify ciphertext in SQLite database is authenticated encrypted (not plaintext)
      final rawDbRow = await dbHelper.getEncryptedProfile();
      expect(rawDbRow, isNotNull);
      expect(rawDbRow!['encrypted_payload'], isNot(contains('Severe Asthma')));
      expect(rawDbRow['iv_base64'], isNotNull);
      expect(rawDbRow['auth_tag_base64'], isNotNull);

      // 4. Tampered ciphertext rejection
      final originalCipher = rawDbRow['encrypted_payload'] as String;
      final tamperedCipher = '${originalCipher.substring(0, originalCipher.length - 4)}AAAA';
      await dbHelper.saveEncryptedProfile(
        encryptedPayload: tamperedCipher,
        ivBase64: rawDbRow['iv_base64'] as String,
        authTagBase64: rawDbRow['auth_tag_base64'] as String,
        isSyntheticDemo: false,
      );

      final tamperedResult = await vault.decryptPayload(
        tamperedCipher,
        rawDbRow['iv_base64'] as String,
        rawDbRow['auth_tag_base64'] as String,
      );
      expect(tamperedResult, isNull, reason: 'Tampered ciphertext must be rejected by AES-GCM tag verification');

      // 5. Wrong key rejection
      final wrongKeyStorage = InMemoryVaultKeyStorage();
      final wrongKey = await wrongKeyStorage.getOrCreateMasterKey();
      final wrongKeyResult = await vault.decryptPayload(
        originalCipher,
        rawDbRow['iv_base64'] as String,
        rawDbRow['auth_tag_base64'] as String,
        wrongKey,
      );
      expect(wrongKeyResult, isNull, reason: 'Decryption with incorrect key must fail without crashing');

      // 6. Persistence across restart (simulated with same key storage)
      final restartedVault = PersonalVaultStore();
      restartedVault.setKeyStorage(keyStorage);
      // Restore valid ciphertext
      await dbHelper.saveEncryptedProfile(
        encryptedPayload: originalCipher,
        ivBase64: rawDbRow['iv_base64'] as String,
        authTagBase64: rawDbRow['auth_tag_base64'] as String,
        isSyntheticDemo: false,
      );
      final restoredProfile = await restartedVault.getProfile();
      expect(restoredProfile['is_configured'], isTrue);
      expect(restoredProfile['blood_group'], equals('O-'));

      // 7. Fail-closed protection when corrupt vault cannot be decrypted:
      // Must NOT fallback to blank profile or allow silent overwrite!
      restartedVault.invalidateCache();
      await dbHelper.saveEncryptedProfile(
        encryptedPayload: 'NOT_VALID_ENCRYPTED_DATA',
        ivBase64: 'INVALID_IV',
        authTagBase64: 'INVALID_TAG',
        isSyntheticDemo: false,
      );

      // Reading a corrupted profile MUST throw VaultSecurityException and transition to corrupted state
      bool threwCorrupted = false;
      try {
        await restartedVault.getProfile();
      } on VaultSecurityException catch (e) {
        threwCorrupted = true;
        expect(e.state, equals(VaultState.corrupted));
      }
      expect(threwCorrupted, isTrue, reason: 'Reading corrupted profile must throw VaultSecurityException');
      expect(restartedVault.vaultState, equals(VaultState.corrupted));

      // Attempting to save/update an inaccessible/corrupted profile MUST be blocked
      bool threwSaveBlocked = false;
      try {
        await restartedVault.saveProfile({'blood_group': 'B+'});
      } on VaultSecurityException catch (_) {
        threwSaveBlocked = true;
      }
      expect(threwSaveBlocked, isTrue, reason: 'Saving to corrupted vault must be blocked');

      // Verify original encrypted data was NOT overwritten on disk
      final preservedRow = await dbHelper.getEncryptedProfile();
      expect(preservedRow, isNotNull);
      expect(preservedRow!['encrypted_payload'], equals('NOT_VALID_ENCRYPTED_DATA'));

      // Explicit user-authorized vault reset clears corrupted state
      await restartedVault.resetVault();
      expect(restartedVault.vaultState, equals(VaultState.unconfigured));
      final resetProfile = await restartedVault.getProfile();
      expect(resetProfile['is_configured'], isFalse);
    });

    test('P1-D: VaultKeyStorage failure handling fails closed without exposing raw keys', () async {
      // 1. Key storage read failure throws VaultKeyStorageException
      final throwingReadStorage = _ThrowingKeyStorage(throwOnRead: true);
      final vaultWithFailingRead = PersonalVaultStore();
      vaultWithFailingRead.setKeyStorage(throwingReadStorage);

      // Seed encrypted profile row
      await dbHelper.saveEncryptedProfile(
        encryptedPayload: 'ENCRYPTED_CIPHERTEXT_123',
        ivBase64: 'IV_123',
        authTagBase64: 'TAG_123',
        isSyntheticDemo: false,
      );

      bool threwInaccessible = false;
      try {
        await vaultWithFailingRead.getProfile();
      } on VaultSecurityException catch (e) {
        threwInaccessible = true;
        expect(e.state, equals(VaultState.storageInaccessible));
      }
      expect(threwInaccessible, isTrue, reason: 'Read failure must throw VaultSecurityException');
      expect(vaultWithFailingRead.vaultState, equals(VaultState.storageInaccessible));

      // 2. Key storage write failure throws VaultKeyStorageException and never returns ephemeral key
      final throwingWriteStorage = _ThrowingKeyStorage(throwOnWrite: true);
      bool threwWriteFailure = false;
      try {
        await throwingWriteStorage.getOrCreateMasterKey();
      } on VaultKeyStorageException catch (_) {
        threwWriteFailure = true;
      }
      expect(threwWriteFailure, isTrue, reason: 'Write failure must throw VaultKeyStorageException');
    });

    test('P0-B: Duplicate event insertion preserves single durable copy and handles transactions', () async {
      final event = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_dup_storage_check',
        operationId: 'OP_DURABLE_TEST',
        entityId: 'pt_dup_check',
        eventType: 'PATIENT_CREATED',
        actorId: 'node_test_medic',
        actorSequence: 1,
        lamportTimestamp: 1,
        occurredAtUtc: '2026-10-25T12:00:00.000Z',
        payload: {'tag': 'DUP-TEST'},
      );

      final firstInsert = await dbHelper.insertEvent(event);
      expect(firstInsert, isTrue);

      // Second insert of same ID must return false (primary key collision)
      final secondInsert = await dbHelper.insertEvent(event);
      expect(secondInsert, isFalse);

      // Exactly one copy in database
      final events = await dbHelper.getAllEvents();
      expect(events.where((e) => e.eventId == 'evt_dup_storage_check').length, equals(1));
    });
  });
}

class _ThrowingKeyStorage implements VaultKeyStorage {
  final bool throwOnRead;
  final bool throwOnWrite;

  _ThrowingKeyStorage({this.throwOnRead = false, this.throwOnWrite = false});

  @override
  Future<List<int>> getOrCreateMasterKey() async {
    if (throwOnRead) {
      throw const VaultKeyStorageException('Hardware keystore inaccessible');
    }
    if (throwOnWrite) {
      throw const VaultKeyStorageException('Failed to persist newly generated key');
    }
    return List<int>.filled(32, 1);
  }

  @override
  Future<void> clearMasterKey() async {}
}
