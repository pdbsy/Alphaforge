import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VaultActionsController,
  type VaultActionsClient,
} from '../apps/web/src/launch-market/vault-actions.ts';
import type { LaunchClientState, StrategyId } from '../apps/web/src/launch-market/model.ts';
import type { CommunityApi } from '../apps/web/src/community/client.ts';
import { account, config, wallet, snapshot, quote, OWNER } from './helpers/launch-market-ui-fixture.ts';

function setup({
  authorized = true,
  approval = false,
  pendingPaper = false,
  createFirst = false,
  approvalCount = -1,
} = {}) {
  type Action = {
    executionMode?: 'PAPER' | 'CHAIN';
    actionId: string;
    kind: 'DEPOSIT' | 'STOP' | 'WITHDRAW';
    amountRaw: string;
    step: 'CREATE' | 'DEPOSIT' | 'BUY' | 'CLOSE' | null;
    stepAmountRaw: string;
    phase: string;
    cancelled: boolean;
    prepared: boolean;
    pending: { transactionHash: string; verified: boolean } | null;
    failure: string | null;
    expectedVersion: string | null;
  };
  const blank = (strategyId: StrategyId) => ({
    schemaVersion: 1 as const,
    executionMode: 'PAPER' as const,
    owner: OWNER,
    strategyId,
    vault: '0x3333333333333333333333333333333333333333',
    paused: false,
    revocationRequired: false,
    revision: 0,
    action: null as Action | null,
    updatedAt: 1792000000,
  });
  const runs = { TSLA: blank('TSLA'), AMZN: blank('AMZN') };
  if (pendingPaper)
    runs.TSLA.action = {
      executionMode: 'PAPER',
      actionId: 'confirmed-deposit-awaiting-price',
      kind: 'DEPOSIT',
      amountRaw: '10000000',
      stepAmountRaw: '0',
      step: null,
      phase: 'PAPER_PENDING',
      cancelled: false,
      prepared: false,
      pending: null,
      failure: null,
      expectedVersion: null,
    };
  let state: LaunchClientState = {
    enabled: true,
    owner: OWNER,
    account: account(),
    config: config(),
    wallet: wallet(),
    snapshot: snapshot(),
    connecting: false,
    busy: false,
    quote: null,
    quoteRequest: null,
    error: null,
    notice: null,
    transaction: { state: 'IDLE', owner: null, hash: null, id: null, approval: false, confirmations: 0 },
  };
  const listeners = new Set<(value: LaunchClientState) => void>();
  const update = (patch: Partial<LaunchClientState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(structuredClone(state));
  };
  let guard: (() => Promise<void>) | null = null,
    walletSends = 0,
    stockCalls = 0,
    chainRefreshes = 0,
    transactionRefreshes = 0,
    quoteReady = authorized,
    delayTransactionCompletion = false,
    approvalsRemaining = approvalCount < 0 ? (approval ? 1 : 0) : approvalCount;
  let beforeWallet: (() => Promise<void>) | null = null;
  const reviews: { operation: string; amountRaw: string }[] = [];
  const requests: string[] = [];
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
      guard = value;
    },
    async review(request) {
      reviews.push({ operation: request.operation, amountRaw: request.amountRaw });
      const quoted = quote({ ...request, owner: OWNER });
      update({
        quote: {
          ...quoted,
          allowance:
            approvalsRemaining > 0 && request.operation === 'DEPOSIT'
              ? {
                  token:
                    approvalsRemaining > 1
                      ? config().manifest!.usdc
                      : config().manifest!.strategies.TSLA.pass,
                  spender: runs.TSLA.vault,
                  amountRaw: request.amountRaw,
                }
              : null,
        },
      });
    },
    async confirm() {
      await beforeWallet?.();
      await guard?.();
      const approving = state.quote?.allowance != null;
      walletSends++;
      if (approving) approvalsRemaining--;
      update({
        quote: null,
        transaction: {
          state: 'SUBMITTED',
          hash: `0x${String(walletSends).padStart(64, '0')}`,
          owner: OWNER,
          id: null,
          approval: approving,
          confirmations: 0,
        },
      });
    },
    async refreshTransaction() {
      transactionRefreshes++;
      update({
        transaction: {
          ...state.transaction,
          state: delayTransactionCompletion ? 'INCLUDED' : 'COMPLETED',
          confirmations: delayTransactionCompletion ? 0 : 3,
        },
      });
    },
    async refresh() {
      chainRefreshes++;
    },
    clearQuote() {
      update({ quote: null });
    },
    async refreshStock() {
      stockCalls++;
      throw new Error('Paper entries cannot request chain stock state');
    },
    async reviewStock() {
      stockCalls++;
      throw new Error('Paper entries cannot prepare stock transactions');
    },
    async reviewExecutorPermission() {
      throw new Error('No executor exists in this fixture');
    },
    async confirmExecutorPermission() {
      throw new Error('No executor exists in this fixture');
    },
  };
  const api: CommunityApi = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    requests.push(`${method} ${path}`);
    const match = /^\/api\/launch-market\/vault-run\/(TSLA|AMZN)(?:\/(\w+))?$/.exec(path);
    assert.ok(match, 'Only the owner workflow endpoint may be used');
    const run = runs[match[1] as StrategyId],
      action = match[2];
    if (method === 'POST') {
      const input = body as {
        actionId?: string;
        amountRaw?: string;
        transactionHash?: string;
        expectedRevision?: number;
      };
      if (input.expectedRevision !== undefined && input.expectedRevision !== run.revision)
        throw new Error('VAULT_RUN_REVISION_CONFLICT');
      if (action === 'deposit' && !quoteReady) throw new Error('PAPER_PRICE_UNAVAILABLE');
      run.revision++;
      if (action === 'deposit' || action === 'withdraw') {
        run.action = {
          executionMode: 'PAPER',
          actionId: input.actionId!,
          kind: action === 'deposit' ? 'DEPOSIT' : 'WITHDRAW',
          amountRaw: input.amountRaw ?? '0',
          stepAmountRaw: action === 'deposit' && createFirst ? '0' : (input.amountRaw ?? '0'),
          step: action === 'deposit' ? (createFirst ? 'CREATE' : 'DEPOSIT') : 'CLOSE',
          phase: 'READY',
          cancelled: false,
          prepared: false,
          pending: null,
          failure: null,
          expectedVersion: null,
        };
      } else if (action === 'stop') {
        run.paused = true;
        if (run.action)
          Object.assign(run.action, { phase: 'STOPPED', prepared: false, step: null, cancelled: true });
        return { state: structuredClone(run), automationPaused: true, revocationObserved: true } as T;
      } else if (action === 'prepare') {
        Object.assign(run.action!, { phase: 'AWAITING_WALLET', prepared: true });
      } else if (action === 'submitted') {
        Object.assign(run.action!, {
          phase: 'SUBMITTED',
          prepared: false,
          pending: { transactionHash: input.transactionHash!, verified: true },
        });
      } else if (action === 'reconcile') {
        Object.assign(run.action!, {
          phase:
            run.action!.step === 'CREATE'
              ? 'READY'
              : run.action!.kind === 'WITHDRAW'
                ? 'CLOSED'
                : quoteReady
                  ? 'HOLDING'
                  : 'PAPER_PENDING',
          pending: null,
          stepAmountRaw: run.action!.amountRaw,
          step: run.action!.step === 'CREATE' ? 'DEPOSIT' : null,
          prepared: false,
        });
      } else if (action === 'rejected') {
        Object.assign(run.action!, { phase: 'FAILED', pending: null, prepared: false });
      } else throw new Error(`Unexpected workflow request ${action}`);
    }
    return structuredClone(run) as T;
  };
  const scheduled: { callback: () => void; delay: number; cancelled: boolean; fired: boolean }[] = [];
  const controller = new VaultActionsController(client, {
    api,
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false, fired: false };
      scheduled.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  return {
    controller,
    runs,
    reviews,
    requests,
    get walletSends() {
      return walletSends;
    },
    get stockCalls() {
      return stockCalls;
    },
    get chainRefreshes() {
      return chainRefreshes;
    },
    get transactionRefreshes() {
      return transactionRefreshes;
    },
    scheduled,
    setTrackerLag(lag: boolean) {
      delayTransactionCompletion = lag;
    },
    switchOwner() {
      update({ owner: '0x2222222222222222222222222222222222222222' });
    },
    setQuoteReady(value: boolean) {
      quoteReady = value;
    },
    async fireNext() {
      const timer = scheduled.find((value) => !value.cancelled && !value.fired);
      assert.ok(timer);
      timer.fired = true;
      timer.callback();
      for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    },
    delayBeforeWallet(value: () => Promise<void>) {
      beforeWallet = value;
    },
  };
}

