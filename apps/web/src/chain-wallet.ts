import {
  asAddress,
  asHexData,
  asTransactionHash,
  sameAddress,
  type Address,
  type HexData,
  type TransactionHash,
} from '../../../packages/chain-adapter/src/types.ts';

export interface Eip1193Request {
  readonly method: string;
  readonly params?: readonly unknown[];
}

export interface Eip1193Provider {
  request(input: Eip1193Request): Promise<unknown>;
  on(event: 'accountsChanged' | 'chainChanged' | 'disconnect', listener: (value: unknown) => void): void;
  removeListener(
    event: 'accountsChanged' | 'chainChanged' | 'disconnect',
    listener: (value: unknown) => void,
  ): void;
}

export type WalletFailureCode =
  | 'WALLET_DISCONNECTED'
  | 'WALLET_WRONG_CHAIN'
  | 'WALLET_ACCOUNT_CHANGED'
  | 'WALLET_SESSION_CHANGED'
  | 'WALLET_REJECTED'
  | 'WALLET_INVALID_RESPONSE'
  | 'WALLET_REQUEST_FAILED'
  | 'WALLET_SIMULATION_FAILED'
  | 'UNTRUSTED_PREPARED_ACTION';

export class WalletFailure extends Error {
  readonly code: WalletFailureCode;

  constructor(code: WalletFailureCode) {
    super(code);
    this.name = 'WalletFailure';
    this.code = code;
  }
}

export interface WalletSession {
  readonly account: Address;
  readonly chainId: number;
}

export interface PreparedAction {
  readonly operationId: string;
  readonly chainId: number;
  readonly owner: Address;
  readonly target: Address;
  readonly data: HexData;
  readonly value: bigint;
}

declare const preparedActionAuthorityBrand: unique symbol;
export interface PreparedActionAuthority {
  readonly [preparedActionAuthorityBrand]: true;
}

interface PreparedActionPolicy<Action> {
  readonly chainId: number;
  readonly target: Address;
  readonly operationId: (action: Action) => string;
  readonly encode: (
    action: Action,
    owner: Address,
  ) => {
    readonly data: HexData;
    readonly value: bigint;
  };
}

const trustedAuthorities = new WeakSet<object>();
const trustedActions = new WeakMap<object, PreparedActionAuthority>();
const maximumTransactionValue = (1n << 256n) - 1n;
const maximumCalldataBytes = 131_072;

function validChainId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('INVALID_CHAIN_ID');
  return value;
}

function validOperationId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error('INVALID_OPERATION_ID');
  return value;
}

export class PreparedActionFactory<Action> {
  readonly #policy: PreparedActionPolicy<Action>;
  readonly authority: PreparedActionAuthority;

  constructor(policy: PreparedActionPolicy<Action>) {
    this.#policy = Object.freeze({
      ...policy,
      chainId: validChainId(policy.chainId),
      target: asAddress(policy.target),
    });
    this.authority = Object.freeze({}) as PreparedActionAuthority;
    trustedAuthorities.add(this.authority);
  }

  prepare(action: Action, owner: Address): PreparedAction {
    const encoded = this.#policy.encode(action, owner);
    if (encoded.value < 0n || encoded.value > maximumTransactionValue)
      throw new Error('INVALID_TRANSACTION_VALUE');
    const data = asHexData(encoded.data);
    if ((data.length - 2) / 2 > maximumCalldataBytes) throw new Error('TRANSACTION_DATA_TOO_LARGE');
    const prepared: PreparedAction = Object.freeze({
      operationId: validOperationId(this.#policy.operationId(action)),
      chainId: this.#policy.chainId,
      owner: asAddress(owner),
      target: this.#policy.target,
      data,
      value: encoded.value,
    });
    trustedActions.set(prepared, this.authority);
    return prepared;
  }
}

export interface SubmittedOperation {
  readonly operationId: string;
  readonly chainId: number;
  readonly owner: Address;
  readonly target: Address;
  readonly state: 'SUBMITTED';
  readonly txHash: TransactionHash;
  readonly submittedAt: string;
}

export interface AmbiguousSubmission {
  readonly operationId: string;
  readonly requestedChainId: number;
  readonly requestedOwner: Address;
  readonly target: Address;
  readonly state: 'SUBMISSION_AMBIGUOUS';
  readonly txHash: TransactionHash | null;
  readonly observedAt: string | null;
  readonly reason:
    'SESSION_CHANGED' | 'POST_SUBMISSION_CHECK_FAILED' | 'PROVIDER_RESULT_UNKNOWN' | 'LOCAL_EVIDENCE_INVALID';
  readonly retryable: false;
}

export type WalletSubmission = SubmittedOperation | AmbiguousSubmission;
export type BeforeWalletSend = () => void | Promise<void>;

