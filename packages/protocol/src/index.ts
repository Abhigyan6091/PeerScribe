export type PeerScribeEventType =
  | 'PATIENT_CREATED'
  | 'OBSERVATION_RECORDED'
  | 'VITALS_RECORDED'
  | 'INJURY_RECORDED'
  | 'ALLERGY_RECORDED'
  | 'TRIAGE_STATUS_CHANGED'
  | 'MEDICATION_RECORDED'
  | 'LOCATION_OBSERVED'
  | 'SOS_CREATED'
  | 'VAULT_SNAPSHOT_ATTACHED'
  | 'DIVERGENCE_ACKNOWLEDGED'
  | 'DIVERGENCE_RESOLVED'
  | 'AUTHORIZATION_FAILED';

export type TriageCategory = 'RED' | 'YELLOW' | 'GREEN' | 'BLACK' | 'UNASSESSED';

export type ResponderRole = 'PARTICIPANT' | 'MEDICAL_RESPONDER' | 'COORDINATOR' | 'TRANSPORT' | 'SUPPORT';

export type Capability =
  | 'RECORD_OBSERVATION'
  | 'RECORD_VITALS'
  | 'RECORD_INJURY'
  | 'OVERRIDE_TRIAGE'
  | 'ADMINISTER_MEDICATION'
  | 'ATTACH_VAULT_SNAPSHOT'
  | 'RESOLVE_DIVERGENCE'
  | 'MANAGE_OPERATION'
  | 'DISPATCH_TRANSPORT';

