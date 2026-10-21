import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { address } from './config.ts';
import { LaunchMarketError } from './types.ts';

export interface StrategyPolicy {
  readonly kind: 'BUY_AND_HOLD' | 'EMA_CROSS' | 'DCA';
  readonly allocationBps: number;
  readonly maxSlippageBps: number;
  readonly fastPeriod?: number;
  readonly slowPeriod?: number;
  readonly intervalDays?: number;
}
export interface CreatorStrategyInput {
  readonly name: string;
  readonly symbol: 'TSLA' | 'AMZN';
  readonly summary: string;
  readonly method: string;
  readonly risks: string;
  readonly policy: StrategyPolicy;
}
export interface CreatorStrategy extends CreatorStrategyInput {
  readonly id: string;
  readonly authorWallet: string;
  readonly version: number;
  readonly publishedVersion: number | null;
  readonly publicationRevision: number;
  readonly publishedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: 'DRAFT' | 'PUBLISHED' | 'UNLISTED';
  readonly draftChanges: boolean;
  readonly digest: string;
  readonly executionStatus: 'DOCUMENT_ONLY';
}

const fail = (code = 'INVALID_STRATEGY', status = 400): never => {
  throw new LaunchMarketError(code, status);
};
const bounded = (value: unknown, low: number, high: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < low || value > high) fail();
  return value as number;
};
const text = (value: unknown, low: number, high: number): string => {
  if (typeof value !== 'string') fail();
  const normalized = (value as string).trim().normalize('NFC');
  if (
    normalized.length < low ||
    normalized.length > high ||
    /\p{Cc}/u.test(normalized.replace(/[\n\r\t]/gu, ''))
  )
    fail();
  return normalized;
};
export function validateCreatorStrategy(input: unknown): CreatorStrategyInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !['name', 'symbol', 'summary', 'method', 'risks', 'policy'].includes(key),
    )
  )
    fail();
  if (!['TSLA', 'AMZN'].includes(String(value.symbol))) fail();
  const candidate = value.policy;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) fail();
  const policy = candidate as Record<string, unknown>;
  const common = ['kind', 'allocationBps', 'maxSlippageBps'];
  const allowed =
    policy.kind === 'EMA_CROSS'
      ? [...common, 'fastPeriod', 'slowPeriod']
      : policy.kind === 'DCA'
        ? [...common, 'intervalDays']
        : common;
  if (
    !['BUY_AND_HOLD', 'EMA_CROSS', 'DCA'].includes(String(policy.kind)) ||
    Object.keys(policy).some((key) => !allowed.includes(key))
  )
    fail();
  const allocationBps = bounded(policy.allocationBps, 1, 10_000);
  const maxSlippageBps = bounded(policy.maxSlippageBps, 1, 500);
  let normalized: StrategyPolicy;
  if (policy.kind === 'EMA_CROSS') {
    const fastPeriod = bounded(policy.fastPeriod, 2, 200),
      slowPeriod = bounded(policy.slowPeriod, 3, 500);
    if (fastPeriod >= slowPeriod) fail();
    normalized = { kind: 'EMA_CROSS', allocationBps, maxSlippageBps, fastPeriod, slowPeriod };
  } else if (policy.kind === 'DCA')
    normalized = {
      kind: 'DCA',
      allocationBps,
      maxSlippageBps,
      intervalDays: bounded(policy.intervalDays, 1, 90),
    };
  else normalized = { kind: 'BUY_AND_HOLD', allocationBps, maxSlippageBps };
  return {
    name: text(value.name, 4, 80),
    symbol: value.symbol as 'TSLA' | 'AMZN',
    summary: text(value.summary, 20, 2000),
    method: text(value.method, 20, 6000),
    risks: text(value.risks, 20, 3000),
    policy: normalized,
  };
}
const validId = (value: string): string => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
    fail('STRATEGY_NOT_FOUND', 404);
  return value;
};
const version = (value: number): number => bounded(value, 1, 1_000_000_000);
const timestamp = (value: number): number => bounded(value, 0, 9_000_000_000);
type Row = Record<string, SQLOutputValue>;

