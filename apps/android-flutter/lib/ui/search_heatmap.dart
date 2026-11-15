import 'dart:async';
import 'dart:math';
import 'package:flutter/material.dart';
import '../core/location/particle_filter_service.dart';
import 'theme.dart';

class SearchHeatmapView extends StatefulWidget {
  final String patientEphemeralId;
  final String lastKnownLocation;
  final String locationAge;

  const SearchHeatmapView({
    Key? key,
    required this.patientEphemeralId,
    required this.lastKnownLocation,
    required this.locationAge,
  }) : super(key: key);

  @override
  State<SearchHeatmapView> createState() => _SearchHeatmapViewState();
}

class _SearchHeatmapViewState extends State<SearchHeatmapView> {
  final ParticleFilterService _particleService = ParticleFilterService();
  StreamSubscription<SearchAreaEstimates>? _subscription;
  SearchAreaEstimates? _currentEstimates;

  @override
  void initState() {
    super.initState();
    _particleService.startSimulation(
      lkpLat: 27.7172,
      lkpLon: 85.3240,
      numParticles: 500,
    );
    _currentEstimates = _particleService.lastEstimates;

    _subscription = _particleService.estimatesStream.listen((estimates) {
      if (mounted) {
        setState(() {
          _currentEstimates = estimates;
        });
      }
    });
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }

