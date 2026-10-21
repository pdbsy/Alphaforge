import type { LaunchClientState, StrategyId } from './model.ts';
import { escapeHtml as esc, rawAmount } from './presentation.ts';
import type { PaperLedgerValue } from '../../../../packages/launch-market/src/paper-ledger.ts';
import { renderPaperPortfolio } from './paper-portfolio-ui.ts';

export interface VaultActionsViewState {
  flow: {
    strategyId: StrategyId;
    kind: 'DEPOSIT' | 'STOP' | 'WITHDRAW';
    phase: string;
    busy: boolean;
    review: boolean;
    pendingHash: string | null;
  } | null;
  error: string | null;
  notice: string | null;
  paused: Partial<Record<StrategyId, boolean>>;
}

const phases: Readonly<Record<string, string>> = {
  READY: 'Review the next Vault step',
  FAILED: 'This step did not complete',
  CHECKING: 'Checking current Vault state',
  PREPARING: 'Preparing your next step',
  CREATE_REVIEW: 'Review Vault creation',
  DEPOSIT_REVIEW: 'Review your deposit',
  APPROVAL_REVIEW: 'Review token approval',
  BUY_REVIEW: 'Review your stock purchase',
  SELL_REVIEW: 'Review the full stock sale',
  REVOKE_REVIEW: 'Review removal of trading permission',
  CLOSE_REVIEW: 'Review full withdrawal and PASS release',
  AWAITING_WALLET: 'Waiting for your wallet',
  SUBMITTED: 'Waiting for chain confirmation',
  CONFIRMING: 'Verifying chain confirmation',
  PENDING: 'Waiting for chain confirmation',
  PAPER_PENDING: 'Deposit confirmed · queued for automatic simulated entry',
  RUNNING: 'Purchase in progress',
  HOLDING: 'Simulated holding',
  PAUSING: 'Stopping further execution',
  PAUSED: 'Stopped',
  STOPPED: 'Stopped',
  WITHDRAWING: 'Withdrawal in progress',
  COMPLETED: 'Completed',
  CLOSED: 'Withdrawn · all PASS released',
  RECOVERY_REQUIRED: 'Check the previous transaction before continuing',
  BLOCKED: 'Action needs attention',
  LEGACY_RESULT: 'Previous on-chain workflow · simulation is separate',
};

/** UI state is explanatory; the controller revalidates every step before requesting a wallet signature. */
export function renderVaultActionStatus(
  launch: LaunchClientState,
  actions: VaultActionsViewState | undefined,
  strategy: StrategyId,
  valuation?: VaultValuationView,
): string {
  const flow = actions?.flow?.strategyId === strategy ? actions.flow : null;
  const vault = launch.wallet?.vaults.find(
    (entry) => entry.strategyId === strategy && entry.status === 'OPEN',
  );
  const holding = valuation?.value && BigInt(valuation.value.paper.quantityRaw) > 0n;
  const status = flow
    ? (phases[flow.phase] ?? 'Vault operation in progress')
    : actions?.paused[strategy]
      ? 'Stopped · simulated holdings remain recorded'
      : holding
        ? `Simulated ${strategy} holding`
        : vault && BigInt(vault.cashRaw) > 0n
          ? 'Cash available in your Vault'
          : 'Ready to deposit';
  const recover =
    flow &&
    !flow.busy &&
    !flow.review &&
    (flow.pendingHash ||
      ['READY', 'PAPER_PENDING', 'RECOVERY_REQUIRED', 'AWAITING_WALLET'].includes(flow.phase));
  const hashRecovery =
    flow &&
    !flow.busy &&
    ['RECOVERY_REQUIRED', 'AWAITING_WALLET'].includes(flow.phase) &&
    !flow.review &&
    !flow.pendingHash;
  return `<div class="launch-vault-progress" data-launch-vault-progress="${strategy}" aria-live="polite"><p class="small" role="status"><strong>${esc(status)}</strong></p>${flow && actions?.notice ? `<p class="small muted">${esc(actions.notice)}</p>` : ''}${flow && actions?.error ? `<p class="form-error" role="alert">${esc(actions.error)}</p>` : ''}${recover ? `<button class="text-link" type="button" data-launch-vault-recover="${strategy}">${flow.phase === 'READY' ? 'Continue Vault steps' : flow.phase === 'PAPER_PENDING' ? 'Check simulated entry' : 'Check existing transaction'} ↗</button><p class="small muted">${flow.phase === 'READY' ? 'Continue from the current verified step. Each new on-chain transaction needs wallet confirmation.' : flow.phase === 'PAPER_PENDING' ? 'The server checks automatically, even with this page closed. Entry waits for market opening and a fresh authorized quote. Stop cancels the pending entry; Withdraw returns the cash.' : 'Check the previous wallet result before sending another transaction.'}</p>` : ''}${hashRecovery ? `<form data-launch-vault-hash-recover data-strategy="${strategy}"><label for="vault-recover-${strategy}">Find the previous transaction in your wallet and enter its hash.</label><input id="vault-recover-${strategy}" name="hash" type="text" autocomplete="off" placeholder="0x…" required><button class="outline-btn" type="submit">Verify existing transaction ↗</button><p class="small muted">Check the previous wallet request before continuing. This verifies the original transaction and sends no replacement.</p></form>` : ''}</div>`;
}

