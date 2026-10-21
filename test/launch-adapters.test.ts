import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Interface, ZeroAddress, keccak256, toQuantity } from 'ethers';
import type { FastifyRequest } from 'fastify';
import type { LaunchMarketManifest } from '../packages/launch-market/src/types.ts';
import { RpcMarketChain } from '../apps/server/src/launch-market-adapters/rpc-chain.ts';
import { VerifiedEthReference, priceToRaw } from '../apps/server/src/launch-market-adapters/eth-reference.ts';
import { AccessIdentityBridge } from '../apps/server/src/launch-market-adapters/access-identity.ts';

const rpcAddress = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const rpcHash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const rpcCode = '0x60016000';
const rpcAbi = new Interface([
  'function decimals() view returns(uint8)',
  'function totalSupply() view returns(uint256)',
  'function balanceOf(address) view returns(uint256)',
  'function state() view returns(uint8)',
  'function sold() view returns(uint256)',
  'function pool() view returns(address)',
  'function lpRecipient() view returns(address)',
  'function getPool(address) view returns(address)',
  'function pass() view returns(address)',
  'function usdc() view returns(address)',
  'function factory() view returns(address)',
  'function initialLpRecipient() view returns(address)',
  'function initialized() view returns(bool)',
  'function getReserves() view returns(uint256,uint256)',
  'function totalClaims() view returns(uint256)',
  'function claimsOpened() view returns(bool)',
  'function paused() view returns(bool)',
  'function ethInputPaused() view returns(bool)',
  'function ethOutputPaused() view returns(bool)',
  'function conversionFeeBps() view returns(uint16)',
  'function quoteEpoch() view returns(uint64)',
  'function quoteSigner() view returns(address)',
  'function claimSigner() view returns(address)',
  'function claimEpoch() view returns(uint64)',
  'function limits() view returns(uint256,uint256,uint256,uint256)',
  'function tradingRouter() view returns(address)',
]);

