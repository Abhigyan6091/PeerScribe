import 'dart:async';
import 'package:uuid/uuid.dart';
import '../protocol/event_model.dart';
import '../protocol/sync_bundle.dart';
import '../storage/database_helper.dart';
import '../clinical/patient_projection.dart';
import 'semantic_safety_analyzer.dart';

/// Explicit structured result returned from bundle ingestion.
class IngestResult {
  final String status;
  final List<String> acceptedEventIds;
  final List<String> duplicateEventIds;
  final List<Map<String, dynamic>> rejectedEvents;
  final int divergencesFlagged;
  final String timestamp;

  const IngestResult({
    required this.status,
    required this.acceptedEventIds,
    required this.duplicateEventIds,
    required this.rejectedEvents,
    required this.divergencesFlagged,
    required this.timestamp,
  });

  int get insertedCount => acceptedEventIds.length;
  int get duplicateCount => duplicateEventIds.length;

  Map<String, dynamic> toMap() => {
    'status': status,
    'inserted_events': acceptedEventIds.length,
    'duplicate_events': duplicateEventIds.length,
    'divergences_flagged': divergencesFlagged,
    'accepted_event_ids': acceptedEventIds,
    'duplicate_event_ids': duplicateEventIds,
    'rejected_events': rejectedEvents,
    'timestamp': timestamp,
  };

  dynamic operator [](String key) => toMap()[key];
}

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
  /// and persists valid new events with durable verification.
  Future<IngestResult> ingestBundle(PeerScribeSyncBundle bundle) async {
    final acceptedEventIds = <String>[];
    final duplicateEventIds = <String>[];
    final rejectedEvents = <Map<String, dynamic>>[];
    final List<SemanticDivergence> flaggedDivergences = [];

    final allLocalEvents = await _db.getAllEvents();

    for (final incomingEvent in bundle.events) {
      // 1. Complete shared event validation
      final validationErrors = incomingEvent.validate();
      if (validationErrors.isNotEmpty) {
        rejectedEvents.add({
          'event_id': incomingEvent.eventId.isNotEmpty ? incomingEvent.eventId : 'unknown',
          'reason': 'Schema validation failed: ${validationErrors.join("; ")}',
          'rejected_at_utc': DateTime.now().toUtc().toIso8601String(),
        });
        continue;
      }

      // 2. Check if already durable in local database
      final existingDurable = await _db.getEventById(incomingEvent.eventId);
      if (existingDurable != null) {
        duplicateEventIds.add(incomingEvent.eventId);
        continue;
      }

      // 3. Check for semantic divergence against existing patient projection
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
          try {
            await _db.insertEvent(divEvent);
          } catch (_) {}
        }
      }

      // 4. Insertion with durable verification check
      bool inserted = false;
      try {
        inserted = await _db.insertEvent(incomingEvent);
      } catch (dbErr) {
        rejectedEvents.add({
          'event_id': incomingEvent.eventId,
          'reason': 'Database transaction error: $dbErr',
          'rejected_at_utc': DateTime.now().toUtc().toIso8601String(),
        });
        continue;
      }

      if (inserted) {
        // Verify that event is actually durably stored before accepting
        final verified = await _db.getEventById(incomingEvent.eventId);
        if (verified != null) {
          acceptedEventIds.add(incomingEvent.eventId);
          allLocalEvents.add(incomingEvent);
        } else {
          rejectedEvents.add({
            'event_id': incomingEvent.eventId,
            'reason': 'Database insertion succeeded but durable verification query returned null',
            'rejected_at_utc': DateTime.now().toUtc().toIso8601String(),
          });
        }
      } else {
        // Insertion returned false (idempotent rejection). Verify durable copy exists!
        final verifiedDup = await _db.getEventById(incomingEvent.eventId);
        if (verifiedDup != null) {
          duplicateEventIds.add(incomingEvent.eventId);
        } else {
          rejectedEvents.add({
            'event_id': incomingEvent.eventId,
            'reason': 'Database insertion failed without durable copy present',
            'rejected_at_utc': DateTime.now().toUtc().toIso8601String(),
          });
        }
      }
    }

    _lastSyncTimestamp = DateTime.now().toUtc().toIso8601String();
    _syncStatusController.add({
      'last_sync': _lastSyncTimestamp,
      'inserted': acceptedEventIds.length,
      'duplicates': duplicateEventIds.length,
      'divergences': flaggedDivergences.length,
    });

    return IngestResult(
      status: 'SUCCESS',
      acceptedEventIds: acceptedEventIds,
      duplicateEventIds: duplicateEventIds,
      rejectedEvents: rejectedEvents,
      divergencesFlagged: flaggedDivergences.length,
      timestamp: _lastSyncTimestamp!,
    );
  }

  void updatePeerCount(int count) {
    _connectedPeersCount = count;
  }
}
