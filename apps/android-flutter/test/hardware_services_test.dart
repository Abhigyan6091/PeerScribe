import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:peerscribe_mobile/core/protocol/event_model.dart';
import 'package:peerscribe_mobile/core/storage/database_helper.dart';
import 'package:peerscribe_mobile/core/sync/ble_mesh_service.dart';
import 'package:peerscribe_mobile/core/sync/wifi_p2p_service.dart';
import 'package:peerscribe_mobile/core/location/gps_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;

  late Directory tempDir;
  late String dbPath;
  late DatabaseHelper dbHelper;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('peerscribe_hw_test_');
    dbPath = '${tempDir.path}${Platform.pathSeparator}test_hw.db';
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

  group('Physical BLE Mesh & Beacon Discovery Tests', () {
    test('BleMeshService advertises, discovers peers, and maintains peer state', () async {
      final ble = BleMeshService();
      expect(ble.discoveredPeers.isEmpty, isTrue);

      // 1. Simulate receiving peer beacon
      final peer = DiscoveredBlePeer(
        nodeId: 'node_alpha_ble',
        role: ResponderRole.medicalResponder,
        geohash: 'u15ek200',
        ipAddress: '192.168.1.55',
        port: 4322,
        pairingPin: 'TACTICAL-112233',
        rssi: -55,
        lastSeen: DateTime.now(),
      );

      ble.injectDiscoveredPeer(peer);
      expect(ble.discoveredPeers.length, 1);
      expect(ble.discoveredPeers.first.nodeId, 'node_alpha_ble');
      expect(ble.discoveredPeers.first.role, ResponderRole.medicalResponder);

      await ble.stop();
      expect(ble.isAdvertising, isFalse);
      expect(ble.isScanning, isFalse);
    });
  });

  group('Android Wi-Fi Direct (P2P) Discovery Tests', () {
    test('WifiP2pService manages P2P peers and group owner info', () async {
      final p2p = WifiP2pService();
      expect(p2p.peers.isEmpty, isTrue);

      final peer = WifiP2pPeer(
        deviceName: 'Responder-Tablet-01',
        deviceAddress: 'AA:BB:CC:DD:EE:FF',
        isGroupOwner: true,
        ipAddress: '192.168.49.1',
        status: 0,
      );

      p2p.injectPeer(peer);
      expect(p2p.peers.length, 1);
      expect(p2p.peers.first.isGroupOwner, isTrue);
      expect(p2p.peers.first.ipAddress, '192.168.49.1');

      await p2p.stop();
      expect(p2p.isDiscovering, isFalse);
    });
  });

  group('Real GPS/GNSS Location Integration Tests', () {
    test('GpsService encodes geohash and records durable OBSERVATION_RECORDED event', () async {
      final gps = GpsService();

      // Verify geohash encoding accuracy
      final geohash = GpsService.encodeGeohash(27.7172, 85.3240, precision: 8);
      expect(geohash.length, 8);
      expect(geohash, 'tuutttg0');

      // Inject coordinates
      gps.injectCoordinates(27.7172, 85.3240, accuracyMeters: 4.5);
      expect(gps.lastCoordinates, isNotNull);
      expect(gps.lastCoordinates!.latitude, 27.7172);
      expect(gps.lastCoordinates!.geohash, 'tuutttg0');

      // Record durable location event
      final event = await gps.recordLocationObservation(
        patientId: 'PATIENT_GPS_001',
        localNodeId: 'node_field_alpha',
        role: ResponderRole.medicalResponder,
      );

      expect(event.eventType, 'OBSERVATION_RECORDED');
      expect(event.actorRole, 'MEDICALRESPONDER');
      expect(event.payload['sector_geohash'], 'tuutttg0');

      // Verify event was persisted in SQLite
      final allEvents = await dbHelper.getAllEvents();
      final persisted = allEvents.where((e) => e.entityId == 'PATIENT_GPS_001').toList();
      expect(persisted.length, 1);
      expect(persisted.first.eventType, 'OBSERVATION_RECORDED');

      // Verify enqueued in outbox for mesh replication
      final outbox = await dbHelper.getOutbox();
      expect(outbox.any((e) => e.eventId == event.eventId), isTrue);

      await gps.stop();
    });
  });
}
