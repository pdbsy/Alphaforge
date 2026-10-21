import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LaunchMarketError, type MarketAccount } from '../../../../packages/launch-market/src/types.ts';
import {
  CommunityStore,
  communityCategories,
  communityWallet,
  type CommunityAccountPatch,
  type CommunityCategory,
  type CommunityNoteInput,
  type CommunityPostInput,
} from '../../../../packages/launch-market/src/community.ts';

export interface CommunityRoutesOptions {
  readonly store: CommunityStore;
  /** Reuse launch-market identity selection, including mutation CSRF; never trust a caller wallet/header. */
  readonly resolveAccount: (request: FastifyRequest) => Promise<MarketAccount | null> | MarketAccount | null;
  readonly origin: string;
  readonly now?: () => number;
  readonly canWrite?: () => boolean;
}
const string = (maxLength: number, minLength = 0) => ({ type: 'string', minLength, maxLength });
const identifier = { ...string(128, 1), pattern: '^[A-Za-z0-9_-]+$' };
const strategy = { anyOf: [{ ...string(64, 1), pattern: '^[A-Za-z0-9_-]+$' }, { type: 'null' }] };
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const category = { enum: communityCategories };
const object = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const postProperties = { title: string(120, 2), body: string(6000, 2), category, strategyId: strategy };
const noteProperties = { title: string(120, 1), body: string(6000, 1), strategyId: strategy };
const profile = object({ displayName: string(60, 1), bio: string(300) });
const preferences = object({
  defaultForumCategory: { enum: ['All', ...communityCategories] },
  defaultForumSort: { enum: ['newest', 'replies'] },
  savedStrategies: {
    type: 'array',
    maxItems: 100,
    uniqueItems: true,
    items: { ...string(64, 1), pattern: '^[A-Za-z0-9_-]+$' },
  },
});
const draft = {
  anyOf: [
    object({ ...postProperties, title: string(120), body: string(6000) }, ['title', 'body', 'category']),
    { type: 'null' },
  ],
};
const accountProperties = { revision, profile, preferences, draft };
const paging = {
  cursor: { ...string(256, 1), pattern: '^[A-Za-z0-9_-]+$' },
  limit: { type: 'string', pattern: '^([1-9]|[1-4][0-9]|50)$' },
};
type PageQuery = { cursor?: string; limit?: string };

