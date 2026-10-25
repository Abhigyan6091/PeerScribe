import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:cryptography/cryptography.dart' as crypto_pkg;
import 'package:uuid/uuid.dart';
import '../protocol/event_model.dart';
import '../protocol/sync_bundle.dart';
import '../storage/database_helper.dart';
import 'sync_manager.dart';

const int defaultTacticalMobilePort = 4322;
const int maxRequestSizeBytes = 2 * 1024 * 1024; // 2 MB limit
const int maxEventsPerBundle = 500;
const int sessionTtlMs = 24 * 60 * 60 * 1000; // 24 hours
const int maxTimestampSkewMs = 5 * 60 * 1000; // 5 minutes

/// RFC 5869 HKDF-SHA256 Key Derivation
List<int> hkdfSha256({
  required List<int> ikm,
  required List<int> salt,
  required List<int> info,
  int length = 32,
}) {
  final prk = Hmac(sha256, salt).convert(ikm).bytes;
  final okm = Hmac(sha256, prk).convert([...info, 1]).bytes;
  return okm.sublist(0, length);
}

/// Derives 256-bit session key and 256-bit auth token from pairing PIN and mutual nonces.
Map<String, List<int>> deriveSessionKeys({
  required String pairingPin,
  required String clientNonceBase64,
  required String serverNonceBase64,
  required String clientNodeId,
  required String serverNodeId,
}) {
  final clientNonceBytes = base64.decode(clientNonceBase64);
  final serverNonceBytes = base64.decode(serverNonceBase64);
  final salt = sha256.convert([...clientNonceBytes, ...serverNonceBytes]).bytes;

  final infoKey = utf8.encode('PeerScribe-LAN-v1-Enc-$clientNodeId-$serverNodeId');
  final infoToken = utf8.encode('PeerScribe-LAN-v1-Auth-$clientNodeId-$serverNodeId');
  final pinBytes = utf8.encode(pairingPin);

  final sessionKey = hkdfSha256(ikm: pinBytes, salt: salt, info: infoKey, length: 32);
  final sessionToken = hkdfSha256(ikm: pinBytes, salt: salt, info: infoToken, length: 32);

  return {'sessionKey': sessionKey, 'sessionToken': sessionToken};
}

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
/// Implements standard AES-256-GCM authenticated encryption in transit,
/// dynamic pairing PIN handshakes with HKDF key derivation, session binding,
/// strict durable acknowledgement semantics, and replay protection.
class LanSyncService {
  static final LanSyncService _instance = LanSyncService._internal();
  factory LanSyncService() => _instance;
  LanSyncService._internal();

  final DatabaseHelper _db = DatabaseHelper();
  final SyncManager _syncManager = SyncManager();
  static final crypto_pkg.AesGcm _aesGcm = crypto_pkg.AesGcm.with256bits();
  static const Uuid _uuid = Uuid();

  HttpServer? _server;
  int _port = defaultTacticalMobilePort;
  String _nodeId = 'node_mobile_flutter';

  // Active Pairing PIN for incoming pairing requests
  String _activePairingPin = 'TACTICAL-${100000 + Random.secure().nextInt(900000)}';
  int _pairingPinExpiresAt = DateTime.now().millisecondsSinceEpoch + sessionTtlMs;

  // Active Sessions hosted on this server: sessionId -> SessionDetails
  final Map<String, Map<String, dynamic>> _activeSessions = {};

  // Client Sessions established with remote peers: peerAddress -> SessionCreds
  final Map<String, Map<String, dynamic>> _clientSessions = {};

  // Paired peers metadata list
  final Map<String, Map<String, dynamic>> _pairedPeers = {};

  // Audit log of rejected events for diagnostics without logging clinical payloads
  final List<Map<String, dynamic>> _rejectedEventsLog = [];

