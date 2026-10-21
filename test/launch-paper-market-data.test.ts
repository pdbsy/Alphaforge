import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PaperMarketDataCache,
  isPaperEntryQuote,
  type PaperMarketDataSource,
  type PaperMarketQuote,
  type PaperMarketSourceQuote,
} from '../apps/server/src/launch-market-adapters/paper-market-data.ts';
import type { StrategyId } from '../packages/launch-market/src/types.ts';

type Batch = Readonly<Record<StrategyId, PaperMarketSourceQuote>>;
const open = (now: number): Batch => ({
  TSLA: { strategyId: 'TSLA', marketState: 'OPEN', priceRaw: '250123456', observedAt: now },
  AMZN: { strategyId: 'AMZN', marketState: 'OPEN', priceRaw: '180654321', observedAt: now },
});
const source = (readBatch: PaperMarketDataSource['readBatch']): PaperMarketDataSource => ({
  sourceId: 'ALPACA_IEX',
  readBatch,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('paper references default unavailable and configured sources require explicit authorization', async () => {
  const empty = new PaperMarketDataCache({ now: () => 1000 });
  const snapshot = await empty.read();
  assert.equal(snapshot.status, 'NOT_CONFIGURED');
  assert.equal(snapshot.sourceId, null);
  assert.equal(snapshot.sourceAuthorized, false);
  for (const quote of Object.values(snapshot.quotes)) {
    assert.equal(quote.status, 'NOT_CONFIGURED');
    for (const field of [
      'priceRaw',
      'observedAt',
      'fetchedAt',
      'expiresAt',
      'lastKnownPriceRaw',
      'lastKnownObservedAt',
    ] as const)
      assert.equal(quote[field], null);
    assert.equal(isPaperEntryQuote(quote, 1000), false);
  }
  let calls = 0;
  const blocked = new PaperMarketDataCache({
    now: () => 1000,
    source: source(async () => {
      calls++;
      return open(1000);
    }),
  });
  const views = await Promise.all(Array.from({ length: 20 }, () => blocked.read()));
  assert.equal(calls, 0);
  assert.ok(views.every((view) => view.status === 'NOT_AUTHORIZED'));
  assert.equal(blocked.status().quotes.TSLA.priceRaw, null);
});

test('both symbols share one batch and one 30 second attempt window across concurrent readers', async () => {
  let now = 1000,
    calls = 0;
  const first = deferred<Batch>();
  const cache = new PaperMarketDataCache({
    now: () => now,
    sourceAuthorization: true,
    source: source(async () => {
      calls++;
      return calls === 1 ? first.promise : open(now);
    }),
  });
  const readers = Array.from({ length: 25 }, () => cache.read());
  assert.equal(calls, 1);
  first.resolve(open(now));
  const snapshots = await Promise.all(readers);
  assert.ok(snapshots.every((snapshot) => snapshot.status === 'READY'));
  const quote = snapshots[0]!.quotes.TSLA;
  assert.equal(quote.sourceId, 'ALPACA_IEX');
  assert.equal(quote.sourceAuthorized, true);
  assert.equal(quote.fetchedAt, 1000);
  assert.equal(quote.expiresAt, 1030);
  assert.equal(isPaperEntryQuote(quote, 1000), true);
  (quote as { priceRaw: string | null }).priceRaw = '1';
  assert.equal(cache.status().quotes.TSLA.priceRaw, '250123456');
  now = 1029;
  await Promise.all(Array.from({ length: 20 }, () => cache.read()));
  cache.status();
  assert.equal(calls, 1);
  now = 1030;
  assert.equal(cache.status().quotes.TSLA.status, 'STALE');
  assert.equal(cache.status().quotes.TSLA.priceRaw, null);
  assert.equal(isPaperEntryQuote(quote, now), false);
  await Promise.all(Array.from({ length: 20 }, () => cache.read()));
  assert.equal(calls, 2);
  assert.equal(cache.status().quotes.AMZN.expiresAt, 1060);
});

test('provider references reject old, future, malformed and unsupported values without inventing prices', async () => {
  for (const override of [
    { observedAt: 939 },
    { observedAt: 1001 },
    { observedAt: 1000.5 },
    { priceRaw: '0' },
    { priceRaw: '-1' },
    { priceRaw: '01' },
    { priceRaw: (1n << 256n).toString() },
    { strategyId: 'AMZN' },
    { marketState: 'CLOSED', priceRaw: '250123456' },
    { secret: 'must-not-reflect' },
  ]) {
    const batch = { ...open(1000), TSLA: { ...open(1000).TSLA, ...override } } as Batch;
    const cache = new PaperMarketDataCache({
      now: () => 1000,
      sourceAuthorization: true,
      source: source(async () => batch),
    });
    const snapshot = await cache.read();
    assert.equal(snapshot.status, 'DEGRADED');
    assert.equal(snapshot.quotes.TSLA.status, 'UNAVAILABLE');
    assert.equal(snapshot.quotes.TSLA.priceRaw, null);
    assert.equal(snapshot.quotes.TSLA.lastKnownPriceRaw, null);
    assert.equal(snapshot.quotes.AMZN.status, 'READY');
    assert.equal(JSON.stringify(snapshot).includes('must-not-reflect'), false);
  }
  const extra = { ...open(1000), MSFT: open(1000).TSLA } as Batch;
  const invalid = new PaperMarketDataCache({
    now: () => 1000,
    sourceAuthorization: true,
    source: source(async () => extra),
  });
  assert.ok(Object.values((await invalid.read()).quotes).every((quote) => quote.status === 'UNAVAILABLE'));
  const aging = new PaperMarketDataCache({
    now: () => 1000,
    sourceAuthorization: true,
    source: source(async () => open(950)),
  });
  assert.equal((await aging.read()).quotes.TSLA.expiresAt, 1010);
});

test('closed sessions retain historical display evidence without renewing or using it for entry', async () => {
  let now = 1000;
  const cache = new PaperMarketDataCache({
    now: () => now,
    sourceAuthorization: true,
    source: source(async () =>
      now === 1000
        ? open(now)
        : {
            TSLA: { strategyId: 'TSLA', marketState: 'CLOSED', priceRaw: null, observedAt: now },
            AMZN: { strategyId: 'AMZN', marketState: 'CLOSED', priceRaw: null, observedAt: now },
          },
    ),
  });
  await cache.read();
  now = 1030;
  const closed = await cache.read();
  assert.equal(closed.status, 'MARKET_CLOSED');
  assert.equal(closed.quotes.TSLA.marketState, 'CLOSED');
  assert.equal(closed.quotes.TSLA.priceRaw, null);
  assert.equal(closed.quotes.TSLA.lastKnownPriceRaw, '250123456');
  assert.equal(closed.quotes.TSLA.lastKnownObservedAt, 1000);
  assert.equal(isPaperEntryQuote(closed.quotes.TSLA, now), false);
  now = 1060;
  assert.equal(cache.status().quotes.TSLA.status, 'STALE');
  assert.equal(cache.status().quotes.TSLA.lastKnownObservedAt, 1000);
});

test('source failures expose no private error and share the failed attempt limit', async () => {
  let now = 1000,
    calls = 0;
  const secret = 'private-provider-header:/private/credentials.json';
  const cache = new PaperMarketDataCache({
    now: () => now,
    sourceAuthorization: true,
    source: source(async () => {
      calls++;
      if (calls > 1) throw new Error(secret);
      return open(now);
    }),
  });
  await cache.read();
  now = 1030;
  const failed = await cache.read();
  assert.equal(failed.quotes.TSLA.status, 'UNAVAILABLE');
  assert.equal(failed.quotes.TSLA.priceRaw, null);
  assert.equal(failed.quotes.TSLA.lastKnownObservedAt, 1000);
  assert.equal(JSON.stringify(failed).includes(secret), false);
  await Promise.all(Array.from({ length: 25 }, () => cache.read()));
  assert.equal(calls, 2);
  now = 1059;
  await cache.read();
  assert.equal(calls, 2);
  now = 1060;
  await cache.read();
  assert.equal(calls, 3);
});

test('a source deadline aborts the shared read and ignores a late completion', async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const late = deferred<Batch>();
  const cache = new PaperMarketDataCache({
    now: () => 1000,
    sourceAuthorization: true,
    requestTimeoutMs: 10,
    source: source(async (options) => {
      calls++;
      signal = options.signal;
      return late.promise;
    }),
  });
  const snapshots = await Promise.all(Array.from({ length: 10 }, () => cache.read()));
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
  assert.ok(snapshots.every((snapshot) => snapshot.quotes.TSLA.status === 'UNAVAILABLE'));
  late.resolve(open(1000));
  await Promise.resolve();
  assert.equal((await cache.read()).quotes.TSLA.priceRaw, null);
  assert.equal(cache.status().quotes.TSLA.lastKnownPriceRaw, null);
  assert.equal(calls, 1);
});

test('entry eligibility checks source permission, symbol and every freshness boundary', async () => {
  const cache = new PaperMarketDataCache({
    now: () => 1000,
    sourceAuthorization: true,
    source: source(async () => open(1000)),
  });
  const quote = (await cache.read()).quotes.TSLA;
  assert.equal(isPaperEntryQuote(quote, 1000), true);
  assert.equal(isPaperEntryQuote(quote, 1029), true);
  assert.equal(isPaperEntryQuote(quote, 1030), false);
  assert.equal(isPaperEntryQuote(quote, 999), false);
  assert.equal(isPaperEntryQuote(quote, NaN), false);
  for (const override of [
    { sourceAuthorized: false },
    { sourceId: null },
    { status: 'STALE' },
    { marketState: 'CLOSED' },
    { strategyId: 'MSFT' },
    { priceRaw: '0' },
    { observedAt: 939 },
    { observedAt: 1001 },
    { fetchedAt: 970 },
    { fetchedAt: 1001 },
    { expiresAt: 1031 },
    { expiresAt: 1000 },
  ])
    assert.equal(isPaperEntryQuote({ ...quote, ...override } as PaperMarketQuote, 1000), false);
});
