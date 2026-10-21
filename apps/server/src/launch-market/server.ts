import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { isAbsolute } from 'node:path';
import type { LaunchMarketService } from '../../../../packages/launch-market/src/service.ts';
import {
  LaunchMarketError,
  type TrustedEmailIdentity,
} from '../../../../packages/launch-market/src/types.ts';
import { registerLaunchMarketRoutes } from './routes.ts';
import type { MarketEventIndexer } from './indexer.ts';
import { StockReferenceHistory, type StockHistoryRange } from '../stock-reference/history.ts';
import { StockReferenceQuotes } from '../stock-reference/quotes.ts';
import type { CommunityStore } from '../../../../packages/launch-market/src/community.ts';
import type { CreatorStrategyStore } from '../../../../packages/launch-market/src/creator.ts';
import type { StockAutomationOptions } from './automation-routes.ts';
import type { VaultRunOptions } from './vault-run-routes.ts';
import type { VaultValuations } from '../launch-market-adapters/vault-valuation.ts';
import type { OperatorStockDataOptions } from './operator-stock-data-routes.ts';
import type { PaperVaultValueOptions } from './paper-vault-routes.ts';
import type { PaperMarketDataCache } from '../launch-market-adapters/paper-market-data.ts';

export interface LaunchMarketServerOptions {
  readonly service: LaunchMarketService;
  readonly trustedIdentity: (
    request: FastifyRequest,
  ) => TrustedEmailIdentity | null | Promise<TrustedEmailIdentity | null>;
  /** Public origin used for host and browser mutation checks; identity callback must also validate CSRF. */
  readonly origin: string;
  /** Read the trusted console policy for every request. Unavailable policy keeps verification enabled. */
  readonly verificationRequired?: () => boolean | Promise<boolean>;
  readonly indexer?: MarketEventIndexer;
  readonly webRoot?: string;
  readonly community?: CommunityStore;
  readonly creators?: CreatorStrategyStore;
  readonly canCommunityWrite?: () => boolean;
  readonly automation?: StockAutomationOptions;
  readonly vaultRun?: VaultRunOptions;
  readonly vaultValuations?: Pick<VaultValuations, 'read'>;
  readonly operatorStockData?: OperatorStockDataOptions;
  readonly paperVault?: PaperVaultValueOptions;
  readonly paperMarketData?: Pick<PaperMarketDataCache, 'read' | 'status'>;
  readonly rpcProvider?: 'OFFICIAL_PUBLIC';
  /** Read-only UI references, independent of the trusted stock execution/valuation adapter. */
  readonly stockHistory?: Pick<StockReferenceHistory, 'read'>;
  readonly stockQuotes?: Pick<StockReferenceQuotes, 'read'>;
  /** Qualifies the concrete RPC reader and external credential/feed adapters before serving. */
  readonly initialize?: () => Promise<void>;
  /** Stop shared maintenance before its ledger/chain dependencies are closed. */
  readonly beforeClose?: () => Promise<void>;
  /** Release concrete provider/feed resources. The builder owns service and indexer shutdown. */
  readonly dispose?: () => Promise<void>;
}
export interface LaunchMarketServer {
  readonly app: FastifyInstance;
  start(host?: string, port?: number): Promise<string>;
  stop(): Promise<void>;
}

