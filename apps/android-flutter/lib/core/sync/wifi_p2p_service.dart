import 'dart:async';
import 'package:flutter/services.dart';
import 'lan_sync_service.dart';

class WifiP2pPeer {
  final String deviceName;
  final String deviceAddress; // MAC address
  final bool isGroupOwner;
  final String? ipAddress;
  final int status; // 0: connected, 1: invited, 2: failed, 3: available, 4: unavailable

  WifiP2pPeer({
    required this.deviceName,
    required this.deviceAddress,
    this.isGroupOwner = false,
    this.ipAddress,
    this.status = 3,
  });

  Map<String, dynamic> toJson() => {
    'deviceName': deviceName,
    'deviceAddress': deviceAddress,
    'isGroupOwner': isGroupOwner,
    'ipAddress': ipAddress,
    'status': status,
  };
}

/// Android Wi-Fi Direct (P2P) Discovery & Connection Service.
/// Enables offline peer-to-peer Wi-Fi discovery without any pre-existing router/AP.
/// Seamlessly falls back to regular LAN multicast/Wi-Fi when P2P is inactive.
class WifiP2pService {
  static final WifiP2pService _instance = WifiP2pService._internal();
  factory WifiP2pService() => _instance;
  WifiP2pService._internal();

  static const MethodChannel _p2pChannel = MethodChannel('com.peerscribe.mesh/wifip2p');

  bool _isDiscovering = false;
  bool _isConnected = false;
  String? _groupOwnerIp;

  final Map<String, WifiP2pPeer> _peers = {};
  final StreamController<List<WifiP2pPeer>> _peersController =
      StreamController<List<WifiP2pPeer>>.broadcast();

  Stream<List<WifiP2pPeer>> get peersStream => _peersController.stream;
  List<WifiP2pPeer> get peers => _peers.values.toList();
  bool get isDiscovering => _isDiscovering;
  bool get isConnected => _isConnected;
  String? get groupOwnerIp => _groupOwnerIp;

  /// Start discovering nearby Wi-Fi Direct peers.
  Future<void> startDiscovery() async {
    if (_isDiscovering) return;
    _isDiscovering = true;

    try {
      _p2pChannel.setMethodCallHandler((call) async {
        if (call.method == 'onPeersChanged') {
          final List<dynamic> peerList = call.arguments['peers'] ?? [];
          _updatePeerList(peerList);
        } else if (call.method == 'onConnectionChanged') {
          final Map<dynamic, dynamic> info = call.arguments;
          _isConnected = info['connected'] == true;
          _groupOwnerIp = info['groupOwnerAddress'] as String?;
        }
      });

      await _p2pChannel.invokeMethod('discoverPeers');
    } on MissingPluginException {
      // In host test environments
    } catch (_) {}
  }

  void _updatePeerList(List<dynamic> rawPeers) {
    for (final p in rawPeers) {
      if (p is Map) {
        final address = p['deviceAddress'] as String? ?? '';
        if (address.isNotEmpty) {
          _peers[address] = WifiP2pPeer(
            deviceName: p['deviceName'] as String? ?? 'PeerScribe Responder',
            deviceAddress: address,
            isGroupOwner: p['isGroupOwner'] == true,
            ipAddress: p['ipAddress'] as String?,
            status: (p['status'] as num?)?.toInt() ?? 3,
          );
        }
      }
    }
    _peersController.add(peers);
  }

  /// Connects to a discovered Wi-Fi Direct peer.
  Future<bool> connectToPeer(String deviceAddress) async {
    try {
      final result = await _p2pChannel.invokeMethod('connect', {'address': deviceAddress});
      return result == true;
    } on MissingPluginException {
      return false;
    } catch (_) {
      return false;
    }
  }

  /// Injects simulated Wi-Fi Direct peer for testing.
  void injectPeer(WifiP2pPeer peer) {
    _peers[peer.deviceAddress] = peer;
    _peersController.add(peers);
  }

  Future<void> stop() async {
    _isDiscovering = false;
    _isConnected = false;
    _groupOwnerIp = null;
    _peers.clear();

    try {
      await _p2pChannel.invokeMethod('stopDiscovery');
    } catch (_) {}
  }
}
