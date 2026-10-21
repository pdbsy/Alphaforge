import { Interface, JsonRpcProvider, ZeroAddress, keccak256, toQuantity } from 'ethers';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  MarketChain,
  MarketSnapshotTarget,
  ObservedMarketReceipt,
  ObservedMarketTransaction,
} from '../../../../packages/launch-market/src/chain.ts';
import type {
  ChainLocation,
  LaunchMarketManifest,
  MarketSnapshot,
  MarketTransaction,
  MarketWalletSnapshot,
  StrategyId,
  VaultSnapshot,
} from '../../../../packages/launch-market/src/types.ts';
import { LaunchMarketError } from '../../../../packages/launch-market/src/types.ts';
import { address, hash, uint, validateManifest } from '../../../../packages/launch-market/src/config.ts';
import { marketInterfaces } from '../../../../packages/launch-market/src/abi.ts';

const token = new Interface([
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function totalSupply() view returns(uint256)',
  'function decimals() view returns(uint8)',
]);
const launch = new Interface([
  'function state() view returns(uint8)',
  'function sold() view returns(uint256)',
  'function pool() view returns(address)',
  'function lpRecipient() view returns(address)',
]);
const pool = new Interface([
  'function pass() view returns(address)',
  'function usdc() view returns(address)',
  'function factory() view returns(address)',
  'function initialized() view returns(bool)',
  'function initialLpRecipient() view returns(address)',
  'function getReserves() view returns(uint256,uint256)',
  'function quoteBuy(uint256) view returns(uint256,uint256)',
  'function quoteSell(uint256) view returns(uint256,uint256)',
]);
const claim = new Interface([
  'function totalClaims() view returns(uint256)',
  'function claimSigner() view returns(address)',
  'function claimEpoch() view returns(uint64)',
  'function claimsOpened() view returns(bool)',
  'function paused() view returns(bool)',
]);
const reserve = new Interface([
  'function quoteSigner() view returns(address)',
  'function quoteEpoch() view returns(uint64)',
  'function conversionFeeBps() view returns(uint16)',
  'function ethInputPaused() view returns(bool)',
  'function ethOutputPaused() view returns(bool)',
  'function limits() view returns(uint256 perTransaction,uint256 perAccountDaily,uint256 globalDaily,uint256 minNativeReserve)',
  'function tradingRouter() view returns(address)',
]);
const factory = new Interface(['function getPool(address) view returns(address)']);
const vaultFactory = new Interface([
  'function vaults(address,uint8) view returns(address)',
  'function createVault(uint8) returns(address)',
]);
export const vaultInterface = new Interface([
  'function owner() view returns(address)',
  'function pass() view returns(address)',
  'function afUsdc() view returns(address)',
  'function passLocker() view returns(address)',
  'function targetStock() view returns(address)',
  'function principalBasis() view returns(uint256)',
  'function trackedUsdcBalance() view returns(uint256)',
  'function trackedPosition(address) view returns(uint256)',
  'function closed() view returns(bool)',
  'function equity() view returns(uint256)',
  'function unrealizedPnl() view returns(int256)',
  'function realizedTradingPnl() view returns(int256)',
  'function realizedProfit() view returns(uint256)',
  'function withdrawableUsdc() view returns(uint256)',
  'function deposit(uint256)',
  'function withdraw(uint256)',
  'function close()',
]);
const locker = new Interface(['function lockedBalance() view returns(uint256)']);
interface Header {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
  gasLimit: string;
}
function header(value: unknown): Header {
  if (!value || typeof value !== 'object') throw new LaunchMarketError('BLOCK_UNAVAILABLE', 503);
  const result = value as Header;
  if (!/^0x[0-9a-f]+$/i.test(result.number)) throw new LaunchMarketError('INVALID_RPC_BLOCK', 503);
  hash(result.hash);
  hash(result.parentHash);
  return result;
}

