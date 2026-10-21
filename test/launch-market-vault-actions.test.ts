import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Interface } from 'ethers';
import {
  Eip1193Wallet,
  PreparedActionFactory,
  type BeforeWalletSend,
  type Eip1193Provider,
  type Eip1193Request,
} from '../apps/web/src/chain-wallet.ts';
import { asAddress, asHexData } from '../packages/chain-adapter/src/types.ts';
import {
  VaultActionsController,
  type VaultActionsClient,
} from '../apps/web/src/launch-market/vault-actions.ts';
import {
  VaultRunStore,
  type VaultRunObservation,
  type VaultRunState,
} from '../packages/launch-market/src/vault-run.ts';
import { registerVaultRunRoutes } from '../apps/server/src/launch-market/vault-run-routes.ts';
import { VaultReferenceDemand } from '../apps/server/src/launch-market-adapters/vault-reference-demand.ts';
import {
  LaunchMarketError,
  type QuoteRequest,
  type StrategyId,
} from '../packages/launch-market/src/types.ts';
import type { LaunchClientState } from '../apps/web/src/launch-market/model.ts';
import type { StockExecutionSnapshot } from '../apps/web/src/launch-market/stock-execution.ts';
import { stockExecutionInterface } from '../apps/web/src/launch-market/stock-execution.ts';
import { executorInterface } from '../apps/web/src/launch-market/executor.ts';
import { marketInterfaces } from '../packages/launch-market/src/abi.ts';
import {
  account,
  config,
  wallet,
  snapshot,
  quote,
  OWNER,
  OTHER,
  NOW,
  BLOCK,
} from './helpers/launch-market-ui-fixture.ts';

const VAULT = '0x3333333333333333333333333333333333333333';
const OLD_HASH = `0x${'ab'.repeat(32)}`;
const PRICE = 250_000_000n;
const tokenInterface = new Interface(['function approve(address,uint256) returns(bool)']);
const origin = 'https://vault.example.test';