  void _triggerSighting() {
    // Ingest a tactical sighting with random local offset representing beacon or peer sighting
    final random = Random();
    final dLat = (random.nextDouble() - 0.5) * 0.0004;
    final dLon = (random.nextDouble() - 0.5) * 0.0004;
    final sightingLat = 27.7172 + dLat;
    final sightingLon = 85.3240 + dLon;

    _particleService.observeSighting(sightingLat, sightingLon, accuracyMeters: 30.0);

    final rate = _particleService.lastEstimates?.contractionRatePercent ?? 45.0;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('Sighting Ingested: Search area contracted by ${rate.toStringAsFixed(1)}%'),
        backgroundColor: TacticalTheme.primary,
        duration: const Duration(seconds: 2),
      ),
    );
  }

  void _reanchorLkp() {
    _particleService.startSimulation(lkpLat: 27.7172, lkpLon: 85.3240, numParticles: 500);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Swarm Re-anchored to Last Known Position')),
    );
  }

  String _formatElapsed(int seconds) {
    final m = seconds ~/ 60;
    final s = seconds % 60;
    return '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final estimates = _currentEstimates;
    final radius50 = estimates != null ? '${estimates.radius50PercentMeters.toStringAsFixed(0)}m' : '120m';
    final radius90 = estimates != null ? '${estimates.radius90PercentMeters.toStringAsFixed(0)}m' : '380m';
    final contraction = estimates != null ? '${estimates.contractionRatePercent.toStringAsFixed(1)}%' : '0.0%';
    final elapsedStr = estimates != null ? _formatElapsed(estimates.elapsedSeconds) : '00:00';

    return Scaffold(
      appBar: AppBar(
        title: Text('SEARCH PROBABILITY: ${widget.patientEphemeralId}'),
        backgroundColor: TacticalTheme.surface,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Re-anchor LKP',
            onPressed: _reanchorLkp,
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Warning header: Research prototype disclaimer
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.amber.withOpacity(0.15),
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: Colors.amber, width: 1),
              ),
              child: Row(
                children: const [
                  Icon(Icons.radar, color: Colors.amber, size: 20),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'LIVE MONTE CARLO PARTICLE FILTER (500 PARTICLES)\nContinuous kinematic Brownian motion & Bayesian sighting updates.',
                      style: TextStyle(color: Colors.amber, fontSize: 11, fontWeight: FontWeight.bold),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),

            // Sighting Metadata Card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(14.0),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('LAST KNOWN SIGHTING (LKP)', style: TextStyle(color: TacticalTheme.textSecondary, fontSize: 11, letterSpacing: 1.1)),
                        const SizedBox(height: 4),
                        Text(widget.lastKnownLocation, style: const TextStyle(color: TacticalTheme.primary, fontSize: 15, fontWeight: FontWeight.bold)),
                        const SizedBox(height: 2),
                        Text('Original Fix Age: ${widget.locationAge} | Drift Time: $elapsedStr', style: const TextStyle(color: TacticalTheme.textMuted, fontSize: 12)),
                      ],
                    ),
                    ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: TacticalTheme.surfaceVariant,
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      ),
                      icon: const Icon(Icons.sensors, size: 16, color: TacticalTheme.primary),
                      label: const Text('SIGHTING', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                      onPressed: _triggerSighting,
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 14),

            // Canvas Particle Heatmap
            Container(
              height: 320,
              decoration: BoxDecoration(
                color: const Color(0xFF070B12),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: TacticalTheme.border),
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: CustomPaint(
                  size: const Size(double.infinity, 320),
                  painter: LiveParticleHeatmapPainter(estimates: estimates),
                ),
              ),
            ),
            const SizedBox(height: 14),

            // Live Telemetry Grid
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                _buildMetric('Active Swarm', '${estimates?.particleCount ?? 500} pts', Colors.white),
                _buildMetric('50% Radius', radius50, TacticalTheme.triageGreen),
                _buildMetric('90% Radius', radius90, TacticalTheme.triageYellow),
                _buildMetric('Contraction', contraction, TacticalTheme.primary),
              ],
            ),
            const SizedBox(height: 16),

            // Tactical Actions
            SizedBox(
              width: double.infinity,
              height: 48,
              child: ElevatedButton.icon(
                style: ElevatedButton.styleFrom(
                  backgroundColor: TacticalTheme.primary,
                  foregroundColor: Colors.black,
                  textStyle: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                ),
                icon: const Icon(Icons.satellite_alt),
                label: const Text('RECORD OPPORTUNISTIC PEER SIGHTING'),
                onPressed: _triggerSighting,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMetric(String label, String value, Color color) {
    return Column(
      children: [
        Text(value, style: TextStyle(color: color, fontSize: 16, fontWeight: FontWeight.bold)),
        const SizedBox(height: 2),
        Text(label, style: const TextStyle(color: TacticalTheme.textMuted, fontSize: 11)),
      ],
    );
  }
}

class LiveParticleHeatmapPainter extends CustomPainter {
  final SearchAreaEstimates? estimates;

  LiveParticleHeatmapPainter({this.estimates});

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);

    // 1. Draw radar sweep grid
    final gridPaint = Paint()
      ..color = const Color(0xFF142033)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.0;

    canvas.drawLine(Offset(0, center.dy), Offset(size.width, center.dy), gridPaint);
    canvas.drawLine(Offset(center.dx, 0), Offset(center.dx, size.height), gridPaint);

    for (double r = 35; r <= 140; r += 35) {
      canvas.drawCircle(center, r, gridPaint);
    }

    // 2. Draw live probability isochrone rings
    final maxR = 140.0;
    final r90Meters = max(10.0, estimates?.radius90PercentMeters ?? 400.0);
    final scale = maxR / r90Meters;

    final ring90Radius = (estimates?.radius90PercentMeters ?? 400.0) * scale;
    final ring75Radius = (estimates?.radius75PercentMeters ?? 250.0) * scale;
    final ring50Radius = (estimates?.radius50PercentMeters ?? 120.0) * scale;

    // 90% Confidence Ring (Crimson)
    final paint90 = Paint()
      ..color = TacticalTheme.triageRed.withOpacity(0.3)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    canvas.drawCircle(center, ring90Radius.clamp(10.0, maxR), paint90);

    // 75% Confidence Ring (Yellow)
    final paint75 = Paint()
      ..color = TacticalTheme.triageYellow.withOpacity(0.4)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    canvas.drawCircle(center, ring75Radius.clamp(10.0, maxR), paint75);

    // 50% Confidence Core (Emerald)
    final paint50 = Paint()
      ..color = TacticalTheme.triageGreen.withOpacity(0.6)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.0;
    canvas.drawCircle(center, ring50Radius.clamp(5.0, maxR), paint50);

    // 3. Draw live simulated particles from sample swarm
    final particlePaint = Paint()..style = PaintingStyle.fill;
    final samples = estimates?.sampleParticles ?? [];

    if (samples.isNotEmpty) {
      final cLat = estimates?.centerLat ?? 27.7172;
      final cLon = estimates?.centerLon ?? 85.3240;

      for (final p in samples) {
        final pLat = (p['lat'] as num).toDouble();
        final pLon = (p['lon'] as num).toDouble();
        final weight = (p['weight'] as num?)?.toDouble() ?? 0.01;

        final dy = (cLat - pLat) * 111320.0 * scale;
        final dx = (pLon - cLon) * 111320.0 * cos(cLat * pi / 180.0) * scale;

        final pt = Offset(center.dx + dx, center.dy + dy);
        if (pt.dx >= 0 && pt.dx <= size.width && pt.dy >= 0 && pt.dy <= size.height) {
          particlePaint.color = TacticalTheme.primary.withOpacity((weight * 25.0).clamp(0.25, 0.95));
          canvas.drawCircle(pt, 2.2, particlePaint);
        }
      }
    } else {
      // Fallback initial dot cluster
      final random = Random(42);
      for (int i = 0; i < 60; i++) {
        final u = random.nextDouble() + random.nextDouble();
        final r = (u > 1 ? 2 - u : u) * 45;
        final theta = random.nextDouble() * 2 * pi;
        particlePaint.color = TacticalTheme.primary.withOpacity(0.5);
        canvas.drawCircle(Offset(center.dx + r * cos(theta), center.dy + r * sin(theta)), 2.0, particlePaint);
      }
    }

    // 4. Center LKP Marker
    final centerPaint = Paint()..color = Colors.white;
    canvas.drawCircle(center, 3.5, centerPaint);
  }

  @override
  bool shouldRepaint(covariant LiveParticleHeatmapPainter oldDelegate) {
    return true;
  }
}
