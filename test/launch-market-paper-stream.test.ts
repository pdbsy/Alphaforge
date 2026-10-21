import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LaunchMarketClient } from '../apps/web/src/launch-market/client.ts';
import { fixture, location, OWNER, OTHER, NOW, BLOCK } from './helpers/launch-market-ui-fixture.ts';

async function connected() {
  const f = fixture();
  const client = new LaunchMarketClient({ api: f.api, provider: f.provider, now: () => NOW });
  await client.initialize();
  await client.connect();
  return { ...f, client };
}
async function submitted() {
  const f = await connected();
  await f.client.review({
    strategyId: 'AMZN',
    operation: 'BUY',
    asset: 'AF_USDC',
    amountRaw: '1000000',
    slippageBps: 50,
  });
  await f.client.confirm();
  f.state.requests.length = 0;
  f.provider.calls.length = 0;
  return f;
}

test('normal block snapshots update global market state without any wallet or asset read', async () => {
  const f = await connected();
  f.state.requests.length = 0;
  f.provider.calls.length = 0;
  for (let block = 101; block <= 200; block++) {
    const snapshot = { ...f.state.snapshot, location: location(block) };
    await f.client.stream({ type: 'SNAPSHOT', location: snapshot.location, snapshot });
  }
  assert.equal(f.client.state.snapshot!.location.blockNumber, '200');
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.provider.calls.length, 0);
});

test('unrelated owner or transaction broadcasts cannot trigger an active wallet read', async () => {
  const f = await submitted();
  await f.client.stream({
    type: 'OPERATION',
    location: location(101),
    operation: { ...f.state.operation, owner: OTHER },
  });
  await f.client.stream({
    type: 'OPERATION',
    location: location(101),
    operation: {
      ...f.state.operation,
      owner: OWNER,
      id: 'other-operation',
      transactionHash: `0x${'ff'.repeat(32)}`,
    },
  });
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.provider.calls.length, 0);
  assert.equal(f.client.state.transaction.state, 'SUBMITTED');
});

test('one confirmed own operation refreshes funds once, while a reorg always rereads authoritative custody', async () => {
  const f = await submitted();
  f.state.operation = { ...f.state.operation, state: 'COMPLETED', confirmations: 3, location: location(101) };
  f.state.wallet = { ...f.state.wallet, location: location(101), usdcBalanceRaw: '900000000' };
  f.state.snapshot = { ...f.state.snapshot, location: location(101) };
  const event = { type: 'OPERATION' as const, location: location(101), operation: f.state.operation };
  await f.client.stream(event);
  await f.client.stream(event);
  assert.equal(f.client.state.transaction.state, 'COMPLETED');
  assert.equal(f.client.state.wallet!.usdcBalanceRaw, '900000000');
  assert.equal(f.state.requests.filter((request) => request.path.includes('/wallet?')).length, 1);
  const fork = { ...location(99), blockHash: `0x${'cc'.repeat(32)}`, version: '102' };
  f.state.wallet = { ...f.state.wallet, location: fork, usdcBalanceRaw: '1000000000' };
  f.state.snapshot = { ...f.state.snapshot, location: fork };
  f.state.operation = { ...f.state.operation, state: 'REORGED', confirmations: 0, location: fork };
  await f.client.stream({ type: 'REORG', location: fork });
  assert.equal(f.state.requests.filter((request) => request.path.includes('/wallet?')).length, 2);
  assert.equal(f.client.state.wallet!.usdcBalanceRaw, '1000000000');
  assert.equal(f.client.state.wallet!.location.blockHash, fork.blockHash);
  assert.notEqual(f.client.state.wallet!.location.blockHash, BLOCK);
  assert.equal(f.client.state.transaction.state, 'REORGED');
  assert.equal(f.client.state.quote, null);
});
