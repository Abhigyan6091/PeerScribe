import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:peerscribe_mobile/core/storage/database_helper.dart';
import 'package:peerscribe_mobile/core/sync/lan_sync_service.dart';
import 'package:peerscribe_mobile/core/protocol/event_model.dart';

void main() {
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;

  const int testPort = 4455;
  late Directory tempDir;
  late String dbPath;
  late DatabaseHelper dbHelper;
  late LanSyncService syncService;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('peerscribe_lan_test_');
    dbPath = '${tempDir.path}${Platform.pathSeparator}lan_test.db';
    dbHelper = DatabaseHelper();
    dbHelper.setDatabasePath(dbPath);
    await dbHelper.initDatabase();

    syncService = LanSyncService();
    syncService.setNodeId('node_test_mobile');
    syncService.setPairingPin('TACTICAL-TESTPIN');
    await syncService.startServer(port: testPort);
  });

  tearDown(() async {
    await syncService.stopServer();
    try {
      await tempDir.delete(recursive: true);
    } catch (_) {}
  });

  test('DatabaseHelper.getOutboxCount returns 0 initially and increments with events', () async {
    final initialCount = await dbHelper.getOutboxCount();
    expect(initialCount, equals(0));

    final event = PeerScribeEvent(
      eventId: 'evt_test_outbox_1',
      operationId: 'OP_TEST',
      entityId: 'pt_test_1',
      eventType: 'OBSERVATION_RECORDED',
      actorId: 'node_test',
      actorSequence: 1,
      lamportTimestamp: 1,
      occurredAtUtc: DateTime.now().toUtc().toIso8601String(),
      payload: {'note': 'Test Observation'},
    );

    final inserted = await dbHelper.insertEvent(event);
    expect(inserted, isTrue);

    final updatedCount = await dbHelper.getOutboxCount();
    expect(updatedCount, equals(1));
  });

  test('GET /api/v1/sync/info returns 200 OK with safe discovery metadata', () async {
    final client = HttpClient();
    final req = await client.getUrl(Uri.parse('http://127.0.0.1:$testPort/api/v1/sync/info'));
    final res = await req.close();

    expect(res.statusCode, equals(HttpStatus.ok));
    expect(res.headers.contentType?.mimeType, equals('application/json'));
    expect(res.headers.value('Access-Control-Allow-Origin'), equals('*'));

    final bodyStr = await utf8.decodeStream(res);
    final data = json.decode(bodyStr) as Map<String, dynamic>;

    expect(data['status'], equals('OK'));
    expect(data['nodeId'], equals('node_test_mobile'));
    expect(data['appVersion'], equals('1.0.0'));
    expect(data['platform'], equals('android-flutter'));
    expect(data['port'], equals(testPort));
    expect(data['requiresPairing'], isTrue);
    expect(data['outboxCount'], isA<int>());
    expect(data['ipAddresses'], isA<List>());

    // CRITICAL SECURITY CHECK: Ensure zero secrets are leaked
    expect(data.containsKey('pairingPin'), isFalse);
    expect(data.containsKey('sessionKey'), isFalse);
    expect(data.containsKey('sessionToken'), isFalse);
    expect(bodyStr.contains('TACTICAL-TESTPIN'), isFalse);

    client.close();
  });

  test('ensureServerRunning keeps server listening if stopped or restarted', () async {
    await syncService.stopServer();
    expect(syncService.isListening, isFalse);

    final port = await syncService.ensureServerRunning();
    expect(port, equals(testPort));
    expect(syncService.isListening, isTrue);

    // Verify it responds again
    final client = HttpClient();
    final req = await client.getUrl(Uri.parse('http://127.0.0.1:$testPort/api/v1/sync/info'));
    final res = await req.close();
    expect(res.statusCode, equals(HttpStatus.ok));
    client.close();
  });

  test('OPTIONS request returns 204 No Content with CORS headers', () async {
    final client = HttpClient();
    final req = await client.openUrl('OPTIONS', Uri.parse('http://127.0.0.1:$testPort/api/v1/sync/pair'));
    final res = await req.close();

    expect(res.statusCode, equals(HttpStatus.noContent));
    expect(res.headers.value('Access-Control-Allow-Origin'), equals('*'));
    expect(res.headers.value('Access-Control-Allow-Methods'), contains('GET, POST, OPTIONS'));
    client.close();
  });

  test('Malformed JSON on POST returns 400 Bad Request with error JSON', () async {
    final client = HttpClient();
    final req = await client.postUrl(Uri.parse('http://127.0.0.1:$testPort/api/v1/sync/pair'));
    req.headers.contentType = ContentType.json;
    req.write('{malformed_json: true');
    final res = await req.close();

    expect(res.statusCode, equals(HttpStatus.badRequest));
    final bodyStr = await utf8.decodeStream(res);
    final data = json.decode(bodyStr) as Map<String, dynamic>;
    expect(data['error'], contains('Malformed JSON'));
    client.close();
  });

  test('Unknown route returns 404 Not Found', () async {
    final client = HttpClient();
    final req = await client.getUrl(Uri.parse('http://127.0.0.1:$testPort/api/v1/unknown_route'));
    final res = await req.close();

    expect(res.statusCode, equals(HttpStatus.notFound));
    final bodyStr = await utf8.decodeStream(res);
    final data = json.decode(bodyStr) as Map<String, dynamic>;
    expect(data['error'], contains('Not found'));
    client.close();
  });
}
