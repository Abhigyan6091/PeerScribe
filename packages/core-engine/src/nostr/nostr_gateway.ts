import * as crypto from 'crypto';
import { sha256 } from '../identity/crypto.ts';

// Secp256k1 Curve Constants for BIP-340 Schnorr Signatures
const p = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function modExp(base: bigint, exp: bigint, m: bigint): bigint {
  let res = 1n;
  let b = base % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) res = (res * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return res;
}

function modInv(a: bigint, m: bigint): bigint {
  return modExp(a, m - 2n, m);
}

type Point = [bigint, bigint] | null;

function pointAdd(P: Point, Q: Point): Point {
  if (!P) return Q;
  if (!Q) return P;
  const [x1, y1] = P;
  const [x2, y2] = Q;
  if (x1 === x2 && y1 !== y2) return null;
  let m: bigint;
  if (x1 === x2 && y1 === y2) {
    m = mod(3n * x1 * x1 * modInv(2n * y1, p), p);
  } else {
    m = mod((y2 - y1) * modInv(x2 - x1, p), p);
  }
  const x3 = mod(m * m - x1 - x2, p);
  const y3 = mod(m * (x1 - x3) - y1, p);
  return [x3, y3];
}

function scalarMult(k: bigint, P: [bigint, bigint]): Point {
  let R: Point = null;
  let cur: Point = P;
  let scalar = k;
  while (scalar > 0n) {
    if (scalar & 1n) R = pointAdd(R, cur);
    cur = pointAdd(cur, cur);
    scalar >>= 1n;
  }
  return R;
}

function taggedHash(tag: string, data: Buffer): Buffer {
  const tagHash = crypto.createHash('sha256').update(tag).digest();
  return crypto.createHash('sha256').update(tagHash).update(tagHash).update(data).digest();
}

function bytesToBigInt(b: Buffer): bigint {
  return BigInt('0x' + b.toString('hex'));
}

function bigIntToHex(b: bigint, len = 32): string {
  return b.toString(16).padStart(len * 2, '0');
}

/**
 * Normalizes any private key hex into a valid secp256k1 scalar in [1, n-1].
 * Preserves 32-byte secp256k1 keys while deterministically deriving valid scalars
 * from Ed25519 identity keys or other key formats.
 */
export function normalizeSecp256k1PrivKey(privKeyHex: string): string {
  const cleanHex = privKeyHex.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(cleanHex)) {
    const val = BigInt('0x' + cleanHex);
    if (val > 0n && val < n) {
      return cleanHex;
    }
  }
  const keyBytes = /^[0-9a-f]+$/i.test(cleanHex) && cleanHex.length % 2 === 0
    ? Buffer.from(cleanHex, 'hex')
    : Buffer.from(cleanHex, 'utf-8');
  const hash = crypto.createHash('sha256').update(keyBytes).digest();
  let scalar = bytesToBigInt(hash) % n;
  if (scalar === 0n) scalar = 1n;
  return bigIntToHex(scalar);
}

/**
 * Derives the canonical 32-byte x-only public key from a 32-byte secp256k1 private key
 * in compliance with BIP-340 / Nostr (NIP-01).
 */
export function deriveNostrPublicKey(privKeyHex: string): string {
  const normalizedKey = normalizeSecp256k1PrivKey(privKeyHex);
  const d = BigInt('0x' + normalizedKey);
  const P = scalarMult(d, [Gx, Gy]);
  if (!P) throw new Error('Invalid point derived from private key');
  return bigIntToHex(P[0]);
}

/**
 * Generates a valid standards-compliant BIP-340 Schnorr signature.
 */
