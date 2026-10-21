import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { fixture, OWNER, OTHER } from './helpers/launch-market-ui-fixture.ts';
import type { MarketAccount } from '../packages/launch-market/src/types.ts';

const browserPackage =
  process.env.AF_UI_BROWSER_PACKAGE ??
  '/opt/alphaforge/mock-source/.checks/release-browser-tools/package/index.mjs';
const browserBinary =
  process.env.CHROMIUM_PATH ?? '/opt/alphaforge/mock-browser-cache/chromium-1234/chrome-linux64/chrome';
const communityRoot = process.env.AF_COMMUNITY_SOURCE_ROOT ?? resolve('.');
const creatorRoot = process.env.AF_CREATOR_SOURCE_ROOT ?? resolve('.');
const available = await Promise.all([
  stat(browserPackage).catch(() => null),
  stat(browserBinary).catch(() => null),
  stat(resolve(communityRoot, 'packages/launch-market/src/community.ts')).catch(() => null),
  stat(resolve(creatorRoot, 'packages/launch-market/src/creator.ts')).catch(() => null),
]);

// Real community and creator route/store code runs in isolated memory databases. Wallet signing and chain writes are refused.
test(
  'online community, synced private notebooks and creator publications work across desktop/mobile devices with permission and failure boundaries',
  {
    skip: available.some((v) => !v)
      ? 'NOT_RUN: qualified browser or composed API sources unavailable'
      : false,
    timeout: 60000,
  },
  async () => {
    const { chromium } = await import(pathToFileURL(browserPackage).href);
    const { CommunityStore } = await import(
      pathToFileURL(resolve(communityRoot, 'packages/launch-market/src/community.ts')).href
    );
    const { registerCommunityRoutes } = await import(
      pathToFileURL(resolve(communityRoot, 'apps/server/src/launch-market/community-routes.ts')).href
    );
    const { CreatorStrategyStore } = await import(
      pathToFileURL(resolve(creatorRoot, 'packages/launch-market/src/creator.ts')).href
    );
    const { registerCreatorRoutes } = await import(
      pathToFileURL(resolve(creatorRoot, 'apps/server/src/launch-market/creator-routes.ts')).href
    );
    const app = Fastify({ logger: false });
    await app.register(cookie);
    const writes: string[] = [];
    const pageErrors: string[] = [];
    let writeAvailable = true;
    const csrf = 'browser-only-authenticated-csrf-token-123456';
    const sessionActor = (value: string | undefined) =>
      value === 'first' ? OWNER : value === 'second' ? OTHER : null;
    const webRoot = resolve('apps/web/dist');
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      const actor = sessionActor(
        /(?:^|;\s*)af_browser_session=([^;]+)/.exec(request.headers.cookie ?? '')?.[1],
      );
      try {
        response.setHeader('content-type', 'application/json');
        if (url.pathname === '/api/launch-market/wallet/test-session') {
          response.writeHead(actor ? 200 : 401);
          response.end(
            JSON.stringify(
              actor
                ? {
                    identityKind: 'WALLET_TEST',
                    emailVerificationRequired: false,
                    csrfToken: csrf,
                    wallet: actor,
                  }
                : { error: 'MARKET_SESSION_REQUIRED' },
            ),
          );
          return;
        }
        if (url.pathname === '/auth/me') {
          response.writeHead(401);
          response.end('{}');
          return;
        }
        if (url.pathname === '/api/session') {
          response.end('{"user":null}');
          return;
        }
        if (url.pathname === '/api/launch-market/events') {
          response.end('');
          return;
        }
        if (url.pathname === '/api/launch-market/automation/status') {
          response.end(
            JSON.stringify({
              schemaVersion: 1,
              available: false,
              reason: 'NOT_CONFIGURED',
              executor: null,
              manifestDigest: null,
              observedAt: Math.floor(Date.now() / 1000),
              readiness: [
                { strategyId: 'TSLA', status: 'UNAVAILABLE' },
                { strategyId: 'AMZN', status: 'UNAVAILABLE' },
              ],
            }),
          );
          return;
        }
        if (url.pathname === '/api/launch-market/automation/sessions') {
          response.end(JSON.stringify({ revision: 0, sessions: [] }));
          return;
        }
        if (
          url.pathname.startsWith('/api/community/') ||
          url.pathname.startsWith('/api/creator/') ||
          url.pathname.startsWith('/api/strategies')
        ) {
          let raw = '';
          for await (const chunk of request) raw += String(chunk);
          if (request.method !== 'GET') writes.push(request.method + ' ' + url.pathname);
          const injected = await app.inject({
            method: request.method as 'GET' | 'POST' | 'PUT' | 'DELETE',
            url: url.pathname + url.search,
            headers: request.headers,
            ...(raw ? { payload: raw } : {}),
          });
          response.writeHead(injected.statusCode, injected.headers);
          response.end(injected.body);
          return;
        }
        if (url.pathname.startsWith('/api/launch-market/')) {
          if (request.method !== 'GET') throw new Error('Chain writes refused');
          const f = fixture();
          f.state.wallet = {
            ...f.state.wallet,
            vaults: [
              {
                strategyId: 'AMZN',
                address: '0x3333333333333333333333333333333333333333',
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
          if (actor) {
            f.state.wallet = { ...f.state.wallet, owner: actor };
            f.state.account = { ...f.state.account!, wallet: actor };
          } else f.state.account = null;
          if (['history', 'candles', 'holders'].some((name) => url.pathname.endsWith('/' + name))) {
            response.end(JSON.stringify({ [url.pathname.split('/').at(-1)!]: [] }));
            return;
          }
          try {
            response.end(JSON.stringify(await f.api(url.pathname + url.search)));
          } catch {
            response.writeHead(401);
            response.end('{"error":"MARKET_SESSION_REQUIRED"}');
          }
          return;
        }
        const assetPath = url.pathname.replace(/^\/alphaforge(?=\/)/, '');
        const file = resolve(webRoot, '.' + (assetPath === '/' ? '/index.html' : assetPath));
        if (!file.startsWith(webRoot + sep)) throw new Error('Invalid asset path');
        response.setHeader(
          'content-type',
          { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[
            extname(file)
          ] ?? 'application/octet-stream',
        );
        response.end(await readFile(file));
      } catch {
        response.writeHead(404);
        response.end('{}');
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const store = new CommunityStore(':memory:', origin);
    const creator = new CreatorStrategyStore(':memory:', origin);
    const actor = async (request: FastifyRequest): Promise<MarketAccount | null> => {
      const wallet = sessionActor(request.cookies.af_browser_session);
      if (!wallet || (request.method !== 'GET' && request.headers['x-csrf-token'] !== csrf)) return null;
      return {
        id: wallet === OWNER ? 'verified-account' : 'other-account',
        accountKey: '0x' + 'aa'.repeat(32),
        email: null,
        identityKind: 'WALLET_TEST',
        wallet,
      };
    };
    registerCommunityRoutes(app, { store, origin, resolveAccount: actor, canWrite: () => writeAvailable });
    registerCreatorRoutes(app, {
      store: creator,
      origin,
      resolveAccount: actor,
      consumeRate: () => {},
      canWrite: () => writeAvailable,
      now: () => Math.floor(Date.now() / 1000),
    });
    await app.ready();
    const browser = await chromium.launch({
      executablePath: browserBinary,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const evidence = resolve('.checks/community-product');
    await mkdir(evidence, { recursive: true });
    try {
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
      for (const context of [desktop, mobile]) {
        await context.addCookies([{ name: 'af_browser_session', value: 'first', url: origin }]);
        await context.addInitScript((owner: string) => {
          Object.assign(window, {
            communityWalletCalls: [],
            ethereum: {
              request: async ({ method }: { method: string }) => {
                (window as unknown as { communityWalletCalls: string[] }).communityWalletCalls.push(method);
                if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [owner];
                if (method === 'eth_chainId') return '0xb626';
                throw new Error(`Read-only browser refuses ${method}`);
              },
              on: () => {},
              removeListener: () => {},
            },
          });
        }, OWNER);
      }
      const page = await desktop.newPage(),
        phone = await mobile.newPage();
      for (const p of [page, phone]) {
        p.setDefaultTimeout(5000);
        p.on('pageerror', (error: Error) => pageErrors.push(error.message));
      }
      await page.goto(origin + '/alphaforge/#/account/notes');
      await page.locator('[data-community="new-note"]').click();
      await page.locator('#private-title').fill('Private concentration research');
      await page
        .locator('#private-body')
        .fill('This private research should follow my wallet to the other device.');
      await page.locator('[data-community-form="note"] button[type="submit"]').click();
      await page.getByRole('heading', { name: 'Private concentration research' }).waitFor();
      await phone.goto(origin + '/alphaforge/#/account/notes');
      await phone.getByRole('heading', { name: 'Private concentration research' }).waitFor();
      assert.equal(store.account(OTHER).notes.length, 0);
      await page.locator('[data-community="share-note"]').click();
      await page.locator('[data-community-form="post"] button[type="submit"]').click();
      await page.getByRole('heading', { name: 'Private concentration research', level: 1 }).waitFor();
      const publicUrl = page.url();
      await page
        .locator('#community-reply')
        .fill('I would also investigate drawdown before allocating principal.');
      await page.locator('[data-community-form="reply"] button[type="submit"]').click();
      await page
        .getByText('I would also investigate drawdown before allocating principal.', { exact: true })
        .waitFor();
      await page.locator('[data-community="like"]').click();
      await page.locator('[data-community="like"][aria-pressed="true"]').waitFor();
      await page.locator('[data-community="bookmark"]').click();
      await page.locator('[data-community="bookmark"][aria-pressed="true"]').waitFor();
      await phone.goto(origin + '/alphaforge/#/account/saved');
      await phone.getByRole('heading', { name: 'Private concentration research' }).waitFor();
      // A failed save never invents success or clears the entered note.
      await page.goto(origin + '/alphaforge/#/account/notes');
      await page.locator('[data-community="edit-note"]').click();
      await page.locator('#private-body').fill('The edited text must survive a failed save.');
      writeAvailable = false;
      await page.locator('[data-community-form="note"] button[type="submit"]').click();
      await page
        .locator('[data-community-form-error]')
        .filter({ hasText: 'service could not complete' })
        .waitFor();
      assert.equal(
        await page.locator('#private-body').inputValue(),
        'The edited text must survive a failed save.',
      );
      writeAvailable = true;
      await page.locator('[data-community-form="note"] button[type="submit"]').click();
      await page.getByText('The edited text must survive a failed save.', { exact: true }).waitFor();
      // The creator form imports actual policy fields, saves privately, then publishes an immutable version.
      await page.goto(origin + '/alphaforge/#/account/creator');
      await page.locator('[data-community="new-strategy"]').click();
      const strategyDocument = {
        name: 'Bounded EMA research',
        symbol: 'TSLA',
        summary: 'A policy designed around a bounded allocation and two exponential averages.',
        method: 'Compare the fast and slow moving average at each eligible session.',
        risks: 'A concentrated stock position can lose value, and moving averages can lag.',
        policy: {
          kind: 'EMA_CROSS',
          allocationBps: 4000,
          maxSlippageBps: 100,
          fastPeriod: 12,
          slowPeriod: 26,
        },
      };
      await page.locator('[data-community-upload]').setInputFiles({
        name: 'strategy.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(strategyDocument)),
      });
      await page.locator('[data-community-form-error]').filter({ hasText: 'Document loaded' }).waitFor();
      await page.locator('[data-community-form="strategy"] button[type="submit"]').click();
      await page.getByRole('heading', { name: strategyDocument.name }).waitFor();
      assert.equal(creator.publicList().strategies.length, 0);
      await page.locator('[data-community="publish-strategy"]').click();
      await page.locator('[data-community="confirm-publish-strategy"]').click();
      await page.getByText('Strategy version published to the library.', { exact: true }).waitFor();
      await phone.goto(origin + '/alphaforge/#/library');
      await phone.getByRole('heading', { name: strategyDocument.name }).waitFor();
      await phone.getByRole('link', { name: 'Read strategy ↗' }).click();
      await phone.getByRole('heading', { name: 'Strategy policy' }).waitFor();
      assert.match(await phone.locator('#main').innerText(), /PUBLISHED VERSION 1/);
      assert.match(
        await phone.locator('#main').innerText(),
        /wallet execution requires an approved deployment/,
      );
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await phone.screenshot({ path: resolve(evidence, 'creator-mobile.png'), fullPage: true });
      await page.goto(origin + '/alphaforge/#/account/trades');
      await page.locator('[data-launch-connect]').click();
      await page.locator('[data-launch-wallet-browser]').click();
      await page
        .locator('[data-launch-position="AMZN"] form[data-launch-vault-order]')
        .waitFor({ state: 'attached' });
      await page.locator('[data-launch-position="AMZN"] summary').click();
      await page.locator('[data-launch-position="AMZN"] button[value="DEPOSIT"]').waitFor();
      await page.locator('[data-launch-position="AMZN"] button[value="WITHDRAW"]').waitFor();
      await page.screenshot({ path: resolve(evidence, 'holdings-desktop.png'), fullPage: true });
      await page.goto(origin + '/alphaforge/#/account/vaults/AMZN');
      await page.getByRole('heading', { name: 'Automatic stock strategy' }).waitFor();
      assert.equal(
        await page.locator('[data-automation-policy="AMZN"] button[type="submit"]').isDisabled(),
        true,
      );
      assert.match(
        await page.locator('.launch-automation').innerText(),
        /verified stock market data and the execution service/,
      );
      await phone.goto(origin + '/alphaforge/#/account/vaults/AMZN');
      await phone.locator('[data-launch-connect]').click();
      await phone.locator('[data-launch-wallet-browser]').click();
      await phone.getByRole('heading', { name: 'Automatic stock strategy' }).waitFor();
      await phone.locator('[data-automation-options="AMZN"] summary').click();
      await phone.locator('#automation-AMZN-maxPosition').fill('125');
      await phone.locator('[data-automation-refresh="AMZN"]').click();
      await phone.waitForTimeout(200);
      assert.equal(await phone.locator('#automation-AMZN-maxPosition').inputValue(), '125');
      assert.equal(
        (await phone.locator('[data-automation-options="AMZN"]').getAttribute('open')) !== null,
        true,
      );
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await phone.screenshot({ path: resolve(evidence, 'automation-mobile.png'), fullPage: true });
      // Anonymous readers can read publications but cannot see a wallet's private notebook or author controls.
      const anonymous = await browser.newContext({ viewport: { width: 390, height: 844 } }),
        reader = await anonymous.newPage();
      reader.on('pageerror', (error: Error) => pageErrors.push(error.message));
      await reader.goto(publicUrl);
      await reader.getByRole('heading', { name: 'Private concentration research', level: 1 }).waitFor();
      assert.equal(await reader.locator('[data-community="like"]').isDisabled(), true);
      assert.equal(await reader.locator('[data-community="edit-post"]').count(), 0);
      await reader.goto(origin + '/alphaforge/#/account/notes');
      await reader.getByText('Your workspace follows your wallet.', { exact: true }).waitFor();
      assert.equal(await reader.getByRole('heading', { name: 'Private concentration research' }).count(), 0);
      const calls = await page.evaluate(
        () => (window as unknown as { communityWalletCalls: string[] }).communityWalletCalls,
      );
      assert.equal(
        calls.some((method: string) => /sign|sendTransaction/.test(method)),
        false,
      );
      assert.deepEqual(pageErrors, []);
      await Promise.all([desktop.close(), mobile.close(), anonymous.close()]);
      await readFile(resolve(evidence, 'creator-mobile.png'));
      assert.ok(writes.some((path) => path === 'POST /api/community/posts'));
      assert.ok(writes.some((path) => path === 'POST /api/creator/strategies'));
    } finally {
      await browser.close();
      await app.close();
      store.close();
      creator.close();
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    }
  },
);
