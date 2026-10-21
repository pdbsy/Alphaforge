import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet } from 'ethers';
import { StockDataCredentialStore } from '../apps/server/src/launch-market-adapters/stock-data-credential-store.ts';
import { buildLaunchMarketServer } from '../apps/server/src/launch-market/server.ts';
import { LaunchMarketStore } from '../packages/launch-market/src/store.ts';
import { CommunityStore } from '../packages/launch-market/src/community.ts';
import { LaunchMarketService } from '../packages/launch-market/src/service.ts';

const origin = 'https://credential-save.example.test',
  route = '/api/launch-market/operator/stock-data';
const body = { apiKey: 'sample-API-key-one', apiSecret: 'sample-API-secret-one' };
const replacement = { apiKey: 'sample-API-key-two', apiSecret: 'sample-API-secret-two' };
const statusKeys = ['readOnlyEnabled', 'saved', 'source', 'tradingEnabled', 'updatedAt'];

test('private store starts empty, saves atomically, and rejects stale metadata without overwriting new credentials', () => {
  const folder = mkdtempSync(join(tmpdir(), 'af-stock-store-')),
    path = join(folder, 'stock-data-credentials.json');
  try {
    const store = new StockDataCredentialStore(path),
      empty = store.snapshot();
    assert.equal(empty.status.saved, false);
    assert.equal(empty.status.updatedAt, null);
    assert.equal(existsSync(path), false);
    const saved = store.save(body, empty.fingerprint);
    assert.deepEqual(Object.keys(saved).sort(), statusKeys);
    assert.equal(saved.saved, true);
    assert.equal(saved.source, 'Alpaca IEX');
    assert.equal(saved.readOnlyEnabled, false);
    assert.equal(saved.tradingEnabled, false);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.equal(lstatSync(path).nlink, 1);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), body);
    const current = store.snapshot();
    store.save(replacement, current.fingerprint);
    assert.throws(() => store.save(body, current.fingerprint), /STOCK_DATA_STATE_CHANGED/);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), replacement);
    assert.equal(
      readdirSync(folder).some((name) => name.startsWith('.stock-data-save-')),
      false,
    );
    assert.equal(JSON.stringify(store).includes(replacement.apiSecret), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('unsafe files and directories fail closed, preserving old content and exposing no key or path in errors', () => {
  const folder = mkdtempSync(join(tmpdir(), 'af-stock-store-unsafe-'));
  const path = join(folder, 'stock-data-credentials.json'),
    victim = join(folder, 'victim.json'),
    alias = join(folder, 'alias.json');
  const fail = (work: () => unknown) =>
    assert.throws(work, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'STOCK_DATA_STORAGE_UNAVAILABLE');
      assert.equal(JSON.stringify(error).includes(body.apiSecret), false);
      assert.equal(error.message.includes(folder), false);
      return true;
    });
  try {
    writeFileSync(victim, JSON.stringify(body), { mode: 0o600 });
    symlinkSync(victim, path);
    fail(() => new StockDataCredentialStore(path));
    unlinkSync(path);
    assert.deepEqual(JSON.parse(readFileSync(victim, 'utf8')), body);
    writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
    linkSync(path, alias);
    fail(() => new StockDataCredentialStore(path));
    unlinkSync(alias);
    chmodSync(path, 0o644);
    fail(() => new StockDataCredentialStore(path));
    chmodSync(path, 0o600);
    const store = new StockDataCredentialStore(path),
      prior = store.snapshot();
    chmodSync(folder, 0o755);
    fail(() => store.save(replacement, prior.fingerprint));
    chmodSync(folder, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), body);
    writeFileSync(path, 'x'.repeat(4097));
    fail(() => new StockDataCredentialStore(path));
    assert.equal(readFileSync(path).length, 4097);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('precommit durability failures preserve old credentials while postcommit failures require explicit metadata readback', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'af-stock-store-durability-')),
    path = join(folder, 'stock-data-credentials.json');
  const store = new StockDataCredentialStore(path);
  const originalFsync = fs.fsyncSync;
  try {
    store.save(body, store.snapshot().fingerprint);
    let hook = t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if (fs.fstatSync(fd).isFile()) throw new Error('private-fault-' + replacement.apiSecret);
      originalFsync(fd);
    });
    syncBuiltinESMExports();
    assert.throws(
      () => store.save(replacement, store.snapshot().fingerprint),
      /STOCK_DATA_STORAGE_UNAVAILABLE/,
    );
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), body);
    hook.mock.restore();
    syncBuiltinESMExports();
    hook = t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error('private-fault-' + replacement.apiSecret);
      originalFsync(fd);
    });
    syncBuiltinESMExports();
    assert.throws(
      () => store.save(replacement, store.snapshot().fingerprint),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'STOCK_DATA_SAVE_UNCERTAIN');
        assert.equal(error.message.includes(replacement.apiSecret), false);
        return true;
      },
    );
    assert.equal(store.snapshot().status.saved, true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), replacement);
    assert.equal(
      readdirSync(folder).some((name) => name.startsWith('.stock-data-save-')),
      false,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(folder, { recursive: true, force: true });
  }
});

