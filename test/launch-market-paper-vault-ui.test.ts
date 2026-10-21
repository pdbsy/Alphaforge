import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LaunchClientState } from '../apps/web/src/launch-market/model.ts';
import { renderVaultFunding, renderVaults } from '../apps/web/src/launch-market/shell.ts';
import { renderPaperPortfolio, renderPaperCurve } from '../apps/web/src/launch-market/paper-portfolio-ui.ts';
import { VaultValuationController } from '../apps/web/src/launch-market/vault-valuation.ts';
import type { CommunityApi } from '../apps/web/src/community/client.ts';
import { account, OTHER, NOW } from './helpers/launch-market-ui-fixture.ts';
import {
  PAPER_VAULT,
  CLOSED_PAPER_VAULT,
  paperValue,
  paperVault,
  paperState,
  pricedPaper,
  closedPaper,
} from './helpers/launch-market-paper-fixture.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('missing quotes show no simulated valuation while actual cash Withdraw remains usable', () => {
  const value = paperValue(),
    state = paperState();
  const html = renderVaultFunding(state, 'TSLA', {}, undefined, {
    TSLA: { value, vault: PAPER_VAULT, observedAt: NOW },
  });
  assert.match(html, /ON-CHAIN FUNDS/);
  assert.match(html, /Withdrawable on-chain cash<\/dt><dd>10 AF-USDC/);
  assert.match(html, /Waiting for authorized market data/);
  assert.match(html, /value="DEPOSIT" disabled/);
  assert.match(html, /data-launch-vault-withdraw="TSLA" >Withdraw/);
  assert.doesNotMatch(html, /0\.00%|data-paper-curve>/);
});

test('simulated loss and value are separate from unchanged withdrawable principal', () => {
  const value = pricedPaper(),
    state = paperState();
  const html = renderVaultFunding(state, 'TSLA', {}, undefined, {
    TSLA: { value, vault: PAPER_VAULT, observedAt: NOW },
  });
  assert.match(html, /Withdrawable on-chain cash<\/dt><dd>10 AF-USDC/);
  assert.match(html, /<strong>8<\/strong><span>AF-USDC reference/);
  assert.match(html, /-2 AF-USDC/);
  assert.match(html, /-20\.00%/);
  assert.doesNotMatch(html, /<strong>18<\/strong>/);
  assert.match(html, /cannot be withdrawn or added to on-chain funds/);
});

test('closed results persist beside a new Vault without increasing its withdrawal amount', () => {
  const initial = paperState(),
    closed = closedPaper(),
    current = paperValue();
  const state = {
    ...initial,
    wallet: { ...initial.wallet!, vaults: [paperVault(CLOSED_PAPER_VAULT, 'CLOSED'), paperVault()] },
  };
  const html = renderVaults(state, {}, 'TSLA', undefined, {
    TSLA: { value: current, vault: PAPER_VAULT, observedAt: NOW },
    byVault: { [CLOSED_PAPER_VAULT]: { value: closed, vault: CLOSED_PAPER_VAULT, observedAt: NOW } },
  });
  assert.match(html, /Final simulated value/);
  assert.match(html, /<strong>12<\/strong><span>AF-USDC reference/);
  assert.match(html, /Known realized simulated PnL: <strong>\+2 AF-USDC/);
  assert.match(html, /Withdrawable on-chain cash<\/dt><dd>10 AF-USDC/);
  assert.doesNotMatch(html, /Withdrawable on-chain cash<\/dt><dd>12 AF-USDC/);
});

test('no simulated entry masks cash-only ledger zeros and does not draw a price curve', () => {
  const value = paperValue();
  const cashOnly = {
    ...value,
    paper: {
      ...value.paper,
      contributedRaw: '10000000',
      equityRaw: '10000000',
      profitRaw: '0',
      returnBps: '0',
      realizedRaw: '0',
      curve: [{ at: NOW, contributedRaw: '10000000', equityRaw: '10000000', profitRaw: '0' }],
    },
  };
  const html = renderPaperPortfolio(cashOnly);
  assert.match(html, /<strong>—<\/strong><span>AF-USDC reference/);
  assert.match(html, /No valued observations yet/);
  assert.doesNotMatch(html, /0\.00%|data-paper-curve>/);
});