/** Public Testnet providers may lag a newly announced block; retries keep the exact pinned read. */
class MarketReadProvider extends JsonRpcProvider {
  constructor(rpcUrl: string) {
    super(rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 3, batchStallTime: 10 });
  }
  override async send(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
    // Keep the complete indexer range, while respecting the public provider's log-query limit.
    if (method === 'eth_getLogs' && Array.isArray(params) && params.length === 1) {
      const filter = params[0] as Record<string, unknown> | null;
      if (
        filter &&
        typeof filter.fromBlock === 'string' &&
        typeof filter.toBlock === 'string' &&
        /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(filter.fromBlock) &&
        /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(filter.toBlock)
      ) {
        const from = BigInt(filter.fromBlock),
          to = BigInt(filter.toBlock);
        if (from > to) throw new LaunchMarketError('INDEX_LOG_RANGE_LIMIT', 503);
        if (to - from >= 100n) {
          if (to - from >= 2000n) throw new LaunchMarketError('INDEX_LOG_RANGE_LIMIT', 503);
          const results: unknown[] = [];
          for (let batch = from; batch <= to; batch += 300n) {
            const reads: Promise<unknown>[] = [];
            for (let start = batch; start <= to && start < batch + 300n; start += 100n)
              reads.push(
                this.send(method, [
                  {
                    ...filter,
                    fromBlock: toQuantity(start),
                    toBlock: toQuantity(start + 99n < to ? start + 99n : to),
                  },
                ]),
              );
            for (const rows of await Promise.all(reads)) {
              if (!Array.isArray(rows)) throw new LaunchMarketError('INDEX_LOG_RESPONSE', 503);
              if (results.length + rows.length > 50000)
                throw new LaunchMarketError('INDEX_LOG_RESPONSE', 503);
              results.push(...rows);
            }
          }
          return results;
        }
      }
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await super.send(method, params);
      } catch (error) {
        // ethers puts eth_call RPC errors inside CALL_EXCEPTION.info.error,
        // while other read methods expose the original error at .error.
        const rpcError = error as { error?: unknown; info?: { error?: unknown } } | null | undefined;
        const detail = (rpcError?.error ?? rpcError?.info?.error) as
          { code?: unknown; message?: unknown } | undefined;
        const pinned = Array.isArray(params)
          ? method === 'eth_getBlockByNumber'
            ? params[0]
            : params.at(-1)
          : undefined;
        if (
          attempt >= 2 ||
          !['eth_call', 'eth_getCode', 'eth_getBalance', 'eth_getBlockByNumber'].includes(method) ||
          typeof pinned !== 'string' ||
          !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(pinned) ||
          detail?.code !== -32000 ||
          typeof detail.message !== 'string' ||
          !/^unsupported block number\b/i.test(detail.message)
        )
          throw error;
        await delay(250);
      }
    }
  }
}

