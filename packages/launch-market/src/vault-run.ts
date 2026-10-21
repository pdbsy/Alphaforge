import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { LaunchMarketError, type StrategyId } from './types.ts';

export type VaultRunStep = 'CREATE' | 'DEPOSIT' | 'BUY' | 'REVOKE' | 'SELL' | 'CLOSE';
export type VaultRunPhase =
  | 'READY'
  | 'AWAITING_WALLET'
  | 'SUBMITTED'
  | 'RECOVERY_REQUIRED'
  | 'PAUSED'
  | 'STOPPED'
  | 'HOLDING'
  | 'CLOSED'
  | 'FAILED'
  | 'PAPER_PENDING';
/** Supplied only by the server's canonical factory/vault reader. Never accepted from an HTTP body. */
export interface VaultRunObservation {
  readonly owner: string;
  readonly strategyId: StrategyId;
  readonly vault: string | null;
  readonly closed: boolean;
  readonly cashRaw: string;
  readonly positionRaw: string;
  readonly lockedPassRaw: string;
  readonly executorActive: boolean;
  readonly version: string;
  readonly ownerNonceRaw: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly confirmations: number;
}
export interface VaultRunPending {
  readonly transactionHash: string | null;
  readonly verified: boolean;
}
export interface VaultRunAction {
  readonly executionMode?: 'CHAIN' | 'PAPER';
  readonly actionId: string;
  readonly kind: 'DEPOSIT' | 'WITHDRAW' | 'STOP';
  /** BUY is limited to this deposit, never all pre-existing idle cash. */
  readonly amountRaw: string;
  readonly step: VaultRunStep | null;
  readonly stepAmountRaw: string;
  readonly expectedVersion: string | null;
  readonly preparedBlockNumber: string | null;
  readonly preparedBlockHash: string | null;
  readonly minimumNonceRaw: string | null;
  /** Closed generation before CREATE; replacement must resolve a different canonical address. */
  readonly previousVault: string | null;
  readonly phase: VaultRunPhase;
  readonly cancelled: boolean;
  readonly prepared: boolean;
  readonly pending: VaultRunPending | null;
  readonly failure: string | null;
}
export interface VaultRunState {
  readonly executionMode?: 'CHAIN' | 'PAPER';
  readonly schemaVersion: 1;
  readonly owner: string;
  readonly strategyId: StrategyId;
  readonly vault: string | null;
  readonly paused: boolean;
  /** null means the server has not confirmed whether an old executor grant still needs revocation. */
  readonly revocationRequired: boolean | null;
  readonly revision: number;
  readonly action: VaultRunAction | null;
  readonly updatedAt: number;
}
/** A callback must prove the exact owner transaction and canonical receipt with >= 3 confirmations. */
export type VaultRunReceipt =
  | { readonly status: 'UNKNOWN' }
  | { readonly status: 'PENDING' }
  | {
      readonly status: 'CONFIRMED' | 'REVERTED';
      readonly transactionHash: string;
      readonly blockNumber: string;
      readonly blockHash: string;
      readonly confirmations: number;
    };
export const VAULT_RUN_APPLICATION_ID = 1095126351;
const zero = '0x' + '0'.repeat(40);
const fail: (code: string, status?: number) => never = (code, status = 409) => {
  throw new LaunchMarketError(code, status);
};
function wallet(value: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || value.toLowerCase() === zero)
    return fail('LINKED_WALLET_REQUIRED', 401);
  return value.toLowerCase();
}
function strategy(value: StrategyId): void {
  if (!['TSLA', 'AMZN'].includes(value)) fail('INVALID_VAULT_RUN_INPUT', 400);
}
function raw(value: string, positive = false): void {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
    BigInt(value) >= 1n << 256n ||
    (positive && value === '0')
  )
    fail('INVALID_VAULT_RUN_INPUT', 400);
}
function hash(value: string): void {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail('INVALID_VAULT_RUN_INPUT', 400);
}
function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_VAULT_RUN_INPUT', 400);
}
function clock(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_VAULT_RUN_INPUT', 400);
}
function actionId(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value))
    fail('INVALID_VAULT_RUN_INPUT', 400);
}
function pathGuard(path: string): void {
  if (path === ':memory:') return;
  if (!isAbsolute(path) || path !== resolve(path) || realpathSync(dirname(path)) !== dirname(path))
    fail('VAULT_RUN_STORAGE_UNSAFE', 503);
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.())
    fail('VAULT_RUN_STORAGE_UNSAFE', 503);
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
      const file = lstatSync(path + suffix);
      if (
        !file.isFile() ||
        file.nlink !== 1 ||
        (file.mode & 0o077) !== 0 ||
        file.uid !== parent.uid ||
        realpathSync(path + suffix) !== path + suffix
      )
        fail('VAULT_RUN_STORAGE_UNSAFE', 503);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