/** A separate onchain runtime: no legacy local-money store or mock market routes are registered. */
export async function buildLaunchMarketServer(
  options: LaunchMarketServerOptions,
): Promise<LaunchMarketServer> {
  const origin = new URL(options.origin);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new LaunchMarketError('INVALID_MARKET_ORIGIN', 400);
  if (options.webRoot !== undefined && !isAbsolute(options.webRoot))
    throw new LaunchMarketError('ABSOLUTE_WEB_ROOT_REQUIRED', 400);
  if (options.indexer && options.indexer.options.service !== options.service)
    throw new LaunchMarketError('INDEX_SERVICE_MISMATCH', 400);
  if (options.service.config().deployment === 'CONFIGURED' && !options.service.options.chain)
    throw new LaunchMarketError('MARKET_CHAIN_NOT_CONFIGURED', 503);
  const app = Fastify({
    logger: false,
    // The gateway replaces X-Forwarded-For with the remote client address.
    // Only the loopback reverse proxy may supply that address for rate limits.
    trustProxy: ['127.0.0.1', '::1'],
    bodyLimit: 16_384,
    requestTimeout: 10_000,
    // The first bounded historical scan can exceed Fastify's default 10-second readiness deadline.
    pluginTimeout: 60_000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  await app.register(cookie);
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cache-Control', 'no-store');
    const requestHost = request.headers.host?.toLowerCase();
    const defaultPortHost = origin.port
      ? null
      : origin.hostname + ':' + (origin.protocol === 'https:' ? '443' : '80');
    if (requestHost !== origin.host && requestHost !== defaultPortHost)
      throw new LaunchMarketError('INVALID_REQUEST_HOST', 403);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== origin.origin)
      throw new LaunchMarketError('INVALID_REQUEST_ORIGIN', 403);
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof LaunchMarketError)
      return reply.code(error.statusCode).send({ error: { code: error.code } });
    if (error && typeof error === 'object' && 'validation' in error)
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    return reply.code(503).send({ error: { code: 'MARKET_UNAVAILABLE' } });
  });
  registerLaunchMarketRoutes(app, options);
  const stockHistory = options.stockHistory ?? new StockReferenceHistory();
  const stockQuotes = options.stockQuotes ?? new StockReferenceQuotes();
  const symbols = ['TSLA', 'AMZN'];
  app.get<{ Querystring: { symbol: 'TSLA' | 'AMZN'; range?: StockHistoryRange } }>(
    '/api/stock-reference/candles',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['symbol'],
          properties: { symbol: { enum: symbols }, range: { enum: ['1D', '1W', '1M', '3M', '1Y'] } },
        },
      },
    },
    async (request) => stockHistory.read(request.query.symbol, request.query.range ?? '1Y'),
  );
  app.get<{ Querystring: { symbol: 'TSLA' | 'AMZN' } }>(
    '/api/stock-reference/quote',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['symbol'],
          properties: { symbol: { enum: symbols } },
        },
      },
    },
    async (request) => stockQuotes.read(request.query.symbol),
  );
  app.get('/health', async () => ({
    ok:
      options.service.config().deployment === 'NOT_DEPLOYED' ||
      !options.indexer ||
      options.indexer.status().state === 'HEALTHY',
    mode: 'ONCHAIN_TESTNET',
    deployment: options.service.config().deployment,
    chainId: options.service.config().chainId,
    indexer: options.indexer?.status() ?? null,
  }));
  if (options.indexer) {
    const indexer = options.indexer;
    const querySchema = {
      type: 'object',
      additionalProperties: false,
      required: ['strategyId'],
      properties: {
        strategyId: { enum: ['TSLA', 'AMZN'] },
        limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
        bucketSeconds: { type: 'string', pattern: '^[1-9][0-9]{0,4}$' },
      },
    };
    for (const name of ['history', 'holders', 'candles'] as const) {
      app.get<{ Querystring: { strategyId: 'TSLA' | 'AMZN'; limit?: string; bucketSeconds?: string } }>(
        '/api/launch-market/' + name,
        { schema: { querystring: querySchema } },
        async (request) =>
          indexer.readStableHistory(() => {
            const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
            const result =
              name === 'candles'
                ? indexer.candles(
                    request.query.strategyId,
                    request.query.bucketSeconds === undefined ? 60 : Number(request.query.bucketSeconds),
                    limit,
                  )
                : indexer[name](request.query.strategyId, limit);
            return {
              [name]: result,
              location: options.service.projector.latest()!.location,
              indexer: indexer.status(),
            };
          }),
      );
    }
  }
  if (options.webRoot) {
    await app.register(staticFiles, { root: options.webRoot, prefix: '/', wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === 'GET' &&
        request.headers.accept?.includes('text/html') &&
        !request.url.startsWith('/api/') &&
        !request.url.startsWith('/auth/')
      )
        return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    });
  } else app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND' } }));
  app.addHook('onReady', async () => {
    await options.initialize?.();
    if (options.indexer) {
      await options.indexer.poll();
      options.indexer.start();
    }
  });
  app.addHook('onClose', async () => {
    try {
      await options.beforeClose?.();
      await options.indexer?.close();
    } finally {
      try {
        try {
          options.service.close();
        } finally {
          options.community?.close();
          options.creators?.close();
          options.vaultRun?.store.close();
        }
      } finally {
        await options.dispose?.();
      }
    }
  });
  return {
    app,
    start: async (
      host = '127.0.0.1',
      port = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)),
    ) => app.listen({ host, port }),
    stop: async () => app.close(),
  };
}