/** Protocol fixture rejects the exact public-RPC batch, quantity and range failures. */
async function rpcFixture() {
  const manifest: LaunchMarketManifest = {
    schemaVersion: 1,
    chainId: 46630,
    deploymentBlock: '1',
    usdc: rpcAddress(1),
    claim: rpcAddress(2),
    conversionReserve: rpcAddress(3),
    router: rpcAddress(4),
    poolFactory: rpcAddress(5),
    vaultFactory: null,
    strategies: {
      TSLA: { pass: rpcAddress(6), launch: rpcAddress(7), pool: null, lpRecipient: rpcAddress(20) },
      AMZN: { pass: rpcAddress(8), launch: null, pool: rpcAddress(9), lpRecipient: rpcAddress(21) },
    },
    runtimeCodeHashes: Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [rpcAddress(i + 1), keccak256(rpcCode)]),
    ),
  };
  type Request = { id: number; method: string; params: unknown[] };
  const records: Request[] = [],
    batchSizes: number[] = [];
  const state = {
    head: 5,
    chainId: 46630,
    code: rpcCode,
    codeFailures: 0,
    callFailures: 0,
    errorCode: -32000,
    errorMessage: 'unsupported block number',
    logsPerRead: 1,
  };
  const quantity = (value: unknown) =>
    typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
  const dispatch = (request: Request) => {
    const { method, params } = request;
    records.push(request);
    const fail = (code: number, message: string) => ({
      id: request.id,
      jsonrpc: '2.0',
      error: { code, message },
    });
    let result: unknown;
    if (method === 'eth_chainId') result = toQuantity(state.chainId);
    else if (method === 'eth_getBlockByNumber') {
      if (params[0] !== 'latest' && !quantity(params[0])) return fail(-32602, 'invalid block quantity');
      const height = params[0] === 'latest' ? state.head : Number(BigInt(String(params[0])));
      result = {
        number: toQuantity(height),
        hash: rpcHash(height),
        parentHash: rpcHash(height - 1),
        timestamp: '0x3e8',
        gasLimit: '0x1c9c380',
      };
    } else if (method === 'eth_getCode') {
      if (!quantity(params[1])) return fail(-32602, 'invalid pinned quantity');
      if (params[0] === manifest.usdc && state.codeFailures-- > 0)
        return fail(state.errorCode, state.errorMessage);
      result = state.code;
    } else if (method === 'eth_getBalance') result = '0x71afd498d0000';
    else if (method === 'eth_call' || method === 'eth_estimateGas') {
      const input = params[0] as { to: string; data: string; value?: string };
      if (!quantity(params[1]) || (input.value !== undefined && !quantity(input.value)))
        return fail(-32602, 'invalid call quantity');
      if (method === 'eth_estimateGas') result = '0x5208';
      else {
        const parsed = rpcAbi.parseTransaction(input);
        if (parsed?.name === 'claimEpoch' && state.callFailures-- > 0)
          return fail(state.errorCode, state.errorMessage);
        if (!parsed) result = '0x';
        else {
          const values: Record<string, readonly unknown[]> = {
            decimals: [input.to === manifest.usdc ? 6 : 18],
            totalSupply: [10n ** 24n],
            balanceOf: [100000000000n],
            state: [1],
            sold: [0],
            pool: [ZeroAddress],
            lpRecipient: [manifest.strategies.TSLA.lpRecipient],
            getPool: [
              parsed.name === 'getPool' && parsed.args[0] === manifest.strategies.AMZN.pass
                ? manifest.strategies.AMZN.pool
                : ZeroAddress,
            ],
            pass: [manifest.strategies.AMZN.pass],
            usdc: [manifest.usdc],
            factory: [manifest.poolFactory],
            initialLpRecipient: [manifest.strategies.AMZN.lpRecipient],
            initialized: [true],
            getReserves: [500000n * 10n ** 18n, 250000n * 10n ** 6n],
            totalClaims: [0],
            claimsOpened: [true],
            paused: [false],
            ethInputPaused: [false],
            ethOutputPaused: [false],
            conversionFeeBps: [0],
            quoteEpoch: [0],
            quoteSigner: [rpcAddress(31)],
            claimSigner: [rpcAddress(32)],
            claimEpoch: [1],
            limits: [200000000000000n, 1000000000000000n, 1600000000000000n, 200000000000000n],
            tradingRouter: [manifest.router],
          };
          result = rpcAbi.encodeFunctionResult(parsed.name, values[parsed.name]!);
        }
      }
    } else if (method === 'eth_getLogs') {
      const filter = params[0] as { address: string[]; fromBlock: string; toBlock: string };
      if (!quantity(filter.fromBlock) || !quantity(filter.toBlock))
        return fail(-32602, 'invalid log quantity');
      if (BigInt(filter.toBlock) - BigInt(filter.fromBlock) >= 100n) return fail(35, 'provider range limit');
      result = Array.from({ length: state.logsPerRead }, () => ({
        address: filter.address[0],
        blockNumber: filter.fromBlock,
      }));
    } else return fail(-32601, 'unexpected read method');
    return { id: request.id, jsonrpc: '2.0', result };
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as Request | Request[];
    const requests = Array.isArray(payload) ? payload : [payload];
    batchSizes.push(requests.length);
    response.setHeader('content-type', 'application/json');
    if (requests.length > 3) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: 'max batch count 3' }));
      return;
    }
    const values = requests.map(dispatch);
    response.end(JSON.stringify(Array.isArray(payload) ? values : values[0]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const chain = new RpcMarketChain(manifest, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  return {
    manifest,
    chain,
    state,
    records,
    batchSizes,
    async close() {
      chain.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('market RPC bounds public batches and preserves exact pinned snapshot identity as the head advances', async () => {
  const fixture = await rpcFixture();
  try {
    fixture.state.codeFailures = 1;
    await fixture.chain.initialize();
    assert.ok(fixture.batchSizes.every((size) => size <= 3));
    const codeReads = fixture.records.filter(
      (row) => row.method === 'eth_getCode' && row.params[0] === fixture.manifest.usdc,
    );
    assert.equal(codeReads.length, 2);
    assert.deepEqual(
      codeReads.map((row) => row.params[1]),
      ['0x5', '0x5'],
    );
    fixture.state.head = 8;
    const snapshot = await fixture.chain.snapshot({ blockNumber: '5', blockHash: rpcHash(5) });
    assert.equal(snapshot.location.blockNumber, '5');
    assert.equal(snapshot.location.blockHash, rpcHash(5));
    assert.equal(snapshot.markets.TSLA.state, 'MINTING');
    assert.equal(snapshot.markets.AMZN.reserveUsdcRaw, '250000000000');
    assert.equal(snapshot.claim.funded, true);
    await assert.rejects(
      fixture.chain.snapshot({ blockNumber: '5', blockHash: rpcHash(6) }),
      /INDEX_SNAPSHOT_FORK/,
    );
    assert.equal(await fixture.chain.canonicalBlockHash('5'), rpcHash(5));
    const calls = fixture.records.filter((row) => row.method === 'eth_call');
    assert.ok(calls.every((row) => row.params[1] === '0x5'));
  } finally {
    await fixture.close();
  }
});

test('market RPC uses canonical JSON-RPC quantities for zero and nonzero simulation values', async () => {
  const fixture = await rpcFixture();
  try {
    for (const value of ['0', '1'])
      assert.equal(
        await fixture.chain.simulate(
          { to: fixture.manifest.claim, data: '0x12345678', value },
          rpcAddress(30),
        ),
        '21000',
      );
    const simulations = fixture.records.filter(
      (row) => row.method === 'eth_call' || row.method === 'eth_estimateGas',
    );
    assert.deepEqual(
      simulations.map((row) => (row.params[0] as { value: string }).value),
      ['0x0', '0x0', '0x1', '0x1'],
    );
    assert.ok(
      fixture.records
        .filter((row) => row.method === 'eth_getBlockByNumber' && row.params[0] !== 'latest')
        .every((row) => row.params[0] === '0x5'),
    );
  } finally {
    await fixture.close();
  }
});

test('signing policy retries wrapped eth_call lag at the same block and stops on real failures', async () => {
  for (const variant of ['transient', 'persistent', 'revert', 'other']) {
    const fixture = await rpcFixture();
    try {
      fixture.state.callFailures = variant === 'transient' ? 1 : 100;
      if (variant === 'revert') {
        fixture.state.errorCode = 3;
        fixture.state.errorMessage = 'execution reverted';
      } else if (variant === 'other') {
        fixture.state.errorMessage = 'upstream unavailable';
      }
      if (variant === 'transient') {
        const policy = await fixture.chain.signingPolicy();
        assert.equal(policy.claimEpoch, '1');
        assert.equal(policy.claimSigner, rpcAddress(32));
        assert.equal(policy.quoteSigner, rpcAddress(31));
        assert.equal(policy.claimsOpened, true);
      } else {
        await assert.rejects(fixture.chain.signingPolicy());
      }
      const selector = rpcAbi.getFunction('claimEpoch')!.selector;
      const reads = fixture.records.filter(
        (row) => row.method === 'eth_call' && (row.params[0] as { data: string }).data === selector,
      );
      assert.equal(reads.length, variant === 'transient' ? 2 : variant === 'persistent' ? 3 : 1);
      assert.ok(reads.every((row) => row.params[1] === '0x5'));
      assert.ok(fixture.records.every((row) => !row.method.startsWith('eth_send')));
    } finally {
      await fixture.close();
    }
  }
});

test('market RPC retry is bounded and never bypasses runtime identity, revert or network checks', async () => {
  for (const variant of ['persistent', 'revert', 'runtime', 'network']) {
    const fixture = await rpcFixture();
    try {
      if (variant === 'persistent' || variant === 'revert') fixture.state.codeFailures = 100;
      if (variant === 'revert') {
        fixture.state.errorCode = 3;
        fixture.state.errorMessage = 'execution reverted';
      }
      if (variant === 'runtime') fixture.state.code = '0x60026000';
      if (variant === 'network') fixture.state.chainId = 1;
      await assert.rejects(
        fixture.chain.initialize(),
        variant === 'runtime'
          ? /RUNTIME_CODE_MISMATCH/
          : variant === 'network'
            ? /WRONG_CHAIN/
            : variant === 'revert'
              ? /execution reverted/
              : /unsupported block number/,
      );
      const reads = fixture.records.filter(
        (row) => row.method === 'eth_getCode' && row.params[0] === fixture.manifest.usdc,
      );
      assert.equal(reads.length, variant === 'persistent' ? 3 : variant === 'network' ? 0 : 1);
      assert.ok(reads.every((row) => row.params[1] === '0x5'));
      await assert.rejects(fixture.chain.snapshot(), /RPC_NOT_VERIFIED/);
    } finally {
      await fixture.close();
    }
  }
});

test('market RPC splits the entire inclusive log range without dropping filter fields or records', async () => {
  const fixture = await rpcFixture();
  try {
    const filter = {
      address: [fixture.manifest.poolFactory],
      topics: [rpcHash(20)],
      fromBlock: '0x5',
      toBlock: '0x131',
    };
    const logs = (await fixture.chain.provider.send('eth_getLogs', [filter])) as unknown[];
    assert.equal(logs.length, 4);
    const reads = fixture.records
      .filter((row) => row.method === 'eth_getLogs')
      .map((row) => row.params[0] as typeof filter);
    assert.deepEqual(
      reads.map((row) => [row.fromBlock, row.toBlock]),
      [
        ['0x5', '0x68'],
        ['0x69', '0xcc'],
        ['0xcd', '0x130'],
        ['0x131', '0x131'],
      ],
    );
    assert.ok(
      reads.every(
        (row) =>
          JSON.stringify(row.address) === JSON.stringify(filter.address) &&
          JSON.stringify(row.topics) === JSON.stringify(filter.topics),
      ),
    );
    assert.ok(fixture.batchSizes.every((size) => size <= 3));
    await assert.rejects(
      fixture.chain.provider.send('eth_getLogs', [{ ...filter, fromBlock: '0x6', toBlock: '0x5' }]),
      /INDEX_LOG_RANGE_LIMIT/,
    );
    await assert.rejects(
      fixture.chain.provider.send('eth_getLogs', [{ ...filter, toBlock: '0x7d5' }]),
      /INDEX_LOG_RANGE_LIMIT/,
    );
    fixture.state.logsPerRead = 25001;
    await assert.rejects(
      fixture.chain.provider.send('eth_getLogs', [{ ...filter, toBlock: '0xc8' }]),
      /INDEX_LOG_RESPONSE/,
    );
  } finally {
    await fixture.close();
  }
});

test('native reference checks both exchange timestamps and disagreement without price floating point', async () => {
  let primaryPrice = '3000.000001';
  let checkedPrice = '3000.000000';
  let sourceTime = 1000;
  let now = 1000;
  const fetcher = (async (url: string | URL | Request) => {
    const value = String(url).includes('coinbase')
      ? { price: primaryPrice, time: new Date(sourceTime * 1000).toISOString() }
      : { error: [], result: { XETHZUSD: [[checkedPrice, '1', sourceTime, 'b', 'm', '']], last: '1' } };
    return Response.json(value);
  }) as typeof fetch;
  const reference = new VerifiedEthReference({ fetcher, now: () => now });
  const initial = await reference.read();
  assert.equal(initial.priceRaw, '3000000001');
  assert.equal(initial.observedAt, 1000);
  now = 1031;
  await assert.rejects(reference.read(), /STALE_REFERENCE_PRICE/);
  sourceTime = now;
  primaryPrice = '3000';
  checkedPrice = '3060.000001';
  await assert.rejects(reference.read(), /REFERENCE_PRICE_DEVIATION/);
  checkedPrice = '3060';
  assert.equal((await reference.read()).deviationBps, 200);
  now = 1040;
  sourceTime = 1041;
  await assert.rejects(reference.read(), /STALE_REFERENCE_PRICE/);
  assert.equal(priceToRaw('0.000001'), 1n);
  assert.throws(() => priceToRaw('1e6'), /INVALID_REFERENCE_PRICE/);
  assert.throws(() => priceToRaw('0'), /INVALID_REFERENCE_PRICE/);
});

test('reference outage and oversized payload never produce a new native quotation', async () => {
  await assert.rejects(
    new VerifiedEthReference({
      fetcher: (async () => new Response('', { status: 503 })) as typeof fetch,
    }).read(),
    /REFERENCE_UNAVAILABLE/,
  );
  await assert.rejects(
    new VerifiedEthReference({
      fetcher: (async () => new Response(' '.repeat(262145))) as typeof fetch,
    }).read(),
    /REFERENCE_RESPONSE_TOO_LARGE/,
  );
});

test('existing verified session bridge rejects native/demo users, revoked identity and CSRF forgery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-verified-session-'));
  const file = join(dir, 'access.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE whitelist(email TEXT PRIMARY KEY);
    CREATE TABLE identities(email TEXT PRIMARY KEY,subject TEXT UNIQUE);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,email TEXT,subject TEXT,csrf_token TEXT,expires_at INTEGER);
    CREATE TABLE revoked_sessions(token_hash TEXT PRIMARY KEY,expires_at INTEGER);`);
  const token = 'A'.repeat(43);
  const hash = createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO whitelist VALUES (?)').run('alice@example.test');
  db.prepare('INSERT INTO identities VALUES (?,?)').run('alice@example.test', 'verified-google-subject');
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(
    hash,
    'alice@example.test',
    'verified-google-subject',
    'server-csrf',
    1100,
  );
  const bridge = new AccessIdentityBridge(file, () => 1000);
  const request = (method: string, cookies: Record<string, string>, headers = {}) =>
    ({ method, cookies, headers }) as FastifyRequest;
  try {
    assert.equal(bridge.identity(request('GET', { qp_demo: 'alice' })), null);
    assert.equal(bridge.identity(request('GET', { '__Host-ikol_session': token }))?.verified, true);
    assert.equal(
      bridge.identity(request('POST', { '__Host-ikol_session': token }, { 'x-csrf-token': 'wrong' })),
      null,
    );
    assert.equal(
      bridge.identity(request('POST', { '__Host-ikol_session': token }, { 'x-csrf-token': 'server-csrf' }))
        ?.subject,
      'verified-google-subject',
    );
    db.prepare('INSERT INTO revoked_sessions VALUES (?,?)').run(hash, 1100);
    assert.equal(bridge.identity(request('GET', { '__Host-ikol_session': token })), null);
    db.prepare('DELETE FROM revoked_sessions').run();
    db.prepare('UPDATE identities SET subject=?').run('changed-subject');
    assert.equal(bridge.identity(request('GET', { '__Host-ikol_session': token })), null);
  } finally {
    bridge.close();
    db.close();
    rmSync(dir, { recursive: true });
  }
});