export function qualifyVaultRunObservation(owner: string, id: StrategyId, value: VaultRunObservation): void {
  if (!value || wallet(value.owner) !== wallet(owner) || value.strategyId !== id)
    fail('VAULT_RUN_OWNER_MISMATCH', 403);
  strategy(id);
  if (value.vault !== null) wallet(value.vault);
  for (const amount of [
    value.cashRaw,
    value.positionRaw,
    value.lockedPassRaw,
    value.blockNumber,
    value.version,
    value.ownerNonceRaw,
  ])
    raw(amount);
  hash(value.blockHash);
  if (
    typeof value.closed !== 'boolean' ||
    typeof value.executorActive !== 'boolean' ||
    !Number.isSafeInteger(value.confirmations) ||
    value.confirmations < 3 ||
    (value.vault === null &&
      (value.closed ||
        value.executorActive ||
        [value.cashRaw, value.positionRaw, value.lockedPassRaw].some((amount) => amount !== '0')))
  )
    fail('VAULT_RUN_CHAIN_UNCONFIRMED', 503);
}
const exitStep = (observation: VaultRunObservation): VaultRunStep | null =>
  observation.closed || !observation.vault
    ? null
    : observation.executorActive
      ? 'REVOKE'
      : observation.positionRaw !== '0'
        ? 'SELL'
        : 'CLOSE';
const amountFor = (step: VaultRunStep | null, actionAmount: string, observation: VaultRunObservation) =>
  step === 'DEPOSIT' || step === 'BUY' ? actionAmount : step === 'SELL' ? observation.positionRaw : '0';

