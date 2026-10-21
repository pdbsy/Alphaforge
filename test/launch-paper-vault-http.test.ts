import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { LaunchMarketError } from '../packages/launch-market/src/types.ts';
import {
  PaperLedger,
  type PaperFundingProof,
  type PaperExecutionPrice,
} from '../packages/launch-market/src/paper-ledger.ts';
import {
  VaultRunStore,
  type VaultRunObservation,
  type VaultRunReceipt,
  type VaultRunState,
} from '../packages/launch-market/src/vault-run.ts';
import { VaultReferenceDemand } from '../apps/server/src/launch-market-adapters/vault-reference-demand.ts';
import {
  registerVaultRunRoutes,
  reconcileVaultRun,
  type VaultRunRoutesOptions,
} from '../apps/server/src/launch-market/vault-run-routes.ts';
import {
  registerPaperVaultRoutes,
  type PaperValueQuote,
} from '../apps/server/src/launch-market/paper-vault-routes.ts';
const owner = '0x' + '11'.repeat(20),
  other = '0x' + '22'.repeat(20),
  vault = '0x' + '33'.repeat(20),
  h = '0x' + '44'.repeat(32),
  tx = '0x' + '55'.repeat(32),
  closeTx = '0x' + '66'.repeat(32),
  origin = 'https://paper.example.test';