export function signBip340(privKeyHex: string, msgHex: string): string {
  const normalizedKey = normalizeSecp256k1PrivKey(privKeyHex);
  let d = BigInt('0x' + normalizedKey);
  const P = scalarMult(d, [Gx, Gy]);
  if (!P) throw new Error('Invalid public key calculation');

  // BIP-340: If P.y is odd, negate d so P.y becomes even
  if (P[1] % 2n !== 0n) {
    d = n - d;
  }

  const px = bigIntToHex(P[0]);
  const mBytes = Buffer.from(msgHex, 'hex');
  const aux = crypto.randomBytes(32);
  const kBytes = taggedHash('BIP0340/aux', aux);
  const kPrime = bytesToBigInt(taggedHash('BIP0340/nonce', Buffer.concat([kBytes, Buffer.from(px, 'hex'), mBytes]))) % n;
  if (kPrime === 0n) throw new Error('Generated zero nonce, retry');

  const R = scalarMult(kPrime, [Gx, Gy]);
  if (!R) throw new Error('Invalid nonce point calculation');

  let k = kPrime;
  if (R[1] % 2n !== 0n) {
    k = n - kPrime;
  }

  const rx = bigIntToHex(R[0]);
  const e = bytesToBigInt(taggedHash('BIP0340/challenge', Buffer.concat([
    Buffer.from(rx, 'hex'),
    Buffer.from(px, 'hex'),
    mBytes
  ]))) % n;

  const s = mod(k + e * d, n);
  return rx + bigIntToHex(s);
}

/**
 * Verifies a BIP-340 Schnorr signature against a 32-byte x-only public key.
 */
export function verifyBip340(pubkeyHex: string, msgHex: string, sigHex: string): boolean {
  if (sigHex.length !== 128 || pubkeyHex.length !== 64 || msgHex.length !== 64) {
    return false;
  }
  try {
    const rx = BigInt('0x' + sigHex.substring(0, 64));
    const s = BigInt('0x' + sigHex.substring(64, 128));
    if (rx >= p || s >= n) return false;

    const px = BigInt('0x' + pubkeyHex);
    if (px >= p) return false;

    // Recover P = (px, y) with even y on secp256k1
    const ySq = mod(px * px * px + 7n, p);
    let y = modExp(ySq, (p + 1n) / 4n, p);
    if (mod(y * y, p) !== ySq) return false; // Not on curve
    if (y % 2n !== 0n) y = p - y;

    const P: [bigint, bigint] = [px, y];
    const e = bytesToBigInt(taggedHash('BIP0340/challenge', Buffer.concat([
      Buffer.from(bigIntToHex(rx), 'hex'),
      Buffer.from(pubkeyHex, 'hex'),
      Buffer.from(msgHex, 'hex')
    ]))) % n;

    const sG = scalarMult(s, [Gx, Gy]);
    const negP: [bigint, bigint] = [P[0], p - P[1]];
    const eP = scalarMult(e, negP);
    const R = pointAdd(sG, eP);

    return R !== null && R[1] % 2n === 0n && R[0] === rx;
  } catch (_) {
    return false;
  }
}

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string; // Base64 encrypted AEAD envelope
  sig: string;
}

export const NOSTR_KIND_MESH_SYNC = 20042; // Ephemeral Encrypted Mesh Sync Bundle
export const NOSTR_KIND_GIFT_WRAP = 1059;  // Private Envelope NIP-59

/**
 * Package an encrypted CRDT sync bundle into a BitChat-compatible Nostr event.
 * Never transmits unencrypted clinical information to public relays.
 */
export function createNostrMeshEvent(
  operationId: string,
  geohash: string,
  payloadBuffer: Buffer,
  sharedSecret: Buffer,
  nodePrivKeyHex: string
): NostrEvent {
  const opHash = sha256(operationId);

  // 1. Encrypt clinical content with ChaCha20-Poly1305 using shared secret
  const nonce12 = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('chacha20-poly1305', sharedSecret, nonce12, { authTagLength: 16 });
  const encrypted = cipher.update(payloadBuffer);
  cipher.final();
  const tag = cipher.getAuthTag();

  const encryptedEnvelope = Buffer.concat([nonce12, tag, encrypted]).toString('base64');
  const createdAt = Math.floor(Date.now() / 1000);

  const tags = [
    ['g', geohash],
    ['e', opHash],
    ['t', 'peerscribe_mesh_sync'],
    ['experimental', 'true']
  ];

  // 2. Canonical BIP-340 / Nostr public key derivation
  const pubkey = deriveNostrPublicKey(nodePrivKeyHex);

  // 3. Canonical NIP-01 JSON Serialization: [0, pubkey, created_at, kind, tags, content]
  const canonicalJson = JSON.stringify([
    0,
    pubkey,
    createdAt,
    NOSTR_KIND_MESH_SYNC,
    tags,
    encryptedEnvelope
  ]);

  // 4. Canonical Event ID: SHA-256 of canonical JSON
  const eventId = crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');

  // 5. Canonical BIP-340 Schnorr Signature
  const signature = signBip340(nodePrivKeyHex, eventId);

  return {
    id: eventId,
    pubkey,
    created_at: createdAt,
    kind: NOSTR_KIND_MESH_SYNC,
    tags,
    content: encryptedEnvelope,
    sig: signature
  };
}

