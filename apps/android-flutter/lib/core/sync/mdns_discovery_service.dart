import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Model representing a peer discovered via mDNS or subnet broadcast.
class DiscoveredPeer {
  final String nodeId;
  final String platform;
  final String ipAddress;
  final int port;
  final String role;
  final bool requiresPairing;
  final String? pairingPin;
  final String medium; // 'mDNS' | 'UDP_BROADCAST' | 'BLE'
  final DateTime lastSeen;

  DiscoveredPeer({
    required this.nodeId,
    required this.platform,
    required this.ipAddress,
    required this.port,
    required this.role,
    this.requiresPairing = true,
    this.pairingPin,
    this.medium = 'mDNS',
    required this.lastSeen,
  });

  String get endpoint => 'http://$ipAddress:$port';

  Map<String, dynamic> toJson() => {
    'nodeId': nodeId,
    'platform': platform,
    'ipAddress': ipAddress,
    'port': port,
    'role': role,
    'requiresPairing': requiresPairing,
    'pairingPin': pairingPin,
    'medium': medium,
    'endpoint': endpoint,
    'lastSeen': lastSeen.toIso8601String(),
  };

  factory DiscoveredPeer.fromJson(Map<String, dynamic> json, String sourceAddress, {String medium = 'mDNS'}) {
    return DiscoveredPeer(
      nodeId: json['nodeId']?.toString() ?? 'node_unknown',
      platform: json['platform']?.toString() ?? 'android',
      ipAddress: (json['ip'] != null && json['ip'].toString().isNotEmpty && json['ip'] != '127.0.0.1')
          ? json['ip'].toString()
          : sourceAddress,
      port: (json['port'] as num?)?.toInt() ?? 4322,
      role: json['role']?.toString() ?? 'medicalResponder',
      requiresPairing: json['requiresPairing'] != false,
      pairingPin: json['pairingPin']?.toString(),
      medium: medium,
      lastSeen: DateTime.now(),
    );
  }
}

/// Standalone Offline mDNS & Subnet Peer Discovery Service.
/// Discovers nearby PeerScribe nodes (phone-to-phone and phone-to-laptop) automatically
/// using RFC 6762 / RFC 6763 mDNS (224.0.0.251:5353) with subnet UDP broadcast fallback.
/// Operates entirely offline without internet, cloud, or central servers.
class MdnsDiscoveryService {
  static final MdnsDiscoveryService _instance = MdnsDiscoveryService._internal();
  factory MdnsDiscoveryService() => _instance;
  MdnsDiscoveryService._internal();

  static const String mdnsServiceType = '_peerscribe._tcp.local';
  static const int mdnsPort = 5353;
  static const int broadcastFallbackPort = 4325;
  static final InternetAddress mdnsMulticastAddress = InternetAddress('224.0.0.251');

  RawDatagramSocket? _mdnsSocket;
  RawDatagramSocket? _broadcastSocket;

  bool _isRunning = false;
  Timer? _announceTimer;
  Timer? _pruneTimer;

  String _localNodeId = 'node_mobile_flutter';
  String _localPlatform = 'android-flutter';
  String _localRole = 'MEDICAL_RESPONDER';
  int _localPort = 4322;
  String _localPairingPin = '';
  List<String> _localIps = ['127.0.0.1'];

  final Map<String, DiscoveredPeer> _discoveredPeers = {};
  final StreamController<List<DiscoveredPeer>> _peersController =
      StreamController<List<DiscoveredPeer>>.broadcast();

  Stream<List<DiscoveredPeer>> get peersStream => _peersController.stream;
  List<DiscoveredPeer> get discoveredPeers => _discoveredPeers.values.toList();
  bool get isRunning => _isRunning;

  /// Starts the mDNS and UDP subnet broadcast discovery services.
  Future<void> startDiscovery({
    required String localNodeId,
    required int localPort,
    required String pairingPin,
    String role = 'MEDICAL_RESPONDER',
    List<String>? localIps,
  }) async {
    if (_isRunning) return;
    _isRunning = true;

    _localNodeId = localNodeId;
    _localPort = localPort;
    _localPairingPin = pairingPin;
    _localRole = role;
    if (localIps != null && localIps.isNotEmpty) {
      _localIps = localIps;
    }

    try {
      // 1. Bind mDNS Multicast Socket (224.0.0.251:5353)
      try {
        _mdnsSocket = await RawDatagramSocket.bind(
          InternetAddress.anyIPv4,
          mdnsPort,
          reuseAddress: true,
          reusePort: true,
        );
        _mdnsSocket?.broadcastEnabled = true;
        _mdnsSocket?.multicastLoopback = false;
        try {
          _mdnsSocket?.joinMulticast(mdnsMulticastAddress);
        } catch (_) {}

        _mdnsSocket?.listen((event) => _handleSocketEvent(_mdnsSocket, 'mDNS'));
      } catch (e) {
        print('[MdnsDiscovery] Notice: Standard mDNS port $mdnsPort bind unavailable: $e');
      }

      // 2. Bind Subnet UDP Broadcast Fallback Socket (port 4325)
      try {
        _broadcastSocket = await RawDatagramSocket.bind(
          InternetAddress.anyIPv4,
          broadcastFallbackPort,
          reuseAddress: true,
          reusePort: true,
        );
        _broadcastSocket?.broadcastEnabled = true;
        _broadcastSocket?.multicastLoopback = false;

        _broadcastSocket?.listen((event) => _handleSocketEvent(_broadcastSocket, 'UDP_BROADCAST'));
      } catch (e) {
        print('[MdnsDiscovery] Notice: Subnet broadcast port $broadcastFallbackPort bind: $e');
      }

      // 3. Immediately send discovery query to find existing nodes
      await queryPeers();

      // 4. Send initial announcement
      await announcePresence();

      // 5. Periodic presence announcements every 5 seconds
      _announceTimer?.cancel();
      _announceTimer = Timer.periodic(const Duration(seconds: 5), (_) {
        if (_isRunning) {
          announcePresence();
        }
      });

      // 6. Prune stale peers older than 45 seconds every 15 seconds
      _pruneTimer?.cancel();
      _pruneTimer = Timer.periodic(const Duration(seconds: 15), (_) {
        _pruneStalePeers();
      });

      print('[MdnsDiscovery] Automatic peer discovery active for service $mdnsServiceType');
    } catch (err) {
      print('[MdnsDiscovery] Failed to start discovery engine: $err');
    }
  }

