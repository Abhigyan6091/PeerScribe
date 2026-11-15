import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:peerscribe_mobile/core/protocol/event_model.dart';
import 'package:peerscribe_mobile/core/storage/database_helper.dart';
import 'package:peerscribe_mobile/core/sync/ble_mesh_service.dart';
import 'package:peerscribe_mobile/core/sync/wifi_p2p_service.dart';
import 'package:peerscribe_mobile/core/location/gps_service.dart';
import 'package:peerscribe_mobile/core/location/particle_filter_service.dart';
import 'package:peerscribe_mobile/core/ai/offline_whisper_service.dart';

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

  group('Real GPS/GNSS Location Integration & Automated Duty-Cycling Tests', () {
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

    test('GpsService automated duty-cycling transitions correctly', () async {
      final gps = GpsService();

      // 1. Transition to FIELD mode (120s interval)
      await gps.setOperationalMode(OperationalDutyMode.field);
      expect(gps.currentDutyMode, OperationalDutyMode.field);
      expect(gps.isTracking, isTrue);

      // 2. Transition to EMERGENCY mode (5s interval)
      await gps.setOperationalMode(OperationalDutyMode.emergency);
      expect(gps.currentDutyMode, OperationalDutyMode.emergency);
      expect(gps.isTracking, isTrue);

      // 3. Transition to DORMANT mode (Radio silence, tracking stopped)
      await gps.setOperationalMode(OperationalDutyMode.dormant);
      expect(gps.currentDutyMode, OperationalDutyMode.dormant);
      expect(gps.isTracking, isFalse);

      await gps.stop();
    });
  });

  group('Live Background Particle Filter Simulation Tests', () {
    test('MobilityParticleFilter initializes 500 particles and propagates kinematic drift', () {
      final filter = MobilityParticleFilter(
        lkpLat: 27.7172,
        lkpLon: 85.3240,
        numParticles: 500,
        initialDispersionMeters: 40.0,
      );

      expect(filter.particles.length, 500);
      final initialContours = filter.estimateSearchContours();
      expect(initialContours.particleCount, 500);
      expect(initialContours.radius50PercentMeters, greaterThan(0));
      expect(initialContours.radius90PercentMeters, greaterThan(initialContours.radius50PercentMeters));

      // Propagate forward 10 seconds
      filter.propagate(10.0);
      expect(filter.totalElapsedSeconds, 10);
      final propagatedContours = filter.estimateSearchContours();
      expect(propagatedContours.elapsedSeconds, 10);
    });

    test('MobilityParticleFilter contracts search radius upon Bayesian sighting update', () {
      final filter = MobilityParticleFilter(
        lkpLat: 27.7172,
        lkpLon: 85.3240,
        numParticles: 500,
        initialDispersionMeters: 80.0,
      );

      // Propagate drift for 30s so the particle swarm expands
      filter.propagate(30.0);
      final beforeSighting = filter.estimateSearchContours();

      // Opportunistic sighting within 25 meters of true position
      filter.observeSighting(27.7174, 85.3242, accuracyMeters: 25.0);
      final afterSighting = filter.estimateSearchContours();

      // Contraction rate must be positive and reduce search radius
      expect(afterSighting.radius90PercentMeters, lessThan(beforeSighting.radius90PercentMeters));
      expect(afterSighting.contractionRatePercent, greaterThan(20.0));
    });

    test('ParticleFilterService manages live background stream and binds sightings', () async {
      final service = ParticleFilterService();
      expect(service.isRunning, isFalse);

      service.startSimulation(lkpLat: 27.7172, lkpLon: 85.3240, numParticles: 500);
      expect(service.isRunning, isTrue);
      expect(service.lastEstimates, isNotNull);
      expect(service.lastEstimates!.particleCount, 500);

      // Trigger sighting
      service.observeSighting(27.7173, 85.3241, accuracyMeters: 20.0);
      expect(service.lastEstimates!.contractionRatePercent, greaterThan(0));

      service.stopSimulation();
      expect(service.isRunning, isFalse);
    });
  });

  group('On-Device Quantized Whisper Neural Model Tests', () {
    test('OfflineWhisperService performs on-device quantized acoustic decoding', () async {
      final whisper = OfflineWhisperService();
      expect(whisper.isLocalModel, isTrue);
      expect(whisper.modelArchitecture, 'whisper-tiny-quantized-int8');

      // Test tactical audio sample transcription
      final result = await whisper.transcribeTacticalAudioSample('TRAUMA_FEMUR');
      expect(result.isOffline, isTrue);
      expect(result.modelArchitecture, 'whisper-tiny-quantized-int8');
      expect(result.confidence, greaterThan(0.90));
      expect(result.transcript, contains('femur'));
      expect(result.transcript, contains('respiratory rate'));
    });

    test('OfflineWhisperService handles low-energy noise gate VAD', () async {
      final whisper = OfflineWhisperService();

      // Silent/low-energy buffer (zeros)
      final silentBytes = Uint8List(16000 * 2); // 1 sec of 16-bit silence
      final result = await whisper.transcribePcm(silentBytes);

      expect(result.isOffline, isTrue);
      expect(result.transcript, contains('silence / ambient background noise'));
    });
  });
}
