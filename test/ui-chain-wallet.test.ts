import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Eip1193WalletConnection,
  Eip1193Wallet,
  PreparedActionFactory,
  WalletFailure,
  type Eip1193Provider,
  type Eip1193Request,
  type PreparedAction,
  type PreparedActionAuthority,
} from '../apps/web/src/chain-wallet.ts';
import { asAddress, asHexData, asTransactionHash } from '../packages/chain-adapter/src/types.ts';

const CHAIN_ID = 46_630;
const OWNER = asAddress('0x1111111111111111111111111111111111111111');
const OTHER_OWNER = asAddress('0x3333333333333333333333333333333333333333');
const CONTRACT = asAddress('0x2222222222222222222222222222222222222222');
const TX_HASH = asTransactionHash(`0x${'aa'.repeat(32)}`);

class ProviderFixture implements Eip1193Provider {
  readonly methods: string[] = [];
  readonly requests: Eip1193Request[] = [];
  readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  readonly sendStarted = Promise.withResolvers<void>();
  readonly simulationStarted = Promise.withResolvers<void>();
  accounts: readonly string[] = [OWNER];
  chainId = '0xb626';
  simulationResult: unknown = '0x';
  simulationResponse: Promise<unknown> | null = null;
  simulationError: unknown = null;
  sendResult: unknown = TX_HASH;
  sendResponse: Promise<unknown> | null = null;
  sendError: unknown = null;
  listenerFailureEvent: 'accountsChanged' | 'chainChanged' | 'disconnect' | null = null;

  on(event: 'accountsChanged' | 'chainChanged' | 'disconnect', listener: (value: unknown) => void): void {
    if (event === this.listenerFailureEvent) throw new Error('provider listener failure');
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(
    event: 'accountsChanged' | 'chainChanged' | 'disconnect',
    listener: (value: unknown) => void,
  ): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: 'accountsChanged' | 'chainChanged' | 'disconnect', value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  async request(input: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown> {
    this.methods.push(input.method);
    this.requests.push(input);
    if (input.method === 'eth_requestAccounts' || input.method === 'eth_accounts') return this.accounts;
    if (input.method === 'eth_chainId') return this.chainId;
    if (input.method === 'eth_call') {
      this.simulationStarted.resolve();
      if (this.simulationError) throw this.simulationError;
      if (this.simulationResponse) return this.simulationResponse;
      return this.simulationResult;
    }
    if (input.method === 'eth_sendTransaction') {
      this.sendStarted.resolve();
      if (this.sendError) throw this.sendError;
      if (this.sendResponse) return this.sendResponse;
      return this.sendResult;
    }
    throw new Error('unexpected method');
  }
}

const factory = new PreparedActionFactory<{ readonly amount: string }>({
  chainId: CHAIN_ID,
  target: CONTRACT,
  operationId: (action) => `deposit-${action.amount}`,
  encode: (action) => ({ data: asHexData(`0x1234${action.amount}`), value: 0n }),
});

test('an asynchronous operation guard must finish before send and a remote Stop prevents submission', async () => {
  const provider = new ProviderFixture();
  const wallet = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
  });
  const started = Promise.withResolvers<void>();
  const guard = Promise.withResolvers<void>();
  const pending = wallet.submit(factory.prepare({ amount: '01' }, OWNER), async () => {
    started.resolve();
    await guard.promise;
    throw new Error('VAULT_RUN_STEP_CHANGED');
  });
  await started.promise;
  assert.equal(provider.methods.includes('eth_sendTransaction'), false);
  guard.resolve();
  await assert.rejects(pending, /VAULT_RUN_STEP_CHANGED/);
  assert.equal(provider.methods.includes('eth_sendTransaction'), false);
});

test('wallet identity is rebound after the asynchronous guard and cannot send on a changed account', async () => {
  const provider = new ProviderFixture();
  const wallet = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
  });
  await assert.rejects(
    wallet.submit(factory.prepare({ amount: '01' }, OWNER), async () => {
      await Promise.resolve();
      provider.accounts = [OTHER_OWNER];
    }),
    /WALLET_ACCOUNT_CHANGED/,
  );
  assert.equal(provider.methods.includes('eth_sendTransaction'), false);
});

