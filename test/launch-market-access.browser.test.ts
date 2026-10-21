import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Interface, Wallet, ZeroAddress, keccak256, verifyMessage } from 'ethers';
import { fixture, HASH, BLOCK, location as chainLocation } from './helpers/launch-market-ui-fixture.ts';
import { marketInterfaces } from '../packages/launch-market/src/abi.ts';
import { executorInterface } from '../apps/web/src/launch-market/executor.ts';
import { stockExecutionInterface } from '../apps/web/src/launch-market/stock-execution.ts';
import type { MarketQuote, VaultSnapshot, QuoteRequest } from '../packages/launch-market/src/types.ts';

const browserPackage =
  process.env.AF_UI_BROWSER_PACKAGE ??
  '/opt/alphaforge/mock-source/.checks/release-browser-tools/package/index.mjs';
const browserBinary =
  process.env.CHROMIUM_PATH ?? '/opt/alphaforge/mock-browser-cache/chromium-1234/chrome-linux64/chrome';
const available = await Promise.all([
  stat(browserPackage).catch(() => null),
  stat(browserBinary).catch(() => null),
]);
const VAULT = '0x3333333333333333333333333333333333333333';
const STOCK = '0x4444444444444444444444444444444444444444';
const RESERVE = '0x5555555555555555555555555555555555555555';
const FEED = '0x6666666666666666666666666666666666666666';
const CODE = '0x60006000';
const ZERO_HASH = `0x${'00'.repeat(32)}`;
const factory = new Interface([
  'function vaults(address,uint8) view returns(address)',
  'function strategy(uint8) view returns(tuple(address creator,address pass,address usdc,address targetStock,address otherStock,address stockReserve,address referenceFeed,bytes32 strategyRef,uint32 maxPriceAge))',
]);
const venue = new Interface([
  'function usdc() view returns(address)',
  'function stock() view returns(address)',
  'function feed() view returns(address)',
  'function maxPriceAge() view returns(uint32)',
  'function paused() view returns(bool)',
]);
const feed = new Interface([
  'function price() view returns(uint256,uint64,bytes32)',
  'function regularOpen() view returns(uint64)',
  'function regularClose() view returns(uint64)',
  'function calendarObservedAt() view returns(uint64)',
  'function calendarDigest() view returns(bytes32)',
  'function executionAllowed() view returns(bool)',
]);
const token = new Interface(['function balanceOf(address) view returns(uint256)']);

function vault(strategyId: 'TSLA' | 'AMZN'): VaultSnapshot {
  return {
    strategyId,
    address: VAULT,
    principalBasisRaw: '10000000',
    equityRaw: '10000000',
    cashRaw: '10000000',
    lockedPassRaw: '10000000000000000000',
    realizedPnlRaw: '0',
    unrealizedPnlRaw: '0',
    valuationState: 'FRESH',
    withdrawableProfitRaw: '0',
    withdrawablePrincipalRaw: '10000000',
    status: 'OPEN',
    holdings: [],
  };
}

