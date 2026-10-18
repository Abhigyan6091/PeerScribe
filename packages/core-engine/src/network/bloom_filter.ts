import { sha256 } from '../identity/crypto.ts';

/**
 * 128-byte (1024-bit) Anti-Entropy Bloom Filter.
 * Used during BLE handshakes to suppress redundant broadcast packets (BitChat pattern).
 */
export class BloomFilter {
  public readonly sizeBits = 1024;
  public readonly sizeBytes = 128;
  private readonly bitArray: Uint8Array;
  private readonly numHashes = 3;

  constructor(existingBuffer?: Uint8Array) {
    if (existingBuffer && existingBuffer.length === this.sizeBytes) {
      this.bitArray = new Uint8Array(existingBuffer);
    } else {
      this.bitArray = new Uint8Array(this.sizeBytes);
    }
  }

  private getHashes(item: string): number[] {
    const hash = sha256(item);
    const h1 = parseInt(hash.substring(0, 8), 16) % this.sizeBits;
    const h2 = parseInt(hash.substring(8, 16), 16) % this.sizeBits;
    const h3 = parseInt(hash.substring(16, 24), 16) % this.sizeBits;
    return [h1, h2, h3];
  }

  add(item: string): void {
    const hashes = this.getHashes(item);
    for (const bitIdx of hashes) {
      const byteIdx = Math.floor(bitIdx / 8);
      const bitOffset = bitIdx % 8;
      this.bitArray[byteIdx] |= (1 << bitOffset);
    }
  }

  contains(item: string): boolean {
    const hashes = this.getHashes(item);
    for (const bitIdx of hashes) {
      const byteIdx = Math.floor(bitIdx / 8);
      const bitOffset = bitIdx % 8;
      if ((this.bitArray[byteIdx] & (1 << bitOffset)) === 0) {
        return false;
      }
    }
    return true;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bitArray);
  }

  static fromBuffer(buffer: Buffer): BloomFilter {
    return new BloomFilter(buffer);
  }
}
