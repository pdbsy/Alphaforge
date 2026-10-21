import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { buildLaunchMarketServer } from '../apps/server/src/launch-market/server.ts';
import { CommunityStore } from '../packages/launch-market/src/community.ts';
import { CreatorStrategyStore } from '../packages/launch-market/src/creator.ts';
import { LaunchMarketService } from '../packages/launch-market/src/service.ts';
import { LaunchMarketStore } from '../packages/launch-market/src/store.ts';
import type { TrustedEmailIdentity } from '../packages/launch-market/src/types.ts';

const origin = 'https://product-http.example.test';
const policy = {
  name: 'A bounded TSLA allocation',
  symbol: 'TSLA',
  summary: 'Hold a bounded allocation through regular market sessions.',
  method: 'Purchase the allocation after explicit owner approval and risk review.',
  risks: 'Prices can fall and gaps can exceed the configured tolerance.',
  policy: { kind: 'BUY_AND_HOLD', allocationBps: 2500, maxSlippageBps: 100 },
};
const post = {
  title: 'Shared research from one device',
  body: 'A durable observation visible to every reader.',
  category: 'Research Notes',
  strategyId: 'TSLA',
};
type Headers = Record<string, string>;
interface Response {
  status: number;
  headers: import('node:http').IncomingHttpHeaders;
  body: string;
  json: ReturnType<typeof JSON.parse>;
}