test('unallocated custody joins only the simulated book value once in the reference total', () => {
  const value = pricedPaper();
  const withIdleCustody = {
    ...value,
    real: { ...value.real, cashRaw: '20000000', principalRaw: '20000000', withdrawableRaw: '20000000' },
  };
  const html = renderPaperPortfolio(withIdleCustody);
  assert.match(html, /<strong>18<\/strong><span>AF-USDC reference/);
  assert.match(html, /Unallocated on-chain cash<\/dt><dd>10 AF-USDC/);
  assert.doesNotMatch(html, /<strong>28<\/strong>/);
});

test('additional principal creates no PnL chart gain and a negative PnL draws a loss', () => {
  const flat = renderPaperCurve([
    { at: NOW - 10, contributedRaw: '10000000', equityRaw: '10000000', profitRaw: '0' },
    { at: NOW, contributedRaw: '20000000', equityRaw: '20000000', profitRaw: '0' },
  ]);
  assert.match(flat, /points="24\.00,90\.00 576\.00,90\.00"/);
  assert.match(flat, /<title>Simulated PnL<\/title>/);
  const loss = renderPaperCurve([
    { at: NOW - 10, contributedRaw: '10000000', equityRaw: '10000000', profitRaw: '0' },
    { at: NOW, contributedRaw: '20000000', equityRaw: '18000000', profitRaw: '-2000000' },
  ]);
  assert.match(loss, /points="24\.00,24\.00 576\.00,156\.00"/);
  assert.match(loss, /-2 AF-USDC/);
});

test('thirty-second valuation refresh reads only cached paper values and retains closed generations', async () => {
  const initial = paperState();
  const state = {
    ...initial,
    wallet: { ...initial.wallet!, vaults: [paperVault(CLOSED_PAPER_VAULT, 'CLOSED'), paperVault()] },
  };
  let tick: (() => void) | undefined,
    chainReads = 0;
  const requests: string[] = [];
  const api: CommunityApi = async <T>(path: string): Promise<T> => {
    requests.push(path);
    return structuredClone(
      path.includes('vault=') ? closedPaper() : { ...paperValue(), closedVaults: [CLOSED_PAPER_VAULT] },
    ) as T;
  };
  const controller = new VaultValuationController(
    {
      get state() {
        return state;
      },
      subscribe(listener) {
        listener(state);
        return () => {};
      },
      async refresh() {
        chainReads++;
      },
    },
    {
      api,
      now: () => NOW,
      strategies: () => ['TSLA'],
      visible: () => true,
      listen: () => () => {},
      schedule: (callback, ms) => {
        assert.equal(ms, 30000);
        tick = callback;
        return () => {};
      },
    },
  );
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(controller.state.byVault![CLOSED_PAPER_VAULT]!.value!.paper.realizedRaw, '2000000');
  tick!();
  await flush();
  assert.equal(requests.length, 3);
  assert.equal(chainReads, 0);
  assert.equal(controller.state.byVault![CLOSED_PAPER_VAULT]!.value!.paper.realizedRaw, '2000000');
  controller.dispose();
});

test('an old owner response cannot populate the next wallet ledger', async () => {
  let state = paperState();
  const listeners = new Set<(value: LaunchClientState) => void>();
  const pending = Promise.withResolvers<unknown>();
  const api: CommunityApi = async <T>(): Promise<T> => pending.promise as Promise<T>;
  const controller = new VaultValuationController(
    {
      get state() {
        return state;
      },
      subscribe(listener) {
        listeners.add(listener);
        listener(state);
        return () => {
          listeners.delete(listener);
        };
      },
      async refresh() {},
    },
    {
      api,
      now: () => NOW,
      strategies: () => ['TSLA'],
      visible: () => true,
      listen: () => () => {},
      schedule: () => () => {},
    },
  );
  state = {
    ...state,
    owner: OTHER,
    account: { ...account(), wallet: OTHER },
    wallet: { ...state.wallet!, owner: OTHER },
  };
  for (const listener of listeners) listener(state);
  pending.resolve(paperValue());
  await flush();
  assert.equal(controller.state.TSLA?.value, undefined);
  assert.equal(controller.state.byVault?.[PAPER_VAULT]?.value, undefined);
  controller.dispose();
});

