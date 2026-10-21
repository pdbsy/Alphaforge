import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CreatorStrategyStore } from '../../../../packages/launch-market/src/creator.ts';
import { LaunchMarketError, type MarketAccount } from '../../../../packages/launch-market/src/types.ts';

export interface CreatorRoutesOptions {
  readonly store: CreatorStrategyStore;
  readonly origin: string;
  readonly resolveAccount: (request: FastifyRequest) => Promise<MarketAccount | null>;
  readonly consumeRate: (key: string, limit: number, windowSeconds: number, now: number) => void;
  readonly canWrite: () => boolean;
  readonly now: () => number;
}
const id = { type: 'string', pattern: '^[a-f0-9-]{36}$', maxLength: 36 };
const expectedVersion = { type: 'integer', minimum: 1, maximum: 1000 };
const expectedPublicationRevision = { type: 'integer', minimum: 0, maximum: 1000000 };
const revisionBody = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'expectedPublicationRevision'],
  properties: { expectedVersion, expectedPublicationRevision },
};
export function registerCreatorRoutes(app: FastifyInstance, options: CreatorRoutesOptions): void {
  const actor = async (request: FastifyRequest, mutation: boolean) => {
    if (
      mutation &&
      (request.headers.origin !== options.origin || request.headers['sec-fetch-site'] === 'cross-site')
    )
      throw new LaunchMarketError('INVALID_REQUEST_ORIGIN', 403);
    const account = await options.resolveAccount(request);
    if (!account?.wallet) throw new LaunchMarketError('LINKED_WALLET_REQUIRED', 401);
    if (mutation) {
      if (!options.canWrite()) throw new LaunchMarketError('CREATOR_STORAGE_FULL', 503);
      options.consumeRate('creator:' + account.wallet, 60, 3600, options.now());
      options.consumeRate('creator-global', 3000, 3600, options.now());
    }
    return account.wallet;
  };
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/api/strategies',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cursor: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,160}$' },
            limit: { type: 'string', pattern: '^([1-9]|[1-4][0-9]|50)$' },
          },
        },
      },
    },
    async (request) => {
      options.consumeRate('creator-read:' + request.ip, 300, 60, options.now());
      return options.store.publicList(request.query.cursor, Number(request.query.limit ?? '20'));
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/strategies/:id',
    {
      schema: {
        params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id } },
      },
    },
    async (request) => {
      options.consumeRate('creator-read:' + request.ip, 300, 60, options.now());
      return { strategy: options.store.publicDetail(request.params.id) };
    },
  );
  app.get('/api/creator/strategies', async (request) => ({
    strategies: options.store.owned(await actor(request, false)),
  }));
  app.post('/api/creator/strategies', { bodyLimit: 65536 }, async (request, reply) => {
    const strategy = options.store.create(await actor(request, true), request.body, options.now());
    return reply.code(201).send({ strategy });
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> & { expectedVersion: number } }>(
    '/api/creator/strategies/:id',
    {
      bodyLimit: 65536,
      schema: {
        params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id } },
        body: { type: 'object', required: ['expectedVersion'], properties: { expectedVersion } },
      },
    },
    async (request) => {
      const { expectedVersion: expected, ...input } = request.body;
      return {
        strategy: options.store.update(
          await actor(request, true),
          request.params.id,
          expected,
          input,
          options.now(),
        ),
      };
    },
  );
  for (const action of ['publish', 'unpublish'] as const)
    app.post<{
      Params: { id: string };
      Body: { expectedVersion: number; expectedPublicationRevision: number };
    }>(
      '/api/creator/strategies/:id/' + action,
      {
        schema: {
          params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id } },
          body: revisionBody,
        },
      },
      async (request) => ({
        strategy:
          action === 'publish'
            ? options.store.publish(
                await actor(request, true),
                request.params.id,
                request.body.expectedVersion,
                options.now(),
                request.body.expectedPublicationRevision,
              )
            : options.store.unpublish(
                await actor(request, true),
                request.params.id,
                request.body.expectedVersion,
                request.body.expectedPublicationRevision,
              ),
      }),
    );
}
