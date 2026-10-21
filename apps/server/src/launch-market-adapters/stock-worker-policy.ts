import { getAddress, sha256, toUtf8Bytes, verifyMessage, ZeroAddress } from 'ethers';
import { uint, hash } from '../../../../packages/launch-market/src/config.ts';
import type { StrategyId } from '../../../../packages/launch-market/src/types.ts';
import type { ExecutorPermission } from '../../../web/src/launch-market/executor.ts';
import type { StockExecutionSnapshot } from '../../../web/src/launch-market/stock-execution.ts';

export const stockEvidenceHash = (value: unknown): string => sha256(toUtf8Bytes(JSON.stringify(value)));
export type StockPolicy =
  | { readonly kind: 'BUY_AND_HOLD' }
  | { readonly kind: 'DCA'; readonly intervalSeconds: number; readonly installmentUsdcRaw: string }
  | { readonly kind: 'EMA_CROSS'; readonly fast: number; readonly slow: number };
export interface StockAutomationConsent {
  readonly schemaVersion: 1;
  readonly chainId: 46630;
  readonly manifestDigest: string;
  readonly owner: string;
  readonly vault: string;
  readonly strategyId: StrategyId;
  readonly initialVersion: string;
  readonly grant: ExecutorPermission;
  readonly policy: StockPolicy;
  readonly validUntil: number;
  readonly maxPositionUsdcRaw: string;
  /** Zero disables this threshold. All thresholds use the actual stock reference, never PASS price. */
  readonly stopPriceUsdcRaw: string;
  readonly takePriceUsdcRaw: string;
  readonly nonce: string;
}
export interface SignedStockConsent {
  readonly consent: StockAutomationConsent;
  readonly signature: string;
}
export interface StockMinuteBar {
  readonly start: number;
  readonly closeUsdcRaw: string;
  readonly sourceDigest: string;
  readonly sourceEvidence?: unknown;
}
function keys(value: object, expected: readonly string[]) {
  if (Object.keys(value).sort().join('|') !== [...expected].sort().join('|'))
    throw new Error('STOCK_POLICY_FIELDS');
}
export function validateStockConsent(c: StockAutomationConsent): void {
  keys(c, [
    'schemaVersion',
    'chainId',
    'manifestDigest',
    'owner',
    'vault',
    'strategyId',
    'initialVersion',
    'grant',
    'policy',
    'validUntil',
    'maxPositionUsdcRaw',
    'stopPriceUsdcRaw',
    'takePriceUsdcRaw',
    'nonce',
  ]);
  if (c.schemaVersion !== 1 || c.chainId !== 46630 || !['TSLA', 'AMZN'].includes(c.strategyId))
    throw new Error('STOCK_POLICY_IDENTITY');
  hash(c.manifestDigest);
  uint(c.initialVersion);
  const owner = getAddress(c.owner),
    vault = getAddress(c.vault),
    executor = getAddress(c.grant.executor);
  if ([owner, vault, executor].includes(ZeroAddress) || new Set([owner, vault, executor]).size !== 3)
    throw new Error('STOCK_POLICY_AUTHORITY');
  keys(c.grant, ['executor', 'expiresAt', 'maxOrderUsdc', 'maxTotalBuyUsdc', 'maxSlippageBps']);
  if (
    !Number.isSafeInteger(c.validUntil) ||
    c.validUntil < 1 ||
    uint(c.grant.expiresAt) >= 2n ** 64n ||
    BigInt(c.validUntil) > uint(c.grant.expiresAt) ||
    uint(c.grant.maxOrderUsdc) === 0n ||
    uint(c.grant.maxTotalBuyUsdc) === 0n ||
    uint(c.grant.maxOrderUsdc) > uint(c.grant.maxTotalBuyUsdc) ||
    !Number.isSafeInteger(c.grant.maxSlippageBps) ||
    c.grant.maxSlippageBps < 0 ||
    c.grant.maxSlippageBps > 500 ||
    uint(c.maxPositionUsdcRaw) === 0n ||
    !/^[a-zA-Z0-9_-]{16,96}$/.test(c.nonce)
  )
    throw new Error('STOCK_POLICY_LIMITS');
  const stop = uint(c.stopPriceUsdcRaw),
    take = uint(c.takePriceUsdcRaw);
  if (stop && take && stop >= take) throw new Error('STOCK_POLICY_THRESHOLDS');
  if (c.policy.kind === 'BUY_AND_HOLD') keys(c.policy, ['kind']);
  else if (c.policy.kind === 'DCA') {
    keys(c.policy, ['kind', 'intervalSeconds', 'installmentUsdcRaw']);
    if (
      !Number.isSafeInteger(c.policy.intervalSeconds) ||
      c.policy.intervalSeconds < 60 ||
      c.policy.intervalSeconds > 31 * 86400 ||
      !uint(c.policy.installmentUsdcRaw) ||
      uint(c.policy.installmentUsdcRaw) > uint(c.grant.maxOrderUsdc)
    )
      throw new Error('STOCK_POLICY_DCA');
  } else if (c.policy.kind === 'EMA_CROSS') {
    keys(c.policy, ['kind', 'fast', 'slow']);
    if (
      !Number.isSafeInteger(c.policy.fast) ||
      !Number.isSafeInteger(c.policy.slow) ||
      c.policy.fast < 2 ||
      c.policy.slow <= c.policy.fast ||
      c.policy.slow > 120
    )
      throw new Error('STOCK_POLICY_EMA');
  } else throw new Error('STOCK_POLICY_KIND');
}
/** Stable explicit field order makes the same wallet message available to web and offline operators. */
export function stockConsentMessage(c: StockAutomationConsent): string {
  validateStockConsent(c);
  const normalized = {
    schemaVersion: c.schemaVersion,
    chainId: c.chainId,
    manifestDigest: c.manifestDigest.toLowerCase(),
    owner: getAddress(c.owner).toLowerCase(),
    vault: getAddress(c.vault).toLowerCase(),
    strategyId: c.strategyId,
    initialVersion: c.initialVersion,
    grant: {
      executor: getAddress(c.grant.executor).toLowerCase(),
      expiresAt: c.grant.expiresAt,
      maxOrderUsdc: c.grant.maxOrderUsdc,
      maxTotalBuyUsdc: c.grant.maxTotalBuyUsdc,
      maxSlippageBps: c.grant.maxSlippageBps,
    },
    policy:
      c.policy.kind === 'BUY_AND_HOLD'
        ? { kind: c.policy.kind }
        : c.policy.kind === 'DCA'
          ? {
              kind: c.policy.kind,
              intervalSeconds: c.policy.intervalSeconds,
              installmentUsdcRaw: c.policy.installmentUsdcRaw,
            }
          : { kind: c.policy.kind, fast: c.policy.fast, slow: c.policy.slow },
    validUntil: c.validUntil,
    maxPositionUsdcRaw: c.maxPositionUsdcRaw,
    stopPriceUsdcRaw: c.stopPriceUsdcRaw,
    takePriceUsdcRaw: c.takePriceUsdcRaw,
    nonce: c.nonce,
  };
  return (
    'AlphaForge stock automation authorization\nThis permits the named executor to trade only this Vault under these limits.\n' +
    JSON.stringify(normalized)
  );
}
export function verifyStockConsent(signed: SignedStockConsent): string {
  keys(signed, ['consent', 'signature']);
  const message = stockConsentMessage(signed.consent);
  if (getAddress(verifyMessage(message, signed.signature)) !== getAddress(signed.consent.owner))
    throw new Error('STOCK_POLICY_SIGNATURE');
  return stockEvidenceHash(message);
}
function minimum(...values: bigint[]): bigint {
  return values.reduce((a, b) => (a < b ? a : b));
}
export function emaStockSignal(
  bars: readonly StockMinuteBar[],
  fast: number,
  slow: number,
  now: number,
): 'BUY' | 'SELL' | 'HOLD' {
  if (bars.length < slow * 3 + 1 || bars.length > 400) throw new Error('STOCK_EMA_WARMUP');
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    if (
      !Number.isSafeInteger(bar.start) ||
      bar.start % 60 ||
      bar.start + 90 > now ||
      !uint(bar.closeUsdcRaw) ||
      (i && bar.start !== bars[i - 1]!.start + 60)
    )
      throw new Error('STOCK_EMA_GAP_OR_UNFINISHED');
    hash(bar.sourceDigest);
  }
  if (now - bars.at(-1)!.start > 180) throw new Error('STOCK_EMA_STALE');
  // Fixed-point integer EMA, seeded only from real source bars; no floating-point order decisions.
  const scale = 10n ** 18n;
  let f = uint(bars[0]!.closeUsdcRaw) * scale,
    s = f,
    previous = 0n;
  for (let i = 1; i < bars.length; i++) {
    previous = f - s;
    const close = uint(bars[i]!.closeUsdcRaw) * scale;
    f += ((close - f) * 2n) / BigInt(fast + 1);
    s += ((close - s) * 2n) / BigInt(slow + 1);
  }
  return previous <= 0n && f > s ? 'BUY' : previous >= 0n && f < s ? 'SELL' : 'HOLD';
}
export interface StockDecision {
  readonly buy: boolean;
  readonly inputRaw: string;
  readonly reason: string;
}
/** Authoritative balances and grant always come from the canonical reader, never policy HTTP input. */
export function decideStockOrder(
  c: StockAutomationConsent,
  snapshot: StockExecutionSnapshot,
  now: number,
  progress: { readonly lastBuyAt: number | null; readonly riskStopped: boolean },
  bars: readonly StockMinuteBar[] = [],
): StockDecision | null {
  validateStockConsent(c);
  const s = snapshot;
  if (s.status !== 'READY' || now < s.blockTimestamp || now - s.blockTimestamp > 30)
    throw new Error('STOCK_MARKET_NOT_READY');
  if (
    getAddress(s.owner) !== getAddress(c.owner) ||
    getAddress(s.vault) !== getAddress(c.vault) ||
    s.strategyId !== c.strategyId ||
    getAddress(s.grant.executor) !== getAddress(c.grant.executor) ||
    s.grant.expiresAt !== c.grant.expiresAt ||
    s.grant.maxOrderUsdc !== c.grant.maxOrderUsdc ||
    s.grant.maxTotalBuyUsdc !== c.grant.maxTotalBuyUsdc ||
    s.grant.maxSlippageBps !== c.grant.maxSlippageBps ||
    now >= c.validUntil ||
    BigInt(now) >= uint(s.grant.expiresAt)
  )
    throw new Error('STOCK_GRANT_CHANGED_OR_EXPIRED');
  const price = uint(s.stockPriceUsdcRaw),
    position = uint(s.trackedStockRaw),
    cash = uint(s.trackedCashRaw);
  const stop = uint(c.stopPriceUsdcRaw),
    take = uint(c.takePriceUsdcRaw);
  const risk = progress.riskStopped || (stop > 0n && price <= stop) || (take > 0n && price >= take);
  let side: 'BUY' | 'SELL' | 'HOLD' = risk ? 'SELL' : 'BUY';
  if (!risk && c.policy.kind === 'EMA_CROSS') side = emaStockSignal(bars, c.policy.fast, c.policy.slow, now);
  if (side === 'HOLD' || (side === 'SELL' && !position)) return null;
  if (side === 'SELL') {
    const input = minimum(position, (uint(s.grant.maxOrderUsdc) * 10n ** 18n) / price);
    return input > 0n
      ? { buy: false, inputRaw: String(input), reason: risk ? 'RISK_EXIT' : 'EMA_SELL' }
      : null;
  }
  if (
    c.policy.kind === 'DCA' &&
    progress.lastBuyAt !== null &&
    now < progress.lastBuyAt + c.policy.intervalSeconds
  )
    return null;
  const positionValue = (position * price) / 10n ** 18n;
  const remaining =
    uint(s.grant.maxTotalBuyUsdc) > uint(s.totalBuyUsdc)
      ? uint(s.grant.maxTotalBuyUsdc) - uint(s.totalBuyUsdc)
      : 0n;
  const cap = uint(c.maxPositionUsdcRaw) > positionValue ? uint(c.maxPositionUsdcRaw) - positionValue : 0n;
  const installment =
    c.policy.kind === 'DCA' ? uint(c.policy.installmentUsdcRaw) : uint(s.grant.maxOrderUsdc);
  const input = minimum(cash, remaining, cap, uint(s.grant.maxOrderUsdc), installment);
  return input > 0n ? { buy: true, inputRaw: String(input), reason: c.policy.kind } : null;
}
