import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderVaultFunding, renderAccount, renderVaults } from '../apps/web/src/launch-market/shell.ts';
import type { LaunchClientState } from '../apps/web/src/launch-market/model.ts';
import type { VaultActionsViewState } from '../apps/web/src/launch-market/vault-actions-ui.ts';
import { config, wallet, snapshot, account, quote, OWNER } from './helpers/launch-market-ui-fixture.ts';

function fixture(operation: 'CREATE_VAULT' | 'DEPOSIT' | 'CLOSE') {
  const state: LaunchClientState = {
    enabled: true,
    owner: OWNER,
    config: config(),
    wallet: wallet(),
    snapshot: snapshot(),
    account: account(),
    connecting: false,
    busy: false,
    error: null,
    notice: null,
    quoteRequest: null,
    quote: quote({
      owner: OWNER,
      strategyId: 'TSLA',
      operation,
      asset: 'AF_USDC',
      amountRaw: '100000000',
      slippageBps: 100,
    }),
    transaction: { state: 'IDLE', owner: null, hash: null, id: null, approval: false, confirmations: 0 },
  };
  const actions: VaultActionsViewState = {
    flow: {
      strategyId: 'TSLA',
      kind: operation === 'CLOSE' ? 'WITHDRAW' : 'DEPOSIT',
      phase: 'READY',
      busy: false,
      review: true,
      pendingHash: null,
    },
    error: null,
    notice: null,
    paused: {},
  };
  return { state, actions };
}

for (const operation of ['CREATE_VAULT', 'DEPOSIT', 'CLOSE'] as const)
  test(`${operation} has one actionable review immediately after its amount`, () => {
    const { state, actions } = fixture(operation);
    const html = renderVaultFunding(state, 'TSLA', {}, actions);
    assert.ok(html.indexOf('name="amount"') < html.indexOf('data-launch-vault-review'));
    assert.match(html, /type="button" data-launch-confirm >/);
    assert.match(html, /type="button" data-launch-clear >/);
    assert.doesNotMatch(html, /value="DEPOSIT"|Finish or cancel/);
    assert.match(
      html,
      operation === 'CREATE_VAULT'
        ? /No deposit is transferred/
        : operation === 'DEPOSIT'
          ? /100 AF-USDC/
          : /release all locked PASS/,
    );
    assert.equal((renderAccount(state, {}, [], actions).match(/data-launch-confirm/g) ?? []).length, 1);
    assert.match(renderAccount(state, {}, [], actions), /data-launch-position="TSLA" open/);
    assert.equal((renderVaults(state, {}, 'TSLA', actions).match(/data-launch-confirm/g) ?? []).length, 1);
    assert.doesNotMatch(renderVaultFunding(state, 'AMZN', {}, actions), /data-launch-vault-review/);
  });

test('Exact approvals identify the correct token and amount; pending and mismatched reviews cannot proceed inline', () => {
  let { state } = fixture('DEPOSIT');
  const { actions } = fixture('DEPOSIT');
  for (const [token, amountRaw, expected] of [
    [state.config!.manifest!.usdc, '100000000', '100 AF-USDC'],
    [state.config!.manifest!.strategies.TSLA.pass, '100000000000000000000', '100 PASS'],
  ]) {
    state = {
      ...state,
      quote: { ...state.quote!, allowance: { token: token!, amountRaw: amountRaw!, spender: OWNER } },
    };
    assert.ok(renderVaultFunding(state, 'TSLA', {}, actions).includes(expected!));
  }
  actions.error = 'Unable to prepare this step';
  assert.match(
    renderVaultFunding(state, 'TSLA', {}, actions),
    /data-launch-vault-review="TSLA"[\s\S]*role="alert">Unable to prepare this step/,
  );
  actions.flow!.busy = true;
  assert.match(renderVaultFunding(state, 'TSLA', {}, actions), /data-launch-confirm disabled/);
  actions.flow!.busy = false;
  actions.flow!.pendingHash = '0xabc';
  assert.match(renderVaultFunding(state, 'TSLA', {}, actions), /data-launch-confirm disabled/);
  actions.flow!.review = false;
  assert.doesNotMatch(renderVaults(state, {}, 'TSLA', actions), /data-launch-confirm/);
  assert.doesNotMatch(renderVaults(state, {}, 'AMZN', actions), /data-launch-confirm/);
  assert.match(renderVaultFunding(state, 'TSLA', {}, actions), /Waiting for chain confirmation/);
  actions.flow!.review = true;
  state = { ...state, owner: '0x2222222222222222222222222222222222222222' };
  assert.doesNotMatch(renderVaultFunding(state, 'TSLA', {}, actions), /data-launch-vault-review/);
});
