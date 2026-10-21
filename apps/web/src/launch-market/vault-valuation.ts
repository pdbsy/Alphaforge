import { createCommunityApi, type CommunityApi } from '../community/client.ts';
import type { LaunchClientState, StrategyId } from './model.ts';
import type { PaperLedgerValue } from '../../../../packages/launch-market/src/paper-ledger.ts';
import type { VaultValuationView, VaultValuationsView } from './vault-actions-ui.ts';

type ViewClient = {
  readonly state: LaunchClientState;
  subscribe(listener: (state: LaunchClientState) => void): () => void;
  refresh(): Promise<void>;
};
interface Options {
  api?: CommunityApi;
  retryDelay?: () => Promise<void>;
  render?: () => void;
  now?: () => number;
  visible?: () => boolean;
  strategies?: () => StrategyId[];
  activePage?: () => boolean;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
  listen?: (callback: () => void) => () => void;
}
const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
const uint = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
const syncing = (error: unknown) =>
  error instanceof Error && ['PAPER_CHAIN_INDEX_SYNCING', 'MARKET_HISTORY_SYNCING'].includes(error.message);
const activeStrategies = (): StrategyId[] => {
  const parts = globalThis.location?.hash.split('/') ?? [];
  if (parts[1] !== 'account') return [];
  if (['vaults', 'funds'].includes(parts[2] ?? '')) {
    const selected = parts[3]?.toUpperCase();
    return selected === 'TSLA' || selected === 'AMZN' ? [selected] : ['TSLA', 'AMZN'];
  }
  if (['trades', 'passes', undefined].includes(parts[2]))
    return (['TSLA', 'AMZN'] as const).filter((id) =>
      globalThis.document?.querySelector(`[data-launch-position="${id}"][open]`),
    );
  return [];
};

