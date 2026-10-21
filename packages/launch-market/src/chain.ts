import type { MarketSnapshot, MarketTransaction, MarketWalletSnapshot, StrategyId } from './types.ts';

export interface ObservedMarketTransaction extends MarketTransaction {
  readonly hash: string;
  readonly from: string;
  readonly chainId: number;
}
export interface ObservedMarketReceipt {
  readonly transactionHash: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly status: 'SUCCESS' | 'REVERTED';
}
export interface MarketSnapshotTarget {
  readonly blockNumber: string;
  readonly blockHash: string;
}
/** Implement with the qualified deployed ABI and canonical RPC reads. It never signs or broadcasts. */
export interface MarketChain {
  /** Fresh canonical RPC head, independent of the historical event scanner. */
  head?(): Promise<{ readonly number: string; readonly hash: string }>;
  snapshot(at?: MarketSnapshotTarget): Promise<MarketSnapshot>;
  wallet(owner: string): Promise<MarketWalletSnapshot>;
  quoteAmm(
    strategy: StrategyId,
    side: 'BUY' | 'SELL',
    amountRaw: string,
    blockHash: string,
  ): Promise<{ outputRaw: string; feeRaw: string }>;
  /** eth_call and eth_estimateGas using the same exact from/to/data/value. */
  simulate(transaction: MarketTransaction, owner: string): Promise<string>;
  transaction(hash: string): Promise<ObservedMarketTransaction | null>;
  receipt(hash: string): Promise<ObservedMarketReceipt | null>;
  canonicalBlockHash(blockNumber: string): Promise<string | null>;
  signingPolicy(): Promise<{
    readonly quoteSigner: string;
    readonly claimSigner: string;
    readonly quoteEpoch: string;
    readonly claimEpoch: string;
    readonly claimsOpened: boolean;
  }>;
}
export interface EthReference {
  readonly ethUsdPriceRaw: string;
  readonly observedAt: number;
}
export interface EthReferenceProvider {
  read(): Promise<EthReference>;
}
