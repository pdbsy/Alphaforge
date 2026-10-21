import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Wallet, getAddress, verifyMessage } from 'ethers';
import { marketInterfaces } from '../packages/launch-market/src/abi.ts';
import { fixture, quote } from './helpers/launch-market-ui-fixture.ts';
import { paperValue } from './helpers/launch-market-paper-fixture.ts';

const browserPackage = '/opt/alphaforge/mock-source/.checks/release-browser-tools/package/index.mjs';
const browserBinary = '/opt/alphaforge/mock-browser-cache/chromium-1234/chrome-linux64/chrome';
const available = await Promise.all([
  stat(browserPackage).catch(() => null),
  stat(browserBinary).catch(() => null),
]);

for (const scenario of ['closed'] as readonly string[])
  test(
    `Deposit directly requests a wallet transaction after sign-in without a second page confirmation: ${scenario}`,
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
      const runState = {
        schemaVersion: 1,
        executionMode: 'PAPER',
        owner,
        strategyId: 'TSLA',
        vault: null,
        paused: false,
        revocationRequired: false,
        revision: 0,
        action: null as Record<string, unknown> | null,
        updatedAt: Math.floor(Date.now() / 1000),
      };
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
          if (url.pathname === '/api/launch-market/vault-run/TSLA/deposit' && request.method === 'POST') {
            assert.ok(scenario === 'open' || scenario === 'closed');
            assert.equal(session, true);
            writes.push(url.pathname);
            let raw = '';
            for await (const part of request) raw += String(part);
            assert.equal(JSON.parse(raw).amountRaw, '1000000000');
            runState.revision++;
            runState.action = {
              executionMode: 'PAPER',
              actionId: 'inline-create',
              kind: 'DEPOSIT',
              amountRaw: '1000000000',
              step: 'CREATE',
              stepAmountRaw: '0',
              phase: 'READY',
              cancelled: false,
              prepared: false,
              pending: null,
              failure: null,
              expectedVersion: null,
            };
            return json({ state: runState });
          }
          if (url.pathname.endsWith('/quote') && request.method === 'POST') {
            let raw = '';
            for await (const part of request) raw += String(part);
            const input = JSON.parse(raw);
            return json({
              ...quote(input),
              owner,
              expiresAt: Math.floor(Date.now() / 1000) + 60,
              transaction: {
                to: f.state.config.manifest!.vaultFactory,
                data: marketInterfaces.vaultFactory.encodeFunctionData('createVault', [0]),
                value: '0',
              },
            });
          }
          if (url.pathname.endsWith('/TSLA/prepare') && request.method === 'POST') {
            writes.push(url.pathname);
            runState.revision++;
            Object.assign(runState.action!, { prepared: true, phase: 'AWAITING_WALLET' });
            return json({ state: runState });
          }
          if (url.pathname.endsWith('/TSLA/rejected') && request.method === 'POST') {
            writes.push(url.pathname);
            runState.revision++;
            Object.assign(runState.action!, { prepared: false, phase: 'FAILED' });
            return json({ state: runState });
          }
          if (request.method !== 'GET') {
            writes.push('REFUSED:' + url.pathname);
            return json({ error: { code: 'NO_ASSET_WRITES' } }, 403);
          }
          if (url.pathname.startsWith('/api/community/') || url.pathname.startsWith('/api/creator/'))
            return json({ error: { code: 'LINKED_WALLET_REQUIRED' } }, 401);
          if (url.pathname.endsWith('/vault-values/TSLA')) {
            const value = paperValue();
            const now = Math.floor(Date.now() / 1000);
            return json({
              ...value,
              owner,
              vault: null,
              real: {
                ...value.real,
                principalRaw: '0',
                cashRaw: '0',
                withdrawableRaw: '0',
                lockedPassRaw: '0',
                observedAt: now,
              },
              paper: {
                ...value.paper,
                observedAt: now,
                marketSession: scenario === 'closed' ? 'CLOSED' : 'OPEN',
                quoteStatus: scenario === 'closed' ? 'UNAVAILABLE' : 'FRESH',
                sourceId: 'ALPACA_IEX',
              },
            });
          }
          if (url.pathname.startsWith('/api/launch-market/vault-run/'))
            return session
              ? json({
                  state: {
                    ...runState,
                    ...(url.pathname.includes('/AMZN') ? { strategyId: 'AMZN', action: null } : {}),
                  },
                })
              : json({ error: { code: 'LINKED_WALLET_REQUIRED' } }, 401);
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
          const control = {
            calls: [] as string[],
            accounts: [owner],
            listeners: {} as Record<string, (...args: unknown[]) => void>,
            pending: null as { resolve: (signature: string) => void; reject: (error: Error) => void } | null,
          };
          Object.assign(window, {
            signInFixture: control,
            ethereum: {
              request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
                control.calls.push(method);
                if (method === 'eth_accounts' || method === 'eth_requestAccounts') return control.accounts;
                if (method === 'eth_chainId') return '0xb626';
                if (method === 'eth_call') return '0x';
                if (method === 'eth_sendTransaction') {
                  return new Promise<string>((resolve, reject) => {
                    control.pending = { resolve, reject };
                  });
                }
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
              on: (event: string, listener: (...args: unknown[]) => void) => {
                control.listeners[event] = listener;
              },
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
        await page.locator('button[value="DEPOSIT"]').click();
        assert.equal(await page.locator('#app-dialog[open] [data-launch-bind-confirm]').count(), 0);
      };
      const allBindDisabled = () =>
        page.evaluate(() =>
          [...document.querySelectorAll<HTMLButtonElement>('[data-launch-bind]')].every(
            (button) => button.disabled,
          ),
        );
      const sendSnapshot = () => {
        for (const stream of streams)
          stream.write(
            'data: ' +
              JSON.stringify({
                type: 'SNAPSHOT',
                location: f.state.snapshot.location,
                snapshot: f.state.snapshot,
              }) +
              '\n\n',
          );
      };
      try {
        await page.goto(origin + '/alphaforge/#/account/vaults/tsla');
        if (scenario !== 'open') {
          await page.locator('[data-launch-connect]').first().click();
          await page.locator('[data-launch-wallet-browser]').click();
          await page.waitForFunction(
            () => !!(window as unknown as { AF: { launchState: { wallet: unknown } } }).AF.launchState.wallet,
          );
        } else {
          await page.waitForFunction(
            () =>
              (window as unknown as { AF: { launchState: { config: { deployment: string } } } }).AF
                ?.launchState?.config?.deployment === 'CONFIGURED',
          );
        }
        assert.equal(await page.locator('button[value="DEPOSIT"]').isEnabled(), true);
        await page.locator('input[name="amount"]').fill('1000');
        assert.equal(await page.locator('button[value="DEPOSIT"]').isEnabled(), true);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('button[value="DEPOSIT"]').scrollIntoViewIfNeeded();
        const box = await page.locator('button[value="DEPOSIT"]').boundingBox();
        assert.ok(box && box.width > 0 && box.x >= 0 && box.x + box.width <= 390);
        assert.equal(await page.locator('[data-stock-data-form]').count(), 0);
        assert.equal(await signCount(), 0);

        // Deposit is the explicit sign-in action; no extra application dialog is needed.
        await reviewSignIn();
        await page
          .locator('[data-launch-deposit-reason]')
          .filter({ hasText: /Checking the wallet/ })
          .waitFor();
        assert.equal(await allBindDisabled(), true);
        sendSnapshot();
        await page
          .locator('[data-launch-deposit-reason]')
          .filter({ hasText: /Checking the wallet/ })
          .waitFor();
        challengeGate.resolve();
        await page
          .locator('[data-launch-vault-signin-error]')
          .filter({ hasText: /sign-in message could not be validated/ })
          .waitFor();
        assert.equal(await signCount(), 0);
        assert.equal(await page.locator('button[value="DEPOSIT"]').isEnabled(), true);

        // A fresh explicit retry can wait on the provider without looking inert.
        failChallenge = false;
        challengeGate = Promise.withResolvers<void>();
        challengeGate.resolve();
        await reviewSignIn();
        await page
          .locator('[data-launch-deposit-reason]')
          .filter({ hasText: /Waiting for your wallet signature/ })
          .waitFor();
        assert.equal(await signCount(), 1);
        assert.equal(await allBindDisabled(), true);
        sendSnapshot();
        await page
          .locator('[data-launch-deposit-reason]')
          .filter({ hasText: /Waiting for your wallet signature/ })
          .waitFor();
        await page.evaluate(() =>
          document.querySelector<HTMLButtonElement>('button[value="DEPOSIT"]')!.click(),
        );
        assert.equal(await signCount(), 1, 'disabled retry cannot request a second signature');
        await page.evaluate(() => {
          const pending = (
            window as unknown as { signInFixture: { pending: { reject: (error: Error) => void } } }
          ).signInFixture.pending;
          pending.reject(Object.assign(new Error('Isolated user rejection'), { code: 4001 }));
        });
        await page
          .locator('[data-launch-vault-signin-error]')
          .filter({ hasText: /Wallet confirmation cancelled/ })
          .waitFor();
        assert.equal(await page.locator('button[value="DEPOSIT"]').isEnabled(), true);

        // This signature is by a fresh isolated wallet, never a user or live key.
        await reviewSignIn();
        await page
          .locator('[data-launch-deposit-reason]')
          .filter({ hasText: /Waiting for your wallet signature/ })
          .waitFor();
        assert.equal(await signCount(), 2);
        if (scenario === 'amount-change') await page.locator('input[name="amount"]').fill('2000');
        if (scenario === 'wallet-change')
          await page.evaluate(() => {
            const fixture = (
              window as unknown as {
                signInFixture: {
                  accounts: string[];
                  listeners: Record<string, (...args: unknown[]) => void>;
                };
              }
            ).signInFixture;
            fixture.accounts = ['0x2222222222222222222222222222222222222222'];
            fixture.listeners.accountsChanged?.(fixture.accounts);
          });
        const signed = await testWallet.signMessage(challenge!.message);
        await page.evaluate((signature: string) => {
          (
            window as unknown as { signInFixture: { pending: { resolve: (value: string) => void } } }
          ).signInFixture.pending.resolve(signature);
        }, signed);
        if (scenario === 'wallet-change') {
          await page.waitForFunction(
            () => !(window as unknown as { AF: { launchState: { busy: boolean } } }).AF.launchState.busy,
          );
          assert.equal(
            writes.some((path) => path.endsWith('/test-session') || path.endsWith('/deposit')),
            false,
          );
          return;
        }
        await page
          .locator('[data-launch-deposit-reason]')
          .filter({ hasText: /Verifying your signature/ })
          .waitFor();
        assert.equal(await allBindDisabled(), true);
        sendSnapshot();
        await page
          .locator('[data-launch-deposit-reason]')
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
        // The original Deposit gesture must reach the wallet, with no additional page click.
        await page.waitForFunction(() =>
          (window as unknown as { signInFixture: { calls: string[] } }).signInFixture.calls.includes(
            'eth_sendTransaction',
          ),
        );
        assert.equal(writes.filter((path) => path.endsWith('/prepare')).length, 1);
        assert.equal(writes.filter((path) => path.endsWith('/deposit')).length, 1);
        assert.equal(await page.locator('input[name="amount"]').inputValue(), '1000');
        assert.equal(await page.locator('button[value="DEPOSIT"]').isEnabled(), false);
        assert.match(
          await page.locator('[data-launch-deposit-reason]').innerText(),
          /Waiting for transaction confirmation in your wallet/,
        );
        sendSnapshot();
        await page.evaluate(() => {
          const control = (
            window as unknown as { signInFixture: { pending: { reject: (error: Error) => void } } }
          ).signInFixture;
          control.pending.reject(Object.assign(new Error('Isolated transaction rejection'), { code: 4001 }));
        });
        await page.locator('[data-launch-vault-progress="TSLA"] [role="alert"]').waitFor();
        assert.equal(
          await page.locator('[data-launch-confirm]').count(),
          0,
          'rejected quotes cannot bypass the Vault workflow',
        );
        await page.waitForFunction(
          () => !document.querySelector<HTMLButtonElement>('button[value="DEPOSIT"]')?.disabled,
        );
        for (const width of [390, 1292]) {
          await page.setViewportSize({ width, height: 844 });
          const bounds = await page.locator('button[value="DEPOSIT"]').boundingBox();
          assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
        }
        assert.equal(
          await page.locator('[data-stock-data-form]').count(),
          0,
          'ordinary wallet cannot access administrator secret fields',
        );
        assert.equal(
          await page.evaluate(
            () =>
              (window as unknown as { AF: { launchState: { error: string | null } } }).AF.launchState.error,
          ),
          'Wallet confirmation cancelled. No transaction was submitted.',
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(writes, [
          '/api/launch-market/wallet/test-challenge',
          '/api/launch-market/wallet/test-challenge',
          '/api/launch-market/wallet/test-challenge',
          '/api/launch-market/wallet/test-session',
          '/api/launch-market/vault-run/TSLA/deposit',
          '/api/launch-market/vault-run/TSLA/prepare',
          '/api/launch-market/vault-run/TSLA/rejected',
        ]);
        const calls = await page.evaluate(
          () => (window as unknown as { signInFixture: { calls: string[] } }).signInFixture.calls,
        );
        assert.equal(calls.filter((method: string) => method === 'eth_sendTransaction').length, 1);
        assert.equal(
          calls.some((method: string) => /sendRawTransaction|signTypedData/.test(method)),
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
