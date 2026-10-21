import type { StrategyId } from '../../../../packages/launch-market/src/types.ts';
import type { VaultRunChain } from './vault-run-chain.ts';

export interface VaultValuation {
  readonly owner: string;
  readonly strategyId: StrategyId;
  readonly vault: string | null;
  readonly equityRaw: string | null;
  readonly principalRaw: string;
  readonly profitRaw: string | null;
  readonly returnBps: string | null;
  readonly status: 'FRESH' | 'STALE' | 'UNAVAILABLE';
  readonly observedAt: number;
  readonly priceObservedAt: number | null;
}
export interface VaultValuationOptions {
  readonly chain: Pick<VaultRunChain, 'readValuation'>;
  /** Verified source, display valuation only. This callback does not publish prices or place orders. */
  readonly readPrice?: (strategyId: StrategyId) => Promise<{ priceRaw: string; observedAt: number } | null>;
  readonly now?: () => number;
}
/** Cash plus stock value, including losses. Never used to authorize a funding or stock transaction. */
export class VaultValuations {
  readonly #options: VaultValuationOptions;
  readonly #now: () => number;
  readonly #inflight = new Map<string, Promise<VaultValuation>>();
  readonly #cache = new Map<string, VaultValuation>();
  constructor(options: VaultValuationOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }
  async read(
    owner: string,
    strategyId: StrategyId,
    options: { fresh?: boolean } = {},
  ): Promise<VaultValuation> {
    const key = owner.toLowerCase() + ':' + strategyId,
      now = this.#now();
    const cached = this.#cache.get(key);
    if (!options.fresh && cached && now - cached.observedAt >= 0 && now - cached.observedAt < 5)
      return cached;
    const existing = this.#inflight.get(key);
    if (!options.fresh && existing) return existing;
    if (options.fresh) this.#cache.delete(key);
    const work = this.#read(owner, strategyId, options.fresh ?? false);
    this.#inflight.set(key, work);
    try {
      const result = await work;
      if (this.#inflight.get(key) === work) this.#cache.set(key, result);
      if (this.#cache.size > 200) this.#cache.delete(this.#cache.keys().next().value!);
      return result;
    } finally {
      if (this.#inflight.get(key) === work) this.#inflight.delete(key);
    }
  }
  async #read(owner: string, strategyId: StrategyId, fresh: boolean): Promise<VaultValuation> {
    const read = await this.#options.chain.readValuation(owner, strategyId, { fresh });
    const observation = read.observation;
    let priceRaw = read.priceRaw,
      priceObservedAt = read.priceObservedAt;
    const current = () =>
      priceObservedAt !== null && priceObservedAt <= this.#now() && this.#now() - priceObservedAt <= 60;
    if (observation.positionRaw !== '0' && !current() && this.#options.readPrice) {
      try {
        const reference = await this.#options.readPrice(strategyId);
        if (
          reference &&
          /^[1-9][0-9]{0,77}$/.test(reference.priceRaw) &&
          Number.isSafeInteger(reference.observedAt) &&
          reference.observedAt <= this.#now() &&
          this.#now() - reference.observedAt <= 60
        ) {
          priceRaw = reference.priceRaw;
          priceObservedAt = reference.observedAt;
        }
      } catch {
        /* A failed source never substitutes a made-up price. */
      }
    }
    const hasPosition = BigInt(observation.positionRaw) > 0n;
    const priceUsable = priceRaw !== null && /^[1-9][0-9]{0,77}$/.test(priceRaw);
    const equity = !hasPosition
      ? BigInt(observation.cashRaw)
      : priceUsable
        ? BigInt(observation.cashRaw) + (BigInt(observation.positionRaw) * BigInt(priceRaw!)) / 10n ** 18n
        : null;
    const principal = BigInt(read.principalRaw),
      profit = equity === null ? null : equity - principal;
    return {
      owner: observation.owner,
      strategyId,
      vault: observation.vault,
      principalRaw: read.principalRaw,
      equityRaw: equity === null ? null : String(equity),
      profitRaw: profit === null ? null : String(profit),
      returnBps: profit === null || principal <= 0n ? null : String((profit * 10000n) / principal),
      status: equity === null ? 'UNAVAILABLE' : hasPosition && !current() ? 'STALE' : 'FRESH',
      observedAt: this.#now(),
      priceObservedAt: hasPosition ? priceObservedAt : null,
    };
  }
}
