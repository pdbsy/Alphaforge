import type { StrategyId } from '../../../../packages/launch-market/src/types.ts';

export interface VaultReferenceDemandResult {
  readonly strategyId: StrategyId;
  readonly status: 'READY' | 'NOT_CONFIGURED' | 'MARKET_CLOSED' | 'UNAVAILABLE' | 'RATE_LIMITED';
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly priceRaw: string | null;
  readonly source: 'Alpaca IEX' | null;
  readonly reason: string;
}
export interface VaultReferenceDemandStatus {
  readonly available: boolean;
  readonly reason: 'READY' | 'NOT_CONFIGURED';
  readonly missing: readonly ('MARKET_DATA' | 'KEEPER_SIGNER')[];
}
export interface VaultReferenceDemandOptions {
  readonly sourceConfigured?: boolean;
  readonly keeperConfigured?: boolean;
  /** Real source + authorized keeper refresh. No default signer or market value is provided. */
  readonly refresh?: (strategyId: StrategyId, now: number) => Promise<VaultReferenceDemandResult>;
  readonly now?: () => number;
}

/** Only runs on an explicit request. Coalesces requests per stock and serializes keeper nonce usage. */
export class VaultReferenceDemand {
  readonly #options: VaultReferenceDemandOptions;
  readonly #now: () => number;
  readonly #inflight = new Map<StrategyId, Promise<VaultReferenceDemandResult>>();
  readonly #recent = new Map<StrategyId, { at: number; result: VaultReferenceDemandResult }>();
  #queue: Promise<unknown> = Promise.resolve();
  #window = -1;
  #attempts = 0;
  constructor(options: VaultReferenceDemandOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }
  status(): VaultReferenceDemandStatus {
    const missing: ('MARKET_DATA' | 'KEEPER_SIGNER')[] = [];
    if (!this.#options.sourceConfigured) missing.push('MARKET_DATA');
    if (!this.#options.keeperConfigured) missing.push('KEEPER_SIGNER');
    const available = missing.length === 0 && typeof this.#options.refresh === 'function';
    return { available, reason: available ? 'READY' : 'NOT_CONFIGURED', missing };
  }
  async request(strategyId: StrategyId): Promise<VaultReferenceDemandResult> {
    if (!['TSLA', 'AMZN'].includes(strategyId)) throw new Error('VAULT_REFERENCE_STRATEGY');
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('VAULT_REFERENCE_CLOCK');
    const disabled: VaultReferenceDemandResult = {
      strategyId,
      status: 'NOT_CONFIGURED',
      observedAt: now,
      expiresAt: now,
      priceRaw: null,
      source: null,
      reason: 'STOCK_REFERENCE_NOT_CONFIGURED',
    };
    if (!this.status().available) return disabled;
    const running = this.#inflight.get(strategyId);
    if (running) return running;
    const recent = this.#recent.get(strategyId);
    if (recent && now - recent.at >= 0 && now - recent.at < 5) {
      if (recent.result.status !== 'READY' || recent.result.expiresAt > now) return recent.result;
      return { ...disabled, status: 'UNAVAILABLE', reason: 'STOCK_REFERENCE_EXPIRED' };
    }
    const window = Math.floor(now / 60);
    if (window !== this.#window) {
      this.#window = window;
      this.#attempts = 0;
    }
    if (this.#attempts >= 24)
      return { ...disabled, status: 'RATE_LIMITED', reason: 'STOCK_REFERENCE_RATE_LIMITED' };
    this.#attempts++;
    const work = this.#queue
      .catch(() => undefined)
      .then(async () => {
        const startedAt = this.#now();
        let result: VaultReferenceDemandResult;
        try {
          result = await this.#options.refresh!(strategyId, startedAt);
          const endedAt = this.#now();
          if (
            !result ||
            result.strategyId !== strategyId ||
            !['READY', 'MARKET_CLOSED', 'UNAVAILABLE'].includes(result.status) ||
            !Number.isSafeInteger(result.observedAt) ||
            !Number.isSafeInteger(result.expiresAt) ||
            !['Alpaca IEX', null].includes(result.source) ||
            result.observedAt > endedAt ||
            endedAt - result.observedAt > 60 ||
            !/^[A-Z0-9_]{1,80}$/.test(result.reason) ||
            (result.status === 'READY' &&
              (result.source !== 'Alpaca IEX' ||
                !result.priceRaw ||
                !/^[1-9][0-9]{0,77}$/.test(result.priceRaw) ||
                BigInt(result.priceRaw) >= 1n << 256n ||
                result.expiresAt <= endedAt ||
                result.expiresAt > result.observedAt + 60)) ||
            (result.status !== 'READY' && result.priceRaw !== null)
          )
            throw new Error('VAULT_REFERENCE_INVALID');
          result = {
            strategyId,
            status: result.status,
            observedAt: result.observedAt,
            expiresAt: result.expiresAt,
            priceRaw: result.priceRaw,
            source: result.source,
            reason: result.reason,
          };
        } catch {
          // Never expose provider errors (which may contain private URLs/headers), or retain stale prices.
          result = {
            ...disabled,
            observedAt: this.#now(),
            expiresAt: this.#now(),
            status: 'UNAVAILABLE',
            reason: 'STOCK_REFERENCE_UNAVAILABLE',
          };
        }
        this.#recent.set(strategyId, { at: this.#now(), result });
        return result;
      });
    this.#queue = work;
    this.#inflight.set(strategyId, work);
    try {
      return await work;
    } finally {
      if (this.#inflight.get(strategyId) === work) this.#inflight.delete(strategyId);
    }
  }
}
