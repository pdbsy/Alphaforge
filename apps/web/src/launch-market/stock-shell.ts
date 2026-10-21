import type { LaunchClientState, StrategyId } from './model.ts';
import { actionable, escapeHtml as esc, rawAmount } from './presentation.ts';

const messages = {
  UNINITIALIZED:
    'The chain price feed has not been initialized. The authorized feed keeper must publish a verified stock price and trading session before a strategy trade can execute.',
  MARKET_CLOSED:
    'The regular US stock market session is closed. You can deposit or withdraw available cash; new stock trades wait for the next verified session.',
  STALE_REFERENCE:
    'The chain stock price is stale. A fresh price is required before buying or selling stock holdings.',
  STALE_CALENDAR: 'The verified trading session has expired. The feed keeper must publish a fresh session.',
  PAUSED: 'The stock trading reserve is paused.',
  VAULT_CLOSED: 'This Vault is closed.',
  READY: 'A fresh on-chain stock price and regular trading session are available.',
};

export function renderStockExecution(state: LaunchClientState, strategy: StrategyId): string {
  const snapshot = state.stockSnapshots?.[strategy];
  const now = Math.floor(Date.now() / 1000);
  const fresh =
    snapshot?.status === 'READY' && snapshot.executionCutoff !== null && snapshot.executionCutoff > now;
  const enabled = fresh && actionable(state, strategy, 'DEPOSIT', 'AF_USDC');
  const text = snapshot
    ? messages[snapshot.status]
    : 'Refresh the chain stock price and session to check whether strategy trading is available.';
  return `<section class="launch-stock-execution"><h3>Use your ${strategy} strategy</h3><p>Invest Vault cash in ${strategy} stock holdings at the verified stock price. Sell the holdings back to AF-USDC, then withdraw available cash to your wallet. Profit and loss come from those stock trades.</p><p class="small muted">You review and sign each trade as the Vault owner. Depositing cash alone does not place a stock trade.</p><dl class="order-quote">${snapshot ? `<div><dt>Stock reference price</dt><dd>${BigInt(snapshot.stockPriceUsdcRaw) > 0n ? `${rawAmount(snapshot.stockPriceUsdcRaw, 6)} AF-USDC / stock unit` : 'Not initialized'}</dd></div><div><dt>Reference updated</dt><dd>${snapshot.referenceObservedAt ? esc(new Date(snapshot.referenceObservedAt * 1000).toISOString()) : 'Not initialized'}</dd></div><div><dt>Stock holdings</dt><dd>${rawAmount(snapshot.trackedStockRaw, 18)}</dd></div><div><dt>Strategy trading</dt><dd>${esc(fresh ? 'READY' : snapshot.status === 'READY' ? 'REFRESH REQUIRED' : snapshot.status.replaceAll('_', ' '))}</dd></div>` : ''}</dl><p class="small muted" data-launch-stock-status role="status">${esc(snapshot?.status === 'READY' && !fresh ? 'The displayed price or session has expired. Refresh before reviewing a trade.' : text)}</p><button class="text-link" data-launch-stock-refresh="${strategy}" ${state.owner && !state.busy ? '' : 'disabled'}>Refresh stock price & session ↗</button><div class="inline-actions"><button class="primary-btn" data-launch-stock-buy="${strategy}" ${enabled && BigInt(snapshot!.trackedCashRaw) > 0n ? '' : 'disabled'}>Review invest available cash ↗</button><button class="outline-btn" data-launch-stock-sell="${strategy}" ${enabled && BigInt(snapshot!.trackedStockRaw) > 0n ? '' : 'disabled'}>Review sell stock holdings ↗</button></div><p class="small muted">The review shows exact amounts, minimum output and gas. Slippage is 1%. Unrealized gains become withdrawable AF-USDC only after a successful stock sale.</p></section>`;
}

export function renderStockReview(state: LaunchClientState): string {
  const review = state.stockReview;
  if (!review) return '';
  const { strategyId } = review.snapshot;
  return `<section class="launch-reviewed sketch-box" aria-label="Reviewed stock trade"><span class="section-label">REVIEW ${review.buy ? 'INVEST CASH' : 'SELL HOLDINGS'} · ${strategyId}</span><h2>${rawAmount(review.estimatedOutRaw, review.buy ? 18 : 6)} ${review.buy ? `${strategyId} stock units` : 'AF-USDC'}</h2><dl class="order-quote"><div><dt>Vault pays</dt><dd>${rawAmount(review.inputRaw, review.buy ? 6 : 18)} ${review.buy ? 'AF-USDC' : `${strategyId} stock units`}</dd></div><div><dt>Minimum received</dt><dd>${rawAmount(review.minOutRaw, review.buy ? 18 : 6)}</dd></div><div><dt>Stock price</dt><dd>${rawAmount(review.snapshot.stockPriceUsdcRaw, 6)} AF-USDC</dd></div><div><dt>Quote expires</dt><dd>${esc(new Date(review.deadline * 1000).toISOString())}</dd></div><div><dt>Estimated gas</dt><dd>${rawAmount(review.gasEstimateRaw, 0)} gas</dd></div></dl><p class="small muted">Assets settle inside your Vault in one chain transaction. A stock sale returns AF-USDC to the Vault; withdrawal to your wallet is a separate operation.</p><button class="primary-btn" data-launch-executor-confirm ${state.busy ? 'disabled' : ''}>Confirm stock trade in wallet ↗</button><button class="text-link" data-launch-clear ${state.busy ? 'disabled' : ''}>Cancel review</button></section>`;
}
