export { LAUNCH_CHAIN_ID } from '../../../../packages/launch-market/src/config.ts';
export type {
  ChainLocation,
  StrategyId,
  SettlementAsset as PaymentAsset,
  MarketOperation,
  StrategyMarketSnapshot as LaunchMarket,
  MarketSnapshot as LaunchSnapshot,
  MarketWalletSnapshot as LaunchWallet,
  QuoteRequest,
  MarketQuote as LaunchQuote,
} from '../../../../packages/launch-market/src/types.ts';
import type {
  MarketConfiguration,
  MarketSnapshot,
  MarketWalletSnapshot,
  MarketQuote,
  QuoteRequest,
  OperationState,
} from '../../../../packages/launch-market/src/types.ts';
import type { ExecutorReview, ExecutorSnapshot } from './executor.ts';
import type { StockExecutionReview, StockExecutionSnapshot } from './stock-execution.ts';

export type LaunchConfig = MarketConfiguration & { readonly emailVerificationRequired?: boolean };
export type TransactionState = OperationState | 'IDLE';
export interface LaunchAccount {
  readonly id: string;
  readonly accountKey: string;
  readonly wallet: string | null;
  readonly emailVerified: boolean;
  readonly identityKind?: 'GOOGLE' | 'WALLET_TEST';
  readonly claimStatus:
    'ELIGIBLE' | 'ISSUED' | 'SUBMITTED' | 'INCLUDED' | 'COMPLETED' | 'REORGED' | 'REVERTED' | 'EXPIRED';
}
export interface LaunchTransaction {
  readonly id: string | null;
  readonly hash: string | null;
  readonly state: TransactionState;
  readonly confirmations: number;
  readonly approval: boolean;
  readonly owner: string | null;
  readonly executor?: boolean;
  readonly stock?: boolean;
}
export interface LaunchClientState {
  readonly enabled: boolean;
  readonly config: LaunchConfig | null;
  readonly snapshot: MarketSnapshot | null;
  readonly wallet: MarketWalletSnapshot | null;
  readonly account?: LaunchAccount | null;
  readonly owner: string | null;
  readonly connecting: boolean;
  readonly busy: boolean;
  readonly walletSignIn?: 'CHECKING' | 'AWAITING_SIGNATURE' | 'VERIFYING' | null;
  readonly quote: MarketQuote | null;
  readonly quoteRequest: QuoteRequest | null;
  readonly executorReview?: ExecutorReview | null;
  readonly executorSnapshots?: Partial<Record<'TSLA' | 'AMZN', ExecutorSnapshot>>;
  readonly stockReview?: StockExecutionReview | null;
  readonly stockSnapshots?: Partial<Record<'TSLA' | 'AMZN', StockExecutionSnapshot>>;
  readonly transaction: LaunchTransaction;
  readonly error: string | null;
  readonly notice: string | null;
}
