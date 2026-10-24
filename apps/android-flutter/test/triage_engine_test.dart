import 'package:flutter_test/flutter_test.dart';
import 'package:peerscribe_mobile/core/clinical/start_triage_engine.dart';

void main() {
  group('START Triage Protocol Rules Decision Tree Tests', () {
    test('tags ambulatory patient as GREEN', () {
      final res = StartTriageEngine.evaluateStart(
        canWalk: true,
        breathing: true,
      );
      expect(res['category'], equals('GREEN'));
    });

    test('tags apneic patient as BLACK when airway repositioning fails', () {
      final res = StartTriageEngine.evaluateStart(
        canWalk: false,
        breathing: false,
        airwayRepositionedBreathing: false,
      );
      expect(res['category'], equals('BLACK'));
    });

    test('tags patient as RED when breathing only resumes upon repositioning', () {
      final res = StartTriageEngine.evaluateStart(
        canWalk: false,
        breathing: false,
        airwayRepositionedBreathing: true,
      );
      expect(res['category'], equals('RED'));
    });

    test('tags tachypneic patient (RR > 30) as RED', () {
      final res = StartTriageEngine.evaluateStart(
        canWalk: false,
        breathing: true,
        respirationRate: 36,
      );
      expect(res['category'], equals('RED'));
    });

    test('tags patient with absent radial pulse as RED', () {
      final res = StartTriageEngine.evaluateStart(
        canWalk: false,
        breathing: true,
        respirationRate: 20,
        radialPulsePresent: false,
      );
      expect(res['category'], equals('RED'));
    });

    test('tags stable non-ambulatory patient as YELLOW', () {
      final res = StartTriageEngine.evaluateStart(
        canWalk: false,
        breathing: true,
        respirationRate: 18,
        radialPulsePresent: true,
        capillaryRefillSeconds: 1.5,
        followsSimpleCommands: true,
      );
      expect(res['category'], equals('YELLOW'));
    });
  });
}
