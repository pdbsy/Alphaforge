import { hexlify, toUtf8Bytes } from 'ethers';
import {
  stockConsentMessage,
  validateStockConsent,
  verifyStockConsent,
  type SignedStockConsent,
  type StockAutomationConsent,
  type StockPolicy,
} from '../../../server/src/launch-market-adapters/stock-worker-policy.ts';
import { createCommunityApi, type CommunityApi } from '../community/client.ts';
import type { Eip1193Provider } from '../chain-wallet.ts';
import type { LaunchClientState, StrategyId } from './model.ts';
import type { StockExecutionSnapshot } from './stock-execution.ts';
import { actionable, escapeHtml as esc, inputRaw, rawAmount } from './presentation.ts';

export interface AutomationStatus {
  schemaVersion: 1;
  available: boolean;
  reason: 'READY' | 'NOT_CONFIGURED' | 'WORKER_INACTIVE' | 'STATUS_STALE' | 'MARKET_UNAVAILABLE';
  executor: string | null;
  manifestDigest: string | null;
  observedAt: number;
  readiness: { strategyId: StrategyId; status: string }[];
}
export interface AutomationSession {
  digest: string;
  signed: SignedStockConsent;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface AutomationRegistry {
  revision: number;
  sessions: AutomationSession[];
}
export interface AutomationDraft {
  kind: 'BUY_AND_HOLD' | 'DCA' | 'EMA_CROSS';
  maxPosition: string;
  stopPrice: string;
  takePrice: string;
  validUntil: string;
  intervalMinutes: string;
  installment: string;
  fast: string;
  slow: string;
}
export interface AutomationState {
  status: AutomationStatus | null;
  registry: AutomationRegistry | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  review: { consent: StockAutomationConsent; revision: number; expiresAt: number } | null;
  drafts: Partial<Record<StrategyId, AutomationDraft>>;
}
export interface AutomationLaunch {
  readonly state: LaunchClientState;
  refreshStock(strategy: StrategyId): Promise<void>;
}
const base = '/api/launch-market/automation';
const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
const timestamp = (seconds: number) => esc(new Date(seconds * 1000).toISOString());
const identity = (state: LaunchClientState) =>
  [
    state.owner?.toLowerCase(),
    state.account?.id,
    state.account?.wallet?.toLowerCase(),
    state.wallet?.accountId,
  ].join('/');
const linked = (state: LaunchClientState) =>
  !!state.owner &&
  !!state.account &&
  state.account.id === state.wallet?.accountId &&
  same(state.owner, state.account.wallet);

export function automationUnavailable(
  launch: LaunchClientState,
  state: AutomationState,
  strategy: StrategyId,
  now = Math.floor(Date.now() / 1000),
): string | null {
  const status = state.status;
  if (!status) return 'Refresh to check verified stock market data and the execution service.';
  if (!status.available || status.reason !== 'READY') {
    const messages: Record<AutomationStatus['reason'], string> = {
      READY: 'The automation service is unavailable.',
      NOT_CONFIGURED:
        'Automated trading is unavailable until verified stock market data and the execution service are connected.',
      WORKER_INACTIVE: 'The automation worker is not running. Start is unavailable.',
      STATUS_STALE: 'The automation worker status has expired. Refresh after the worker recovers.',
      MARKET_UNAVAILABLE:
        'Stock prices or the regular trading session are unavailable. Start waits for fresh verified market data.',
    };
    return messages[status.reason] ?? 'The automation service is unavailable.';
  }
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(status.executor ?? '') ||
    !/^0x[0-9a-fA-F]{64}$/.test(status.manifestDigest ?? '')
  )
    return 'The automation executor or deployment identity is missing.';
  if (
    !Number.isSafeInteger(status.observedAt) ||
    status.observedAt > now + 30 ||
    now - status.observedAt > 20
  )
    return 'The automation status has expired. Refresh before reviewing Start.';
  if (status.readiness.find((route) => route.strategyId === strategy)?.status !== 'READY')
    return `The ${strategy} stock route is not ready. Fresh prices, trading hours and reserve liquidity are required.`;
  if (!linked(launch) || !actionable(launch, strategy, 'DEPOSIT', 'AF_USDC'))
    return 'Connect the Vault owner wallet and sign in before starting automation.';
  if (!state.registry) return 'Refresh your automation authorizations before continuing.';
  const snapshot = launch.stockSnapshots?.[strategy];
  const vault = launch.wallet?.vaults.find(
    (entry) => entry.strategyId === strategy && entry.status === 'OPEN',
  );
  if (
    !snapshot ||
    !vault ||
    snapshot.closed ||
    !same(snapshot.owner, launch.owner) ||
    !same(snapshot.vault, vault.address)
  )
    return 'Refresh the stock price and current Vault permission before reviewing Start.';
  if (
    snapshot.status !== 'READY' ||
    snapshot.executionCutoff === null ||
    snapshot.executionCutoff <= now ||
    now - snapshot.blockTimestamp > 60
  )
    return 'The stock price or current Vault permission has expired. Refresh before reviewing Start.';
  if (!same(snapshot.grant.executor, status.executor))
    return 'Configure this Vault’s executor permission for the exact automation executor shown below, then refresh.';
  try {
    if (
      BigInt(snapshot.grant.expiresAt) <= BigInt(now + 60) ||
      BigInt(snapshot.grant.maxOrderUsdc) <= 0n ||
      BigInt(snapshot.grant.maxTotalBuyUsdc) <= BigInt(snapshot.totalBuyUsdc)
    )
      return 'The executor permission has expired or has no remaining buy allowance. Review its limits before starting.';
  } catch {
    return 'The executor permission could not be verified. Refresh before starting.';
  }
  return null;
}

