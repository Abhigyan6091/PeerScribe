import * as crypto from 'crypto';

export interface KeyPair {
  publicKey: string; // Hex string (32 bytes / 64 hex chars)
  privateKey: string; // Hex string
}

/**
 * Generate a new Ed25519 cryptographic identity keypair.
 */
export function generateIdentityKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });

  return {
    publicKey: publicKey.toString('hex'),
    privateKey: privateKey.toString('hex')
  };
}

/**
 * Compute SHA-256 hash of a string or Buffer.
 */
export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Compute truncated 8-byte hash (16 hex chars) for compact packet headers.
 */
export function hash16(data: string | Buffer): string {
  return sha256(data).substring(0, 16);
}

/**
 * Compute CRC-32 checksum for BitChat binary packet verification.
 */
export function crc32(buffer: Buffer): number {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

// Precomputed CRC-32 Lookup Table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

/**
 * Sign payload using Ed25519 private key.
 */
export function sign(privateKeyHex: string, data: Buffer | string): string {
  const privKeyBuffer = Buffer.from(privateKeyHex, 'hex');
  const key = crypto.createPrivateKey({
    key: privKeyBuffer,
    format: 'der',
    type: 'pkcs8'
  });

  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const signature = crypto.sign(null, buffer, key);
  return signature.toString('hex');
}

/**
 * Verify payload signature using Ed25519 public key.
 */
export function verify(publicKeyHex: string, data: Buffer | string, signatureHex: string): boolean {
  try {
    const pubKeyBuffer = Buffer.from(publicKeyHex, 'hex');
    const key = crypto.createPublicKey({
      key: pubKeyBuffer,
      format: 'der',
      type: 'spki'
    });

    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const signature = Buffer.from(signatureHex, 'hex');
    return crypto.verify(null, buffer, key, signature);
  } catch (err) {
    return false;
  }
}

/**
 * Securely scrub memory buffer with random bytes then zeros (anti-capture zeroization).
 */
export function zeroizeBuffer(buffer: Buffer): void {
  if (!buffer || buffer.length === 0) return;
  crypto.randomFillSync(buffer);
  buffer.fill(0);
}
