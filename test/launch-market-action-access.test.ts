import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionAccess, actionControl } from '../apps/web/src/launch-market/action-access.ts';
import { actionable } from '../apps/web/src/launch-market/presentation.ts';
import { renderAccount, renderVaults, renderVaultFunding } from '../apps/web/src/launch-market/shell.ts';
import { account, config, OWNER, snapshot, wallet } from './helpers/launch-market-ui-fixture.ts';
import { pricedPaper } from './helpers/launch-market-paper-fixture.ts';
import type { LaunchClientState } from '../apps/web/src/launch-market/model.ts';

const state = (): LaunchClientState => ({
  enabled: true,
  config: { ...config(), emailVerificationRequired: false },
  owner: OWNER,
  wallet: { ...wallet(), accountId: null },
  account: null,
  snapshot: snapshot(),
  busy: false,
  connecting: false,
  quote: null,
  quoteRequest: null,
  error: null,
  notice: null,
  transaction: { state: 'IDLE', id: null, hash: null, confirmations: 0, approval: false, owner: null },
});

test('a connected wallet without a session gets an explicit ownership action, without enabling settlement', () => {
  const current = state();
  assert.equal(actionable(current, 'TSLA', 'MINT', 'AF_USDC'), false);
  const html = actionControl(current, 'TSLA', 'MINT', 'AF_USDC', 'Review Mint TSLA');
  assert.match(html, /type="button"[^>]+data-launch-bind/);
  assert.match(html, /This signature moves no assets/);
  assert.doesNotMatch(html, /type="submit"|disabled|data-launch-confirm/);
  const session = { ...account(), emailVerified: false, identityKind: 'WALLET_TEST' as const };
  const linked = { ...current, account: session, wallet: wallet() };
  assert.equal(actionAccess(linked, 'TSLA', 'MINT', 'AF_USDC').action, 'REVIEW');
  assert.match(actionControl(linked, 'TSLA', 'MINT', 'AF_USDC', 'Review Mint TSLA'), /type="submit"/);
});

test('missing wallet, expired session, pending transaction and verified-email mode show the appropriate next step', () => {
  const current = state();
  assert.equal(
    actionAccess({ ...current, owner: null, wallet: null }, 'TSLA', 'MINT', 'AF_USDC').action,
    'CONNECT',
  );
  assert.equal(
    actionAccess(
      { ...current, config: { ...current.config!, emailVerificationRequired: true } },
      'TSLA',
      'MINT',
      'AF_USDC',
    ).action,
    'LOGIN',
  );
  assert.equal(actionAccess({ ...current, busy: true }, 'TSLA', 'MINT', 'AF_USDC').action, 'WAIT');
  const pending = {
    ...current,
    transaction: { ...current.transaction, state: 'RECOVERY_REQUIRED' as const },
  };
  assert.equal(actionAccess(pending, 'TSLA', 'MINT', 'AF_USDC').action, 'WAIT');
  assert.match(
    actionControl(pending, 'TSLA', 'MINT', 'AF_USDC', 'Review Mint TSLA'),
    /Check your pending transaction/,
  );
});

test('My Account opens the selected strategy Vault with concrete capacity and settlement steps', () => {
  const current = state();
  const html = renderAccount(current);
  assert.match(html, /href="#\/account\/vaults\/tsla">Vault details/);
  assert.match(html, /href="#\/account\/vaults\/amzn">Vault details/);
  const page = renderVaults(current, {}, 'TSLA');
  assert.match(page, /All in TSLA Vault/);
  assert.doesNotMatch(page, /All in AMZN Vault/);
  assert.match(page, /10 PASS lets you deposit 10 AF-USDC/);
  assert.match(page, /data-launch-bind/);
  assert.match(page, /data-strategy="TSLA" data-vault="new:TSLA"[\s\S]*value="DEPOSIT" >Deposit/);
  assert.doesNotMatch(page, /data-launch-create-vault/);
});

test('Deposit is the account entry and remains disabled while signing', () => {
  const current = state();
  for (const candidate of [
    current,
    { ...current, owner: null, wallet: null },
    { ...current, config: { ...current.config!, emailVerificationRequired: true } },
  ]) {
    const html = renderVaultFunding(candidate, 'TSLA', { 'new:TSLA': '1000' });
    assert.match(html, /value="1000"/);
    assert.match(html, /value="DEPOSIT" >Deposit/);
    assert.doesNotMatch(html, /data-launch-vault-access|data-launch-bind|data-launch-confirm/);
  }
  const retry = renderVaultFunding({ ...current, error: '<cancelled>' }, 'TSLA');
  assert.match(retry, /data-launch-vault-signin-error>&lt;cancelled&gt;/);
  assert.match(retry, /value="DEPOSIT" >Deposit/);
  for (const walletSignIn of ['CHECKING', 'AWAITING_SIGNATURE', 'VERIFYING'] as const) {
    const html = renderVaultFunding({ ...current, busy: true, walletSignIn }, 'TSLA');
    assert.match(html, /data-launch-deposit-reason/);
    assert.match(html, /value="DEPOSIT" disabled/);
  }
});

test('Vault sign-in completion leaves quote and pending transaction gates intact', () => {
  const current = state();
  const linked = {
    ...current,
    account: { ...account(), emailVerified: false, identityKind: 'WALLET_TEST' as const },
    wallet: wallet(),
  };
  const value = { ...pricedPaper(), vault: null };
  const values = { TSLA: { value, observedAt: value.paper.observedAt } };
  const render = (candidate = linked, valuations = values) =>
    renderVaultFunding(candidate, 'TSLA', {}, undefined, valuations);
  assert.doesNotMatch(render(), /data-launch-vault-access|value="DEPOSIT" disabled/);
  const closed = {
    TSLA: {
      ...values.TSLA,
      value: { ...value, paper: { ...value.paper, marketSession: 'CLOSED' as const } },
    },
  };
  assert.match(render(linked, closed), /Market closed: you can deposit now/);
  assert.doesNotMatch(render(linked, closed), /value="DEPOSIT" disabled/);
  assert.match(render({ ...linked, busy: true }), /value="DEPOSIT" disabled/);
  const pending = { ...linked, transaction: { ...linked.transaction, state: 'RECOVERY_REQUIRED' as const } };
  assert.match(render(pending), /value="DEPOSIT" disabled/);
  assert.doesNotMatch(render(pending), /data-launch-vault-access/);
});
