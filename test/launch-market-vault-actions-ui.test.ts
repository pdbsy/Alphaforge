import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAccount, renderVaults } from '../apps/web/src/launch-market/shell.ts';
import {
  renderVaultActionStatus,
  renderVaultPerformance,
  vaultReturnPercent,
} from '../apps/web/src/launch-market/vault-actions-ui.ts';
import type { LaunchClientState } from '../apps/web/src/launch-market/model.ts';
import { account, config, OWNER, snapshot, wallet } from './helpers/launch-market-ui-fixture.ts';

const address = '0x3333333333333333333333333333333333333333';
const current = (): LaunchClientState => ({
  enabled: true,
  config: config(),
  snapshot: snapshot(),
  owner: OWNER,
  account: account(),
  wallet: {
    ...wallet(),
    vaults: [
      {
        strategyId: 'AMZN',
        address,
        principalBasisRaw: '10000000',
        equityRaw: '9000000',
        cashRaw: '9000000',
        lockedPassRaw: '10000000000000000000',
        realizedPnlRaw: '-1000000',
        unrealizedPnlRaw: '0',
        valuationState: 'FRESH',
        withdrawableProfitRaw: '0',
        withdrawablePrincipalRaw: '9000000',
        status: 'OPEN',
        holdings: [],
      },
    ],
  },
  connecting: false,
  busy: false,
  quote: null,
  quoteRequest: null,
  error: null,
  notice: null,
  transaction: { state: 'IDLE', hash: null, id: null, confirmations: 0, approval: false, owner: null },
});

test('holdings and Vault detail expose the same three actions, with full exit independent of deposit amount', () => {
  for (const html of [
    renderAccount(current(), { [address]: '0.01' }, ['AMZN']),
    renderVaults(current(), { [address]: '0.01' }, 'AMZN'),
  ]) {
    const form = html.match(/<form data-launch-vault-order data-strategy="AMZN"[\s\S]*?<\/form>/)?.[0];
    assert.ok(form);
    assert.equal((form.match(/<button\b/g) ?? []).length, 3);
    assert.match(form, /type="submit" name="operation" value="DEPOSIT"/);
    assert.match(form, /type="button" data-launch-vault-stop="AMZN"/);
    assert.match(form, /type="button" data-launch-vault-withdraw="AMZN"/);
    assert.match(form, /name="amount"[^>]*value="0\.01"/);
    assert.doesNotMatch(
      html,
      /data-launch-vault-close|data-launch-stock-buy|data-launch-stock-sell|data-automation-policy|data-launch-executor-order|Automatic stock strategy|Strategy trading & executor settings/,
    );
    assert.match(html, /every locked PASS by closing the Vault/);
    assert.match(html, /may require separate transactions/);
    assert.match(html, /failed stock purchase leaves deposited cash in your Vault/);
  }
});

test('Deposit and Withdraw remain gated while unresolved outcomes still allow an authenticated Stop', () => {
  for (const state of [
    { ...current(), account: null, wallet: { ...current().wallet!, accountId: null } },
    { ...current(), transaction: { ...current().transaction, state: 'RECOVERY_REQUIRED' as const } },
    { ...current(), busy: true },
  ]) {
    const html = renderVaults(state, {}, 'AMZN');
    for (const marker of ['name="operation" value="DEPOSIT"', 'data-launch-vault-withdraw="AMZN"'])
      assert.match(html, new RegExp(`${marker}[^>]*disabled`));
    const stop = html.match(/<button[^>]*data-launch-vault-stop="AMZN"[^>]*>/)?.[0];
    assert.ok(stop);
    if (state.account === null) assert.match(stop, /disabled/);
    else assert.doesNotMatch(stop, /disabled/);
  }
});