/** Workflow coordination only. Financial balances and transaction success always come from the chain. */
export class VaultRunStore {
  readonly db: DatabaseSync;
  constructor(path: string, identity: { origin: string; manifestDigest: string }) {
    if (new URL(identity.origin).origin !== identity.origin) fail('INVALID_VAULT_RUN_INPUT', 400);
    hash(identity.manifestDigest);
    pathGuard(path);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      this.atomic(() => {
        const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
        const appId = Number(this.db.prepare('PRAGMA application_id').get()!.application_id);
        if (version === 0 && (appId === 0 || appId === VAULT_RUN_APPLICATION_ID)) {
          if (
            this.db
              .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
              .get()
          )
            fail('VAULT_RUN_DATABASE_IDENTITY', 503);
          this.db.exec(`
            CREATE TABLE vault_run_identity(id INTEGER PRIMARY KEY CHECK(id=1),origin TEXT NOT NULL,manifest_digest TEXT NOT NULL) STRICT;
            CREATE TABLE vault_run_state(owner TEXT NOT NULL,strategy_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(owner,strategy_id)) STRICT;
            CREATE TABLE vault_run_actions(action_id TEXT PRIMARY KEY,owner TEXT NOT NULL,strategy_id TEXT NOT NULL,kind TEXT NOT NULL,amount_raw TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
            CREATE TABLE vault_run_transactions(transaction_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,strategy_id TEXT NOT NULL,action_id TEXT NOT NULL,step TEXT NOT NULL) STRICT;
            PRAGMA user_version=1; PRAGMA application_id=${VAULT_RUN_APPLICATION_ID};`);
          this.db
            .prepare('INSERT INTO vault_run_identity VALUES(1,?,?)')
            .run(identity.origin, identity.manifestDigest);
        } else if (version !== 1 || appId !== VAULT_RUN_APPLICATION_ID)
          fail('VAULT_RUN_DATABASE_IDENTITY', 503);
        const row = this.db.prepare('SELECT origin,manifest_digest FROM vault_run_identity WHERE id=1').get();
        if (row?.origin !== identity.origin || row.manifest_digest !== identity.manifestDigest)
          fail('VAULT_RUN_DATABASE_IDENTITY', 503);
      });
      if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        fail('VAULT_RUN_DATABASE_CORRUPT', 503);
      this.db.exec('PRAGMA journal_mode=WAL;');
      pathGuard(path);
    } catch (error) {
      this.db.close();
      throw error;
    }
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
  close(): void {
    if (this.db.isOpen) this.db.close();
  }
  private claimTransaction(state: VaultRunState, transactionHash: string): void {
    const action = state.action!;
    const normalized = transactionHash.toLowerCase();
    const existing = this.db
      .prepare('SELECT owner,strategy_id,action_id,step FROM vault_run_transactions WHERE transaction_hash=?')
      .get(normalized);
    if (
      existing &&
      (existing.owner !== state.owner ||
        existing.strategy_id !== state.strategyId ||
        existing.action_id !== action.actionId ||
        existing.step !== action.step)
    )
      fail('VAULT_RUN_TRANSACTION_REUSED');
    if (!existing)
      this.db
        .prepare('INSERT INTO vault_run_transactions VALUES(?,?,?,?,?)')
        .run(normalized, state.owner, state.strategyId, action.actionId, action.step);
  }
  get(owner: string, id: StrategyId): VaultRunState {
    owner = wallet(owner);
    strategy(id);
    const row = this.db
      .prepare('SELECT state FROM vault_run_state WHERE owner=? AND strategy_id=?')
      .get(owner, id);
    return row
      ? (JSON.parse(String(row.state)) as VaultRunState)
      : {
          schemaVersion: 1,
          owner,
          strategyId: id,
          vault: null,
          paused: true,
          revocationRequired: null,
          revision: 0,
          action: null,
          updatedAt: 0,
        };
  }
  pendingPaperRuns(limit = 20, cursor?: { owner: string; strategyId: StrategyId }): readonly VaultRunState[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_VAULT_RUN_INPUT', 400);
    if (cursor) {
      wallet(cursor.owner);
      strategy(cursor.strategyId);
    }
    const rows = this.db
      .prepare(
        `SELECT state FROM vault_run_state
      WHERE json_extract(state,'$.action.executionMode')='PAPER'
        AND (json_extract(state,'$.action.pending.transactionHash') IS NOT NULL
          OR (json_extract(state,'$.action.phase')='PAPER_PENDING' AND json_extract(state,'$.paused')=0 AND json_extract(state,'$.action.cancelled')=0))
        AND (? IS NULL OR owner>? OR (owner=? AND strategy_id>?))
      ORDER BY owner,strategy_id LIMIT ?`,
      )
      .all(
        cursor?.owner.toLowerCase() ?? null,
        cursor?.owner.toLowerCase() ?? null,
        cursor?.owner.toLowerCase() ?? null,
        cursor?.strategyId ?? null,
        limit,
      );
    return rows.map((row) => JSON.parse(String(row.state)) as VaultRunState);
  }
  private mutate(
    owner: string,
    id: StrategyId,
    expected: number,
    now: number,
    work: (state: VaultRunState) => Omit<VaultRunState, 'revision' | 'updatedAt'>,
  ): VaultRunState {
    revision(expected);
    clock(now);
    return this.atomic(() => {
      const previous = this.get(owner, id);
      if (previous.revision !== expected) fail('VAULT_RUN_REVISION_CONFLICT');
      if (previous.revision >= Number.MAX_SAFE_INTEGER) fail('VAULT_RUN_REVISION_LIMIT', 503);
      const next: VaultRunState = { ...work(previous), revision: previous.revision + 1, updatedAt: now };
      this.db
        .prepare(
          'INSERT INTO vault_run_state VALUES(?,?,?) ON CONFLICT(owner,strategy_id) DO UPDATE SET state=excluded.state',
        )
        .run(next.owner, id, JSON.stringify(next));
      return next;
    });
  }
  begin(
    owner: string,
    id: StrategyId,
    kind: 'DEPOSIT' | 'WITHDRAW',
    key: string,
    expected: number,
    amount: string,
    observation: VaultRunObservation,
    now: number,
    executionMode: 'CHAIN' | 'PAPER' = 'CHAIN',
  ): VaultRunState {
    qualifyVaultRunObservation(owner, id, observation);
    if (!['CHAIN', 'PAPER'].includes(executionMode)) fail('INVALID_VAULT_RUN_INPUT', 400);
    actionId(key);
    raw(amount, kind === 'DEPOSIT');
    if (!['DEPOSIT', 'WITHDRAW'].includes(kind) || (kind === 'WITHDRAW' && amount !== '0'))
      fail('INVALID_VAULT_RUN_INPUT', 400);
    return this.mutate(owner, id, expected, now, (state) => {
      if (
        state.action?.pending ||
        state.action?.prepared ||
        (state.action &&
          !state.action.cancelled &&
          !['HOLDING', 'CLOSED', 'FAILED', 'PAUSED', 'STOPPED'].includes(state.action.phase))
      )
        fail('VAULT_RUN_ACTION_PENDING');
      if (this.db.prepare('SELECT 1 FROM vault_run_actions WHERE action_id=?').get(key))
        fail('VAULT_RUN_ACTION_USED');
      if (
        kind === 'DEPOSIT' &&
        Number(this.db.prepare('SELECT count(*) n FROM vault_run_actions').get()!.n) >= 50000
      )
        fail('VAULT_RUN_STORAGE_FULL', 503);
      if (state.vault && observation.vault?.toLowerCase() !== state.vault && state.action?.phase !== 'CLOSED')
        fail('VAULT_RUN_VAULT_CHANGED');
      if (
        kind === 'DEPOSIT' &&
        observation.closed &&
        (observation.cashRaw !== '0' ||
          observation.positionRaw !== '0' ||
          observation.lockedPassRaw !== '0' ||
          observation.executorActive)
      )
        fail('VAULT_RUN_CLOSE_NOT_OBSERVED');
      if (executionMode === 'PAPER' && observation.positionRaw !== '0')
        fail('PAPER_LEGACY_POSITION_UNSUPPORTED');
      if (kind === 'DEPOSIT' && observation.executorActive) fail('VAULT_RUN_EXECUTOR_ACTIVE');
      const step =
        kind === 'DEPOSIT'
          ? observation.vault && !observation.closed
            ? 'DEPOSIT'
            : 'CREATE'
          : exitStep(observation);
      this.db
        .prepare('INSERT INTO vault_run_actions VALUES(?,?,?,?,?,?)')
        .run(key, state.owner, id, kind, amount, now);
      return {
        ...state,
        ...(executionMode === 'PAPER' ? { executionMode } : {}),
        vault: kind === 'DEPOSIT' && observation.closed ? null : (observation.vault?.toLowerCase() ?? null),
        paused: kind === 'WITHDRAW',
        revocationRequired: observation.executorActive,
        action: {
          ...(executionMode === 'PAPER' ? { executionMode } : {}),
          actionId: key,
          kind,
          amountRaw: amount,
          step,
          stepAmountRaw: amountFor(step, amount, observation),
          expectedVersion: null,
          preparedBlockNumber: null,
          preparedBlockHash: null,
          minimumNonceRaw: null,
          previousVault: step === 'CREATE' ? (observation.vault?.toLowerCase() ?? null) : null,
          phase: step ? 'READY' : 'CLOSED',
          cancelled: false,
          prepared: false,
          pending: null,
          failure: null,
        },
      };
    });
  }
  prepare(
    owner: string,
    id: StrategyId,
    key: string,
    expected: number,
    step: VaultRunStep,
    observation: VaultRunObservation,
    now: number,
  ): VaultRunState {
    qualifyVaultRunObservation(owner, id, observation);
    return this.mutate(owner, id, expected, now, (state) => {
      const action = state.action;
      if (
        !action ||
        action.actionId !== key ||
        action.step !== step ||
        action.phase !== 'READY' ||
        action.cancelled ||
        action.pending ||
        action.prepared ||
        (state.paused && action.kind === 'DEPOSIT')
      )
        fail('VAULT_RUN_STEP_CHANGED');
      if (action.executionMode === 'PAPER' && ['BUY', 'SELL'].includes(step))
        fail('PAPER_WALLET_STEP_UNSUPPORTED');
      if (state.vault && observation.vault?.toLowerCase() !== state.vault) fail('VAULT_RUN_VAULT_CHANGED');
      if (
        (step !== 'CREATE' && observation.closed) ||
        (step === 'CREATE' &&
          observation.vault &&
          (!observation.closed || observation.vault.toLowerCase() !== action.previousVault)) ||
        (step !== 'CREATE' && !observation.vault)
      )
        fail('VAULT_RUN_STEP_CHANGED');
      if (step === 'BUY' && BigInt(observation.cashRaw) < BigInt(action.amountRaw))
        fail('VAULT_RUN_CASH_CHANGED');
      if (step === 'SELL' && observation.positionRaw === '0') fail('VAULT_RUN_POSITION_CHANGED');
      if (step === 'CLOSE' && (observation.positionRaw !== '0' || observation.executorActive))
        fail('VAULT_RUN_EXIT_NOT_OBSERVED');
      return {
        ...state,
        action: {
          ...action,
          stepAmountRaw: amountFor(step, action.amountRaw, observation),
          expectedVersion: observation.version,
          preparedBlockNumber: observation.blockNumber,
          preparedBlockHash: observation.blockHash,
          minimumNonceRaw: observation.ownerNonceRaw,
          prepared: true,
          phase: 'AWAITING_WALLET',
        },
      };
    });
  }
  /** Stop is monotonic: a stale device may safely pause, but can never resume a newer action. */
  stop(owner: string, id: StrategyId, expected: number, now: number): VaultRunState {
    revision(expected);
    const current = this.get(owner, id);
    if (expected > current.revision) fail('VAULT_RUN_REVISION_CONFLICT');
    return this.mutate(owner, id, current.revision, now, (state) => ({
      ...state,
      paused: true,
      revocationRequired: null,
      action: state.action
        ? {
            ...state.action,
            cancelled: true,
            phase: state.action.pending
              ? state.action.phase
              : state.action.prepared
                ? 'RECOVERY_REQUIRED'
                : 'PAUSED',
          }
        : null,
    }));
  }
  /** Called after pause is durable. Failure to read the chain never undoes the initial Stop. */
  planStop(
    owner: string,
    id: StrategyId,
    expected: number,
    observation: VaultRunObservation,
    now: number,
    executionMode: 'CHAIN' | 'PAPER' = 'CHAIN',
  ): VaultRunState {
    qualifyVaultRunObservation(owner, id, observation);
    return this.mutate(owner, id, expected, now, (state) => {
      if (!state.paused) fail('VAULT_RUN_STEP_CHANGED');
      if (state.vault && observation.vault?.toLowerCase() !== state.vault) fail('VAULT_RUN_VAULT_CHANGED');
      if (state.action?.pending || state.action?.prepared)
        return {
          ...state,
          revocationRequired: observation.executorActive,
        };
      const step = observation.executorActive ? 'REVOKE' : null;
      return {
        ...state,
        vault: observation.vault?.toLowerCase() ?? null,
        revocationRequired: observation.executorActive,
        action: {
          ...(executionMode === 'PAPER' ? { executionMode } : {}),
          actionId: randomUUID(),
          kind: 'STOP',
          amountRaw: '0',
          step,
          stepAmountRaw: '0',
          expectedVersion: null,
          preparedBlockNumber: null,
          preparedBlockHash: null,
          minimumNonceRaw: null,
          previousVault: null,
          phase: step ? 'READY' : 'STOPPED',
          cancelled: false,
          prepared: false,
          pending: null,
          failure: null,
        },
      };
    });
  }
  submitted(
    owner: string,
    id: StrategyId,
    key: string,
    expected: number,
    step: VaultRunStep,
    transactionHash: string | null,
    verified: boolean,
    now: number,
  ): VaultRunState {
    if (transactionHash !== null) hash(transactionHash);
    if (verified && transactionHash === null) fail('INVALID_VAULT_RUN_INPUT', 400);
    return this.mutate(owner, id, expected, now, (state) => {
      const action = state.action;
      if (
        !action ||
        action.actionId !== key ||
        action.step !== step ||
        !action.prepared ||
        (action.pending?.verified && action.pending.transactionHash !== transactionHash) ||
        (action.pending?.transactionHash && transactionHash !== action.pending.transactionHash)
      )
        fail('VAULT_RUN_STEP_CHANGED');
      if (verified && transactionHash !== null) this.claimTransaction(state, transactionHash);
      return {
        ...state,
        action: {
          ...action,
          phase: verified ? 'SUBMITTED' : 'RECOVERY_REQUIRED',
          pending: { transactionHash: transactionHash?.toLowerCase() ?? null, verified },
        },
      };
    });
  }
  /** Explicit wallet rejection is metadata only; it never asserts a transaction or financial completion. */
  rejected(owner: string, id: StrategyId, key: string, expected: number, now: number): VaultRunState {
    return this.mutate(owner, id, expected, now, (state) => {
      const action = state.action;
      if (!action || action.actionId !== key || !action.prepared || action.pending)
        fail('VAULT_RUN_STEP_CHANGED');
      return {
        ...state,
        paused: true,
        action: { ...action, prepared: false, cancelled: true, phase: 'FAILED', failure: 'WALLET_REJECTED' },
      };
    });
  }
  completePaperEntry(
    owner: string,
    id: StrategyId,
    key: string,
    expected: number,
    now: number,
  ): VaultRunState {
    return this.mutate(owner, id, expected, now, (state) => {
      const action = state.action;
      if (
        !action ||
        action.actionId !== key ||
        action.executionMode !== 'PAPER' ||
        action.phase !== 'PAPER_PENDING' ||
        action.pending ||
        action.prepared ||
        state.paused ||
        action.cancelled
      )
        fail('VAULT_RUN_STEP_CHANGED');
      return { ...state, action: { ...action, phase: 'HOLDING' } };
    });
  }
  reconcile(
    owner: string,
    id: StrategyId,
    expected: number,
    receipt: VaultRunReceipt,
    observation: VaultRunObservation,
    now: number,
    paperFunded = false,
  ): VaultRunState {
    qualifyVaultRunObservation(owner, id, observation);
    return this.mutate(owner, id, expected, now, (state) => {
      const action = state.action;
      if (!action?.pending) fail('VAULT_RUN_NO_PENDING_TRANSACTION');
      if (action.step !== 'CREATE' && state.vault && observation.vault?.toLowerCase() !== state.vault)
        fail('VAULT_RUN_VAULT_CHANGED');
      if (receipt.status === 'UNKNOWN' || receipt.status === 'PENDING') return state;
      hash(receipt.transactionHash);
      hash(receipt.blockHash);
      raw(receipt.blockNumber);
      if (
        !action.pending.transactionHash ||
        receipt.transactionHash.toLowerCase() !== action.pending.transactionHash ||
        receipt.confirmations < 3 ||
        !Number.isSafeInteger(receipt.confirmations) ||
        action.preparedBlockNumber === null ||
        BigInt(receipt.blockNumber) <= BigInt(action.preparedBlockNumber) ||
        BigInt(receipt.blockNumber) > BigInt(observation.blockNumber)
      )
        fail('VAULT_RUN_RECEIPT_UNCONFIRMED', 503);
      this.claimTransaction(state, receipt.transactionHash);
      // Exact owner/calldata qualification is required in the receipt callback even for uncertain hashes.
      if (receipt.status === 'REVERTED')
        return {
          ...state,
          paused: true,
          action: {
            ...action,
            prepared: false,
            pending: null,
            phase: 'FAILED',
            failure: 'TRANSACTION_REVERTED',
          },
        };
      if (
        action.step === 'CREATE' &&
        (!observation.vault || observation.closed || observation.vault.toLowerCase() === action.previousVault)
      )
        fail('VAULT_RUN_CREATE_NOT_OBSERVED', 503);
      if (
        action.step === 'CLOSE' &&
        (!observation.closed ||
          observation.cashRaw !== '0' ||
          observation.positionRaw !== '0' ||
          observation.lockedPassRaw !== '0' ||
          observation.executorActive)
      )
        fail('VAULT_RUN_CLOSE_NOT_OBSERVED', 503);
      let step: VaultRunStep | null = null;
      let phase: VaultRunPhase = action.cancelled ? 'STOPPED' : 'READY';
      if (!action.cancelled) {
        if (action.kind === 'DEPOSIT') {
          step =
            action.step === 'CREATE'
              ? 'DEPOSIT'
              : action.step === 'DEPOSIT' && action.executionMode !== 'PAPER'
                ? 'BUY'
                : null;
          if (step === 'BUY' && BigInt(observation.cashRaw) < BigInt(action.amountRaw))
            fail('VAULT_RUN_CASH_CHANGED');
          if (!step) phase = action.executionMode === 'PAPER' && !paperFunded ? 'PAPER_PENDING' : 'HOLDING';
        } else if (action.kind === 'WITHDRAW') {
          if (action.executionMode === 'PAPER' && observation.positionRaw !== '0')
            fail('PAPER_LEGACY_POSITION_UNSUPPORTED');
          step = exitStep(observation);
          if (!step) phase = 'CLOSED';
          // A confirmed step must have achieved its advertised all-out target before continuing.
          if (
            (action.step === 'REVOKE' && observation.executorActive) ||
            (action.step === 'SELL' && observation.positionRaw !== '0')
          )
            fail('VAULT_RUN_EXIT_NOT_OBSERVED', 503);
        } else {
          if (observation.executorActive) fail('VAULT_RUN_EXIT_NOT_OBSERVED', 503);
          phase = 'STOPPED';
        }
      }
      if (action.cancelled && observation.executorActive)
        return {
          ...state,
          vault: observation.vault?.toLowerCase() ?? null,
          revocationRequired: true,
          action: {
            ...(action.executionMode === 'PAPER' ? { executionMode: 'PAPER' as const } : {}),
            actionId: randomUUID(),
            kind: 'STOP',
            amountRaw: '0',
            step: 'REVOKE',
            stepAmountRaw: '0',
            expectedVersion: null,
            preparedBlockNumber: null,
            preparedBlockHash: null,
            minimumNonceRaw: null,
            previousVault: null,
            phase: 'READY',
            cancelled: false,
            prepared: false,
            pending: null,
            failure: null,
          },
        };
      return {
        ...state,
        vault: observation.vault?.toLowerCase() ?? null,
        revocationRequired: observation.executorActive,
        action: {
          ...action,
          step,
          stepAmountRaw: amountFor(step, action.amountRaw, observation),
          expectedVersion: null,
          preparedBlockNumber: null,
          preparedBlockHash: null,
          minimumNonceRaw: null,
          phase,
          prepared: false,
          pending: null,
          failure: null,
        },
      };
    });
  }
}