  int get port => _port;
  String get nodeId => _nodeId;
  bool get isListening => _server != null;
  String get pairingPin => _activePairingPin;
  List<Map<String, dynamic>> get pairedPeers => _pairedPeers.values.toList();
  List<Map<String, dynamic>> get rejectedEventsLog => List.unmodifiable(_rejectedEventsLog);

  void setNodeId(String id) {
    _nodeId = id;
  }

  String setPairingPin(String pin, {int ttlSeconds = 86400}) {
    _activePairingPin = pin.trim();
    _pairingPinExpiresAt = DateTime.now().millisecondsSinceEpoch + (ttlSeconds * 1000);
    return _activePairingPin;
  }

  /// Encrypts plaintext or object payload in transit using AES-256-GCM.
  Future<Map<String, String>> encryptPayload(dynamic data, List<int> keyBytes) async {
    final jsonStr = data is String ? data : json.encode(data);
    final plaintextBytes = utf8.encode(jsonStr);
    final secretKey = crypto_pkg.SecretKey(keyBytes);

    final secretBox = await _aesGcm.encrypt(plaintextBytes, secretKey: secretKey);
    return {
      'ciphertext': base64.encode(secretBox.cipherText),
      'iv': base64.encode(secretBox.nonce),
      'tag': base64.encode(secretBox.mac.bytes),
    };
  }

  /// Decrypts ciphertext in transit verifying 128-bit authentication tag.
  Future<dynamic> decryptPayload(Map<String, dynamic> encryptedObj, List<int> keyBytes) async {
    final ciphertextBase64 = encryptedObj['ciphertext'] as String?;
    final ivBase64 = encryptedObj['iv'] as String?;
    final tagBase64 = (encryptedObj['tag'] ?? encryptedObj['auth_tag']) as String?;

    if (ciphertextBase64 == null || ivBase64 == null || tagBase64 == null) {
      throw const FormatException('Missing required fields in encrypted payload (iv, tag, ciphertext)');
    }

    final secretBox = crypto_pkg.SecretBox(
      base64.decode(ciphertextBase64),
      nonce: base64.decode(ivBase64),
      mac: crypto_pkg.Mac(base64.decode(tagBase64)),
    );

    final secretKey = crypto_pkg.SecretKey(keyBytes);
    final decryptedBytes = await _aesGcm.decrypt(secretBox, secretKey: secretKey);
    return json.decode(utf8.decode(decryptedBytes));
  }

