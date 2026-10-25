import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PeerScribeDaemon, type OperationalMode } from './node_daemon.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '4321', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Path to UI static assets
const UI_STATIC_DIR = path.resolve(__dirname, '../../ui-app');

export function createPeerScribeServer(daemon?: PeerScribeDaemon): http.Server {
  const node = daemon || new PeerScribeDaemon();
  const sseClients = new Set<http.ServerResponse>();

  // Broadcast daemon events to connected SSE clients
  const broadcastSse = (eventType: string, data: any) => {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch (err) {
        sseClients.delete(client);
      }
    }
  };

  node.on('patientCreated', (doc) => broadcastSse('patientCreated', doc));
  node.on('patientUpdated', (data) => broadcastSse('patientUpdated', data));
  node.on('modeChanged', (data) => broadcastSse('modeChanged', data));
  node.on('sightingContracted', (data) => broadcastSse('sightingContracted', data));
  node.on('emergencyWiped', (data) => broadcastSse('emergencyWiped', data));
  node.on('activityLogged', (data) => broadcastSse('activityLogged', data));

  const server = http.createServer(async (req, res) => {
    const startTime = Date.now();

    // Enable CORS for tactical mobile and local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Helper to read JSON request body
    const readJsonBody = async (): Promise<any> => {
      return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            resolve(body.length > 0 ? JSON.parse(body) : {});
          } catch (err) {
            reject(new Error('Invalid JSON'));
          }
        });
        req.on('error', reject);
      });
    };

    const sendJson = (statusCode: number, data: any) => {
      const duration = Date.now() - startTime;
      if (!pathname.startsWith('/api/v1/telemetry') && pathname !== '/health' && pathname !== '/api/v1/events') {
        console.log(`\x1b[32m[HTTP ${statusCode}]\x1b[0m ${req.method} ${pathname} (${duration}ms)`);
      }
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    try {
      // -------------------------------------------------------------
      // API ROUTES
      // -------------------------------------------------------------
      if (pathname === '/health' && req.method === 'GET') {
        sendJson(200, { status: 'OK', uptime: process.uptime() });
        return;
      }

      if (pathname === '/api/v1/status' && req.method === 'GET') {
        sendJson(200, node.getStatus());
        return;
      }

      if (pathname === '/api/v1/mode' && req.method === 'POST') {
        const body = await readJsonBody();
        if (!['DORMANT', 'FIELD', 'EMERGENCY'].includes(body.mode)) {
          sendJson(400, { error: 'Invalid mode. Must be DORMANT, FIELD, or EMERGENCY.' });
          return;
        }
        const updated = node.transitionMode(body.mode as OperationalMode);
        sendJson(200, { currentMode: updated });
        return;
      }

      if (pathname === '/api/v1/patients' && req.method === 'GET') {
        sendJson(200, node.listPatients());
        return;
      }

      if (pathname === '/api/v1/patients' && req.method === 'POST') {
        const body = await readJsonBody();
        const doc = node.createPatient(body.ephemeralId);
        sendJson(201, doc);
        return;
      }

      const triageMatch = pathname.match(/^\/api\/v1\/patients\/([^/]+)\/triage$/);
      if (triageMatch && req.method === 'POST') {
        const patientId = triageMatch[1];
        const body = await readJsonBody();
        const result = node.recordTriage(patientId, body.category, body.protocol, body.overrideReason);
        sendJson(200, result);
        return;
      }

      const notesMatch = pathname.match(/^\/api\/v1\/patients\/([^/]+)\/notes$/);
      if (notesMatch && req.method === 'POST') {
        const patientId = notesMatch[1];
        const body = await readJsonBody();
        if (!body.text) { sendJson(400, { error: 'Field "text" required' }); return; }
        const updatedDoc = node.recordNote(patientId, body.text);
        sendJson(200, updatedDoc);
        return;
      }

      const injuryMatch = pathname.match(/^\/api\/v1\/patients\/([^/]+)\/injury$/);
      if (injuryMatch && req.method === 'POST') {
        const patientId = injuryMatch[1];
        const body = await readJsonBody();
        if (!body.classification) { sendJson(400, { error: 'Field "classification" required' }); return; }
        const updatedDoc = node.recordInjury(patientId, body.location || 'General Trauma', body.classification);
        sendJson(200, updatedDoc);
        return;
      }

      // GET /api/v1/patients/:id — Single patient detail
      const singlePatientMatch = pathname.match(/^\/api\/v1\/patients\/([^/]+)$/);
      if (singlePatientMatch && req.method === 'GET') {
        const patientId = singlePatientMatch[1];
        const doc = node.db.getPatientDocument(patientId);
        if (!doc) { sendJson(404, { error: `Patient ${patientId} not found` }); return; }
        const auditTrail = node.db.getAuditTrail(patientId);
        sendJson(200, { doc, auditTrail });
        return;
      }

      const vitalsMatch = pathname.match(/^\/api\/v1\/patients\/([^/]+)\/vitals$/);
      if (vitalsMatch && req.method === 'POST') {
        const patientId = vitalsMatch[1];
        const body = await readJsonBody();
        const result = node.recordVitals(patientId, body);
        sendJson(200, result);
        return;
      }

      const medMatch = pathname.match(/^\/api\/v1\/patients\/([^/]+)\/medications$/);
      if (medMatch && req.method === 'POST') {
        const patientId = medMatch[1];
        const body = await readJsonBody();
        const result = node.recordMedication(patientId, body.drugName, body.dosage, body.route);
        sendJson(200, result);
        return;
      }

      const divMatch = pathname.match(/^\/api\/v1\/patients\/([^/]+)\/resolve-divergence$/);
      if (divMatch && req.method === 'POST') {
        const patientId = divMatch[1];
        const body = await readJsonBody();
        const result = node.resolveDivergenceFlag(patientId, body.flagId, body.note || 'Clinician confirmed');
        sendJson(200, result);
        return;
      }

      const snapshotMatch = pathname.match(/^\/api\/v1\/patients\/([^/]+)\/snapshot$/);
      if (snapshotMatch && req.method === 'POST') {
        const patientId = snapshotMatch[1];
        const body = await readJsonBody();
        const result = node.attachEmergencySnapshot(patientId, body);
        sendJson(200, result);
        return;
      }

      if (pathname === '/api/v1/vault/sample' && req.method === 'GET') {
        sendJson(200, {
          profile: {
            citizenId: 'CITIZEN-DEMO-001',
            fullName: 'Synthetic Demo Citizen',
            isSyntheticDemo: true,
            bloodGroup: 'O+ (DEMO)',
            allergies: ['Penicillin (SYNTHETIC DEMO)', 'Sulfa (SYNTHETIC DEMO)'],
            chronicConditions: ['Asthma (SYNTHETIC DEMO)'],
            currentMedications: [{ name: 'Albuterol (SYNTHETIC DEMO)', dosage: 'Simulated' }],
            emergencyContacts: [{ name: 'Synthetic Demo Contact', relation: 'Simulated', phone: '+0-000-000-0000' }],
            updatedAt: Date.now()
          },
          snapshot: {
            isSyntheticDemo: true,
            bloodGroup: 'O+ (DEMO)',
            allergies: ['Penicillin (SYNTHETIC DEMO)', 'Sulfa (SYNTHETIC DEMO)'],
            criticalConditions: ['Asthma (SYNTHETIC DEMO)'],
            currentMedicationsSummary: ['Albuterol (SYNTHETIC DEMO)'],
            emergencyContacts: [{ name: 'Synthetic Demo Contact', relation: 'Simulated', phone: '+0-000-000-0000' }],
            extractedAt: Date.now()
          }
        });
        return;
      }

      if (pathname === '/api/v1/ai/transcribe-triage' && req.method === 'POST') {
        const body = await readJsonBody();
        if (!body.transcript) {
          sendJson(400, { error: 'Field "transcript" is required' });
          return;
        }
        const result = node.processVoiceTranscript(body.transcript, body.patientId);
        sendJson(200, result);
        return;
      }

      if (pathname === '/api/v1/location/search-contours' && req.method === 'GET') {
        sendJson(200, node.getSearchContours());
        return;
      }

      if (pathname === '/api/v1/location/sighting' && req.method === 'POST') {
        const body = await readJsonBody();
        if (typeof body.lat !== 'number' || typeof body.lon !== 'number') {
          sendJson(400, { error: 'lat and lon numbers required' });
          return;
        }
        const updated = node.observeSighting(body.lat, body.lon, body.accuracyMeters);
        sendJson(200, updated);
        return;
      }

      // --- Telemetry & Packet Inspector Endpoints ---
      if (pathname === '/api/v1/telemetry/packets' && req.method === 'GET') {
        sendJson(200, node.recentWirePackets);
        return;
      }

      if (pathname === '/api/v1/telemetry/nostr' && req.method === 'GET') {
        sendJson(200, node.recentNostrEvents);
        return;
      }

      if (pathname === '/api/v1/telemetry/dtn' && req.method === 'GET') {
        sendJson(200, node.db.listPendingDtnBundles(node.currentOperationId).map(b => ({
          bundleId: b.bundleId,
          priority: b.priority === 3 ? 'CRITICAL_SOS' : 'CLINICAL_DELTA',
          hopCount: b.hopCount,
          maxHops: b.maxHops,
          createdAt: b.createdAt,
          timeStr: new Date(b.createdAt).toLocaleTimeString(),
          payloadBytes: b.payload.length
        })));
        return;
      }

      if (pathname === '/api/v1/telemetry/audit' && req.method === 'GET') {
        const stmt = node.db.db.prepare('SELECT * FROM clinical_audit_trail ORDER BY timestamp DESC LIMIT 30');
        const rows = stmt.all() as any[];
        sendJson(200, rows.map(r => ({
          ...r,
          timeStr: new Date(r.timestamp).toLocaleTimeString(),
          details: JSON.parse(r.details_json || '{}')
        })));
        return;
      }

      if (pathname === '/api/v1/telemetry/activity' && req.method === 'GET') {
        sendJson(200, node.recentActivityLogs);
        return;
      }

      if (pathname === '/api/v1/security/wipe' && req.method === 'POST') {
        const success = node.triggerEmergencyWipe();
        sendJson(200, { zeroized: success, message: 'All session state cryptographically wiped.' });
        return;
      }

      // Server-Sent Events (Live Reactive UI updates)
      if (pathname === '/api/v1/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        res.write(`event: connected\ndata: ${JSON.stringify({ nodeId: node.nodeId })}\n\n`);
        sseClients.add(res);

        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      // -------------------------------------------------------------
      // STATIC UI ASSET SERVING
      // -------------------------------------------------------------
      let filePath = pathname === '/' ? '/index.html' : pathname;
      const safePath = path.normalize(path.join(UI_STATIC_DIR, filePath));

      if (safePath.startsWith(UI_STATIC_DIR) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
        const ext = path.extname(safePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json',
          '.png': 'image/png',
          '.svg': 'image/svg+xml'
        };

        const contentType = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(safePath).pipe(res);
        return;
      }

      sendJson(404, { error: 'Not Found' });
    } catch (err: any) {
      sendJson(500, { error: err.message || 'Internal Server Error' });
    }
  });

  return server;
}

