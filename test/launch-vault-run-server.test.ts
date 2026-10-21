import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet } from 'ethers';
import { LaunchMarketStore } from '../packages/launch-market/src/store.ts';
import { CommunityStore } from '../packages/launch-market/src/community.ts';
import { VaultRunStore } from '../packages/launch-market/src/vault-run.ts';
import { LaunchMarketService } from '../packages/launch-market/src/service.ts';
import { LaunchMarketError, type StrategyId } from '../packages/launch-market/src/types.ts';
import { buildLaunchMarketServer } from '../apps/server/src/launch-market/server.ts';
import { VaultReferenceDemand } from '../apps/server/src/launch-market-adapters/vault-reference-demand.ts';
import { VaultValuations } from '../apps/server/src/launch-market-adapters/vault-valuation.ts';
import { StockConsentRegistry } from '../apps/server/src/launch-market-adapters/stock-consent-registry.ts';
import {
  stockConsentMessage,
  stockEvidenceHash,
} from '../apps/server/src/launch-market-adapters/stock-worker-policy.ts';
import { pauseVaultAutomation } from '../tools/launch-market/server.ts';
import { config, NOW, BLOCK } from './helpers/launch-market-ui-fixture.ts';
import { permission, VAULT } from './helpers/launch-market-executor-fixture.ts';

