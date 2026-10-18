import test from 'node:test';
import assert from 'node:assert/strict';

import { MockBleMeshHub } from '../src/ble_mock.ts';
import { calculateDistanceMeters, encodeGeohash } from '../src/gnss_mock.ts';
import {
  encodePacket,
  decodePacket,
  PacketType
} from '../../core-engine/src/index.ts';

test('BLE Mesh Hub: 2-Hop Bucket Brigade Store-and-Forward simulation', () => {
  const mesh = new MockBleMeshHub();

  const nodeA = 'medic_alpha';
  const nodeB = 'relay_bravo';
  const nodeC = 'hospital_charlie';

  const packetsReceivedAtB: Buffer[] = [];
  const packetsReceivedAtC: Buffer[] = [];

  mesh.registerNode(nodeA, () => {});
  mesh.registerNode(nodeB, (fromNode, packet) => {
    packetsReceivedAtB.push(packet);
    // Node B acts as BitChat store-and-forward relay: forwards to its neighbors
    const decoded = decodePacket(packet);
    if (decoded.header.hopCount < decoded.header.maxTtl) {
      const forwardedPacket = encodePacket(decoded.header.type, decoded.payload, {
        hopCount: decoded.header.hopCount + 1,
        maxTtl: decoded.header.maxTtl,
        sequenceNumber: decoded.header.sequenceNumber,
        geohash: decoded.header.geohash,
        senderPubkeyHash: decoded.header.senderPubkeyHash
      });
      mesh.broadcastAdvertising(nodeB, forwardedPacket);
    }
  });

  mesh.registerNode(nodeC, (fromNode, packet) => {
    packetsReceivedAtC.push(packet);
  });

  // Setup linear topology: A <-> B <-> C (A cannot reach C directly)
  mesh.setLink(nodeA, nodeB, true, -68);
  mesh.setLink(nodeB, nodeC, true, -72);
  mesh.setLink(nodeA, nodeC, false); // Direct link broken / out of range

  // Verify neighbor discovery
  const neighborsOfA = mesh.getNeighbors(nodeA);
  assert.equal(neighborsOfA.length, 1);
  assert.equal(neighborsOfA[0].nodeId, nodeB);

  // Medic Alpha creates critical triage sync bundle packet
  const payload = Buffer.from('CRDT_TRIAGE_STATE_UPDATE:RED-PANTHER-04:STATUS=RED');
  const geohash = encodeGeohash(27.7172, 85.3240, 8); // Kathmandu disaster sector
  const wirePacket = encodePacket(PacketType.CRDT_SYNC_BUNDLE, payload, {
    hopCount: 1,
    maxTtl: 10,
    sequenceNumber: 101,
    geohash,
    senderPubkeyHash: 'aabbccdd11223344'
  });

  // Medic Alpha broadcasts packet
  const sentCount = mesh.broadcastAdvertising(nodeA, wirePacket);
  assert.equal(sentCount, 1); // Delivered to Node B

  // Node B should have received 1 packet and forwarded it
  assert.equal(packetsReceivedAtB.length, 1);

  // Hospital Charlie should have received the forwarded packet via Node B!
  assert.equal(packetsReceivedAtC.length, 1);
  const finalDecoded = decodePacket(packetsReceivedAtC[0]);
  assert.equal(finalDecoded.header.hopCount, 2); // Hop incremented!
  assert.deepEqual(finalDecoded.payload, payload);
  assert.equal(finalDecoded.header.geohash, geohash);
});

test('GNSS & Geohash: Distance calculation and spatial geohash encoding', () => {
  // Coordinates for two field camps ~1.1km apart
  const campA = { lat: 27.7172, lon: 85.3240 };
  const campB = { lat: 27.7272, lon: 85.3240 };

  const distMeters = calculateDistanceMeters(campA.lat, campA.lon, campB.lat, campB.lon);
  assert.ok(distMeters > 1100 && distMeters < 1120);

  const hashA = encodeGeohash(campA.lat, campA.lon, 8);
  assert.equal(hashA.length, 8);
  assert.ok(hashA.startsWith('t')); // Asia/Himalayan geohash prefix

  const hashB = encodeGeohash(campB.lat, campB.lon, 8);
  assert.equal(hashB.length, 8);
  // Shared regional prefix for adjacent cells
  assert.equal(hashA.substring(0, 4), hashB.substring(0, 4));
});