export const ROLE_CAPABILITIES: Record<ResponderRole, Capability[]> = {
  PARTICIPANT: [
    'RECORD_OBSERVATION',
    'ATTACH_VAULT_SNAPSHOT'
  ],
  SUPPORT: [
    'RECORD_OBSERVATION',
    'RECORD_VITALS',
    'RECORD_INJURY',
    'ATTACH_VAULT_SNAPSHOT'
  ],
  TRANSPORT: [
    'RECORD_OBSERVATION',
    'RECORD_VITALS',
    'RECORD_INJURY',
    'ATTACH_VAULT_SNAPSHOT',
    'DISPATCH_TRANSPORT'
  ],
  MEDICAL_RESPONDER: [
    'RECORD_OBSERVATION',
    'RECORD_VITALS',
    'RECORD_INJURY',
    'ATTACH_VAULT_SNAPSHOT',
    'OVERRIDE_TRIAGE',
    'ADMINISTER_MEDICATION',
    'RESOLVE_DIVERGENCE',
    'DISPATCH_TRANSPORT'
  ],
  COORDINATOR: [
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

export const EVENT_REQUIRED_CAPABILITIES: Partial<Record<PeerScribeEventType, Capability>> = {
  OBSERVATION_RECORDED: 'RECORD_OBSERVATION',
  VITALS_RECORDED: 'RECORD_VITALS',
  INJURY_RECORDED: 'RECORD_INJURY',
  TRIAGE_STATUS_CHANGED: 'OVERRIDE_TRIAGE',
  MEDICATION_RECORDED: 'ADMINISTER_MEDICATION',
  VAULT_SNAPSHOT_ATTACHED: 'ATTACH_VAULT_SNAPSHOT',
  DIVERGENCE_RESOLVED: 'RESOLVE_DIVERGENCE'
};

export function hasCapability(role: ResponderRole, capability: Capability): boolean {
  const caps = ROLE_CAPABILITIES[role];
  return Array.isArray(caps) && caps.includes(capability);
}

export function canPerformEvent(role: ResponderRole, eventType: PeerScribeEventType): boolean {
  const required = EVENT_REQUIRED_CAPABILITIES[eventType];
  if (!required) return true; // Events like PATIENT_CREATED, SOS_CREATED, DIVERGENCE_ACKNOWLEDGED permitted
  return hasCapability(role, required);
}

export interface PeerScribeEvent<T = any> {
  schema_version: number;
  event_id: string;
  operation_id: string;
  entity_id: string;
  event_type: PeerScribeEventType;
  actor_id: string;
  actor_role?: ResponderRole;
  actor_sequence: number;
  lamport_timestamp: number;
  causal_context?: Record<string, number>;
  occurred_at_utc: string;
  payload: T;
}

export interface PeerScribeSyncBundle {
  schema_version: number;
  bundle_id: string;
  operation_id: string;
  origin_node_id: string;
  priority: 'CRITICAL_SOS' | 'CLINICAL_DELTA' | 'ROUTINE';
  hop_count: number;
  max_hops: number;
  created_at_utc: string;
  vector_clock: Record<string, number>;
  events: PeerScribeEvent[];
  bloom_filter_hex?: string;
}

export type DivergenceState = 'NONE' | 'DETECTED' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface ProjectedPatientState {
  patient_id: string;
  operation_id: string;
  ephemeral_id: string;
  active_triage: TriageCategory;
  triage_display_label: string;
  divergence_state: DivergenceState;
  divergent_categories: TriageCategory[];
  created_at_utc: string;
  updated_at_utc: string;
  vector_clock: Record<string, number>;
  triage_history: any[];
  vitals: any[];
  injuries: any[];
  medications: any[];
  known_allergies: string[];
  notes: any[];
  divergence_flags: any[];
  authorization_failures?: any[];
}

/**
 * Validates a PeerScribeEvent against invariant protocol contracts.
 */
export function validateEvent(event: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!event || typeof event !== 'object') {
    return { valid: false, errors: ['Event must be a non-null object'] };
  }
  if (event.schema_version !== 1) {
    errors.push(`Unsupported schema_version: ${event.schema_version}. Expected: 1`);
  }
  if (!event.event_id || typeof event.event_id !== 'string') {
    errors.push('event_id is required and must be a string');
  }
  if (!event.operation_id || typeof event.operation_id !== 'string') {
    errors.push('operation_id is required and must be a string');
  }
  if (!event.entity_id || typeof event.entity_id !== 'string') {
    errors.push('entity_id is required and must be a string');
  }
  const validTypes: PeerScribeEventType[] = [
    'PATIENT_CREATED', 'OBSERVATION_RECORDED', 'VITALS_RECORDED', 'INJURY_RECORDED',
    'ALLERGY_RECORDED', 'TRIAGE_STATUS_CHANGED', 'MEDICATION_RECORDED', 'LOCATION_OBSERVED',
    'SOS_CREATED', 'VAULT_SNAPSHOT_ATTACHED', 'DIVERGENCE_ACKNOWLEDGED', 'DIVERGENCE_RESOLVED',
    'AUTHORIZATION_FAILED'
  ];
  if (!validTypes.includes(event.event_type)) {
    errors.push(`Unknown event_type: ${event.event_type}`);
  }
  if (!event.actor_id || typeof event.actor_id !== 'string') {
    errors.push('actor_id is required and must be a string');
  }

  // Role validation if actor_role provided
  if (event.actor_role) {
    const validRoles: ResponderRole[] = ['PARTICIPANT', 'MEDICAL_RESPONDER', 'COORDINATOR', 'TRANSPORT', 'SUPPORT'];
    if (!validRoles.includes(event.actor_role)) {
      errors.push(`Invalid actor_role: ${event.actor_role}`);
    } else if (!canPerformEvent(event.actor_role, event.event_type)) {
      errors.push(`Role ${event.actor_role} lacks authorization for event ${event.event_type}`);
    }
  }

  if (typeof event.actor_sequence !== 'number' || event.actor_sequence < 1) {
    errors.push('actor_sequence must be a positive integer');
  }
  if (typeof event.lamport_timestamp !== 'number' || event.lamport_timestamp < 1) {
    errors.push('lamport_timestamp must be a positive integer');
  }
  if (!event.occurred_at_utc || isNaN(Date.parse(event.occurred_at_utc))) {
    errors.push('occurred_at_utc must be a valid ISO-8601 date-time string');
  }
  if (!event.payload || typeof event.payload !== 'object') {
    errors.push('payload must be an object');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validates a PeerScribeSyncBundle before ingestion.
 */
export function validateSyncBundle(bundle: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!bundle || typeof bundle !== 'object') {
    return { valid: false, errors: ['SyncBundle must be an object'] };
  }
  if (bundle.schema_version !== 1) {
    errors.push(`Unsupported schema_version: ${bundle.schema_version}`);
  }
  if (!bundle.bundle_id || typeof bundle.bundle_id !== 'string') {
    errors.push('bundle_id is required');
  }
  if (!Array.isArray(bundle.events)) {
    errors.push('events must be an array');
  } else {
    bundle.events.forEach((evt: any, idx: number) => {
      const v = validateEvent(evt);
      if (!v.valid) {
        errors.push(`Event at index ${idx} invalid: ${v.errors.join('; ')}`);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Deterministically projects patient state from an append-only stream of immutable events.
 */
export function projectPatientState(events: PeerScribeEvent[]): ProjectedPatientState | null {
  if (!events || events.length === 0) return null;

  // Sort events deterministically: Lamport clock ASC -> actor_id ASC -> event_id ASC
  const sorted = [...events].sort((a, b) => {
    if (a.lamport_timestamp !== b.lamport_timestamp) {
      return a.lamport_timestamp - b.lamport_timestamp;
    }
    if (a.actor_id !== b.actor_id) {
      return a.actor_id.localeCompare(b.actor_id);
    }
    return a.event_id.localeCompare(b.event_id);
  });

  const creation = sorted.find(e => e.event_type === 'PATIENT_CREATED');
  if (!creation) return null;

  const state: ProjectedPatientState = {
    patient_id: creation.entity_id,
    operation_id: creation.operation_id,
    ephemeral_id: creation.payload.ephemeral_id || 'UNKNOWN-00',
    active_triage: 'UNASSESSED',
    triage_display_label: 'UNASSESSED',
    divergence_state: 'NONE',
    divergent_categories: [],
    created_at_utc: creation.occurred_at_utc,
    updated_at_utc: creation.occurred_at_utc,
    vector_clock: {},
    triage_history: [],
    vitals: [],
    injuries: [],
    medications: [],
    known_allergies: [],
    notes: [],
    divergence_flags: [],
    authorization_failures: []
  };

  let resolvedCategory: TriageCategory | null = null;
  let hasResolvedEvent = false;
  let hasAcknowledgedEvent = false;

  for (const evt of sorted) {
    state.updated_at_utc = evt.occurred_at_utc;
    state.vector_clock[evt.actor_id] = Math.max(state.vector_clock[evt.actor_id] || 0, evt.actor_sequence);

    switch (evt.event_type) {
      case 'VITALS_RECORDED':
        state.vitals.push({ event_id: evt.event_id, timestamp: evt.occurred_at_utc, ...evt.payload });
        break;
      case 'INJURY_RECORDED':
        state.injuries.push({ event_id: evt.event_id, timestamp: evt.occurred_at_utc, ...evt.payload });
        break;
      case 'MEDICATION_RECORDED':
        state.medications.push({ event_id: evt.event_id, timestamp: evt.occurred_at_utc, ...evt.payload });
        break;
      case 'ALLERGY_RECORDED':
        if (evt.payload.allergy && !state.known_allergies.includes(evt.payload.allergy)) {
          state.known_allergies.push(evt.payload.allergy);
        }
        break;
      case 'OBSERVATION_RECORDED':
        state.notes.push({ event_id: evt.event_id, timestamp: evt.occurred_at_utc, text: evt.payload.text || '' });
        break;
      case 'VAULT_SNAPSHOT_ATTACHED':
        if (Array.isArray(evt.payload.allergies)) {
          evt.payload.allergies.forEach((a: string) => {
            if (!state.known_allergies.includes(a)) state.known_allergies.push(a);
          });
        }
        state.notes.push({
          event_id: evt.event_id,
          timestamp: evt.occurred_at_utc,
          text: `[EMERGENCY ID] Blood: ${evt.payload.blood_group || 'UNKNOWN'} | Allergies: ${(evt.payload.allergies || []).join(', ')}`
        });
        break;
      case 'TRIAGE_STATUS_CHANGED':
        state.triage_history.push({
          event_id: evt.event_id,
          actor_id: evt.actor_id,
          actor_role: evt.actor_role,
          category: evt.payload.triage_category,
          lamport_timestamp: evt.lamport_timestamp,
          occurred_at_utc: evt.occurred_at_utc
        });
        break;
      case 'DIVERGENCE_ACKNOWLEDGED':
        hasAcknowledgedEvent = true;
        state.divergence_flags.push({ flag_id: evt.payload.flag_id || evt.event_id, resolved: false, ...evt.payload });
        break;
      case 'DIVERGENCE_RESOLVED':
        hasResolvedEvent = true;
        resolvedCategory = evt.payload.resolved_category;
        state.divergence_flags.forEach(f => {
          if (f.flag_id === evt.payload.flag_id || !evt.payload.flag_id) {
            f.resolved = true;
            f.resolved_by = evt.actor_id;
            f.resolution_note = evt.payload.clinician_signoff_note;
          }
        });
        break;
      case 'AUTHORIZATION_FAILED':
        state.authorization_failures?.push({
          event_id: evt.event_id,
          timestamp: evt.occurred_at_utc,
          actor_id: evt.actor_id,
          attempted_action: evt.payload.attempted_action,
          role: evt.actor_role,
          reason: evt.payload.reason
        });
        break;
    }
  }

  // Evaluate Clinical Triage and Divergence State Machine
  const distinctTriageCategories = Array.from(new Set(state.triage_history.map(t => t.category).filter(Boolean)));

  if (hasResolvedEvent && resolvedCategory) {
    state.divergence_state = 'RESOLVED';
    state.active_triage = resolvedCategory;
    state.triage_display_label = resolvedCategory;
  } else if (distinctTriageCategories.length > 1) {
    // Concurrent un-reconciled triage assessments detected
    state.divergence_state = hasAcknowledgedEvent ? 'ACKNOWLEDGED' : 'DETECTED';
    state.divergent_categories = distinctTriageCategories as TriageCategory[];
    state.triage_display_label = `UNRESOLVED DIVERGENCE (${distinctTriageCategories.join(' vs ')})`;
    // UI policy: Do NOT finalize to an arbitrary single category when unresolved
    state.active_triage = 'UNASSESSED';
  } else if (distinctTriageCategories.length === 1) {
    state.divergence_state = 'NONE';
    state.active_triage = distinctTriageCategories[0] as TriageCategory;
    state.triage_display_label = state.active_triage;
  }

  return state;
}
