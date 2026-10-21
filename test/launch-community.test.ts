import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Wallet } from 'ethers';
import { CommunityStore, type CommunityPostInput } from '../packages/launch-market/src/community.ts';
import { LaunchMarketStore } from '../packages/launch-market/src/store.ts';
import { LaunchMarketError } from '../packages/launch-market/src/types.ts';
import { registerCommunityRoutes } from '../apps/server/src/launch-market/community-routes.ts';

const origin = 'https://community.example.test';
const first = '0x' + '1'.repeat(40),
  second = '0x' + '2'.repeat(40);
const postInput: CommunityPostInput = {
  title: 'An open research question',
  body: 'A durable public research note.',
  category: 'Research Notes',
  strategyId: 'TSLA',
};
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'af-community-')),
    path = join(folder, 'community.sqlite'),
    store = new CommunityStore(path, origin);
  return {
    folder,
    path,
    store,
    close() {
      store.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

test('private wallet notebook/preferences persist across devices and reject stale revisions', () => {
  const f = fixture();
  let other: CommunityStore | null = null;
  try {
    other = new CommunityStore(f.path, origin);
    assert.equal(f.store.account(first).revision, 0);
    const initial = f.store.updateAccount(first, {
      revision: 0,
      profile: { displayName: 'A researcher', bio: 'Process first' },
      preferences: {
        defaultForumCategory: 'Research Notes',
        defaultForumSort: 'replies',
        savedStrategies: ['TSLA'],
      },
      draft: { title: '', body: 'Unfinished thought', category: 'Research Notes' },
    });
    assert.equal(initial.revision, 1);
    assert.equal(other.account(first.toUpperCase().replace('0X', '0x')).profile.displayName, 'A researcher');
    assert.equal(other.account(first).draft?.body, 'Unfinished thought');
    assert.throws(
      () => other!.updateAccount(first, { revision: 0, profile: { displayName: 'Older device', bio: '' } }),
      /COMMUNITY_REVISION_CONFLICT/,
    );
    const note = f.store.createNote(
      first,
      { id: 'browser-note-1', title: 'Private observation', body: 'This must never become a public post.' },
      1000,
    );
    assert.equal(other.account(first).notes[0]?.id, note.id);
    assert.equal(other.account(second).notes.length, 0);
    assert.throws(
      () => other!.updateNote(second, note.id, { title: 'Theft', body: 'Changed' }, 1, 1001),
      /COMMUNITY_NOTE_NOT_FOUND/,
    );
    other.updateNote(first, note.id, { title: note.title, body: 'Updated on another device.' }, 1, 1002);
    assert.throws(
      () => f.store.updateNote(first, note.id, { title: 'Stale', body: 'Older edit' }, 1, 1003),
      /COMMUNITY_REVISION_CONFLICT/,
    );
    assert.equal(f.store.listPosts().posts.length, 0);
    assert.equal(statSync(f.path).mode & 0o077, 0);
    other.close();
    other = null;
    f.store.close();
    const reopened = new CommunityStore(f.path, origin);
    try {
      assert.equal(reopened.account(first).notes[0]?.body, 'Updated on another device.');
      assert.deepEqual(reopened.account(first).preferences.savedStrategies, ['TSLA']);
    } finally {
      reopened.close();
    }
  } finally {
    other?.close();
    f.close();
  }
});

test('shared posts/replies enforce author revision, reactions are idempotent and deletion cascades', () => {
  const f = fixture();
  try {
    const post = f.store.createPost(first, postInput, 1000);
    const reply = f.store.createReply(second, post.id, 'An independent reply.', 1001);
    assert.equal(f.store.listPosts().posts[0]?.replyCount, 1);
    assert.throws(() => f.store.updatePost(second, post.id, postInput, 1, 1002), /COMMUNITY_AUTHOR_REQUIRED/);
    assert.throws(() => f.store.deletePost(second, post.id, 1), /COMMUNITY_AUTHOR_REQUIRED/);
    assert.throws(
      () => f.store.updateReply(first, reply.id, 'Cannot edit this reply.', 1, 1002),
      /COMMUNITY_AUTHOR_REQUIRED/,
    );
    const updated = f.store.updatePost(
      first,
      post.id,
      { ...postInput, title: 'Revised research question' },
      1,
      1002,
    );
    assert.equal(updated.revision, 2);
    assert.throws(
      () => f.store.updatePost(first, post.id, postInput, 1, 1003),
      /COMMUNITY_REVISION_CONFLICT/,
    );
    for (let i = 0; i < 2; i++) {
      f.store.react(second, post.id, 'like', true);
      f.store.react(second, post.id, 'bookmark', true);
    }
    assert.equal(f.store.getPost(post.id).likeCount, 1);
    assert.equal(f.store.getPost(post.id).liked, false);
    assert.equal(f.store.account(second).likedPosts[0]?.liked, true);
    assert.equal(f.store.account(second).bookmarkedPosts[0]?.bookmarked, true);
    f.store.react(second, post.id, 'like', false);
    assert.equal(f.store.getPost(post.id).likeCount, 0);
    f.store.updateReply(second, reply.id, 'A clearer reply.', 1, 1004);
    assert.throws(() => f.store.deleteReply(second, reply.id, 1), /COMMUNITY_REVISION_CONFLICT/);
    f.store.deletePost(first, post.id, 2);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM community_replies').get()!.n, 0);
    assert.equal(f.store.account(second).bookmarkedPosts.length, 0);
  } finally {
    f.close();
  }
});

test('public cursor pagination is bounded and search treats SQL/metacharacters as literal text', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 5; i++)
      f.store.createPost(
        first,
        { ...postInput, title: 'Research ' + i, body: 'Exact 10%_ observation ' + i },
        1000 + i,
      );
    const initial = f.store.listPosts({ limit: 2 }),
      next = f.store.listPosts({ limit: 2, cursor: initial.nextCursor! }),
      last = f.store.listPosts({ limit: 2, cursor: next.nextCursor! });
    assert.equal(new Set([...initial.posts, ...next.posts, ...last.posts].map((x) => x.id)).size, 5);
    assert.equal(last.nextCursor, null);
    assert.equal(f.store.listPosts({ query: '10%_' }).posts.length, 5);
    assert.equal(f.store.listPosts({ query: "' OR 1=1--" }).posts.length, 0);
    assert.equal(f.store.listPosts({ strategyId: 'AMZN' }).posts.length, 0);
    assert.throws(() => f.store.listPosts({ cursor: 'garbage' }), /INVALID_COMMUNITY_INPUT/);
    assert.throws(() => f.store.listPosts({ limit: 500 }), /INVALID_COMMUNITY_INPUT/);
    assert.throws(
      () => f.store.createPost(first, { ...postInput, body: 'x'.repeat(6001) }, 1000),
      /INVALID_COMMUNITY_INPUT/,
    );
    assert.throws(
      () => f.store.createPost(first, { ...postInput, body: 'null\0byte' }, 1000),
      /INVALID_COMMUNITY_INPUT/,
    );
  } finally {
    f.close();
  }
});