test('wallet returns an explicit ambiguous result when account changes during provider confirmation', async () => {
  const provider = new ProviderFixture();
  const response = Promise.withResolvers<unknown>();
  provider.sendResponse = response.promise;
  const wallet = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
    now: () => '2026-09-14T12:00:00.000Z',
  });
  const pending = wallet.submit(factory.prepare({ amount: '01' }, OWNER));
  await provider.sendStarted.promise;
  provider.accounts = [OTHER_OWNER];
  provider.emit('accountsChanged', provider.accounts);
  provider.accounts = [OWNER];
  provider.emit('accountsChanged', provider.accounts);
  response.resolve(TX_HASH);

  assert.deepEqual(await pending, {
    operationId: 'deposit-01',
    target: CONTRACT,
    state: 'SUBMISSION_AMBIGUOUS',
    txHash: TX_HASH,
    observedAt: '2026-09-14T12:00:00.000Z',
    requestedChainId: CHAIN_ID,
    requestedOwner: OWNER,
    reason: 'SESSION_CHANGED',
    retryable: false,
  });
  assert.equal(
    [...provider.listeners.values()].every((listeners) => listeners.size === 0),
    true,
  );
});

test('wallet returns an explicit ambiguous result when chain changes during provider confirmation', async () => {
  const provider = new ProviderFixture();
  const response = Promise.withResolvers<unknown>();
  provider.sendResponse = response.promise;
  const wallet = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
    now: () => '2026-09-14T12:00:00.000Z',
  });
  const pending = wallet.submit(factory.prepare({ amount: '02' }, OWNER));
  await provider.sendStarted.promise;
  provider.chainId = '0x1';
  provider.emit('chainChanged', provider.chainId);
  response.resolve(TX_HASH);

  const result = await pending;
  assert.equal(result.state, 'SUBMISSION_AMBIGUOUS');
  if (result.state !== 'SUBMISSION_AMBIGUOUS') assert.fail('expected ambiguous submission');
  assert.equal(result.reason, 'SESSION_CHANGED');
  assert.equal(result.txHash, TX_HASH);
  assert.equal(
    [...provider.listeners.values()].every((listeners) => listeners.size === 0),
    true,
  );
});

test('provider failure after submission begins is non-retryable and does not claim chain ownership', async () => {
  const provider = new ProviderFixture();
  provider.sendError = { code: -32_000, message: 'unknown provider outcome' };
  const wallet = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
    now: () => '2026-09-14T12:00:00.000Z',
  });
  const result = await wallet.submit(factory.prepare({ amount: '03' }, OWNER));
  assert.deepEqual(result, {
    operationId: 'deposit-03',
    target: CONTRACT,
    state: 'SUBMISSION_AMBIGUOUS',
    txHash: null,
    observedAt: '2026-09-14T12:00:00.000Z',
    requestedChainId: CHAIN_ID,
    requestedOwner: OWNER,
    reason: 'PROVIDER_RESULT_UNKNOWN',
    retryable: false,
  });
});

test('invalid local time after a returned hash preserves the hash as an ambiguous outcome', async () => {
  const provider = new ProviderFixture();
  const wallet = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
    now: () => 'invalid-time',
  });
  const result = await wallet.submit(factory.prepare({ amount: '04' }, OWNER));
  assert.equal(result.state, 'SUBMISSION_AMBIGUOUS');
  if (result.state !== 'SUBMISSION_AMBIGUOUS') assert.fail('expected ambiguous submission');
  assert.equal(result.txHash, TX_HASH);
  assert.equal(result.observedAt, null);
  assert.equal(result.reason, 'LOCAL_EVIDENCE_INVALID');
  assert.equal(result.retryable, false);
});

