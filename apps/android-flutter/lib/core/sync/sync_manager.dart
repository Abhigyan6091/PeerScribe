import 'dart:async';
import 'dart:convert';
import 'package:uuid/uuid.dart';
import '../protocol/event_model.dart';
import '../protocol/sync_bundle.dart';
import '../storage/database_helper.dart';
import '../clinical/patient_projection.dart';
import 'semantic_safety_analyzer.dart';

class SyncManager {
  static final SyncManager _instance = SyncManager._internal();
  factory SyncManager() => _instance;
  SyncManager._internal();

  final DatabaseHelper _db = DatabaseHelper();
  final _uuid = const Uuid();

  final _syncStatusController = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get syncStatusStream => _syncStatusController.stream;

  final _divergenceController = StreamController<SemanticDivergence>.broadcast();
  Stream<SemanticDivergence> get divergenceStream => _divergenceController.stream;

  String? _lastSyncTimestamp;
  int _connectedPeersCount = 0;

  String? get lastSyncTimestamp => _lastSyncTimestamp;
  int get connectedPeersCount => _connectedPeersCount;

  /// Creates a local outbox bundle to transmit to connected peers.
  Future<PeerScribeSyncBundle> createOutboxBundle({required String localNodeId}) async {
    final outbox = await _db.getOutbox();
    final op = await _db.getActiveOperation();

    final vectorClock = <String, int>{};
    for (final e in outbox) {
      final cur = vectorClock[e.actorId] ?? 0;
      if (e.actorSequence > cur) vectorClock[e.actorId] = e.actorSequence;
    }

    return PeerScribeSyncBundle(
      bundleId: 'bundle_${_uuid.v4()}',
      operationId: op['operation_id'] as String? ?? 'OP_TACTICAL',
      originNodeId: localNodeId,
      priority: outbox.any((e) => e.eventType == 'SOS_CREATED') ? 'CRITICAL_SOS' : 'CLINICAL_DELTA',
      createdAtUtc: DateTime.now().toUtc().toIso8601String(),
      vectorClock: vectorClock,
      events: outbox,
    );
  }

  /// Ingests an incoming sync bundle from a LAN peer or gateway.
  /// Suppresses duplicates, validates schema, checks for safety divergence,
  /// and persists valid new events.
  Future<Map<String, dynamic>> ingestBundle(PeerScribeSyncBundle bundle) async {
    int insertedCount = 0;
    int duplicateCount = 0;
    final List<SemanticDivergence> flaggedDivergences = [];

    final allLocalEvents = await _db.getAllEvents();

    for (final incomingEvent in bundle.events) {
      final validationErrors = incomingEvent.validate();
      if (validationErrors.isNotEmpty) {
        continue; // Discard invalid event
      }

      // Check for semantic divergence against existing patient projection
      final patientEvents = allLocalEvents.where((e) => e.entityId == incomingEvent.entityId).toList();
      final currentPatient = ProjectedPatient.project(patientEvents);

      if (currentPatient != null) {
        final divergence = SemanticSafetyAnalyzer.analyze(
          currentPatient: currentPatient,
          incomingEvent: incomingEvent,
        );
        if (divergence != null) {
          flaggedDivergences.add(divergence);
          _divergenceController.add(divergence);

          // Append DIVERGENCE_ACKNOWLEDGED event so the conflict is prominently preserved
          final divEvent = PeerScribeEvent(
            eventId: 'div_${_uuid.v4()}',
            operationId: incomingEvent.operationId,
            entityId: incomingEvent.entityId,
            eventType: 'DIVERGENCE_ACKNOWLEDGED',
            actorId: 'node_mobile_flutter',
            actorSequence: allLocalEvents.length + 1,
            lamportTimestamp: incomingEvent.lamportTimestamp + 1,
            occurredAtUtc: DateTime.now().toUtc().toIso8601String(),
            payload: {
              'conflict_type': divergence.conflictType,
              'severity': divergence.severity,
              'reason': divergence.description,
              'metadata': divergence.metadata,
            },
          );
          await _db.insertEvent(divEvent);
        }
      }

      // Idempotent insertion
      final inserted = await _db.insertEvent(incomingEvent);
      if (inserted) {
        insertedCount++;
      } else {
        duplicateCount++;
      }
    }

    _lastSyncTimestamp = DateTime.now().toUtc().toIso8601String();
    _syncStatusController.add({
      'last_sync': _lastSyncTimestamp,
      'inserted': insertedCount,
      'duplicates': duplicateCount,
      'divergences': flaggedDivergences.length,
    });

    return {
      'status': 'SUCCESS',
      'inserted_events': insertedCount,
      'duplicate_events': duplicateCount,
      'divergences_flagged': flaggedDivergences.length,
      'timestamp': _lastSyncTimestamp,
    };
  }

  void updatePeerCount(int count) {
    _connectedPeersCount = count;
  }
}
