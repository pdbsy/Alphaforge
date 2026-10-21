import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  LaunchMarketError,
  type MarketAccount,
  type StrategyId,
} from '../../../../packages/launch-market/src/types.ts';
import {
  usablePaperEntryPrice,
  type PaperExecutionPrice,
  type PaperLedger,
  type PaperLedgerValue,
} from '../../../../packages/launch-market/src/paper-ledger.ts';
import type { VaultRunStore } from '../../../../packages/launch-market/src/vault-run.ts';

export interface PaperIndexedReal {
  readonly vault: string | null;
  readonly principalRaw: string;
  readonly cashRaw: string;
  readonly withdrawableRaw: string;
  readonly lockedPassRaw: string;
  readonly observedAt: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly confirmations: number;
}
export interface PaperValueQuote {
  readonly sourceId: 'ALPACA_IEX' | null;
  readonly sourceAuthorized: boolean;
  readonly strategyId: StrategyId;
  readonly status: string;
  readonly marketState: 'OPEN' | 'CLOSED' | null;
  readonly priceRaw: string | null;
  readonly observedAt: number | null;
  readonly fetchedAt: number | null;
  readonly expiresAt: number | null;
  readonly lastKnownPriceRaw?: string | null;
  readonly lastKnownObservedAt?: number | null;
}
export interface PaperVaultRoutesOptions {
  readonly ledger: PaperLedger;
  readonly store: VaultRunStore;
  /** Reads canonical owner-scoped indexed funding events. Never an RPC call or a user-supplied owner. */
  readonly readReal: (
    owner: string,
    id: StrategyId,
    options: { vault?: string },
  ) => PaperIndexedReal | Promise<PaperIndexedReal>;
  readonly readMarket: () => Promise<{ quotes: Readonly<Record<StrategyId, PaperValueQuote>> }>;
  readonly canonicalAnchor: (height: string) => { known: boolean; blockHash: string | null };
  readonly resolveAccount: (request: FastifyRequest) => Promise<MarketAccount | null>;
  readonly consumeRate: (key: string, limit: number, windowSeconds: number, now: number) => void;
  readonly now: () => number;
}
export type PaperVaultValueOptions = Omit<PaperVaultRoutesOptions, 'resolveAccount' | 'consumeRate' | 'now'>;
export type PaperVaultValueResponse = PaperLedgerValue;
export function registerPaperVaultRoutes(app: FastifyInstance, options: PaperVaultRoutesOptions): void {
  app.get<{ Params: { strategyId: StrategyId }; Querystring: { vault?: string; fresh?: '1' } }>(
    '/api/launch-market/vault-values/:strategyId',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['strategyId'],
          properties: { strategyId: { enum: ['TSLA', 'AMZN'] } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            vault: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
            fresh: { type: 'string', enum: ['1'] },
          },
        },
      },
    },
    async (request, reply): Promise<PaperLedgerValue> => {
      reply.header('Cache-Control', 'private, no-store');
      const owner = (await options.resolveAccount(request))?.wallet?.toLowerCase();
      if (!owner) throw new LaunchMarketError('LINKED_WALLET_REQUIRED', 401);
      const id = request.params.strategyId,
        now = options.now();
      options.consumeRate('paper-values:' + owner, 120, 60, now);
      // Finish asynchronous price reads before pinning confirmed history. The
      // following anchor and ledger checks are synchronous and must not race
      // a new index scan while waiting for the market-data network request.
      let quote: PaperValueQuote | null = null;
      try {
        quote = (await options.readMarket()).quotes[id];
      } catch {
        /* The physical balance remains readable without a price. */
      }
      const real = await options.readReal(
        owner,
        id,
        request.query.vault ? { vault: request.query.vault } : {},
      );
      const raw = (v: string) =>
        typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << 256n;
      if (
        ![real.principalRaw, real.cashRaw, real.withdrawableRaw, real.lockedPassRaw, real.blockNumber].every(
          raw,
        ) ||
        !/^0x[0-9a-f]{64}$/i.test(real.blockHash) ||
        !Number.isSafeInteger(real.observedAt) ||
        real.confirmations < 3 ||
        (request.query.vault && real.vault?.toLowerCase() !== request.query.vault.toLowerCase())
      )
        throw new LaunchMarketError('PAPER_CHAIN_INDEX_SYNCING', 503);
      const pinned = options.canonicalAnchor(real.blockNumber);
      if (!pinned.known || pinned.blockHash?.toLowerCase() !== real.blockHash.toLowerCase())
        throw new LaunchMarketError('PAPER_CHAIN_INDEX_SYNCING', 503);
      for (const anchor of options.ledger.anchors(owner, id)) {
        if (BigInt(anchor.blockNumber) > BigInt(real.blockNumber))
          throw new LaunchMarketError('PAPER_CHAIN_INDEX_SYNCING', 503);
        const canonical = options.canonicalAnchor(anchor.blockNumber);
        if (!canonical.known) throw new LaunchMarketError('PAPER_CHAIN_INDEX_SYNCING', 503);
        if (canonical.blockHash?.toLowerCase() !== anchor.blockHash)
          options.ledger.setCanonical(anchor.proofId, canonical.blockHash);
      }
      let mark: PaperExecutionPrice | null = null;
      if (quote?.sourceAuthorized && quote.sourceId === 'ALPACA_IEX') {
        const price = quote.priceRaw ?? quote.lastKnownPriceRaw,
          at = quote.priceRaw !== null ? quote.observedAt : quote.lastKnownObservedAt;
        if (
          price &&
          at !== null &&
          at !== undefined &&
          /^[1-9][0-9]{0,77}$/.test(price) &&
          Number.isSafeInteger(at) &&
          at <= now
        )
          mark = {
            sourceId: 'ALPACA_IEX',
            sourceAuthorized: true,
            strategyId: id,
            priceRaw: price,
            observedAt: at,
            fetchedAt: quote.fetchedAt ?? at,
            expiresAt: quote.expiresAt ?? at,
            marketState: quote.marketState ?? 'CLOSED',
          };
      }
      const fromCurrent = !!mark && quote?.priceRaw !== null;
      if (!mark) mark = options.ledger.latestMark(id);
      const paper = options.ledger.book(owner, id, real.vault, mark, now);
      if (BigInt(paper.allocatedPrincipalRaw) > BigInt(real.cashRaw))
        throw new LaunchMarketError('PAPER_CHAIN_INDEX_SYNCING', 503);
      const fresh =
        fromCurrent &&
        quote?.sourceAuthorized === true &&
        quote?.status === 'READY' &&
        usablePaperEntryPrice(mark, id, now);
      return {
        schemaVersion: 2,
        executionMode: 'PAPER',
        owner,
        strategyId: id,
        vault: real.vault,
        paused: options.store.get(owner, id).paused,
        closedVaults: options.ledger.closedVaults(owner, id),
        real: {
          principalRaw: real.principalRaw,
          cashRaw: real.cashRaw,
          withdrawableRaw: real.withdrawableRaw,
          lockedPassRaw: real.lockedPassRaw,
          observedAt: real.observedAt,
          blockNumber: real.blockNumber,
          blockHash: real.blockHash,
          confirmations: real.confirmations,
        },
        paper: {
          ...paper,
          observedAt: now,
          priceObservedAt: mark?.observedAt ?? null,
          quoteStatus: mark ? (fresh ? 'FRESH' : 'STALE') : 'UNAVAILABLE',
          marketSession: quote?.marketState ?? 'UNKNOWN',
          sourceId: mark?.sourceId ?? null,
        },
      };
    },
  );
}
