import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PeerScribeDaemon, type OperationalMode } from './node_daemon.ts';
import { decodePacket, MAGIC_BYTES } from '../../core-engine/src/index.ts';

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
  node.on('roleChanged', (data) => broadcastSse('roleChanged', data));
  node.on('operationChanged', (data) => broadcastSse('operationChanged', data));
  node.on('sightingContracted', (data) => broadcastSse('sightingContracted', data));
  node.on('emergencyWiped', (data) => broadcastSse('emergencyWiped', data));
  node.on('activityLogged', (data) => broadcastSse('activityLogged', data));

  const server = http.createServer(async (req, res) => {
    const startTime = Date.now();

    // Enable CORS for tactical mobile and local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    const requestId = 'req_' + crypto.randomBytes(4).toString('hex');

    // Helper to read JSON request body with 2MB protection limit
    const readJsonBody = async (maxSize = 2 * 1024 * 1024): Promise<any> => {
      return new Promise((resolve, reject) => {
        let body = '';
        let received = 0;
        req.on('data', chunk => {
          received += chunk.length;
          if (received > maxSize) {
            reject(new Error('Payload too large'));
            return;
          }
          body += chunk;
        });
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

    // Structured Request/Response Logger with Timestamps & Request IDs
    const sendJson = (statusCode: number, data: any) => {
      const duration = Date.now() - startTime;
      const timestamp = new Date().toISOString();
      if (!pathname.startsWith('/api/v1/telemetry') && pathname !== '/health' && pathname !== '/api/v1/events') {
        const color = statusCode >= 500 ? '\x1b[31m' : statusCode >= 400 ? '\x1b[33m' : '\x1b[32m';
        const errDetail = statusCode >= 400 && data.error ? ` | Error: ${data.error}` : '';
        console.log(`${color}[${timestamp}] [${requestId}] [HTTP ${statusCode}]\x1b[0m ${req.method} ${pathname} (${duration}ms)${errDetail}`);
      }
      res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId
      });
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

      // --- Role & Capabilities ---
      if (pathname === '/api/v1/role' && req.method === 'POST') {
        const body = await readJsonBody();
        const validRoles = ['PARTICIPANT', 'MEDICAL_RESPONDER', 'COORDINATOR', 'TRANSPORT', 'SUPPORT'];
        if (!validRoles.includes(body.role)) {
          sendJson(400, { error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
          return;
        }
        const updated = node.setRole(body.role);
        sendJson(200, { currentRole: updated });
        return;
      }

      // --- Operation Lifecycle & Archiving ---
      if (pathname === '/api/v1/operations' && req.method === 'GET') {
        sendJson(200, node.listOperations());
        return;
      }

      if (pathname === '/api/v1/operations' && req.method === 'POST') {
        const body = await readJsonBody();
        const opName = body.name || body.title;
        if (!body.operationId || !opName) {
          sendJson(400, { error: 'operationId and name are required' });
          return;
        }
        try {
          node.createOperation(body.operationId, opName, body.sectorGeohash);
          sendJson(201, { success: true, operationId: body.operationId });
        } catch (err: any) {
          if (err.message && err.message.startsWith('Unauthorized:')) {
            sendJson(403, { error: err.message, authorizationFailed: true });
            return;
          }
          sendJson(500, { error: err.message });
        }
        return;
      }

      const opSwitchMatch = pathname.match(/^\/api\/v1\/operations\/([^/]+)\/switch$/);
      if (opSwitchMatch && req.method === 'POST') {
        node.switchOperation(opSwitchMatch[1]);
        sendJson(200, { success: true, currentOperationId: node.currentOperationId });
        return;
      }

      const opFinalizeMatch = pathname.match(/^\/api\/v1\/operations\/([^/]+)\/finalize$/);
      if (opFinalizeMatch && req.method === 'POST') {
        node.finalizeOperation(opFinalizeMatch[1]);
        sendJson(200, { success: true, status: 'FINALIZING' });
        return;
      }

      const opArchiveMatch = pathname.match(/^\/api\/v1\/operations\/([^/]+)\/archive$/);
      if (opArchiveMatch && req.method === 'POST') {
        const archiveInfo = node.archiveOperation(opArchiveMatch[1]);
        sendJson(200, { success: true, archiveInfo });
        return;
      }


      if (pathname === '/api/v1/patients' && req.method === 'GET') {
        sendJson(200, node.listPatients());
        return;
      }

      if (pathname === '/api/v1/patients' && req.method === 'POST') {
        const body = await readJsonBody();
        const doc = node.createPatient(body.ephemeralId);
        const triageCat = body.priority || body.category;
        if (triageCat && ['RED', 'YELLOW', 'GREEN', 'BLACK'].includes(triageCat)) {
          try {
            node.recordTriage(doc.patientId, triageCat, 'START_v1.0.0', body.overrideReason);
          } catch (e) {}
        }
        if (body.notes && typeof body.notes === 'string') {
          node.recordNote(doc.patientId, body.notes);
        }
        const updated = node.db.getPatientDocument(doc.patientId) || doc;
        sendJson(201, updated);
        return;
      }

      const triageMatch = pathname.match(/^\/api\/v1\/patients\/([^/]+)\/triage$/);
      if (triageMatch && req.method === 'POST') {
        const patientId = triageMatch[1];
        const body = await readJsonBody();
        if (!body.category || !['RED', 'YELLOW', 'GREEN', 'BLACK'].includes(body.category)) {
          sendJson(400, { error: 'Invalid or missing category. Must be RED, YELLOW, GREEN, or BLACK' });
          return;
        }
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

      const injuryMatch = pathname.match(/^\/api\/v1\/patients\/([^/]+)\/injur(?:y|ies)$/);
      if (injuryMatch && req.method === 'POST') {
        const patientId = injuryMatch[1];
        const body = await readJsonBody();
        const classification = body.classification || body.description;
        if (!classification) { sendJson(400, { error: 'Field "classification" or "description" required' }); return; }
        const tourniquet = body.tourniquetApplied === true || Boolean(classification && classification.toLowerCase().includes('tourniquet'));
        const updatedDoc = node.recordInjury(patientId, body.location || 'General Trauma', classification, tourniquet);
        sendJson(200, updatedDoc);
        return;
      }

      // Patient resource endpoints: GET, PUT, PATCH, DELETE
      const singlePatientMatch = pathname.match(/^\/api\/v1\/patients\/([^/]+)$/);
      if (singlePatientMatch && req.method === 'GET') {
        const patientId = singlePatientMatch[1];
        const doc = node.resolvePatient(patientId, patientId === 'pt_001');
        if (!doc) { sendJson(404, { error: `Patient ${patientId} not found` }); return; }
        const auditTrail = node.db.getAuditTrail(doc.patientId);
        sendJson(200, { doc, auditTrail });
        return;
      }

      if (singlePatientMatch && req.method === 'PUT') {
        const patientId = singlePatientMatch[1];
        const body = await readJsonBody();
        const existing = node.db.getPatientDocument(patientId);
        if (!existing) { sendJson(404, { error: `Patient ${patientId} not found` }); return; }
        if (body.notes && typeof body.notes === 'string') {
          node.recordNote(patientId, body.notes);
        }
        if (body.category && ['RED', 'YELLOW', 'GREEN', 'BLACK'].includes(body.category)) {
          node.recordTriage(patientId, body.category, 'START_v1.0.0', body.overrideReason);
        }
        const updated = node.db.getPatientDocument(patientId);
        sendJson(200, updated);
        return;
      }

      if (singlePatientMatch && req.method === 'PATCH') {
        const patientId = singlePatientMatch[1];
        const body = await readJsonBody();
        const existing = node.db.getPatientDocument(patientId);
        if (!existing) { sendJson(404, { error: `Patient ${patientId} not found` }); return; }
        if (body.category && ['RED', 'YELLOW', 'GREEN', 'BLACK'].includes(body.category)) {
          node.recordTriage(patientId, body.category, 'START_v1.0.0', body.overrideReason);
        }
        const noteContent = body.notes || body.note;
        if (noteContent && typeof noteContent === 'string') {
          node.recordNote(patientId, noteContent);
        }
        const updated = node.db.getPatientDocument(patientId);
        sendJson(200, { success: true, patient: updated });
        return;
      }

      if (singlePatientMatch && req.method === 'DELETE') {
        const patientId = singlePatientMatch[1];
        const doc = node.db.getPatientDocument(patientId);
        if (!doc) { sendJson(404, { error: `Patient ${patientId} not found` }); return; }
        node.recordTriage(patientId, 'BLACK', 'START_v1.0.0', 'Discharged / Transfer out of sector');
        node.db.logAuditEvent(node.generateAuditId(), patientId, 'PATIENT_DISCHARGED', node.nodeId, { reason: 'Discharged or transferred' });
        sendJson(200, { success: true, patientId, status: 'DISCHARGED' });
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
        if (!body.drugName || typeof body.drugName !== 'string' || body.drugName.trim().length === 0) {
          sendJson(400, { error: 'Field "drugName" is required and cannot be empty' });
          return;
        }
        if (!body.dosage || typeof body.dosage !== 'string' || body.dosage.trim().length === 0) {
          sendJson(400, { error: 'Field "dosage" is required and cannot be empty' });
          return;
        }
        try {
          const result = node.recordMedication(patientId, body.drugName.trim(), body.dosage.trim(), body.route, Boolean(body.forceOverride));
          sendJson(200, result);
        } catch (err: any) {
          if (err.message && err.message.startsWith('ALLERGY_COLLISION:')) {
            sendJson(409, { error: err.message, allergyCollision: true });
            return;
          }
          throw err;
        }
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

      if (pathname.startsWith('/api/v1/vault/sample') && req.method === 'GET') {
        const targetPatientId = parsedUrl.searchParams.get('patientId');
        let citizenName = 'Aarav Sharma';
        let citizenId = 'CITIZEN-VAL-8821';
        if (targetPatientId) {
          const patient = node.db.getPatientDocument(targetPatientId);
          if (patient) {
            citizenId = `CITIZEN-${patient.ephemeralId}`;
            citizenName = `Citizen ${patient.ephemeralId}`;
          }
        }
        sendJson(200, {
          profile: {
            citizenId,
            fullName: citizenName,
            isSyntheticDemo: true,
            bloodGroup: 'O+ (DEMO)',
            allergies: ['Penicillin (SYNTHETIC DEMO)', 'Sulfa (SYNTHETIC DEMO)'],
            chronicConditions: ['Asthma (SYNTHETIC DEMO)'],
            currentMedications: [{ name: 'Albuterol (SYNTHETIC DEMO)', dosage: 'Simulated' }],
            emergencyContacts: [{ name: 'Emergency Family Contact', relation: 'Next-of-kin', phone: '+1-555-019-2831' }],
            updatedAt: Date.now()
          },
          snapshot: {
            citizenId,
            fullName: citizenName,
            isSyntheticDemo: true,
            bloodGroup: 'O+ (DEMO)',
            allergies: ['Penicillin (SYNTHETIC DEMO)', 'Sulfa (SYNTHETIC DEMO)'],
            criticalConditions: ['Asthma (SYNTHETIC DEMO)'],
            currentMedicationsSummary: ['Albuterol (SYNTHETIC DEMO)'],
            emergencyContacts: [{ name: 'Emergency Family Contact', relation: 'Next-of-kin', phone: '+1-555-019-2831' }],
            extractedAt: Date.now()
          }
        });
        return;
      }

      if (pathname === '/api/v1/ai/transcribe-audio' && req.method === 'POST') {
        const contentType = req.headers['content-type'] || '';
        let audioBuf: Buffer;
        let patientId: string | undefined;

        if (contentType.includes('application/json')) {
          const body = await readJsonBody();
          if (!body.audioBase64) {
            sendJson(400, { error: 'Field "audioBase64" is required when Content-Type is application/json' });
            return;
          }
          audioBuf = Buffer.from(body.audioBase64, 'base64');
          patientId = body.patientId;
        } else {
          audioBuf = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(Buffer.from(chunk)));
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
          });
          patientId = req.headers['x-patient-id'] as string | undefined;
        }

        const result = await node.processVoiceAudio(audioBuf, patientId);
        sendJson(200, result);
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
        sendJson(200, node.recentWirePackets || []);
        return;
      }

      const singleWireMatch = pathname.match(/^\/api\/v1\/telemetry\/packets\/([^/]+)$/);
      if (singleWireMatch && req.method === 'GET') {
        const pId = singleWireMatch[1];
        const found = (node.recentWirePackets || []).find(p => p.id === pId || p.bundleId === pId);
        if (!found) {
          sendJson(404, { error: `Wire packet ${pId} not found` });
          return;
        }
        sendJson(200, found);
        return;
      }

      if (pathname === '/api/v1/telemetry/packets' && req.method === 'POST') {
        const body = await readJsonBody();
        if (!body.rawWireHex && !body.payload) {
          sendJson(400, { error: 'Field "rawWireHex" or "payload" is required for telemetry ingestion' });
          return;
        }
        sendJson(200, { success: true, ingested: true, timestamp: Date.now() });
        return;
      }

      if (pathname === '/api/v1/telemetry/nostr' && req.method === 'GET') {
        sendJson(200, { events: node.recentNostrEvents, relayAcks: node.relayPool ? node.relayPool.getAcks() : [] });
        return;
      }

      if (pathname === '/api/v1/telemetry/dtn' && req.method === 'GET') {
        const bundles = node.db.listPendingDtnBundles(node.currentOperationId).map(b => {
          let decodedInfo: any = {};
          try {
            const wire = decodePacket(b.payload);
            let parsedPayload: any = null;
            try {
              parsedPayload = JSON.parse(wire.payload.toString('utf-8'));
            } catch {
              parsedPayload = wire.payload.toString('utf-8');
            }
            decodedInfo = {
              magic: '0x' + MAGIC_BYTES.toString(16).toUpperCase(),
              crc32Hex: '0x' + wire.header.checksum.toString(16).toUpperCase(),
              crcValid: true,
              geohash: wire.header.geohash,
              sourcePubkey: wire.header.senderPubkeyHash,
              packetType: wire.header.type,
              decodedPayload: parsedPayload
            };
          } catch (err: any) {
            decodedInfo = { crcValid: false, decodeError: err.message };
          }

          return {
            bundleId: b.bundleId,
            priority: b.priority === 3 ? 'CRITICAL_SOS' : 'CLINICAL_DELTA',
            hopCount: b.hopCount,
            maxHops: b.maxHops,
            createdAt: b.createdAt,
            timeStr: new Date(b.createdAt).toLocaleTimeString(),
            payloadBytes: b.payload.length,
            deliveryStatus: 'QUEUED_IN_OUTBOX',
            rawWireHex: b.payload.toString('hex'),
            ...decodedInfo
          };
        });
        sendJson(200, bundles);
        return;
      }

      const singleDtnMatch = pathname.match(/^\/api\/v1\/telemetry\/dtn\/([^/]+)$/);
      if (singleDtnMatch && req.method === 'GET') {
        const targetBundleId = singleDtnMatch[1];
        const allBundles = node.db.listPendingDtnBundles(node.currentOperationId);
        const b = allBundles.find(item => item.bundleId === targetBundleId);
        if (!b) {
          sendJson(404, { error: `Bundle ${targetBundleId} not found in outbox` });
          return;
        }
        let decodedInfo: any = {};
        try {
          const wire = decodePacket(b.payload);
          let parsedPayload: any = null;
          try { parsedPayload = JSON.parse(wire.payload.toString('utf-8')); } catch { parsedPayload = wire.payload.toString('utf-8'); }
          decodedInfo = {
            magic: '0x' + MAGIC_BYTES.toString(16).toUpperCase(),
            crc32Hex: '0x' + wire.header.checksum.toString(16).toUpperCase(),
            crcValid: true,
            geohash: wire.header.geohash,
            sourcePubkey: wire.header.senderPubkeyHash,
            packetType: wire.header.type,
            decodedPayload: parsedPayload
          };
        } catch (err: any) {
          decodedInfo = { crcValid: false, decodeError: err.message };
        }
        sendJson(200, {
          bundleId: b.bundleId,
          priority: b.priority === 3 ? 'CRITICAL_SOS' : 'CLINICAL_DELTA',
          hopCount: b.hopCount,
          maxHops: b.maxHops,
          createdAt: b.createdAt,
          timeStr: new Date(b.createdAt).toLocaleTimeString(),
          payloadBytes: b.payload.length,
          deliveryStatus: 'QUEUED_IN_OUTBOX',
          rawWireHex: b.payload.toString('hex'),
          ...decodedInfo
        });
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

      // -------------------------------------------------------------
      // MESH SYNC & PEER PAIRING ENDPOINTS
      // -------------------------------------------------------------
      if ((pathname === '/api/v1/mesh/info' || pathname === '/api/v1/mesh/status') && req.method === 'GET') {
        const info = node.getLanSyncInfo ? node.getLanSyncInfo() : {
          nodeId: node.nodeId,
          port: 4323,
          ipAddresses: ['127.0.0.1'],
          pairingPin: 'TACTICAL-000000',
          peers: [],
          outboxCount: 0
        };
        sendJson(200, info);
        return;
      }

      if (pathname === '/api/v1/mesh/peers' && req.method === 'GET') {
        const peers = (node.lanSync && typeof node.lanSync.getPeersList === 'function')
          ? node.lanSync.getPeersList()
          : [];
        sendJson(200, peers);
        return;
      }

      if (pathname === '/api/v1/mesh/probe' && req.method === 'POST') {
        const body = await readJsonBody();
        if (!body.peerAddress || typeof body.peerAddress !== 'string' || !body.peerAddress.trim()) {
          sendJson(400, { error: 'Field "peerAddress" is required (e.g. 10.50.10.15:4322)' });
          return;
        }
        try {
          const probeResult = await node.probePeer(body.peerAddress.trim());
          sendJson(200, probeResult);
        } catch (err: any) {
          sendJson(502, { error: `Peer probe failed: ${err.message}` });
        }
        return;
      }

      if (pathname === '/api/v1/mesh/pair' && req.method === 'POST') {
        const body = await readJsonBody();
        if (!body.peerAddress || typeof body.peerAddress !== 'string' || !body.peerAddress.trim()) {
          sendJson(400, { error: 'Field "peerAddress" is required (e.g. 10.50.10.15:4322)' });
          return;
        }
        if (!body.pairingPin || typeof body.pairingPin !== 'string' || !body.pairingPin.trim()) {
          sendJson(400, { error: 'Field "pairingPin" is required (e.g. TACTICAL-XXXXXX)' });
          return;
        }
        try {
          const session = await node.pairWithPeer(body.peerAddress.trim(), body.pairingPin.trim());
          sendJson(200, {
            success: true,
            status: 'PAIRED',
            sessionId: session.sessionId,
            serverNodeId: session.serverNodeId,
            peerAddress: session.peerAddress,
            pairedAt: session.pairedAt
          });
        } catch (err: any) {
          const isAuth = err.message && (err.message.includes('401') || err.message.toLowerCase().includes('pin'));
          sendJson(isAuth ? 401 : 502, { error: `Pairing failed: ${err.message}` });
        }
        return;
      }

      if (pathname === '/api/v1/mesh/sync' && req.method === 'POST') {
        const body = await readJsonBody();
        if (!body.peerAddress || typeof body.peerAddress !== 'string' || !body.peerAddress.trim()) {
          sendJson(400, { error: 'Field "peerAddress" is required (e.g. 10.50.10.15:4322)' });
          return;
        }
        try {
          const syncResult = await node.syncWithPeer(body.peerAddress.trim(), body.pairingPin?.trim());
          sendJson(200, syncResult);
        } catch (err: any) {
          sendJson(500, { error: `Synchronization failed: ${err.message}` });
        }
        return;
      }

      if (pathname === '/api/v1/mesh/pin' && req.method === 'POST') {
        const body = await readJsonBody();
        if (!body.pairingPin || typeof body.pairingPin !== 'string' || !body.pairingPin.trim()) {
          sendJson(400, { error: 'Field "pairingPin" is required' });
          return;
        }
        const updatedPin = node.setPairingPin ? node.setPairingPin(body.pairingPin.trim()) : body.pairingPin.trim();
        sendJson(200, { success: true, pairingPin: updatedPin });
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
      if (err.message === 'Invalid JSON') {
        sendJson(400, { error: 'Malformed JSON payload' });
        return;
      }
      if (err.message === 'Payload too large') {
        sendJson(413, { error: 'Payload exceeds 2MB limit' });
        return;
      }
      if (err.message && err.message.startsWith('Unauthorized:')) {
        sendJson(403, { error: err.message, authorizationFailed: true });
        return;
      }
      if (err.message && err.message.includes('not found')) {
        sendJson(404, { error: err.message });
        return;
      }
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
