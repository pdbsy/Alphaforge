import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productPageRedirect } from '../apps/web/src/product-pages.ts';
import { renderAccount, renderExecutorReview, renderVaults } from '../apps/web/src/launch-market/shell.ts';
import { LaunchMarketClient } from '../apps/web/src/launch-market/client.ts';
import { executorFixture, permission } from './helpers/launch-market-executor-fixture.ts';
import { NOW } from './helpers/launch-market-ui-fixture.ts';

test('retired setup links return to the account while usable pages and Vault selection keep their address', () => {
  for (const page of [
    'market-data',
    'executor',
    'authorization',
    'authorize',
    'automation',
    'deployment',
    'testnet',
    'automata',
    'reference-paper',
  ]) {
    assert.equal(productPageRedirect('#/account/' + page), '#/account/trades');
    assert.equal(productPageRedirect('#/' + page), '#/account/trades');
  }
  assert.equal(productPageRedirect('#/account/market%2Ddata'), '#/account/trades');
  for (const hash of [
    '#/home',
    '#/trade/tsla',
    '#/account/vaults/amzn',
    '#/account/claim',
    '#/account/notes',
    '#/account/settings',
    '#/forum',
    '#/library',
    '#/%FF',
  ])
    assert.equal(productPageRedirect(hash), null);
});

test('the account has no setup link; old configuration cannot be rendered, while Stop still reviews exact revocation', async () => {
  const fixture = executorFixture();
  const client = new LaunchMarketClient({
    api: fixture.api,
    provider: fixture.provider,
    journal: fixture.journal,
    now: () => NOW,
  });
  await client.initialize();
  await client.connect();
  for (const html of [renderAccount(client.state), renderVaults(client.state, {}, 'AMZN')]) {
    assert.doesNotMatch(
      html,
      /market-data|data-stock-data-form|data-launch-executor-order|Configure an executor/,
    );
    assert.match(html, /value="DEPOSIT"/);
    assert.match(html, /data-launch-vault-stop="AMZN"/);
    assert.match(html, /data-launch-vault-withdraw="AMZN"/);
  }
  await client.reviewExecutorPermission('AMZN', permission());
  assert.equal(renderExecutorReview(client.state), '');
  client.clearQuote();
  fixture.current.grant = permission();
  await client.reviewExecutorPermission('AMZN', null);
  const review = renderExecutorReview(client.state);
  assert.match(review, /Reviewed Vault stop/);
  assert.match(review, /Permission removed/);
  assert.match(review, /data-launch-executor-confirm/);
  assert.doesNotMatch(review, /configureExecutor|Configure an executor|data-launch-executor-order/);
  assert.equal(fixture.provider.calls.filter((call) => call.method === 'eth_sendTransaction').length, 0);
});
