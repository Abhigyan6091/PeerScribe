const fs = require('fs');
const path = require('path');

/**
 * Crash-Consistent Tactical Persistence Store for PeerScribe Desktop.
 * - Append-only immutable event log (events.jsonl)
 * - Atomic write-ahead journal for outbox state machine (outbox_state.json)
 * - Explicit state transitions: ACCEPTED -> DURABLY_STORED -> OUTBOX_QUEUED -> ACKNOWLEDGED
 * - Automatic crash recovery and outbox repair on startup
 * - Duplicate ingestion outbox reconciliation (repairs missing forwarding entries)
 * - Atomic file replacement preventing partial/corrupt writes across sudden termination
 */
class TacticalStorageEngine {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.eventsFile = path.join(this.dataDir, 'immutable_events.jsonl');
    this.outboxFile = path.join(this.dataDir, 'outbox_state.json');

    this.eventsLog = [];
    this.outboxQueue = [];
    this.acknowledgedIds = new Set();

    // Fault injection hooks for crash consistency verification
    this._injectFailAfterEventAppend = false;
    this._injectFailDuringOutboxWrite = false;

    this.recoverState();
  }

  /**
   * Reads state from disk and reconciles any crash inconsistencies.
   */
  recoverState() {
    this.eventsLog = [];
    this.outboxQueue = [];
    this.acknowledgedIds = new Set();

    // 1. Recover immutable events log
    if (fs.existsSync(this.eventsFile)) {
      const content = fs.readFileSync(this.eventsFile, 'utf8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      for (const line of lines) {
        try {
          const evt = JSON.parse(line);
          if (evt && evt.event_id) {
            this.eventsLog.push(evt);
          }
        } catch (_) {
          // Truncated line due to crash during write: safely skip corrupted tail
        }
      }
    }

    // 2. Recover outbox state
    let loadedOutbox = [];
    if (fs.existsSync(this.outboxFile)) {
      try {
        const stateObj = JSON.parse(fs.readFileSync(this.outboxFile, 'utf8'));
        if (Array.isArray(stateObj.outbox)) {
          loadedOutbox = stateObj.outbox;
        }
        if (Array.isArray(stateObj.acknowledged)) {
          for (const id of stateObj.acknowledged) {
            this.acknowledgedIds.add(id);
          }
        }
      } catch (_) {
        // Corrupted outbox file from power loss: will be reconstructed from eventsLog below
      }
    }

    // 3. RECONCILIATION INVARIANT:
    // Every accepted event in eventsLog must have an outbox state.
    // If an event was durably persisted in eventsLog but is NOT marked as acknowledged
    // and is missing from loadedOutbox (e.g. process crashed before outbox write),
    // repair and restore it to outboxQueue so it is never dropped from store-and-forward!
    const outboxMap = new Map(loadedOutbox.map(e => [e.event_id, e]));
    for (const evt of this.eventsLog) {
      if (this.acknowledgedIds.has(evt.event_id)) {
        continue; // Successfully acknowledged by downstream peers
      }
      if (!outboxMap.has(evt.event_id)) {
        // Restored missing outbox entry lost in crash
        outboxMap.set(evt.event_id, evt);
      }
    }

    this.outboxQueue = Array.from(outboxMap.values());
    this._persistOutboxStateAtomic();
  }

  /**
   * Atomically writes the outbox state machine to disk using write-to-temp + rename.
   */
  _persistOutboxStateAtomic() {
    if (this._injectFailDuringOutboxWrite) {
      throw new Error('Injected persistence fault during atomic outbox write');
    }

    const tmpFile = `${this.outboxFile}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const payload = JSON.stringify({
      version: 1,
      updated_at_utc: new Date().toISOString(),
      outbox: this.outboxQueue,
      acknowledged: Array.from(this.acknowledgedIds)
    }, null, 2);

    fs.writeFileSync(tmpFile, payload, 'utf8');
    fs.renameSync(tmpFile, this.outboxFile);
  }

  /**
   * Persists a new accepted event durably and enqueues it into the store-and-forward outbox.
   */
  persistEvent(event) {
    if (!event || !event.event_id) {
      throw new Error('Cannot persist event without valid event_id');
    }

    // 1. Durable write to append-only log
    fs.appendFileSync(this.eventsFile, JSON.stringify(event) + '\n', 'utf8');
    this.eventsLog.push(event);

    if (this._injectFailAfterEventAppend) {
      throw new Error('Injected crash fault immediately after event append');
    }

    // 2. Outbox state transition
    if (!this.outboxQueue.some(e => e.event_id === event.event_id) && !this.acknowledgedIds.has(event.event_id)) {
      this.outboxQueue.push(event);
      this._persistOutboxStateAtomic();
    }
  }

  /**
   * Ingests a duplicate event: Verifies durable copy and repairs outbox if missing.
   */
  repairDuplicateOutboxState(eventId) {
    const isDurable = this.eventsLog.some(e => e.event_id === eventId);
    if (!isDurable) return false;

    // If duplicate was previously accepted but is missing from outbox and not yet acknowledged, repair it
    if (!this.acknowledgedIds.has(eventId) && !this.outboxQueue.some(e => e.event_id === eventId)) {
      const original = this.eventsLog.find(e => e.event_id === eventId);
      if (original) {
        this.outboxQueue.push(original);
        this._persistOutboxStateAtomic();
      }
    }
    return true;
  }

  /**
   * Acknowledges forwarded events, removing them from outbox and marking them acknowledged.
   */
  acknowledgeEvents(eventIds) {
    if (!Array.isArray(eventIds) || eventIds.length === 0) return 0;

    let modified = false;
    for (const id of eventIds) {
      this.acknowledgedIds.add(id);
    }

    const initialLen = this.outboxQueue.length;
    this.outboxQueue = this.outboxQueue.filter(e => !eventIds.includes(e.event_id));
    if (this.outboxQueue.length !== initialLen) {
      modified = true;
    }

    if (modified) {
      this._persistOutboxStateAtomic();
    }
    return initialLen - this.outboxQueue.length;
  }

  /**
   * Operational wipe: Zeroizes operational events and outbox, strictly leaving vault files untouched.
   */
  wipeOperationalData() {
    this.eventsLog = [];
    this.outboxQueue = [];
    this.acknowledgedIds.clear();

    if (fs.existsSync(this.eventsFile)) {
      fs.unlinkSync(this.eventsFile);
    }
    if (fs.existsSync(this.outboxFile)) {
      fs.unlinkSync(this.outboxFile);
    }
  }

  getState() {
    return {
      eventsLog: this.eventsLog,
      outboxQueue: this.outboxQueue,
      acknowledgedCount: this.acknowledgedIds.size
    };
  }
}

module.exports = {
  TacticalStorageEngine
};
