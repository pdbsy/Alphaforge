import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Wallet, getAddress, getBytes, toUtf8String } from 'ethers';
import { LaunchMarketStore } from '../packages/launch-market/src/store.ts';
import { marketInterfaces } from '../packages/launch-market/src/abi.ts';
import {
  LaunchMarketClient,
  MarketApiError,
  createLaunchApi,
  newerLocation,
} from '../apps/web/src/launch-market/client.ts';
import {
  fixture,
  account,
  OWNER,
  OTHER,
  HASH,
  BLOCK,
  NOW,
  location,
  quote,
} from './helpers/launch-market-ui-fixture.ts';
import type { QuoteRequest } from '../packages/launch-market/src/types.ts';
const buy: Omit<QuoteRequest, 'owner'> = {
  strategyId: 'AMZN',
  operation: 'BUY',
  asset: 'AF_USDC',
  amountRaw: '10000000',
  slippageBps: 50,
};
async function connected() {
  const f = fixture();
  const client = new LaunchMarketClient({ api: f.api, provider: f.provider, now: () => NOW });
  assert.equal(await client.initialize(), true);
  await client.connect();
  return { ...f, client };
}

test('absent chain-market route keeps the existing workshop; NOT_DEPLOYED performs no asset or wallet request', async () => {
  const missing = new LaunchMarketClient({
    api: async () => {
      throw new MarketApiError('NOT_FOUND', 404);
    },
  });
  assert.equal(await missing.initialize(), false);
  const f = fixture();
  f.state.config = { ...f.state.config, deployment: 'NOT_DEPLOYED', manifest: null };
  const client = new LaunchMarketClient({ api: f.api, provider: f.provider });
  assert.equal(await client.initialize(), true);
  assert.equal(client.state.snapshot, null);
  assert.deepEqual(f.provider.calls, []);
  assert.equal(f.state.requests.length, 1);
  await assert.rejects(client.review(buy), /MARKET_ACTION_UNAVAILABLE/);
});

test('quote review binds owner, strategy, asset, amount, recipient and slippage before a wallet send', async () => {
  const { client, state, provider } = await connected();
  const base = quote({ ...buy, owner: OWNER });
  state.quote = {
    ...base,
    transaction: {
      ...base.transaction,
      data: marketInterfaces.pool.encodeFunctionData('buy', [
        buy.amountRaw,
        base.minOutRaw,
        OTHER,
        base.expiresAt,
      ]),
    },
  };
  await assert.rejects(client.review(buy), /QUOTE_TRANSACTION_MISMATCH/);
  state.quote = {
    ...base,
    minOutRaw: '1',
    transaction: {
      ...base.transaction,
      data: marketInterfaces.pool.encodeFunctionData('buy', [buy.amountRaw, '1', OWNER, base.expiresAt]),
    },
  };
  await assert.rejects(client.review(buy), /QUOTE_SLIPPAGE_MISMATCH/);
  state.quote = { ...base, asset: 'ETH' };
  await assert.rejects(client.review(buy), /QUOTE_REQUEST_MISMATCH/);
  assert.equal(
    provider.calls.some((call) => call.method === 'eth_sendTransaction'),
    false,
  );
});

test('ETH is native transaction value, with no token approval or AF-ETH substitution', async () => {
  const { client, provider } = await connected();
  await client.review({ ...buy, asset: 'ETH', amountRaw: '10000000000000000' });
  await client.confirm();
  const sent = provider.calls.find((call) => call.method === 'eth_sendTransaction');
  assert.equal((sent?.params?.[0] as { value: string }).value, '0x2386f26fc10000');
  assert.equal(client.state.transaction.state, 'SUBMITTED');
  assert.equal(client.state.transaction.hash, HASH);
});

