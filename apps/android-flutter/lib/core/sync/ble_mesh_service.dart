import 'dart:async';
import 'dart:convert';
import 'package:flutter/services.dart';
import '../protocol/event_model.dart';
import 'lan_sync_service.dart';

/// Representation of a physically or beacon-discovered peer responder.
class DiscoveredBlePeer {
  final String nodeId;
  final ResponderRole role;
  final String geohash;
  final String ipAddress;
  final int port;
  final String pairingPin;
  final int rssi;
  final DateTime lastSeen;

  DiscoveredBlePeer({
    required this.nodeId,
    required this.role,
    required this.geohash,
    required this.ipAddress,
    required this.port,
    required this.pairingPin,
    required this.rssi,
    required this.lastSeen,
  });

  Map<String, dynamic> toJson() => {
    'nodeId': nodeId,
    'role': role.name,
    'geohash': geohash,
    'ipAddress': ipAddress,
    'port': port,
    'pairingPin': pairingPin,
    'rssi': rssi,
    'lastSeen': lastSeen.toIso8601String(),
  };
}

/// Physical Bluetooth Low Energy (BLE) Mesh & Discovery Service.
/// Scans for and advertises PeerScribe responders using GATT Service UUID 0x5053 ("PS").
/// Discovered peers are automatically integrated with tactical LAN/P2P sync.
class BleMeshService {
  static final BleMeshService _instance = BleMeshService._internal();
  factory BleMeshService() => _instance;
  BleMeshService._internal();

  static const String serviceUuid = '00005053-0000-1000-8000-00805F9B34FB';
  static const MethodChannel _bleChannel = MethodChannel('com.peerscribe.mesh/ble');

  bool _isAdvertising = false;
  bool _isScanning = false;
  Timer? _advertisementHeartbeat;
  Timer? _scanPruneTimer;

  final Map<String, DiscoveredBlePeer> _discoveredPeers = {};
  final StreamController<List<DiscoveredBlePeer>> _peersController =
      StreamController<List<DiscoveredBlePeer>>.broadcast();

  Stream<List<DiscoveredBlePeer>> get discoveredPeersStream => _peersController.stream;
  List<DiscoveredBlePeer> get discoveredPeers => _discoveredPeers.values.toList();
  bool get isAdvertising => _isAdvertising;
  bool get isScanning => _isScanning;

  /// Starts advertising device presence over BLE.
  Future<void> startAdvertising({
    required String localNodeId,
    required ResponderRole localRole,
    required String geohash,
    required int port,
    required String pairingPin,
    String ipAddress = '127.0.0.1',
  }) async {
    if (_isAdvertising) return;
    _isAdvertising = true;

    final beaconData = {
      'id': localNodeId,
      'r': localRole.name,
      'g': geohash,
      'p': port,
      'ip': ipAddress,
      'pin': pairingPin,
    };

    try {
      await _bleChannel.invokeMethod('startAdvertising', {
        'serviceUuid': serviceUuid,
        'payload': jsonEncode(beaconData),
      });
    } on MissingPluginException {
      // In host test or simulator environments
    } catch (_) {}

    _advertisementHeartbeat = Timer.periodic(const Duration(seconds: 10), (_) async {
      if (!_isAdvertising) return;
      try {
        await _bleChannel.invokeMethod('updateBeaconPayload', {
          'payload': jsonEncode(beaconData),
        });
      } catch (_) {}
    });
  }

  /// Starts scanning for nearby BLE PeerScribe beacons.
  Future<void> startScanning({bool autoSyncOnDiscovery = true}) async {
    if (_isScanning) return;
    _isScanning = true;

    try {
      _bleChannel.setMethodCallHandler((call) async {
        if (call.method == 'onDeviceDiscovered') {
          final Map<dynamic, dynamic> args = call.arguments;
          final rawPayload = args['payload'] as String?;
          final rssi = (args['rssi'] as num?)?.toInt() ?? -60;
          if (rawPayload != null) {
            _handleDiscoveredBeacon(rawPayload, rssi, autoSyncOnDiscovery);
          }
        }
      });

      await _bleChannel.invokeMethod('startScanning', {'serviceUuid': serviceUuid});
    } on MissingPluginException {
      // In host test
    } catch (_) {}

    _scanPruneTimer = Timer.periodic(const Duration(seconds: 15), (_) {
      final cutoff = DateTime.now().subtract(const Duration(seconds: 60));
      _discoveredPeers.removeWhere((_, peer) => peer.lastSeen.isBefore(cutoff));
      _peersController.add(discoveredPeers);
    });
  }

  void _handleDiscoveredBeacon(String rawPayload, int rssi, bool autoSync) {
    try {
      final data = jsonDecode(rawPayload) as Map<String, dynamic>;
      final peerId = data['id'] as String;
      final roleStr = data['r'] as String? ?? 'medicalResponder';
      final role = ResponderRole.values.firstWhere(
        (r) => r.name.toLowerCase() == roleStr.toLowerCase(),
        orElse: () => ResponderRole.medicalResponder,
      );
      final geohash = data['g'] as String? ?? 'u15ek200';
      final ip = data['ip'] as String? ?? '127.0.0.1';
      final port = (data['p'] as num?)?.toInt() ?? 4322;
      final pin = data['pin'] as String? ?? '';

      final peer = DiscoveredBlePeer(
        nodeId: peerId,
        role: role,
        geohash: geohash,
        ipAddress: ip,
        port: port,
        pairingPin: pin,
        rssi: rssi,
        lastSeen: DateTime.now(),
      );

      final isNewPeer = !_discoveredPeers.containsKey(peerId);
      _discoveredPeers[peerId] = peer;
      _peersController.add(discoveredPeers);

      if (isNewPeer && autoSync && pin.isNotEmpty) {
        LanSyncService().syncWithPeer(
          '$ip:$port',
          pairingPin: pin,
        ).catchError((_) => const LanSyncResult(success: false, peerAddress: '', timestamp: ''));
      }
    } catch (_) {}
  }

  /// Inject discovered peer directly (for testing and manual discovery).
  void injectDiscoveredPeer(DiscoveredBlePeer peer, {bool autoSync = false}) {
    _discoveredPeers[peer.nodeId] = peer;
    _peersController.add(discoveredPeers);

    if (autoSync && peer.pairingPin.isNotEmpty) {
      LanSyncService().syncWithPeer(
        '${peer.ipAddress}:${peer.port}',
        pairingPin: peer.pairingPin,
      ).catchError((_) => const LanSyncResult(success: false, peerAddress: '', timestamp: ''));
    }
  }

  Future<void> stop() async {
    _isAdvertising = false;
    _isScanning = false;
    _advertisementHeartbeat?.cancel();
    _scanPruneTimer?.cancel();

    try {
      await _bleChannel.invokeMethod('stopAdvertising');
      await _bleChannel.invokeMethod('stopScanning');
    } catch (_) {}
  }
}
