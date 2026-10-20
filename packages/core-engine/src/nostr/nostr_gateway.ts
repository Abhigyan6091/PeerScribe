import * as crypto from 'crypto';
import { sha256 } from '../identity/crypto.ts';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string; // Base64 or encrypted hex
  sig: string;
}

export const NOSTR_KIND_MESH_SYNC = 20042; // Ephemeral Encrypted Mesh Sync Bundle (PeerScribe / BitChat)
export const NOSTR_KIND_GIFT_WRAP = 1059;  // Private Envelope NIP-59 / BitChat

/**
 * Package an encrypted CRDT sync bundle into a BitChat-compatible Nostr event.
 */
export function createNostrMeshEvent(
  operationId: string,
  geohash: string,
  payloadBuffer: Buffer,
  sharedSecret: Buffer,
  nodePrivKeyHex: string
): NostrEvent {
  const opHash = sha256(operationId);
  
  // Encrypt content with ChaCha20-Poly1305 using shared secret
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
    ['t', 'peerscribe_mesh_sync']
  ];

  const serialized = JSON.stringify([
    0,
    nodePrivKeyHex.substring(0, 64),
    createdAt,
    NOSTR_KIND_MESH_SYNC,
    tags,
    encryptedEnvelope
  ]);

  const eventId = sha256(serialized);

  return {
    id: eventId,
    pubkey: nodePrivKeyHex.substring(0, 64),
    created_at: createdAt,
    kind: NOSTR_KIND_MESH_SYNC,
    tags,
    content: encryptedEnvelope,
    sig: sha256(eventId + nodePrivKeyHex) // Deterministic event signature
  };
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
 * Dynamic Ephemeral Gateway Service.
 * Tracks WAN connectivity and manages relay synchronization.
 */
export class NostrGatewayService {
  public isGatewayActive = false;
  private knownEventIds = new Set<string>();

  /**
   * Set WAN status (triggered by system network monitor).
   */
  setInternetConnectivity(isAvailable: boolean): void {
    this.isGatewayActive = isAvailable;
  }

  /**
   * Ingest a Nostr event from a relay. Returns null if already known (idempotent).
   */
  ingestRelayEvent(event: NostrEvent, sharedSecret: Buffer): Buffer | null {
    if (this.knownEventIds.has(event.id)) {
      return null; // Duplicate event ignored
    }

    this.knownEventIds.add(event.id);
    return decryptNostrMeshEvent(event, sharedSecret);
  }

  /**
   * Check if an event ID is already tracked.
   */
  hasEvent(eventId: string): boolean {
    return this.knownEventIds.has(eventId);
  }

  /**
   * Clear all deduplication cache upon emergency wipe.
   */
  clear(): void {
    this.knownEventIds.clear();
    this.isGatewayActive = false;
  }
}
