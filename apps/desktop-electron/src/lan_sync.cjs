const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');

const DEFAULT_SYNC_PORT = 4323;
const MAX_REQUEST_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB limit
const MAX_EVENTS_PER_BUNDLE = 500;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_PAIRING_PIN_TTL_MS = 60 * 1000; // 60 seconds short pairing window
const MAX_FAILED_PAIRING_ATTEMPTS = 3;
const PAIRING_LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes lockout after 3 failed attempts
const HANDSHAKE_TTL_MS = 60 * 1000; // 60 seconds pending handshake TTL

/**
 * Standard Authenticated Encryption helper using AES-256-GCM (NIST SP 800-38D).
 */
function encryptPayload(dataObj, keyBuffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  const jsonStr = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj);
  const ciphertext = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  };
}

function decryptPayload(encryptedObj, keyBuffer) {
  if (!encryptedObj || !encryptedObj.ciphertext || !encryptedObj.iv || (!encryptedObj.tag && !encryptedObj.auth_tag)) {
    throw new Error('Invalid encrypted payload structure');
  }
  const iv = Buffer.from(encryptedObj.iv, 'base64');
  const tag = Buffer.from(encryptedObj.tag || encryptedObj.auth_tag, 'base64');
  const ciphertext = Buffer.from(encryptedObj.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

/**
 * Generates an ephemeral X25519 keypair for Perfect Forward Secrecy (PFS).
 */
function generateX25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)
  };
}

/**
 * Computes raw X25519 Diffie-Hellman shared secret (32 bytes).
 */
function computeX25519DH(ourPriv32, theirPub32) {
  const privKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), ourPriv32]),
    format: 'der',
    type: 'pkcs8'
  });
  const pubKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), theirPub32]),
    format: 'der',
    type: 'spki'
  });
  return crypto.diffieHellman({ privateKey: privKey, publicKey: pubKey });
}

/**
 * Derives handshake keys from Diffie-Hellman shared secret and out-of-band PIN authorization
 * using standard RFC 5869 HKDF-SHA256.
 */
function deriveHandshakeKeys(sharedDH, clientNonce, serverNonce, clientNodeId, serverNodeId, pairingPin) {
  const cNonceBuf = Buffer.isBuffer(clientNonce) ? clientNonce : Buffer.from(clientNonce, 'base64');
  const sNonceBuf = Buffer.isBuffer(serverNonce) ? serverNonce : Buffer.from(serverNonce, 'base64');
  const salt = crypto.createHash('sha256').update(Buffer.concat([cNonceBuf, sNonceBuf])).digest();

  const pinBuf = Buffer.from(String(pairingPin).trim(), 'utf8');

  // RFC 5869 HKDF-Extract & HKDF-Expand with sharedDH as IKM
  const confirmInfo = Buffer.concat([Buffer.from('PeerScribe-LAN-v2-Confirm-', 'utf8'), pinBuf]);
  const confirmKey = Buffer.from(crypto.hkdfSync('sha256', sharedDH, salt, confirmInfo, 32));

  const encInfo = Buffer.concat([
    Buffer.from(`PeerScribe-LAN-v2-Enc-${clientNodeId}-${serverNodeId}-`, 'utf8'),
    pinBuf
  ]);
  const sessionKey = Buffer.from(crypto.hkdfSync('sha256', sharedDH, salt, encInfo, 32));

  const tokenInfo = Buffer.concat([
    Buffer.from(`PeerScribe-LAN-v2-Auth-${clientNodeId}-${serverNodeId}-`, 'utf8'),
    pinBuf
  ]);
  const sessionToken = Buffer.from(crypto.hkdfSync('sha256', sharedDH, salt, tokenInfo, 32));

  // Truncated Short Authentication String (SAS) fingerprint
  const sas = crypto.createHash('sha256')
    .update(Buffer.concat([sharedDH, salt]))
    .digest('hex')
    .substring(0, 6)
    .toUpperCase();

  return { confirmKey, sessionKey, sessionToken, sas };
}

/**
 * Computes HMAC-SHA256 authentication proof for pairing confirmation.
 */
function computeAuthProof(confirmKey, role, handshakeId, firstNodeId, secondNodeId) {
  const data = Buffer.from(`${role}:${handshakeId}:${firstNodeId}:${secondNodeId}`, 'utf8');
  return crypto.createHmac('sha256', confirmKey).update(data).digest();
}

/**
 * Legacy key derivation helper maintained for backwards compatibility.
 */
function deriveSessionKeys(pairingPin, clientNonce, serverNonce, clientNodeId, serverNodeId) {
  const salt = crypto.createHash('sha256').update(Buffer.concat([
    Buffer.from(clientNonce, 'base64'),
    Buffer.from(serverNonce, 'base64')
  ])).digest();

  const infoKey = Buffer.from(`PeerScribe-LAN-v1-Enc-${clientNodeId}-${serverNodeId}`, 'utf8');
  const infoToken = Buffer.from(`PeerScribe-LAN-v1-Auth-${clientNodeId}-${serverNodeId}`, 'utf8');

  const sessionKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(pairingPin, 'utf8'), salt, infoKey, 32));
  const sessionToken = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(pairingPin, 'utf8'), salt, infoToken, 32));

  return { sessionKey, sessionToken };
}

