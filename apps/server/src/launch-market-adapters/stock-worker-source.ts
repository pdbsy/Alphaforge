import { VerifiedStockReference, type ConfirmedStockReference } from './stock-reference.ts';
import { stockEvidenceHash, type StockMinuteBar } from './stock-worker-policy.ts';

export interface StockWorkerSource {
  read(strategyId: 'TSLA' | 'AMZN'): Promise<ConfirmedStockReference>;
  minuteBars(reference: ConfirmedStockReference, count: number): Promise<readonly StockMinuteBar[]>;
  evidence?(strategyId: 'TSLA' | 'AMZN'): unknown;
}
/** Credentialed GET-only IEX source. Closed sessions never fetch quotes or bars. */
export class AlpacaStockWorkerSource implements StockWorkerSource {
  readonly reader: VerifiedStockReference;
  readonly options: {
    readonly apiKey: string;
    readonly apiSecret: string;
    readonly fetcher?: typeof fetch;
    readonly now?: () => number;
  };
  readonly #captured = new Map<'TSLA' | 'AMZN', unknown>();
  constructor(options: AlpacaStockWorkerSource['options']) {
    this.options = options;
    this.reader = new VerifiedStockReference({
      ...options,
      capture: (evidence) => {
        const value = evidence as { strategyId: 'TSLA' | 'AMZN' };
        this.#captured.set(value.strategyId, evidence);
      },
    });
  }
  read(strategyId: 'TSLA' | 'AMZN') {
    return this.reader.read(strategyId);
  }
  evidence(strategyId: 'TSLA' | 'AMZN') {
    return this.#captured.get(strategyId);
  }
  async minuteBars(reference: ConfirmedStockReference, count: number): Promise<readonly StockMinuteBar[]> {
    const now = this.options.now?.() ?? Math.floor(Date.now() / 1000);
    if (
      reference.status !== 'OPEN' ||
      now >= reference.regularClose ||
      now < reference.regularOpen ||
      now - reference.calendarObservedAt > 60 ||
      !Number.isSafeInteger(count) ||
      count < 7 ||
      count > 361
    )
      throw new Error('STOCK_BARS_SESSION');
    // Alpaca can revise the previous minute after late trades at the half-minute mark.
    // Wait 90 seconds after each bar's start, then bind the returned source digest to the order.
    const end = Math.floor((now - 90) / 60) * 60;
    const start = end - (count - 1) * 60;
    if (start < reference.regularOpen) throw new Error('STOCK_EMA_WARMUP');
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${reference.strategyId}/bars`);
    url.search = new URLSearchParams({
      timeframe: '1Min',
      start: new Date(start * 1000).toISOString(),
      end: new Date((end + 1) * 1000).toISOString(),
      limit: String(count),
      feed: 'iex',
      adjustment: 'raw',
      sort: 'asc',
    }).toString();
    const response = await (this.options.fetcher ?? fetch)(url.toString(), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
      headers: { 'APCA-API-KEY-ID': this.options.apiKey, 'APCA-API-SECRET-KEY': this.options.apiSecret },
    });
    if (!response.ok || !response.body) throw new Error('STOCK_BARS_UNAVAILABLE');
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 262144) throw new Error('STOCK_BARS_RESPONSE_LIMIT');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as {
      symbol?: unknown;
      bars?: unknown;
      next_page_token?: unknown;
    };
    if (
      raw.symbol !== reference.strategyId ||
      !Array.isArray(raw.bars) ||
      raw.bars.length !== count ||
      raw.next_page_token
    )
      throw new Error('STOCK_BARS_INCOMPLETE');
    return raw.bars.map((value: unknown, index: number) => {
      if (!value || typeof value !== 'object') throw new Error('STOCK_BAR_INVALID');
      const bar = value as { t?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown; v?: unknown };
      const at = typeof bar.t === 'string' ? Date.parse(bar.t) / 1000 : NaN;
      const numbers = [bar.o, bar.h, bar.l, bar.c];
      if (
        at !== start + index * 60 ||
        !numbers.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0) ||
        typeof bar.v !== 'number' ||
        !Number.isSafeInteger(bar.v) ||
        bar.v < 1 ||
        Number(bar.h) < Math.max(Number(bar.o), Number(bar.c), Number(bar.l)) ||
        Number(bar.l) > Math.min(Number(bar.o), Number(bar.c), Number(bar.h))
      )
        throw new Error('STOCK_BAR_INVALID');
      const close = String(bar.c);
      if (!/^[1-9][0-9]{0,8}(?:\.[0-9]{1,6})?$/.test(close) && !/^0\.[0-9]{1,6}$/.test(close))
        throw new Error('STOCK_BAR_PRECISION');
      const [whole, fraction = ''] = close.split('.');
      const price = BigInt(whole!) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
      if (!price) throw new Error('STOCK_BAR_PRECISION');
      return {
        start: at,
        closeUsdcRaw: String(price),
        sourceDigest: stockEvidenceHash({ source: 'Alpaca IEX', strategyId: reference.strategyId, bar }),
        sourceEvidence: bar,
      };
    });
  }
}
