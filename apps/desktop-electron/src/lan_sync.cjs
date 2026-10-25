const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');

const DEFAULT_SYNC_PORT = 4323;
const MAX_REQUEST_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB limit
const MAX_EVENTS_PER_BUNDLE = 500;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000; // 5 minutes

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
  if (!encryptedObj || !encryptedObj.ciphertext || !encryptedObj.iv || !encryptedObj.tag) {
    throw new Error('Invalid encrypted payload structure');
  }
  const iv = Buffer.from(encryptedObj.iv, 'base64');
  const tag = Buffer.from(encryptedObj.tag, 'base64');
  const ciphertext = Buffer.from(encryptedObj.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

/**
 * Derives a 256-bit session key and 256-bit auth token using standard RFC 5869 HKDF-SHA256.
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
 * - One-time / explicit pairing PIN with HKDF key derivation
 * - In-transit AES-256-GCM clinical payload encryption
 * - Session-bound peer authentication
 * - Payload size limits and replay protection
 * - Strict acknowledgement semantics (only durable events acknowledged)
 * - DTN Store-and-Forward propagation
 */
class LanSyncService {
  constructor(options = {}) {
    this.port = options.port || DEFAULT_SYNC_PORT;
    this.nodeId = options.nodeId || `node_desktop_${crypto.randomBytes(4).toString('hex')}`;
    this.getState = options.getState || (() => ({ eventsLog: [], outboxQueue: [], activeOperation: {} }));
    this.onEventsIngested = options.onEventsIngested || (() => 0);
    this.onOutboxAcknowledged = options.onOutboxAcknowledged || (() => {});

    // Active Pairing PIN for incoming pairing requests
    this.activePairingPin = options.pairingPin || 'TACTICAL-' + crypto.randomInt(100000, 999999).toString();
    this.pairingPinExpiresAt = Date.now() + 24 * 60 * 60 * 1000;

    this.server = null;
    // Map: sessionId -> { sessionId, peerId, sessionKey, sessionToken, createdAt, expiresAt, seenNonces }
    this.activeSessions = new Map();
    // Map: peerAddress / peerId -> active session credentials for client requests
    this.clientSessions = new Map();
    // Audit log of rejected events for diagnostics without logging clinical payloads
    this.rejectedEventsLog = [];
  }

  setPairingPin(pin, ttlSeconds = 86400) {
    this.activePairingPin = String(pin).trim();
    this.pairingPinExpiresAt = Date.now() + ttlSeconds * 1000;
    return this.activePairingPin;
  }

  getPairingPin() {
    return this.activePairingPin;
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

        // Enforce maximum payload size limit
        let bytesRead = 0;
        let body = '';
        let payloadTooLarge = false;

        req.on('data', chunk => {
          bytesRead += chunk.length;
          if (bytesRead > MAX_REQUEST_SIZE_BYTES) {
            payloadTooLarge = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload Too Large: Exceeds 2 MB limit' }));
            req.destroy();
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
            // Returns ONLY public discovery metadata; NEVER exposes secrets or tokens!
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
            // Route: POST /api/v1/sync/pair
            // Explicit, authenticated pairing handshake with one-time / shared PIN
            // -----------------------------------------------------------------
            if (pathname === '/api/v1/sync/pair' && req.method === 'POST') {
              const clientNodeId = json.client_node_id;
              const providedPin = json.pairing_pin;
              const clientNonce = json.client_nonce;

              if (!clientNodeId || !providedPin || !clientNonce) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required pairing fields (client_node_id, pairing_pin, client_nonce)' }));
                return;
              }

              if (Date.now() > this.pairingPinExpiresAt) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Pairing PIN expired. Request a new PIN from the host device.' }));
                return;
              }

              // Constant-time PIN comparison
              const isMatch = crypto.timingSafeEqual(
                Buffer.from(String(providedPin).padEnd(64, ' ')),
                Buffer.from(String(this.activePairingPin).padEnd(64, ' '))
              );

              if (!isMatch) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid pairing PIN' }));
                return;
              }

              const serverNonce = crypto.randomBytes(32).toString('base64');
              const sessionId = `sess_${crypto.randomUUID()}`;

              const { sessionKey, sessionToken } = deriveSessionKeys(
                providedPin,
                clientNonce,
                serverNonce,
                clientNodeId,
                this.nodeId
              );

              // Register established session bound to this peer identity
              this.activeSessions.set(sessionId, {
                sessionId,
                peerId: clientNodeId,
                sessionKey,
                sessionToken: sessionToken.toString('base64'),
                createdAt: Date.now(),
                expiresAt: Date.now() + SESSION_TTL_MS,
                seenNonces: new Set()
              });

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                status: 'PAIRED',
                session_id: sessionId,
                session_token: sessionToken.toString('base64'),
                server_nonce: serverNonce,
                server_node_id: this.nodeId,
                expires_in_seconds: Math.floor(SESSION_TTL_MS / 1000)
              }));
              return;
            }

            // -----------------------------------------------------------------
            // Session Authentication & Binding Guard for Bundle and Ack routes
            // -----------------------------------------------------------------
            const sessionId = req.headers['x-peerscribe-session'];
            const sessionToken = req.headers['x-peerscribe-token'];
            const claimedPeerId = req.headers['x-peerscribe-peer-id'];
            const requestNonce = req.headers['x-peerscribe-nonce'];
            const requestTimestamp = req.headers['x-peerscribe-timestamp'];

            if (pathname === '/api/v1/sync/bundle' || pathname === '/api/v1/sync/ack') {
              if (!sessionId || !sessionToken || !claimedPeerId) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Missing session authentication headers' }));
                return;
              }

              const session = this.activeSessions.get(sessionId);
              if (!session || Date.now() > session.expiresAt) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Session not found or expired' }));
                return;
              }

              // Bind authentication to paired peer identity (prevent peer forgery / session hijacking)
              if (session.peerId !== claimedPeerId) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Forbidden: Claimed peer identity does not match authenticated session binding' }));
                return;
              }

              // Verify session token
              const tokenMatches = crypto.timingSafeEqual(
                Buffer.from(sessionToken.padEnd(64, ' ')),
                Buffer.from(session.sessionToken.padEnd(64, ' '))
              );
              if (!tokenMatches) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Invalid session token' }));
                return;
              }

              // Replay protection: verify timestamp and unique nonce
              if (requestTimestamp) {
                const reqTime = new Date(requestTimestamp).getTime();
                if (isNaN(reqTime) || Math.abs(Date.now() - reqTime) > MAX_TIMESTAMP_SKEW_MS) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Request timestamp is invalid or exceeds maximum allowable clock skew' }));
                  return;
                }
              }

              if (requestNonce) {
                if (session.seenNonces.has(requestNonce)) {
                  res.writeHead(409, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Conflict: Replayed request nonce detected' }));
                  return;
                }
                session.seenNonces.add(requestNonce);
                if (session.seenNonces.size > 1000) {
                  const firstElem = session.seenNonces.values().next().value;
                  session.seenNonces.delete(firstElem);
                }
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
              const existingEventIds = new Set(state.eventsLog.map(e => e.event_id));
              const validNewEvents = [];
              const acknowledgedEventIds = [];
              let duplicateCount = 0;

              for (const evt of incomingBundle.events) {
                // P0-3 Rule 1: Every incoming event validated against shared protocol schema
                if (!evt || typeof evt !== 'object') {
                  this.rejectedEventsLog.push({ event_id: 'unknown', reason: 'Non-object event', rejected_at_utc: new Date().toISOString() });
                  continue;
                }
                if (evt.schema_version !== 1) {
                  this.rejectedEventsLog.push({ event_id: evt.event_id || 'unknown', reason: `Unsupported schema_version: ${evt.schema_version}`, rejected_at_utc: new Date().toISOString() });
                  continue;
                }
                if (!evt.event_id || !evt.entity_id || !evt.event_type || !evt.occurred_at_utc || !evt.actor_id) {
                  this.rejectedEventsLog.push({ event_id: evt.event_id || 'unknown', reason: 'Missing mandatory schema fields', rejected_at_utc: new Date().toISOString() });
                  continue; // Rejected, NOT acknowledged!
                }

                // P0-3 Rule 7: Duplicate valid events can be acknowledged after their existing durable copy is verified
                if (existingEventIds.has(evt.event_id)) {
                  duplicateCount++;
                  acknowledgedEventIds.push(evt.event_id);
                  continue;
                }

                validNewEvents.push(evt);
              }

              // P0-3 Rule 2: Persist valid events durably. Only acknowledged if durable persistence succeeds!
              let divergencesCount = 0;
              if (validNewEvents.length > 0) {
                try {
                  divergencesCount = this.onEventsIngested(validNewEvents, incomingBundle.origin_node_id || claimedPeerId);
                  for (const evt of validNewEvents) {
                    acknowledgedEventIds.push(evt.event_id);
                    existingEventIds.add(evt.event_id);
                  }
                } catch (persistErr) {
                  // P0-3 Rule 4: Database failure results in no successful acknowledgement for affected events
                  this.rejectedEventsLog.push({
                    event_id: 'batch_failure',
                    reason: `Persistence failure: ${persistErr.message}`,
                    rejected_at_utc: new Date().toISOString()
                  });
                }
              }

              // Prepare local outbox delta for return to peer
              const serverOutbox = (state.outboxQueue || []).filter(e => e.actor_id !== claimedPeerId);
              const responseBundle = {
                schema_version: 1,
                bundle_id: `bundle_${crypto.randomUUID()}`,
                operation_id: state.activeOperation?.operation_id || 'OP_TACTICAL',
                origin_node_id: this.nodeId,
                priority: 'CLINICAL_DELTA',
                created_at_utc: new Date().toISOString(),
                events: serverOutbox
              };

              // Encrypt response bundle with session key
              const encryptedServerBundle = encryptPayload(responseBundle, session.sessionKey);

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                status: 'SUCCESS',
                acknowledged_event_ids: acknowledgedEventIds,
                inserted_count: validNewEvents.length,
                duplicate_count: duplicateCount,
                divergences_count: divergencesCount,
                encrypted_server_bundle: encryptedServerBundle
              }));
              return;
            }

            // -----------------------------------------------------------------
            // Route: POST /api/v1/sync/ack
            // Authenticated outbox acknowledgement
            // -----------------------------------------------------------------
            if (pathname === '/api/v1/sync/ack' && req.method === 'POST') {
              const ackedIds = json.acknowledged_event_ids || [];
              if (Array.isArray(ackedIds) && ackedIds.length > 0) {
                this.onOutboxAcknowledged(ackedIds);
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, acknowledged: ackedIds.length }));
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
        console.log(`[LanSyncService] Tactical Sync Server listening on 0.0.0.0:${this.port}`);
        resolve(this.port);
      });
    });
  }

  /**
   * Pairs with a remote peer using an explicit, verifiable pairing PIN.
   */
  async pairWithPeer(peerAddress, pairingPin) {
    let cleanAddress = peerAddress.trim();
    if (!cleanAddress.startsWith('http://') && !cleanAddress.startsWith('https://')) {
      cleanAddress = `http://${cleanAddress}`;
    }

    const clientNonce = crypto.randomBytes(32).toString('base64');
    const pairUrl = new URL('/api/v1/sync/pair', cleanAddress);

    const payload = JSON.stringify({
      client_node_id: this.nodeId,
      pairing_pin: pairingPin,
      client_nonce: clientNonce
    });

    return new Promise((resolve, reject) => {
      const req = http.request(pairUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 5000
      }, (res) => {
        let respBody = '';
        res.on('data', chunk => { respBody += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Pairing failed with status ${res.statusCode}: ${respBody}`));
            return;
          }

          try {
            const data = JSON.parse(respBody);
            const { sessionKey, sessionToken } = deriveSessionKeys(
              pairingPin,
              clientNonce,
              data.server_nonce,
              this.nodeId,
              data.server_node_id
            );

            const sessionCreds = {
              sessionId: data.session_id,
              sessionToken: sessionToken.toString('base64'),
              sessionKey,
              serverNodeId: data.server_node_id,
              peerAddress: cleanAddress,
              pairedAt: Date.now()
            };

            this.clientSessions.set(cleanAddress, sessionCreds);
            this.clientSessions.set(data.server_node_id, sessionCreds);

            resolve(sessionCreds);
          } catch (err) {
            reject(new Error(`Failed to parse pairing response: ${err.message}`));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Pairing connection to ${cleanAddress} timed out`));
      });
      req.on('error', err => reject(new Error(`Pairing network error: ${err.message}`)));

      req.write(payload);
      req.end();
    });
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
            reject(new Error(`Peer returned HTTP ${res.statusCode}: ${respBody}`));
            return;
          }

          try {
            const data = JSON.parse(respBody);

            // P0-3 Rule 6: Outbox deletion based ONLY on validated acks
            // Verify that acknowledged event IDs were actually part of this sent bundle
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
                const existingEventIds = new Set(this.getState().eventsLog.map(e => e.event_id));
                const newInbound = peerBundle.events.filter(e => !existingEventIds.has(e.event_id));
                const acceptedByClient = [];

                if (newInbound.length > 0) {
                  // Validate schema before acceptance
                  const validInbound = newInbound.filter(e => e.schema_version === 1 && e.event_id && e.entity_id && e.event_type && e.occurred_at_utc);
                  if (validInbound.length > 0) {
                    inboundIngested = validInbound.length;
                    this.onEventsIngested(validInbound, peerBundle.origin_node_id);
                    validInbound.forEach(e => acceptedByClient.push(e.event_id));
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
  deriveSessionKeys
};
