import { createHash, randomBytes } from 'node:crypto';
import { getAddress, ZeroAddress } from 'ethers';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { LaunchMarketError, type MarketAccount } from '../../../../packages/launch-market/src/types.ts';
import type {
  StockDataCredentialStore,
  StockDataCredentialInput,
} from '../launch-market-adapters/stock-data-credential-store.ts';

export interface OperatorStockDataOptions {
  readonly store: StockDataCredentialStore;
  /** Server-trusted role configuration, never a request/body wallet address. */
  readonly operatorWallet: string;
  /** Trusted runtime capability; credential storage alone never enables a data source. */
  readonly readOnlyEnabled?: () => boolean;
}
export interface OperatorStockDataRoutesOptions extends OperatorStockDataOptions {
  readonly origin: string;
  readonly resolveAccount: (request: FastifyRequest) => Promise<MarketAccount | null>;
  readonly consumeRate: (key: string, limit: number, seconds: number, now: number) => void;
  readonly canWrite: () => boolean;
  readonly now: () => number;
}
export const STOCK_DATA_SAVE_NONCE_HEADER = 'x-stock-data-save-nonce';
const route = '/api/launch-market/operator/stock-data';
interface SaveNonce {
  readonly value: string;
  readonly expiresAt: number;
  readonly fingerprint: string;
}
const emptyQuery = { type: 'object', additionalProperties: false, properties: {} };
const field = { type: 'string', pattern: '^[\\x21-\\x7e]{1,1024}$', maxLength: 1024 };

export function registerOperatorStockDataRoutes(
  app: FastifyInstance,
  options: OperatorStockDataRoutesOptions,
): void {
  const operator = getAddress(options.operatorWallet);
  if (operator === ZeroAddress) throw new LaunchMarketError('OPERATOR_CONFIGURATION_INVALID', 503);
  const nonces = new Map<string, SaveNonce>();
  const actor = async (request: FastifyRequest): Promise<string> => {
    if (
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.method === 'POST' && request.headers.origin !== options.origin)
    )
      throw new LaunchMarketError('INVALID_REQUEST_ORIGIN', 403);
    const account = await options.resolveAccount(request);
    if (!account?.wallet) throw new LaunchMarketError('LINKED_WALLET_REQUIRED', 401);
    if (getAddress(account.wallet) !== operator) throw new LaunchMarketError('OPERATOR_WALLET_REQUIRED', 403);
    options.consumeRate('stock-data-read:' + account.wallet, 30, 60, options.now());
    // The same wallet on different browsers gets independent nonces. A session/account switch invalidates a nonce.
    return createHash('sha256')
      .update(
        JSON.stringify([
          account.id,
          account.wallet.toLowerCase(),
          request.cookies?.['__Host-af_market_test'] ?? null,
          request.cookies?.['__Host-ikol_session'] ?? null,
        ]),
      )
      .digest('hex');
  };
  const prune = (now: number) => {
    for (const [key, nonce] of nonces) if (nonce.expiresAt <= now) nonces.delete(key);
  };
  const errors = (error: unknown, _request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof LaunchMarketError) {
      const rate = error.statusCode === 429;
      return reply
        .code(error.statusCode)
        .send({ error: { code: rate ? 'STOCK_DATA_RATE_LIMITED' : error.code } });
    }
    const details = error as { statusCode?: unknown; validation?: unknown };
    const tooLarge = details?.statusCode === 413,
      invalid = details?.validation !== undefined || details?.statusCode === 400;
    return reply.code(tooLarge ? 413 : invalid ? 400 : 503).send({
      error: {
        code: tooLarge
          ? 'STOCK_DATA_REQUEST_TOO_LARGE'
          : invalid
            ? 'INVALID_STOCK_DATA_CREDENTIALS'
            : 'STOCK_DATA_STORAGE_UNAVAILABLE',
      },
    });
  };
  app.get(route, { schema: { querystring: emptyQuery }, errorHandler: errors }, async (request, reply) => {
    const context = await actor(request),
      now = options.now();
    prune(now);
    const snapshot = options.store.snapshot();
    if (!nonces.has(context) && nonces.size >= 128)
      throw new LaunchMarketError('STOCK_DATA_RATE_LIMITED', 429);
    const value = randomBytes(32).toString('base64url');
    nonces.set(context, { value, expiresAt: now + 300, fingerprint: snapshot.fingerprint });
    reply.header('Cache-Control', 'no-store').header(STOCK_DATA_SAVE_NONCE_HEADER, value);
    return { ...snapshot.status, readOnlyEnabled: options.readOnlyEnabled?.() === true };
  });
  app.post<{ Body: StockDataCredentialInput }>(
    route,
    {
      bodyLimit: 4096,
      schema: {
        querystring: emptyQuery,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['apiKey', 'apiSecret'],
          properties: { apiKey: field, apiSecret: field },
        },
      },
      errorHandler: errors,
    },
    async (request, reply) => {
      const context = await actor(request),
        now = options.now();
      options.consumeRate('stock-data-save:' + context, 6, 3600, now);
      prune(now);
      const supplied = request.headers[STOCK_DATA_SAVE_NONCE_HEADER],
        nonce = nonces.get(context);
      if (
        typeof supplied !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
        !nonce ||
        supplied !== nonce.value
      )
        throw new LaunchMarketError('STOCK_DATA_NONCE_INVALID', 409);
      // Synchronous removal precedes the filesystem write: duplicate/replayed POSTs cannot reuse this authorization.
      nonces.delete(context);
      if (!options.canWrite()) throw new LaunchMarketError('STOCK_DATA_STORAGE_UNAVAILABLE', 503);
      const result = options.store.save(request.body, nonce.fingerprint);
      reply.header('Cache-Control', 'no-store');
      return { ...result, readOnlyEnabled: options.readOnlyEnabled?.() === true };
    },
  );
  app.addHook('onClose', () => {
    nonces.clear();
  });
}
