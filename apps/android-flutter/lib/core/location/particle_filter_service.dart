import 'dart:async';
import 'dart:math';
import 'gps_service.dart';

/// Great-Circle distance between two coordinates in meters (Haversine formula).
double calculateDistanceMeters(double lat1, double lon1, double lat2, double lon2) {
  const double r = 6371000; // Earth radius in meters
  final dLat = (lat2 - lat1) * pi / 180.0;
  final dLon = (lon2 - lon1) * pi / 180.0;
  final a = sin(dLat / 2) * sin(dLat / 2) +
      cos(lat1 * pi / 180.0) * cos(lat2 * pi / 180.0) * sin(dLon / 2) * sin(dLon / 2);
  final c = 2 * atan2(sqrt(a), sqrt(1 - a));
  return r * c;
}

/// A simulated kinematic mobility particle in the Monte Carlo swarm.
class Particle {
  double lat;
  double lon;
  double vx; // Velocity in meters/sec (east-west)
  double vy; // Velocity in meters/sec (north-south)
  double weight;

  Particle({
    required this.lat,
    required this.lon,
    required this.vx,
    required this.vy,
    required this.weight,
  });
}

/// Telemetry metrics and probability contours computed from the particle swarm.
class SearchAreaEstimates {
  final double centerLat;
  final double centerLon;
  final double radius50PercentMeters;
  final double radius75PercentMeters;
  final double radius90PercentMeters;
  final int particleCount;
  final int elapsedSeconds;
  final double contractionRatePercent;
  final List<Map<String, dynamic>> sampleParticles;

  SearchAreaEstimates({
    required this.centerLat,
    required this.centerLon,
    required this.radius50PercentMeters,
    required this.radius75PercentMeters,
    required this.radius90PercentMeters,
    required this.particleCount,
    required this.elapsedSeconds,
    required this.contractionRatePercent,
    required this.sampleParticles,
  });
}

/// Sequential Monte Carlo (Particle Filter) for tracking isolated casualties & responders.
/// Implements Bayesian measurement updates and Brownian kinematic motion.
class MobilityParticleFilter {
  final double lkpLat;
  final double lkpLon;
  final int numParticles;
  List<Particle> particles = [];
  int totalElapsedSeconds = 0;
  double _baselineRadiusMeters = 500.0;
  double _lastContractionRate = 0.0;

  MobilityParticleFilter({
    required this.lkpLat,
    required this.lkpLon,
    this.numParticles = 500,
    double initialDispersionMeters = 40.0,
  }) {
    _initializeParticles(numParticles, initialDispersionMeters);
  }

  void _initializeParticles(int num, double dispersionMeters) {
    const latOffsetPerMeter = 1.0 / 111320.0;
    final lonOffsetPerMeter = 1.0 / (111320.0 * cos(lkpLat * pi / 180.0));
    final random = Random();

    particles = [];
    for (int i = 0; i < num; i++) {
      final r = (random.nextDouble() + random.nextDouble() - 1.0) * dispersionMeters;
      final angle = random.nextDouble() * 2 * pi;
      final speed = 0.2 + random.nextDouble() * 0.8; // 0.2 to 1.0 m/s walking/injured speed
      final heading = random.nextDouble() * 2 * pi;

      particles.add(Particle(
        lat: lkpLat + (r * cos(angle)) * latOffsetPerMeter,
        lon: lkpLon + (r * sin(angle)) * lonOffsetPerMeter,
        vx: speed * cos(heading),
        vy: speed * sin(heading),
        weight: 1.0 / num,
      ));
    }

    final initialContours = estimateSearchContours();
    _baselineRadiusMeters = max(50.0, initialContours.radius90PercentMeters);
  }

  /// Propagate particles forward in time (dt in seconds).
  void propagate(double dtSeconds) {
    totalElapsedSeconds += dtSeconds.toInt();
    const latOffsetPerMeter = 1.0 / 111320.0;
    final lonOffsetPerMeter = 1.0 / (111320.0 * cos(lkpLat * pi / 180.0));
    final random = Random();

    for (final p in particles) {
      final noiseX = (random.nextDouble() - 0.5) * 0.3;
      final noiseY = (random.nextDouble() - 0.5) * 0.3;
      p.vx = (p.vx + noiseX).clamp(-1.5, 1.5);
      p.vy = (p.vy + noiseY).clamp(-1.5, 1.5);

      p.lat += (p.vy * dtSeconds) * latOffsetPerMeter;
      p.lon += (p.vx * dtSeconds) * lonOffsetPerMeter;
    }
  }

  /// Bayesian Measurement Update: Sighting or radio beacon detected.
  /// Re-weights particles via Gaussian likelihood and resamples the swarm to contract search radius.
  void observeSighting(double sightingLat, double sightingLon, {double accuracyMeters = 40.0}) {
    final beforeContours = estimateSearchContours();
    double totalWeight = 0.0;

    for (final p in particles) {
      final dist = calculateDistanceMeters(p.lat, p.lon, sightingLat, sightingLon);
      final likelihood = exp(-0.5 * pow(dist / accuracyMeters, 2));
      p.weight = p.weight * likelihood + 1e-12;
      totalWeight += p.weight;
    }

    // Normalize weights
    for (final p in particles) {
      p.weight /= totalWeight;
    }

    // Low-variance systematic resampling
    _resample();

    final afterContours = estimateSearchContours();
    if (beforeContours.radius90PercentMeters > 0) {
      final reduction = (beforeContours.radius90PercentMeters - afterContours.radius90PercentMeters) /
          beforeContours.radius90PercentMeters;
      _lastContractionRate = (reduction * 100.0).clamp(0.0, 95.0);
    }
  }