export function automationDraft(): AutomationDraft {
  return {
    kind: 'BUY_AND_HOLD',
    maxPosition: '',
    stopPrice: '',
    takePrice: '',
    validUntil: '',
    intervalMinutes: '1440',
    installment: '',
    fast: '12',
    slow: '26',
  };
}

export function automationConsent(
  status: AutomationStatus,
  snapshot: StockExecutionSnapshot,
  draft: AutomationDraft,
  nonce: string,
  now = Math.floor(Date.now() / 1000),
): StockAutomationConsent {
  const money = (value: string) => inputRaw('DEPOSIT', 'AF_USDC', value);
  let policy: StockPolicy;
  if (draft.kind === 'BUY_AND_HOLD') policy = { kind: 'BUY_AND_HOLD' };
  else if (draft.kind === 'DCA')
    policy = {
      kind: 'DCA',
      intervalSeconds: Number(draft.intervalMinutes) * 60,
      installmentUsdcRaw: money(draft.installment),
    };
  else if (draft.kind === 'EMA_CROSS')
    policy = { kind: 'EMA_CROSS', fast: Number(draft.fast), slow: Number(draft.slow) };
  else throw new Error('Choose a supported policy.');
  const consent: StockAutomationConsent = {
    schemaVersion: 1,
    chainId: 46630,
    manifestDigest: status.manifestDigest!,
    owner: snapshot.owner,
    vault: snapshot.vault,
    strategyId: snapshot.strategyId,
    initialVersion: snapshot.version,
    grant: { ...snapshot.grant },
    policy,
    validUntil: Math.floor(new Date(draft.validUntil).getTime() / 1000),
    maxPositionUsdcRaw: money(draft.maxPosition),
    stopPriceUsdcRaw: draft.stopPrice.trim() ? money(draft.stopPrice) : '0',
    takePriceUsdcRaw: draft.takePrice.trim() ? money(draft.takePrice) : '0',
    nonce,
  };
  validateStockConsent(consent);
  if (consent.validUntil <= now + 60)
    throw new Error('Choose an authorization expiry at least one minute in the future.');
  return consent;
}

