import type { StrategyId } from '../../../../packages/launch-market/src/types.ts';

export type PaperMarketSourceId = 'ALPACA_IEX';
export type PaperQuoteStatus =
  'NOT_CONFIGURED' | 'NOT_AUTHORIZED' | 'READY' | 'MARKET_CLOSED' | 'STALE' | 'UNAVAILABLE';
export interface PaperMarketSourceQuote {
  readonly strategyId: StrategyId;
  readonly marketState: 'OPEN' | 'CLOSED';
  /** AF-USDC precision: six decimal places per stock unit. CLOSED has no new price. */
  readonly priceRaw: string | null;
  readonly observedAt: number;
}
export interface PaperMarketDataSource {
  readonly sourceId: PaperMarketSourceId;
  /** One authorized, shared batch for both symbols. A provider must honor cancellation. */
  readBatch(options: {
    readonly signal: AbortSignal;
  }): Promise<Readonly<Record<StrategyId, PaperMarketSourceQuote>>>;
}
export interface PaperMarketQuote {
  readonly strategyId: StrategyId;
  readonly sourceId: PaperMarketSourceId | null;
  readonly sourceAuthorized: boolean;
  readonly status: PaperQuoteStatus;
  readonly marketState: 'OPEN' | 'CLOSED' | null;
  /** Non-null only for a current authorized OPEN reference. Never generated locally. */
  readonly priceRaw: string | null;
  readonly observedAt: number | null;
  readonly fetchedAt: number | null;
  readonly expiresAt: number | null;
  /** Display evidence only. These timestamps are never renewed by a closed session or failure. */
  readonly lastKnownPriceRaw: string | null;
  readonly lastKnownObservedAt: number | null;
}
export interface PaperMarketDataSnapshot {
  readonly sourceId: PaperMarketSourceId | null;
  readonly sourceAuthorized: boolean;
  readonly status: 'NOT_CONFIGURED' | 'NOT_AUTHORIZED' | 'READY' | 'MARKET_CLOSED' | 'DEGRADED';
  readonly refreshIntervalSeconds: 30;
  readonly quotes: Readonly<Record<StrategyId, PaperMarketQuote>>;
}
export interface PaperMarketDataOptions {
  readonly source?: PaperMarketDataSource | null;
  /** A trusted server decision. Saved credentials alone do not establish permission. */
  readonly sourceAuthorization?: boolean;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
}
export type PaperEntryQuote = PaperMarketQuote & {
  readonly sourceId: PaperMarketSourceId;
  readonly sourceAuthorized: true;
  readonly status: 'READY';
  readonly marketState: 'OPEN';
  readonly priceRaw: string;
  readonly observedAt: number;
  readonly fetchedAt: number;
  readonly expiresAt: number;
};
const symbols = ['TSLA', 'AMZN'] as const;
const refreshSeconds = 30;
const sourceAgeSeconds = 60;
const seconds = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const price = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) < 1n << 256n;

/** The paper ledger receives this reference from its server callback, never an HTTP body. */
export function isPaperEntryQuote(quote: PaperMarketQuote, now: number): quote is PaperEntryQuote {
  return (
    seconds(now) &&
    ['TSLA', 'AMZN'].includes(quote.strategyId) &&
    quote.sourceId === 'ALPACA_IEX' &&
    quote.sourceAuthorized === true &&
    quote.status === 'READY' &&
    quote.marketState === 'OPEN' &&
    price(quote.priceRaw) &&
    seconds(quote.observedAt) &&
    seconds(quote.fetchedAt) &&
    seconds(quote.expiresAt) &&
    quote.observedAt <= now &&
    now - quote.observedAt <= sourceAgeSeconds &&
    quote.fetchedAt <= now &&
    now - quote.fetchedAt < refreshSeconds &&
    quote.expiresAt <= Math.min(quote.observedAt + sourceAgeSeconds, quote.fetchedAt + refreshSeconds) &&
    now < quote.expiresAt
  );
}
interface CachedQuote {
  readonly value: PaperMarketSourceQuote;
  readonly fetchedAt: number;
}
interface LastKnown {
  readonly priceRaw: string;
  readonly observedAt: number;
}

