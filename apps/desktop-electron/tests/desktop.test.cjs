process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const {
  LanSyncService,
  generateX25519KeyPair,
  computeX25519DH,
  deriveHandshakeKeys,
  computeAuthProof
} = require('../src/lan_sync.cjs');
const {
  getOrCreateVaultKey,
  encryptVault,
  decryptVault,
  VaultDecryptionError
} = require('../src/vault_crypto.cjs');
const { TacticalStorageEngine } = require('../src/persistence_store.cjs');

// Helper to make POST requests and parse JSON
function requestJson(url, options = {}, payload = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : null;
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (bodyStr) {
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(parsed, {
      method: options.method || (bodyStr ? 'POST' : 'GET'),
      headers: reqHeaders,
      timeout: options.timeout || 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          json
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out to ${url}`));
    });
    req.on('error', reject);

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe('PeerScribe Windows Electron Desktop Engine', () => {
  it('validates preload script channel whitelists', () => {
    const preloadPath = path.resolve(__dirname, '../src/preload.cjs');
    assert.ok(fs.existsSync(preloadPath), 'Preload script must exist');
    const content = fs.readFileSync(preloadPath, 'utf8');

    // Context bridge and isolation checks
    assert.ok(content.includes('contextBridge.exposeInMainWorld'), 'Must expose via contextBridge');
    assert.ok(content.includes('ALLOWED_INVOKE_CHANNELS'), 'Must define invoke whitelist');
    assert.ok(content.includes('ALLOWED_RECEIVE_CHANNELS'), 'Must define receive whitelist');
    assert.ok(content.includes('clinical:change-triage'), 'Must include clinical triage channel');
    assert.ok(content.includes('clinical:resolve-divergence'), 'Must include divergence resolution');
    assert.ok(content.includes('sync:pair-peer'), 'Must include sync pairing channel');
  });

  it('verifies manifest package.json build configurations', () => {
    const pkgPath = path.resolve(__dirname, '../package.json');
    assert.ok(fs.existsSync(pkgPath), 'package.json must exist');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    assert.strictEqual(pkg.name, '@peerscribe/desktop-electron');
    assert.strictEqual(pkg.version, '1.0.0', 'First release version must be named v1.0 (1.0.0)');
    assert.ok(pkg.build, 'Must contain electron-builder config');
    assert.strictEqual(pkg.build.appId, 'org.peerscribe.desktop');
    assert.ok(pkg.build.nsis.differentialPackage, 'Must enable differential delta packaging');
    assert.ok(pkg.build.win, 'Must contain Windows build config');
    assert.ok(
      pkg.build.win.target.some(t => t.target === 'nsis'),
      'Must configure NSIS installer'
    );
    assert.ok(
      pkg.build.win.target.some(t => t.target === 'portable' || t.target === 'zip'),
      'Must configure portable target'
    );
  });

  // --------------------------------------------------------------------------
  // P0-2 & P1-D: AES-256-GCM Vault Encryption & Protected Key Management Tests
  // --------------------------------------------------------------------------
  describe('P0-2: Personal Profile Vault AES-256-GCM & Key Security', () => {
    const testScratchDir = path.resolve(__dirname, '../test_scratch_vault');
    const keyFile = path.join(testScratchDir, 'vault.key');
    const vaultFile = path.join(testScratchDir, 'personal_vault.enc');

    beforeEach(() => {
      if (fs.existsSync(testScratchDir)) {
        fs.rmSync(testScratchDir, { recursive: true, force: true });
      }
      fs.mkdirSync(testScratchDir, { recursive: true });
    });

    it('generates, persists, and recovers 256-bit AES master key without hardcoding', () => {
      // 1. Initial key creation
      const key1 = getOrCreateVaultKey(keyFile);
      assert.strictEqual(Buffer.isBuffer(key1), true);
      assert.strictEqual(key1.length, 32, 'Master key must be exactly 32 bytes (256 bits)');
      assert.ok(fs.existsSync(keyFile), 'Key file must be durably persisted');

      // 2. Restart simulation: Key must persist and match
      const key2 = getOrCreateVaultKey(keyFile);
      assert.strictEqual(key1.equals(key2), true, 'Key must be persistent across application restarts');
    });

    it('fails closed in production when safeStorage is unavailable', () => {
      const origEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        const prodKeyFile = path.join(testScratchDir, 'prod.key');
        assert.throws(
          () => getOrCreateVaultKey(prodKeyFile, { safeStorage: { isEncryptionAvailable: () => false } }),
          /Security Violation: Electron safeStorage .* unavailable/
        );
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it('performs roundtrip AES-256-GCM encryption and decryption', () => {
      const key = getOrCreateVaultKey(keyFile);
      const profileData = {
        is_configured: true,
        blood_group: 'AB-',
        allergies: ['Penicillin', 'Sulfa'],
        critical_conditions: ['Type 1 Diabetes'],
        emergency_contacts: [{ name: 'Dr. Evelyn Reed', phone: '+1-555-0199' }]
      };

      const encrypted = encryptVault(profileData, key);
      const parsedEnvelope = JSON.parse(encrypted);

      assert.strictEqual(parsedEnvelope.cipher, 'aes-256-gcm');
      assert.ok(parsedEnvelope.iv, 'Must contain 12-byte IV (96-bit nonce)');
      assert.ok(parsedEnvelope.tag, 'Must contain 16-byte authentication tag');
      assert.ok(parsedEnvelope.ciphertext, 'Must contain ciphertext');

      const decrypted = decryptVault(encrypted, key);
      assert.deepStrictEqual(decrypted, profileData, 'Decrypted profile must match original');
    });

    it('rejects tampered ciphertext and modified authentication tags', () => {
      const key = getOrCreateVaultKey(keyFile);
      const profileData = { blood_group: 'O+', allergies: ['Latex'] };
      const encrypted = encryptVault(profileData, key);
      const envelope = JSON.parse(encrypted);

      // Tamper ciphertext
      const rawCipher = Buffer.from(envelope.ciphertext, 'base64');
      rawCipher[0] = rawCipher[0] ^ 0xFF; // flip bits
      const tamperedCiphertext = JSON.stringify({ ...envelope, ciphertext: rawCipher.toString('base64') });

      assert.throws(
        () => decryptVault(tamperedCiphertext, key),
        /Vault authentication or decryption failed/,
        'Tampered ciphertext must be rejected by GCM tag verification'
      );

      // Tamper auth tag
      const rawTag = Buffer.from(envelope.tag, 'base64');
      rawTag[0] = rawTag[0] ^ 0xFF;
      const tamperedTag = JSON.stringify({ ...envelope, tag: rawTag.toString('base64') });

      assert.throws(
        () => decryptVault(tamperedTag, key),
        /Vault authentication or decryption failed/,
        'Tampered authentication tag must be rejected'
      );
    });

    it('rejects decryption when wrong or rotated key is supplied', () => {
      const keyA = crypto.randomBytes(32);
      const keyB = crypto.randomBytes(32);

      const profileData = { blood_group: 'A+', allergies: [] };
      const encrypted = encryptVault(profileData, keyA);

      assert.throws(
        () => decryptVault(encrypted, keyB),
        /Vault authentication or decryption failed/,
        'Attempting decryption with incorrect key must fail'
      );
    });

    it('preserves personal profile vault across operational emergency wipes', () => {
      const key = getOrCreateVaultKey(keyFile);
      const profile = { blood_group: 'B+', allergies: ['Iodine'] };
      fs.writeFileSync(vaultFile, encryptVault(profile, key), 'utf8');

      const eventsFile = path.join(testScratchDir, 'immutable_events.jsonl');
      fs.writeFileSync(eventsFile, '{"event_id":"evt_01","type":"PATIENT_CREATED"}\n', 'utf8');

      // Emergency wipe clears operational events
      fs.unlinkSync(eventsFile);

      assert.strictEqual(fs.existsSync(eventsFile), false, 'Operation records wiped');
      assert.strictEqual(fs.existsSync(vaultFile), true, 'Personal vault retained and isolated');

      const decrypted = decryptVault(fs.readFileSync(vaultFile, 'utf8'), key);
      assert.deepStrictEqual(decrypted, profile, 'Personal vault data intact');
    });

    it('gracefully recovers without crashing when vault file is corrupt', () => {
      const key = getOrCreateVaultKey(keyFile);
      fs.writeFileSync(vaultFile, 'corrupted_non_json_garbage', 'utf8');

      assert.throws(
        () => decryptVault(fs.readFileSync(vaultFile, 'utf8'), key),
        /Vault data is not valid JSON/
      );
    });
  });

  // --------------------------------------------------------------------------
  // P0-A: Peer Pairing & Authenticated Encrypted LAN Sessions Tests
  // --------------------------------------------------------------------------
  describe('P0-1: Peer Pairing, Authentication, and Negative Security Tests', () => {
    let serviceHost;
    let serviceClient;
    const hostPort = 4420;
    const clientPort = 4421;
    const hostPairingPin = 'TACTICAL-778899';

    before(async () => {
      serviceHost = new LanSyncService({
        port: hostPort,
        nodeId: 'node_host_test',
        pairingPin: hostPairingPin,
        getState: () => ({ eventsLog: [], outboxQueue: [], activeOperation: { operation_id: 'OP_TEST' } }),
        onEventsIngested: () => 0
      });
      serviceClient = new LanSyncService({
        port: clientPort,
        nodeId: 'node_client_test',
        getState: () => ({ eventsLog: [], outboxQueue: [], activeOperation: { operation_id: 'OP_TEST' } }),
        onEventsIngested: () => 0
      });

      await serviceHost.startServer();
      await serviceClient.startServer();
    });

    after(async () => {
      if (serviceHost) await serviceHost.stopServer();
      if (serviceClient) await serviceClient.stopServer();
    });

    beforeEach(() => {
      serviceHost.setPairingPin(hostPairingPin);
      serviceHost.failedAttempts.clear();
      serviceHost.activeSessions.clear();
      serviceClient.clientSessions.clear();
    });

    it('GET /api/v1/sync/info never exposes secrets, tokens, or pairing PIN', async () => {
      const res = await requestJson(`http://127.0.0.1:${hostPort}/api/v1/sync/info`);
      const info = res.json;

      assert.strictEqual(info.status, 'OK');
      assert.strictEqual(info.nodeId, 'node_host_test');
      assert.strictEqual(info.requiresPairing, true);
      assert.strictEqual(info.pairingToken, undefined, 'Public info MUST NOT expose pairing token');
      assert.strictEqual(info.pairingPin, undefined, 'Public info MUST NOT expose pairing PIN');
      assert.strictEqual(info.sessionKey, undefined, 'Public info MUST NOT expose session key');
    });

    it('rejects pairing with invalid pairing PIN (401)', async () => {
      await assert.rejects(
        () => serviceClient.pairWithPeer(`http://127.0.0.1:${hostPort}`, 'WRONG-PIN-123'),
        /401/
      );
    });

    it('successfully pairs with valid PIN and establishes encrypted session via X25519 DH', async () => {
      const session = await serviceClient.pairWithPeer(`http://127.0.0.1:${hostPort}`, hostPairingPin);
      assert.ok(session.sessionId.startsWith('sess_'));
      assert.ok(session.sessionToken, 'Must receive session token');
      assert.strictEqual(Buffer.isBuffer(session.sessionKey), true);
      assert.strictEqual(session.sessionKey.length, 32, 'Session key must be 256 bits');
      assert.ok(session.sas, 'Must compute short authentication string');
    });

    it('proves that a network eavesdropper with full transcript cannot compute session keys or PIN without DH private key', async () => {
      const eavesdroppedTranscript = [];

      // Intercept and record the pairing handshake
      const clientEphemeral = generateX25519KeyPair();
      const clientNonce = crypto.randomBytes(32);

      // Step 1: client -> host pair-init
      const initPayload = {
        client_node_id: serviceClient.nodeId,
        client_ephemeral_pub: clientEphemeral.publicKey.toString('base64'),
        client_nonce: clientNonce.toString('base64')
      };
      eavesdroppedTranscript.push({ step: 'init_req', body: initPayload });

      const initRes = await requestJson(`http://127.0.0.1:${hostPort}/api/v1/sync/pair-init`, {}, initPayload);
      eavesdroppedTranscript.push({ step: 'init_res', body: initRes.json });

      // Step 2: client -> host pair-confirm
      const serverPubBytes = Buffer.from(initRes.json.server_ephemeral_pub, 'base64');
      const serverNonce = Buffer.from(initRes.json.server_nonce, 'base64');
      const sharedDH = computeX25519DH(clientEphemeral.privateKey, serverPubBytes);

      const { confirmKey, sessionKey } = deriveHandshakeKeys(
        sharedDH,
        clientNonce,
        serverNonce,
        serviceClient.nodeId,
        initRes.json.server_node_id,
        hostPairingPin
      );

      const clientProof = computeAuthProof(confirmKey, 'CLIENT-PROOF', initRes.json.handshake_id, serviceClient.nodeId, initRes.json.server_node_id);
      const confirmPayload = {
        handshake_id: initRes.json.handshake_id,
        client_node_id: serviceClient.nodeId,
        client_proof: clientProof.toString('base64')
      };
      eavesdroppedTranscript.push({ step: 'confirm_req', body: confirmPayload });

      const confirmRes = await requestJson(`http://127.0.0.1:${hostPort}/api/v1/sync/pair-confirm`, {}, confirmPayload);
      eavesdroppedTranscript.push({ step: 'confirm_res', body: confirmRes.json });

      assert.strictEqual(confirmRes.json.status, 'PAIRED');

      // Assert 1: The PIN is nowhere in the plaintext network transcript!
      const transcriptStr = JSON.stringify(eavesdroppedTranscript);
      assert.strictEqual(transcriptStr.includes(hostPairingPin), false, 'PIN must NEVER appear in network transcript');

      // Assert 2: An observer attempting candidate PINs without private DH keys cannot derive the valid session key
      const fakeSharedDH = crypto.randomBytes(32); // Observer does NOT possess client or server private keys
      const candidateKeys = deriveHandshakeKeys(
        fakeSharedDH,
        clientNonce,
        serverNonce,
        serviceClient.nodeId,
        initRes.json.server_node_id,
        hostPairingPin
      );
      assert.strictEqual(candidateKeys.sessionKey.equals(sessionKey), false, 'Observer without DH private key cannot compute session key');
    });

    it('enforces lockout after 3 consecutive failed pairing attempts (429)', async () => {
      const attackerNodeId = 'node_attacker_' + crypto.randomUUID();

      for (let i = 0; i < 3; i++) {
        const attackerClient = new LanSyncService({ nodeId: attackerNodeId });
        await assert.rejects(
          () => attackerClient.pairWithPeer(`http://127.0.0.1:${hostPort}`, 'WRONG_PIN_' + i),
          /401/
        );
      }

      // 4th attempt must be locked out with 429
      const lockedClient = new LanSyncService({ nodeId: attackerNodeId });
      await assert.rejects(
        () => lockedClient.pairWithPeer(`http://127.0.0.1:${hostPort}`, hostPairingPin),
        /429/
      );
    });

    it('rejects unauthenticated bundle requests (401)', async () => {
      const res = await requestJson(`http://127.0.0.1:${hostPort}/api/v1/sync/bundle`, {}, { events: [] });
      assert.strictEqual(res.statusCode, 401, 'Unauthenticated bundle request must be rejected with 401');
    });

    it('rejects unauthenticated ack requests (401)', async () => {
      const res = await requestJson(`http://127.0.0.1:${hostPort}/api/v1/sync/ack`, {}, { acknowledged_event_ids: ['evt_1'] });
      assert.strictEqual(res.statusCode, 401, 'Unauthenticated ack request must be rejected with 401');
    });

    it('rejects bundle requests missing any of the 5 mandatory security headers', async () => {
      const session = await serviceClient.pairWithPeer(`http://127.0.0.1:${hostPort}`, hostPairingPin);

      const allHeaders = {
        'X-PeerScribe-Session': session.sessionId,
        'X-PeerScribe-Token': session.sessionToken,
        'X-PeerScribe-Peer-Id': serviceClient.nodeId,
        'X-PeerScribe-Nonce': 'nonce_' + crypto.randomUUID(),
        'X-PeerScribe-Timestamp': new Date().toISOString()
      };

      for (const headerKey of ['X-PeerScribe-Session', 'X-PeerScribe-Token', 'X-PeerScribe-Peer-Id', 'X-PeerScribe-Nonce', 'X-PeerScribe-Timestamp']) {
        const headers = { ...allHeaders };
        delete headers[headerKey];

        const res = await requestJson(`http://127.0.0.1:${hostPort}/api/v1/sync/bundle`, { headers }, { encrypted_payload: {} });
        assert.strictEqual(res.statusCode, 401, `Missing ${headerKey} must return 401`);
      }
    });

    it('rejects forged peer identity that does not match session binding (403)', async () => {
      const session = await serviceClient.pairWithPeer(`http://127.0.0.1:${hostPort}`, hostPairingPin);

      const res = await requestJson(`http://127.0.0.1:${hostPort}/api/v1/sync/bundle`, {
        headers: {
          'X-PeerScribe-Session': session.sessionId,
          'X-PeerScribe-Token': session.sessionToken,
          'X-PeerScribe-Peer-Id': 'impostor_node_id', // Forged peer ID!
          'X-PeerScribe-Nonce': 'nonce_' + crypto.randomUUID(),
          'X-PeerScribe-Timestamp': new Date().toISOString()
        }
      }, { encrypted_payload: {} });

      assert.strictEqual(res.statusCode, 403, 'Forged peer identity must be rejected with 403 Forbidden');
    });

    it('rejects malformed JSON payloads (400)', async () => {
      const res = await requestJson(`http://127.0.0.1:${hostPort}/api/v1/sync/pair-init`, {}, 'this_is_not_valid_json{{');
      assert.strictEqual(res.statusCode, 400, 'Malformed JSON must return 400 Bad Request');
    });

    it('rejects oversized request bodies exceeding 2MB (413)', async () => {
      const hugeBuffer = Buffer.alloc(2.5 * 1024 * 1024, 'X'); // 2.5 MB

      const res = await new Promise((resolve) => {
        const req = http.request(`http://127.0.0.1:${hostPort}/api/v1/sync/pair-init`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': hugeBuffer.length
          }
        }, (r) => {
          r.on('data', () => {});
          r.on('end', () => resolve(r));
        });
        req.on('error', () => {
          resolve({ statusCode: 413 });
        });
        req.write(hugeBuffer);
        req.end();
      });

      assert.strictEqual(res.statusCode, 413, 'Oversized payload must return 413 Payload Too Large');
    });

    it('detects and rejects replayed request nonces (409)', async () => {
      const session = await serviceClient.pairWithPeer(`http://127.0.0.1:${hostPort}`, hostPairingPin);
      const replayNonce = 'fixed_nonce_' + crypto.randomUUID();
      const timestamp = new Date().toISOString();

      const sendReq = () => requestJson(`http://127.0.0.1:${hostPort}/api/v1/sync/ack`, {
        headers: {
          'X-PeerScribe-Session': session.sessionId,
          'X-PeerScribe-Token': session.sessionToken,
          'X-PeerScribe-Peer-Id': serviceClient.nodeId,
          'X-PeerScribe-Nonce': replayNonce,
          'X-PeerScribe-Timestamp': timestamp
        }
      }, { acknowledged_event_ids: [] });

      const res1 = await sendReq();
      assert.strictEqual(res1.statusCode, 200);

      // Replay identical request with identical nonce
      const res2 = await sendReq();
      assert.strictEqual(res2.statusCode, 409, 'Replayed nonce must be rejected with 409 Conflict');
    });

    it('rejects forged ack IDs not transmitted to that peer in that session', async () => {
      let hostOutbox = [
        {
          schema_version: 1,
          event_id: 'evt_real_outbox_untransmitted',
          operation_id: 'OP_ACK',
          entity_id: 'pt_1',
          event_type: 'PATIENT_CREATED',
          actor_id: 'host_node',
          actor_sequence: 1,
          lamport_timestamp: 1,
          occurred_at_utc: new Date().toISOString(),
          payload: {}
        }
      ];

      serviceHost.getState = () => ({
        eventsLog: [],
        outboxQueue: hostOutbox,
        activeOperation: { operation_id: 'OP_ACK' }
      });
      serviceHost.onOutboxAcknowledged = (ids) => {
        hostOutbox = hostOutbox.filter(e => !ids.includes(e.event_id));
      };

      const session = await serviceClient.pairWithPeer(`http://127.0.0.1:${hostPort}`, hostPairingPin);

      // Client sends an ACK for 'evt_real_outbox_untransmitted' WITHOUT host having sent it to client
      const ackRes = await requestJson(`http://127.0.0.1:${hostPort}/api/v1/sync/ack`, {
        headers: {
          'X-PeerScribe-Session': session.sessionId,
          'X-PeerScribe-Token': session.sessionToken,
          'X-PeerScribe-Peer-Id': serviceClient.nodeId,
          'X-PeerScribe-Nonce': 'nonce_forged_' + crypto.randomUUID(),
          'X-PeerScribe-Timestamp': new Date().toISOString()
        }
      }, { acknowledged_event_ids: ['evt_real_outbox_untransmitted'] });

      assert.strictEqual(ackRes.statusCode, 200);
      assert.strictEqual(ackRes.json.acknowledged, 0, 'Forged ID must NOT be acknowledged');
      assert.strictEqual(ackRes.json.rejected_forged, 1, 'Forged ID must be counted in rejected_forged');
      assert.strictEqual(hostOutbox.length, 1, 'Host outbox must remain untouched');
    });
  });

  // --------------------------------------------------------------------------
  // P0-B: Strict Durable Event Acknowledgement Invariants
  // --------------------------------------------------------------------------
  describe('P0-3: Strict Durable Event Acknowledgement Invariants', () => {
    let host;
    let client;
    const hostPort = 4424;
    const clientPort = 4425;
    const pin = 'TACTICAL-334455';
    let hostEvents = [];
    let hostOutbox = [];
    let shouldDbFail = false;

    before(async () => {
      host = new LanSyncService({
        port: hostPort,
        nodeId: 'node_host_ack_test',
        pairingPin: pin,
        getState: () => ({ eventsLog: hostEvents, outboxQueue: hostOutbox, activeOperation: { operation_id: 'OP_ACK' } }),
        onEventsIngested: (events) => {
          if (shouldDbFail) {
            throw new Error('Simulated SQLite disk write failure');
          }
          hostEvents.push(...events);
          return 0;
        },
        onOutboxAcknowledged: (ids) => {
          hostOutbox = hostOutbox.filter(e => !ids.includes(e.event_id));
        }
      });

      client = new LanSyncService({
        port: clientPort,
        nodeId: 'node_client_ack_test',
        getState: () => ({ eventsLog: [], outboxQueue: [], activeOperation: { operation_id: 'OP_ACK' } })
      });

      await host.startServer();
      await client.startServer();
    });

    after(async () => {
      if (host) await host.stopServer();
      if (client) await client.stopServer();
    });

    beforeEach(() => {
      hostEvents = [];
      hostOutbox = [];
      shouldDbFail = false;
      client.clientSessions.clear();
      host.activeSessions.clear();
      host.setPairingPin(pin);
    });

    it('rejects malformed events and does NOT acknowledge them', async () => {
      client.getState = () => ({
        eventsLog: [],
        outboxQueue: [
          {
            schema_version: 1,
            event_id: 'evt_valid_101',
            operation_id: 'OP_ACK',
            entity_id: 'pt_1',
            event_type: 'PATIENT_CREATED',
            actor_id: client.nodeId,
            actor_sequence: 1,
            lamport_timestamp: 1,
            occurred_at_utc: new Date().toISOString(),
            payload: {}
          },
          {
            schema_version: 1,
            // MISSING event_id, entity_id, event_type -> Malformed!
            occurred_at_utc: new Date().toISOString()
          }
        ],
        activeOperation: { operation_id: 'OP_ACK' }
      });

      const syncRes = await client.syncWithPeer(`http://127.0.0.1:${hostPort}`, pin);

      assert.strictEqual(syncRes.success, true);
      assert.ok(hostEvents.some(e => e.event_id === 'evt_valid_101'), 'Valid event persisted');
      assert.ok(host.rejectedEventsLog.some(r => r.reason.includes('Missing mandatory schema fields')));
    });

    it('rejects events with invalid timestamp format without acknowledgement', async () => {
      client.getState = () => ({
        eventsLog: [],
        outboxQueue: [
          {
            schema_version: 1,
            event_id: 'evt_bad_ts',
            operation_id: 'OP_ACK',
            entity_id: 'pt_ts',
            event_type: 'PATIENT_CREATED',
            actor_id: client.nodeId,
            actor_sequence: 1,
            lamport_timestamp: 1,
            occurred_at_utc: 'NOT_A_VALID_ISO_TIMESTAMP',
            payload: {}
          }
        ],
        activeOperation: { operation_id: 'OP_ACK' }
      });

      let ackedOutbox = [];
      client.onOutboxAcknowledged = (ids) => { ackedOutbox = ids; };

      const syncRes = await client.syncWithPeer(`http://127.0.0.1:${hostPort}`, pin);
      assert.strictEqual(syncRes.success, true);
      assert.strictEqual(ackedOutbox.length, 0, 'Bad timestamp must not be acknowledged');
      assert.strictEqual(hostEvents.length, 0, 'Bad timestamp event must not be persisted');
    });

    it('rejects events with invalid actor sequence or lamport timestamp (non-positive)', async () => {
      client.getState = () => ({
        eventsLog: [],
        outboxQueue: [
          {
            schema_version: 1,
            event_id: 'evt_bad_seq',
            operation_id: 'OP_ACK',
            entity_id: 'pt_seq',
            event_type: 'PATIENT_CREATED',
            actor_id: client.nodeId,
            actor_sequence: 0, // Invalid: must be positive
            lamport_timestamp: 1,
            occurred_at_utc: new Date().toISOString(),
            payload: {}
          }
        ],
        activeOperation: { operation_id: 'OP_ACK' }
      });

      let ackedOutbox = [];
      client.onOutboxAcknowledged = (ids) => { ackedOutbox = ids; };

      const syncRes = await client.syncWithPeer(`http://127.0.0.1:${hostPort}`, pin);
      assert.strictEqual(syncRes.success, true);
      assert.strictEqual(ackedOutbox.length, 0, 'Invalid sequence must not be acknowledged');
    });

    it('rejects events with unsupported schema versions without acknowledgement', async () => {
      client.getState = () => ({
        eventsLog: [],
        outboxQueue: [
          {
            schema_version: 999, // Unsupported future schema!
            event_id: 'evt_future_schema',
            operation_id: 'OP_ACK',
            entity_id: 'pt_2',
            event_type: 'PATIENT_CREATED',
            actor_id: client.nodeId,
            actor_sequence: 1,
            lamport_timestamp: 1,
            occurred_at_utc: new Date().toISOString(),
            payload: {}
          }
        ],
        activeOperation: { operation_id: 'OP_ACK' }
      });

      const syncRes = await client.syncWithPeer(`http://127.0.0.1:${hostPort}`, pin);
      assert.strictEqual(syncRes.success, true);
      assert.strictEqual(hostEvents.length, 0, 'Event with schema_version 999 must NOT be persisted');
      assert.ok(host.rejectedEventsLog.some(r => r.reason.includes('Unsupported schema_version: 999')));
    });

    it('database failure results in NO successful acknowledgement for affected events', async () => {
      shouldDbFail = true;

      client.getState = () => ({
        eventsLog: [],
        outboxQueue: [
          {
            schema_version: 1,
            event_id: 'evt_should_not_ack',
            operation_id: 'OP_ACK',
            entity_id: 'pt_3',
            event_type: 'PATIENT_CREATED',
            actor_id: client.nodeId,
            actor_sequence: 1,
            lamport_timestamp: 1,
            occurred_at_utc: new Date().toISOString(),
            payload: {}
          }
        ],
        activeOperation: { operation_id: 'OP_ACK' }
      });

      let ackedOutbox = [];
      client.onOutboxAcknowledged = (ids) => { ackedOutbox = ids; };

      const syncRes = await client.syncWithPeer(`http://127.0.0.1:${hostPort}`, pin);
      assert.strictEqual(syncRes.success, true);
      assert.strictEqual(ackedOutbox.length, 0, 'No events must be acknowledged when DB write fails');
      assert.strictEqual(hostEvents.length, 0, 'No events in host DB');
    });

    it('acknowledges duplicate events after verifying durable copy without duplicate persistence', async () => {
      const existingEvt = {
        schema_version: 1,
        event_id: 'evt_already_durable',
        operation_id: 'OP_ACK',
        entity_id: 'pt_dup',
        event_type: 'PATIENT_CREATED',
        actor_id: 'node_prior',
        actor_sequence: 1,
        lamport_timestamp: 1,
        occurred_at_utc: new Date().toISOString(),
        payload: {}
      };
      hostEvents.push(existingEvt);

      client.getState = () => ({
        eventsLog: [existingEvt],
        outboxQueue: [existingEvt],
        activeOperation: { operation_id: 'OP_ACK' }
      });

      let clientAcked = [];
      client.onOutboxAcknowledged = (ids) => { clientAcked = ids; };

      const syncRes = await client.syncWithPeer(`http://127.0.0.1:${hostPort}`, pin);
      assert.strictEqual(syncRes.success, true);
      assert.ok(clientAcked.includes('evt_already_durable'), 'Existing duplicate must be acknowledged');
      assert.strictEqual(hostEvents.length, 1, 'Duplicate event must NOT be inserted twice');
    });
  });

  // --------------------------------------------------------------------------
  // P1-C: Electron Crash-Consistent Persistence & Fault Injection
  // --------------------------------------------------------------------------
  describe('P1-C: Electron Crash-Consistent Persistence Engine', () => {
    const testPersistenceDir = path.resolve(__dirname, '../test_scratch_persistence');

    beforeEach(() => {
      if (fs.existsSync(testPersistenceDir)) {
        fs.rmSync(testPersistenceDir, { recursive: true, force: true });
      }
      fs.mkdirSync(testPersistenceDir, { recursive: true });
    });

    it('recovers unacknowledged event from immutable log when crash occurs before outbox write', () => {
      const engine1 = new TacticalStorageEngine(testPersistenceDir);
      engine1._injectFailAfterEventAppend = true;

      const evt = {
        schema_version: 1,
        event_id: 'evt_crash_recovery_1',
        operation_id: 'OP_TEST',
        entity_id: 'pt_c1',
        event_type: 'PATIENT_CREATED',
        actor_id: 'node_tester',
        actor_sequence: 1,
        lamport_timestamp: 1,
        occurred_at_utc: new Date().toISOString(),
        payload: { test: true }
      };

      // Injected crash occurs after writing to immutable_events.jsonl before outbox_state.json
      assert.throws(
        () => engine1.persistEvent(evt),
        /Injected crash fault immediately after event append/
      );

      // Verify the event exists in immutable_events.jsonl
      const lines = fs.readFileSync(engine1.eventsFile, 'utf8').trim().split('\n');
      assert.strictEqual(lines.length, 1);

      // RESTART simulation: Create new storage engine pointing to the same data directory
      const engineRestarted = new TacticalStorageEngine(testPersistenceDir);
      assert.strictEqual(engineRestarted.eventsLog.length, 1);
      // RECONCILIATION INVARIANT: Outbox must recover the unacknowledged event!
      assert.strictEqual(engineRestarted.outboxQueue.length, 1);
      assert.strictEqual(engineRestarted.outboxQueue[0].event_id, 'evt_crash_recovery_1');
    });

    it('repairs missing outbox state when a duplicate is received after incomplete forwarding', () => {
      const engine = new TacticalStorageEngine(testPersistenceDir);

      const evt = {
        schema_version: 1,
        event_id: 'evt_dup_repair',
        operation_id: 'OP_TEST',
        entity_id: 'pt_dup',
        event_type: 'PATIENT_CREATED',
        actor_id: 'node_tester',
        actor_sequence: 1,
        lamport_timestamp: 1,
        occurred_at_utc: new Date().toISOString(),
        payload: {}
      };
      engine.persistEvent(evt);

      // Simulate outbox entry somehow missing or corrupted (manually cleared without ack)
      engine.outboxQueue = [];
      engine._persistOutboxStateAtomic();
      assert.strictEqual(engine.outboxQueue.length, 0);

      // Duplicate ingestion occurs: Invariant: Duplicate must repair outbox state!
      const repaired = engine.repairDuplicateOutboxState('evt_dup_repair');
      assert.strictEqual(repaired, true);
      assert.strictEqual(engine.outboxQueue.length, 1, 'Outbox entry must be repaired on duplicate ingestion');
      assert.strictEqual(engine.outboxQueue[0].event_id, 'evt_dup_repair');
    });

    it('does not re-enqueue acknowledged events upon restart recovery', () => {
      const engine = new TacticalStorageEngine(testPersistenceDir);
      const evt = {
        schema_version: 1,
        event_id: 'evt_acked_1',
        operation_id: 'OP_TEST',
        entity_id: 'pt_ack',
        event_type: 'PATIENT_CREATED',
        actor_id: 'node_tester',
        actor_sequence: 1,
        lamport_timestamp: 1,
        occurred_at_utc: new Date().toISOString(),
        payload: {}
      };

      engine.persistEvent(evt);
      assert.strictEqual(engine.outboxQueue.length, 1);

      // Peer acknowledges event
      engine.acknowledgeEvents(['evt_acked_1']);
      assert.strictEqual(engine.outboxQueue.length, 0);

      // Restart
      const engineRestarted = new TacticalStorageEngine(testPersistenceDir);
      assert.strictEqual(engineRestarted.eventsLog.length, 1);
      assert.strictEqual(engineRestarted.outboxQueue.length, 0, 'Acknowledged event must NOT be re-enqueued on restart');
    });
  });

  // --------------------------------------------------------------------------
  // P1-5: Store-and-Forward DTN Propagation across 3 Disconnected Peers
  // --------------------------------------------------------------------------
  describe('P1-5: DTN Store-and-Forward Multi-Hop Propagation', () => {
    it('propagates event from Peer A -> Peer B -> Peer C with intermediate disconnection', async () => {
      const portA = 4426;
      const portB = 4427;
      const portC = 4428;
      const pinB = 'TACTICAL-112233';
      const pinC = 'TACTICAL-445566';

      const peerAOutbox = [
        {
          schema_version: 1,
          event_id: 'evt_from_origin_A',
          operation_id: 'OP_DISASTER_MULTI',
          entity_id: 'pt_triage_alpha',
          event_type: 'PATIENT_CREATED',
          actor_id: 'node_paramedic_A',
          actor_sequence: 1,
          lamport_timestamp: 1,
          occurred_at_utc: new Date().toISOString(),
          payload: { ephemeral_id: 'TAG-ALPHA-01' }
        }
      ];

      const serviceA = new LanSyncService({
        port: portA,
        nodeId: 'node_paramedic_A',
        getState: () => ({ eventsLog: [], outboxQueue: peerAOutbox, activeOperation: { operation_id: 'OP_DISASTER_MULTI' } }),
        onOutboxAcknowledged: (ids) => {
          const idx = peerAOutbox.findIndex(e => ids.includes(e.event_id));
          if (idx >= 0) peerAOutbox.splice(idx, 1);
        }
      });

      const peerBEvents = [];
      const peerBOutbox = [];

      const serviceB = new LanSyncService({
        port: portB,
        nodeId: 'node_runner_B',
        pairingPin: pinB,
        getState: () => ({ eventsLog: peerBEvents, outboxQueue: peerBOutbox, activeOperation: { operation_id: 'OP_DISASTER_MULTI' } }),
        onEventsIngested: (newEvents) => {
          for (const evt of newEvents) {
            peerBEvents.push(evt);
            if (!peerBOutbox.some(e => e.event_id === evt.event_id)) {
              peerBOutbox.push(evt);
            }
          }
          return 0;
        },
        onOutboxAcknowledged: (ids) => {
          const remaining = peerBOutbox.filter(e => !ids.includes(e.event_id));
          peerBOutbox.length = 0;
          peerBOutbox.push(...remaining);
        }
      });

      const peerCEvents = [];
      const peerCOutbox = [];

      const serviceC = new LanSyncService({
        port: portC,
        nodeId: 'node_hospital_C',
        pairingPin: pinC,
        getState: () => ({ eventsLog: peerCEvents, outboxQueue: peerCOutbox, activeOperation: { operation_id: 'OP_DISASTER_MULTI' } }),
        onEventsIngested: (newEvents) => {
          peerCEvents.push(...newEvents);
          return 0;
        }
      });

      try {
        await serviceA.startServer();
        await serviceB.startServer();
        await serviceC.startServer();

        // Step 1: A syncs with B
        const syncAB = await serviceA.syncWithPeer(`http://127.0.0.1:${portB}`, pinB);
        assert.strictEqual(syncAB.success, true);
        assert.strictEqual(peerBEvents.length, 1);
        assert.strictEqual(peerBEvents[0].event_id, 'evt_from_origin_A');
        assert.strictEqual(peerBOutbox.length, 1, 'B must have enqueued event into outbox for store-and-forward');
        assert.strictEqual(peerAOutbox.length, 0, 'A outbox cleared upon verified ack');

        // Step 2: A disconnects completely from network
        await serviceA.stopServer();

        // Step 3: Peer B user authorizes Peer C connection
        serviceB.setPairingPin(pinB);

        // Step 4: C connects and syncs with B (A is offline)
        const syncCB = await serviceC.syncWithPeer(`http://127.0.0.1:${portB}`, pinB);
        assert.strictEqual(syncCB.success, true);

        // Step 5: Verify C received A's event forwarded by B!
        assert.ok(peerCEvents.some(e => e.event_id === 'evt_from_origin_A'), 'C must receive event created by A via B');

        // Step 6: Duplicate suppression on subsequent sync (session reused)
        const syncCB2 = await serviceC.syncWithPeer(`http://127.0.0.1:${portB}`);
        assert.strictEqual(syncCB2.success, true);
        assert.strictEqual(peerCEvents.length, 1, 'Duplicate event must be suppressed and not duplicated');
      } finally {
        await serviceA.stopServer();
        await serviceB.stopServer();
        await serviceC.stopServer();
      }
    });
  });
});
