import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fixture, OWNER, location, quote } from './helpers/launch-market-ui-fixture.ts';
import { marketInterfaces } from '../packages/launch-market/src/abi.ts';
import type { QuoteRequest } from '../packages/launch-market/src/types.ts';

const browserPackage =
  process.env.AF_UI_BROWSER_PACKAGE ??
  '/opt/alphaforge/mock-source/.checks/release-browser-tools/package/index.mjs';
const browserBinary =
  process.env.CHROMIUM_PATH ?? '/opt/alphaforge/mock-browser-cache/chromium-1234/chrome-linux64/chrome';
const available = await Promise.all([
  stat(browserPackage).catch(() => null),
  stat(browserBinary).catch(() => null),
]);

// The production SPA runs against isolated chain reads and quotes. Signatures and broadcasts are refused.
test(
  'desktop and mobile holdings fund the real Vault through reviewed quotes and retain account boundaries',
  {
    skip: available.some((entry) => !entry) ? 'NOT_RUN: qualified local browser tools unavailable' : false,
    timeout: 45000,
  },
  async () => {
    const { chromium } = await import(pathToFileURL(browserPackage).href);
    let f = fixture();
    const vaultAddress = '0x3333333333333333333333333333333333333333';
    const reviewed: QuoteRequest[] = [];
    const writes: string[] = [];
    let configUnavailable = false;
    const webRoot = resolve('apps/web/dist');
    const evidence = resolve('.checks/holdings-funding');
    await mkdir(evidence, { recursive: true });
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      try {
        response.setHeader('content-type', 'application/json');
        if (request.method === 'POST') writes.push(url.pathname);
        if (url.pathname === '/api/launch-market/config' && configUnavailable) {
          response.writeHead(503);
          response.end('{"error":"ACCOUNT_SERVICE_UNAVAILABLE"}');
          return;
        }
        if (url.pathname === '/auth/me') {
          response.end(JSON.stringify({ authKind: 'google', csrfToken: 'trusted-session-csrf-token' }));
          return;
        }
        if (url.pathname === '/api/session') {
          response.end(JSON.stringify({ scope: 'TEST_ONLY', user: null }));
          return;
        }
        if (url.pathname === '/api/launch-market/wallet/test-session') {
          response.writeHead(401);
          response.end('{"error":"WALLET_TEST_SESSION_REQUIRED"}');
          return;
        }
        if (url.pathname === '/api/launch-market/events') {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.flushHeaders();
          return;
        }
        if (url.pathname === '/api/launch-market/account' && !f.state.account) {
          response.writeHead(401);
          response.end('{"error":"VERIFIED_EMAIL_REQUIRED"}');
          return;
        }
        if (['history', 'candles', 'holders'].some((name) => url.pathname.endsWith(`/${name}`))) {
          const name = url.pathname.split('/').at(-1)!;
          response.end(JSON.stringify({ [name]: [], location: location(), indexer: { state: 'HEALTHY' } }));
          return;
        }
        if (url.pathname === '/api/launch-market/quote') {
          let raw = '';
          for await (const chunk of request) raw += String(chunk);
          const input = JSON.parse(raw) as QuoteRequest;
          assert.ok(['DEPOSIT', 'WITHDRAW'].includes(input.operation));
          reviewed.push(input);
          response.end(
            JSON.stringify({
              ...quote(input),
              expiresAt: Math.floor(Date.now() / 1000) + 60,
              estimatedOutRaw: input.amountRaw,
              minOutRaw: input.amountRaw,
              transaction: {
                to: vaultAddress,
                data: marketInterfaces.vault.encodeFunctionData(
                  input.operation === 'DEPOSIT' ? 'deposit' : 'withdraw',
                  [input.amountRaw],
                ),
                value: '0',
              },
            }),
          );
          return;
        }
        if (request.method === 'POST') {
          response.writeHead(403);
          response.end('{"error":"READ_ONLY_BROWSER_FIXTURE"}');
          return;
        }
        if (url.pathname.startsWith('/api/launch-market/')) {
          response.end(JSON.stringify(await f.api(url.pathname + url.search)));
          return;
        }
        const assetPath = url.pathname.replace(/^\/alphaforge(?=\/)/, '');
        const file = resolve(webRoot, `.${assetPath === '/' ? '/index.html' : assetPath}`);
        if (!file.startsWith(webRoot + sep)) throw new Error('Invalid asset path');
        response.setHeader(
          'content-type',
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.woff2': 'font/woff2',
          }[extname(file)] ?? 'application/octet-stream',
        );
        response.end(await readFile(file));
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    const browser = await chromium.launch({
      executablePath: browserBinary,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      for (const viewport of [
        { width: 1440, height: 1000 },
        { width: 390, height: 844 },
      ]) {
        f = fixture();
        f.state.wallet = {
          ...f.state.wallet,
          vaults: [
            {
              strategyId: 'AMZN',
              address: vaultAddress,
              principalBasisRaw: '1000000',
              equityRaw: '1000000',
              cashRaw: '1000000',
              lockedPassRaw: '1000000000000000000',
              realizedPnlRaw: '0',
              unrealizedPnlRaw: '0',
              valuationState: 'FRESH',
              withdrawableProfitRaw: '0',
              withdrawablePrincipalRaw: '1000000',
              status: 'OPEN',
              holdings: [],
            },
          ],
        };
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        const errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.addInitScript((owner: string) => {
          const calls: string[] = [];
          Object.assign(window, {
            fixtureWalletCalls: calls,
            ethereum: {
              request: async ({ method }: { method: string }) => {
                calls.push(method);
                if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [owner];
                if (method === 'eth_chainId') return '0xb626';
                throw new Error(`Read-only browser fixture refuses ${method}`);
              },
              on: () => {},
              removeListener: () => {},
            },
          });
        }, OWNER);
        await page.goto(`http://127.0.0.1:${port}/#/account/trades`);
        await page.locator('[data-launch-account]').waitFor();
        await page.evaluate(() => {
          document.body.tabIndex = -1;
          document.body.focus();
          document.body.removeAttribute('tabindex');
        });
        await page.keyboard.press('Tab');
        const skip = page.locator('a.skip');
        assert.equal(await skip.evaluate((element: HTMLElement) => document.activeElement === element), true);
        assert.equal(await skip.evaluate((element: HTMLElement) => getComputedStyle(element).opacity), '1');
        assert.ok((await skip.boundingBox())!.y >= 0, 'The focused skip link must remain visible');
        await page.keyboard.press('Tab');
        assert.equal(await skip.evaluate((element: HTMLElement) => getComputedStyle(element).opacity), '0');
        await page.locator('[data-launch-connect]').click();
        await page.locator('[data-launch-wallet-browser]').click();
        await page.waitForFunction(
          () =>
            (window as unknown as { AF: { launchState: { wallet: { accountId: string } | null } } }).AF
              .launchState.wallet?.accountId === 'verified-account',
        );
        const holding = page.locator('details[data-launch-position="AMZN"]');
        const input = holding.locator('input[name="amount"]');
        assert.equal(await input.isVisible(), false);
        await holding.locator('summary').click();
        await input.fill('0.01');
        f.state.wallet = { ...f.state.wallet, location: location(101) };
        await page.locator('[data-launch-refresh]').click();
        await page.waitForFunction(
          () =>
            (window as unknown as { AF: { launchState: { wallet: { location: { blockNumber: string } } } } })
              .AF.launchState.wallet.location.blockNumber === '101',
        );
        assert.equal(await holding.getAttribute('open'), '');
        assert.equal(await input.inputValue(), '0.01');
        for (const [operation, amount] of [
          ['DEPOSIT', '0.01'],
          ['WITHDRAW', '0.02'],
        ] as const) {
          await input.fill(amount);
          await holding.locator(`button[value="${operation}"]`).click();
          await page.locator('[data-launch-confirm]').waitFor();
          assert.deepEqual(reviewed.at(-1), {
            owner: OWNER,
            strategyId: 'AMZN',
            operation,
            asset: 'AF_USDC',
            amountRaw: operation === 'DEPOSIT' ? '10000' : '20000',
            slippageBps: 100,
          });
          assert.match(
            await page.locator('[aria-label="Reviewed chain quote"]').innerText(),
            new RegExp(`REVIEW ${operation} · AMZN`),
          );
          assert.equal(await holding.getAttribute('open'), '');
          assert.equal(await input.inputValue(), amount);
          await input.fill('0.03');
          await page.locator('[data-launch-confirm]').waitFor({ state: 'detached' });
        }
        assert.doesNotMatch(await page.locator('body').innerText(), /\btest(?:net)?\b|\bdemo\b|\bmock\b/i);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
          false,
          `No page overflow at ${viewport.width}px`,
        );
        await page.screenshot({
          path: resolve(evidence, viewport.width > 1000 ? 'desktop.png' : 'mobile.png'),
          fullPage: true,
        });
        f.state.account = null;
        f.state.wallet = { ...f.state.wallet, accountId: null, location: location(102) };
        await page.locator('[data-launch-refresh]').click();
        await page.waitForFunction(() => {
          const state = (
            window as unknown as {
              AF: { launchState: { account: unknown; wallet: { accountId: string | null } } };
            }
          ).AF.launchState;
          return state.account === null && state.wallet.accountId === null;
        });
        assert.equal(await holding.getAttribute('open'), null);
        await holding.locator('summary').click();
        assert.equal(await input.inputValue(), '');
        assert.equal(await holding.locator('button[value="DEPOSIT"]').isDisabled(), true);
        assert.equal(await holding.locator('button[value="WITHDRAW"]').isDisabled(), true);
        assert.equal(await page.locator('[data-launch-create-vault="TSLA"]').isDisabled(), true);
        const financialCalls = await page.evaluate(() =>
          (window as unknown as { fixtureWalletCalls: string[] }).fixtureWalletCalls.filter((method) =>
            /sign|sendTransaction|sendCalls/i.test(method),
          ),
        );
        assert.deepEqual(financialCalls, []);
        assert.deepEqual(errors, []);
        await context.close();
      }
      configUnavailable = true;
      const fallbackContext = await browser.newContext();
      const fallbackPage = await fallbackContext.newPage();
      const fallbackErrors: string[] = [];
      fallbackPage.on('pageerror', (error: Error) => fallbackErrors.push(error.message));
      const [failedConfig] = await Promise.all([
        fallbackPage.waitForResponse((response: { url(): string }) =>
          response.url().endsWith('/api/launch-market/config'),
        ),
        fallbackPage.goto(`http://127.0.0.1:${port}/#/account/trades`),
      ]);
      assert.equal(failedConfig.status(), 503);
      const fallback = fallbackPage.locator('[data-financial-unavailable]');
      await fallback.waitFor();
      assert.deepEqual(await fallback.locator('strong').allTextContents(), ['—', '—', 'Unavailable']);
      assert.equal(await fallback.getByRole('button', { name: 'Deposit', exact: true }).isDisabled(), true);
      assert.equal(await fallback.getByRole('button', { name: 'Withdraw', exact: true }).isDisabled(), true);
      await fallbackPage.goto(`http://127.0.0.1:${port}/#/account/notes`);
      assert.equal(await fallbackPage.locator('[data-financial-unavailable]').count(), 0);
      assert.match(await fallbackPage.locator('body').innerText(), /My Notes|My notes/);
      assert.deepEqual(fallbackErrors, []);
      await fallbackContext.close();
      assert.equal(reviewed.length, 4);
      assert.ok(writes.every((path) => path === '/api/launch-market/quote'));
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);
