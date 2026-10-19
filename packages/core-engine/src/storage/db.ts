import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { type CrdtPatientDocument, type CrdtDelta } from '../crdt/crdt_doc.ts';
import { type QueuedBundle, BundlePriority } from '../network/dtn_outbox.ts';

export interface DatabaseConfig {
  dbPath?: string; // If undefined or ':memory:', uses in-memory DB
  walMode?: boolean;
}

/**
 * PeerScribe Local Relational Storage Engine (SQLite WAL mode).
 * Stores durable relational indexes, incident state, and DTN store-and-forward queues.
 */
export class PeerScribeDatabase {
  public readonly db: DatabaseSync;

  constructor(config: DatabaseConfig = {}) {
    const targetPath = config.dbPath || ':memory:';
    if (targetPath !== ':memory:') {
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(targetPath);

    // Apply high-concurrency disaster durability pragmas
    if (targetPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }
    this.db.exec('PRAGMA foreign_keys = ON;');

    this.runMigrations();
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sector_geohash TEXT,
        status TEXT DEFAULT 'ACTIVE',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS patient_documents (
        patient_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        ephemeral_id TEXT NOT NULL,
        crdt_json TEXT NOT NULL,
        active_triage TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_patients_op_triage 
        ON patient_documents(operation_id, active_triage);

      CREATE TABLE IF NOT EXISTS dtn_outbox (
        bundle_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        priority INTEGER NOT NULL,
        hop_count INTEGER NOT NULL,
        max_hops INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        ttl_ms INTEGER NOT NULL,
        payload_base64 TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dtn_priority 
        ON dtn_outbox(priority DESC, created_at ASC);

      CREATE TABLE IF NOT EXISTS peer_registry (
        peer_id TEXT PRIMARY KEY,
        public_key_hex TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        rssi INTEGER,
        bloom_filter_base64 TEXT
      );

      CREATE TABLE IF NOT EXISTS clinical_audit_trail (
        entry_id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        node_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        details_json TEXT NOT NULL
      );
    `);
  }

  // --- Operations ---
  createOperation(opId: string, name: string, sectorGeohash?: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO operations (operation_id, name, sector_geohash, status, created_at)
      VALUES (?, ?, ?, 'ACTIVE', ?)
    `);
    stmt.run(opId, name, sectorGeohash || null, Date.now());
  }

  // --- Patients & CRDT Documents ---
  savePatientDocument(doc: CrdtPatientDocument, activeTriage: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO patient_documents (patient_id, operation_id, ephemeral_id, crdt_json, active_triage, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(patient_id) DO UPDATE SET
        crdt_json = excluded.crdt_json,
        active_triage = excluded.active_triage,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      doc.patientId,
      doc.operationId,
      doc.ephemeralId,
      JSON.stringify(doc),
      activeTriage,
      Date.now()
    );
  }

  getPatientDocument(patientId: string): CrdtPatientDocument | null {
    const stmt = this.db.prepare(`
      SELECT crdt_json FROM patient_documents WHERE patient_id = ?
    `);
    const row = stmt.get(patientId) as { crdt_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.crdt_json) as CrdtPatientDocument;
  }

  listPatientDocuments(operationId: string): { doc: CrdtPatientDocument; activeTriage: string }[] {
    const stmt = this.db.prepare(`
      SELECT crdt_json, active_triage FROM patient_documents 
      WHERE operation_id = ? 
      ORDER BY 
        CASE active_triage 
          WHEN 'RED' THEN 1 
          WHEN 'YELLOW' THEN 2 
          WHEN 'GREEN' THEN 3 
          WHEN 'BLACK' THEN 4 
          ELSE 5 
        END ASC, 
        updated_at DESC
    `);
    const rows = stmt.all(operationId) as { crdt_json: string; active_triage: string }[];
    return rows.map(r => ({
      doc: JSON.parse(r.crdt_json) as CrdtPatientDocument,
      activeTriage: r.active_triage
    }));
  }

  // --- DTN Outbox ---
  enqueueDtnBundle(bundle: QueuedBundle): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO dtn_outbox 
      (bundle_id, operation_id, priority, hop_count, max_hops, created_at, ttl_ms, payload_base64)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      bundle.bundleId,
      bundle.operationId,
      bundle.priority,
      bundle.hopCount,
      bundle.maxHops,
      bundle.createdAt,
      bundle.ttlMs,
      bundle.payload.toString('base64')
    );
  }

  listPendingDtnBundles(operationId?: string): QueuedBundle[] {
    let sql = 'SELECT * FROM dtn_outbox';
    const params: any[] = [];
    if (operationId) {
      sql += ' WHERE operation_id = ?';
      params.push(operationId);
    }
    sql += ' ORDER BY priority DESC, created_at ASC';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(r => ({
      bundleId: r.bundle_id,
      operationId: r.operation_id,
      priority: r.priority as BundlePriority,
      hopCount: r.hop_count,
      maxHops: r.max_hops,
      createdAt: r.created_at,
      ttlMs: r.ttl_ms,
      payload: Buffer.from(r.payload_base64, 'base64')
    }));
  }

  removeDtnBundle(bundleId: string): void {
    const stmt = this.db.prepare('DELETE FROM dtn_outbox WHERE bundle_id = ?');
    stmt.run(bundleId);
  }

  // --- Audit Trail ---
  logAuditEvent(entryId: string, patientId: string, actionType: string, nodeId: string, details: any): void {
    const stmt = this.db.prepare(`
      INSERT INTO clinical_audit_trail (entry_id, patient_id, action_type, node_id, timestamp, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(entryId, patientId, actionType, nodeId, Date.now(), JSON.stringify(details));
  }

  getAuditTrail(patientId: string): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM clinical_audit_trail WHERE patient_id = ? ORDER BY timestamp ASC
    `);
    return stmt.all(patientId) as any[];
  }

  close(): void {
    this.db.close();
  }
}