test('total funds and return include a loss, preserve exact large base units and never invent an unavailable valuation', () => {
  assert.equal(vaultReturnPercent('9000000', '10000000'), '-10.00%');
  assert.equal(vaultReturnPercent('11000000', '10000000'), '+10.00%');
  assert.equal(vaultReturnPercent('0', '0'), '—');
  assert.equal(vaultReturnPercent('1', '1000000000000000000000000000000'), '-100.00%');
  assert.equal(vaultReturnPercent('1000000000001', '1000000000000'), '+<0.01%');
  const html = renderVaultPerformance(current(), 'AMZN', {
    observedAt: 1792000000,
    priceObservedAt: 1791999990,
  });
  assert.match(html, /TOTAL FUNDS[\s\S]*<strong>9<\/strong>/);
  assert.match(html, /Invested principal[\s\S]*10 AF-USDC/);
  assert.match(html, /-1 AF-USDC/);
  assert.match(html, /-10.00%/);
  assert.match(html, /Updated [\s\S]*Stock price/);
  const unavailable = {
    ...current(),
    wallet: {
      ...current().wallet!,
      vaults: current().wallet!.vaults.map((v) => ({
        ...v,
        equityRaw: null,
        valuationState: 'UNAVAILABLE' as const,
      })),
    },
  };
  const unknown = renderVaultPerformance(unavailable, 'AMZN');
  assert.match(unknown, /TOTAL FUNDS[\s\S]*<strong>—<\/strong>/);
  assert.match(unknown, /Valuation unavailable/);
  assert.doesNotMatch(unknown, /-10.00%/);
});

test('a stopped Vault reports retained holdings and an unresolved transaction exposes recovery without a new send', () => {
  const stopped = renderVaultActionStatus(
    current(),
    { flow: null, error: null, notice: null, paused: { AMZN: true } },
    'AMZN',
  );
  assert.match(stopped, /Stopped · holdings remain in your Vault/);
  const unknown = renderVaultActionStatus(
    current(),
    {
      flow: {
        strategyId: 'AMZN',
        kind: 'WITHDRAW',
        phase: 'RECOVERY_REQUIRED',
        busy: false,
        review: false,
        pendingHash: null,
      },
      error: 'Check the original wallet result.',
      notice: null,
      paused: {},
    },
    'AMZN',
  );
  assert.match(unknown, /data-launch-vault-recover="AMZN"/);
  assert.doesNotMatch(unknown, /data-launch-confirm/);
});

test('stale totals retain their dated value and initial service errors remain visible before any flow exists', () => {
  const state = current();
  const old = renderVaultPerformance(state, 'AMZN', {
    vault: address,
    equityRaw: '8000000',
    principalRaw: '10000000',
    profitRaw: '-2000000',
    returnBps: '-2000',
    status: 'STALE',
    observedAt: 1792000000,
    priceObservedAt: 1791990000,
  });
  assert.match(old, /<strong>8<\/strong>[\s\S]*-20.00%/);
  assert.match(old, /Last valuation[\s\S]*Stock price[\s\S]*current stock reference price is unavailable/);
  assert.ok(old.includes('Stock price ' + new Date(1791990000 * 1000).toLocaleString('en-US')));
  const wrong = renderVaultPerformance(state, 'AMZN', {
    vault: '0x4444444444444444444444444444444444444444',
    equityRaw: '1',
    principalRaw: '1',
    status: 'FRESH',
    observedAt: 1792000000,
  });
  assert.match(wrong, /<strong>9<\/strong>/);
  const error = 'Connect the verified stock data service before depositing.';
  const html = renderVaults(state, {}, 'AMZN', { flow: null, error, notice: null, paused: {} });
  assert.match(html, /data-launch-vault-error role="alert"/);
  assert.ok(html.includes(error));
});

test('a reloaded unresolved wallet request offers hash recovery without another wallet send', () => {
  const flow = {
    strategyId: 'AMZN' as const,
    kind: 'DEPOSIT' as const,
    phase: 'AWAITING_WALLET',
    busy: false,
    review: false,
    pendingHash: null,
  };
  const recovering = renderVaultActionStatus(
    current(),
    { flow, error: null, notice: null, paused: {} },
    'AMZN',
  );
  assert.match(recovering, /data-launch-vault-hash-recover data-strategy="AMZN"/);
  assert.match(recovering, /Check the previous wallet request before continuing/);
  assert.match(recovering, /sends no replacement/);
  assert.doesNotMatch(recovering, /data-launch-confirm/);
  const active = renderVaultActionStatus(
    current(),
    { flow: { ...flow, busy: true }, error: null, notice: null, paused: {} },
    'AMZN',
  );
  assert.doesNotMatch(active, /data-launch-vault-hash-recover/);
});
