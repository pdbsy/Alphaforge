import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Wallet, getBytes, toUtf8String } from 'ethers';
import { LaunchMarketClient, MarketApiError, createLaunchApi } from '../apps/web/src/launch-market/client.ts';
import { LaunchMarketStore, type WalletBindingChallenge } from '../packages/launch-market/src/store.ts';
import { fixture, NOW, OTHER } from './helpers/launch-market-ui-fixture.ts';

const origin = 'https://www.ikol.top';
const prefix = '/api/launch-market';
interface ClockFixtureOptions {
  deviceOffset?: number;
  dateHeader?: string | null;
  issuedOffset?: number;
  mutate?: (challenge: WalletBindingChallenge) => WalletBindingChallenge;
  onChallengeResponse?: () => void;
}

async function clockFixture(context: TestContext, options: ClockFixtureOptions = {}) {
  const f = fixture();
  const signer = Wallet.createRandom();
  const store = new LaunchMarketStore(':memory:', origin);
  context.after(() => store.close());
  f.provider.owner = signer.address;
  f.state.config = { ...f.state.config, emailVerificationRequired: false };
  f.state.account = null;
  f.state.wallet = { ...f.state.wallet, owner: signer.address, accountId: null };
  const requests: { path: string; method: string }[] = [];
  let challenge: WalletBindingChallenge | null = null;
  let submitted: { nonce: string; signature: string } | null = null;
  const original = f.provider.request.bind(f.provider);
  f.provider.request = async (input) => {
    if (input.method !== 'personal_sign') return original(input);
    f.provider.calls.push(input);
    const message = toUtf8String(getBytes(input.params![0] as string));
    assert.equal(message, challenge!.message);
    assert.equal(message.split('\n')[1], signer.address);
    assert.equal(input.params![1], message.split('\n')[1]);
    return signer.signMessage(message);
  };
  const fetcher = (async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ path, method });
    const json = (value: unknown, status = 200, dateHeader: string | null = null) =>
      new Response(JSON.stringify(value), {
        status,
        headers: {
          'content-type': 'application/json',
          ...(dateHeader === null ? {} : { Date: dateHeader }),
        },
      });
    if (path === `${prefix}/wallet/test-challenge` && method === 'POST') {
      assert.equal(init?.credentials, 'same-origin');
      assert.equal(init?.cache, 'no-store');
      assert.deepEqual(JSON.parse(init!.body as string), { owner: signer.address });
      const issued = store.walletTestChallenge(signer.address, NOW + (options.issuedOffset ?? 0));
      challenge = options.mutate ? options.mutate(issued) : issued;
      options.onChallengeResponse?.();
      return json(
        challenge,
        200,
        options.dateHeader === undefined ? new Date(NOW * 1000).toUTCString() : options.dateHeader,
      );
    }
    if (path === `${prefix}/wallet/test-session` && method === 'POST') {
      submitted = JSON.parse(init!.body as string) as { nonce: string; signature: string };
      const opened = store.openWalletTestSession(submitted.nonce, submitted.signature, NOW);
      assert.equal(opened.account.wallet, signer.address.toLowerCase());
      assert.equal(opened.account.identityKind, 'WALLET_TEST');
      assert.equal(opened.account.email, null);
      f.state.account = {
        id: opened.account.id,
        accountKey: opened.account.accountKey,
        wallet: opened.account.wallet,
        emailVerified: false,
        identityKind: 'WALLET_TEST',
        claimStatus: 'ELIGIBLE',
      };
      f.state.wallet = { ...f.state.wallet, accountId: opened.account.id };
      return json(f.state.account);
    }
    try {
      return json(await f.api(path));
    } catch (error) {
      if (error instanceof MarketApiError) return json({ error: { code: error.message } }, error.status);
      throw error;
    }
  }) as typeof fetch;
  const client = new LaunchMarketClient({
    api: createLaunchApi(fetcher),
    provider: f.provider,
    now: () => NOW + (options.deviceOffset ?? 0),
    origin,
  });
  assert.equal(await client.initialize(), true);
  await client.connect();
  assert.equal(client.state.account, null);
  return {
    client,
    provider: f.provider,
    store,
    requests,
    submitted: () => submitted,
  };
}

function assertNoSignature(f: Awaited<ReturnType<typeof clockFixture>>): void {
  assert.equal(
    f.provider.calls.some((call) => call.method === 'personal_sign'),
    false,
  );
  assert.equal(
    f.provider.calls.some((call) => call.method === 'eth_sendTransaction'),
    false,
  );
  assert.equal(
    f.requests.some((request) => request.path.endsWith('/test-session')),
    false,
  );
  assert.equal(f.client.state.account, null);
}

test('same-origin challenge Date permits a device clock one second or one day away from the server', async (context) => {
  for (const deviceOffset of [-1, -86400, 86400]) {
    await context.test(`device offset ${deviceOffset} seconds`, async (child) => {
      const f = await clockFixture(child, { deviceOffset });
      await f.client.bindWallet();
      assert.equal(f.provider.calls.filter((call) => call.method === 'personal_sign').length, 1);
      assert.equal(f.client.state.account!.identityKind, 'WALLET_TEST');
      assert.equal(f.client.state.wallet!.accountId, f.client.state.account!.id);
      const submitted = f.submitted()!;
      assert.throws(
        () => f.store.openWalletTestSession(submitted.nonce, submitted.signature, NOW),
        /WALLET_CHALLENGE_EXPIRED/,
      );
      assert.equal(
        f.provider.calls.some((call) => call.method === 'eth_sendTransaction'),
        false,
      );
    });
  }
});

