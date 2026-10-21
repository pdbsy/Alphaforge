import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Wallet, verifyTypedData } from 'ethers';
import { LaunchMarketStore } from '../packages/launch-market/src/store.ts';
import { LaunchMarketService } from '../packages/launch-market/src/service.ts';
import {
  nativeQuoteTypes,
  claimVoucherTypes,
  marketInterfaces,
  validateQuoteTransaction,
} from '../packages/launch-market/src/abi.ts';
import { registerLaunchMarketRoutes } from '../apps/server/src/launch-market/routes.ts';
import {
  LaunchMarketError,
  type LaunchMarketManifest,
  type MarketSnapshot,
  type MarketWalletSnapshot,
  type QuoteRequest,
  type TrustedEmailIdentity,
} from '../packages/launch-market/src/types.ts';
import type {
  MarketChain,
  ObservedMarketReceipt,
  ObservedMarketTransaction,
} from '../packages/launch-market/src/chain.ts';
import { ammQuote } from '../packages/launch-market/src/math.ts';

const h = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const a = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const manifest: LaunchMarketManifest = {
  schemaVersion: 1,
  chainId: 46630,
  deploymentBlock: '1',
  usdc: a(1),
  claim: a(2),
  conversionReserve: a(3),
  router: a(4),
  poolFactory: a(5),
  vaultFactory: null,
  strategies: {
    TSLA: { pass: a(6), launch: a(7), pool: null, lpRecipient: a(20) },
    AMZN: { pass: a(8), launch: null, pool: a(9), lpRecipient: a(21) },
  },
  runtimeCodeHashes: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [a(n), h(42)])),
};
function snapshot(block = 10): MarketSnapshot {
  const base = {
    state: 'LAUNCHED' as const,
    pass: a(8),
    totalSupplyRaw: '1000000000000000000000000',
    publicSupplyRaw: '0',
    soldRaw: '0',
    remainingRaw: '0',
    mintPriceUsdcRaw: '500000',
    lpPassRaw: '500000000000000000000000',
    lpUsdcRaw: '250000000000',
    pool: a(9),
    reservePassRaw: '500000000000000000000000',
    reserveUsdcRaw: '250000000000',
    ammFeeBps: 30,
  };
  return {
    location: {
      chainId: 46630,
      blockNumber: String(block),
      blockHash: h(block),
      transactionHash: null,
      logIndex: null,
      version: '0',
      confirmations: 1,
    },
    markets: {
      TSLA: {
        ...base,
        pass: a(6),
        state: 'MINTING',
        pool: null,
        reservePassRaw: '0',
        reserveUsdcRaw: '0',
        publicSupplyRaw: '500000000000000000000000',
        remainingRaw: '500000000000000000000000',
      },
      AMZN: base,
    },
    claim: {
      amountUsdcRaw: '1000000000',
      successfulClaims: 0,
      maxClaims: 100,
      remainingClaims: 100,
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
/** Explicit unit-test RPC fixture; runtime code has no fake chain implementation. */
class ChainFixture implements MarketChain {
  current = snapshot();
  allowanceRequired = false;
  simulationFailure = false;
  simulations = 0;
  observedTransaction: ObservedMarketTransaction | null = null;
  observedReceipt: ObservedMarketReceipt | null = null;
  readonly owner: string;
  readonly issuer: Wallet;
  constructor(owner: string, issuer: Wallet) {
    this.owner = owner.toLowerCase();
    this.issuer = issuer;
  }
  async snapshot() {
    return this.current;
  }
  async wallet(owner: string): Promise<MarketWalletSnapshot> {
    return {
      owner: owner.toLowerCase(),
      accountId: null,
      location: this.current.location,
      ethBalanceRaw: '100000000000000000000',
      usdcBalanceRaw: '1000000000000',
      passes: {
        TSLA: {
          balanceRaw: '1000000000000000000000',
          availableRaw: '1000000000000000000000',
          lockedRaw: '0',
        },
        AMZN: {
          balanceRaw: '1000000000000000000000',
          availableRaw: '1000000000000000000000',
          lockedRaw: '0',
        },
      },
      vaults: [],
    };
  }
  async quoteAmm(strategy: 'TSLA' | 'AMZN', side: 'BUY' | 'SELL', amountRaw: string) {
    const market = this.current.markets[strategy];
    const result = ammQuote(
      BigInt(amountRaw),
      BigInt(side === 'BUY' ? market.reserveUsdcRaw : market.reservePassRaw),
      BigInt(side === 'BUY' ? market.reservePassRaw : market.reserveUsdcRaw),
      30,
    );
    return { outputRaw: result.output.toString(), feeRaw: result.fee.toString() };
  }
  async simulate() {
    this.simulations++;
    if (this.allowanceRequired) throw new LaunchMarketError('ALLOWANCE_REQUIRED');
    if (this.simulationFailure) throw new LaunchMarketError('EXECUTION_REVERTED');
    return '500000';
  }
  async transaction() {
    return this.observedTransaction;
  }
  async receipt() {
    return this.observedReceipt;
  }
  async canonicalBlockHash(blockNumber: string) {
    return h(Number(blockNumber));
  }
  async signingPolicy() {
    return {
      quoteSigner: this.issuer.address,
      claimSigner: this.issuer.address,
      quoteEpoch: '1',
      claimEpoch: '1',
      claimsOpened: true,
    };
  }
}
async function fixture({ indexedSnapshots = false } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'alphaforge-launch-service-')),
    store = new LaunchMarketStore(join(folder, 'market.sqlite'), 'https://www.ikol.top');
  const owner = new Wallet(h(10)),
    issuer = new Wallet(h(11)),
    identity: TrustedEmailIdentity = {
      email: 'alice@example.test',
      subject: 'google:alice',
      emailVerified: true,
    },
    account = store.trustedAccount(identity, 1000);
  const challenge = store.bindingChallenge(account.id, owner.address, 1000);
  store.bindWallet(account.id, challenge.nonce, await owner.signMessage(challenge.message), 1000);
  const chain = new ChainFixture(owner.address, issuer),
    clock = { now: 1000 },
    reference = { ethUsdPriceRaw: '2000000000', observedAt: 1000 };
  const service = new LaunchMarketService({
    indexedSnapshots,
    manifest,
    store,
    chain,
    ethReference: {
      async read() {
        return reference;
      },
    },
    quoteSigner: issuer,
    claimSigner: issuer,
    now: () => clock.now,
  });
  const request: QuoteRequest = {
    owner: owner.address,
    strategyId: 'AMZN',
    operation: 'BUY',
    asset: 'ETH',
    amountRaw: '1000000000000000000',
    slippageBps: 100,
  };
  return {
    store,
    owner,
    issuer,
    identity,
    account,
    chain,
    clock,
    reference,
    service,
    request,
    close() {
      service.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
test('wallet projection exposes account linkage only for the genuinely bound wallet', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service.wallet(f.owner.address, f.account.id)).accountId, f.account.id);
    assert.equal((await f.service.wallet(Wallet.createRandom().address, f.account.id)).accountId, null);
    f.store.db.prepare('UPDATE market_accounts SET wallet=NULL WHERE id=?').run(f.account.id);
    assert.equal((await f.service.wallet(f.owner.address, f.account.id)).accountId, null);
  } finally {
    f.close();
  }
});
test('missing deployment never serves a sample market or prepares transactions', async () => {
  const f = await fixture();
  try {
    const service = new LaunchMarketService({ ...f.service.options, manifest: null, chain: null });
    assert.equal(service.config().deployment, 'NOT_DEPLOYED');
    await assert.rejects(service.snapshot(), /NOT_DEPLOYED/);
    await assert.rejects(service.quote(f.request, f.account.id), /NOT_DEPLOYED/);
  } finally {
    f.close();
  }
});
test('native quote binds account, chain, canonical quote, expiry and exact wallet calldata', async () => {
  const f = await fixture();
  try {
    const quote = await f.service.quote(f.request, f.account.id);
    assert.equal(quote.asset, 'ETH');
    assert.equal(quote.transaction.value, f.request.amountRaw);
    assert.equal(quote.simulation, 'READY');
    assert.equal(quote.gasEstimateRaw, '500000');
    const parsed = marketInterfaces.router.parseTransaction({ data: quote.transaction.data })!,
      native = parsed.args[0];
    assert.equal(native.accountId, f.account.accountKey);
    assert.equal(Number(native.operation), 1);
    assert.equal(native.payer.toLowerCase(), f.owner.address.toLowerCase());
    assert.equal(native.ethUsdPrice, 2000000000n);
    const fields = Object.fromEntries(
      nativeQuoteTypes.NativeQuote.map((field, index) => [field.name, native[index]]),
    );
    assert.equal(
      verifyTypedData(
        {
          name: 'AlphaForge Native Conversion',
          version: '1',
          chainId: 46630,
          verifyingContract: manifest.conversionReserve,
        },
        nativeQuoteTypes,
        fields,
        String(parsed.args[1]),
      ),
      f.issuer.address,
    );
    assert.throws(
      () =>
        validateQuoteTransaction(
          { ...quote, transaction: { ...quote.transaction, value: '1' } },
          manifest,
          f.chain.current,
        ),
      /QUOTE_TRANSACTION_MISMATCH/,
    );
    assert.throws(
      () =>
        validateQuoteTransaction(
          { ...quote, reference: { ethUsdPriceRaw: '1', observedAt: 1000 } },
          manifest,
          f.chain.current,
        ),
      /QUOTE_TRANSACTION_MISMATCH/,
    );
    await assert.rejects(
      f.service.quote({ ...f.request, owner: new Wallet(h(21)).address }, f.account.id),
      /LINKED_WALLET_REQUIRED/,
    );
  } finally {
    f.close();
  }
});
test('a reorg after the last RPC read never publishes a non-canonical market head', async () => {
  const f = await fixture();
  try {
    f.chain.current = { ...f.chain.current, location: { ...f.chain.current.location, blockHash: h(999) } };
    await assert.rejects(f.service.snapshot(), /NON_CANONICAL_MARKET_HEAD/);
    assert.equal(f.service.projector.latest(), null);
  } finally {
    f.close();
  }
});
test('new native quotes reject stale/future references and unavailable ETH sales leave AF-USDC path open', async () => {
  const f = await fixture();
  try {
    f.reference.observedAt = 969;
    await assert.rejects(f.service.quote(f.request, f.account.id), /ETH_REFERENCE_STALE/);
    f.reference.observedAt = 1001;
    await assert.rejects(f.service.quote(f.request, f.account.id), /ETH_REFERENCE_STALE/);
    f.reference.observedAt = 1000;
    f.chain.current = {
      ...f.chain.current,
      conversion: {
        ...f.chain.current.conversion,
        ethSellAvailable: false,
        ethBuyAvailable: false,
        usdcReserveRaw: '0',
      },
    };
    await assert.rejects(
      f.service.quote({ ...f.request, operation: 'SELL' }, f.account.id),
      /ETH_PATH_UNAVAILABLE/,
    );
    const usdc = await f.service.quote({ ...f.request, operation: 'SELL', asset: 'AF_USDC' }, f.account.id);
    assert.equal(usdc.transaction.value, '0');
    assert.ok(BigInt(usdc.estimatedOutRaw) > 0n);
    const nativeMint = await f.service.quote(
      { ...f.request, strategyId: 'TSLA', operation: 'MINT' },
      f.account.id,
    );
    assert.equal(nativeMint.estimatedOutRaw, f.request.amountRaw);
    assert.equal(nativeMint.transaction.value, '250000000000000');
  } finally {
    f.close();
  }
});
test('approval deficit is explicit and other simulation failures never create executable quotes', async () => {
  const f = await fixture();
  try {
    f.chain.allowanceRequired = true;
    const quote = await f.service.quote(
      { ...f.request, asset: 'AF_USDC', amountRaw: '1000000' },
      f.account.id,
    );
    assert.equal(quote.simulation, 'APPROVAL_REQUIRED');
    assert.equal(quote.gasEstimateRaw, null);
    assert.equal(quote.allowance!.amountRaw, '1000000');
    assert.throws(
      () =>
        validateQuoteTransaction(
          { ...quote, allowance: { ...quote.allowance!, amountRaw: '100000000000000000000' } },
          manifest,
          f.chain.current,
        ),
      /QUOTE_TRANSACTION_MISMATCH/,
    );
    f.chain.allowanceRequired = false;
    const approved = await f.service.quote(
      { ...f.request, asset: 'AF_USDC', amountRaw: '1000000' },
      f.account.id,
    );
    assert.equal(approved.simulation, 'READY');
    assert.equal(approved.allowance, null);
    assert.ok(approved.gasEstimateRaw);
    f.chain.simulationFailure = true;
    await assert.rejects(
      f.service.quote({ ...f.request, asset: 'AF_USDC', amountRaw: '1000000' }, f.account.id),
      /EXECUTION_REVERTED/,
    );
  } finally {
    f.close();
  }
});
test('Mint precision and final inventory are checked before signing; native amount stays separate from PASS input', async () => {
  const f = await fixture();
  try {
    const mint = { ...f.request, strategyId: 'TSLA' as const, operation: 'MINT' as const };
    await assert.rejects(f.service.quote({ ...mint, amountRaw: '1' }, f.account.id), /MINT_PRECISION/);
    await assert.rejects(
      f.service.quote({ ...mint, amountRaw: '500001000000000000000000' }, f.account.id),
      /OVERSELL/,
    );
    const quote = await f.service.quote({ ...mint, asset: 'AF_USDC' }, f.account.id);
    assert.equal(quote.amountInRaw, mint.amountRaw);
    assert.equal(quote.estimatedOutRaw, mint.amountRaw);
    assert.equal(quote.allowance, null);
    f.chain.current = {
      ...f.chain.current,
      markets: {
        ...f.chain.current.markets,
        TSLA: {
          ...f.chain.current.markets.TSLA,
          state: 'LAUNCHED',
          remainingRaw: '0',
          soldRaw: '500000000000000000000000',
          pool: a(30),
        },
      },
    };
    await assert.rejects(f.service.quote(mint, f.account.id), /MINT_NOT_OPEN/);
  } finally {
    f.close();
  }
});
test('claim quote has one durable voucher across concurrent preparations and exact EIP712 payout identity', async () => {
  const f = await fixture();
  try {
    const request = { ...f.request, operation: 'CLAIM' as const, amountRaw: '0' };
    const [first, second] = await Promise.all([
      f.service.quote(request, f.account.id),
      f.service.quote(request, f.account.id),
    ]);
    const a = marketInterfaces.claim.parseTransaction({ data: first.transaction.data })!,
      b = marketInterfaces.claim.parseTransaction({ data: second.transaction.data })!;
    assert.equal(a.args[0].nonce, b.args[0].nonce);
    assert.equal(first.estimatedOutRaw, '1000000000');
    assert.equal(first.allowance, null);
    const fields = Object.fromEntries(
      claimVoucherTypes.ClaimVoucher.map((field, index) => [field.name, a.args[0][index]]),
    );
    assert.equal(
      verifyTypedData(
        { name: 'AlphaForge Free AF-USDC', version: '1', chainId: 46630, verifyingContract: manifest.claim },
        claimVoucherTypes,
        fields,
        String(a.args[1]),
      ),
      f.issuer.address,
    );
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM market_claim_vouchers').get()!.n, 1);
  } finally {
    f.close();
  }
});
test('submission validates actual from/to/data/value and inclusion stays pending until three L2 blocks', async () => {
  const f = await fixture();
  try {
    const quote = await f.service.quote(f.request, f.account.id),
      txHash = h(200);
    f.chain.observedTransaction = {
      ...quote.transaction,
      hash: txHash,
      from: f.owner.address,
      chainId: 46630,
    };
    const operation = await f.service.submit(f.account.id, quote.id, txHash, f.owner.address);
    assert.equal(operation.state, 'SUBMITTED');
    assert.equal(f.store.operations(f.account.id, f.owner.address)[0]!.id, operation.id);
    assert.equal(f.store.operations(f.account.id, new Wallet(h(22)).address).length, 0);
    const bob = f.store.trustedAccount(
      { email: 'bob@example.test', subject: 'google:bob', emailVerified: true },
      1000,
    );
    assert.equal(f.store.operations(bob.id, f.owner.address).length, 0);
    assert.equal((await f.service.submit(f.account.id, quote.id, txHash, f.owner.address)).id, operation.id);
    f.chain.observedTransaction = { ...f.chain.observedTransaction, value: '1' };
    await assert.rejects(
      f.service.submit(f.account.id, quote.id, txHash, f.owner.address),
      /TRANSACTION_MISMATCH/,
    );
    f.chain.observedReceipt = {
      transactionHash: txHash,
      blockNumber: '10',
      blockHash: h(10),
      status: 'SUCCESS',
    };
    assert.equal((await f.service.operation(f.account.id, operation.id)).state, 'INCLUDED');
    f.chain.current = snapshot(11);
    assert.equal((await f.service.operation(f.account.id, operation.id)).confirmations, 2);
    f.chain.current = snapshot(12);
    assert.equal((await f.service.operation(f.account.id, operation.id)).state, 'COMPLETED');
    f.chain.observedReceipt = null;
    assert.equal((await f.service.operation(f.account.id, operation.id)).state, 'REORGED');
  } finally {
    f.close();
  }
});
test('HTTP routes reject browser-provided email verification and require a trusted session for signatures', async () => {
  const f = await fixture(),
    app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  try {
    registerLaunchMarketRoutes(app, { service: f.service, trustedIdentity: () => null });
    const publicConfig = await app.inject({ method: 'GET', url: '/api/launch-market/config' });
    assert.equal(publicConfig.statusCode, 200);
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/launch-market/wallet/challenge',
      payload: { owner: f.owner.address },
    });
    assert.equal(unauthorized.statusCode, 401);
    const forged = await app.inject({
      method: 'POST',
      url: '/api/launch-market/wallet/challenge',
      payload: { owner: f.owner.address, emailVerified: true, email: 'alice@example.test' },
    });
    assert.equal(forged.statusCode, 400);
    const unauthorizedQuote = await app.inject({
      method: 'POST',
      url: '/api/launch-market/quote',
      payload: f.request,
    });
    assert.equal(unauthorizedQuote.statusCode, 401);
  } finally {
    await app.close();
    f.close();
  }
});