test('wallet sanitizes listener registration failures and removes partial registrations', async () => {
  const provider = new ProviderFixture();
  provider.listenerFailureEvent = 'chainChanged';
  const wallet = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
  });
  await assert.rejects(
    () => wallet.submit(factory.prepare({ amount: '05' }, OWNER)),
    (error: unknown) => error instanceof WalletFailure && error.code === 'WALLET_REQUEST_FAILED',
  );
  assert.deepEqual(provider.methods, []);
  assert.equal(
    [...provider.listeners.values()].every((listeners) => listeners.size === 0),
    true,
  );
});

test('wallet is inert until explicit connect and connect verifies chain identity', async () => {
  const provider = new ProviderFixture();
  const wallet = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
  });
  assert.deepEqual(provider.methods, []);
  assert.deepEqual(await wallet.connect(), { account: OWNER, chainId: CHAIN_ID });
  assert.deepEqual(provider.methods, ['eth_requestAccounts', 'eth_chainId']);
});

test('wallet verifies account and chain again immediately before submission', async () => {
  const provider = new ProviderFixture();
  const wallet = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
    now: () => '2026-09-14T12:00:00.000Z',
  });
  const prepared = factory.prepare({ amount: '00' }, OWNER);
  const result = await wallet.submit(prepared);
  assert.deepEqual(provider.methods, [
    'eth_accounts',
    'eth_chainId',
    'eth_call',
    'eth_accounts',
    'eth_chainId',
    'eth_sendTransaction',
    'eth_accounts',
    'eth_chainId',
  ]);
  assert.deepEqual(result, {
    operationId: 'deposit-00',
    chainId: CHAIN_ID,
    owner: OWNER,
    target: CONTRACT,
    state: 'SUBMITTED',
    txHash: TX_HASH,
    submittedAt: '2026-09-14T12:00:00.000Z',
  });
  assert.deepEqual(provider.requests[2], {
    method: 'eth_call',
    params: [{ from: OWNER, to: CONTRACT, data: '0x123400', value: '0x0' }, 'latest'],
  });
  assert.deepEqual(provider.requests[5], {
    method: 'eth_sendTransaction',
    params: [{ from: OWNER, to: CONTRACT, data: '0x123400', value: '0x0' }],
  });
  assert.equal('ownerId' in result, false);
  assert.equal('demoIdentity' in result, false);
});

test('wallet runs the final guard after preflight checks and aborts before submission when it rejects', async () => {
  const provider = new ProviderFixture();
  const wallet = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
  });
  let guardCalls = 0;

  await assert.rejects(
    wallet.submit(factory.prepare({ amount: '08' }, OWNER), () => {
      guardCalls += 1;
      assert.equal(provider.methods.at(-1), 'eth_chainId');
      assert.equal(provider.methods.includes('eth_call'), true);
      assert.equal(provider.methods.includes('eth_sendTransaction'), false);
      throw new Error('M3_VAULT_SELECTION_CHANGED');
    }),
    /M3_VAULT_SELECTION_CHANGED/,
  );

  assert.equal(guardCalls, 1);
  assert.equal(provider.methods.includes('eth_sendTransaction'), false);
});

test('wallet fails closed when preflight simulation rejects or returns malformed data', async () => {
  const provider = new ProviderFixture();
  const wallet = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
  });
  const prepared = factory.prepare({ amount: '06' }, OWNER);
  provider.simulationError = { code: -32_000, message: 'private provider detail' };
  await assert.rejects(
    () => wallet.submit(prepared),
    (error: unknown) =>
      error instanceof WalletFailure &&
      error.code === 'WALLET_SIMULATION_FAILED' &&
      !error.message.includes('private'),
  );
  assert.equal(provider.methods.includes('eth_sendTransaction'), false);

  provider.simulationError = null;
  provider.simulationResult = 'not-hex';
  await assert.rejects(
    () => wallet.submit(prepared),
    (error: unknown) => error instanceof WalletFailure && error.code === 'WALLET_SIMULATION_FAILED',
  );
  assert.equal(provider.methods.includes('eth_sendTransaction'), false);
});

