import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VaultValuationController } from '../apps/web/src/launch-market/vault-valuation.ts';
import { renderVaultPerformance } from '../apps/web/src/launch-market/vault-actions-ui.ts';
import type { LaunchClientState } from '../apps/web/src/launch-market/model.ts';
import type { CommunityApi } from '../apps/web/src/community/client.ts';
import { account, config, OWNER, OTHER, snapshot, wallet } from './helpers/launch-market-ui-fixture.ts';
const vault = '0x3333333333333333333333333333333333333333';
const now = 1792000000;
const value = () => ({
  owner: OWNER,
  strategyId: 'AMZN',
  vault,
  equityRaw: '9000000',
  principalRaw: '10000000',
  profitRaw: '-1000000',
  returnBps: '-1000',
  status: 'FRESH',
  observedAt: now,
  priceObservedAt: now - 10,
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(api?: CommunityApi) {
  let state: LaunchClientState = {
    enabled: true,
    config: config(),
    snapshot: snapshot(),
    owner: OWNER,
    account: account(),
    wallet: {
      ...wallet(),
      vaults: [
        {
          strategyId: 'AMZN',
          address: vault,
          principalBasisRaw: '10000000',
          equityRaw: '10000000',
          cashRaw: '10000000',
          lockedPassRaw: '10000000000000000000',
          realizedPnlRaw: '0',
          unrealizedPnlRaw: '0',
          valuationState: 'FRESH',
          withdrawableProfitRaw: '0',
          withdrawablePrincipalRaw: '10000000',
          status: 'OPEN',
          holdings: [],
        },
      ],
    },
    connecting: false,
    busy: false,
    quote: null,
    quoteRequest: null,
    error: null,
    notice: null,
    transaction: { state: 'IDLE', hash: null, id: null, confirmations: 0, approval: false, owner: null },
  };
  let visible = true,
    page = true,
    assetReads = 0,
    stops = 0;
  let callback: (() => void) | null = null;
  const listeners = new Set<(state: LaunchClientState) => void>();
  const requests: { path: string; method?: string }[] = [];
  const client = {
    get state() {
      return state;
    },
    subscribe(fn: (state: LaunchClientState) => void) {
      listeners.add(fn);
      fn(state);
      return () => {
        listeners.delete(fn);
      };
    },
    async refresh() {
      assetReads++;
    },
  };
  const values = new VaultValuationController(client, {
    api: async <T>(path: string, method?: string) => {
      requests.push({ path, ...(method === undefined ? {} : { method }) });
      return api ? api<T>(path, method) : (structuredClone(value()) as T);
    },
    now: () => now,
    visible: () => visible,
    activePage: () => page,
    strategies: () => ['AMZN'],
    listen: () => () => {},
    schedule: (fn, ms) => {
      assert.equal(ms, 30000);
      callback = fn;
      return () => {
        stops++;
      };
    },
  });
  return {
    values,
    client,
    requests,
    get assetReads() {
      return assetReads;
    },
    get stops() {
      return stops;
    },
    update(patch: Partial<LaunchClientState>) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
    },
    tick() {
      callback?.();
    },
    hide() {
      visible = false;
      values.sync();
    },
    show() {
      visible = true;
      values.sync();
    },
    leave() {
      page = false;
      values.sync();
    },
  };
}

test('visible financial display polls every 30 seconds, preserves financial snapshots and stops when hidden or left', async () => {
  const f = fixture();
  await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.path, '/api/launch-market/vault-values/AMZN');
  assert.equal(f.requests[0]!.method, undefined);
  assert.equal(f.client.state.wallet!.vaults[0]!.equityRaw, '10000000');
  assert.equal(f.values.state.AMZN!.equityRaw, '9000000');
  assert.match(
    renderVaultPerformance(f.client.state, 'AMZN', f.values.state.AMZN),
    /<strong>9<\/strong>[\s\S]*-10.00%/,
  );
  f.tick();
  await flush();
  assert.equal(f.assetReads, 1);
  assert.equal(f.requests.length, 2);
  f.hide();
  f.tick();
  await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.stops, 1);
  f.show();
  await flush();
  assert.equal(f.requests.length, 3);
  f.leave();
  f.tick();
  await flush();
  assert.equal(f.requests.length, 3);
  f.values.dispose();
});

test('a newly confirmed transaction refreshes visible assets and valuation immediately once', async () => {
  const f = fixture();
  await flush();
  f.update({
    transaction: { ...f.client.state.transaction, state: 'COMPLETED', hash: `0x${'a'.repeat(64)}` },
  });
  await flush();
  assert.equal(f.assetReads, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests.at(-1)!.path, '/api/launch-market/vault-values/AMZN?fresh=1');
  f.update({ transaction: { ...f.client.state.transaction } });
  await flush();
  assert.equal(f.assetReads, 1);
  assert.equal(f.requests.length, 2);
  f.values.dispose();
});

test('wrong owner or Vault and inconsistent PnL cannot replace a verified valuation', async () => {
  for (const invalid of [
    { ...value(), owner: OTHER },
    { ...value(), vault: OTHER },
    { ...value(), profitRaw: '0' },
    { ...value(), returnBps: '0' },
  ]) {
    const f = fixture(async <T>() => invalid as T);
    await flush();
    assert.equal(f.values.state.AMZN?.equityRaw, undefined);
    assert.match(f.values.state.AMZN!.error!, /unavailable/);
    assert.equal(f.client.state.wallet!.vaults[0]!.equityRaw, '10000000');
    f.values.dispose();
  }
});

test('a response from a hidden page or former wallet is discarded', async () => {
  let complete: ((result: unknown) => void) | undefined;
  const f = fixture(
    <T>() =>
      new Promise<T>((resolve) => {
        complete = (result) => resolve(result as T);
      }),
  );
  f.hide();
  complete!(value());
  await flush();
  assert.deepEqual(f.values.state, {});
  f.update({
    owner: OTHER,
    account: { ...account(), wallet: OTHER },
    wallet: { ...f.client.state.wallet!, owner: OTHER },
  });
  assert.deepEqual(f.values.state, {});
  f.values.dispose();
});

test('confirmation forces a fresh valuation and an older in-flight response cannot overwrite it', async () => {
  let oldResponse: ((result: unknown) => void) | undefined;
  const f = fixture(<T>(path: string) =>
    path.endsWith('?fresh=1')
      ? Promise.resolve({ ...value(), equityRaw: '11000000', profitRaw: '1000000', returnBps: '1000' } as T)
      : new Promise<T>((resolve) => {
          oldResponse = (result) => resolve(result as T);
        }),
  );
  f.update({
    transaction: { ...f.client.state.transaction, state: 'COMPLETED', hash: `0x${'b'.repeat(64)}` },
  });
  await flush();
  assert.equal(f.values.state.AMZN!.equityRaw, '11000000');
  assert.equal(f.requests.at(-1)!.path, '/api/launch-market/vault-values/AMZN?fresh=1');
  oldResponse!(value());
  await flush();
  assert.equal(f.values.state.AMZN!.equityRaw, '11000000');
  assert.equal(f.client.state.wallet!.vaults[0]!.equityRaw, '10000000');
  f.values.dispose();
});
