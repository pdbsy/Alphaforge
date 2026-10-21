import { ROBINHOOD_CHAIN_TESTNET } from '../../../packages/robinhood-chain/src/network.ts';
import { formatUnits } from '../../../packages/domain/src/money.ts';
import type { Address } from '../../../packages/chain-adapter/src/types.ts';
import { MOCK_ETH_USDC_RATE, type MockWalletSnapshot } from './mock-wallet.ts';
import type { WalletSubmission } from './chain-wallet.ts';
import type { ProductOperationEvidence } from './strategy-adapter.ts';

export const M3_CANONICAL_STRATEGY_ID = 'trend' as const;

export const WALLET_STATUSES = [
  'DISCONNECTED',
  'CONNECTING',
  'CONNECTED',
  'CONNECTION_REJECTED',
  'ACCOUNT_CHANGED',
  'WALLET_DISCONNECTED',
] as const;

export const NETWORK_STATUSES = [
  'UNAVAILABLE',
  'CORRECT',
  'WRONG',
  'SWITCHING',
  'SWITCH_REJECTED',
  'UNSUPPORTED',
  'RPC_UNAVAILABLE',
] as const;

export const TRANSACTION_STATUSES = [
  'IDLE',
  'WALLET_APPROVAL_REQUIRED',
  'WALLET_PENDING',
  'SUBMITTED',
  'SUBMISSION_AMBIGUOUS',
  'CONFIRMING',
  'CHAIN_CONFIRMED',
  'INDEXING',
  'READY',
  'FAILED',
] as const;

export type WalletStatus = (typeof WALLET_STATUSES)[number];
export type NetworkStatus = (typeof NETWORK_STATUSES)[number];
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
export type ProductProvenance = 'FIXTURE' | 'LOCAL SIMULATION';

