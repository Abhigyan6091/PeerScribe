import 'dart:convert';
import 'event_model.dart';

/// SyncBundle exchanged between mesh peers over LAN WebSocket or DTN Outbox.
class PeerScribeSyncBundle {
  final int schemaVersion;
  final String bundleId;
  final String operationId;
  final String originNodeId;
  final String priority;
  final int hopCount;
  final int maxHops;
  final String createdAtUtc;
  final Map<String, int> vectorClock;
  final List<PeerScribeEvent> events;

  const PeerScribeSyncBundle({
    this.schemaVersion = 1,
    required this.bundleId,
    required this.operationId,
    required this.originNodeId,
    this.priority = 'CLINICAL_DELTA',
    this.hopCount = 0,
    this.maxHops = 15,
    required this.createdAtUtc,
    required this.vectorClock,
    required this.events,
  });

  Map<String, dynamic> toMap() {
    return {
      'schema_version': schemaVersion,
      'bundle_id': bundleId,
      'operation_id': operationId,
      'origin_node_id': originNodeId,
      'priority': priority,
      'hop_count': hopCount,
      'max_hops': maxHops,
      'created_at_utc': createdAtUtc,
      'vector_clock': vectorClock,
      'events': events.map((x) => x.toMap()).toList(),
    };
  }

  factory PeerScribeSyncBundle.fromMap(Map<String, dynamic> map) {
    return PeerScribeSyncBundle(
      schemaVersion: map['schema_version'] as int? ?? 1,
      bundleId: map['bundle_id'] as String,
      operationId: map['operation_id'] as String,
      originNodeId: map['origin_node_id'] as String,
      priority: map['priority'] as String? ?? 'CLINICAL_DELTA',
      hopCount: map['hop_count'] as int? ?? 0,
      maxHops: map['max_hops'] as int? ?? 15,
      createdAtUtc: map['created_at_utc'] as String,
      vectorClock: Map<String, int>.from(map['vector_clock'] as Map),
      events: (map['events'] as List)
          .map((e) => PeerScribeEvent.fromMap(e as Map<String, dynamic>))
          .toList(),
    );
  }

  String toJson() => json.encode(toMap());

  factory PeerScribeSyncBundle.fromJson(String source) =>
      PeerScribeSyncBundle.fromMap(json.decode(source) as Map<String, dynamic>);
}
