import * as crypto from 'crypto';

export interface PersonalMedicalProfile {
  citizenId: string;
  fullName: string;
  dateOfBirth?: string;
  bloodGroup: 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-' | 'UNKNOWN';
  allergies: string[];
  chronicConditions: string[];
  currentMedications: {
    name: string;
    dosage?: string;
    frequency?: string;
  }[];
  emergencyContacts: {
    name: string;
    relation: string;
    phone: string;
  }[];
  organDonor?: boolean;
  confidentialNotes?: string;
  updatedAt: number;
}

export interface EmergencyMedicalSnapshot {
  bloodGroup: string;
  allergies: string[];
  criticalConditions: string[];
  currentMedicationsSummary: string[];
  emergencyContacts: {
    name: string;
    relation: string;
    phone: string;
  }[];
  extractedAt: number;
}

export interface EncryptedVaultPayload {
  version: number;
  saltHex: string;
  ivHex: string;
  authTagHex: string;
  cipherTextHex: string;
}

/**
 * Derive a 256-bit encryption key using PBKDF2 with SHA-256.
 */
function deriveKey(passphrase: string, salt: Buffer, iterations = 10000): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256');
}

/**
 * Encrypt citizen medical profile using AES-256-GCM authenticated cipher.
 */
export function encryptProfile(profile: PersonalMedicalProfile, passphrase: string): EncryptedVaultPayload {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const jsonStr = JSON.stringify(profile);
  let encrypted = cipher.update(jsonStr, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    saltHex: salt.toString('hex'),
    ivHex: iv.toString('hex'),
    authTagHex: authTag.toString('hex'),
    cipherTextHex: encrypted
  };
}

/**
 * Decrypt citizen medical profile using AES-256-GCM.
 */
export function decryptProfile(payload: EncryptedVaultPayload, passphrase: string): PersonalMedicalProfile {
  const salt = Buffer.from(payload.saltHex, 'hex');
  const iv = Buffer.from(payload.ivHex, 'hex');
  const authTag = Buffer.from(payload.authTagHex, 'hex');
  const key = deriveKey(passphrase, salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(payload.cipherTextHex, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');

  return JSON.parse(decrypted) as PersonalMedicalProfile;
}

/**
 * Extract a privacy-preserving emergency medical snapshot for disaster intake.
 */
export function extractEmergencySnapshot(profile: PersonalMedicalProfile): EmergencyMedicalSnapshot {
  return {
    bloodGroup: profile.bloodGroup,
    allergies: [...profile.allergies],
    criticalConditions: [...profile.chronicConditions],
    currentMedicationsSummary: profile.currentMedications.map(m => `${m.name} ${m.dosage || ''}`.trim()),
    emergencyContacts: profile.emergencyContacts.map(c => ({ ...c })),
    extractedAt: Date.now()
  };
}
