import { Interface, ZeroAddress, getAddress, keccak256 } from 'ethers';
import type { LaunchMarketManifest, StrategyId } from '../../../../packages/launch-market/src/types.ts';
import { hash, uint, validateManifest } from '../../../../packages/launch-market/src/config.ts';
import type { Eip1193Provider } from '../../../web/src/chain-wallet.ts';

export interface StockAutomationReadiness {
  readonly strategyId: StrategyId;
  readonly chainId: 46630;
  readonly status:
    | 'UNINITIALIZED'
    | 'STALE_REFERENCE'
    | 'STALE_CALENDAR'
    | 'MARKET_CLOSED'
    | 'PAUSED'
    | 'EMPTY_RESERVE'
    | 'READY';
  readonly referenceObservedAt: number;
  readonly calendarObservedAt: number;
  readonly regularOpen: number;
  readonly regularClose: number;
  readonly stockPriceUsdcRaw: string | null;
  readonly keeper: string;
  readonly blockNumber: string;
  readonly blockHash: string;
}
const factory = new Interface([
  'function strategy(uint8) view returns(tuple(address creator,address pass,address usdc,address targetStock,address otherStock,address stockReserve,address referenceFeed,bytes32 strategyRef,uint32 maxPriceAge))',
]);
const feed = new Interface([
  'function keeper() view returns(address)',
  'function price() view returns(uint256,uint64,bytes32)',
  'function calendarObservedAt() view returns(uint64)',
  'function calendarDigest() view returns(bytes32)',
  'function regularOpen() view returns(uint64)',
  'function regularClose() view returns(uint64)',
  'function executionAllowed() view returns(bool)',
]);
const reserve = new Interface([
  'function paused() view returns(bool)',
  'function usdc() view returns(address)',
  'function stock() view returns(address)',
  'function feed() view returns(address)',
]);
const token = new Interface(['function balanceOf(address) view returns(uint256)']);
const zero = '0x' + '00'.repeat(32);
/** Credential-free public contract readiness. No owner data, price fabrication, signing or submission. */
export async function readStockAutomationReadiness(
  provider: Eip1193Provider,
  manifest: LaunchMarketManifest,
  strategyId: StrategyId,
  now = Math.floor(Date.now() / 1000),
): Promise<StockAutomationReadiness> {
  validateManifest(manifest);
  if (
    !manifest.vaultFactory ||
    !['TSLA', 'AMZN'].includes(strategyId) ||
    String(await provider.request({ method: 'eth_chainId' })).toLowerCase() !== '0xb626'
  )
    throw new Error('STOCK_READINESS_CONFIGURATION');
  const block = (await provider.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })) as {
    number: string;
    hash: string;
    timestamp: string;
  };
  if (
    !block ||
    !/^0x[0-9a-fA-F]+$/.test(block.number) ||
    !/^0x[0-9a-fA-F]+$/.test(block.timestamp) ||
    !Number.isSafeInteger(now) ||
    BigInt(block.timestamp) > BigInt(now) ||
    BigInt(now) - BigInt(block.timestamp) > 30n
  )
    throw new Error('STOCK_READINESS_CHAIN_STALE');
  hash(block.hash);
  const call = async (target: string, abi: Interface, name: string, args: readonly unknown[] = []) =>
    abi.decodeFunctionResult(
      name,
      String(
        await provider.request({
          method: 'eth_call',
          params: [{ to: target, data: abi.encodeFunctionData(name, args) }, block.number],
        }),
      ),
    );
  const verifyCode = async (target: string) => {
    if (getAddress(target) === ZeroAddress) throw new Error('STOCK_READINESS_ROUTE');
    const code = String(await provider.request({ method: 'eth_getCode', params: [target, block.number] }));
    if (code === '0x' || keccak256(code).toLowerCase() !== manifest.runtimeCodeHashes[target.toLowerCase()])
      throw new Error('STOCK_READINESS_CODE');
  };
  await verifyCode(manifest.vaultFactory);
  const route = (await call(manifest.vaultFactory, factory, 'strategy', [strategyId === 'TSLA' ? 0 : 1]))[0];
  if (
    getAddress(String(route.pass)) !== getAddress(manifest.strategies[strategyId].pass) ||
    getAddress(String(route.usdc)) !== getAddress(manifest.usdc) ||
    Number(route.maxPriceAge) < 1 ||
    Number(route.maxPriceAge) > 60
  )
    throw new Error('STOCK_READINESS_ROUTE');
  const feedAddress = getAddress(String(route.referenceFeed)),
    reserveAddress = getAddress(String(route.stockReserve)),
    stock = getAddress(String(route.targetStock));
  await Promise.all([feedAddress, reserveAddress, stock, manifest.usdc].map(verifyCode));
  const [
    keeper,
    price,
    calendar,
    calendarDigest,
    opens,
    closes,
    allowed,
    paused,
    cash,
    inventory,
    usdcRoute,
    stockRoute,
    feedRoute,
  ] = await Promise.all([
    call(feedAddress, feed, 'keeper'),
    call(feedAddress, feed, 'price'),
    call(feedAddress, feed, 'calendarObservedAt'),
    call(feedAddress, feed, 'calendarDigest'),
    call(feedAddress, feed, 'regularOpen'),
    call(feedAddress, feed, 'regularClose'),
    call(feedAddress, feed, 'executionAllowed'),
    call(reserveAddress, reserve, 'paused'),
    call(manifest.usdc, token, 'balanceOf', [reserveAddress]),
    call(stock, token, 'balanceOf', [reserveAddress]),
    call(reserveAddress, reserve, 'usdc'),
    call(reserveAddress, reserve, 'stock'),
    call(reserveAddress, reserve, 'feed'),
  ]);
  if (
    getAddress(String(usdcRoute[0])) !== getAddress(manifest.usdc) ||
    getAddress(String(stockRoute[0])) !== stock ||
    getAddress(String(feedRoute[0])) !== feedAddress
  )
    throw new Error('STOCK_READINESS_ROUTE');
  const at = Number(price[1]),
    calendarAt = Number(calendar[0]),
    open = Number(opens[0]),
    close = Number(closes[0]);
  if (![at, calendarAt, open, close].every(Number.isSafeInteger)) throw new Error('STOCK_READINESS_TIME');
  // A fresh real CLOSED calendar is useful readiness even before any reference price is initialized.
  const status: StockAutomationReadiness['status'] =
    hash(String(calendarDigest[0])) === zero || !calendarAt
      ? 'UNINITIALIZED'
      : calendarAt > now || now - calendarAt > 60
        ? 'STALE_CALENDAR'
        : now < open || now >= close || !allowed[0]
          ? 'MARKET_CLOSED'
          : !uint(String(price[0])) || hash(String(price[2])) === zero || !at
            ? 'UNINITIALIZED'
            : at > now || now - at > Number(route.maxPriceAge)
              ? 'STALE_REFERENCE'
              : paused[0]
                ? 'PAUSED'
                : !uint(String(cash[0])) || !uint(String(inventory[0]))
                  ? 'EMPTY_RESERVE'
                  : 'READY';
  const canonical = (await provider.request({
    method: 'eth_getBlockByNumber',
    params: [block.number, false],
  })) as { hash: string } | null;
  if (!canonical || hash(canonical.hash) !== hash(block.hash)) throw new Error('STOCK_READINESS_REORG');
  return {
    strategyId,
    chainId: 46630,
    status,
    referenceObservedAt: at,
    calendarObservedAt: calendarAt,
    regularOpen: open,
    regularClose: close,
    stockPriceUsdcRaw: status === 'READY' ? String(price[0]) : null,
    keeper: getAddress(String(keeper[0])),
    blockNumber: String(BigInt(block.number)),
    blockHash: block.hash,
  };
}