test('ETH SELL validates the 1% USDC minimum before conversion rounding and rejects a lower signed minimum', async () => {
  const { client, state, provider } = await connected();
  const request: Omit<QuoteRequest, 'owner'> = {
    strategyId: 'AMZN',
    operation: 'SELL',
    asset: 'ETH',
    amountRaw: '1000000000000000000',
    slippageBps: 100,
  };
  const manifest = state.config.manifest!;
  const grossUsdc = 498579n,
    price = 2000000000n;
  const conversionFee = (grossUsdc * 30n + 9999n) / 10000n;
  const output = ((grossUsdc - conversionFee) * 10n ** 18n) / price;
  const signedMinimum = (grossUsdc * 9900n) / 10000n;
  const convertMinimum = (usdc: bigint) => ((usdc - (usdc * 30n + 9999n) / 10000n) * 10n ** 18n) / price;
  const minimumOutput = convertMinimum(signedMinimum);
  assert.ok(minimumOutput < (output * 9900n) / 10000n, 'This valid quote exposes conversion rounding');
  const native = {
    router: manifest.router,
    payer: OWNER,
    accountId: HASH,
    operation: 2,
    pass: manifest.strategies.AMZN.pass,
    amountIn: request.amountRaw,
    usdcAmount: signedMinimum,
    minOut: minimumOutput,
    ethAmount: output,
    ethUsdPrice: price,
    nonce: 1,
    issuedAt: NOW,
    deadline: NOW + 60,
    epoch: 1,
  };
  const base = {
    ...quote({ ...request, owner: OWNER }),
    estimatedOutRaw: String(output),
    minOutRaw: String(minimumOutput),
    conversionFeeUsdcRaw: String(conversionFee),
    transaction: {
      to: manifest.router,
      value: '0',
      data: marketInterfaces.router.encodeFunctionData('sellNative', [native, '0x']),
    },
  };
  state.quote = base;
  await client.review(request);
  assert.equal(client.state.quote!.minOutRaw, String(minimumOutput));
  const lowered = signedMinimum - 1n;
  state.quote = {
    ...base,
    minOutRaw: String(convertMinimum(lowered)),
    transaction: {
      ...base.transaction,
      data: marketInterfaces.router.encodeFunctionData('sellNative', [
        { ...native, usdcAmount: lowered, minOut: convertMinimum(lowered) },
        '0x',
      ]),
    },
  };
  await assert.rejects(client.review(request), /QUOTE_SLIPPAGE_MISMATCH/);
  assert.equal(
    provider.calls.some((call) => call.method === 'eth_sendTransaction'),
    false,
  );
});

test('a wallet network change invalidates the quote and prevents a new send', async () => {
  const { client, provider } = await connected();
  await client.review(buy);
  provider.chainId = '0x1';
  provider.emit('chainChanged', '0x1');
  assert.equal(client.state.quote, null);
  assert.equal(client.state.wallet, null);
  await assert.rejects(client.confirm(), /QUOTE_REVIEW_REQUIRED/);
  assert.equal(
    provider.calls.some((call) => call.method === 'eth_sendTransaction'),
    false,
  );
});

test('explicit wallet rejection is distinct from an uncertain submitted outcome', async () => {
  const rejected = await connected();
  await rejected.client.review(buy);
  rejected.provider.sendError = { code: 4001 };
  await assert.rejects(rejected.client.confirm(), /WALLET_REJECTED/);
  assert.equal(rejected.client.state.transaction.state, 'REJECTED');
  assert.equal(rejected.client.state.transaction.hash, null);
  const uncertain = await connected();
  await uncertain.client.review(buy);
  uncertain.provider.sendError = { code: -32000 };
  await uncertain.client.confirm();
  assert.equal(uncertain.client.state.transaction.state, 'RECOVERY_REQUIRED');
  await assert.rejects(uncertain.client.review(buy), /MARKET_ACTION_UNAVAILABLE/);
  assert.equal(uncertain.provider.calls.filter((call) => call.method === 'eth_sendTransaction').length, 1);
});

test('registration failure preserves the hash and retries observation without broadcasting twice', async () => {
  const { client, provider, state } = await connected();
  await client.review(buy);
  state.registrationError = true;
  await assert.rejects(client.confirm(), /SYNC_UNAVAILABLE/);
  assert.equal(client.state.transaction.state, 'RECOVERY_REQUIRED');
  assert.equal(client.state.transaction.hash, HASH);
  state.registrationError = false;
  await client.refresh();
  assert.equal(client.state.transaction.state, 'SUBMITTED');
  assert.equal(provider.calls.filter((call) => call.method === 'eth_sendTransaction').length, 1);
});

test('a returned hash or insufficient-depth projection cannot mark a transfer complete', async () => {
  const { client, state } = await connected();
  await client.review(buy);
  await client.confirm();
  assert.equal(client.state.transaction.state, 'SUBMITTED');
  state.operation = { ...state.operation, state: 'COMPLETED', confirmations: 2, location: location() };
  await assert.rejects(client.refreshTransaction(), /INSUFFICIENT_CONFIRMATION_EVIDENCE/);
  assert.equal(client.state.transaction.state, 'SUBMITTED');
  state.operation = { ...state.operation, confirmations: 3 };
  await client.refreshTransaction();
  assert.equal(client.state.transaction.state, 'COMPLETED');
});

