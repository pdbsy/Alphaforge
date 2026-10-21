import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { LaunchMarketError } from '../packages/launch-market/src/types.ts';
import {
  VaultRunStore,
  type VaultRunObservation,
  type VaultRunState,
  type VaultRunReceipt,
} from '../packages/launch-market/src/vault-run.ts';
import { registerVaultRunRoutes } from '../apps/server/src/launch-market/vault-run-routes.ts';
import { VaultReferenceDemand } from '../apps/server/src/launch-market-adapters/vault-reference-demand.ts';

const owner = '0x' + '11'.repeat(20),
  other = '0x' + '22'.repeat(20),
  vault = '0x' + '33'.repeat(20);
const block = '0x' + '44'.repeat(32),
  tx = '0x' + '55'.repeat(32),
  origin = 'https://vault.example.test';
const actionId = 'deposit_action_http_00001';
const observation: VaultRunObservation = {
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
};
async function fixture(configured = true) {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const store = new VaultRunStore(':memory:', { origin, manifestDigest: block });
  let writable = true,
    chainDown = false,
    pauseFails = false,
    qualifyFails = false,
    stoppedDuringRead = false;
  let observed = observation;
  let receipt: VaultRunReceipt = { status: 'PENDING' };
  let pauseCount = 0;
  const demand = new VaultReferenceDemand({
    sourceConfigured: configured,
    keeperConfigured: configured,
    now: () => 2000000000,
    refresh: async (strategyId, now) => ({
      strategyId,
      status: 'READY',
      observedAt: now,
      expiresAt: now + 60,
      priceRaw: '250000000',
      source: 'Alpaca IEX',
      reason: 'READY',
    }),
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof LaunchMarketError) return reply.code(error.status).send({ error: error.code });
    const detail = error as { statusCode?: number; code?: string };
    return reply.code(detail.statusCode ?? 500).send({ error: detail.code ?? 'INTERNAL_ERROR' });
  });
  registerVaultRunRoutes(app, {
    origin,
    store,
    demand,
    now: () => 2000000000,
    canWrite: () => writable,
    consumeRate: () => {},
    resolveAccount: async (request) => {
      if (!['owner', 'other'].includes(String(request.headers.authorization))) return null;
      if (request.method === 'POST' && request.headers['x-csrf-token'] !== 'device-private-csrf')
        throw new LaunchMarketError('INVALID_CSRF_TOKEN', 403);
      return {
        id: 'wallet-account',
        accountKey: 'wallet-account-key',
        wallet: request.headers.authorization === 'owner' ? owner : other,
        email: null,
      };
    },
    readObservation: async (wallet, _id, options) => {
      if (chainDown) throw new LaunchMarketError('CHAIN_UNAVAILABLE', 503);
      if (options.fresh) assert.equal(typeof options.fresh, 'boolean');
      return { ...observed, owner: wallet };
    },
    qualifyTransaction: async (state, hash) => {
      if (qualifyFails || hash !== tx) throw new LaunchMarketError('VAULT_RUN_TRANSACTION_MISMATCH', 409);
      if (stoppedDuringRead) store.stop(owner, 'TSLA', state.revision, 2000000000);
    },
    readReceipt: async (state) => {
      if (qualifyFails || state.action?.pending?.transactionHash !== tx)
        throw new LaunchMarketError('VAULT_RUN_TRANSACTION_MISMATCH', 409);
      if (stoppedDuringRead) store.stop(owner, 'TSLA', state.revision, 2000000000);
      return receipt;
    },
    pauseAutomation: () => {
      pauseCount++;
      if (pauseFails) throw new Error('PRIVATE_PAUSE_FAILURE');
    },
  });
  const call = (method: 'GET' | 'POST', path = '', body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: '/api/launch-market/vault-run/TSLA' + path,
      headers: { authorization: 'owner', origin, 'x-csrf-token': 'device-private-csrf', ...headers },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  return {
    app,
    store,
    call,
    full: () => {
      writable = false;
    },
    chainDown: () => {
      chainDown = true;
    },
    pauseFails: () => {
      pauseFails = true;
    },
    qualifyFails: () => {
      qualifyFails = true;
    },
    stopDuringRead: () => {
      stoppedDuringRead = true;
    },
    observation: (value: Partial<VaultRunObservation>) => {
      observed = { ...observation, ...value };
    },
    receipt: (value: VaultRunReceipt) => {
      receipt = value;
    },
    pauseCount: () => pauseCount,
    close: async () => {
      await app.close();
      store.close();
    },
  };
}
const deposit = { actionId, expectedRevision: 0, amountRaw: '1000000' };

