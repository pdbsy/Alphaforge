import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  VaultRunStore,
  VAULT_RUN_APPLICATION_ID,
  type VaultRunObservation,
  type VaultRunState,
  type VaultRunStep,
} from '../packages/launch-market/src/vault-run.ts';
import { privateServerStorage } from '../packages/testnet/src/private-storage.ts';

const owner = '0x' + '11'.repeat(20),
  vault = '0x' + '22'.repeat(20),
  block = '0x' + '33'.repeat(32);
const tx = '0x' + '44'.repeat(32),
  now = 2000000000;
const observation = (patch: Partial<VaultRunObservation> = {}): VaultRunObservation => ({
  owner,
  strategyId: 'TSLA',
  vault,
  closed: false,
  cashRaw: '0',
  positionRaw: '0',
  lockedPassRaw: '0',
  executorActive: false,
  version: '0',
  ownerNonceRaw: '0',
  blockNumber: '99',
  blockHash: block,
  confirmations: 3,
  ...patch,
});
const identity = { origin: 'https://vault.example.test', manifestDigest: block };
const depositId = 'deposit_action_0000001',
  withdrawId = 'withdraw_action_000001';
let proofSequence = 1n;
function complete(
  store: VaultRunStore,
  state: VaultRunState,
  step: VaultRunStep,
  before: VaultRunObservation,
  after: VaultRunObservation,
): VaultRunState {
  state = store.prepare(owner, 'TSLA', state.action!.actionId, state.revision, step, before, now);
  const transactionHash = '0x' + (proofSequence++).toString(16).padStart(64, '0');
  state = store.submitted(
    owner,
    'TSLA',
    state.action!.actionId,
    state.revision,
    step,
    transactionHash,
    true,
    now,
  );
  return store.reconcile(
    owner,
    'TSLA',
    state.revision,
    { status: 'CONFIRMED', transactionHash, blockNumber: '100', blockHash: block, confirmations: 3 },
    { ...after, blockNumber: '100' },
    now,
  );
}

test('first Deposit creates the canonical vault and buys only the confirmed new deposit; completed ids cannot be reused', () => {
  const store = new VaultRunStore(':memory:', identity);
  try {
    let state = store.begin(
      owner,
      'TSLA',
      'DEPOSIT',
      depositId,
      0,
      '25000000',
      observation({ vault: null }),
      now,
    );
    assert.equal(state.action!.step, 'CREATE');
    state = complete(
      store,
      state,
      'CREATE',
      observation({ vault: null }),
      observation({ cashRaw: '9000000' }),
    );
    assert.equal(state.action!.step, 'DEPOSIT');
    assert.equal(state.vault, vault);
    state = complete(
      store,
      state,
      'DEPOSIT',
      observation({ cashRaw: '9000000' }),
      observation({ cashRaw: '34000000', lockedPassRaw: '25000000000000000000' }),
    );
    assert.equal(state.action!.step, 'BUY');
    assert.equal(state.action!.stepAmountRaw, '25000000');
    state = complete(
      store,
      state,
      'BUY',
      observation({ cashRaw: '34000000', version: '2' }),
      observation({ cashRaw: '9000000', positionRaw: '100000000000000000', version: '3' }),
    );
    assert.equal(state.action!.phase, 'HOLDING');
    assert.equal(state.action!.pending, null);
    assert.throws(
      () => store.begin(owner, 'TSLA', 'DEPOSIT', depositId, state.revision, '25000000', observation(), now),
      /VAULT_RUN_ACTION_USED/,
    );
    assert.throws(
      () =>
        store.begin(
          owner,
          'TSLA',
          'DEPOSIT',
          'new_deposit_action_0001',
          state.revision,
          '1',
          observation({ owner: '0x' + '55'.repeat(20) }),
          now,
        ),
      /VAULT_RUN_OWNER_MISMATCH/,
    );
  } finally {
    store.close();
  }
});

