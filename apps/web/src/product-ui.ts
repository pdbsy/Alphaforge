import { productSessionPresentation } from './product-session.ts';
import { installProductNavigation } from './product-navigation.ts';
import { installLiveRendering } from './product-live-render.ts';
import { installPassPriceChart } from './pass-price-chart.ts';
import { installCandleInspection, type CandleChartHost } from './kline-hover.ts';
import './kline-hover.css';
import './wallet-account.css';
import { installCommunity } from './community/install.ts';
import './community/styles.css';
import './launch-market/styles.css';
import { installLaunchMarket } from './launch-market/install.ts';
import { installNativeMint } from './launch-market/native-mint.ts';
import './launch-market/native-mint.css';
import type { LaunchClientState } from './launch-market/model.ts';
import { installStockHistory, type StockHistoryHost } from './stock-history.ts';
import { installStockInspection } from './stock-inspection.ts';
import './stock-inspection.css';
import { installReferenceInspection } from './reference-inspection.ts';
import './reference-inspection.css';
import { ProductAdapter, type ProductVault, type StrategySummary } from './product-adapter.ts';
import type { CommandFields, CommandReview, CommandType } from './product-client.ts';
import { createM3BrowserRuntime, type M3BrowserDeploymentConfig } from './m3-browser-runtime.ts';
import { createM3BrowserRuntimeSet } from './m3-browser-runtime-set.ts';
import type { Eip1193Provider } from './chain-wallet.ts';
import { renderM3DepositApprovalDialog, runM3DialogAction } from './m3-product-dialog.ts';
import { extendM3ProductPages, onchainActionEnabled } from './m3-product-shell.ts';
import type { OnchainProductAction } from './m3-product-shell.ts';
import {
  depositAllowanceCheck,
  parseM3RescueAction,
  parseM3PassTransfer,
  parseM3ProductAction,
  sameM3ProductAction,
  type M3ProductActionRequest,
  type M3ProductActionReview,
  type M3DepositApprovalKind,
  type M3DepositApprovalReview,
  type M3ProductRuntime,
  type M3PassTransferRequest,
  type M3PassTransferReview,
} from './m3-product-runtime.ts';
import { formatUnits, parseUnits } from '../../../packages/domain/src/money.ts';
interface Prototype extends CandleChartHost, StockHistoryHost {
  originalMarketLayout?: boolean;
  launchState?: LaunchClientState;
  view: CandleChartHost['view'] & { priceStyle: string };
  charts: CandleChartHost['charts'] & {
    priceBlock(strategy: { id: string }): string;
    pos: { price: number; returns: number };
  };
  market?: { refresh(): void };
  strategies: { id: string; name: string }[];
  pages: { market: () => string; account: (tab: string) => string; trade: (id: string) => string };
  app: {
    render: (options?: { preserve?: boolean }) => void;
    openDialog: (html: string) => void;
    closeDialog: () => void;
  };
  m3OnchainRuntime?: M3ProductRuntime;
  m3Deployment?: M3BrowserDeploymentConfig;
  m3Deployments?: readonly M3BrowserDeploymentConfig[];
}
declare global {
  interface Window {
    AF: Prototype;
    ethereum?: Eip1193Provider;
  }
}
const AF = window.AF;
installLiveRendering(AF);
if (AF.originalMarketLayout) installPassPriceChart(AF);
// Server configuration selects the canonical chain market. The imported workshop keeps its layout and router.
installCandleInspection(
  AF,
  document,
  AF.originalMarketLayout
    ? {
        quoteUnit: 'AF-USDC',
        volumeUnit: 'AF-USDC',
        english: true,
        sourceLabel: 'Indexed chain swaps',
      }
    : {},
);
installProductNavigation();
let onchainRuntime = AF.m3OnchainRuntime;
if (!onchainRuntime && import.meta.env.DEV && new URLSearchParams(location.search).get('m3Fixture') === '1') {
  const fixtureModule = await import('./m3-injected-runtime-fixture.ts');
  const fixture = fixtureModule.createM3InjectedRuntimeFixture();
  onchainRuntime = fixture.runtime;
  fixtureModule.installM3InjectedRuntimeControls(fixture);
}
onchainRuntime ??=
  AF.m3Deployments !== undefined
    ? createM3BrowserRuntimeSet({
        ...(window.ethereum ? { provider: window.ethereum } : {}),
        deployments: AF.m3Deployments,
      })
    : createM3BrowserRuntime({
        ...(window.ethereum ? { provider: window.ethereum } : {}),
        ...(AF.m3Deployment ? { deployment: AF.m3Deployment } : {}),
      });
const adapter = new ProductAdapter();
const client = adapter.client;
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const units = (value: unknown) =>
  typeof value === 'string'
    ? value.startsWith('-')
      ? '-' + formatUnits(value.slice(1), 6)
      : formatUnits(value, 6)
    : 'Unavailable';