test('a reload with only the current Vault recovers canonical closed history without a synthetic wallet entry', async () => {
  const state = paperState();
  assert.equal(state.wallet!.vaults.length, 1);
  const requests: string[] = [];
  const api: CommunityApi = async <T>(path: string): Promise<T> => {
    requests.push(path);
    return structuredClone(
      path.includes('vault=') ? closedPaper() : { ...paperValue(), closedVaults: [CLOSED_PAPER_VAULT] },
    ) as T;
  };
  const controller = new VaultValuationController(
    {
      get state() {
        return state;
      },
      subscribe(listener) {
        listener(state);
        return () => {};
      },
      async refresh() {
        throw new Error('History discovery must use the indexed API');
      },
    },
    {
      api,
      now: () => NOW,
      strategies: () => ['TSLA'],
      visible: () => true,
      listen: () => () => {},
      schedule: () => () => {},
    },
  );
  await flush();
  assert.deepEqual(requests, [
    '/api/launch-market/vault-values/TSLA',
    `/api/launch-market/vault-values/TSLA?vault=${CLOSED_PAPER_VAULT}`,
  ]);
  assert.equal(state.wallet!.vaults.length, 1);
  const html = renderVaults(state, {}, 'TSLA', undefined, controller.state);
  assert.match(html, /data-paper-archived-vault=/);
  assert.match(html, /Known realized simulated PnL: <strong>\+2 AF-USDC/);
  assert.match(html, /Final simulated value/);
  assert.match(html, /Withdrawable on-chain cash<\/dt><dd>10 AF-USDC/);
  assert.doesNotMatch(html, /Withdrawable on-chain cash<\/dt><dd>12 AF-USDC/);
  controller.dispose();
});

test('a canonical history withdrawal removes cached archived profit without wallet RPC', async () => {
  const state = paperState();
  let canonical = true;
  const api: CommunityApi = async <T>(path: string): Promise<T> =>
    structuredClone(
      path.includes('vault=')
        ? closedPaper()
        : { ...paperValue(), closedVaults: canonical ? [CLOSED_PAPER_VAULT] : [] },
    ) as T;
  const controller = new VaultValuationController(
    {
      get state() {
        return state;
      },
      subscribe(listener) {
        listener(state);
        return () => {};
      },
      async refresh() {
        throw new Error('Valuation must never request chain state');
      },
    },
    {
      api,
      now: () => NOW,
      strategies: () => ['TSLA'],
      visible: () => true,
      listen: () => () => {},
      schedule: () => () => {},
    },
  );
  await flush();
  assert.match(
    renderVaults(state, {}, 'TSLA', undefined, controller.state),
    /Known realized simulated PnL: <strong>\+2 AF-USDC/,
  );
  canonical = false;
  await controller.refresh();
  assert.equal(controller.state.byVault?.[CLOSED_PAPER_VAULT], undefined);
  assert.doesNotMatch(
    renderVaults(state, {}, 'TSLA', undefined, controller.state),
    /Known realized simulated PnL: <strong>\+2 AF-USDC|data-paper-archived-vault=/,
  );
  controller.dispose();
});

test('a reorg-frozen ledger disables new Deposit while actual cash Withdraw remains enabled', () => {
  const initial = pricedPaper();
  const value = {
    ...initial,
    paper: {
      ...initial.paper,
      status: 'REORG_REVIEW_REQUIRED' as const,
      equityRaw: null,
      profitRaw: null,
      returnBps: null,
      realizedRaw: null,
      unrealizedRaw: null,
    },
  };
  const html = renderVaultFunding(paperState(), 'TSLA', {}, undefined, {
    TSLA: { value, vault: PAPER_VAULT, observedAt: NOW },
  });
  assert.match(html, /value="DEPOSIT" disabled/);
  assert.match(html, /data-launch-vault-withdraw="TSLA" >Withdraw/);
});

