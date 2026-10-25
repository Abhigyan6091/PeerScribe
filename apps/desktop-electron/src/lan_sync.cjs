const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');

const DEFAULT_SYNC_PORT = 4323;
const TACTICAL_PAIRING_SECRET = 'PEERSCRIBE-TACTICAL-MESH-2026';

/**
 * Real Cross-Platform LAN Synchronization Server and Client for PeerScribe Desktop.
 * Provides offline-first bidirectional sync over local Wi-Fi / Hotspot with:
 * - Real HTTP listener and client
 * - Token authentication
 * - Event deduplication
 * - Outbox persistence and reconciliation
 * - Peer connection tracking
 */
class LanSyncService {
  constructor(options = {}) {
    this.port = options.port || DEFAULT_SYNC_PORT;
    this.nodeId = options.nodeId || 'node_desktop_electron';
    this.getState = options.getState || (() => ({ eventsLog: [], outboxQueue: [], activeOperation: {} }));
    this.onEventsIngested = options.onEventsIngested || (() => {});
    this.onOutboxAcknowledged = options.onOutboxAcknowledged || (() => {});

    this.server = null;
    this.pairedPeers = new Map(); // peerAddress -> { peerId, pairedAt, lastSyncAt, status }
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
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-PeerScribe-Auth');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = parsedUrl.pathname;

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            let json = {};
            if (body.length > 0) {
              try { json = JSON.parse(body); } catch (_) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Malformed JSON payload' }));
                return;
              }
            }

