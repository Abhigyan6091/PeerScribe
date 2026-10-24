import 'package:flutter_test/flutter_test.dart';
import 'package:peerscribe_mobile/core/sync/delta_update_manager.dart';

void main() {
  group('PeerScribe Mobile Delta Updates Tests', () {
    test('verifies initial version baseline is v1.0 (1.0.0)', () {
      expect(DeltaUpdateManager.currentVersion, equals('1.0.0'));
    });

    test('correctly evaluates semantic delta version ordering', () {
      expect(DeltaUpdateManager.isNewerVersion('1.0.0', '1.0.1'), isTrue);
      expect(DeltaUpdateManager.isNewerVersion('1.0.0', '1.1.0'), isTrue);
      expect(DeltaUpdateManager.isNewerVersion('1.0.0', '2.0.0'), isTrue);
      expect(DeltaUpdateManager.isNewerVersion('1.0.0', '1.0.0'), isFalse);
      expect(DeltaUpdateManager.isNewerVersion('1.1.0', '1.0.9'), isFalse);
    });

    test('checks for delta updates across local mesh peer', () async {
      final manager = DeltaUpdateManager();
      final update = await manager.checkForUpdates(meshPeerAddress: '192.168.1.45:4321');

      expect(update.currentVersion, equals('1.0.0'));
      expect(update.isDifferentialMeshUpdate, isTrue);
    });
  });
}