test('exact ERC-20 approval is a separate transaction and waits three inclusive blocks', async () => {
  const { client, provider, state, tokenInterface } = await connected();
  const base = quote({ ...buy, owner: OWNER });
  state.quote = {
    ...base,
    allowance: { token: state.config.manifest!.usdc, spender: base.transaction.to, amountRaw: buy.amountRaw },
    gasEstimateRaw: null,
    simulation: 'APPROVAL_REQUIRED',
  };
  await client.review(buy);
  await client.confirm();
  const sent = provider.calls.find((call) => call.method === 'eth_sendTransaction')?.params?.[0] as {
    to: string;
    data: string;
    value: string;
  };
  const approval = tokenInterface.parseTransaction({ data: sent.data })!;
  assert.equal(sent.to, state.config.manifest!.usdc);
  assert.equal(sent.value, '0x0');
  assert.equal(approval.name, 'approve');
  assert.equal(approval.args[1], 10000000n);
  assert.equal(
    state.requests.some((request) => request.path.endsWith('/submissions')),
    false,
  );
  provider.receipt = {
    transactionHash: HASH,
    from: OWNER,
    blockNumber: '0x64',
    blockHash: BLOCK,
    status: '0x1',
  };
  provider.tip = '0x65';
  await client.refreshTransaction();
  assert.equal(client.state.transaction.confirmations, 2);
  assert.equal(client.state.transaction.state, 'INCLUDED');
  provider.tip = '0x66';
  await client.refreshTransaction();
  assert.equal(client.state.transaction.state, 'COMPLETED');
  assert.equal(client.state.quote, null);
  assert.match(client.state.notice!, /asset operation has not been sent/);
  assert.equal(provider.calls.filter((call) => call.method === 'eth_sendTransaction').length, 1);
});

test('old synchronization messages cannot undo launch; reorg invalidates quote and rereads chain state', async () => {
  const { client, state } = await connected();
  const launched = {
    ...state.snapshot,
    location: location(102),
    markets: {
      ...state.snapshot.markets,
      TSLA: {
        ...state.snapshot.markets.TSLA,
        state: 'LAUNCHED' as const,
        soldRaw: state.snapshot.markets.TSLA.publicSupplyRaw,
        remainingRaw: '0',
        pool: state.config.manifest!.strategies.AMZN.pool,
        reservePassRaw: state.snapshot.markets.TSLA.lpPassRaw,
        reserveUsdcRaw: state.snapshot.markets.TSLA.lpUsdcRaw,
      },
    },
  };
  await client.stream({ type: 'SNAPSHOT', location: launched.location, snapshot: launched });
  await client.stream({ type: 'SNAPSHOT', location: state.snapshot.location, snapshot: state.snapshot });
  assert.equal(client.state.snapshot!.markets.TSLA.state, 'LAUNCHED');
  await client.review(buy);
  await client.stream({ type: 'REORG', location: location(100) });
  assert.equal(client.state.quote, null);
  assert.equal(client.state.snapshot!.markets.TSLA.state, 'MINTING');
  assert.equal(newerLocation({ ...location(100), blockHash: HASH }, location(100)), false);
});

test('same-origin mutations acquire session CSRF without asserting a browser supplied email', async () => {
  const calls: { path: string; options?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    calls.push({ path: String(input), ...(options ? { options } : {}) });
    return Response.json(
      String(input) === '/auth/me'
        ? {
            authKind: 'google',
            user: { email: 'verified@example.test', isAdmin: false },
            csrfToken: 'trusted-session-csrf-token',
          }
        : { ok: true },
    );
  };
  const api = createLaunchApi(fetcher);
  await api('/api/launch-market/wallet/challenge', { owner: OWNER });
  assert.equal(calls[0]!.path, '/api/launch-market/wallet/test-session');
  assert.equal(calls[1]!.path, '/auth/me');
  assert.equal(calls[0]!.options!.credentials, 'same-origin');
  assert.equal(calls[0]!.options!.cache, 'no-store');
  assert.equal(
    (calls[2]!.options!.headers as Record<string, string>)['x-csrf-token'],
    'trusted-session-csrf-token',
  );
  assert.equal(calls[2]!.options!.body, JSON.stringify({ owner: OWNER }));
  assert.equal(calls[2]!.options!.credentials, 'same-origin');
  await api('/api/launch-market/wallet/challenge', { owner: OWNER });
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/launch-market/wallet/test-session',
      '/auth/me',
      '/api/launch-market/wallet/challenge',
      '/api/launch-market/wallet/challenge',
    ],
  );
});

test('without an active test session, mutations require Google identity and bounded server CSRF', async () => {
  for (const session of [
    null,
    { authKind: 'website', csrfToken: 'trusted-session-csrf-token' },
    { csrfToken: 'trusted-session-csrf-token' },
    { authKind: 'google', csrfToken: 'short' },
    { authKind: 'google', csrfToken: 'x'.repeat(257) },
    { authKind: 'google', csrfToken: 123 },
  ]) {
    const calls: string[] = [];
    const api = createLaunchApi(async (input) => {
      calls.push(String(input));
      return Response.json(session);
    });
    await assert.rejects(
      api('/api/launch-market/wallet/challenge', { owner: OWNER }),
      /VERIFIED_ACCOUNT_REQUIRED|ACCOUNT_SESSION_INVALID/,
    );
    assert.deepEqual(calls, ['/api/launch-market/wallet/test-session', '/auth/me']);
  }
});

