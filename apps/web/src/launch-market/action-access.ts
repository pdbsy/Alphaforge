import type { LaunchClientState, MarketOperation, PaymentAsset, StrategyId } from './model.ts';
import { actionable, escapeHtml } from './presentation.ts';

/** Explain the same account gate used by execution; connecting a wallet only enables chain reads. */
export function actionAccess(
  state: LaunchClientState,
  strategy: StrategyId,
  operation: MarketOperation,
  asset: PaymentAsset,
) {
  if (state.config?.deployment !== 'CONFIGURED')
    return { action: 'WAIT', reason: 'Market contracts are not ready.' } as const;
  if (state.connecting || state.busy)
    return {
      action: 'WAIT',
      reason: state.connecting ? 'Connecting your wallet…' : 'A wallet operation is in progress.',
    } as const;
  if (
    ['AWAITING_WALLET', 'SUBMITTED', 'INCLUDED', 'CONFIRMED_L2', 'REORGED', 'RECOVERY_REQUIRED'].includes(
      state.transaction.state,
    )
  )
    return {
      action: 'WAIT',
      reason: 'Check your pending transaction before starting another operation.',
    } as const;
  if (!state.owner) return { action: 'CONNECT', reason: 'Connect your wallet to continue.' } as const;
  if (!state.snapshot || !state.wallet)
    return { action: 'WAIT', reason: 'Reading the current chain state. Refresh if this continues.' } as const;
  if (!state.account || state.account.id !== state.wallet.accountId) {
    if (state.config.emailVerificationRequired === false || state.account?.emailVerified)
      return {
        action: 'BIND',
        reason:
          state.config.emailVerificationRequired === false && !state.account?.emailVerified
            ? 'Confirm wallet ownership with a message signature to continue. This signature moves no assets.'
            : 'Link your verified account with an ownership message before continuing.',
      } as const;
    return { action: 'LOGIN', reason: 'Sign in to your verified account, then link this wallet.' } as const;
  }
  if (actionable(state, strategy, operation, asset)) return { action: 'REVIEW', reason: '' } as const;
  const market = state.snapshot.markets[strategy];
  if (
    (operation === 'MINT' && market.state !== 'MINTING') ||
    (['BUY', 'SELL'].includes(operation) && market.state !== 'LAUNCHED')
  )
    return {
      action: 'WAIT',
      reason: operation === 'MINT' ? 'Public Mint is not open.' : 'This PASS market has not launched.',
    } as const;
  if (asset === 'ETH' && ['MINT', 'BUY', 'SELL'].includes(operation))
    return {
      action: 'WAIT',
      reason: 'This ETH path is unavailable. Choose AF-USDC or try again later.',
    } as const;
  return { action: 'WAIT', reason: 'Refresh your account and chain state to continue.' } as const;
}

export function actionControl(
  state: LaunchClientState,
  strategy: StrategyId,
  operation: MarketOperation,
  asset: PaymentAsset,
  label: string,
): string {
  const access = actionAccess(state, strategy, operation, asset);
  const controls = {
    CONNECT:
      '<button type="button" class="primary-btn full" data-launch-connect>Connect wallet to continue ↗</button>',
    BIND: `<button type="button" class="primary-btn full" data-launch-bind>${state.config?.emailVerificationRequired === false && !state.account?.emailVerified ? 'Continue with wallet' : 'Link account to continue'} ↗</button>`,
    LOGIN: '<a class="primary-btn full" href="/login/?next=%2Falphaforge%2F">Sign in to continue ↗</a>',
    REVIEW: `<button type="submit" class="primary-btn full">${escapeHtml(label)} ↗</button>`,
    WAIT: `<button type="submit" class="primary-btn full" disabled>${escapeHtml(label)} ↗</button>`,
  };
  return `${controls[access.action]}${access.reason ? `<p class="small muted" data-launch-access-reason role="status">${escapeHtml(access.reason)}</p>` : ''}`;
}

/** Replace only the existing primary action so the original home and Trade design stays intact. */
export function installActionAccess(
  host: {
    originalMarketLayout?: boolean;
    launchState?: LaunchClientState;
    launchForms?: Record<StrategyId, { operation: MarketOperation; asset: PaymentAsset }>;
    trade?: { actionPanel(strategy: { id: string }): string };
  },
  doc: Document = document,
): void {
  if (!host.originalMarketLayout || !host.trade) return;
  const original = host.trade.actionPanel;
  host.trade.actionPanel = (strategy) => {
    const html = original.call(host.trade, strategy),
      id = strategy.id.toUpperCase();
    if (id !== 'TSLA' && id !== 'AMZN') return html;
    const state = host.launchState,
      draft = host.launchForms?.[id];
    if (!state || !draft) return html;
    const template = doc.createElement('template');
    template.innerHTML = html;
    const primary = template.content.querySelector('[data-launch-order] > button[type="submit"]');
    if (primary) {
      const access = actionAccess(state, id, draft.operation, draft.asset);
      const label = `Review ${draft.operation === 'MINT' ? 'Mint' : draft.operation === 'SELL' ? 'Sell' : 'Buy'} ${id}`;
      const control = doc.createElement('template');
      control.innerHTML = actionControl(state, id, draft.operation, draft.asset, label);
      const button = control.content.querySelector('button');
      if (button && access.action === 'REVIEW') button.className = primary.className;
      primary.replaceWith(control.content);
    }
    return template.innerHTML;
  };
}