export interface VaultValuationView {
  vault?: string | null;
  value?: PaperLedgerValue;
  equityRaw?: string | null;
  principalRaw?: string;
  profitRaw?: string | null;
  returnBps?: string | null;
  status?: 'FRESH' | 'STALE' | 'UNAVAILABLE';
  observedAt: number | null;
  priceObservedAt?: number | null;
  error?: string | null;
  busy?: boolean;
}
export type VaultValuationsView = Partial<Record<StrategyId, VaultValuationView>> & {
  byVault?: Readonly<Record<string, VaultValuationView>>;
};

export function vaultReturnPercent(equityRaw: string | null, principalRaw: string): string {
  if (equityRaw === null || BigInt(principalRaw) <= 0n) return '—';
  const difference = BigInt(equityRaw) - BigInt(principalRaw);
  const principal = BigInt(principalRaw);
  const absoluteDifference = difference < 0n ? -difference : difference;
  const absolute = (absoluteDifference * 10000n + principal / 2n) / principal;
  if (difference !== 0n && absolute === 0n) return `${difference < 0n ? '-' : '+'}<0.01%`;
  return `${difference < 0n ? '-' : difference > 0n ? '+' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}%`;
}

/** Real custody is shown separately from simulated performance; the amounts are never summed. */
export function renderVaultPerformance(
  launch: LaunchClientState,
  strategy: StrategyId,
  valuation?: VaultValuationView,
  vaultAddress?: string,
): string {
  const vault = launch.wallet?.vaults.find(
    (entry) =>
      entry.strategyId === strategy &&
      (vaultAddress ? entry.address.toLowerCase() === vaultAddress.toLowerCase() : entry.status === 'OPEN'),
  );
  if (!vault) return '';
  const matching =
    valuation && (!valuation.vault || valuation.vault.toLowerCase() === vault.address.toLowerCase());
  const view = matching ? valuation : undefined;
  const real = view?.value?.real;
  const principal = real?.principalRaw ?? vault.principalBasisRaw;
  const when = (seconds: number | null | undefined) =>
    seconds && Number.isSafeInteger(seconds) ? new Date(seconds * 1000).toLocaleString('en-US') : null;
  const observed = when(real?.observedAt ?? view?.observedAt);
  return `<section class="launch-vault-performance" aria-label="${strategy} on-chain funds"><span class="section-label">ON-CHAIN FUNDS</span><div class="wallet-amount"><strong>${rawAmount(principal, 6)}</strong><span>AF-USDC principal</span></div><dl class="order-quote"><div><dt>On-chain Vault cash</dt><dd>${rawAmount(real?.cashRaw ?? vault.cashRaw, 6)} AF-USDC</dd></div><div><dt>Withdrawable on-chain cash</dt><dd>${real ? rawAmount(real.withdrawableRaw, 6) : '—'}${real ? ' AF-USDC' : ''}</dd></div><div><dt>Locked PASS</dt><dd>${rawAmount(real?.lockedPassRaw ?? vault.lockedPassRaw, 18)}</dd></div></dl><p class="small muted">${vault.status === 'CLOSED' ? 'This Vault is closed. Simulated results below remain in its history.' : 'Withdraw returns on-chain cash and releases PASS. Simulated profit does not increase this amount.'}${observed ? ` Funding record updated ${esc(observed)}.` : ''}${view?.busy ? ' Updating…' : ''}</p></section>${renderPaperPortfolio(view?.value, view?.error)}`;
}
