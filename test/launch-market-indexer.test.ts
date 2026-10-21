import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { Interface, Wallet, ZeroAddress } from 'ethers';
import { MarketEventIndexer, marketEventInterface } from '../apps/server/src/launch-market/indexer.ts';
import { buildLaunchMarketServer } from '../apps/server/src/launch-market/server.ts';
import { LaunchMarketService } from '../packages/launch-market/src/service.ts';
import { LaunchMarketStore } from '../packages/launch-market/src/store.ts';
import type { MarketChain, MarketSnapshotTarget } from '../packages/launch-market/src/chain.ts';
import {
  LaunchMarketError,
  type LaunchMarketManifest,
  type MarketSnapshot,
} from '../packages/launch-market/src/types.ts';

const a = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const h = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const qty = (n: number) => '0x' + n.toString(16);
const P = 10n ** 18n;
const manifest: LaunchMarketManifest = {
  schemaVersion: 1,
  chainId: 46630,
  deploymentBlock: '1',
  usdc: a(1),
  claim: a(2),
  conversionReserve: a(3),
  router: a(4),
  poolFactory: a(5),
  vaultFactory: a(10),
  strategies: {
    TSLA: { pass: a(6), launch: a(7), pool: null, lpRecipient: a(20) },
    AMZN: { pass: a(8), launch: null, pool: a(9), lpRecipient: a(21) },
  },
  runtimeCodeHashes: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [a(n), h(99)])),
};
function snapshot(height: number, blockHash: string, claims = 0): MarketSnapshot {
  const base = {
    state: 'LAUNCHED' as const,
    pass: a(8),
    totalSupplyRaw: (1_000_000n * P).toString(),
    publicSupplyRaw: '0',
    soldRaw: '0',
    remainingRaw: '0',
    mintPriceUsdcRaw: '500000',
    lpPassRaw: (500_000n * P).toString(),
    lpUsdcRaw: '250000000000',
    pool: a(9),
    reservePassRaw: (500_000n * P).toString(),
    reserveUsdcRaw: '250000000000',
    ammFeeBps: 30,
  };
  return {
    location: {
      chainId: 46630,
      blockNumber: String(height),
      blockHash,
      transactionHash: null,
      logIndex: null,
      version: '0',
      confirmations: 1,
    },
    markets: {
      TSLA: {
        ...base,
        pass: a(6),
        pool: a(11),
        publicSupplyRaw: (500_000n * P).toString(),
        soldRaw: (500_000n * P).toString(),
      },
      AMZN: base,
    },
    claim: {
      amountUsdcRaw: '1000000000',
      successfulClaims: claims,
      maxClaims: 100,
      remainingClaims: 100 - claims,
      funded: true,
    },
    conversion: {
      ethReserveRaw: '100000000000000000000',
      usdcReserveRaw: '1000000000000',
      ethBuyAvailable: true,
      ethSellAvailable: true,
      ethMintAvailable: true,
      feeBps: 0,
      epoch: '1',
    },
  };
}
/** A local unit fixture for raw Ethereum JSON-RPC; the runtime indexer has no invented chain source. */
class RpcFixture {
  height = 2;
  fork = 0;
  claims = 1;
  logs: Array<Record<string, unknown>> = [];
  calls = 0;
  injectForeign = false;
  beforeSend: ((method: string, params: unknown[]) => Promise<void>) | null = null;
  beforeSnapshot: ((at?: MarketSnapshotTarget) => Promise<void>) | null = null;
  hash(height: number) {
    return h(height + (height >= 2 ? this.fork * 1000 : 0));
  }
  log(emitter: string, name: string, args: unknown[], height: number, index: number) {
    const encoded = marketEventInterface.encodeEventLog(marketEventInterface.getEvent(name)!, args);
    const result = {
      address: emitter,
      blockNumber: qty(height),
      blockHash: this.hash(height),
      transactionHash: h(100 + height + index),
      transactionIndex: '0x0',
      logIndex: qty(index),
      topics: encoded.topics,
      data: encoded.data,
      removed: false,
    };
    this.logs.push(result);
    return result;
  }
  async send(method: string, params: unknown[]): Promise<unknown> {
    this.calls++;
    await this.beforeSend?.(method, params);
    if (method === 'eth_chainId') return qty(46630);
    if (method === 'eth_getBlockByNumber') {
      const height = params[0] === 'latest' ? this.height : Number(BigInt(String(params[0])));
      if (height > this.height) return null;
      return {
        number: qty(height),
        hash: this.hash(height),
        parentHash: this.hash(height - 1),
        timestamp: qty(1000 + height * 12),
      };
    }
    if (method === 'eth_getLogs') {
      const filter = params[0] as { address: string[]; fromBlock: string; toBlock: string };
      const matched = this.logs.filter(
        (log) =>
          filter.address.includes(String(log.address)) &&
          Number(BigInt(String(log.blockNumber))) >= Number(BigInt(filter.fromBlock)) &&
          Number(BigInt(String(log.blockNumber))) <= Number(BigInt(filter.toBlock)) &&
          log.blockHash === this.hash(Number(BigInt(String(log.blockNumber)))),
      );
      if (this.injectForeign) return [...matched, { ...this.logs[0], address: a(90) }];
      return matched;
    }
    if (method === 'eth_call') {
      const request = params[0] as { data: string };
      const iface = new Interface([
        'function passLocker() view returns(address)',
        'function targetStock() view returns(address)',
      ]);
      const decoded = iface.parseTransaction(request)!;
      return iface.encodeFunctionResult(decoded.name, [decoded.name === 'passLocker' ? a(13) : a(14)]);
    }
    throw new Error('Unexpected RPC fixture method ' + method);
  }
}
function chain(rpc: RpcFixture): MarketChain {
  return {
    snapshot: async (at) => {
      await rpc.beforeSnapshot?.(at);
      const height = at ? Number(at.blockNumber) : rpc.height;
      return snapshot(height, rpc.hash(height), rpc.claims);
    },
    wallet: async () => {
      throw new Error('Unused');
    },
    quoteAmm: async () => {
      throw new Error('Unused');
    },
    simulate: async () => {
      throw new Error('Unused');
    },
    transaction: async () => null,
    receipt: async () => null,
    canonicalBlockHash: async (n) => (Number(n) > rpc.height ? null : rpc.hash(Number(n))),
    signingPolicy: async () => {
      throw new Error('Unused');
    },
  };
}
function fixture(maxBlocksPerPoll = 500, pollIntervalMs = 5000) {
  const dir = mkdtempSync(join(tmpdir(), 'af-market-index-'));
  const rpc = new RpcFixture();
  const createService = () =>
    new LaunchMarketService({
      manifest,
      store: new LaunchMarketStore(join(dir, 'accounts.sqlite'), 'http://localhost'),
      chain: chain(rpc),
      ethReference: null,
      quoteSigner: null,
      claimSigner: null,
      indexedSnapshots: true,
      now: () => 1000,
    });
  const service = createService();
  const indexer = new MarketEventIndexer({
    path: join(dir, 'events.sqlite'),
    manifest,
    provider: rpc,
    service,
    maxBlocksPerPoll,
    pollIntervalMs,
  });
  return {
    dir,
    rpc,
    service,
    indexer,
    createService,
    cleanup: async () => {
      await indexer.close();
      service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function pendingGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function stableHistoryServer(f: ReturnType<typeof fixture>) {
  f.rpc.claims = 0;
  f.indexer.start = () => {};
  const server = await buildLaunchMarketServer({
    service: f.service,
    indexer: f.indexer,
    origin: 'http://localhost',
    trustedIdentity: () => null,
  });
  await server.app.ready();
  return server;
}
function sixHistoryRequests(server: Awaited<ReturnType<typeof stableHistoryServer>>) {
  return (['TSLA', 'AMZN'] as const).flatMap((strategyId) =>
    (['history', 'holders', 'candles'] as const).map((name) => ({
      name,
      strategyId,
      response: server.app.inject({
        method: 'GET',
        url: `/api/launch-market/${name}?strategyId=${strategyId}`,
        headers: { host: 'localhost' },
      }),
    })),
  );
}

test('stable history waits for a normal in-flight poll and returns consistent data on all six routes', async () => {
  const f = fixture(),
    entered = pendingGate(),
    gate = pendingGate(),
    server = await stableHistoryServer(f);
  let poll: Promise<void> | null = null;
  try {
    f.rpc.height = 3;
    f.rpc.log(a(6), 'Transfer', [ZeroAddress, a(30), P], 3, 0);
    f.rpc.log(a(8), 'Transfer', [ZeroAddress, a(30), P], 3, 1);
    f.rpc.beforeSnapshot = async (at) => {
      assert.equal(at?.blockNumber, '3');
      entered.release();
      await gate.promise;
    };
    poll = f.indexer.poll();
    await entered.promise;
    assert.equal(f.indexer.status().blockNumber, '3');
    assert.equal(f.service.projector.latest()?.location.blockNumber, '2');
    let completed = 0;
    const requests = sixHistoryRequests(server).map(async ({ response }) => {
      const result = await response;
      completed++;
      return result;
    });
    await yieldEventLoop();
    assert.equal(completed, 0, 'no route may mix the new cursor with the previous projection');
    gate.release();
    await poll;
    for (const response of await Promise.all(requests)) {
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.deepEqual(body.location, f.service.projector.latest()!.location);
      assert.equal(body.indexer.state, 'HEALTHY');
      assert.equal(body.indexer.blockHash, body.location.blockHash);
    }
  } finally {
    gate.release();
    await poll?.catch(() => {});
    await server.stop();
    await f.cleanup();
  }
});

test('stable history keeps initial backfill, a true backlog, and a failed poll unavailable on all six routes', async () => {
  for (const scenario of ['initial', 'backlog', 'failure']) {
    const f = fixture(scenario === 'failure' ? 500 : 1),
      entered = pendingGate(),
      gate = pendingGate();
    if (scenario === 'initial') f.rpc.height = 4;
    if (scenario === 'backlog') f.rpc.height = 1;
    const server = await stableHistoryServer(f);
    let poll: Promise<unknown> | null = null;
    try {
      if (scenario === 'initial') {
        assert.equal(f.indexer.status().state, 'SYNCING');
        assert.equal(f.service.projector.latest(), null);
      } else if (scenario === 'backlog') {
        assert.equal(f.indexer.status().state, 'HEALTHY');
        assert.equal(f.service.projector.latest()?.location.blockNumber, '1');
        f.rpc.height = 4;
        await f.indexer.poll();
        assert.equal(f.indexer.status().state, 'SYNCING');
        assert.equal(f.indexer.status().blockNumber, '2');
      } else {
        f.rpc.height = 3;
        f.rpc.beforeSnapshot = async () => {
          entered.release();
          await gate.promise;
          throw new LaunchMarketError('TEST_RPC_FAILURE', 503);
        };
        poll = f.indexer.poll().catch((error: unknown) => error);
        await entered.promise;
      }
      const requests = sixHistoryRequests(server);
      gate.release();
      await poll;
      for (const { response } of requests) {
        const result = await response;
        assert.equal(result.statusCode, 503);
        assert.equal(result.json().error.code, 'MARKET_HISTORY_SYNCING');
      }
      assert.equal(f.indexer.status().state, scenario === 'failure' ? 'DEGRADED' : 'SYNCING');
      assert.equal(
        f.service.projector.latest()?.location.blockNumber ?? null,
        scenario === 'initial' ? null : scenario === 'backlog' ? '1' : '2',
      );
    } finally {
      gate.release();
      await poll;
      await server.stop();
      await f.cleanup();
    }
  }
});

test('stable history never leaks the old fork while rewind is checking canonical block identity', async () => {
  const f = fixture(),
    entered = pendingGate(),
    gate = pendingGate();
  for (const [index, pass] of [a(6), a(8)].entries()) {
    f.rpc.log(pass, 'Transfer', [ZeroAddress, a(30), 10n * P], 1, index);
    f.rpc.log(pass, 'Transfer', [a(30), a(31), P], 2, index);
  }
  f.rpc.log(a(9), 'Swap', [a(30), a(30), true, 25_000_000n, 50n * P, 75_000n], 2, 2);
  const server = await stableHistoryServer(f);
  let poll: Promise<void> | null = null;
  try {
    f.rpc.fork = 1;
    for (const [index, pass] of [a(6), a(8)].entries())
      f.rpc.log(pass, 'Transfer', [a(30), a(32), 2n * P], 2, index);
    f.rpc.log(a(9), 'Swap', [a(30), a(30), true, 90_000_000n, 50n * P, 270_000n], 2, 2);
    f.rpc.beforeSend = async (method, params) => {
      if (method === 'eth_getBlockByNumber' && params[0] === '0x2') {
        f.rpc.beforeSend = null;
        entered.release();
        await gate.promise;
      }
    };
    poll = f.indexer.poll();
    await entered.promise;
    let completed = 0;
    const requests = sixHistoryRequests(server).map(async (request) => {
      const response = await request.response;
      completed++;
      return { ...request, response };
    });
    await yieldEventLoop();
    assert.equal(completed, 0);
    gate.release();
    await poll;
    for (const { name, strategyId, response } of await Promise.all(requests)) {
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.location.blockHash, f.rpc.hash(2));
      assert.equal(body.indexer.state, 'HEALTHY');
      if (name === 'holders') {
        assert.equal(
          body.holders.some((entry: { owner: string }) => entry.owner === a(31)),
          false,
        );
        assert.ok(body.holders.some((entry: { owner: string }) => entry.owner === a(32)));
      } else if (name === 'history') {
        for (const event of body.history)
          if (event.location.blockNumber === '2') assert.equal(event.location.blockHash, f.rpc.hash(2));
      } else if (strategyId === 'AMZN') assert.equal(body.candles[0].volumeUsdcRaw, '90000000');
    }
  } finally {
    gate.release();
    await poll?.catch(() => {});
    await server.stop();
    await f.cleanup();
  }
});

test('stable history uses one absolute five-second deadline across poll reentry and clears its timer', async (t) => {
  const f = fixture(),
    firstEntered = pendingGate(),
    secondEntered = pendingGate(),
    firstGate = pendingGate(),
    secondGate = pendingGate();
  let first: Promise<void> | null = null,
    second: Promise<void> | null = null;
  try {
    f.rpc.claims = 0;
    await f.indexer.poll();
    let calls = 0;
    f.rpc.beforeSnapshot = async () => {
      if (++calls === 1) {
        firstEntered.release();
        await firstGate.promise;
      } else {
        secondEntered.release();
        await secondGate.promise;
      }
    };
    first = f.indexer.poll();
    await firstEntered.promise;
    const restarted = first.then(() => {
      second = f.indexer.poll();
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const clear = t.mock.method(globalThis, 'clearTimeout');
    let reads = 0,
      finished = false;
    const reading = f.indexer
      .readStableHistory(() => ++reads)
      .then(
        (value) => {
          finished = true;
          return value;
        },
        (error: unknown) => {
          finished = true;
          return error;
        },
      );
    t.mock.timers.tick(4000);
    firstGate.release();
    await restarted;
    await secondEntered.promise;
    t.mock.timers.tick(999);
    await yieldEventLoop();
    assert.equal(finished, false);
    assert.equal(reads, 0);
    t.mock.timers.tick(1);
    assert.match(String(await reading), /MARKET_HISTORY_SYNCING/);
    assert.equal(reads, 0);
    assert.equal(clear.mock.callCount(), 1);
  } finally {
    firstGate.release();
    secondGate.release();
    t.mock.timers.reset();
    await first?.catch(() => {});
    await Promise.resolve(second).catch(() => {});
    await f.cleanup();
  }
});

test('stable history waits through poll reentry and runs its callback synchronously at the newest projection', async (t) => {
  const f = fixture(),
    firstEntered = pendingGate(),
    secondEntered = pendingGate(),
    firstGate = pendingGate(),
    secondGate = pendingGate();
  let first: Promise<void> | null = null,
    second: Promise<void> | null = null;
  try {
    f.rpc.claims = 0;
    await f.indexer.poll();
    f.rpc.height = 3;
    let calls = 0;
    f.rpc.beforeSnapshot = async () => {
      if (++calls === 1) {
        firstEntered.release();
        await firstGate.promise;
      } else {
        secondEntered.release();
        await secondGate.promise;
      }
    };
    first = f.indexer.poll();
    await firstEntered.promise;
    const restarted = first.then(() => {
      f.rpc.height = 4;
      second = f.indexer.poll();
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const clear = t.mock.method(globalThis, 'clearTimeout');
    let reads = 0;
    const reading = f.indexer.readStableHistory(() => {
      reads++;
      return {
        location: f.service.projector.latest()!.location,
        indexer: f.indexer.status(),
      };
    });
    firstGate.release();
    await restarted;
    await secondEntered.promise;
    assert.equal(reads, 0);
    secondGate.release();
    const result = await reading;
    assert.equal(reads, 1);
    assert.equal(result.location.blockNumber, '4');
    assert.equal(result.indexer.state, 'HEALTHY');
    assert.equal(result.indexer.blockHash, result.location.blockHash);
    assert.equal(clear.mock.callCount(), 1);
  } finally {
    firstGate.release();
    secondGate.release();
    t.mock.timers.reset();
    await first?.catch(() => {});
    await Promise.resolve(second).catch(() => {});
    await f.cleanup();
  }
});

test('stable history preserves callback errors and blocks reads as soon as shutdown begins', async () => {
  const f = fixture(),
    entered = pendingGate(),
    gate = pendingGate();
  let poll: Promise<void> | null = null,
    closing: Promise<void> | null = null;
  try {
    f.rpc.claims = 0;
    await f.indexer.poll();
    const original = new LaunchMarketError('READ_CALLBACK_FAILURE', 400);
    await assert.rejects(
      f.indexer.readStableHistory(() => {
        throw original;
      }),
      (error) => error === original,
    );
    f.rpc.beforeSnapshot = async () => {
      entered.release();
      await gate.promise;
    };
    poll = f.indexer.poll();
    await entered.promise;
    let reads = 0;
    const reading = f.indexer.readStableHistory(() => ++reads).catch((error: unknown) => error);
    closing = f.indexer.close();
    await assert.rejects(
      f.indexer.readStableHistory(() => ++reads),
      /MARKET_HISTORY_SYNCING/,
    );
    gate.release();
    assert.match(String(await reading), /MARKET_HISTORY_SYNCING/);
    await closing;
    await assert.rejects(
      f.indexer.readStableHistory(() => ++reads),
      /MARKET_HISTORY_SYNCING/,
    );
    assert.equal(reads, 0);
  } finally {
    gate.release();
    await poll?.catch(() => {});
    await closing;
    await f.cleanup();
  }
});

test('bootstrap reads during partial history catch-up do not publish or advance the indexer cursor', async () => {
  const f = fixture(1);
  try {
    f.rpc.claims = 0;
    f.rpc.height = 3;
    await f.indexer.poll();
    assert.equal(f.indexer.status().state, 'SYNCING');
    assert.equal(f.indexer.status().blockNumber, '1');
    assert.equal(f.service.projector.latest(), null);
    const published: string[] = [];
    const unsubscribe = f.service.broker.subscribe((event) => published.push(event.type));
    const current = await f.service.snapshot();
    unsubscribe();
    assert.equal(current.location.blockNumber, '3');
    assert.equal(current.location.version, '0');
    assert.equal(f.service.projector.latest(), null);
    assert.equal(f.indexer.status().blockNumber, '1');
    assert.equal(f.indexer.status().state, 'SYNCING');
    assert.deepEqual(published, []);
  } finally {
    await f.cleanup();
  }
});

test('startup accepts a slow first history scan but keeps a bounded readiness deadline', async (t) => {
  for (const expires of [false, true]) {
    const f = fixture(1);
    let scanStarted = false;
    let release!: () => void;
    const scanPending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalPoll = f.indexer.poll.bind(f.indexer);
    let backgroundStarted = false;
    const initialPoll = async () => {
      scanStarted = true;
      await scanPending;
      await originalPoll();
    };
    f.indexer.poll = initialPoll;
    f.indexer.start = () => {
      backgroundStarted = true;
    };
    f.rpc.height = 3;
    f.rpc.claims = 0;
    const server = await buildLaunchMarketServer({
      service: f.service,
      indexer: f.indexer,
      origin: 'http://localhost',
      trustedIdentity: () => null,
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      assert.equal(server.app.initialConfig.pluginTimeout, 60000);
      let finished = false;
      const ready = server.app.ready().then(
        () => {
          finished = true;
          return null;
        },
        (error: unknown) => {
          finished = true;
          return error;
        },
      );
      for (let turn = 0; !scanStarted && turn < 20; turn++) {
        t.mock.timers.tick(0);
        await yieldEventLoop();
      }
      assert.equal(scanStarted, true);
      t.mock.timers.tick(10001);
      await Promise.resolve();
      assert.equal(finished, false, 'the measured 17-second startup scan must not fail at ten seconds');
      assert.equal(backgroundStarted, false);
      if (expires) {
        t.mock.timers.tick(50000);
        await yieldEventLoop();
        t.mock.timers.tick(0);
        assert.match(String((await ready) as Error), /onReady.*timed out/);
        assert.equal(backgroundStarted, false);
      } else {
        t.mock.timers.tick(7000);
        release();
        assert.equal(await ready, null);
        assert.equal(backgroundStarted, true);
        assert.equal(f.indexer.status().state, 'SYNCING');
        assert.equal(f.indexer.status().blockNumber, '1');
        assert.equal(f.service.projector.latest(), null);
        const history = await server.app.inject({
          method: 'GET',
          url: '/api/launch-market/history?strategyId=AMZN',
          headers: { host: 'localhost' },
        });
        assert.equal(history.statusCode, 503);
        assert.equal(history.json().error.code, 'MARKET_HISTORY_SYNCING');
      }
    } finally {
      release();
      // Fastify timeouts do not cancel an in-flight hook; drain it before closing isolated resources.
      t.mock.timers.reset();
      await yieldEventLoop();
      await server.stop();
      await f.cleanup();
    }
  }
});

test('a moving RPC head publishes the captured checkpoint and bootstrap API reads never persist state', async () => {
  const f = fixture();
  try {
    f.rpc.claims = 0;
    const initial = await f.service.snapshot();
    assert.equal(initial.location.blockNumber, '2');
    assert.equal(initial.location.version, '0');
    assert.equal(f.service.projector.latest(), null);
    assert.equal(f.indexer.status().blockNumber, null);
    assert.notEqual(f.indexer.status().state, 'HEALTHY');
    f.rpc.beforeSnapshot = async (at) => {
      if (at) f.rpc.height++;
    };
    const versions: string[] = [];
    const unsubscribe = f.service.broker.subscribe((event) => versions.push(event.location.version));
    await f.indexer.poll();
    assert.equal(f.rpc.height, 3);
    assert.equal(f.indexer.status().state, 'HEALTHY');
    assert.equal(f.indexer.status().blockNumber, '2');
    const first = await f.service.snapshot();
    assert.equal(first.location.blockNumber, '2');
    assert.equal(first.location.blockHash, f.rpc.hash(2));
    assert.equal(f.service.projector.latest()?.location.blockNumber, '2');
    const reads = await Promise.all(Array.from({ length: 20 }, () => f.service.snapshot()));
    assert.ok(reads.every((value) => value.location.version === first.location.version));
    assert.equal(versions.length, 1, 'API reads must not publish newer unindexed snapshots');
    await f.indexer.poll();
    const second = await f.service.snapshot();
    assert.equal(f.indexer.status().state, 'HEALTHY');
    assert.equal(second.location.blockNumber, '3');
    assert.equal(f.service.projector.latest()?.location.blockNumber, '3');
    assert.ok(BigInt(second.location.version) > BigInt(first.location.version));
    assert.equal(versions.length, 2);
    unsubscribe();
  } finally {
    await f.cleanup();
  }
});

test('concurrent API reads retain the indexed projection during a pinned indexer read', async () => {
  const f = fixture();
  let release!: () => void;
  const pendingRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.rpc.claims = 0;
    await f.indexer.poll();
    const previous = await f.service.snapshot();
    f.rpc.height = 3;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.rpc.beforeSnapshot = async (at) => {
      if (!at) return;
      assert.equal(at?.blockNumber, '3');
      entered();
      await pendingRead;
    };
    const poll = f.indexer.poll();
    await started;
    const reads = await Promise.all(Array.from({ length: 20 }, () => f.service.snapshot()));
    assert.ok(reads.every((value) => value.location.version === previous.location.version));
    assert.ok(reads.every((value) => value.location.blockNumber === '2'));
    assert.equal(f.service.projector.latest()?.location.blockNumber, '2');
    release();
    await poll;
    const next = await f.service.snapshot();
    assert.equal(next.location.blockNumber, '3');
    assert.equal(next.location.blockHash, f.indexer.status().blockHash);
    assert.ok(BigInt(next.location.version) > BigInt(previous.location.version));
  } finally {
    release();
    await f.cleanup();
  }
});

test('pinned reads reject a different fork and API reads do not roll back projections', async () => {
  const f = fixture();
  try {
    f.rpc.claims = 0;
    await f.indexer.poll();
    const previous = f.service.projector.latest()!;
    f.rpc.fork = 1;
    await assert.rejects(f.service.snapshot(), /NON_CANONICAL_MARKET_HEAD/);
    await assert.rejects(
      f.service.readSnapshotAt({ blockNumber: '2', blockHash: previous.location.blockHash }),
      /INDEX_SNAPSHOT_FORK/,
    );
    assert.deepEqual(f.service.projector.latest(), previous);
    await f.indexer.poll();
    const next = await f.service.snapshot();
    assert.equal(next.location.blockHash, f.rpc.hash(2));
    assert.ok(BigInt(next.location.version) > BigInt(previous.location.version));
    assert.equal(f.indexer.status().state, 'HEALTHY');
  } finally {
    await f.cleanup();
  }
});

test('a non-canonical API read never changes the indexed projection', async () => {
  const f = fixture();
  try {
    f.rpc.claims = 0;
    await f.indexer.poll();
    const previous = f.service.projector.latest()!;
    f.service.options.chain!.canonicalBlockHash = async () => h(999);
    await assert.rejects(f.service.snapshot(), /NON_CANONICAL_MARKET_HEAD/);
    assert.deepEqual(f.service.projector.latest(), previous);
  } finally {
    await f.cleanup();
  }
});

test('raw canonical logs discover pools and isolated vaults, and index real transfers and swaps across restart', async () => {
  const f = fixture();
  try {
    f.rpc.claims = 0;
    f.rpc.log(a(6), 'Transfer', [ZeroAddress, a(7), 1_000_000n * P], 1, 0);
    f.rpc.log(a(5), 'PoolCreated', [a(6), a(11), a(20), 100n], 2, 0);
    f.rpc.log(a(6), 'Transfer', [a(7), a(11), 500_000n * P], 2, 1);
    f.rpc.log(a(11), 'Swap', [a(30), a(30), true, 25_000_000n, 50n * P, 75_000n], 2, 2);
    f.rpc.log(a(6), 'Transfer', [a(11), a(30), 50n * P], 2, 3);
    f.rpc.log(a(10), 'VaultCreated', [a(30), 0, a(12), 0], 2, 4);
    f.rpc.log(a(12), 'Deposited', [a(30), 1_000_000n, P, 1_000_000n, 1_000_000n], 2, 5);
    const first = f.indexer.poll();
    assert.strictEqual(f.indexer.poll(), first);
    await first;
    assert.equal(f.indexer.status().state, 'HEALTHY');
    assert.equal(f.indexer.history('TSLA').find((event) => event.name === 'Deposited')?.emitter, a(12));
    assert.equal(
      f.indexer.holders('TSLA').find((holder) => holder.owner === a(30))?.balanceRaw,
      (50n * P).toString(),
    );
    assert.deepEqual(f.indexer.candles('TSLA'), [
      {
        timestamp: 1020,
        openRaw: '500000',
        highRaw: '500000',
        lowRaw: '500000',
        closeRaw: '500000',
        volumeUsdcRaw: '25000000',
      },
    ]);
    assert.equal(
      f.indexer.db
        .prepare(
          "SELECT count(*) AS n FROM event_index_watch WHERE kind IN('VAULT','LOCKER','STOCK') AND canonical=1",
        )
        .get()?.n,
      3,
    );
    await f.indexer.close();
    f.service.close();
    const service = f.createService(),
      indexer = new MarketEventIndexer({
        path: join(f.dir, 'events.sqlite'),
        manifest,
        provider: f.rpc,
        service,
      });
    try {
      const before = f.rpc.calls;
      await indexer.poll();
      assert.ok(f.rpc.calls - before < 10);
      assert.equal(indexer.history('TSLA').filter((event) => event.name === 'Swap').length, 1);
      assert.equal(indexer.status().blockHash, f.rpc.hash(2));
    } finally {
      await indexer.close();
      service.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('claim logs without a browser submission reconcile durable vouchers after three inclusive blocks and preserve eligibility on reorg', async () => {
  const f = fixture();
  try {
    const wallet = Wallet.createRandom(),
      account = f.service.account({
        email: 'person@example.test',
        subject: 'issuer-subject',
        emailVerified: true,
      });
    const challenge = f.service.options.store.bindingChallenge(account.id, wallet.address, 1000);
    f.service.options.store.bindWallet(
      account.id,
      challenge.nonce,
      await wallet.signMessage(challenge.message),
      1000,
    );
    const voucher = f.service.options.store.reserveClaim(account.id, wallet.address, 1000, 1060, 0);
    f.rpc.log(
      a(2),
      'Claim',
      [account.accountKey, wallet.address, BigInt(voucher.nonce), 1_000_000_000n, 1],
      2,
      0,
    );
    await f.indexer.poll();
    assert.equal(f.service.options.store.voucher(account.id)?.status, 'INCLUDED');
    f.rpc.height = 4;
    await f.indexer.poll();
    assert.equal(f.service.options.store.voucher(account.id)?.status, 'COMPLETED');
    const streamed: string[] = [];
    const unsubscribe = f.service.broker.subscribe((event) => streamed.push(event.type));
    f.rpc.fork = 1;
    f.rpc.claims = 0;
    await f.indexer.poll();
    unsubscribe();
    assert.equal(f.service.options.store.voucher(account.id)?.status, 'REORGED');
    assert.equal(f.service.options.store.voucher(account.id)?.nonce, voucher.nonce);
    assert.ok(streamed.includes('REORG'));
    assert.equal(
      f.service.options.store.db
        .prepare('SELECT count(*) AS n FROM market_claim_events WHERE canonical=1')
        .get()?.n,
      0,
    );
    assert.equal(
      f.indexer.db
        .prepare("SELECT count(*) AS n FROM event_index_events WHERE name='Claim' AND canonical=1")
        .get()?.n,
      0,
    );
    assert.throws(
      () => f.service.options.store.reserveClaim(account.id, wallet.address, 1001, 1061, 0),
      (error) => error instanceof LaunchMarketError && error.code === 'CLAIM_RECOVERY_REQUIRED',
    );
  } finally {
    await f.cleanup();
  }
});

test('foreign log emitters and wrong chains cannot advance the durable canonical cursor', async () => {
  const f = fixture();
  try {
    f.rpc.log(a(6), 'Transfer', [ZeroAddress, a(7), P], 1, 0);
    f.rpc.injectForeign = true;
    await assert.rejects(
      f.indexer.poll(),
      (error) => error instanceof LaunchMarketError && error.code === 'INDEX_UNWATCHED_LOG',
    );
    assert.equal(f.indexer.status().blockNumber, null);
    assert.equal(f.indexer.status().state, 'DEGRADED');
    const wrong = new MarketEventIndexer({
      path: join(f.dir, 'wrong.sqlite'),
      manifest,
      provider: { send: async () => qty(1) },
      service: f.service,
    });
    try {
      await assert.rejects(
        wrong.poll(),
        (error) => error instanceof LaunchMarketError && error.code === 'INDEX_WRONG_CHAIN',
      );
      assert.equal(wrong.status().blockNumber, null);
    } finally {
      await wrong.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('dedicated server reports NOT_DEPLOYED and enforces host, origin, strict input, and trusted authentication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-market-server-'));
  const service = new LaunchMarketService({
    manifest: null,
    store: new LaunchMarketStore(join(dir, 'accounts.sqlite'), 'http://localhost'),
    chain: null,
    ethReference: null,
    quoteSigner: null,
    claimSigner: null,
  });
  let initialized = 0,
    disposed = 0;
  const runtime = await buildLaunchMarketServer({
    service,
    origin: 'http://localhost',
    trustedIdentity: () => null,
    initialize: async () => {
      initialized++;
    },
    dispose: async () => {
      disposed++;
    },
  });
  try {
    const config = await runtime.app.inject({ method: 'GET', url: '/api/launch-market/config' });
    assert.equal(config.json().deployment, 'NOT_DEPLOYED');
    assert.equal(initialized, 1);
    assert.equal(
      (await runtime.app.inject({ method: 'GET', url: '/api/launch-market/snapshot' })).statusCode,
      503,
    );
    assert.equal(
      (await runtime.app.inject({ method: 'GET', url: '/api/launch-market/account' })).statusCode,
      401,
    );
    assert.equal(
      (
        await runtime.app.inject({
          method: 'GET',
          url: '/api/launch-market/config',
          headers: { host: 'attacker.test' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await runtime.app.inject({
          method: 'POST',
          url: '/api/launch-market/wallet/challenge',
          headers: { origin: 'https://attacker.test' },
          payload: { owner: a(30) },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await runtime.app.inject({
          method: 'POST',
          url: '/api/launch-market/wallet/challenge',
          headers: { origin: 'http://localhost' },
          payload: { owner: a(30), emailVerified: true, email: 'forged@example.test' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await runtime.app.inject({
          method: 'POST',
          url: '/api/launch-market/wallet/challenge',
          headers: { origin: 'http://localhost' },
          payload: { owner: a(30) },
        })
      ).statusCode,
      401,
    );
    assert.equal((await runtime.app.inject({ method: 'GET', url: '/api/market' })).statusCode, 404);
    assert.equal(
      (await runtime.app.inject({ method: 'GET', url: '/health' })).json().mode,
      'ONCHAIN_TESTNET',
    );
  } finally {
    await runtime.stop();
    assert.equal(disposed, 1);
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'server shutdown ends a real open SSE connection before Fastify drains connections',
  { timeout: 3000 },
  async () => {
    const f = fixture();
    const port = await new Promise<number>((done, reject) => {
      const listener = createServer();
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        const endpoint = listener.address();
        if (!endpoint || typeof endpoint === 'string') return reject(new Error('NO_LOCAL_PORT'));
        listener.close((error) => (error ? reject(error) : done(endpoint.port)));
      });
    });
    const origin = 'http://127.0.0.1:' + port;
    const runtime = await buildLaunchMarketServer({
      service: f.service,
      origin,
      trustedIdentity: () => null,
    });
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | null = null;
    try {
      await runtime.start('127.0.0.1', port);
      const response = await fetch(origin + '/api/launch-market/events', { signal: controller.signal });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      assert.equal((await reader.read()).done, false);
      assert.equal(f.service.broker.connections, 1);
      const started = performance.now();
      await Promise.race([
        runtime.stop(),
        new Promise<never>((_done, reject) => {
          deadline = setTimeout(() => reject(new Error('SSE_SHUTDOWN_BLOCKED')), 350);
        }),
      ]);
      assert.ok(performance.now() - started < 350);
      assert.equal(f.service.broker.connections, 0);
      assert.equal((await reader.read()).done, true);
      reader.releaseLock();
    } finally {
      if (deadline) clearTimeout(deadline);
      controller.abort();
      await runtime.stop();
      await f.cleanup();
    }
  },
);

test('30-second shared index exposes canonical proof anchors without per-user RPC reads', async () => {
  const f = fixture(500, 30000);
  try {
    assert.deepEqual(f.indexer.canonicalAnchor('2'), { known: false, blockHash: null });
    await f.indexer.poll();
    const calls = f.rpc.calls;
    for (let viewer = 0; viewer < 100; viewer++)
      assert.deepEqual(f.indexer.canonicalAnchor('2'), { known: true, blockHash: f.rpc.hash(2) });
    assert.deepEqual(f.indexer.canonicalAnchor('3'), { known: false, blockHash: null });
    assert.equal(f.rpc.calls, calls);
    const previous = f.rpc.hash(2);
    f.rpc.fork = 1;
    f.rpc.height = 3;
    const entered = pendingGate(),
      gate = pendingGate();
    f.rpc.beforeSend = async (method, params) => {
      if (method === 'eth_getBlockByNumber' && params[0] === '0x2') {
        f.rpc.beforeSend = null;
        entered.release();
        await gate.promise;
      }
    };
    const poll = f.indexer.poll();
    await entered.promise;
    const duringRewindCalls = f.rpc.calls;
    let completed = false;
    const stableRead = f.indexer
      .readStableHistory(() => f.indexer.canonicalAnchor('2'))
      .then((value) => {
        completed = true;
        return value;
      });
    for (let viewer = 0; viewer < 100; viewer++)
      assert.deepEqual(f.indexer.canonicalAnchor('2'), { known: false, blockHash: null });
    await yieldEventLoop();
    assert.equal(completed, false, 'confirmed SQL values wait for the existing rewind');
    assert.equal(f.rpc.calls, duringRewindCalls, 'viewers do not start a separate chain read');
    gate.release();
    await poll;
    assert.notEqual(f.rpc.hash(2), previous);
    assert.deepEqual(await stableRead, { known: true, blockHash: f.rpc.hash(2) });
    assert.deepEqual(f.indexer.canonicalAnchor('2'), { known: true, blockHash: f.rpc.hash(2) });
  } finally {
    await f.cleanup();
  }
});