test('fund mutations stop on unauthenticated sessions and renew CSRF after a server denial', async () => {
  for (const status of [401, 403]) {
    const calls: string[] = [];
    const api = createLaunchApi(async (input) => {
      calls.push(String(input));
      return Response.json({ code: 'login_required' }, { status });
    });
    await assert.rejects(api('/api/launch-market/quote', {}), /VERIFIED_ACCOUNT_REQUIRED/);
    assert.deepEqual(calls, ['/api/launch-market/wallet/test-session', '/auth/me']);
  }
  const calls: string[] = [];
  let sessions = 0;
  const api = createLaunchApi(async (input, options) => {
    const path = String(input);
    calls.push(path);
    if (path === '/api/launch-market/wallet/test-session')
      return Response.json({ code: 'VERIFIED_EMAIL_REQUIRED' }, { status: 401 });
    if (path === '/auth/me') {
      sessions++;
      return Response.json({ authKind: 'google', csrfToken: `trusted-session-csrf-${sessions}` });
    }
    assert.equal(
      (options!.headers as Record<string, string>)['x-csrf-token'],
      `trusted-session-csrf-${sessions}`,
    );
    return sessions === 1
      ? Response.json({ error: { code: 'VERIFIED_EMAIL_REQUIRED' } }, { status: 403 })
      : Response.json({ ok: true });
  });
  await assert.rejects(api('/api/launch-market/quote', {}), /VERIFIED_EMAIL_REQUIRED/);
  await api('/api/launch-market/quote', {});
  assert.deepEqual(calls, [
    '/api/launch-market/wallet/test-session',
    '/auth/me',
    '/api/launch-market/quote',
    '/api/launch-market/wallet/test-session',
    '/auth/me',
    '/api/launch-market/quote',
  ]);
});

test('bounded nested production API error codes remain available for claim and ETH recovery messages', async () => {
  for (const code of ['CLAIM_RECOVERY_REQUIRED', 'ETH_PATH_UNAVAILABLE']) {
    const api = createLaunchApi(async () => Response.json({ error: { code } }, { status: 409 }));
    await assert.rejects(
      api('/api/launch-market/snapshot'),
      (error: unknown) => error instanceof Error && error.message === code,
    );
  }
  for (const code of ['x'.repeat(1000), '<script>alert(1)</script>']) {
    const api = createLaunchApi(async () => Response.json({ error: { code } }, { status: 503 }));
    await assert.rejects(api('/api/launch-market/snapshot'), /MARKET_API_UNAVAILABLE/);
  }
});

test('an API read failure cannot release the outstanding wallet confirmation lock', async () => {
  const { client, provider } = await connected();
  const response = Promise.withResolvers<unknown>();
  provider.sendResponse = response.promise;
  await client.review(buy);
  const pending = client.confirm();
  await provider.sendStarted.promise;
  client.setError(new Error('Temporary read failure'));
  assert.equal(client.state.busy, true);
  await assert.rejects(client.confirm(), /QUOTE_REVIEW_REQUIRED/);
  response.resolve(HASH);
  await pending;
  assert.equal(provider.calls.filter((call) => call.method === 'eth_sendTransaction').length, 1);
});

test('reload recovers the durable outstanding operation without sending another transaction', async () => {
  const f = fixture();
  f.state.operations = [f.state.operation];
  const reloaded = new LaunchMarketClient({ api: f.api, provider: f.provider, now: () => NOW });
  await reloaded.initialize();
  await reloaded.connect();
  assert.equal(reloaded.state.transaction.hash, HASH);
  assert.equal(reloaded.state.transaction.id, 'operation_a');
  assert.equal(reloaded.state.transaction.state, 'SUBMITTED');
  await assert.rejects(reloaded.review(buy), /MARKET_ACTION_UNAVAILABLE/);
  assert.equal(
    f.provider.calls.some((call) => call.method === 'eth_sendTransaction'),
    false,
  );
});

test('anonymous account reads stay unknown without errors or privileged operation requests', async () => {
  const f = fixture();
  f.state.account = null;
  f.state.wallet = { ...f.state.wallet, accountId: null };
  const client = new LaunchMarketClient({ api: f.api, provider: f.provider, now: () => NOW });
  await client.initialize();
  await client.connect();
  assert.equal(client.state.account, null);
  assert.equal(client.state.wallet!.accountId, null);
  assert.equal(client.state.owner, OWNER);
  assert.equal(client.state.wallet!.ethBalanceRaw, f.state.wallet.ethBalanceRaw);
  assert.equal(client.state.wallet!.usdcBalanceRaw, f.state.wallet.usdcBalanceRaw);
  assert.equal(client.state.error, null);
  assert.equal(
    f.state.requests.some((r) => r.path.includes('/operations?')),
    false,
  );
  await assert.rejects(
    client.review({ ...buy, operation: 'CLAIM', amountRaw: '0' }),
    /MARKET_ACTION_UNAVAILABLE/,
  );
  await assert.rejects(client.review(buy), /MARKET_ACTION_UNAVAILABLE/);
  await assert.rejects(
    client.review({ ...buy, operation: 'CREATE_VAULT', amountRaw: '0' }),
    /MARKET_ACTION_UNAVAILABLE/,
  );
  assert.equal(
    f.state.requests.some((r) => r.path.endsWith('/quote')),
    false,
  );
  assert.equal(
    f.provider.calls.some((c) => c.method === 'personal_sign' || c.method === 'eth_sendTransaction'),
    false,
  );
});

