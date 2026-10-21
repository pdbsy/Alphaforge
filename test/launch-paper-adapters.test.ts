import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { alpacaPaperMarketSource } from '../apps/server/src/launch-market-adapters/alpaca-paper-market.ts';
import { readIndexedPaperReal } from '../apps/server/src/launch-market-adapters/paper-real-projection.ts';
import type { MarketEventIndexer } from '../apps/server/src/launch-market/indexer.ts';

test('Alpaca batch shares clock/calendar and exposes verified two-symbol prices without brokerage orders', async (t) => {
  const directory = await mkdtemp('/tmp/af-paper-adapter-');
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'credentials.json');
  await writeFile(file, JSON.stringify({ apiKey: 'dummy-key', apiSecret: 'dummy-secret' }), { mode: 0o600 });
  const now = Date.parse('2026-10-12T14:00:00Z') / 1000;
  const requests: string[] = [];
  const source = alpacaPaperMarketSource(file, {
    now: () => now,
    fetcher: (async (input, init) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      assert.equal(init?.method, 'GET');
      if (url.pathname.endsWith('/clock'))
        return Response.json({
          timestamp: new Date(now * 1000).toISOString(),
          is_open: true,
          next_close: '2026-10-12T20:00:00Z',
        });
      if (url.pathname.endsWith('/calendar'))
        return Response.json([{ date: '2026-10-12', open: '09:30', close: '16:00' }]);
      const symbol = url.pathname.split('/')[3]!,
        value = symbol === 'TSLA' ? 250 : 200;
      return Response.json({
        symbol,
        quote: { t: new Date(now * 1000).toISOString(), bp: value - 0.05, ap: value + 0.05 },
      });
    }) as typeof fetch,
  });
  const batch = await source.readBatch({ signal: new AbortController().signal });
  assert.equal(batch.TSLA.priceRaw, '250000000');
  assert.equal(batch.AMZN.priceRaw, '200000000');
  assert.equal(requests.filter((path) => path.endsWith('/clock')).length, 1);
  assert.equal(requests.filter((path) => path.endsWith('/calendar')).length, 1);
  assert.equal(requests.length, 4);
  assert.doesNotMatch(JSON.stringify(batch), /dummy-key|dummy-secret/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(source.readBatch({ signal: aborted.signal }), /ALPACA_READ_CANCELLED/);
  assert.equal(requests.length, 4, 'cancelled batch sends no further provider request');
});

function projectionFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE event_index_cursor(id INTEGER PRIMARY KEY,number INTEGER);
    CREATE TABLE event_index_blocks(number INTEGER,hash TEXT,timestamp INTEGER,canonical INTEGER);
    CREATE TABLE event_index_events(payload TEXT,name TEXT,emitter TEXT,strategy TEXT,block_number INTEGER,log_index INTEGER,canonical INTEGER);`);
  const owner = '0x1111111111111111111111111111111111111111',
    factory = '0x3333333333333333333333333333333333333333';
  const first = '0x2222222222222222222222222222222222222222',
    next = '0x4444444444444444444444444444444444444444';
  db.prepare('INSERT INTO event_index_cursor VALUES(1,?)').run(20);
  db.prepare('INSERT INTO event_index_blocks VALUES(?,?,?,1)').run(18, '0x' + 'ab'.repeat(32), 1000);
  let log = 0;
  const add = (height: number, name: string, emitter: string, fields: Record<string, string>) => {
    const payload = JSON.stringify({
      name,
      emitter,
      strategyId: 'TSLA',
      fields,
      timestamp: 900,
      location: { blockNumber: String(height) },
    });
    db.prepare('INSERT INTO event_index_events VALUES(?,?,?,?,?,?,1)').run(
      payload,
      name,
      emitter,
      'TSLA',
      height,
      ++log,
    );
  };
  add(10, 'VaultCreated', factory, { owner, vault: first });
  add(11, 'Deposited', first, {
    owner,
    usdcAmount: '1000000000',
    passRaw: '1000000000000000000000',
    principalBasis: '1000000000',
    trackedUsdcBalance: '1000000000',
  });
  add(12, 'TrackedUsdcBalanceChanged', first, { previousBalance: '1000000000', newBalance: '1000000000' });
  const indexer = { db, options: { manifest: { vaultFactory: factory } } } as unknown as MarketEventIndexer;
  return { db, indexer, owner, first, next, factory, add };
}

test('indexed paper cash uses confirmed funding facts and keeps closed generation cash zero', (t) => {
  const f = projectionFixture();
  t.after(() => f.db.close());
  assert.equal(readIndexedPaperReal(f.indexer, f.owner, 'TSLA').cashRaw, '1000000000');
  f.add(19, 'Deposited', f.first, {
    owner: f.owner,
    usdcAmount: '100000000',
    passRaw: '100000000000000000000',
    principalBasis: '1100000000',
    trackedUsdcBalance: '1100000000',
  });
  assert.equal(
    readIndexedPaperReal(f.indexer, f.owner, 'TSLA').cashRaw,
    '1000000000',
    'one/two confirmations cannot inflate cash',
  );
  f.db.prepare('DELETE FROM event_index_events WHERE block_number=19').run();
  f.add(13, 'Closed', f.first, {
    owner: f.owner,
    usdcReturned: '1000000000',
    passRawReleased: '1000000000000000000000',
  });
  f.add(14, 'VaultCreated', f.factory, { owner: f.owner, vault: f.next });
  f.add(15, 'Deposited', f.next, {
    owner: f.owner,
    usdcAmount: '200000000',
    passRaw: '200000000000000000000',
    principalBasis: '200000000',
    trackedUsdcBalance: '200000000',
  });
  assert.equal(readIndexedPaperReal(f.indexer, f.owner, 'TSLA').cashRaw, '200000000');
  const previous = readIndexedPaperReal(f.indexer, f.owner, 'TSLA', f.first);
  assert.equal(previous.cashRaw, '0');
  assert.equal(previous.lockedPassRaw, '0');
  assert.equal(previous.withdrawableRaw, '0');
});

test('indexed paper cash cannot read another owner generation and does not treat missing index as funded', (t) => {
  const f = projectionFixture();
  t.after(() => f.db.close());
  assert.throws(() => readIndexedPaperReal(f.indexer, f.next, 'TSLA', f.first), /PAPER_VAULT_NOT_OWNED/);
  f.db.prepare("DELETE FROM event_index_events WHERE name='Deposited'").run();
  f.db.prepare("DELETE FROM event_index_events WHERE name='TrackedUsdcBalanceChanged'").run();
  assert.equal(readIndexedPaperReal(f.indexer, f.owner, 'TSLA').cashRaw, '0');
  f.db.prepare('DELETE FROM event_index_cursor').run();
  assert.throws(() => readIndexedPaperReal(f.indexer, f.owner, 'TSLA'), /PAPER_CHAIN_INDEX_SYNCING/);
});
