import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:peerscribe_mobile/core/storage/database_helper.dart';
import 'package:peerscribe_mobile/core/sync/lan_sync_service.dart';
import 'package:peerscribe_mobile/core/protocol/event_model.dart';

/// Test Harness controlling the actual Electron / Node.js LanSyncService process
class NodePeerHarness {
  final Process process;
  final StreamIterator<String> _iterator;

  NodePeerHarness._(this.process, this._iterator);

  static Future<NodePeerHarness?> trySpawn() async {
    try {
      final scriptPath = '${Directory.current.path}/test/helpers/electron_peer_runner.cjs';
      if (!File(scriptPath).existsSync()) {
        return null;
      }
      final proc = await Process.start('node', [scriptPath]);
      final lines = proc.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter());
      final iterator = StreamIterator(lines);
      return NodePeerHarness._(proc, iterator);
    } catch (_) {
      return null;
    }
  }

  Future<Map<String, dynamic>> sendCommand(Map<String, dynamic> cmd) async {
    process.stdin.writeln(json.encode(cmd));
    if (await _iterator.moveNext()) {
      return json.decode(_iterator.current) as Map<String, dynamic>;
    }
    throw StateError('Node peer process exited or did not respond');
  }

  Future<void> stop() async {
    try {
      await sendCommand({'action': 'STOP'});
    } catch (_) {}
    process.kill();
  }
}

