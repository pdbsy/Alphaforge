import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PaperLedger,
  paperProofId,
  type PaperFundingProof,
  type PaperExecutionPrice,
} from '../packages/launch-market/src/paper-ledger.ts';
const owner = '0x' + '11'.repeat(20),
  other = '0x' + '22'.repeat(20),
  vault = '0x' + '33'.repeat(20),
  next = '0x' + '44'.repeat(20),
  hash = '0x' + 'aa'.repeat(32);
const price = (at: number, p = '100000000'): PaperExecutionPrice => ({
  sourceId: 'ALPACA_IEX',
  sourceAuthorized: true,
  strategyId: 'TSLA',
  priceRaw: p,
  observedAt: at,
  expiresAt: at + 30,
  fetchedAt: at,
  marketState: 'OPEN',
});
const proof = (
  kind: 'DEPOSIT' | 'CLOSE' = 'DEPOSIT',
  at = 100,
  tx = '0x' + 'bb'.repeat(32),
): PaperFundingProof => ({
  kind,
  chainId: 46630,
  owner,
  strategyId: 'TSLA',
  vault,
  transactionHash: tx,
  logIndex: 4,
  blockNumber: String(at),
  blockHash: hash,
  blockTimestamp: at,
  confirmations: 3,
  amountRaw: '100000000',
  passRaw: '100000000000000000000',
});
const fixture = () =>
  new PaperLedger(':memory:', { origin: 'https://paper.example.test', manifestDigest: hash });
