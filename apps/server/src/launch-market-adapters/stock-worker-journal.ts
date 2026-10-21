import { DatabaseSync } from 'node:sqlite';
import { hash } from '../../../../packages/launch-market/src/config.ts';
import { stockEvidenceHash } from './stock-worker-policy.ts';

const schema = [
  'CREATE TABLE worker_identity (id INTEGER PRIMARY KEY CHECK(id=1), configuration_hash TEXT NOT NULL) STRICT',
  'CREATE TABLE source_evidence (digest TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT',
  'CREATE TABLE decisions (intent_id TEXT PRIMARY KEY, consent_digest TEXT NOT NULL, state_version TEXT NOT NULL, reason TEXT NOT NULL, source_digest TEXT NOT NULL REFERENCES source_evidence(digest)) STRICT',
];
/** Separate worker evidence, never the user ledger. Sources and decisions are immutable and hash checked. */
export class StockWorkerJournal {
  readonly db: DatabaseSync;
  constructor(path: string, configurationHash: string) {
    hash(configurationHash);
    this.db = new DatabaseSync(path);
    try {
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      const tables = this.db
        .prepare("SELECT sql FROM sqlite_schema WHERE type='table' ORDER BY name")
        .all()
        .map((r) => String(r.sql))
        .sort();
      if (version === 0 && !tables.length) {
        this.db.exec('BEGIN IMMEDIATE');
        for (const sql of schema) this.db.exec(sql);
        this.db.prepare('INSERT INTO worker_identity VALUES(1,?)').run(configurationHash);
        this.db.exec('PRAGMA user_version=1; COMMIT');
      } else if (
        version !== 1 ||
        JSON.stringify(tables) !== JSON.stringify([...schema].sort()) ||
        this.db.prepare('SELECT configuration_hash FROM worker_identity WHERE id=1').get()
          ?.configuration_hash !== configurationHash
      )
        throw new Error('STOCK_WORKER_DATABASE_IDENTITY');
      if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        throw new Error('STOCK_WORKER_DATABASE_INTEGRITY');
      this.db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000',
      );
      let count = 0;
      for (const row of this.db.prepare('SELECT digest,payload FROM source_evidence').iterate()) {
        if (
          ++count > 1000000 ||
          typeof row.payload !== 'string' ||
          row.payload.length > 262144 ||
          stockEvidenceHash(JSON.parse(row.payload)) !== row.digest
        )
          throw new Error('STOCK_WORKER_EVIDENCE_INTEGRITY');
      }
      if (this.db.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('STOCK_WORKER_EVIDENCE_INTEGRITY');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }
  capture(value: unknown): string {
    const digest = stockEvidenceHash(value),
      payload = JSON.stringify(value);
    if (payload.length > 262144) throw new Error('STOCK_WORKER_EVIDENCE_LIMIT');
    this.db.prepare('INSERT OR IGNORE INTO source_evidence VALUES(?,?)').run(digest, payload);
    if (
      this.db.prepare('SELECT payload FROM source_evidence WHERE digest=?').get(digest)?.payload !== payload
    )
      throw new Error('STOCK_WORKER_EVIDENCE_CONFLICT');
    return digest;
  }
  decision(intentId: string, consentDigest: string, version: string, reason: string, sourceDigest: string) {
    const expected = {
      intent_id: intentId,
      consent_digest: consentDigest,
      state_version: version,
      reason,
      source_digest: sourceDigest,
    };
    this.db
      .prepare('INSERT OR IGNORE INTO decisions VALUES(?,?,?,?,?)')
      .run(intentId, consentDigest, version, reason, sourceDigest);
    const actual = this.db.prepare('SELECT * FROM decisions WHERE intent_id=?').get(intentId);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error('STOCK_WORKER_DECISION_CONFLICT');
  }
  decisions(consentDigest: string) {
    const rows = this.db
      .prepare(
        'SELECT intent_id,state_version,reason,source_digest FROM decisions WHERE consent_digest=? LIMIT 20001',
      )
      .all(consentDigest);
    if (rows.length > 20000) throw new Error('STOCK_WORKER_DECISION_LIMIT');
    return rows.map((row) => ({
      id: String(row.intent_id),
      version: String(row.state_version),
      reason: String(row.reason),
      sourceDigest: String(row.source_digest),
    }));
  }
  close() {
    this.db.close();
  }
}
