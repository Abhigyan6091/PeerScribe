import 'dart:convert';

enum ResponderRole {
  participant,
  medicalResponder,
  coordinator,
  transport,
  support
}

const Map<String, List<String>> roleCapabilities = {
  'PARTICIPANT': [
    'RECORD_OBSERVATION',
    'ATTACH_VAULT_SNAPSHOT'
  ],
  'SUPPORT': [
    'RECORD_OBSERVATION',
    'RECORD_VITALS',
    'RECORD_INJURY',
    'ATTACH_VAULT_SNAPSHOT'
  ],
  'TRANSPORT': [
    'RECORD_OBSERVATION',
    'RECORD_VITALS',
    'RECORD_INJURY',
    'ATTACH_VAULT_SNAPSHOT',
    'DISPATCH_TRANSPORT'
  ],
  'MEDICAL_RESPONDER': [
    'RECORD_OBSERVATION',
    'RECORD_VITALS',
    'RECORD_INJURY',
    'ATTACH_VAULT_SNAPSHOT',
    'OVERRIDE_TRIAGE',
    'ADMINISTER_MEDICATION',
    'RESOLVE_DIVERGENCE',
    'DISPATCH_TRANSPORT'
  ],
  'COORDINATOR': [
    'RECORD_OBSERVATION',
    'RECORD_VITALS',
    'RECORD_INJURY',
    'ATTACH_VAULT_SNAPSHOT',
    'OVERRIDE_TRIAGE',
    'ADMINISTER_MEDICATION',
    'RESOLVE_DIVERGENCE',
    'MANAGE_OPERATION',
    'DISPATCH_TRANSPORT'
  ]
};

const Map<String, String> eventRequiredCapabilities = {
  'OBSERVATION_RECORDED': 'RECORD_OBSERVATION',
  'VITALS_RECORDED': 'RECORD_VITALS',
  'INJURY_RECORDED': 'RECORD_INJURY',
  'TRIAGE_STATUS_CHANGED': 'OVERRIDE_TRIAGE',
  'MEDICATION_RECORDED': 'ADMINISTER_MEDICATION',
  'VAULT_SNAPSHOT_ATTACHED': 'ATTACH_VAULT_SNAPSHOT',
  'DIVERGENCE_RESOLVED': 'RESOLVE_DIVERGENCE'
};

bool roleHasCapability(String role, String capability) {
  final caps = roleCapabilities[role.toUpperCase()];
  return caps != null && caps.contains(capability);
}

bool canRolePerformEvent(String role, String eventType) {
  final req = eventRequiredCapabilities[eventType];
  if (req == null) return true;
  return roleHasCapability(role, req);
}

/// Invariant Canonical Operational Event Model for PeerScribe.
/// Guarantees binary and wire compatibility with @peerscribe/protocol schemas.
class PeerScribeEvent {
  final int schemaVersion;
  final String eventId;
  final String operationId;
  final String entityId;
  final String eventType;
  final String actorId;
  final String? actorRole;
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
    this.actorRole,
    required this.actorSequence,
    required this.lamportTimestamp,
    this.causalContext = const {},
    required this.occurredAtUtc,
    required this.payload,
  });

  Map<String, dynamic> toMap() {
    final map = <String, dynamic>{
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
    if (actorRole != null) {
      map['actor_role'] = actorRole;
    }
    return map;
  }

  factory PeerScribeEvent.fromMap(Map<String, dynamic> map) {
    return PeerScribeEvent(
      schemaVersion: map['schema_version'] as int? ?? 1,
      eventId: map['event_id'] as String,
      operationId: map['operation_id'] as String,
      entityId: map['entity_id'] as String,
      eventType: map['event_type'] as String,
      actorId: map['actor_id'] as String,
      actorRole: map['actor_role'] as String?,
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
    if (eventId.isEmpty) errors.add('event_id is required');
    if (operationId.isEmpty) errors.add('operation_id is required');
    if (entityId.isEmpty) errors.add('entity_id is required');
    if (actorId.isEmpty) errors.add('actor_id is required');
    if (actorRole != null) {
      final validRoles = ['PARTICIPANT', 'MEDICAL_RESPONDER', 'COORDINATOR', 'TRANSPORT', 'SUPPORT'];
      if (!validRoles.contains(actorRole!.toUpperCase())) {
        errors.add('Invalid actor_role: $actorRole');
      } else if (!canRolePerformEvent(actorRole!, eventType)) {
        errors.add('Role $actorRole lacks authorization for event $eventType');
      }
    }
    if (actorSequence < 1) errors.add('actor_sequence must be positive integer');
    if (lamportTimestamp < 1) errors.add('lamport_timestamp must be positive integer');
    if (DateTime.tryParse(occurredAtUtc) == null) {
      errors.add('occurred_at_utc must be a valid ISO-8601 string');
    }
    return errors;
  }
}