const origin = 'https://vault-integrated.example.test';
const identity = { email: 'legacy@example.test', subject: 'legacy-google', emailVerified: true as const };
const manifestDigest = stockEvidenceHash(config().manifest!);
async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'af-vault-composed-'));
  const market = new LaunchMarketStore(join(folder, 'market.sqlite'), origin);
  const community = new CommunityStore(join(folder, 'community.sqlite'), origin);
  const runs = new VaultRunStore(join(folder, 'vault-run.sqlite'), { origin, manifestDigest });
  const registry = new StockConsentRegistry(join(folder, 'stock-owner-consents.json'));
  let down = false,
    writable = true,
    valuationsRead = 0;
  const observe = async (owner: string, strategyId: StrategyId) => {
    if (down) throw new LaunchMarketError('CHAIN_UNAVAILABLE', 503);
    return {
      owner,
      strategyId,
      vault: VAULT,
      closed: false,
      cashRaw: '1000000',
      positionRaw: '1000000000000000000',
      lockedPassRaw: '1000000000000000000',
      executorActive: false,
      version: '0',
      ownerNonceRaw: '0',
      blockNumber: '100',
      blockHash: BLOCK,
      confirmations: 3,
    };
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
  const google = Wallet.createRandom(),
    selected = Wallet.createRandom(),
    outsider = Wallet.createRandom();
  const account = service.account(identity),
    binding = market.bindingChallenge(account.id, google.address, NOW);
  market.bindWallet(account.id, binding.nonce, await google.signMessage(binding.message), NOW);
  const walletHeaders = async (wallet: typeof selected) => {
    const challenge = market.walletTestChallenge(wallet.address, NOW);
    const session = market.openWalletTestSession(
      challenge.nonce,
      await wallet.signMessage(challenge.message),
      NOW,
    );
    return {
      cookie: '__Host-af_market_test=' + session.token + '; legacy-google=present',
      origin,
      'x-csrf-token': session.csrfToken,
    };
  };
  const selectedHeaders = await walletHeaders(selected),
    outsiderHeaders = await walletHeaders(outsider);
  const valuations = new VaultValuations({
    now: () => NOW,
    chain: {
      readValuation: async (owner, strategyId) => {
        valuationsRead++;
        return {
          observation: await observe(owner, strategyId),
          principalRaw: '300000000',
          priceRaw: '250000000',
          priceObservedAt: NOW,
        };
      },
    },
  });
  const server = await buildLaunchMarketServer({
    service,
    origin,
    community,
    vaultValuations: valuations,
    verificationRequired: () => false,
    trustedIdentity: (request) => (request.cookies['legacy-google'] === 'present' ? identity : null),
    canCommunityWrite: () => writable,
    vaultRun: {
      store: runs,
      demand: new VaultReferenceDemand({
        sourceConfigured: true,
        keeperConfigured: true,
        now: () => NOW,
        refresh: async (strategyId, now) => ({
          strategyId,
          status: 'READY',
          observedAt: now,
          expiresAt: now + 60,
          priceRaw: '250000000',
          source: 'Alpaca IEX',
          reason: 'READY',
        }),
      }),
      readObservation: (owner, strategyId) => observe(owner, strategyId),
      qualifyTransaction: async () => {},
      readReceipt: async () => ({ status: 'PENDING' }),
      pauseAutomation: (owner, strategyId) => pauseVaultAutomation(registry, owner, strategyId, NOW),
    },
  });
  const call = (
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    headers: Record<string, string> = selectedHeaders,
  ) =>
    server.app.inject({
      method,
      url,
      headers: { host: new URL(origin).host, ...headers },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  const addConsent = async (owner: typeof selected, strategyId: StrategyId, vault: string) => {
    const consent = {
      schemaVersion: 1 as const,
      chainId: 46630 as const,
      manifestDigest,
      owner: owner.address,
      vault,
      strategyId,
      initialVersion: '0',
      grant: permission(),
      policy: { kind: 'BUY_AND_HOLD' as const },
      validUntil: NOW + 3600,
      maxPositionUsdcRaw: '50000000',
      stopPriceUsdcRaw: '0',
      takePriceUsdcRaw: '0',
      nonce: 'server_consent_nonce_00001',
    };
    registry.start(
      owner.address,
      { consent, signature: await owner.signMessage(stockConsentMessage(consent)) },
      registry.owned(owner.address).revision,
      NOW,
    );
  };
  return {
    call,
    selected,
    outsider,
    selectedHeaders,
    outsiderHeaders,
    runs,
    registry,
    addConsent,
    down: () => {
      down = true;
      writable = false;
    },
    valuationsRead: () => valuationsRead,
    close: async () => {
      await server.stop();
      assert.equal(runs.db.isOpen, false);
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

test('composed server uses the selected wallet for workflow and loss valuation, with device CSRF and no Google fallback', async () => {
  const f = await fixture();
  try {
    const values = '/api/launch-market/vault-values/TSLA';
    assert.equal((await f.call('GET', values, undefined, {})).statusCode, 401);
    assert.equal((await f.call('GET', values + '?owner=' + f.outsider.address)).statusCode, 400);
    const result = await f.call('GET', values);
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().owner, f.selected.address.toLowerCase());
    assert.equal(result.json().equityRaw, '251000000');
    assert.equal(result.json().profitRaw, '-49000000');
    assert.equal(result.json().returnBps, '-1633');
    await f.call('GET', values);
    assert.equal(f.valuationsRead(), 1);
    const forced = await f.call('GET', values + '?fresh=1');
    assert.equal(forced.statusCode, 200);
    assert.equal(forced.json().owner, f.selected.address.toLowerCase());
    assert.equal(f.valuationsRead(), 2);
    assert.equal((await f.call('GET', values + '?fresh=0')).statusCode, 400);
    const body = { actionId: 'composed_deposit_action_00001', expectedRevision: 0, amountRaw: '1000000' };
    const noCsrf = await f.call('POST', '/api/launch-market/vault-run/TSLA/deposit', body, {
      cookie: f.selectedHeaders.cookie,
      origin,
    });
    assert.equal(noCsrf.statusCode, 401);
    assert.equal(f.runs.get(f.selected.address, 'TSLA').revision, 0);
    const deposited = await f.call('POST', '/api/launch-market/vault-run/TSLA/deposit', body);
    assert.equal(deposited.statusCode, 200);
    assert.equal(deposited.json().owner, f.selected.address.toLowerCase());
    assert.equal(
      (await f.call('GET', '/api/launch-market/vault-run/TSLA', undefined, f.outsiderHeaders)).json().state
        .action,
      null,
    );
    assert.equal(
      (
        await f.call(
          'POST',
          '/api/launch-market/vault-run/TSLA/stop',
          { expectedRevision: 0 },
          { ...f.selectedHeaders, 'x-csrf-token': f.outsiderHeaders['x-csrf-token'] },
        )
      ).statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});

test('shared Stop retires every old consent for this wallet and strategy while preserving other owners and strategies during downtime', async () => {
  const f = await fixture();
  try {
    await f.addConsent(f.selected, 'TSLA', VAULT);
    await f.addConsent(f.selected, 'TSLA', '0x' + '61'.repeat(20));
    await f.addConsent(f.selected, 'AMZN', '0x' + '62'.repeat(20));
    await f.addConsent(f.outsider, 'TSLA', '0x' + '63'.repeat(20));
    f.down();
    const stopped = await f.call('POST', '/api/launch-market/vault-run/TSLA/stop', { expectedRevision: 0 });
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopped.json().state.paused, true);
    assert.equal(stopped.json().automationPaused, true);
    assert.equal(stopped.json().revocationObserved, false);
    const selected = f.registry.owned(f.selected.address).sessions;
    assert.equal(selected.length, 3);
    assert.equal(
      selected.filter((entry) => entry.signed.consent.strategyId === 'TSLA').every((entry) => !entry.active),
      true,
    );
    assert.equal(selected.find((entry) => entry.signed.consent.strategyId === 'AMZN')!.active, true);
    assert.equal(f.registry.owned(f.outsider.address).sessions[0]!.active, true);
  } finally {
    await f.close();
  }
});
