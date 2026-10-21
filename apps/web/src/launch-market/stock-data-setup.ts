import type { LaunchClientState } from './model.ts';
import { escapeHtml as esc } from './presentation.ts';

export const STOCK_DATA_ADMIN = '0x86767116cd40bf6b4f8cf88E08D11E38B04364Cf';
const endpoint = '/api/launch-market/operator/stock-data';
export interface StockDataStatus {
  saved: boolean;
  updatedAt: number | null;
  source: 'Alpaca IEX';
  readOnlyEnabled: boolean;
  tradingEnabled: false;
}
export interface StockDataSetupState {
  status: StockDataStatus | null;
  loading: boolean;
  busy: boolean;
  ready: boolean;
  error: string | null;
  notice: string | null;
}
export interface StockDataApi {
  read(current: () => boolean): Promise<{ status: StockDataStatus; nonce: string }>;
  save(
    input: { apiKey: string; apiSecret: string },
    nonce: string,
    current: () => boolean,
  ): Promise<StockDataStatus>;
}
class StockDataRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super('STOCK_DATA_REQUEST_FAILED');
    this.status = status;
  }
}
const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
export function stockDataAdmin(state: LaunchClientState): boolean {
  return (
    same(state.owner, STOCK_DATA_ADMIN) &&
    same(state.account?.wallet, STOCK_DATA_ADMIN) &&
    !!state.account &&
    !!state.wallet &&
    state.account.id === state.wallet.accountId
  );
}
const identity = (state: LaunchClientState) =>
  JSON.stringify([
    state.owner?.toLowerCase(),
    state.account?.id,
    state.account?.wallet?.toLowerCase(),
    state.wallet?.accountId,
  ]);
const validNonce = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value);
function status(value: unknown): StockDataStatus {
  const item = value as StockDataStatus;
  if (
    !item ||
    Object.keys(item).sort().join(',') !== 'readOnlyEnabled,saved,source,tradingEnabled,updatedAt' ||
    typeof item.saved !== 'boolean' ||
    item.source !== 'Alpaca IEX' ||
    typeof item.readOnlyEnabled !== 'boolean' ||
    item.tradingEnabled !== false ||
    !(item.updatedAt === null || (Number.isSafeInteger(item.updatedAt) && item.updatedAt >= 0))
  )
    throw new StockDataRequestError(503);
  return {
    saved: item.saved,
    updatedAt: item.updatedAt,
    source: 'Alpaca IEX',
    readOnlyEnabled: item.readOnlyEnabled,
    tradingEnabled: false,
  };
}
/** The selected session's CSRF token and one-use nonce are fetched separately from the submitted credentials. */
export function createStockDataApi(fetcher: typeof fetch = fetch): StockDataApi {
  const read = (path: string) =>
    fetcher(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
  const assertCurrent = (current: () => boolean) => {
    if (!current()) throw new StockDataRequestError(401);
  };
  return {
    async read(current) {
      assertCurrent(current);
      const response = await read(endpoint);
      assertCurrent(current);
      if (!response.ok) throw new StockDataRequestError(response.status);
      const value: unknown = await response.json();
      assertCurrent(current);
      const nonce = response.headers.get('x-stock-data-save-nonce');
      if (!validNonce(nonce)) throw new StockDataRequestError(503);
      return { status: status(value), nonce };
    },
    async save(input, nonce, current) {
      assertCurrent(current);
      const walletResponse = await read('/api/launch-market/wallet/test-session');
      assertCurrent(current);
      const wallet = walletResponse.ok
        ? ((await walletResponse.json()) as { identityKind?: string; csrfToken?: unknown })
        : null;
      assertCurrent(current);
      let csrf: unknown = wallet?.identityKind === 'WALLET_TEST' ? wallet.csrfToken : null;
      if (wallet?.identityKind !== 'WALLET_TEST') {
        const accountResponse = await read('/auth/me');
        assertCurrent(current);
        const account = accountResponse.ok
          ? ((await accountResponse.json()) as { authKind?: string; csrfToken?: unknown })
          : null;
        assertCurrent(current);
        csrf = account?.authKind === 'google' ? account.csrfToken : null;
      }
      if (typeof csrf !== 'string' || csrf.length < 16 || csrf.length > 256 || !validNonce(nonce))
        throw new StockDataRequestError(401);
      assertCurrent(current);
      const response = await fetcher(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          'X-Stock-Data-Save-Nonce': nonce,
        },
        body: JSON.stringify({ apiKey: input.apiKey, apiSecret: input.apiSecret }),
      });
      assertCurrent(current);
      if (!response.ok) throw new StockDataRequestError(response.status);
      const value: unknown = await response.json();
      assertCurrent(current);
      return status(value);
    },
  };
}
export function clearStockDataInputs(doc: Pick<Document, 'querySelectorAll'> = document): void {
  for (const input of doc.querySelectorAll<HTMLInputElement>('[data-stock-data-form] input[type="password"]'))
    input.value = '';
}
const errorMessage = (error: unknown): string => {
  const code = error instanceof StockDataRequestError ? error.status : 503;
  if (code === 401 || code === 403)
    return 'Sign in with the administrator wallet before saving market-data credentials.';
  if (code === 409)
    return 'The save request expired or another device updated these credentials. Review the current status, enter both values again and save.';
  if (code === 400 || code === 413)
    return 'Enter the API Key and Secret exactly as Alpaca provided them, without spaces. Both fields were cleared.';
  if (code === 429)
    return 'Too many save requests. Please wait, refresh the status, and enter the credentials again.';
  return 'The save result could not be confirmed. Both fields were cleared. Refresh the saved status before deciding whether to enter and save the credentials again.';
};

