import 'dart:async';
import 'dart:convert';
import 'dart:io';
import '../protocol/event_model.dart';
import '../protocol/sync_bundle.dart';
import '../storage/database_helper.dart';
import 'sync_manager.dart';

const String tacticalPairingSecret = 'PEERSCRIBE-TACTICAL-MESH-2026';
const int defaultTacticalMobilePort = 4322;

class LanSyncResult {
  final bool success;
  final String peerAddress;
  final int eventsSent;
  final int eventsReceived;
  final int divergencesFlagged;
  final String? errorMessage;
  final String timestamp;

  const LanSyncResult({
    required this.success,
    required this.peerAddress,
    this.eventsSent = 0,
    this.eventsReceived = 0,
    this.divergencesFlagged = 0,
    this.errorMessage,
    required this.timestamp,
  });

  Map<String, dynamic> toMap() => {
    'success': success,
    'peerAddress': peerAddress,
    'eventsSent': eventsSent,
    'eventsReceived': eventsReceived,
    'divergencesFlagged': divergencesFlagged,
    'errorMessage': errorMessage,
    'timestamp': timestamp,
  };
}

/// Real Cross-Platform LAN Synchronization Service for Android Flutter.
/// Implements true network socket listener and client for offline hotspot/LAN sync
/// with Windows Electron desktop or peer mobile responders without Internet.
class LanSyncService {
  static final LanSyncService _instance = LanSyncService._internal();
  factory LanSyncService() => _instance;
  LanSyncService._internal();

  final DatabaseHelper _db = DatabaseHelper();
  final SyncManager _syncManager = SyncManager();

  HttpServer? _server;
  int _port = defaultTacticalMobilePort;
  final Map<String, Map<String, dynamic>> _pairedPeers = {};

  int get port => _port;
  bool get isListening => _server != null;
  List<Map<String, dynamic>> get pairedPeers => _pairedPeers.values.toList();

  /// Starts the embedded tactical HTTP server on the mobile device.
  Future<int> startServer({int port = defaultTacticalMobilePort}) async {
    if (_server != null) return _port;
    _port = port;

    try {
      _server = await HttpServer.bind(InternetAddress.anyIPv4, _port);
      _server!.listen(_handleIncomingRequest);
      return _port;
    } catch (err) {
      // If port is occupied, try fallback port
      _port = port + 10;
      _server = await HttpServer.bind(InternetAddress.anyIPv4, _port);
      _server!.listen(_handleIncomingRequest);
      return _port;
    }
  }

