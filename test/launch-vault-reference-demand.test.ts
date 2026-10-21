import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VaultReferenceDemand,
  type VaultReferenceDemandResult,
} from '../apps/server/src/launch-market-adapters/vault-reference-demand.ts';
import type { StrategyId } from '../packages/launch-market/src/types.ts';

const result = (strategyId: StrategyId, now: number): VaultReferenceDemandResult => ({
  strategyId,
  status: 'READY',
  observedAt: now,
  expiresAt: now + 60,
  priceRaw: '250000000',
  source: 'Alpaca IEX',
  reason: 'READY',
});
test('demand defaults to honest unconfigured status and never calls an unready signer', async () => {
  let calls = 0;
  const demand = new VaultReferenceDemand({
    now: () => 2000000000,
    sourceConfigured: true,
    refresh: async (id, now) => {
      calls++;
      return result(id, now);
    },
  });
  assert.equal(demand.status().available, false);
  assert.deepEqual(demand.status().missing, ['KEEPER_SIGNER']);
  assert.equal((await demand.request('TSLA')).status, 'NOT_CONFIGURED');
  assert.equal(calls, 0);
});
test('identical requests coalesce, stock refreshes serialize, and cache refreshes after five seconds', async () => {
  let now = 2000000000,
    calls = 0,
    concurrent = 0,
    peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const demand = new VaultReferenceDemand({
    sourceConfigured: true,
    keeperConfigured: true,
    now: () => now,
    refresh: async (id, at) => {
      calls++;
      concurrent++;
      peak = Math.max(peak, concurrent);
      await gate;
      concurrent--;
      return result(id, at);
    },
  });
  const first = demand.request('TSLA'),
    same = demand.request('TSLA'),
    second = demand.request('AMZN');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const values = await Promise.all([first, same, second]);
  assert.deepEqual(values[0], values[1]);
  assert.equal(calls, 2);
  assert.equal(peak, 1);
  await demand.request('TSLA');
  assert.equal(calls, 2);
  now += 5;
  await demand.request('TSLA');
  assert.equal(calls, 3);
});
test('failed or stale refreshes expose no old price or private details, and refreshed responses whitelist fields', async () => {
  let now = 2000000000,
    fail = false;
  const demand = new VaultReferenceDemand({
    sourceConfigured: true,
    keeperConfigured: true,
    now: () => now,
    refresh: async (id, at) => {
      if (fail) throw new Error('secret-provider-url-and-key');
      return { ...result(id, at), privateKey: 'must-not-be-published' };
    },
  });
  const first = await demand.request('TSLA');
  assert.equal('privateKey' in first, false);
  fail = true;
  now += 5;
  const unavailable = await demand.request('TSLA');
  assert.equal(unavailable.status, 'UNAVAILABLE');
  assert.equal(unavailable.priceRaw, null);
  assert.equal(JSON.stringify(unavailable).includes('secret'), false);
  const stale = new VaultReferenceDemand({
    sourceConfigured: true,
    keeperConfigured: true,
    now: () => now,
    refresh: async (id) => result(id, now - 61),
  });
  assert.equal((await stale.request('TSLA')).status, 'UNAVAILABLE');
  const closed = new VaultReferenceDemand({
    sourceConfigured: true,
    keeperConfigured: true,
    now: () => now,
    refresh: async (id, at) => ({
      ...result(id, at),
      status: 'MARKET_CLOSED',
      priceRaw: null,
      expiresAt: at,
      reason: 'MARKET_CLOSED',
    }),
  });
  assert.equal((await closed.request('TSLA')).status, 'MARKET_CLOSED');
});