export interface BrowserWalletPort {
  connect(): Promise<WalletSession>;
  submit(prepared: PreparedAction, beforeSend?: BeforeWalletSend): Promise<WalletSubmission>;
}

export interface BrowserWalletConnectionPort {
  connect(): Promise<WalletSession>;
  observe(): Promise<WalletSession | null>;
}

interface WalletOptions {
  readonly chainId: number;
  readonly target: Address;
  readonly actionAuthority: PreparedActionAuthority;
  readonly now?: () => string;
}

function parseAccounts(value: unknown): readonly Address[] {
  if (!Array.isArray(value)) throw new WalletFailure('WALLET_INVALID_RESPONSE');
  try {
    return Object.freeze(value.map((entry) => asAddress(String(entry))));
  } catch {
    throw new WalletFailure('WALLET_INVALID_RESPONSE');
  }
}

function parseChainId(value: unknown): number {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value))
    throw new WalletFailure('WALLET_INVALID_RESPONSE');
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER))
    throw new WalletFailure('WALLET_INVALID_RESPONSE');
  return Number(parsed);
}

function rejected(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 4001);
}

function validProvider(provider: Eip1193Provider): Eip1193Provider {
  if (
    !provider ||
    typeof provider.request !== 'function' ||
    typeof provider.on !== 'function' ||
    typeof provider.removeListener !== 'function'
  )
    throw new Error('INVALID_EIP1193_PROVIDER');
  return provider;
}

export class Eip1193WalletConnection implements BrowserWalletConnectionPort {
  readonly #provider: Eip1193Provider;
  readonly #chainId: number;

  constructor(provider: Eip1193Provider, chainId: number) {
    this.#provider = validProvider(provider);
    this.#chainId = validChainId(chainId);
  }

  async #accounts(method: 'eth_accounts' | 'eth_requestAccounts'): Promise<readonly Address[]> {
    try {
      return parseAccounts(await this.#provider.request({ method }));
    } catch (error) {
      if (error instanceof WalletFailure) throw error;
      if (rejected(error)) throw new WalletFailure('WALLET_REJECTED');
      throw new WalletFailure('WALLET_REQUEST_FAILED');
    }
  }

  async #currentChainId(): Promise<number> {
    try {
      return parseChainId(await this.#provider.request({ method: 'eth_chainId' }));
    } catch (error) {
      if (error instanceof WalletFailure) throw error;
      throw new WalletFailure('WALLET_REQUEST_FAILED');
    }
  }

  async #session(method: 'eth_accounts' | 'eth_requestAccounts'): Promise<WalletSession | null> {
    const accounts = await this.#accounts(method);
    if (!accounts[0]) return null;
    return Object.freeze({ account: accounts[0], chainId: await this.#currentChainId() });
  }

  async connect(): Promise<WalletSession> {
    const session = await this.#session('eth_requestAccounts');
    if (!session) throw new WalletFailure('WALLET_DISCONNECTED');
    if (session.chainId !== this.#chainId) throw new WalletFailure('WALLET_WRONG_CHAIN');
    return session;
  }

  observe(): Promise<WalletSession | null> {
    return this.#session('eth_accounts');
  }
}

export class Eip1193Wallet implements BrowserWalletPort {
  readonly #provider: Eip1193Provider;
  readonly #connection: Eip1193WalletConnection;
  readonly #chainId: number;
  readonly #target: Address;
  readonly #actionAuthority: PreparedActionAuthority;
  readonly #now: () => string;

  constructor(provider: Eip1193Provider, options: WalletOptions) {
    this.#provider = validProvider(provider);
    this.#chainId = validChainId(options.chainId);
    this.#connection = new Eip1193WalletConnection(provider, this.#chainId);
    this.#target = asAddress(options.target);
    if (!trustedAuthorities.has(options.actionAuthority)) throw new Error('INVALID_ACTION_AUTHORITY');
    this.#actionAuthority = options.actionAuthority;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async connect(): Promise<WalletSession> {
    return this.#connection.connect();
  }

  #ambiguous(
    prepared: PreparedAction,
    txHash: TransactionHash | null,
    observedAt: string | null,
    reason: AmbiguousSubmission['reason'],
  ): AmbiguousSubmission {
    return Object.freeze({
      operationId: prepared.operationId,
      requestedChainId: prepared.chainId,
      requestedOwner: prepared.owner,
      target: prepared.target,
      state: 'SUBMISSION_AMBIGUOUS',
      txHash,
      observedAt,
      reason,
      retryable: false,
    });
  }

  #observationTime(): string | null {
    try {
      const value = this.#now();
      return Number.isFinite(Date.parse(value)) ? value : null;
    } catch {
      return null;
    }
  }