/**
 * Validates inbound Nostr event against NIP-01 and BIP-340 rules.
 */
export function validateNostrEvent(event: NostrEvent): { valid: boolean; error?: string } {
  if (!event || typeof event !== 'object') return { valid: false, error: 'Invalid event object' };
  if (!event.id || !event.pubkey || !event.sig) return { valid: false, error: 'Missing mandatory fields' };

  // 1. Verify canonical serialization and event ID
  const canonicalJson = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ]);
  const expectedId = crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  if (expectedId !== event.id) {
    return { valid: false, error: `Event ID mismatch: computed ${expectedId} != ${event.id}` };
  }

  // 2. Verify BIP-340 Schnorr Signature
  const isSigValid = verifyBip340(event.pubkey, event.id, event.sig);
  if (!isSigValid) {
    return { valid: false, error: 'Invalid BIP-340 Schnorr signature' };
  }

  return { valid: true };
}

/**
 * Decrypt incoming Nostr mesh sync event.
 */
export function decryptNostrMeshEvent(event: NostrEvent, sharedSecret: Buffer): Buffer {
  const envelope = Buffer.from(event.content, 'base64');
  if (envelope.length < 28) {
    throw new Error('Nostr payload too short for AEAD envelope');
  }

  const nonce12 = envelope.subarray(0, 12);
  const tag = envelope.subarray(12, 28);
  const ciphertext = envelope.subarray(28);

  const decipher = crypto.createDecipheriv('chacha20-poly1305', sharedSecret, nonce12, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  const decrypted = decipher.update(ciphertext);
  decipher.final();

  return decrypted;
}

/**
 * [EXPERIMENTAL] Nostr Gateway Service.
 * Tracks WAN connectivity, provides duplicate suppression, bounded forwarding,
 * and handles encrypted relay synchronization.
 */
export class NostrGatewayService {
  public readonly isExperimental = true;
  public isGatewayActive = false;
  private knownEventIds = new Set<string>();
  private maxBoundedEvents = 1000;

  /**
   * Set WAN status (triggered by system network monitor).
   */
  setInternetConnectivity(isAvailable: boolean): void {
    this.isGatewayActive = isAvailable;
  }

  /**
   * Ingest a Nostr event from a relay with authentication and duplicate suppression.
   */
  ingestRelayEvent(event: NostrEvent, sharedSecret: Buffer): Buffer | null {
    // 1. Duplicate check (bounded forwarding)
    if (this.knownEventIds.has(event.id)) {
      return null;
    }

    // 2. Cryptographic signature and ID validation
    const validation = validateNostrEvent(event);
    if (!validation.valid) {
      console.warn('[NostrGateway] Discarded invalid relay event:', validation.error);
      return null;
    }

    // 3. Track bounded event cache
    if (this.knownEventIds.size >= this.maxBoundedEvents) {
      const first = this.knownEventIds.values().next().value;
      if (first) this.knownEventIds.delete(first);
    }
    this.knownEventIds.add(event.id);

    return decryptNostrMeshEvent(event, sharedSecret);
  }

  hasEvent(eventId: string): boolean {
    return this.knownEventIds.has(eventId);
  }

  clear(): void {
    this.knownEventIds.clear();
    this.isGatewayActive = false;
  }
}
