/**
 * Calculate Great-Circle distance between two coordinates in meters (Haversine formula).
 */
export function calculateDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export interface Particle {
  lat: number;
  lon: number;
  vx: number; // m/s
  vy: number; // m/s
  weight: number;
}

export interface SearchAreaEstimates {
  centerLat: number;
  centerLon: number;
  radius50PercentMeters: number;
  radius75PercentMeters: number;
  radius90PercentMeters: number;
  particleCount: number;
  elapsedSeconds: number;
}

/**
 * Sequential Monte Carlo (Particle Filter) for tracking isolated individuals.
 * Probabilistically estimates search area under zero-connectivity conditions.
 */
export class MobilityParticleFilter {
  private particles: Particle[] = [];
  private totalElapsedSeconds = 0;
  public readonly lkpLat: number;
  public readonly lkpLon: number;

  constructor(
    lkpLat: number,
    lkpLon: number,
    numParticles = 500,
    initialDispersionMeters = 30
  ) {
    this.lkpLat = lkpLat;
    this.lkpLon = lkpLon;
    this.initializeParticles(numParticles, initialDispersionMeters);
  }

  private initializeParticles(num: number, dispersionMeters: number): void {
    const latOffsetPerMeter = 1 / 111320;
    const lonOffsetPerMeter = 1 / (111320 * Math.cos(this.lkpLat * Math.PI / 180));

    this.particles = [];
    for (let i = 0; i < num; i++) {
      // Gaussian perturbation
      const r = (Math.random() + Math.random() - 1) * dispersionMeters;
      const angle = Math.random() * 2 * Math.PI;

      // Random initial velocity (0.2 to 1.2 m/s typical walking/injured speed)
      const speed = 0.2 + Math.random() * 0.8;
      const heading = Math.random() * 2 * Math.PI;

      this.particles.push({
        lat: this.lkpLat + (r * Math.cos(angle)) * latOffsetPerMeter,
        lon: this.lkpLon + (r * Math.sin(angle)) * lonOffsetPerMeter,
        vx: speed * Math.cos(heading),
        vy: speed * Math.sin(heading),
        weight: 1.0 / num
      });
    }
  }

  /**
   * Propagate particles forward in time (dt in seconds).
   */
  propagate(dtSeconds: number): void {
    this.totalElapsedSeconds += dtSeconds;
    const latOffsetPerMeter = 1 / 111320;
    const lonOffsetPerMeter = 1 / (111320 * Math.cos(this.lkpLat * Math.PI / 180));

    for (const p of this.particles) {
      // Kinematic update with Brownian motion noise
      const noiseX = (Math.random() - 0.5) * 0.3;
      const noiseY = (Math.random() - 0.5) * 0.3;
      p.vx = Math.max(-1.5, Math.min(1.5, p.vx + noiseX));
      p.vy = Math.max(-1.5, Math.min(1.5, p.vy + noiseY));

      p.lat += (p.vy * dtSeconds) * latOffsetPerMeter;
      p.lon += (p.vx * dtSeconds) * lonOffsetPerMeter;
    }
  }

  /**
   * Bayesian Measurement Update: A passing peer detects an opportunistic radio beacon.
   * Re-weights particles and resamples swarm to contract search area.
   */
  observeSighting(sightingLat: number, sightingLon: number, accuracyMeters = 50): void {
    let totalWeight = 0;

    for (const p of this.particles) {
      const dist = calculateDistanceMeters(p.lat, p.lon, sightingLat, sightingLon);
      // Gaussian likelihood: L = exp(-0.5 * (d / sigma)^2)
      const likelihood = Math.exp(-0.5 * Math.pow(dist / accuracyMeters, 2));
      p.weight = p.weight * likelihood + 1e-12; // Avoid zero
      totalWeight += p.weight;
    }

    // Normalize
    for (const p of this.particles) {
      p.weight /= totalWeight;
    }

    // Resample
    this.resample();
  }

  private resample(): void {
    const newParticles: Particle[] = [];
    const N = this.particles.length;
    const step = 1.0 / N;
    let r = Math.random() * step;
    let c = this.particles[0].weight;
    let i = 0;

    for (let m = 0; m < N; m++) {
      const u = r + m * step;
      while (u > c && i < N - 1) {
        i++;
        c += this.particles[i].weight;
      }
      const selected = this.particles[i];
      // Clone with small jitter
      newParticles.push({
        lat: selected.lat + (Math.random() - 0.5) * 0.00005,
        lon: selected.lon + (Math.random() - 0.5) * 0.00005,
        vx: selected.vx,
        vy: selected.vy,
        weight: 1.0 / N
      });
    }

    this.particles = newParticles;
  }

  /**
   * Estimate search area radii covering 50%, 75%, and 90% probability mass.
   */
  estimateSearchContours(): SearchAreaEstimates {
    // Calculate weighted center
    let sumLat = 0, sumLon = 0;
    for (const p of this.particles) {
      sumLat += p.lat * p.weight;
      sumLon += p.lon * p.weight;
    }
    const centerLat = sumLat;
    const centerLon = sumLon;

    // Distances from center
    const distances = this.particles.map(p => calculateDistanceMeters(centerLat, centerLon, p.lat, p.lon));
    distances.sort((a, b) => a - b);

    const idx50 = Math.floor(distances.length * 0.50);
    const idx75 = Math.floor(distances.length * 0.75);
    const idx90 = Math.floor(distances.length * 0.90);

    return {
      centerLat,
      centerLon,
      radius50PercentMeters: distances[idx50],
      radius75PercentMeters: distances[idx75],
      radius90PercentMeters: distances[idx90],
      particleCount: this.particles.length,
      elapsedSeconds: this.totalElapsedSeconds
    };
  }
}
