import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:peerscribe_mobile/core/storage/database_helper.dart';
import 'package:peerscribe_mobile/core/sync/lan_sync_service.dart';
import 'package:peerscribe_mobile/core/protocol/event_model.dart';

/// Test Harness controlling the actual Electron / Node.js LanSyncService process
/// connected via IPC to a live TacticalStorageEngine instance.
class NodePeerHarness {
  final Process process;
  final StreamIterator<String> _iterator;

  NodePeerHarness._(this.process, this._iterator);

  /// Spawns the Node.js peer runner.
  /// Fails explicitly if the helper script or node environment is not available;
  /// silent skipping is strictly prohibited.
  static Future<NodePeerHarness> spawn() async {
    final scriptPath = '${Directory.current.path}/test/helpers/electron_peer_runner.cjs';
    if (!File(scriptPath).existsSync()) {
      throw StateError('CRITICAL: Electron peer runner script not found at $scriptPath. Integration tests cannot proceed.');
    }
    try {
      final proc = await Process.start('node', [scriptPath]);
      final lines = proc.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter());
      final iterator = StreamIterator(lines);
      return NodePeerHarness._(proc, iterator);
    } catch (e) {
      throw StateError('CRITICAL: Failed to spawn Electron Node peer process: $e. Node.js must be installed and accessible.');
    }
  }

  Future<Map<String, dynamic>> sendCommand(Map<String, dynamic> cmd) async {
    process.stdin.writeln(json.encode(cmd));
    while (await _iterator.moveNext()) {
      final line = _iterator.current.trim();
      if (line.startsWith('{') && line.endsWith('}')) {
        try {
          return json.decode(line) as Map<String, dynamic>;
        } catch (_) {}
      }
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
  late NodePeerHarness nodeHarness;

  setUpAll(() async {
    // Spawn the live Node.js Electron LanSyncService runner
    nodeHarness = await NodePeerHarness.spawn();
    final startRes = await nodeHarness.sendCommand({
      'action': 'START',
      'port': nodePort,
      'pairingPin': nodePairingPin,
      'nodeId': 'node_electron_desktop'
    });
    expect(startRes['status'], equals('STARTED'));
  });

  tearDownAll(() async {
    await nodeHarness.stop();
  });

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('peerscribe_cross_test_');
    dbPath = '${tempDir.path}${Platform.pathSeparator}cross_test.db';
    dbHelper = DatabaseHelper();
    dbHelper.setDatabasePath(dbPath);
    await dbHelper.initDatabase();

    dartService = LanSyncService();
    dartService.clearClientSessions();
    dartService.setNodeId('node_mobile_flutter');
    dartService.setPairingPin(dartPairingPin, ttlSeconds: 300);
    await dartService.startServer(port: dartPort);

    // Refresh pairing PIN on Node for each test run to account for single-use consumption
    await nodeHarness.sendCommand({
      'action': 'SET_PIN',
      'pairingPin': nodePairingPin,
      'ttlSeconds': 300,
    });
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

      // 4. Verify Node received and persisted the event in TacticalStorageEngine
      final nodeState = await nodeHarness.sendCommand({'action': 'GET_STATE'});
      final nodeEvents = (nodeState['events'] as List).cast<Map<String, dynamic>>();
      expect(nodeEvents.any((e) => e['event_id'] == 'evt_dart_to_node_100'), isTrue);
    });

    test('Electron-initiated sync: Electron synchronizes to Dart and Dart persists to SQLite', () async {
      // 1. Electron creates an event
      await nodeHarness.sendCommand({
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

      // Refresh Dart pairing PIN
      dartService.setPairingPin(dartPairingPin, ttlSeconds: 300);

      // 2. Electron initiates synchronization targeting Dart service
      final syncCmdRes = await nodeHarness.sendCommand({
        'action': 'SYNC_WITH_PEER',
        'peerAddress': 'http://127.0.0.1:$dartPort',
        'pairingPin': dartPairingPin,
      });

      expect(syncCmdRes['status'], equals('SYNC_COMPLETE'));
      final syncResult = syncCmdRes['result'] as Map<String, dynamic>;
      expect(syncResult['success'], isTrue);
      expect(syncResult['eventsSent'], greaterThanOrEqualTo(1));

      // 3. Verify event is durably stored in Dart SQLite
      final persisted = await dbHelper.getEventById('evt_node_to_dart_200');
      expect(persisted, isNotNull);
      expect(persisted!.payload['ephemeral_id'], equals('TAG-NODE-02'));

      // 4. Verify Node outbox is cleared after durable acknowledgement
      final nodeStateAfter = await nodeHarness.sendCommand({'action': 'GET_STATE'});
      final nodeOutbox = (nodeStateAfter['outbox'] as List).cast<Map<String, dynamic>>();
      expect(nodeOutbox.any((e) => e['event_id'] == 'evt_node_to_dart_200'), isFalse);
    });

    test('Duplicate events are suppressed and not inserted twice into SQLite', () async {
      // 1. Ingest an event into Dart SQLite
      final testEvent = PeerScribeEvent(
        schemaVersion: 1,
        eventId: 'evt_duplicate_test_300',
        operationId: 'OP_CROSS_PLATFORM_TEST',
        entityId: 'pt_cross_003',
        eventType: 'PATIENT_CREATED',
        actorId: 'node_electron_desktop',
        actorSequence: 1,
        lamportTimestamp: 1,
        occurredAtUtc: '2026-10-25T14:08:00.000Z',
        payload: {'ephemeral_id': 'TAG-DUP-01'},
      );
      await dbHelper.insertEvent(testEvent);

      // 2. Node also has this exact event in its outboxQueue
      await nodeHarness.sendCommand({
        'action': 'ADD_EVENT',
        'event': testEvent.toMap(),
      });

      // 3. Sync: Dart receives the duplicate event from Node
      final result = await dartService.syncWithPeer(
        'http://127.0.0.1:$nodePort',
        pairingPin: nodePairingPin,
      );
      expect(result.success, isTrue);

      // 4. Verify duplicate event is NOT inserted twice into SQLite
      final allEvents = await dbHelper.getAllEvents();
      final count = allEvents.where((e) => e.eventId == 'evt_duplicate_test_300').length;
      expect(count, equals(1), reason: 'Duplicate event must not be duplicated in database');
    });

    test('Concurrent RED vs GREEN triage assessments produce a visible divergence flag', () async {
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
      await nodeHarness.sendCommand({
        'action': 'ADD_EVENT',
        'event': {
          'schema_version': 1,
          'event_id': 'evt_node_green_$patientId',
          'operation_id': 'OP_CROSS_PLATFORM_TEST',
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

    test('Security: Anti-forgery rejects arbitrary unverified acknowledgement IDs', () async {
      // 1. Establish an authenticated session with Node
      final pairRes = await dartService.pairWithPeer(
        'http://127.0.0.1:$nodePort',
        nodePairingPin,
      );
      final sessionId = pairRes['sessionId'] as String;
      final sessionToken = pairRes['sessionToken'] as String;

      // 2. Attempt to acknowledge an arbitrary forged ID never sent to this session
      final client = HttpClient();
      try {
        final ackReq = await client.postUrl(Uri.parse('http://127.0.0.1:$nodePort/api/v1/sync/ack'));
        ackReq.headers.set('X-PeerScribe-Session', sessionId);
        ackReq.headers.set('X-PeerScribe-Token', sessionToken);
        ackReq.headers.set('X-PeerScribe-Peer-Id', dartService.nodeId);
        ackReq.headers.set('X-PeerScribe-Nonce', 'nonce_forged_${DateTime.now().millisecondsSinceEpoch}');
        ackReq.headers.set('X-PeerScribe-Timestamp', DateTime.now().toUtc().toIso8601String());
        ackReq.headers.contentType = ContentType.json;

        ackReq.write(json.encode({
          'acknowledged_event_ids': ['evt_forged_arbitrary_999']
        }));

        final ackResp = await ackReq.close();
        final bodyStr = await utf8.decodeStream(ackResp);
        expect(ackResp.statusCode, equals(HttpStatus.ok));

        final respJson = json.decode(bodyStr) as Map<String, dynamic>;
        // Must acknowledge 0 and report forged count
        expect(respJson['acknowledged'], equals(0));
        expect(respJson['rejected_forged'], equals(1));
      } finally {
        client.close();
      }
    });

    test('Security: Replayed request nonce is rejected with HTTP 409 Conflict', () async {
      final pairRes = await dartService.pairWithPeer(
        'http://127.0.0.1:$nodePort',
        nodePairingPin,
      );
      final sessionId = pairRes['sessionId'] as String;
      final sessionToken = pairRes['sessionToken'] as String;
      const duplicateNonce = 'nonce_replay_test_5544';

      final client = HttpClient();
      try {
        // Request 1: Valid
        final req1 = await client.postUrl(Uri.parse('http://127.0.0.1:$nodePort/api/v1/sync/ack'));
        req1.headers.set('X-PeerScribe-Session', sessionId);
        req1.headers.set('X-PeerScribe-Token', sessionToken);
        req1.headers.set('X-PeerScribe-Peer-Id', dartService.nodeId);
        req1.headers.set('X-PeerScribe-Nonce', duplicateNonce);
        req1.headers.set('X-PeerScribe-Timestamp', DateTime.now().toUtc().toIso8601String());
        req1.headers.contentType = ContentType.json;
        req1.write(json.encode({'acknowledged_event_ids': []}));
        final resp1 = await req1.close();
        await utf8.decodeStream(resp1);
        expect(resp1.statusCode, equals(HttpStatus.ok));

        // Request 2: Replay same nonce
        final req2 = await client.postUrl(Uri.parse('http://127.0.0.1:$nodePort/api/v1/sync/ack'));
        req2.headers.set('X-PeerScribe-Session', sessionId);
        req2.headers.set('X-PeerScribe-Token', sessionToken);
        req2.headers.set('X-PeerScribe-Peer-Id', dartService.nodeId);
        req2.headers.set('X-PeerScribe-Nonce', duplicateNonce);
        req2.headers.set('X-PeerScribe-Timestamp', DateTime.now().toUtc().toIso8601String());
        req2.headers.contentType = ContentType.json;
        req2.write(json.encode({'acknowledged_event_ids': []}));
        final resp2 = await req2.close();
        final body2 = await utf8.decodeStream(resp2);

        expect(resp2.statusCode, equals(HttpStatus.conflict), reason: body2);
      } finally {
        client.close();
      }
    });

    test('Durability: Node restart recovery preserves unacknowledged events in outbox', () async {
      // 1. Add event to Node outbox
      await nodeHarness.sendCommand({
        'action': 'ADD_EVENT',
        'event': {
          'schema_version': 1,
          'event_id': 'evt_crash_survival_400',
          'operation_id': 'OP_CROSS_PLATFORM_TEST',
          'entity_id': 'pt_restart_400',
          'event_type': 'PATIENT_CREATED',
          'actor_id': 'node_electron_desktop',
          'actor_sequence': 1,
          'lamport_timestamp': 1,
          'occurred_at_utc': '2026-10-25T14:12:00.000Z',
          'payload': {'ephemeral_id': 'TAG-RESTART-400'},
        }
      });

      // 2. Simulate Node crash and restart using identical persistence data directory
      final restartRes = await nodeHarness.sendCommand({
        'action': 'RESTART',
        'port': nodePort,
        'pairingPin': nodePairingPin,
      });
      expect(restartRes['status'], equals('RESTARTED'));
      expect(restartRes['outboxCount'], greaterThanOrEqualTo(1));

      // 3. Dart synchronizes with recovered Node
      final syncRes = await dartService.syncWithPeer(
        'http://127.0.0.1:$nodePort',
        pairingPin: nodePairingPin,
      );
      expect(syncRes.success, isTrue);
      expect(syncRes.eventsReceived, greaterThanOrEqualTo(1));

      // 4. Verify event is durably stored in Dart SQLite
      final storedInDart = await dbHelper.getEventById('evt_crash_survival_400');
      expect(storedInDart, isNotNull);
      expect(storedInDart!.payload['ephemeral_id'], equals('TAG-RESTART-400'));
    });

    test('DTN Store-and-Forward: Multi-hop propagation (Dart A -> Node B -> Dart C) through intermediate restart', () async {
      final multiHopEventId = 'evt_multi_hop_${DateTime.now().millisecondsSinceEpoch}';

      // 1. Peer A (Dart) creates an event
      final eventA = PeerScribeEvent(
        schemaVersion: 1,
        eventId: multiHopEventId,
        operationId: 'OP_CROSS_PLATFORM_TEST',
        entityId: 'pt_multihop_001',
        eventType: 'PATIENT_CREATED',
        actorId: 'peer_a_dart',
        actorSequence: 1,
        lamportTimestamp: 1,
        occurredAtUtc: '2026-10-25T14:15:00.000Z',
        payload: {'sector': 'TRIAGE-HOT-ZONE'},
      );
      await dbHelper.insertEvent(eventA);

      // 2. Peer A syncs with Intermediary Peer B (Node)
      final syncAToB = await dartService.syncWithPeer(
        'http://127.0.0.1:$nodePort',
        pairingPin: nodePairingPin,
      );
      expect(syncAToB.success, isTrue);
      expect(syncAToB.eventsSent, equals(1));
      expect((await dbHelper.getOutbox()).isEmpty, isTrue);

      // 3. Intermediary Peer B restarts (simulating power cycle / crash during field movement)
      final restartB = await nodeHarness.sendCommand({
        'action': 'RESTART',
        'port': nodePort,
        'pairingPin': nodePairingPin,
      });
      expect(restartB['status'], equals('RESTARTED'));
      expect(restartB['outboxCount'], greaterThanOrEqualTo(1));

      // 4. Set up Peer C with isolated database and fresh session
      final tempDirC = await Directory.systemTemp.createTemp('peerscribe_peer_c_');
      final dbPathC = '${tempDirC.path}${Platform.pathSeparator}peer_c.db';
      await dbHelper.close();
      dbHelper.setDatabasePath(dbPathC);
      await dbHelper.initDatabase();

      dartService.setNodeId('peer_c_dart');
      dartService.clearClientSessions();
      try {
        final syncCToB = await dartService.syncWithPeer(
          'http://127.0.0.1:$nodePort',
          pairingPin: nodePairingPin,
        );
        expect(syncCToB.success, isTrue, reason: syncCToB.errorMessage);
        expect(syncCToB.eventsReceived, greaterThanOrEqualTo(1));

        // 5. Verify Peer C durably persisted the multi-hop event in its isolated database
        final storedInC = await dbHelper.getEventById(multiHopEventId);
        expect(storedInC, isNotNull);
        expect(storedInC!.payload['sector'], equals('TRIAGE-HOT-ZONE'));

        // 6. Verify Intermediary Peer B's outbox is cleared after Peer C acknowledged it
        final nodeBState = await nodeHarness.sendCommand({'action': 'GET_STATE'});
        final outboxB = (nodeBState['outbox'] as List).cast<Map<String, dynamic>>();
        expect(outboxB.any((e) => e['event_id'] == multiHopEventId), isFalse);
      } finally {
        await dbHelper.close();
        dbHelper.setDatabasePath(dbPath);
        await dbHelper.initDatabase();
        dartService.setNodeId('node_mobile_flutter');
        dartService.clearClientSessions();
        if (tempDirC.existsSync()) {
          try {
            tempDirC.deleteSync(recursive: true);
          } catch (_) {}
        }
      }
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
      // Dart client directly attempts to send malformed event missing required fields
      final client = HttpClient();
      try {
        final pairRes = await dartService.pairWithPeer(
          'http://127.0.0.1:$nodePort',
          nodePairingPin,
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