  void _handleIncomingRequest(HttpRequest request) async {
    final response = request.response;
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-PeerScribe-Auth');

    if (request.method == 'OPTIONS') {
      response.statusCode = HttpStatus.noContent;
      await response.close();
      return;
    }

    final path = request.uri.path;

    try {
      // 1. GET /api/v1/sync/info
      if (path == '/api/v1/sync/info' && request.method == 'GET') {
        final outbox = await _db.getOutbox();
        final op = await _db.getActiveOperation();
        response.headers.contentType = ContentType.json;
        response.write(json.encode({
          'status': 'OK',
          'nodeId': 'node_mobile_flutter',
          'appVersion': '1.0.0',
          'platform': 'android-flutter',
          'port': _port,
          'operationId': op['operation_id'],
          'outboxCount': outbox.length,
          'pairingToken': tacticalPairingSecret,
        }));
        await response.close();
        return;
      }

      // 2. POST /api/v1/sync/bundle
      if (path == '/api/v1/sync/bundle' && request.method == 'POST') {
        final token = request.headers.value('X-PeerScribe-Auth');
        final bodyStr = await utf8.decodeStream(request);
        Map<String, dynamic> jsonBody = {};
        if (bodyStr.isNotEmpty) {
          jsonBody = json.decode(bodyStr) as Map<String, dynamic>;
        }

        final authHeaderOrBody = token ?? jsonBody['pairing_token'];
        if (authHeaderOrBody != tacticalPairingSecret) {
          response.statusCode = HttpStatus.unauthorized;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Unauthorized: Invalid tactical token'}));
          await response.close();
          return;
        }

        final incomingBundle = PeerScribeSyncBundle.fromMap(jsonBody);
        final ingestResult = await _syncManager.ingestBundle(incomingBundle);

        // Acknowledge incoming event IDs
        final ackedIds = incomingBundle.events.map((e) => e.eventId).toList();

        // Construct mobile outbox delta to return to peer
        final localOutboxBundle = await _syncManager.createOutboxBundle(localNodeId: 'node_mobile_flutter');

        // Track peer connection
        final remoteIp = request.connectionInfo?.remoteAddress.address ?? 'unknown';
        _pairedPeers[remoteIp] = {
          'peerId': incomingBundle.originNodeId,
          'host': remoteIp,
          'status': 'CONNECTED',
          'lastSyncAt': DateTime.now().toUtc().toIso8601String(),
        };
        _syncManager.updatePeerCount(_pairedPeers.length);

        response.statusCode = HttpStatus.ok;
        response.headers.contentType = ContentType.json;
        response.write(json.encode({
          'status': 'SUCCESS',
          'acknowledged_event_ids': ackedIds,
          'inserted_count': ingestResult['inserted_events'],
          'duplicate_count': ingestResult['duplicate_events'],
          'divergences_count': ingestResult['divergences_flagged'],
          'server_bundle': localOutboxBundle.toMap(),
        }));
        await response.close();
        return;
      }

      // 3. POST /api/v1/sync/ack
      if (path == '/api/v1/sync/ack' && request.method == 'POST') {
        final bodyStr = await utf8.decodeStream(request);
        if (bodyStr.isNotEmpty) {
          final ackData = json.decode(bodyStr) as Map<String, dynamic>;
          final acked = (ackData['acknowledged_event_ids'] as List?)?.cast<String>() ?? [];
          if (acked.isNotEmpty) {
            await _db.acknowledgeOutboxEvents(acked);
          }
        }
        response.statusCode = HttpStatus.ok;
        response.headers.contentType = ContentType.json;
        response.write(json.encode({'success': true}));
        await response.close();
        return;
      }

      response.statusCode = HttpStatus.notFound;
      response.write(json.encode({'error': 'Not found: $path'}));
      await response.close();
    } catch (err) {
      response.statusCode = HttpStatus.internalServerError;
      response.write(json.encode({'error': err.toString()}));
      await response.close();
    }
  }