test('missing authorized prices reject a new Deposit before any wallet review or send', async () => {
  const f = setup({ authorized: false });
  await assert.rejects(f.controller.deposit('TSLA', '10000000'), /PAPER_PRICE_UNAVAILABLE/);
  assert.equal(f.walletSends, 0);
  assert.deepEqual(f.reviews, []);
  assert.equal(f.stockCalls, 0);
  assert.match(f.controller.state.error!, /Authorized market data is not ready/);
});

test('approval then exact Deposit becomes a server-recorded holding without a stock wallet request', async () => {
  const f = setup({ approval: true });
  await f.controller.deposit('TSLA', '10000001');
  await f.controller.confirm();
  await f.controller.recover('TSLA');
  await f.controller.confirm();
  await f.controller.recover('TSLA');
  assert.deepEqual(f.reviews, [
    { operation: 'DEPOSIT', amountRaw: '10000001' },
    { operation: 'DEPOSIT', amountRaw: '10000001' },
  ]);
  assert.equal(f.walletSends, 2);
  assert.equal(f.controller.state.flow!.phase, 'HOLDING');
  assert.equal(f.stockCalls, 0);
  assert.equal(
    f.requests.some((path) => /reference|stock|execution/.test(path)),
    false,
  );
});

test('Withdraw uses only actual Vault Close when prices are unavailable and keeps simulated results separate', async () => {
  const f = setup({ authorized: false });
  await f.controller.withdraw('AMZN');
  assert.deepEqual(f.reviews, [{ operation: 'CLOSE', amountRaw: '0' }]);
  await f.controller.confirm();
  await f.controller.recover('AMZN');
  assert.equal(f.walletSends, 1);
  assert.equal(f.stockCalls, 0);
  assert.equal(f.controller.state.flow!.phase, 'CLOSED');
  assert.match(f.controller.state.notice!, /Simulated results remain in the ledger history/);
});

