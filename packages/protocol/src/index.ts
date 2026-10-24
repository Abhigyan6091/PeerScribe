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
  | 'DIVERGENCE_RESOLVED';

export type TriageCategory = 'RED' | 'YELLOW' | 'GREEN' | 'BLACK' | 'UNASSESSED';

export interface PeerScribeEvent<T = any> {
  schema_version: number;
  event_id: string;
  operation_id: string;
  entity_id: string;
  event_type: PeerScribeEventType;
  actor_id: string;
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

export interface ProjectedPatientState {
  patient_id: string;
  operation_id: string;
  ephemeral_id: string;
  active_triage: TriageCategory;
  created_at_utc: string;
  updated_at_utc: string;
  vector_clock: Record<string, number>;
  vitals: any[];
  injuries: any[];
  medications: any[];
  known_allergies: string[];
  notes: any[];
  divergence_flags: any[];
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
  const validTypes = [
    'PATIENT_CREATED', 'OBSERVATION_RECORDED', 'VITALS_RECORDED', 'INJURY_RECORDED',
    'ALLERGY_RECORDED', 'TRIAGE_STATUS_CHANGED', 'MEDICATION_RECORDED', 'LOCATION_OBSERVED',
    'SOS_CREATED', 'VAULT_SNAPSHOT_ATTACHED', 'DIVERGENCE_ACKNOWLEDGED', 'DIVERGENCE_RESOLVED'
  ];
  if (!validTypes.includes(event.event_type)) {
    errors.push(`Unknown event_type: ${event.event_type}`);
  }
  if (!event.actor_id || typeof event.actor_id !== 'string') {
    errors.push('actor_id is required and must be a string');
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
    created_at_utc: creation.occurred_at_utc,
    updated_at_utc: creation.occurred_at_utc,
    vector_clock: {},
    vitals: [],
    injuries: [],
    medications: [],
    known_allergies: [],
    notes: [],
    divergence_flags: []
  };

  const triageSeverity: Record<string, number> = { RED: 4, YELLOW: 3, GREEN: 2, BLACK: 1, UNASSESSED: 0 };

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
        state.active_triage = evt.payload.triage_category || state.active_triage;
        break;
      case 'DIVERGENCE_ACKNOWLEDGED':
        state.divergence_flags.push({ flag_id: evt.payload.flag_id || evt.event_id, resolved: false, ...evt.payload });
        break;
      case 'DIVERGENCE_RESOLVED':
        state.active_triage = evt.payload.resolved_category || state.active_triage;
        state.divergence_flags.forEach(f => {
          if (f.flag_id === evt.payload.flag_id || !evt.payload.flag_id) {
            f.resolved = true;
            f.resolved_by = evt.actor_id;
            f.resolution_note = evt.payload.clinician_signoff_note;
          }
        });
        break;
    }
  }

  return state;
}