test('reply-ranked feed paginates the entire community and publishing clears only matching drafts atomically', () => {
  const f = fixture();
  try {
    f.store.updateAccount(first, { revision: 0, draft: postInput });
    const oldest = f.store.createPost(first, postInput, 1000);
    assert.equal(f.store.account(first).draft, null);
    assert.equal(f.store.account(first).revision, 2);
    f.store.updateAccount(first, { revision: 2, draft: { ...postInput, title: 'Different saved draft' } });
    f.store.createPost(first, postInput, 1001);
    assert.equal(f.store.account(first).draft?.title, 'Different saved draft');
    f.store.createPost(second, postInput, 1002);
    for (let i = 0; i < 3; i++) f.store.createReply(second, oldest.id, 'Useful reply ' + i, 1003 + i);
    const top = f.store.listPosts({ sort: 'replies', limit: 1 });
    assert.equal(top.posts[0]?.id, oldest.id);
    const remaining = f.store.listPosts({ sort: 'replies', limit: 2, cursor: top.nextCursor! });
    assert.equal(remaining.posts.length, 2);
    assert.ok(!remaining.posts.some((post) => post.id === oldest.id));
    assert.equal(remaining.nextCursor, null);
    assert.throws(
      () => f.store.listPosts({ sort: 'newest', cursor: top.nextCursor! }),
      /INVALID_COMMUNITY_INPUT/,
    );
  } finally {
    f.close();
  }
});

