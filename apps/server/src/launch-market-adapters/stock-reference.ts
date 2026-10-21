import { createHash } from 'node:crypto';
import { Interface } from 'ethers';

interface StockSourceOptions {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  /** Private archival hook. Never exposed to the browser or operational status. */
  readonly capture?: (evidence: unknown) => void;
}
export interface ConfirmedStockReference {
  readonly strategyId: 'TSLA' | 'AMZN';
  readonly status: 'OPEN' | 'CLOSED';
  readonly observedAt: number;
  readonly priceRaw: string | null;
  readonly regularOpen: number;
  readonly regularClose: number;
  readonly calendarObservedAt: number;
  readonly sourceDigest: string;
  readonly calendarDigest: string;
  readonly source: 'Alpaca IEX';
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_STOCK_SOURCE');
  return value as Record<string, unknown>;
}
function seconds(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new Error('INVALID_SOURCE_TIMESTAMP');
  const time = Math.floor(Date.parse(value) / 1000);
  if (!Number.isSafeInteger(time)) throw new Error('INVALID_SOURCE_TIMESTAMP');
  return time;
}
function fresh(at: number, now: number): void {
  if (at > now || now - at > 60) throw new Error('STOCK_SOURCE_STALE');
}
function amount(value: unknown): bigint {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,8})(?:\.[0-9]{1,18})?$/.test(text))
    throw new Error('INVALID_STOCK_PRICE');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
}
function digest(value: unknown): string {
  return '0x' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** Calendar supplies holidays/early close. Intl's New York timezone supplies that day's DST offset. */
function bounds(calendar: unknown, now: number): { opens: number; closes: number } | null {
  if (!Array.isArray(calendar) || calendar.length > 1) throw new Error('INVALID_MARKET_CALENDAR');
  if (!calendar.length) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(now * 1000))
      .map((part) => [part.type, part.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`,
    item = object(calendar[0]);
  if (
    item.date !== date ||
    typeof item.open !== 'string' ||
    typeof item.close !== 'string' ||
    !/^\d{2}:\d{2}$/.test(item.open) ||
    !/^\d{2}:\d{2}$/.test(item.close)
  )
    throw new Error('CALENDAR_DATE_MISMATCH');
  const offset =
    Math.floor(Date.parse(`${date}T${parts.hour}:${parts.minute}:${parts.second}Z`) / 1000) - now;
  const opens = Math.floor(Date.parse(`${date}T${item.open}:00Z`) / 1000) - offset,
    closes = Math.floor(Date.parse(`${date}T${item.close}:00Z`) / 1000) - offset;
  if (
    !Number.isSafeInteger(opens) ||
    !Number.isSafeInteger(closes) ||
    opens >= closes ||
    closes - opens > 8 * 3600
  )
    throw new Error('INVALID_REGULAR_SESSION');
  return { opens, closes };
}

/** GET-only market data. No real brokerage order endpoint or trading credential action exists. */
export class VerifiedStockReference {
  readonly #options: StockSourceOptions;
  readonly #fetcher: typeof fetch;
  readonly #now: () => number;
  constructor(options: StockSourceOptions) {
    if (!options.apiKey || !options.apiSecret) throw new Error('STOCK_REFERENCE_NOT_CONFIGURED');
    this.#options = options;
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }
  async #get(url: string): Promise<unknown> {
    const response = await this.#fetcher(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
      headers: { 'APCA-API-KEY-ID': this.#options.apiKey, 'APCA-API-SECRET-KEY': this.#options.apiSecret },
    });
    if (!response.ok || !response.body) throw new Error('STOCK_REFERENCE_UNAVAILABLE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 262144) throw new Error('STOCK_REFERENCE_TOO_LARGE');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  async read(strategyId: 'TSLA' | 'AMZN'): Promise<ConfirmedStockReference> {
    if (!['TSLA', 'AMZN'].includes(strategyId)) throw new Error('UNSUPPORTED_TEST_STOCK');
    const now = this.#now(),
      localDay = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(now * 1000));
    const [rawClock, calendar] = await Promise.all([
      this.#get('https://paper-api.alpaca.markets/v2/clock'),
      this.#get(`https://paper-api.alpaca.markets/v2/calendar?start=${localDay}&end=${localDay}`),
    ]);
    const clock = object(rawClock),
      observed = seconds(clock.timestamp);
    const calendarReadAt = this.#now();
    fresh(observed, calendarReadAt);
    if (typeof clock.is_open !== 'boolean') throw new Error('INVALID_MARKET_CLOCK');
    const session = bounds(calendar, observed),
      calendarDigest = digest({ clock: rawClock, calendar });
    const result = {
      strategyId,
      observedAt: observed,
      regularOpen: session?.opens ?? 0,
      regularClose: session?.closes ?? 0,
      calendarObservedAt: observed,
      calendarDigest,
      source: 'Alpaca IEX' as const,
    };
    if (!clock.is_open || !session || calendarReadAt < session.opens || calendarReadAt >= session.closes) {
      this.#options.capture?.({ strategyId, clock: rawClock, calendar });
      return { ...result, status: 'CLOSED', priceRaw: null, sourceDigest: calendarDigest };
    }
    if (seconds(clock.next_close) !== session.closes) throw new Error('CALENDAR_CLOCK_DISAGREE');
    const rawQuote = await this.#get(
        `https://data.alpaca.markets/v2/stocks/${strategyId}/quotes/latest?feed=iex`,
      ),
      quote = object(object(rawQuote).quote);
    if (object(rawQuote).symbol !== strategyId) throw new Error('STOCK_SOURCE_SYMBOL');
    const at = seconds(quote.t),
      bid = amount(quote.bp),
      ask = amount(quote.ap);
    const quoteReadAt = this.#now();
    fresh(at, quoteReadAt);
    fresh(observed, quoteReadAt);
    if (quoteReadAt < session.opens || quoteReadAt >= session.closes)
      throw new Error('REGULAR_SESSION_REQUIRED');
    if (bid === 0n || ask < bid) throw new Error('INVALID_STOCK_SPREAD');
    const price = (bid + ask) / 2n;
    this.#options.capture?.({ strategyId, clock: rawClock, calendar, rawQuote });
    return {
      ...result,
      status: 'OPEN',
      observedAt: at,
      priceRaw: price.toString(),
      sourceDigest: digest({ strategyId, rawQuote, calendarDigest }),
    };
  }
}