test('private workflow routes enforce selected identity, CSRF, origin, and reject user-supplied completion', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('GET', '', undefined, { authorization: '' })).statusCode, 401);
    assert.equal((await f.call('POST', '/deposit', deposit, { 'x-csrf-token': '' })).statusCode, 403);
    assert.equal(
      (await f.call('POST', '/deposit', deposit, { origin: 'https://evil.example' })).statusCode,
      403,
    );
    assert.equal((await f.call('POST', '/deposit', { ...deposit, phase: 'HOLDING' })).statusCode, 400);
    const response = await f.call('POST', '/deposit', deposit);
    assert.equal(response.statusCode, 200);
    const state = response.json() as VaultRunState;
    assert.equal(state.action!.phase, 'READY');
    assert.equal((await f.call('GET', '', undefined, { authorization: 'other' })).json().state.action, null);
    assert.equal(
      (
        await f.call(
          'POST',
          '/prepare',
          { actionId, expectedRevision: state.revision, step: 'DEPOSIT' },
          { authorization: 'other' },
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (await f.call('POST', '/reconcile', { expectedRevision: state.revision, completed: true })).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});

test('unconfigured reference never begins funding, and Stop persists while quota, chain, and old automation are unavailable', async () => {
  const f = await fixture(false);
  try {
    assert.equal((await f.call('POST', '/deposit', deposit)).json().error, 'STOCK_REFERENCE_NOT_CONFIGURED');
    assert.equal(f.store.get(owner, 'TSLA').revision, 0);
    f.full();
    f.chainDown();
    f.pauseFails();
    const result = await f.call('POST', '/stop', { expectedRevision: 0 });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().state.paused, true);
    assert.equal(result.json().state.revocationRequired, null);
    assert.equal(result.json().automationPaused, false);
    assert.equal(result.json().revocationObserved, false);
    assert.equal(f.pauseCount(), 1);
    assert.equal(f.store.get(owner, 'TSLA').paused, true);
  } finally {
    await f.close();
  }
});

test('async submission and canonical receipt reads preserve a concurrent Stop and do not advance to BUY', async () => {
  const f = await fixture();
  try {
    let state = (await f.call('POST', '/deposit', deposit)).json() as VaultRunState;
    state = (
      await f.call('POST', '/prepare', { actionId, expectedRevision: state.revision, step: 'DEPOSIT' })
    ).json() as VaultRunState;
    f.stopDuringRead();
    const submitted = await f.call('POST', '/submitted', {
      actionId,
      expectedRevision: state.revision,
      step: 'DEPOSIT',
      transactionHash: tx,
    });
    assert.equal(submitted.statusCode, 200);
    state = submitted.json() as VaultRunState;
    assert.equal(state.paused, true);
    assert.equal(state.action!.pending!.verified, true);
    f.receipt({
      status: 'CONFIRMED',
      transactionHash: tx,
      blockNumber: '100',
      blockHash: block,
      confirmations: 3,
    });
    f.observation({ cashRaw: '1000000', lockedPassRaw: '1000000000000000000', blockNumber: '100' });
    const reconciled = await f.call('POST', '/reconcile', { expectedRevision: state.revision });
    assert.equal(reconciled.statusCode, 200);
    state = reconciled.json() as VaultRunState;
    assert.equal(state.action!.phase, 'STOPPED');
    assert.equal(state.action!.step, null);
    assert.equal(state.paused, true);
  } finally {
    await f.close();
  }
});

