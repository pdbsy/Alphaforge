import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fixture } from './helpers/launch-market-ui-fixture.ts';
const browserPackage = '/opt/alphaforge/mock-source/.checks/release-browser-tools/package/index.mjs';
const browserBinary = '/opt/alphaforge/mock-browser-cache/chromium-1234/chrome-linux64/chrome';
const available = await Promise.all([
  stat(browserPackage).catch(() => null),
  stat(browserBinary).catch(() => null),
]);

test(
  'retired credential and authorization routes return to the account without signatures or credential requests',
  {
    skip: available.some((value) => !value) ? 'NOT_RUN: qualified local browser tools unavailable' : false,
    timeout: 30000,
  },
  async () => {
    const { chromium } = await import(pathToFileURL(browserPackage).href);
    const f = fixture();
    const streams = new Set<ServerResponse>();
    const privateRequests: string[] = [];
    const writes: string[] = [];
    const webRoot = resolve('apps/web/dist');
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      try {
        response.setHeader('content-type', 'application/json');
        if (url.pathname === '/auth/me') {
          response.end(JSON.stringify({ authKind: 'google', csrfToken: 'fixture-private-google-csrf' }));
          return;
        }
        if (url.pathname === '/api/session') {
          response.end(JSON.stringify({ user: null, scope: 'TEST_ONLY' }));
          return;
        }
        if (url.pathname === '/api/launch-market/wallet/test-session') {
          response.writeHead(401);
          response.end('{"error":"SESSION_REQUIRED"}');
          return;
        }
        if (url.pathname === '/api/launch-market/operator/stock-data') {
          privateRequests.push(url.pathname);
          response.writeHead(401);
          response.end('{"error":"ACCOUNT_SESSION_REQUIRED"}');
          return;
        }
        if (!['GET', 'HEAD'].includes(request.method!)) writes.push(request.method! + ' ' + url.pathname);
        if (url.pathname === '/api/launch-market/events') {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.flushHeaders();
          streams.add(response);
          response.on('close', () => streams.delete(response));
          return;
        }
        if (/^\/api\/launch-market\/vault-run\/(TSLA|AMZN)(?:\/state)?$/.test(url.pathname)) {
          response.writeHead(401);
          response.end('{"error":"ACCOUNT_SESSION_REQUIRED"}');
          return;
        }
        if (url.pathname.startsWith('/api/launch-market/')) {
          response.end(JSON.stringify(await f.api(url.pathname + url.search)));
          return;
        }
        if (url.pathname.startsWith('/api/community/') || url.pathname.startsWith('/api/creator/')) {
          response.writeHead(401);
          response.end('{"error":"ACCOUNT_SESSION_REQUIRED"}');
          return;
        }
        const assetPath = url.pathname.replace(/^\/alphaforge(?=\/)/, '');
        const file = resolve(webRoot, `.${assetPath === '/' ? '/index.html' : assetPath}`);
        if (!file.startsWith(webRoot + sep)) throw new Error('ASSET_PATH');
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({
      executablePath: browserBinary,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on('pageerror', (error: Error) => errors.push(error.message));
      await page.addInitScript(() => {
        Object.assign(window, {
          cleanupWalletCalls: [] as string[],
          ethereum: {
            request: async ({ method }: { method: string }) => {
              (window as unknown as { cleanupWalletCalls: string[] }).cleanupWalletCalls.push(method);
              throw new Error('This route check must never invoke the wallet');
            },
            on: () => {},
            removeListener: () => {},
          },
        });
      });
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      await page.goto(origin + '/#/account/market-data');
      await page.waitForFunction(() => location.hash === '#/account/trades');
      await page.getByRole('heading', { name: 'My Account', exact: true }).waitFor();
      for (const viewport of [
        { width: 1440, height: 1000 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        for (const hash of ['#/account/automation', '#/account/executor', '#/authorization']) {
          await page.evaluate((next: string) => {
            location.hash = next;
          }, hash);
          await page.waitForFunction(() => location.hash === '#/account/trades');
          assert.equal(await page.locator('[data-stock-data-form],[data-launch-executor-order]').count(), 0);
          await page.getByRole('heading', { name: 'My Account', exact: true }).waitFor();
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      }
      await page.evaluate(() => {
        location.hash = '#/account/vaults/AMZN';
      });
      await page.getByRole('heading', { name: 'All in AMZN Vault', exact: true, level: 1 }).waitFor();
      for (const name of [/^Deposit/, /^Stop/, /^Withdraw/])
        assert.equal(await page.getByRole('button', { name }).isVisible(), true);
      await page.evaluate(() => {
        history.back();
      });
      await page.waitForFunction(() => location.hash === '#/account/trades');
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as { cleanupWalletCalls: string[] }).cleanupWalletCalls),
        [],
      );
      assert.deepEqual(privateRequests, []);
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
