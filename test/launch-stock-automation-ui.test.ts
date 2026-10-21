import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Wallet, getBytes, toUtf8String } from 'ethers';
import { stockConsentMessage } from '../apps/server/src/launch-market-adapters/stock-worker-policy.ts';
import type { CommunityApi } from '../apps/web/src/community/client.ts';
import type { Eip1193Provider, Eip1193Request } from '../apps/web/src/chain-wallet.ts';
import type { LaunchClientState } from '../apps/web/src/launch-market/model.ts';
import type { StockExecutionSnapshot } from '../apps/web/src/launch-market/stock-execution.ts';
import {
  AutomationController,
  automationConsent,
  automationDraft,
  automationUnavailable,
  renderAutomation,
  renderAutomationReview,
  type AutomationRegistry,
  type AutomationStatus,
} from '../apps/web/src/launch-market/automation.ts';
import { config, snapshot as market, account, wallet } from './helpers/launch-market-ui-fixture.ts';

// Public, disposable fixture key. No network or chain transaction is used.
const signer = new Wallet('0x' + '11'.repeat(32));
const vault = '0x3333333333333333333333333333333333333333';
const executor = '0x2222222222222222222222222222222222222222';
const digest = '0x' + 'aa'.repeat(32);
const now = () => Math.floor(Date.now() / 1000);
function setup() {
  const stock: StockExecutionSnapshot = {
    strategyId: 'AMZN',
    owner: signer.address,
    vault,
    version: '3',
    closed: false,
    blockNumber: '100',
    blockHash: digest,
    blockTimestamp: now(),
    totalBuyUsdc: '0',
    grant: {
      executor,
      expiresAt: String(now() + 7200),
      maxOrderUsdc: '10000000',
      maxTotalBuyUsdc: '50000000',
      maxSlippageBps: 100,
    },
    targetStock: '0x4444444444444444444444444444444444444444',
    stockReserve: vault,
    referenceFeed: executor,
    maxPriceAge: 60,
    trackedCashRaw: '50000000',
    trackedStockRaw: '0',
    vaultUsdcRaw: '50000000',
    vaultStockRaw: '0',
    reserveUsdcRaw: '10000000000',
    reserveStockRaw: '1000000000000000000000',
    stockPriceUsdcRaw: '100000000',
    referenceObservedAt: now(),
    referenceDigest: digest,
    regularOpen: now() - 3600,
    regularClose: now() + 3600,
    calendarObservedAt: now(),
    calendarDigest: digest,
    executionAllowed: true,
    venuePaused: false,
    status: 'READY',
    executionCutoff: now() + 60,
  };
  const launch = {
    state: {
      enabled: true,
      config: config(),
      snapshot: market(),
      owner: signer.address,
      account: { ...account(), wallet: signer.address },
      wallet: {
        ...wallet(),
        owner: signer.address,
        vaults: [
          {
            strategyId: 'AMZN',
            address: vault,
            principalBasisRaw: '50000000',
            equityRaw: '50000000',
            cashRaw: '50000000',
            lockedPassRaw: '50000000000000000000',
            realizedPnlRaw: '0',
            unrealizedPnlRaw: '0',
            valuationState: 'FRESH',
            withdrawableProfitRaw: '0',
            withdrawablePrincipalRaw: '50000000',
            status: 'OPEN',
            holdings: [],
          },
        ],
      },
      busy: false,
      connecting: false,
      quote: null,
      quoteRequest: null,
      transaction: { id: null, hash: null, state: 'IDLE', confirmations: 0, approval: false, owner: null },
      error: null,
      notice: null,
      stockSnapshots: { AMZN: stock },
    } as LaunchClientState,
    async refreshStock() {},
  };
  let status: AutomationStatus = {
    schemaVersion: 1,
    available: true,
    reason: 'READY',
    executor,
    manifestDigest: digest,
    observedAt: now(),
    readiness: [
      { strategyId: 'AMZN', status: 'READY' },
      { strategyId: 'TSLA', status: 'UNINITIALIZED' },
    ],
  };
  let registry: AutomationRegistry = { revision: 2, sessions: [] };
  let owner = signer.address;
  let chain = '0xb626';
  let afterSign = () => {};
  let failWrite = false;
  const calls: Eip1193Request[] = [];
  const writes: { path: string; body: unknown }[] = [];
  const provider = {
    async request(input: Eip1193Request) {
      calls.push(input);
      if (input.method === 'eth_accounts') return [owner];
      if (input.method === 'eth_chainId') return chain;
      if (input.method === 'personal_sign') {
        const signature = await signer.signMessage(getBytes(String(input.params![0])));
        afterSign();
        return signature;
      }
      throw new Error('Live transactions refused');
    },
    on() {},
    removeListener() {},
  } as Eip1193Provider;
  const api: CommunityApi = async <T>(path: string, method?: string, body?: unknown) => {
    if (!method || method === 'GET') return (path.endsWith('/status') ? status : registry) as T;
    writes.push({ path, body });
    if (failWrite) throw new Error('STOCK_AUTOMATION_UNAVAILABLE');
    if (path.endsWith('/start')) {
      const data = body as { signed: (typeof registry.sessions)[number]['signed']; expectedRevision: number };
      assert.equal(data.expectedRevision, registry.revision);
      registry = {
        revision: registry.revision + 1,
        sessions: [{ digest, signed: data.signed, active: true, createdAt: now(), updatedAt: now() }],
      };
    } else if (path.endsWith('/pause')) {
      const data = body as { digest: string; expectedRevision: number };
      assert.equal(data.expectedRevision, registry.revision);
      registry = {
        revision: registry.revision + 1,
        sessions: registry.sessions.map((entry) => ({ ...entry, active: false })),
      };
    }
    return registry as T;
  };
  const controller = new AutomationController(launch, provider, api);
  const draft = {
    ...automationDraft(),
    maxPosition: '50',
    validUntil: new Date((now() + 3600) * 1000).toISOString(),
  };
  return {
    controller,
    launch,
    stock,
    draft,
    calls,
    writes,
    status: () => status,
    registry: () => registry,
    setStatus(value: Partial<AutomationStatus>) {
      status = { ...status, ...value };
    },
    setOwner(value: string) {
      owner = value;
    },
    setChain(value: string) {
      chain = value;
    },
    afterSign(value: () => void) {
      afterSign = value;
    },
    failWrite() {
      failWrite = true;
    },
  };
}