test('wallet test HTTP session requires proof and CSRF, and selects one account across old Google cookies', async () => {
  const f = await fixture(),
    app = Fastify(),
    wallet = new Wallet(h(12));
  let required = false;
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) =>
    error instanceof LaunchMarketError
      ? reply.code(error.statusCode).send({ error: { code: error.code } })
      : reply.code(503).send({ error: { code: 'UNAVAILABLE' } }),
  );
  registerLaunchMarketRoutes(app, {
    service: f.service,
    verificationRequired: () => required,
    trustedIdentity: (request) =>
      request.cookies['__Host-ikol_session'] === 'unit-google-session' &&
      (request.method === 'GET' || request.headers['x-csrf-token'] === 'unit-google-csrf')
        ? f.identity
        : null,
  });
  const origin = 'https://www.ikol.top';
  try {
    assert.equal((await app.inject('/api/launch-market/config')).json().emailVerificationRequired, false);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/launch-market/wallet/test-challenge',
          headers: { origin: 'https://wrong-origin.test' },
          payload: { owner: wallet.address },
        })
      ).statusCode,
      403,
    );
    const challenge = (
      await app.inject({
        method: 'POST',
        url: '/api/launch-market/wallet/test-challenge',
        headers: { origin },
        payload: { owner: wallet.address },
      })
    ).json();
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM market_accounts').get()?.n, 1);
    const signed = await wallet.signMessage(challenge.message);
    const opened = await app.inject({
      method: 'POST',
      url: '/api/launch-market/wallet/test-session',
      headers: { origin },
      payload: { nonce: challenge.nonce, signature: signed },
    });
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.json().emailVerified, false);
    assert.equal(opened.json().identityKind, 'WALLET_TEST');
    assert.match(String(opened.headers['set-cookie']), /HttpOnly/);
    assert.match(String(opened.headers['set-cookie']), /Secure/);
    assert.match(String(opened.headers['set-cookie']), /SameSite=Strict/);
    const sessionCookie = String(opened.headers['set-cookie']).split(';')[0]!;
    const mixedCookie = sessionCookie + '; __Host-ikol_session=unit-google-session';
    const csrfToken = (
      await app.inject({ url: '/api/launch-market/wallet/test-session', headers: { cookie: mixedCookie } })
    ).json().csrfToken;
    const account = (
      await app.inject({ url: '/api/launch-market/account', headers: { cookie: mixedCookie } })
    ).json();
    assert.equal(account.id, opened.json().id);
    assert.equal(account.emailVerified, false);
    assert.equal(account.claimStatus, 'ELIGIBLE');
    assert.equal(
      (
        await app.inject({
          url: '/api/launch-market/wallet?owner=' + wallet.address,
          headers: { cookie: mixedCookie },
        })
      ).json().accountId,
      account.id,
    );
    const request = { ...f.request, owner: wallet.address, amountRaw: '10000000000000' };
    for (const csrf of [undefined, 'unit-google-csrf', 'wrong']) {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/launch-market/quote',
            headers: { origin, cookie: mixedCookie, ...(csrf ? { 'x-csrf-token': csrf } : {}) },
            payload: request,
          })
        ).statusCode,
        401,
      );
    }
    const quote = await app.inject({
      method: 'POST',
      url: '/api/launch-market/quote',
      headers: { origin, cookie: mixedCookie, 'x-csrf-token': csrfToken },
      payload: request,
    });
    assert.equal(quote.statusCode, 200, quote.body);
    assert.equal(f.store.quote(quote.json().id, account.id).owner, wallet.address.toLowerCase());
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/launch-market/wallet/test-session',
          headers: { origin },
          payload: { nonce: challenge.nonce, signature: signed },
        })
      ).statusCode,
      401,
    );
    required = true;
    assert.equal((await app.inject('/api/launch-market/config')).json().emailVerificationRequired, true);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/launch-market/wallet/test-challenge',
          headers: { origin },
          payload: { owner: wallet.address },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ url: '/api/launch-market/wallet/test-session', headers: { cookie: mixedCookie } }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/launch-market/quote',
          headers: { origin, cookie: sessionCookie, 'x-csrf-token': csrfToken },
          payload: request,
        })
      ).statusCode,
      401,
    );
    // Verified Google access is restored; the unverified session never becomes a verified identity.
    const restored = (
      await app.inject({ url: '/api/launch-market/account', headers: { cookie: mixedCookie } })
    ).json();
    assert.equal(restored.id, f.account.id);
    assert.equal(restored.emailVerified, true);
    assert.equal(restored.identityKind, 'GOOGLE');
    const googleQuote = await app.inject({
      method: 'POST',
      url: '/api/launch-market/quote',
      headers: { origin, cookie: mixedCookie, 'x-csrf-token': 'unit-google-csrf' },
      payload: f.request,
    });
    assert.equal(googleQuote.statusCode, 200, googleQuote.body);
  } finally {
    await app.close();
    f.close();
  }
});

