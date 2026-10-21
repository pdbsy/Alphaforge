import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface } from 'ethers';
import {
  VerifiedStockReference,
  prepareStockReferenceUpdate,
} from '../apps/server/src/launch-market-adapters/stock-reference.ts';

function source(
  at: string,
  date: string,
  close: string,
  nextClose: string,
  options: { open?: boolean; holiday?: boolean; quoteAt?: string } = {},
) {
  const now = Math.floor(Date.parse(at) / 1000),
    requests: string[] = [];
  const reader = new VerifiedStockReference({
    apiKey: 'offline-test-identity',
    apiSecret: 'offline-test-credential',
    now: () => now,
    fetcher: async (input, init) => {
      const url = String(input);
      requests.push(url);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error');
      const result = url.includes('/clock')
        ? {
            timestamp: at,
            is_open: options.open ?? true,
            next_close: nextClose,
            next_open: '2026-01-21T14:30:00Z',
          }
        : url.includes('/calendar')
          ? options.holiday
            ? []
            : [{ date, open: '09:30', close }]
          : {
              symbol: url.includes('/TSLA/') ? 'TSLA' : 'AMZN',
              quote: { t: options.quoteAt ?? at, bp: '100.20', ap: '100.40' },
            };
      return new Response(JSON.stringify(result));
    },
  });
  return { reader, now, requests };
}
test('provider calendar regular sessions handle New York DST and early close without weekday guessing', async () => {
  for (const [at, date, close, nextClose, openSeconds] of [
    ['2026-01-20T15:00:00Z', '2026-01-20', '16:00', '2026-01-20T21:00:00Z', '2026-01-20T14:30:00Z'],
    ['2026-10-09T15:00:00Z', '2026-10-09', '16:00', '2026-10-09T20:00:00Z', '2026-10-09T13:30:00Z'],
    ['2026-11-27T17:00:00Z', '2026-11-27', '13:00', '2026-11-27T18:00:00Z', '2026-11-27T14:30:00Z'],
  ]) {
    const f = source(at!, date!, close!, nextClose!),
      result = await f.reader.read('TSLA');
    assert.equal(result.status, 'OPEN');
    assert.equal(result.regularOpen, Date.parse(openSeconds!) / 1000);
    assert.equal(result.regularClose, Date.parse(nextClose!) / 1000);
    assert.equal(result.priceRaw, '100300000');
    assert.equal(f.requests.length, 3);
  }
});
test('holidays and outside regular session return closed without fetching or fabricating stock prices', async () => {
  const holiday = source('2026-12-25T15:00:00Z', '2026-12-25', '16:00', '2026-12-28T21:00:00Z', {
    open: false,
    holiday: true,
  });
  const closed = await holiday.reader.read('AMZN');
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.priceRaw, null);
  assert.equal(holiday.requests.length, 2);
  const afterHours = source('2026-10-09T21:00:00Z', '2026-10-09', '16:00', '2026-10-10T20:00:00Z');
  assert.equal((await afterHours.reader.read('TSLA')).status, 'CLOSED');
  assert.equal(afterHours.requests.length, 2);
});
test('stale/future quotes or contradictory calendar clock prevent new stock references', async () => {
  const stale = source('2026-10-09T15:00:00Z', '2026-10-09', '16:00', '2026-10-09T20:00:00Z', {
    quoteAt: '2026-10-09T14:58:59Z',
  });
  await assert.rejects(stale.reader.read('TSLA'), /STOCK_SOURCE_STALE/);
  const future = source('2026-10-09T15:00:00Z', '2026-10-09', '16:00', '2026-10-09T20:00:00Z', {
    quoteAt: '2026-10-09T15:00:01Z',
  });
  await assert.rejects(future.reader.read('TSLA'), /STOCK_SOURCE_STALE/);
  const disagreement = source('2026-10-09T15:00:00Z', '2026-10-09', '16:00', '2026-10-09T19:00:00Z');
  await assert.rejects(disagreement.reader.read('TSLA'), /CALENDAR_CLOCK_DISAGREE/);
});
test('keeper preparation binds actual fresh reference and calendar calldata, never signs or broadcasts', async () => {
  const f = source('2026-10-09T15:00:00Z', '2026-10-09', '16:00', '2026-10-09T20:00:00Z'),
    reference = await f.reader.read('AMZN');
  const prepared = prepareStockReferenceUpdate(
    '0x1111111111111111111111111111111111111111',
    reference,
    f.now,
  );
  const iface = new Interface([
    'function update(uint256,uint64,bytes32)',
    'function updateSession(uint64,uint64,uint64,bytes32)',
  ]);
  assert.equal(prepared.status, 'UNSIGNED_REQUIRES_KEEPER_APPROVAL');
  assert.equal(prepared.actions.length, 2);
  assert.equal(iface.parseTransaction(prepared.actions[1]!)!.args[0], 100300000n);
  assert.throws(
    () => prepareStockReferenceUpdate(prepared.actions[0]!.to, reference, f.now + 61),
    /STOCK_SOURCE_STALE/,
  );
});

test('source timestamps advancing during a data read are checked against the completion clock', async () => {
  let now = Date.parse('2026-10-09T15:00:00Z') / 1000;
  const reader = new VerifiedStockReference({
    apiKey: 'offline-test-identity',
    apiSecret: 'offline-test-credential',
    now: () => now,
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/clock')) {
        now++;
        return new Response(
          JSON.stringify({
            timestamp: new Date(now * 1000).toISOString(),
            is_open: true,
            next_close: '2026-10-09T20:00:00Z',
          }),
        );
      }
      if (url.includes('/calendar'))
        return new Response(JSON.stringify([{ date: '2026-10-09', open: '09:30', close: '16:00' }]));
      now++;
      return new Response(
        JSON.stringify({
          symbol: 'AMZN',
          quote: { t: new Date(now * 1000).toISOString(), bp: '100.20', ap: '100.40' },
        }),
      );
    },
  });
  const reference = await reader.read('AMZN');
  assert.equal(reference.status, 'OPEN');
  assert.equal(reference.observedAt, now);
  assert.equal(reference.calendarObservedAt, now - 1);
});

test('a stock quote that arrives after regular close cannot become an executable reference', async () => {
  let now = Date.parse('2026-10-09T19:59:59Z') / 1000;
  const reader = new VerifiedStockReference({
    apiKey: 'offline-test-identity',
    apiSecret: 'offline-test-credential',
    now: () => now,
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes('/clock'))
        return new Response(
          JSON.stringify({
            timestamp: '2026-10-09T19:59:59Z',
            is_open: true,
            next_close: '2026-10-09T20:00:00Z',
          }),
        );
      if (url.includes('/calendar'))
        return new Response(JSON.stringify([{ date: '2026-10-09', open: '09:30', close: '16:00' }]));
      now++;
      return new Response(
        JSON.stringify({
          symbol: 'TSLA',
          quote: { t: new Date(now * 1000).toISOString(), bp: '100.20', ap: '100.40' },
        }),
      );
    },
  });
  await assert.rejects(reader.read('TSLA'), /REGULAR_SESSION_REQUIRED/);
});
