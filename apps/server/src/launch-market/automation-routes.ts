import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getAddress } from 'ethers';
import {
  LaunchMarketError,
  type MarketAccount,
  type StrategyId,
} from '../../../../packages/launch-market/src/types.ts';
import type { StockConsentRegistry } from '../launch-market-adapters/stock-consent-registry.ts';
import {
  verifyStockConsent,
  type SignedStockConsent,
} from '../launch-market-adapters/stock-worker-policy.ts';
import type { StockAutomationReadiness } from '../launch-market-adapters/stock-worker-readiness.ts';

export interface StockOperatorStatus {
  readonly available: boolean;
  readonly reason: 'READY' | 'NOT_CONFIGURED' | 'WORKER_INACTIVE' | 'STATUS_STALE';
  readonly executor: string | null;
  readonly manifestDigest: string | null;
}
export type StockReadiness =
  StockAutomationReadiness | { readonly strategyId: StrategyId; readonly status: 'UNAVAILABLE' };
export interface StockAutomationOptions {
  readonly registry: StockConsentRegistry;
  readonly operator: () => StockOperatorStatus;
  readonly readiness: (strategyId: StrategyId, now: number) => Promise<StockReadiness>;
  readonly validateConsent: (signed: SignedStockConsent, now: number) => Promise<void>;
}
export interface AutomationRoutesOptions extends StockAutomationOptions {
  readonly origin: string;
  readonly resolveAccount: (request: FastifyRequest) => Promise<MarketAccount | null>;
  readonly consumeRate: (key: string, limit: number, windowSeconds: number, now: number) => void;
  readonly canWrite: () => boolean;
  readonly now: () => number;
}
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

export function registerAutomationRoutes(app: FastifyInstance, options: AutomationRoutesOptions): void {
  const actor = async (request: FastifyRequest, mutation: boolean, needsCapacity = true) => {
    if (
      mutation &&
      (request.headers.origin !== options.origin || request.headers['sec-fetch-site'] === 'cross-site')
    )
      throw new LaunchMarketError('INVALID_REQUEST_ORIGIN', 403);
    const account = await options.resolveAccount(request);
    if (!account?.wallet) throw new LaunchMarketError('LINKED_WALLET_REQUIRED', 401);
    if (mutation && !needsCapacity) {
      // Stopping a session does not add history or consume the start quota.
      options.consumeRate('automation-pause:' + account.wallet, 60, 60, options.now());
      return account.wallet;
    }
    options.consumeRate('automation-owner:' + account.wallet, 120, 60, options.now());
    if (mutation) {
      if (needsCapacity && !options.canWrite()) throw new LaunchMarketError('STOCK_STORAGE_FULL', 503);
      options.consumeRate('automation-write:' + account.wallet, 60, 3600, options.now());
    }
    return account.wallet;
  };
  app.get('/api/launch-market/automation/status', async (request) => {
    const observedAt = options.now();
    options.consumeRate('automation-read:' + request.ip, 60, 60, observedAt);
    const operator = options.operator();
    const readiness = await Promise.all(
      (['TSLA', 'AMZN'] as const).map(async (strategyId): Promise<StockReadiness> => {
        try {
          return await options.readiness(strategyId, observedAt);
        } catch {
          return { strategyId, status: 'UNAVAILABLE' };
        }
      }),
    );
    const available = operator.available && readiness.some((item) => item.status === 'READY');
    return {
      schemaVersion: 1,
      available,
      reason: operator.available && !available ? 'MARKET_UNAVAILABLE' : operator.reason,
      executor: operator.executor,
      manifestDigest: operator.manifestDigest,
      observedAt,
      readiness,
    };
  });
  app.get('/api/launch-market/automation/sessions', async (request) =>
    options.registry.owned(await actor(request, false)),
  );
  app.post<{ Body: { signed: SignedStockConsent; expectedRevision: number } }>(
    '/api/launch-market/automation/start',
    {
      bodyLimit: 16_384,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['signed', 'expectedRevision'],
          properties: {
            expectedRevision: revision,
            signed: {
              type: 'object',
              additionalProperties: false,
              required: ['consent', 'signature'],
              properties: {
                consent: { type: 'object' },
                signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$' },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const wallet = await actor(request, true),
        { signed, expectedRevision } = request.body;
      try {
        verifyStockConsent(signed);
      } catch {
        throw new LaunchMarketError('STOCK_CONSENT_INVALID', 400);
      }
      if (getAddress(signed.consent.owner) !== getAddress(wallet))
        throw new LaunchMarketError('LINKED_WALLET_REQUIRED', 403);
      const operator = options.operator(),
        now = options.now();
      if (!operator.available || !operator.executor || !operator.manifestDigest)
        throw new LaunchMarketError('STOCK_AUTOMATION_UNAVAILABLE', 503);
      if (
        getAddress(signed.consent.grant.executor) !== getAddress(operator.executor) ||
        signed.consent.manifestDigest !== operator.manifestDigest
      )
        throw new LaunchMarketError('STOCK_CONSENT_STATE_CHANGED', 409);
      let ready: StockReadiness;
      try {
        ready = await options.readiness(signed.consent.strategyId, now);
      } catch {
        throw new LaunchMarketError('STOCK_AUTOMATION_UNAVAILABLE', 503);
      }
      if (ready.status !== 'READY') throw new LaunchMarketError('STOCK_AUTOMATION_UNAVAILABLE', 503);
      await options.validateConsent(signed, now);
      // Chain qualification is asynchronous. Recheck the operator and expiry before committing the registry.
      const fresh = options.operator();
      if (
        !fresh.available ||
        fresh.executor !== operator.executor ||
        fresh.manifestDigest !== operator.manifestDigest
      )
        throw new LaunchMarketError('STOCK_AUTOMATION_UNAVAILABLE', 503);
      return options.registry.start(wallet, signed, expectedRevision, options.now());
    },
  );
  app.post<{ Body: { digest: string; expectedRevision: number } }>(
    '/api/launch-market/automation/pause',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['digest', 'expectedRevision'],
          properties: { digest: { type: 'string', pattern: '^0x[0-9a-f]{64}$' }, expectedRevision: revision },
        },
      },
    },
    async (request) =>
      options.registry.pause(
        await actor(request, true, false),
        request.body.digest,
        request.body.expectedRevision,
        options.now(),
      ),
  );
}
