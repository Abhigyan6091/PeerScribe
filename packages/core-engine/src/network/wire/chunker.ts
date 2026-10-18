export interface PacketChunk {
  streamId: string;
  chunkIndex: number;
  totalChunks: number;
  data: Buffer;
}

/**
 * Fragment a large payload into indexed chunks fitting BLE MTU constraints.
 */
export function fragmentPayload(streamId: string, payload: Buffer, maxChunkSize = 200): PacketChunk[] {
  const chunks: PacketChunk[] = [];
  const totalChunks = Math.ceil(payload.length / maxChunkSize);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * maxChunkSize;
    const end = Math.min(start + maxChunkSize, payload.length);
    chunks.push({
      streamId,
      chunkIndex: i,
      totalChunks,
      data: payload.subarray(start, end)
    });
  }

  return chunks;
}

/**
 * Reassembler for incoming fragmented packet streams.
 */
export class StreamReassembler {
  private streams = new Map<string, { totalChunks: number; chunks: Map<number, Buffer>; createdAt: number }>();
  private readonly ttlMs = 60000; // 60s timeout for stale streams

  /**
   * Ingest a chunk. If all chunks for the stream are received, returns the complete reassembled Buffer.
   */
  ingestChunk(chunk: PacketChunk): Buffer | null {
    this.pruneStaleStreams();

    let stream = this.streams.get(chunk.streamId);
    if (!stream) {
      stream = {
        totalChunks: chunk.totalChunks,
        chunks: new Map(),
        createdAt: Date.now()
      };
      this.streams.set(chunk.streamId, stream);
    }

    stream.chunks.set(chunk.chunkIndex, chunk.data);

    if (stream.chunks.size === stream.totalChunks) {
      // All chunks arrived, reassemble in order
      const orderedBuffers: Buffer[] = [];
      for (let i = 0; i < stream.totalChunks; i++) {
        const piece = stream.chunks.get(i);
        if (!piece) return null; // Missing slice
        orderedBuffers.push(piece);
      }

      this.streams.delete(chunk.streamId);
      return Buffer.concat(orderedBuffers);
    }

    return null;
  }

  private pruneStaleStreams(): void {
    const now = Date.now();
    for (const [id, stream] of this.streams.entries()) {
      if (now - stream.createdAt > this.ttlMs) {
        this.streams.delete(id);
      }
    }
  }
}