type StockDataLaunch = {
  readonly state: LaunchClientState;
  subscribe(listener: (state: LaunchClientState) => void): () => void;
};
export class StockDataSetupController {
  readonly #launch: StockDataLaunch;
  readonly #api: StockDataApi;
  readonly #render: () => void;
  readonly #document: Pick<Document, 'querySelectorAll'>;
  readonly #unsubscribe: () => void;
  #identity = '';
  #generation = 0;
  #nonce: string | null = null;
  #visible = false;
  #state: StockDataSetupState = {
    status: null,
    loading: false,
    busy: false,
    ready: false,
    error: null,
    notice: null,
  };
  constructor(
    launch: StockDataLaunch,
    options: { api?: StockDataApi; render: () => void; document?: Pick<Document, 'querySelectorAll'> },
  ) {
    this.#launch = launch;
    this.#api = options.api ?? createStockDataApi();
    this.#render = options.render;
    this.#document = options.document ?? document;
    this.#unsubscribe = launch.subscribe(() => {
      if (this.bind() && this.#visible && stockDataAdmin(launch.state)) void this.refresh();
    });
  }
  get state(): StockDataSetupState {
    return this.#state;
  }
  #emit(patch: Partial<StockDataSetupState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#render();
  }
  bind(): boolean {
    const next = identity(this.#launch.state);
    if (next === this.#identity) return false;
    this.#identity = next;
    this.#generation++;
    this.#nonce = null;
    clearStockDataInputs(this.#document);
    this.#state = { status: null, loading: false, busy: false, ready: false, error: null, notice: null };
    this.#render();
    return true;
  }
  show(visible: boolean): void {
    if (this.#visible === visible) return;
    this.#visible = visible;
    if (!visible) {
      this.#generation++;
      this.#nonce = null;
      clearStockDataInputs(this.#document);
      this.#state.ready = false;
      return;
    }
    if (stockDataAdmin(this.#launch.state)) void this.refresh();
  }
  async refresh(preserveError = false): Promise<void> {
    if (!this.#visible || !stockDataAdmin(this.#launch.state) || this.#state.busy || this.#state.loading)
      return;
    const generation = this.#generation;
    const current = () =>
      generation === this.#generation && this.#visible && stockDataAdmin(this.#launch.state);
    this.#nonce = null;
    this.#emit({ loading: true, ready: false, ...(preserveError ? {} : { error: null, notice: null }) });
    try {
      const result = await this.#api.read(current);
      if (!current()) return;
      this.#nonce = result.nonce;
      this.#emit({ status: result.status, ready: true });
    } catch (error) {
      if (current()) this.#emit({ error: errorMessage(error) });
    } finally {
      if (current()) this.#emit({ loading: false });
    }
  }
  async submit(form: HTMLFormElement): Promise<void> {
    if (this.#state.busy || this.#state.loading) {
      clearStockDataInputs(this.#document);
      return;
    }
    const fields = form.elements;
    let apiKey = (fields.namedItem('apiKey') as HTMLInputElement | null)?.value ?? '';
    let apiSecret = (fields.namedItem('apiSecret') as HTMLInputElement | null)?.value ?? '';
    clearStockDataInputs(this.#document);
    const generation = this.#generation,
      nonce = this.#nonce;
    const current = () =>
      generation === this.#generation && this.#visible && stockDataAdmin(this.#launch.state);
    if (!current() || !nonce || !apiKey || !apiSecret) {
      this.#emit({ error: 'Refresh the status, then enter both API credentials to save them.' });
      return;
    }
    this.#nonce = null;
    this.#emit({ busy: true, ready: false, error: null, notice: null });
    let renew = false;
    try {
      const saved = await this.#api.save({ apiKey, apiSecret }, nonce, current);
      if (current())
        this.#emit({
          status: saved,
          notice: saved.readOnlyEnabled
            ? 'Market-data credentials saved. Market-data reading is enabled. Real stock orders remain disabled.'
            : 'Market-data credentials saved. Market-data reading and real stock orders remain disabled.',
        });
      renew = true;
    } catch (error) {
      if (current()) this.#emit({ error: errorMessage(error) });
      renew = true;
    } finally {
      // Release the captured strings as soon as this explicit submission settles.
      // eslint-disable-next-line no-useless-assignment
      apiKey = '';
      // eslint-disable-next-line no-useless-assignment
      apiSecret = '';
      if (current()) {
        this.#emit({ busy: false });
        if (renew) await this.refresh(true);
      }
    }
  }
  dispose(): void {
    this.#generation++;
    this.#nonce = null;
    this.#visible = false;
    clearStockDataInputs(this.#document);
    this.#unsubscribe();
  }
}

export function stockDataSetupLink(launch: LaunchClientState): string {
  return stockDataAdmin(launch)
    ? '<p><a class="text-link" href="#/account/market-data">Market-data setup ↗</a></p>'
    : '';
}
export function renderStockDataSetup(
  launch: LaunchClientState,
  view: StockDataSetupState | undefined,
  connection: string,
  access: string,
): string {
  const allowed = stockDataAdmin(launch);
  const metadata = allowed ? view?.status : null;
  const pending = !!view?.busy || !!view?.loading;
  const signIn = launch.walletSignIn
    ? {
        CHECKING: 'Checking the wallet and requesting a sign-in message…',
        AWAITING_SIGNATURE:
          'Waiting for your wallet signature. Open your wallet extension or wallet app to review the message.',
        VERIFYING: 'Verifying your signature and completing sign-in…',
      }[launch.walletSignIn]
    : null;
  const feedback = `${signIn ? `<p class="launch-feedback" role="status" aria-live="polite">${esc(signIn)}</p>` : ''}${launch.error ? `<p class="form-error launch-feedback" role="alert">${esc(launch.error)}</p>` : ''}${launch.notice ? `<p class="launch-feedback" role="status">${esc(launch.notice)}</p>` : ''}`;
  return `<div class="wrap inner-page launch-market"><p><a class="text-link" href="#/account/trades">Back to my account ↗</a></p><header class="terminal-heading"><div><span class="section-label">ADMINISTRATOR</span><h1>Market-data setup</h1></div>${connection}</header>${feedback}${allowed ? '' : `${access}<section class="sketch-box"><h2>Administrator wallet required</h2><p>Connect and sign in with the project administrator wallet to save market-data credentials.</p><p class="small muted">Administrator: <span class="launch-hash">${STOCK_DATA_ADMIN}</span></p></section>`}${allowed ? `<section class="sketch-box wallet-funding"><h2>Alpaca market data</h2><p>Create or sign in to your Alpaca account, select the Paper Trading account, and generate an API Key and Secret in its dashboard.</p><p><a class="text-link" href="https://app.alpaca.markets/signup" target="_blank" rel="noopener noreferrer">Create an Alpaca account ↗</a> <a class="text-link" href="https://app.alpaca.markets/account/login" target="_blank" rel="noopener noreferrer">Open Alpaca dashboard ↗</a></p><dl class="order-quote"><div><dt>Credentials</dt><dd>${metadata ? (metadata.saved ? 'Saved on the server' : 'Not saved') : 'Reading current status…'}</dd></div>${metadata?.updatedAt ? `<div><dt>Last saved</dt><dd>${esc(new Date(metadata.updatedAt * 1000).toLocaleString('en-US'))}</dd></div>` : ''}<div><dt>Market-data reading</dt><dd>${metadata ? (metadata.readOnlyEnabled ? 'Enabled' : 'Disabled') : 'Reading status…'}</dd></div><div><dt>Real stock orders</dt><dd>Disabled</dd></div></dl>${view?.error ? `<p class="form-error" role="alert">${esc(view.error)}</p>` : ''}${view?.notice ? `<p role="status">${esc(view.notice)}</p>` : ''}<form data-stock-data-form autocomplete="off"><label for="stock-data-key">API Key</label><input id="stock-data-key" name="apiKey" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="1024" value="" ${pending ? 'disabled' : ''} required><label for="stock-data-secret">API Secret</label><input id="stock-data-secret" name="apiSecret" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="1024" value="" ${pending ? 'disabled' : ''} required><p class="small muted">Only enter Alpaca API credentials. Never enter a wallet private key or recovery phrase. The app uses these credentials to read market data and sends no real stock orders.</p><button class="primary-btn" type="submit" ${pending || !view?.ready ? 'disabled' : ''}>${view?.busy ? 'Saving…' : 'Save credentials'} ↗</button></form><button class="text-link" type="button" data-stock-data-refresh ${pending ? 'disabled' : ''}>Refresh saved status ↗</button></section>` : ''}</div>`;
}