/** Two references shared across users. Inert until both a source and explicit permission are supplied. */
export class PaperMarketDataCache {
  readonly #source: PaperMarketDataSource | null;
  readonly #sourceId: PaperMarketSourceId | null;
  readonly #authorized: boolean;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #quotes = new Map<StrategyId, CachedQuote>();
  readonly #lastKnown = new Map<StrategyId, LastKnown>();
  #lastAttemptAt: number | null = null;
  #inflight: Promise<void> | null = null;
  constructor(options: PaperMarketDataOptions = {}) {
    this.#source = options.source ?? null;
    this.#sourceId = this.#source?.sourceId ?? null;
    this.#authorized = options.sourceAuthorization === true;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#timeoutMs = options.requestTimeoutMs ?? 3000;
    if (
      (this.#source && (this.#sourceId !== 'ALPACA_IEX' || typeof this.#source.readBatch !== 'function')) ||
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > 5000
    )
      throw new Error('PAPER_MARKET_CONFIGURATION_INVALID');
  }
  #clock(): number {
    const now = this.#now();
    if (!seconds(now)) throw new Error('PAPER_MARKET_CLOCK_INVALID');
    return now;
  }
  #quote(strategyId: StrategyId, now: number): PaperMarketQuote {
    const last = this.#lastKnown.get(strategyId);
    const empty: PaperMarketQuote = {
      strategyId,
      sourceId: this.#sourceId,
      sourceAuthorized: this.#authorized && this.#source !== null,
      status: !this.#source ? 'NOT_CONFIGURED' : !this.#authorized ? 'NOT_AUTHORIZED' : 'UNAVAILABLE',
      marketState: null,
      priceRaw: null,
      observedAt: null,
      fetchedAt: null,
      expiresAt: null,
      lastKnownPriceRaw: last?.priceRaw ?? null,
      lastKnownObservedAt: last?.observedAt ?? null,
    };
    const cached = this.#quotes.get(strategyId);
    if (!cached || !empty.sourceAuthorized) return empty;
    const { value, fetchedAt } = cached;
    const expiresAt = Math.min(fetchedAt + refreshSeconds, value.observedAt + sourceAgeSeconds);
    const fresh = value.observedAt <= now && fetchedAt <= now && now < expiresAt;
    return {
      ...empty,
      status: !fresh ? 'STALE' : value.marketState === 'CLOSED' ? 'MARKET_CLOSED' : 'READY',
      marketState: value.marketState,
      priceRaw: fresh && value.marketState === 'OPEN' ? value.priceRaw : null,
      observedAt: value.observedAt,
      fetchedAt,
      expiresAt,
    };
  }
  /** Metadata/cache only: this method never calls a provider or renews an old reference. */
  status(): PaperMarketDataSnapshot {
    const now = this.#clock();
    const TSLA = this.#quote('TSLA', now),
      AMZN = this.#quote('AMZN', now);
    return {
      sourceId: this.#sourceId,
      sourceAuthorized: this.#authorized && this.#source !== null,
      status: !this.#source
        ? 'NOT_CONFIGURED'
        : !this.#authorized
          ? 'NOT_AUTHORIZED'
          : TSLA.status === 'READY' && AMZN.status === 'READY'
            ? 'READY'
            : TSLA.status === 'MARKET_CLOSED' && AMZN.status === 'MARKET_CLOSED'
              ? 'MARKET_CLOSED'
              : 'DEGRADED',
      refreshIntervalSeconds: 30,
      quotes: { TSLA, AMZN },
    };
  }
  #admit(value: unknown, strategyId: StrategyId, fetchedAt: number): PaperMarketSourceQuote {
    const item = value as PaperMarketSourceQuote;
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).sort().join('|') !== 'marketState|observedAt|priceRaw|strategyId' ||
      item.strategyId !== strategyId ||
      !['OPEN', 'CLOSED'].includes(item.marketState) ||
      !seconds(item.observedAt) ||
      (item.marketState === 'OPEN' ? !price(item.priceRaw) : item.priceRaw !== null)
    )
      throw new Error('PAPER_MARKET_REFERENCE_INVALID');
    if (item.observedAt > fetchedAt || fetchedAt - item.observedAt > sourceAgeSeconds)
      throw new Error('PAPER_MARKET_REFERENCE_STALE');
    return {
      strategyId,
      marketState: item.marketState,
      observedAt: item.observedAt,
      priceRaw: item.priceRaw,
    };
  }
  async #refresh(): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const batch = await Promise.race([
        this.#source!.readBatch({ signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('PAPER_MARKET_SOURCE_TIMEOUT'));
          }, this.#timeoutMs);
        }),
      ]);
      if (
        !batch ||
        typeof batch !== 'object' ||
        Array.isArray(batch) ||
        Object.keys(batch).sort().join('|') !== 'AMZN|TSLA'
      )
        throw new Error('PAPER_MARKET_REFERENCE_INVALID');
      const fetchedAt = this.#clock();
      for (const strategyId of symbols) {
        try {
          const value = this.#admit(batch[strategyId], strategyId, fetchedAt);
          this.#quotes.set(strategyId, { value, fetchedAt });
          if (value.marketState === 'OPEN')
            this.#lastKnown.set(strategyId, { priceRaw: value.priceRaw!, observedAt: value.observedAt });
        } catch {
          this.#quotes.delete(strategyId);
        }
      }
    } catch {
      // Provider errors can contain private headers or URLs. Public state exposes no error text.
      this.#quotes.clear();
    } finally {
      clearTimeout(timer);
    }
  }
  /** At most one shared batch per 30-second attempt window, including failures and empty sessions. */
  async read(): Promise<PaperMarketDataSnapshot> {
    const now = this.#clock();
    if (!this.#source || !this.#authorized) return this.status();
    if (this.#inflight) {
      await this.#inflight;
      return this.status();
    }
    if (this.#lastAttemptAt !== null && now - this.#lastAttemptAt < refreshSeconds) return this.status();
    this.#lastAttemptAt = now;
    const work = this.#refresh();
    this.#inflight = work;
    try {
      await work;
      return this.status();
    } finally {
      if (this.#inflight === work) this.#inflight = null;
    }
  }
}