test('explicit local import is atomic and conflicting IDs cannot overwrite another device', () => {
  const f = fixture();
  try {
    f.store.createNote(first, { id: 'already-saved', title: 'Original', body: 'Keep this content' }, 1000);
    assert.throws(
      () =>
        f.store.importAccount(
          first,
          {
            revision: 0,
            profile: { displayName: 'Should roll back', bio: '' },
            notes: [
              { id: 'new-note', title: 'New', body: 'Should also roll back' },
              { id: 'already-saved', title: 'Overwrite', body: 'Must not overwrite' },
            ],
          },
          1001,
        ),
      /COMMUNITY_REVISION_CONFLICT/,
    );
    assert.equal(f.store.account(first).revision, 0);
    assert.equal(f.store.account(first).notes.length, 1);
    assert.notEqual(f.store.account(first).profile.displayName, 'Should roll back');
    const imported = f.store.importAccount(
      first,
      { revision: 0, notes: [{ id: 'new-note', title: 'New local note', body: 'Imported with permission' }] },
      1002,
    );
    assert.equal(imported.revision, 1);
    assert.equal(imported.notes.length, 2);
    assert.equal(f.store.listPosts().posts.length, 0);
    assert.throws(
      () => f.store.importAccount(first, { revision: 0, notes: [] }, 1003),
      /COMMUNITY_REVISION_CONFLICT/,
    );
  } finally {
    f.close();
  }
});

test('private database rejects namespace mismatch/symlinks and persisted rate limits survive restart', () => {
  const f = fixture();
  try {
    assert.throws(
      () => new CommunityStore(f.path, 'https://elsewhere.example.test'),
      /COMMUNITY_DATABASE_IDENTITY/,
    );
    const symlink = join(f.folder, 'alias.sqlite');
    symlinkSync(f.path, symlink);
    assert.throws(() => new CommunityStore(symlink, origin), /COMMUNITY_STORAGE_UNSAFE/);
    f.store.consumeRate('creator:' + first, 2, 3600, 1000);
    f.store.consumeRate('creator:' + first, 2, 3600, 1001);
    const other = new CommunityStore(f.path, origin);
    try {
      assert.throws(() => other.consumeRate('creator:' + first, 2, 3600, 1002), /COMMUNITY_RATE_LIMITED/);
      other.consumeRate('creator:' + first, 2, 3600, 3600);
    } finally {
      other.close();
    }
    assert.ok(
      !JSON.stringify(f.store.db.prepare('SELECT * FROM community_rate_limits').all()).includes(first),
    );
  } finally {
    f.close();
  }
});

async function serverFixture() {
  const f = fixture(),
    market = new LaunchMarketStore(join(f.folder, 'market.sqlite'), origin),
    app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  let time = 1000;
  let writable = true;
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof LaunchMarketError)
      return reply.code(error.statusCode).send({ error: { code: error.code } });
    if (error && typeof error === 'object' && 'validation' in error)
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    return reply.code(503).send({ error: { code: 'UNAVAILABLE' } });
  });
  registerCommunityRoutes(app, {
    store: f.store,
    origin,
    now: () => time,
    canWrite: () => writable,
    resolveAccount: (request) =>
      market.walletTestSession(
        request.cookies['__Host-af_market_test'] ?? '',
        typeof request.headers['x-csrf-token'] === 'string' ? request.headers['x-csrf-token'] : null,
        time,
        !['GET', 'HEAD'].includes(request.method),
      )?.account ?? null,
  });
  const session = async (key: number) => {
    const wallet = new Wallet('0x' + key.toString(16).padStart(64, '0')),
      challenge = market.walletTestChallenge(wallet.address, time);
    const signed = market.openWalletTestSession(
      challenge.nonce,
      await wallet.signMessage(challenge.message),
      time,
    );
    return { cookie: '__Host-af_market_test=' + signed.token, origin, 'x-csrf-token': signed.csrfToken };
  };
  return {
    ...f,
    app,
    session,
    readOnly: () => {
      writable = false;
    },
    advance: () => {
      time += 60;
    },
    async close() {
      await app.close();
      market.close();
      f.close();
    },
  };
}

