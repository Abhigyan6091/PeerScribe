export type PacketCallback = (fromNodeId: string, packet: Buffer) => void;

export interface BleNeighbor {
  nodeId: string;
  rssi: number; // dBm (e.g. -45 to -95)
  reachable: boolean;
}

/**
 * In-memory BLE Mesh Router simulator.
 * Simulates radio proximity, packet attenuation, and multi-hop forwarding.
 */
export class MockBleMeshHub {
  private nodes = new Map<string, PacketCallback>();
  private topology = new Map<string, Map<string, number>>(); // fromNode -> toNode -> rssi
  private packetCounter = 0;

  /**
   * Register a node onto the simulated mesh radio spectrum.
   */
  registerNode(nodeId: string, onPacketReceived: PacketCallback): void {
    this.nodes.set(nodeId, onPacketReceived);
    if (!this.topology.has(nodeId)) {
      this.topology.set(nodeId, new Map());
    }
  }

  /**
   * Set bidirectional radio reachability between two nodes with signal strength.
   */
  setLink(nodeA: string, nodeB: string, reachable: boolean, rssi = -65): void {
    if (!this.topology.has(nodeA)) this.topology.set(nodeA, new Map());
    if (!this.topology.has(nodeB)) this.topology.set(nodeB, new Map());

    if (reachable) {
      this.topology.get(nodeA)!.set(nodeB, rssi);
      this.topology.get(nodeB)!.set(nodeA, rssi);
    } else {
      this.topology.get(nodeA)!.delete(nodeB);
      this.topology.get(nodeB)!.delete(nodeA);
    }
  }

  /**
   * Broadcast a BLE advertising packet to all immediate neighbors within radio range.
   */
  broadcastAdvertising(fromNodeId: string, packet: Buffer): number {
    const neighbors = this.topology.get(fromNodeId);
    if (!neighbors) return 0;

    let deliveredCount = 0;
    for (const [neighborId] of neighbors.entries()) {
      const listener = this.nodes.get(neighborId);
      if (listener) {
        this.packetCounter++;
        // Clone buffer to simulate true radio transmission isolation
        listener(fromNodeId, Buffer.from(packet));
        deliveredCount++;
      }
    }

    return deliveredCount;
  }

  /**
   * Get list of currently reachable BLE neighbors for a node.
   */
  getNeighbors(nodeId: string): BleNeighbor[] {
    const neighbors = this.topology.get(nodeId);
    if (!neighbors) return [];

    return Array.from(neighbors.entries()).map(([target, rssi]) => ({
      nodeId: target,
      rssi,
      reachable: true
    }));
  }

  getTotalPacketsTransmitted(): number {
    return this.packetCounter;
  }
}
