import { Interface, getAddress, keccak256, ZeroAddress, toQuantity } from 'ethers';
import { LaunchMarketError, type StrategyId } from '../../../../packages/launch-market/src/types.ts';
import type {
  VaultRunObservation,
  VaultRunReceipt,
  VaultRunState,
} from '../../../../packages/launch-market/src/vault-run.ts';
import type { RpcMarketChain } from './rpc-chain.ts';
import type { PaperFundingProof } from '../../../../packages/launch-market/src/paper-ledger.ts';

const factory = new Interface([
  'function vaults(address,uint8) view returns(address)',
  'function createVault(uint8) returns(address)',
  'function strategy(uint8) view returns(tuple(address creator,address pass,address usdc,address targetStock,address otherStock,address stockReserve,address referenceFeed,bytes32 strategyRef,uint32 maxPriceAge))',
  'event VaultCreated(address indexed owner,uint8 indexed strategyIndex,address vault,uint256 generation)',
]);
const vault = new Interface([
  'function owner() view returns(address)',
  'function closed() view returns(bool)',
  'function targetStock() view returns(address)',
  'function pass() view returns(address)',
  'function afUsdc() view returns(address)',
  'function passLocker() view returns(address)',
  'function trackedUsdcBalance() view returns(uint256)',
  'function trackedPosition(address) view returns(uint256)',
  'function principalBasis() view returns(uint256)',
  'function executionVersion() view returns(uint256)',
  'function grant() view returns(address executor,uint64 expiresAt,uint256 maxOrderUsdc,uint256 maxTotalBuyUsdc,uint16 maxSlippageBps)',
  'function deposit(uint256)',
  'function close()',
  'function revokeExecutor()',
  'function execute(bool,uint256,uint256,uint64,uint256) returns(uint256)',
  'event Deposited(address indexed owner,uint256 usdcAmount,uint256 passRaw,uint256 principalBasis,uint256 trackedUsdcBalance)',
  'event Closed(address indexed owner,uint256 usdcReturned,uint256 passRawReleased)',
  'event ExecutorConfigured(address indexed executor,uint64 expiresAt,uint256 version)',
  'event StrategyExecuted(bool buy,uint256 input,uint256 output,uint256 version)',
]);
const locker = new Interface(['function lockedBalance() view returns(uint256)']);
const feed = new Interface(['function price() view returns(uint256,uint64,bytes32)']);
const same = (a: string, b: string) => getAddress(a) === getAddress(b);
const fail = (): never => {
  throw new LaunchMarketError('VAULT_RUN_CHAIN_PROOF_INVALID', 503);
};
type Header = { number: string; hash: string; timestamp: string };
type Receipt = {
  transactionHash: string;
  from: string;
  to: string;
  blockNumber: string;
  blockHash: string;
  status: string;
  logs: readonly { address: string; topics: readonly string[]; data: string; logIndex?: string }[];
};
type RawTransaction = {
  hash: string;
  nonce: string;
  from: string;
  to: string;
  input: string;
  value: string;
  chainId: string;
  blockNumber: string | null;
  blockHash: string | null;
};
const quantity = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value);
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);