test('a legacy chain BUY action cannot be turned into a new stock wallet request', async () => {
  const f = setup();
  await f.controller.deposit('TSLA', '10000000');
  Object.assign(f.runs.TSLA.action!, { executionMode: 'CHAIN', step: 'BUY' });
  await assert.rejects(f.controller.recover('TSLA'), /PAPER_WORKFLOW_MODE_REQUIRED/);
  assert.equal(f.walletSends, 0);
  assert.equal(f.stockCalls, 0);
});

test('a completed legacy chain result is not presented as a new simulated position', async () => {
  const f = setup();
  await f.controller.deposit('TSLA', '10000000');
  Object.assign(f.runs.TSLA.action!, { executionMode: 'CHAIN', phase: 'HOLDING', step: 'BUY' });
  await f.controller.recover('TSLA');
  assert.equal(f.controller.state.flow!.phase, 'LEGACY_RESULT');
  assert.doesNotMatch(f.controller.state.notice!, /Your simulated stock position is recorded/);
  assert.equal(f.walletSends, 0);
  assert.equal(f.stockCalls, 0);
});

test('Stop while a confirmed review is waiting prevents the subsequent wallet send', async () => {
  const f = setup();
  await f.controller.deposit('TSLA', '10000000');
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  f.delayBeforeWallet(async () => {
    entered.resolve();
    await gate.promise;
  });
  const sending = f.controller.confirm();
  await entered.promise;
  await f.controller.stop('TSLA');
  gate.resolve();
  await assert.rejects(sending, /VAULT_RUN_STEP_CHANGED/);
  assert.equal(f.walletSends, 0);
  assert.equal(f.stockCalls, 0);
});

test('confirmed funding waits every thirty seconds for a paper entry with no wallet reads or sends and Stop cancels the loop', async () => {
  const f = setup({ authorized: false, pendingPaper: true });
  await f.controller.refresh('TSLA');
  assert.equal(f.scheduled[0]!.delay, 30000);
  await f.fireNext();
  assert.equal(f.controller.state.flow!.phase, 'PAPER_PENDING');
  assert.equal(f.scheduled[1]!.delay, 30000);
  f.setQuoteReady(true);
  await f.fireNext();
  assert.equal(f.controller.state.flow!.phase, 'HOLDING');
  assert.equal(f.scheduled.filter((timer) => !timer.cancelled && !timer.fired).length, 0);
  assert.equal(f.walletSends, 0);
  assert.equal(f.chainRefreshes, 0);
  assert.equal(f.transactionRefreshes, 0);
  assert.equal(f.stockCalls, 0);
  assert.equal(f.requests.filter((path) => path.endsWith('/reconcile')).length, 2);
  const stopped = setup({ authorized: false, pendingPaper: true });
  await stopped.controller.refresh('TSLA');
  await stopped.controller.stop('TSLA');
  assert.equal(stopped.controller.state.flow!.phase, 'STOPPED');
  assert.equal(stopped.scheduled[0]!.cancelled, true);
  assert.equal(stopped.scheduled.filter((timer) => !timer.cancelled && !timer.fired).length, 0);
  assert.equal(stopped.walletSends + stopped.chainRefreshes + stopped.transactionRefreshes, 0);
});

