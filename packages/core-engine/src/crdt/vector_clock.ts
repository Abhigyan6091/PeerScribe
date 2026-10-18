export type VectorClock = Record<string, number>;

/**
 * Increment logical clock for a specific node replica.
 */
export function incrementClock(clock: VectorClock, nodeId: string): VectorClock {
  const current = clock[nodeId] || 0;
  return {
    ...clock,
    [nodeId]: current + 1
  };
}

/**
 * Merges two vector clocks taking the pairwise maximum of counters.
 */
export function mergeClocks(v1: VectorClock, v2: VectorClock): VectorClock {
  const merged: VectorClock = { ...v1 };
  for (const [node, counter] of Object.entries(v2)) {
    merged[node] = Math.max(merged[node] || 0, counter);
  }
  return merged;
}

/**
 * Compare two vector clocks to determine causality.
 */
export function compareClocks(v1: VectorClock, v2: VectorClock): 'EQUAL' | 'ANCESTOR' | 'DESCENDANT' | 'CONCURRENT' {
  let v1Greater = false;
  let v2Greater = false;

  const allNodes = new Set([...Object.keys(v1), ...Object.keys(v2)]);

  for (const node of allNodes) {
    const c1 = v1[node] || 0;
    const c2 = v2[node] || 0;

    if (c1 > c2) v1Greater = true;
    if (c2 > c1) v2Greater = true;
  }

  if (!v1Greater && !v2Greater) return 'EQUAL';
  if (v1Greater && !v2Greater) return 'DESCENDANT'; // v1 is strictly ahead of v2
  if (!v1Greater && v2Greater) return 'ANCESTOR';   // v1 is strictly behind v2
  return 'CONCURRENT';                              // Concurrent / divergent branch
}

/**
 * Check if remote clock has updates not present in local clock.
 */
export function hasMissingUpdates(localClock: VectorClock, remoteClock: VectorClock): boolean {
  for (const [node, remoteCounter] of Object.entries(remoteClock)) {
    const localCounter = localClock[node] || 0;
    if (remoteCounter > localCounter) {
      return true;
    }
  }
  return false;
}
