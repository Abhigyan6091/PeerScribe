import 'dart:math';
import 'package:flutter/material.dart';
import 'theme.dart';

class SearchHeatmapView extends StatelessWidget {
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
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('SEARCH PROBABILITY: $patientEphemeralId'),
        backgroundColor: TacticalTheme.surface,
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
                  Icon(Icons.info_outline, color: Colors.amber, size: 20),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'SIMULATED MOBILITY MODEL (RESEARCH PROTOTYPE)\nNot for unvalidated solo tactical rescue dispatch.',
                      style: TextStyle(color: Colors.amber, fontSize: 11, fontWeight: FontWeight.bold),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('LAST KNOWN SIGHTING', style: TextStyle(color: TacticalTheme.textSecondary, fontSize: 11, letterSpacing: 1.1)),
                    const SizedBox(height: 4),
                    Text(lastKnownLocation, style: const TextStyle(color: TacticalTheme.primary, fontSize: 16, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 4),
                    Text('Observation Age: $locationAge', style: const TextStyle(color: TacticalTheme.textMuted, fontSize: 12)),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
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
                  painter: HeatmapPainter(),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                _buildMetric('Active Particles', '500'),
                _buildMetric('Search Radius', '850m'),
                _buildMetric('Contraction Rate', '72%'),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMetric(String label, String value) {
    return Column(
      children: [
        Text(value, style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold)),
        const SizedBox(height: 2),
        Text(label, style: const TextStyle(color: TacticalTheme.textMuted, fontSize: 11)),
      ],
    );
  }
}

class HeatmapPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final paintRing = Paint()
      ..color = TacticalTheme.primary.withOpacity(0.15)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.0;

    // Draw range rings
    for (double r = 40; r <= 140; r += 35) {
      canvas.drawCircle(center, r, paintRing);
    }

    // Draw simulated particles
    final random = Random(42);
    final particlePaint = Paint()..style = PaintingStyle.fill;

    for (int i = 0; i < 400; i++) {
      final u = random.nextDouble() + random.nextDouble();
      final r = (u > 1 ? 2 - u : u) * 130;
      final theta = random.nextDouble() * 2 * pi;

      final dx = center.dx + r * cos(theta);
      final dy = center.dy + r * sin(theta);

      final intensity = (1.0 - (r / 140)).clamp(0.1, 1.0);
      particlePaint.color = Color.lerp(
        Colors.blue.withOpacity(0.2),
        TacticalTheme.primary.withOpacity(0.8),
        intensity,
      )!;

      canvas.drawCircle(Offset(dx, dy), 2.5 * intensity, particlePaint);
    }

    // Center Sighting Marker
    final centerPaint = Paint()..color = Colors.redAccent;
    canvas.drawCircle(center, 5, centerPaint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