test('account claim status refreshes in the same block and blocks completed or pending claim review', async () => {
  const f = await connected();
  for (const claimStatus of [
    'COMPLETED',
    'SUBMITTED',
    'INCLUDED',
    'REORGED',
    'REVERTED',
    'EXPIRED',
  ] as const) {
    f.state.account = { ...account(), claimStatus };
    await f.client.refresh();
    assert.equal(f.client.state.account!.claimStatus, claimStatus);
    await assert.rejects(
      f.client.review({ ...buy, operation: 'CLAIM', amountRaw: '0' }),
      /MARKET_ACTION_UNAVAILABLE/,
    );
  }
  assert.equal(
    f.state.requests.some((r) => r.path.endsWith('/quote')),
    false,
  );
  assert.equal(
    f.provider.calls.some((c) => c.method === 'eth_sendTransaction'),
    false,
  );
});

test('late account status cannot repopulate a disconnected or switched wallet session', async () => {
  const f = fixture();
  const delayed = Promise.withResolvers<unknown>();
  const started = Promise.withResolvers<void>();
  let defer = false;
  const client = new LaunchMarketClient({
    api: async <T>(path: string, body?: unknown): Promise<T> => {
      if (defer && path.endsWith('/account')) {
        started.resolve();
        return (await delayed.promise) as T;
      }
      return f.api<T>(path, body);
    },
    provider: f.provider,
    now: () => NOW,
  });
  await client.initialize();
  await client.connect();
  defer = true;
  const pending = client.refresh();
  await started.promise;
  f.provider.owner = OTHER;
  f.provider.emit('accountsChanged', [OTHER]);
  assert.equal(client.state.account, null);
  delayed.resolve({ ...account(), claimStatus: 'COMPLETED' });
  await pending;
  assert.equal(client.state.account, null);
  assert.equal(client.state.owner, null);
  defer = false;
  f.state.account = { ...account(), id: 'other-account', wallet: OTHER };
  f.state.wallet = { ...f.state.wallet, owner: OTHER, accountId: 'other-account' };
  await client.connect();
  assert.equal(client.state.account!.id, 'other-account');
  assert.equal(client.state.account!.claimStatus, 'ELIGIBLE');
});

test('an account or session change clears old claim state and linkage without altering asset balances', async () => {
  const f = await connected();
  f.state.account = { ...account(), id: 'new-account', claimStatus: 'COMPLETED' };
  // Wallet read sees a different session from the earlier account response.
  f.state.wallet = { ...f.state.wallet, accountId: 'unexpected-account' };
  await f.client.refresh();
  assert.equal(f.client.state.account, null);
  assert.equal(f.client.state.wallet!.accountId, null);
  const balance = f.client.state.wallet!.usdcBalanceRaw;
  f.client.setError(new MarketApiError('VERIFIED_EMAIL_REQUIRED', 401));
  assert.equal(f.client.state.account, null);
  assert.equal(f.client.state.wallet!.usdcBalanceRaw, balance);
});

test('an unavailable ETH sell quote explains smaller amounts and AF-USDC without sending a transaction', async () => {
  const f = fixture();
  const client = new LaunchMarketClient({
    api: async <T>(path: string, body?: unknown): Promise<T> => {
      if (path.endsWith('/quote')) throw new MarketApiError('MARKET_OPERATION_UNAVAILABLE', 503);
      return f.api<T>(path, body);
    },
    provider: f.provider,
    now: () => NOW,
  });
  await client.initialize();
  await client.connect();
  let caught: unknown;
  try {
    await client.review({ ...buy, operation: 'SELL', asset: 'ETH' });
  } catch (error) {
    caught = error;
  }
  assert.match(String(caught), /ETH_SELL_QUOTE_UNAVAILABLE/);
  client.setError(caught);
  assert.match(client.state.error!, /smaller PASS amount or choose AF-USDC/);
  assert.match(client.state.error!, /per-transaction and daily limits/);
  assert.equal(
    f.provider.calls.some((c) => c.method === 'eth_sendTransaction'),
    false,
  );
});

test('same-account unlink or mismatched linkage clears an already reviewed quote before confirmation', async () => {
  for (const accountId of [null, 'unexpected-account']) {
    const f = await connected();
    await f.client.review(buy);
    assert.ok(f.client.state.quote);
    f.state.wallet = { ...f.state.wallet, accountId };
    await f.client.refresh();
    assert.equal(f.client.state.quote, null);
    assert.equal(f.client.state.quoteRequest, null);
    assert.equal(f.client.state.wallet!.accountId, null);
    await assert.rejects(f.client.confirm(), /QUOTE_REVIEW_REQUIRED/);
    assert.equal(
      f.provider.calls.some((c) => c.method === 'eth_sendTransaction'),
      false,
    );
  }
});