test('missing or invalid challenge Date keeps strict device-clock validation', async (context) => {
  for (const dateHeader of [null, 'not-a-date']) {
    for (const deviceOffset of [-1, -86400, 86400]) {
      await context.test(`${dateHeader ?? 'missing'} Date, offset ${deviceOffset}`, async (child) => {
        const f = await clockFixture(child, { dateHeader, deviceOffset });
        await assert.rejects(f.client.bindWallet(), /WALLET_CHALLENGE_INVALID/);
        assertNoSignature(f);
      });
    }
    await context.test(`${dateHeader ?? 'missing'} Date, synchronized device`, async (child) => {
      const f = await clockFixture(child, { dateHeader });
      await f.client.bindWallet();
      assert.equal(f.client.state.account!.identityKind, 'WALLET_TEST');
    });
  }
});

test('a whole-second response Date cached before issuance still permits a fresh challenge', async (context) => {
  const f = await clockFixture(context, {
    dateHeader: new Date((NOW - 1) * 1000).toUTCString(),
    deviceOffset: -86400,
  });
  await f.client.bindWallet();
  assert.equal(f.client.state.account!.identityKind, 'WALLET_TEST');
  assert.equal(f.provider.calls.filter((call) => call.method === 'personal_sign').length, 1);
});

test('JSON time fields cannot replace the authenticated challenge response Date', async (context) => {
  const forged = (serverNow: number) => (challenge: WalletBindingChallenge) => ({
    ...challenge,
    serverNow,
    now: serverNow,
    responseDate: new Date(serverNow * 1000).toUTCString(),
    responseDateMs: serverNow * 1000,
    challengeClock: { serverNow },
  });
  await context.test('valid header wins over forged expired JSON clock', async (child) => {
    const f = await clockFixture(child, { deviceOffset: 86400, mutate: forged(NOW + 86400) });
    await f.client.bindWallet();
    assert.equal(f.client.state.account!.identityKind, 'WALLET_TEST');
  });
  await context.test('forged JSON clock cannot rescue a missing header and skewed device', async (child) => {
    const f = await clockFixture(child, { dateHeader: null, deviceOffset: -86400, mutate: forged(NOW) });
    await assert.rejects(f.client.bindWallet(), /WALLET_CHALLENGE_INVALID/);
    assertNoSignature(f);
  });
  await context.test('forged JSON clock cannot rescue a challenge expired at header time', async (child) => {
    const f = await clockFixture(child, {
      dateHeader: new Date((NOW + 300) * 1000).toUTCString(),
      mutate: forged(NOW),
    });
    await assert.rejects(f.client.bindWallet(), /WALLET_CHALLENGE_INVALID/);
    assertNoSignature(f);
  });
});

test('server-clock validation rejects future, expired and oversized challenges before signing', async (context) => {
  const cases: { name: string; options: ClockFixtureOptions }[] = [
    { name: 'issue time beyond the whole-second Date bound', options: { issuedOffset: 2 } },
    { name: 'expiry at response time', options: { issuedOffset: -300 } },
    {
      name: '301-second lifetime with an otherwise fresh response',
      options: {
        dateHeader: new Date((NOW + 1) * 1000).toUTCString(),
        mutate: (challenge) => ({
          ...challenge,
          expiresAt: challenge.expiresAt + 1,
          message: challenge.message.replace(
            new Date(challenge.expiresAt * 1000).toISOString(),
            new Date((challenge.expiresAt + 1) * 1000).toISOString(),
          ),
        }),
      },
    },
  ];
  for (const { name, options } of cases) {
    await context.test(name, async (child) => {
      const f = await clockFixture(child, { ...options, deviceOffset: -86400 });
      await assert.rejects(f.client.bindWallet(), /WALLET_CHALLENGE_INVALID/);
      assertNoSignature(f);
    });
  }
});

test('trusted response time does not weaken domain, chain, wallet or nonce binding', async (context) => {
  const cases: { name: string; mutate: NonNullable<ClockFixtureOptions['mutate']> }[] = [
    {
      name: 'different domain and URI',
      mutate: (challenge) => ({
        ...challenge,
        message: challenge.message.replaceAll('www.ikol.top', 'untrusted.example'),
      }),
    },
    {
      name: 'different chain',
      mutate: (challenge) => ({
        ...challenge,
        message: challenge.message.replace('Chain ID: 46630', 'Chain ID: 1'),
      }),
    },
    {
      name: 'different wallet',
      mutate: (challenge) => ({
        ...challenge,
        message: challenge.message.replace(/^0x[a-fA-F0-9]{40}$/m, OTHER),
      }),
    },
    { name: 'nonce mismatch', mutate: (challenge) => ({ ...challenge, nonce: 'ff'.repeat(24) }) },
    {
      name: 'malformed nonce in matching message',
      mutate: (challenge) => ({
        ...challenge,
        nonce: 'gg'.repeat(24),
        message: challenge.message.replace(challenge.nonce, 'gg'.repeat(24)),
      }),
    },
  ];
  for (const { name, mutate } of cases) {
    await context.test(name, async (child) => {
      const f = await clockFixture(child, { deviceOffset: 86400, mutate });
      await assert.rejects(f.client.bindWallet(), /WALLET_CHALLENGE_INVALID/);
      assertNoSignature(f);
    });
  }
});

test('monotonic elapsed time expires a challenge even when the device wall clock stays behind', async (context) => {
  let elapsedMs = 0;
  context.mock.method(performance, 'now', () => elapsedMs);
  const f = await clockFixture(context, {
    deviceOffset: -86400,
    onChallengeResponse: () => {
      elapsedMs = 301000;
    },
  });
  await assert.rejects(f.client.bindWallet(), /WALLET_CHALLENGE_INVALID/);
  assertNoSignature(f);
});
