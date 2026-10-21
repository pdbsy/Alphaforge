import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommunityApiError, CommunityClient, createCommunityApi } from '../apps/web/src/community/client.ts';
import { strategyFields } from '../apps/web/src/community/install.ts';
import { composeDialog, renderAccount, renderPost, renderStrategy } from '../apps/web/src/community/shell.ts';
import type { CommunityAccount, CommunityPost, CommunityState } from '../apps/web/src/community/model.ts';

const wallet = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const account = (): CommunityAccount => ({
  wallet,
  profile: { displayName: 'Researcher', bio: '' },
  preferences: { defaultForumCategory: 'All', defaultForumSort: 'newest', savedStrategies: [] },
  draft: null,
  notes: [],
  likedPosts: [],
  bookmarkedPosts: [],
  revision: 0,
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const post = (): CommunityPost => ({
  id: 'note-1',
  authorWallet: wallet,
  authorName: 'Researcher',
  title: '<img src=x onerror=alert(1)>',
  body: '<script>unsafe()</script>',
  category: 'Research Notes',
  strategyId: null,
  createdAt: '2026-10-11T00:00:00Z',
  updatedAt: '2026-10-11T00:00:00Z',
  revision: 1,
  likeCount: 0,
  replyCount: 0,
  liked: false,
  bookmarked: false,
});

test('each write obtains a fresh session CSRF and never writes with an expired session', async () => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  let valid = true;
  const api = createCommunityApi((async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    if (path.endsWith('/wallet/test-session'))
      return valid
        ? response({ identityKind: 'WALLET_TEST', csrfToken: 'fresh-wallet-session-token' })
        : response({}, 401);
    if (path === '/auth/me') return response({}, 401);
    return response({ saved: true });
  }) as typeof fetch);
  await api('/api/community/account', 'PUT', { revision: 0, draft: null });
  const write = calls.find((call) => call.path === '/api/community/account')!;
  assert.equal(write.init?.method, 'PUT');
  assert.equal((write.init?.headers as Record<string, string>)['x-csrf-token'], 'fresh-wallet-session-token');
  assert.equal(write.init?.credentials, 'same-origin');
  valid = false;
  await assert.rejects(
    api('/api/community/account', 'PUT', { revision: 1, draft: null }),
    /ACCOUNT_SESSION_REQUIRED/,
  );
  assert.equal(calls.filter((call) => call.path === '/api/community/account').length, 1);
});

test('wallet changes discard old private reads and reject mutation completions from the old identity', async () => {
  let resolveRead!: (value: CommunityAccount) => void;
  const client = new CommunityClient(
    <T>() =>
      new Promise<T>((resolve) => {
        resolveRead = resolve as (value: CommunityAccount) => void;
      }),
  );
  const pending = client.account();
  client.invalidate();
  resolveRead(account());
  await pending;
  assert.equal(client.state.account, null);
  client.state.account = account();
  const write = client.mutate('/api/community/notes', 'POST', { title: 'Private', body: 'Private thought' });
  client.invalidate();
  resolveRead(account());
  await assert.rejects(write, /ACCOUNT_SESSION_REQUIRED/);
  assert.equal(client.state.account, null);
});

test('connected wallet mismatch and unauthenticated writes fail before a mutation', async () => {
  let writes = 0;
  const client = new CommunityClient(async <T>(_path: string, method = 'GET') => {
    if (method !== 'GET') ++writes;
    return account() as T;
  });
  client.bindWallet(other);
  await client.account();
  assert.equal(client.state.account, null);
  await assert.rejects(client.mutate('/api/community/notes', 'POST', {}), /ACCOUNT_SESSION_REQUIRED/);
  assert.equal(writes, 0);
});

test('expired session removes private account content, while revision conflicts preserve the loaded record', async () => {
  let status = 409;
  const client = new CommunityClient(async () => {
    throw new CommunityApiError('COMMUNITY_REVISION_CONFLICT', status);
  });
  client.state.account = account();
  await assert.rejects(client.mutate('/api/community/account', 'PUT', {}));
  assert.equal(client.state.account?.wallet, wallet);
  status = 401;
  await assert.rejects(client.mutate('/api/community/account', 'PUT', {}));
  assert.equal(client.state.account, null);
});

test('public prose and imported drafts escape HTML; anonymous controls cannot publish', () => {
  const state: CommunityState = { ...new CommunityClient().state, post: post(), loading: false };
  const html = renderPost(state);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;script&gt;unsafe()&lt;/script&gt;'));
  assert.ok(!html.includes('<script>unsafe()'));
  assert.match(html, /data-community="like"[^>]*disabled/);
  assert.match(renderAccount(state, 'notes'), /Continue with wallet/);
  assert.ok(
    composeDialog({
      title: '" autofocus onfocus="unsafe()',
      body: '<b>unsafe</b>',
      category: 'Research Notes',
      strategyId: null,
    }).includes('&lt;b&gt;unsafe&lt;/b&gt;'),
  );
});

test('creator policy rejects unsupported symbols, invalid EMA order and out-of-range allocation', () => {
  const form = new FormData();
  for (const [name, value] of Object.entries({
    name: 'A strategy',
    symbol: 'TSLA',
    summary: 'Research summary',
    method: 'Research method',
    risks: 'Concentration risk',
    kind: 'EMA_CROSS',
    allocation: '80',
    slippage: '1',
    fastPeriod: '12',
    slowPeriod: '26',
  }))
    form.set(name, value);
  assert.deepEqual(strategyFields(form).policy, {
    kind: 'EMA_CROSS',
    allocationBps: 8000,
    maxSlippageBps: 100,
    fastPeriod: 12,
    slowPeriod: 26,
  });
  form.set('fastPeriod', '30');
  assert.throws(() => strategyFields(form), /fast period shorter/);
  form.set('fastPeriod', '12');
  form.set('allocation', '101');
  assert.throws(() => strategyFields(form), /allocation/);
  form.set('allocation', '80');
  form.set('symbol', 'FAKE');
  assert.throws(() => strategyFields(form), /supported stock/);
});

test('published research includes immutable evidence and availability rather than invented financial controls', () => {
  const state = new CommunityClient().state;
  state.strategy = {
    id: 'strategy-1',
    authorWallet: wallet,
    name: 'Steady accumulation',
    symbol: 'AMZN',
    summary: 'A bounded accumulation policy.',
    method: 'Buy at a fixed interval.',
    risks: 'The stock can lose its value.',
    policy: { kind: 'DCA', allocationBps: 2500, maxSlippageBps: 100, intervalDays: 7 },
    version: 2,
    publishedVersion: 2,
    publicationRevision: 1,
    publishedAt: '2026-10-11T00:00:00Z',
    createdAt: '2026-10-11T00:00:00Z',
    updatedAt: '2026-10-11T00:00:00Z',
    status: 'PUBLISHED',
    digest: 'sha256:verified-content',
    executionStatus: 'DOCUMENT_ONLY',
  };
  const html = renderStrategy(state);
  assert.match(html, /PUBLISHED VERSION 2/);
  assert.match(html, /sha256:verified-content/);
  assert.match(html, /wallet execution requires an approved deployment/);
  assert.doesNotMatch(html, /data-launch-order|Mint PASS|Deposit/);
});