/** A read-only RPC adapter. It has no signer and never calls a transaction submission RPC. */
export class RpcMarketChain implements MarketChain {
  readonly manifest: LaunchMarketManifest;
  readonly provider: JsonRpcProvider;
  #cache: { hash: string; pending: Promise<MarketSnapshot> } | null = null;
  #verified = false;
  constructor(manifest: LaunchMarketManifest, rpcUrl: string) {
    validateManifest(manifest);
    this.manifest = manifest;
    const url = new URL(rpcUrl);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
    )
      throw new LaunchMarketError('RPC_HTTPS_REQUIRED', 400);
    this.provider = new MarketReadProvider(rpcUrl);
  }
  async initialize(): Promise<void> {
    if (BigInt(await this.provider.send('eth_chainId', [])) !== 46630n)
      throw new LaunchMarketError('WRONG_CHAIN', 503);
    const block = header(await this.provider.send('eth_getBlockByNumber', ['latest', false]));
    if (BigInt(block.number) < uint(this.manifest.deploymentBlock))
      throw new LaunchMarketError('DEPLOYMENT_BLOCK_NOT_REACHED', 503);
    await Promise.all(
      Object.entries(this.manifest.runtimeCodeHashes).map(async ([target, expected]) => {
        const code = String(await this.provider.send('eth_getCode', [address(target), block.number]));
        if (code === '0x' || keccak256(code).toLowerCase() !== hash(expected))
          throw new LaunchMarketError('RUNTIME_CODE_MISMATCH', 503);
      }),
    );
    for (const strategy of ['TSLA', 'AMZN'] as const) {
      const pass = this.manifest.strategies[strategy].pass;
      if (
        String((await this.read(pass, token, 'decimals', [], block))[0]) !== '18' ||
        String((await this.read(pass, token, 'totalSupply', [], block))[0]) !== '1000000000000000000000000'
      )
        throw new LaunchMarketError('PASS_SUPPLY_CONFLICT', 503);
    }
    if (String((await this.read(this.manifest.usdc, token, 'decimals', [], block))[0]) !== '6')
      throw new LaunchMarketError('USDC_PRECISION_CONFLICT', 503);
    this.#verified = true;
  }
  location(block: Header): ChainLocation {
    return {
      chainId: 46630,
      blockNumber: BigInt(block.number).toString(),
      blockHash: hash(block.hash),
      transactionHash: null,
      logIndex: null,
      version: BigInt(block.number).toString(),
      confirmations: 1,
    };
  }
  async head(): Promise<Header> {
    return header(await this.provider.send('eth_getBlockByNumber', ['latest', false]));
  }
  async read(target: string, iface: Interface, name: string, args: readonly unknown[], block: Header) {
    const data = iface.encodeFunctionData(name, args);
    const result = String(
      await this.provider.send('eth_call', [{ to: address(target), data }, block.number]),
    );
    return iface.decodeFunctionResult(name, result);
  }
  async assertCanonical(block: Header): Promise<void> {
    if ((await this.canonicalBlockHash(BigInt(block.number).toString())) !== hash(block.hash))
      throw new LaunchMarketError('REORG_DURING_READ', 503);
  }
  async snapshot(at?: MarketSnapshotTarget): Promise<MarketSnapshot> {
    if (!this.#verified) throw new LaunchMarketError('RPC_NOT_VERIFIED', 503);
    const block = at
      ? header(await this.provider.send('eth_getBlockByNumber', [toQuantity(uint(at.blockNumber)), false]))
      : await this.head();
    if (at && (BigInt(block.number) !== uint(at.blockNumber) || hash(block.hash) !== hash(at.blockHash)))
      throw new LaunchMarketError('INDEX_SNAPSHOT_FORK', 503);
    if (this.#cache?.hash === block.hash) return this.#cache.pending;
    const pending = this.#snapshot(block);
    this.#cache = { hash: block.hash, pending };
    try {
      return await pending;
    } catch (error) {
      if (this.#cache?.pending === pending) this.#cache = null;
      throw error;
    }
  }
  async #snapshot(block: Header): Promise<MarketSnapshot> {
    const m = this.manifest;
    const markets = {} as MarketSnapshot['markets'];
    const marketEntries = await Promise.all(
      (['TSLA', 'AMZN'] as const).map(async (strategy) => {
        const config = m.strategies[strategy];
        let state: 'PREPARING' | 'MINTING' | 'SOLD_OUT' | 'LAUNCHED' = 'LAUNCHED';
        let sold = '0';
        let poolAddress = String(
          (await this.read(m.poolFactory, factory, 'getPool', [config.pass], block))[0],
        );
        if (config.launch) {
          const [stateResult, soldResult, launchPool, lp] = await Promise.all([
            this.read(config.launch, launch, 'state', [], block),
            this.read(config.launch, launch, 'sold', [], block),
            this.read(config.launch, launch, 'pool', [], block),
            this.read(config.launch, launch, 'lpRecipient', [], block),
          ]);
          const number = Number(stateResult[0]);
          state = (['PREPARING', 'MINTING', 'SOLD_OUT', 'LAUNCHED'] as const)[number] ?? 'PREPARING';
          if (number > 3 || state === 'SOLD_OUT') throw new LaunchMarketError('INVALID_LAUNCH_STATE', 503);
          sold = String(soldResult[0]);
          if (address(String(lp[0])) !== address(config.lpRecipient))
            throw new LaunchMarketError('LP_RECIPIENT_MISMATCH', 503);
          if (String(launchPool[0]).toLowerCase() !== poolAddress.toLowerCase() && state === 'LAUNCHED')
            throw new LaunchMarketError('LAUNCH_POOL_MISMATCH', 503);
        }
        let passReserve = '0',
          usdcReserve = '0';
        if (poolAddress.toLowerCase() !== ZeroAddress) {
          poolAddress = address(poolAddress);
          if (config.pool && poolAddress !== address(config.pool))
            throw new LaunchMarketError('POOL_ADDRESS_MISMATCH', 503);
          const [identityPass, identityUsdc, identityFactory, lp, initialized, reserves] = await Promise.all([
            this.read(poolAddress, pool, 'pass', [], block),
            this.read(poolAddress, pool, 'usdc', [], block),
            this.read(poolAddress, pool, 'factory', [], block),
            this.read(poolAddress, pool, 'initialLpRecipient', [], block),
            this.read(poolAddress, pool, 'initialized', [], block),
            this.read(poolAddress, pool, 'getReserves', [], block),
          ]);
          if (
            address(String(identityPass[0])) !== address(config.pass) ||
            address(String(identityUsdc[0])) !== address(m.usdc) ||
            address(String(identityFactory[0])) !== address(m.poolFactory) ||
            address(String(lp[0])) !== address(config.lpRecipient) ||
            initialized[0] !== true
          )
            throw new LaunchMarketError('POOL_IDENTITY_MISMATCH', 503);
          passReserve = String(reserves[0]);
          usdcReserve = String(reserves[1]);
        } else if (state === 'LAUNCHED') throw new LaunchMarketError('LAUNCHED_POOL_MISSING', 503);
        return [
          strategy,
          {
            state,
            pass: address(config.pass),
            totalSupplyRaw: '1000000000000000000000000',
            publicSupplyRaw: strategy === 'TSLA' ? '500000000000000000000000' : '0',
            soldRaw: sold,
            remainingRaw: strategy === 'TSLA' ? (500000000000000000000000n - uint(sold)).toString() : '0',
            mintPriceUsdcRaw: '500000',
            lpPassRaw: '500000000000000000000000',
            lpUsdcRaw: '250000000000',
            pool: poolAddress.toLowerCase() === ZeroAddress ? null : poolAddress,
            reservePassRaw: passReserve,
            reserveUsdcRaw: usdcReserve,
            ammFeeBps: 30,
          },
        ] as const;
      }),
    );
    Object.assign(markets, Object.fromEntries(marketEntries));
    const [
      claims,
      balanceUsdcClaim,
      opened,
      claimPaused,
      ethBalance,
      usdcBalance,
      inputPaused,
      outputPaused,
      fee,
      epoch,
      limits,
      tradingRouter,
    ] = await Promise.all([
      this.read(m.claim, claim, 'totalClaims', [], block),
      this.read(m.usdc, token, 'balanceOf', [m.claim], block),
      this.read(m.claim, claim, 'claimsOpened', [], block),
      this.read(m.claim, claim, 'paused', [], block),
      this.provider.send('eth_getBalance', [m.conversionReserve, block.number]),
      this.read(m.usdc, token, 'balanceOf', [m.conversionReserve], block),
      this.read(m.conversionReserve, reserve, 'ethInputPaused', [], block),
      this.read(m.conversionReserve, reserve, 'ethOutputPaused', [], block),
      this.read(m.conversionReserve, reserve, 'conversionFeeBps', [], block),
      this.read(m.conversionReserve, reserve, 'quoteEpoch', [], block),
      this.read(m.conversionReserve, reserve, 'limits', [], block),
      this.read(m.conversionReserve, reserve, 'tradingRouter', [], block),
    ]);
    const total = Number(claims[0]),
      eth = BigInt(String(ethBalance)),
      cash = BigInt(String(usdcBalance[0]));
    if (total < 0 || total > 100) throw new LaunchMarketError('CLAIM_SUPPLY_CONFLICT', 503);
    const routesReady = String(tradingRouter[0]).toLowerCase() === address(m.router);
    const result: MarketSnapshot = {
      location: this.location(block),
      markets,
      claim: {
        amountUsdcRaw: '1000000000',
        successfulClaims: total,
        maxClaims: 100,
        remainingClaims: 100 - total,
        funded:
          opened[0] === true &&
          claimPaused[0] === false &&
          BigInt(String(balanceUsdcClaim[0])) >= 1000000000n * BigInt(100 - total),
      },
      conversion: {
        ethReserveRaw: eth.toString(),
        usdcReserveRaw: cash.toString(),
        ethMintAvailable: routesReady && inputPaused[0] === false,
        ethBuyAvailable: routesReady && inputPaused[0] === false && cash > 0n,
        ethSellAvailable:
          routesReady &&
          outputPaused[0] === false &&
          eth > BigInt(String(limits[3])) &&
          BigInt(String(limits[0])) > 0n,
        feeBps: Number(fee[0]),
        epoch: String(epoch[0]),
      },
    };
    await this.assertCanonical(block);
    return result;
  }
  async wallet(ownerInput: string): Promise<MarketWalletSnapshot> {
    const owner = address(ownerInput),
      block = await this.head(),
      m = this.manifest;
    const [eth, cash] = await Promise.all([
      this.provider.send('eth_getBalance', [owner, block.number]),
      this.read(m.usdc, token, 'balanceOf', [owner], block),
    ]);
    const vaults: VaultSnapshot[] = [];
    const passEntries = await Promise.all(
      (['TSLA', 'AMZN'] as const).map(async (strategy, index) => {
        const pass = m.strategies[strategy].pass;
        const balance = String((await this.read(pass, token, 'balanceOf', [owner], block))[0]);
        let locked = '0';
        if (m.vaultFactory) {
          const target = String(
            (await this.read(m.vaultFactory, vaultFactory, 'vaults', [owner, index], block))[0],
          );
          if (target.toLowerCase() !== ZeroAddress) {
            const entry = await this.vault(target, owner, strategy, block);
            vaults.push(entry);
            locked = entry.lockedPassRaw;
          }
        }
        // Locked PASS was transferred into a Locker; subtracting it again would undercount the wallet.
        return [
          strategy,
          {
            balanceRaw: (BigInt(balance) + BigInt(locked)).toString(),
            lockedRaw: locked,
            availableRaw: balance,
          },
        ] as const;
      }),
    );
    await this.assertCanonical(block);
    return {
      owner,
      accountId: null,
      location: this.location(block),
      ethBalanceRaw: BigInt(String(eth)).toString(),
      usdcBalanceRaw: String(cash[0]),
      passes: Object.fromEntries(passEntries) as MarketWalletSnapshot['passes'],
      vaults,
    };
  }
  async vault(target: string, owner: string, strategy: StrategyId, block: Header): Promise<VaultSnapshot> {
    const read = (name: string, args: unknown[] = []) => this.read(target, vaultInterface, name, args, block);
    const [
      actualOwner,
      pass,
      usdc,
      passLocker,
      stock,
      principal,
      cash,
      closed,
      realized,
      profit,
      withdrawable,
    ] = await Promise.all([
      read('owner'),
      read('pass'),
      read('afUsdc'),
      read('passLocker'),
      read('targetStock'),
      read('principalBasis'),
      read('trackedUsdcBalance'),
      read('closed'),
      read('realizedTradingPnl'),
      read('realizedProfit'),
      read('withdrawableUsdc'),
    ]);
    if (
      address(String(actualOwner[0])) !== address(owner) ||
      address(String(pass[0])) !== address(this.manifest.strategies[strategy].pass) ||
      address(String(usdc[0])) !== address(this.manifest.usdc)
    )
      throw new LaunchMarketError('VAULT_IDENTITY_MISMATCH', 503);
    const [position, locked] = await Promise.all([
      read('trackedPosition', [stock[0]]),
      this.read(String(passLocker[0]), locker, 'lockedBalance', [], block),
    ]);
    const valuations = await Promise.allSettled([read('equity'), read('unrealizedPnl')]);
    const equity = valuations[0].status === 'fulfilled' ? String(valuations[0].value[0]) : null;
    const pnl = valuations[1].status === 'fulfilled' ? String(valuations[1].value[0]) : null;
    const max = BigInt(String(withdrawable[0])),
      gain = BigInt(String(profit[0]));
    return {
      strategyId: strategy,
      address: address(target),
      principalBasisRaw: String(principal[0]),
      equityRaw: equity,
      cashRaw: String(cash[0]),
      lockedPassRaw: String(locked[0]),
      realizedPnlRaw: String(realized[0]),
      unrealizedPnlRaw: pnl,
      valuationState: equity !== null && pnl !== null ? 'FRESH' : 'UNAVAILABLE',
      withdrawableProfitRaw: (max < gain ? max : gain).toString(),
      withdrawablePrincipalRaw: (max > gain ? max - gain : 0n).toString(),
      status: closed[0] === true ? 'CLOSED' : 'OPEN',
      holdings:
        BigInt(String(position[0])) === 0n
          ? []
          : [{ token: address(String(stock[0])), amountRaw: String(position[0]) }],
    };
  }
  async quoteAmm(strategy: StrategyId, side: 'BUY' | 'SELL', amountRaw: string, blockHash: string) {
    const block = header(await this.provider.send('eth_getBlockByHash', [hash(blockHash), false]));
    const target = String(
      (
        await this.read(
          this.manifest.poolFactory,
          factory,
          'getPool',
          [this.manifest.strategies[strategy].pass],
          block,
        )
      )[0],
    );
    if (target.toLowerCase() === ZeroAddress) throw new LaunchMarketError('POOL_NOT_LIVE');
    const result = await this.read(
      target,
      pool,
      side === 'BUY' ? 'quoteBuy' : 'quoteSell',
      [uint(amountRaw)],
      block,
    );
    await this.assertCanonical(block);
    return { outputRaw: String(result[0]), feeRaw: String(result[1]) };
  }
  async requiredApprovals(
    tx: MarketTransaction,
    owner: string,
    block: Header,
  ): Promise<readonly { token: string; spender: string; amountRaw: string }[]> {
    const m = this.manifest,
      target = address(tx.to),
      checks: { token: string; spender: string; amountRaw: string }[] = [];
    const add = (asset: string, amount: unknown) =>
      checks.push({ token: address(asset), spender: target, amountRaw: String(amount) });
    if (target === address(m.router)) {
      const parsed = marketInterfaces.router.parseTransaction(tx);
      if (parsed?.name === 'sellNative') add(String(parsed.args[0].pass), parsed.args[0].amountIn);
    } else if (target === address(m.strategies.TSLA.launch!)) {
      const parsed = marketInterfaces.launch.parseTransaction(tx);
      if (parsed?.name === 'subscribeUsdc') add(m.usdc, BigInt(String(parsed.args[0])) / 2000000000000n);
    } else if (m.vaultFactory && target === address(m.vaultFactory)) {
      // Factory creation never approves assets.
    } else if (target !== address(m.claim)) {
      const pending = marketInterfaces.pool.parseTransaction(tx);
      if (pending?.name === 'buy') add(m.usdc, pending.args[0]);
      else if (pending?.name === 'sell')
        add(String((await this.read(target, pool, 'pass', [], block))[0]), pending.args[0]);
      else {
        const parsed = vaultInterface.parseTransaction(tx);
        if (parsed?.name === 'deposit') {
          const actualOwner = String((await this.read(target, vaultInterface, 'owner', [], block))[0]);
          if (address(actualOwner) !== address(owner))
            throw new LaunchMarketError('VAULT_OWNER_MISMATCH', 403);
          const pass = String((await this.read(target, vaultInterface, 'pass', [], block))[0]);
          add(pass, BigInt(String(parsed.args[0])) * 1000000000000n);
          add(m.usdc, parsed.args[0]);
        }
      }
    }
    const deficits = await Promise.all(
      checks.map(async (check) => {
        const current = await this.read(check.token, token, 'allowance', [owner, check.spender], block);
        return BigInt(String(current[0])) < uint(check.amountRaw) ? check : null;
      }),
    );
    return deficits.filter((item) => item !== null);
  }
  async simulate(tx: MarketTransaction, ownerInput: string): Promise<string> {
    const owner = address(ownerInput),
      block = await this.head();
    if ((await this.requiredApprovals(tx, owner, block)).length)
      throw new LaunchMarketError('ALLOWANCE_REQUIRED');
    const input = { from: owner, to: address(tx.to), data: tx.data, value: toQuantity(uint(tx.value)) };
    await this.provider.send('eth_call', [input, block.number]);
    const gas = BigInt(String(await this.provider.send('eth_estimateGas', [input, block.number])));
    await this.assertCanonical(block);
    if (gas >= BigInt(block.gasLimit)) throw new LaunchMarketError('TRANSACTION_GAS_EXCEEDS_BLOCK_LIMIT');
    return gas.toString();
  }
  async transaction(transactionHash: string): Promise<ObservedMarketTransaction | null> {
    const raw = (await this.provider.send('eth_getTransactionByHash', [hash(transactionHash)])) as Record<
      string,
      string
    > | null;
    if (!raw) return null;
    return {
      hash: hash(raw.hash!),
      from: address(raw.from!),
      chainId: Number(BigInt(raw.chainId!)),
      to: address(raw.to!),
      data: raw.input!,
      value: BigInt(raw.value!).toString(),
    };
  }
  async receipt(transactionHash: string): Promise<ObservedMarketReceipt | null> {
    const raw = (await this.provider.send('eth_getTransactionReceipt', [hash(transactionHash)])) as Record<
      string,
      string
    > | null;
    if (!raw) return null;
    return {
      transactionHash: hash(raw.transactionHash!),
      blockNumber: BigInt(raw.blockNumber!).toString(),
      blockHash: hash(raw.blockHash!),
      status: BigInt(raw.status!) === 1n ? 'SUCCESS' : 'REVERTED',
    };
  }
  async canonicalBlockHash(blockNumber: string): Promise<string | null> {
    const raw = await this.provider.send('eth_getBlockByNumber', [toQuantity(uint(blockNumber)), false]);
    return raw ? hash(header(raw).hash) : null;
  }
  async signingPolicy() {
    const block = await this.head(),
      m = this.manifest;
    const [signer, claimSigner, quoteEpoch, claimEpoch, opened, paused] = await Promise.all([
      this.read(m.conversionReserve, reserve, 'quoteSigner', [], block),
      this.read(m.claim, claim, 'claimSigner', [], block),
      this.read(m.conversionReserve, reserve, 'quoteEpoch', [], block),
      this.read(m.claim, claim, 'claimEpoch', [], block),
      this.read(m.claim, claim, 'claimsOpened', [], block),
      this.read(m.claim, claim, 'paused', [], block),
    ]);
    await this.assertCanonical(block);
    return {
      quoteSigner: address(String(signer[0])),
      claimSigner: address(String(claimSigner[0])),
      quoteEpoch: String(quoteEpoch[0]),
      claimEpoch: String(claimEpoch[0]),
      claimsOpened: opened[0] === true && paused[0] === false,
    };
  }
  close(): void {
    this.provider.destroy();
  }
}