async function fixture(readOnlyEnabled = false) {
  const folder = mkdtempSync(join(tmpdir(), 'af-stock-data-http-'));
  const path = join(folder, 'stock-data-credentials.json');
  const market = new LaunchMarketStore(join(folder, 'market.sqlite'), origin),
    community = new CommunityStore(join(folder, 'community.sqlite'), origin);
  const credentials = new StockDataCredentialStore(path),
    admin = Wallet.createRandom(),
    outsider = Wallet.createRandom(),
    google = Wallet.createRandom();
  let now = 2000000000,
    writable = true;
  const service = new LaunchMarketService({
    manifest: null,
    chain: null,
    store: market,
    ethReference: null,
    quoteSigner: null,
    claimSigner: null,
    now: () => now,
  });
  const identity = {
    email: 'legacy-google@example.test',
    subject: 'legacy-google',
    emailVerified: true as const,
  };
  const account = service.account(identity),
    bind = market.bindingChallenge(account.id, google.address, now);
  market.bindWallet(account.id, bind.nonce, await google.signMessage(bind.message), now);
  const session = async (wallet: typeof admin) => {
    const challenge = market.walletTestChallenge(wallet.address, now);
    const opened = market.openWalletTestSession(
      challenge.nonce,
      await wallet.signMessage(challenge.message),
      now,
    );
    return {
      cookie: '__Host-af_market_test=' + opened.token + '; legacy-google=present',
      origin,
      'x-csrf-token': opened.csrfToken,
    };
  };
  const adminA = await session(admin),
    adminB = await session(admin),
    ordinary = await session(outsider);
  const server = await buildLaunchMarketServer({
    service,
    origin,
    community,
    verificationRequired: () => false,
    trustedIdentity: (request) => (request.cookies['legacy-google'] === 'present' ? identity : null),
    canCommunityWrite: () => writable,
    operatorStockData: {
      store: credentials,
      operatorWallet: admin.address,
      readOnlyEnabled: () => readOnlyEnabled,
    },
  });
  const call = (
    method: 'GET' | 'POST',
    payload?: unknown,
    headers: Record<string, string> = adminA,
    suffix = '',
  ) =>
    server.app.inject({
      method,
      url: route + suffix,
      headers: { host: new URL(origin).host, ...headers },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const getNonce = async (headers = adminA) => {
    const response = await call('GET', undefined, headers);
    assert.equal(response.statusCode, 200);
    const value = response.headers['x-stock-data-save-nonce'];
    assert.equal(typeof value, 'string');
    return { value: String(value), status: response.json(), response };
  };
  const nonceHeaders = (nonce: string, headers = adminA) => ({
    ...headers,
    'x-stock-data-save-nonce': nonce,
  });
  return {
    call,
    getNonce,
    nonceHeaders,
    adminA,
    adminB,
    ordinary,
    credentials,
    path,
    full: () => {
      writable = false;
    },
    writable: () => {
      writable = true;
    },
    expire: () => {
      now += 301;
    },
    close: async () => {
      await server.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

test('credential endpoints require the selected operator wallet, retain per-device CSRF, and never return secret data', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('GET', undefined, {})).statusCode, 401);
    const ordinary = await f.call('GET', undefined, f.ordinary);
    assert.equal(ordinary.statusCode, 403);
    assert.equal(ordinary.headers['x-stock-data-save-nonce'], undefined);
    const nonce = await f.getNonce();
    assert.deepEqual(Object.keys(nonce.status).sort(), statusKeys);
    assert.equal(nonce.status.saved, false);
    assert.equal(
      (
        await f.call('POST', body, {
          cookie: f.adminA.cookie,
          origin,
          'x-stock-data-save-nonce': nonce.value,
        })
      ).statusCode,
      401,
    );
    assert.equal((await f.call('POST', body, f.nonceHeaders(nonce.value, f.ordinary))).statusCode, 403);
    assert.equal(
      (
        await f.call('POST', body, {
          ...f.nonceHeaders(nonce.value),
          'x-csrf-token': f.adminB['x-csrf-token'],
        })
      ).statusCode,
      401,
    );
    const saved = await f.call('POST', body, f.nonceHeaders(nonce.value));
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(Object.keys(saved.json()).sort(), statusKeys);
    for (const response of [saved, (await f.getNonce()).response]) {
      assert.equal(response.body.includes(body.apiSecret), false);
      assert.equal(response.body.includes(body.apiKey), false);
      assert.equal(response.body.includes('sample-API'), false);
      assert.equal(response.body.includes(f.path), false);
      assert.equal(response.json().readOnlyEnabled, false);
      assert.equal(response.json().tradingEnabled, false);
    }
  } finally {
    await f.close();
  }
});

test('enabled data status comes only from the trusted runtime and never enables real stock orders', async () => {
  const f = await fixture(true);
  try {
    const nonce = await f.getNonce();
    assert.equal(nonce.status.readOnlyEnabled, true);
    assert.equal(nonce.status.tradingEnabled, false);
    const saved = await f.call('POST', body, f.nonceHeaders(nonce.value));
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().readOnlyEnabled, true);
    assert.equal(saved.json().tradingEnabled, false);
    assert.equal(saved.body.includes(body.apiSecret), false);
    assert.equal((await f.call('GET', undefined, f.ordinary)).statusCode, 403);
  } finally {
    await f.close();
  }
});

