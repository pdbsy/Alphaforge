import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { LaunchMarketStore } from '../packages/launch-market/src/store.ts';
import { CommunityStore } from '../packages/launch-market/src/community.ts';
import { LaunchMarketService } from '../packages/launch-market/src/service.ts';
import { LaunchMarketError } from '../packages/launch-market/src/types.ts';
import { buildLaunchMarketServer } from '../apps/server/src/launch-market/server.ts';
import { StockConsentRegistry } from '../apps/server/src/launch-market-adapters/stock-consent-registry.ts';
import { buildStockAutomationRuntime } from '../apps/server/src/launch-market-adapters/stock-automation-runtime.ts';
import {
  stockConsentMessage,
  stockEvidenceHash,
  verifyStockConsent,
  type SignedStockConsent,
} from '../apps/server/src/launch-market-adapters/stock-worker-policy.ts';
import type {
  StockAutomationOptions,
  StockOperatorStatus,
} from '../apps/server/src/launch-market/automation-routes.ts';
import { config, NOW, OWNER, BLOCK } from './helpers/launch-market-ui-fixture.ts';
import { executorFixture, permission, VAULT } from './helpers/launch-market-executor-fixture.ts';

const origin = 'https://automation.example.test';
const executor = Wallet.createRandom();
const manifest = config().manifest!;
const digest = stockEvidenceHash(manifest);
async function signed(owner: ReturnType<typeof Wallet.createRandom>): Promise<SignedStockConsent> {
  const consent = {
    schemaVersion: 1 as const,
    chainId: 46630 as const,
    manifestDigest: digest,
    owner: owner.address,
    vault: VAULT,
    strategyId: 'TSLA' as const,
    initialVersion: '0',
    grant: { ...permission(), executor: executor.address },
    policy: { kind: 'BUY_AND_HOLD' as const },
    validUntil: NOW + 3600,
    maxPositionUsdcRaw: '50000000',
    stopPriceUsdcRaw: '0',
    takePriceUsdcRaw: '0',
    nonce: 'web_owner_consent_0001',
  };
  return { consent, signature: await owner.signMessage(stockConsentMessage(consent)) };
}
async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'af-automation-http-'));
  const market = new LaunchMarketStore(join(folder, 'market.sqlite'), origin);
  const community = new CommunityStore(join(folder, 'community.sqlite'), origin);
  const registry = new StockConsentRegistry(join(folder, 'stock-owner-consents.json'));
  let writable = true,
    live = false,
    changed = false,
    pausedMarket = false;
  let operatorCalls = 0,
    stopDuringValidation = false;
  const operator = (): StockOperatorStatus => {
    operatorCalls++;
    return {
      available: live,
      reason: live ? 'READY' : 'NOT_CONFIGURED',
      executor: live ? executor.address : null,
      manifestDigest: digest,
    };
  };
  const automation: StockAutomationOptions = {
    registry,
    operator,
    readiness: async (strategyId) =>
      pausedMarket
        ? { strategyId, status: 'UNAVAILABLE' }
        : {
            strategyId,
            chainId: 46630,
            status: 'READY',
            referenceObservedAt: NOW,
            calendarObservedAt: NOW,
            regularOpen: NOW - 3600,
            regularClose: NOW + 3600,
            stockPriceUsdcRaw: '250000000',
            keeper: executor.address,
            blockNumber: '100',
            blockHash: BLOCK,
          },
    validateConsent: async () => {
      if (changed) throw new LaunchMarketError('STOCK_CONSENT_STATE_CHANGED', 409);
      if (stopDuringValidation) live = false;
    },
  };
  const service = new LaunchMarketService({
    manifest: null,
    chain: null,
    store: market,
    ethReference: null,
    quoteSigner: null,
    claimSigner: null,
    now: () => NOW,
  });
  const server = await buildLaunchMarketServer({
    service,
    origin,
    community,
    automation,
    trustedIdentity: () => null,
    verificationRequired: () => false,
    canCommunityWrite: () => writable,
  });
  const call = async (
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string> = {},
    payload?: unknown,
  ) =>
    server.app.inject({
      method,
      url,
      headers: { host: new URL(origin).host, ...headers },
      ...(payload === undefined
        ? {}
        : {
            payload: JSON.stringify(payload),
            headers: { host: new URL(origin).host, 'content-type': 'application/json', ...headers },
          }),
    });
  const session = async (wallet: ReturnType<typeof Wallet.createRandom>) => {
    const challenge = market.walletTestChallenge(wallet.address, NOW);
    const result = market.openWalletTestSession(
      challenge.nonce,
      await wallet.signMessage(challenge.message),
      NOW,
    );
    return { cookie: '__Host-af_market_test=' + result.token, origin, 'x-csrf-token': result.csrfToken };
  };
  return {
    call,
    session,
    registry,
    live: () => {
      live = true;
    },
    stop: () => {
      live = false;
    },
    full: () => {
      writable = false;
    },
    changed: () => {
      changed = true;
    },
    unchanged: () => {
      changed = false;
    },
    closed: () => {
      pausedMarket = true;
    },
    stopDuringValidation: () => {
      stopDuringValidation = true;
    },
    operatorCalls: () => operatorCalls,
    close: async () => {
      await server.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

test('automation HTTP keeps default execution disabled, proves owner/CSRF, and pauses atomically without worker availability', async () => {
  const f = await fixture();
  try {
    const owner = Wallet.createRandom(),
      outsider = Wallet.createRandom(),
      authorization = await signed(owner);
    const device = await f.session(owner),
      other = await f.session(outsider);
    const status = await f.call('GET', '/api/launch-market/automation/status');
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().available, false);
    assert.equal(status.json().reason, 'NOT_CONFIGURED');
    assert.equal(status.json().executor, null);
    assert.equal((await f.call('GET', '/api/launch-market/automation/sessions')).statusCode, 401);
    const body = { signed: authorization, expectedRevision: 0 };
    assert.equal(
      (
        await f.call(
          'POST',
          '/api/launch-market/automation/start',
          { ...device, origin: 'https://other.test' },
          body,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.call(
          'POST',
          '/api/launch-market/automation/start',
          { ...device, 'x-csrf-token': other['x-csrf-token'] },
          body,
        )
      ).statusCode,
      401,
    );
    assert.equal((await f.call('POST', '/api/launch-market/automation/start', other, body)).statusCode, 403);
    assert.equal(
      (await f.call('POST', '/api/launch-market/automation/start', device, body)).json().error.code,
      'STOCK_AUTOMATION_UNAVAILABLE',
    );
    assert.deepEqual(f.registry.owned(owner.address), { revision: 0, sessions: [] });
    f.live();
    f.changed();
    assert.equal((await f.call('POST', '/api/launch-market/automation/start', device, body)).statusCode, 409);
    f.unchanged();
    const bad = { ...authorization, consent: { ...authorization.consent, maxPositionUsdcRaw: '1' } };
    assert.equal(
      (await f.call('POST', '/api/launch-market/automation/start', device, { ...body, signed: bad }))
        .statusCode,
      400,
    );
    const started = await f.call('POST', '/api/launch-market/automation/start', device, body);
    assert.equal(started.statusCode, 200, started.body);
    assert.equal(started.json().revision, 1);
    assert.equal(started.json().sessions[0].active, true);
    assert.deepEqual(
      (await f.call('GET', '/api/launch-market/automation/sessions', other)).json().sessions,
      [],
    );
    const publicStatus = (await f.call('GET', '/api/launch-market/automation/status')).body;
    assert.ok(!publicStatus.includes(owner.address));
    assert.ok(!publicStatus.includes(authorization.signature));
    const pause = { digest: verifyStockConsent(authorization), expectedRevision: 1 };
    assert.equal((await f.call('POST', '/api/launch-market/automation/pause', other, pause)).statusCode, 404);
    assert.equal(
      (await f.call('POST', '/api/launch-market/automation/pause', device, { ...pause, expectedRevision: 0 }))
        .statusCode,
      409,
    );
    f.stop();
    f.full();
    const paused = await f.call('POST', '/api/launch-market/automation/pause', device, pause);
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal(paused.json().sessions[0].active, false);
    assert.ok(f.operatorCalls() >= 4);
  } finally {
    await f.close();
  }
});

test('automation rechecks stopped operators before writing and refuses unavailable selected markets', async () => {
  const f = await fixture();
  try {
    const owner = Wallet.createRandom(),
      headers = await f.session(owner),
      authorization = await signed(owner);
    f.live();
    f.closed();
    assert.equal(
      (await f.call('GET', '/api/launch-market/automation/status')).json().reason,
      'MARKET_UNAVAILABLE',
    );
    assert.equal(
      (
        await f.call('POST', '/api/launch-market/automation/start', headers, {
          signed: authorization,
          expectedRevision: 0,
        })
      ).statusCode,
      503,
    );
    assert.deepEqual(f.registry.owned(owner.address).sessions, []);
  } finally {
    await f.close();
  }
  const g = await fixture();
  try {
    const owner = Wallet.createRandom(),
      headers = await g.session(owner),
      authorization = await signed(owner);
    g.live();
    g.stopDuringValidation();
    assert.equal(
      (
        await g.call('POST', '/api/launch-market/automation/start', headers, {
          signed: authorization,
          expectedRevision: 0,
        })
      ).statusCode,
      503,
    );
    assert.deepEqual(g.registry.owned(owner.address).sessions, []);
  } finally {
    await g.close();
  }
});

test('runtime qualifies a private fresh worker with the actual manifest, executor and atomic registry path', () => {
  const folder = mkdtempSync(join(tmpdir(), 'af-worker-status-'));
  const registry = new StockConsentRegistry(join(folder, 'owner-consents.json')),
    file = join(folder, 'status.json');
  const f = executorFixture(),
    manifest = f.state.config.manifest!;
  const input = {
    registry,
    manifest,
    provider: f.provider,
    statusFile: file,
    executorAddress: executor.address,
    now: () => NOW,
  };
  const state = {
    schemaVersion: 1,
    mode: 'ACTIVE',
    status: 'RUNNING',
    lastTickAt: NOW,
    manifestDigest: stockEvidenceHash(manifest),
    executorAddresses: [executor.address],
    sessionsFile: registry.path,
    strategies: [],
  };
  const update = (patch: Record<string, unknown> = {}) =>
    writeFileSync(file, JSON.stringify({ ...state, ...patch }), { mode: 0o600 });
  try {
    const runtime = buildStockAutomationRuntime(input);
    assert.equal(runtime.operator().available, false);
    update();
    assert.equal(runtime.operator().available, true);
    update({ lastTickAt: NOW - 21 });
    assert.equal(runtime.operator().reason, 'STATUS_STALE');
    update({ lastTickAt: NOW + 1 });
    assert.equal(runtime.operator().available, false);
    update({ sessionsFile: join(folder, 'other-registry.json') });
    assert.equal(runtime.operator().available, false);
    update({ manifestDigest: '0x' + 'ff'.repeat(32) });
    assert.equal(runtime.operator().available, false);
    update({ executorAddresses: [OWNER] });
    assert.equal(runtime.operator().available, false);
    update({ mode: 'PREPARE' });
    assert.equal(runtime.operator().available, false);
    update();
    chmodSync(file, 0o644);
    assert.equal(runtime.operator().available, false);
    chmodSync(file, 0o600);
    const link = join(folder, 'linked-status.json');
    symlinkSync(file, link);
    assert.equal(buildStockAutomationRuntime({ ...input, statusFile: link }).operator().available, false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('runtime rejects changed chain grants, execution versions, owner/factory identity and canonical blocks', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'af-worker-grant-'));
  const f = executorFixture(),
    manifest = f.state.config.manifest!;
  const grant = permission();
  f.current.grant = { ...grant };
  const runtime = buildStockAutomationRuntime({
    registry: new StockConsentRegistry(join(folder, 'owner-consents.json')),
    manifest,
    provider: f.provider,
    executorAddress: grant.executor,
    now: () => NOW,
  });
  const consent = {
    schemaVersion: 1 as const,
    chainId: 46630 as const,
    manifestDigest: stockEvidenceHash(manifest),
    owner: OWNER,
    vault: VAULT,
    strategyId: 'AMZN' as const,
    initialVersion: '0',
    grant,
    policy: { kind: 'BUY_AND_HOLD' as const },
    validUntil: NOW + 3600,
    maxPositionUsdcRaw: '50000000',
    stopPriceUsdcRaw: '0',
    takePriceUsdcRaw: '0',
    nonce: 'owner_boundary_0001',
  };
  const authorization = { consent, signature: '0x' };
  try {
    await runtime.validateConsent(authorization, NOW);
    f.current.version = 1;
    await assert.rejects(runtime.validateConsent(authorization, NOW), /STOCK_CONSENT_STATE_CHANGED/);
    f.current.version = 0;
    f.current.grant.maxOrderUsdc = '1';
    await assert.rejects(runtime.validateConsent(authorization, NOW), /STOCK_CONSENT_STATE_CHANGED/);
    f.current.grant = { ...grant };
    f.current.pinnedHash = '0x' + 'ff'.repeat(32);
    await assert.rejects(runtime.validateConsent(authorization, NOW), /CHAIN_REORGANIZED/);
    f.current.pinnedHash = BLOCK;
    await assert.rejects(
      runtime.validateConsent({ ...authorization, consent: { ...consent, vault: executor.address } }, NOW),
      /VAULT_IDENTITY_CHANGED/,
    );
    await assert.rejects(runtime.validateConsent(authorization, NOW + 31), /STOCK_CONSENT_STATE_CHANGED/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
