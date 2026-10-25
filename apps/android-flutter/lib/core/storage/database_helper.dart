import 'dart:convert';
import 'package:path/path.dart';
import 'package:sqflite/sqflite.dart';
import '../protocol/event_model.dart';

/// Database Helper providing durable SQLite persistence with append-only immutable events,
/// outbox queuing, idempotent duplicate rejection, and strict isolation between
/// operational disaster records and personal health profile vaults.
class DatabaseHelper {
  static final DatabaseHelper _instance = DatabaseHelper._internal();
  factory DatabaseHelper() => _instance;
  DatabaseHelper._internal();

  Database? _database;
  String? _customPath;

  /// Constructor for dependency injection and isolated testing.
  DatabaseHelper.withDatabase(Database db) {
    _database = db;
  }

  /// Sets an explicit database path (useful for testing restarts and file persistence).
  void setDatabasePath(String? path) {
    _customPath = path;
  }

  /// Explicitly initializes or binds the database instance.
  Future<void> initDatabase({Database? customDb, String? dbPath}) async {
    if (customDb != null) {
      _database = customDb;
      return;
    }
    if (dbPath != null) {
      _customPath = dbPath;
    }
    await getDatabase();
  }

  /// Returns the open SQLite database handle, initializing tables if needed.
  Future<Database> getDatabase() async {
    if (_database != null && _database!.isOpen) {
      return _database!;
    }

    String path;
    if (_customPath != null) {
      path = _customPath!;
    } else {
      final dbFolder = await getDatabasesPath();
      path = join(dbFolder, 'peerscribe_tactical.db');
    }

    _database = await openDatabase(
      path,
      version: 1,
      onCreate: _onCreate,
    );
    return _database!;
  }