test('a delayed quote cannot restore a review after the account changes without a wallet change', async () => {
  const f = fixture();
  const delayed = Promise.withResolvers<unknown>();
  const started = Promise.withResolvers<void>();
  const client = new LaunchMarketClient({
    api: async <T>(path: string, body?: unknown): Promise<T> => {
      if (path.endsWith('/quote')) {
        started.resolve();
        return (await delayed.promise) as T;
      }
      return f.api<T>(path, body);
    },
    provider: f.provider,
    now: () => NOW,
  });
  await client.initialize();
  await client.connect();
  const reviewing = client.review(buy);
  const rejected = assert.rejects(reviewing, /ACCOUNT_LINKAGE_CHANGED/);
  await started.promise;
  f.state.account = { ...account(), id: 'next-account' };
  f.state.wallet = { ...f.state.wallet, accountId: 'next-account' };
  await client.refresh();
  delayed.resolve(quote({ ...buy, owner: OWNER }));
  await rejected;
  assert.equal(client.state.account!.id, 'next-account');
  assert.equal(client.state.quote, null);
  assert.equal(client.state.quoteRequest, null);
  assert.equal(
    f.provider.calls.some((c) => c.method === 'eth_sendTransaction'),
    false,
  );
});

test('an included or completed claim clears an active claim review in the same account and block', async () => {
  const request = { ...buy, operation: 'CLAIM' as const, amountRaw: '0' };
  for (const claimStatus of ['INCLUDED', 'COMPLETED'] as const) {
    const f = await connected();
    const base = quote({ ...request, owner: OWNER });
    f.state.quote = {
      ...base,
      estimatedOutRaw: '1000000000',
      minOutRaw: '1000000000',
      transaction: {
        to: f.state.config.manifest!.claim,
        data: marketInterfaces.claim.encodeFunctionData('claim', [
          { accountId: HASH, wallet: OWNER, nonce: '1', issuedAt: NOW, deadline: NOW + 60, epoch: '1' },
          '0x',
        ]),
        value: '0',
      },
    };
    await f.client.review(request);
    assert.ok(f.client.state.quote);
    f.state.account = { ...account(), claimStatus };
    await f.client.refresh();
    assert.equal(f.client.state.quote, null);
    assert.equal(f.client.state.quoteRequest, null);
    await assert.rejects(f.client.confirm(), /QUOTE_REVIEW_REQUIRED/);
    assert.equal(
      f.provider.calls.some((c) => c.method === 'eth_sendTransaction'),
      false,
    );
  }
});

test('session expiration during the final contract simulation prevents the actual wallet send', async () => {
  const f = await connected();
  const started = Promise.withResolvers<void>();
  const simulation = Promise.withResolvers<unknown>();
  const original = f.provider.request.bind(f.provider);
  f.provider.request = async (input) => {
    if (input.method === 'eth_call') {
      started.resolve();
      return simulation.promise;
    }
    return original(input);
  };
  await f.client.review(buy);
  const confirming = f.client.confirm();
  const rejected = assert.rejects(confirming, /ACCOUNT_LINKAGE_CHANGED/);
  await started.promise;
  f.client.setError(new MarketApiError('ACCOUNT_SESSION_INVALID', 401));
  simulation.resolve('0x');
  await rejected;
  assert.equal(f.client.state.quote, null);
  assert.equal(f.client.state.transaction.state, 'REJECTED');
  assert.equal(
    f.provider.calls.some((c) => c.method === 'eth_sendTransaction'),
    false,
  );
});

test('test login POSTs use only exact signed-nonce paths; asset mutations require actual test CSRF first', async () => {
  const calls: { path: string; options?: RequestInit }[] = [];
  const api = createLaunchApi(async (input, options) => {
    const path = String(input);
    calls.push({ path, ...(options ? { options } : {}) });
    return Response.json(
      path === '/api/launch-market/wallet/test-session' && options?.method !== 'POST'
        ? {
            identityKind: 'WALLET_TEST',
            emailVerificationRequired: false,
            csrfToken: 'actual-wallet-test-csrf-token',
          }
        : { ok: true },
    );
  });
  await api('/api/launch-market/wallet/test-challenge', { owner: OWNER });
  await api('/api/launch-market/wallet/test-session', { nonce: 'one-use', signature: 'wallet-signature' });
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/api/launch-market/wallet/test-challenge', '/api/launch-market/wallet/test-session'],
  );
  for (const call of calls) {
    assert.equal(call.options?.method, 'POST');
    assert.equal((call.options?.headers as Record<string, string>)['x-csrf-token'], undefined);
  }
  await api('/api/launch-market/quote', {});
  assert.equal(calls[2]!.path, '/api/launch-market/wallet/test-session');
  assert.equal(calls[2]!.options?.method, undefined);
  assert.equal(calls[3]!.path, '/api/launch-market/quote');
  assert.equal(
    (calls[3]!.options?.headers as Record<string, string>)['x-csrf-token'],
    'actual-wallet-test-csrf-token',
  );
  assert.equal(
    calls.some((c) => c.path === '/auth/me'),
    false,
    'An old Google cookie must not override a valid current test identity.',
  );
  await api('/api/launch-market/wallet/test-session?bypass=1', {});
  assert.equal(
    (calls.at(-1)!.options?.headers as Record<string, string>)['x-csrf-token'],
    'actual-wallet-test-csrf-token',
  );
});