const actionId = 'paper_deposit_http_0001';
const price = (now: number): PaperExecutionPrice => ({
  sourceId: 'ALPACA_IEX',
  sourceAuthorized: true,
  strategyId: 'TSLA',
  priceRaw: '100000000',
  observedAt: now,
  expiresAt: now + 30,
  fetchedAt: now,
  marketState: 'OPEN',
});
async function fixture() {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } }),
    store = new VaultRunStore(':memory:', { origin, manifestDigest: h }),
    ledger = new PaperLedger(':memory:', { origin, manifestDigest: h });
  let now = 1000,
    configured = true,
    closedSession = false,
    full = false,
    stopDuringQuote = false,
    reorgDuringValue = false,
    pollDuringValue = false,
    reorgDuringEntry = false,
    indexKnown = true,
    blockHash = h;
  let currentQuote: PaperValueQuote | null = null;
  let observationReads = 0;
  let observed: VaultRunObservation = {
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
    blockHash: h,
    confirmations: 3,
  };
  const resolver = async (request: { method: string; headers: Record<string, unknown> }) => {
    if (!['owner', 'other'].includes(String(request.headers.authorization))) return null;
    if (request.method === 'POST' && request.headers['x-csrf-token'] !== 'local-csrf')
      throw new LaunchMarketError('INVALID_CSRF_TOKEN', 403);
    return {
      id: 'account',
      accountKey: 'account',
      wallet: request.headers.authorization === 'owner' ? owner : other,
      email: null,
    };
  };
  const canonicalAnchor = () => ({ known: indexKnown, blockHash });
  const readPrice = async () => {
    if (reorgDuringEntry) blockHash = '0x' + '88'.repeat(32);
    if (stopDuringQuote) {
      const s = store.get(owner, 'TSLA');
      store.stop(owner, 'TSLA', s.revision, now);
    }
    return configured && !closedSession ? price(now) : null;
  };
  const funding = (state: VaultRunState): PaperFundingProof => ({
    kind: state.action!.step === 'CLOSE' ? 'CLOSE' : 'DEPOSIT',
    chainId: 46630,
    owner,
    strategyId: 'TSLA',
    vault,
    transactionHash: state.action!.pending!.transactionHash!,
    logIndex: 1,
    blockNumber: observed.blockNumber,
    blockHash: h,
    blockTimestamp: now - 5,
    confirmations: 3,
    amountRaw: '100000000',
    passRaw: '100000000000000000000',
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof LaunchMarketError) return reply.code(error.status).send({ error: error.code });
    return reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: 'REJECTED' });
  });
  const workflowOptions: VaultRunRoutesOptions = {
    origin,
    store,
    demand: new VaultReferenceDemand({ sourceConfigured: false, keeperConfigured: false }),
    resolveAccount: resolver,
    readObservation: async (wallet) => {
      observationReads++;
      return { ...observed, owner: wallet };
    },
    qualifyTransaction: async () => {},
    readReceipt: async (state): Promise<VaultRunReceipt> => ({
      status: 'CONFIRMED',
      transactionHash: state.action!.pending!.transactionHash!,
      blockNumber: observed.blockNumber,
      blockHash: h,
      confirmations: 3,
    }),
    consumeRate: () => {},
    canWrite: () => !full,
    now: () => now,
    paper: {
      ledger,
      readPrice,
      readFundingProof: async (state) => funding(state),
      canonicalAnchor,
      referenceStatus: () => ({
        quotes: {
          TSLA: closedSession
            ? {
                ...price(now),
                marketState: 'CLOSED',
                status: 'MARKET_CLOSED',
                priceRaw: null,
                sourceAuthorized: configured,
              }
            : undefined,
        },
      }),
    },
  };
  registerVaultRunRoutes(app, workflowOptions);

  registerPaperVaultRoutes(app, {
    ledger,
    store,
    resolveAccount: resolver,
    consumeRate: () => {},
    now: () => now,
    canonicalAnchor,
    readReal: async (wallet, _id, opts) => {
      // Mirrors readStableHistory waiting for an in-flight normal scan.
      if (pollDuringValue) indexKnown = true;
      if (opts.vault && opts.vault !== vault) throw new LaunchMarketError('PAPER_VAULT_NOT_OWNED', 403);
      if (wallet !== owner)
        return {
          vault: null,
          principalRaw: '0',
          cashRaw: '0',
          withdrawableRaw: '0',
          lockedPassRaw: '0',
          observedAt: now,
          blockNumber: observed.blockNumber,
          blockHash: h,
          confirmations: 3,
        };
      return {
        vault,
        principalRaw: observed.closed ? '0' : observed.cashRaw,
        cashRaw: observed.cashRaw,
        withdrawableRaw: observed.cashRaw,
        lockedPassRaw: observed.lockedPassRaw,
        observedAt: now,
        blockNumber: observed.blockNumber,
        blockHash: h,
        confirmations: 3,
      };
    },
    readMarket: async () => {
      if (pollDuringValue) indexKnown = false;
      if (reorgDuringValue) blockHash = '0x' + '77'.repeat(32);
      const q = currentQuote ?? {
        ...price(now),
        status: configured ? 'READY' : 'NOT_CONFIGURED',
        priceRaw: configured ? '100000000' : null,
        sourceAuthorized: configured,
        sourceId: configured ? 'ALPACA_IEX' : null,
        lastKnownPriceRaw: null,
        lastKnownObservedAt: null,
      };
      return {
        quotes: { TSLA: q as PaperValueQuote, AMZN: { ...q, strategyId: 'AMZN' } as PaperValueQuote },
      };
    },
  });
  const call = (
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url: '/api/launch-market/' + path,
      headers: { origin, authorization: 'owner', 'x-csrf-token': 'local-csrf', ...headers },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const setup = async () => {
    let response = await call('POST', 'vault-run/TSLA/deposit', {
      actionId,
      expectedRevision: store.get(owner, 'TSLA').revision,
      amountRaw: '100000000',
    });
    assert.equal(response.statusCode, 200);
    let s = response.json() as VaultRunState;
    response = await call('POST', 'vault-run/TSLA/prepare', {
      actionId,
      expectedRevision: s.revision,
      step: 'DEPOSIT',
    });
    assert.equal(response.statusCode, 200);
    s = response.json();
    response = await call('POST', 'vault-run/TSLA/submitted', {
      actionId,
      expectedRevision: s.revision,
      step: 'DEPOSIT',
      transactionHash: tx,
    });
    assert.equal(response.statusCode, 200);
    observed = {
      ...observed,
      blockNumber: '101',
      cashRaw: '100000000',
      lockedPassRaw: '100000000000000000000',
    };
    return response.json() as VaultRunState;
  };
  return {
    app,
    background: (state: VaultRunState) =>
      reconcileVaultRun(workflowOptions, state.owner, state.strategyId, state.revision),
    store,
    ledger,
    get observationReads() {
      return observationReads;
    },
    call,
    setup,
    get observed() {
      return observed;
    },
    set observed(v) {
      observed = v;
    },
    marketClosed(v = true) {
      closedSession = v;
    },
    configure(v: boolean) {
      configured = v;
    },
    full() {
      full = true;
    },
    stopDuringQuote() {
      stopDuringQuote = true;
    },
    reorgDuringEntry() {
      reorgDuringEntry = true;
    },
    pollDuringValue() {
      pollDuringValue = true;
    },
    reorgDuringValue() {
      reorgDuringValue = true;
    },
    clock(v: number) {
      now = v;
    },
    quote(v: PaperValueQuote) {
      currentQuote = v;
    },
    indexDown() {
      indexKnown = false;
    },
    close: async () => {
      await app.close();
      store.close();
      ledger.close();
    },
  };
}
test('paper admission fails before funding without authorized price; routes isolate selected identities and reject owner/proof input', async () => {
  const f = await fixture();
  try {
    f.configure(false);
    assert.equal(
      (
        await f.call('POST', 'vault-run/TSLA/deposit', {
          actionId,
          expectedRevision: 0,
          amountRaw: '100000000',
        })
      ).statusCode,
      503,
    );
    assert.equal(f.store.get(owner, 'TSLA').revision, 0);
    assert.equal(
      (
        await f.call(
          'POST',
          'vault-run/TSLA/deposit',
          { actionId, expectedRevision: 0, amountRaw: '100000000' },
          { 'x-csrf-token': '' },
        )
      ).statusCode,
      403,
    );
    assert.equal((await f.call('GET', 'vault-values/TSLA?owner=' + other)).statusCode, 400);
    assert.equal((await f.call('GET', 'vault-values/TSLA?vault=' + other)).statusCode, 403);
    const response = await f.call('GET', 'vault-values/TSLA');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().paper.profitRaw, null);
    assert.deepEqual(response.json().paper.curve, []);
    assert.equal(
      (await f.call('GET', 'vault-values/TSLA', undefined, { authorization: '' })).statusCode,
      401,
    );
    assert.equal(
      (await f.call('GET', 'vault-values/TSLA', undefined, { authorization: 'other' })).json().paper.status,
      'EMPTY',
    );
  } finally {
    await f.close();
  }
});
test('confirmed Deposit becomes paper pending when quote fails, later fresh fill needs no wallet and Stop during retry cannot revive it', async () => {
  const f = await fixture();
  try {
    let s = await f.setup();
    f.configure(false);
    let response = await f.call('POST', 'vault-run/TSLA/reconcile', { expectedRevision: s.revision });
    assert.equal(response.statusCode, 200);
    s = response.json();
    assert.equal(s.action!.phase, 'PAPER_PENDING');
    assert.equal(s.action!.step, null);
    assert.equal(s.action!.pending, null);
    f.clock(2000);
    f.configure(true);
    response = await f.call('POST', 'vault-run/TSLA/reconcile', { expectedRevision: s.revision });
    assert.equal(response.statusCode, 200);
    s = response.json();
    assert.equal(s.action!.phase, 'HOLDING');
    assert.equal(s.action!.executionMode, 'PAPER');
    assert.equal(f.ledger.book(owner, 'TSLA', vault, price(2000), 2000).quantityRaw, '1000000000000000000');
    assert.equal(
      (
        await f.call('POST', 'vault-run/TSLA/prepare', {
          actionId,
          expectedRevision: s.revision,
          step: 'BUY',
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
  const stopped = await fixture();
  try {
    let s = await stopped.setup();
    stopped.configure(false);
    s = (await stopped.call('POST', 'vault-run/TSLA/reconcile', { expectedRevision: s.revision })).json();
    stopped.configure(true);
    stopped.stopDuringQuote();
    assert.equal(
      (await stopped.call('POST', 'vault-run/TSLA/reconcile', { expectedRevision: s.revision })).statusCode,
      409,
    );
    assert.equal(stopped.store.get(owner, 'TSLA').paused, true);
    assert.equal(stopped.ledger.book(owner, 'TSLA', vault, null, 1000).quantityRaw, '0');
  } finally {
    await stopped.close();
  }
});
test('withdrawal bypasses new-intake quota and price outage, returns only actual cash and leaves simulated exit settlement pending', async () => {
  const f = await fixture();
  try {
    let s = await f.setup();
    s = (await f.call('POST', 'vault-run/TSLA/reconcile', { expectedRevision: s.revision })).json();
    f.configure(false);
    f.full();
    let response = await f.call('POST', 'vault-run/TSLA/withdraw', {
      actionId: 'paper_close_http_0001',
      expectedRevision: s.revision,
    });
    assert.equal(response.statusCode, 200);
    s = response.json();
    assert.equal(s.action!.step, 'CLOSE');
    s = (
      await f.call('POST', 'vault-run/TSLA/prepare', {
        actionId: s.action!.actionId,
        expectedRevision: s.revision,
        step: 'CLOSE',
      })
    ).json();
    s = (
      await f.call('POST', 'vault-run/TSLA/submitted', {
        actionId: s.action!.actionId,
        expectedRevision: s.revision,
        step: 'CLOSE',
        transactionHash: closeTx,
      })
    ).json();
    f.observed = { ...f.observed, closed: true, blockNumber: '103', cashRaw: '0', lockedPassRaw: '0' };
    response = await f.call('POST', 'vault-run/TSLA/reconcile', { expectedRevision: s.revision });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().action.phase, 'CLOSED');
    const value = (await f.call('GET', 'vault-values/TSLA?vault=' + vault)).json();
    assert.equal(value.real.withdrawableRaw, '0');
    assert.equal(value.paper.status, 'SETTLEMENT_PENDING');
    assert.equal(value.paper.realizedRaw, null);
  } finally {
    await f.close();
  }
});
test('closed last-known price keeps its old timestamp, persisted mark is stale after cache reset, and a reorg during quote read rejects mixed-fork value', async () => {
  const f = await fixture();
  try {
    const s = await f.setup();
    await f.call('POST', 'vault-run/TSLA/reconcile', { expectedRevision: s.revision });
    f.ledger.recordMark(price(1000), 1000);
    f.clock(2000);
    f.quote({
      ...price(2000),
      status: 'MARKET_CLOSED',
      marketState: 'CLOSED',
      priceRaw: null,
      lastKnownPriceRaw: '90000000',
      lastKnownObservedAt: 1000,
    });
    let response = await f.call('GET', 'vault-values/TSLA');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().paper.priceObservedAt, 1000);
    assert.equal(response.json().paper.profitRaw, '-10000000');
    assert.equal(response.json().paper.realizedRaw, '0');
    f.quote({
      ...price(2000),
      status: 'NOT_CONFIGURED',
      sourceId: null,
      sourceAuthorized: false,
      priceRaw: null,
      lastKnownPriceRaw: null,
      lastKnownObservedAt: null,
    });
    response = await f.call('GET', 'vault-values/TSLA');
    assert.equal(response.json().paper.quoteStatus, 'STALE');
    assert.equal(response.json().paper.priceObservedAt, 1000);
    f.reorgDuringValue();
    assert.equal((await f.call('GET', 'vault-values/TSLA')).statusCode, 503);
  } finally {
    await f.close();
  }
});

test('trusted shared reconciliation consumes only known PAPER funding outcomes and can complete a delayed paper fill without a browser', async () => {
  const f = await fixture();
  try {
    let s = await f.setup();
    let legacy = f.store.begin(
      other,
      'AMZN',
      'DEPOSIT',
      'legacy_action_paper_0001',
      0,
      '100000000',
      { ...f.observed, owner: other, strategyId: 'AMZN' },
      1000,
    );
    legacy = f.store.prepare(
      other,
      'AMZN',
      legacy.action!.actionId,
      legacy.revision,
      'DEPOSIT',
      { ...f.observed, owner: other, strategyId: 'AMZN' },
      1000,
    );
    f.store.submitted(
      other,
      'AMZN',
      legacy.action!.actionId,
      legacy.revision,
      'DEPOSIT',
      closeTx,
      true,
      1000,
    );
    assert.deepEqual(
      f.store.pendingPaperRuns(20).map((r) => r.owner),
      [owner],
    );
    assert.equal(f.store.pendingPaperRuns(20, { owner, strategyId: 'TSLA' }).length, 0);
    f.configure(false);
    s = await f.background(s);
    assert.equal(s.action!.phase, 'PAPER_PENDING');
    assert.equal(f.store.pendingPaperRuns(20).length, 1);
    f.clock(3000);
    f.configure(true);
    s = await f.background(s);
    assert.equal(s.action!.phase, 'HOLDING');
    assert.equal(f.store.pendingPaperRuns(20).length, 0);
    assert.equal(f.ledger.book(owner, 'TSLA', vault, price(3000), 3000).history[1]!.at, 3000);
  } finally {
    await f.close();
  }
});

test('an indexed reorg during a pending entry price await freezes the orphaned proof before any fill', async () => {
  const f = await fixture();
  try {
    let s = await f.setup();
    f.configure(false);
    s = await f.background(s);
    assert.equal(s.action!.phase, 'PAPER_PENDING');
    f.configure(true);
    f.reorgDuringEntry();
    await assert.rejects(() => f.background(s), /PAPER_REORG_REVIEW_REQUIRED/);
    assert.equal(f.ledger.hasEntry(s.action!.actionId), false);
    assert.equal(f.ledger.book(owner, 'TSLA', vault, price(1000), 1000).status, 'REORG_REVIEW_REQUIRED');
    assert.equal(f.ledger.book(owner, 'TSLA', vault, price(1000), 1000).profitRaw, null);
  } finally {
    await f.close();
  }
});

test('workflow state recovery stays wallet-private and never reads custody or requests a stock price', async () => {
  const f = await fixture();
  try {
    f.configure(false);
    const response = await f.call('GET', 'vault-run/TSLA/state');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().owner, owner);
    assert.equal(response.json().executionMode, 'PAPER');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(f.observationReads, 0);
    assert.equal(
      (await f.call('GET', 'vault-run/TSLA/state', undefined, { authorization: '' })).statusCode,
      401,
    );
    assert.equal((await f.call('GET', 'vault-run/TSLA/state?owner=' + other)).statusCode, 400);
    const otherState = await f.call('GET', 'vault-run/TSLA/state', undefined, { authorization: 'other' });
    assert.equal(otherState.statusCode, 200);
    assert.equal(otherState.json().owner, other);
    assert.equal(f.observationReads, 0);
  } finally {
    await f.close();
  }
});

test('an orphaned simulation cannot admit new money even when no canonical funding anchor remains', async () => {
  const f = await fixture();
  try {
    const prepared = await f.setup();
    const confirmed = await f.call('POST', 'vault-run/TSLA/reconcile', {
      expectedRevision: prepared.revision,
    });
    assert.equal(confirmed.statusCode, 200);
    const state = confirmed.json() as VaultRunState;
    const anchor = f.ledger.anchors(owner, 'TSLA')[0]!;
    f.ledger.setCanonical(anchor.proofId, null);
    const deposit = await f.call('POST', 'vault-run/TSLA/deposit', {
      actionId: 'next-deposit-after-orphan',
      expectedRevision: state.revision,
      amountRaw: '1000000',
    });
    assert.equal(deposit.statusCode, 503);
    assert.equal(deposit.json().error, 'PAPER_REORG_REVIEW_REQUIRED');
    assert.equal(f.store.get(owner, 'TSLA').revision, state.revision);
    const withdraw = await f.call('POST', 'vault-run/TSLA/withdraw', {
      actionId: 'withdraw-after-orphan-proof',
      expectedRevision: state.revision,
    });
    assert.equal(withdraw.statusCode, 200);
    assert.equal(withdraw.json().action.step, 'CLOSE');
  } finally {
    await f.close();
  }
});

test('a closed-session deposit queues confirmed funding and the server fills once after opening without a browser', async () => {
  const f = await fixture();
  try {
    f.marketClosed();
    let state = await f.setup();
    state = await f.background(state);
    assert.equal(state.action!.phase, 'PAPER_PENDING');
    assert.equal(f.ledger.hasEntry(actionId), false);
    assert.equal(f.ledger.book(owner, 'TSLA', vault, null, 1000).quantityRaw, '0');
    assert.equal(f.store.pendingPaperRuns().length, 1);
    assert.equal((await f.background(state)).revision, state.revision);
    const extra = await f.call('POST', 'vault-run/TSLA/deposit', {
      actionId: 'another_closed_deposit_0001',
      expectedRevision: state.revision,
      amountRaw: '100000000',
    });
    assert.equal(extra.statusCode, 409);
    f.marketClosed(false);
    f.clock(2000);
    state = await f.background(f.store.pendingPaperRuns()[0]!);
    assert.equal(state.action!.phase, 'HOLDING');
    assert.equal(f.store.pendingPaperRuns().length, 0);
    assert.equal(
      f.ledger.book(owner, 'TSLA', vault, price(2000), 2000).history.filter((e) => e.kind === 'ENTRY').length,
      1,
    );
    await assert.rejects(f.background(state), /VAULT_RUN_NO_PENDING_TRANSACTION/);
    assert.equal(
      f.ledger.book(owner, 'TSLA', vault, price(2000), 2000).history.filter((e) => e.kind === 'ENTRY').length,
      1,
    );
  } finally {
    await f.close();
  }
});

for (const action of ['stop', 'withdraw'] as const)
  test(`${action} cancels a closed-session queued entry before market opening`, async () => {
    const f = await fixture();
    try {
      f.marketClosed();
      const state = await f.background(await f.setup());
      const response = await f.call('POST', `vault-run/TSLA/${action}`, {
        expectedRevision: state.revision,
        ...(action === 'withdraw' ? { actionId: 'closed_market_withdraw_0001' } : {}),
      });
      assert.equal(response.statusCode, 200);
      assert.equal(f.store.get(owner, 'TSLA').paused, true);
      assert.equal(f.store.pendingPaperRuns().length, 0);
      if (action === 'withdraw') assert.equal(response.json().action.step, 'CLOSE');
      f.marketClosed(false);
      await assert.rejects(f.background(f.store.get(owner, 'TSLA')), /VAULT_RUN_NO_PENDING_TRANSACTION/);
      assert.equal(f.ledger.hasEntry(actionId), false);
    } finally {
      await f.close();
    }
  });

test('an unauthorized closed session still refuses funding', async () => {
  const f = await fixture();
  try {
    f.marketClosed();
    f.configure(false);
    assert.equal(
      (
        await f.call('POST', 'vault-run/TSLA/deposit', {
          actionId,
          expectedRevision: 0,
          amountRaw: '100000000',
        })
      ).statusCode,
      503,
    );
    assert.equal(f.store.get(owner, 'TSLA').revision, 0);
  } finally {
    await f.close();
  }
});

test('a scan starting during the market read cannot invalidate an otherwise stable empty Vault value', async () => {
  const f = await fixture();
  try {
    f.pollDuringValue();
    const response = await f.call('GET', 'vault-values/TSLA');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().vault, vault);
    assert.equal(response.json().real.cashRaw, '0');
    assert.equal(response.json().paper.status, 'EMPTY');
  } finally {
    await f.close();
  }
});