type Sent = { from: string; to: string; data: string; value: string };
/** Real durable routes and store, real guarded EIP-1193 send, and a small isolated chain/client display model. */
async function setup(
  options: {
    source?: boolean;
    approval?: boolean;
    cash?: string;
    position?: string;
    locked?: string;
    executor?: boolean;
  } = {},
) {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const store = new VaultRunStore(':memory:', { origin, manifestDigest: BLOCK });
  const observations = new Map<StrategyId, VaultRunObservation>(
    ['TSLA', 'AMZN'].map((strategyId) => [
      strategyId as StrategyId,
      {
        owner: OWNER,
        strategyId: strategyId as StrategyId,
        vault: VAULT,
        closed: false,
        cashRaw: options.cash ?? '9000000',
        positionRaw: options.position ?? '0',
        lockedPassRaw: options.locked ?? '0',
        executorActive: options.executor ?? false,
        version: '0',
        ownerNonceRaw: '0',
        blockNumber: '99',
        blockHash: BLOCK,
        confirmations: 3,
      },
    ]),
  );
  let state: LaunchClientState = {
    enabled: true,
    config: config(),
    wallet: wallet(),
    snapshot: snapshot(),
    owner: OWNER,
    account: account(),
    connecting: false,
    busy: false,
    quote: null,
    quoteRequest: null,
    error: null,
    notice: null,
    transaction: {
      state: 'COMPLETED',
      hash: OLD_HASH,
      id: 'prior',
      confirmations: 3,
      approval: false,
      owner: OWNER,
    },
  };
  const listeners = new Set<(state: LaunchClientState) => void>();
  const update = (patch: Partial<LaunchClientState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(structuredClone(state));
  };
  let guard: BeforeWalletSend | undefined,
    needsApproval = options.approval ?? false;
  let preflightFailure = false,
    wrongOwner = false,
    blockSimulation: (() => Promise<void>) | null = null;
  const requests: { path: string; method: string; body?: unknown }[] = [];
  const reviews: { kind: string; strategy: StrategyId; amount: string }[] = [];
  const sent = new Map<string, Sent>();
  const confirmed = new Set<string>();
  const payouts = { cash: 0n, pass: 0n };
  let sequence = 1n;
  const provider: Eip1193Provider = {
    async request(input: Eip1193Request) {
      if (input.method === 'eth_accounts' || input.method === 'eth_requestAccounts') return [state.owner];
      if (input.method === 'eth_chainId') return '0xb626';
      if (input.method === 'eth_call') {
        await blockSimulation?.();
        return '0x';
      }
      if (input.method === 'eth_sendTransaction') {
        const hash = `0x${(sequence++).toString(16).padStart(64, '0')}`;
        sent.set(hash, input.params![0] as Sent);
        return hash;
      }
      throw new Error(`Unexpected wallet request ${input.method}`);
    },
    on() {},
    removeListener() {},
  };
  const stockSnapshot = (id: StrategyId) =>
    ({
      owner: state.owner!,
      strategyId: id,
      vault: VAULT,
      version: observations.get(id)!.version,
      trackedCashRaw: observations.get(id)!.cashRaw,
      trackedStockRaw: observations.get(id)!.positionRaw,
    }) as StockExecutionSnapshot;
  const perform = async (data: string, approval: boolean, target = VAULT) => {
    // This failure occurs before a wallet handoff and intentionally retains the old transaction evidence.
    if (preflightFailure) throw new Error('CONFIGURATION_REFRESH_FAILED');
    update({
      busy: true,
      transaction: {
        state: 'AWAITING_WALLET',
        hash: null,
        id: null,
        confirmations: 0,
        approval,
        owner: state.owner,
      },
    });
    const factory = new PreparedActionFactory<string>({
      chainId: 46630,
      target: asAddress(target),
      operationId: () => `fixture-${sequence}`,
      encode: (value) => ({ data: asHexData(value), value: 0n }),
    });
    const browserWallet = new Eip1193Wallet(provider, {
      chainId: 46630,
      target: asAddress(target),
      actionAuthority: factory.authority,
    });
    try {
      const result = await browserWallet.submit(factory.prepare(data, asAddress(state.owner!)), guard);
      update({
        busy: false,
        quote: null,
        quoteRequest: null,
        stockReview: null,
        executorReview: null,
        transaction: {
          state: result.state === 'SUBMITTED' ? 'SUBMITTED' : 'RECOVERY_REQUIRED',
          hash: result.txHash,
          id: null,
          confirmations: 0,
          approval,
          owner: state.owner,
        },
      });
    } catch (error) {
      update({ busy: false, transaction: { ...state.transaction, state: 'REJECTED' } });
      throw error;
    }
  };
  const client: VaultActionsClient = {
    get state() {
      return structuredClone(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(structuredClone(state));
      return () => {
        listeners.delete(listener);
      };
    },
    setSubmissionGuard(value) {
      guard = value ?? undefined;
    },
    async review(request) {
      reviews.push({ kind: request.operation, strategy: request.strategyId, amount: request.amountRaw });
      const full: QuoteRequest = { ...request, owner: state.owner! };
      const approval = request.operation === 'DEPOSIT' && needsApproval;
      const data =
        request.operation === 'CLOSE'
          ? marketInterfaces.vault.encodeFunctionData('close')
          : marketInterfaces.vault.encodeFunctionData('deposit', [request.amountRaw]);
      update({
        stockReview: null,
        executorReview: null,
        quoteRequest: full,
        quote: {
          ...quote(full),
          id: `review_${reviews.length}`,
          transaction: { to: VAULT, data, value: '0' },
          allowance: approval
            ? { token: config().manifest!.usdc, spender: VAULT, amountRaw: request.amountRaw }
            : null,
        },
      });
    },
    async refreshStock(id) {
      update({ stockSnapshots: { ...state.stockSnapshots, [id]: stockSnapshot(id) } });
    },
    async reviewStock(id, buy, amount, slippage) {
      reviews.push({ kind: buy ? 'BUY' : 'SELL', strategy: id, amount });
      const snap = stockSnapshot(id);
      update({
        quote: null,
        quoteRequest: null,
        executorReview: null,
        stockReview: {
          snapshot: snap,
          buy,
          inputRaw: amount,
          data: stockExecutionInterface.encodeFunctionData('execute', [
            buy,
            amount,
            1,
            NOW + 60,
            snap.version,
          ]),
          estimatedOutRaw: '1',
          minOutRaw: '1',
          slippageBps: slippage,
          deadline: NOW + 60,
          gasEstimateRaw: '1',
          reviewExpiresAt: NOW + 60,
        },
      });
    },
    async reviewExecutorPermission(id) {
      reviews.push({ kind: 'REVOKE', strategy: id, amount: '0' });
      update({
        quote: null,
        quoteRequest: null,
        stockReview: null,
        executorReview: {
          snapshot: stockSnapshot(id),
          data: executorInterface.encodeFunctionData('revokeExecutor'),
          kind: 'REVOKE',
          permission: null,
          gasEstimateRaw: '1',
          reviewExpiresAt: NOW + 60,
        },
      });
    },
    async confirm() {
      const current = state.quote!;
      const approval = current.allowance !== null;
      await perform(
        approval
          ? tokenInterface.encodeFunctionData('approve', [VAULT, current.allowance!.amountRaw])
          : current.transaction.data,
        approval,
        approval ? current.allowance!.token : VAULT,
      );
    },
    async confirmExecutorPermission() {
      await perform((state.stockReview ?? state.executorReview)!.data, false);
    },
    clearQuote() {
      update({ quote: null, quoteRequest: null, stockReview: null, executorReview: null });
    },
    async refresh() {},
    async refreshTransaction() {},
  };
  app.setErrorHandler((error, _request, reply) =>
    reply.code(error instanceof LaunchMarketError ? error.status : 500).send({
      error:
        error instanceof LaunchMarketError
          ? error.code
          : error instanceof Error
            ? error.message
            : 'FIXTURE_ERROR',
    }),
  );
  const demand = new VaultReferenceDemand({
    sourceConfigured: options.source !== false,
    keeperConfigured: options.source !== false,
    now: () => NOW,
    refresh: async (strategyId, observedAt) => ({
      strategyId,
      status: 'READY',
      observedAt,
      expiresAt: observedAt + 60,
      priceRaw: String(PRICE),
      source: 'Alpaca IEX',
      reason: 'READY',
    }),
  });
  const qualify = (run: VaultRunState, hash: string) => {
    const actual = sent.get(hash);
    assert.ok(actual);
    assert.equal(actual.from.toLowerCase(), OWNER.toLowerCase());
    assert.equal(actual.to.toLowerCase(), VAULT.toLowerCase());
    assert.equal(actual.value, '0x0');
    const action = run.action!;
    if (action.step === 'BUY' || action.step === 'SELL') {
      const decoded = stockExecutionInterface.parseTransaction(actual)!;
      assert.equal(decoded.name, 'execute');
      assert.equal(decoded.args[0], action.step === 'BUY');
      assert.equal(String(decoded.args[1]), action.stepAmountRaw);
      assert.equal(String(decoded.args[4]), action.expectedVersion);
    } else {
      const decoded = (
        action.step === 'REVOKE' ? executorInterface : marketInterfaces.vault
      ).parseTransaction(actual)!;
      assert.equal(
        decoded.name,
        action.step === 'DEPOSIT' ? 'deposit' : action.step === 'CLOSE' ? 'close' : 'revokeExecutor',
      );
      if (action.step === 'DEPOSIT') assert.equal(String(decoded.args[0]), action.stepAmountRaw);
    }
  };
  registerVaultRunRoutes(app, {
    origin,
    store,
    demand,
    now: () => NOW,
    canWrite: () => true,
    consumeRate() {},
    pauseAutomation() {},
    resolveAccount: async (request) => {
      assert.equal(request.headers.authorization, OWNER);
      if (request.method === 'POST') assert.equal(request.headers['x-csrf-token'], 'fixture-csrf-token');
      return { id: 'fixture', accountKey: 'fixture', email: null, wallet: OWNER };
    },
    readObservation: async (_owner, id) => observations.get(id)!,
    qualifyTransaction: async (run, hash) => qualify(run, hash),
    readReceipt: async (run) => {
      const hash = run.action!.pending!.transactionHash!;
      qualify(run, hash);
      return confirmed.has(hash)
        ? {
            status: 'CONFIRMED',
            transactionHash: hash,
            blockNumber: observations.get(run.strategyId)!.blockNumber,
            blockHash: BLOCK,
            confirmations: 3,
          }
        : { status: 'PENDING' };
    },
  });
  const controller = new VaultActionsController(client, {
    api: async <T>(path: string, method = 'GET', body?: unknown) => {
      requests.push({ path, method, ...(body === undefined ? {} : { body }) });
      const response = await app.inject({
        url: path,
        method: method as 'GET' | 'POST',
        headers: { authorization: OWNER, origin, 'x-csrf-token': 'fixture-csrf-token' },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      });
      if (response.statusCode !== 200) throw new Error(response.json().error);
      const result = response.json();
      if (wrongOwner) {
        if (result.state) result.state.owner = OTHER;
        else result.owner = OTHER;
      }
      return result as T;
    },
  });
  const complete = (hash = state.transaction.hash!, id: StrategyId = 'AMZN') => {
    const transaction = sent.get(hash)!;
    const observed = observations.get(id)!;
    const approval = transaction.to.toLowerCase() !== VAULT.toLowerCase();
    const next = {
      ...observed,
      blockNumber: String(BigInt(observed.blockNumber) + 1n),
      ownerNonceRaw: String(BigInt(observed.ownerNonceRaw) + 1n),
    };
    if (approval) needsApproval = false;
    else {
      next.version = String(BigInt(next.version) + 1n);
      const execute = stockExecutionInterface.parseTransaction(transaction);
      if (execute?.name === 'execute') {
        const amount = BigInt(execute.args[1]);
        if (execute.args[0]) {
          next.cashRaw = String(BigInt(next.cashRaw) - amount);
          next.positionRaw = String(BigInt(next.positionRaw) + (amount * 10n ** 18n) / PRICE);
        } else {
          next.cashRaw = String(BigInt(next.cashRaw) + (amount * PRICE) / 10n ** 18n);
          next.positionRaw = String(BigInt(next.positionRaw) - amount);
        }
      } else {
        const decoded = marketInterfaces.vault.parseTransaction(transaction);
        if (decoded?.name === 'deposit') {
          const amount = BigInt(decoded.args[0]);
          next.cashRaw = String(BigInt(next.cashRaw) + amount);
          next.lockedPassRaw = String(BigInt(next.lockedPassRaw) + amount * 10n ** 12n);
        } else if (decoded?.name === 'close') {
          payouts.cash += BigInt(next.cashRaw);
          payouts.pass += BigInt(next.lockedPassRaw);
          next.cashRaw = '0';
          next.lockedPassRaw = '0';
          next.closed = true;
        } else next.executorActive = false;
      }
    }
    observations.set(id, next);
    confirmed.add(hash);
    update({ transaction: { ...state.transaction, state: 'COMPLETED', confirmations: 3 } });
  };
  return {
    app,
    store,
    controller,
    client,
    requests,
    reviews,
    sent,
    payouts,
    observations,
    complete,
    failBeforeWallet() {
      preflightFailure = true;
    },
    corruptOwner() {
      wrongOwner = true;
    },
    simulation(value: () => Promise<void>) {
      blockSimulation = value;
    },
    update,
    async close() {
      update({ owner: null });
      await app.close();
      store.close();
    },
  };
}

test('a pre-wallet failure retains its previous hash without registering it as an uncertain new deposit', async () => {
  const f = await setup();
  try {
    await f.controller.deposit('AMZN', '1000000');
    f.failBeforeWallet();
    await assert.rejects(f.controller.confirm(), /CONFIGURATION_REFRESH_FAILED/);
    assert.equal(f.sent.size, 0);
    assert.equal(f.client.state.transaction.hash, OLD_HASH);
    assert.equal(f.store.get(OWNER, 'AMZN').action!.phase, 'FAILED');
    assert.equal(
      f.requests.some((r) => r.path.endsWith('/submitted') || r.path.endsWith('/uncertain')),
      false,
    );
  } finally {
    await f.close();
  }
});

test('Stop during simulation prevents the actual EIP-1193 send and durably pauses later steps', async () => {
  const f = await setup();
  try {
    await f.controller.deposit('AMZN', '1000000');
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    f.simulation(async () => {
      entered.resolve();
      await release.promise;
    });
    const confirming = f.controller.confirm();
    await entered.promise;
    await f.controller.stop('AMZN');
    release.resolve();
    await assert.rejects(confirming, /VAULT_RUN_STEP_CHANGED/);
    assert.equal(f.sent.size, 0);
    assert.equal(f.store.get(OWNER, 'AMZN').paused, true);
    assert.equal(f.reviews.filter((r) => r.kind === 'BUY').length, 0);
  } finally {
    await f.close();
  }
});

test('approval, deposit and a single purchase each require confirmation and only invest the new deposit', async () => {
  const f = await setup({ approval: true });
  try {
    await f.controller.deposit('AMZN', '25000000');
    assert.equal(f.sent.size, 0);
    await f.controller.confirm();
    assert.equal(f.sent.size, 1);
    const approval = tokenInterface.parseTransaction([...f.sent.values()][0]!)!;
    assert.equal(approval.name, 'approve');
    assert.equal(approval.args[0].toLowerCase(), VAULT.toLowerCase());
    assert.equal(String(approval.args[1]), '25000000');
    assert.equal(f.observations.get('AMZN')!.cashRaw, '9000000');
    f.complete();
    await f.controller.recover('AMZN');
    assert.equal(f.client.state.quote!.allowance, null);
    await f.controller.confirm();
    assert.equal(f.sent.size, 2);
    f.complete();
    await f.controller.recover('AMZN');
    assert.deepEqual(f.reviews.at(-1), { kind: 'BUY', strategy: 'AMZN', amount: '25000000' });
    assert.equal(f.sent.size, 2, 'the purchase is reviewed, not silently sent');
    await f.controller.confirm();
    assert.equal(f.sent.size, 3);
    f.complete();
    await f.controller.recover('AMZN');
    assert.equal(f.store.get(OWNER, 'AMZN').action!.phase, 'HOLDING');
    assert.equal(
      f.observations.get('AMZN')!.cashRaw,
      '9000000',
      'existing idle cash is not swept into the purchase',
    );
    assert.equal(f.observations.get('AMZN')!.positionRaw, '100000000000000000');
    await f.controller.recover('AMZN');
    assert.equal(f.sent.size, 3);
  } finally {
    await f.close();
  }
});

test('full Withdraw sells all shares before closing and releasing every locked PASS after a loss', async () => {
  const f = await setup({ cash: '0', position: '200000000000000000', locked: '60000000000000000000' });
  try {
    await f.controller.withdraw('AMZN');
    assert.deepEqual(f.reviews.at(-1), { kind: 'SELL', strategy: 'AMZN', amount: '200000000000000000' });
    await f.controller.confirm();
    f.complete();
    await f.controller.recover('AMZN');
    assert.deepEqual(f.reviews.at(-1), { kind: 'CLOSE', strategy: 'AMZN', amount: '0' });
    assert.equal(f.payouts.cash, 0n);
    assert.equal(f.payouts.pass, 0n);
    await f.controller.confirm();
    f.complete();
    await f.controller.recover('AMZN');
    assert.equal(f.store.get(OWNER, 'AMZN').action!.phase, 'CLOSED');
    assert.equal(f.payouts.cash, 50_000_000n);
    assert.equal(f.payouts.pass, 60n * 10n ** 18n);
    assert.equal(f.observations.get('AMZN')!.lockedPassRaw, '0');
  } finally {
    await f.close();
  }
});

test('a wrong wallet response cannot create a review or wallet transaction', async () => {
  const f = await setup();
  try {
    f.corruptOwner();
    await assert.rejects(f.controller.deposit('AMZN', '1000000'), /VAULT_RUN_RESPONSE_INVALID/);
    assert.equal(f.reviews.length, 0);
    assert.equal(f.sent.size, 0);
    assert.equal(f.store.get(OWNER, 'AMZN').action, null);
  } finally {
    await f.close();
  }
});

test('missing verified reference blocks funding before a review or any wallet request', async () => {
  const f = await setup({ source: false });
  try {
    await assert.rejects(f.controller.deposit('AMZN', '1000000'), /STOCK_REFERENCE_NOT_CONFIGURED/);
    assert.equal(f.reviews.length, 0);
    assert.equal(f.sent.size, 0);
    assert.equal(f.store.get(OWNER, 'AMZN').revision, 0);
    assert.match(f.controller.state.error!, /Verified market data/);
  } finally {
    await f.close();
  }
});

test('AMZN recovery selects its unfinished action rather than an old terminal TSLA action', async () => {
  const f = await setup();
  try {
    const old = f.store.stop(OWNER, 'TSLA', 0, NOW);
    f.store.planStop(OWNER, 'TSLA', old.revision, f.observations.get('TSLA')!, NOW);
    await f.controller.refresh();
    await f.controller.deposit('AMZN', '1000000');
    await f.controller.stop('AMZN');
    await f.controller.deposit('AMZN', '2000000');
    await f.controller.refresh();
    const start = f.requests.length;
    await f.controller.recover('AMZN');
    assert.equal(f.controller.state.flow!.strategyId, 'AMZN');
    assert.deepEqual(f.reviews.at(-1), { kind: 'DEPOSIT', strategy: 'AMZN', amount: '2000000' });
    assert.equal(
      f.requests.slice(start).some((r) => r.path.includes('/TSLA')),
      false,
    );
    assert.equal(f.sent.size, 0);
  } finally {
    await f.close();
  }
});

test('a reopened page reviews the remaining purchase after a confirmed deposit without resending the deposit', async () => {
  const f = await setup();
  try {
    await f.controller.deposit('AMZN', '2000000');
    await f.controller.confirm();
    f.complete();
    const previous = f.store.get(OWNER, 'AMZN');
    const reconciled = await f.app.inject({
      url: '/api/launch-market/vault-run/AMZN/reconcile',
      method: 'POST',
      headers: { authorization: OWNER, origin, 'x-csrf-token': 'fixture-csrf-token' },
      payload: { expectedRevision: previous.revision },
    });
    assert.equal(reconciled.statusCode, 200);
    assert.equal(f.store.get(OWNER, 'AMZN').action!.step, 'BUY');
    const reopened = new VaultActionsController(f.client, {
      api: async <T>(path: string, method = 'GET', body?: unknown) => {
        const response = await f.app.inject({
          url: path,
          method: method as 'GET' | 'POST',
          headers: { authorization: OWNER, origin, 'x-csrf-token': 'fixture-csrf-token' },
          ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
        });
        if (response.statusCode !== 200) throw new Error(response.json().error);
        return response.json() as T;
      },
    });
    await reopened.refresh();
    assert.equal(reopened.state.flow!.phase, 'READY');
    const sends = f.sent.size;
    await reopened.recover('AMZN');
    assert.deepEqual(f.reviews.at(-1), { kind: 'BUY', strategy: 'AMZN', amount: '2000000' });
    assert.equal(f.sent.size, sends);
    await reopened.confirm();
    assert.equal(f.sent.size, sends + 1);
    assert.equal(stockExecutionInterface.parseTransaction([...f.sent.values()].at(-1)!)!.name, 'execute');
  } finally {
    await f.close();
  }
});