/** Wallet-owned documents and immutable publications, independent of financial accounting. */
export class CreatorStrategyStore {
  readonly db: DatabaseSync;
  constructor(path: string, origin: string) {
    if (new URL(origin).origin !== origin) fail('INVALID_CREATOR_ORIGIN');
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
      const schema = this.db.prepare('PRAGMA user_version').get()!.user_version;
      const appId = this.db.prepare('PRAGMA application_id').get()!.application_id;
      if (appId !== 0 && appId !== 1095126350) fail('CREATOR_DATABASE_IDENTITY', 503);
      if (schema === 0) {
        if (
          this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()
        )
          fail('CREATOR_DATABASE_IDENTITY', 503);
        this.atomic(() => {
          this.db
            .exec(`CREATE TABLE creator_identity(id INTEGER PRIMARY KEY CHECK(id=1),origin TEXT NOT NULL) STRICT;
CREATE TABLE creator_strategies(id TEXT PRIMARY KEY,wallet TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,published_version INTEGER,published_at INTEGER,visible INTEGER NOT NULL CHECK(visible IN(0,1)),publication_revision INTEGER NOT NULL) STRICT;
CREATE INDEX creator_owned ON creator_strategies(wallet,updated_at DESC,id DESC);
CREATE INDEX creator_public ON creator_strategies(visible,published_at DESC,id DESC);
CREATE TABLE creator_publications(strategy_id TEXT NOT NULL REFERENCES creator_strategies(id),version INTEGER NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,published_at INTEGER NOT NULL,PRIMARY KEY(strategy_id,version)) STRICT;
PRAGMA application_id=1095126350; PRAGMA user_version=1;`);
          this.db.prepare('INSERT INTO creator_identity VALUES(1,?)').run(origin);
        });
      } else if (schema !== 1 || appId !== 1095126350) fail('CREATOR_DATABASE_IDENTITY', 503);
      if (this.db.prepare('SELECT origin FROM creator_identity WHERE id=1').get()?.origin !== origin)
        fail('CREATOR_DATABASE_IDENTITY', 503);
      if (
        this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
        this.db.prepare('PRAGMA foreign_key_check').get()
      )
        fail('CREATOR_DATABASE_CORRUPT', 503);
      this.db.exec('PRAGMA journal_mode=WAL;');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    if (this.db.isOpen) this.db.close();
  }
  private atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private ownedRow(walletInput: string, id: string): Row {
    const row = this.db
      .prepare('SELECT * FROM creator_strategies WHERE id=? AND wallet=?')
      .get(validId(id), address(walletInput));
    if (!row) fail('STRATEGY_NOT_FOUND', 404);
    return row!;
  }
  private toView(row: Row, published = false): CreatorStrategy {
    const publication = published
      ? this.db
          .prepare('SELECT * FROM creator_publications WHERE strategy_id=? AND version=?')
          .get(row.id!, row.published_version!)
      : null;
    const input = validateCreatorStrategy(JSON.parse(String(publication?.payload ?? row.payload)));
    const currentVersion = Number(publication?.version ?? row.version);
    if (published && !publication) fail('CREATOR_DATABASE_CORRUPT', 503);
    const digest = publication
      ? String(publication.digest)
      : this.digest(String(row.id), String(row.wallet), currentVersion, input);
    return {
      ...input,
      id: String(row.id),
      authorWallet: String(row.wallet),
      version: currentVersion,
      publishedVersion: row.published_version === null ? null : Number(row.published_version),
      publicationRevision: Number(row.publication_revision),
      publishedAt: row.published_at === null ? null : Number(row.published_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(published ? row.published_at : row.updated_at),
      status: Number(row.visible) === 1 ? 'PUBLISHED' : row.published_version === null ? 'DRAFT' : 'UNLISTED',
      draftChanges:
        !published && row.published_version !== null && Number(row.published_version) !== Number(row.version),
      digest,
      executionStatus: 'DOCUMENT_ONLY',
    };
  }
  private digest(id: string, wallet: string, v: number, input: CreatorStrategyInput): string {
    return createHash('sha256')
      .update(JSON.stringify({ schemaVersion: 1, id, authorWallet: wallet, version: v, ...input }))
      .digest('hex');
  }
  create(walletInput: string, input: unknown, now: number): CreatorStrategy {
    const wallet = address(walletInput),
      payload = JSON.stringify(validateCreatorStrategy(input)),
      at = timestamp(now);
    return this.atomic(() => {
      if (
        Number(this.db.prepare('SELECT count(*) n FROM creator_strategies WHERE wallet=?').get(wallet)!.n) >=
        50
      )
        fail('CREATOR_STRATEGY_LIMIT', 429);
      if (Number(this.db.prepare('SELECT count(*) n FROM creator_strategies').get()!.n) >= 100_000)
        fail('CREATOR_CAPACITY', 503);
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO creator_strategies VALUES(?,?,1,?,?,?,NULL,NULL,0,0)')
        .run(id, wallet, payload, at, at);
      return this.toView(this.ownedRow(wallet, id));
    });
  }
  owned(wallet: string): CreatorStrategy[] {
    return this.db
      .prepare('SELECT * FROM creator_strategies WHERE wallet=? ORDER BY updated_at DESC,id DESC')
      .all(address(wallet))
      .map((row) => this.toView(row));
  }
  update(wallet: string, id: string, expectedVersion: number, input: unknown, now: number): CreatorStrategy {
    const payload = JSON.stringify(validateCreatorStrategy(input)),
      expected = version(expectedVersion),
      at = timestamp(now);
    return this.atomic(() => {
      const row = this.ownedRow(wallet, id);
      if (Number(row.version) !== expected) fail('STRATEGY_VERSION_CONFLICT', 409);
      if (expected >= 1000) fail('STRATEGY_VERSION_LIMIT', 429);
      this.db
        .prepare('UPDATE creator_strategies SET version=version+1,payload=?,updated_at=? WHERE id=?')
        .run(payload, at, id);
      return this.toView(this.ownedRow(wallet, id));
    });
  }
  publish(
    wallet: string,
    id: string,
    expectedVersion: number,
    now: number,
    expectedPublicationRevision: number,
  ): CreatorStrategy {
    const expected = version(expectedVersion),
      at = timestamp(now);
    return this.atomic(() => {
      const row = this.ownedRow(wallet, id);
      if (Number(row.version) !== expected) fail('STRATEGY_VERSION_CONFLICT', 409);
      const visibilityRevision = bounded(expectedPublicationRevision, 0, 1_000_000);
      if (Number(row.publication_revision) !== visibilityRevision) {
        if (
          Number(row.publication_revision) === visibilityRevision + 1 &&
          Number(row.visible) === 1 &&
          Number(row.published_version) === expected
        )
          return this.toView(row);
        fail('STRATEGY_PUBLICATION_CONFLICT', 409);
      }
      if (Number(row.visible) === 1 && Number(row.published_version) === expected) return this.toView(row);
      const input = validateCreatorStrategy(JSON.parse(String(row.payload)));
      const digest = this.digest(id, address(wallet), expected, input);
      // A published policy never changes in place. Publishing the same revision is idempotent.
      this.db
        .prepare(
          'INSERT INTO creator_publications VALUES(?,?,?,?,?) ON CONFLICT(strategy_id,version) DO NOTHING',
        )
        .run(id, expected, JSON.stringify(input), digest, at);
      const publishedAt = Number(
        this.db
          .prepare('SELECT published_at FROM creator_publications WHERE strategy_id=? AND version=?')
          .get(id, expected)!.published_at,
      );
      this.db
        .prepare(
          'UPDATE creator_strategies SET published_version=?,published_at=?,visible=1,publication_revision=publication_revision+1 WHERE id=?',
        )
        .run(expected, publishedAt, id);
      return this.toView(this.ownedRow(wallet, id));
    });
  }
  unpublish(
    wallet: string,
    id: string,
    expectedVersion: number,
    expectedPublicationRevision: number,
  ): CreatorStrategy {
    return this.atomic(() => {
      const row = this.ownedRow(wallet, id);
      if (Number(row.version) !== version(expectedVersion)) fail('STRATEGY_VERSION_CONFLICT', 409);
      const visibilityRevision = bounded(expectedPublicationRevision, 0, 1_000_000);
      if (Number(row.publication_revision) !== visibilityRevision) {
        if (Number(row.publication_revision) === visibilityRevision + 1 && Number(row.visible) === 0)
          return this.toView(row);
        fail('STRATEGY_PUBLICATION_CONFLICT', 409);
      }
      if (Number(row.visible) === 1)
        this.db
          .prepare(
            'UPDATE creator_strategies SET visible=0,publication_revision=publication_revision+1 WHERE id=?',
          )
          .run(id);
      return this.toView(this.ownedRow(wallet, id));
    });
  }
  publicDetail(id: string): CreatorStrategy {
    const row = this.db.prepare('SELECT * FROM creator_strategies WHERE id=? AND visible=1').get(validId(id));
    if (!row) fail('STRATEGY_NOT_FOUND', 404);
    return this.toView(row!, true);
  }
  publicList(cursor?: string, limit = 20): { strategies: CreatorStrategy[]; nextCursor: string | null } {
    bounded(limit, 1, 50);
    let at = 9_000_000_001,
      id = 'zzzzzzzz';
    if (cursor !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(cursor)) fail('INVALID_CURSOR');
      try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
          at: number;
          id: string;
        };
        at = timestamp(value.at);
        id = validId(value.id);
      } catch {
        fail('INVALID_CURSOR');
      }
    }
    const rows = this.db
      .prepare(
        'SELECT * FROM creator_strategies WHERE visible=1 AND (published_at<? OR (published_at=? AND id<?)) ORDER BY published_at DESC,id DESC LIMIT ?',
      )
      .all(at, at, id, limit + 1);
    const page = rows.slice(0, limit),
      last = page.at(-1);
    return {
      strategies: page.map((row) => this.toView(row, true)),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ at: Number(last.published_at), id: String(last.id) })).toString(
              'base64url',
            )
          : null,
    };
  }
}
