import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fixture, OWNER } from './helpers/launch-market-ui-fixture.ts';
import {
  paperValue,
  closedPaper,
  paperVault,
  CLOSED_PAPER_VAULT,
} from './helpers/launch-market-paper-fixture.ts';
const browserPackage = '/opt/alphaforge/mock-source/.checks/release-browser-tools/package/index.mjs';
const browserBinary = '/opt/alphaforge/mock-browser-cache/chromium-1234/chrome-linux64/chrome';
const available = await Promise.all([
  stat(browserPackage).catch(() => null),
  stat(browserBinary).catch(() => null),
]);

test(
  'paper Vault page separates custody and past simulated results on desktop/mobile without stock wallet calls',
  {
    skip: available.some((value) => !value) ? 'NOT_RUN: qualified local browser tools unavailable' : false,
    timeout: 30000,
  },
  async () => {
    const { chromium } = await import(pathToFileURL(browserPackage).href);
    const f = fixture();
    f.state.wallet = { ...f.state.wallet, vaults: [paperVault()] };
    const streams = new Set<ServerResponse>();
    let walletReads = 0;
    const webRoot = resolve('apps/web/dist');
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      response.setHeader('content-type', 'application/json');
      try {
        if (url.pathname === '/auth/me') {
          response.end('{"authKind":"google","csrfToken":"fixture-private-google-csrf"}');
          return;
        }
        if (url.pathname === '/api/session') {
          response.end('{"user":null,"scope":"TEST_ONLY"}');
          return;
        }
        if (
          url.pathname === '/api/launch-market/wallet/test-session' ||
          url.pathname.startsWith('/api/community/') ||
          url.pathname.startsWith('/api/creator/')
        ) {
          response.writeHead(401);
          response.end('{"error":"ACCOUNT_SESSION_REQUIRED"}');
          return;
        }
        if (url.pathname === '/api/launch-market/events') {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.flushHeaders();
          streams.add(response);
          response.on('close', () => streams.delete(response));
          return;
        }
        const run = /\/vault-run\/(TSLA|AMZN)(?:\/state)?$/.exec(url.pathname);
        if (run) {
          response.end(
            JSON.stringify({
              schemaVersion: 1,
              executionMode: 'PAPER',
              owner: OWNER,
              strategyId: run[1],
              vault: run[1] === 'TSLA' ? paperValue().vault : null,
              paused: false,
              revocationRequired: false,
              revision: 0,
              action: null,
              updatedAt: Math.floor(Date.now() / 1000),
            }),
          );
          return;
        }
        if (url.pathname.endsWith('/vault-values/TSLA')) {
          const original = structuredClone(url.searchParams.has('vault') ? closedPaper() : paperValue());
          const now = Math.floor(Date.now() / 1000);
          const value = {
            ...original,
            closedVaults: [CLOSED_PAPER_VAULT],
            real: { ...original.real, observedAt: now },
            paper: {
              ...original.paper,
              observedAt: now,
              priceObservedAt: original.paper.priceObservedAt === null ? null : now - 2,
              history: original.paper.history.map((event, index) => ({
                ...event,
                at: now - 120 + index * 60,
                priceObservedAt: event.priceObservedAt === null ? null : now - 121 + index * 60,
              })),
              curve: original.paper.curve.map((point) => ({ ...point, at: now - 60 })),
            },
          };
          response.end(JSON.stringify(value));
          return;
        }
        if (url.pathname.startsWith('/api/launch-market/')) {
          if (url.pathname === '/api/launch-market/wallet') walletReads++;
          response.end(JSON.stringify(await f.api(url.pathname + url.search)));
          return;
        }
        const path = url.pathname.replace(/^\/alphaforge(?=\/)/, '');
        const file = resolve(webRoot, `.${path === '/' ? '/index.html' : path}`);
        assert.ok(file.startsWith(webRoot + sep));
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
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({
      executablePath: browserBinary,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors: string[] = [];
      page.on('pageerror', (error: Error) => errors.push(error.message));
      await page.addInitScript(
        (owner: string) =>
          Object.assign(window, {
            forbiddenWalletCalls: 0,
            ethereum: {
              request: async ({ method }: { method: string }) => {
                if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [owner];
                if (method === 'eth_chainId') return '0xb626';
                (window as unknown as { forbiddenWalletCalls: number }).forbiddenWalletCalls++;
                throw new Error('Read-only paper page fixture forbids signatures and broadcasts');
              },
              on() {},
              removeListener() {},
            },
          }),
        OWNER,
      );
      await page.goto(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/#/account/vaults/tsla`,
      );
      await page.locator('[data-launch-connect]').click();
      await page.locator('[data-launch-wallet-browser]').click();
      await page.getByText('Known realized simulated PnL:', { exact: false }).waitFor();
      assert.equal(await page.locator('button[value="DEPOSIT"]').isDisabled(), true);
      assert.equal(await page.locator('[data-launch-vault-withdraw="TSLA"]').isDisabled(), false);
      assert.equal(await page.getByText('Waiting for authorized market data.', { exact: false }).count(), 1);
      assert.equal(await page.getByText('Final simulated value', { exact: true }).count(), 1);
      assert.equal(await page.locator('[data-paper-archived-vault]').count(), 1);
      assert.equal(await page.locator('svg title').getByText('Simulated PnL', { exact: true }).count(), 1);
      await page.locator('[data-paper-history] summary').click();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const overflow = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('main *')]
            .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
            .map((element) => ({
              tag: element.tagName,
              class: element.className,
              right: Math.round(element.getBoundingClientRect().right),
            }))
            .slice(-15),
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          JSON.stringify({ width, overflow }),
        );
      }
      await mkdir('/root/alphaforge/artifacts/vault-paper-ui-20261012', { recursive: true });
      await page.screenshot({
        path: '/root/alphaforge/artifacts/vault-paper-ui-20261012/mobile-pnl.png',
        fullPage: true,
      });
      const before = walletReads;
      const next = {
        ...f.state.snapshot,
        location: { ...f.state.snapshot.location, blockNumber: '101', version: '101' },
      };
      for (const stream of streams)
        stream.write(
          `data: ${JSON.stringify({ type: 'SNAPSHOT', location: next.location, snapshot: next })}\n\n`,
        );
      await page.waitForFunction(
        () =>
          (window as unknown as { AF: { launchState: { snapshot: { location: { blockNumber: string } } } } })
            .AF.launchState.snapshot.location.blockNumber === '101',
      );
      assert.equal(walletReads, before);
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { forbiddenWalletCalls: number }).forbiddenWalletCalls,
        ),
        0,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