/** Can be composed into the on-chain server without registering legacy local ledger routes. */
export function registerCommunityRoutes(app: FastifyInstance, options: CommunityRoutesOptions): void {
  const { store } = options,
    origin = new URL(options.origin);
  if (origin.origin !== options.origin || options.origin !== store.origin)
    throw new LaunchMarketError('INVALID_COMMUNITY_ORIGIN', 400);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/community/'))
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
  });
  const account = async (request: FastifyRequest, required = false): Promise<string | null> => {
    const actor = await options.resolveAccount(request);
    if (!actor?.wallet) {
      if (required) throw new LaunchMarketError('MARKET_SESSION_REQUIRED', 401);
      return null;
    }
    return communityWallet(actor.wallet);
  };
  const read = async (request: FastifyRequest) => {
    store.consumeRate('community-read:' + request.ip, 300, 60, now());
    return account(request);
  };
  const write = async (request: FastifyRequest, kind = 'write'): Promise<string> => {
    // Keep these checks even when embedded into another app with different global hooks.
    if (request.headers.origin !== origin.origin || request.headers['sec-fetch-site'] === 'cross-site')
      throw new LaunchMarketError('INVALID_REQUEST_ORIGIN', 403);
    const csrf = request.headers['x-csrf-token'];
    if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(csrf))
      throw new LaunchMarketError('MARKET_SESSION_REQUIRED', 401);
    const wallet = (await account(request, true))!;
    if (options.canWrite && !options.canWrite()) throw new LaunchMarketError('COMMUNITY_STORAGE_FULL', 503);
    store.consumeRate('community-ip-write:' + request.ip, 180, 60, now());
    store.consumeRate('community-wallet-write:' + wallet, 60, 60, now());
    if (kind === 'post') store.consumeRate('community-publish:' + wallet, 30, 3600, now());
    if (kind === 'import') store.consumeRate('community-import:' + wallet, 5, 3600, now());
    return wallet;
  };
  const parameters = { params: object({ id: identifier }) };
  const page = <T extends PageQuery>(query: T): Omit<T, 'limit'> & { limit?: number } => {
    const { limit, ...rest } = query;
    return { ...rest, ...(limit === undefined ? {} : { limit: Number(limit) }) };
  };
  app.get<{
    Querystring: PageQuery & {
      query?: string;
      category?: CommunityCategory;
      strategyId?: string;
      sort?: 'newest' | 'replies';
    };
  }>(
    '/api/community/posts',
    {
      schema: {
        querystring: object(
          {
            ...paging,
            query: string(120),
            sort: { enum: ['newest', 'replies'] },
            category,
            strategyId: { ...string(64, 1), pattern: '^[A-Za-z0-9_-]+$' },
          },
          [],
        ),
      },
    },
    async (request) => store.listPosts(page(request.query), await read(request)),
  );
  app.get<{ Params: { id: string }; Querystring: PageQuery }>(
    '/api/community/posts/:id',
    { schema: { ...parameters, querystring: object(paging, []) } },
    async (request) => ({
      post: store.getPost(request.params.id, await read(request)),
      ...store.listReplies(request.params.id, page(request.query)),
    }),
  );
  app.post<{ Body: CommunityPostInput }>(
    '/api/community/posts',
    { bodyLimit: 32768, schema: { body: object(postProperties, ['title', 'body', 'category']) } },
    async (request, reply) => {
      const post = store.createPost(await write(request, 'post'), request.body, now());
      return reply.code(201).send({ post });
    },
  );
  app.put<{ Params: { id: string }; Body: CommunityPostInput & { revision: number } }>(
    '/api/community/posts/:id',
    {
      bodyLimit: 32768,
      schema: {
        ...parameters,
        body: object({ ...postProperties, revision }, ['title', 'body', 'category', 'revision']),
      },
    },
    async (request) => ({
      post: store.updatePost(
        await write(request),
        request.params.id,
        request.body,
        request.body.revision,
        now(),
      ),
    }),
  );
  app.delete<{ Params: { id: string }; Body: { revision: number } }>(
    '/api/community/posts/:id',
    { schema: { ...parameters, body: object({ revision }) } },
    async (request) => {
      store.deletePost(await write(request), request.params.id, request.body.revision);
      return { deleted: true };
    },
  );
  app.get<{ Params: { id: string }; Querystring: PageQuery }>(
    '/api/community/posts/:id/replies',
    { schema: { ...parameters, querystring: object(paging, []) } },
    async (request) => {
      await read(request);
      return store.listReplies(request.params.id, page(request.query));
    },
  );
  app.post<{ Params: { id: string }; Body: { body: string } }>(
    '/api/community/posts/:id/replies',
    { schema: { ...parameters, body: object({ body: string(2000, 2) }) } },
    async (request, reply) =>
      reply.code(201).send({
        reply: store.createReply(await write(request), request.params.id, request.body.body, now()),
      }),
  );
  app.put<{ Params: { id: string }; Body: { body: string; revision: number } }>(
    '/api/community/replies/:id',
    { schema: { ...parameters, body: object({ body: string(2000, 2), revision }) } },
    async (request) => ({
      reply: store.updateReply(
        await write(request),
        request.params.id,
        request.body.body,
        request.body.revision,
        now(),
      ),
    }),
  );
  app.delete<{ Params: { id: string }; Body: { revision: number } }>(
    '/api/community/replies/:id',
    { schema: { ...parameters, body: object({ revision }) } },
    async (request) => {
      store.deleteReply(await write(request), request.params.id, request.body.revision);
      return { deleted: true };
    },
  );
  for (const kind of ['like', 'bookmark'] as const)
    app.put<{ Params: { id: string }; Body: { active: boolean } }>(
      '/api/community/posts/:id/' + kind,
      { schema: { ...parameters, body: object({ active: { type: 'boolean' } }) } },
      async (request) => ({
        post: store.react(await write(request), request.params.id, kind, request.body.active),
      }),
    );
  app.get('/api/community/account', async (request) => {
    store.consumeRate('community-read:' + request.ip, 300, 60, now());
    return store.account((await account(request, true))!);
  });
  app.put<{ Body: CommunityAccountPatch }>(
    '/api/community/account',
    { bodyLimit: 32768, schema: { body: object(accountProperties, ['revision']) } },
    async (request) => store.updateAccount(await write(request), request.body),
  );
  app.post<{ Body: CommunityNoteInput }>(
    '/api/community/notes',
    { bodyLimit: 32768, schema: { body: object({ ...noteProperties, id: identifier }, ['title', 'body']) } },
    async (request, reply) =>
      reply.code(201).send({ note: store.createNote(await write(request), request.body, now()) }),
  );
  app.put<{ Params: { id: string }; Body: CommunityNoteInput & { revision: number } }>(
    '/api/community/notes/:id',
    {
      bodyLimit: 32768,
      schema: { ...parameters, body: object({ ...noteProperties, revision }, ['title', 'body', 'revision']) },
    },
    async (request) => ({
      note: store.updateNote(
        await write(request),
        request.params.id,
        request.body,
        request.body.revision,
        now(),
      ),
    }),
  );
  app.delete<{ Params: { id: string }; Body: { revision: number } }>(
    '/api/community/notes/:id',
    { schema: { ...parameters, body: object({ revision }) } },
    async (request) => {
      store.deleteNote(await write(request), request.params.id, request.body.revision);
      return { deleted: true };
    },
  );
  app.post<{ Body: CommunityAccountPatch & { notes: readonly CommunityNoteInput[] } }>(
    '/api/community/account/import',
    {
      bodyLimit: 524288,
      schema: {
        body: object(
          {
            ...accountProperties,
            notes: {
              type: 'array',
              maxItems: 50,
              items: object({ ...noteProperties, id: identifier }, ['id', 'title', 'body']),
            },
          },
          ['revision', 'notes'],
        ),
      },
    },
    async (request) => store.importAccount(await write(request, 'import'), request.body, now()),
  );
}