test('unconfigured automation exposes missing dependencies and disables Start without wallet signing', async () => {
  const f = setup();
  f.setStatus({ available: false, reason: 'NOT_CONFIGURED', executor: null, manifestDigest: null });
  await f.controller.refresh();
  const html = renderAutomation(f.launch.state, f.controller.state, 'AMZN');
  assert.match(html, /verified stock market data and the execution service/);
  assert.match(html, /disabled>Review Start/);
  await assert.rejects(f.controller.review('AMZN', f.draft), /unavailable until/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});

test('readiness is specific to the selected stock and exact executor with fresh evidence', async () => {
  const f = setup();
  await f.controller.refresh();
  assert.equal(automationUnavailable(f.launch.state, f.controller.state, 'AMZN'), null);
  assert.match(automationUnavailable(f.launch.state, f.controller.state, 'TSLA')!, /TSLA stock route/);
  f.setStatus({ executor: vault });
  await f.controller.refresh();
  assert.match(
    automationUnavailable(f.launch.state, f.controller.state, 'AMZN')!,
    /exact automation executor/,
  );
  f.setStatus({ executor, observedAt: now() - 21 });
  await f.controller.refresh();
  assert.match(automationUnavailable(f.launch.state, f.controller.state, 'AMZN')!, /status has expired/);
  f.setStatus({ observedAt: now(), manifestDigest: null });
  await f.controller.refresh();
  assert.match(
    automationUnavailable(f.launch.state, f.controller.state, 'AMZN')!,
    /deployment identity is missing/,
  );
});

test('explicit reviewed Start uses the canonical owner authorization and waits for registry acknowledgement', async () => {
  const f = setup();
  await f.controller.review('AMZN', f.draft);
  assert.equal(f.calls.length, 0);
  const review = f.controller.state.review!;
  const html = renderAutomationReview(f.controller.state);
  for (const value of ['50 AF-USDC', '10 AF-USDC', '1%', signer.address, executor, digest])
    assert.ok(html.includes(value));
  await f.controller.confirm();
  const prompt = f.calls.find((call) => call.method === 'personal_sign')!;
  assert.equal(toUtf8String(getBytes(String(prompt.params![0]))), stockConsentMessage(review.consent));
  assert.equal(prompt.params![1], signer.address);
  assert.equal(f.writes.length, 1);
  assert.equal(f.controller.state.registry!.sessions[0]!.active, true);
  assert.match(f.controller.state.notice!, /authorization was saved/);
  assert.equal(
    f.calls.some((call) => call.method === 'eth_sendTransaction'),
    false,
  );
});

test('wallet, chain, grant, version and registry changes before confirmation prevent signing', async () => {
  for (const change of ['wallet', 'chain', 'grant', 'version', 'registry', 'executor'] as const) {
    const f = setup();
    await f.controller.review('AMZN', f.draft);
    if (change === 'wallet') f.setOwner(vault);
    if (change === 'chain') f.setChain('0x1');
    if (change === 'grant') Object.assign(f.stock.grant, { maxOrderUsdc: '9000000' });
    if (change === 'version') Object.assign(f.stock, { version: '4' });
    if (change === 'registry') f.registry().revision++;
    if (change === 'executor') f.setStatus({ executor: vault });
    await f.controller.confirm();
    assert.ok(f.controller.state.error, change);
    assert.equal(
      f.calls.some((call) => call.method === 'personal_sign'),
      false,
      change,
    );
    assert.equal(f.writes.length, 0, change);
  }
});

test('changed Vault permission while owner signs prevents starting the worker', async () => {
  const f = setup();
  await f.controller.review('AMZN', f.draft);
  f.afterSign(() => {
    Object.assign(f.stock, { version: '4' });
  });
  await f.controller.confirm();
  assert.equal(f.calls.filter((call) => call.method === 'personal_sign').length, 1);
  assert.equal(f.writes.length, 0);
  assert.match(f.controller.state.error!, /changed or expired/);
  assert.equal(f.controller.state.notice, null);
});

test('failed Start keeps the policy and never reports an active authorization', async () => {
  const f = setup();
  await f.controller.review('AMZN', f.draft);
  f.failWrite();
  await f.controller.confirm();
  assert.match(f.controller.state.error!, /unavailable/);
  assert.equal(f.controller.state.notice, null);
  assert.equal(f.controller.state.registry!.sessions.length, 0);
  assert.equal(f.controller.state.drafts.AMZN!.maxPosition, '50');
});

test('Pause uses the current owned revision even while worker and stock route are unavailable on another chain', async () => {
  const f = setup();
  await f.controller.review('AMZN', f.draft);
  await f.controller.confirm();
  f.setStatus({ available: false, reason: 'WORKER_INACTIVE' });
  f.setChain('0x1');
  const prior = f.registry().revision;
  await f.controller.pause(digest);
  assert.deepEqual(f.writes.at(-1), {
    path: '/api/launch-market/automation/pause',
    body: { digest, expectedRevision: prior },
  });
  assert.equal(f.controller.state.registry!.sessions[0]!.active, false);
  assert.match(f.controller.state.notice!, /Automation paused/);
  assert.equal(f.calls.filter((call) => call.method === 'personal_sign').length, 1);
});

test('wallet changes discard pending private reads and reviewed consent', async () => {
  const f = setup();
  let resolveRegistry!: (value: AutomationRegistry) => void;
  const api: CommunityApi = <T>(path: string) =>
    path.endsWith('/status')
      ? Promise.resolve(f.status() as T)
      : new Promise<T>((resolve) => {
          resolveRegistry = resolve as (value: AutomationRegistry) => void;
        });
  const controller = new AutomationController(f.launch, undefined, api);
  const reading = controller.refresh();
  await Promise.resolve();
  f.launch.state = { ...f.launch.state, owner: vault };
  controller.bind();
  resolveRegistry({ revision: 9, sessions: [] });
  await reading;
  assert.equal(controller.state.registry, null);
  assert.equal(controller.state.review, null);
});

test('structured policy validation rejects expired expiry, crossed thresholds and oversized installments', () => {
  const f = setup();
  for (const draft of [
    { ...f.draft, validUntil: new Date((now() - 60) * 1000).toISOString() },
    { ...f.draft, stopPrice: '150', takePrice: '100' },
    { ...f.draft, kind: 'DCA' as const, installment: '11' },
    { ...f.draft, kind: 'EMA_CROSS' as const, fast: '30', slow: '20' },
  ])
    assert.throws(() => automationConsent(f.status(), f.stock, draft, 'isolated-fixture-nonce'));
});