test('an uncertain hash is only a recovery clue; mismatched or underconfirmed receipts cannot complete a step', async () => {
  const f = await fixture();
  try {
    let state = (await f.call('POST', '/deposit', deposit)).json() as VaultRunState;
    state = (
      await f.call('POST', '/prepare', { actionId, expectedRevision: state.revision, step: 'DEPOSIT' })
    ).json() as VaultRunState;
    assert.equal(
      (
        await f.call('POST', '/submitted', {
          actionId,
          expectedRevision: state.revision,
          step: 'DEPOSIT',
          transactionHash: block,
        })
      ).statusCode,
      409,
    );
    state = (
      await f.call('POST', '/uncertain', {
        actionId,
        expectedRevision: state.revision,
        step: 'DEPOSIT',
        transactionHash: tx,
      })
    ).json() as VaultRunState;
    assert.equal(state.action!.phase, 'RECOVERY_REQUIRED');
    assert.equal(state.action!.pending!.verified, false);
    f.receipt({
      status: 'CONFIRMED',
      transactionHash: tx,
      blockNumber: '100',
      blockHash: block,
      confirmations: 2,
    });
    f.observation({ cashRaw: '1000000' });
    assert.equal((await f.call('POST', '/reconcile', { expectedRevision: state.revision })).statusCode, 503);
    assert.equal(f.store.get(owner, 'TSLA').action!.phase, 'RECOVERY_REQUIRED');
    f.qualifyFails();
    assert.equal((await f.call('POST', '/reconcile', { expectedRevision: state.revision })).statusCode, 409);
    assert.equal(
      (await f.call('POST', '/rejected', { actionId, expectedRevision: state.revision })).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});

test('Withdraw durably cancels follow-up even when fresh chain read fails; old consents are paused before selling', async () => {
  const f = await fixture();
  try {
    let state = (await f.call('POST', '/deposit', deposit)).json() as VaultRunState;
    f.chainDown();
    const withdrawal = await f.call('POST', '/withdraw', {
      actionId: 'withdraw_http_action_0001',
      expectedRevision: state.revision,
    });
    assert.equal(withdrawal.statusCode, 503);
    state = f.store.get(owner, 'TSLA');
    assert.equal(state.paused, true);
    assert.equal(state.action!.cancelled, true);
    assert.equal(f.pauseCount(), 1);
  } finally {
    await f.close();
  }
});

test('a ready reference with unavailable transaction lookup retains uncertainty and blocks a second send intent', async () => {
  const f = await fixture();
  try {
    let state = (await f.call('POST', '/deposit', deposit)).json() as VaultRunState;
    state = (
      await f.call('POST', '/prepare', { actionId, expectedRevision: state.revision, step: 'DEPOSIT' })
    ).json() as VaultRunState;
    f.qualifyFails();
    const missing = await f.call('POST', '/submitted', {
      actionId,
      expectedRevision: state.revision,
      step: 'DEPOSIT',
      transactionHash: tx,
    });
    assert.equal(missing.statusCode, 409);
    assert.equal(f.store.get(owner, 'TSLA').action!.phase, 'AWAITING_WALLET');
    state = (
      await f.call('POST', '/uncertain', { actionId, expectedRevision: state.revision, step: 'DEPOSIT' })
    ).json() as VaultRunState;
    assert.equal(state.action!.phase, 'RECOVERY_REQUIRED');
    assert.equal(state.action!.pending!.transactionHash, null);
    assert.equal(
      (await f.call('POST', '/prepare', { actionId, expectedRevision: state.revision, step: 'DEPOSIT' }))
        .statusCode,
      409,
    );
    assert.equal(
      (
        await f.call('POST', '/deposit', {
          ...deposit,
          actionId: 'second_http_deposit_0001',
          expectedRevision: state.revision,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await f.call('POST', '/reconcile', { expectedRevision: state.revision })).json().revision,
      state.revision,
    );
    assert.equal(f.store.get(owner, 'TSLA').action!.phase, 'RECOVERY_REQUIRED');
  } finally {
    await f.close();
  }
});
