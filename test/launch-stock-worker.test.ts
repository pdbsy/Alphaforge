import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Transaction, Wallet, ZeroAddress, keccak256 } from 'ethers';
import { config, BLOCK, NOW } from './helpers/launch-market-ui-fixture.ts';
import { OrderJournal } from '../packages/testnet/src/order-journal.ts';
import { StockWorkerJournal } from '../apps/server/src/launch-market-adapters/stock-worker-journal.ts';
import {
  StockAutomationWorker,
  reconcileStockWorkerOrder,
  type StockWorkerOptions,
} from '../apps/server/src/launch-market-adapters/stock-worker.ts';
import {
  stockConsentMessage,
  verifyStockConsent,
  stockEvidenceHash,
  decideStockOrder,
  emaStockSignal,
  type StockAutomationConsent,
} from '../apps/server/src/launch-market-adapters/stock-worker-policy.ts';
import { stockWorkerReadProvider } from '../apps/server/src/launch-market-adapters/stock-worker-rpc.ts';
import {
  stockExecutionInterface,
  type StockExecutionSnapshot,
} from '../apps/web/src/launch-market/stock-execution.ts';
import type { ConfirmedStockReference } from '../apps/server/src/launch-market-adapters/stock-reference.ts';
import type { Eip1193Provider } from '../apps/web/src/chain-wallet.ts';
import { stockWorkerCli, readStockWorkerPrivateJson } from '../tools/launch-market/stock-worker.ts';
import { AlpacaStockWorkerSource } from '../apps/server/src/launch-market-adapters/stock-worker-source.ts';
import { readStockAutomationReadiness } from '../apps/server/src/launch-market-adapters/stock-worker-readiness.ts';

const owner = new Wallet('0x' + '11'.repeat(32)),
  executor = new Wallet('0x' + '22'.repeat(32));
const VAULT = '0x' + '33'.repeat(20),
  STOCK = '0x' + '44'.repeat(20),
  VENUE = '0x' + '55'.repeat(20),
  FEED = '0x' + '66'.repeat(20);
const manifest = config().manifest!;
const gas = {
  gasLimit: '300000',
  maxFeePerGas: '1000',
  maxPriorityFeePerGas: '1',
  maxGasCostWei: '300000000',
};
const grant = {
  executor: executor.address,
  expiresAt: String(NOW + 3600),
  maxOrderUsdc: '10000000',
  maxTotalBuyUsdc: '50000000',
  maxSlippageBps: 100,
};
function consent(): StockAutomationConsent {
  return {
    schemaVersion: 1,
    chainId: 46630,
    manifestDigest: stockEvidenceHash(manifest),
    owner: owner.address,
    vault: VAULT,
    strategyId: 'TSLA',
    initialVersion: '2',
    grant: { ...grant },
    policy: { kind: 'BUY_AND_HOLD' },
    validUntil: NOW + 3600,
    maxPositionUsdcRaw: '50000000',
    stopPriceUsdcRaw: '0',
    takePriceUsdcRaw: '0',
    nonce: 'owner_consent_0001',
  };
}
function snapshot(): StockExecutionSnapshot {
  return {
    strategyId: 'TSLA',
    owner: owner.address,
    vault: VAULT,
    blockNumber: '100',
    blockHash: BLOCK,
    blockTimestamp: NOW,
    closed: false,
    version: '2',
    totalBuyUsdc: '0',
    grant: { ...grant },
    targetStock: STOCK,
    stockReserve: VENUE,
    referenceFeed: FEED,
    maxPriceAge: 60,
    trackedCashRaw: '20000000',
    trackedStockRaw: '0',
    vaultUsdcRaw: '20000000',
    vaultStockRaw: '0',
    reserveUsdcRaw: '1000000000',
    reserveStockRaw: String(1000n * 10n ** 18n),
    stockPriceUsdcRaw: '100000000',
    referenceObservedAt: NOW,
    referenceDigest: BLOCK,
    regularOpen: NOW - 3600,
    regularClose: NOW + 3600,
    calendarObservedAt: NOW,
    calendarDigest: BLOCK,
    executionAllowed: true,
    venuePaused: false,
    status: 'READY',
    executionCutoff: NOW + 60,
  };
}
const reference: ConfirmedStockReference = {
  strategyId: 'TSLA',
  status: 'OPEN',
  observedAt: NOW,
  priceRaw: '100000000',
  regularOpen: NOW - 3600,
  regularClose: NOW + 3600,
  calendarObservedAt: NOW,
  sourceDigest: BLOCK,
  calendarDigest: BLOCK,
  source: 'Alpaca IEX',
};