async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'af-product-http-'));
  const market = new LaunchMarketStore(join(folder, 'market.sqlite'), origin);
  const community = new CommunityStore(join(folder, 'community.sqlite'), origin);
  const creators = new CreatorStrategyStore(join(folder, 'creator.sqlite'), origin);
  let time = 1000;
  let verifiedOnly = false;
  let writable = true;
  let googleIdentity: TrustedEmailIdentity | null = null;
  const googleToken = randomBytes(32).toString('base64url');
  const googleCsrf = randomBytes(32).toString('base64url');
  const service = new LaunchMarketService({
    manifest: null,
    store: market,
    chain: null,
    ethReference: null,
    quoteSigner: null,
    claimSigner: null,
    now: () => time,
  });
  const server = await buildLaunchMarketServer({
    service,
    origin,
    community,
    creators,
    canCommunityWrite: () => writable,
    verificationRequired: () => verifiedOnly,
    // An isolated server-issued identity callback, mirroring the bridge's cookie/CSRF contract.
    // No external OAuth, production cookie or wallet key participates in this test.
    trustedIdentity: (incoming) => {
      if (incoming.cookies.trusted_google !== googleToken) return null;
      if (!['GET', 'HEAD'].includes(incoming.method) && incoming.headers['x-csrf-token'] !== googleCsrf)
        return null;
      return googleIdentity;
    },
  });
  let address: string;
  try {
    address = await server.start('127.0.0.1', 0);
  } catch (error) {
    await server.stop();
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  const port = Number(new URL(address).port);
  const call = (method: string, path: string, headers: Headers = {}, payload?: unknown): Promise<Response> =>
    new Promise((resolve, reject) => {
      const encoded = payload === undefined ? undefined : JSON.stringify(payload);
      const outgoing = request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: {
            host: new URL(origin).host,
            ...(encoded === undefined ? {} : { 'content-type': 'application/json' }),
            ...headers,
          },
          timeout: 5000,
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1_048_576) outgoing.destroy(new Error('HTTP_RESPONSE_TOO_LARGE'));
            else chunks.push(chunk);
          });
          incoming.on('error', reject);
          incoming.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            try {
              resolve({
                status: incoming.statusCode!,
                headers: incoming.headers,
                body,
                json: JSON.parse(body),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      outgoing.on('timeout', () => outgoing.destroy(new Error('HTTP_TIMEOUT')));
      outgoing.on('error', reject);
      outgoing.end(encoded);
    });
  const session = async (wallet: Pick<Wallet, 'address' | 'signMessage'>): Promise<Headers> => {
    time++;
    const challenge = await call(
      'POST',
      '/api/launch-market/wallet/test-challenge',
      { origin },
      { owner: wallet.address },
    );
    assert.equal(challenge.status, 200, challenge.body);
    const opened = await call(
      'POST',
      '/api/launch-market/wallet/test-session',
      { origin },
      { nonce: challenge.json.nonce, signature: await wallet.signMessage(challenge.json.message) },
    );
    assert.equal(opened.status, 200, opened.body);
    const cookie = opened.headers['set-cookie']![0]!.split(';')[0]!;
    assert.match(opened.headers['set-cookie']![0]!, /HttpOnly/);
    assert.match(opened.headers['set-cookie']![0]!, /Secure/);
    const restored = await call('GET', '/api/launch-market/wallet/test-session', { cookie });
    assert.equal(restored.status, 200, restored.body);
    return { cookie, origin, 'x-csrf-token': restored.json.csrfToken };
  };
  return {
    call,
    session,
    market,
    community,
    creators,
    readOnly: () => {
      writable = false;
    },
    google: (identity: TrustedEmailIdentity) => {
      googleIdentity = identity;
      return { cookie: 'trusted_google=' + googleToken, origin, 'x-csrf-token': googleCsrf };
    },
    requireGoogle: () => {
      verifiedOnly = true;
    },
    async close() {
      await server.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

test('assembled HTTP server synchronizes two proven-wallet devices, isolates private data and handles revisions/logout', async () => {
  const f = await fixture();
  try {
    const wallet = Wallet.createRandom(),
      otherWallet = Wallet.createRandom();
    const deviceA = await f.session(wallet),
      deviceB = await f.session(wallet),
      other = await f.session(otherWallet);
    assert.notEqual(deviceA.cookie, deviceB.cookie);
    assert.notEqual(deviceA['x-csrf-token'], deviceB['x-csrf-token']);
    assert.equal((await f.call('GET', '/api/community/account')).status, 401);
    assert.equal((await f.call('POST', '/api/community/posts', { origin }, post)).status, 401);
    assert.equal(
      (
        await f.call(
          'POST',
          '/api/community/posts',
          { ...deviceA, 'x-csrf-token': deviceB['x-csrf-token']! },
          post,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await f.call(
          'POST',
          '/api/community/posts',
          { ...deviceA, origin: 'https://elsewhere.example.test' },
          post,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.call('POST', '/api/community/posts', { ...deviceA, 'sec-fetch-site': 'cross-site' }, post))
        .status,
      403,
    );
    assert.equal(
      (await f.call('POST', '/api/community/posts', deviceA, { ...post, wallet: otherWallet.address }))
        .status,
      400,
    );
    const profile = await f.call('PUT', '/api/community/account', deviceA, {
      revision: 0,
      profile: { displayName: 'A shared researcher', bio: 'A private profile preference.' },
      preferences: {
        defaultForumCategory: 'Research Notes',
        defaultForumSort: 'replies',
        savedStrategies: ['TSLA'],
      },
      draft: { title: 'Unfinished', body: 'Private draft content', category: 'Research Notes' },
    });
    assert.equal(profile.status, 200, profile.body);
    const synchronized = await f.call('GET', '/api/community/account', deviceB);
    assert.equal(synchronized.json.profile.displayName, 'A shared researcher');
    assert.equal(synchronized.json.draft.body, 'Private draft content');
    assert.equal(
      (
        await f.call('PUT', '/api/community/account', deviceB, {
          revision: 0,
          profile: { displayName: 'Stale device', bio: '' },
        })
      ).status,
      409,
    );
    const note = await f.call('POST', '/api/community/notes', deviceA, {
      id: 'private-device-note',
      title: 'Only mine',
      body: 'Confidential wallet notebook.',
    });
    assert.equal(note.status, 201, note.body);
    assert.equal(
      (await f.call('GET', '/api/community/account', deviceB)).json.notes[0].body,
      'Confidential wallet notebook.',
    );
    assert.equal((await f.call('GET', '/api/community/account', other)).json.notes.length, 0);
    assert.equal(
      (
        await f.call('PUT', '/api/community/notes/private-device-note', other, {
          title: 'Unauthorized',
          body: 'Changed content',
          revision: 1,
        })
      ).status,
      404,
    );
    const created = await f.call('POST', '/api/community/posts', deviceA, post);
    assert.equal(created.status, 201, created.body);
    const id = created.json.post.id;
    assert.equal(
      (
        await f.call('POST', '/api/community/posts/' + id + '/replies', other, {
          body: 'A reply from another wallet',
        })
      ).status,
      201,
    );
    const guest = await f.call('GET', '/api/community/posts/' + id);
    assert.equal(guest.status, 200, guest.body);
    assert.equal(guest.json.replies.length, 1);
    assert.ok(!guest.body.includes('Confidential wallet notebook.'));
    assert.ok(!guest.body.includes('Private draft content'));
    assert.equal(
      (await f.call('PUT', '/api/community/posts/' + id, other, { ...post, revision: 1 })).status,
      403,
    );
    const edited = await f.call('PUT', '/api/community/posts/' + id, deviceB, {
      ...post,
      body: 'Edited on a second device.',
      revision: 1,
    });
    assert.equal(edited.status, 200, edited.body);
    assert.equal(
      (await f.call('PUT', '/api/community/posts/' + id, deviceA, { ...post, revision: 1 })).status,
      409,
    );
    assert.equal(
      (await f.call('PUT', '/api/community/posts/' + id + '/bookmark', deviceA, { active: true })).status,
      200,
    );
    assert.equal((await f.call('GET', '/api/community/account', deviceB)).json.bookmarkedPosts[0].id, id);
    assert.equal(
      (
        await f.call(
          'POST',
          '/api/launch-market/wallet/logout',
          { ...deviceA, 'x-csrf-token': deviceB['x-csrf-token']! },
          { allDevices: false },
        )
      ).status,
      401,
    );
    assert.equal(
      (await f.call('POST', '/api/launch-market/wallet/logout', deviceA, { allDevices: false })).status,
      200,
    );
    assert.equal((await f.call('GET', '/api/community/account', deviceA)).status, 401);
    assert.equal((await f.call('GET', '/api/community/account', deviceB)).status, 200);
    assert.equal(
      (await f.call('POST', '/api/launch-market/wallet/logout', deviceB, { allDevices: true })).status,
      200,
    );
    assert.equal((await f.call('GET', '/api/community/account', deviceB)).status, 401);
    assert.equal((await f.call('GET', '/api/community/account', other)).status, 200);
    f.readOnly();
    assert.equal((await f.call('POST', '/api/community/posts', other, post)).status, 503);
    assert.equal((await f.call('POST', '/api/creator/strategies', other, policy)).status, 503);
    assert.equal((await f.call('GET', '/api/community/posts')).status, 200);
    assert.equal(f.market.db.prepare('SELECT count(*) n FROM market_operations').get()!.n, 0);
    assert.equal(f.market.db.prepare('SELECT count(*) n FROM market_claim_vouchers').get()!.n, 0);
  } finally {
    await f.close();
  }
});

test('assembled creator HTTP publication is immutable and rejects stale publication races and policy/CSRF bypass', async () => {
  const f = await fixture();
  try {
    const wallet = Wallet.createRandom(),
      otherWallet = Wallet.createRandom(),
      googleWallet = Wallet.createRandom();
    const deviceA = await f.session(wallet),
      deviceB = await f.session(wallet),
      other = await f.session(otherWallet);
    const created = await f.call('POST', '/api/creator/strategies', deviceA, policy);
    assert.equal(created.status, 201, created.body);
    const id = created.json.strategy.id;
    assert.equal((await f.call('GET', '/api/strategies/' + id)).status, 404);
    assert.equal((await f.call('GET', '/api/creator/strategies', other)).json.strategies.length, 0);
    assert.equal(
      (
        await f.call('POST', '/api/creator/strategies/' + id + '/publish', other, {
          expectedVersion: 1,
          expectedPublicationRevision: 0,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await f.call(
          'POST',
          '/api/creator/strategies',
          { ...deviceA, 'x-csrf-token': deviceB['x-csrf-token']! },
          policy,
        )
      ).status,
      401,
    );
    assert.equal(
      (await f.call('POST', '/api/creator/strategies', deviceA, { ...policy, execute: 'arbitraryCode()' }))
        .status,
      400,
    );
    const published = await f.call('POST', '/api/creator/strategies/' + id + '/publish', deviceA, {
      expectedVersion: 1,
      expectedPublicationRevision: 0,
    });
    assert.equal(published.status, 200, published.body);
    assert.equal(published.json.strategy.publicationRevision, 1);
    assert.equal(published.json.strategy.executionStatus, 'DOCUMENT_ONLY');
    const initialPublic = await f.call('GET', '/api/strategies/' + id);
    const edited = await f.call('PUT', '/api/creator/strategies/' + id, deviceB, {
      ...policy,
      name: 'Private unpublished next revision',
      expectedVersion: 1,
    });
    assert.equal(edited.status, 200, edited.body);
    assert.equal(edited.json.strategy.version, 2);
    assert.equal((await f.call('GET', '/api/strategies/' + id)).json.strategy.name, policy.name);
    assert.equal(
      (await f.call('GET', '/api/strategies/' + id)).json.strategy.digest,
      initialPublic.json.strategy.digest,
    );
    assert.equal(
      (await f.call('PUT', '/api/creator/strategies/' + id, deviceA, { ...policy, expectedVersion: 1 }))
        .status,
      409,
    );
    assert.equal(
      (
        await f.call('POST', '/api/creator/strategies/' + id + '/publish', deviceB, {
          expectedVersion: 2,
          expectedPublicationRevision: 1,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.call('POST', '/api/creator/strategies/' + id + '/unpublish', deviceA, {
          expectedVersion: 2,
          expectedPublicationRevision: 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call('POST', '/api/creator/strategies/' + id + '/unpublish', deviceB, {
          expectedVersion: 2,
          expectedPublicationRevision: 2,
        })
      ).status,
      200,
    );
    assert.equal((await f.call('GET', '/api/strategies/' + id)).status, 404);
    assert.equal(
      (
        await f.call('POST', '/api/creator/strategies/' + id + '/publish', deviceA, {
          expectedVersion: 2,
          expectedPublicationRevision: 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call('POST', '/api/creator/strategies/' + id + '/publish', deviceB, {
          expectedVersion: 2,
          expectedPublicationRevision: 3,
        })
      ).status,
      200,
    );
    const googleHeaders = f.google({
      email: 'verified@example.test',
      subject: 'isolated-subject',
      emailVerified: true,
    });
    const challenge = await f.call('POST', '/api/launch-market/wallet/challenge', googleHeaders, {
      owner: googleWallet.address,
    });
    assert.equal(challenge.status, 200, challenge.body);
    const bound = await f.call('POST', '/api/launch-market/wallet/bind', googleHeaders, {
      nonce: challenge.json.nonce,
      signature: await googleWallet.signMessage(challenge.json.message),
    });
    assert.equal(bound.status, 200, bound.body);
    const bothCookies = deviceA.cookie + '; ' + googleHeaders.cookie;
    assert.equal(
      (await f.call('GET', '/api/community/account', { cookie: bothCookies })).json.wallet,
      wallet.address.toLowerCase(),
    );
    assert.equal(
      (await f.call('POST', '/api/creator/strategies', { ...googleHeaders, cookie: bothCookies }, policy))
        .status,
      401,
    );
    f.requireGoogle();
    assert.equal((await f.call('GET', '/api/community/account', deviceA)).status, 401);
    assert.equal(
      (await f.call('GET', '/api/community/account', { cookie: bothCookies })).json.wallet,
      googleWallet.address.toLowerCase(),
    );
    assert.equal(
      (await f.call('POST', '/api/creator/strategies', { ...googleHeaders, 'x-csrf-token': 'wrong' }, policy))
        .status,
      401,
    );
    assert.equal((await f.call('POST', '/api/creator/strategies', googleHeaders, policy)).status, 201);
    assert.equal(f.market.db.prepare('SELECT count(*) n FROM market_operations').get()!.n, 0);
  } finally {
    await f.close();
  }
});