test('a queued entry blocks another Deposit but keeps Stop and Withdraw available', () => {
  const state = paperState();
  const value = paperValue();
  const actions = {
    flow: {
      strategyId: 'TSLA' as const,
      kind: 'DEPOSIT' as const,
      phase: 'PAPER_PENDING',
      busy: false,
      review: false,
      pendingHash: null,
    },
    paused: {},
    error: null,
    notice: null,
  };
  const html = renderVaultFunding(state, 'TSLA', {}, actions, {
    TSLA: { value: { ...value, paper: { ...value.paper, marketSession: 'CLOSED' } }, observedAt: NOW },
  });
  assert.match(html, /value="DEPOSIT" disabled/);
  assert.match(html, /data-launch-vault-stop="TSLA" >Stop/);
  assert.match(html, /data-launch-vault-withdraw="TSLA" >Withdraw/);
  assert.match(html, /server checks automatically, even with this page closed/);
});

test('a transient index-sync error retries once and restores the Deposit valuation', async () => {
  let reads = 0,
    delays = 0;
  const state = paperState();
  const controller = new VaultValuationController(
    { state, subscribe: () => () => {}, refresh: async () => {} },
    {
      api: async <T>() => {
        reads++;
        if (reads === 1) throw new Error('PAPER_CHAIN_INDEX_SYNCING');
        return pricedPaper() as T;
      },
      retryDelay: async () => {
        delays++;
      },
      now: () => NOW,
      strategies: () => ['TSLA'],
      visible: () => true,
      listen: () => () => {},
      schedule: () => () => {},
    },
  );
  controller.sync();
  await controller.refresh();
  assert.equal(reads, 2);
  assert.equal(delays, 1);
  assert.equal(controller.state.TSLA!.error, null);
  assert.match(
    renderVaultFunding(state, 'TSLA', {}, undefined, controller.state),
    /value="DEPOSIT" >Deposit/,
  );
  controller.dispose();
});

for (const code of ['MARKET_HISTORY_SYNCING', 'LINKED_WALLET_REQUIRED'])
  test(`${code} keeps funding disabled and retries only known transient errors`, async () => {
    let reads = 0;
    const state = paperState();
    const controller = new VaultValuationController(
      { state, subscribe: () => () => {}, refresh: async () => {} },
      {
        api: async () => {
          reads++;
          throw new Error(code);
        },
        retryDelay: async () => {},
        now: () => NOW,
        strategies: () => ['TSLA'],
        visible: () => true,
        listen: () => () => {},
        schedule: () => () => {},
      },
    );
    controller.sync();
    await controller.refresh();
    assert.equal(reads, code === 'MARKET_HISTORY_SYNCING' ? 2 : 1);
    const html = renderVaultFunding(state, 'TSLA', {}, undefined, controller.state);
    assert.match(html, /value="DEPOSIT" disabled/);
    if (code === 'MARKET_HISTORY_SYNCING') assert.match(html, /Retrying automatically/);
    controller.dispose();
  });

test('switching wallets during a sync retry discards the pending request', async () => {
  let reads = 0;
  const gate = Promise.withResolvers<void>();
  let state = paperState();
  const controller = new VaultValuationController(
    {
      get state() {
        return state;
      },
      subscribe: () => () => {},
      refresh: async () => {},
    },
    {
      api: async () => {
        reads++;
        throw new Error('PAPER_CHAIN_INDEX_SYNCING');
      },
      retryDelay: () => gate.promise,
      now: () => NOW,
      strategies: () => ['TSLA'],
      visible: () => true,
      listen: () => () => {},
      schedule: () => () => {},
    },
  );
  controller.sync();
  const pending = controller.refresh();
  await flush();
  state = { ...state, owner: OTHER };
  controller.sync();
  gate.resolve();
  await pending;
  assert.equal(reads, 1);
  assert.deepEqual(controller.state, {});
  controller.dispose();
});
