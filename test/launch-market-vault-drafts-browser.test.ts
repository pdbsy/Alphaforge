import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
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

// Isolated browser regression: the wallet and API are fixtures, and no signature or broadcast is allowed.
test(
  'Vault amount, focus and caret survive a streamed refresh and the real form reviews the typed amount',
  {
    skip: available.some((entry) => !entry) ? 'NOT_RUN: qualified local browser tools unavailable' : false,
    timeout: 30000,
  },
  async () => {
    const { chromium } = await import(pathToFileURL(browserPackage).href);
    const f = fixture();
    const vaultAddress = '0x3333333333333333333333333333333333333333';
    f.state.wallet = {
      ...f.state.wallet,
      vaults: [
        {
          strategyId: 'AMZN',
          address: vaultAddress,
          principalBasisRaw: '10000000',
          equityRaw: '9000000',
          cashRaw: '9000000',
          lockedPassRaw: '10000000000000000000',
          realizedPnlRaw: '-1000000',
          unrealizedPnlRaw: '0',
          valuationState: 'FRESH',
          withdrawableProfitRaw: '0',
          withdrawablePrincipalRaw: '9000000',
          status: 'OPEN',
          holdings: [],
        },
      ],
    };
    const streams = new Set<ServerResponse>();
    const reviewed: QuoteRequest[] = [];
    const actions: { path: string; body: Record<string, unknown> }[] = [];
    const runs = new Map(
      ['TSLA', 'AMZN'].map((strategyId) => [
        strategyId,
        {
          schemaVersion: 1,
          owner: OWNER.toLowerCase(),
          strategyId,
          vault: strategyId === 'AMZN' ? vaultAddress : null,
          paused: false,
          revision: 0,
          action: null as Record<string, unknown> | null,
          updatedAt: 1,
        },
      ]),
    );
    const webRoot = resolve('apps/web/dist');
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      try {
        response.setHeader('content-type', 'application/json');
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
          streams.add(response);
          response.on('close', () => streams.delete(response));
          return;
        }
        if (['history', 'candles', 'holders'].some((name) => url.pathname.endsWith(`/${name}`))) {
          const name = url.pathname.split('/').at(-1)!;
          response.end(JSON.stringify({ [name]: [], location: location(), indexer: { state: 'HEALTHY' } }));
          return;
        }
        if (url.pathname === '/api/launch-market/vault-values/AMZN') {
          response.end(
            JSON.stringify({
              owner: OWNER,
              strategyId: 'AMZN',
              vault: vaultAddress,
              equityRaw: '9000000',
              principalRaw: '10000000',
              profitRaw: '-1000000',
              returnBps: '-1000',
              status: 'FRESH',
              observedAt: Math.floor(Date.now() / 1000),
              priceObservedAt: null,
            }),
          );
          return;
        }
        const runPath = url.pathname.match(
          /^\/api\/launch-market\/vault-run\/(TSLA|AMZN)(?:\/(deposit|stop|withdraw))?$/,
        );
        if (runPath) {
          const strategyId = runPath[1]!,
            operation = runPath[2];
          const run = runs.get(strategyId)!;
          if (operation) {
            let raw = '';
            for await (const chunk of request) raw += String(chunk);
            const input = JSON.parse(raw) as Record<string, unknown>;
            actions.push({ path: url.pathname, body: input });
            assert.equal(input.expectedRevision, run.revision);
            run.revision++;
            if (operation === 'stop') {
              run.paused = true;
              run.action = {
                actionId: 'stopped',
                kind: 'STOP',
                amountRaw: '0',
                step: null,
                stepAmountRaw: '0',
                phase: 'STOPPED',
                cancelled: false,
                prepared: false,
                pending: null,
                failure: null,
              };
            } else {
              run.paused = operation === 'withdraw';
              run.action = {
                actionId: input.actionId,
                kind: operation === 'deposit' ? 'DEPOSIT' : 'WITHDRAW',
                amountRaw: input.amountRaw ?? '0',
                step: operation === 'deposit' ? 'DEPOSIT' : 'CLOSE',
                stepAmountRaw: input.amountRaw ?? '0',
                phase: 'READY',
                cancelled: false,
                prepared: false,
                pending: null,
                failure: null,
              };
            }
          }
          response.end(JSON.stringify({ state: run }));
          return;
        }
        if (url.pathname.endsWith('/quote')) {
          let raw = '';
          for await (const chunk of request) raw += String(chunk);
          const input = JSON.parse(raw) as QuoteRequest;
          reviewed.push(input);
          response.end(
            JSON.stringify({
              ...quote(input),
              expiresAt: Math.floor(Date.now() / 1000) + 60,
              estimatedOutRaw: input.operation === 'CLOSE' ? '9000000' : input.amountRaw,
              minOutRaw: input.amountRaw,
              transaction: {
                to: vaultAddress,
                data: marketInterfaces.vault.encodeFunctionData(
                  input.operation === 'CLOSE' ? 'close' : 'deposit',
                  input.operation === 'CLOSE' ? [] : [input.amountRaw],
                ),
                value: '0',
              },
            }),
          );
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
          }[extname(file)] ?? 'application/octet-stream',
        );
        response.end(await readFile(file));
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const browser = await chromium.launch({
      executablePath: browserBinary,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.setDefaultTimeout(5000);
      await page.addInitScript((owner: string) => {
        Object.assign(window, {
          ethereum: {
            request: async ({ method }: { method: string }) => {
              if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [owner];
              if (method === 'eth_chainId') return '0xb626';
              throw new Error(`Read-only browser fixture refuses ${method}`);
            },
            on: () => {},
            removeListener: () => {},
          },
        });
      }, OWNER);
      await page.goto(`http://127.0.0.1:${port}/#/account/vaults`);
      await page.locator('[data-launch-connect]').click();
      await page.locator('[data-launch-wallet-browser]').click();
      const input = page.locator('[data-launch-vault-order][data-strategy="AMZN"] input[name="amount"]');
      await input.waitFor();
      await page.waitForFunction(() =>
        document.querySelector('[aria-label="AMZN Vault performance"]')?.textContent?.includes('-10.00%'),
      );
      assert.match(
        await page.locator('[aria-label="AMZN Vault performance"]').innerText(),
        /9[\s\S]*10 AF-USDC[\s\S]*-1 AF-USDC[\s\S]*-10.00%[\s\S]*Updated/,
      );
      await input.fill('0.01');
      await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(2, 4, 'backward'));
      const updated = { ...f.state.snapshot, location: location(101) };
      for (const stream of streams)
        stream.write(
          `data: ${JSON.stringify({ type: 'SNAPSHOT', location: updated.location, snapshot: updated })}\n\n`,
        );
      await page.waitForFunction(
        () =>
          (window as unknown as { AF: { launchState: { snapshot: { location: { blockNumber: string } } } } })
            .AF.launchState.snapshot.location.blockNumber === '101',
      );
      assert.deepEqual(
        await input.evaluate((element: HTMLInputElement) => ({
          value: element.value,
          focused: document.activeElement === element,
          start: element.selectionStart,
          end: element.selectionEnd,
          direction: element.selectionDirection,
        })),
        { value: '0.01', focused: true, start: 2, end: 4, direction: 'backward' },
      );
      await page.locator('[data-launch-vault-order][data-strategy="AMZN"] button[value="DEPOSIT"]').click();
      await page.locator('[data-launch-confirm]').waitFor();
      assert.equal(reviewed.length, 1);
      assert.equal(reviewed[0]!.amountRaw, '10000');
      assert.equal(reviewed[0]!.operation, 'DEPOSIT');
      assert.equal(reviewed[0]!.owner, OWNER);
      assert.equal(await input.inputValue(), '0.01');
      await page.locator('[data-launch-clear]').click();
      await page.waitForFunction(() =>
        document.querySelector('[data-launch-vault-progress="AMZN"]')?.textContent?.includes('Stopped'),
      );
      assert.equal(await input.inputValue(), '0.01');
      assert.equal(actions[0]!.path, '/api/launch-market/vault-run/AMZN/deposit');
      assert.equal(actions[0]!.body.amountRaw, '10000');
      assert.equal(actions[1]!.path, '/api/launch-market/vault-run/AMZN/stop');
      await input.fill('');
      await page.locator('[data-launch-vault-withdraw="AMZN"]').click();
      await page.locator('[data-launch-confirm]').waitFor();
      assert.equal(reviewed.at(-1)!.operation, 'CLOSE');
      assert.equal(reviewed.at(-1)!.amountRaw, '0');
      assert.equal(actions.at(-1)!.path, '/api/launch-market/vault-run/AMZN/withdraw');
      assert.equal('amountRaw' in actions.at(-1)!.body, false);
      assert.equal(await page.locator('[data-launch-vault-stop="AMZN"]').count(), 1);
      assert.equal(await page.locator('[data-launch-vault-withdraw="AMZN"]').count(), 1);
      assert.equal(
        await page
          .locator(
            '[data-launch-stock-buy],[data-launch-stock-sell],[data-launch-vault-close],[data-launch-create-vault],[data-automation-policy]',
          )
          .count(),
        0,
      );
      await page.locator('[data-launch-clear]').click();
      await page.waitForFunction(() =>
        document.querySelector('[data-launch-vault-progress="AMZN"]')?.textContent?.includes('Stopped'),
      );
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
        assert.equal(await page.locator('[aria-label="AMZN Vault performance"]').count(), 1);
      }
      await page.close();
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