// Built product SPA, isolated HTTP/RPC fixtures. The only signature allowed is an explicit
// ownership message by a fresh test wallet; every asset signature and chain broadcast is refused.
test(
  'wallet session access, selected Use PASS and owner stock review require explicit user actions',
  {
    skip: available.some((entry) => !entry) ? 'NOT_RUN: qualified local browser tools unavailable' : false,
    timeout: 60_000,
  },
  async (t) => {
    const { chromium } = await import(pathToFileURL(browserPackage).href);
    const testWallet = Wallet.createRandom();
    const owner = testWallet.address.toLowerCase();
    let f = fixture();
    let session = false;
    let challenge: { nonce: string; message: string; expiresAt: number } | null = null;
    const writes: string[] = [];
    const reviewed: QuoteRequest[] = [];
    const streams = new Set<ServerResponse>();
    const webRoot = resolve('apps/web/dist');
    const reset = (authenticated: boolean) => {
      f = fixture();
      session = authenticated;
      writes.length = 0;
      reviewed.length = 0;
      challenge = null;
      f.state.config = { ...f.state.config, emailVerificationRequired: false };
      f.state.account = {
        ...f.state.account!,
        wallet: owner,
        emailVerified: false,
        identityKind: 'WALLET_TEST',
      };
      f.state.wallet = {
        ...f.state.wallet,
        owner,
        accountId: authenticated ? f.state.account.id : null,
        usdcBalanceRaw: '1100000500000',
      };
      f.state.snapshot = {
        ...f.state.snapshot,
        markets: {
          ...f.state.snapshot.markets,
          TSLA: {
            ...f.state.snapshot.markets.TSLA,
            remainingRaw: String(400n * 10n ** 18n),
            soldRaw: String(499_600n * 10n ** 18n),
          },
        },
      };
      const cfg = f.state.config.manifest!;
      f.state.config = {
        ...f.state.config,
        manifest: {
          ...cfg,
          runtimeCodeHashes: Object.fromEntries(
            [...Object.keys(cfg.runtimeCodeHashes), STOCK, RESERVE, FEED].map((address) => [
              address.toLowerCase(),
              keccak256(CODE),
            ]),
          ),
        },
      };
    };
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      const json = (data: unknown, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(data));
      };
      try {
        if (url.pathname === '/api/session') return json({ scope: 'TEST_ONLY', user: null });
        if (url.pathname === '/auth/me') return json({ error: 'NO_GOOGLE_SESSION' }, 401);
        if (url.pathname === '/api/launch-market/events') {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.flushHeaders();
          streams.add(response);
          response.on('close', () => streams.delete(response));
          return;
        }
        if (url.pathname === '/api/launch-market/wallet/test-challenge' && request.method === 'POST') {
          writes.push(url.pathname);
          const now = Math.floor(Date.now() / 1000),
            origin = `http://${request.headers.host}`;
          const nonce = 'ab'.repeat(24),
            expiresAt = now + 300;
          challenge = {
            nonce,
            expiresAt,
            message: `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${owner}\n\nSign in to AlphaForge wallet-only mode. This proves control of this wallet; it does not verify an email, move assets or approve a transaction. Free credits are limited to one claim for this wallet and 100 claims in total.\n\nURI: ${origin}\nVersion: 1\nChain ID: 46630\nNonce: ${nonce}\nIssued At: ${new Date(now * 1000).toISOString()}\nExpiration Time: ${new Date(expiresAt * 1000).toISOString()}`,
          };
          return json(challenge);
        }
        if (url.pathname === '/api/launch-market/wallet/test-session') {
          if (request.method === 'POST') {
            writes.push(url.pathname);
            let raw = '';
            for await (const part of request) raw += String(part);
            const body = JSON.parse(raw) as { nonce: string; signature: string };
            assert.equal(body.nonce, challenge!.nonce);
            assert.equal(verifyMessage(challenge!.message, body.signature).toLowerCase(), owner);
            session = true;
            f.state.wallet = { ...f.state.wallet, accountId: f.state.account!.id };
            return json(f.state.account);
          }
          return session
            ? json({
                csrfToken: 'isolated-wallet-test-csrf-token',
                identityKind: 'WALLET_TEST',
                emailVerificationRequired: false,
              })
            : json({ error: 'MARKET_SESSION_REQUIRED' }, 401);
        }
        if (url.pathname === '/api/launch-market/account')
          return session ? json(f.state.account) : json({ error: 'MARKET_SESSION_REQUIRED' }, 401);
        if (url.pathname === '/api/launch-market/eth-reference') {
          const now = Math.floor(Date.now() / 1000);
          return json({ ethUsdPriceRaw: '2000000000', observedAt: now, validUntil: now + 30 });
        }
        if (url.pathname === '/api/launch-market/quote' && request.method === 'POST') {
          let raw = '';
          for await (const part of request) raw += String(part);
          const input = JSON.parse(raw) as QuoteRequest;
          reviewed.push(input);
          assert.equal(session, true);
          assert.equal(input.owner, owner);
          const expiresAt = Math.floor(Date.now() / 1000) + 60;
          const created = input.operation === 'CREATE_VAULT';
          assert.ok(created || input.operation === 'DEPOSIT');
          const result: MarketQuote = {
            id: `review_${reviewed.length}`,
            owner,
            strategyId: input.strategyId,
            operation: input.operation,
            asset: 'AF_USDC',
            amountInRaw: input.amountRaw,
            estimatedOutRaw: created ? '0' : input.amountRaw,
            minOutRaw: created ? '0' : input.amountRaw,
            feeUsdcRaw: '0',
            conversionFeeUsdcRaw: '0',
            priceImpactBps: 0,
            expiresAt,
            reference: null,
            transaction: {
              to: created ? f.state.config.manifest!.vaultFactory! : VAULT,
              data: created
                ? marketInterfaces.vaultFactory.encodeFunctionData('createVault', [
                    input.strategyId === 'TSLA' ? 0 : 1,
                  ])
                : marketInterfaces.vault.encodeFunctionData('deposit', [input.amountRaw]),
              value: '0',
            },
            allowance: null,
            gasEstimateRaw: '100000',
            simulation: 'READY',
            location: chainLocation(),
          };
          return json(result);
        }
        if (request.method !== 'GET') {
          writes.push(`REFUSED:${url.pathname}`);
          return json({ error: 'NO_ASSET_WRITES' }, 403);
        }
        if (['history', 'candles', 'holders'].some((name) => url.pathname.endsWith(`/${name}`)))
          return json({
            [url.pathname.split('/').at(-1)!]: [],
            location: chainLocation(),
            indexer: { state: 'HEALTHY' },
          });
        if (url.pathname.startsWith('/api/launch-market/'))
          return json(await f.api(url.pathname + url.search));
        const asset = url.pathname.replace(/^\/alphaforge(?=\/)/, '');
        const file = resolve(webRoot, `.${asset === '/' ? '/index.html' : asset}`);
        if (!file.startsWith(webRoot + sep)) throw new Error('Invalid asset path');
        response.setHeader(
          'content-type',
          (
            {
              '.html': 'text/html',
              '.js': 'text/javascript',
              '.css': 'text/css',
              '.svg': 'image/svg+xml',
            } as Record<string, string>
          )[extname(file)] ?? 'application/octet-stream',
        );
        response.end(await readFile(file));
      } catch (error) {
        json({ error: String(error) }, 404);
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({
      executablePath: browserBinary,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const open = async (route: string, authenticated = true) => {
      reset(authenticated);
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on('pageerror', (error: Error) => errors.push(error.message));
      await page.exposeFunction('signIsolatedOwnershipMessage', async (message: string) => {
        assert.equal(message, challenge!.message);
        assert.match(message, /does not verify an email, move assets or approve a transaction/);
        return testWallet.signMessage(message);
      });
      await page.addInitScript(
        ({ owner, code, blockHash }: { owner: string; code: string; blockHash: string }) => {
          const control = { calls: [] as string[], responses: {} as Record<string, string> };
          Object.assign(window, {
            accessWalletFixture: control,
            ethereum: {
              request: async ({ method, params }: { method: string; params?: unknown[] }) => {
                control.calls.push(method);
                if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [owner];
                if (method === 'eth_chainId') return '0xb626';
                if (method === 'personal_sign') {
                  const encoded = String(params![0]).slice(2);
                  const message = new TextDecoder().decode(
                    Uint8Array.from(encoded.match(/../g)!.map((hex) => parseInt(hex, 16))),
                  );
                  return (
                    window as unknown as {
                      signIsolatedOwnershipMessage: (message: string) => Promise<string>;
                    }
                  ).signIsolatedOwnershipMessage(message);
                }
                if (method === 'eth_getBlockByNumber')
                  return {
                    number: '0x64',
                    hash: blockHash,
                    timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
                  };
                if (method === 'eth_getCode') return code;
                if (method === 'eth_estimateGas') return '0x186a0';
                if (method === 'eth_call') {
                  const tx = params![0] as { to: string; data: string };
                  const result = control.responses[`${tx.to.toLowerCase()}:${tx.data}`];
                  if (result !== undefined) return result;
                  if (params![1] === 'latest') return '0x';
                  throw new Error(`Unknown isolated RPC read ${tx.to}:${tx.data}`);
                }
                throw new Error(`Isolated wallet refuses ${method}`);
              },
              on: () => {},
              removeListener: () => {},
            },
          });
        },
        { owner, code: CODE, blockHash: BLOCK },
      );
      await page.goto(`${origin}/alphaforge/#/${route}`);
      await page
        .waitForFunction(
          () =>
            !!(window as unknown as { AF?: { launchState?: { snapshot: unknown } } }).AF?.launchState
              ?.snapshot,
        )
        .catch(async (error: unknown) => {
          throw new Error(
            JSON.stringify({
              errors,
              requests: f.state.requests,
              main: await page.locator('main').innerText(),
            }),
            { cause: error },
          );
        });
      await page.locator('[data-launch-connect]').first().click();
      await page.locator('[data-launch-wallet-browser]').click();
      await page.waitForFunction(
        () => !!(window as unknown as { AF: { launchState: { wallet: unknown } } }).AF.launchState.wallet,
      );
      return { page, context, errors };
    };
    const noBroadcast = async (page: Awaited<ReturnType<typeof open>>['page']) => {
      const calls = await page.evaluate(
        () => (window as unknown as { accessWalletFixture: { calls: string[] } }).accessWalletFixture.calls,
      );
      assert.equal(calls.includes('eth_sendTransaction'), false);
      assert.equal(calls.includes('eth_signTypedData_v4'), false);
      assert.ok(
        writes.every((path) =>
          ['/api/launch-market/wallet/test-challenge', '/api/launch-market/wallet/test-session'].includes(
            path,
          ),
        ),
        JSON.stringify(writes),
      );
    };
    const stockResponses = (fresh: boolean) => {
      const cfg = f.state.config.manifest!;
      const now = Math.floor(Date.now() / 1000);
      const responses: Record<string, string> = {};
      const add = (
        address: string,
        abi: Interface,
        name: string,
        values: unknown[],
        args: unknown[] = [],
      ) => {
        responses[`${address.toLowerCase()}:${abi.encodeFunctionData(name, args)}`] =
          abi.encodeFunctionResult(name, values);
      };
      add(cfg.vaultFactory!, factory, 'vaults', [VAULT], [owner, 1]);
      add(
        cfg.vaultFactory!,
        factory,
        'strategy',
        [
          [
            ZeroAddress,
            cfg.strategies.AMZN.pass,
            cfg.usdc,
            STOCK,
            cfg.strategies.TSLA.pass,
            RESERVE,
            FEED,
            HASH,
            60,
          ],
        ],
        [1],
      );
      for (const [name, values] of Object.entries({
        owner: [owner],
        pass: [cfg.strategies.AMZN.pass],
        afUsdc: [cfg.usdc],
        closed: [false],
        executionVersion: [0],
        totalBuyUsdc: [0],
        grant: [ZeroAddress, 0, 0, 0, 0],
      }))
        add(VAULT, executorInterface, name, values);
      for (const [name, values] of Object.entries({
        targetStock: [STOCK],
        stockReserve: [RESERVE],
        referenceFeed: [FEED],
        maxPriceAge: [60],
        trackedUsdcBalance: [10_000_000],
      }))
        add(VAULT, stockExecutionInterface, name, values);
      add(VAULT, stockExecutionInterface, 'trackedPosition', [0], [STOCK]);
      for (const [name, values] of Object.entries({
        usdc: [cfg.usdc],
        stock: [STOCK],
        feed: [FEED],
        maxPriceAge: [60],
        paused: [false],
      }))
        add(RESERVE, venue, name, values);
      for (const [name, values] of Object.entries({
        price: fresh ? [200_000_000, now, HASH] : [0, 0, ZERO_HASH],
        regularOpen: [fresh ? now - 10 : 0],
        regularClose: [fresh ? now + 3600 : 0],
        calendarObservedAt: [fresh ? now : 0],
        calendarDigest: [fresh ? HASH : ZERO_HASH],
        executionAllowed: [fresh],
      }))
        add(FEED, feed, name, values);
      add(cfg.usdc, token, 'balanceOf', [10_000_000], [VAULT]);
      add(STOCK, token, 'balanceOf', [0], [VAULT]);
      add(cfg.usdc, token, 'balanceOf', [1_000_000_000], [RESERVE]);
      add(STOCK, token, 'balanceOf', [10n ** 21n], [RESERVE]);
      return responses;
    };
    try {
      await t.test(
        'connected wallet without session opens ownership review; explicit fixture signature restores Mint draft',
        async () => {
          const { page, context, errors } = await open('trade/tsla', false);
          try {
            const input = page.locator('[data-launch-order] input[name="amount"]');
            await input.fill('10');
            await page.locator('[data-launch-asset]').selectOption('AF_USDC');
            const primary = page.locator('[data-launch-order] [data-launch-bind]');
            assert.equal(await primary.isEnabled(), true);
            assert.match(await primary.innerText(), /Continue with wallet/);
            await primary.click();
            await page.locator('[data-launch-bind-confirm]').waitFor();
            assert.match(
              await page.locator('#app-dialog').innerText(),
              /does not move assets or approve transactions/,
            );
            assert.equal(
              await page.evaluate(
                () =>
                  (
                    window as unknown as { accessWalletFixture: { calls: string[] } }
                  ).accessWalletFixture.calls.filter((method) => method === 'personal_sign').length,
              ),
              0,
            );
            assert.deepEqual(writes, []);
            await page.locator('[data-launch-bind-confirm]').click();
            await page.locator('[data-launch-order] button[type="submit"]:enabled').waitFor();
            assert.equal(await input.inputValue(), '10');
            assert.equal(await page.locator('[data-launch-order] button[type="submit"]').isEnabled(), true);
            assert.match(
              await page.locator('#pass-quote-summary .order-total dd').innerText(),
              /5(?:\.0+)? AF-USDC/,
            );
            assert.equal(
              await page.evaluate(
                () =>
                  (
                    window as unknown as { accessWalletFixture: { calls: string[] } }
                  ).accessWalletFixture.calls.filter((method) => method === 'personal_sign').length,
              ),
              1,
            );
            assert.equal(reviewed.length, 0);
            await noBroadcast(page);
            assert.deepEqual(errors, []);
          } finally {
            await context.close();
          }
        },
      );
      await t.test(
        'My Account Use PASS selects TSLA and reviews only its create and deposit path',
        async () => {
          const { page, context, errors } = await open('account/trades');
          try {
            await page
              .locator('.wallet-pass-row')
              .filter({ hasText: 'All in TSLA' })
              .getByRole('link', { name: 'Use PASS' })
              .click();
            await page.locator('[data-launch-create-vault="TSLA"]').waitFor();
            assert.ok(page.url().endsWith('#/account/vaults/tsla'));
            assert.equal(await page.locator('[data-launch-create-vault="AMZN"]').count(), 0);
            assert.match(await page.locator('main').innerText(), /10 PASS lets you deposit 10 AF-USDC/);
            await page.locator('[data-launch-create-vault="TSLA"]').click();
            await page.locator('[data-launch-confirm]').waitFor();
            assert.deepEqual(
              reviewed.map((input) => [input.strategyId, input.operation, input.amountRaw]),
              [['TSLA', 'CREATE_VAULT', '0']],
            );
            f.state.wallet = { ...f.state.wallet, vaults: [vault('TSLA')] };
            await page.locator('[data-launch-clear]').click();
            await page.locator('[data-launch-refresh]').click();
            await page.locator('[data-launch-vault-order][data-strategy="TSLA"]').waitFor();
            await page.locator('#vault-TSLA').fill('10');
            await page.locator('[data-launch-vault-order] button[value="DEPOSIT"]').click();
            await page.locator('[data-launch-confirm]').waitFor();
            assert.deepEqual(
              reviewed.map((input) => [input.strategyId, input.operation, input.amountRaw]),
              [
                ['TSLA', 'CREATE_VAULT', '0'],
                ['TSLA', 'DEPOSIT', '10000000'],
              ],
            );
            assert.equal(await page.locator('[data-launch-vault-order][data-strategy="AMZN"]').count(), 0);
            await noBroadcast(page);
            assert.deepEqual(errors, []);
          } finally {
            await context.close();
          }
        },
      );
      await t.test(
        'uninitialized chain feed explains disabled stock trade while cash controls work; fresh owner review does not sign',
        async () => {
          const { page, context, errors } = await open('account/trades');
          try {
            f.state.wallet = { ...f.state.wallet, vaults: [vault('AMZN')] };
            await page.locator('[data-launch-refresh]').click();
            await page
              .locator('.wallet-pass-row')
              .filter({ hasText: 'All in AMZN' })
              .getByRole('link', { name: 'Use PASS' })
              .click();
            await page.locator('[data-launch-stock-refresh="AMZN"]').waitFor();
            await page.evaluate((responses: Record<string, string>) => {
              (
                window as unknown as { accessWalletFixture: { responses: Record<string, string> } }
              ).accessWalletFixture.responses = responses;
            }, stockResponses(false));
            await page.locator('[data-launch-stock-refresh="AMZN"]').click();
            await page
              .locator('[data-launch-stock-status]')
              .filter({ hasText: 'not been initialized' })
              .waitFor();
            assert.equal(await page.locator('[data-launch-stock-buy="AMZN"]').isDisabled(), true);
            assert.equal(
              await page.locator('[data-launch-vault-order] button[value="DEPOSIT"]').isEnabled(),
              true,
            );
            assert.equal(
              await page.locator('[data-launch-vault-order] button[value="WITHDRAW"]').isEnabled(),
              true,
            );
            await page.evaluate((responses: Record<string, string>) => {
              (
                window as unknown as { accessWalletFixture: { responses: Record<string, string> } }
              ).accessWalletFixture.responses = responses;
            }, stockResponses(true));
            await page.locator('[data-launch-stock-refresh="AMZN"]').click();
            await page.locator('[data-launch-stock-buy="AMZN"]:enabled').waitFor();
            await page.locator('[data-launch-stock-buy="AMZN"]').click();
            await page.locator('[aria-label="Reviewed stock trade"]').waitFor();
            const review = await page.locator('[aria-label="Reviewed stock trade"]').innerText();
            assert.match(review, /10 AF-USDC/);
            assert.match(review, /0\.05 AMZN stock units/);
            assert.match(review, /Confirm stock trade in wallet/);
            assert.equal(
              await page.evaluate(() =>
                (
                  window as unknown as { accessWalletFixture: { calls: string[] } }
                ).accessWalletFixture.calls.includes('personal_sign'),
              ),
              false,
            );
            assert.equal(reviewed.length, 0);
            await noBroadcast(page);
            assert.deepEqual(errors, []);
          } finally {
            await context.close();
          }
        },
      );
    } finally {
      await browser.close();
      for (const stream of streams) stream.end();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);