test('HTTP guest reads, real signed-wallet writes, CSRF/origin/schema boundaries and no private leak', async () => {
  const f = await serverFixture();
  try {
    const headers = await f.session(100),
      other = await f.session(101);
    const create = () =>
      f.app.inject({ method: 'POST', url: '/api/community/posts', headers, payload: postInput });
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/community/posts' })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/community/account' })).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/community/posts',
          headers: { origin },
          payload: postInput,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/community/posts',
          headers: { ...headers, 'x-csrf-token': 'x'.repeat(43) },
          payload: postInput,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/community/posts',
          headers: { ...headers, origin: 'https://evil.example.test' },
          payload: postInput,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/community/posts',
          headers: { ...headers, 'sec-fetch-site': 'cross-site' },
          payload: postInput,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/community/posts',
          headers,
          payload: { ...postInput, owner: second },
        })
      ).statusCode,
      400,
    );
    const created = await create();
    assert.equal(created.statusCode, 201);
    const post = created.json().post;
    const reply = await f.app.inject({
      method: 'POST',
      url: '/api/community/posts/' + post.id + '/replies',
      headers: other,
      payload: { body: 'A real shared reply' },
    });
    assert.equal(reply.statusCode, 201);
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/community/posts/' + post.id,
          headers: other,
          payload: { ...postInput, revision: 1 },
        })
      ).statusCode,
      403,
    );
    const privateNote = await f.app.inject({
      method: 'POST',
      url: '/api/community/notes',
      headers,
      payload: { title: 'Private', body: 'A private secret' },
    });
    assert.equal(privateNote.statusCode, 201);
    const guest = await f.app.inject({ method: 'GET', url: '/api/community/posts/' + post.id });
    assert.equal(guest.statusCode, 200);
    assert.equal(guest.json().replies.length, 1);
    assert.ok(!guest.body.includes('A private secret'));
    const privateOther = await f.app.inject({ method: 'GET', url: '/api/community/account', headers: other });
    assert.equal(privateOther.json().notes.length, 0);
    const markup = await f.app.inject({
      method: 'POST',
      url: '/api/community/posts',
      headers,
      payload: { ...postInput, title: '<img src=x onerror=alert(1)>', body: '<script>alert(1)</script>' },
    });
    assert.equal(markup.statusCode, 201);
    assert.match(markup.headers['content-type'] ?? '', /^application\/json/);
    assert.equal(markup.json().post.body, '<script>alert(1)</script>');
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/community/account',
          headers,
          payload: {
            revision: 0,
            preferences: {
              defaultForumCategory: 'All',
              defaultForumSort: 'newest',
              savedStrategies: ['TSLA'],
            },
            draft: { title: '', body: '', category: 'Research Notes' },
          },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/community/account',
          headers,
          payload: { revision: 0 },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await f.app.inject({ method: 'GET', url: '/api/community/posts?limit=51' })).statusCode,
      400,
    );
    f.readOnly();
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/community/notes',
          headers,
          payload: { title: 'Blocked', body: 'Storage full' },
        })
      ).statusCode,
      503,
    );
    const stillReadable = await f.app.inject({ method: 'GET', url: '/api/community/account', headers });
    assert.equal(stillReadable.statusCode, 200);
    assert.equal(stillReadable.headers['cache-control'], 'no-store');
  } finally {
    await f.close();
  }
});

test('HTTP account import remains opt-in and publication throttles without disabling reads', async () => {
  const f = await serverFixture();
  try {
    const headers = await f.session(200);
    const imported = await f.app.inject({
      method: 'POST',
      url: '/api/community/account/import',
      headers,
      payload: { revision: 0, notes: [{ id: 'device-note', title: 'Local', body: 'Imported private note' }] },
    });
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().notes.length, 1);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/community/posts' })).json().posts.length, 0);
    for (let i = 0; i < 30; i++) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/community/posts',
        headers,
        payload: { ...postInput, title: 'Research question ' + i },
      });
      assert.equal(response.statusCode, 201);
    }
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/api/community/posts', headers, payload: postInput }))
        .statusCode,
      429,
    );
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/community/posts' })).statusCode, 200);
    f.advance();
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/api/community/posts', headers, payload: postInput }))
        .statusCode,
      429,
    );
  } finally {
    await f.close();
  }
});