test('server-completed paper entry ends the waiting loop after a revision conflict without wallet or chain reads', async () => {
  const f = setup({ pendingPaper: true, authorized: false });
  await f.controller.refresh('TSLA');
  f.runs.TSLA.revision++;
  f.runs.TSLA.action!.phase = 'HOLDING';
  await f.fireNext();
  assert.equal(f.controller.state.flow!.phase, 'HOLDING');
  assert.equal(f.controller.state.error, null);
  assert.equal(f.scheduled.filter((timer) => !timer.cancelled && !timer.fired).length, 0);
  assert.equal(f.walletSends + f.chainRefreshes + f.transactionRefreshes + f.stockCalls, 0);
  assert.ok(f.requests.at(-1)!.endsWith('/state'));
});

test('one Deposit gesture opens creation, both approvals and exact funding wallets in order', async () => {
  const f = setup({ createFirst: true, approvalCount: 2 });
  await f.controller.deposit('TSLA', '10000001', true);
  assert.equal(f.walletSends, 1);
  assert.equal(f.reviews[0]!.operation, 'CREATE_VAULT');
  await f.fireNext();
  assert.equal(f.walletSends, 2);
  await f.fireNext();
  assert.equal(f.walletSends, 3);
  await f.fireNext();
  assert.equal(f.walletSends, 4);
  await f.fireNext();
  assert.equal(f.controller.state.flow!.phase, 'HOLDING');
  assert.deepEqual(
    f.reviews.map((r) => r.amountRaw),
    ['0', '10000001', '10000001', '10000001'],
  );
  assert.equal(f.requests.filter((p) => p.endsWith('/deposit')).length, 1);
  assert.equal(f.stockCalls, 0);
});

test('wallet rejection stops a Deposit sequence and refresh never retries it', async () => {
  const f = setup({ approval: true });
  f.delayBeforeWallet(async () => {
    throw new Error('WALLET_REJECTED');
  });
  await assert.rejects(f.controller.deposit('TSLA', '10000000', true), /WALLET_REJECTED/);
  f.delayBeforeWallet(async () => {});
  await f.controller.refresh('TSLA');
  await f.controller.recover('TSLA');
  assert.equal(f.walletSends, 0);
  assert.equal(f.controller.state.flow!.review, true, 'recovery requires a new explicit gesture');
});

for (const cancel of ['stop', 'identity', 'edit', 'replacement'] as const)
  test(`${cancel} prevents the next automatic wallet request after approval`, async () => {
    const f = setup({ approval: true });
    await f.controller.deposit('TSLA', '10000000', true);
    assert.equal(f.walletSends, 1);
    if (cancel === 'stop') await f.controller.stop('TSLA');
    if (cancel === 'identity') f.switchOwner();
    if (cancel === 'edit') f.controller.cancelWalletSequence();
    if (cancel === 'replacement') f.runs.TSLA.action!.actionId = 'another-device-action';
    if (cancel !== 'identity') await f.fireNext();
    else assert.equal(f.scheduled.filter((t) => !t.cancelled && !t.fired).length, 0);
    assert.equal(f.walletSends, 1);
  });

test('cancelling after preparation but before wallet handoff blocks the request', async () => {
  const f = setup();
  f.delayBeforeWallet(async () => f.controller.cancelWalletSequence());
  await assert.rejects(f.controller.deposit('TSLA', '10000000', true), /VAULT_RUN_STEP_CHANGED/);
  assert.equal(f.walletSends, 0);
  assert.ok(f.requests.some((p) => p.endsWith('/rejected')));
});

test('Deposit resumes the same ready amount without creating a duplicate workflow', async () => {
  const f = setup();
  await f.controller.deposit('TSLA', '10000000');
  await f.controller.refresh('TSLA');
  await f.controller.deposit('TSLA', '10000000', true);
  assert.equal(f.walletSends, 1);
  assert.equal(f.requests.filter((p) => p.endsWith('/deposit')).length, 1);
});

test('a READY next step waits for the transaction tracker without losing the original Deposit intent', async () => {
  const f = setup({ createFirst: true });
  f.setTrackerLag(true);
  await f.controller.deposit('TSLA', '10000000', true);
  assert.equal(f.walletSends, 1);
  await f.fireNext();
  assert.equal(f.runs.TSLA.action!.phase, 'READY');
  assert.equal(f.walletSends, 1);
  assert.equal(f.reviews.length, 1, 'no quote request while the previous transaction remains pending');
  assert.equal(f.controller.state.error, null);
  assert.match(f.controller.state.notice!, /Waiting for the previous wallet transaction/);
  await f.fireNext();
  assert.equal(f.walletSends, 1, 'continued lag never re-sends the create transaction');
  f.setTrackerLag(false);
  await f.fireNext();
  assert.equal(f.walletSends, 2, 'the original Deposit continues without another page confirmation');
  assert.equal(f.reviews[1]!.operation, 'DEPOSIT');
  assert.equal(f.requests.filter((p) => p.endsWith('/deposit')).length, 1);
});