// Start standalone daemon if run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const daemon = new PeerScribeDaemon();
  const server = createPeerScribeServer(daemon);
  server.listen(PORT, HOST, () => {
    console.log(`\n\x1b[1m\x1b[36m===============================================================\x1b[0m`);
    console.log(`\x1b[1m\x1b[32m  PEERSCRIBE FIELD NODE DAEMON (BitChat P2P + Nostr)\x1b[0m`);
    console.log(`\x1b[36m===============================================================\x1b[0m`);
    console.log(`  \x1b[1mStatus:\x1b[0m       ONLINE & READY`);
    console.log(`  \x1b[1mNode ID:\x1b[0m      ${daemon.nodeId}`);
    console.log(`  \x1b[1mPublic Key:\x1b[0m   ${daemon.keyPair.publicKey.substring(0, 32)}...`);
    console.log(`  \x1b[1mSector:\x1b[0m       ${daemon.sectorGeohash} (27.7172° N, 85.3240° E)`);
    console.log(`  \x1b[1mStorage:\x1b[0m      SQLite WAL Engine initialized (Zero-Central DB)`);
    console.log(`  \x1b[1mWeb UI:\x1b[0m       \x1b[4mhttp://localhost:${PORT}\x1b[0m`);
    console.log(`  \x1b[1mTelemetry:\x1b[0m    \x1b[4mhttp://localhost:${PORT}/api/v1/telemetry/packets\x1b[0m`);
    console.log(`\x1b[36m===============================================================\x1b[0m\n`);
    console.log(`\x1b[90m[Awaiting tactical field triage & mesh sync events...]\x1b[0m\n`);
  });
}
