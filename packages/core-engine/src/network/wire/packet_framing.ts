import { crc32 } from '../../identity/crypto.ts';

export const MAGIC_BYTES = 0x5053; // 'PS' (PeerScribe)
export const PROTOCOL_VERSION = 0x01;

export const PacketType = {
  CRDT_SYNC_BUNDLE: 0x01,
  BEACON_HEARTBEAT: 0x02,
  SOS_PRIORITY: 0x03,
  EMERGENCY_WIPE_CMD: 0x04
} as const;
export type PacketType = typeof PacketType[keyof typeof PacketType];

export const PacketFlags = {
  NONE: 0x00,
  LZ4_COMPRESSED: 0x01,
  FRAGMENTED: 0x02,
  ENCRYPTED: 0x04
} as const;
export type PacketFlags = typeof PacketFlags[keyof typeof PacketFlags];

export interface PacketHeader {
  type: PacketType;
  flags: number;
  hopCount: number;
  maxTtl: number;
  sequenceNumber: number;
  geohash: string; // 8 ASCII chars
  senderPubkeyHash: string; // 8 bytes / 16 hex chars
  payloadLength: number;
  checksum: number; // CRC-32
}

export interface WirePacket {
  header: PacketHeader;
  payload: Buffer;
}

import * as zlib from 'zlib';

/**
 * High-performance lightweight packet compression algorithm.
 */
export function lz4Compress(input: Buffer): Buffer {
  if (input.length < 32) return Buffer.from(input); // Compression not worthwhile
  try {
    const compressed = zlib.deflateRawSync(input, { level: 6 });
    return compressed.length < input.length ? compressed : Buffer.from(input);
  } catch (err) {
    return Buffer.from(input);
  }
}

/**
 * Packet decompression algorithm.
 */
export function lz4Decompress(input: Buffer, uncompressedSize?: number): Buffer {
  try {
    return zlib.inflateRawSync(input);
  } catch (err) {
    // If not compressed, return as-is
    return Buffer.from(input);
  }
}

/**
 * Encode packet into BitChat binary wire format.
 * Header size: exactly 32 bytes.
 */
export function encodePacket(
  type: PacketType,
  payload: Buffer,
  options: {
    hopCount?: number;
    maxTtl?: number;
    sequenceNumber?: number;
    geohash?: string;
    senderPubkeyHash?: string;
    forceCompression?: boolean;
  } = {}
): Buffer {
  const shouldCompress = options.forceCompression || payload.length > 100;
  let finalPayload = payload;
  let flags = PacketFlags.NONE;

  if (shouldCompress) {
    const compressed = lz4Compress(payload);
    if (compressed.length < payload.length) {
      finalPayload = compressed;
      flags |= PacketFlags.LZ4_COMPRESSED;
    }
  }

  const headerBuf = Buffer.alloc(32);
  headerBuf.writeUInt16BE(MAGIC_BYTES, 0);
  headerBuf.writeUInt8(PROTOCOL_VERSION, 2);
  headerBuf.writeUInt8(type, 3);
  headerBuf.writeUInt8(flags, 4);
  headerBuf.writeUInt8(options.hopCount || 0, 5);
  headerBuf.writeUInt8(options.maxTtl || 15, 6);
  headerBuf.writeUInt16BE(options.sequenceNumber || 1, 7);

  // Geohash (8 bytes)
  const geoStr = (options.geohash || '00000000').padEnd(8, ' ').substring(0, 8);
  headerBuf.write(geoStr, 9, 8, 'ascii');

  // Sender pubkey hash (8 bytes)
  const pkHex = (options.senderPubkeyHash || '0000000000000000').padEnd(16, '0').substring(0, 16);
  Buffer.from(pkHex, 'hex').copy(headerBuf, 17, 0, 8);

  // Payload length (2 bytes)
  headerBuf.writeUInt16BE(finalPayload.length, 25);

  // Checksum (4 bytes) over header (0-26) + payload
  const checksumData = Buffer.concat([headerBuf.subarray(0, 27), finalPayload]);
  const cSum = crc32(checksumData);
  headerBuf.writeUInt32BE(cSum, 27);

  return Buffer.concat([headerBuf, finalPayload]);
}

/**
 * Decode and verify incoming wire packet.
 */
export function decodePacket(buffer: Buffer): WirePacket {
  if (buffer.length < 32) {
    throw new Error(`Packet too small: ${buffer.length} bytes (minimum 32 bytes required)`);
  }

  const magic = buffer.readUInt16BE(0);
  if (magic !== MAGIC_BYTES) {
    throw new Error(`Invalid magic header: 0x${magic.toString(16)} (expected 0x${MAGIC_BYTES.toString(16)})`);
  }

  const version = buffer.readUInt8(2);
  const type = buffer.readUInt8(3) as PacketType;
  const flags = buffer.readUInt8(4);
  const hopCount = buffer.readUInt8(5);
  const maxTtl = buffer.readUInt8(6);
  const sequenceNumber = buffer.readUInt16BE(7);
  const geohash = buffer.toString('ascii', 9, 17).trim();
  const senderPubkeyHash = buffer.subarray(17, 25).toString('hex');
  const payloadLength = buffer.readUInt16BE(25);
  const checksum = buffer.readUInt32BE(27);

  const payload = buffer.subarray(32, 32 + payloadLength);
  if (payload.length !== payloadLength) {
    throw new Error(`Payload length mismatch: expected ${payloadLength}, got ${payload.length}`);
  }

  // Verify CRC-32 checksum
  const checksumData = Buffer.concat([buffer.subarray(0, 27), payload]);
  const expectedChecksum = crc32(checksumData);
  if (checksum !== expectedChecksum) {
    throw new Error(`Corrupted packet: CRC32 checksum mismatch (expected 0x${expectedChecksum.toString(16)}, got 0x${checksum.toString(16)})`);
  }

  return {
    header: {
      type,
      flags,
      hopCount,
      maxTtl,
      sequenceNumber,
      geohash,
      senderPubkeyHash,
      payloadLength,
      checksum
    },
    payload
  };
}