  async submit(prepared: PreparedAction, beforeSend?: BeforeWalletSend): Promise<WalletSubmission> {
    if (!prepared || typeof prepared !== 'object' || trustedActions.get(prepared) !== this.#actionAuthority)
      throw new WalletFailure('UNTRUSTED_PREPARED_ACTION');
    if (prepared.chainId !== this.#chainId || !sameAddress(prepared.target, this.#target))
      throw new WalletFailure('UNTRUSTED_PREPARED_ACTION');

    const session = { changed: false };
    const invalidateSession = () => {
      session.changed = true;
    };
    const registeredEvents: ('accountsChanged' | 'chainChanged' | 'disconnect')[] = [];
    try {
      for (const event of ['accountsChanged', 'chainChanged', 'disconnect'] as const) {
        try {
          this.#provider.on(event, invalidateSession);
        } catch {
          throw new WalletFailure('WALLET_REQUEST_FAILED');
        }
        registeredEvents.push(event);
      }
      const current = await this.#connection.observe();
      if (!current) throw new WalletFailure('WALLET_DISCONNECTED');
      if (!sameAddress(current.account, prepared.owner)) throw new WalletFailure('WALLET_ACCOUNT_CHANGED');
      if (current.chainId !== this.#chainId) throw new WalletFailure('WALLET_WRONG_CHAIN');
      if (session.changed) throw new WalletFailure('WALLET_SESSION_CHANGED');

      const transaction = Object.freeze({
        from: prepared.owner,
        to: prepared.target,
        data: prepared.data,
        value: `0x${prepared.value.toString(16)}`,
      });
      try {
        const simulated = await this.#provider.request({
          method: 'eth_call',
          params: [transaction, 'latest'],
        });
        asHexData(String(simulated));
      } catch {
        throw new WalletFailure('WALLET_SIMULATION_FAILED');
      }

      const preSubmit = await this.#connection.observe();
      if (!preSubmit) throw new WalletFailure('WALLET_DISCONNECTED');
      if (!sameAddress(preSubmit.account, prepared.owner)) throw new WalletFailure('WALLET_ACCOUNT_CHANGED');
      if (preSubmit.chainId !== this.#chainId) throw new WalletFailure('WALLET_WRONG_CHAIN');
      if (session.changed) throw new WalletFailure('WALLET_SESSION_CHANGED');

      await beforeSend?.();
      // A remote action guard may await a cross-device pause check. Bind the
      // wallet again after that wait, before handing the transaction to it.
      if (beforeSend) {
        const guarded = await this.#connection.observe();
        if (!guarded) throw new WalletFailure('WALLET_DISCONNECTED');
        if (!sameAddress(guarded.account, prepared.owner)) throw new WalletFailure('WALLET_ACCOUNT_CHANGED');
        if (guarded.chainId !== this.#chainId) throw new WalletFailure('WALLET_WRONG_CHAIN');
        if (session.changed) throw new WalletFailure('WALLET_SESSION_CHANGED');
      }
      let result: unknown;
      try {
        result = await this.#provider.request({
          method: 'eth_sendTransaction',
          params: [transaction],
        });
      } catch (error) {
        if (rejected(error)) throw new WalletFailure('WALLET_REJECTED');
        return this.#ambiguous(prepared, null, this.#observationTime(), 'PROVIDER_RESULT_UNKNOWN');
      }
      let txHash: TransactionHash;
      try {
        txHash = asTransactionHash(String(result));
      } catch {
        return this.#ambiguous(prepared, null, this.#observationTime(), 'PROVIDER_RESULT_UNKNOWN');
      }
      const observedAt = this.#observationTime();
      if (observedAt === null) return this.#ambiguous(prepared, txHash, null, 'LOCAL_EVIDENCE_INVALID');

      let sessionMatches = false;
      try {
        const current = await this.#connection.observe();
        sessionMatches =
          !session.changed &&
          Boolean(current) &&
          sameAddress(current!.account, prepared.owner) &&
          current!.chainId === this.#chainId;
      } catch {
        sessionMatches = false;
      }
      if (!sessionMatches)
        return this.#ambiguous(
          prepared,
          txHash,
          observedAt,
          session.changed ? 'SESSION_CHANGED' : 'POST_SUBMISSION_CHECK_FAILED',
        );

      return Object.freeze({
        operationId: prepared.operationId,
        chainId: prepared.chainId,
        owner: prepared.owner,
        target: prepared.target,
        state: 'SUBMITTED',
        txHash,
        submittedAt: observedAt,
      });
    } finally {
      for (const event of registeredEvents) {
        try {
          this.#provider.removeListener(event, invalidateSession);
        } catch {
          // Provider cleanup cannot change or hide an already determined submission outcome.
        }
      }
    }
  }
}