test('strict origin, exact fields, ASCII and size checks reject malformed requests without reflecting credentials', async () => {
  const f = await fixture();
  try {
    const nonce = await f.getNonce(),
      headers = f.nonceHeaders(nonce.value);
    assert.equal(
      (await f.call('POST', body, { ...headers, origin: 'https://evil.example' })).statusCode,
      403,
    );
    assert.equal(
      (await f.call('POST', body, { ...headers, 'sec-fetch-site': 'cross-site' })).statusCode,
      403,
    );
    for (const invalid of [
      { ...body, owner: '0x' + '11'.repeat(20) },
      { ...body, path: f.path },
      { ...body, url: 'https://example.test' },
      { ...body, apiSecret: '' },
      { ...body, apiSecret: body.apiSecret + '\n' },
      { ...body, apiSecret: '非ASCII' },
      { ...body, apiKey: 'x'.repeat(1025) },
    ]) {
      const response = await f.call('POST', invalid, headers);
      assert.equal(response.statusCode, 400);
      assert.equal(response.body.includes(body.apiSecret), false);
      assert.equal(response.body.includes(f.path), false);
    }
    const oversized = await f.call('POST', { ...body, apiSecret: 'x'.repeat(5000) }, headers);
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.body.includes('xxxx'), false);
    const malformed = await f.call('POST', '{"apiSecret":"' + body.apiSecret, {
      ...headers,
      'content-type': 'application/json',
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.body.includes(body.apiSecret), false);
    assert.equal(
      (await f.call('GET', undefined, f.adminA, '?path=' + encodeURIComponent(f.path))).statusCode,
      400,
    );
    assert.equal(existsSync(f.path), false);
    assert.equal((await f.call('POST', body, headers)).statusCode, 200); // rejected input did not consume a valid save.
  } finally {
    await f.close();
  }
});

test('one-time save authorization is session-bound, rotated on GET, expires, and cannot be replayed', async () => {
  const f = await fixture();
  try {
    const first = await f.getNonce();
    assert.equal((await f.call('POST', body, f.nonceHeaders(first.value, f.adminB))).statusCode, 409);
    const rotated = await f.getNonce();
    assert.equal((await f.call('POST', body, f.nonceHeaders(first.value))).statusCode, 409);
    assert.equal((await f.call('POST', body, f.nonceHeaders(rotated.value))).statusCode, 200);
    assert.equal((await f.call('POST', replacement, f.nonceHeaders(rotated.value))).statusCode, 409);
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), body);
    const expiring = await f.getNonce();
    f.expire();
    assert.equal((await f.call('POST', replacement, f.nonceHeaders(expiring.value))).statusCode, 409);
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), body);
  } finally {
    await f.close();
  }
});

test('another device cannot overwrite a newer save with an older nonce and file identity', async () => {
  const f = await fixture();
  try {
    const a = await f.getNonce(f.adminA),
      b = await f.getNonce(f.adminB);
    assert.equal((await f.call('POST', body, f.nonceHeaders(a.value, f.adminA))).statusCode, 200);
    const stale = await f.call('POST', replacement, f.nonceHeaders(b.value, f.adminB));
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'STOCK_DATA_STATE_CHANGED');
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), body);
    const fresh = await f.getNonce(f.adminB);
    assert.equal((await f.call('POST', replacement, f.nonceHeaders(fresh.value, f.adminB))).statusCode, 200);
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), replacement);
  } finally {
    await f.close();
  }
});

test('capacity failure consumes nonce while preserving old credentials, and save rate limits never echo secrets', async () => {
  const f = await fixture();
  try {
    let nonce = await f.getNonce();
    assert.equal((await f.call('POST', body, f.nonceHeaders(nonce.value))).statusCode, 200);
    nonce = await f.getNonce();
    f.full();
    const failure = await f.call('POST', replacement, f.nonceHeaders(nonce.value));
    assert.equal(failure.statusCode, 503);
    assert.equal(failure.body.includes(replacement.apiSecret), false);
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), body);
    f.writable();
    assert.equal((await f.call('POST', replacement, f.nonceHeaders(nonce.value))).statusCode, 409);
    for (let i = 0; i < 3; i++) {
      nonce = await f.getNonce();
      assert.equal((await f.call('POST', replacement, f.nonceHeaders(nonce.value))).statusCode, 200);
    }
    nonce = await f.getNonce();
    const limited = await f.call('POST', body, f.nonceHeaders(nonce.value));
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'STOCK_DATA_RATE_LIMITED');
    assert.equal(limited.body.includes(body.apiSecret), false);
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), replacement);
  } finally {
    await f.close();
  }
});
