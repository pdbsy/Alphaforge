import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Wallet, getAddress, verifyMessage } from 'ethers';
import { fixture } from './helpers/launch-market-ui-fixture.ts';

const browserPackage = '/opt/alphaforge/mock-source/.checks/release-browser-tools/package/index.mjs';
const browserBinary = '/opt/alphaforge/mock-browser-cache/chromium-1234/chrome-linux64/chrome';
const available = await Promise.all([
  stat(browserPackage).catch(() => null),
  stat(browserBinary).catch(() => null),
]);

test(
  'wallet sign-in on market-data setup preserves checksummed address verification and succeeds with the device clock one day behind',
  {
    skip: available.some((entry) => !entry) ? 'NOT_RUN: qualified local browser tools unavailable' : false,
    timeout: 30000,
  },
  async () => {
    const { chromium } = await import(pathToFileURL(browserPackage).href);
    const testWallet = Wallet.createRandom(),
      owner = testWallet.address.toLowerCase(),
      f = fixture();
    const account = {
      ...f.state.account!,
      wallet: owner,
      emailVerified: false,
      identityKind: 'WALLET_TEST' as const,
    };
    f.state.config = { ...f.state.config, emailVerificationRequired: false };
    f.state.account = null;
    f.state.wallet = { ...f.state.wallet, owner, accountId: null };
    const streams = new Set<ServerResponse>();
    const writes: string[] = [];
    const errors: string[] = [];
    let session = false,
      failChallenge = true,
      challenge: { nonce: string; message: string; expiresAt: number } | null = null;
    let challengeGate = Promise.withResolvers<void>();
    const sessionGate = Promise.withResolvers<void>();
    const webRoot = resolve('apps/web/dist');
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      const json = (value: unknown, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      try {
        if (url.pathname === '/api/session') return json({ user: null, scope: 'TEST_ONLY' });
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
          let raw = '';
          for await (const part of request) raw += String(part);
          assert.deepEqual(JSON.parse(raw), { owner });
          await challengeGate.promise;
          if (failChallenge) return json({ error: { code: 'WALLET_CHALLENGE_INVALID' } }, 503);
          const now = Math.floor(Date.now() / 1000),
            origin = `http://${request.headers.host}`,
            nonce = 'ab'.repeat(24),
            expiresAt = now + 300;
          challenge = {
            nonce,
            expiresAt,
            message: `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${getAddress(owner)}\n\nSign in to AlphaForge wallet-only mode. This proves control of this wallet; it does not verify an email, move assets or approve a transaction. Free credits are limited to one claim for this wallet and 100 claims in total.\n\nURI: ${origin}\nVersion: 1\nChain ID: 46630\nNonce: ${nonce}\nIssued At: ${new Date(now * 1000).toISOString()}\nExpiration Time: ${new Date(expiresAt * 1000).toISOString()}`,
          };
          // Exercise a cached Date header at a second boundary on every explicit retry.
          response.setHeader('Date', new Date((now - 1) * 1000).toUTCString());
          return json(challenge);
        }
        if (url.pathname === '/api/launch-market/wallet/test-session') {
          if (request.method === 'POST') {
            writes.push(url.pathname);
            let raw = '';
            for await (const part of request) raw += String(part);
            const input = JSON.parse(raw) as { nonce: string; signature: string };
            assert.equal(input.nonce, challenge!.nonce);
            assert.equal(verifyMessage(challenge!.message, input.signature).toLowerCase(), owner);
            await sessionGate.promise;
            session = true;
            f.state.account = account;
            f.state.wallet = { ...f.state.wallet, accountId: account.id };
            return json(account);
          }
          return session
            ? json({
                identityKind: 'WALLET_TEST',
                emailVerificationRequired: false,
                csrfToken: 'isolated-sign-in-csrf-token',
              })
            : json({ error: { code: 'MARKET_SESSION_REQUIRED' } }, 401);
        }
        if (url.pathname === '/api/launch-market/account')
          return session ? json(account) : json({ error: { code: 'MARKET_SESSION_REQUIRED' } }, 401);
        if (url.pathname === '/api/launch-market/operator/stock-data')
          return json({ error: { code: 'OPERATOR_WALLET_REQUIRED' } }, 403);
        if (request.method !== 'GET') {
          writes.push('REFUSED:' + url.pathname);
          return json({ error: { code: 'NO_ASSET_WRITES' } }, 403);
        }
        if (url.pathname.startsWith('/api/community/') || url.pathname.startsWith('/api/creator/'))
          return json({ error: { code: 'LINKED_WALLET_REQUIRED' } }, 401);
        if (url.pathname.startsWith('/api/launch-market/vault-run/'))
          return json({ error: { code: 'LINKED_WALLET_REQUIRED' } }, 401);
        if (url.pathname.startsWith('/api/launch-market/'))
          return json(await f.api(url.pathname + url.search));
        if (url.pathname.startsWith('/api/')) return json({ error: 'ISOLATED_FIXTURE_UNAVAILABLE' }, 404);
        const asset = url.pathname.replace(/^\/alphaforge(?=\/)/, '');
        const file = resolve(webRoot, `.${asset === '/' ? '/index.html' : asset}`);
        if (!file.startsWith(webRoot + sep)) throw new Error('ASSET_PATH');
        const content = await readFile(file);
        response.writeHead(200, {
          'content-type':
            (
              {
                '.html': 'text/html',
                '.js': 'text/javascript',
                '.css': 'text/css',
                '.svg': 'image/svg+xml',
              } as Record<string, string>
            )[extname(file)] ?? 'application/octet-stream',
        });
        response.end(content);
      } catch {
        json({ error: { code: 'ISOLATED_REQUEST_FAILED' } }, 503);
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({
      executablePath: browserBinary,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.addInitScript(
      ({ owner, checksumOwner }: { owner: string; checksumOwner: string }) => {
        const deviceNow = Date.now.bind(Date);
        Date.now = () => deviceNow() - 86400000;
        const control = {
          calls: [] as string[],
          pending: null as { resolve: (signature: string) => void; reject: (error: Error) => void } | null,
        };
        Object.assign(window, {
          signInFixture: control,
          ethereum: {
            request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
              control.calls.push(method);
              if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [owner];
              if (method === 'eth_chainId') return '0xb626';
              if (method === 'personal_sign') {
                const messageBytes = String(params?.[0]).slice(2).match(/.{2}/g) ?? [];
                const message = new TextDecoder().decode(
                  Uint8Array.from(messageBytes, (byte) => Number.parseInt(byte, 16)),
                );
                if (params?.[1] !== checksumOwner || message.split('\n')[1] !== params[1])
                  throw new Error(
                    "The app's signature request cannot be shown as the address does not match the provided address for verification.",
                  );
                return new Promise<string>((resolve, reject) => {
                  control.pending = { resolve, reject };
                });
              }
              throw new Error('Isolated wallet refuses ' + method);
            },
            on: () => {},
            removeListener: () => {},
          },
        });
      },
      { owner, checksumOwner: testWallet.address },
    );
    const signCount = () =>
      page.evaluate(
        () =>
          (window as unknown as { signInFixture: { calls: string[] } }).signInFixture.calls.filter(
            (method) => method === 'personal_sign',
          ).length,
      );
    const reviewSignIn = async () => {
      await page.locator('[data-launch-bind]').first().click();
      await page.locator('#app-dialog[open] [data-launch-bind-confirm]').waitFor();
      assert.match(
        await page.locator('#app-dialog').innerText(),
        /does not move assets or approve transactions/,
      );
      await page.locator('[data-launch-bind-confirm]').click();
      await page.locator('#app-dialog').waitFor({ state: 'hidden' });
    };
    const allBindDisabled = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLButtonElement>('[data-launch-bind]')].every(
          (button) => button.disabled,
        ),
      );
    const sendSnapshot = () => {
      for (const stream of streams)
        stream.write('data: ' + JSON.stringify({ type: 'SNAPSHOT', snapshot: f.state.snapshot }) + '\n\n');
    };
    try {
      await page.goto(origin + '/alphaforge/#/account/market-data');
      await page.locator('[data-launch-connect]').first().click();
      await page.locator('[data-launch-wallet-browser]').click();
      await page.waitForFunction(
        () => !!(window as unknown as { AF: { launchState: { wallet: unknown } } }).AF.launchState.wallet,
      );
      assert.equal(await page.locator('[data-launch-bind]').count(), 2);
      assert.equal(await page.locator('[data-stock-data-form]').count(), 0);
      assert.equal(await signCount(), 0);

      // Failure after the explicit confirmation must be visible on this page.
      await reviewSignIn();
      await page
        .locator('main [role="status"]')
        .filter({ hasText: /Checking the wallet/ })
        .waitFor();
      assert.equal(await allBindDisabled(), true);
      sendSnapshot();
      await page
        .locator('main [role="status"]')
        .filter({ hasText: /Checking the wallet/ })
        .waitFor();
      challengeGate.resolve();
      await page
        .locator('main [role="alert"]')
        .filter({ hasText: /sign-in message could not be validated/ })
        .waitFor();
      assert.equal(await signCount(), 0);
      assert.equal(await page.locator('[data-launch-bind]').first().isEnabled(), true);

      // A fresh explicit retry can wait on the provider without looking inert.
      failChallenge = false;
      challengeGate = Promise.withResolvers<void>();
      challengeGate.resolve();
      await reviewSignIn();
      await page
        .locator('main [role="status"]')
        .filter({ hasText: /Waiting for your wallet signature/ })
        .waitFor();
      assert.equal(await signCount(), 1);
      assert.equal(await allBindDisabled(), true);
      sendSnapshot();
      await page
        .locator('main [role="status"]')
        .filter({ hasText: /Waiting for your wallet signature/ })
        .waitFor();
      await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-launch-bind]')!.click());
      assert.equal(await signCount(), 1, 'disabled retry cannot request a second signature');
      await page.evaluate(() => {
        const pending = (
          window as unknown as { signInFixture: { pending: { reject: (error: Error) => void } } }
        ).signInFixture.pending;
        pending.reject(Object.assign(new Error('Isolated user rejection'), { code: 4001 }));
      });
      await page
        .locator('main [role="alert"]')
        .filter({ hasText: /Wallet confirmation cancelled/ })
        .waitFor();
      assert.equal(await page.locator('[data-launch-bind]').first().isEnabled(), true);

      // This signature is by a fresh isolated wallet, never a user or live key.
      await reviewSignIn();
      await page
        .locator('main [role="status"]')
        .filter({ hasText: /Waiting for your wallet signature/ })
        .waitFor();
      assert.equal(await signCount(), 2);
      const signed = await testWallet.signMessage(challenge!.message);
      await page.evaluate((signature: string) => {
        (
          window as unknown as { signInFixture: { pending: { resolve: (value: string) => void } } }
        ).signInFixture.pending.resolve(signature);
      }, signed);
      await page
        .locator('main [role="status"]')
        .filter({ hasText: /Verifying your signature/ })
        .waitFor();
      assert.equal(await allBindDisabled(), true);
      sendSnapshot();
      await page
        .locator('main [role="status"]')
        .filter({ hasText: /Verifying your signature/ })
        .waitFor();
      sessionGate.resolve();
      await page.waitForFunction(() => {
        const state = (
          window as unknown as {
            AF: {
              launchState: {
                busy: boolean;
                account: { wallet: string } | null;
                wallet: { accountId: string | null } | null;
              };
            };
          }
        ).AF.launchState;
        return !state.busy && !!state.account && !!state.wallet?.accountId;
      });
      await page
        .locator('main [role="status"]')
        .filter({ hasText: /signed in with your wallet/ })
        .waitFor();
      assert.equal(await page.locator('[data-launch-bind]').count(), 0);
      assert.equal(
        await page.locator('[data-stock-data-form]').count(),
        0,
        'ordinary wallet cannot access administrator secret fields',
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(writes, [
        '/api/launch-market/wallet/test-challenge',
        '/api/launch-market/wallet/test-challenge',
        '/api/launch-market/wallet/test-challenge',
        '/api/launch-market/wallet/test-session',
      ]);
      const calls = await page.evaluate(
        () => (window as unknown as { signInFixture: { calls: string[] } }).signInFixture.calls,
      );
      assert.equal(
        calls.some((method: string) => /sendTransaction|sendRawTransaction|signTypedData/.test(method)),
        false,
      );
    } catch (error) {
      const feedback = await page.evaluate(() => {
        const state = (
          window as unknown as { AF?: { launchState?: { error?: string; walletSignIn?: string } } }
        ).AF?.launchState;
        return { error: state?.error, walletSignIn: state?.walletSignIn };
      });
      process.stderr.write(JSON.stringify({ isolatedLoginFailure: feedback }) + '\n');
      throw error;
    } finally {
      challengeGate.resolve();
      sessionGate.resolve();
      await context.close();
      await browser.close();
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);