            // Route: GET /api/v1/sync/info
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
                eventsCount: state.eventsLog.length,
                outboxCount: state.outboxQueue.length,
                pairingToken: TACTICAL_PAIRING_SECRET
              }));
              return;
            }

            // Route: POST /api/v1/sync/pair
            if (pathname === '/api/v1/sync/pair' && req.method === 'POST') {
              const token = req.headers['x-peerscribe-auth'] || json.pairing_token;
              if (token !== TACTICAL_PAIRING_SECRET) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Invalid tactical pairing token' }));
                return;
              }

              const peerId = json.peer_id || 'unknown_peer';
              const peerHost = json.peer_host || req.socket.remoteAddress;
              this.pairedPeers.set(peerHost, {
                peerId,
                host: peerHost,
                pairedAt: new Date().toISOString(),
                lastSyncAt: null,
                status: 'CONNECTED'
              });

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: 'Peer paired successfully', nodeId: this.nodeId }));
              return;
            }

            // Route: POST /api/v1/sync/bundle
            if (pathname === '/api/v1/sync/bundle' && req.method === 'POST') {
              const token = req.headers['x-peerscribe-auth'] || json.pairing_token;
              if (token !== TACTICAL_PAIRING_SECRET) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid tactical token' }));
                return;
              }

              const incomingBundle = json;
              if (!incomingBundle || !Array.isArray(incomingBundle.events)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid bundle structure: events array required' }));
                return;
              }

              const state = this.getState();
              const existingEventIds = new Set(state.eventsLog.map(e => e.event_id));
              const validNewEvents = [];
              const acknowledgedEventIds = [];
              let duplicateCount = 0;

              for (const evt of incomingBundle.events) {
                acknowledgedEventIds.push(evt.event_id);
                if (existingEventIds.has(evt.event_id)) {
                  duplicateCount++;
                  continue;
                }
                // Validate mandatory schema fields
                if (!evt.event_id || !evt.entity_id || !evt.event_type || !evt.occurred_at_utc) {
                  continue;
                }
                validNewEvents.push(evt);
                existingEventIds.add(evt.event_id);
              }

              // Persist valid new events and project
              let divergencesCount = 0;
              if (validNewEvents.length > 0) {
                divergencesCount = this.onEventsIngested(validNewEvents);
              }

              // Update peer status
              const remoteHost = req.socket.remoteAddress;
              this.pairedPeers.set(remoteHost, {
                peerId: incomingBundle.originNodeId || incomingBundle.origin_node_id || 'remote_peer',
                host: remoteHost,
                pairedAt: this.pairedPeers.get(remoteHost)?.pairedAt || new Date().toISOString(),
                lastSyncAt: new Date().toISOString(),
                status: 'CONNECTED'
              });

              // Construct response including server outbox delta
              const serverOutbox = state.outboxQueue || [];
              const responseBundle = {
                schema_version: 1,
                bundle_id: `bundle_${crypto.randomUUID()}`,
                operation_id: state.activeOperation?.operation_id || 'OP_TACTICAL',
                origin_node_id: this.nodeId,
                priority: 'CLINICAL_DELTA',
                created_at_utc: new Date().toISOString(),
                events: serverOutbox
              };

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                status: 'SUCCESS',
                acknowledged_event_ids: acknowledgedEventIds,
                inserted_count: validNewEvents.length,
                duplicate_count: duplicateCount,
                divergences_count: divergencesCount,
                server_bundle: responseBundle
              }));
              return;
            }

            // Route: POST /api/v1/sync/ack
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
          console.warn(`[LanSyncService] Port ${this.port} in use, trying ${this.port + 1}`);
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
   * Performs an actual bidirectional LAN sync exchange with a remote peer (e.g. Android Flutter app).
   */
  async syncWithPeer(peerAddress, customToken = TACTICAL_PAIRING_SECRET) {
    let cleanAddress = peerAddress.trim();
    if (!cleanAddress.startsWith('http://') && !cleanAddress.startsWith('https://')) {
      cleanAddress = `http://${cleanAddress}`;
    }

    const state = this.getState();
    const localOutbox = state.outboxQueue || [];
    const eventsSentCount = localOutbox.length;

    const syncBundle = {
      schema_version: 1,
      bundle_id: `bundle_${crypto.randomUUID()}`,
      operation_id: state.activeOperation?.operation_id || 'OP_TACTICAL',
      origin_node_id: this.nodeId,
      priority: 'CLINICAL_DELTA',
      created_at_utc: new Date().toISOString(),
      events: localOutbox
    };

    const targetUrl = new URL('/api/v1/sync/bundle', cleanAddress);

    return new Promise((resolve, reject) => {
      const payloadStr = JSON.stringify(syncBundle);
      const req = http.request(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadStr),
          'X-PeerScribe-Auth': customToken
        },
        timeout: 6000
      }, (res) => {
        let respBody = '';
        res.on('data', chunk => { respBody += chunk; });
        res.on('end', async () => {
          if (res.statusCode !== 200) {
            this.pairedPeers.set(cleanAddress, {
              host: cleanAddress,
              status: 'UNREACHABLE',
              lastSyncAt: null
            });
            reject(new Error(`Peer returned HTTP ${res.statusCode}: ${respBody}`));
            return;
          }

          try {
            const data = JSON.parse(respBody);
            // 1. Acknowledge local outbox items verified by peer
            if (Array.isArray(data.acknowledged_event_ids) && data.acknowledged_event_ids.length > 0) {
              this.onOutboxAcknowledged(data.acknowledged_event_ids);
            }

            // 2. Ingest peer delta events
            let inboundIngested = 0;
            const peerBundle = data.server_bundle;
            if (peerBundle && Array.isArray(peerBundle.events) && peerBundle.events.length > 0) {
              const existingEventIds = new Set(this.getState().eventsLog.map(e => e.event_id));
              const newInbound = peerBundle.events.filter(e => !existingEventIds.has(e.event_id));
              if (newInbound.length > 0) {
                inboundIngested = newInbound.length;
                this.onEventsIngested(newInbound);
              }

              // Send ack back to peer
              try {
                await new Promise((resAck) => {
                  const ackReq = http.request(new URL('/api/v1/sync/ack', cleanAddress), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-PeerScribe-Auth': customToken }
                  }, (ackRes) => {
                    ackRes.resume();
                    ackRes.on('end', resAck);
                  });
                  ackReq.on('error', resAck);
                  ackReq.write(JSON.stringify({ acknowledged_event_ids: peerBundle.events.map(e => e.event_id) }));
                  ackReq.end();
                });
              } catch (_) {}
            }

            // 3. Update paired peer tracking
            this.pairedPeers.set(cleanAddress, {
              host: cleanAddress,
              status: 'CONNECTED',
              lastSyncAt: new Date().toISOString(),
              eventsSent: eventsSentCount,
              eventsReceived: inboundIngested
            });

            resolve({
              success: true,
              peer: cleanAddress,
              eventsSent: eventsSentCount,
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
        this.pairedPeers.set(cleanAddress, { host: cleanAddress, status: 'TIMEOUT' });
        reject(new Error(`Connection to peer ${cleanAddress} timed out after 6000ms`));
      });

      req.on('error', (err) => {
        this.pairedPeers.set(cleanAddress, { host: cleanAddress, status: 'UNREACHABLE' });
        reject(new Error(`Network sync failed with ${cleanAddress}: ${err.message}`));
      });

      req.write(payloadStr);
      req.end();
    });
  }

  getPeersList() {
    return Array.from(this.pairedPeers.values());
  }

  stopServer() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

module.exports = {
  LanSyncService,
  DEFAULT_SYNC_PORT,
  TACTICAL_PAIRING_SECRET
};