  void _resample() {
    final newParticles = <Particle>[];
    final n = particles.length;
    final step = 1.0 / n;
    final random = Random();
    double r = random.nextDouble() * step;
    double c = particles[0].weight;
    int i = 0;

    for (int m = 0; m < n; m++) {
      final u = r + m * step;
      while (u > c && i < n - 1) {
        i++;
        c += particles[i].weight;
      }
      final selected = particles[i];
      // Jitter slightly to prevent particle collapse
      newParticles.add(Particle(
        lat: selected.lat + (random.nextDouble() - 0.5) * 0.00004,
        lon: selected.lon + (random.nextDouble() - 0.5) * 0.00004,
        vx: selected.vx,
        vy: selected.vy,
        weight: 1.0 / n,
      ));
    }

    particles = newParticles;
  }

  /// Compute probability contours covering 50%, 75%, and 90% confidence radii.
  SearchAreaEstimates estimateSearchContours() {
    double sumLat = 0.0;
    double sumLon = 0.0;
    for (final p in particles) {
      sumLat += p.lat * p.weight;
      sumLon += p.lon * p.weight;
    }
    final centerLat = sumLat;
    final centerLon = sumLon;

    final distances = particles
        .map((p) => calculateDistanceMeters(centerLat, centerLon, p.lat, p.lon))
        .toList();
    distances.sort();

    final idx50 = (distances.length * 0.50).floor().clamp(0, distances.length - 1);
    final idx75 = (distances.length * 0.75).floor().clamp(0, distances.length - 1);
    final idx90 = (distances.length * 0.90).floor().clamp(0, distances.length - 1);

    return SearchAreaEstimates(
      centerLat: centerLat,
      centerLon: centerLon,
      radius50PercentMeters: distances[idx50],
      radius75PercentMeters: distances[idx75],
      radius90PercentMeters: distances[idx90],
      particleCount: particles.length,
      elapsedSeconds: totalElapsedSeconds,
      contractionRatePercent: _lastContractionRate > 0
          ? _lastContractionRate
          : max(0.0, (1.0 - (distances[idx90] / _baselineRadiusMeters)) * 100.0),
      sampleParticles: particles.take(100).map((p) => {
        'lat': p.lat,
        'lon': p.lon,
        'weight': p.weight,
      }).toList(),
    );
  }
}

/// Service managing continuous on-device particle filter simulation in the background.
class ParticleFilterService {
  static final ParticleFilterService _instance = ParticleFilterService._internal();
  factory ParticleFilterService() => _instance;
  ParticleFilterService._internal();

  MobilityParticleFilter? _filter;
  Timer? _ticker;
  StreamSubscription? _gpsSubscription;

  final StreamController<SearchAreaEstimates> _estimatesController =
      StreamController<SearchAreaEstimates>.broadcast();

  Stream<SearchAreaEstimates> get estimatesStream => _estimatesController.stream;
  SearchAreaEstimates? _lastEstimates;
  SearchAreaEstimates? get lastEstimates => _lastEstimates;
  bool get isRunning => _ticker != null && _ticker!.isActive;

  /// Start or reset the live background particle filter simulation.
  void startSimulation({
    double lkpLat = 27.7172,
    double lkpLon = 85.3240,
    int numParticles = 500,
  }) {
    stopSimulation();

    _filter = MobilityParticleFilter(
      lkpLat: lkpLat,
      lkpLon: lkpLon,
      numParticles: numParticles,
      initialDispersionMeters: 45.0,
    );

    // Initial broadcast
    _lastEstimates = _filter!.estimateSearchContours();
    _estimatesController.add(_lastEstimates!);

    // Continuous 1-second background propagation loop
    _ticker = Timer.periodic(const Duration(milliseconds: 1000), (_) {
      if (_filter == null) return;
      _filter!.propagate(1.0);
      _lastEstimates = _filter!.estimateSearchContours();
      _estimatesController.add(_lastEstimates!);
    });

    // Automatically bind to GPS fixes as sightings
    _gpsSubscription?.cancel();
    _gpsSubscription = GpsService().locationStream.listen((coords) {
      observeSighting(coords.latitude, coords.longitude, accuracyMeters: coords.accuracyMeters);
    });
  }

  /// Ingest an opportunistic radio or physical sighting to contract search uncertainty.
  void observeSighting(double sightingLat, double sightingLon, {double accuracyMeters = 35.0}) {
    if (_filter == null) return;
    _filter!.observeSighting(sightingLat, sightingLon, accuracyMeters: accuracyMeters);
    _lastEstimates = _filter!.estimateSearchContours();
    _estimatesController.add(_lastEstimates!);
  }

  void stopSimulation() {
    _ticker?.cancel();
    _ticker = null;
    _gpsSubscription?.cancel();
    _gpsSubscription = null;
  }
}