/** Read-only qualification of an owner's step, amount, version and canonical result. Has no signer. */
export class VaultRunChain {
  readonly #chain: RpcMarketChain;
  readonly #cache = new Map<string, { at: number; sequence: number; value: VaultRunObservation }>();
  #sequence = 0;
  constructor(chain: RpcMarketChain) {
    this.#chain = chain;
  }
  async #header(number: string): Promise<Header> {
    const result = (await this.#chain.provider.send('eth_getBlockByNumber', [
      number,
      false,
    ])) as Header | null;
    if (
      !result ||
      !/^0x[0-9a-f]+$/i.test(result.number) ||
      !/^0x[0-9a-f]{64}$/i.test(result.hash) ||
      !/^0x[0-9a-f]+$/i.test(result.timestamp)
    )
      fail();
    return result!;
  }
  async #call(target: string, abi: Interface, name: string, args: readonly unknown[], block: string) {
    return abi.decodeFunctionResult(
      name,
      String(
        await this.#chain.provider.send('eth_call', [
          { to: target, data: abi.encodeFunctionData(name, args) },
          block,
        ]),
      ),
    );
  }
  async #code(target: string, block: string): Promise<void> {
    const code = String(await this.#chain.provider.send('eth_getCode', [target, block]));
    if (keccak256(code).toLowerCase() !== this.#chain.manifest.runtimeCodeHashes[target.toLowerCase()])
      fail();
  }
  async readObservation(
    owner: string,
    strategyId: StrategyId,
    options: { fresh: boolean },
  ): Promise<VaultRunObservation> {
    const key = getAddress(owner) + ':' + strategyId,
      now = Date.now(),
      cached = this.#cache.get(key);
    if (!options.fresh && cached && now - cached.at >= 0 && now - cached.at < 5000) return cached.value;
    const sequence = ++this.#sequence;
    if (String(await this.#chain.provider.send('eth_chainId', [])).toLowerCase() !== '0xb626') fail();
    const tip = await this.#header('latest');
    if (
      BigInt(tip.number) < 2n ||
      BigInt(tip.timestamp) > BigInt(Math.floor(now / 1000)) ||
      BigInt(Math.floor(now / 1000)) - BigInt(tip.timestamp) > 30n
    )
      fail();
    const pinned = await this.#header(toQuantity(BigInt(tip.number) - 2n));
    const ownerNonce = await this.#chain.provider.send('eth_getTransactionCount', [owner, 'pending']);
    if (!quantity(ownerNonce)) fail();
    const ownerNonceRaw = String(BigInt(ownerNonce as string));
    const targetFactory = this.#chain.manifest.vaultFactory;
    if (!targetFactory) fail();
    await this.#code(targetFactory!, pinned.number);
    const index = strategyId === 'TSLA' ? 0 : 1;
    const target = String(
      (await this.#call(targetFactory!, factory, 'vaults', [owner, index], pinned.number))[0],
    );
    let value: VaultRunObservation;
    if (same(target, ZeroAddress)) {
      value = {
        owner: getAddress(owner),
        strategyId,
        vault: null,
        closed: false,
        cashRaw: '0',
        positionRaw: '0',
        lockedPassRaw: '0',
        executorActive: false,
        version: '0',
        ownerNonceRaw,
        blockNumber: String(BigInt(pinned.number)),
        blockHash: pinned.hash,
        confirmations: 3,
      };
    } else {
      const configured = (await this.#call(targetFactory!, factory, 'strategy', [index], pinned.number))[0];
      const names = [
        'owner',
        'closed',
        'targetStock',
        'pass',
        'afUsdc',
        'passLocker',
        'trackedUsdcBalance',
        'executionVersion',
        'grant',
      ] as const;
      const fields = await Promise.all(
        names.map((name) => this.#call(target, vault, name, [], pinned.number)),
      );
      if (
        !same(String(fields[0]![0]), owner) ||
        !same(String(fields[2]![0]), String(configured.targetStock)) ||
        !same(String(fields[3]![0]), this.#chain.manifest.strategies[strategyId].pass) ||
        !same(String(fields[4]![0]), this.#chain.manifest.usdc)
      )
        fail();
      const [position, locked] = await Promise.all([
        this.#call(target, vault, 'trackedPosition', [configured.targetStock], pinned.number),
        this.#call(String(fields[5]![0]), locker, 'lockedBalance', [], pinned.number),
      ]);
      const grant = fields[8]!;
      value = {
        owner: getAddress(owner),
        strategyId,
        vault: getAddress(target),
        closed: Boolean(fields[1]![0]),
        cashRaw: String(fields[6]![0]),
        positionRaw: String(position[0]),
        lockedPassRaw: String(locked[0]),
        executorActive: !same(String(grant[0]), ZeroAddress) && BigInt(grant[1]) > BigInt(pinned.timestamp),
        version: String(fields[7]![0]),
        ownerNonceRaw,
        blockNumber: String(BigInt(pinned.number)),
        blockHash: pinned.hash,
        confirmations: 3,
      };
    }
    if ((await this.#header(pinned.number)).hash.toLowerCase() !== pinned.hash.toLowerCase()) fail();
    const previous = this.#cache.get(key);
    if (!previous || sequence > previous.sequence) this.#cache.set(key, { at: now, sequence, value });
    if (this.#cache.size > 200) this.#cache.delete(this.#cache.keys().next().value!);
    return value;
  }
  async #qualified(state: VaultRunState, transactionHash: string): Promise<RawTransaction> {
    const action = state.action;
    if (
      !action?.step ||
      !action.prepared ||
      action.minimumNonceRaw === null ||
      action.preparedBlockNumber === null ||
      action.preparedBlockHash === null ||
      !digest(transactionHash)
    )
      fail();
    if (
      (await this.#header(toQuantity(BigInt(action!.preparedBlockNumber!)))).hash.toLowerCase() !==
      action!.preparedBlockHash!.toLowerCase()
    )
      fail();
    const tx = (await this.#chain.provider.send('eth_getTransactionByHash', [
      transactionHash,
    ])) as RawTransaction | null;
    if (
      !tx ||
      !digest(tx.hash) ||
      tx.hash.toLowerCase() !== transactionHash.toLowerCase() ||
      !quantity(tx.chainId) ||
      BigInt(tx.chainId) !== 46630n ||
      !quantity(tx.value) ||
      BigInt(tx.value) !== 0n ||
      !quantity(tx.nonce) ||
      BigInt(tx.nonce) < BigInt(action!.minimumNonceRaw!) ||
      !same(tx.from, state.owner) ||
      typeof tx.input !== 'string' ||
      !/^0x(?:[0-9a-f]{2})+$/i.test(tx.input)
    )
      fail();
    if (
      tx!.blockNumber !== null &&
      (!quantity(tx!.blockNumber) ||
        !digest(tx!.blockHash) ||
        BigInt(tx!.blockNumber) <= BigInt(action!.preparedBlockNumber!))
    )
      fail();
    const creating = action!.step === 'CREATE';
    const target = creating ? this.#chain.manifest.vaultFactory : state.vault;
    if (!target || !same(tx!.to, target)) fail();
    const abi = creating ? factory : vault;
    const parsed = abi.parseTransaction({ data: tx!.input, value: 0n });
    if (!parsed || abi.encodeFunctionData(parsed.name, parsed.args).toLowerCase() !== tx!.input.toLowerCase())
      fail();
    switch (action!.step) {
      case 'CREATE':
        if (
          parsed!.name !== 'createVault' ||
          Number(parsed!.args[0]) !== (state.strategyId === 'TSLA' ? 0 : 1)
        )
          fail();
        break;
      case 'DEPOSIT':
        if (parsed!.name !== 'deposit' || String(parsed!.args[0]) !== action!.stepAmountRaw) fail();
        break;
      case 'BUY':
      case 'SELL':
        if (
          parsed!.name !== 'execute' ||
          Boolean(parsed!.args[0]) !== (action!.step === 'BUY') ||
          String(parsed!.args[1]) !== action!.stepAmountRaw ||
          BigInt(parsed!.args[2]) <= 0n ||
          action!.expectedVersion === null ||
          String(parsed!.args[4]) !== action!.expectedVersion
        )
          fail();
        break;
      case 'REVOKE':
        if (parsed!.name !== 'revokeExecutor') fail();
        break;
      case 'CLOSE':
        if (parsed!.name !== 'close') fail();
        break;
      default:
        fail();
    }
    return tx!;
  }
  async qualifyTransaction(state: VaultRunState, transactionHash: string): Promise<void> {
    await this.#qualified(state, transactionHash);
  }
  async readValuation(
    owner: string,
    strategyId: StrategyId,
    options: { fresh?: boolean } = {},
  ): Promise<{
    observation: VaultRunObservation;
    principalRaw: string;
    priceRaw: string | null;
    priceObservedAt: number | null;
  }> {
    const observation = await this.readObservation(owner, strategyId, { fresh: options.fresh ?? false });
    if (!observation.vault) return { observation, principalRaw: '0', priceRaw: null, priceObservedAt: null };
    const block = toQuantity(BigInt(observation.blockNumber));
    const principal = await this.#call(observation.vault, vault, 'principalBasis', [], block);
    const configured = (
      await this.#call(
        this.#chain.manifest.vaultFactory!,
        factory,
        'strategy',
        [strategyId === 'TSLA' ? 0 : 1],
        block,
      )
    )[0];
    await this.#code(String(configured.referenceFeed), block);
    const reference = await this.#call(String(configured.referenceFeed), feed, 'price', [], block);
    if ((await this.#header(block)).hash.toLowerCase() !== observation.blockHash.toLowerCase()) fail();
    return {
      observation,
      principalRaw: String(principal[0]),
      priceRaw: BigInt(reference[0]) > 0n ? String(reference[0]) : null,
      priceObservedAt: BigInt(reference[1]) > 0n ? Number(reference[1]) : null,
    };
  }
  async readReceipt(state: VaultRunState): Promise<VaultRunReceipt> {
    const transactionHash = state.action?.pending?.transactionHash;
    if (!transactionHash) return { status: 'UNKNOWN' };
    const tx = await this.#qualified(state, transactionHash);
    const raw = (await this.#chain.provider.send('eth_getTransactionReceipt', [
      transactionHash,
    ])) as Receipt | null;
    if (!raw) return { status: 'PENDING' };
    const target = state.action!.step === 'CREATE' ? this.#chain.manifest.vaultFactory! : state.vault!;
    if (
      !quantity(raw.blockNumber) ||
      !digest(raw.blockHash) ||
      !digest(raw.transactionHash) ||
      !same(raw.from, state.owner) ||
      !same(raw.to, target) ||
      tx.blockNumber === null ||
      tx.blockHash === null ||
      BigInt(tx.blockNumber) !== BigInt(raw.blockNumber) ||
      tx.blockHash.toLowerCase() !== raw.blockHash.toLowerCase() ||
      BigInt(raw.blockNumber) <= BigInt(state.action!.preparedBlockNumber!) ||
      !Array.isArray(raw.logs) ||
      raw.logs.length > 1000
    )
      fail();
    const tip = await this.#header('latest');
    const confirmations = BigInt(tip.number) - BigInt(raw.blockNumber) + 1n;
    if (confirmations < 3n) return { status: 'PENDING' };
    if (
      raw.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
      !same(raw.from, state.owner) ||
      (await this.#header(raw.blockNumber)).hash.toLowerCase() !== raw.blockHash.toLowerCase() ||
      !['0x0', '0x1'].includes(raw.status)
    )
      fail();
    if (raw.status === '0x1') {
      const action = state.action!,
        creating = action.step === 'CREATE';
      const target = creating ? this.#chain.manifest.vaultFactory! : state.vault!;
      const events = raw.logs
        .filter((log) => same(log.address, target))
        .flatMap((log) => {
          try {
            const event = (creating ? factory : vault).parseLog({ topics: [...log.topics], data: log.data });
            return event ? [event] : [];
          } catch {
            return [];
          }
        });
      const matches = events.filter((event) =>
        action.step === 'CREATE'
          ? event.name === 'VaultCreated' &&
            same(String(event.args.owner), state.owner) &&
            Number(event.args.strategyIndex) === (state.strategyId === 'TSLA' ? 0 : 1)
          : action.step === 'DEPOSIT'
            ? event.name === 'Deposited' &&
              same(String(event.args.owner), state.owner) &&
              String(event.args.usdcAmount) === action.stepAmountRaw
            : action.step === 'REVOKE'
              ? event.name === 'ExecutorConfigured' &&
                same(String(event.args.executor), ZeroAddress) &&
                String(event.args.version) === String(BigInt(action.expectedVersion!) + 1n)
              : action.step === 'CLOSE'
                ? event.name === 'Closed' && same(String(event.args.owner), state.owner)
                : event.name === 'StrategyExecuted' &&
                  Boolean(event.args.buy) === (action.step === 'BUY') &&
                  String(event.args.input) === action.stepAmountRaw &&
                  String(event.args.version) === String(BigInt(action.expectedVersion!) + 1n),
      );
      if (matches.length !== 1) fail();
      if (creating) {
        const mapped = String(
          (
            await this.#call(
              target,
              factory,
              'vaults',
              [state.owner, state.strategyId === 'TSLA' ? 0 : 1],
              raw.blockNumber,
            )
          )[0],
        );
        if (same(mapped, ZeroAddress) || !same(mapped, String(matches[0]!.args.vault))) fail();
      }
    }
    if ((await this.#header(raw.blockNumber)).hash.toLowerCase() !== raw.blockHash.toLowerCase()) fail();
    this.#cache.delete(getAddress(state.owner) + ':' + state.strategyId);
    return {
      status: raw.status === '0x1' ? 'CONFIRMED' : 'REVERTED',
      transactionHash,
      blockNumber: String(BigInt(raw.blockNumber)),
      blockHash: raw.blockHash,
      confirmations: 3,
    };
  }
  /** An actual funding log after the existing exact transaction and canonical receipt checks. */
  async readFundingProof(state: VaultRunState): Promise<PaperFundingProof> {
    const action = state.action;
    if (!action || !['DEPOSIT', 'CLOSE'].includes(action.step ?? '') || !state.vault) fail();
    const receipt = await this.readReceipt(state);
    if (receipt.status !== 'CONFIRMED') fail();
    const confirmed = receipt as Extract<VaultRunReceipt, { status: 'CONFIRMED' | 'REVERTED' }>;
    const raw = (await this.#chain.provider.send('eth_getTransactionReceipt', [
      confirmed.transactionHash,
    ])) as Receipt | null;
    if (
      !raw ||
      raw.status !== '0x1' ||
      !digest(raw.transactionHash) ||
      raw.transactionHash.toLowerCase() !== confirmed.transactionHash.toLowerCase() ||
      !quantity(raw.blockNumber) ||
      String(BigInt(raw.blockNumber)) !== confirmed.blockNumber ||
      !digest(raw.blockHash) ||
      raw.blockHash.toLowerCase() !== confirmed.blockHash.toLowerCase() ||
      !same(raw.from, state.owner) ||
      !same(raw.to, state.vault!) ||
      !Array.isArray(raw.logs) ||
      raw.logs.length > 1000
    )
      fail();
    const matches = raw!.logs.flatMap((log) => {
      if (!same(log.address, state.vault!)) return [];
      try {
        const event = vault.parseLog({ topics: [...log.topics], data: log.data });
        const name = action!.step === 'DEPOSIT' ? 'Deposited' : 'Closed';
        return event?.name === name && same(String(event.args.owner), state.owner)
          ? [{ event, logIndex: log.logIndex }]
          : [];
      } catch {
        return [];
      }
    });
    if (matches.length !== 1 || !quantity(matches[0]!.logIndex)) fail();
    const match = matches[0]!,
      index = BigInt(match.logIndex!);
    if (index > 100000n) fail();
    const amount = BigInt(match.event.args[action!.step === 'DEPOSIT' ? 'usdcAmount' : 'usdcReturned']);
    const passRaw = BigInt(match.event.args[action!.step === 'DEPOSIT' ? 'passRaw' : 'passRawReleased']);
    if (
      amount < 0n ||
      amount >= 1n << 256n ||
      passRaw < 0n ||
      passRaw >= 1n << 256n ||
      (action!.step === 'DEPOSIT' &&
        (amount <= 0n || String(amount) !== action!.stepAmountRaw || passRaw !== amount * 10n ** 12n))
    )
      fail();
    const header = await this.#header(raw!.blockNumber),
      tip = await this.#header('latest');
    if (
      header.hash.toLowerCase() !== confirmed.blockHash.toLowerCase() ||
      BigInt(tip.number) < BigInt(header.number) + 2n ||
      BigInt(header.timestamp) > BigInt(Math.floor(Date.now() / 1000)) ||
      BigInt(header.timestamp) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      fail();
    return {
      kind: action!.step === 'DEPOSIT' ? 'DEPOSIT' : 'CLOSE',
      chainId: 46630,
      owner: getAddress(state.owner).toLowerCase(),
      strategyId: state.strategyId,
      vault: getAddress(state.vault!).toLowerCase(),
      transactionHash: confirmed.transactionHash.toLowerCase(),
      logIndex: Number(index),
      blockNumber: confirmed.blockNumber,
      blockHash: confirmed.blockHash.toLowerCase(),
      blockTimestamp: Number(BigInt(header.timestamp)),
      confirmations: 3,
      amountRaw: String(amount),
      passRaw: String(passRaw),
    };
  }
}