  /// Synchronizes bidirectionally with a peer node (e.g. Electron desktop at 192.168.1.15:4323
  /// or emulator host at 10.0.2.2:4323) over local Wi-Fi / hotspot.
  Future<LanSyncResult> syncWithPeer(
    String peerAddress, {
    String token = tacticalPairingSecret,
  }) async {
    String cleanAddress = peerAddress.trim();
    if (!cleanAddress.startsWith('http://') && !cleanAddress.startsWith('https://')) {
      cleanAddress = 'http://$cleanAddress';
    }

    final outboxEvents = await _db.getOutbox();
    final outboxBundle = await _syncManager.createOutboxBundle(localNodeId: 'node_mobile_flutter');
    final outboxEventIds = outboxEvents.map((e) => e.eventId).toList();

    final client = HttpClient()..connectionTimeout = const Duration(seconds: 5);

    try {
      final uri = Uri.parse('$cleanAddress/api/v1/sync/bundle');
      final request = await client.postUrl(uri);
      request.headers.contentType = ContentType.json;
      request.headers.set('X-PeerScribe-Auth', token);

      final payloadStr = json.encode(outboxBundle.toMap());
      request.write(payloadStr);

      final response = await request.close().timeout(const Duration(seconds: 6));

      if (response.statusCode != HttpStatus.ok) {
        final errorText = await utf8.decodeStream(response);
        await _db.markOutboxAttemptFailed(outboxEventIds, reason: 'HTTP ${response.statusCode}');
        _pairedPeers[cleanAddress] = {
          'host': cleanAddress,
          'status': 'UNREACHABLE',
          'lastSyncAt': null,
        };
        return LanSyncResult(
          success: false,
          peerAddress: cleanAddress,
          errorMessage: 'Peer returned HTTP ${response.statusCode}: $errorText',
          timestamp: DateTime.now().toUtc().toIso8601String(),
        );
      }

      final responseBody = await utf8.decodeStream(response);
      final respData = json.decode(responseBody) as Map<String, dynamic>;

      // 1. Acknowledge verified outbox events
      final ackedIds = (respData['acknowledged_event_ids'] as List?)?.cast<String>() ?? [];
      if (ackedIds.isNotEmpty) {
        await _db.acknowledgeOutboxEvents(ackedIds);
      }

      // 2. Ingest inbound delta events from peer
      int inboundCount = 0;
      int divergencesFlagged = 0;
      if (respData['server_bundle'] != null) {
        final inboundBundle = PeerScribeSyncBundle.fromMap(respData['server_bundle'] as Map<String, dynamic>);
        final ingestResult = await _syncManager.ingestBundle(inboundBundle);
        inboundCount = ingestResult['inserted_events'] as int? ?? 0;
        divergencesFlagged = ingestResult['divergences_flagged'] as int? ?? 0;

        // Send ack back to peer
        if (inboundBundle.events.isNotEmpty) {
          try {
            final ackUri = Uri.parse('$cleanAddress/api/v1/sync/ack');
            final ackReq = await client.postUrl(ackUri);
            ackReq.headers.contentType = ContentType.json;
            ackReq.headers.set('X-PeerScribe-Auth', token);
            ackReq.write(json.encode({
              'acknowledged_event_ids': inboundBundle.events.map((e) => e.eventId).toList(),
            }));
            await ackReq.close();
          } catch (_) {}
        }
      }

      // 3. Update peer status tracking
      _pairedPeers[cleanAddress] = {
        'host': cleanAddress,
        'status': 'CONNECTED',
        'lastSyncAt': DateTime.now().toUtc().toIso8601String(),
        'eventsSent': outboxEvents.length,
        'eventsReceived': inboundCount,
      };
      _syncManager.updatePeerCount(_pairedPeers.length);

      return LanSyncResult(
        success: true,
        peerAddress: cleanAddress,
        eventsSent: outboxEvents.length,
        eventsReceived: inboundCount,
        divergencesFlagged: divergencesFlagged,
        timestamp: DateTime.now().toUtc().toIso8601String(),
      );
    } on SocketException catch (err) {
      await _db.markOutboxAttemptFailed(outboxEventIds, reason: err.message);
      _pairedPeers[cleanAddress] = {'host': cleanAddress, 'status': 'UNREACHABLE'};
      return LanSyncResult(
        success: false,
        peerAddress: cleanAddress,
        errorMessage: 'Network connection refused or host unreachable at $cleanAddress: ${err.message}',
        timestamp: DateTime.now().toUtc().toIso8601String(),
      );
    } on TimeoutException {
      await _db.markOutboxAttemptFailed(outboxEventIds, reason: 'Timeout');
      _pairedPeers[cleanAddress] = {'host': cleanAddress, 'status': 'TIMEOUT'};
      return LanSyncResult(
        success: false,
        peerAddress: cleanAddress,
        errorMessage: 'Sync timeout connecting to $cleanAddress after 6 seconds.',
        timestamp: DateTime.now().toUtc().toIso8601String(),
      );
    } catch (err) {
      await _db.markOutboxAttemptFailed(outboxEventIds, reason: err.toString());
      return LanSyncResult(
        success: false,
        peerAddress: cleanAddress,
        errorMessage: 'LAN sync failed: $err',
        timestamp: DateTime.now().toUtc().toIso8601String(),
      );
    } finally {
      client.close();
    }
  }

  /// Closes the embedded HTTP listener.
  Future<void> stopServer() async {
    if (_server != null) {
      await _server!.close(force: true);
      _server = null;
    }
  }
}