test('unavailable trusted policy keeps wallet test login and existing test credentials unauthorized', async () => {
  const f = await fixture(),
    app = Fastify();
  await app.register(cookie);
  registerLaunchMarketRoutes(app, {
    service: f.service,
    trustedIdentity: () => null,
    verificationRequired: () => {
      throw new Error('UNIT_POLICY_OFFLINE');
    },
  });
  try {
    assert.equal((await app.inject('/api/launch-market/config')).json().emailVerificationRequired, true);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/launch-market/wallet/test-challenge',
          headers: { origin: 'https://www.ikol.top' },
          payload: { owner: f.owner.address },
        })
      ).statusCode,
      401,
    );
    assert.equal((await app.inject('/api/launch-market/wallet/test-session')).statusCode, 401);
  } finally {
    await app.close();
    f.close();
  }
});

for (const directHead of [true, false])
  test(`transaction confirmation uses fresh canonical head while indexed history lags: directHead=${directHead}`, async () => {
    const f = await fixture({ indexedSnapshots: true });
    try {
      const quote = await f.service.quote(f.request, f.account.id),
        txHash = h(201);
      f.chain.observedTransaction = {
        ...quote.transaction,
        hash: txHash,
        from: f.owner.address,
        chainId: 46630,
      };
      const operation = await f.service.submit(f.account.id, quote.id, txHash, f.owner.address);
      f.service.publish(snapshot(8), h(7), null);
      f.chain.observedReceipt = {
        transactionHash: txHash,
        blockNumber: '10',
        blockHash: h(10),
        status: 'SUCCESS',
      };
      const chain: MarketChain = f.chain;
      if (directHead)
        chain.head = async () => ({
          number: '0x' + BigInt(f.chain.current.location.blockNumber).toString(16),
          hash: f.chain.current.location.blockHash,
        });
      f.chain.current = snapshot(11);
      assert.equal((await f.service.operation(f.account.id, operation.id)).confirmations, 2);
      f.chain.current = snapshot(12);
      const completed = await f.service.operation(f.account.id, operation.id);
      assert.equal(completed.state, 'COMPLETED');
      assert.equal(completed.confirmations, 3);
      assert.equal(completed.location!.blockNumber, '10');
      assert.equal(
        (await f.service.snapshot()).location.blockNumber,
        '8',
        'receipt checks never advance the event scanner',
      );
      if (directHead) {
        chain.head = async () => ({ number: '0xc', hash: h(999) });
        await assert.rejects(f.service.operation(f.account.id, operation.id), /NON_CANONICAL_MARKET_HEAD/);
        chain.head = async () => ({ number: '0xc', hash: h(12) });
      }
      f.chain.observedReceipt = { ...f.chain.observedReceipt, blockHash: h(999) };
      assert.equal((await f.service.operation(f.account.id, operation.id)).state, 'REORGED');
      f.chain.observedReceipt = { ...f.chain.observedReceipt, blockHash: h(10), status: 'REVERTED' };
      assert.equal((await f.service.operation(f.account.id, operation.id)).state, 'REVERTED');
    } finally {
      f.close();
    }
  });