  /// Starts the embedded tactical HTTP server on the mobile device.
  Future<int> startServer({int port = defaultTacticalMobilePort}) async {
    if (_server != null) return _port;
    _port = port;

    try {
      _server = await HttpServer.bind(InternetAddress.anyIPv4, _port);
      _server!.listen(_handleIncomingRequest);
      return _port;
    } catch (_) {
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
    response.headers.set('Access-Control-Allow-Headers',
      'Content-Type, X-PeerScribe-Session, X-PeerScribe-Token, X-PeerScribe-Peer-Id, X-PeerScribe-Nonce, X-PeerScribe-Timestamp');

    if (request.method == 'OPTIONS') {
      response.statusCode = HttpStatus.noContent;
      await response.close();
      return;
    }

    final path = request.uri.path;

    try {
      // Enforce 2 MB maximum payload limit
      if (request.contentLength > maxRequestSizeBytes) {
        response.statusCode = HttpStatus.requestEntityTooLarge;
        response.headers.contentType = ContentType.json;
        response.write(json.encode({'error': 'Payload Too Large: Exceeds 2 MB limit'}));
        await response.close();
        return;
      }

      // -----------------------------------------------------------------
      // Route: GET /api/v1/sync/info
      // Returns safe discovery metadata only; NEVER exposes secrets or tokens!
      // -----------------------------------------------------------------
      if (path == '/api/v1/sync/info' && request.method == 'GET') {
        final outbox = await _db.getOutbox();
        final op = await _db.getActiveOperation();
        response.headers.contentType = ContentType.json;
        response.write(json.encode({
          'status': 'OK',
          'nodeId': _nodeId,
          'appVersion': '1.0.0',
          'platform': 'android-flutter',
          'port': _port,
          'operationId': op['operation_id'],
          'outboxCount': outbox.length,
          'requiresPairing': true,
        }));
        await response.close();
        return;
      }

      // Read request body with size bounds
      final bodyBytes = <int>[];
      await for (final chunk in request) {
        bodyBytes.addAll(chunk);
        if (bodyBytes.length > maxRequestSizeBytes) {
          response.statusCode = HttpStatus.requestEntityTooLarge;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Payload Too Large: Exceeds 2 MB limit'}));
          await response.close();
          return;
        }
      }

      Map<String, dynamic> jsonBody = {};
      if (bodyBytes.isNotEmpty) {
        try {
          jsonBody = json.decode(utf8.decode(bodyBytes)) as Map<String, dynamic>;
        } catch (_) {
          response.statusCode = HttpStatus.badRequest;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Malformed JSON payload'}));
          await response.close();
          return;
        }
      }

      // -----------------------------------------------------------------
      // Route: POST /api/v1/sync/pair
      // Explicit pairing handshake via PIN with mutual nonces & HKDF derivation
      // -----------------------------------------------------------------
      if (path == '/api/v1/sync/pair' && request.method == 'POST') {
        final clientNodeId = jsonBody['client_node_id'] as String?;
        final providedPin = jsonBody['pairing_pin'] as String?;
        final clientNonce = jsonBody['client_nonce'] as String?;

        if (clientNodeId == null || providedPin == null || clientNonce == null) {
          response.statusCode = HttpStatus.badRequest;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Missing required pairing fields (client_node_id, pairing_pin, client_nonce)'}));
          await response.close();
          return;
        }

        if (DateTime.now().millisecondsSinceEpoch > _pairingPinExpiresAt) {
          response.statusCode = HttpStatus.unauthorized;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Pairing PIN expired. Request a fresh PIN from the host device.'}));
          await response.close();
          return;
        }

        if (providedPin.trim() != _activePairingPin.trim()) {
          response.statusCode = HttpStatus.unauthorized;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Invalid pairing PIN'}));
          await response.close();
          return;
        }

        final serverNonceBytes = List<int>.generate(32, (_) => Random.secure().nextInt(256));
        final serverNonce = base64.encode(serverNonceBytes);
        final sessionId = 'sess_${_uuid.v4()}';

        final derived = deriveSessionKeys(
          pairingPin: providedPin.trim(),
          clientNonceBase64: clientNonce,
          serverNonceBase64: serverNonce,
          clientNodeId: clientNodeId,
          serverNodeId: _nodeId,
        );

        _activeSessions[sessionId] = {
          'sessionId': sessionId,
          'peerId': clientNodeId,
          'sessionKey': derived['sessionKey']!,
          'sessionToken': base64.encode(derived['sessionToken']!),
          'createdAt': DateTime.now().millisecondsSinceEpoch,
          'expiresAt': DateTime.now().millisecondsSinceEpoch + sessionTtlMs,
          'seenNonces': <String>{},
        };

        response.statusCode = HttpStatus.ok;
        response.headers.contentType = ContentType.json;
        response.write(json.encode({
          'status': 'PAIRED',
          'session_id': sessionId,
          'session_token': base64.encode(derived['sessionToken']!),
          'server_nonce': serverNonce,
          'server_node_id': _nodeId,
          'expires_in_seconds': sessionTtlMs ~/ 1000,
        }));
        await response.close();
        return;
      }

      // -----------------------------------------------------------------
      // Session Authentication Guard for Bundle and Ack routes
      // -----------------------------------------------------------------
      final sessionId = request.headers.value('X-PeerScribe-Session');
      final sessionToken = request.headers.value('X-PeerScribe-Token');
      final claimedPeerId = request.headers.value('X-PeerScribe-Peer-Id');
      final requestNonce = request.headers.value('X-PeerScribe-Nonce');
      final requestTimestamp = request.headers.value('X-PeerScribe-Timestamp');

      if (path == '/api/v1/sync/bundle' || path == '/api/v1/sync/ack') {
        if (sessionId == null || sessionToken == null || claimedPeerId == null) {
          response.statusCode = HttpStatus.unauthorized;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Unauthorized: Missing session authentication headers'}));
          await response.close();
          return;
        }

        final session = _activeSessions[sessionId];
        if (session == null || DateTime.now().millisecondsSinceEpoch > (session['expiresAt'] as int)) {
          response.statusCode = HttpStatus.unauthorized;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Unauthorized: Session not found or expired'}));
          await response.close();
          return;
        }

        // Session binding check: claimed peer ID must match paired peer ID
        if (session['peerId'] != claimedPeerId) {
          response.statusCode = HttpStatus.forbidden;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Forbidden: Claimed peer identity does not match authenticated session binding'}));
          await response.close();
          return;
        }

        // Verify session token
        if (session['sessionToken'] != sessionToken) {
          response.statusCode = HttpStatus.unauthorized;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Unauthorized: Invalid session token'}));
          await response.close();
          return;
        }

        // Replay and clock skew verification
        if (requestTimestamp != null) {
          final reqTime = DateTime.tryParse(requestTimestamp)?.millisecondsSinceEpoch;
          if (reqTime == null || (DateTime.now().millisecondsSinceEpoch - reqTime).abs() > maxTimestampSkewMs) {
            response.statusCode = HttpStatus.badRequest;
            response.headers.contentType = ContentType.json;
            response.write(json.encode({'error': 'Request timestamp is invalid or exceeds maximum allowable clock skew'}));
            await response.close();
            return;
          }
        }

        if (requestNonce != null) {
          final seenNonces = session['seenNonces'] as Set<String>;
          if (seenNonces.contains(requestNonce)) {
            response.statusCode = HttpStatus.conflict;
            response.headers.contentType = ContentType.json;
            response.write(json.encode({'error': 'Conflict: Replayed request nonce detected'}));
            await response.close();
            return;
          }
          seenNonces.add(requestNonce);
          if (seenNonces.length > 1000) {
            seenNonces.remove(seenNonces.first);
          }
        }
      }

      // -----------------------------------------------------------------
      // Route: POST /api/v1/sync/bundle
      // Encrypted in-transit bundle ingestion with strict durable ack semantics
      // -----------------------------------------------------------------
      if (path == '/api/v1/sync/bundle' && request.method == 'POST') {
        final session = _activeSessions[sessionId!]!;
        final sessionKey = session['sessionKey'] as List<int>;

        final encryptedPayload = jsonBody['encrypted_payload'] as Map<String, dynamic>?;
        if (encryptedPayload == null) {
          response.statusCode = HttpStatus.badRequest;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Encrypted payload required for clinical sync in transit'}));
          await response.close();
          return;
        }

        Map<String, dynamic> decryptedBundleJson;
        try {
          final decryptedObj = await decryptPayload(encryptedPayload, sessionKey);
          decryptedBundleJson = decryptedObj as Map<String, dynamic>;
        } catch (decErr) {
          response.statusCode = HttpStatus.badRequest;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Decryption or authentication tag verification failed: $decErr'}));
          await response.close();
          return;
        }

        final incomingBundle = PeerScribeSyncBundle.fromMap(decryptedBundleJson);

        if (incomingBundle.events.length > maxEventsPerBundle) {
          response.statusCode = HttpStatus.badRequest;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Bundle exceeds maximum event limit ($maxEventsPerBundle)'}));
          await response.close();
          return;
        }

        // P0-3: Strict durable acknowledgement semantics
        final acknowledgedEventIds = <String>[];
        final validEvents = <PeerScribeEvent>[];
        int duplicateCount = 0;

        for (final evt in incomingBundle.events) {
          // Rule 1: Validate schema before acceptance
          if (evt.schemaVersion != 1 || evt.eventId.isEmpty || evt.entityId.isEmpty || evt.eventType.isEmpty || evt.occurredAtUtc.isEmpty) {
            _rejectedEventsLog.add({
              'event_id': evt.eventId,
              'reason': 'Schema validation failed (missing mandatory fields or invalid schema_version)',
              'rejected_at_utc': DateTime.now().toUtc().toIso8601String(),
            });
            continue; // Rule 3: Rejected events are NOT acknowledged!
          }

          // Rule 7: Duplicate valid events can be acknowledged after their existing durable copy is verified
          final existing = await _db.getEventById(evt.eventId);
          if (existing != null) {
            duplicateCount++;
            acknowledgedEventIds.add(evt.eventId);
            continue;
          }

          validEvents.add(evt);
        }

        // Rule 2 & 4: Durable persistence required before acknowledgement
        int insertedCount = 0;
        int divergencesCount = 0;
        if (validEvents.isNotEmpty) {
          try {
            final validBundle = PeerScribeSyncBundle(
              schemaVersion: incomingBundle.schemaVersion,
              bundleId: incomingBundle.bundleId,
              operationId: incomingBundle.operationId,
              originNodeId: incomingBundle.originNodeId,
              priority: incomingBundle.priority,
              createdAtUtc: incomingBundle.createdAtUtc,
              vectorClock: incomingBundle.vectorClock,
              events: validEvents,
            );
            final ingestResult = await _syncManager.ingestBundle(validBundle);
            insertedCount = ingestResult['inserted_events'] as int? ?? 0;
            divergencesCount = ingestResult['divergences_flagged'] as int? ?? 0;

            for (final evt in validEvents) {
              acknowledgedEventIds.add(evt.eventId);
            }
          } catch (dbErr) {
            // Rule 4: Database failure results in NO successful acknowledgement for affected events
            _rejectedEventsLog.add({
              'event_id': 'batch_persistence_error',
              'reason': 'Database persistence error: $dbErr',
              'rejected_at_utc': DateTime.now().toUtc().toIso8601String(),
            });
          }
        }

        // Prepare local outbox delta bundle to return to peer
        final localOutboxBundle = await _syncManager.createOutboxBundle(localNodeId: _nodeId);
        final encryptedServerBundle = await encryptPayload(localOutboxBundle.toMap(), sessionKey);

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
          'acknowledged_event_ids': acknowledgedEventIds,
          'inserted_count': insertedCount,
          'duplicate_count': duplicateCount,
          'divergences_count': divergencesCount,
          'encrypted_server_bundle': encryptedServerBundle,
        }));
        await response.close();
        return;
      }