/** Display polling is separate from trading. No quote, wallet signature or broadcast is requested here. */
export class VaultValuationController {
  readonly #client: ViewClient;
  readonly #api: CommunityApi;
  readonly #options: Options;
  readonly #unsubscribe: () => void;
  readonly #unlisten: () => void;
  #values: VaultValuationsView = {};
  #identity = '';
  #key = '';
  #generation = 0;
  #active: StrategyId[] = [];
  #running = false;
  #stop: (() => void) | null = null;
  #inflight: { generation: number; promise: Promise<void> } | null = null;
  #completed: string | null = null;
  #disposed = false;
  constructor(client: ViewClient, options: Options = {}) {
    this.#client = client;
    this.#options = options;
    this.#api = options.api ?? createCommunityApi();
    const listen =
      options.listen ??
      ((callback: () => void) => {
        globalThis.document?.addEventListener('visibilitychange', callback);
        globalThis.window?.addEventListener('hashchange', callback);
        return () => {
          globalThis.document?.removeEventListener?.('visibilitychange', callback);
          globalThis.window?.removeEventListener?.('hashchange', callback);
        };
      });
    this.#unlisten = listen(() => this.sync());
    this.#unsubscribe = client.subscribe((state) => {
      this.sync();
      const completed = state.transaction.state === 'COMPLETED' ? state.transaction.hash : null;
      if (completed && completed !== this.#completed) {
        this.#completed = completed;
        if (this.#running) void this.#tick(true);
      }
    });
  }
  get state(): VaultValuationsView {
    return this.#values;
  }
  sync(): void {
    if (this.#disposed) return;
    const state = this.#client.state;
    const identity = JSON.stringify([
      state.owner?.toLowerCase(),
      state.account?.id,
      state.account?.wallet?.toLowerCase(),
      state.wallet?.accountId,
    ]);
    if (identity !== this.#identity) {
      this.#identity = identity;
      this.#generation++;
      this.#values = {};
    }
    const visible = this.#options.visible?.() ?? globalThis.document?.visibilityState === 'visible';
    const linked =
      !!state.owner &&
      same(state.owner, state.account?.wallet) &&
      state.account?.id === state.wallet?.accountId;
    const selected = this.#options.strategies?.() ?? activeStrategies();
    const active = visible && linked ? selected : [];
    const route = globalThis.location?.hash.split('/') ?? [];
    const financialPage =
      this.#options.activePage?.() ??
      (this.#options.strategies
        ? true
        : route[1] === 'account' && ['vaults', 'funds', 'trades', 'passes', undefined].includes(route[2]));
    const running = visible && linked && financialPage;
    const vaults = state.wallet?.vaults.map((v) => `${v.address.toLowerCase()}:${v.status}`).join(',');
    const key = `${identity}/${running}/${active.join(',')}/${vaults}`;
    if (key === this.#key) return;
    this.#key = key;
    this.#generation++;
    this.#active = [...new Set(active)];
    this.#running = running;
    this.#stop?.();
    this.#stop = null;
    if (!this.#running) return;
    const schedule =
      this.#options.schedule ??
      ((callback: () => void, ms: number) => {
        const timer = setInterval(callback, ms);
        timer.unref?.();
        return () => clearInterval(timer);
      });
    this.#stop = schedule(() => void this.#tick(), 30000);
    void this.refresh();
  }
  async #tick(fresh = false): Promise<void> {
    if (this.#disposed || !this.#running || !this.#active.length) return;
    await this.refresh(fresh);
  }
  #verify(value: unknown, id: StrategyId, expectedVault?: string): VaultValuationView {
    const response = value as PaperLedgerValue;
    const state = this.#client.state;
    const candidates = state.wallet?.vaults.filter((v) => v.strategyId === id) ?? [];
    const selected = candidates.find((v) => v.status === 'OPEN') ?? candidates.at(-1);
    const now = this.#options.now?.() ?? Math.floor(Date.now() / 1000);
    const seconds = (v: unknown): v is number =>
      Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= now + 30;
    const nullableTime = (v: unknown) => v === null || seconds(v);
    const signed = (v: unknown, bps = false): v is string =>
      typeof v === 'string' &&
      /^(0|-?[1-9][0-9]{0,82})$/.test(v) &&
      (BigInt(v) < 0n ? -BigInt(v) : BigInt(v)) < 2n ** 256n * (bps ? 10000n : 1n);
    const nullableSigned = (v: unknown, bps = false) => v === null || signed(v, bps);
    const nullableUint = (v: unknown) => v === null || uint(v);
    const hash = (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
    const real = response?.real,
      paper = response?.paper;
    if (
      !response ||
      response.schemaVersion !== 2 ||
      response.executionMode !== 'PAPER' ||
      !same(response.owner, state.owner) ||
      response.strategyId !== id ||
      (expectedVault
        ? !same(response.vault, expectedVault)
        : selected
          ? !same(response.vault, selected.address)
          : response.vault !== null) ||
      typeof response.paused !== 'boolean' ||
      !real ||
      !paper ||
      ![real.principalRaw, real.cashRaw, real.withdrawableRaw, real.lockedPassRaw, real.blockNumber].every(
        uint,
      ) ||
      BigInt(real.withdrawableRaw) > BigInt(real.cashRaw) ||
      !seconds(real.observedAt) ||
      !hash(real.blockHash) ||
      !Number.isSafeInteger(real.confirmations) ||
      real.confirmations < 3 ||
      !['EMPTY', 'OPEN', 'ENTRY_PENDING', 'CLOSED', 'SETTLEMENT_PENDING', 'REORG_REVIEW_REQUIRED'].includes(
        paper.status,
      ) ||
      ![
        paper.contributedRaw,
        paper.allocatedPrincipalRaw,
        paper.costBasisRaw,
        paper.quantityRaw,
        paper.idleRaw,
      ].every(uint) ||
      BigInt(paper.allocatedPrincipalRaw) > BigInt(paper.contributedRaw) ||
      !nullableUint(paper.equityRaw) ||
      ![paper.realizedRaw, paper.unrealizedRaw, paper.profitRaw].every((v) => nullableSigned(v)) ||
      !nullableSigned(paper.returnBps, true) ||
      !seconds(paper.observedAt) ||
      !nullableTime(paper.priceObservedAt) ||
      !['FRESH', 'STALE', 'UNAVAILABLE'].includes(paper.quoteStatus) ||
      !['OPEN', 'CLOSED', 'UNKNOWN'].includes(paper.marketSession) ||
      !(paper.sourceId === null || paper.sourceId === 'ALPACA_IEX') ||
      !Array.isArray(paper.history) ||
      paper.history.length > 200 ||
      !Array.isArray(paper.curve) ||
      paper.curve.length > 200
    )
      throw new Error('VAULT_VALUATION_INVALID');
    if (
      response.closedVaults !== undefined &&
      (!Array.isArray(response.closedVaults) ||
        response.closedVaults.length > 200 ||
        !response.closedVaults.every(
          (address) =>
            typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) && !/^0x0{40}$/i.test(address),
        ))
    )
      throw new Error('VAULT_VALUATION_INVALID');
    const profit =
      paper.equityRaw === null ? null : String(BigInt(paper.equityRaw) - BigInt(paper.contributedRaw));
    const returns =
      profit === null || paper.contributedRaw === '0'
        ? null
        : String((BigInt(profit) * 10000n) / BigInt(paper.contributedRaw));
    if (paper.profitRaw !== profit || paper.returnBps !== returns) throw new Error('VAULT_VALUATION_INVALID');
    for (const event of paper.history) {
      if (
        !event ||
        typeof event.eventId !== 'string' ||
        event.eventId.length > 200 ||
        !['DEPOSIT', 'ENTRY', 'CLOSE'].includes(event.kind) ||
        !hash(event.transactionHash) ||
        !hash(event.blockHash) ||
        !seconds(event.at) ||
        !uint(event.amountRaw) ||
        !uint(event.quantityRaw) ||
        !nullableUint(event.priceRaw) ||
        !nullableTime(event.priceObservedAt) ||
        !(event.sourceId === null || event.sourceId === 'ALPACA_IEX') ||
        !nullableSigned(event.profitRaw)
      )
        throw new Error('VAULT_VALUATION_INVALID');
    }
    for (const point of paper.curve) {
      if (
        !point ||
        !seconds(point.at) ||
        !uint(point.contributedRaw) ||
        !nullableUint(point.equityRaw) ||
        !nullableSigned(point.profitRaw) ||
        point.profitRaw !==
          (point.equityRaw === null ? null : String(BigInt(point.equityRaw) - BigInt(point.contributedRaw)))
      )
        throw new Error('VAULT_VALUATION_INVALID');
    }
    return { vault: response.vault, value: response, observedAt: real.observedAt, error: null, busy: false };
  }
  refresh(fresh = false): Promise<void> {
    if (this.#disposed || !this.#active.length) return Promise.resolve();
    const generation = fresh ? ++this.#generation : this.#generation;
    if (this.#inflight?.generation === generation) return this.#inflight.promise;
    const pending = { generation, promise: Promise.resolve() };
    pending.promise = (async () => {
      for (const id of [...this.#active]) {
        const read = async (address?: string) => {
          const query = [address ? `vault=${encodeURIComponent(address)}` : '', fresh ? 'fresh=1' : '']
            .filter(Boolean)
            .join('&');
          try {
            const path = `/api/launch-market/vault-values/${id}${query ? '?' + query : ''}`;
            let response: unknown;
            try {
              response = await this.#api(path);
            } catch (error) {
              if (!syncing(error)) throw error;
              await (this.#options.retryDelay?.() ??
                new Promise<void>((resolve) => setTimeout(resolve, 1000)));
              if (generation !== this.#generation || this.#disposed) return;
              response = await this.#api(path);
            }
            if (generation !== this.#generation || this.#disposed) return;
            const view = this.#verify(response, id, address);
            if (!address) {
              const canonicalClosed = new Set(view.value!.closedVaults.map((vault) => vault.toLowerCase()));
              this.#values.byVault = Object.fromEntries(
                Object.entries(this.#values.byVault ?? {}).filter(
                  ([vault, cached]) =>
                    cached.value?.strategyId !== id ||
                    !['CLOSED', 'SETTLEMENT_PENDING'].includes(cached.value.paper.status) ||
                    canonicalClosed.has(vault),
                ),
              );
              this.#values[id] = view;
            }
            if (view.vault)
              this.#values.byVault = { ...this.#values.byVault, [view.vault.toLowerCase()]: view };
          } catch (error) {
            if (generation !== this.#generation || this.#disposed) return;
            const previous = address ? this.#values.byVault?.[address.toLowerCase()] : this.#values[id];
            const view = {
              ...previous,
              observedAt: previous?.observedAt ?? null,
              error: syncing(error)
                ? 'Confirmed Vault history is syncing. Retrying automatically…'
                : 'The latest ledger value is unavailable. Recorded history is retained.',
            };
            if (address) this.#values.byVault = { ...this.#values.byVault, [address.toLowerCase()]: view };
            else {
              this.#values[id] = view;
              this.#values.byVault = Object.fromEntries(
                Object.entries(this.#values.byVault ?? {}).map(([vault, cached]) => [
                  vault,
                  cached.value?.strategyId === id ? { ...cached, error: view.error } : cached,
                ]),
              );
            }
          }
        };
        await read();
        if (generation !== this.#generation || this.#disposed) return;
        const indexed = this.#values[id]?.value?.closedVaults;
        const closed = new Set((indexed ?? []).map((address) => address.toLowerCase()));
        for (const address of closed) {
          const cached = this.#values.byVault?.[address];
          if (!fresh && !cached?.error && cached?.value && cached.value.paper.status === 'CLOSED') continue;
          await read(address);
          if (generation !== this.#generation || this.#disposed) return;
        }
      }
      if (generation === this.#generation && !this.#disposed) this.#options.render?.();
    })().finally(() => {
      if (this.#inflight === pending) this.#inflight = null;
    });
    this.#inflight = pending;
    return pending.promise;
  }
  dispose(): void {
    this.#disposed = true;
    this.#generation++;
    this.#active = [];
    this.#stop?.();
    this.#stop = null;
    this.#unsubscribe();
    this.#unlisten();
  }
}