test('wallet rechecks account and chain after simulation before asking for submission', async () => {
  const provider = new ProviderFixture();
  const simulated = Promise.withResolvers<unknown>();
  provider.simulationResponse = simulated.promise;
  const wallet = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
  });
  const pending = wallet.submit(factory.prepare({ amount: '07' }, OWNER));
  await provider.simulationStarted.promise;
  provider.accounts = [OTHER_OWNER];
  simulated.resolve('0x');
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof WalletFailure && error.code === 'WALLET_ACCOUNT_CHANGED',
  );
  assert.equal(provider.methods.includes('eth_sendTransaction'), false);
});

test('changed account, changed chain and forged prepared data fail before submission', async () => {
  const provider = new ProviderFixture();
  const wallet = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
  });
  const prepared = factory.prepare({ amount: '00' }, OWNER);

  provider.accounts = [OTHER_OWNER];
  await assert.rejects(
    () => wallet.submit(prepared),
    (error: unknown) => {
      return error instanceof WalletFailure && error.code === 'WALLET_ACCOUNT_CHANGED';
    },
  );
  provider.accounts = [OWNER];
  provider.chainId = '0x1';
  await assert.rejects(
    () => wallet.submit(prepared),
    (error: unknown) => {
      return error instanceof WalletFailure && error.code === 'WALLET_WRONG_CHAIN';
    },
  );
  provider.chainId = '0xb626';
  await assert.rejects(
    () => wallet.submit({ ...prepared } as PreparedAction),
    (error: unknown) => {
      return error instanceof WalletFailure && error.code === 'UNTRUSTED_PREPARED_ACTION';
    },
  );
  const foreignFactory = new PreparedActionFactory<{ readonly amount: string }>({
    chainId: CHAIN_ID,
    target: CONTRACT,
    operationId: () => 'foreign-action',
    encode: () => ({ data: asHexData('0x1234'), value: 0n }),
  });
  await assert.rejects(
    () => wallet.submit(foreignFactory.prepare({ amount: '00' }, OWNER)),
    (error: unknown) => {
      return error instanceof WalletFailure && error.code === 'UNTRUSTED_PREPARED_ACTION';
    },
  );
  assert.equal(provider.methods.includes('eth_sendTransaction'), false);
});

test('wallet rejection is deterministic while an invalid provider result is explicitly ambiguous', async () => {
  const provider = new ProviderFixture();
  const wallet = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
  });
  const prepared = factory.prepare({ amount: '00' }, OWNER);
  provider.sendError = { code: 4001, message: 'secret provider detail' };
  await assert.rejects(
    () => wallet.submit(prepared),
    (error: unknown) => {
      return (
        error instanceof WalletFailure &&
        error.code === 'WALLET_REJECTED' &&
        !error.message.includes('secret')
      );
    },
  );
  provider.sendError = null;
  provider.sendResult = 'not-a-hash';
  const ambiguous = await wallet.submit(prepared);
  assert.equal(ambiguous.state, 'SUBMISSION_AMBIGUOUS');
  if (ambiguous.state !== 'SUBMISSION_AMBIGUOUS') assert.fail('expected ambiguous submission');
  assert.equal(ambiguous.txHash, null);
  assert.equal(ambiguous.reason, 'PROVIDER_RESULT_UNKNOWN');
  assert.equal(ambiguous.retryable, false);
});

test('prepared action factory rejects values outside the EVM uint256 range', () => {
  const invalidFactory = new PreparedActionFactory<null>({
    chainId: CHAIN_ID,
    target: CONTRACT,
    operationId: () => 'invalid-value',
    encode: () => ({ data: asHexData('0x'), value: 1n << 256n }),
  });
  assert.throws(() => invalidFactory.prepare(null, OWNER), /INVALID_TRANSACTION_VALUE/);
});