      // -----------------------------------------------------------------
      // Route: POST /api/v1/sync/ack
      // Authenticated outbox acknowledgement
      // -----------------------------------------------------------------
      if (path == '/api/v1/sync/ack' && request.method == 'POST') {
        final acked = (jsonBody['acknowledged_event_ids'] as List?)?.cast<String>() ?? [];
        if (acked.isNotEmpty) {
          await _db.acknowledgeOutboxEvents(acked);
        }
        response.statusCode = HttpStatus.ok;
        response.headers.contentType = ContentType.json;
        response.write(json.encode({'success': true, 'acknowledged': acked.length}));
        await response.close();
        return;
      }

      response.statusCode = HttpStatus.notFound;
      response.headers.contentType = ContentType.json;
      response.write(json.encode({'error': 'Not found: $path'}));
      await response.close();
    } catch (err) {
      response.statusCode = HttpStatus.internalServerError;
      response.headers.contentType = ContentType.json;
      response.write(json.encode({'error': err.toString()}));
      await response.close();
    }
  }

  /// Pairs with a remote peer node using pairing PIN handshake.
  Future<Map<String, dynamic>> pairWithPeer(String peerAddress, String pairingPin) async {
    String cleanAddress = peerAddress.trim();
    if (!cleanAddress.startsWith('http://') && !cleanAddress.startsWith('https://')) {
      cleanAddress = 'http://$cleanAddress';
    }

    final clientNonceBytes = List<int>.generate(32, (_) => Random.secure().nextInt(256));
    final clientNonce = base64.encode(clientNonceBytes);

    final client = HttpClient()..connectionTimeout = const Duration(seconds: 5);
    try {
      final pairUri = Uri.parse('$cleanAddress/api/v1/sync/pair');
      final req = await client.postUrl(pairUri);
      req.headers.contentType = ContentType.json;
      req.write(json.encode({
        'client_node_id': _nodeId,
        'pairing_pin': pairingPin.trim(),
        'client_nonce': clientNonce,
      }));

      final res = await req.close().timeout(const Duration(seconds: 5));
      final respBody = await utf8.decodeStream(res);

      if (res.statusCode != HttpStatus.ok) {
        throw HttpException('Pairing failed with HTTP ${res.statusCode}: $respBody');
      }

      final data = json.decode(respBody) as Map<String, dynamic>;
      final derived = deriveSessionKeys(
        pairingPin: pairingPin.trim(),
        clientNonceBase64: clientNonce,
        serverNonceBase64: data['server_nonce'] as String,
        clientNodeId: _nodeId,
        serverNodeId: data['server_node_id'] as String,
      );

      final sessionCreds = {
        'sessionId': data['session_id'] as String,
        'sessionToken': base64.encode(derived['sessionToken']!),
        'sessionKey': derived['sessionKey']!,
        'serverNodeId': data['server_node_id'] as String,
        'peerAddress': cleanAddress,
        'pairedAt': DateTime.now().millisecondsSinceEpoch,
      };

      _clientSessions[cleanAddress] = sessionCreds;
      _clientSessions[data['server_node_id'] as String] = sessionCreds;
      return sessionCreds;
    } finally {
      client.close();
    }
  }

  /// Synchronizes bidirectionally with a peer node over an authenticated, encrypted session.
  Future<LanSyncResult> syncWithPeer(
    String peerAddress, {
    String? pairingPin,
  }) async {
    String cleanAddress = peerAddress.trim();
    if (!cleanAddress.startsWith('http://') && !cleanAddress.startsWith('https://')) {
      cleanAddress = 'http://$cleanAddress';
    }

    Map<String, dynamic>? session = _clientSessions[cleanAddress];
    if (session == null) {
      if (pairingPin == null || pairingPin.isEmpty) {
        return LanSyncResult(
          success: false,
          peerAddress: cleanAddress,
          errorMessage: 'Cannot synchronize with unpaired peer $cleanAddress without a pairing PIN',
          timestamp: DateTime.now().toUtc().toIso8601String(),
        );
      }
      try {
        session = await pairWithPeer(cleanAddress, pairingPin);
      } catch (err) {
        return LanSyncResult(
          success: false,
          peerAddress: cleanAddress,
          errorMessage: 'Pairing handshake failed: $err',
          timestamp: DateTime.now().toUtc().toIso8601String(),
        );
      }
    }

    final outboxEvents = await _db.getOutbox();
    final outboxBundle = await _syncManager.createOutboxBundle(localNodeId: _nodeId);
    final outboxEventIds = outboxEvents.map((e) => e.eventId).toList();

    final sessionKey = session['sessionKey'] as List<int>;
    final sessionId = session['sessionId'] as String;
    final sessionToken = session['sessionToken'] as String;

    final client = HttpClient()..connectionTimeout = const Duration(seconds: 5);

    try {
      // Encrypt bundle payload in transit
      final encryptedPayload = await encryptPayload(outboxBundle.toMap(), sessionKey);
      final nonceBytes = List<int>.generate(16, (_) => Random.secure().nextInt(256));
      final nonce = base64.encode(nonceBytes);
      final timestamp = DateTime.now().toUtc().toIso8601String();

      final uri = Uri.parse('$cleanAddress/api/v1/sync/bundle');
      final request = await client.postUrl(uri);
      request.headers.contentType = ContentType.json;
      request.headers.set('X-PeerScribe-Session', sessionId);
      request.headers.set('X-PeerScribe-Token', sessionToken);
      request.headers.set('X-PeerScribe-Peer-Id', _nodeId);
      request.headers.set('X-PeerScribe-Nonce', nonce);
      request.headers.set('X-PeerScribe-Timestamp', timestamp);

      final requestBody = json.encode({
        'session_id': sessionId,
        'sender_node_id': _nodeId,
        'encrypted_payload': encryptedPayload,
      });
      request.write(requestBody);

      final response = await request.close().timeout(const Duration(seconds: 6));

      if (response.statusCode != HttpStatus.ok) {
        final errorText = await utf8.decodeStream(response);
        // P0-3: Network or server error -> outbox NOT cleared, attempt logged
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

      // P0-3 Rule 5 & 6: Only remove outbox events that were actually acknowledged and sent in this bundle
      final returnedAcks = (respData['acknowledged_event_ids'] as List?)?.cast<String>() ?? [];
      final verifiedAcks = returnedAcks.where((id) => outboxEventIds.contains(id)).toList();
      if (verifiedAcks.isNotEmpty) {
        await _db.acknowledgeOutboxEvents(verifiedAcks);
      }

      // Ingest peer delta events
      int inboundCount = 0;
      int divergencesFlagged = 0;
      final peerEncrypted = respData['encrypted_server_bundle'] as Map<String, dynamic>?;

      if (peerEncrypted != null) {
        final decryptedObj = await decryptPayload(peerEncrypted, sessionKey);
        final inboundBundle = PeerScribeSyncBundle.fromMap(decryptedObj as Map<String, dynamic>);

        final acceptedByClient = <String>[];
        final validInboundEvents = <PeerScribeEvent>[];

        for (final evt in inboundBundle.events) {
          if (evt.schemaVersion == 1 && evt.eventId.isNotEmpty && evt.entityId.isNotEmpty && evt.eventType.isNotEmpty) {
            validInboundEvents.add(evt);
          }
        }

        if (validInboundEvents.isNotEmpty) {
          final validBundle = PeerScribeSyncBundle(
            schemaVersion: inboundBundle.schemaVersion,
            bundleId: inboundBundle.bundleId,
            operationId: inboundBundle.operationId,
            originNodeId: inboundBundle.originNodeId,
            priority: inboundBundle.priority,
            createdAtUtc: inboundBundle.createdAtUtc,
            vectorClock: inboundBundle.vectorClock,
            events: validInboundEvents,
          );
          final ingestResult = await _syncManager.ingestBundle(validBundle);
          inboundCount = ingestResult['inserted_events'] as int? ?? 0;
          divergencesFlagged = ingestResult['divergences_flagged'] as int? ?? 0;
          for (final evt in validInboundEvents) {
            acceptedByClient.add(evt.eventId);
          }
        }

        // Send authenticated acknowledgement back to peer for accepted events
        if (acceptedByClient.isNotEmpty) {
          try {
            final ackUri = Uri.parse('$cleanAddress/api/v1/sync/ack');
            final ackReq = await client.postUrl(ackUri);
            final ackNonce = base64.encode(List<int>.generate(16, (_) => Random.secure().nextInt(256)));
            ackReq.headers.contentType = ContentType.json;
            ackReq.headers.set('X-PeerScribe-Session', sessionId);
            ackReq.headers.set('X-PeerScribe-Token', sessionToken);
            ackReq.headers.set('X-PeerScribe-Peer-Id', _nodeId);
            ackReq.headers.set('X-PeerScribe-Nonce', ackNonce);
            ackReq.headers.set('X-PeerScribe-Timestamp', DateTime.now().toUtc().toIso8601String());
            ackReq.write(json.encode({'acknowledged_event_ids': acceptedByClient}));
            await ackReq.close();
          } catch (_) {}
        }
      }

      // Update peer status tracking
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
