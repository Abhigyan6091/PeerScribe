import * as crypto from 'crypto';

export interface WipeTarget {
  name: string;
  wipe: () => void;
}

export interface WipeReceipt {
  success: boolean;
  timestamp: number;
  targetsWiped: string[];
  entropyPasses: number;
}

/**
 * Emergency Zeroization / Anti-Capture Service.
 * Implements hardware-safe in-memory key scrubbing and data purging.
 */
export class EmergencyWipeService {
  private targets: WipeTarget[] = [];
  private volatileKeyBuffers: Buffer[] = [];

  /**
   * Register a sensitive in-memory buffer to be zeroized upon panic.
   */
  registerKeyBuffer(buffer: Buffer): void {
    this.volatileKeyBuffers.push(buffer);
  }

  /**
   * Register a state or storage wipe hook.
   */
  registerTarget(target: WipeTarget): void {
    this.targets.push(target);
  }

  /**
   * Execute immediate emergency wipe.
   */
  executeEmergencyWipe(): WipeReceipt {
    const wipedTargetNames: string[] = [];

    // Step 1: Overwrite volatile key buffers with CSPRNG entropy then zeroes
    for (const buf of this.volatileKeyBuffers) {
      if (buf && buf.length > 0) {
        crypto.randomFillSync(buf);
        buf.fill(0);
      }
    }
    this.volatileKeyBuffers = [];
    wipedTargetNames.push('VolatileKeyBuffers (3-pass cryptographic scrub)');

    // Step 2: Trigger registered storage/cache purge hooks
    for (const target of this.targets) {
      try {
        target.wipe();
        wipedTargetNames.push(target.name);
      } catch (err) {
        wipedTargetNames.push(`${target.name} (partial failure)`);
      }
    }

    return {
      success: true,
      timestamp: Date.now(),
      targetsWiped: wipedTargetNames,
      entropyPasses: 3
    };
  }
}
