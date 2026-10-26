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
const int defaultPairingPinTtlMs = 60 * 1000; // 60 seconds short pairing window
const int maxFailedPairingAttempts = 3;
const int pairingLockoutMs = 5 * 60 * 1000; // 5 minutes lockout after 3 failed attempts
const int handshakeTtlMs = 60 * 1000; // 60 seconds pending handshake TTL

final crypto_pkg.X25519 _x25519 = crypto_pkg.X25519();

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

/// Derives handshake keys from Diffie-Hellman shared secret and out-of-band PIN authorization
/// using standard RFC 5869 HKDF-SHA256.
Map<String, dynamic> deriveHandshakeKeys({
  required List<int> sharedDH,
  required List<int> clientNonce,
  required List<int> serverNonce,
  required String clientNodeId,
  required String serverNodeId,
  required String pairingPin,
}) {
  final salt = sha256.convert([...clientNonce, ...serverNonce]).bytes;
  final pinBytes = utf8.encode(pairingPin.trim());

  final confirmInfo = [...utf8.encode('PeerScribe-LAN-v2-Confirm-'), ...pinBytes];
  final confirmKey = hkdfSha256(ikm: sharedDH, salt: salt, info: confirmInfo, length: 32);

  final encInfo = [...utf8.encode('PeerScribe-LAN-v2-Enc-$clientNodeId-$serverNodeId-'), ...pinBytes];
  final sessionKey = hkdfSha256(ikm: sharedDH, salt: salt, info: encInfo, length: 32);

  final tokenInfo = [...utf8.encode('PeerScribe-LAN-v2-Auth-$clientNodeId-$serverNodeId-'), ...pinBytes];
  final sessionToken = hkdfSha256(ikm: sharedDH, salt: salt, info: tokenInfo, length: 32);

  final sas = sha256.convert([...sharedDH, ...salt]).toString().substring(0, 6).toUpperCase();

  return {
    'confirmKey': confirmKey,
    'sessionKey': sessionKey,
    'sessionToken': sessionToken,
    'sas': sas,
  };
}

/// Computes HMAC-SHA256 authentication proof for pairing confirmation.
List<int> computeAuthProof(List<int> confirmKey, String role, String handshakeId, String firstNodeId, String secondNodeId) {
  final data = utf8.encode('$role:$handshakeId:$firstNodeId:$secondNodeId');
  return Hmac(sha256, confirmKey).convert(data).bytes;
}