const key = 'paper_action_test_0001';
test('confirmed deposit buys only that contribution at confirmation time, bigint fractions preserve cash, and deposits are never profit', () => {
  const s = fixture();
  try {
    const p = proof();
    s.recordDeposit(p, { actionId: key, paused: false, price: price(105, '300000000') }, 105);
    let b = s.book(owner, 'TSLA', vault, price(105, '300000000'), 105);
    assert.equal(b.status, 'OPEN');
    assert.equal(b.quantityRaw, '333333333333333333');
    assert.equal(b.idleRaw, '1');
    assert.equal(b.equityRaw, '100000000');
    assert.equal(b.profitRaw, '0');
    assert.equal(b.history[1]!.at, 105);
    s.recordDeposit(p, { actionId: key, paused: false, price: price(110, '100000000') }, 110);
    assert.equal(s.book(owner, 'TSLA', vault, price(110, '300000000'), 110).quantityRaw, b.quantityRaw);
    s.recordDeposit(
      { ...proof('DEPOSIT', 120, '0x' + 'cc'.repeat(32)), amountRaw: '100000000' },
      { actionId: 'paper_action_test_0002', paused: true, price: price(120) },
      120,
    );
    b = s.book(owner, 'TSLA', vault, price(130, '150000000'), 130);
    assert.equal(b.quantityRaw, '333333333333333333');
    assert.equal(b.unrealizedRaw, '-50000000');
    assert.equal(b.contributedRaw, '200000000');
    assert.equal(b.returnBps, '-2500');
  } finally {
    s.close();
  }
});
test('Stop before funding confirmation preserves idle principal and can never fill that stopped deposit on a retry', () => {
  const s = fixture();
  try {
    const p = proof();
    s.recordDeposit(p, { actionId: key, paused: true, price: price(105) }, 105);
    s.recordDeposit(p, { actionId: key, paused: false, price: price(106) }, 106);
    assert.equal(s.book(owner, 'TSLA', vault, price(110), 110).quantityRaw, '0');
    assert.equal(s.book(owner, 'TSLA', vault, null, 110).equityRaw, null);
    assert.equal(s.book(other, 'TSLA', vault, price(110), 110).status, 'EMPTY');
    assert.equal(s.book(owner, 'AMZN', vault, null, 110).status, 'EMPTY');
  } finally {
    s.close();
  }
});
test('CLOSE keeps exact real returned principal separate from virtual losses, and lack of exit price stays pending', () => {
  const s = fixture();
  try {
    s.recordDeposit(proof(), { actionId: key, paused: false, price: price(105) }, 105);
    s.recordClose(
      proof('CLOSE', 130, '0x' + 'cc'.repeat(32)),
      { actionId: 'paper_close_test_0001', price: null },
      135,
    );
    let b = s.book(owner, 'TSLA', vault, price(140, '50000000'), 140);
    assert.equal(b.status, 'SETTLEMENT_PENDING');
    assert.equal(b.profitRaw, null);
    assert.equal(b.quantityRaw, '0');
    s.recordClose(
      proof('CLOSE', 130, '0x' + 'cc'.repeat(32)),
      { actionId: 'paper_close_test_0001', price: price(135, '50000000') },
      135,
    );
    b = s.book(owner, 'TSLA', vault, null, 150);
    assert.equal(b.realizedRaw, '-50000000');
    assert.equal(b.history.at(-1)!.amountRaw, '100000000');
    assert.equal(b.status, 'CLOSED');
    assert.equal(s.book(owner, 'TSLA', next, null, 150).status, 'EMPTY');
    assert.deepEqual(s.closedVaults(owner, 'TSLA'), [vault]);
    assert.deepEqual(s.closedVaults(other, 'TSLA'), []);
    s.recordDeposit(
      { ...proof('DEPOSIT', 160, '0x' + 'dd'.repeat(32)), vault: next },
      { actionId: 'paper_next_vault_0001', paused: false, price: price(165) },
      165,
    );
    assert.equal(s.book(owner, 'TSLA', next, price(170), 170).status, 'OPEN');
    assert.deepEqual(s.closedVaults(owner, 'TSLA'), [vault]);
    assert.equal(s.book(owner, 'TSLA', vault, null, 170).realizedRaw, '-50000000');
    assert.equal(b.curve.at(-1)!.profitRaw, '-50000000');
  } finally {
    s.close();
  }
});
test('stable transaction identity survives re-inclusion with a changed global log index, while different transaction for same action is rejected and orphaned values freeze', () => {
  const s = fixture();
  try {
    const p = proof();
    s.recordDeposit(p, { actionId: key, paused: false, price: price(105) }, 105);
    assert.throws(
      () =>
        s.recordDeposit(
          proof('DEPOSIT', 110, '0x' + 'dd'.repeat(32)),
          { actionId: key, paused: false, price: price(110) },
          110,
        ),
      /PAPER_LEDGER_ACTION_REUSED/,
    );
    s.setCanonical(paperProofId(p), '0x' + 'ee'.repeat(32));
    let b = s.book(owner, 'TSLA', vault, price(120), 120);
    assert.equal(b.status, 'REORG_REVIEW_REQUIRED');
    assert.equal(b.profitRaw, null);
    assert.equal(b.equityRaw, null);
    const recovered = {
      ...p,
      logIndex: 8,
      blockHash: '0x' + 'ee'.repeat(32),
      blockNumber: '111',
      blockTimestamp: 111,
    };
    s.recordDeposit(recovered, { actionId: key, paused: false, price: price(115) }, 115);
    b = s.book(owner, 'TSLA', vault, price(120), 120);
    assert.equal(b.status, 'OPEN');
    assert.equal(b.contributedRaw, '100000000');
    assert.equal(b.quantityRaw, '1000000000000000000');
    assert.equal(s.db.prepare('SELECT count(*) n FROM paper_funding').get()!.n, 2);
  } finally {
    s.close();
  }
});
test('shared persistent marks produce a profit curve without a deposit jump or per-user mark duplicates', () => {
  const s = fixture();
  try {
    s.recordDeposit(proof(), { actionId: key, paused: false, price: price(105) }, 105);
    s.recordMark(price(110, '110000000'), 110);
    s.recordMark(price(110, '110000000'), 110);
    s.recordDeposit(
      proof('DEPOSIT', 120, '0x' + 'cc'.repeat(32)),
      { actionId: 'paper_action_test_0002', paused: false, price: price(125, '110000000') },
      125,
    );
    s.recordMark(price(130, '110000000'), 130);
    const b = s.book(owner, 'TSLA', vault, price(130, '110000000'), 130);
    assert.equal(b.curve.length, 2);
    assert.equal(b.curve[0]!.profitRaw, '10000000');
    assert.equal(b.curve[1]!.profitRaw, '10000000');
    assert.equal(s.db.prepare('SELECT count(*) n FROM paper_marks').get()!.n, 2);
  } finally {
    s.close();
  }
});
test('unauthorized and closed references never fill, while a delayed entry uses its actual new fill time', () => {
  const s = fixture();
  try {
    s.recordDeposit(
      proof(),
      { actionId: key, paused: false, price: { ...price(100), sourceAuthorized: false as true } },
      105,
    );
    assert.equal(s.book(owner, 'TSLA', vault, null, 105).status, 'ENTRY_PENDING');
    s.recordDeposit(proof(), { actionId: key, paused: false, price: price(200) }, 200);
    assert.equal(s.book(owner, 'TSLA', vault, null, 200).quantityRaw, '1000000000000000000');
    assert.equal(s.book(owner, 'TSLA', vault, null, 200).history[1]!.at, 200);
    s.recordDeposit(
      { ...proof('DEPOSIT', 200, '0x' + 'cc'.repeat(32)) },
      { actionId: 'paper_action_test_0002', paused: false, price: { ...price(205), marketState: 'CLOSED' } },
      205,
    );
    assert.equal(s.book(owner, 'TSLA', vault, null, 205).quantityRaw, '1000000000000000000');
  } finally {
    s.close();
  }
});
