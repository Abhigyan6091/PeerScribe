import 'dart:convert';

/// Invariant Canonical Operational Event Model for PeerScribe.
/// Guarantees binary and wire compatibility with @peerscribe/protocol schemas.
class PeerScribeEvent {
  final int schemaVersion;
  final String eventId;
  final String operationId;
  final String entityId;
  final String eventType;
  final String actorId;
  final int actorSequence;
  final int lamportTimestamp;
  final Map<String, int> causalContext;
  final String occurredAtUtc;
  final Map<String, dynamic> payload;

  const PeerScribeEvent({
    this.schemaVersion = 1,
    required this.eventId,
    required this.operationId,
    required this.entityId,
    required this.eventType,
    required this.actorId,
    required this.actorSequence,
    required this.lamportTimestamp,
    this.causalContext = const {},
    required this.occurredAtUtc,
    required this.payload,
  });

  Map<String, dynamic> toMap() {
    return {
      'schema_version': schemaVersion,
      'event_id': eventId,
      'operation_id': operationId,
      'entity_id': entityId,
      'event_type': eventType,
      'actor_id': actorId,
      'actor_sequence': actorSequence,
      'lamport_timestamp': lamportTimestamp,
      'causal_context': causalContext,
      'occurred_at_utc': occurredAtUtc,
      'payload': payload,
    };
  }

  factory PeerScribeEvent.fromMap(Map<String, dynamic> map) {
    return PeerScribeEvent(
      schemaVersion: map['schema_version'] as int? ?? 1,
      eventId: map['event_id'] as String,
      operationId: map['operation_id'] as String,
      entityId: map['entity_id'] as String,
      eventType: map['event_type'] as String,
      actorId: map['actor_id'] as String,
      actorSequence: map['actor_sequence'] as int,
      lamportTimestamp: map['lamport_timestamp'] as int,
      causalContext: map['causal_context'] != null
          ? Map<String, int>.from(map['causal_context'] as Map)
          : const {},
      occurredAtUtc: map['occurred_at_utc'] as String,
      payload: Map<String, dynamic>.from(map['payload'] as Map),
    );
  }

  String toJson() => json.encode(toMap());

  factory PeerScribeEvent.fromJson(String source) =>
      PeerScribeEvent.fromMap(json.decode(source) as Map<String, dynamic>);

  List<String> validate() {
    final errors = <String>[];
    if (schemaVersion != 1) {
      errors.add('Unsupported schema_version: $schemaVersion. Expected: 1');
    }
    if (eventId.trim().isEmpty) errors.add('event_id is required');
    if (operationId.trim().isEmpty) errors.add('operation_id is required');
    if (entityId.trim().isEmpty) errors.add('entity_id is required');
    if (eventType.trim().isEmpty) errors.add('event_type is required');
    if (actorId.trim().isEmpty) errors.add('actor_id is required');
    if (actorSequence < 1) errors.add('actor_sequence must be positive integer');
    if (lamportTimestamp < 1) errors.add('lamport_timestamp must be positive integer');
    if (occurredAtUtc.trim().isEmpty || DateTime.tryParse(occurredAtUtc) == null) {
      errors.add('occurred_at_utc must be a valid ISO-8601 string');
    }
    return errors;
  }
}