test('wallet construction and prepared action validators reject invalid authority boundaries', () => {
  assert.throws(
    () =>
      new PreparedActionFactory<null>({
        chainId: 0,
        target: CONTRACT,
        operationId: () => 'valid',
        encode: () => ({ data: asHexData('0x'), value: 0n }),
      }),
    /INVALID_CHAIN_ID/,
  );
  const invalidOperation = new PreparedActionFactory<null>({
    chainId: CHAIN_ID,
    target: CONTRACT,
    operationId: () => 'invalid operation',
    encode: () => ({ data: asHexData('0x'), value: 0n }),
  });
  assert.throws(() => invalidOperation.prepare(null, OWNER), /INVALID_OPERATION_ID/);
  const oversized = new PreparedActionFactory<null>({
    chainId: CHAIN_ID,
    target: CONTRACT,
    operationId: () => 'oversized',
    encode: () => ({ data: asHexData(`0x${'00'.repeat(131_073)}`), value: 0n }),
  });
  assert.throws(() => oversized.prepare(null, OWNER), /TRANSACTION_DATA_TOO_LARGE/);

  assert.throws(
    () =>
      new Eip1193Wallet({} as Eip1193Provider, {
        chainId: CHAIN_ID,
        target: CONTRACT,
        actionAuthority: factory.authority,
      }),
    /INVALID_EIP1193_PROVIDER/,
  );
  assert.throws(
    () =>
      new Eip1193Wallet(new ProviderFixture(), {
        chainId: CHAIN_ID,
        target: CONTRACT,
        actionAuthority: {} as PreparedActionAuthority,
      }),
    /INVALID_ACTION_AUTHORITY/,
  );
});

test('wallet connection sanitizes malformed accounts, chain ids and provider failures', async () => {
  for (const accounts of [null, ['invalid']] as const) {
    const provider = new ProviderFixture();
    provider.accounts = accounts as unknown as readonly string[];
    const connection = new Eip1193WalletConnection(provider, CHAIN_ID);
    await assert.rejects(
      connection.connect(),
      (error: unknown) => error instanceof WalletFailure && error.code === 'WALLET_INVALID_RESPONSE',
    );
  }

  const empty = new ProviderFixture();
  empty.accounts = [];
  await assert.rejects(
    new Eip1193WalletConnection(empty, CHAIN_ID).connect(),
    (error: unknown) => error instanceof WalletFailure && error.code === 'WALLET_DISCONNECTED',
  );

  for (const chainId of [1, '0x01', '0x0', `0x${'f'.repeat(32)}`] as const) {
    const provider = new ProviderFixture();
    provider.chainId = chainId as string;
    await assert.rejects(
      new Eip1193WalletConnection(provider, CHAIN_ID).connect(),
      (error: unknown) => error instanceof WalletFailure && error.code === 'WALLET_INVALID_RESPONSE',
    );
  }

  for (const failure of [{ code: 4001 }, new Error('provider detail')]) {
    const provider = new ProviderFixture();
    provider.request = () => Promise.reject(failure);
    await assert.rejects(
      new Eip1193WalletConnection(provider, CHAIN_ID).connect(),
      (error: unknown) =>
        error instanceof WalletFailure &&
        error.code === ('code' in failure ? 'WALLET_REJECTED' : 'WALLET_REQUEST_FAILED'),
    );
  }

  const chainFailure = new ProviderFixture();
  const request = chainFailure.request.bind(chainFailure);
  chainFailure.request = (input) =>
    input.method === 'eth_chainId' ? Promise.reject(new Error('chain detail')) : request(input);
  await assert.rejects(
    new Eip1193WalletConnection(chainFailure, CHAIN_ID).connect(),
    (error: unknown) => error instanceof WalletFailure && error.code === 'WALLET_REQUEST_FAILED',
  );
});

test('wallet rejects trusted actions whose chain or target differs from its authority context', async () => {
  const provider = new ProviderFixture();
  const prepared = factory.prepare({ amount: '08' }, OWNER);
  const targetMismatch = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID,
    target: OTHER_OWNER,
    actionAuthority: factory.authority,
  });
  await assert.rejects(
    targetMismatch.submit(prepared),
    (error: unknown) => error instanceof WalletFailure && error.code === 'UNTRUSTED_PREPARED_ACTION',
  );
  const chainMismatch = new Eip1193Wallet(provider, {
    chainId: CHAIN_ID + 1,
    target: CONTRACT,
    actionAuthority: factory.authority,
  });
  await assert.rejects(
    chainMismatch.submit(prepared),
    (error: unknown) => error instanceof WalletFailure && error.code === 'UNTRUSTED_PREPARED_ACTION',
  );
});

