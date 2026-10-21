import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { LaunchMarketError, type StrategyId } from './types.ts';

export const PAPER_LEDGER_APPLICATION_ID = 1095126352;
export interface PaperExecutionPrice {
  readonly sourceId: 'ALPACA_IEX';
  readonly sourceAuthorized: true;
  readonly strategyId: StrategyId;
  readonly priceRaw: string;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly fetchedAt: number;
  readonly marketState: 'OPEN' | 'CLOSED';
}
/** Produced exclusively by the canonical server chain reader, never accepted from an HTTP body. */
export interface PaperFundingProof {
  readonly kind: 'DEPOSIT' | 'CLOSE';
  readonly chainId: 46630;
  readonly owner: string;
  readonly strategyId: StrategyId;
  readonly vault: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly blockTimestamp: number;
  readonly confirmations: number;
  readonly amountRaw: string;
  readonly passRaw: string;
}
export type PaperBookStatus =
  'EMPTY' | 'OPEN' | 'ENTRY_PENDING' | 'CLOSED' | 'SETTLEMENT_PENDING' | 'REORG_REVIEW_REQUIRED';
export interface PaperHistoryEntry {
  readonly eventId: string;
  readonly kind: 'DEPOSIT' | 'ENTRY' | 'CLOSE';
  readonly transactionHash: string;
  readonly blockHash: string;
  readonly at: number;
  readonly amountRaw: string;
  readonly quantityRaw: string;
  readonly priceRaw: string | null;
  readonly priceObservedAt: number | null;
  readonly sourceId: 'ALPACA_IEX' | null;
  readonly profitRaw: string | null;
}
export interface PaperCurvePoint {
  readonly at: number;
  readonly contributedRaw: string;
  readonly equityRaw: string | null;
  readonly profitRaw: string | null;
}
export interface PaperBookValue {
  readonly status: PaperBookStatus;
  readonly contributedRaw: string;
  /** Principal represented in the active virtual book; subtract this from physical cash before adding paper equity. */
  readonly allocatedPrincipalRaw: string;
  readonly costBasisRaw: string;
  readonly quantityRaw: string;
  readonly idleRaw: string;
  readonly equityRaw: string | null;
  readonly realizedRaw: string | null;
  readonly unrealizedRaw: string | null;
  readonly profitRaw: string | null;
  readonly returnBps: string | null;
  readonly history: readonly PaperHistoryEntry[];
  readonly curve: readonly PaperCurvePoint[];
}
export interface PaperLedgerValue {
  readonly schemaVersion: 2;
  readonly executionMode: 'PAPER';
  readonly owner: string;
  readonly strategyId: StrategyId;
  readonly vault: string | null;
  readonly paused: boolean;
  readonly closedVaults: readonly string[];
  readonly real: {
    readonly principalRaw: string;
    readonly cashRaw: string;
    readonly withdrawableRaw: string;
    readonly lockedPassRaw: string;
    readonly observedAt: number;
    readonly blockNumber: string;
    readonly blockHash: string;
    readonly confirmations: number;
  };
  readonly paper: PaperBookValue & {
    readonly observedAt: number;
    readonly priceObservedAt: number | null;
    readonly quoteStatus: 'FRESH' | 'STALE' | 'UNAVAILABLE';
    readonly marketSession: 'OPEN' | 'CLOSED' | 'UNKNOWN';
    readonly sourceId: 'ALPACA_IEX' | null;
  };
}
export type PaperVaultValueResponse = PaperLedgerValue;
interface FundingRow {
  proof_id: string;
  proof: string;
  action_id: string;
  canonical: number;
  paused: number;
  price: string | null;
  fill_at: number | null;
}
const scale = 10n ** 18n;
const max = (1n << 256n) - 1n;
const fail = (code: string, status = 409): never => {
  throw new LaunchMarketError(code, status);
};
const addr = (value: string) => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value))
    fail('PAPER_LEDGER_INPUT_INVALID', 400);
  return value.toLowerCase();
};
const strategy = (id: StrategyId) => {
  if (!['TSLA', 'AMZN'].includes(id)) fail('PAPER_LEDGER_INPUT_INVALID', 400);
};
const raw = (value: string, positive = false) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
    BigInt(value) > max ||
    (positive && value === '0')
  )
    fail('PAPER_LEDGER_INPUT_INVALID', 400);
  return BigInt(value);
};
const time = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) fail('PAPER_LEDGER_INPUT_INVALID', 400);
};
const digest = (value: string) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) fail('PAPER_LEDGER_INPUT_INVALID', 400);
};
function guard(path: string): void {
  if (path === ':memory:') return;
  if (!isAbsolute(path) || path !== resolve(path) || realpathSync(dirname(path)) !== dirname(path))
    fail('PAPER_LEDGER_STORAGE_UNSAFE', 503);
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.())
    fail('PAPER_LEDGER_STORAGE_UNSAFE', 503);
  try {
    closeSync(
      openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const f = lstatSync(path + suffix);
      if (
        !f.isFile() ||
        f.nlink !== 1 ||
        (f.mode & 0o077) !== 0 ||
        f.uid !== parent.uid ||
        realpathSync(path + suffix) !== path + suffix
      )
        fail('PAPER_LEDGER_STORAGE_UNSAFE', 503);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
export function paperProofId(proof: PaperFundingProof): string {
  return `${proof.chainId}:${proof.transactionHash.toLowerCase()}:${proof.kind}`;
}
export function qualifyPaperFundingProof(proof: PaperFundingProof): void {
  if (!proof || proof.chainId !== 46630 || !['DEPOSIT', 'CLOSE'].includes(proof.kind))
    fail('PAPER_LEDGER_PROOF_INVALID', 503);
  addr(proof.owner);
  addr(proof.vault);
  strategy(proof.strategyId);
  digest(proof.transactionHash);
  digest(proof.blockHash);
  raw(proof.blockNumber);
  raw(proof.amountRaw, proof.kind === 'DEPOSIT');
  raw(proof.passRaw);
  time(proof.blockTimestamp);
  if (
    !Number.isSafeInteger(proof.logIndex) ||
    proof.logIndex < 0 ||
    proof.logIndex > 100000 ||
    !Number.isSafeInteger(proof.confirmations) ||
    proof.confirmations < 3
  )
    fail('PAPER_LEDGER_PROOF_INVALID', 503);
}
function priceValid(
  price: PaperExecutionPrice | null,
  id: StrategyId,
  at: number,
  entry: boolean,
): price is PaperExecutionPrice {
  if (!price) return false;
  try {
    strategy(price.strategyId);
    raw(price.priceRaw, true);
    time(price.observedAt);
    time(price.expiresAt);
    time(price.fetchedAt);
    return (
      price.sourceId === 'ALPACA_IEX' &&
      price.sourceAuthorized === true &&
      price.strategyId === id &&
      ['OPEN', 'CLOSED'].includes(price.marketState) &&
      (!entry || price.marketState === 'OPEN') &&
      price.observedAt <= at &&
      at - price.observedAt <= 60 &&
      price.expiresAt > at &&
      price.expiresAt <= Math.min(price.observedAt + 60, price.fetchedAt + 30) &&
      price.fetchedAt >= price.observedAt &&
      price.fetchedAt <= at &&
      at - price.fetchedAt < 30
    );
  } catch {
    return false;
  }
}
export function usablePaperEntryPrice(
  price: PaperExecutionPrice | null,
  id: StrategyId,
  now: number,
): price is PaperExecutionPrice {
  return priceValid(price, id, now, true);
}
/** Derived simulation only. This store has no signer, RPC client, or authority over withdrawable cash. */
export class PaperLedger {
  readonly db: DatabaseSync;
  constructor(path: string, identity: { origin: string; manifestDigest: string }) {
    if (new URL(identity.origin).origin !== identity.origin) fail('PAPER_LEDGER_INPUT_INVALID', 400);
    digest(identity.manifestDigest);
    guard(path);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      this.atomic(() => {
        const v = Number(this.db.prepare('PRAGMA user_version').get()!.user_version),
          app = Number(this.db.prepare('PRAGMA application_id').get()!.application_id);
        if (v === 0 && (app === 0 || app === PAPER_LEDGER_APPLICATION_ID)) {
          if (
            this.db
              .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
              .get()
          )
            fail('PAPER_LEDGER_DATABASE_IDENTITY', 503);
          this.db
            .exec(`CREATE TABLE paper_identity(id INTEGER PRIMARY KEY CHECK(id=1),origin TEXT NOT NULL,manifest_digest TEXT NOT NULL) STRICT;
            CREATE TABLE paper_funding(proof_id TEXT NOT NULL,block_hash TEXT NOT NULL,owner TEXT NOT NULL,strategy_id TEXT NOT NULL,vault TEXT NOT NULL,proof TEXT NOT NULL,action_id TEXT NOT NULL,canonical INTEGER NOT NULL CHECK(canonical IN(0,1)),paused INTEGER NOT NULL CHECK(paused IN(0,1)),price TEXT,fill_at INTEGER,PRIMARY KEY(proof_id,block_hash)) STRICT;
            CREATE UNIQUE INDEX paper_canonical_proof ON paper_funding(proof_id) WHERE canonical=1;
            CREATE TABLE paper_marks(strategy_id TEXT NOT NULL,fetched_at INTEGER NOT NULL,observed_at INTEGER NOT NULL,price_raw TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(strategy_id,fetched_at)) STRICT;
            CREATE TABLE paper_actions(action_id TEXT PRIMARY KEY,owner TEXT NOT NULL,strategy_id TEXT NOT NULL,vault TEXT NOT NULL,kind TEXT NOT NULL) STRICT;
            PRAGMA user_version=1; PRAGMA application_id=${PAPER_LEDGER_APPLICATION_ID};`);
          this.db
            .prepare('INSERT INTO paper_identity VALUES(1,?,?)')
            .run(identity.origin, identity.manifestDigest);
        } else if (v !== 1 || app !== PAPER_LEDGER_APPLICATION_ID)
          fail('PAPER_LEDGER_DATABASE_IDENTITY', 503);
        const row = this.db.prepare('SELECT origin,manifest_digest FROM paper_identity WHERE id=1').get();
        if (row?.origin !== identity.origin || row.manifest_digest !== identity.manifestDigest)
          fail('PAPER_LEDGER_DATABASE_IDENTITY', 503);
      });
      if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        fail('PAPER_LEDGER_DATABASE_CORRUPT', 503);
      this.db.exec('PRAGMA journal_mode=WAL;');
      guard(path);
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
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private record(
    proof: PaperFundingProof,
    input: { actionId: string; paused?: boolean; price: PaperExecutionPrice | null },
    now: number,
  ): void {
    qualifyPaperFundingProof(proof);
    time(now);
    if (proof.blockTimestamp > now || !/^[A-Za-z0-9_-]{16,128}$/.test(input.actionId))
      fail('PAPER_LEDGER_INPUT_INVALID', 400);
    const p = {
      ...proof,
      owner: addr(proof.owner),
      vault: addr(proof.vault),
      transactionHash: proof.transactionHash.toLowerCase(),
      blockHash: proof.blockHash.toLowerCase(),
      confirmations: 3,
    };
    this.atomic(() => {
      const id = paperProofId(p);
      const claimed = this.db
        .prepare('SELECT owner,strategy_id,vault,kind FROM paper_actions WHERE action_id=?')
        .get(input.actionId);
      if (
        claimed &&
        (claimed.owner !== p.owner ||
          claimed.strategy_id !== p.strategyId ||
          claimed.vault !== p.vault ||
          claimed.kind !== p.kind)
      )
        fail('PAPER_LEDGER_ACTION_REUSED');
      const otherTx = this.db
        .prepare('SELECT proof_id FROM paper_funding WHERE action_id=? LIMIT 1')
        .get(input.actionId);
      if (otherTx && otherTx.proof_id !== id) fail('PAPER_LEDGER_ACTION_REUSED');
      const prior = this.db
        .prepare('SELECT proof,action_id FROM paper_funding WHERE proof_id=? LIMIT 1')
        .get(id);
      if (prior) {
        const old = JSON.parse(String(prior.proof)) as PaperFundingProof;
        if (
          old.owner !== p.owner ||
          old.strategyId !== p.strategyId ||
          old.vault !== p.vault ||
          old.kind !== p.kind ||
          prior.action_id !== input.actionId
        )
          fail('PAPER_LEDGER_PROOF_REUSED');
      }
      const same = this.db
        .prepare('SELECT * FROM paper_funding WHERE proof_id=? AND block_hash=?')
        .get(id, p.blockHash) as unknown as FundingRow | undefined;
      const fillValid =
        priceValid(input.price, p.strategyId, now, p.kind === 'DEPOSIT') &&
        (p.kind === 'DEPOSIT' || now - p.blockTimestamp <= 60) &&
        (p.kind !== 'DEPOSIT' || (raw(p.amountRaw) * scale) / BigInt(input.price!.priceRaw) <= max);
      if (same) {
        if (same.proof !== JSON.stringify(p)) fail('PAPER_LEDGER_PROOF_CHANGED');
        // The first fill is immutable. Cancellation can only prevent an unfilled deposit.
        if (input.paused && same.price === null)
          this.db
            .prepare('UPDATE paper_funding SET paused=1 WHERE proof_id=? AND block_hash=?')
            .run(id, p.blockHash);
        if (!same.price && !same.paused && !input.paused && fillValid) {
          this.db
            .prepare('UPDATE paper_funding SET price=?,fill_at=? WHERE proof_id=? AND block_hash=?')
            .run(JSON.stringify(input.price), now, id, p.blockHash);
        }
        this.db.prepare('UPDATE paper_funding SET canonical=0 WHERE proof_id=?').run(id);
        this.db
          .prepare('UPDATE paper_funding SET canonical=1 WHERE proof_id=? AND block_hash=?')
          .run(id, p.blockHash);
        return;
      }
      if (
        Number(this.db.prepare('SELECT count(*) n FROM paper_funding').get()!.n) >= 50000 &&
        p.kind !== 'CLOSE'
      )
        fail('PAPER_LEDGER_STORAGE_FULL', 503);
      const price = !input.paused && fillValid ? JSON.stringify(input.price) : null;
      this.db.prepare('UPDATE paper_funding SET canonical=0 WHERE proof_id=?').run(id);
      this.db
        .prepare('INSERT INTO paper_funding VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          p.blockHash,
          p.owner,
          p.strategyId,
          p.vault,
          JSON.stringify(p),
          input.actionId,
          1,
          input.paused ? 1 : 0,
          price,
          price ? now : null,
        );
      if (!claimed)
        this.db
          .prepare('INSERT INTO paper_actions VALUES(?,?,?,?,?)')
          .run(input.actionId, p.owner, p.strategyId, p.vault, p.kind);
    });
  }
  recordDeposit(
    proof: PaperFundingProof,
    input: { actionId: string; paused: boolean; price: PaperExecutionPrice | null },
    now: number,
  ): void {
    if (proof.kind !== 'DEPOSIT') fail('PAPER_LEDGER_PROOF_INVALID', 503);
    this.record(proof, input, now);
  }
  recordClose(
    proof: PaperFundingProof,
    input: { actionId: string; price: PaperExecutionPrice | null },
    now: number,
  ): void {
    if (proof.kind !== 'CLOSE') fail('PAPER_LEDGER_PROOF_INVALID', 503);
    this.record(proof, input, now);
  }
  recordMark(price: PaperExecutionPrice, now: number): void {
    time(now);
    if (!usablePaperEntryPrice(price, price.strategyId, now)) return;
    this.atomic(() => {
      const prior = this.db
        .prepare(
          'SELECT observed_at,price_raw,source_id FROM paper_marks WHERE strategy_id=? AND fetched_at=?',
        )
        .get(price.strategyId, price.fetchedAt);
      if (
        prior &&
        (prior.observed_at !== price.observedAt ||
          prior.price_raw !== price.priceRaw ||
          prior.source_id !== price.sourceId)
      )
        fail('PAPER_MARK_CHANGED');
      this.db
        .prepare('INSERT OR IGNORE INTO paper_marks VALUES(?,?,?,?,?)')
        .run(price.strategyId, price.fetchedAt, price.observedAt, price.priceRaw, price.sourceId);
      this.db.exec(
        'DELETE FROM paper_marks WHERE rowid IN (SELECT rowid FROM paper_marks ORDER BY fetched_at DESC,strategy_id LIMIT -1 OFFSET 20000)',
      );
    });
  }
  closedVaults(owner: string, id: StrategyId): readonly string[] {
    owner = addr(owner);
    strategy(id);
    return this.db
      .prepare(
        "SELECT vault FROM paper_funding WHERE owner=? AND strategy_id=? AND canonical=1 AND json_extract(proof,'$.kind')='CLOSE' GROUP BY vault ORDER BY max(CAST(json_extract(proof,'$.blockNumber') AS INTEGER)) DESC LIMIT 200",
      )
      .all(owner, id)
      .map((row) => String(row.vault));
  }
  latestMark(id: StrategyId): PaperExecutionPrice | null {
    strategy(id);
    const row = this.db
      .prepare(
        'SELECT fetched_at,observed_at,price_raw,source_id FROM paper_marks WHERE strategy_id=? ORDER BY fetched_at DESC LIMIT 1',
      )
      .get(id);
    return row
      ? {
          sourceId: 'ALPACA_IEX',
          sourceAuthorized: true,
          strategyId: id,
          priceRaw: String(row.price_raw),
          observedAt: Number(row.observed_at),
          fetchedAt: Number(row.fetched_at),
          expiresAt: Math.min(Number(row.observed_at) + 60, Number(row.fetched_at) + 30),
          marketState: 'OPEN',
        }
      : null;
  }
  depositProof(owner: string, id: StrategyId, vault: string, actionId: string): PaperFundingProof | null {
    const row = this.db
      .prepare(
        "SELECT proof FROM paper_funding WHERE owner=? AND strategy_id=? AND vault=? AND action_id=? AND canonical=1 AND json_extract(proof,'$.kind')='DEPOSIT'",
      )
      .get(addr(owner), id, addr(vault), actionId);
    return row ? (JSON.parse(String(row.proof)) as PaperFundingProof) : null;
  }
  hasEntry(actionId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM paper_funding WHERE action_id=? AND canonical=1 AND price IS NOT NULL AND json_extract(proof,'$.kind')='DEPOSIT'",
      )
      .get(actionId);
  }
  pause(owner: string, id: StrategyId): void {
    owner = addr(owner);
    strategy(id);
    this.db
      .prepare(
        "UPDATE paper_funding SET paused=1 WHERE owner=? AND strategy_id=? AND price IS NULL AND json_extract(proof,'$.kind')='DEPOSIT'",
      )
      .run(owner, id);
  }
  anchors(
    owner: string,
    id: StrategyId,
  ): readonly { proofId: string; blockNumber: string; blockHash: string }[] {
    owner = addr(owner);
    strategy(id);
    return (
      this.db
        .prepare('SELECT proof_id,proof FROM paper_funding WHERE owner=? AND strategy_id=? AND canonical=1')
        .all(owner, id) as unknown as FundingRow[]
    ).map((row) => {
      const p = JSON.parse(row.proof) as PaperFundingProof;
      return { proofId: row.proof_id, blockNumber: p.blockNumber, blockHash: p.blockHash };
    });
  }
  /** Call only after a trusted canonical block read. RPC failures must not be represented as an orphan. */
  setCanonical(proofId: string, canonicalHash: string | null): void {
    if (canonicalHash !== null) digest(canonicalHash);
    this.atomic(() => {
      this.db.prepare('UPDATE paper_funding SET canonical=0 WHERE proof_id=?').run(proofId);
      if (canonicalHash !== null)
        this.db
          .prepare('UPDATE paper_funding SET canonical=1 WHERE proof_id=? AND block_hash=?')
          .run(proofId, canonicalHash.toLowerCase());
    });
  }
  book(
    owner: string,
    id: StrategyId,
    vault: string | null,
    mark: PaperExecutionPrice | null,
    now: number,
  ): PaperBookValue {
    owner = addr(owner);
    strategy(id);
    time(now);
    const empty: PaperBookValue = {
      status: 'EMPTY',
      contributedRaw: '0',
      allocatedPrincipalRaw: '0',
      costBasisRaw: '0',
      quantityRaw: '0',
      idleRaw: '0',
      equityRaw: null,
      realizedRaw: null,
      unrealizedRaw: null,
      profitRaw: null,
      returnBps: null,
      history: [],
      curve: [],
    };
    if (vault === null) return empty;
    vault = addr(vault);
    const rows = this.db
      .prepare(
        'SELECT proof_id,proof,action_id,canonical,paused,price,fill_at FROM paper_funding WHERE owner=? AND strategy_id=? AND vault=?',
      )
      .all(owner, id, vault) as unknown as FundingRow[];
    if (!rows.length) return empty;
    const canonicalIds = new Set(rows.filter((row) => row.canonical === 1).map((row) => row.proof_id));
    const orphaned = rows.some((row) => !canonicalIds.has(row.proof_id));
    const events = rows
      .filter((row) => row.canonical === 1)
      .map((row) => ({ row, proof: JSON.parse(row.proof) as PaperFundingProof }))
      .sort((a, b) =>
        BigInt(a.proof.blockNumber) < BigInt(b.proof.blockNumber)
          ? -1
          : BigInt(a.proof.blockNumber) > BigInt(b.proof.blockNumber)
            ? 1
            : a.proof.logIndex - b.proof.logIndex,
      );
    let contributed = 0n,
      qty = 0n,
      idle = 0n,
      basis = 0n,
      closed = false,
      pending = false,
      realized: bigint | null = null,
      closedEquity: bigint | null = null;
    const history: PaperHistoryEntry[] = [],
      curve: PaperCurvePoint[] = [];
    for (const { row, proof: p } of events) {
      const price = row.price ? (JSON.parse(row.price) as PaperExecutionPrice) : null;
      const base = {
        eventId: row.proof_id,
        transactionHash: p.transactionHash,
        blockHash: p.blockHash,
        at: p.blockTimestamp,
        priceRaw: null as string | null,
        priceObservedAt: null as number | null,
        sourceId: null as 'ALPACA_IEX' | null,
        profitRaw: null as string | null,
      };
      if (p.kind === 'DEPOSIT') {
        if (closed) fail('PAPER_LEDGER_GENERATION_CLOSED', 503);
        const amount = raw(p.amountRaw, true);
        contributed += amount;
        history.push({ ...base, kind: 'DEPOSIT', amountRaw: p.amountRaw, quantityRaw: '0' });
        if (price) {
          const q = (amount * scale) / raw(price.priceRaw, true),
            cost = (q * BigInt(price.priceRaw)) / scale;
          if (qty + q > max || contributed > max) fail('PAPER_LEDGER_AMOUNT_OVERFLOW', 503);
          qty += q;
          basis += cost;
          idle += amount - cost;
          history.push({
            ...base,
            eventId: createHash('sha256')
              .update(row.proof_id + ':ENTRY')
              .digest('hex'),
            kind: 'ENTRY',
            amountRaw: String(cost),
            quantityRaw: String(q),
            priceRaw: price.priceRaw,
            priceObservedAt: price.observedAt,
            sourceId: price.sourceId,
            at: row.fill_at ?? p.blockTimestamp,
          });
        } else {
          idle += amount;
          if (!row.paused) pending = true;
        }
        curve.push({
          at: p.blockTimestamp,
          contributedRaw: String(contributed),
          equityRaw: null,
          profitRaw: null,
        });
      } else {
        closed = true;
        if (qty === 0n && contributed > 0n) {
          closedEquity = idle;
          realized = idle - contributed;
        } else if (price && contributed > 0n) {
          closedEquity = idle + (qty * BigInt(price.priceRaw)) / scale;
          realized = closedEquity - contributed;
        }
        history.push({
          ...base,
          kind: 'CLOSE',
          amountRaw: p.amountRaw,
          quantityRaw: String(qty),
          priceRaw: price?.priceRaw ?? null,
          priceObservedAt: price?.observedAt ?? null,
          sourceId: price?.sourceId ?? null,
          at: row.fill_at ?? p.blockTimestamp,
          profitRaw: realized === null ? null : String(realized),
        });
        curve.push({
          at: p.blockTimestamp,
          contributedRaw: String(contributed),
          equityRaw: closedEquity === null ? null : String(closedEquity),
          profitRaw: realized === null ? null : String(realized),
        });
      }
    }
    let equity: bigint | null = closed ? closedEquity : null;
    if (
      !closed &&
      mark &&
      mark.sourceId === 'ALPACA_IEX' &&
      mark.strategyId === id &&
      mark.observedAt <= now
    ) {
      try {
        equity = idle + (qty * raw(mark.priceRaw, true)) / scale;
      } catch {
        /* Unavailable display remains null. */
      }
    }
    if (orphaned) {
      equity = null;
      realized = null;
    }
    const profit = closed ? realized : equity === null ? null : equity - contributed;
    // Funding changes are excluded from the profit curve. Marks are shared across all users.
    curve.length = 0;
    if (!orphaned) {
      const marks = this.db
        .prepare(
          'SELECT fetched_at,price_raw FROM paper_marks WHERE strategy_id=? ORDER BY fetched_at DESC LIMIT 200',
        )
        .all(id)
        .reverse();
      for (const m of marks) {
        const at = Number(m.fetched_at);
        let b = 0n,
          q = 0n,
          c = 0n,
          exit = false;
        for (const e of events) {
          if (e.proof.blockTimestamp > at) continue;
          if (e.proof.kind === 'CLOSE') {
            exit = true;
            continue;
          }
          const a = BigInt(e.proof.amountRaw);
          b += a;
          if (e.row.price && e.row.fill_at !== null && e.row.fill_at <= at) {
            const p = JSON.parse(e.row.price) as PaperExecutionPrice,
              v = (a * scale) / BigInt(p.priceRaw),
              used = (v * BigInt(p.priceRaw)) / scale;
            q += v;
            c += a - used;
          } else c += a;
        }
        if (b > 0n && q > 0n && !exit) {
          const value = c + (q * BigInt(String(m.price_raw))) / scale;
          curve.push({
            at,
            contributedRaw: String(b),
            equityRaw: String(value),
            profitRaw: String(value - b),
          });
        }
      }
      if (closed && realized !== null)
        curve.push({
          at:
            events.find((e) => e.proof.kind === 'CLOSE')!.row.fill_at ??
            events.find((e) => e.proof.kind === 'CLOSE')!.proof.blockTimestamp,
          contributedRaw: String(contributed),
          equityRaw: String(closedEquity),
          profitRaw: String(realized),
        });
    }
    return {
      status: orphaned
        ? 'REORG_REVIEW_REQUIRED'
        : contributed === 0n
          ? 'EMPTY'
          : closed
            ? realized === null
              ? 'SETTLEMENT_PENDING'
              : 'CLOSED'
            : pending
              ? 'ENTRY_PENDING'
              : 'OPEN',
      contributedRaw: String(contributed),
      allocatedPrincipalRaw: closed ? '0' : String(contributed),
      costBasisRaw: String(basis),
      quantityRaw: closed ? '0' : String(qty),
      idleRaw: closed ? '0' : String(idle),
      equityRaw: equity === null ? null : String(equity),
      realizedRaw: closed
        ? realized === null
          ? null
          : String(realized)
        : contributed > 0n && !orphaned
          ? '0'
          : null,
      unrealizedRaw: closed ? null : profit === null ? null : String(profit),
      profitRaw: profit === null ? null : String(profit),
      returnBps: profit === null || contributed === 0n ? null : String((profit * 10000n) / contributed),
      history: history.slice(-200),
      curve: curve.slice(-200),
    };
  }
}
