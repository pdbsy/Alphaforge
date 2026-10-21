import { actionAccess } from './action-access.ts';
import { renderPaperPortfolio, renderClosedPaperSummary } from './paper-portfolio-ui.ts';
import {
  renderVaultActionStatus,
  renderVaultPerformance,
  type VaultActionsViewState,
  type VaultValuationsView,
} from './vault-actions-ui.ts';
import type { LaunchClientState, MarketOperation, PaymentAsset, StrategyId } from './model.ts';
import {
  actionable,
  escapeHtml as esc,
  inputUnit,
  outputUnit,
  poolPrice,
  progress,
  quoteIsFinalMint,
  rawAmount,
} from './presentation.ts';

export interface OrderForm {
  readonly operation: MarketOperation;
  readonly asset: PaymentAsset;
  readonly amount: string;
  readonly slippageBps: number;
}
const strategies: readonly StrategyId[] = ['TSLA', 'AMZN'];
const amount = rawAmount;
const row = (label: string, value: string): string =>
  `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
const actionName = (operation: MarketOperation): string =>
  ({
    MINT: 'Mint',
    BUY: 'Buy',
    SELL: 'Sell',
    CLAIM: 'Claim',
    DEPOSIT: 'Deposit',
    WITHDRAW: 'Withdraw',
    CLOSE: 'Withdraw all',
    CREATE_VAULT: 'Create Vault',
  })[operation];

function network(state: LaunchClientState): string {
  const configured = state.config?.deployment === 'CONFIGURED';
  return `<div class="launch-network"><span class="section-label">ROBINHOOD CHAIN</span></div>${!configured ? '<p class="dialog-notice">Contracts are not deployed. Mint, trading, claims and Vault funding become available after the reviewed deployment and reserves are ready.</p>' : ''}${state.error ? `<p class="form-error launch-feedback" role="alert">${esc(state.error)}</p>` : ''}${state.notice ? `<p class="launch-feedback" role="status">${esc(state.notice)}</p>` : ''}`;
}

export function connection(state: LaunchClientState): string {
  const label = state.connecting
    ? 'Connecting…'
    : state.owner
      ? `${state.owner.slice(0, 6)}…${state.owner.slice(-4)}`
      : 'Connect Wallet';
  return `<div class="launch-wallet-actions"><button class="primary-btn wallet-connect" data-launch-connect ${state.connecting || state.busy ? 'disabled' : ''}><span class="wallet-status-dot${state.owner ? ' connected' : ''}" aria-hidden="true"></span>${esc(label)}</button>${state.owner && state.config?.deployment === 'CONFIGURED' && (state.account || state.config.emailVerificationRequired === false) && !state.wallet?.accountId ? `<button class="text-link" data-launch-bind ${state.connecting || state.busy ? 'disabled' : ''}>${state.config.emailVerificationRequired === false && !state.account?.emailVerified ? 'Continue with wallet' : 'Link verified account'} ↗</button>` : ''}</div>`;
}

export function accountAccess(state: LaunchClientState): string {
  const verified = state.account?.emailVerified === true;
  if (state.account && state.wallet?.accountId === state.account.id) return '';
  if (state.config?.emailVerificationRequired === false && !verified)
    return `<section class="sketch-box launch-onboarding"><h2>Continue with your wallet</h2><p>Confirm wallet ownership to continue. The message signature does not move assets or approve transactions.</p>${state.owner && state.config.deployment === 'CONFIGURED' ? `<button class="text-link" data-launch-bind ${state.connecting || state.busy ? 'disabled' : ''}>Continue with wallet ↗</button>` : ''}</section>`;
  return `<section class="sketch-box launch-onboarding"><h2>Finish your account setup</h2><p>${verified ? 'Your Google account is verified.' : 'Sign in with Google to verify your email before claiming or trading.'} Connect your wallet, then choose Link verified account and approve the message in your wallet. This link does not move assets or approve a contract transaction.</p>${!verified ? '<a class="text-link" href="/login/?next=%2Falphaforge%2F">Sign in with Google ↗</a>' : ''}</section>`;
}

function claimStatus(state: LaunchClientState): string {
  switch (state.account?.claimStatus) {
    case 'COMPLETED':
      return 'Claimed';
    case 'SUBMITTED':
    case 'INCLUDED':
      return 'Pending chain confirmation';
    case 'REORGED':
    case 'REVERTED':
    case 'EXPIRED':
      return 'Recovery required';
    case 'ISSUED':
      return 'Ready for wallet review';
    case 'ELIGIBLE':
      return 'Available';
    default:
      return state.config?.emailVerificationRequired === false
        ? 'Connect wallet to check'
        : 'Sign in to check';
  }
}

export function renderTransaction(state: LaunchClientState, actions?: VaultActionsViewState): string {
  const tx = state.transaction;
  if (tx.state === 'IDLE') return '';
  const stage = tx.stock
    ? 'Strategy stock transaction'
    : tx.executor
      ? 'Executor permission transaction'
      : tx.approval
        ? 'Token approval'
        : 'Transaction';
  const hash = tx.hash && /^0x[0-9a-fA-F]{64}$/.test(tx.hash) ? tx.hash : null;
  return `<section class="launch-transaction sketch-box" aria-live="polite"><div class="section-label">${stage}</div><strong>${esc(tx.state.replaceAll('_', ' '))}</strong><p>${tx.state === 'INCLUDED' || tx.state === 'CONFIRMED_L2' || tx.state === 'COMPLETED' ? `${tx.confirmations} / 3 L2 blocks, including the inclusion block. This is the application confirmation policy.` : tx.state === 'RECOVERY_REQUIRED' ? 'The wallet outcome or synchronization needs review. Refresh the evidence before starting another transaction.' : tx.state === 'SUBMITTED' ? 'Submitted. Waiting for a receipt and chain readback.' : tx.state === 'REORGED' ? 'The inclusion was reorganized. Balances and market state are being read again.' : tx.state === 'REVERTED' ? 'The transaction reverted. Contract asset transfers were rolled back.' : tx.state === 'AWAITING_WALLET' ? 'Review the transaction in your wallet.' : ''}</p>${hash ? `<a class="text-link launch-hash" href="https://explorer.testnet.chain.robinhood.com/tx/${hash}" target="_blank" rel="noopener noreferrer">${hash.slice(0, 12)}…${hash.slice(-8)} ↗</a>` : ''}${tx.executor && !actions?.flow && !tx.hash && tx.state === 'RECOVERY_REQUIRED' ? '<form data-launch-executor-recover><label for="executor-recovery-hash">Find the transaction in your original owner wallet and enter its hash.</label><input id="executor-recovery-hash" name="hash" type="text" autocomplete="off" placeholder="0x…" required><button class="outline-btn" type="submit">Verify existing transaction ↗</button><p class="small muted">The previous wallet request had an unknown outcome. This verifies its exact owner, Vault and calldata without sending a replacement.</p></form>' : ''}${tx.state === 'RECOVERY_REQUIRED' || tx.state === 'REORGED' ? '<button class="text-link" data-launch-refresh>Refresh transaction evidence ↗</button>' : ''}</section>`;
}

function stats(state: LaunchClientState, strategy: StrategyId): string {
  const market = state.snapshot?.markets[strategy];
  const minted = market?.state === 'LAUNCHED';
  if (strategy === 'TSLA')
    return `<dl class="order-quote launch-stats">${row('Total supply', `${amount(market?.totalSupplyRaw, 18)} PASS`)}${row('Public Mint', `${amount(market?.publicSupplyRaw, 18)} PASS`)}${row('Subscribed', `${amount(market?.soldRaw, 18)} PASS`)}${row('Remaining', `${amount(market?.remainingRaw, 18)} PASS`)}${row('Subscription progress', progress(market))}${row('Mint price', `${amount(market?.mintPriceUsdcRaw, 6)} AF-USDC/PASS`)}${row('LP reserve', `${amount(market?.lpPassRaw, 18)} PASS · ${amount(market?.lpUsdcRaw, 6)} AF-USDC`)}${minted ? row('Current AMM price', `${poolPrice(market)} AF-USDC/PASS`) : ''}</dl>`;
  return `<dl class="order-quote launch-stats">${row('Total supply', `${amount(market?.totalSupplyRaw, 18)} PASS`)}${row('Initial pool', `${amount(market?.lpPassRaw, 18)} PASS`)}${row('Initial AF-USDC reserve', `${amount(market?.lpUsdcRaw, 6)} AF-USDC`)}${row('Treasury wallet allocation', market ? '500,000 PASS' : '—')}${row('Current AMM price', `${poolPrice(market)} AF-USDC/PASS`)}${row('Pool PASS reserve', `${amount(market?.reservePassRaw, 18)} PASS`)}${row('Pool AF-USDC reserve', `${amount(market?.reserveUsdcRaw, 6)} AF-USDC`)}</dl>`;
}

export function renderMarket(state: LaunchClientState): string {
  return `<div class="wrap inner-page launch-market"><header class="page-intro catalogue-intro"><div><span class="section-label">THE STRATEGY MARKET</span><h1>Two ideas.<br><em>One shared market.</em></h1><p>Fixed supply PASS. ETH or AF-USDC. Wallet-authorized settlement on Robinhood Chain.</p></div>${connection(state)}</header>${network(state)}<div class="strategy-grid launch-market-grid">${strategies.map((strategy) => `<article class="market-card sketch-box"><span class="section-label">${strategy === 'TSLA' ? 'FAIR LAUNCH' : 'SECONDARY MARKET'}</span><h2>All in ${strategy}</h2><span class="fixture-tag">${esc(state.snapshot?.markets[strategy].state === 'LAUNCHED' ? 'LIVE TRADING' : (state.snapshot?.markets[strategy].state ?? 'NOT_DEPLOYED'))}</span>${stats(state, strategy)}<a class="primary-btn" href="#/trade/${strategy.toLowerCase()}">${state.snapshot?.markets[strategy].state === 'LAUNCHED' ? 'Open trading' : strategy === 'TSLA' ? 'Explore Mint' : 'Explore strategy'} ↗</a></article>`).join('')}</div><section class="launch-fair-note sketch-box"><span class="section-label">TSLA · MINTING → SOLD OUT → AUTO LAUNCH → LIVE TRADING</span><h2>The final Mint opens the market.</h2><p>500,000 public PASS at 0.5 AF-USDC/PASS. Another 500,000 PASS and 250,000 AF-USDC are reserved before Mint opens. The final Mint atomically creates the AMM pool and opens trading. No second administrator signature is needed.</p><p class="small muted">If pool creation fails, the entire final Mint reverts. Subscription proceeds go to the configured collection wallet; LP funds are held separately.</p></section><a class="text-link" href="#/account/claim">Free AF-USDC ↗</a>${renderTransaction(state)}</div>`;
}

export function renderQuote(state: LaunchClientState): string {
  const q = state.quote;
  if (!q) return '';
  const output = outputUnit(q);
  const decimals = output === 'AF-USDC' ? 6 : 18;
  const reference = q.reference;
  const paidRaw =
    q.operation === 'MINT'
      ? q.asset === 'ETH'
        ? q.transaction.value
        : state.snapshot
          ? String(
              (BigInt(q.estimatedOutRaw) * BigInt(state.snapshot.markets.TSLA.mintPriceUsdcRaw) +
                10n ** 18n -
                1n) /
                10n ** 18n,
            )
          : ''
      : q.amountInRaw;
  const when = (time: number) => new Date(time * 1000).toLocaleString('en-US');
  return `<section class="launch-reviewed sketch-box" aria-label="Reviewed chain quote"><span class="section-label">REVIEW ${actionName(q.operation).toUpperCase()} · ${q.strategyId}</span><h2>${amount(q.estimatedOutRaw, decimals, output === 'ETH' ? 8 : 6)} ${output}</h2><dl class="order-quote">${row('Pay', `${amount(paidRaw, q.operation === 'SELL' || q.asset === 'ETH' ? 18 : 6, 18)} ${q.operation === 'SELL' ? 'PASS' : q.asset === 'ETH' ? 'ETH' : 'AF-USDC'}`)}${row('Minimum received', `${amount(q.minOutRaw, decimals, output === 'ETH' ? 18 : 6)} ${output}`)}${row('Price impact', `${q.priceImpactBps / 100}%`)}${row('AMM fee', `${amount(q.feeUsdcRaw, 6)} AF-USDC`)}${row('Conversion fee', `${amount(q.conversionFeeUsdcRaw, 6)} AF-USDC`)}${row('Reference ETH/USD', reference ? `${amount(reference.ethUsdPriceRaw, 6)} USD` : 'Not required')}${row('Rate updated', reference ? when(reference.observedAt) : '—')}${row('Quote expires', when(q.expiresAt))}${row('Estimated gas', q.gasEstimateRaw === null ? 'Available after token approval' : `${amount(q.gasEstimateRaw, 0)} gas`)}</dl>${quoteIsFinalMint(state, q) ? `<p class="dialog-notice">This is the final Mint. It also creates the pool with the reserved 500,000 PASS and 250,000 AF-USDC, then opens trading in the same transaction. ${q.gasEstimateRaw === null ? 'The launch gas estimate is available after approval.' : 'The gas estimate includes launch.'} If launch fails, your Mint rolls back.</p>` : ''}<p class="small muted">${q.allowance ? 'An exact token approval is required first. This is a separate wallet transaction. After it is confirmed, review a fresh quote for the asset operation.' : 'Your wallet shows the contract, assets and amounts. A returned transaction hash is pending until verified chain inclusion.'}</p><button class="primary-btn full" data-launch-confirm ${state.busy ? 'disabled' : ''}>${q.allowance ? 'Approve exact amount' : 'Confirm in wallet'} ↗</button><button class="text-link" data-launch-clear ${state.busy ? 'disabled' : ''}>Cancel quote</button></section>`;
}

export function renderTrade(state: LaunchClientState, strategy: StrategyId, form: OrderForm): string {
  const market = state.snapshot?.markets[strategy];
  const launched = market?.state === 'LAUNCHED';
  const mint = strategy === 'TSLA' && !launched;
  const operation = mint ? 'MINT' : form.operation === 'SELL' ? 'SELL' : 'BUY';
  const available = state.wallet?.passes[strategy];
  const ethUnavailable =
    form.asset === 'ETH' &&
    !!state.snapshot &&
    !(operation === 'SELL'
      ? state.snapshot.conversion.ethSellAvailable
      : operation === 'MINT'
        ? (state.snapshot.conversion.ethMintAvailable ?? state.snapshot.conversion.ethBuyAvailable)
        : state.snapshot.conversion.ethBuyAvailable);
  return `<div class="wrap terminal-page launch-market"><header class="terminal-heading"><div><span class="section-label">${mint ? 'FAIR LAUNCH · PUBLIC MINT' : 'SHARED AMM · LIVE TRADING'}</span><h1>All in ${strategy}</h1><p>${mint ? 'Mint completes. The market launches automatically.' : 'Buy or sell PASS through one AF-USDC pool.'}</p></div>${connection(state)}</header>${network(state)}<div class="launch-terminal"><section><article class="sketch-box"><span class="fixture-tag">${esc(launched ? 'LIVE TRADING' : (market?.state ?? 'NOT_DEPLOYED'))}</span>${stats(state, strategy)}${mint ? '<p class="launch-fair-note">MINTING → SOLD OUT → AUTO LAUNCH → LIVE TRADING<br><span class="small muted">The final Mint and launch settle atomically. A failed launch rolls back the entire Mint.</span></p>' : ''}</article><section class="position-slip"><h2>Your PASS</h2><dl class="order-quote">${row('Available PASS', amount(available?.availableRaw, 18))}${row('Locked PASS', amount(available?.lockedRaw, 18))}${row('Wallet ETH', amount(state.wallet?.ethBalanceRaw, 18, 8))}${row('Wallet AF-USDC', amount(state.wallet?.usdcBalanceRaw, 6))}</dl><a class="text-link" href="#/account/vaults">Use PASS in a Vault ↗</a></section><p class="small muted">PASS market prices are separate from the strategy’s stock holdings and investment PnL.</p></section><aside class="pass-trade-aside"><section class="order-card sketch-box"><div class="order-kicker"><span class="mono">${mint ? 'PUBLIC MINT' : 'PASS MARKET'}</span></div><h2>${mint ? 'Mint TSLA PASS' : `${actionName(operation)} ${strategy} PASS`}</h2>${mint ? '' : `<div class="order-side"><button data-launch-side="BUY" aria-pressed="${operation === 'BUY'}">Buy</button><button data-launch-side="SELL" aria-pressed="${operation === 'SELL'}">Sell</button></div>`}<form data-launch-order data-strategy="${strategy}" data-operation="${operation}"><label for="launch-payment">${operation === 'SELL' ? 'Receive' : 'Pay with'}</label><select id="launch-payment" name="asset" data-launch-asset><option value="ETH" ${form.asset === 'ETH' ? 'selected' : ''}>ETH · Default</option><option value="AF_USDC" ${form.asset === 'AF_USDC' ? 'selected' : ''}>AF-USDC</option></select><label class="order-amount-label" for="launch-amount">${mint ? 'PASS to mint' : operation === 'SELL' ? 'PASS to sell' : 'Amount to spend'}</label><div class="pass-amount-wrap"><input id="launch-amount" name="amount" type="text" inputmode="decimal" autocomplete="off" value="${esc(form.amount)}" placeholder="Enter ${inputUnit(operation, form.asset)}" required><span>${inputUnit(operation, form.asset)}</span></div><label for="launch-slippage">Maximum slippage</label><select id="launch-slippage" name="slippageBps" data-launch-slippage>${[50, 100, 300].map((bps) => `<option value="${bps}" ${form.slippageBps === bps ? 'selected' : ''}>${bps / 100}%</option>`).join('')}</select>${ethUnavailable ? '<p class="form-error">This ETH conversion path has insufficient liquidity. Switch to AF-USDC to continue.</p>' : ''}<button class="primary-btn full" type="submit" ${actionable(state, strategy, operation, form.asset) ? '' : 'disabled'}>Review ${actionName(operation).toLowerCase()} ↗</button></form>${!state.owner ? '<p class="small muted">Connect your browser wallet to read balances and request a quote.</p>' : ''}<p class="small muted">Leave ETH for gas. ETH sell payouts have per-transaction and daily limits; enter a smaller amount or choose AF-USDC.</p><p class="order-disclaimer">Amounts settle on chain. Approvals, if needed, are separate transactions. No asset balances are created in the browser.</p></section>${renderQuote(state)}</aside></div>${renderTransaction(state)}</div>`;
}

const accountNav = (selected: string): string =>
  `<nav class="wrap account-tabs" aria-label="Account sections">${[
    ['trades', 'Pass Holdings'],
    ['claim', 'Free AF-USDC'],
    ['vaults', 'Vaults'],
    ['saved', 'Saved strategies'],
    ['notes', 'My notes'],
    ['settings', 'Settings'],
  ]
    .map(
      ([id, name]) =>
        `<a href="#/account/${id}" ${id === selected ? 'class="active" aria-current="page"' : ''}>${name}</a>`,
    )
    .join('')}</nav>`;

function vaultFlowQuote(state: LaunchClientState, actions?: VaultActionsViewState, strategy?: StrategyId) {
  const q = state.quote;
  return actions?.flow &&
    q &&
    actions.flow.strategyId === q.strategyId &&
    (!strategy || q.strategyId === strategy) &&
    q.owner.toLowerCase() === state.owner?.toLowerCase() &&
    ['CREATE_VAULT', 'DEPOSIT', 'CLOSE'].includes(q.operation)
    ? q
    : null;
}

function vaultReviewQuote(state: LaunchClientState, actions?: VaultActionsViewState, strategy?: StrategyId) {
  return actions?.flow?.review ? vaultFlowQuote(state, actions, strategy) : null;
}

function renderVaultReview(
  state: LaunchClientState,
  actions: VaultActionsViewState | undefined,
  strategy: StrategyId,
): string {
  const q = vaultReviewQuote(state, actions, strategy);
  if (!q) return '';
  const approval = q.allowance;
  const manifest = state.config?.manifest;
  const usdc = approval?.token.toLowerCase() === manifest?.usdc.toLowerCase();
  const pass = approval?.token.toLowerCase() === manifest?.strategies[strategy].pass.toLowerCase();
  const title = approval
    ? 'Approve exact amount'
    : q.operation === 'CREATE_VAULT'
      ? 'Create Vault'
      : q.operation === 'CLOSE'
        ? 'Confirm withdrawal'
        : 'Confirm deposit';
  const detail = approval
    ? `${usdc || pass ? amount(approval.amountRaw, usdc ? 6 : 18, 18) : approval.amountRaw} ${usdc ? 'AF-USDC' : pass ? 'PASS' : 'token base units'}`
    : q.operation === 'DEPOSIT'
      ? `${amount(q.amountInRaw, 6, 6)} AF-USDC`
      : q.operation === 'CREATE_VAULT'
        ? 'Create your own Vault before funding it. No deposit is transferred in this step.'
        : 'Return all on-chain Vault cash and release all locked PASS.';
  const disabled = state.busy || actions?.flow?.busy || actions?.flow?.pendingHash ? 'disabled' : '';
  return `<section class="launch-reviewed" aria-label="Reviewed Vault transaction" data-launch-vault-review="${strategy}"><p><strong>${esc(title)} · ${strategy}</strong></p><p>${esc(detail)}</p>${actions?.error ? `<p class="form-error" role="alert">${esc(actions.error)}</p>` : ''}<p class="small muted">${approval ? 'This approval is a separate wallet transaction. After confirmation, the next required wallet request opens automatically.' : actions?.flow?.kind === 'DEPOSIT' ? 'Open your wallet to confirm this transaction. The remaining Deposit steps open automatically after chain confirmation.' : 'Open your wallet to confirm this withdrawal.'}</p><button class="primary-btn" type="button" data-launch-confirm ${disabled}>${actions?.flow?.kind === 'DEPOSIT' ? 'Deposit' : 'Withdraw'} ↗</button><button class="text-link" type="button" data-launch-clear ${disabled}>Cancel operation</button></section>`;
}

export function renderVaultFunding(
  state: LaunchClientState,
  strategy: StrategyId,
  drafts: Readonly<Record<string, string>> = {},
  actions?: VaultActionsViewState,
  valuations?: VaultValuationsView,
): string {
  const vault = state.wallet?.vaults.find((item) => item.strategyId === strategy && item.status === 'OPEN');
  const address = vault?.address.toLowerCase() ?? `new:${strategy}`;
  const flow = actions?.flow;
  const review = vaultReviewQuote(state, actions, strategy);
  const unlocked = !flow?.busy && (!flow || (!flow.review && !flow.pendingHash));
  const valuation = vault
    ? (valuations?.byVault?.[vault.address.toLowerCase()] ?? valuations?.[strategy])
    : valuations?.[strategy];
  const paper = valuation?.value?.paper;
  const marketReady =
    !valuation?.error &&
    paper?.status !== 'REORG_REVIEW_REQUIRED' &&
    (paper?.marketSession === 'CLOSED' ||
      (paper?.quoteStatus === 'FRESH' && paper.marketSession === 'OPEN' && paper.sourceId === 'ALPACA_IEX'));
  const entryPending = flow?.strategyId === strategy && flow.phase === 'PAPER_PENDING';
  const enabled =
    unlocked &&
    !entryPending &&
    marketReady &&
    actionable(state, strategy, vault ? 'DEPOSIT' : 'CREATE_VAULT', 'AF_USDC');
  const access = actionAccess(state, strategy, vault ? 'DEPOSIT' : 'CREATE_VAULT', 'AF_USDC');
  const needsAccountAction = ['CONNECT', 'BIND', 'LOGIN'].includes(access.action);
  const signInProgress = state.walletSignIn
    ? {
        CHECKING: 'Checking the wallet and requesting a sign-in message…',
        AWAITING_SIGNATURE:
          'Waiting for your wallet signature. Open your wallet extension or wallet app to review the message.',
        VERIFYING: 'Verifying your signature…',
      }[state.walletSignIn]
    : '';
  const signInError =
    needsAccountAction && state.error
      ? `<p class="form-error" role="alert" data-launch-vault-signin-error>${esc(state.error)}</p>`
      : '';
  const depositReason =
    enabled || review
      ? ''
      : signInProgress ||
        (flow?.strategyId === strategy && state.transaction.state === 'AWAITING_WALLET'
          ? 'Waiting for transaction confirmation in your wallet. Open your wallet extension or app to confirm or cancel.'
          : '') ||
        (access.action === 'BIND'
          ? 'Click Deposit to sign in with your wallet, then continue. The sign-in message moves no assets.'
          : access.reason) ||
        (entryPending
          ? 'Your deposit is waiting for automatic simulated entry. Use Stop to cancel it, or Withdraw to return the cash.'
          : !unlocked
            ? flow?.strategyId !== strategy
              ? `Continue the ${flow?.strategyId ?? ''} Vault operation before starting this Deposit.`
              : flow?.pendingHash
                ? 'Transaction submitted. Waiting for chain confirmation; no second Deposit is needed.'
                : 'Preparing the next Vault step. If your wallet is open, confirm or cancel the request there.'
            : valuation?.error
              ? valuation.error
              : paper?.status === 'REORG_REVIEW_REQUIRED'
                ? 'Funding confirmation changed. Deposit is paused while the ledger is reconciled.'
                : paper?.marketSession === 'CLOSED'
                  ? 'The stock market is closed. Confirmed deposits wait for automatic simulated entry when the market opens and a fresh authorized quote arrives.'
                  : 'Deposit is waiting for a fresh authorized stock quote.');
  const closeEnabled = !!vault && unlocked && actionable(state, strategy, 'CLOSE', 'AF_USDC');
  const stopState = { ...state, busy: false, transaction: { ...state.transaction, state: 'IDLE' as const } };
  const stopEnabled =
    (!!vault || flow?.strategyId === strategy) &&
    !state.connecting &&
    state.account?.wallet?.toLowerCase() === state.owner?.toLowerCase() &&
    actionable(stopState, strategy, vault ? 'DEPOSIT' : 'CREATE_VAULT', 'AF_USDC');
  return `<section class="wallet-funding"><h2>Deposit · Stop · Withdraw</h2>${vault ? renderVaultPerformance(state, strategy, valuation) : renderPaperPortfolio(valuation?.value, valuation?.error)}${renderVaultActionStatus(state, actions, strategy, valuation)}<dl class="order-quote">${row('Available funds', `${amount(state.wallet?.usdcBalanceRaw, 6)} AF-USDC`)}${row('Available PASS', amount(state.wallet?.passes[strategy].availableRaw, 18))}${vault ? `${row('Vault cash', `${amount(vault.cashRaw, 6)} AF-USDC`)}${row('Locked PASS', amount(vault.lockedPassRaw, 18))}` : ''}</dl><form data-launch-vault-order data-strategy="${strategy}" data-vault="${esc(address)}"><label for="vault-${strategy}">Deposit amount · AF-USDC</label><input id="vault-${strategy}" name="amount" type="text" inputmode="decimal" autocomplete="off" value="${esc(drafts[address] ?? '')}" placeholder="10" required>${signInError}${enabled && paper?.marketSession === 'CLOSED' ? '<p class="dialog-notice" role="status" data-launch-deposit-queued>Market closed: you can deposit now. After on-chain confirmation, the server will automatically record the simulated entry at the first available fresh authorized quote after the market opens. You can close this page. Stop cancels the pending entry; Withdraw returns your Vault cash.</p>' : ''}${depositReason ? `<p class="dialog-notice" role="status" data-launch-deposit-reason>${esc(depositReason)}</p>` : ''}${renderVaultReview(state, actions, strategy)}<div class="inline-actions">${review ? '' : `<button class="primary-btn" type="submit" name="operation" value="DEPOSIT" ${enabled || (unlocked && needsAccountAction) ? '' : 'disabled'}>Deposit ↗</button>`}<button class="outline-btn" type="button" data-launch-vault-stop="${strategy}" ${stopEnabled ? '' : 'disabled'}>Stop ↗</button><button class="outline-btn" type="button" data-launch-vault-withdraw="${strategy}" ${closeEnabled ? '' : 'disabled'}>Withdraw ↗</button></div></form>${state.wallet && !vault && flow?.strategyId !== strategy ? '<p class="small muted">No active Vault yet. Stop and Withdraw become available after your first Deposit creates a Vault.</p>' : ''}<p class="small muted">${!vault ? 'Your first Deposit starts with creating your own Vault. ' : ''}Deposit locks PASS. After confirmed funding, one simulated ${strategy} entry is recorded when the market is open and an authorized quote is available. Stop pauses new simulated trades while retaining the recorded position. Withdraw closes the simulated record and the on-chain Vault, returning its cash and releasing every locked PASS.</p><p class="small muted">Vault creation, token approvals, funding and closure need wallet confirmation. Simulated stock entries and exits use the server ledger and request no stock transaction. Simulated profit cannot be withdrawn.</p></section>`;
}

export function renderAccount(
  state: LaunchClientState,
  drafts: Readonly<Record<string, string>> = {},
  openHoldings: readonly StrategyId[] = [],
  actions?: VaultActionsViewState,
  valuations?: VaultValuationsView,
): string {
  const holdings = strategies
    .map(
      (id) =>
        `<details class="wallet-holding" data-launch-position="${id}" ${openHoldings.includes(id) || vaultReviewQuote(state, actions, id) ? 'open' : ''}><summary class="wallet-pass-row sketch-box"><span class="wallet-pass-icon" aria-hidden="true">α</span><div class="wallet-pass-strategy"><h3>All in ${id}</h3><span class="small muted">Available ${amount(state.wallet?.passes[id].availableRaw, 18)} · Locked ${amount(state.wallet?.passes[id].lockedRaw, 18)}</span><p class="text-link">Deposit · Stop · Withdraw</p></div><div class="wallet-pass-quantity"><strong>${amount(state.wallet?.passes[id].balanceRaw, 18)}</strong> PASS</div></summary><div class="wallet-holding-actions"><a class="text-link" href="#/trade/${id.toLowerCase()}">Open strategy ↗</a><a class="text-link" href="#/account/vaults/${id.toLowerCase()}">Vault details ↗</a></div>${renderVaultFunding(state, id, drafts, actions, valuations)}</details>`,
    )
    .join('');
  return `${accountNav('trades')}<section class="wrap wallet-account launch-market" data-launch-account><header class="wallet-account-header"><div><span class="section-label">MY WORKSHOP</span><h1>My Account</h1></div>${connection(state)}</header>${network(state)}${accountAccess(state)}${actions?.error && !actions.flow ? `<p class="form-error" data-launch-vault-error role="alert">${esc(actions.error)}</p>` : ''}<div class="wallet-balance-grid"><article class="sketch-box wallet-eth"><span class="section-label">ETH balance</span><div class="wallet-amount"><strong>${amount(state.wallet?.ethBalanceRaw, 18, 8)}</strong><span>ETH</span></div><p class="small muted">Available for transactions and gas.</p></article><article class="sketch-box wallet-usdc"><span class="section-label">AF-USDC balance</span><div class="wallet-amount"><strong>${amount(state.wallet?.usdcBalanceRaw, 6)}</strong><span>AF-USDC</span></div><a class="text-link" href="#/account/claim">Free AF-USDC ↗</a></article></div><section class="wallet-passes"><header><h2>Pass holdings</h2><span class="small muted">Fixed supply · Strategy capacity</span></header>${holdings}</section><button class="text-link" data-launch-refresh>Refresh balances ↗</button>${vaultFlowQuote(state, actions) ? '' : renderQuote(state)}${renderExecutorReview(state)}${renderTransaction(state, actions)}</section>`;
}

export function renderClaim(state: LaunchClientState): string {
  const claim = state.snapshot?.claim;
  const testMode = state.config?.emailVerificationRequired === false;
  const emailStatus = testMode
    ? 'Not required'
    : state.wallet
      ? state.wallet.accountId
        ? 'Verified account linked'
        : 'Verified account required'
      : 'Connect wallet to check';
  return `${accountNav('claim')}<div class="wrap inner-page launch-market"><header class="terminal-heading"><div><span class="section-label">${testMode ? 'WALLET ACCOUNT' : 'VERIFIED ACCOUNT'}</span><h1>Free AF-USDC</h1><p>1,000 AF-USDC per ${testMode ? 'wallet' : 'verified account'} · 100 total successful claims.</p></div>${connection(state)}</header>${network(state)}${accountAccess(state)}<section class="sketch-box launch-claim"><dl class="order-quote">${row('Claim amount', `${amount(claim?.amountUsdcRaw, 6)} AF-USDC`)}${row('Remaining claims', claim ? String(claim.remainingClaims) : '—')}${row('Email verification status', emailStatus)}${row('Wallet connection', state.owner ? 'Connected' : 'Not connected')}${row('Claim reserve', claim ? (claim.funded ? 'Funded on chain' : 'Funding required') : 'Unavailable')}${row('Claim status', claimStatus(state))}</dl><p class="small muted">${testMode ? 'One successful claim per wallet. Connecting again does not create another claim.' : 'One successful claim per verified account. Changing wallets or signing in again does not create another claim. Email login does not grant wallet transaction authority.'}</p><button class="primary-btn" data-launch-claim ${actionable(state, 'TSLA', 'CLAIM', 'AF_USDC') ? '' : 'disabled'}>Review claim ↗</button></section>${renderQuote(state)}${renderTransaction(state)}</div>`;
}

export function renderVaults(
  state: LaunchClientState,
  drafts: Readonly<Record<string, string>> = {},
  selected?: StrategyId,
  actions?: VaultActionsViewState,
  valuations?: VaultValuationsView,
): string {
  const vaults = (state.wallet?.vaults ?? []).filter((vault) => !selected || vault.strategyId === selected);
  const closedValues = Object.values(valuations?.byVault ?? {}).flatMap((view) => {
    const value = view.value;
    return !view.error &&
      value &&
      value.owner.toLowerCase() === state.owner?.toLowerCase() &&
      value.vault &&
      (!selected || value.strategyId === selected) &&
      ['CLOSED', 'SETTLEMENT_PENDING'].includes(value.paper.status)
      ? [value]
      : [];
  });
  const archivedValues = closedValues.filter(
    (value) => !vaults.some((vault) => vault.address.toLowerCase() === value.vault!.toLowerCase()),
  );
  const archives = archivedValues
    .map(
      (value) =>
        `<article class="sketch-box launch-vault" data-paper-archived-vault="${esc(value.vault!)}"><h2>All in ${value.strategyId} Vault · closed</h2><p class="small muted">Archived Vault <span class="launch-hash" title="${esc(value.vault!)}">${esc(value.vault!.slice(0, 10))}…${esc(value.vault!.slice(-8))}</span>. Its recorded simulation remains separate from your current Vault.</p><dl class="order-quote">${row('Withdrawable on-chain cash', `${amount(value.real.withdrawableRaw, 6)} AF-USDC`)}${row('Locked PASS', amount(value.real.lockedPassRaw, 18))}</dl>${renderPaperPortfolio(value)}</article>`,
    )
    .join('');
  return `${accountNav('vaults')}<div class="wrap inner-page launch-market"><header class="terminal-heading"><div><span class="section-label">STRATEGY PRINCIPAL · 1 PASS = 1 AF-USDC CAPACITY</span><h1>${selected ? `All in ${selected} Vault` : 'Your Vaults'}</h1></div>${connection(state)}</header>${network(state)}${accountAccess(state)}${actions?.error && !actions.flow ? `<p class="form-error" data-launch-vault-error role="alert">${esc(actions.error)}</p>` : ''}${selected ? '<p><a class="text-link" href="#/account/vaults">View all Vaults ↗</a></p>' : ''}<p>Use PASS: create your own Vault, then Deposit to fund it and record a simulated ${selected ?? 'TSLA or AMZN'} entry. For example, 10 PASS lets you deposit 10 AF-USDC; the PASS purchase price is separate from this principal.</p><p>Deposit locks 1 PASS per AF-USDC. During market closure, confirmed deposits wait for automatic simulated entry after opening at an available authorized quote. Stop pauses new simulated trades while retaining the position. Withdraw returns the on-chain Vault cash and releases all PASS. Simulated profits and losses remain in the ledger history and do not change the withdrawal amount.</p>${renderClosedPaperSummary(closedValues)}${archives}${vaults.map((vault) => `<article class="sketch-box launch-vault"><h2>All in ${vault.strategyId} Vault${vault.status === 'CLOSED' ? ' · closed' : ''}</h2>${vault.status === 'OPEN' ? renderVaultFunding(state, vault.strategyId, drafts, actions, valuations) : renderVaultPerformance(state, vault.strategyId, valuations?.byVault?.[vault.address.toLowerCase()], vault.address)}${vault.holdings.some((holding) => BigInt(holding.amountRaw) > 0n) ? '<p class="form-error">This Vault has an existing on-chain stock position. The simulated ledger does not trade or replace that position.</p>' : ''}</article>`).join('')}${strategies
    .filter(
      (strategy) =>
        (!selected || strategy === selected) &&
        !vaults.some((vault) => vault.strategyId === strategy && vault.status === 'OPEN'),
    )
    .map(
      (strategy) =>
        `<article class="sketch-box launch-vault"><h2>All in ${strategy} Vault</h2><p>${vaults.some((vault) => vault.strategyId === strategy && vault.status === 'CLOSED') ? 'Your previous Vault is closed. You can create a new, separate Vault for this strategy. ' : ''}Your wallet creates and owns its own Vault. The subscription collection wallet cannot operate it.</p>${renderVaultFunding(state, strategy, drafts, actions, valuations)}</article>`,
    )
    .join(
      '',
    )}<button class="text-link" data-launch-refresh>Refresh chain state ↗</button>${vaultFlowQuote(state, actions) ? '' : renderQuote(state)}${renderExecutorReview(state)}${renderTransaction(state, actions)}</div>`;
}

export function renderExecutorReview(state: LaunchClientState): string {
  const review = state.executorReview;
  if (!review || review.kind !== 'REVOKE') return '';
  return `<section class="launch-reviewed sketch-box" aria-label="Reviewed Vault stop"><span class="section-label">OWNER WALLET · STOP VAULT</span><h2>${review.snapshot.strategyId} Vault</h2><dl class="order-quote">${row('Owner signing wallet', review.snapshot.owner)}${row('Vault contract', review.snapshot.vault)}${row('Permission removed', review.snapshot.grant.executor)}${row('Native ETH transferred', '0 ETH')}${row('Estimated gas', `${amount(review.gasEstimateRaw, 0)} gas`)}</dl><p>Confirm removal of the previous trading permission to continue. Your wallet must confirm this contract transaction.</p><button class="primary-btn" data-launch-executor-confirm ${state.busy ? 'disabled' : ''}>Confirm in wallet ↗</button><button class="text-link" data-launch-clear ${state.busy ? 'disabled' : ''}>Cancel review</button></section>`;
}