test('invalid or verification-required test session cannot authorize a mutation without real Google identity', async () => {
  for (const session of [
    {
      identityKind: 'WALLET_TEST',
      emailVerificationRequired: true,
      csrfToken: 'actual-wallet-test-csrf-token',
    },
    { identityKind: 'WALLET_TEST', emailVerificationRequired: false, csrfToken: 'short' },
    { identityKind: 'GOOGLE', emailVerificationRequired: false, csrfToken: 'actual-wallet-test-csrf-token' },
    { emailVerificationRequired: false, csrfToken: 'actual-wallet-test-csrf-token' },
  ]) {
    const writes: string[] = [];
    const api = createLaunchApi(async (input, options) => {
      if (options?.method === 'POST') writes.push(String(input));
      return Response.json(
        String(input).endsWith('/wallet/test-session') ? session : { authKind: 'website' },
      );
    });
    await assert.rejects(
      api('/api/launch-market/quote', {}),
      /VERIFIED_ACCOUNT_REQUIRED|ACCOUNT_SESSION_INVALID/,
    );
    assert.deepEqual(writes, []);
  }
});

function testMessage(owner: string, nonce: string, origin = 'https://www.ikol.top'): string {
  return `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${getAddress(owner)}\n\nSign in to AlphaForge wallet-only mode. This proves control of this wallet; it does not verify an email, move assets or approve a transaction. Free credits are limited to one claim for this wallet and 100 claims in total.\n\nURI: ${origin}\nVersion: 1\nChain ID: 46630\nNonce: ${nonce}\nIssued At: ${new Date(NOW * 1000).toISOString()}\nExpiration Time: ${new Date((NOW + 300) * 1000).toISOString()}`;
}

test('wallet test session normalizes a lowercase provider address to the checksummed Store message and verifies an actual ownership signature', async (context) => {
  const f = fixture();
  const signer = Wallet.createRandom(); // Ephemeral cryptographic unit fixture; never a deployed user wallet.
  f.provider.owner = signer.address.toLowerCase();
  f.state.account = null;
  f.state.wallet = { ...f.state.wallet, owner: signer.address, accountId: null };
  f.state.config = { ...f.state.config, emailVerificationRequired: false };
  const store = new LaunchMarketStore(':memory:', 'https://www.ikol.top');
  context.after(() => store.close());
  const { nonce, message, expiresAt } = store.walletTestChallenge(signer.address, NOW);
  const original = f.provider.request.bind(f.provider);
  f.provider.request = async (input) => {
    if (input.method === 'personal_sign') {
      f.provider.calls.push(input);
      assert.equal(toUtf8String(getBytes(input.params![0] as string)), message);
      assert.equal(message.split('\n')[1], signer.address);
      assert.equal(input.params![1], message.split('\n')[1]);
      return signer.signMessage(message);
    }
    return original(input);
  };
  const paths: string[] = [];
  const client = new LaunchMarketClient({
    api: async <T>(path: string, body?: unknown): Promise<T> => {
      paths.push(path);
      if (path.endsWith('/wallet/test-challenge')) return { nonce, message, expiresAt } as T;
      if (path.endsWith('/wallet/test-session')) {
        const credentials = body as { nonce: string; signature: string };
        assert.equal(credentials.nonce, nonce);
        const opened = store.openWalletTestSession(credentials.nonce, credentials.signature, NOW);
        assert.equal(opened.account.email, null);
        assert.equal(opened.account.identityKind, 'WALLET_TEST');
        assert.equal(
          store.walletTestSession(opened.token, opened.csrfToken, NOW, true)?.account.id,
          opened.account.id,
        );
        assert.throws(
          () => store.openWalletTestSession(credentials.nonce, credentials.signature, NOW),
          /WALLET_CHALLENGE_EXPIRED/,
        );
        f.state.account = {
          id: opened.account.id,
          accountKey: opened.account.accountKey,
          wallet: opened.account.wallet,
          emailVerified: false,
          identityKind: 'WALLET_TEST',
          claimStatus: 'ELIGIBLE',
        };
        f.state.wallet = { ...f.state.wallet, accountId: opened.account.id };
        return f.state.account as T;
      }
      return f.api<T>(path, body);
    },
    provider: f.provider,
    now: () => NOW,
    origin: 'https://www.ikol.top',
  });
  await client.initialize();
  await client.connect();
  assert.equal(client.state.account, null);
  await client.bindWallet();
  assert.equal(client.state.account!.emailVerified, false);
  assert.equal(client.state.account!.identityKind, 'WALLET_TEST');
  assert.equal(client.state.wallet!.accountId, f.state.account!.id);
  assert.match(client.state.notice!, /signed in with your wallet/);
  assert.equal(
    paths.some((p) => p.endsWith('/wallet/challenge') || p.endsWith('/wallet/bind')),
    false,
  );
  assert.equal(f.provider.calls.filter((c) => c.method === 'personal_sign').length, 1);
  assert.equal(
    f.provider.calls.some((c) => c.method === 'eth_sendTransaction'),
    false,
  );
});

