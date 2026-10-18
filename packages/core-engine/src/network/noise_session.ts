import * as crypto from 'crypto';

export interface X25519KeyPair {
  publicKey: Buffer;  // 32 bytes
  privateKey: Buffer; // 32 bytes
}

export function generateX25519KeyPair(): X25519KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    publicKey: (publicKey.export({ type: 'spki', format: 'der' })).subarray(-32),
    privateKey: (privateKey.export({ type: 'pkcs8', format: 'der' })).subarray(-32)
  };
}

/**
 * Compute X25519 Diffie-Hellman shared secret.
 */
export function computeDH(ourPrivateKey: Buffer, theirPublicKey: Buffer): Buffer {
  const privKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b656e04220420', 'hex'),
      ourPrivateKey
    ]),
    format: 'der',
    type: 'pkcs8'
  });

  const pubKey = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b656e032100', 'hex'),
      theirPublicKey
    ]),
    format: 'der',
    type: 'spki'
  });

  return crypto.diffieHellman({ privateKey: privKey, publicKey: pubKey });
}

/**
 * ChaCha20-Poly1305 authenticated symmetric encryption.
 */
export function encryptChaCha20Poly1305(key: Buffer, nonce8: Buffer, plaintext: Buffer, ad = Buffer.alloc(0)): Buffer {
  // Pad 8-byte nonce to 12 bytes for Node.js standard ChaCha20-Poly1305
  const iv12 = Buffer.concat([Buffer.alloc(4, 0), nonce8]);
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, iv12, { authTagLength: 16 });
  if (ad.length > 0) cipher.setAAD(ad);
  const ct = cipher.update(plaintext);
  cipher.final();
  const tag = cipher.getAuthTag();
  return Buffer.concat([ct, tag]);
}

/**
 * ChaCha20-Poly1305 authenticated symmetric decryption.
 */
export function decryptChaCha20Poly1305(key: Buffer, nonce8: Buffer, ciphertextWithTag: Buffer, ad = Buffer.alloc(0)): Buffer {
  const iv12 = Buffer.concat([Buffer.alloc(4, 0), nonce8]);
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
  const ct = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);

  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, iv12, { authTagLength: 16 });
  if (ad.length > 0) decipher.setAAD(ad);
  decipher.setAuthTag(tag);
  const pt = decipher.update(ct);
  decipher.final();
  return pt;
}

/**
 * Noise Transport Cipher State.
 */
export class NoiseCipherState {
  private nonce = 0;
  private readonly key: Buffer;

  constructor(key: Buffer) {
    this.key = key;
  }

  encrypt(plaintext: Buffer): Buffer {
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64BE(BigInt(this.nonce++), 0);
    return encryptChaCha20Poly1305(this.key, nonceBuf, plaintext);
  }

  decrypt(ciphertext: Buffer): Buffer {
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64BE(BigInt(this.nonce++), 0);
    return decryptChaCha20Poly1305(this.key, nonceBuf, ciphertext);
  }
}

export interface EstablishedNoiseSession {
  peerStaticPublicKey: string; // Hex
  sendCipher: NoiseCipherState;
  receiveCipher: NoiseCipherState;
}

/**
 * Noise_XX Session Handshake Machine (Direct BitChat Pattern).
 * Implements 3-message mutual authentication with Perfect Forward Secrecy.
 */
export class NoiseHandshakeSession {
  private e?: X25519KeyPair;
  private re?: Buffer; // Remote ephemeral
  private rs?: Buffer; // Remote static
  private chainingKey: Buffer;
  public readonly role: 'INITIATOR' | 'RESPONDER';
  private readonly staticKey: X25519KeyPair;

  constructor(
    role: 'INITIATOR' | 'RESPONDER',
    staticKey: X25519KeyPair
  ) {
    this.role = role;
    this.staticKey = staticKey;
    this.chainingKey = crypto.createHash('sha256').update('Noise_XX_25519_ChaChaPoly_SHA256').digest();
  }

  /**
   * Message 1 (Initiator -> Responder): -> e
   */
  createMessage1(): Buffer {
    if (this.role !== 'INITIATOR') throw new Error('Only initiator creates message 1');
    this.e = generateX25519KeyPair();
    // Mix e into chaining key
    this.chainingKey = crypto.createHash('sha256').update(Buffer.concat([this.chainingKey, this.e.publicKey])).digest();
    return this.e.publicKey;
  }

