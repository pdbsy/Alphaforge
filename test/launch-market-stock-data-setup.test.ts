import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createStockDataApi,
  renderStockDataSetup,
  STOCK_DATA_ADMIN,
  StockDataSetupController,
  type StockDataApi,
  type StockDataStatus,
} from '../apps/web/src/launch-market/stock-data-setup.ts';
import type { LaunchClientState } from '../apps/web/src/launch-market/model.ts';
import { account, config, wallet, snapshot, OWNER } from './helpers/launch-market-ui-fixture.ts';
const endpoint = '/api/launch-market/operator/stock-data';
const initial = (): StockDataStatus => ({
  saved: false,
  updatedAt: null,
  source: 'Alpaca IEX',
  readOnlyEnabled: false,
  tradingEnabled: false,
});
const saved = (): StockDataStatus => ({ ...initial(), saved: true, updatedAt: 1792000000 });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const credentials = { apiKey: 'ui-fixture-api-key', apiSecret: 'ui-fixture-api-secret' };
const state = (): LaunchClientState => ({
  enabled: true,
  owner: STOCK_DATA_ADMIN,
  account: { ...account(), wallet: STOCK_DATA_ADMIN },
  wallet: { ...wallet(), owner: STOCK_DATA_ADMIN },
  snapshot: snapshot(),
  config: config(),
  connecting: false,
  busy: false,
  quote: null,
  quoteRequest: null,
  error: null,
  notice: null,
  transaction: { state: 'IDLE', owner: null, id: null, hash: null, confirmations: 0, approval: false },
});
function fixture(api: StockDataApi) {
  let current = state();
  const listeners = new Set<(state: LaunchClientState) => void>();
  const key = { value: '' },
    secret = { value: '' };
  const document = { querySelectorAll: () => [key, secret] } as unknown as Pick<Document, 'querySelectorAll'>;
  const form = {
    elements: { namedItem: (name: string) => (name === 'apiKey' ? key : secret) },
  } as unknown as HTMLFormElement;
  const launch = {
    get state() {
      return current;
    },
    subscribe(listener: (value: LaunchClientState) => void) {
      listeners.add(listener);
      listener(current);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const controller = new StockDataSetupController(launch, { api, document, render() {} });
  controller.show(true);
  return {
    controller,
    key,
    secret,
    form,
    launch,
    fill() {
      key.value = credentials.apiKey;
      secret.value = credentials.apiSecret;
    },
    update(value: Partial<LaunchClientState>) {
      current = { ...current, ...value };
      for (const listener of listeners) listener(current);
    },
  };
}

test('administrator form uses empty password fields and other wallets cannot see saved status', () => {
  const view = { status: saved(), ready: true, loading: false, busy: false, notice: null, error: null };
  const html = renderStockDataSetup(state(), view, 'wallet-controls', 'access-controls');
  assert.equal((html.match(/type="password"/g) ?? []).length, 2);
  assert.equal((html.match(/autocomplete="off"/g) ?? []).length, 3);
  assert.equal((html.match(/value=""/g) ?? []).length, 2);
  assert.match(html, /sends no real stock orders/);
  assert.match(html, /app.alpaca.markets\/signup/);
  assert.match(html, /app.alpaca.markets\/account\/login/);
  const denied = renderStockDataSetup(
    { ...state(), owner: OWNER, account: { ...account(), wallet: OWNER } },
    view,
    '',
    'access-controls',
  );
  assert.match(denied, /Administrator wallet required/);
  assert.doesNotMatch(denied, /data-stock-data-form|Saved on the server|Last saved/);
});

test('one-use nonce and selected-session CSRF accompany only an explicit POST body, never its URL', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const api = createStockDataApi((async (url, init) => {
    requests.push({ url: String(url), ...(init ? { init } : {}) });
    if (String(url).endsWith('/test-session'))
      return Response.json({ identityKind: 'WALLET_TEST', csrfToken: 'fixture-private-wallet-csrf' });
    if (init?.method === 'POST') return Response.json(saved());
    return Response.json(initial(), {
      headers: { 'x-stock-data-save-nonce': 'fixture_one_use_nonce_000001' },
    });
  }) as typeof fetch);
  const read = await api.read(() => true);
  await api.save(credentials, read.nonce, () => true);
  const posted = requests.find((request) => request.init?.method === 'POST')!;
  assert.equal(posted.url, endpoint);
  assert.deepEqual(JSON.parse(String(posted.init!.body)), credentials);
  const headers = new Headers(posted.init!.headers);
  assert.equal(headers.get('x-stock-data-save-nonce'), read.nonce);
  assert.equal(headers.get('x-csrf-token'), 'fixture-private-wallet-csrf');
  assert.equal(posted.init!.credentials, 'same-origin');
  assert.equal(posted.init!.cache, 'no-store');
  assert.equal(
    requests.some((request) => request.url.includes(credentials.apiSecret) || request.url.includes('?')),
    false,
  );
});

test('a wallet change during CSRF lookup prevents sending the captured credentials', async () => {
  let current = true,
    posts = 0;
  const api = createStockDataApi((async (_url, init) => {
    if (init?.method === 'POST') {
      posts++;
      return Response.json(saved());
    }
    current = false;
    return Response.json({ identityKind: 'WALLET_TEST', csrfToken: 'fixture-private-wallet-csrf' });
  }) as typeof fetch);
  await assert.rejects(api.save(credentials, 'fixture_one_use_nonce_000001', () => current));
  assert.equal(posts, 0);
});

test('submission immediately clears fields, suppresses duplicates and never adds credentials to controller state', async () => {
  const pending = Promise.withResolvers<StockDataStatus>();
  let count = 0;
  let metadata = initial();
  const f = fixture({
    read: async () => ({ status: metadata, nonce: 'fixture_one_use_nonce_000001' }),
    save: async (input) => {
      count++;
      assert.deepEqual(input, credentials);
      return pending.promise;
    },
  });
  await flush();
  f.fill();
  const saving = f.controller.submit(f.form);
  assert.equal(f.key.value, '');
  assert.equal(f.secret.value, '');
  assert.equal(f.controller.state.busy, true);
  await f.controller.submit(f.form);
  assert.equal(count, 1);
  assert.equal(JSON.stringify(f.controller.state).includes(credentials.apiKey), false);
  assert.equal(JSON.stringify(f.controller.state).includes(credentials.apiSecret), false);
  metadata = saved();
  pending.resolve(metadata);
  await saving;
  assert.equal(f.controller.state.status!.saved, true);
  assert.equal(f.key.value, '');
  assert.equal(f.secret.value, '');
  f.controller.dispose();
});

test('an old identity response is discarded and all secrets are cleared before another wallet sees the page', async () => {
  const pending = Promise.withResolvers<StockDataStatus>();
  const f = fixture({
    read: async () => ({ status: initial(), nonce: 'fixture_one_use_nonce_000001' }),
    save: async () => pending.promise,
  });
  await flush();
  f.fill();
  const saving = f.controller.submit(f.form);
  f.update({ owner: OWNER, account: { ...account(), wallet: OWNER }, wallet: { ...wallet(), owner: OWNER } });
  pending.resolve(saved());
  await saving;
  assert.equal(f.controller.state.status, null);
  assert.equal(f.key.value, '');
  assert.equal(f.secret.value, '');
  assert.equal(f.controller.state.notice, null);
  f.controller.dispose();
});

test('a nonce conflict reloads metadata without resending credentials or echoing an untrusted response', async () => {
  let gets = 0,
    posts = 0;
  const api = createStockDataApi((async (url, init) => {
    if (String(url).endsWith('/test-session'))
      return Response.json({ identityKind: 'WALLET_TEST', csrfToken: 'fixture-private-wallet-csrf' });
    if (init?.method === 'POST') {
      posts++;
      return Response.json({ error: credentials.apiSecret }, { status: 409 });
    }
    gets++;
    return Response.json(initial(), {
      headers: { 'x-stock-data-save-nonce': `fixture_one_use_nonce_${String(gets).padStart(6, '0')}` },
    });
  }) as typeof fetch);
  const f = fixture(api);
  await flush();
  f.fill();
  await f.controller.submit(f.form);
  assert.equal(posts, 1);
  assert.equal(gets, 2);
  assert.equal(f.controller.state.ready, true);
  assert.match(f.controller.state.error!, /enter both values again/);
  assert.equal(JSON.stringify(f.controller.state).includes(credentials.apiSecret), false);
  assert.equal(f.secret.value, '');
  f.controller.dispose();
});

test('an uncertain save remains uncertain when a metadata refresh finds a stored credential record', async () => {
  let gets = 0,
    posts = 0;
  const api = createStockDataApi((async (url, init) => {
    if (String(url).endsWith('/test-session'))
      return Response.json({ identityKind: 'WALLET_TEST', csrfToken: 'fixture-private-wallet-csrf' });
    if (init?.method === 'POST') {
      posts++;
      return Response.json({ error: 'STOCK_DATA_SAVE_UNCERTAIN' }, { status: 503 });
    }
    gets++;
    return Response.json(gets === 1 ? initial() : saved(), {
      headers: { 'x-stock-data-save-nonce': `fixture_one_use_nonce_${String(gets).padStart(6, '0')}` },
    });
  }) as typeof fetch);
  const f = fixture(api);
  await flush();
  f.fill();
  await f.controller.submit(f.form);
  assert.equal(posts, 1);
  assert.equal(gets, 2);
  assert.equal(f.controller.state.status!.saved, true);
  assert.equal(f.controller.state.notice, null);
  assert.match(f.controller.state.error!, /save result could not be confirmed/);
  assert.equal(f.key.value, '');
  assert.equal(f.secret.value, '');
  assert.equal(JSON.stringify(f.controller.state).includes(credentials.apiSecret), false);
  f.controller.dispose();
});

test('market-data reading may be enabled while real stock orders remain disabled', async () => {
  const value = { ...saved(), readOnlyEnabled: true };
  const api = createStockDataApi((async () =>
    Response.json(value, {
      headers: { 'x-stock-data-save-nonce': 'fixture_one_use_nonce_000001' },
    })) as typeof fetch);
  const result = await api.read(() => true);
  assert.equal(result.status.readOnlyEnabled, true);
  const html = renderStockDataSetup(
    state(),
    { status: result.status, ready: true, loading: false, busy: false, error: null, notice: null },
    '',
    '',
  );
  assert.match(html, /Market-data reading<\/dt><dd>Enabled/);
  assert.match(html, /Real stock orders<\/dt><dd>Disabled/);
});