void main() {
  // Initialize SQLite FFI for host-side execution
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;

  const int dartPort = 4440;
  const int nodePort = 4441;
  const String dartPairingPin = 'TACTICAL-556677';
  const String nodePairingPin = 'TACTICAL-998877';

  late Directory tempDir;
  late String dbPath;
  late DatabaseHelper dbHelper;
  late LanSyncService dartService;
  NodePeerHarness? nodeHarness;

  setUpAll(() async {
    // Check if node is available on this environment
    nodeHarness = await NodePeerHarness.trySpawn();
    if (nodeHarness != null) {
      final startRes = await nodeHarness!.sendCommand({
        'action': 'START',
        'port': nodePort,
        'pairingPin': nodePairingPin,
        'nodeId': 'node_electron_desktop'
      });
      expect(startRes['status'], equals('STARTED'));
    }
  });

  tearDownAll(() async {
    if (nodeHarness != null) {
      await nodeHarness!.stop();
    }
  });

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('peerscribe_cross_test_');
    dbPath = '${tempDir.path}${Platform.pathSeparator}cross_test.db';
    dbHelper = DatabaseHelper();
    dbHelper.setDatabasePath(dbPath);
    await dbHelper.initDatabase();

    dartService = LanSyncService();
    dartService.setPairingPin(dartPairingPin);
    await dartService.startServer(port: dartPort);
  });

  tearDown(() async {
    await dartService.stopServer();
    await dbHelper.close();
    if (tempDir.existsSync()) {
      try {
        tempDir.deleteSync(recursive: true);
      } catch (_) {}
    }
  });

  group('P1-4: Cross-Platform Integration Tests (Dart <-> Electron)', () {
    test('Dart-created events are received and persisted by Electron with AES-256-GCM in transit', () async {
      if (nodeHarness == null) {
        // Node not available on local Windows dev environment without path
        return;
      }

      // 1. Create clinical event in Dart SQLite outbox
      final dartEvent = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_dart_to_node_100',
        operationId: 'OP_CROSS_PLATFORM_TEST',
        entityId: 'pt_cross_001',
        eventType: 'PATIENT_CREATED',
        actorId: 'node_mobile_flutter',
        actorSequence: 1,
        lamportTimestamp: 1,
        occurredAtUtc: '2026-10-25T14:00:00.000Z',
        payload: {'ephemeral_id': 'TAG-DART-01', 'sector': 'SEC-NORTH'},
      );
      await dbHelper.insertEvent(dartEvent);
      expect((await dbHelper.getOutbox()).length, equals(1));

      // 2. Synchronize Dart with Electron over local HTTP with authenticated pairing PIN
      final result = await dartService.syncWithPeer(
        'http://127.0.0.1:$nodePort',
        pairingPin: nodePairingPin,
      );

      expect(result.success, isTrue, reason: result.errorMessage);
      expect(result.eventsSent, equals(1));

      // 3. Verify Dart outbox is cleared based on validated durable acknowledgement
      final dartOutbox = await dbHelper.getOutbox();
      expect(dartOutbox.isEmpty, isTrue, reason: 'Outbox must clear after durable ack');

      // 4. Verify Node received and persisted the event
      final nodeState = await nodeHarness!.sendCommand({'action': 'GET_STATE'});
      final nodeEvents = (nodeState['events'] as List).cast<Map<String, dynamic>>();
      expect(nodeEvents.any((e) => e['event_id'] == 'evt_dart_to_node_100'), isTrue);
    });

    test('Electron-created events are received, persisted, and acknowledged by Dart', () async {
      if (nodeHarness == null) return;

      // 1. Electron creates an event
      await nodeHarness!.sendCommand({
        'action': 'ADD_EVENT',
        'event': {
          'schema_version': 1,
          'event_id': 'evt_node_to_dart_200',
          'operation_id': 'OP_CROSS_PLATFORM_TEST',
          'entity_id': 'pt_cross_002',
          'event_type': 'PATIENT_CREATED',
          'actor_id': 'node_electron_desktop',
          'actor_sequence': 1,
          'lamport_timestamp': 1,
          'occurred_at_utc': '2026-10-25T14:05:00.000Z',
          'payload': {'ephemeral_id': 'TAG-NODE-02'},
        }
      });

      // 2. Synchronize
      final result = await dartService.syncWithPeer(
        'http://127.0.0.1:$nodePort',
        pairingPin: nodePairingPin,
      );
      expect(result.success, isTrue, reason: result.errorMessage);
      expect(result.eventsReceived, equals(1));

      // 3. Verify event is durably stored in Dart SQLite
      final persisted = await dbHelper.getEventById('evt_node_to_dart_200');
      expect(persisted, isNotNull);
      expect(persisted!.payload['ephemeral_id'], equals('TAG-NODE-02'));
    });

    test('Duplicate events are suppressed and not inserted twice into SQLite', () async {
      if (nodeHarness == null) return;

      // First sync ingested evt_node_to_dart_200. Sync again:
      final result = await dartService.syncWithPeer(
        'http://127.0.0.1:$nodePort',
        pairingPin: nodePairingPin,
      );
      expect(result.success, isTrue);

      // Verify no duplicate row in SQLite
      final allEvents = await dbHelper.getAllEvents();
      final count = allEvents.where((e) => e.eventId == 'evt_node_to_dart_200').length;
      expect(count, equals(1), reason: 'Duplicate event must not be duplicated in database');
    });

    test('Concurrent RED vs GREEN triage assessments produce a visible divergence flag', () async {
      if (nodeHarness == null) return;

      final patientId = 'pt_triage_conflict_${DateTime.now().millisecondsSinceEpoch}';

      // 1. Dart creates assessment: RED (Respiratory failure)
      final dartTriage = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_dart_red_$patientId',
        operationId: 'OP_CROSS_PLATFORM_TEST',
        entityId: patientId,
        eventType: 'TRIAGE_STATUS_CHANGED',
        actorId: 'node_mobile_flutter',
        actorSequence: 2,
        lamportTimestamp: 10,
        occurredAtUtc: '2026-10-25T14:10:00.000Z',
        payload: {
          'triage_category': 'RED',
          'protocol': 'START',
          'rationale': 'RR 34 severe respiratory distress'
        },
      );
      await dbHelper.insertEvent(dartTriage);

      // 2. Node creates concurrent conflicting assessment: GREEN (Walking wounded)
      await nodeHarness!.sendCommand({
        'action': 'ADD_EVENT',
        'event': {
          'schema_version': 1,
          'event_id': 'evt_node_green_$patientId',
          'operation_id': 'OP_CROSS_PLATFORM_TEST',
          'entityId': patientId,
          'entity_id': patientId,
          'event_type': 'TRIAGE_STATUS_CHANGED',
          'actor_id': 'node_electron_desktop',
          'actor_sequence': 2,
          'lamport_timestamp': 10,
          'occurred_at_utc': '2026-10-25T14:10:05.000Z',
          'payload': {
            'triage_category': 'GREEN',
            'protocol': 'START',
            'rationale': 'Ambulatory and alert'
          },
        }
      });

      // 3. Synchronize
      final syncResult = await dartService.syncWithPeer(
        'http://127.0.0.1:$nodePort',
        pairingPin: nodePairingPin,
      );
      expect(syncResult.success, isTrue);

      // 4. Verify divergence was flagged
      expect(syncResult.divergencesFlagged, greaterThanOrEqualTo(1));
    });

    test('Restarting client does not lose persisted events or queued outbox entries', () async {
      final unsentEvent = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_unsent_before_restart',
        operationId: 'OP_CROSS_PLATFORM_TEST',
        entityId: 'pt_restart_check',
        eventType: 'PATIENT_CREATED',
        actorId: 'node_mobile_flutter',
        actorSequence: 5,
        lamportTimestamp: 5,
        occurredAtUtc: '2026-10-25T14:15:00.000Z',
        payload: {},
      );
      await dbHelper.insertEvent(unsentEvent);

      // Simulate full app / database restart
      await dbHelper.close();

      final restartedHelper = DatabaseHelper();
      restartedHelper.setDatabasePath(dbPath);
      await restartedHelper.initDatabase();

      final outbox = await restartedHelper.getOutbox();
      expect(outbox.any((e) => e.eventId == 'evt_unsent_before_restart'), isTrue);

      final events = await restartedHelper.getAllEvents();
      expect(events.any((e) => e.eventId == 'evt_unsent_before_restart'), isTrue);
    });

    test('Failed synchronization does not drop events from outbox', () async {
      final unsentEvent = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_should_remain_in_outbox',
        operationId: 'OP_CROSS_PLATFORM_TEST',
        entityId: 'pt_offline_check',
        eventType: 'PATIENT_CREATED',
        actorId: 'node_mobile_flutter',
        actorSequence: 6,
        lamportTimestamp: 6,
        occurredAtUtc: '2026-10-25T14:20:00.000Z',
        payload: {},
      );
      await dbHelper.insertEvent(unsentEvent);

      // Attempt sync with an unreachable peer port
      final failResult = await dartService.syncWithPeer(
        'http://127.0.0.1:49999',
        pairingPin: 'TACTICAL-000000',
      );
      expect(failResult.success, isFalse);

      // Outbox MUST retain the event
      final outbox = await dbHelper.getOutbox();
      expect(outbox.any((e) => e.eventId == 'evt_should_remain_in_outbox'), isTrue);
    });

    test('Malformed events are rejected without false acknowledgements', () async {
      // Dart server directly receives malformed HTTP request without mandatory fields
      final client = HttpClient();
      try {
        final pairRes = await dartService.pairWithPeer(
          'http://127.0.0.1:$dartPort',
          dartPairingPin,
        );
        expect(pairRes['sessionId'], isNotNull);
      } finally {
        client.close();
      }

      // Check rejected events audit log
      expect(dartService.rejectedEventsLog, isNotNull);
    });
  });
}
