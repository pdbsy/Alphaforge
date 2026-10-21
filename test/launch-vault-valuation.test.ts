import assert from 'node:assert/strict';
import test from 'node:test';
import { VaultValuations } from '../apps/server/src/launch-market-adapters/vault-valuation.ts';
import type { VaultRunObservation } from '../packages/launch-market/src/vault-run.ts';

const owner = '0x1111111111111111111111111111111111111111';
const observation: VaultRunObservation = {
  owner,
  strategyId: 'TSLA',
  vault: '0x2222222222222222222222222222222222222222',
  closed: false,
  cashRaw: '1000000',
  positionRaw: '1000000000000000000',
  lockedPassRaw: '10000000000000000000',
  executorActive: false,
  version: '1',
  ownerNonceRaw: '4',
  blockNumber: '50',
  blockHash: '0x' + 'aa'.repeat(32),
  confirmations: 3,
};
const input = (
  overrides: Partial<VaultRunObservation> = {},
  priceRaw: string | null = '8000000',
  priceObservedAt: number | null = 1000,
) => ({
  observation: { ...observation, ...overrides },
  principalRaw: '10000000',
  priceRaw,
  priceObservedAt,
});

test('total funds and signed return include losses in cash plus actual stock holdings', async () => {
  const service = new VaultValuations({ chain: { readValuation: async () => input() }, now: () => 1000 });
  const result = await service.read(owner, 'TSLA');
  assert.equal(result.equityRaw, '9000000');
  assert.equal(result.principalRaw, '10000000');
  assert.equal(result.profitRaw, '-1000000');
  assert.equal(result.returnBps, '-1000');
  assert.equal(result.status, 'FRESH');
});
test('cash-only funds need no stock quote and zero principal has no invented percentage', async () => {
  const service = new VaultValuations({
    chain: {
      readValuation: async () => ({
        ...input({ positionRaw: '0', cashRaw: '1234567' }, null, null),
        principalRaw: '0',
      }),
    },
    now: () => 1000,
  });
  const result = await service.read(owner, 'TSLA');
  assert.equal(result.equityRaw, '1234567');
  assert.equal(result.profitRaw, '1234567');
  assert.equal(result.returnBps, null);
  assert.equal(result.priceObservedAt, null);
  assert.equal(result.status, 'FRESH');
});
test('unavailable quotes do not fabricate zero equity; stale quotes retain dated estimates', async () => {
  const missing = new VaultValuations({
    chain: { readValuation: async () => input({}, null, null) },
    now: () => 1000,
  });
  const noPrice = await missing.read(owner, 'TSLA');
  assert.equal(noPrice.equityRaw, null);
  assert.equal(noPrice.profitRaw, null);
  assert.equal(noPrice.status, 'UNAVAILABLE');
  const stale = new VaultValuations({
    chain: { readValuation: async () => input({}, '8000000', 900) },
    now: () => 1000,
    readPrice: async () => {
      throw new Error('SOURCE_UNAVAILABLE');
    },
  });
  const dated = await stale.read(owner, 'TSLA');
  assert.equal(dated.status, 'STALE');
  assert.equal(dated.equityRaw, '9000000');
  assert.equal(dated.priceObservedAt, 900);
});
test('large balances use exact arithmetic and simultaneous reads merge without extending the quote age', async () => {
  let reads = 0;
  let now = 1000;
  const principal = 123456789012345678901234567890n;
  const cash = principal - 1234567890123456789n;
  const service = new VaultValuations({
    chain: {
      readValuation: async () => {
        reads++;
        await Promise.resolve();
        return { ...input({ positionRaw: '0', cashRaw: String(cash) }), principalRaw: String(principal) };
      },
    },
    now: () => now,
  });
  const [a, b] = await Promise.all([service.read(owner, 'TSLA'), service.read(owner, 'TSLA')]);
  assert.deepEqual(a, b);
  assert.equal(reads, 1);
  assert.equal(a.profitRaw, String(cash - principal));
  assert.equal(a.returnBps, String(((cash - principal) * 10000n) / principal));
  now += 5;
  await service.read(owner, 'TSLA');
  assert.equal(reads, 2);
});
test('verified display source refresh is dated after it completes and never publishes or signs', async () => {
  let now = 1000;
  const service = new VaultValuations({
    chain: { readValuation: async () => input({}, '8000000', 900) },
    now: () => now,
    readPrice: async (strategy) => {
      assert.equal(strategy, 'TSLA');
      now = 1002;
      return { priceRaw: '11000000', observedAt: 1002 };
    },
  });
  const result = await service.read(owner, 'TSLA');
  assert.equal(result.equityRaw, '12000000');
  assert.equal(result.returnBps, '2000');
  assert.equal(result.observedAt, 1002);
  assert.equal(result.priceObservedAt, 1002);
});

test('a confirmed transaction bypasses recent values and an older response cannot replace its fresh cache', async () => {
  const old = Promise.withResolvers<ReturnType<typeof input>>();
  const requests: boolean[] = [];
  const service = new VaultValuations({
    chain: {
      readValuation: async (_owner, _strategy, options) => {
        requests.push(options?.fresh ?? false);
        if (requests.length === 2) return old.promise;
        return input({ positionRaw: '0', cashRaw: requests.length === 1 ? '9000000' : '11000000' });
      },
    },
    now: () => 1000,
  });
  assert.equal((await service.read(owner, 'TSLA')).equityRaw, '9000000');
  const pending = service.read(owner, 'TSLA', { fresh: true });
  assert.equal((await service.read(owner, 'TSLA', { fresh: true })).equityRaw, '11000000');
  old.resolve(input({ positionRaw: '0', cashRaw: '9000000' }));
  await pending;
  assert.equal((await service.read(owner, 'TSLA')).equityRaw, '11000000');
  assert.deepEqual(requests, [false, true, true]);
});
