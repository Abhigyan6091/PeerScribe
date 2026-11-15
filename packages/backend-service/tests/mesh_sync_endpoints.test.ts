import test from 'node:test';
import * as assert from 'node:assert';
import { PeerScribeDaemon } from '../src/node_daemon.ts';
import { createPeerScribeServer } from '../src/server.ts';

test('Mesh REST Endpoints: discovery, pairing, and delta synchronization', async (t) => {
  // Setup Node A (Host / Coordinator)
  const daemonA = new PeerScribeDaemon({
    dbPath: ':memory:',
    nodeId: 'node_test_laptop',
    initialRole: 'COORDINATOR'
  });
  const serverA = createPeerScribeServer(daemonA);
  await new Promise<void>(resolve => serverA.listen(0, '127.0.0.1', () => resolve()));
  const portA = (serverA.address() as any).port;
  const baseUrlA = `http://127.0.0.1:${portA}`;

  // Setup Node B (Remote Mobile Node Simulator)
  const daemonB = new PeerScribeDaemon({
    dbPath: ':memory:',
    nodeId: 'node_test_phone',
    initialRole: 'MEDICAL_RESPONDER'
  });
  const serverB = createPeerScribeServer(daemonB);
  await new Promise<void>(resolve => serverB.listen(0, '127.0.0.1', () => resolve()));
  const portB = (serverB.address() as any).port;
  const baseUrlB = `http://127.0.0.1:${portB}`;

  t.after(async () => {
    serverA.close();
    serverB.close();
    await daemonA.close();
    await daemonB.close();
  });

  await t.test('1. GET /api/v1/mesh/info returns local pairing PIN, listening port and node metadata', async () => {
    const res = await fetch(`${baseUrlA}/api/v1/mesh/info`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.nodeId, 'node_test_laptop');
    assert.ok(typeof data.port === 'number');
    assert.ok(data.pairingPin.startsWith('TACTICAL-'));
    assert.ok(Array.isArray(data.ipAddresses));
    assert.ok(Array.isArray(data.peers));
  });

  await t.test('2. POST /api/v1/mesh/pin customizes the local pairing PIN', async () => {
    const res = await fetch(`${baseUrlA}/api/v1/mesh/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingPin: 'TACTICAL-998877' })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.pairingPin, 'TACTICAL-998877');
    assert.strictEqual(daemonA.lanSync.getPairingPin(), 'TACTICAL-998877');
  });

  await t.test('3. POST /api/v1/mesh/probe returns 400 for empty address and queries peer info', async () => {
    const badRes = await fetch(`${baseUrlA}/api/v1/mesh/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerAddress: '' })
    });
    assert.strictEqual(badRes.status, 400);

    // Probe Node B's LanSync endpoint
    const probeRes = await fetch(`${baseUrlA}/api/v1/mesh/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerAddress: `http://127.0.0.1:${daemonB.lanSync.port}` })
    });
    assert.strictEqual(probeRes.status, 200);
    const probeData = await probeRes.json();
    assert.strictEqual(probeData.nodeId, 'node_test_phone');
    assert.strictEqual(probeData.status, 'PAIRING_REQUIRED');
    assert.strictEqual(probeData.requiresPairing, true);
  });

  await t.test('4. POST /api/v1/mesh/pair rejects invalid PIN with 401', async () => {
    const pairRes = await fetch(`${baseUrlA}/api/v1/mesh/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peerAddress: `http://127.0.0.1:${daemonB.lanSync.port}`,
        pairingPin: 'TACTICAL-000000'
      })
    });
    assert.strictEqual(pairRes.status, 401);
  });

  await t.test('5. POST /api/v1/mesh/pair establishes authenticated session with valid PIN', async () => {
    const pinB = daemonB.lanSync.getPairingPin();
    const pairRes = await fetch(`${baseUrlA}/api/v1/mesh/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peerAddress: `http://127.0.0.1:${daemonB.lanSync.port}`,
        pairingPin: pinB
      })
    });
    assert.strictEqual(pairRes.status, 200);
    const pairData = await pairRes.json();
    assert.strictEqual(pairData.success, true);
    assert.strictEqual(pairData.status, 'PAIRED');
    assert.strictEqual(pairData.serverNodeId, 'node_test_phone');
    assert.ok(pairData.sessionId);

    // Verify GET /api/v1/mesh/peers now includes Node B
    const peersRes = await fetch(`${baseUrlA}/api/v1/mesh/peers`);
    assert.strictEqual(peersRes.status, 200);
    const peers = await peersRes.json();
    assert.ok(peers.length >= 1);
    assert.strictEqual(peers[0].nodeId, 'node_test_phone');
    assert.strictEqual(peers[0].status, 'CONNECTED');
  });

  await t.test('6. POST /api/v1/mesh/sync bidirectionally exchanges outbox casualties between nodes', async () => {
    // Create a casualty on Node A
    const ptA = daemonA.createPatient('RED-WOLF-01');
    daemonA.recordTriage(ptA.patientId, 'RED', 'START_v1.0.0', 'Severe shock');

    // Create a casualty on Node B
    const ptB = daemonB.createPatient('YELLOW-FOX-02');
    daemonB.recordTriage(ptB.patientId, 'YELLOW', 'START_v1.0.0', 'Stable fracture');

    // Trigger sync from Node A to Node B
    const syncRes = await fetch(`${baseUrlA}/api/v1/mesh/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        peerAddress: `http://127.0.0.1:${daemonB.lanSync.port}`
      })
    });
    assert.strictEqual(syncRes.status, 200);
    const syncData = await syncRes.json();
    assert.strictEqual(syncData.success, true);
    assert.ok(syncData.eventsSent >= 1);

    // Verify that Node A now contains the casualty created on Node B!
    const nodeAPatients = daemonA.listPatients();
    const hasPtB = nodeAPatients.some(p => p.doc.patientId === ptB.patientId || p.doc.ephemeralId === 'YELLOW-FOX-02');
    assert.ok(hasPtB, 'Node A must have ingested casualty created on Node B');

    // Verify that Node B now contains the casualty created on Node A!
    const nodeBPatients = daemonB.listPatients();
    const hasPtA = nodeBPatients.some(p => p.doc.patientId === ptA.patientId || p.doc.ephemeralId === 'RED-WOLF-01');
    assert.ok(hasPtA, 'Node B must have ingested casualty created on Node A');
  });
});