// Only the imported, mechanically marked declarations are hydrated. No CSS text, URLs or arbitrary properties.
const styleProperties = new Set([
  'position',
  'width',
  'height',
  'overflow',
  '--cover',
  '--s-ink',
  'background',
  'color',
  'display',
  'margin-top',
]);
function hydrate(root: ParentNode): void {
  const nodes = [
    ...(root instanceof Element && root.hasAttribute('data-user-style') ? [root] : []),
    ...root.querySelectorAll('[data-user-style]'),
  ];
  for (const node of nodes) {
    if (!(node instanceof HTMLElement || node instanceof SVGElement)) continue;
    const value = node.getAttribute('data-user-style') ?? '';
    for (const declaration of value.split(';')) {
      const colon = declaration.indexOf(':');
      const property = declaration.slice(0, colon).trim(),
        val = declaration.slice(colon + 1).trim();
      if (
        colon > 0 &&
        styleProperties.has(property) &&
        /^[#\w\s.%,()-]+$/.test(val) &&
        !/(url|expression|var)\s*\(/i.test(val)
      )
        node.style.setProperty(property, val);
    }
  }
}
hydrate(document);
const footerNote = document.querySelector('.footer-bottom > span');
if (footerNote)
  footerNote.textContent = AF.originalMarketLayout
    ? 'Strategy market · Wallet settlement'
    : 'Strategy access · Local records';
new MutationObserver((records) => {
  for (const record of records)
    for (const node of record.addedNodes) if (node instanceof Element) hydrate(node);
}).observe(document.body, { childList: true, subtree: true });
let localError: string | null = null;
let query = '',
  statusFilter = 'all',
  environment = 'all';
function currentId(): string {
  try {
    return decodeURIComponent(location.hash.split('/')[2] ?? '');
  } catch {
    return '';
  }
}
function selected(): ProductVault | undefined {
  const s = adapter.snapshot;
  return s.vaults.find((v) => v.vaultId === s.selectedVaultId && v.ownerId === s.user);
}
function canWrite(): boolean {
  const s = adapter.snapshot;
  return s.phase === 'READY' && !s.pending && !adapter.retryAfterSeconds;
}
function button(type: CommandType, label: string): string {
  return `<button class="outline-btn" data-product-command="${type}" ${canWrite() ? '' : 'disabled'}>${label}</button>`;
}
function strategyLink(s: StrategySummary): string {
  return `<a class="text-link" data-product-strategy="${esc(s.strategyId)}" href="#/trade/${encodeURIComponent(s.strategyId)}">${esc(s.strategyId)} ↗</a>`;
}
function catalogueRows(): string {
  const s = adapter.snapshot;
  const rows = s.strategies.filter(
    (item) =>
      `${item.strategyId} ${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()) &&
      (environment === 'all' || item.scope === environment) &&
      (statusFilter === 'all' ||
        (s.account?.strategies.find((a) => a.strategyId === item.strategyId)?.status ??
          s.vaults.find((v) => v.strategyId === item.strategyId)?.status ??
          'not_started') === statusFilter),
  );
  return rows.length
    ? rows
        .map(
          (item) =>
            `<article class="sketch-box"><span class="section-label">${esc(item.scope)} / API CATALOGUE</span><h3>${esc(item.name)}</h3><p>${esc(item.description)}</p>${strategyLink(item)}<p class="small muted">Strategy access: ${esc(item.testPasses)} Pass. Passes are not deposited funds.</p></article>`,
        )
        .join('')
    : '<p>No API strategies match. Select a local identity or adjust filters.</p>';
}
function catalogue(): string {
  return `<section class="wrap section" aria-label="API strategies"><span class="section-label">STRATEGY WORKSPACES</span><h2>Run the local funding journey.</h2><p>These server catalogue entries have independent vaults. Workshop records are managed separately.</p><div class="ranking-filters"><label>Search API catalogue<input data-product-search type="search" value="${esc(query)}" placeholder="Strategy ID or name"></label><label>Status<select data-product-status-filter>${['all', 'not_started', 'stopped', 'running', 'stopping'].map((v) => `<option ${statusFilter === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label>Environment<select data-product-environment-filter><option value="all">All environments</option><option ${environment === 'TEST_ONLY' ? 'selected' : ''}>TEST_ONLY</option></select></label></div><div class="strategy-grid" data-product-catalogue>${catalogueRows()}</div></section>`;
}
function balances(v: ProductVault): string {
  const labels = [
    ['idle', 'Idle'],
    ['activeNet', 'Allocated pool · net'],
    ['reserved', 'Reserved orders'],
    ['pending', 'Pending withdrawal'],
    ['withdrawalsPaid', 'Withdrawals paid'],
    ['equity', 'Equity'],
    ['deposits', 'Total deposits'],
    ['realizedPnl', 'Realized simulation P&L'],
    ['feeLiability', 'Fee liability'],
    ['feesAccrued', 'Fees accrued'],
    ['feesPaid', 'Fees paid'],
  ];
  return `<div class="receipt"><div class="receipt-lines">${labels.map(([key, label]) => `<div><span>${label}</span><span>${esc(units(v.balances[key!]))} USDT</span></div>`).join('')}<div><span>Simulated strategy access</span><span>${esc(v.passBalance.total)} PASS</span></div><div><span>Access allowance (not cash)</span><span>${esc(units(v.passBalance.allowance))} USDT capacity</span></div></div></div>`;
}
function account(): string {
  const s = adapter.snapshot;
  const session = productSessionPresentation(s, adapter.mode);
  if (!session.usable)
    return `<section class="wrap section" aria-label="API account unavailable"><h2>Backend account unavailable</h2><p>${esc(session.hint)}</p><p>Browser workshop records are stored separately on this device.</p></section>`;
  const totalPass = s.vaults.reduce((sum, v) => sum + BigInt(v.passBalance.total), 0n).toString();
  const availableUsdt = s.vaults.reduce((sum, v) => sum + BigInt(String(v.balances.idle)), 0n).toString();
  return `<section class="wrap section"><span class="section-label">API ACCOUNT / ${esc(s.user ?? 'NO SESSION')}</span><h2>Strategy Vaults and access.</h2><div class="receipt"><div class="receipt-lines"><div><span>Simulated PASS</span><strong>${esc(totalPass)} PASS</strong></div><div><span>Available simulated USDT</span><strong>${esc(units(availableUsdt))} USDT</strong></div></div></div><p>${adapter.mode === 'legacy' ? 'Legacy API capability: unavailable financial fields are shown explicitly.' : 'Canonical account and strategy relationships from the local backend.'}</p>${
    s.account
      ? `<p>Account owner: ${esc(s.account.ownerId)} · ${s.account.strategies.length} registered strategy relationships.</p><div class="receipt-lines">${s.account.strategies
          .map((a) => {
            const pass = s.account!.passBalances.find((p) => p.strategyId === a.strategyId);
            return `<div><span>${esc(a.strategyId)} · ${esc(a.status)}</span><span>${esc(pass?.total ?? 'Unavailable')} PASS</span></div>`;
          })
          .join('')}</div>`
      : ''
  }${s.vaults.length ? s.vaults.map((v) => `<article class="sketch-box"><h3>${esc(v.strategyId)}</h3><p>Owner ${esc(v.ownerId)} · ${esc(v.status)} · revision ${v.revision}</p><p class="small">Vault ${esc(v.vaultId)}</p>${balances(v)}<a class="text-link" data-product-strategy="${esc(v.strategyId)}" href="#/trade/${encodeURIComponent(v.strategyId)}">Open ${esc(v.strategyId)} workspace ↗</a></article>`).join('') : '<p>EMPTY — No backend vaults for this identity. Claim strategy access from the catalogue.</p>'}<p class="dialog-notice">Browser records are independent from these account balances.</p></section>`;
}
function workspace(id: string): string {
  const session = productSessionPresentation(adapter.snapshot, adapter.mode);
  if (!session.usable)
    return `<div class="wrap inner-page"><h1>API strategy workspace</h1><p>${esc(session.hint)}</p></div>`;
  const s = adapter.snapshot,
    item = s.strategies.find((v) => v.strategyId === id),
    detail = s.details.find((v) => v.strategyId === id),
    vault = s.vaults.find((v) => v.strategyId === id && v.ownerId === s.user);
  if (!item)
    return `<div class="wrap inner-page"><h1>API strategy workspace.</h1><p>${esc(id)}</p><p>Select a local identity and refresh to read this server catalogue entry.</p></div>`;
  const v = vault?.vaultId === s.selectedVaultId ? vault : undefined;
  return `<div class="wrap terminal-page"><header class="terminal-heading"><div><span class="section-label">STRATEGY / LOCAL RECORDS</span><h1>${esc(item.name)}</h1><p>${esc(item.strategyId)} · ${esc(item.description)}</p></div></header><p>Strategy access and local records. No market prices, yield or strategy performance are supplied by this API.</p>${detail ? `<p>Execution: ${esc(detail.capabilities?.execution ?? 'Unavailable')} · association ${esc(detail.accountStrategy?.status ?? 'Unavailable')}</p>` : ''}${!vault ? `<button class="primary-btn" data-product-claim="${esc(id)}" ${s.user && ['READY', 'EMPTY'].includes(s.phase) && !s.pending ? '' : 'disabled'}>Claim ${esc(item.testPasses)} Pass ↗</button>` : !v ? '<p>LOADING selected vault…</p>' : `<section class="sketch-box"><h2>Workspace · ${esc(v.ownerId)}</h2><p>${esc(v.vaultId)} · <strong>${esc(v.status)}</strong> · revision ${v.revision}</p>${v.status === 'stopping' ? '<p class="dialog-notice">Stopping — waiting for open orders or positions to settle. Stop is not complete.</p>' : ''}${balances(v)}<div class="inline-actions">${button('deposit', 'Add funds')}${button('allocate', 'Allocate')}${button('deallocate', 'Deallocate')}${button('start', 'Start simulation')}${button('stop', 'Stop')}</div><h3>Simulation controls</h3><div class="inline-actions">${button('reserveBuy', 'Reserve buy')}${button('fillBuy', 'Fill buy')}${button('cancelOrder', 'Cancel order')}${button('markPosition', 'Mark position')}${button('settlePosition', 'Settle position')}</div><h3>Withdrawal queue</h3><div class="inline-actions">${button('requestWithdrawal', 'Request withdrawal')}${button('confirmWithdrawal', 'Confirm withdrawal')}${button('cancelWithdrawal', 'Cancel withdrawal')}</div>${v.pendingOperations.length ? `<div class="receipt-lines">${v.pendingOperations.map((op) => `<div><span>${esc(op.kind)} · ${esc(op.operationId)} · ${esc(op.status)}</span><span>${esc(units(op.amount))}</span></div>`).join('')}</div>` : '<p>No pending orders or withdrawals.</p>'}<h3>API audit receipts</h3>${s.audit.length ? `<div class="receipt-lines">${s.audit.map((e) => `<div><span>${e.revision} · ${esc(e.commandType)} · ${esc(e.actorId)}</span><span>${esc(e.commandId)}</span></div>`).join('')}</div>` : '<p>No command receipts yet.</p>'}</section>`}<p><a href="#/account/funds" class="text-link">View account funds ↗</a></p></div>`;
}
const original = { ...AF.pages };
if (!AF.originalMarketLayout) AF.pages.market = () => catalogue() + original.market();
const productPages = AF.originalMarketLayout
  ? { account: original.account, trade: original.trade }
  : extendM3ProductPages(
      {
        account: (tab) => account() + original.account(tab),
        trade: (id) => (AF.strategies.some((s) => s.id === id) ? original.trade(id) : workspace(id)),
      },
      {
        accountId: () => adapter.snapshot.user,
        contentProvenance: (id) =>
          AF.strategies.some((strategy) => strategy.id === id) ? 'FIXTURE' : 'LOCAL SIMULATION',
        ...(onchainRuntime ? { chain: () => onchainRuntime.snapshot } : {}),
      },
    );
AF.pages.account = productPages.account;
AF.pages.trade = productPages.trade;
if (AF.originalMarketLayout) {
  installNativeMint(AF, document);
  installStockHistory(AF);
  installStockInspection(AF);
  installReferenceInspection(AF);
  // Display the correct Mint/market view immediately, without waiting for any API response.
  AF.app.render({ preserve: true });
}
function render(): void {
  AF.app.render({ preserve: true });
}
async function run(action: () => Promise<void>): Promise<void> {
  localError = null;
  try {
    await action();
  } catch (error) {
    if (!client.snapshot.error) localError = error instanceof Error ? error.message : 'REQUEST_FAILED';
  }
  render();
}
async function alignVault(): Promise<void> {
  const id = currentId(),
    s = adapter.snapshot;
  if (!location.hash.startsWith('#/trade/')) return;
  const v = s.vaults.find((v) => v.strategyId === id && v.ownerId === s.user);
  if (v && v.vaultId !== s.selectedVaultId) await client.selectVault(v.vaultId);
}
interface Draft {
  type: CommandType;
  review: CommandReview;
  fields?: CommandFields<CommandType>;
}
let draft: Draft | null = null;
function openCommand(type: CommandType): void {
  const review = client.prepare();
  const v = selected();
  if (!v || v.strategyId !== currentId()) throw Error('SELECT_WORKSPACE_VAULT');
  draft = { type, review };
  let fields = '';
  const numeric = ['deposit', 'allocate', 'deallocate', 'reserveBuy', 'requestWithdrawal'].includes(type)
    ? 'amount'
    : type === 'markPosition'
      ? 'value'
      : type === 'settlePosition'
        ? 'proceeds'
        : null;
  if (numeric)
    fields += `<label>${numeric} · units<input name="${numeric}" inputmode="decimal" value="" autocomplete="off" autofocus></label>`;
  if (type === 'reserveBuy')
    fields += `<label>Order ID<input name="orderId" value="${crypto.randomUUID()}"></label>`;
  const kind = ['fillBuy', 'cancelOrder'].includes(type)
    ? 'order'
    : ['confirmWithdrawal', 'cancelWithdrawal'].includes(type)
      ? 'withdrawal'
      : null;
  if (kind) {
    const name = kind === 'order' ? 'orderId' : 'withdrawalId';
    fields += `<label>${kind} to act on<select name="${name}">${v.pendingOperations
      .filter((o) => o.kind === kind)
      .map(
        (o) =>
          `<option value="${esc(o.operationId)}">${esc(o.operationId)} · ${esc(units(o.amount))}</option>`,
      )
      .join('')}</select></label>`;
  }
  AF.app.openDialog(
    `<span class="section-label">API / LOCAL RECORDS</span><h2>Review ${esc(type)}.</h2><p>${esc(review.ownerId)} · ${esc(review.vaultId)} · revision ${review.expectedRevision}</p>${fields}<p data-product-dialog-error class="form-error" role="alert"></p><div class="inline-actions"><button class="primary-btn" data-product-review>Review next ↗</button><button class="text-link" data-close>Cancel</button></div>`,
  );
}
function reviewDraft(): void {
  if (!draft) throw Error('REVIEW_REQUIRED');
  const fields: Record<string, string> = {};
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('dialog[open] [name]').forEach((input) => {
    const val = input.value;
    if (['amount', 'value', 'proceeds'].includes(input.name)) {
      if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(val))
        throw Error('Enter a non-negative amount with at most six decimals.');
      const amount = parseUnits(val, 6);
      if (input.name === 'amount' && BigInt(amount) <= 0n) throw Error('Amount must be greater than zero.');
      fields[input.name] = amount;
    } else {
      if (!val) throw Error('Select an existing pending operation.');
      fields[input.name] = val;
    }
  });
  draft.fields = fields as CommandFields<CommandType>;
  AF.app.openDialog(
    `<span class="section-label">REVIEW / EXACT API REQUEST</span><h2>Confirm ${esc(draft.type)}.</h2><div class="receipt"><div class="receipt-lines"><div><span>Owner / vault</span><span>${esc(draft.review.ownerId)} / ${esc(draft.review.vaultId)}</span></div><div><span>Reviewed revision</span><span>${draft.review.expectedRevision}</span></div>${Object.entries(
      fields,
    )
      .map(
        ([k, v]) =>
          `<div><span>${esc(k)} ${['amount', 'value', 'proceeds'].includes(k) ? '(integer micro-units)' : ''}</span><span>${esc(v)}</span></div>`,
      )
      .join(
        '',
      )}</div></div><p>This updates only the TEST_ONLY local API ledger.</p><div class="inline-actions"><button class="primary-btn" data-product-confirm>Confirm reviewed request ✓</button><button class="text-link" data-close>Cancel</button></div>`,
  );
}
let claimId: string | null = null;
interface OnchainDraft {
  readonly action: OnchainProductAction;
  readonly request?: M3ProductActionRequest;
  readonly review?: M3ProductActionReview;
  readonly approval?: M3DepositApprovalReview;
}
let onchainDraft: OnchainDraft | null = null;
interface PassTransferDraft {
  readonly request?: M3PassTransferRequest;
  readonly review?: M3PassTransferReview;
}
let passTransferDraft: PassTransferDraft | null = null;
function openOnchainAction(action: OnchainProductAction): void {
  if (!onchainRuntime) throw Error('CHAIN_RUNTIME_UNAVAILABLE');
  if (!onchainActionEnabled(onchainRuntime.snapshot.onchain, action)) throw Error('CHAIN_ACTION_UNAVAILABLE');
  onchainDraft = { action };
  const amount =
    action === 'close'
      ? '<p>Close returns protocol-accounted assets and remaining locked Pass to the immutable Vault owner.</p>'
      : action === 'rescue-native'
        ? '<p>Rescue sends untracked native currency from the closed Vault to its immutable owner.</p>'
        : action === 'rescue-token'
          ? '<label>Untracked token address<input name="chainToken" autocomplete="off" autofocus></label>'
          : '<label>AF-USDC amount<input name="chainAmount" inputmode="decimal" autocomplete="off" autofocus></label>';
  AF.app.openDialog(
    `<span class="section-label">WALLET REVIEW</span><h2>Review ${esc(action)}.</h2>${amount}<p>Current wallet signature and contract authorization determine access. AlphaForge Account does not grant Vault ownership.</p><p data-product-dialog-error class="form-error" role="alert"></p><div class="inline-actions"><button class="primary-btn" data-chain-review>Read and simulate ↗</button><button class="text-link" data-close>Cancel</button></div>`,
  );
}
function showOnchainDialogError(message: string): void {
  const output = document.querySelector('[data-product-dialog-error]');
  if (output) output.textContent = message;
}
function currentDialog(control: HTMLElement): HTMLDialogElement | null {
  const dialog = control.closest('dialog');
  return control.isConnected && dialog?.open ? dialog : null;
}
function showConfirmDialogError(control: HTMLElement, message: string): void {
  const output = currentDialog(control)?.querySelector('[data-product-dialog-error]');
  if (output) output.textContent = message;
}
async function reviewOnchainAction(control: HTMLElement): Promise<void> {
  const draft = onchainDraft;
  if (!onchainRuntime || !draft) throw Error('CHAIN_REVIEW_REQUIRED');
  const stillCurrent = () =>
    onchainDraft === draft && control.isConnected && !!control.closest('dialog')?.open;
  const amountInput = document.querySelector<HTMLInputElement>('dialog[open] [name="chainAmount"]');
  const tokenInput = document.querySelector<HTMLInputElement>('dialog[open] [name="chainToken"]');
  const request =
    draft.action === 'rescue-token' || draft.action === 'rescue-native'
      ? parseM3RescueAction(draft.action, tokenInput?.value)
      : parseM3ProductAction(draft.action, amountInput?.value);
  if (request.kind === 'deposit') {
    if (onchainRuntime.reviewDepositApprovals) {
      let approval;
      try {
        approval = await onchainRuntime.reviewDepositApprovals(request);
      } catch (error) {
        if (!stillCurrent()) return;
        throw error;
      }
      if (!stillCurrent()) return;
      const required = approval.requirements.filter((requirement) => !requirement.sufficient);
      if (required.length > 0) {
        onchainDraft = { action: draft.action, request, approval };
        AF.app.openDialog(renderM3DepositApprovalDialog(approval));
        return;
      }
    } else {
      const onchain = onchainRuntime.snapshot.onchain;
      const authorization = onchain.depositAuthorization;
      if (!onchain.vaultAddress || !authorization) throw Error('DEPOSIT_ALLOWANCES_UNAVAILABLE');
      const check = depositAllowanceCheck(request, {
        vaultAddress: onchain.vaultAddress,
        ...authorization,
      });
      if (check.status === 'APPROVAL_REQUIRED')
        throw Error(
          `DEPOSIT_APPROVAL_REQUIRED_UNSUPPORTED: exact approvals to the Vault are required for ${check.required.afUsdcBaseUnits} AF-USDC base units and ${check.required.passBaseUnits} Pass base units. Infinite approval is not used.`,
        );
      if (check.status !== 'READY') throw Error('DEPOSIT_ALLOWANCES_UNAVAILABLE');
    }
  }
  let review;
  try {
    review = await onchainRuntime.reviewAction(request);
  } catch (error) {
    if (!stillCurrent()) return;
    throw error;
  }
  if (!stillCurrent()) return;
  if (!sameM3ProductAction(request, review.request)) throw Error('CHAIN_ACTION_REVIEW_MISMATCH');
  onchainDraft = { action: draft.action, request, review };
  const amount =
    request.kind === 'deposit' || request.kind === 'withdraw'
      ? `${request.usdcBaseUnits} AF-USDC base units`
      : request.kind === 'rescue-token'
        ? `Token ${request.token}`
        : 'No amount';
  AF.app.openDialog(
    `<span class="section-label">WALLET / CONTRACT REVIEW</span><h2>Confirm ${esc(request.kind)}.</h2><div class="receipt"><div class="receipt-lines"><div><span>Wallet owner</span><span>${esc(review.owner)}</span></div><div><span>Operation</span><span>${esc(review.operationId)}</span></div><div><span>Amount</span><span>${esc(amount)}</span></div></div></div><p>The wallet will show the exact contract transaction. Submission is not success; AlphaForge waits for receipt and canonical readback.</p><p data-product-dialog-error class="form-error" role="alert"></p><div class="inline-actions"><button class="primary-btn" data-chain-confirm>Request wallet confirmation ↗</button><button class="text-link" data-close>Cancel</button></div>`,
  );
}
function openPassTransfer(): void {
  if (!onchainRuntime?.reviewPassTransfer || !onchainRuntime.confirmPassTransfer)
    throw Error('PASS_TRANSFER_UNAVAILABLE');
  if (onchainRuntime.snapshot.onchain.passTransferMode === 'DISABLED')
    throw Error('PASS_TRANSFER_UNAVAILABLE');
  passTransferDraft = {};
  AF.app.openDialog(
    '<span class="section-label">PASS TRANSFER</span><h2>Review Pass transfer.</h2><label>Recipient address<input name="passRecipient" autocomplete="off" autofocus></label><label>Pass amount<input name="passAmount" inputmode="decimal" autocomplete="off"></label><p>Pass uses 18 decimals. Paid Buy and Sell are outside Phase One.</p><p data-product-dialog-error class="form-error" role="alert"></p><div class="inline-actions"><button class="primary-btn" data-pass-review>Read and simulate ↗</button><button class="text-link" data-close>Cancel</button></div>',
  );
}
async function reviewPassTransfer(control: HTMLElement): Promise<void> {
  const draft = passTransferDraft;
  if (!onchainRuntime?.reviewPassTransfer || !draft) throw Error('PASS_TRANSFER_REVIEW_REQUIRED');
  const recipient = document.querySelector<HTMLInputElement>('dialog[open] [name="passRecipient"]')?.value;
  const amount = document.querySelector<HTMLInputElement>('dialog[open] [name="passAmount"]')?.value;
  if (recipient === undefined || amount === undefined) throw Error('PASS_TRANSFER_INPUT_REQUIRED');
  const request = parseM3PassTransfer(recipient, amount);
  const stillCurrent = () =>
    passTransferDraft === draft && control.isConnected && !!control.closest('dialog')?.open;
  let review;
  try {
    review = await onchainRuntime.reviewPassTransfer(request);
  } catch (error) {
    if (!stillCurrent()) return;
    throw error;
  }
  if (!stillCurrent()) return;
  if (
    review.request.recipient.toLowerCase() !== request.recipient.toLowerCase() ||
    review.request.passBaseUnits !== request.passBaseUnits
  )
    throw Error('PASS_TRANSFER_REVIEW_MISMATCH');
  passTransferDraft = { request, review };
  AF.app.openDialog(
    `<span class="section-label">WALLET / CONTRACT REVIEW</span><h2>Confirm Pass transfer.</h2><div class="receipt"><div class="receipt-lines"><div><span>Wallet owner</span><span>${esc(review.owner)}</span></div><div><span>Pass contract</span><span>${esc(review.token)}</span></div><div><span>Recipient</span><span>${esc(request.recipient)}</span></div><div><span>Amount</span><span>${esc(request.passBaseUnits)} Pass base units</span></div><div><span>Operation</span><span>${esc(review.operationId)}</span></div></div></div><p>The wallet will show the exact ERC-20 transfer. One Pass equals 10^18 base units.</p><p data-product-dialog-error class="form-error" role="alert"></p><div class="inline-actions"><button class="primary-btn" data-pass-confirm>Request wallet confirmation ↗</button><button class="text-link" data-close>Cancel</button></div>`,
  );
}
document.addEventListener('click', (event) => {
  const target = (event.target as Element).closest<HTMLElement>(
    '[data-product-login],[data-product-refresh],[data-product-retry],[data-product-dismiss],[data-product-command],[data-product-review],[data-product-confirm],[data-product-claim],[data-chain-connect],[data-wallet-choice],[data-chain-refresh],[data-chain-action],[data-chain-review],[data-chain-confirm],[data-chain-approve],[data-pass-transfer],[data-pass-review],[data-pass-confirm]',
  );
  if (!target) return;
  event.preventDefault();
  const error = (err: unknown) => {
    localError = err instanceof Error ? err.message : 'INVALID_REQUEST';
    const out = document.querySelector('[data-product-dialog-error]');
    if (out) out.textContent = localError;
    render();
  };
  try {
    if (target.hasAttribute('data-product-login')) {
      draft = null;
      claimId = null;
      AF.app.closeDialog();
      void run(async () => {
        await client.selectIdentity(target.dataset.productLogin as 'alice' | 'bob' | 'derick');
        await alignVault();
      });
    } else if (target.hasAttribute('data-product-refresh'))
      void run(async () => {
        await client.refresh();
        await alignVault();
      });
    else if (target.hasAttribute('data-product-retry')) void run(() => client.retry());
    else if (target.hasAttribute('data-product-dismiss'))
      void run(async () => {
        await client.dismissRejected();
        await client.refresh();
      });
    else if (target.hasAttribute('data-product-command')) {
      claimId = null;
      localError = null;
      openCommand(target.dataset.productCommand as CommandType);
    } else if (target.hasAttribute('data-chain-connect')) {
      if (target.closest('[data-wallet-account]')) {
        AF.app.openDialog(
          `<span class="section-label">CONNECT YOUR WALLET</span><h2>Connect Wallet</h2><p>Choose your browser wallet to continue.</p><div class="wallet-options"><button class="primary-btn" data-wallet-choice="browser">Browser Wallet <span>Robinhood Chain</span></button></div><p class="small muted">On mobile, open this page in your wallet’s browser.</p>`,
        );
      } else {
        if (!onchainRuntime) throw Error('CHAIN_RUNTIME_UNAVAILABLE');
        void run(() => onchainRuntime.connect());
      }
    } else if (target.hasAttribute('data-wallet-choice')) {
      if (target.dataset.walletChoice !== 'browser') return;
      if (!onchainRuntime) throw Error('CHAIN_RUNTIME_UNAVAILABLE');
      AF.app.closeDialog();
      void run(() => onchainRuntime.connect());
    } else if (target.hasAttribute('data-chain-refresh')) {
      if (!onchainRuntime) throw Error('CHAIN_RUNTIME_UNAVAILABLE');
      void run(() => onchainRuntime.refresh());
    } else if (target.hasAttribute('data-chain-action')) {
      draft = null;
      claimId = null;
      localError = null;
      openOnchainAction(target.dataset.chainAction as OnchainProductAction);
    } else if (target.hasAttribute('data-pass-transfer')) {
      draft = null;
      claimId = null;
      onchainDraft = null;
      localError = null;
      openPassTransfer();
    } else if (target.hasAttribute('data-pass-review')) {
      void runM3DialogAction(
        'review',
        target as HTMLButtonElement,
        () => reviewPassTransfer(target as HTMLButtonElement),
        showOnchainDialogError,
      );
    } else if (target.hasAttribute('data-pass-confirm')) {
      if (!onchainRuntime?.confirmPassTransfer || !passTransferDraft?.review)
        throw Error('PASS_TRANSFER_REVIEW_REQUIRED');
      const captured = passTransferDraft.review;
      passTransferDraft = null;
      void runM3DialogAction(
        'confirm',
        target as HTMLButtonElement,
        async () => {
          await onchainRuntime.confirmPassTransfer!(captured);
          if (currentDialog(target)) AF.app.closeDialog();
        },
        (message) => showConfirmDialogError(target, message),
      );
    } else if (target.hasAttribute('data-chain-review')) {
      void runM3DialogAction(
        'review',
        target as HTMLButtonElement,
        () => reviewOnchainAction(target as HTMLButtonElement),
        showOnchainDialogError,
      );
    } else if (target.hasAttribute('data-chain-confirm')) {
      if (!onchainRuntime || !onchainDraft?.review) throw Error('CHAIN_REVIEW_REQUIRED');
      const captured = onchainDraft.review;
      onchainDraft = null;
      void runM3DialogAction(
        'confirm',
        target as HTMLButtonElement,
        async () => {
          await onchainRuntime.confirmAction(captured);
          if (currentDialog(target)) AF.app.closeDialog();
        },
        (message) => showConfirmDialogError(target, message),
      );
    } else if (target.hasAttribute('data-chain-approve')) {
      if (!onchainRuntime?.confirmDepositApproval || !onchainDraft?.approval)
        throw Error('DEPOSIT_APPROVAL_REVIEW_REQUIRED');
      const approval = onchainDraft.approval;
      const kind = target.dataset.chainApprove as M3DepositApprovalKind;
      onchainDraft = null;
      void runM3DialogAction(
        'confirm',
        target as HTMLButtonElement,
        async () => {
          await onchainRuntime.confirmDepositApproval!(approval, kind);
          if (currentDialog(target)) AF.app.closeDialog();
        },
        (message) => showConfirmDialogError(target, message),
      );
    } else if (target.hasAttribute('data-product-review')) reviewDraft();
    else if (target.hasAttribute('data-product-claim')) {
      draft = null;
      claimId = target.dataset.productClaim!;
      AF.app.openDialog(
        `<span class="section-label">STRATEGY ACCESS</span><h2>Claim Pass access.</h2><p>${esc(claimId)} · ${esc(adapter.snapshot.user)}. Access allowance is not cash. Claiming does not deposit funds.</p><button class="primary-btn" data-product-confirm>Confirm access</button><button class="text-link" data-close>Cancel</button>`,
      );
    } else if (target.hasAttribute('data-product-confirm')) {
      target.setAttribute('disabled', '');
      if (claimId) {
        const id = claimId;
        claimId = null;
        void run(async () => {
          await client.claim(id);
          if (currentDialog(target)) AF.app.closeDialog();
        });
      } else if (draft?.fields) {
        const captured = draft;
        draft = null;
        void run(async () => {
          await client.command(captured.type, captured.fields!, captured.review);
          if (currentDialog(target)) AF.app.closeDialog();
        });
      } else throw Error('REVIEW_REQUIRED');
    }
  } catch (err) {
    error(err);
  }
});
document.addEventListener('input', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.hasAttribute('data-product-search')) {
    query = input.value;
    const rows = document.querySelector('[data-product-catalogue]');
    if (rows) rows.innerHTML = catalogueRows();
  }
});
document.addEventListener('change', (event) => {
  const input = event.target as HTMLSelectElement;
  if (input.hasAttribute('data-chain-vault-select')) {
    const selection = onchainRuntime?.vaultSelection?.options.find(
      (option) => `${option.chainId}:${option.vaultAddress}` === input.value,
    );
    if (!onchainRuntime?.selectVault || !selection) {
      localError = 'M3_VAULT_SELECTION_NOT_ALLOWLISTED';
      render();
      return;
    }
    onchainDraft = null;
    passTransferDraft = null;
    AF.app.closeDialog();
    void run(() => onchainRuntime.selectVault!(selection));
    return;
  }
  if (input.hasAttribute('data-product-status-filter')) statusFilter = input.value;
  else if (input.hasAttribute('data-product-environment-filter')) environment = input.value;
  else return;
  const rows = document.querySelector('[data-product-catalogue]');
  if (rows) rows.innerHTML = catalogueRows();
});
window.addEventListener('hashchange', () => {
  draft = null;
  claimId = null;
  onchainDraft = null;
  passTransferDraft = null;
  void run(alignVault);
});
client.subscribe(() => render());
onchainRuntime?.subscribe(() => render());
if (window.ethereum) {
  // Wallet events invalidate the displayed owner immediately through the runtime.
  // Refresh is read-only and never requests a signature or another account grant.
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect'] as const)
    window.ethereum.on(event, () => {
      void run(() => onchainRuntime!.refresh());
    });
}
void run(async () => {
  await client.refresh();
  await alignVault();
});
let previousDelay = adapter.retryAfterSeconds;
setInterval(() => {
  const delay = adapter.retryAfterSeconds;
  if (delay !== previousDelay) {
    previousDelay = delay;
    render();
  }
}, 1000);
const community = installCommunity(AF);
void installLaunchMarket(AF, window.ethereum, undefined, AF.pages.account)
  .then((launch) => {
    if (launch) community.attachLaunch(launch);
  })
  .catch((error) => {
    localError = error instanceof Error ? error.message : 'MARKET_INITIALIZATION_FAILED';
    render();
  });
