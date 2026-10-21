export type M3DialogPhase = 'review' | 'confirm';

export interface M3DialogControl {
  disabled: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'CHAIN_REQUEST_FAILED';
}

export async function runM3DialogAction(
  phase: M3DialogPhase,
  control: M3DialogControl,
  action: () => Promise<void>,
  showError: (message: string) => void,
): Promise<boolean> {
  control.disabled = true;
  showError('');
  try {
    await action();
    return true;
  } catch (error) {
    const message = errorMessage(error);
    if (phase === 'review') {
      control.disabled = false;
      showError(message);
    } else {
      showError(
        `${message}. Do not retry automatically. Close this dialog and start a new review; if a wallet request may have been submitted, wait for reconciliation first.`,
      );
    }
    return false;
  }
}

const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );

export function renderM3DepositApprovalDialog(review: M3DepositApprovalReview): string {
  const required = review.requirements.filter((requirement) => !requirement.sufficient);
  return `<span class="section-label">WALLET / EXACT APPROVALS</span><h2>Authorize Deposit.</h2><p>Each approval fixes one token, the configured Vault spender and the exact finite amount required for this Deposit. Submit one approval, wait for its receipt, then start a new review for the remaining requirement.</p><div class="receipt"><div class="receipt-lines">${review.requirements
    .map(
      (requirement) =>
        `<div><span>${requirement.kind === 'af-usdc' ? 'AF-USDC' : 'Pass'} · allowance ${escapeHtml(requirement.allowance)}</span><span>required ${escapeHtml(requirement.requiredRaw)} · ${escapeHtml(requirement.token)} → ${escapeHtml(requirement.spender)}</span></div>`,
    )
    .join(
      '',
    )}</div></div><p data-product-dialog-error class="form-error" role="alert"></p><div class="inline-actions">${required
    .map(
      (requirement) =>
        `<button class="primary-btn" data-chain-approve="${requirement.kind}">Approve exact ${requirement.kind === 'af-usdc' ? 'AF-USDC' : 'Pass'} amount ↗</button>`,
    )
    .join('')}<button class="text-link" data-close>Cancel</button></div>`;
}
import type { M3DepositApprovalReview } from './m3-product-runtime.ts';