/// Constant-time byte array comparison to prevent timing side channels.
bool timingSafeEquals(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  int diff = 0;
  for (int i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff == 0;
}

/// Legacy derivation helper maintained for backwards compatibility.
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
/// - Authenticated, encrypted sessions over local Wi-Fi / Hotspot
/// - Ephemeral X25519 Diffie-Hellman + out-of-band PIN authorization
/// - Cryptographically verified peer identity and mutual HMAC-SHA256 proofs
/// - Short pairing PIN expiration, single-use PIN consumption, and failed-attempt lockout
/// - In-transit AES-256-GCM clinical payload encryption
/// - Mandatory session, token, peer ID, nonce replay, and timestamp validation on all protected routes
/// - Strict acknowledgement semantics (only transmitted durable events acknowledged)
/// - Anti-forgery protections preventing arbitrary outbox clearing
/// - DTN Store-and-Forward multi-hop propagation
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

  // Active Pairing PIN for incoming pairing requests (short TTL by default)
  String _activePairingPin = 'TACTICAL-${100000 + Random.secure().nextInt(900000)}';
  int _pairingPinExpiresAt = DateTime.now().millisecondsSinceEpoch + defaultPairingPinTtlMs;
  bool _pinConsumed = false;

  // Pending handshakes: handshakeId -> HandshakeDetails
  final Map<String, Map<String, dynamic>> _pendingHandshakes = {};

  // Failed attempts tracking: clientId -> { 'failedCount': int, 'lockedUntil': int }
  final Map<String, Map<String, dynamic>> _failedAttempts = {};

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
  String get pairingPin => _pinConsumed || DateTime.now().millisecondsSinceEpoch > _pairingPinExpiresAt ? '' : _activePairingPin;
  List<Map<String, dynamic>> get pairedPeers => _pairedPeers.values.toList();
  List<Map<String, dynamic>> get rejectedEventsLog => List.unmodifiable(_rejectedEventsLog);

  void setNodeId(String id) {
    _nodeId = id;
  }

  void clearClientSessions() {
    _clientSessions.clear();
  }

  String setPairingPin(String pin, {int ttlSeconds = 60}) {
    _activePairingPin = pin.trim();
    _pairingPinExpiresAt = DateTime.now().millisecondsSinceEpoch + (ttlSeconds * 1000);
    _pinConsumed = false;
    return _activePairingPin;
  }

  bool isPinActive() {
    return !_pinConsumed && DateTime.now().millisecondsSinceEpoch <= _pairingPinExpiresAt;
  }

  bool _isLockedOut(String clientId) {
    final rec = _failedAttempts[clientId];
    if (rec == null) return false;
    final lockedUntil = rec['lockedUntil'] as int? ?? 0;
    if (DateTime.now().millisecondsSinceEpoch < lockedUntil) return true;
    if (DateTime.now().millisecondsSinceEpoch >= lockedUntil && (rec['failedCount'] as int? ?? 0) >= maxFailedPairingAttempts) {
      _failedAttempts.remove(clientId);
    }
    return false;
  }

  void _recordFailedAttempt(String clientId) {
    final rec = _failedAttempts[clientId] ?? {'failedCount': 0, 'lockedUntil': 0};
    final count = (rec['failedCount'] as int? ?? 0) + 1;
    rec['failedCount'] = count;
    if (count >= maxFailedPairingAttempts) {
      rec['lockedUntil'] = DateTime.now().millisecondsSinceEpoch + pairingLockoutMs;
    }
    _failedAttempts[clientId] = rec;
  }

  void _resetFailedAttempts(String clientId) {
    _failedAttempts.remove(clientId);
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
      _port = _server!.port;
      _server!.listen(_handleIncomingRequest);
      return _port;
    } catch (_) {
      _server = await HttpServer.bind(InternetAddress.anyIPv4, 0);
      _port = _server!.port;
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
    final clientIp = request.connectionInfo?.remoteAddress.address ?? 'unknown';

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
      // Route: POST /api/v1/sync/pair-init
      // Step 1 of Authenticated Diffie-Hellman Handshake.
      // -----------------------------------------------------------------
      if (path == '/api/v1/sync/pair-init' && request.method == 'POST') {
        final clientNodeId = jsonBody['client_node_id'] as String?;
        final clientEphemeralPubBase64 = jsonBody['client_ephemeral_pub'] as String?;
        final clientNonceBase64 = jsonBody['client_nonce'] as String?;

        if (clientNodeId == null || clientEphemeralPubBase64 == null || clientNonceBase64 == null) {
          response.statusCode = HttpStatus.badRequest;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Missing required handshake initialization fields (client_node_id, client_ephemeral_pub, client_nonce)'}));
          await response.close();
          return;
        }

        if (_isLockedOut(clientNodeId) || _isLockedOut(clientIp)) {
          response.statusCode = HttpStatus.tooManyRequests;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Too many failed pairing attempts. Lockout in effect.'}));
          await response.close();
          return;
        }

        if (!isPinActive()) {
          response.statusCode = HttpStatus.unauthorized;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Pairing authorization window is closed or expired. Request a new PIN on the host device.'}));
          await response.close();
          return;
        }

        final clientPubBytes = base64.decode(clientEphemeralPubBase64);
        if (clientPubBytes.length != 32) {
          response.statusCode = HttpStatus.badRequest;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Malformed client_ephemeral_pub: must be 32 bytes base64'}));
          await response.close();
          return;
        }

        final serverEphemeral = await _x25519.newKeyPair();
        final serverPub = await serverEphemeral.extractPublicKey();
        final serverNonceBytes = List<int>.generate(32, (_) => Random.secure().nextInt(256));
        final clientNonceBytes = base64.decode(clientNonceBase64);

        final remotePublicKey = crypto_pkg.SimplePublicKey(clientPubBytes, type: crypto_pkg.KeyPairType.x25519);
        final sharedSecretKey = await _x25519.sharedSecretKey(keyPair: serverEphemeral, remotePublicKey: remotePublicKey);
        final sharedDH = await sharedSecretKey.extractBytes();

        final derived = deriveHandshakeKeys(
          sharedDH: sharedDH,
          clientNonce: clientNonceBytes,
          serverNonce: serverNonceBytes,
          clientNodeId: clientNodeId,
          serverNodeId: _nodeId,
          pairingPin: _activePairingPin,
        );

        final handshakeId = 'hs_${_uuid.v4()}';
        _pendingHandshakes[handshakeId] = {
          'handshakeId': handshakeId,
          'clientNodeId': clientNodeId,
          'clientIp': clientIp,
          'confirmKey': derived['confirmKey'],
          'sessionKey': derived['sessionKey'],
          'sessionToken': base64.encode(derived['sessionToken'] as List<int>),
          'sas': derived['sas'],
          'expiresAt': DateTime.now().millisecondsSinceEpoch + handshakeTtlMs,
        };

        response.statusCode = HttpStatus.ok;
        response.headers.contentType = ContentType.json;
        response.write(json.encode({
          'status': 'INITIATED',
          'handshake_id': handshakeId,
          'server_node_id': _nodeId,
          'server_ephemeral_pub': base64.encode(serverPub.bytes),
          'server_nonce': base64.encode(serverNonceBytes),
          'sas': derived['sas'],
          'expires_in_seconds': handshakeTtlMs ~/ 1000,
        }));
        await response.close();
        return;
      }

      // -----------------------------------------------------------------
      // Route: POST /api/v1/sync/pair-confirm
      // Step 2 of Authenticated Diffie-Hellman Handshake.
      // -----------------------------------------------------------------
      if (path == '/api/v1/sync/pair-confirm' && request.method == 'POST') {
        final handshakeId = jsonBody['handshake_id'] as String?;
        final clientNodeId = jsonBody['client_node_id'] as String?;
        final clientProofBase64 = jsonBody['client_proof'] as String?;

        if (handshakeId == null || clientNodeId == null || clientProofBase64 == null) {
          response.statusCode = HttpStatus.badRequest;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Missing required handshake confirmation fields (handshake_id, client_node_id, client_proof)'}));
          await response.close();
          return;
        }

        if (_isLockedOut(clientNodeId) || _isLockedOut(clientIp)) {
          response.statusCode = HttpStatus.tooManyRequests;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Too many failed pairing attempts. Lockout in effect.'}));
          await response.close();
          return;
        }

        final pending = _pendingHandshakes[handshakeId];
        if (pending == null || DateTime.now().millisecondsSinceEpoch > (pending['expiresAt'] as int)) {
          _pendingHandshakes.remove(handshakeId);
          response.statusCode = HttpStatus.unauthorized;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Handshake session expired or invalid. Please re-initiate pairing.'}));
          await response.close();
          return;
        }

        if (pending['clientNodeId'] != clientNodeId) {
          _recordFailedAttempt(clientNodeId);
          response.statusCode = HttpStatus.forbidden;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Forbidden: Client identity does not match handshake initialization'}));
          await response.close();
          return;
        }

        final confirmKey = pending['confirmKey'] as List<int>;
        final expectedClientProof = computeAuthProof(confirmKey, 'CLIENT-PROOF', handshakeId, clientNodeId, _nodeId);
        final providedProof = base64.decode(clientProofBase64);

        if (!timingSafeEquals(providedProof, expectedClientProof)) {
          _pendingHandshakes.remove(handshakeId);
          _recordFailedAttempt(clientNodeId);
          _recordFailedAttempt(clientIp);
          response.statusCode = HttpStatus.unauthorized;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Invalid pairing authorization proof.'}));
          await response.close();
          return;
        }

        final serverProof = computeAuthProof(confirmKey, 'SERVER-PROOF', handshakeId, _nodeId, clientNodeId);
        final sessionId = 'sess_${_uuid.v4()}';

        _activeSessions[sessionId] = {
          'sessionId': sessionId,
          'peerId': clientNodeId,
          'sessionKey': pending['sessionKey'],
          'sessionToken': pending['sessionToken'],
          'createdAt': DateTime.now().millisecondsSinceEpoch,
          'expiresAt': DateTime.now().millisecondsSinceEpoch + sessionTtlMs,
          'seenNonces': <String>{},
          'transmittedOutboxEventIds': <String>{},
        };

        _pendingHandshakes.remove(handshakeId);
        _resetFailedAttempts(clientNodeId);
        _resetFailedAttempts(clientIp);

        // Single-use PIN consumption: Immediately consume PIN
        _pinConsumed = true;
        _activePairingPin = '';

        response.statusCode = HttpStatus.ok;
        response.headers.contentType = ContentType.json;
        response.write(json.encode({
          'status': 'PAIRED',
          'session_id': sessionId,
          'server_proof': base64.encode(serverProof),
          'server_node_id': _nodeId,
          'expires_in_seconds': sessionTtlMs ~/ 1000,
        }));
        await response.close();
        return;
      }

      // Reject insecure plaintext PIN endpoint
      if (path == '/api/v1/sync/pair' && request.method == 'POST') {
        response.statusCode = HttpStatus.badRequest;
        response.headers.contentType = ContentType.json;
        response.write(json.encode({
          'error': 'Insecure pairing rejected: Plaintext pairing_pin transmission is prohibited. Use authenticated Diffie-Hellman handshake.'
        }));
        await response.close();
        return;
      }

      // -----------------------------------------------------------------
      // Session Authentication & Replay Protection Guard
      // Mandatory on EVERY protected route (/api/v1/sync/bundle, /api/v1/sync/ack)
      // -----------------------------------------------------------------
      final sessionId = request.headers.value('X-PeerScribe-Session');
      final sessionToken = request.headers.value('X-PeerScribe-Token');
      final claimedPeerId = request.headers.value('X-PeerScribe-Peer-Id');
      final requestNonce = request.headers.value('X-PeerScribe-Nonce');
      final requestTimestamp = request.headers.value('X-PeerScribe-Timestamp');

      if (path == '/api/v1/sync/bundle' || path == '/api/v1/sync/ack') {
        // 1. Mandatory header presence
        if (sessionId == null || sessionToken == null || claimedPeerId == null ||
            requestNonce == null || requestTimestamp == null ||
            sessionId.isEmpty || sessionToken.isEmpty || claimedPeerId.isEmpty ||
            requestNonce.isEmpty || requestTimestamp.isEmpty) {
          response.statusCode = HttpStatus.unauthorized;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Unauthorized: Missing mandatory authentication headers'}));
          await response.close();
          return;
        }

        // 2. Session existence and expiry
        final session = _activeSessions[sessionId];
        if (session == null || DateTime.now().millisecondsSinceEpoch > (session['expiresAt'] as int)) {
          response.statusCode = HttpStatus.unauthorized;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Unauthorized: Session not found or expired'}));
          await response.close();
          return;
        }

        // 3. Cryptographic peer identity binding
        if (session['peerId'] != claimedPeerId) {
          response.statusCode = HttpStatus.forbidden;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Forbidden: Claimed peer identity does not match authenticated session binding'}));
          await response.close();
          return;
        }

        // 4. Session token verification
        final expectedToken = session['sessionToken'] as String;
        if (!timingSafeEquals(utf8.encode(sessionToken), utf8.encode(expectedToken))) {
          response.statusCode = HttpStatus.unauthorized;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Unauthorized: Invalid session token'}));
          await response.close();
          return;
        }

        // 5. Clock skew verification (max 5 minutes)
        final reqTime = DateTime.tryParse(requestTimestamp)?.millisecondsSinceEpoch;
        if (reqTime == null || (DateTime.now().millisecondsSinceEpoch - reqTime).abs() > maxTimestampSkewMs) {
          response.statusCode = HttpStatus.badRequest;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Bad Request: Request timestamp is invalid or exceeds maximum allowable clock skew (5 min)'}));
          await response.close();
          return;
        }

        // 6. Anti-replay nonce verification
        final seenNonces = session['seenNonces'] as Set<String>;
        if (seenNonces.contains(requestNonce)) {
          response.statusCode = HttpStatus.conflict;
          response.headers.contentType = ContentType.json;
          response.write(json.encode({'error': 'Conflict: Replayed request nonce detected'}));
          await response.close();
          return;
        }
        seenNonces.add(requestNonce);
        if (seenNonces.length > 2000) {
          seenNonces.remove(seenNonces.first);
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

        // Ingest bundle returning explicit durable result
        final ingestResult = await _syncManager.ingestBundle(incomingBundle);
        _rejectedEventsLog.addAll(ingestResult.rejectedEvents);

        // Strict Invariant: Acknowledgements accumulated ONLY from verified durable entries
        final acknowledgedEventIds = [
          ...ingestResult.acceptedEventIds,
          ...ingestResult.duplicateEventIds,
        ];

        // Prepare server outbox delta for return to peer
        final allOutbox = await _db.getOutbox();
        final serverOutbox = allOutbox.where((e) => e.actorId != claimedPeerId).toList();

        // Anti-forgery tracking: Record all outbox event IDs transmitted to this session
        final transmitted = session['transmittedOutboxEventIds'] as Set<String>;
        for (final evt in serverOutbox) {
          transmitted.add(evt.eventId);
        }

        final responseBundle = PeerScribeSyncBundle(
          schemaVersion: 1,
          bundleId: 'bundle_${_uuid.v4()}',
          operationId: (await _db.getActiveOperation())['operation_id'] as String? ?? 'OP_TACTICAL',
          originNodeId: _nodeId,
          priority: 'CLINICAL_DELTA',
          createdAtUtc: DateTime.now().toUtc().toIso8601String(),
          vectorClock: const {},
          events: serverOutbox,
        );

        final encryptedServerBundle = await encryptPayload(responseBundle.toMap(), sessionKey);

        response.statusCode = HttpStatus.ok;
        response.headers.contentType = ContentType.json;
        response.write(json.encode({
          'status': 'SUCCESS',
          'acknowledged_event_ids': acknowledgedEventIds,
          'inserted_count': ingestResult.acceptedEventIds.length,
          'duplicate_count': ingestResult.duplicateEventIds.length,
          'divergences_count': ingestResult.divergencesFlagged,
          'encrypted_server_bundle': encryptedServerBundle,
        }));
        await response.close();
        return;
      }

      // -----------------------------------------------------------------
      // Route: POST /api/v1/sync/ack
      // Authenticated outbox acknowledgement with anti-forgery validation
      // -----------------------------------------------------------------
      if (path == '/api/v1/sync/ack' && request.method == 'POST') {
        final session = _activeSessions[sessionId!]!;
        final ackedIds = (jsonBody['acknowledged_event_ids'] as List?)?.cast<String>() ?? [];

        // Anti-forgery: Only remove events that were ACTUALLY transmitted to this peer in this session!
        final transmitted = session['transmittedOutboxEventIds'] as Set<String>;
        final verifiedAcks = ackedIds.where((id) => transmitted.contains(id)).toList();

        if (verifiedAcks.isNotEmpty) {
          await _db.acknowledgeOutboxEvents(verifiedAcks);
          for (final id in verifiedAcks) {
            transmitted.remove(id);
          }
        }

        final forgedCount = ackedIds.length - verifiedAcks.length;
        response.statusCode = HttpStatus.ok;
        response.headers.contentType = ContentType.json;
        response.write(json.encode({
          'success': true,
          'acknowledged': verifiedAcks.length,
          'rejected_forged': forgedCount,
        }));
        await response.close();
        return;
      }

      response.statusCode = HttpStatus.notFound;
      response.headers.contentType = ContentType.json;
      response.write(json.encode({'error': 'Not found: $path'}));
      await response.close();
    } catch (e) {
      response.statusCode = HttpStatus.internalServerError;
      response.headers.contentType = ContentType.json;
      response.write(json.encode({'error': e.toString()}));
      await response.close();
    }
  }

  /// Pairs with a remote peer using the authenticated Diffie-Hellman handshake.
  /// Transmits ephemeral public keys; the pairing PIN is NEVER sent over the wire!
  Future<Map<String, dynamic>> pairWithPeer(String peerAddress, String pairingPin) async {
    String cleanAddress = peerAddress.trim();
    if (!cleanAddress.startsWith('http://') && !cleanAddress.startsWith('https://')) {
      cleanAddress = 'http://$cleanAddress';
    }

    final client = HttpClient()..connectionTimeout = const Duration(seconds: 5);

    try {
      final clientEphemeral = await _x25519.newKeyPair();
      final clientPub = await clientEphemeral.extractPublicKey();
      final clientNonceBytes = List<int>.generate(32, (_) => Random.secure().nextInt(256));

      // Step 1: POST /api/v1/sync/pair-init
      final initUri = Uri.parse('$cleanAddress/api/v1/sync/pair-init');
      final initReq = await client.postUrl(initUri);
      initReq.headers.contentType = ContentType.json;

      final initBody = json.encode({
        'client_node_id': _nodeId,
        'client_ephemeral_pub': base64.encode(clientPub.bytes),
        'client_nonce': base64.encode(clientNonceBytes),
      });
      initReq.write(initBody);

      final initResp = await initReq.close().timeout(const Duration(seconds: 5));
      final initRespBody = await utf8.decodeStream(initResp);

      if (initResp.statusCode != HttpStatus.ok) {
        throw HttpException('Handshake init failed with HTTP ${initResp.statusCode}: $initRespBody');
      }

      final initData = json.decode(initRespBody) as Map<String, dynamic>;
      final serverPubBytes = base64.decode(initData['server_ephemeral_pub'] as String);
      final serverNonceBytes = base64.decode(initData['server_nonce'] as String);
      final handshakeId = initData['handshake_id'] as String;
      final serverNodeId = initData['server_node_id'] as String;

      // Step 2: Compute shared secret and derive keys
      final remotePubKey = crypto_pkg.SimplePublicKey(serverPubBytes, type: crypto_pkg.KeyPairType.x25519);
      final sharedSecretKey = await _x25519.sharedSecretKey(keyPair: clientEphemeral, remotePublicKey: remotePubKey);
      final sharedDH = await sharedSecretKey.extractBytes();

      final derived = deriveHandshakeKeys(
        sharedDH: sharedDH,
        clientNonce: clientNonceBytes,
        serverNonce: serverNonceBytes,
        clientNodeId: _nodeId,
        serverNodeId: serverNodeId,
        pairingPin: pairingPin,
      );

      final confirmKey = derived['confirmKey'] as List<int>;
      final clientProof = computeAuthProof(confirmKey, 'CLIENT-PROOF', handshakeId, _nodeId, serverNodeId);

      // Step 3: POST /api/v1/sync/pair-confirm
      final confirmUri = Uri.parse('$cleanAddress/api/v1/sync/pair-confirm');
      final confirmReq = await client.postUrl(confirmUri);
      confirmReq.headers.contentType = ContentType.json;

      final confirmBody = json.encode({
        'handshake_id': handshakeId,
        'client_node_id': _nodeId,
        'client_proof': base64.encode(clientProof),
      });
      confirmReq.write(confirmBody);

      final confirmResp = await confirmReq.close().timeout(const Duration(seconds: 5));
      final confirmRespBody = await utf8.decodeStream(confirmResp);

      if (confirmResp.statusCode != HttpStatus.ok) {
        throw HttpException('Handshake confirm failed with HTTP ${confirmResp.statusCode}: $confirmRespBody');
      }

      final confirmData = json.decode(confirmRespBody) as Map<String, dynamic>;
      final expectedServerProof = computeAuthProof(confirmKey, 'SERVER-PROOF', handshakeId, serverNodeId, _nodeId);
      final serverProof = base64.decode(confirmData['server_proof'] as String);

      if (!timingSafeEquals(serverProof, expectedServerProof)) {
        throw const HttpException('Peer identity verification failed: Server authentication proof mismatch');
      }

      final sessionCreds = {
        'sessionId': confirmData['session_id'],
        'sessionToken': base64.encode(derived['sessionToken'] as List<int>),
        'sessionKey': derived['sessionKey'] as List<int>,
        'serverNodeId': serverNodeId,
        'peerAddress': cleanAddress,
        'pairedAt': DateTime.now().millisecondsSinceEpoch,
        'sas': derived['sas'],
      };

      _clientSessions[cleanAddress] = sessionCreds;
      _clientSessions[serverNodeId] = sessionCreds;
      _pairedPeers[cleanAddress] = {
        'host': cleanAddress,
        'status': 'PAIRED',
        'lastSyncAt': DateTime.now().toUtc().toIso8601String(),
      };

      return sessionCreds;
    } finally {
      client.close();
    }
  }

  /// Synchronizes bidirectionally with a peer over an authenticated, encrypted session.
  Future<LanSyncResult> syncWithPeer(String peerAddress, {String? pairingPin}) async {
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
      } catch (e) {
        return LanSyncResult(
          success: false,
          peerAddress: cleanAddress,
          errorMessage: 'Pairing failed: $e',
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
        if (response.statusCode == HttpStatus.unauthorized) {
          _clientSessions.remove(cleanAddress);
        }
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

      // Strict Invariant: Only remove outbox events that were sent in this bundle AND confirmed by receiver
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

        final inboundResult = await _syncManager.ingestBundle(inboundBundle);
        inboundCount = inboundResult.acceptedEventIds.length;
        divergencesFlagged = inboundResult.divergencesFlagged;
        _rejectedEventsLog.addAll(inboundResult.rejectedEvents);

        // Send authenticated acknowledgement back to peer ONLY for durably accepted or duplicate events
        final clientAcks = [
          ...inboundResult.acceptedEventIds,
          ...inboundResult.duplicateEventIds,
        ];

        if (clientAcks.isNotEmpty) {
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
            ackReq.write(json.encode({'acknowledged_event_ids': clientAcks}));
            await ackReq.close();
          } catch (_) {}
        }
      }

      _pairedPeers[cleanAddress] = {
        'host': cleanAddress,
        'status': 'SYNCED',
        'lastSyncAt': DateTime.now().toUtc().toIso8601String(),
      };

      return LanSyncResult(
        success: true,
        peerAddress: cleanAddress,
        eventsSent: outboxEvents.length,
        eventsReceived: inboundCount,
        divergencesFlagged: divergencesFlagged,
        timestamp: DateTime.now().toUtc().toIso8601String(),
      );
    } catch (e) {
      return LanSyncResult(
        success: false,
        peerAddress: cleanAddress,
        errorMessage: e.toString(),
        timestamp: DateTime.now().toUtc().toIso8601String(),
      );
    } finally {
      client.close();
    }
  }

  Future<void> stopServer() async {
    if (_server != null) {
      await _server!.close(force: true);
      _server = null;
    }
  }
}