async function fixture(activate = false) {
  const folder = mkdtempSync(join(tmpdir(), 'af-stock-worker-'));
  const orders = new OrderJournal(join(folder, 'orders.sqlite'), BLOCK),
    evidence = new StockWorkerJournal(join(folder, 'sources.sqlite'), BLOCK);
  const c = consent(),
    signed = { consent: c, signature: await owner.signMessage(stockConsentMessage(c)) };
  const current = {
    snapshot: snapshot(),
    sent: 0,
    nonce: 0,
    pendingNonce: 0,
    raw: '',
    paused: false,
    canonicalHash: BLOCK,
    receiptVisible: false,
    depth: 102,
    badLog: false,
    canWrite: true,
    changedAfterSign: false,
    pausedAfterSign: false,
  };
  const eventAbi = new Interface([
    'event StrategyExecuted(bool buy,uint256 input,uint256 output,uint256 version)',
  ]);
  const provider: Eip1193Provider = {
    on: () => undefined,
    removeListener: () => undefined,
    request: async ({ method }) => {
      if (method === 'eth_chainId') return '0xb626';
      if (method === 'eth_call') return '0x';
      if (method === 'eth_blockNumber') return '0x' + current.depth.toString(16);
      if (method === 'eth_getBlockByNumber')
        return { number: '0x64', hash: current.canonicalHash, timestamp: '0x' + NOW.toString(16) };
      if (!current.raw) return null;
      const tx = Transaction.from(current.raw),
        parsed = stockExecutionInterface.parseTransaction({ data: tx.data })!;
      if (method === 'eth_getTransactionByHash')
        return {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          input: tx.data,
          value: '0x0',
          nonce: '0x0',
          blockHash: BLOCK,
          blockNumber: '0x64',
        };
      if (method === 'eth_getTransactionReceipt') {
        if (!current.receiptVisible) return null;
        const log = eventAbi.encodeEventLog(eventAbi.getEvent('StrategyExecuted')!, [
          parsed.args[0],
          parsed.args[1],
          (parsed.args[1] * 10n ** 18n) / 100000000n,
          current.badLog ? 999n : parsed.args[4] + 1n,
        ]);
        return {
          transactionHash: tx.hash,
          from: tx.from,
          to: tx.to,
          status: '0x1',
          blockNumber: '0x64',
          blockHash: BLOCK,
          logs: [{ address: VAULT, transactionHash: tx.hash, data: log.data, topics: log.topics }],
        };
      }
      throw new Error('UNEXPECTED_READ');
    },
  };
  const options: StockWorkerOptions = {
    manifest,
    provider,
    orders,
    evidence,
    sessions: [signed],
    feeds: [],
    gas,
    maxTotalGasCostWei: '30000000000',
    canWrite: () => current.canWrite,
    activationValid: () => true,
    sessionActive: () => !current.paused,
    now: () => NOW,
    readSnapshot: async () => structuredClone(current.snapshot),
    source: { read: async () => reference, minuteBars: async () => [] },
  };
  const submission = {
    signers: [
      {
        address: executor.address.toLowerCase(),
        sign: async (tx: Readonly<Record<string, string>>) => {
          const raw = await executor.signTransaction({ ...tx, nonce: Number(tx.nonce), type: 2 });
          if (current.changedAfterSign)
            current.snapshot = {
              ...current.snapshot,
              grant: { ...current.snapshot.grant, executor: ZeroAddress },
            };
          if (current.pausedAfterSign) current.paused = true;
          return raw;
        },
      },
    ],
    transport: {
      chainId: async () => 46630,
      nonce: async (_a: string, tag: 'pending' | 'latest') =>
        tag === 'pending' ? current.pendingNonce : current.nonce,
      balance: async () => 1000000000000000000n,
      estimate: async () => 100000n,
      send: async (raw: string) => {
        current.sent++;
        current.raw = raw;
        current.pendingNonce = 1;
        return Transaction.from(raw).hash!;
      },
    },
  };
  const worker = new StockAutomationWorker({ ...options, ...(activate ? { submission } : {}) });
  return {
    folder,
    orders,
    evidence,
    c,
    current,
    options,
    submission,
    worker,
    close: async () => {
      await worker.close();
      orders.close();
      evidence.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

test('owner policy signature binds Vault, grant, risk, strategy and publication-independent consent', async () => {
  const c = consent(),
    signed = { consent: c, signature: await owner.signMessage(stockConsentMessage(c)) };
  assert.match(verifyStockConsent(signed), /^0x[0-9a-f]{64}$/);
  assert.throws(
    () => verifyStockConsent({ ...signed, consent: { ...c, maxPositionUsdcRaw: '50000001' } }),
    /STOCK_POLICY_SIGNATURE/,
  );
  assert.throws(
    () => stockConsentMessage({ ...c, grant: { ...c.grant, executor: owner.address } }),
    /AUTHORITY/,
  );
  assert.throws(() => stockConsentMessage({ ...c, validUntil: NOW + 3601 }), /LIMITS/);
});
test('planner caps purchases by cash, position value, current grant and remaining lifetime budget', () => {
  const c = consent(),
    s = snapshot();
  assert.equal(decideStockOrder(c, s, NOW, { lastBuyAt: null, riskStopped: false })?.inputRaw, '10000000');
  assert.equal(
    decideStockOrder({ ...c, maxPositionUsdcRaw: '1000000' }, s, NOW, { lastBuyAt: null, riskStopped: false })
      ?.inputRaw,
    '1000000',
  );
  assert.equal(
    decideStockOrder(c, { ...s, totalBuyUsdc: '49500000' }, NOW, { lastBuyAt: null, riskStopped: false })
      ?.inputRaw,
    '500000',
  );
  for (const status of [
    'STALE_REFERENCE',
    'STALE_CALENDAR',
    'MARKET_CLOSED',
    'PAUSED',
    'VAULT_CLOSED',
  ] as const)
    assert.throws(
      () => decideStockOrder(c, { ...s, status }, NOW, { lastBuyAt: null, riskStopped: false }),
      /NOT_READY/,
    );
  assert.throws(
    () =>
      decideStockOrder(c, { ...s, grant: { ...s.grant, executor: ZeroAddress } }, NOW, {
        lastBuyAt: null,
        riskStopped: false,
      }),
    /GRANT_CHANGED/,
  );
});
test('risk exit is order limited, remains latched after confirmed exit, and DCA does not catch up missed intervals', () => {
  const c = consent(),
    s = { ...snapshot(), trackedStockRaw: String(10n ** 18n), vaultStockRaw: String(10n ** 18n) };
  const decision = decideStockOrder({ ...c, stopPriceUsdcRaw: '100000000' }, s, NOW, {
    lastBuyAt: null,
    riskStopped: false,
  })!;
  assert.equal(decision.reason, 'RISK_EXIT');
  assert.equal(decision.inputRaw, '100000000000000000');
  assert.equal(decideStockOrder(c, snapshot(), NOW, { lastBuyAt: null, riskStopped: true }), null);
  const dca = {
    ...c,
    policy: { kind: 'DCA' as const, intervalSeconds: 3600, installmentUsdcRaw: '2000000' },
  };
  assert.equal(decideStockOrder(dca, snapshot(), NOW, { lastBuyAt: NOW - 3599, riskStopped: false }), null);
  assert.equal(
    decideStockOrder(dca, snapshot(), NOW, { lastBuyAt: NOW - 86400, riskStopped: false })?.inputRaw,
    '2000000',
  );
});
test('EMA uses finalized consecutive real bars, detects a crossover and rejects stale/gapped inputs', () => {
  const end = Math.floor((NOW - 120) / 60) * 60;
  const bars = Array.from({ length: 10 }, (_, i) => ({
    start: end - (9 - i) * 60,
    closeUsdcRaw: i === 9 ? '110000000' : '100000000',
    sourceDigest: BLOCK,
  }));
  assert.equal(emaStockSignal(bars, 2, 3, NOW), 'BUY');
  assert.throws(
    () => emaStockSignal([...bars.slice(0, 9), { ...bars[9]!, start: end + 60 }], 2, 3, NOW),
    /GAP_OR_UNFINISHED/,
  );
  assert.throws(
    () =>
      emaStockSignal(
        bars.map((b) => ({ ...b, start: b.start - 600 })),
        2,
        3,
        NOW,
      ),
    /STALE/,
  );
});
test('prepare mode archives evidence and never calls a signer or write RPC; read adapter rejects writes', async () => {
  const f = await fixture();
  try {
    await f.worker.tick();
    assert.equal(f.current.sent, 0);
    assert.equal(f.orders.attempts(), 0);
    assert.equal(f.orders.db.prepare('SELECT count(*) n FROM orders').get()!.n, 1);
    assert.equal(f.evidence.db.prepare('SELECT count(*) n FROM decisions').get()!.n, 1);
    const rpc = stockWorkerReadProvider({
      send: async () => {
        throw new Error('should not be called');
      },
    });
    await assert.rejects(rpc.request({ method: 'eth_sendRawTransaction', params: ['0x'] }), /READ_ONLY/);
  } finally {
    await f.close();
  }
});
test('supervised signing broadcasts once and uncertain outcome blocks every subsequent tick and restart', async () => {
  const f = await fixture(true);
  try {
    await f.worker.tick();
    await f.worker.tick();
    assert.equal(f.current.sent, 1);
    const fresh = new StockAutomationWorker({ ...f.options, submission: f.submission });
    await fresh.tick();
    await fresh.close();
    assert.equal(f.current.sent, 1);
    assert.equal(f.orders.blocked(executor.address), true);
  } finally {
    await f.close();
  }
});
test('canonical exact execution receipt advances version only after three confirmations; reorg blocks reuse', async () => {
  const f = await fixture(true);
  try {
    await f.worker.tick();
    const id = String(f.orders.db.prepare('SELECT id FROM orders').get()!.id);
    f.current.receiptVisible = true;
    f.current.depth = 101;
    await reconcileStockWorkerOrder(f.options.provider, f.orders, id);
    assert.equal(f.orders.get(id)!.state, 'BROADCAST_UNCERTAIN');
    f.current.depth = 102;
    await reconcileStockWorkerOrder(f.options.provider, f.orders, id);
    assert.equal(f.orders.get(id)!.state, 'RECONCILED');
    f.current.canonicalHash = '0x' + 'cc'.repeat(32);
    await reconcileStockWorkerOrder(f.options.provider, f.orders, id);
    assert.equal(f.orders.get(id)!.state, 'REORGED');
    assert.equal(f.orders.blocked(executor.address), true);
  } finally {
    await f.close();
  }
});
test('forged execution version in receipt cannot reconcile or release the nonce', async () => {
  const f = await fixture(true);
  try {
    await f.worker.tick();
    const id = String(f.orders.db.prepare('SELECT id FROM orders').get()!.id);
    f.current.receiptVisible = true;
    f.current.badLog = true;
    await assert.rejects(reconcileStockWorkerOrder(f.options.provider, f.orders, id), /EXECUTION_RECEIPT/);
    assert.equal(f.orders.blocked(executor.address), true);
  } finally {
    await f.close();
  }
});
test('revocation after signing prevents transmission and retains the signed nonce; pause and storage gates block planning', async () => {
  const f = await fixture(true);
  try {
    f.current.paused = true;
    await f.worker.tick();
    assert.equal(f.orders.attempts(), 0);
    f.current.paused = false;
    f.current.changedAfterSign = true;
    await f.worker.tick();
    assert.equal(f.current.sent, 0);
    assert.equal(f.orders.db.prepare('SELECT state FROM orders').get()!.state, 'SIGNED');
    assert.equal(f.orders.blocked(executor.address), true);
    f.current.canWrite = false;
    await f.worker.tick();
    assert.equal(f.worker.status, 'STOCK_WORKER_AUTHORIZATION');
  } finally {
    await f.close();
  }
});
test('owner manual execution or identical regrant changes the version and requires fresh consent', async () => {
  const f = await fixture(true);
  try {
    f.current.snapshot = { ...f.current.snapshot, version: '3' };
    await f.worker.tick();
    assert.equal(f.current.sent, 0);
    assert.equal(f.worker.safeStatus().strategies[0]!.status, 'STOCK_SESSION_VERSION_CHANGED');
  } finally {
    await f.close();
  }
});
test('owner pause that arrives during signing prevents broadcast and leaves the nonce blocked', async () => {
  const f = await fixture(true);
  try {
    f.current.pausedAfterSign = true;
    await f.worker.tick();
    assert.equal(f.current.sent, 0);
    assert.equal(f.orders.db.prepare('SELECT state FROM orders').get()!.state, 'SIGNED');
    assert.equal(f.orders.blocked(executor.address), true);
  } finally {
    await f.close();
  }
});
test('feed pipeline publishes calendar then price from the same captured source without calendar starvation', async () => {
  const f = await fixture();
  const factory = new Interface([
    'function strategy(uint8) view returns(tuple(address creator,address pass,address usdc,address targetStock,address otherStock,address stockReserve,address referenceFeed,bytes32 strategyRef,uint32 maxPriceAge))',
  ]);
  const feed = new Interface([
    'function keeper() view returns(address)',
    'function referenceIdentity() view returns(bytes32)',
    'function price() view returns(uint256,uint64,bytes32)',
    'function calendarObservedAt() view returns(uint64)',
    'function regularOpen() view returns(uint64)',
    'function regularClose() view returns(uint64)',
    'function calendarDigest() view returns(bytes32)',
    'function executionAllowed() view returns(bool)',
    'function update(uint256,uint64,bytes32)',
    'function updateSession(uint64,uint64,uint64,bytes32)',
  ]);
  const current = { calendar: 0, observed: 0, opens: 0, closes: 0, captures: 0 };
  const code = '0x60006000';
  const venue = new Interface([
    'function paused() view returns(bool)',
    'function usdc() view returns(address)',
    'function stock() view returns(address)',
    'function feed() view returns(address)',
  ]);
  const token = new Interface(['function balanceOf(address) view returns(uint256)']);
  const readyManifest = {
    ...manifest,
    runtimeCodeHashes: {
      ...manifest.runtimeCodeHashes,
      ...Object.fromEntries(
        [FEED, VENUE, STOCK, manifest.usdc, manifest.vaultFactory!].map((address) => [
          address.toLowerCase(),
          keccak256(code),
        ]),
      ),
    },
  };
  const rpc: Eip1193Provider = {
    ...f.options.provider,
    request: async (input) => {
      if (input.method === 'eth_getCode') return code;
      if (input.method === 'eth_call') {
        const tx = input.params![0] as { to: string; data: string };
        if (tx.to.toLowerCase() === manifest.vaultFactory!.toLowerCase())
          return factory.encodeFunctionResult('strategy', [
            [
              owner.address,
              manifest.strategies.TSLA.pass,
              manifest.usdc,
              STOCK,
              VENUE,
              VENUE,
              FEED,
              BLOCK,
              60,
            ],
          ]);
        if (tx.to.toLowerCase() === VENUE.toLowerCase()) {
          const action = venue.parseTransaction({ data: tx.data })!;
          const values: Record<string, unknown[]> = {
            paused: [false],
            usdc: [manifest.usdc],
            stock: [STOCK],
            feed: [FEED],
          };
          return venue.encodeFunctionResult(action.name, values[action.name]!);
        }
        if ([manifest.usdc.toLowerCase(), STOCK.toLowerCase()].includes(tx.to.toLowerCase()))
          return token.encodeFunctionResult('balanceOf', [1000000000]);
        const parsed = feed.parseTransaction({ data: tx.data })!;
        const values: Record<string, unknown[]> = {
          keeper: [executor.address],
          referenceIdentity: [BLOCK],
          price: [100000000, current.observed, BLOCK],
          calendarObservedAt: [current.calendar],
          regularOpen: [current.opens],
          regularClose: [current.closes],
          calendarDigest: [current.calendar ? BLOCK : '0x' + '00'.repeat(32)],
          executionAllowed: [current.opens <= NOW && NOW < current.closes],
        };
        return feed.encodeFunctionResult(parsed.name, values[parsed.name]!);
      }
      return f.options.provider.request(input);
    },
  };
  const worker = new StockAutomationWorker({
    ...f.options,
    provider: rpc,
    manifest: readyManifest,
    sessions: [],
    feeds: [
      {
        strategyId: 'TSLA',
        keeper: executor.address,
        operatorOwner: owner.address,
        referenceIdentity: BLOCK,
      },
    ],
    source: {
      read: async () => {
        current.captures++;
        return reference;
      },
      minuteBars: async () => [],
    },
  });
  try {
    assert.equal(
      (await readStockAutomationReadiness(rpc, readyManifest, 'TSLA', NOW)).status,
      'UNINITIALIZED',
    );
    await worker.tick();
    let rows = f.orders.db.prepare('SELECT intent FROM orders').all();
    assert.equal(rows.length, 1);
    assert.equal(
      feed.parseTransaction({ data: JSON.parse(String(rows[0]!.intent)).calldata })!.name,
      'updateSession',
    );
    current.calendar = NOW;
    assert.equal(
      (await readStockAutomationReadiness(rpc, readyManifest, 'TSLA', NOW)).status,
      'MARKET_CLOSED',
    );
    current.opens = reference.regularOpen;
    current.closes = reference.regularClose;
    await worker.tick();
    rows = f.orders.db.prepare('SELECT intent FROM orders').all();
    assert.equal(rows.length, 2);
    assert.ok(
      rows.some(
        (r) => feed.parseTransaction({ data: JSON.parse(String(r.intent)).calldata })!.name === 'update',
      ),
    );
    assert.equal(current.captures, 1);
    current.observed = NOW;
    assert.equal((await readStockAutomationReadiness(rpc, readyManifest, 'TSLA', NOW)).status, 'READY');
  } finally {
    await worker.close();
    await f.close();
  }
});
test('closed provider session never fetches a quote or minute bars, and finished bars reject provider gaps', async () => {
  const now = Date.parse('2026-10-09T15:00:00Z') / 1000,
    calls: string[] = [];
  const source = new AlpacaStockWorkerSource({
    apiKey: 'offline',
    apiSecret: 'offline',
    now: () => now,
    fetcher: async (input, init) => {
      const url = String(input);
      calls.push(url);
      assert.equal(init?.method, 'GET');
      if (url.includes('/clock'))
        return new Response(JSON.stringify({ timestamp: '2026-10-09T15:00:00Z', is_open: false }));
      if (url.includes('/calendar')) return new Response('[]');
      throw new Error('UNEXPECTED_DATA_FETCH');
    },
  });
  const closed = await source.read('TSLA');
  assert.equal(closed.status, 'CLOSED');
  assert.equal(calls.length, 2);
  await assert.rejects(source.minuteBars(closed, 7), /SESSION/);
  assert.equal(calls.length, 2);
  const open = { ...reference, regularOpen: now - 3600, regularClose: now + 3600, calendarObservedAt: now };
  const bars = new AlpacaStockWorkerSource({
    apiKey: 'offline',
    apiSecret: 'offline',
    now: () => now,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          symbol: 'TSLA',
          bars: Array.from({ length: 7 }, (_, i) => ({
            t: new Date((now - 600 + i * 60) * 1000).toISOString(),
            o: 100,
            h: 101,
            l: 99,
            c: 100,
            v: 1,
          })),
          next_page_token: null,
        }),
      ),
  });
  await assert.rejects(bars.minuteBars(open, 7), /STOCK_BAR_INVALID/);
});
test('CLI rejects activation without explicit scope; private registry rejects readable files and symlinks', async () => {
  assert.equal(await stockWorkerCli(['--activate', '/missing-config', '/missing-activation'], {}), 2);
  const folder = mkdtempSync(join(tmpdir(), 'af-worker-input-'));
  try {
    const file = join(folder, 'input.json');
    writeFileSync(file, '{}', { mode: 0o600 });
    assert.deepEqual(readStockWorkerPrivateJson(file), {});
    chmodSync(file, 0o644);
    assert.throws(() => readStockWorkerPrivateJson(file), /PRIVATE_FILE/);
    chmodSync(file, 0o600);
    symlinkSync(file, join(folder, 'link.json'));
    assert.throws(() => readStockWorkerPrivateJson(join(folder, 'link.json')), /PRIVATE_FILE/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
