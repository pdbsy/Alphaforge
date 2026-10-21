import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { CommunityStore } from '../../../../packages/launch-market/src/community.ts';
import type { CreatorStrategyStore } from '../../../../packages/launch-market/src/creator.ts';
import { registerCommunityRoutes } from './community-routes.ts';
import { registerCreatorRoutes } from './creator-routes.ts';
import { registerAutomationRoutes, type StockAutomationOptions } from './automation-routes.ts';
import { registerVaultRunRoutes, type VaultRunOptions } from './vault-run-routes.ts';
import { registerPaperVaultRoutes, type PaperVaultValueOptions } from './paper-vault-routes.ts';
import type { PaperMarketDataCache } from '../launch-market-adapters/paper-market-data.ts';
import type { VaultValuations } from '../launch-market-adapters/vault-valuation.ts';
import type { LaunchMarketService } from '../../../../packages/launch-market/src/service.ts';
import {
  registerOperatorStockDataRoutes,
  type OperatorStockDataOptions,
} from './operator-stock-data-routes.ts';
import {
  LaunchMarketError,
  type QuoteRequest,
  type TrustedEmailIdentity,
  type MarketStreamUpdate,
  type MarketAccount,
} from '../../../../packages/launch-market/src/types.ts';

export interface LaunchMarketRoutesOptions {
  readonly service: LaunchMarketService;
  /** Must validate a server-issued account session and CSRF for mutations, never request email fields. */
  readonly trustedIdentity: (
    request: FastifyRequest,
  ) => Promise<TrustedEmailIdentity | null> | TrustedEmailIdentity | null;
  readonly verificationRequired?: () => boolean | Promise<boolean>;
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
}
const testSessionCookie = '__Host-af_market_test';
const ownerSchema = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', maxLength: 42 };
const idSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' };
const rawSchema = { type: 'string', pattern: '^(0|[1-9][0-9]{0,77})$', maxLength: 78 };
const body = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
export function registerLaunchMarketRoutes(app: FastifyInstance, options: LaunchMarketRoutesOptions): void {
  const service = options.service,
    clients = new Set<ServerResponse>();
  const verificationRequired = async () => {
    try {
      return (await options.verificationRequired?.()) !== false;
    } catch {
      return true;
    }
  };
  const testSession = (request: FastifyRequest, mutation = !['GET', 'HEAD'].includes(request.method)) => {
    const token = request.cookies?.[testSessionCookie],
      csrf = request.headers['x-csrf-token'];
    if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
    return service.options.store.walletTestSession(
      token,
      typeof csrf === 'string' ? csrf : null,
      service.now(),
      mutation,
    );
  };
  const authenticated = async (
    request: FastifyRequest,
  ): Promise<{
    current: MarketAccount;
    emailVerified: boolean;
    identityKind: 'GOOGLE' | 'WALLET_TEST';
  } | null> => {
    // A real test session selects the same account for reads and writes, even with an older Google cookie.
    // Wrong/missing test CSRF must not silently select a different Google account.
    if (!(await verificationRequired()) && testSession(request, false)) {
      const session = testSession(request);
      return session ? { current: session.account, emailVerified: false, identityKind: 'WALLET_TEST' } : null;
    }
    const identity = await options.trustedIdentity(request);
    return identity
      ? { current: service.account(identity), emailVerified: true, identityKind: 'GOOGLE' }
      : null;
  };
  const account = async (request: FastifyRequest) => {
    const auth = await authenticated(request);
    if (!auth)
      throw new LaunchMarketError(
        (await verificationRequired()) ? 'VERIFIED_EMAIL_REQUIRED' : 'MARKET_SESSION_REQUIRED',
        401,
      );
    return auth.current;
  };
  const verifiedAccount = async (request: FastifyRequest) => {
    const identity = await options.trustedIdentity(request);
    if (!identity) throw new LaunchMarketError('VERIFIED_EMAIL_REQUIRED', 401);
    return service.account(identity);
  };
  const requireTestMode = async (request: FastifyRequest) => {
    if (await verificationRequired()) throw new LaunchMarketError('VERIFIED_EMAIL_REQUIRED', 401);
    // Pre-session requests have no CSRF yet. Require the exact origin, including when routes are embedded.
    if (request.headers.origin !== service.options.store.origin)
      throw new LaunchMarketError('INVALID_REQUEST_ORIGIN', 403);
  };
  const routeError = (error: unknown) => {
    if (error instanceof LaunchMarketError) return error;
    return new LaunchMarketError('MARKET_OPERATION_UNAVAILABLE', 503);
  };
  // A route-scoped wrapper preserves the application's existing error policy.
  const execute = async <T>(work: () => Promise<T> | T): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw routeError(error);
    }
  };
  const resolveAccount = async (request: FastifyRequest) => (await authenticated(request))?.current ?? null;
  if (options.community) {
    const community = options.community;
    registerCommunityRoutes(app, {
      store: community,
      origin: service.options.store.origin,
      resolveAccount,
      now: service.now,
      ...(options.canCommunityWrite ? { canWrite: options.canCommunityWrite } : {}),
    });
    if (options.creators)
      registerCreatorRoutes(app, {
        store: options.creators,
        origin: service.options.store.origin,
        resolveAccount,
        now: service.now,
        canWrite: options.canCommunityWrite ?? (() => true),
        consumeRate: (key, limit, window, at) => community.consumeRate(key, limit, window, at),
      });
    if (options.automation)
      registerAutomationRoutes(app, {
        ...options.automation,
        origin: service.options.store.origin,
        resolveAccount,
        now: service.now,
        canWrite: options.canCommunityWrite ?? (() => true),
        consumeRate: (key, limit, window, at) => community.consumeRate(key, limit, window, at),
      });
    if (options.vaultRun)
      registerVaultRunRoutes(app, {
        ...options.vaultRun,
        origin: service.options.store.origin,
        resolveAccount,
        now: service.now,
        canWrite: options.canCommunityWrite ?? (() => true),
        consumeRate: (key, limit, window, at) => community.consumeRate(key, limit, window, at),
      });
    if (options.operatorStockData)
      registerOperatorStockDataRoutes(app, {
        ...options.operatorStockData,
        origin: service.options.store.origin,
        resolveAccount,
        now: service.now,
        canWrite: options.canCommunityWrite ?? (() => true),
        consumeRate: (key, limit, window, at) => community.consumeRate(key, limit, window, at),
      });
    if (options.paperVault)
      registerPaperVaultRoutes(app, {
        ...options.paperVault,
        resolveAccount,
        now: service.now,
        consumeRate: (key, limit, window, at) => community.consumeRate(key, limit, window, at),
      });
    if (options.vaultValuations && !options.paperVault) {
      const valuations = options.vaultValuations;
      app.get<{ Params: { strategyId: 'TSLA' | 'AMZN' }; Querystring: { fresh?: '1' } }>(
        '/api/launch-market/vault-values/:strategyId',
        {
          schema: {
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: { fresh: { type: 'string', enum: ['1'] } },
            },
            params: {
              type: 'object',
              additionalProperties: false,
              required: ['strategyId'],
              properties: { strategyId: { enum: ['TSLA', 'AMZN'] } },
            },
          },
        },
        async (request) => {
          const owner = (await resolveAccount(request))?.wallet;
          if (!owner) throw new LaunchMarketError('LINKED_WALLET_REQUIRED', 401);
          community.consumeRate('vault-values:' + owner, 120, 60, service.now());
          // The account resolver selects the wallet; callers cannot pass someone else's owner address.
          return valuations.read(owner, request.params.strategyId, { fresh: request.query.fresh === '1' });
        },
      );
    }
  } else if (
    options.creators ||
    options.automation ||
    options.vaultRun ||
    options.vaultValuations ||
    options.paperVault ||
    options.operatorStockData
  )
    throw new LaunchMarketError('COMMUNITY_STORE_REQUIRED', 503);
  app.get('/api/launch-market/config', async () => ({
    ...service.config(),
    emailVerificationRequired: await verificationRequired(),
    ...(options.paperVault ? { vaultExecutionMode: 'PAPER' } : {}),
    ...(options.rpcProvider ? { rpcProvider: options.rpcProvider } : {}),
  }));
  if (options.paperMarketData)
    app.get(
      '/api/launch-market/stock-data',
      { schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } } },
      async () => options.paperMarketData!.read(),
    );
  app.get('/api/launch-market/snapshot', async () => execute(() => service.snapshot()));
  app.get('/api/launch-market/eth-reference', async () => execute(() => service.ethReference()));
  app.get('/api/launch-market/account', async (request) =>
    execute(async () => {
      const auth = await authenticated(request);
      if (!auth)
        throw new LaunchMarketError(
          (await verificationRequired()) ? 'VERIFIED_EMAIL_REQUIRED' : 'MARKET_SESSION_REQUIRED',
          401,
        );
      const current = auth.current;
      return {
        id: current.id,
        accountKey: current.accountKey,
        wallet: current.wallet,
        emailVerified: auth.emailVerified,
        identityKind: auth.identityKind,
        claimStatus: service.options.store.claimStatus(current.id) ?? 'ELIGIBLE',
      };
    }),
  );
  app.get<{ Querystring: { owner: string } }>(
    '/api/launch-market/wallet',
    { schema: { querystring: body({ owner: ownerSchema }) } },
    async (request) =>
      execute(async () => {
        const auth = await authenticated(request);
        return service.wallet(request.query.owner, auth?.current.id ?? null);
      }),
  );
  app.post<{ Body: { owner: string } }>(
    '/api/launch-market/wallet/challenge',
    { schema: { body: body({ owner: ownerSchema }) } },
    async (request) =>
      execute(async () => {
        const current = await verifiedAccount(request);
        return service.options.store.bindingChallenge(current.id, request.body.owner, service.now());
      }),
  );
  app.post<{ Body: { nonce: string; signature: string } }>(
    '/api/launch-market/wallet/bind',
    {
      schema: {
        body: body({
          nonce: { type: 'string', pattern: '^[a-f0-9]{48}$', maxLength: 48 },
          signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$', maxLength: 132 },
        }),
      },
    },
    async (request) =>
      execute(async () => {
        const current = await verifiedAccount(request),
          bound = service.options.store.bindWallet(
            current.id,
            request.body.nonce,
            request.body.signature,
            service.now(),
          );
        return { id: bound.id, wallet: bound.wallet, emailVerified: true, identityKind: 'GOOGLE' };
      }),
  );
  app.post<{ Body: { owner: string } }>(
    '/api/launch-market/wallet/test-challenge',
    { schema: { body: body({ owner: ownerSchema }) } },
    async (request) =>
      execute(async () => {
        await requireTestMode(request);
        return service.options.store.walletTestChallenge(request.body.owner, service.now());
      }),
  );
  app.post<{ Body: { nonce: string; signature: string } }>(
    '/api/launch-market/wallet/test-session',
    {
      schema: {
        body: body({
          nonce: { type: 'string', pattern: '^[a-f0-9]{48}$', maxLength: 48 },
          signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$', maxLength: 132 },
        }),
      },
    },
    async (request, reply) =>
      execute(async () => {
        await requireTestMode(request);
        const session = service.options.store.openWalletTestSession(
          request.body.nonce,
          request.body.signature,
          service.now(),
        );
        reply.setCookie(testSessionCookie, session.token, {
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'strict',
          maxAge: Math.max(0, session.expiresAt - service.now()),
        });
        return {
          id: session.account.id,
          wallet: session.account.wallet,
          emailVerified: false,
          identityKind: 'WALLET_TEST',
        };
      }),
  );
  app.get('/api/launch-market/wallet/test-session', async (request) =>
    execute(async () => {
      if (await verificationRequired()) throw new LaunchMarketError('VERIFIED_EMAIL_REQUIRED', 401);
      const session = testSession(request);
      if (!session) throw new LaunchMarketError('MARKET_SESSION_REQUIRED', 401);
      return { csrfToken: session.csrfToken, identityKind: 'WALLET_TEST', emailVerificationRequired: false };
    }),
  );
  app.post<{ Body: { allDevices: boolean } }>(
    '/api/launch-market/wallet/logout',
    { schema: { body: body({ allDevices: { type: 'boolean' } }) } },
    async (request, reply) =>
      execute(() => {
        if (request.headers.origin !== service.options.store.origin)
          throw new LaunchMarketError('INVALID_REQUEST_ORIGIN', 403);
        const token = request.cookies?.[testSessionCookie],
          csrf = request.headers['x-csrf-token'];
        if (!token || typeof csrf !== 'string') throw new LaunchMarketError('MARKET_SESSION_REQUIRED', 401);
        service.options.store.revokeWalletTestSession(token, csrf, service.now(), request.body.allDevices);
        reply.clearCookie(testSessionCookie, { path: '/', secure: true, httpOnly: true, sameSite: 'strict' });
        return { signedOut: true };
      }),
  );
  app.post<{ Body: QuoteRequest }>(
    '/api/launch-market/quote',
    {
      schema: {
        body: body({
          owner: ownerSchema,
          strategyId: { enum: ['TSLA', 'AMZN'] },
          operation: {
            enum: ['MINT', 'BUY', 'SELL', 'CLAIM', 'CREATE_VAULT', 'DEPOSIT', 'WITHDRAW', 'CLOSE'],
          },
          asset: { enum: ['ETH', 'AF_USDC'] },
          amountRaw: rawSchema,
          slippageBps: { type: 'integer', minimum: 0, maximum: 500 },
        }),
      },
    },
    async (request) => execute(async () => service.quote(request.body, (await account(request)).id)),
  );
  app.post<{ Body: { quoteId: string; transactionHash: string; owner: string } }>(
    '/api/launch-market/submissions',
    {
      schema: {
        body: body({
          quoteId: idSchema,
          transactionHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$', maxLength: 66 },
          owner: ownerSchema,
        }),
      },
    },
    async (request) =>
      execute(async () =>
        service.submit(
          (await account(request)).id,
          request.body.quoteId,
          request.body.transactionHash,
          request.body.owner,
        ),
      ),
  );
  app.get<{ Params: { id: string } }>(
    '/api/launch-market/operations/:id',
    { schema: { params: body({ id: idSchema }) } },
    async (request) => execute(async () => service.operation((await account(request)).id, request.params.id)),
  );
  app.get<{ Querystring: { owner: string } }>(
    '/api/launch-market/operations',
    { schema: { querystring: body({ owner: ownerSchema }) } },
    async (request) =>
      execute(async () => ({
        operations: service.options.store.operations((await account(request)).id, request.query.owner),
      })),
  );
  app.get('/api/launch-market/events', async (request, reply) => {
    const snapshot = await execute(() => service.snapshot());
    const response = reply.raw;
    const send = (event: MarketStreamUpdate) => {
      if (response.destroyed || response.writableEnded) return;
      if (response.writableLength > 65_536) {
        response.end();
        return;
      }
      response.write(`id: ${event.location.version}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = service.broker.subscribe(send);
    reply.hijack();
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    clients.add(response);
    send({ type: 'SNAPSHOT', location: snapshot.location, snapshot });
    const heartbeat = setInterval(() => {
      if (response.writableLength > 65_536) response.end();
      else response.write(': heartbeat\n\n');
    }, 20_000);
    heartbeat.unref();
    response.once('close', () => {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      clients.delete(response);
    });
    request.raw.once('aborted', () => response.end());
  });
  // Fastify waits for open connections before onClose. End hijacked SSE sockets before that wait.
  app.addHook('preClose', async () => {
    for (const client of clients) client.end();
    clients.clear();
  });
}