/**
 * Real Cross-Platform LAN Synchronization Server and Client for PeerScribe Desktop.
 * - Authenticated, encrypted sessions over local Wi-Fi / Hotspot
 * - Ephemeral X25519 Diffie-Hellman + out-of-band PIN authorization
 * - Cryptographically verified peer identity and mutual HMAC-SHA256 proofs
 * - Short pairing PIN expiration, single-use PIN consumption, and failed-attempt lockout
 * - In-transit AES-256-GCM clinical payload encryption
 * - Mandatory session, token, peer ID, nonce replay, and timestamp validation on all protected routes
 * - Strict acknowledgement semantics (only transmitted durable events acknowledged)
 * - Anti-forgery protections preventing arbitrary outbox clearing
 * - DTN Store-and-Forward multi-hop propagation
 */
class LanSyncService {
  constructor(options = {}) {
    this.port = options.port || DEFAULT_SYNC_PORT;
    this.nodeId = options.nodeId || `node_desktop_${crypto.randomBytes(4).toString('hex')}`;
    this.getState = options.getState || (() => ({ eventsLog: [], outboxQueue: [], activeOperation: {} }));
    this.onEventsIngested = options.onEventsIngested || (() => 0);
    this.onOutboxAcknowledged = options.onOutboxAcknowledged || (() => {});

    // Active Pairing PIN for incoming pairing requests (short TTL by default)
    const pinTtlSeconds = options.pinTtlSeconds || (DEFAULT_PAIRING_PIN_TTL_MS / 1000);
    this.activePairingPin = options.pairingPin || 'TACTICAL-' + crypto.randomInt(100000, 999999).toString();
    this.pairingPinExpiresAt = Date.now() + (pinTtlSeconds * 1000);
    this.pinConsumed = false;

    this.server = null;
    // Map: handshakeId -> { handshakeId, clientNodeId, confirmKey, sessionKey, sessionToken, sas, expiresAt }
    this.pendingHandshakes = new Map();
    // Map: clientId / ip -> { failedCount, lockedUntil }
    this.failedAttempts = new Map();
    // Map: sessionId -> { sessionId, peerId, sessionKey, sessionToken, createdAt, expiresAt, seenNonces, transmittedOutboxEventIds }
    this.activeSessions = new Map();
    // Map: peerAddress / peerId -> active session credentials for client requests
    this.clientSessions = new Map();
    // Audit log of rejected events for diagnostics without logging clinical payloads
    this.rejectedEventsLog = [];
  }

  setPairingPin(pin, ttlSeconds = 60) {
    this.activePairingPin = String(pin).trim();
    this.pairingPinExpiresAt = Date.now() + (ttlSeconds * 1000);
    this.pinConsumed = false;
    return this.activePairingPin;
  }

  getPairingPin() {
    if (this.pinConsumed || Date.now() > this.pairingPinExpiresAt) {
      return null;
    }
    return this.activePairingPin;
  }

  isPinActive() {
    return !this.pinConsumed && Date.now() <= this.pairingPinExpiresAt;
  }