  void _handleSocketEvent(RawDatagramSocket? socket, String medium) {
    if (socket == null) return;
    final datagram = socket.receive();
    if (datagram == null) return;

    try {
      final rawStr = utf8.decode(datagram.data);
      final json = jsonDecode(rawStr) as Map<String, dynamic>;

      final type = json['type']?.toString();
      final senderNodeId = json['nodeId']?.toString();

      // Ignore loopback reflections of our own announcements
      if (senderNodeId == _localNodeId) return;

      if (type == 'PEERSCRIBE_MDNS_QUERY') {
        // Reply with our announcement
        _sendDatagramTo(socket, datagram.address, datagram.port, _buildAnnouncementPayload());
        return;
      }

      if (type == 'PEERSCRIBE_MDNS_ANNOUNCE' || type == 'PEERSCRIBE_DISCOVERY') {
        final sourceIp = datagram.address.address;
        final peer = DiscoveredPeer.fromJson(json, sourceIp, medium: medium);

        // Update registry
        _discoveredPeers[peer.nodeId] = peer;
        _peersController.add(discoveredPeers);
      }
    } catch (_) {
      // Ignore malformed or foreign packets on shared ports
    }
  }

  Map<String, dynamic> _buildAnnouncementPayload() {
    return {
      'type': 'PEERSCRIBE_MDNS_ANNOUNCE',
      'service': mdnsServiceType,
      'nodeId': _localNodeId,
      'platform': _localPlatform,
      'ip': _localIps.isNotEmpty ? _localIps.first : '127.0.0.1',
      'port': _localPort,
      'role': _localRole,
      'requiresPairing': true,
      'timestamp': DateTime.now().toUtc().toIso8601String(),
    };
  }

  /// Announces device presence to both mDNS multicast and subnet broadcast.
  Future<void> announcePresence() async {
    final payload = _buildAnnouncementPayload();
    final data = utf8.encode(jsonEncode(payload));

    // Send to mDNS multicast
    if (_mdnsSocket != null) {
      try {
        _mdnsSocket?.send(data, mdnsMulticastAddress, mdnsPort);
      } catch (_) {}
    }

    // Send to subnet broadcast
    if (_broadcastSocket != null) {
      try {
        _broadcastSocket?.send(data, InternetAddress('255.255.255.255'), broadcastFallbackPort);
      } catch (_) {}
    }
  }

  /// Queries nearby devices by sending an mDNS/broadcast query.
  Future<void> queryPeers() async {
    final queryPayload = {
      'type': 'PEERSCRIBE_MDNS_QUERY',
      'service': mdnsServiceType,
      'nodeId': _localNodeId,
      'timestamp': DateTime.now().toUtc().toIso8601String(),
    };
    final data = utf8.encode(jsonEncode(queryPayload));

    if (_mdnsSocket != null) {
      try {
        _mdnsSocket?.send(data, mdnsMulticastAddress, mdnsPort);
      } catch (_) {}
    }
    if (_broadcastSocket != null) {
      try {
        _broadcastSocket?.send(data, InternetAddress('255.255.255.255'), broadcastFallbackPort);
      } catch (_) {}
    }
  }

  void _sendDatagramTo(RawDatagramSocket socket, InternetAddress address, int port, Map<String, dynamic> payload) {
    try {
      final data = utf8.encode(jsonEncode(payload));
      socket.send(data, address, port);
    } catch (_) {}
  }

  void _pruneStalePeers() {
    final cutoff = DateTime.now().subtract(const Duration(seconds: 45));
    final initialCount = _discoveredPeers.length;
    _discoveredPeers.removeWhere((_, peer) => peer.lastSeen.isBefore(cutoff));
    if (_discoveredPeers.length != initialCount) {
      _peersController.add(discoveredPeers);
    }
  }

  /// Injects a peer (e.g. from BLE or manual IP probe).
  void registerPeer(DiscoveredPeer peer) {
    _discoveredPeers[peer.nodeId] = peer;
    _peersController.add(discoveredPeers);
  }

  Future<void> stop() async {
    _isRunning = false;
    _announceTimer?.cancel();
    _pruneTimer?.cancel();

    try {
      _mdnsSocket?.close();
    } catch (_) {}
    try {
      _broadcastSocket?.close();
    } catch (_) {}

    _mdnsSocket = null;
    _broadcastSocket = null;
    _discoveredPeers.clear();
    _peersController.add([]);
  }
}