  static Future<void> _onCreate(Database db, int version) async {
    // 1. Immutable Event Log Table
    await db.execute('''
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY NOT NULL,
        operation_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_sequence INTEGER NOT NULL,
        lamport_timestamp INTEGER NOT NULL,
        occurred_at_utc TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        raw_json TEXT NOT NULL
      )
    ''');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_id)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_events_op ON events(operation_id)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at_utc)');

    // 2. Persistent Outbox Queue (survives app restarts until acknowledged by peers)
    await db.execute('''
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY NOT NULL,
        enqueued_at_utc TEXT NOT NULL,
        retry_count INTEGER DEFAULT 0,
        last_attempt_utc TEXT,
        status TEXT DEFAULT 'QUEUED',
        FOREIGN KEY(event_id) REFERENCES events(event_id) ON DELETE CASCADE
      )
    ''');

    // 3. Operational Metadata
    await db.execute('''
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        started_at_utc TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT
      )
    ''');

    // 4. Encrypted Personal Vault Store (Strictly isolated from operational data)
    await db.execute('''
      CREATE TABLE IF NOT EXISTS personal_profile (
        profile_id TEXT PRIMARY KEY NOT NULL,
        encrypted_payload TEXT NOT NULL,
        iv_base64 TEXT NOT NULL,
        auth_tag_base64 TEXT,
        is_synthetic_demo INTEGER DEFAULT 0,
        updated_at_utc TEXT NOT NULL
      )
    ''');

    // Default operation initialization
    await db.insert(
      'operations',
      {
        'operation_id': 'OP_MOBILE_TACTICAL_01',
        'name': 'Disaster Response Mobile Squad',
        'started_at_utc': DateTime.now().toUtc().toIso8601String(),
        'status': 'ACTIVE',
        'metadata_json': '{}',
      },
      conflictAlgorithm: ConflictAlgorithm.ignore,
    );
  }

  /// Inserts a new event into the immutable log and enqueues it in the outbox.
  /// Rejects duplicate event insertion (returns false if event_id already exists).
  Future<bool> insertEvent(PeerScribeEvent event) async {
    final db = await getDatabase();

    // Idempotent duplicate check
    final existing = await db.query(
      'events',
      columns: ['event_id'],
      where: 'event_id = ?',
      whereArgs: [event.eventId],
      limit: 1,
    );

    if (existing.isNotEmpty) {
      return false; // Duplicate rejected
    }

    final rawJson = event.toJson();
    final payloadJson = json.encode(event.payload);

    await db.transaction((txn) async {
      await txn.insert(
        'events',
        {
          'event_id': event.eventId,
          'operation_id': event.operationId,
          'entity_id': event.entityId,
          'event_type': event.eventType,
          'actor_id': event.actorId,
          'actor_sequence': event.actorSequence,
          'lamport_timestamp': event.lamportTimestamp,
          'occurred_at_utc': event.occurredAtUtc,
          'payload_json': payloadJson,
          'raw_json': rawJson,
        },
        conflictAlgorithm: ConflictAlgorithm.abort,
      );

      await txn.insert(
        'outbox',
        {
          'event_id': event.eventId,
          'enqueued_at_utc': DateTime.now().toUtc().toIso8601String(),
          'retry_count': 0,
          'last_attempt_utc': null,
          'status': 'QUEUED',
        },
        conflictAlgorithm: ConflictAlgorithm.ignore,
      );
    });

    return true;
  }

  /// Retrieves all persisted events ordered chronologically.
  Future<List<PeerScribeEvent>> getAllEvents() async {
    final db = await getDatabase();
    final rows = await db.query(
      'events',
      columns: ['raw_json'],
      orderBy: 'occurred_at_utc ASC, lamport_timestamp ASC',
    );

    return rows
        .map((r) => PeerScribeEvent.fromJson(r['raw_json'] as String))
        .toList();
  }

  /// Retrieves a specific event by its event_id, or null if not found.
  Future<PeerScribeEvent?> getEventById(String eventId) async {
    final db = await getDatabase();
    final rows = await db.query(
      'events',
      columns: ['raw_json'],
      where: 'event_id = ?',
      whereArgs: [eventId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return PeerScribeEvent.fromJson(rows.first['raw_json'] as String);
  }

  /// Retrieves all events for a specific patient entity.
  Future<List<PeerScribeEvent>> getEventsForPatient(String patientId) async {
    final db = await getDatabase();
    final rows = await db.query(
      'events',
      columns: ['raw_json'],
      where: 'entity_id = ?',
      whereArgs: [patientId],
      orderBy: 'occurred_at_utc ASC, lamport_timestamp ASC',
    );

    return rows
        .map((r) => PeerScribeEvent.fromJson(r['raw_json'] as String))
        .toList();
  }

  /// Retrieves all currently queued events in the synchronization outbox.
  Future<List<PeerScribeEvent>> getOutbox() async {
    final db = await getDatabase();
    final rows = await db.rawQuery('''
      SELECT e.raw_json 
      FROM outbox o 
      INNER JOIN events e ON o.event_id = e.event_id 
      ORDER BY o.enqueued_at_utc ASC
    ''');

    return rows
        .map((r) => PeerScribeEvent.fromJson(r['raw_json'] as String))
        .toList();
  }

  /// Removes acknowledged events from the outbox after verified peer delivery.
  Future<void> acknowledgeOutboxEvents(List<String> eventIds) async {
    if (eventIds.isEmpty) return;
    final db = await getDatabase();
    final placeholders = List.filled(eventIds.length, '?').join(',');
    await db.delete(
      'outbox',
      where: 'event_id IN ($placeholders)',
      whereArgs: eventIds,
    );
  }

  /// Records an unsuccessful sync attempt without deleting queued events.
  Future<void> markOutboxAttemptFailed(List<String> eventIds, {String? reason}) async {
    if (eventIds.isEmpty) return;
    final db = await getDatabase();
    final now = DateTime.now().toUtc().toIso8601String();
    final placeholders = List.filled(eventIds.length, '?').join(',');

    await db.rawUpdate('''
      UPDATE outbox 
      SET retry_count = retry_count + 1, 
          last_attempt_utc = ?, 
          status = 'RETRYING'
      WHERE event_id IN ($placeholders)
    ''', [now, ...eventIds]);
  }

  /// Retrieves the active disaster operation.
  Future<Map<String, dynamic>> getActiveOperation() async {
    final db = await getDatabase();
    final rows = await db.query(
      'operations',
      where: 'status = ?',
      whereArgs: ['ACTIVE'],
      limit: 1,
    );

    if (rows.isNotEmpty) {
      final r = rows.first;
      return {
        'operation_id': r['operation_id'],
        'name': r['name'],
        'started_at_utc': r['started_at_utc'],
        'status': r['status'],
      };
    }

    return {
      'operation_id': 'OP_MOBILE_TACTICAL_01',
      'name': 'Disaster Response Mobile Squad',
      'status': 'ACTIVE',
    };
  }

  /// Sets or updates the active operation.
  Future<void> setActiveOperation(Map<String, dynamic> op) async {
    final db = await getDatabase();
    await db.insert(
      'operations',
      {
        'operation_id': op['operation_id'] ?? 'OP_TACTICAL',
        'name': op['name'] ?? 'Disaster Field Operation',
        'started_at_utc': op['started_at_utc'] ?? DateTime.now().toUtc().toIso8601String(),
        'status': op['status'] ?? 'ACTIVE',
        'metadata_json': json.encode(op),
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Wipes all operational records (events, outbox, operations).
  /// Strictly preserves the personal health profile vault.
  Future<void> wipeAllOperationalData() async {
    final db = await getDatabase();
    await db.transaction((txn) async {
      await txn.delete('outbox');
      await txn.delete('events');
      await txn.delete('operations');
    });
  }

  // ---------------------------------------------------------------------------
  // Personal Profile Vault Storage (Isolated from operational wipe)
  // ---------------------------------------------------------------------------

  /// Persists the encrypted personal profile record.
  Future<void> saveEncryptedProfile({
    required String encryptedPayload,
    required String ivBase64,
    String? authTagBase64,
    bool isSyntheticDemo = false,
  }) async {
    final db = await getDatabase();
    await db.insert(
      'personal_profile',
      {
        'profile_id': 'local_user',
        'encrypted_payload': encryptedPayload,
        'iv_base64': ivBase64,
        'auth_tag_base64': authTagBase64 ?? '',
        'is_synthetic_demo': isSyntheticDemo ? 1 : 0,
        'updated_at_utc': DateTime.now().toUtc().toIso8601String(),
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Reads the encrypted personal profile record.
  Future<Map<String, dynamic>?> getEncryptedProfile() async {
    final db = await getDatabase();
    final rows = await db.query(
      'personal_profile',
      where: 'profile_id = ?',
      whereArgs: ['local_user'],
      limit: 1,
    );

    if (rows.isEmpty) return null;
    return Map<String, dynamic>.from(rows.first);
  }

  /// Deletes the personal profile vault record.
  Future<void> deleteProfile() async {
    final db = await getDatabase();
    await db.delete(
      'personal_profile',
      where: 'profile_id = ?',
      whereArgs: ['local_user'],
    );
  }

  /// Closes the database connection.
  Future<void> close() async {
    if (_database != null && _database!.isOpen) {
      await _database!.close();
      _database = null;
    }
  }
}