  getLocalIpAddresses() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          addresses.push(iface.address);
        }
      }
    }
    return addresses.length > 0 ? addresses : ['127.0.0.1'];
  }

  _isLockedOut(clientId) {
    const rec = this.failedAttempts.get(clientId);
    if (!rec) return false;
    if (Date.now() < rec.lockedUntil) return true;
    if (Date.now() >= rec.lockedUntil && rec.failedCount >= MAX_FAILED_PAIRING_ATTEMPTS) {
      this.failedAttempts.delete(clientId);
    }
    return false;
  }

  _recordFailedAttempt(clientId) {
    const rec = this.failedAttempts.get(clientId) || { failedCount: 0, lockedUntil: 0 };
    rec.failedCount += 1;
    if (rec.failedCount >= MAX_FAILED_PAIRING_ATTEMPTS) {
      rec.lockedUntil = Date.now() + PAIRING_LOCKOUT_MS;
    }
    this.failedAttempts.set(clientId, rec);
    return rec;
  }

  _resetFailedAttempts(clientId) {
    this.failedAttempts.delete(clientId);
  }

  startServer() {
    if (this.server) return Promise.resolve(this.port);

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-PeerScribe-Session, X-PeerScribe-Token, X-PeerScribe-Peer-Id, X-PeerScribe-Nonce, X-PeerScribe-Timestamp');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = parsedUrl.pathname;
        const clientIp = req.socket.remoteAddress || 'unknown';

        // Enforce maximum payload size limit
        let bytesRead = 0;
        let body = '';
        let payloadTooLarge = false;

        req.on('data', chunk => {
          if (payloadTooLarge) return;
          bytesRead += chunk.length;
          if (bytesRead > MAX_REQUEST_SIZE_BYTES) {
            payloadTooLarge = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload Too Large: Exceeds 2 MB limit' }));
            req.resume();
            return;
          }
          body += chunk;
        });

        req.on('end', async () => {
          if (payloadTooLarge) return;

          try {
            let json = {};
            if (body.length > 0) {
              try {
                json = JSON.parse(body);
              } catch (_) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Malformed JSON payload' }));
                return;
              }
            }

            // -----------------------------------------------------------------
            // Route: GET /api/v1/sync/info
            // Returns safe public discovery metadata ONLY. NEVER exposes secrets,
            // PINs, session keys, or authentication tokens!
            // -----------------------------------------------------------------
            if (pathname === '/api/v1/sync/info' && req.method === 'GET') {
              const state = this.getState();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                status: 'OK',
                nodeId: this.nodeId,
                appVersion: '1.0.0',
                platform: 'windows-electron',
                ipAddresses: this.getLocalIpAddresses(),
                port: this.port,
                operationId: state.activeOperation?.operation_id || 'OP_TACTICAL',
                requiresPairing: true
              }));
              return;
            }

            // -----------------------------------------------------------------
            // Route: POST /api/v1/sync/pair-init
            // Step 1 of Authenticated Diffie-Hellman Handshake.
            // Client transmits ephemeral public key and nonce; PIN is NEVER sent!
            // -----------------------------------------------------------------
            if (pathname === '/api/v1/sync/pair-init' && req.method === 'POST') {
              const clientNodeId = json.client_node_id;
              const clientEphemeralPubBase64 = json.client_ephemeral_pub;
              const clientNonceBase64 = json.client_nonce;

              if (!clientNodeId || !clientEphemeralPubBase64 || !clientNonceBase64) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required handshake initialization fields (client_node_id, client_ephemeral_pub, client_nonce)' }));
                return;
              }

              // Check lockout from repeated invalid attempts
              if (this._isLockedOut(clientNodeId) || this._isLockedOut(clientIp)) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Too many failed pairing attempts. Lockout in effect.' }));
                return;
              }

              if (!this.isPinActive()) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Pairing authorization window is closed or expired. Request a new PIN on the host device.' }));
                return;
              }

              let clientPubBytes;
              try {
                clientPubBytes = Buffer.from(clientEphemeralPubBase64, 'base64');
                if (clientPubBytes.length !== 32) throw new Error('Invalid key length');
              } catch (_) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Malformed client_ephemeral_pub: must be 32 bytes base64' }));
                return;
              }

              const serverEphemeral = generateX25519KeyPair();
              const serverNonce = crypto.randomBytes(32);
              const clientNonce = Buffer.from(clientNonceBase64, 'base64');

              let sharedDH;
              try {
                sharedDH = computeX25519DH(serverEphemeral.privateKey, clientPubBytes);
              } catch (dhErr) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Diffie-Hellman negotiation failed: ${dhErr.message}` }));
                return;
              }

              const { confirmKey, sessionKey, sessionToken, sas } = deriveHandshakeKeys(
                sharedDH,
                clientNonce,
                serverNonce,
                clientNodeId,
                this.nodeId,
                this.activePairingPin
              );

              const handshakeId = `hs_${crypto.randomUUID()}`;
              this.pendingHandshakes.set(handshakeId, {
                handshakeId,
                clientNodeId,
                clientIp,
                confirmKey,
                sessionKey,
                sessionToken: sessionToken.toString('base64'),
                sas,
                expiresAt: Date.now() + HANDSHAKE_TTL_MS
              });

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                status: 'INITIATED',
                handshake_id: handshakeId,
                server_node_id: this.nodeId,
                server_ephemeral_pub: serverEphemeral.publicKey.toString('base64'),
                server_nonce: serverNonce.toString('base64'),
                sas: sas,
                expires_in_seconds: Math.floor(HANDSHAKE_TTL_MS / 1000)
              }));
              return;
            }

            // -----------------------------------------------------------------
            // Route: POST /api/v1/sync/pair-confirm
            // Step 2 of Authenticated Diffie-Hellman Handshake.
            // Client proves knowledge of PIN via HMAC without disclosing PIN.
            // -----------------------------------------------------------------
            if (pathname === '/api/v1/sync/pair-confirm' && req.method === 'POST') {
              const handshakeId = json.handshake_id;
              const clientNodeId = json.client_node_id;
              const clientProofBase64 = json.client_proof;

              if (!handshakeId || !clientNodeId || !clientProofBase64) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required handshake confirmation fields (handshake_id, client_node_id, client_proof)' }));
                return;
              }

              // Check lockout
              if (this._isLockedOut(clientNodeId) || this._isLockedOut(clientIp)) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Too many failed pairing attempts. Lockout in effect.' }));
                return;
              }

              const pending = this.pendingHandshakes.get(handshakeId);
              if (!pending || Date.now() > pending.expiresAt) {
                this.pendingHandshakes.delete(handshakeId);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Handshake session expired or invalid. Please re-initiate pairing.' }));
                return;
              }

              if (pending.clientNodeId !== clientNodeId) {
                this._recordFailedAttempt(clientNodeId);
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Forbidden: Client identity does not match handshake initialization' }));
                return;
              }

              // Compute expected client authentication proof
              const expectedClientProof = computeAuthProof(
                pending.confirmKey,
                'CLIENT-PROOF',
                handshakeId,
                clientNodeId,
                this.nodeId
              );

              let providedProof;
              try {
                providedProof = Buffer.from(clientProofBase64, 'base64');
              } catch (_) {
                providedProof = Buffer.alloc(0);
              }

              const proofValid = providedProof.length === expectedClientProof.length &&
                crypto.timingSafeEqual(providedProof, expectedClientProof);

              if (!proofValid) {
                this.pendingHandshakes.delete(handshakeId);
                const rec = this._recordFailedAttempt(clientNodeId);
                this._recordFailedAttempt(clientIp);
                const remaining = Math.max(0, MAX_FAILED_PAIRING_ATTEMPTS - rec.failedCount);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: `Invalid pairing authorization proof. Attempts remaining before lockout: ${remaining}`
                }));
                return;
              }

              // Successful handshake verification: Generate server proof
              const serverProof = computeAuthProof(
                pending.confirmKey,
                'SERVER-PROOF',
                handshakeId,
                this.nodeId,
                clientNodeId
              );

              const sessionId = `sess_${crypto.randomUUID()}`;

              // Register established session with empty transmitted outbox set
              this.activeSessions.set(sessionId, {
                sessionId,
                peerId: clientNodeId,
                sessionKey: pending.sessionKey,
                sessionToken: pending.sessionToken,
                createdAt: Date.now(),
                expiresAt: Date.now() + SESSION_TTL_MS,
                seenNonces: new Set(),
                transmittedOutboxEventIds: new Set()
              });

              // Clean up handshake and reset failed attempts
              this.pendingHandshakes.delete(handshakeId);
              this._resetFailedAttempts(clientNodeId);
              this._resetFailedAttempts(clientIp);

              // Single-use PIN consumption: Immediately consume PIN so it cannot be reused
              this.pinConsumed = true;
              this.activePairingPin = null;

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                status: 'PAIRED',
                session_id: sessionId,
                server_proof: serverProof.toString('base64'),
                server_node_id: this.nodeId,
                expires_in_seconds: Math.floor(SESSION_TTL_MS / 1000)
              }));
              return;
            }

            // -----------------------------------------------------------------
            // Route: POST /api/v1/sync/pair (Unified 1-step handshake endpoint)
            // Executes authenticated ephemeral DH exchange under a single endpoint.
            // Accepts client ephemeral public key, nonce, and auth proof; returns
            // server ephemeral key, server proof, and established session ID.
            // Plaintext pairing_pin over the wire is STRICTLY FORBIDDEN!
            // -----------------------------------------------------------------
            if (pathname === '/api/v1/sync/pair' && req.method === 'POST') {
              if (json.pairing_pin && !json.client_ephemeral_pub) {
                // Reject insecure plaintext PIN transmission
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: 'Insecure pairing rejected: Plaintext pairing_pin transmission is prohibited. Use authenticated Diffie-Hellman handshake.'
                }));
                return;
              }

              const clientNodeId = json.client_node_id;
              const clientEphemeralPubBase64 = json.client_ephemeral_pub;
              const clientNonceBase64 = json.client_nonce;
              const clientProofBase64 = json.client_proof;

              if (!clientNodeId || !clientEphemeralPubBase64 || !clientNonceBase64 || !clientProofBase64) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required authenticated handshake fields (client_node_id, client_ephemeral_pub, client_nonce, client_proof)' }));
                return;
              }

              // Check lockout
              if (this._isLockedOut(clientNodeId) || this._isLockedOut(clientIp)) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Too many failed pairing attempts. Lockout in effect.' }));
                return;
              }

              if (!this.isPinActive()) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Pairing PIN expired or consumed. Request a fresh PIN on host device.' }));
                return;
              }

              let clientPubBytes;
              try {
                clientPubBytes = Buffer.from(clientEphemeralPubBase64, 'base64');
                if (clientPubBytes.length !== 32) throw new Error('Invalid key length');
              } catch (_) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Malformed client_ephemeral_pub' }));
                return;
              }

              const serverEphemeral = generateX25519KeyPair();
              const serverNonce = crypto.randomBytes(32);
              const clientNonce = Buffer.from(clientNonceBase64, 'base64');

              let sharedDH;
              try {
                sharedDH = computeX25519DH(serverEphemeral.privateKey, clientPubBytes);
              } catch (dhErr) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Diffie-Hellman calculation failed: ${dhErr.message}` }));
                return;
              }

              const { confirmKey, sessionKey, sessionToken, sas } = deriveHandshakeKeys(
                sharedDH,
                clientNonce,
                serverNonce,
                clientNodeId,
                this.nodeId,
                this.activePairingPin
              );

              // Verify client proof: HMAC(confirmKey, "CLIENT-UNIFIED:" + clientNodeId + ":" + serverNodeId)
              const expectedClientProof = crypto.createHmac('sha256', confirmKey)
                .update(Buffer.from(`CLIENT-UNIFIED:${clientNodeId}:${this.nodeId}`, 'utf8'))
                .digest();

              let providedProof;
              try {
                providedProof = Buffer.from(clientProofBase64, 'base64');
              } catch (_) {
                providedProof = Buffer.alloc(0);
              }

              const match = providedProof.length === expectedClientProof.length &&
                crypto.timingSafeEqual(providedProof, expectedClientProof);

              if (!match) {
                const rec = this._recordFailedAttempt(clientNodeId);
                this._recordFailedAttempt(clientIp);
                const remaining = Math.max(0, MAX_FAILED_PAIRING_ATTEMPTS - rec.failedCount);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: `Invalid pairing authorization proof. Attempts remaining before lockout: ${remaining}`
                }));
                return;
              }

              const serverProof = crypto.createHmac('sha256', confirmKey)
                .update(Buffer.from(`SERVER-UNIFIED:${this.nodeId}:${clientNodeId}`, 'utf8'))
                .digest();

              const sessionId = `sess_${crypto.randomUUID()}`;
              this.activeSessions.set(sessionId, {
                sessionId,
                peerId: clientNodeId,
                sessionKey,
                sessionToken: sessionToken.toString('base64'),
                createdAt: Date.now(),
                expiresAt: Date.now() + SESSION_TTL_MS,
                seenNonces: new Set(),
                transmittedOutboxEventIds: new Set()
              });

              // Single-use PIN consumption
              this.pinConsumed = true;
              this.activePairingPin = null;
              this._resetFailedAttempts(clientNodeId);
              this._resetFailedAttempts(clientIp);

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                status: 'PAIRED',
                session_id: sessionId,
                session_token: sessionToken.toString('base64'),
                server_ephemeral_pub: serverEphemeral.publicKey.toString('base64'),
                server_nonce: serverNonce.toString('base64'),
                server_proof: serverProof.toString('base64'),
                server_node_id: this.nodeId,
                sas,
                expires_in_seconds: Math.floor(SESSION_TTL_MS / 1000)
              }));
              return;
            }

            // -----------------------------------------------------------------
            // Session Authentication & Replay Protection Guard
            // Mandatory on EVERY protected route (/api/v1/sync/bundle, /api/v1/sync/ack)
            // Missing or malformed headers cause an immediate 401/400 rejection.
            // -----------------------------------------------------------------
            const sessionId = req.headers['x-peerscribe-session'];
            const sessionToken = req.headers['x-peerscribe-token'];
            const claimedPeerId = req.headers['x-peerscribe-peer-id'];
            const requestNonce = req.headers['x-peerscribe-nonce'];
            const requestTimestamp = req.headers['x-peerscribe-timestamp'];

            if (pathname === '/api/v1/sync/bundle' || pathname === '/api/v1/sync/ack') {
              // 1. Mandatory header presence check
              if (!sessionId || !sessionToken || !claimedPeerId || !requestNonce || !requestTimestamp) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: 'Unauthorized: Missing mandatory authentication headers (X-PeerScribe-Session, X-PeerScribe-Token, X-PeerScribe-Peer-Id, X-PeerScribe-Nonce, X-PeerScribe-Timestamp)'
                }));
                return;
              }

              // 2. Session existence and expiration
              const session = this.activeSessions.get(sessionId);
              if (!session || Date.now() > session.expiresAt) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Session not found or expired' }));
                return;
              }

              // 3. Cryptographic peer identity binding
              if (session.peerId !== claimedPeerId) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Forbidden: Claimed peer identity does not match authenticated session binding' }));
                return;
              }

              // 4. Constant-time session token verification
              const tokenMatches = sessionToken.length === session.sessionToken.length &&
                crypto.timingSafeEqual(Buffer.from(sessionToken), Buffer.from(session.sessionToken));
              if (!tokenMatches) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Invalid session token' }));
                return;
              }

              // 5. Clock skew verification (max 5 minutes)
              const reqTime = new Date(requestTimestamp).getTime();
              if (isNaN(reqTime) || Math.abs(Date.now() - reqTime) > MAX_TIMESTAMP_SKEW_MS) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bad Request: Request timestamp is invalid or exceeds allowable clock skew (5 min)' }));
                return;
              }

              // 6. Anti-replay nonce verification
              if (session.seenNonces.has(requestNonce)) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Conflict: Replayed request nonce detected' }));
                return;
              }
              session.seenNonces.add(requestNonce);
              if (session.seenNonces.size > 2000) {
                const firstElem = session.seenNonces.values().next().value;
                session.seenNonces.delete(firstElem);
              }
            }

            // -----------------------------------------------------------------
            // Route: POST /api/v1/sync/bundle
            // Authenticated, Encrypted clinical bundle ingestion & outbox exchange
            // -----------------------------------------------------------------
            if (pathname === '/api/v1/sync/bundle' && req.method === 'POST') {
              const session = this.activeSessions.get(sessionId);

              // Decrypt the inbound clinical bundle using session key
              let incomingBundle;
              try {
                if (json.encrypted_payload) {
                  incomingBundle = decryptPayload(json.encrypted_payload, session.sessionKey);
                } else {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Encrypted payload required for clinical sync in transit' }));
                  return;
                }
              } catch (decErr) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Decryption or authentication tag verification failed: ${decErr.message}` }));
                return;
              }

              if (!incomingBundle || !Array.isArray(incomingBundle.events)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid bundle structure: events array required' }));
                return;
              }

              if (incomingBundle.events.length > MAX_EVENTS_PER_BUNDLE) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Bundle exceeds maximum event limit (${MAX_EVENTS_PER_BUNDLE})` }));
                return;
              }

              const state = this.getState();
              const existingEventIds = new Set((state.eventsLog || []).map(e => e.event_id));
              const validNewEvents = [];
              const acceptedEventIds = [];
              const duplicateEventIds = [];

              for (const evt of incomingBundle.events) {
                // Rule 1: Validate against shared canonical protocol schema
                if (!evt || typeof evt !== 'object') {
                  this.rejectedEventsLog.push({ event_id: 'unknown', reason: 'Non-object event', rejected_at_utc: new Date().toISOString() });
                  continue;
                }
                if (evt.schema_version !== 1) {
                  this.rejectedEventsLog.push({ event_id: evt.event_id || 'unknown', reason: `Unsupported schema_version: ${evt.schema_version}`, rejected_at_utc: new Date().toISOString() });
                  continue;
                }
                if (!evt.event_id || !evt.entity_id || !evt.event_type || !evt.actor_id || !evt.operation_id || !evt.occurred_at_utc) {
                  this.rejectedEventsLog.push({ event_id: evt.event_id || 'unknown', reason: 'Missing mandatory schema fields', rejected_at_utc: new Date().toISOString() });
                  continue; // Rejected, NOT acknowledged!
                }
                if (typeof evt.actor_sequence !== 'number' || evt.actor_sequence < 1) {
                  this.rejectedEventsLog.push({ event_id: evt.event_id, reason: 'Invalid actor_sequence: must be positive integer', rejected_at_utc: new Date().toISOString() });
                  continue;
                }
                if (typeof evt.lamport_timestamp !== 'number' || evt.lamport_timestamp < 1) {
                  this.rejectedEventsLog.push({ event_id: evt.event_id, reason: 'Invalid lamport_timestamp: must be positive integer', rejected_at_utc: new Date().toISOString() });
                  continue;
                }
                if (isNaN(new Date(evt.occurred_at_utc).getTime())) {
                  this.rejectedEventsLog.push({ event_id: evt.event_id, reason: 'Invalid occurred_at_utc timestamp format', rejected_at_utc: new Date().toISOString() });
                  continue;
                }

                // Rule 7: Duplicate valid events can only be acknowledged AFTER verifying their durable copy exists
                if (existingEventIds.has(evt.event_id)) {
                  duplicateEventIds.push(evt.event_id);
                  continue;
                }

                validNewEvents.push(evt);
              }

              // Rule 2 & 4: Durable persistence required before acknowledgement
              let divergencesCount = 0;
              if (validNewEvents.length > 0) {
                try {
                  divergencesCount = this.onEventsIngested(validNewEvents, incomingBundle.origin_node_id || claimedPeerId);
                  for (const evt of validNewEvents) {
                    evt.origin_node_id = incomingBundle.origin_node_id || claimedPeerId;
                    acceptedEventIds.push(evt.event_id);
                    existingEventIds.add(evt.event_id);
                  }
                } catch (persistErr) {
                  this.rejectedEventsLog.push({
                    event_id: 'batch_failure',
                    reason: `Persistence failure: ${persistErr.message}`,
                    rejected_at_utc: new Date().toISOString()
                  });
                }
              }

              // Acknowledged IDs accumulated STRICTLY from explicit durable results
              const acknowledgedEventIds = [...acceptedEventIds, ...duplicateEventIds];

              // Prepare local outbox delta for return to peer (suppress echoing events back to originating actor/node)
              const serverOutbox = (state.outboxQueue || []).filter(e => e.actor_id !== claimedPeerId && (!e.origin_node_id || e.origin_node_id !== claimedPeerId));

              // Anti-forgery tracking: Record all outbox event IDs transmitted to this session
              for (const evt of serverOutbox) {
                session.transmittedOutboxEventIds.add(evt.event_id);
              }

              const responseBundle = {
                schema_version: 1,
                bundle_id: `bundle_${crypto.randomUUID()}`,
                operation_id: state.activeOperation?.operation_id || 'OP_TACTICAL',
                origin_node_id: this.nodeId,
                priority: 'CLINICAL_DELTA',
                vector_clock: {},
                created_at_utc: new Date().toISOString(),
                events: serverOutbox
              };

              // Encrypt response bundle with session key
              const encryptedServerBundle = encryptPayload(responseBundle, session.sessionKey);

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                status: 'SUCCESS',
                acknowledged_event_ids: acknowledgedEventIds,
                inserted_count: acceptedEventIds.length,
                duplicate_count: duplicateEventIds.length,
                divergences_count: divergencesCount,
                encrypted_server_bundle: encryptedServerBundle
              }));
              return;
            }

            // -----------------------------------------------------------------
            // Route: POST /api/v1/sync/ack
            // Authenticated outbox acknowledgement with anti-forgery validation
            // -----------------------------------------------------------------
            if (pathname === '/api/v1/sync/ack' && req.method === 'POST') {
              const session = this.activeSessions.get(sessionId);
              const ackedIds = json.acknowledged_event_ids || [];

              if (!Array.isArray(ackedIds)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'acknowledged_event_ids must be an array' }));
                return;
              }

              // Anti-forgery check: Only acknowledge event IDs that were ACTUALLY transmitted
              // to this authenticated peer in this session. Reject forged / arbitrary event IDs!
              const verifiedAcks = ackedIds.filter(id => session.transmittedOutboxEventIds.has(id));

              if (verifiedAcks.length > 0) {
                this.onOutboxAcknowledged(verifiedAcks);
                for (const id of verifiedAcks) {
                  session.transmittedOutboxEventIds.delete(id);
                }
              }

              const forgedCount = ackedIds.length - verifiedAcks.length;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: true,
                acknowledged: verifiedAcks.length,
                rejected_forged: forgedCount
              }));
              return;
            }

            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Not found: ${pathname}` }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
          }
        });
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          this.port += 1;
          this.server.close();
          this.server = null;
          this.startServer().then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        resolve(this.port);
      });
    });
  }

  /**
   * Pairs with a remote peer using the authenticated Diffie-Hellman handshake.
   * Transmits ephemeral public keys; the pairing PIN is NEVER sent over the wire!
   */
  async pairWithPeer(peerAddress, pairingPin) {
    let cleanAddress = peerAddress.trim();
    if (!cleanAddress.startsWith('http://') && !cleanAddress.startsWith('https://')) {
      cleanAddress = `http://${cleanAddress}`;
    }

    const clientEphemeral = generateX25519KeyPair();
    const clientNonce = crypto.randomBytes(32);

    // Step 1: POST /api/v1/sync/pair-init
    const initPayload = JSON.stringify({
      client_node_id: this.nodeId,
      client_ephemeral_pub: clientEphemeral.publicKey.toString('base64'),
      client_nonce: clientNonce.toString('base64')
    });

    const initUrl = new URL('/api/v1/sync/pair-init', cleanAddress);

    const initResp = await new Promise((resolve, reject) => {
      const req = http.request(initUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(initPayload)
        },
        timeout: 5000
      }, (res) => {
        let respBody = '';
        res.on('data', chunk => { respBody += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Handshake init failed with HTTP ${res.statusCode}: ${respBody}`));
            return;
          }
          try {
            resolve(JSON.parse(respBody));
          } catch (e) {
            reject(new Error(`Malformed init response JSON: ${e.message}`));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Pairing connection to ${cleanAddress} timed out`));
      });
      req.on('error', err => reject(new Error(`Pairing network error: ${err.message}`)));

      req.write(initPayload);
      req.end();
    });

    // Step 2: Compute DH shared secret and derive keys
    const serverPubBytes = Buffer.from(initResp.server_ephemeral_pub, 'base64');
    const serverNonce = Buffer.from(initResp.server_nonce, 'base64');
    const handshakeId = initResp.handshake_id;
    const serverNodeId = initResp.server_node_id;

    const sharedDH = computeX25519DH(clientEphemeral.privateKey, serverPubBytes);
    const { confirmKey, sessionKey, sessionToken, sas } = deriveHandshakeKeys(
      sharedDH,
      clientNonce,
      serverNonce,
      this.nodeId,
      serverNodeId,
      pairingPin
    );

    // Compute client auth proof: HMAC(confirmKey, "CLIENT-PROOF:" + handshakeId + ":" + clientNodeId + ":" + serverNodeId)
    const clientProof = computeAuthProof(
      confirmKey,
      'CLIENT-PROOF',
      handshakeId,
      this.nodeId,
      serverNodeId
    );

    // Step 3: POST /api/v1/sync/pair-confirm
    const confirmPayload = JSON.stringify({
      handshake_id: handshakeId,
      client_node_id: this.nodeId,
      client_proof: clientProof.toString('base64')
    });

    const confirmUrl = new URL('/api/v1/sync/pair-confirm', cleanAddress);

    const confirmResp = await new Promise((resolve, reject) => {
      const req = http.request(confirmUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(confirmPayload)
        },
        timeout: 5000
      }, (res) => {
        let respBody = '';
        res.on('data', chunk => { respBody += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Handshake confirm failed with HTTP ${res.statusCode}: ${respBody}`));
            return;
          }
          try {
            resolve(JSON.parse(respBody));
          } catch (e) {
            reject(new Error(`Malformed confirm response JSON: ${e.message}`));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Pairing confirmation timed out`));
      });
      req.on('error', err => reject(new Error(`Pairing confirmation network error: ${err.message}`)));

      req.write(confirmPayload);
      req.end();
    });

    // Verify server authentication proof
    const expectedServerProof = computeAuthProof(
      confirmKey,
      'SERVER-PROOF',
      handshakeId,
      serverNodeId,
      this.nodeId
    );

    const providedServerProof = Buffer.from(confirmResp.server_proof, 'base64');
    if (providedServerProof.length !== expectedServerProof.length ||
        !crypto.timingSafeEqual(providedServerProof, expectedServerProof)) {
      throw new Error('Peer identity verification failed: Server authentication proof mismatch');
    }

    const sessionCreds = {
      sessionId: confirmResp.session_id,
      sessionToken: sessionToken.toString('base64'),
      sessionKey,
      serverNodeId,
      peerAddress: cleanAddress,
      pairedAt: Date.now(),
      sas
    };

    this.clientSessions.set(cleanAddress, sessionCreds);
    this.clientSessions.set(serverNodeId, sessionCreds);

    return sessionCreds;
  }

  /**
   * Synchronizes bidirectionally with a peer over an authenticated, encrypted session.
   */
  async syncWithPeer(peerAddress, pairingPin) {
    let cleanAddress = peerAddress.trim();
    if (!cleanAddress.startsWith('http://') && !cleanAddress.startsWith('https://')) {
      cleanAddress = `http://${cleanAddress}`;
    }

    // 1. Establish or retrieve paired session
    let session = this.clientSessions.get(cleanAddress);
    if (!session) {
      if (!pairingPin) {
        throw new Error(`Cannot synchronize with unpaired peer ${cleanAddress} without a pairing PIN`);
      }
      session = await this.pairWithPeer(cleanAddress, pairingPin);
    }

    const state = this.getState();
    const localOutbox = state.outboxQueue || [];
    const sentEventIds = localOutbox.map(e => e.event_id);

    const syncBundle = {
      schema_version: 1,
      bundle_id: `bundle_${crypto.randomUUID()}`,
      operation_id: state.activeOperation?.operation_id || 'OP_TACTICAL',
      origin_node_id: this.nodeId,
      priority: 'CLINICAL_DELTA',
      created_at_utc: new Date().toISOString(),
      events: localOutbox
    };

    // 2. Encrypt clinical bundle in transit using AES-256-GCM
    const encryptedPayload = encryptPayload(syncBundle, session.sessionKey);
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString();

    const requestBody = JSON.stringify({
      session_id: session.sessionId,
      sender_node_id: this.nodeId,
      encrypted_payload: encryptedPayload
    });

    const targetUrl = new URL('/api/v1/sync/bundle', cleanAddress);

    return new Promise((resolve, reject) => {
      const req = http.request(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'X-PeerScribe-Session': session.sessionId,
          'X-PeerScribe-Token': session.sessionToken,
          'X-PeerScribe-Peer-Id': this.nodeId,
          'X-PeerScribe-Nonce': nonce,
          'X-PeerScribe-Timestamp': timestamp
        },
        timeout: 6000
      }, (res) => {
        let respBody = '';
        res.on('data', chunk => { respBody += chunk; });
        res.on('end', async () => {
          if (res.statusCode !== 200) {
            if (res.statusCode === 401) {
              this.clientSessions.delete(cleanAddress);
            }
            reject(new Error(`Peer returned HTTP ${res.statusCode}: ${respBody}`));
            return;
          }

          try {
            const data = JSON.parse(respBody);

            // P0-B Invariant: Outbox deletion based ONLY on validated acks
            // Verify that acknowledged event IDs were actually part of this sent bundle!
            const verifiedAcks = (data.acknowledged_event_ids || []).filter(id => sentEventIds.includes(id));
            if (verifiedAcks.length > 0) {
              this.onOutboxAcknowledged(verifiedAcks);
            }

            // Ingest peer delta events
            let inboundIngested = 0;
            const peerEncrypted = data.encrypted_server_bundle;
            if (peerEncrypted) {
              const peerBundle = decryptPayload(peerEncrypted, session.sessionKey);
              if (peerBundle && Array.isArray(peerBundle.events) && peerBundle.events.length > 0) {
                const existingEventIds = new Set((this.getState().eventsLog || []).map(e => e.event_id));
                const newInbound = peerBundle.events.filter(e => !existingEventIds.has(e.event_id));
                const acceptedByClient = [];

                if (newInbound.length > 0) {
                  // Validate schema before acceptance
                  const validInbound = newInbound.filter(e =>
                    e && e.schema_version === 1 && e.event_id && e.entity_id && e.event_type && e.occurred_at_utc && e.actor_id
                  );
                  if (validInbound.length > 0) {
                    this.onEventsIngested(validInbound, peerBundle.origin_node_id);
                    validInbound.forEach(e => acceptedByClient.push(e.event_id));
                    inboundIngested = validInbound.length;
                  }
                }

                // Send authenticated ack back to peer containing only accepted event IDs
                if (acceptedByClient.length > 0) {
                  try {
                    await new Promise((resAck) => {
                      const ackNonce = crypto.randomBytes(16).toString('hex');
                      const ackBody = JSON.stringify({ acknowledged_event_ids: acceptedByClient });
                      const ackReq = http.request(new URL('/api/v1/sync/ack', cleanAddress), {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          'Content-Length': Buffer.byteLength(ackBody),
                          'X-PeerScribe-Session': session.sessionId,
                          'X-PeerScribe-Token': session.sessionToken,
                          'X-PeerScribe-Peer-Id': this.nodeId,
                          'X-PeerScribe-Nonce': ackNonce,
                          'X-PeerScribe-Timestamp': new Date().toISOString()
                        }
                      }, (ackRes) => {
                        ackRes.resume();
                        ackRes.on('end', resAck);
                      });
                      ackReq.on('error', resAck);
                      ackReq.write(ackBody);
                      ackReq.end();
                    });
                  } catch (_) {}
                }
              }
            }

            resolve({
              success: true,
              peer: cleanAddress,
              eventsSent: localOutbox.length,
              eventsReceived: inboundIngested,
              divergencesFlagged: data.divergences_count || 0,
              timestamp: new Date().toISOString()
            });
          } catch (err) {
            reject(new Error(`Failed to parse sync response: ${err.message}`));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Connection to peer ${cleanAddress} timed out after 6000ms`));
      });

      req.on('error', (err) => {
        reject(new Error(`Network sync failed with ${cleanAddress}: ${err.message}`));
      });

      req.write(requestBody);
      req.end();
    });
  }

  stopServer() {
    return new Promise((resolve) => {
      if (this.server) {
        if (typeof this.server.closeAllConnections === 'function') {
          this.server.closeAllConnections();
        }
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = {
  LanSyncService,
  DEFAULT_SYNC_PORT,
  MAX_REQUEST_SIZE_BYTES,
  MAX_EVENTS_PER_BUNDLE,
  encryptPayload,
  decryptPayload,
  generateX25519KeyPair,
  computeX25519DH,
  deriveHandshakeKeys,
  computeAuthProof,
  deriveSessionKeys
};
