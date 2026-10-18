import { sha256 } from './crypto.ts';

export const TRIAGE_COLORS = [
  'RED', 'YELLOW', 'GREEN', 'BLACK', 'BLUE', 'AMBER', 'WHITE', 'ORANGE'
] as const;

export const PHONETIC_ANIMALS = [
  'FALCON', 'WOLF', 'OTTER', 'BADGER', 'EAGLE', 'HAWK',
  'BEAR', 'VIPER', 'FOX', 'TIGER', 'PANTHER', 'COBRA',
  'RAVEN', 'SHARK', 'BISON', 'STAG', 'LYNX', 'CONDOR'
] as const;

export interface EphemeralIdentity {
  patientId: string;
  operationId: string;
  ephemeralId: string; // e.g., "RED-FALCON-04"
  visualHash: string; // Deterministic 4x4 SVG identicon
  scannablePayload: string; // Compact URI
  confirmedIdentityLink?: string | null;
  createdAt: number;
}

/**
 * Generate a deterministic or random ephemeral operational identity for an intake patient.
 */
export function generateEphemeralId(
  operationId: string,
  patientId: string,
  preferredColor?: string,
  sequenceNumber?: number
): EphemeralIdentity {
  const hash = sha256(`${operationId}:${patientId}`);
  
  // Choose color
  const color = preferredColor && TRIAGE_COLORS.includes(preferredColor as any)
    ? preferredColor
    : TRIAGE_COLORS[parseInt(hash.substring(0, 2), 16) % TRIAGE_COLORS.length];

  // Choose animal
  const animal = PHONETIC_ANIMALS[parseInt(hash.substring(2, 4), 16) % PHONETIC_ANIMALS.length];

  // Choose sequence number (1-99)
  const num = sequenceNumber !== undefined
    ? sequenceNumber
    : (parseInt(hash.substring(4, 6), 16) % 99) + 1;
  const numStr = num < 10 ? `0${num}` : `${num}`;

  const ephemeralId = `${color}-${animal}-${numStr}`;
  const visualHash = generateIdenticonSvg(hash);
  const scannablePayload = `peerscribe://pt/${operationId}/${patientId}/${ephemeralId}`;

  return {
    patientId,
    operationId,
    ephemeralId,
    visualHash,
    scannablePayload,
    confirmedIdentityLink: null,
    createdAt: Date.now()
  };
}

/**
 * Generate a deterministic high-contrast 4x4 visual identicon as an SVG string.
 */
export function generateIdenticonSvg(hashHex: string, size = 64): string {
  // Use first 16 characters for a 4x4 grid (1 = filled, 0 = background)
  const grid: boolean[][] = [];
  for (let r = 0; r < 4; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < 4; c++) {
      const charIndex = r * 4 + c;
      const val = parseInt(hashHex[charIndex] || '0', 16);
      row.push(val % 2 === 1);
    }
    grid.push(row);
  }

  // Derive high-contrast foreground color from hash
  const rCol = (parseInt(hashHex.substring(16, 18), 16) % 180) + 75;
  const gCol = (parseInt(hashHex.substring(18, 20), 16) % 180) + 75;
  const bCol = (parseInt(hashHex.substring(20, 22), 16) % 180) + 75;
  const fgColor = `rgb(${rCol},${gCol},${bCol})`;
  const bgColor = '#121316';

  const cellSize = size / 4;
  let rects = '';

  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (grid[r][c]) {
        rects += `<rect x="${c * cellSize}" y="${r * cellSize}" width="${cellSize}" height="${cellSize}" fill="${fgColor}"/>`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${bgColor}"/>${rects}</svg>`;
}

/**
 * Parse an ephemeral scannable URI tag.
 */
export function parseScannablePayload(payload: string): { operationId: string; patientId: string; ephemeralId: string } | null {
  const match = payload.match(/^peerscribe:\/\/pt\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return {
    operationId: match[1],
    patientId: match[2],
    ephemeralId: match[3]
  };
}
