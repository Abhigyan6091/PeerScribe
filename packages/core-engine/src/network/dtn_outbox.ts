import { BloomFilter } from './bloom_filter.ts';

export const BundlePriority = {
  ROUTINE: 1,
  CLINICAL_DELTA: 2,
  CRITICAL_SOS: 3
} as const;
export type BundlePriority = typeof BundlePriority[keyof typeof BundlePriority];

export interface QueuedBundle {
  bundleId: string;
  operationId: string;
  priority: BundlePriority;
  hopCount: number;
  maxHops: number;
  createdAt: number;
  ttlMs: number;
  payload: Buffer;
}

/**
 * Delay-Tolerant Networking (DTN) Outbox Queue.
 * Holds messages for store-and-forward relaying across network partitions.
 */
export class DtnOutboxQueue {
  private queue = new Map<string, QueuedBundle>();
  private localBloom = new BloomFilter();

  /**
   * Enqueue a sync bundle for opportunistic relay.
   */
  enqueue(bundle: QueuedBundle): boolean {
    if (bundle.hopCount >= bundle.maxHops) {
      return false; // Dropped: exceeded hop limit
    }

    this.queue.set(bundle.bundleId, bundle);
    this.localBloom.add(bundle.bundleId);
    return true;
  }

  /**
   * Get our local Bloom filter to send to neighbors during handshake.
   */
  getLocalBloomFilter(): BloomFilter {
    return this.localBloom;
  }

  /**
   * Given a neighbor's Bloom filter, return all bundles they are missing,
   * sorted by priority (CRITICAL_SOS first).
   */
  getBundlesNeededByNeighbor(neighborBloom: BloomFilter): QueuedBundle[] {
    this.pruneExpired();

    const missing: QueuedBundle[] = [];
    for (const bundle of this.queue.values()) {
      if (!neighborBloom.contains(bundle.bundleId)) {
        missing.push(bundle);
      }
    }

    // Sort: highest priority first, then oldest first
    return missing.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.createdAt - b.createdAt;
    });
  }

  /**
   * Mark bundle as received / known.
   */
  markReceived(bundleId: string): void {
    this.localBloom.add(bundleId);
  }

  /**
   * Prune expired bundles past their TTL.
   */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, bundle] of this.queue.entries()) {
      if (now - bundle.createdAt > bundle.ttlMs) {
        this.queue.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  size(): number {
    return this.queue.size;
  }
}