export class AutomationController {
  readonly state: AutomationState = {
    status: null,
    registry: null,
    busy: false,
    error: null,
    notice: null,
    review: null,
    drafts: {},
  };
  readonly launch: AutomationLaunch;
  readonly provider: Eip1193Provider | undefined;
  readonly api: CommunityApi;
  #identity = '';
  #generation = 0;
  #loading = false;
  #render: () => void;
  constructor(
    launch: AutomationLaunch,
    provider?: Eip1193Provider,
    api = createCommunityApi(),
    render = () => {},
  ) {
    this.launch = launch;
    this.provider = provider;
    this.api = api;
    this.#render = render;
    this.bind();
  }
  bind(): boolean {
    const next = identity(this.launch.state);
    if (next === this.#identity) return false;
    this.#identity = next;
    ++this.#generation;
    Object.assign(this.state, {
      registry: null,
      review: null,
      busy: false,
      error: null,
      notice: null,
      drafts: {},
    });
    return true;
  }
  async #status(): Promise<AutomationStatus> {
    const status = await this.api<AutomationStatus>(`${base}/status`);
    if (
      !status ||
      status.schemaVersion !== 1 ||
      typeof status.available !== 'boolean' ||
      !['READY', 'NOT_CONFIGURED', 'WORKER_INACTIVE', 'STATUS_STALE', 'MARKET_UNAVAILABLE'].includes(
        status.reason,
      ) ||
      !Array.isArray(status.readiness) ||
      status.readiness.some(
        (route) => !route || !['TSLA', 'AMZN'].includes(route.strategyId) || typeof route.status !== 'string',
      )
    )
      throw new Error('The automation status could not be verified. Refresh and try again.');
    return status;
  }
  async #registry(): Promise<AutomationRegistry> {
    const registry = await this.api<AutomationRegistry>(`${base}/sessions`);
    if (
      !registry ||
      !Number.isSafeInteger(registry.revision) ||
      registry.revision < 0 ||
      !Array.isArray(registry.sessions) ||
      registry.sessions.some(
        (entry) =>
          !entry ||
          !/^0x[0-9a-fA-F]{64}$/.test(entry.digest) ||
          !entry.signed?.consent ||
          typeof entry.signed.consent.owner !== 'string' ||
          !['TSLA', 'AMZN'].includes(entry.signed.consent.strategyId) ||
          !entry.signed.consent.policy ||
          !Number.isSafeInteger(entry.signed.consent.validUntil),
      )
    )
      throw new Error('Your automation authorizations could not be verified. Refresh and try again.');
    return registry;
  }
  async refresh(strategy?: StrategyId): Promise<void> {
    if (this.#loading || this.state.busy) return;
    this.bind();
    const generation = this.#generation;
    this.#loading = true;
    try {
      const [status, registry] = await Promise.all([
        this.#status(),
        linked(this.launch.state) ? this.#registry() : Promise.resolve(null),
      ]);
      if (generation !== this.#generation) return;
      this.state.status = status;
      this.state.registry = registry;
      this.state.error = null;
      if (strategy && linked(this.launch.state) && status.available) {
        try {
          await this.launch.refreshStock(strategy);
        } catch {
          if (generation === this.#generation)
            this.state.error =
              'The current stock price or Vault permission could not be verified. Refresh and try again.';
        }
      }
    } catch (error) {
      if (generation !== this.#generation) return;
      this.state.status = null;
      this.state.registry = null;
      this.state.error = automationError(error);
    } finally {
      this.#loading = false;
      if (generation === this.#generation) this.#render();
    }
  }
  async review(strategy: StrategyId, draft: AutomationDraft): Promise<void> {
    this.state.drafts[strategy] = draft;
    await this.refresh(strategy);
    const unavailable = automationUnavailable(this.launch.state, this.state, strategy);
    if (unavailable) throw new Error(unavailable);
    const consent = automationConsent(
      this.state.status!,
      this.launch.state.stockSnapshots![strategy]!,
      draft,
      crypto.randomUUID(),
    );
    this.state.review = {
      consent,
      revision: this.state.registry!.revision,
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    };
  }
  async #assertWallet(generation: number, requireChain = true): Promise<void> {
    if (!this.provider) throw new Error('Connect the Vault owner browser wallet.');
    const [accounts, chain] = await Promise.all([
      this.provider.request({ method: 'eth_accounts' }),
      requireChain ? this.provider.request({ method: 'eth_chainId' }) : Promise.resolve('0xb626'),
    ]);
    if (
      generation !== this.#generation ||
      !Array.isArray(accounts) ||
      !same(String(accounts[0]), this.launch.state.owner) ||
      BigInt(String(chain)) !== 46630n
    )
      throw new Error('The wallet or network changed. Refresh and review Start again.');
  }
  async #assertReview(review: NonNullable<AutomationState['review']>, generation: number): Promise<void> {
    await this.#assertWallet(generation);
    const [status, registry] = await Promise.all([this.#status(), this.#registry()]);
    if (generation !== this.#generation) throw new Error('The wallet session changed. Review Start again.');
    this.state.status = status;
    this.state.registry = registry;
    await this.launch.refreshStock(review.consent.strategyId);
    if (generation !== this.#generation) throw new Error('The wallet session changed. Review Start again.');
    const now = Math.floor(Date.now() / 1000);
    const unavailable = automationUnavailable(this.launch.state, this.state, review.consent.strategyId, now);
    if (unavailable) throw new Error(unavailable);
    const snapshot = this.launch.state.stockSnapshots![review.consent.strategyId]!;
    if (
      now >= review.expiresAt ||
      now >= review.consent.validUntil ||
      registry.revision !== review.revision ||
      !same(status.executor, review.consent.grant.executor) ||
      status.manifestDigest !== review.consent.manifestDigest ||
      !same(snapshot.owner, review.consent.owner) ||
      !same(snapshot.vault, review.consent.vault) ||
      snapshot.version !== review.consent.initialVersion ||
      JSON.stringify(snapshot.grant) !== JSON.stringify(review.consent.grant)
    )
      throw new Error('The reviewed authorization changed or expired. Refresh and review Start again.');
    await this.#assertWallet(generation);
  }
  async confirm(): Promise<void> {
    const review = this.state.review;
    if (!review || this.state.busy) return;
    const generation = this.#generation;
    this.state.busy = true;
    this.state.error = null;
    this.#render();
    try {
      await this.#assertReview(review, generation);
      const signature = await this.provider!.request({
        method: 'personal_sign',
        params: [hexlify(toUtf8Bytes(stockConsentMessage(review.consent))), review.consent.owner],
      });
      if (typeof signature !== 'string') throw new Error('The wallet returned an invalid signature.');
      const signed = { consent: review.consent, signature };
      verifyStockConsent(signed);
      await this.#assertReview(review, generation);
      const registry = await this.api<AutomationRegistry>(`${base}/start`, 'POST', {
        signed,
        expectedRevision: review.revision,
      });
      if (generation !== this.#generation) return;
      this.state.registry = registry;
      this.state.review = null;
      this.state.notice =
        'Your automation authorization was saved. Trades remain subject to verified market data and your Vault limits.';
    } catch (error) {
      if (generation === this.#generation) {
        this.state.error = automationError(error);
        this.state.review = null;
      }
    } finally {
      if (generation === this.#generation) {
        this.state.busy = false;
        this.#render();
      }
    }
  }
  async pause(digest: string): Promise<void> {
    if (this.state.busy || !linked(this.launch.state)) return;
    const generation = this.#generation;
    this.state.busy = true;
    this.state.error = null;
    this.#render();
    try {
      await this.#assertWallet(generation, false);
      const registry = await this.#registry();
      if (generation !== this.#generation) return;
      if (
        !registry.sessions.some(
          (entry) =>
            entry.active &&
            entry.digest === digest &&
            same(entry.signed.consent.owner, this.launch.state.owner),
        )
      )
        throw new Error('This authorization is no longer active. Refresh your Vault.');
      const next = await this.api<AutomationRegistry>(`${base}/pause`, 'POST', {
        digest,
        expectedRevision: registry.revision,
      });
      if (generation !== this.#generation) return;
      this.state.registry = next;
      this.state.review = null;
      this.state.notice =
        'Automation paused. This stops new orders; an order already submitted to the chain may still settle.';
    } catch (error) {
      if (generation === this.#generation) this.state.error = automationError(error);
    } finally {
      if (generation === this.#generation) {
        this.state.busy = false;
        this.#render();
      }
    }
  }
}

function automationError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const codes: Record<string, string> = {
    STOCK_AUTOMATION_UNAVAILABLE:
      'Automation is unavailable. Refresh when the stock feed and executor service are ready.',
    STOCK_CONSENT_STATE_CHANGED:
      'Your Vault permission or execution version changed. Refresh and review Start again.',
    STOCK_CONSENT_INVALID: 'The owner authorization could not be verified. Review it again in your wallet.',
    LINKED_WALLET_REQUIRED: 'Sign in with the Vault owner wallet to continue.',
    ACCOUNT_SESSION_REQUIRED: 'Sign in with your wallet again before continuing.',
    STOCK_POLICY_LIMITS: 'Check the position cap, executor limits and authorization expiry.',
    STOCK_POLICY_THRESHOLDS: 'The stop price must be lower than the take-profit price.',
  };
  if (codes[message]) return codes[message];
  return /^[A-Z][A-Z0-9_]+$/.test(message) ||
    !message ||
    /Read-only|eth_|RPC|https?:|0x[0-9a-f]{40}/i.test(message)
    ? 'The automation request could not be completed. Refresh and try again.'
    : message;
}

const row = (label: string, value: string) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
export function renderAutomation(
  launch: LaunchClientState,
  state: AutomationState,
  strategy: StrategyId,
): string {
  const unavailable = automationUnavailable(launch, state, strategy);
  const draft = state.drafts[strategy] ?? automationDraft();
  const snapshot = launch.stockSnapshots?.[strategy];
  const sessions =
    state.registry?.sessions.filter(
      (entry) =>
        entry.signed.consent.strategyId === strategy && same(entry.signed.consent.owner, launch.owner),
    ) ?? [];
  const active = sessions.filter(
    (entry) => entry.active && entry.signed.consent.validUntil > Math.floor(Date.now() / 1000),
  );
  const input = (name: keyof AutomationDraft, label: string, type = 'text', required = false) =>
    `<label for="automation-${strategy}-${name}">${esc(label)}</label><input id="automation-${strategy}-${name}" name="${name}" type="${type}" ${type === 'text' ? 'inputmode="decimal"' : ''} value="${esc(draft[name])}" ${required ? 'required' : ''}>`;
  return `<section class="launch-automation" aria-label="${strategy} automation"><h3>Automatic stock strategy</h3><p>Choose a policy and approve its limits with your Vault owner wallet. The executor can trade ${strategy} stock holdings while verified market data and your permission remain valid.</p><p class="small muted" role="status">${esc(unavailable ?? 'The stock route and authorized executor are ready. Review your policy before Start.')}</p>${state.error ? `<p class="form-error" role="alert">${esc(state.error)}</p>` : ''}${state.notice ? `<p class="launch-feedback" role="status">${esc(state.notice)}</p>` : ''}<dl class="order-quote">${row('Automation service', state.status?.available ? 'Available' : 'Unavailable')}${row('Exact executor', state.status?.executor ?? 'Not configured')}${row('Stock route', state.status?.readiness.find((route) => route.strategyId === strategy)?.status.replaceAll('_', ' ') ?? 'Not checked')}${snapshot ? `${row('Permission expiry', new Date(Number(snapshot.grant.expiresAt) * 1000).toISOString())}${row('Per-order cap', `${rawAmount(snapshot.grant.maxOrderUsdc, 6)} AF-USDC`)}${row('Cumulative buy cap', `${rawAmount(snapshot.grant.maxTotalBuyUsdc, 6)} AF-USDC`)}${row('Buy allowance used', `${rawAmount(snapshot.totalBuyUsdc, 6)} AF-USDC`)}${row('Maximum slippage', `${snapshot.grant.maxSlippageBps / 100}%`)}` : ''}</dl><button class="text-link" data-automation-refresh="${strategy}" ${state.busy || launch.busy ? 'disabled' : ''}>Refresh automation & permission ↗</button>${active.map((entry) => `<div class="launch-automation-session"><strong>Active · ${esc(entry.signed.consent.policy.kind.replaceAll('_', ' '))}</strong><p class="small muted">Authorized until ${timestamp(entry.signed.consent.validUntil)} · ${rawAmount(entry.signed.consent.maxPositionUsdcRaw, 6)} AF-USDC position cap</p><button class="outline-btn" data-automation-pause="${esc(entry.digest)}" ${state.busy ? 'disabled' : ''}>Pause automation ↗</button></div>`).join('')}<details data-automation-options="${strategy}"><summary>Choose policy & limits</summary><form data-automation-policy="${strategy}"><label for="automation-${strategy}-kind">Policy</label><select id="automation-${strategy}-kind" name="kind">${(['BUY_AND_HOLD', 'DCA', 'EMA_CROSS'] as const).map((kind) => `<option value="${kind}" ${kind === draft.kind ? 'selected' : ''}>${kind === 'BUY_AND_HOLD' ? 'Buy and hold' : kind === 'DCA' ? 'Recurring investment' : 'EMA crossover'}</option>`).join('')}</select>${input('maxPosition', 'Maximum stock position · AF-USDC at reference price', 'text', true)}${input('validUntil', 'Authorization expiry · your local time', 'datetime-local', true)}${input('stopPrice', 'Stop price · AF-USDC per stock unit (optional)')}${input('takePrice', 'Take-profit price · AF-USDC per stock unit (optional)')}<div data-automation-dca ${draft.kind === 'DCA' ? '' : 'hidden'}>${input('installment', 'AF-USDC per installment')}${input('intervalMinutes', 'Interval · minutes (1–44,640)', 'number')}</div><div data-automation-ema ${draft.kind === 'EMA_CROSS' ? '' : 'hidden'}>${input('fast', 'Fast EMA · minute bars (2–119)', 'number')}${input('slow', 'Slow EMA · minute bars (3–120)', 'number')}</div><p class="small muted">Stops and take-profit use the stock reference price. They can execute only when the market and liquidity are available; they do not guarantee a fill price.</p><button type="submit" class="primary-btn" ${unavailable || state.busy || active.length ? 'disabled' : ''}>Review Start ↗</button></form></details><p class="small muted">Executor permission is configured in Strategy trading & executor settings below. Pause stops new automated orders; revoking on-chain permission removes the executor’s trading authority.</p></section>`;
}

export function renderAutomationReview(state: AutomationState): string {
  const c = state.review?.consent;
  if (!c) return '';
  return `<section class="launch-reviewed"><span class="section-label">OWNER AUTHORIZATION</span><h2>Start ${esc(c.strategyId)} automation</h2><dl class="order-quote">${row('Vault owner', c.owner)}${row('Vault', c.vault)}${row('Exact executor', c.grant.executor)}${row('Policy', c.policy.kind.replaceAll('_', ' '))}${row('Position cap', `${rawAmount(c.maxPositionUsdcRaw, 6)} AF-USDC`)}${c.policy.kind === 'DCA' ? `${row('Installment', `${rawAmount(c.policy.installmentUsdcRaw, 6)} AF-USDC`)}${row('Interval', `${c.policy.intervalSeconds / 60} minutes`)}` : c.policy.kind === 'EMA_CROSS' ? row('Minute-bar EMA periods', `${c.policy.fast} / ${c.policy.slow}`) : ''}${row('Stop price', c.stopPriceUsdcRaw === '0' ? 'Disabled' : `${rawAmount(c.stopPriceUsdcRaw, 6)} AF-USDC`)}${row('Take-profit price', c.takePriceUsdcRaw === '0' ? 'Disabled' : `${rawAmount(c.takePriceUsdcRaw, 6)} AF-USDC`)}${row('Per-order cap', `${rawAmount(c.grant.maxOrderUsdc, 6)} AF-USDC`)}${row('Cumulative buy cap', `${rawAmount(c.grant.maxTotalBuyUsdc, 6)} AF-USDC`)}${row('Maximum slippage', `${c.grant.maxSlippageBps / 100}%`)}${row('Executor permission expires', new Date(Number(c.grant.expiresAt) * 1000).toISOString())}${row('Automation expires', new Date(c.validUntil * 1000).toISOString())}${row('Vault execution version', c.initialVersion)}${row('Deployment digest', c.manifestDigest)}${row('Authorization nonce', c.nonce)}</dl><p>Your wallet signs this authorization. The named executor may then trade this Vault under these limits. Stock prices can fall; available market hours and liquidity affect execution.</p><button class="primary-btn" data-automation-confirm ${state.busy ? 'disabled' : ''}>Authorize Start in owner wallet ↗</button><button class="text-link" data-automation-cancel ${state.busy ? 'disabled' : ''}>Cancel</button></section>`;
}

export function installAutomation(
  launch: AutomationLaunch,
  provider: Eip1193Provider | undefined,
  host: { app: { openDialog(html: string): void; closeDialog(): void } },
  render: () => void,
): AutomationController {
  const controller = new AutomationController(launch, provider, undefined, render);
  const run = (action: () => Promise<void>) => {
    void action().catch((error) => {
      controller.state.error = automationError(error);
      render();
    });
  };
  document.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>(
      '[data-automation-refresh],[data-automation-confirm],[data-automation-cancel],[data-automation-pause]',
    );
    if (!button || button.hasAttribute('disabled') || controller.state.busy) return;
    event.preventDefault();
    const strategy = button.dataset.automationRefresh;
    if (strategy === 'TSLA' || strategy === 'AMZN') run(() => controller.refresh(strategy));
    else if (button.hasAttribute('data-automation-cancel')) {
      controller.state.review = null;
      host.app.closeDialog();
    } else if (button.hasAttribute('data-automation-confirm'))
      run(async () => {
        await controller.confirm();
        host.app.closeDialog();
      });
    else if (button.dataset.automationPause) run(() => controller.pause(button.dataset.automationPause!));
  });
  const draftFrom = (form: HTMLFormElement) => {
    const draft = automationDraft();
    const fields = new FormData(form);
    for (const key of Object.keys(draft) as (keyof AutomationDraft)[])
      Object.assign(draft, { [key]: String(fields.get(key) ?? '') });
    return draft;
  };
  document.addEventListener('input', (event) => {
    const form = (event.target as Element | null)?.closest<HTMLFormElement>('[data-automation-policy]');
    const strategy = form?.dataset.automationPolicy;
    if (!form || (strategy !== 'TSLA' && strategy !== 'AMZN')) return;
    controller.state.drafts[strategy] = draftFrom(form);
  });
  document.addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement;
    const form = select.closest?.<HTMLFormElement>('[data-automation-policy]');
    if (select.name !== 'kind' || !form) return;
    const dca = form.querySelector<HTMLElement>('[data-automation-dca]');
    const ema = form.querySelector<HTMLElement>('[data-automation-ema]');
    if (dca) dca.hidden = select.value !== 'DCA';
    if (ema) ema.hidden = select.value !== 'EMA_CROSS';
  });
  document.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement;
    const strategy = form.dataset?.automationPolicy;
    if (strategy !== 'TSLA' && strategy !== 'AMZN') return;
    event.preventDefault();
    run(async () => {
      await controller.review(strategy, draftFrom(form));
      host.app.openDialog(renderAutomationReview(controller.state));
    });
  });
  return controller;
}