test('wallet fails closed for missing or changed sessions at each pre-submit checkpoint', async () => {
  const cases: Array<{
    mutate(provider: ProviderFixture): void;
    code: WalletFailure['code'];
  }> = [
    {
      mutate: (provider) => {
        provider.accounts = [];
      },
      code: 'WALLET_DISCONNECTED',
    },
    {
      mutate: (provider) => {
        const request = provider.request.bind(provider);
        let accountReads = 0;
        provider.request = (input) => {
          if (input.method === 'eth_accounts' && ++accountReads === 2) return Promise.resolve([]);
          return request(input);
        };
      },
      code: 'WALLET_DISCONNECTED',
    },
    {
      mutate: (provider) => {
        const request = provider.request.bind(provider);
        let chainReads = 0;
        provider.request = (input) => {
          if (input.method === 'eth_chainId' && ++chainReads === 2) return Promise.resolve('0x1');
          return request(input);
        };
      },
      code: 'WALLET_WRONG_CHAIN',
    },
    {
      mutate: (provider) => {
        const request = provider.request.bind(provider);
        provider.request = async (input) => {
          const result = await request(input);
          if (input.method === 'eth_accounts') provider.emit('disconnect', null);
          return result;
        };
      },
      code: 'WALLET_SESSION_CHANGED',
    },
    {
      mutate: (provider) => {
        const request = provider.request.bind(provider);
        provider.request = async (input) => {
          const result = await request(input);
          if (input.method === 'eth_call') provider.emit('chainChanged', '0x1');
          return result;
        };
      },
      code: 'WALLET_SESSION_CHANGED',
    },
  ];
  for (const item of cases) {
    const provider = new ProviderFixture();
    item.mutate(provider);
    const wallet = new Eip1193Wallet(provider, {
      chainId: CHAIN_ID,
      target: CONTRACT,
      actionAuthority: factory.authority,
    });
    await assert.rejects(
      wallet.submit(factory.prepare({ amount: '09' }, OWNER)),
      (error: unknown) => error instanceof WalletFailure && error.code === item.code,
    );
  }
});

test('post-submit observation and cleanup failures preserve an explicit result', async () => {
  const observationFailure = new ProviderFixture();
  const request = observationFailure.request.bind(observationFailure);
  let accountReads = 0;
  observationFailure.request = (input) => {
    if (input.method === 'eth_accounts' && ++accountReads === 3)
      return Promise.reject(new Error('post-submit detail'));
    return request(input);
  };
  const ambiguous = await new Eip1193Wallet(observationFailure, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
    now: () => '2026-09-14T12:00:00.000Z',
  }).submit(factory.prepare({ amount: '10' }, OWNER));
  assert.equal(ambiguous.state, 'SUBMISSION_AMBIGUOUS');
  if (ambiguous.state !== 'SUBMISSION_AMBIGUOUS') assert.fail('expected ambiguous submission');
  assert.equal(ambiguous.reason, 'POST_SUBMISSION_CHECK_FAILED');

  const cleanupFailure = new ProviderFixture();
  cleanupFailure.removeListener = () => {
    throw new Error('cleanup detail');
  };
  const submitted = await new Eip1193Wallet(cleanupFailure, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
    now: () => '2026-09-14T12:00:00.000Z',
  }).submit(factory.prepare({ amount: '11' }, OWNER));
  assert.equal(submitted.state, 'SUBMITTED');

  const invalidTime = new ProviderFixture();
  const invalidTimeResult = await new Eip1193Wallet(invalidTime, {
    chainId: CHAIN_ID,
    target: CONTRACT,
    actionAuthority: factory.authority,
    now: () => {
      throw new Error('clock detail');
    },
  }).submit(factory.prepare({ amount: '12' }, OWNER));
  assert.equal(invalidTimeResult.state, 'SUBMISSION_AMBIGUOUS');
  if (invalidTimeResult.state !== 'SUBMISSION_AMBIGUOUS') assert.fail('expected ambiguous submission');
  assert.equal(invalidTimeResult.reason, 'LOCAL_EVIDENCE_INVALID');
});