export interface WalletPresentation {
  readonly status: WalletStatus;
  readonly address?: string;
  /** Native ETH only, in wei. Never populated from a local demo ledger. */
  readonly ethBalanceWei?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface NetworkPresentation {
  readonly status: NetworkStatus;
  readonly chainId?: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface TransactionPresentation {
  readonly status: TransactionStatus;
  readonly txHash?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export type OnchainProductAction = 'deposit' | 'withdraw' | 'close' | 'rescue-token' | 'rescue-native';
export type OnchainReadiness = 'UNKNOWN' | 'SOFT_READY' | 'FINALITY_UNKNOWN' | 'REORGED';

export interface DepositAuthorizationPresentation {
  readonly spender: string;
  readonly afUsdcAllowanceBaseUnits: string;
  readonly passAllowanceBaseUnits: string;
  readonly approvalCapability: 'UNAVAILABLE' | 'AVAILABLE';
}

export interface OnchainProductPresentation {
  readonly deployment: 'UNAVAILABLE' | 'CONFIGURED';
  readonly health: 'UNAVAILABLE' | 'LIVE' | 'DEGRADED';
  readonly readiness: OnchainReadiness;
  readonly owner: 'UNKNOWN' | 'OWNER' | 'NON_OWNER';
  readonly writeMode: 'DISABLED' | 'INJECTED_MOCK' | 'LIVE_AUTHORIZED';
  readonly exitPath: 'UNAVAILABLE' | 'LIVE_RPC' | 'SIMULATION';
  readonly supportedActions: readonly OnchainProductAction[];
  readonly vaultAddress?: string;
  readonly vaultClosed?: boolean;
  readonly passAddress?: string;
  readonly passBalanceBaseUnits?: string;
  readonly passInitialSupplyBaseUnits?: string;
  readonly passInitialRecipient?: string;
  readonly passTransferMode?: 'DISABLED' | 'INJECTED_MOCK' | 'LIVE_AUTHORIZED';
  readonly depositAuthorization?: DepositAuthorizationPresentation;
}

export interface M3VaultSelection {
  readonly chainId: 46_630;
  readonly vaultAddress: Address;
}

export interface M3VaultSelectionState {
  readonly selected: M3VaultSelection;
  readonly options: readonly M3VaultSelection[];
}

export interface M3ProductChainPresentation {
  readonly wallet: WalletPresentation;
  readonly network: NetworkPresentation;
  readonly transaction: TransactionPresentation;
  readonly onchain: OnchainProductPresentation;
  readonly vaultSelection?: M3VaultSelectionState;
}

export interface StrategyShellInput {
  readonly strategyId: string;
  readonly contentProvenance: ProductProvenance;
  readonly wallet?: WalletPresentation;
  readonly network?: NetworkPresentation;
  readonly transaction?: TransactionPresentation;
  readonly onchain?: OnchainProductPresentation;
  readonly vaultSelection?: M3VaultSelectionState;
}

export interface AccountShellInput {
  readonly accountId?: string | null;
  readonly wallet?: WalletPresentation;
  readonly network?: NetworkPresentation;
  readonly transaction?: TransactionPresentation;
  readonly onchain?: OnchainProductPresentation;
  readonly vaultSelection?: M3VaultSelectionState;
}

export interface M3ProductPages {
  readonly account: (tab: string) => string;
  readonly trade: (strategyId: string) => string;
}

export interface M3PageExtensionOptions {
  readonly mockWallet?: () => MockWalletSnapshot | undefined;
  readonly accountId: () => string | null;
  readonly contentProvenance: (strategyId: string) => ProductProvenance;
  readonly onchain?: () => OnchainProductPresentation | undefined;
  readonly chain?: () => M3ProductChainPresentation | undefined;
}

const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );

const walletMessages: Record<WalletStatus, string> = {
  DISCONNECTED: 'Disconnected. Connect a supported wallet to continue.',
  CONNECTING: 'Connecting. Complete the request in your wallet.',
  CONNECTED: 'Connected.',
  CONNECTION_REJECTED: 'Connection rejected in the wallet.',
  ACCOUNT_CHANGED: 'Wallet account changed. AlphaForge must refresh wallet-owned state.',
  WALLET_DISCONNECTED: 'Wallet disconnected after connection. Pending product state may be stale.',
};

const networkMessages: Record<NetworkStatus, string> = {
  UNAVAILABLE: 'Network state is unavailable until the chain adapter is connected.',
  CORRECT: 'Connected to the required Robinhood Chain network.',
  WRONG: 'Wrong network. Switch to the configured Robinhood Chain network before continuing.',
  SWITCHING: 'Waiting for the wallet to switch networks.',
  SWITCH_REJECTED: 'Network switch rejected in the wallet.',
  UNSUPPORTED: 'This wallet or network cannot use the configured chain.',
  RPC_UNAVAILABLE: 'Robinhood Chain RPC is unavailable.',
};

const transactionMessages: Record<TransactionStatus, string> = {
  IDLE: 'No chain transaction is in progress.',
  WALLET_APPROVAL_REQUIRED: 'Review the action before requesting wallet approval.',
  WALLET_PENDING: 'Waiting for wallet confirmation.',
  SUBMITTED: 'Transaction submitted. Waiting for an RPC receipt.',
  SUBMISSION_AMBIGUOUS:
    'Wallet submission outcome is unknown. Do not retry automatically; wait for chain reconciliation.',
  CONFIRMING: 'Transaction is confirming on-chain.',
  CHAIN_CONFIRMED:
    'Transaction receipt succeeded on-chain. AlphaForge is waiting for canonical reconciliation and product readback.',
  INDEXING: 'Canonical chain evidence is reconciled. Waiting for the current product projection.',
  READY: 'Transaction and readback complete. The AlphaForge product state is updated.',
  FAILED: 'Transaction did not reach a ready product state.',
};

export function renderWalletStatus(status: WalletStatus): string {
  return walletMessages[status];
}

export function renderNetworkStatus(status: NetworkStatus): string {
  return networkMessages[status];
}

export function renderTransactionStatus(status: TransactionStatus): string {
  return transactionMessages[status];
}

export function transactionPresentationFromWalletSubmission(
  submission: WalletSubmission,
): TransactionPresentation {
  switch (submission.state) {
    case 'SUBMITTED':
      return { status: 'SUBMITTED', txHash: submission.txHash };
    case 'SUBMISSION_AMBIGUOUS':
      return {
        status: 'SUBMISSION_AMBIGUOUS',
        ...(submission.txHash ? { txHash: submission.txHash } : {}),
        errorCode: submission.reason,
        errorMessage: 'Submission outcome is unknown. Do not retry automatically; wait for reconciliation.',
      };
  }
}

const failedTransaction = (errorCode: string, txHash?: string): TransactionPresentation => ({
  status: 'FAILED',
  ...(txHash ? { txHash } : {}),
  errorCode,
});

export function transactionPresentationFromEvidence(
  evidence: ProductOperationEvidence,
  txHash?: string,
): TransactionPresentation {
  if (
    evidence.lifecycle === 'REJECTED' ||
    evidence.lifecycle === 'REVERTED' ||
    evidence.lifecycle === 'REPLACED' ||
    evidence.lifecycle === 'DROPPED' ||
    evidence.lifecycle === 'REORGED' ||
    evidence.lifecycle === 'RECONCILIATION_FAILED'
  )
    return failedTransaction(evidence.lifecycle, txHash);
  if (evidence.receipt === 'REVERTED') return failedTransaction('TRANSACTION_REVERTED', txHash);
  if (evidence.reconciliation === 'FAILED') return failedTransaction('RECONCILIATION_FAILED', txHash);
  if (evidence.projection === 'STALE') return failedTransaction('PROJECTION_STALE', txHash);

  if (evidence.productReady) return { status: 'READY', ...(txHash ? { txHash } : {}) };

  const status: TransactionStatus =
    evidence.lifecycle === 'AWAITING_SIGNATURE'
      ? 'WALLET_APPROVAL_REQUIRED'
      : evidence.lifecycle === 'SUBMITTED'
        ? 'SUBMITTED'
        : evidence.lifecycle === 'MINED' && evidence.receipt === 'SUCCESS'
          ? 'CHAIN_CONFIRMED'
          : evidence.lifecycle === 'CONFIRMED'
            ? 'INDEXING'
            : 'CONFIRMING';
  return { status, ...(txHash ? { txHash } : {}) };
}

function errorDetails(value: { readonly errorCode?: string; readonly errorMessage?: string }): string {
  if (!value.errorCode && !value.errorMessage) return '';
  return `<p role="alert"><strong>${escapeHtml(value.errorCode ?? 'UNSPECIFIED_ERROR')}</strong>${
    value.errorMessage ? ` · ${escapeHtml(value.errorMessage)}` : ''
  }</p>`;
}

function walletCard(wallet: WalletPresentation): string {
  const shortAddress =
    wallet.address && wallet.address.length > 12
      ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
      : wallet.address;
  return `<article class="sketch-box"><span class="section-label">WALLET</span><h3>${escapeHtml(
    wallet.status,
  )}</h3><p>${escapeHtml(renderWalletStatus(wallet.status))}</p>${
    wallet.address
      ? `<p><strong>Wallet address</strong> · ${escapeHtml(wallet.address)} · ${escapeHtml(shortAddress)}</p>`
      : '<p>Wallet address · Unavailable</p>'
  }${errorDetails(wallet)}</article>`;
}

function networkCard(network: NetworkPresentation): string {
  const observedChain = network.chainId === undefined ? 'Unavailable' : escapeHtml(network.chainId);
  return `<article class="sketch-box"><span class="section-label">NETWORK</span><h3>${escapeHtml(
    network.status,
  )}</h3><p>${escapeHtml(renderNetworkStatus(network.status))}</p><p><strong>Required</strong> · ${escapeHtml(
    'Robinhood Chain',
  )} · Chain ID ${escapeHtml(ROBINHOOD_CHAIN_TESTNET.chainId)}</p><p>Wallet chain ID · ${observedChain}</p>${errorDetails(
    network,
  )}</article>`;
}

function transactionCard(transaction: TransactionPresentation): string {
  const validHash = /^0x[0-9a-fA-F]{64}$/.test(transaction.txHash ?? '');
  const transactionEvidence = !transaction.txHash
    ? '<p>Transaction hash · Unavailable</p>'
    : validHash
      ? `<p><strong>Transaction hash</strong> · <a class="text-link" href="${escapeHtml(
          `${ROBINHOOD_CHAIN_TESTNET.explorerUrl}/tx/${transaction.txHash}`,
        )}" target="_blank" rel="noopener noreferrer">${escapeHtml(transaction.txHash)} ↗</a> · Chain ID ${escapeHtml(
          ROBINHOOD_CHAIN_TESTNET.chainId,
        )}</p>`
      : `<p><strong>Transaction hash</strong> · ${escapeHtml(transaction.txHash)}</p>`;
  return `<article class="sketch-box"><span class="section-label">TRANSACTION</span><h3>${escapeHtml(
    transaction.status,
  )}</h3><p>${escapeHtml(
    renderTransactionStatus(transaction.status),
  )}</p>${transactionEvidence}${errorDetails(transaction)}</article>`;
}

function disabledActions(): string {
  return `<div class="inline-actions" aria-label="Asset actions">${['Deposit', 'Withdraw', 'Approve']
    .map(
      (action) =>
        `<button class="outline-btn" disabled title="Requires reviewed Macbeth02 contract capability and Macbeth03 chain adapter">${action} · NOT IMPLEMENTED</button>`,
    )
    .join(
      '',
    )}<button class="outline-btn" data-pass-transfer disabled>Transfer Pass</button><button class="outline-btn" disabled>Buy Pass · OUT OF PHASE ONE</button><button class="outline-btn" disabled>Sell Pass · OUT OF PHASE ONE</button></div>`;
}

const readinessMessages: Record<OnchainReadiness, string> = {
  UNKNOWN: 'Chain readiness is unknown.',
  SOFT_READY: 'SOFT READY after three confirmations. L1 finality remains unknown.',
  FINALITY_UNKNOWN: 'L1 finality evidence is unavailable.',
  REORGED: 'Previously observed evidence was reorganized and is not ready.',
};

export function onchainActionEnabled(
  onchain: OnchainProductPresentation,
  action: OnchainProductAction,
): boolean {
  const rescue = action === 'rescue-token' || action === 'rescue-native';
  if (
    onchain.deployment !== 'CONFIGURED' ||
    onchain.health === 'UNAVAILABLE' ||
    onchain.owner !== 'OWNER' ||
    onchain.writeMode === 'DISABLED' ||
    !onchain.supportedActions.includes(action)
  )
    return false;
  if ((onchain.vaultClosed === true) !== rescue) return false;
  if (rescue) return onchain.exitPath === 'LIVE_RPC' || onchain.exitPath === 'SIMULATION';
  if (action === 'deposit') {
    const authorization = onchain.depositAuthorization;
    const validUnits = (value: string) => /^(0|[1-9][0-9]*)$/.test(value);
    if (
      !authorization ||
      !onchain.vaultAddress ||
      !/^0x[0-9a-fA-F]{40}$/.test(onchain.vaultAddress) ||
      authorization.spender.toLowerCase() !== onchain.vaultAddress.toLowerCase() ||
      !validUnits(authorization.afUsdcAllowanceBaseUnits) ||
      !validUnits(authorization.passAllowanceBaseUnits) ||
      (authorization.approvalCapability === 'UNAVAILABLE' &&
        (BigInt(authorization.afUsdcAllowanceBaseUnits) === 0n ||
          BigInt(authorization.passAllowanceBaseUnits) < 1_000_000_000_000n))
    )
      return false;
  }
  const exitEnabled =
    (action === 'withdraw' || action === 'close') &&
    (onchain.exitPath === 'LIVE_RPC' || onchain.exitPath === 'SIMULATION');
  if (onchain.readiness === 'UNKNOWN' || onchain.readiness === 'REORGED') return exitEnabled;
  if (onchain.health !== 'DEGRADED') return onchain.health === 'LIVE';
  return exitEnabled;
}

function onchainActions(onchain: OnchainProductPresentation): string {
  const labels: ReadonlyArray<readonly [OnchainProductAction, string]> = [
    ['deposit', 'Deposit'],
    ['withdraw', 'Withdraw'],
    ['close', 'Close'],
    ['rescue-token', 'Rescue untracked token'],
    ['rescue-native', 'Rescue native'],
  ];
  return `<div class="inline-actions" aria-label="Contract actions">${labels
    .map(([action, label]) => {
      const enabled = onchainActionEnabled(onchain, action);
      return `<button class="outline-btn" data-chain-action="${action}" ${enabled ? '' : 'disabled'}>${label}</button>`;
    })
    .join('')}</div>`;
}

function unsupportedOnchainActions(onchain: OnchainProductPresentation): string {
  const approval =
    onchain.depositAuthorization?.approvalCapability === 'AVAILABLE'
      ? 'Approve · USE DEPOSIT REVIEW'
      : 'Approve · NOT AVAILABLE';
  const passConfigured = /^0x[0-9a-fA-F]{40}$/.test(onchain.passAddress ?? '');
  const transferEnabled =
    passConfigured && onchain.passTransferMode !== undefined && onchain.passTransferMode !== 'DISABLED';
  const passBalance = /^(0|[1-9][0-9]*)$/.test(onchain.passBalanceBaseUnits ?? '')
    ? `${escapeHtml(formatUnits(onchain.passBalanceBaseUnits!, 18))} Pass · ${escapeHtml(onchain.passBalanceBaseUnits)} base unit${onchain.passBalanceBaseUnits === '1' ? '' : 's'}`
    : 'Unavailable';
  return `<p><strong>Pass contract</strong> · ${passConfigured ? escapeHtml(onchain.passAddress) : 'Unavailable'}</p><p><strong>Wallet Pass balance</strong> · ${passBalance}</p><div class="inline-actions" aria-label="Pass actions"><button class="outline-btn" data-pass-transfer ${transferEnabled ? '' : 'disabled'}>Transfer Pass</button><button class="outline-btn" disabled>Buy Pass · OUT OF PHASE ONE</button><button class="outline-btn" disabled>Sell Pass · OUT OF PHASE ONE</button><button class="outline-btn" disabled>${approval}</button></div>`;
}

function vaultSelector(selection: M3VaultSelectionState | undefined): string {
  if (!selection || selection.options.length === 0) return '';
  const validAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value);
  if (
    selection.selected.chainId !== ROBINHOOD_CHAIN_TESTNET.chainId ||
    !validAddress(selection.selected.vaultAddress) ||
    selection.options.some(
      (option) => option.chainId !== ROBINHOOD_CHAIN_TESTNET.chainId || !validAddress(option.vaultAddress),
    ) ||
    !selection.options.some(
      (option) =>
        option.chainId === selection.selected.chainId &&
        option.vaultAddress.toLowerCase() === selection.selected.vaultAddress.toLowerCase(),
    )
  )
    return '';
  return `<label><strong>Reviewed deployment allowlist</strong><select data-chain-vault-select aria-label="Reviewed Vault">${selection.options
    .map((option) => {
      const selected =
        option.chainId === selection.selected.chainId &&
        option.vaultAddress.toLowerCase() === selection.selected.vaultAddress.toLowerCase();
      const value = `${option.chainId}:${option.vaultAddress}`;
      return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>Chain ${option.chainId} · ${escapeHtml(option.vaultAddress)}</option>`;
    })
    .join(
      '',
    )}</select></label><p>Choose only from complete reviewed deployment records. Backend status cross-checks identity and health; it does not discover or authorize Vaults.</p>`;
}

function onchainCard(onchain: OnchainProductPresentation, selection?: M3VaultSelectionState): string {
  const deploymentMessage =
    onchain.deployment === 'CONFIGURED'
      ? 'Verified deployment metadata is configured.'
      : 'NOT DEPLOYED — no verified Vault address or deployment manifest is configured.';
  const healthMessage = onchain.vaultClosed
    ? `${onchain.health === 'DEGRADED' ? 'INDEXER DEGRADED. ' : ''}VAULT CLOSED. Deposit, withdraw and close are unavailable.${
        onchain.owner === 'OWNER' && (onchain.exitPath === 'LIVE_RPC' || onchain.exitPath === 'SIMULATION')
          ? ' Owner-only post-close rescue remains available.'
          : ''
      }`
    : onchain.health === 'DEGRADED'
      ? onchain.owner === 'NON_OWNER'
        ? 'INDEXER DEGRADED. Current wallet is not the Vault owner; owner exits are unavailable.'
        : onchain.owner === 'OWNER'
          ? `INDEXER DEGRADED. Owner exit remains available through ${
              onchain.exitPath === 'SIMULATION'
                ? 'live RPC simulation'
                : onchain.exitPath === 'LIVE_RPC'
                  ? 'live RPC'
                  : 'no verified exit path'
            }.`
          : 'INDEXER DEGRADED. Vault ownership is unknown; owner exits remain unavailable.'
      : onchain.health === 'LIVE'
        ? onchain.writeMode === 'INJECTED_MOCK'
          ? 'Local provider reads are active.'
          : 'Canonical Vault projection reads are active.'
        : 'Chain health is unavailable.';
  const writeMessage =
    onchain.writeMode === 'INJECTED_MOCK'
      ? 'Local provider records do not authorize asset transfers.'
      : onchain.writeMode === 'LIVE_AUTHORIZED'
        ? 'Live wallet actions require an explicit review and confirmation.'
        : 'Chain writes are disabled.';
  const authorization = onchain.depositAuthorization;
  const initialAllocation =
    /^(0|[1-9][0-9]*)$/.test(onchain.passInitialSupplyBaseUnits ?? '') &&
    /^0x[0-9a-fA-F]{40}$/.test(onchain.passInitialRecipient ?? '')
      ? `${escapeHtml(formatUnits(onchain.passInitialSupplyBaseUnits!, 18))} Pass to ${escapeHtml(onchain.passInitialRecipient)}`
      : 'Unavailable until reviewed deployment constructor values are configured.';
  const depositAuthorization = authorization
    ? `<div class="receipt"><div class="receipt-lines"><div><span>AF-USDC allowance</span><span>${escapeHtml(
        authorization.afUsdcAllowanceBaseUnits,
      )} base units</span></div><div><span>Pass allowance</span><span>${escapeHtml(
        authorization.passAllowanceBaseUnits,
      )} base units</span></div><div><span>spender</span><span>${escapeHtml(
        authorization.spender,
      )}</span></div></div></div><p>Deposit requires two exact finite approvals to the configured Vault. ${
        authorization.approvalCapability === 'AVAILABLE'
          ? 'The approval flow is available from Deposit review.'
          : 'Approval flow is not implemented.'
      } Infinite approval and arbitrary spenders are never used.</p>`
    : '<p>Deposit allowances are unavailable. Deposit remains disabled until both AF-USDC and Pass allowances are read for the configured Vault.</p>';
  return `<article class="sketch-box"><span class="section-label">PASS + VAULT</span><h3>${escapeHtml(
    onchain.readiness.replaceAll('_', ' '),
  )}</h3><p><strong>Deployment</strong> · ${escapeHtml(deploymentMessage)}</p>${vaultSelector(selection)}<p><strong>Selected Vault</strong> · ${escapeHtml(onchain.vaultAddress ?? 'Unavailable')}</p><p><strong>Initial Pass allocation</strong> · ${initialAllocation}</p><p>${escapeHtml(
    readinessMessages[onchain.readiness],
  )}</p><p>${escapeHtml(
    healthMessage,
  )}</p><p>${escapeHtml(writeMessage)}</p>${depositAuthorization}${onchainActions(
    onchain,
  )}${unsupportedOnchainActions(onchain)}</article>`;
}

const unavailableWallet: WalletPresentation = { status: 'DISCONNECTED' };
const unavailableNetwork: NetworkPresentation = { status: 'UNAVAILABLE' };
const idleTransaction: TransactionPresentation = { status: 'IDLE' };

function chainCards(
  wallet: WalletPresentation,
  network: NetworkPresentation,
  transaction: TransactionPresentation,
  assetBoundary: string,
  onchain?: OnchainProductPresentation,
  vaultSelection?: M3VaultSelectionState,
): string {
  return `<div class="strategy-grid">${walletCard(wallet)}${networkCard(network)}${transactionCard(
    transaction,
  )}</div>${
    onchain
      ? `${onchainCard(onchain, vaultSelection)}<div class="inline-actions" aria-label="Wallet controls"><button class="outline-btn" data-chain-connect>Connect wallet</button><button class="text-link" data-chain-refresh>Refresh chain state</button></div>`
      : `<article class="sketch-box"><span class="section-label">PASS + VAULT / NOT IMPLEMENTED</span><p>${escapeHtml(
          assetBoundary,
        )}</p>${disabledActions()}</article>`
  }<p class="dialog-notice">Strategy Runtime, venue execution, positions, fills and strategy-generated P&amp;L are NOT IMPLEMENTED / FUTURE PHASE.</p>`;
}

export function renderM3StrategyShell(input: StrategyShellInput): string {
  const wallet = input.wallet ?? unavailableWallet;
  const network = input.network ?? unavailableNetwork;
  const transaction = input.transaction ?? idleTransaction;
  const canonical = input.strategyId === M3_CANONICAL_STRATEGY_ID;
  const historicalLocal = input.contentProvenance === 'LOCAL SIMULATION';
  const identityLabel = canonical
    ? 'CANONICAL STRATEGY ID'
    : historicalLocal
      ? 'HISTORICAL LOCAL IDENTITY'
      : 'STRATEGY REFERENCE ID';
  const identityMessage = canonical
    ? `${M3_CANONICAL_STRATEGY_ID} is the first M3 logical product strategy. Contract addresses and deployments attach through future reviewed metadata.`
    : historicalLocal
      ? `${input.strategyId} remains isolated from ${M3_CANONICAL_STRATEGY_ID}. Local records do not establish chain balances or ownership.`
      : `${input.strategyId} is a strategy reference without an assigned canonical deployment mapping.`;
  const assetBoundary = canonical
    ? 'Chain ownership, balances, deployment evidence and supported writes are unavailable on this baseline.'
    : historicalLocal
      ? 'Local records do not establish chain balances or ownership. No chain deployment mapping is assigned.'
      : 'No Pass or Vault deployment is assigned to this strategy.';
  return `<section class="wrap section" aria-label="M3 product chain status"><span class="section-label">STRATEGY CONTENT / ${escapeHtml(
    input.contentProvenance === 'LOCAL SIMULATION' ? 'LOCAL RECORDS' : 'STRATEGY REFERENCE',
  )}</span><h2>Strategy · ${escapeHtml(
    input.strategyId,
  )}</h2><p><strong>${identityLabel}</strong> · ${escapeHtml(identityMessage)}</p>${chainCards(
    wallet,
    network,
    transaction,
    assetBoundary,
    input.onchain,
    input.vaultSelection,
  )}</section>`;
}

export function renderM3AccountShell(input: AccountShellInput): string {
  const wallet = input.wallet ?? unavailableWallet;
  const network = input.network ?? unavailableNetwork;
  const transaction = input.transaction ?? idleTransaction;
  return `<section class="wrap section" aria-label="M3 account chain status"><span class="section-label">ACCOUNT / LOCAL RECORDS</span><h2>AlphaForge account · ${escapeHtml(
    input.accountId ?? 'No local session',
  )}</h2><p>Account and wallet are separate identities. Local account sessions do not authorize chain assets.</p>${chainCards(
    wallet,
    network,
    transaction,
    'Chain ownership, balances, deployment evidence and supported writes are unavailable on this baseline.',
    input.onchain,
    input.vaultSelection,
  )}</section>`;
}

function walletAmount(raw: string | undefined): string {
  if (raw === undefined || !/^(0|[1-9][0-9]{0,77})$/.test(raw) || BigInt(raw) >= 2n ** 256n) return '—';
  const [whole, fraction] = formatUnits(raw, 18).split('.');
  const trimmed = fraction?.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole!;
}

/** The account landing page shows wallet assets, never the independent local ledgers. */
export function renderWalletAccount(input: AccountShellInput): string {
  const wallet = input.wallet ?? unavailableWallet;
  const network = input.network ?? unavailableNetwork;
  const address = wallet.address && /^0x[0-9a-fA-F]{40}$/.test(wallet.address) ? wallet.address : undefined;
  const connected = wallet.status === 'CONNECTED' && !!address;
  const readable =
    connected && network.status === 'CORRECT' && network.chainId === ROBINHOOD_CHAIN_TESTNET.chainId;
  const eth = readable ? walletAmount(wallet.ethBalanceWei) : '—';
  const pass =
    readable && input.onchain?.deployment === 'CONFIGURED'
      ? walletAmount(input.onchain.passBalanceBaseUnits)
      : '—';
  const connecting = wallet.status === 'CONNECTING';
  const label = connecting
    ? 'Connecting…'
    : address && ['CONNECTED', 'ACCOUNT_CHANGED'].includes(wallet.status)
      ? `${address.slice(0, 6)}…${address.slice(-4)}`
      : 'Connect Wallet';
  let notice = '';
  if (network.status === 'WRONG')
    notice = 'Switch to the configured Robinhood Chain network to view your assets.';
  else if (wallet.status === 'CONNECTION_REJECTED')
    notice = 'Connection cancelled. Try again when you’re ready.';
  else if (wallet.status === 'ACCOUNT_CHANGED')
    notice = 'Wallet changed. Reconnect to refresh your holdings.';
  else if (wallet.errorCode === 'WALLET_PROVIDER_UNAVAILABLE')
    notice = 'Open this page in a wallet-enabled browser.';
  else if (wallet.errorCode) notice = 'Wallet unavailable. Please reconnect.';
  const mock = input.onchain?.writeMode === 'INJECTED_MOCK';
  return `<section class="wrap wallet-account" data-wallet-account aria-label="Wallet account">
    <header class="wallet-account-header"><div><span class="section-label">MY WORKSHOP</span><h1>My Account</h1></div>
      <button class="primary-btn wallet-connect" data-chain-connect ${connecting ? 'disabled' : ''}${address ? ` title="${escapeHtml(address)}"` : ''}><span class="wallet-status-dot${connected ? ' connected' : ''}" aria-hidden="true"></span>${label}</button>
    </header>
    <div class="wallet-network"><span>${mock ? 'Local wallet' : 'Robinhood Chain'}</span>${connected ? '<span class="wallet-connected">Connected</span>' : ''}</div>
    ${notice ? `<p class="wallet-notice" role="status">${notice}</p>` : ''}
    <article class="sketch-box wallet-eth"><span class="section-label">ETH balance</span><div class="wallet-amount"><strong>${eth}</strong><span>ETH</span></div><p class="small muted">${connected ? (eth === '—' ? 'Balance unavailable' : 'Available in your wallet') : 'Connect your wallet to view your balance'}</p></article>
    <section class="wallet-passes" aria-label="Pass holdings"><header><h2>Pass holdings</h2><span class="small muted">Strategy access</span></header>
      ${pass === '—' ? `<div class="wallet-empty sketch-box"><span class="wallet-pass-icon" aria-hidden="true">α</span><h3>${connected ? 'Pass balance unavailable' : 'Your Passes, in one place'}</h3><p>${connected ? 'No verified Pass balance to display yet.' : 'Connect your wallet to see the Passes you hold.'}</p></div>` : `<article class="wallet-pass-row sketch-box"><span class="wallet-pass-icon" aria-hidden="true">α</span><div><h3>Strategy Pass</h3><span class="small muted" title="${escapeHtml(input.onchain?.passAddress ?? '')}">${escapeHtml(input.onchain?.passAddress ? `${input.onchain.passAddress.slice(0, 6)}…${input.onchain.passAddress.slice(-4)}` : 'Robinhood Chain')}</span></div><div class="wallet-pass-quantity"><strong>${pass}</strong> <span>Pass</span></div></article>`}
    </section>
  </section>`;
}

function renderMockWalletAccount(mock: MockWalletSnapshot): string {
  const totalPass = mock.holdings
    ?.reduce((total, holding) => total + BigInt(holding.quantity), 0n)
    .toLocaleString('en-US');
  const holdings = mock.holdings
    ?.map(
      (holding) =>
        `<details class="wallet-holding" name="wallet-holdings" data-wallet-position="${escapeHtml(holding.id)}"><summary class="wallet-pass-row sketch-box"><span class="wallet-pass-icon" aria-hidden="true">α</span><div class="wallet-pass-strategy"><span class="section-label">STRATEGY</span><h3>${escapeHtml(holding.name)}</h3><span class="small muted">Use Pass · Configure strategy funds</span></div><div class="wallet-pass-quantity"><strong>${escapeHtml(holding.quantity)}</strong> <span>Pass</span><small>Frozen (in use) ${escapeHtml(holding.frozenPass ?? '—')} · Available ${escapeHtml(holding.availablePass ?? '—')}</small><small>Allocated ${escapeHtml(holding.allocatedUsdc ?? '—')} USDC</small></div></summary><div class="wallet-holding-actions"><a class="text-link" href="#/trade/${encodeURIComponent(holding.id)}">View strategy ↗</a><span class="small muted">1 Pass = 1 USDC allocation capacity</span></div><div data-wallet-funding-slot></div></details>`,
    )
    .join('');
  return `<section class="wrap wallet-account" data-wallet-account aria-label="Wallet account">
    <header class="wallet-account-header"><div><span class="section-label">YOUR PORTFOLIO</span><h1>My Account</h1><p class="wallet-account-intro">A few strategies. Your own place to try them.</p></div><button class="primary-btn wallet-connect" data-chain-connect title="${escapeHtml(mock.address)}"><span class="wallet-status-dot connected" aria-hidden="true"></span>${escapeHtml(mock.address.slice(0, 6))}…${escapeHtml(mock.address.slice(-4))}</button></header>
    <div class="wallet-network"><span>Local wallet · Local balances</span><span class="wallet-connected">Connected</span></div>
    <div class="wallet-balance-grid"><article class="sketch-box wallet-eth"><span class="section-label">ETH balance</span><div class="wallet-amount"><strong>${escapeHtml(mock.ethBalance ?? '—')}</strong><span>ETH</span></div><p class="small muted">≈ ${escapeHtml(mock.ethValueUsdc ?? '—')} USDC<br>1 ETH = ${MOCK_ETH_USDC_RATE} USDC · Reference rate</p></article><article class="sketch-box wallet-usdc"><span class="section-label">USDC · Available funds</span><div class="wallet-amount"><strong>${escapeHtml(mock.usdcBalance ?? '—')}</strong><span>USDC</span></div><p class="small muted">Available to configure your strategies.</p></article></div>
    <section class="wallet-passes" aria-label="Pass holdings"><header><div><span class="section-label">YOUR STRATEGY COLLECTION</span><h2>Pass holdings</h2></div><div class="wallet-pass-overview"><strong>${escapeHtml(totalPass ?? '—')} <span>PASS</span></strong><span class="small muted">${mock.holdings ? `${mock.holdings.length} ${mock.holdings.length === 1 ? 'strategy' : 'strategies'}` : 'Holdings unavailable'}</span></div></header><p class="wallet-pass-help">Each Pass belongs to a strategy. Open a holding to allocate funds; Passes in use are released when you withdraw.</p>${holdings || `<div class="wallet-empty sketch-box"><span class="wallet-pass-icon" aria-hidden="true">α</span><h3>${mock.holdings ? 'No Passes yet' : 'Pass balance unavailable'}</h3><p>${mock.holdings ? 'Explore the Strategy Market to build your collection.' : 'Local trading records could not be read.'}</p>${mock.holdings ? '<a class="text-link" href="#/market">Explore strategies ↗</a>' : ''}</div>`}</section>
  </section>`;
}

function renderMockWalletInvitation(wallet?: WalletPresentation): string {
  const notice =
    wallet?.status === 'CONNECTION_REJECTED'
      ? 'Browser wallet connection cancelled. You can still view local wallet records.'
      : wallet?.errorCode
        ? 'Browser wallet unavailable. You can view local wallet records below.'
        : '';
  return `<section class="wrap wallet-account" data-wallet-account aria-label="Wallet account"><header class="wallet-account-header"><div><span class="section-label">YOUR PORTFOLIO</span><h1>My Account</h1><p class="wallet-account-intro">Collect strategy Passes. Try an idea.</p></div><button class="primary-btn wallet-connect" data-wallet-choice="mock"><span class="wallet-status-dot" aria-hidden="true"></span>Open local wallet</button></header><div class="wallet-network"><span>Local wallet · Local balances</span><span>Not connected</span></div>${notice ? `<p class="wallet-notice" role="status">${notice}</p>` : ''}<section class="wallet-passes" aria-label="Pass holdings"><header><div><span class="section-label">YOUR STRATEGY COLLECTION</span><h2>Pass holdings</h2></div><span class="small muted">Strategy access</span></header><div class="wallet-empty wallet-invitation sketch-box"><span class="wallet-pass-icon" aria-hidden="true">α</span><h3>Your first strategies are ready.</h3><p>Open the local wallet to see your strategy Pass records here.</p><span class="wallet-starter-strategies">Ridgeline · Prism · Echo</span><p class="small muted">Local balances · No wallet extension needed</p></div></section><p class="wallet-browser-option">Using a browser wallet? <button class="text-link" data-chain-connect>Choose Browser Wallet ↗</button></p></section>`;
}

export function extendM3ProductPages(pages: M3ProductPages, options: M3PageExtensionOptions): M3ProductPages {
  return {
    account: (tab) => {
      if (tab !== 'trades') return pages.account(tab);
      const navigation = `<nav class="wrap account-tabs" aria-label="Account sections"><a href="#/account/trades" aria-current="page">Pass Holdings</a><a href="#/account/passes">Trial Passes</a><a href="#/account/saved">Saved strategies</a><a href="#/account/notes">My notes</a><a href="#/account/funds">Funds</a><a href="#/account/settings">Settings</a></nav>`;
      const mock = options.mockWallet?.();
      if (mock) return navigation + renderMockWalletAccount(mock);
      const chain = options.chain?.();
      const onchain = chain?.onchain ?? options.onchain?.();
      if (
        options.mockWallet &&
        (!chain || !['CONNECTED', 'CONNECTING', 'ACCOUNT_CHANGED'].includes(chain.wallet.status))
      )
        return navigation + renderMockWalletInvitation(chain?.wallet);
      return (
        navigation +
        renderWalletAccount({
          ...(chain ? { wallet: chain.wallet, network: chain.network, transaction: chain.transaction } : {}),
          ...(onchain ? { onchain } : {}),
        })
      );
    },
    trade: (strategyId) => pages.trade(strategyId),
  };
}
