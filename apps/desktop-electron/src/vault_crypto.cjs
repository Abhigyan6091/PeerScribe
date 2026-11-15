const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * PeerScribe Desktop Personal Profile Vault Crypto
 * Implements standard AES-256-GCM authenticated encryption with per-installation/user protected keys.
 * Uses Electron safeStorage (Windows DPAPI) in production.
 */

class VaultDecryptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VaultDecryptionError';
  }
}

/**
 * Retrieve or generate an AES-256 key for vault encryption.
 * In Electron production with safeStorage enabled, the 256-bit key is protected by Windows DPAPI.
 * In headless/test mode, protected file storage is used.
 */
function getOrCreateVaultKey(keyFilePath, options = {}) {
  const safeStorage = options.safeStorage;
  const isEncryptionAvailable = Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
  const isTestEnvironment = process.env.NODE_ENV === 'test' || options.allowInsecureFallback === true;

  if (!isEncryptionAvailable && !isTestEnvironment) {
    throw new Error('Security Violation: Electron safeStorage (Windows DPAPI) is unavailable. Refusing silent security downgrade to raw-key file storage in production.');
  }

  if (fs.existsSync(keyFilePath)) {
    const rawBuffer = fs.readFileSync(keyFilePath);
    if (isEncryptionAvailable) {
      try {
        const decryptedHex = safeStorage.decryptString(rawBuffer);
        return Buffer.from(decryptedHex, 'hex');
      } catch (err) {
        throw new VaultDecryptionError(`Failed to decrypt DPAPI vault key: ${err.message}`);
      }
    } else {
      // Direct raw key storage permitted ONLY for test / CLI environments
      const content = rawBuffer.toString('utf8').trim();
      return Buffer.from(content, 'hex');
    }
  }

  // Generate fresh cryptographically secure 256-bit random key
  const freshKey = crypto.randomBytes(32);
  const keyHex = freshKey.toString('hex');

  const dir = path.dirname(keyFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (isEncryptionAvailable) {
    const encryptedKey = safeStorage.encryptString(keyHex);
    fs.writeFileSync(keyFilePath, encryptedKey);
  } else {
    // Permitted only in explicit test environments
    fs.writeFileSync(keyFilePath, keyHex, { mode: 0o600 });
  }

  return freshKey;
}

/**
 * Encrypt vault data object using AES-256-GCM.
 */
function encryptVault(data, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Vault encryption requires a 32-byte (256-bit) key');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const jsonStr = JSON.stringify(data);
  const ciphertext = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  });
}

/**
 * Decrypt vault ciphertext using AES-256-GCM.
 * Validates GCM authentication tag. Rejects tampered ciphertext.
 */
function decryptVault(raw, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Vault decryption requires a 32-byte (256-bit) key');
  }
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    throw new VaultDecryptionError(`Vault data is not valid JSON: ${err.message}`);
  }

  if (!parsed.iv || !parsed.tag || !parsed.ciphertext) {
    throw new VaultDecryptionError('Vault envelope is missing required fields (iv, tag, ciphertext)');
  }

  const iv = Buffer.from(parsed.iv, 'base64');
  const tag = Buffer.from(parsed.tag, 'base64');
  const ciphertext = Buffer.from(parsed.ciphertext, 'base64');

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (err) {
    throw new VaultDecryptionError(`Vault authentication or decryption failed: ${err.message}`);
  }
}

module.exports = {
  VaultDecryptionError,
  getOrCreateVaultKey,
  encryptVault,
  decryptVault
};