test('Stop survives another connection and restart, accepts an older revision, and reconciles broadcast Deposit without buying', () => {
  const folder = mkdtempSync(join(tmpdir(), 'af-vault-run-'));
  const path = join(folder, 'run.sqlite');
  let store = new VaultRunStore(path, identity);
  const other = new VaultRunStore(path, identity);
  try {
    let state = store.begin(owner, 'TSLA', 'DEPOSIT', depositId, 0, '25000000', observation(), now);
    state = store.prepare(owner, 'TSLA', depositId, state.revision, 'DEPOSIT', observation(), now);
    assert.throws(
      () => other.prepare(owner, 'TSLA', depositId, 1, 'DEPOSIT', observation(), now),
      /VAULT_RUN_REVISION_CONFLICT/,
    );
    state = store.submitted(owner, 'TSLA', depositId, state.revision, 'DEPOSIT', tx, true, now);
    state = other.stop(owner, 'TSLA', 0, now);
    assert.equal(state.paused, true);
    assert.equal(state.action!.pending!.transactionHash, tx);
    assert.equal(state.action!.cancelled, true);
    store.close();
    store = new VaultRunStore(path, identity);
    state = store.reconcile(
      owner,
      'TSLA',
      state.revision,
      { status: 'CONFIRMED', transactionHash: tx, blockNumber: '100', blockHash: block, confirmations: 3 },
      observation({ cashRaw: '25000000', blockNumber: '100' }),
      now,
    );
    assert.equal(state.action!.phase, 'STOPPED');
    assert.equal(state.action!.step, null);
    assert.equal(state.paused, true);
    assert.equal(other.get(owner, 'TSLA').revision, state.revision);
    assert.throws(
      () =>
        store.prepare(
          owner,
          'TSLA',
          depositId,
          state.revision,
          'BUY',
          observation({ cashRaw: '25000000', blockNumber: '100' }),
          now,
        ),
      /VAULT_RUN_STEP_CHANGED/,
    );
  } finally {
    store.close();
    other.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('Stop revokes an existing executor, while unknown outcomes keep all future sends blocked', () => {
  const store = new VaultRunStore(':memory:', identity);
  try {
    let state = store.stop(owner, 'TSLA', 0, now);
    state = store.planStop(owner, 'TSLA', state.revision, observation({ executorActive: true }), now);
    assert.equal(state.action!.kind, 'STOP');
    assert.equal(state.action!.step, 'REVOKE');
    assert.equal(state.action!.phase, 'READY');
    state = complete(store, state, 'REVOKE', observation({ executorActive: true }), observation());
    assert.equal(state.action!.phase, 'STOPPED');
    assert.equal(state.revocationRequired, false);
    state = store.begin(owner, 'TSLA', 'DEPOSIT', depositId, state.revision, '1000000', observation(), now);
    state = store.prepare(owner, 'TSLA', depositId, state.revision, 'DEPOSIT', observation(), now);
    state = store.submitted(owner, 'TSLA', depositId, state.revision, 'DEPOSIT', null, false, now);
    assert.equal(state.action!.phase, 'RECOVERY_REQUIRED');
    assert.throws(
      () => store.begin(owner, 'TSLA', 'WITHDRAW', withdrawId, state.revision, '0', observation(), now),
      /VAULT_RUN_ACTION_PENDING/,
    );
    assert.throws(
      () => store.rejected(owner, 'TSLA', depositId, state.revision, now),
      /VAULT_RUN_STEP_CHANGED/,
    );
    assert.throws(
      () =>
        store.reconcile(
          owner,
          'TSLA',
          state.revision,
          {
            status: 'CONFIRMED',
            transactionHash: tx,
            blockNumber: '100',
            blockHash: block,
            confirmations: 3,
          },
          observation({ cashRaw: '1000000', blockNumber: '100' }),
          now,
        ),
      /VAULT_RUN_RECEIPT_UNCONFIRMED/,
    );
  } finally {
    store.close();
  }
});

test('Withdraw revokes, sells the full position, and only reports CLOSED after cash and every locked PASS are released', () => {
  const store = new VaultRunStore(':memory:', identity);
  try {
    let state = store.begin(
      owner,
      'TSLA',
      'WITHDRAW',
      withdrawId,
      0,
      '0',
      observation({
        executorActive: true,
        positionRaw: '200000000000000000',
        lockedPassRaw: '50000000000000000000',
      }),
      now,
    );
    assert.equal(state.paused, true);
    state = complete(
      store,
      state,
      'REVOKE',
      observation({ executorActive: true, positionRaw: '200000000000000000' }),
      observation({ positionRaw: '200000000000000000', lockedPassRaw: '50000000000000000000' }),
    );
    assert.equal(state.action!.step, 'SELL');
    assert.equal(state.action!.stepAmountRaw, '200000000000000000');
    state = complete(
      store,
      state,
      'SELL',
      observation({ positionRaw: '200000000000000000' }),
      observation({ cashRaw: '40000000', lockedPassRaw: '50000000000000000000' }),
    );
    assert.equal(state.action!.step, 'CLOSE');
    state = store.prepare(
      owner,
      'TSLA',
      withdrawId,
      state.revision,
      'CLOSE',
      observation({ cashRaw: '40000000', lockedPassRaw: '50000000000000000000' }),
      now,
    );
    state = store.submitted(owner, 'TSLA', withdrawId, state.revision, 'CLOSE', tx, true, now);
    const receipt = {
      status: 'CONFIRMED' as const,
      transactionHash: tx,
      blockNumber: '100',
      blockHash: block,
      confirmations: 3,
    };
    assert.throws(
      () =>
        store.reconcile(
          owner,
          'TSLA',
          state.revision,
          receipt,
          observation({ closed: true, lockedPassRaw: '1', blockNumber: '100' }),
          now,
        ),
      /VAULT_RUN_CLOSE_NOT_OBSERVED/,
    );
    assert.equal(store.get(owner, 'TSLA').action!.phase, 'SUBMITTED');
    state = store.reconcile(
      owner,
      'TSLA',
      state.revision,
      receipt,
      observation({ closed: true, blockNumber: '100' }),
      now,
    );
    assert.equal(state.action!.phase, 'CLOSED');
    assert.equal(state.vault, vault);
    assert.equal(state.revocationRequired, false);
  } finally {
    store.close();
  }
});

test('private database namespaces refuse shared files and changed identity', () => {
  const folder = mkdtempSync(join(tmpdir(), 'af-vault-run-path-'));
  const path = join(folder, 'run.sqlite');
  try {
    const store = new VaultRunStore(path, identity);
    store.close();
    assert.throws(
      () => new VaultRunStore(path, { ...identity, manifestDigest: tx }),
      /VAULT_RUN_DATABASE_IDENTITY/,
    );
    const alias = join(folder, 'alias.sqlite');
    symlinkSync(path, alias);
    assert.throws(() => new VaultRunStore(alias, identity), /VAULT_RUN_STORAGE_UNSAFE/);
    chmodSync(path, 0o644);
    assert.throws(() => new VaultRunStore(path, identity), /VAULT_RUN_STORAGE_UNSAFE/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a closed generation can start Deposit again but cannot bind the old closed vault as a new CREATE', () => {
  const store = new VaultRunStore(':memory:', identity);
  try {
    let state = store.begin(owner, 'TSLA', 'WITHDRAW', withdrawId, 0, '0', observation(), now);
    state = complete(store, state, 'CLOSE', observation(), observation({ closed: true }));
    state = store.begin(
      owner,
      'TSLA',
      'DEPOSIT',
      depositId,
      state.revision,
      '1000000',
      observation({ closed: true }),
      now,
    );
    assert.equal(state.action!.step, 'CREATE');
    assert.equal(state.action!.previousVault, vault);
    assert.equal(state.vault, null);
    state = store.prepare(
      owner,
      'TSLA',
      depositId,
      state.revision,
      'CREATE',
      observation({ closed: true }),
      now,
    );
    state = store.submitted(owner, 'TSLA', depositId, state.revision, 'CREATE', tx, true, now);
    const receipt = {
      status: 'CONFIRMED' as const,
      transactionHash: tx,
      blockNumber: '100',
      blockHash: block,
      confirmations: 3,
    };
    assert.throws(
      () =>
        store.reconcile(
          owner,
          'TSLA',
          state.revision,
          receipt,
          observation({ closed: true, blockNumber: '100' }),
          now,
        ),
      /VAULT_RUN_CREATE_NOT_OBSERVED/,
    );
    const replacement = '0x' + '66'.repeat(20);
    state = store.reconcile(
      owner,
      'TSLA',
      state.revision,
      receipt,
      observation({ vault: replacement, blockNumber: '100' }),
      now,
    );
    assert.equal(state.vault, replacement);
    assert.equal(state.action!.step, 'DEPOSIT');
    assert.throws(
      () => store.prepare(owner, 'TSLA', depositId, state.revision, 'DEPOSIT', observation(), now),
      /VAULT_RUN_VAULT_CHANGED/,
    );
  } finally {
    store.close();
  }
});

test('prepared nonce and block anchor reject historical receipts and a transaction hash cannot prove a second action', () => {
  const store = new VaultRunStore(':memory:', identity);
  try {
    let state = store.begin(owner, 'TSLA', 'DEPOSIT', depositId, 0, '1000000', observation(), now);
    state = store.prepare(
      owner,
      'TSLA',
      depositId,
      state.revision,
      'DEPOSIT',
      observation({ ownerNonceRaw: '4', version: '7' }),
      now,
    );
    assert.equal(state.action!.minimumNonceRaw, '4');
    assert.equal(state.action!.expectedVersion, '7');
    assert.equal(state.action!.preparedBlockNumber, '99');
    state = store.submitted(owner, 'TSLA', depositId, state.revision, 'DEPOSIT', tx, true, now);
    assert.throws(
      () =>
        store.reconcile(
          owner,
          'TSLA',
          state.revision,
          { status: 'CONFIRMED', transactionHash: tx, blockNumber: '99', blockHash: block, confirmations: 3 },
          observation({ cashRaw: '1000000' }),
          now,
        ),
      /VAULT_RUN_RECEIPT_UNCONFIRMED/,
    );
    state = store.reconcile(
      owner,
      'TSLA',
      state.revision,
      { status: 'CONFIRMED', transactionHash: tx, blockNumber: '100', blockHash: block, confirmations: 3 },
      observation({ cashRaw: '1000000', blockNumber: '100' }),
      now,
    );
    state = store.stop(owner, 'TSLA', state.revision, now);
    state = store.begin(
      owner,
      'TSLA',
      'DEPOSIT',
      'second_deposit_action_0001',
      state.revision,
      '1000000',
      observation({ cashRaw: '1000000' }),
      now,
    );
    state = store.prepare(
      owner,
      'TSLA',
      state.action!.actionId,
      state.revision,
      'DEPOSIT',
      observation({ cashRaw: '1000000', ownerNonceRaw: '5' }),
      now,
    );
    assert.throws(
      () => store.submitted(owner, 'TSLA', state.action!.actionId, state.revision, 'DEPOSIT', tx, true, now),
      /VAULT_RUN_TRANSACTION_REUSED/,
    );
    assert.equal(store.get(owner, 'TSLA').action!.pending, null);
  } finally {
    store.close();
  }
});

test('the shared private storage preclaimed application id initializes correctly, and active legacy executors block Deposit', () => {
  const parent = mkdtempSync(join(tmpdir(), 'af-vault-shared-store-'));
  const storage = privateServerStorage(join(parent, 'community'), 128 * 1024 * 1024);
  let store: VaultRunStore | null = null;
  try {
    storage.bindIdentity('PUBLIC_TESTNET', block);
    const path = storage.databasePath('vault-run', VAULT_RUN_APPLICATION_ID);
    store = new VaultRunStore(path, identity);
    assert.equal(store.get(owner, 'TSLA').revision, 0);
    assert.throws(
      () =>
        store!.begin(
          owner,
          'TSLA',
          'DEPOSIT',
          depositId,
          0,
          '1000000',
          observation({ executorActive: true }),
          now,
        ),
      /VAULT_RUN_EXECUTOR_ACTIVE/,
    );
    assert.equal(store.get(owner, 'TSLA').revision, 0);
    store.close();
    store = new VaultRunStore(storage.databasePath('vault-run', VAULT_RUN_APPLICATION_ID), identity);
    assert.equal(store.get(owner, 'TSLA').revision, 0);
    assert.equal(VAULT_RUN_APPLICATION_ID, 1095126351);
  } finally {
    store?.close();
    storage.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