const feedInterface = new Interface([
  'function update(uint256,uint64,bytes32)',
  'function updateSession(uint64,uint64,uint64,bytes32)',
]);
/** Offline unsigned keeper actions. Actual Testnet signing/broadcast still needs separate approval. */
export function prepareStockReferenceUpdate(feed: string, reference: ConfirmedStockReference, now: number) {
  fresh(reference.calendarObservedAt, now);
  const actions = [
    {
      to: feed,
      data: feedInterface.encodeFunctionData('updateSession', [
        reference.status === 'OPEN' ? reference.regularOpen : 0,
        reference.status === 'OPEN' ? reference.regularClose : 0,
        reference.calendarObservedAt,
        reference.calendarDigest,
      ]),
      value: '0',
    },
  ];
  if (reference.status === 'OPEN') {
    fresh(reference.observedAt, now);
    if (!reference.priceRaw || reference.regularOpen > now || reference.regularClose <= now)
      throw new Error('REGULAR_SESSION_REQUIRED');
    actions.push({
      to: feed,
      data: feedInterface.encodeFunctionData('update', [
        reference.priceRaw,
        reference.observedAt,
        reference.sourceDigest,
      ]),
      value: '0',
    });
  }
  return {
    status: 'UNSIGNED_REQUIRES_KEEPER_APPROVAL',
    chainId: 46630,
    expiresAt: Math.min(reference.calendarObservedAt, reference.observedAt) + 60,
    source: reference.source,
    actions,
  };
}