test('test challenge with a different origin, chain or wallet is rejected before signing', async () => {
  const nonce = 'cd'.repeat(24);
  for (const message of [
    testMessage(OWNER, nonce, 'https://untrusted.example'),
    testMessage(OWNER, nonce).replace('Chain ID: 46630', 'Chain ID: 1'),
    testMessage(OTHER, nonce),
  ]) {
    const f = fixture();
    f.state.account = null;
    f.state.wallet = { ...f.state.wallet, accountId: null };
    f.state.config = { ...f.state.config, emailVerificationRequired: false };
    const client = new LaunchMarketClient({
      api: async <T>(path: string, body?: unknown): Promise<T> =>
        path.endsWith('/wallet/test-challenge')
          ? ({ nonce, message, expiresAt: NOW + 300 } as T)
          : f.api<T>(path, body),
      provider: f.provider,
      now: () => NOW,
      origin: 'https://www.ikol.top',
    });
    await client.initialize();
    await client.connect();
    await assert.rejects(client.bindWallet(), /WALLET_CHALLENGE_INVALID/);
    assert.equal(
      f.provider.calls.some((c) => c.method === 'personal_sign' || c.method === 'eth_sendTransaction'),
      false,
    );
  }
});

test('unverified wallet-test identity requires the server config to explicitly disable email verification', async () => {
  for (const required of [undefined, true, false]) {
    const f = fixture();
    f.state.config = {
      ...f.state.config,
      ...(required === undefined ? {} : { emailVerificationRequired: required }),
    };
    f.state.account = { ...account(), emailVerified: false, identityKind: 'WALLET_TEST' };
    const client = new LaunchMarketClient({ api: f.api, provider: f.provider, now: () => NOW });
    await client.initialize();
    if (required === false) {
      await client.connect();
      assert.equal(client.state.account!.emailVerified, false);
    } else {
      await assert.rejects(client.connect(), /INVALID_ACCOUNT_STATE/);
      assert.equal(client.state.owner, null);
      assert.equal(client.state.wallet, null);
    }
    assert.equal(
      f.provider.calls.some((c) => c.method === 'eth_sendTransaction'),
      false,
    );
  }
});

test('verification mode changes invalidate unsent quotes before wallet confirmation and preserve submitted hashes', async () => {
  for (const submitted of [false, true]) {
    const f = await connected();
    f.state.config = { ...f.state.config, emailVerificationRequired: false };
    await f.client.refresh();
    await f.client.review(buy);
    if (submitted) await f.client.confirm();
    f.state.config = { ...f.state.config, emailVerificationRequired: true };
    if (!submitted) {
      await assert.rejects(f.client.confirm(), /QUOTE_REVIEW_REQUIRED/);
      assert.equal(
        f.provider.calls.some((c) => c.method === 'eth_sendTransaction'),
        false,
      );
    } else {
      await f.client.refresh();
      assert.equal(f.client.state.transaction.hash, HASH);
      assert.equal(f.client.state.transaction.state, 'SUBMITTED');
      assert.equal(f.provider.calls.filter((c) => c.method === 'eth_sendTransaction').length, 1);
    }
    assert.equal(f.client.state.quote, null);
  }
});

test('an expired real market test session clears unsent quotes and linkage while preserving actual submitted evidence', async () => {
  for (const submitted of [false, true]) {
    const f = await connected();
    f.state.config = { ...f.state.config, emailVerificationRequired: false };
    f.state.account = { ...account(), emailVerified: false, identityKind: 'WALLET_TEST' };
    await f.client.refresh();
    await f.client.review(buy);
    if (submitted) await f.client.confirm();
    f.client.setError(new MarketApiError('MARKET_SESSION_REQUIRED', 401));
    assert.equal(f.client.state.account, null);
    assert.equal(f.client.state.wallet!.accountId, null);
    assert.equal(f.client.state.quote, null);
    assert.match(f.client.state.error!, /wallet session|Sign in with your wallet/);
    if (submitted) {
      assert.equal(f.client.state.transaction.hash, HASH);
      assert.equal(f.client.state.transaction.state, 'SUBMITTED');
    } else {
      await assert.rejects(f.client.confirm(), /QUOTE_REVIEW_REQUIRED/);
      assert.equal(
        f.provider.calls.some((c) => c.method === 'eth_sendTransaction'),
        false,
      );
    }
  }
});