  /**
   * Message 2 (Responder -> Initiator): <- e, ee, s, es
   */
  processMessage1AndCreateMessage2(msg1: Buffer): Buffer {
    if (this.role !== 'RESPONDER') throw new Error('Only responder processes message 1');
    this.re = msg1.subarray(0, 32);
    this.chainingKey = crypto.createHash('sha256').update(Buffer.concat([this.chainingKey, this.re])).digest();

    this.e = generateX25519KeyPair();
    this.chainingKey = crypto.createHash('sha256').update(Buffer.concat([this.chainingKey, this.e.publicKey])).digest();

    // ee = DH(e, re)
    const ee = computeDH(this.e.privateKey, this.re);
    this.chainingKey = crypto.createHash('sha256').update(Buffer.concat([this.chainingKey, ee])).digest();

    // Encrypt static key s
    const nonce0 = Buffer.alloc(8, 0);
    const encryptedStatic = encryptChaCha20Poly1305(this.chainingKey, nonce0, this.staticKey.publicKey);

    // es = DH(s, re)
    const es = computeDH(this.staticKey.privateKey, this.re);
    this.chainingKey = crypto.createHash('sha256').update(Buffer.concat([this.chainingKey, es])).digest();

    return Buffer.concat([this.e.publicKey, encryptedStatic]);
  }

  /**
   * Message 3 (Initiator -> Responder): -> s, se and establish session
   */
  processMessage2AndCreateMessage3(msg2: Buffer): { message3: Buffer; session: EstablishedNoiseSession } {
    if (this.role !== 'INITIATOR' || !this.e) throw new Error('Invalid state for message 3');

    this.re = msg2.subarray(0, 32);
    this.chainingKey = crypto.createHash('sha256').update(Buffer.concat([this.chainingKey, this.re])).digest();

    const ee = computeDH(this.e.privateKey, this.re);
    this.chainingKey = crypto.createHash('sha256').update(Buffer.concat([this.chainingKey, ee])).digest();

    // Decrypt remote static key
    const nonce0 = Buffer.alloc(8, 0);
    const encryptedStatic = msg2.subarray(32, 32 + 32 + 16);
    this.rs = decryptChaCha20Poly1305(this.chainingKey, nonce0, encryptedStatic);

    const es = computeDH(this.e.privateKey, this.rs);
    this.chainingKey = crypto.createHash('sha256').update(Buffer.concat([this.chainingKey, es])).digest();

    // Encrypt our static key
    const encryptedOurStatic = encryptChaCha20Poly1305(this.chainingKey, nonce0, this.staticKey.publicKey);

    // se = DH(s, re)
    const se = computeDH(this.staticKey.privateKey, this.re);
    this.chainingKey = crypto.createHash('sha256').update(Buffer.concat([this.chainingKey, se])).digest();

    // Split transport keys
    const k1 = crypto.createHash('sha256').update(Buffer.concat([this.chainingKey, Buffer.from('INITIATOR_SEND')])).digest();
    const k2 = crypto.createHash('sha256').update(Buffer.concat([this.chainingKey, Buffer.from('INITIATOR_RECV')])).digest();

    const session: EstablishedNoiseSession = {
      peerStaticPublicKey: this.rs.toString('hex'),
      sendCipher: new NoiseCipherState(k1),
      receiveCipher: new NoiseCipherState(k2)
    };

    return { message3: encryptedOurStatic, session };
  }

  /**
   * Finalize session on Responder side after receiving message 3.
   */
  processMessage3(msg3: Buffer): EstablishedNoiseSession {
    if (this.role !== 'RESPONDER' || !this.e) throw new Error('Invalid state for processMessage3');

    const nonce0 = Buffer.alloc(8, 0);
    this.rs = decryptChaCha20Poly1305(this.chainingKey, nonce0, msg3);

    const se = computeDH(this.e.privateKey, this.rs);
    this.chainingKey = crypto.createHash('sha256').update(Buffer.concat([this.chainingKey, se])).digest();

    // Split transport keys (mirrored from Initiator)
    const k1 = crypto.createHash('sha256').update(Buffer.concat([this.chainingKey, Buffer.from('INITIATOR_SEND')])).digest();
    const k2 = crypto.createHash('sha256').update(Buffer.concat([this.chainingKey, Buffer.from('INITIATOR_RECV')])).digest();

    return {
      peerStaticPublicKey: this.rs.toString('hex'),
      sendCipher: new NoiseCipherState(k2), // Responder sends on k2
      receiveCipher: new NoiseCipherState(k1) // Responder receives on k1
    };
  }
}
