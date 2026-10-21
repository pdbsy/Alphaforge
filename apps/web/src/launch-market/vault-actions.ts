import { createCommunityApi, type CommunityApi } from '../community/client.ts';
import type { LaunchMarketClient } from './client.ts';
import type { StrategyId } from './model.ts';

type Step = 'CREATE' | 'DEPOSIT' | 'BUY' | 'REVOKE' | 'SELL' | 'CLOSE';
type Kind = 'DEPOSIT' | 'STOP' | 'WITHDRAW';
interface RunAction {
  executionMode?: 'PAPER' | 'CHAIN';
  actionId: string;
  kind: Kind;
  amountRaw: string;
  step: Step | null;
  stepAmountRaw: string;
  phase: string;
  cancelled: boolean;
  prepared: boolean;
  pending: { transactionHash: string | null; verified: boolean } | null;
  failure: string | null;
  expectedVersion: string | null;
}
interface RunState {
  schemaVersion: 1;
  executionMode: 'PAPER';
  owner: string;
  strategyId: StrategyId;
  vault: string | null;
  paused: boolean;
  revocationRequired: boolean | null;
  revision: number;
  action: RunAction | null;
  updatedAt: number;
}
export interface VaultActionsState {
  readonly flow: {
    readonly strategyId: StrategyId;
    readonly kind: Kind;
    readonly phase: string;
    readonly busy: boolean;
    readonly review: boolean;
    readonly pendingHash: string | null;
  } | null;
  readonly error: string | null;
  readonly notice: string | null;
  readonly paused: Partial<Record<StrategyId, boolean>>;
}
export type VaultActionsClient = Pick<
  LaunchMarketClient,
  | 'state'
  | 'subscribe'
  | 'review'
  | 'confirm'
  | 'reviewExecutorPermission'
  | 'confirmExecutorPermission'
  | 'clearQuote'
  | 'refresh'
  | 'refreshTransaction'
  | 'setSubmissionGuard'
> &
  Partial<Pick<LaunchMarketClient, 'refreshStock' | 'reviewStock'>>;
const terminal = new Set(['HOLDING', 'CLOSED', 'STOPPED', 'FAILED', 'PAUSED']);
const messages: Record<string, string> = {
  PAPER_REORG_REVIEW_REQUIRED:
    'Funding confirmation changed. New deposits are paused while this ledger is reconciled. Existing on-chain cash remains available for withdrawal.',
  PAPER_PRICE_UNAVAILABLE:
    'Authorized market data is not ready. Deposit cannot start a simulated position yet. Existing Vault cash can still be withdrawn.',
  PAPER_MARKET_CLOSED:
    'The stock market is closed. Start a simulated position after the next open with a fresh authorized quote.',
  PAPER_LEGACY_CHAIN_POSITION:
    'This Vault has an existing on-chain stock position. It must be resolved before this Vault can use the simulated ledger.',
  PAPER_WORKFLOW_MODE_REQUIRED:
    'An earlier on-chain workflow needs reconciliation. No simulated trade or new wallet transaction has been sent.',
  STOCK_REFERENCE_NOT_CONFIGURED:
    'Verified market data and price publishing are unavailable. No further deposit or stock transaction has been sent.',
  MARKET_CLOSED:
    'The stock market is closed. Your assets remain in the Vault; try again during an available trading session.',
  VAULT_RUN_REVISION_CONFLICT: 'This Vault changed on another device. Refresh before continuing.',
  VAULT_RUN_ACTION_PENDING: 'An earlier Vault operation is still awaiting a confirmed result.',
  VAULT_RUN_STEP_CHANGED: 'This operation was paused or changed. No further transaction was sent.',
  MARKET_ACTION_UNAVAILABLE:
    'The previous transaction is still being checked. Use Continue Vault steps to check its confirmation.',
  WALLET_REJECTED: 'Wallet confirmation cancelled. Confirmed deposits or holdings remain in your Vault.',
  VAULT_RUN_RECOVERY_REQUIRED:
    'The wallet result is uncertain. Recover the existing transaction before sending another.',
  VAULT_RUN_EXECUTOR_ACTIVE:
    'This Vault still has a trading permission. Use Stop and confirm its removal before depositing.',
  VAULT_RUN_VERSION_UNCONFIRMED:
    'A recent Vault change still needs chain confirmation. Refresh and review the step again.',
};
const errorText = (error: unknown): string => {
  const code = error instanceof Error ? error.message : 'VAULT_ACTION_UNAVAILABLE';
  return (
    messages[code] ??
    (/^[A-Z][A-Z0-9_]+$/.test(code)
      ? 'The Vault operation could not continue. Your confirmed assets remain unchanged. Refresh its status.'
      : code)
  );
};

/** One owner action at a time. Each transaction still requires an explicit wallet confirmation. */
export class VaultActionsController {
  readonly #client: VaultActionsClient;
  readonly #api: CommunityApi;
  readonly #listeners = new Set<(state: VaultActionsState) => void>();
  readonly #runs = new Map<StrategyId, RunState>();
  #identity = '';
  #generation = 0;
  #active: StrategyId | null = null;
  #working = false;
  #depositSequence: { strategyId: StrategyId; actionId: string; amountRaw: string } | null = null;
  #sequenceEpoch = 0;
  #review = false;
  #reviewIdentity: string | null = null;
  #guard: {
    strategyId: StrategyId;
    actionId: string;
    step: Step;
    revision: number;
    prepared: boolean;
    sequence: object | null;
  } | null = null;
  #approval: { strategyId: StrategyId; actionId: string; hash: string | null } | null = null;
  #handoff = false;
  #timer: (() => void) | null = null;
  readonly #scheduleTimer: (callback: () => void, delay: number) => () => void;
  #state: VaultActionsState = { flow: null, error: null, notice: null, paused: {} };
  constructor(
    client: VaultActionsClient,
    options: {
      api?: CommunityApi;
      now?: () => number;
      storage?: Storage;
      schedule?: (callback: () => void, delay: number) => () => void;
    } = {},
  ) {
    this.#client = client;
    this.#api = options.api ?? createCommunityApi();
    this.#scheduleTimer =
      options.schedule ??
      ((callback, delay) => {
        const timer = setTimeout(callback, delay);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    client.setSubmissionGuard(() => this.#beforeSend());
    client.subscribe(() => {
      this.bind();
      if (!this.#working && (this.#approval || this.#current()?.action?.pending || this.#paperPending()))
        this.#schedule();
    });
  }
  get state(): VaultActionsState {
    return this.#state;
  }
  subscribe(listener: (state: VaultActionsState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }
  #emit(patch: Partial<VaultActionsState> = {}): void {
    const run = this.#current(),
      action = run?.action;
    this.#state = {
      ...this.#state,
      ...patch,
      flow:
        action && run
          ? {
              strategyId: run.strategyId,
              kind: action.kind,
              phase:
                action.executionMode !== 'PAPER' && terminal.has(action.phase)
                  ? 'LEGACY_RESULT'
                  : run.paused && run.revocationRequired === null && terminal.has(action.phase)
                    ? 'BLOCKED'
                    : action.phase,
              busy: this.#working,
              review: this.#review,
              pendingHash: action.pending?.transactionHash ?? this.#approval?.hash ?? null,
            }
          : null,
      paused: Object.fromEntries(
        [...this.#runs].map(([id, value]) => [id, value.paused && value.revocationRequired === false]),
      ),
    };
    for (const listener of this.#listeners) listener(this.state);
  }
  bind(): boolean {
    const state = this.#client.state;
    const next = JSON.stringify([
      state.owner?.toLowerCase() ?? null,
      state.account?.id ?? null,
      state.account?.wallet?.toLowerCase() ?? null,
      state.config?.manifest ?? null,
    ]);
    if (next === this.#identity) return false;
    this.#identity = next;
    this.#generation++;
    this.cancelWalletSequence();
    this.#runs.clear();
    this.#active = null;
    this.#approval = null;
    this.#guard = null;
    this.#review = false;
    this.#reviewIdentity = null;
    this.#timer?.();
    this.#timer = null;
    this.#emit({ error: null, notice: null });
    return true;
  }
  #current(): RunState | undefined {
    return this.#active ? this.#runs.get(this.#active) : undefined;
  }
  #paperPending(): boolean {
    const run = this.#current();
    return !!run && run.action?.phase === 'PAPER_PENDING' && !run.paused && !run.action.cancelled;
  }
  #owner(): string {
    const state = this.#client.state;
    if (!state.owner || state.account?.wallet?.toLowerCase() !== state.owner.toLowerCase())
      throw new Error('LINKED_WALLET_REQUIRED');
    return state.owner.toLowerCase();
  }
  #adopt(value: unknown, id: StrategyId, generation: number): RunState {
    if (generation !== this.#generation) throw new Error('WALLET_IDENTITY_CHANGED');
    const item = value as { state?: RunState };
    const run = (item?.state ?? value) as RunState;
    if (
      !run ||
      run.schemaVersion !== 1 ||
      run.executionMode !== 'PAPER' ||
      run.strategyId !== id ||
      run.owner?.toLowerCase() !== this.#owner() ||
      typeof run.paused !== 'boolean' ||
      !Number.isSafeInteger(run.revision) ||
      run.revision < 0 ||
      (run.action &&
        (!['DEPOSIT', 'STOP', 'WITHDRAW'].includes(run.action.kind) ||
          typeof run.action.actionId !== 'string' ||
          !/^(0|[1-9][0-9]*)$/.test(run.action.stepAmountRaw)))
    )
      throw new Error('VAULT_RUN_RESPONSE_INVALID');
    const previous = this.#runs.get(id);
    if (previous && run.revision < previous.revision) throw new Error('VAULT_RUN_REVISION_CONFLICT');
    this.#runs.set(id, run);
    if (
      run.action &&
      (this.#active === null ||
        (terminal.has(this.#current()?.action?.phase ?? '') && !terminal.has(run.action.phase)))
    )
      this.#active = id;
    this.#emit();
    return run;
  }
  #path(id: StrategyId, action = ''): string {
    return `/api/launch-market/vault-run/${id}${action ? '/' + action : ''}`;
  }
  async #read(id: StrategyId): Promise<RunState> {
    const generation = this.#generation;
    return this.#adopt(await this.#api(this.#path(id, 'state')), id, generation);
  }
  async #write(id: StrategyId, action: string, body: Record<string, unknown>): Promise<RunState> {
    const generation = this.#generation;
    return this.#adopt(await this.#api(this.#path(id, action), 'POST', body), id, generation);
  }
  async refresh(id?: StrategyId): Promise<void> {
    this.bind();
    if (
      !this.#client.state.owner ||
      this.#client.state.account?.wallet?.toLowerCase() !== this.#client.state.owner.toLowerCase()
    )
      return;
    try {
      for (const selected of id ? [id] : (['TSLA', 'AMZN'] as const)) await this.#read(selected);
      this.#emit({ error: null });
      if (this.#current()?.action?.pending || this.#paperPending()) this.#schedule();
    } catch (error) {
      this.#emit({ error: errorText(error) });
    }
  }
  cancelWalletSequence(): void {
    this.#depositSequence = null;
    this.#sequenceEpoch++;
  }
  async #task(work: () => Promise<void>): Promise<void> {
    if (this.#working) throw new Error('VAULT_RUN_ACTION_PENDING');
    this.#working = true;
    this.#emit({ error: null });
    try {
      await work();
    } catch (error) {
      this.cancelWalletSequence();
      this.#emit({ error: errorText(error) });
      throw error;
    } finally {
      this.#working = false;
      this.#emit();
    }
    // Only the explicit Deposit gesture authorizes this in-memory sequence.
    // Every transaction still goes through wallet confirmation and the submission guard.
    const sequence = this.#depositSequence,
      run = this.#current(),
      action = run?.action;
    if (sequence) {
      if (
        !run ||
        !action ||
        sequence.strategyId !== run.strategyId ||
        sequence.actionId !== action.actionId ||
        sequence.amountRaw !== action.amountRaw ||
        run.paused ||
        action.cancelled ||
        action.kind !== 'DEPOSIT' ||
        action.executionMode !== 'PAPER' ||
        !action.step ||
        !['CREATE', 'DEPOSIT'].includes(action.step) ||
        (action.step === 'DEPOSIT' && action.stepAmountRaw !== sequence.amountRaw) ||
        (action.step === 'CREATE' && action.stepAmountRaw !== '0') ||
        terminal.has(action.phase)
      ) {
        this.cancelWalletSequence();
      } else if (this.#review && !this.#client.state.busy && !action.pending && !action.prepared) {
        await this.confirm();
      }
    }
  }
  async deposit(id: StrategyId, amountRaw: string, confirmInWallet = false): Promise<void> {
    return this.#task(async () => {
      this.bind();
      this.#owner();
      if (!/^[1-9][0-9]*$/.test(amountRaw)) throw new Error('INVALID_VAULT_RUN_INPUT');
      const epoch = this.#sequenceEpoch;
      const run = await this.#read(id);
      this.#active = id;
      const existing = run.action;
      const resume =
        confirmInWallet &&
        existing?.kind === 'DEPOSIT' &&
        existing.executionMode === 'PAPER' &&
        existing.phase === 'READY' &&
        existing.amountRaw === amountRaw &&
        !existing.cancelled &&
        !existing.prepared &&
        !existing.pending &&
        !run.paused;
      const started = resume
        ? run
        : await this.#write(id, 'deposit', {
            actionId: crypto.randomUUID(),
            expectedRevision: run.revision,
            amountRaw,
          });
      if (confirmInWallet && epoch === this.#sequenceEpoch && started.action) {
        this.#depositSequence = { strategyId: id, actionId: started.action.actionId, amountRaw };
      }
      await this.#reviewNext();
    });
  }
  async withdraw(id: StrategyId): Promise<void> {
    this.cancelWalletSequence();
    return this.#task(async () => {
      this.bind();
      this.#owner();
      const run = await this.#read(id);
      this.#active = id;
      await this.#write(id, 'withdraw', { actionId: crypto.randomUUID(), expectedRevision: run.revision });
      await this.#reviewNext();
    });
  }
  async stop(id: StrategyId): Promise<void> {
    this.cancelWalletSequence();
    this.#timer?.();
    this.#timer = null;
    // Stop must remain accessible while another device/wallet is waiting. It
    // cannot cancel a transaction already handed to the wallet or broadcast.
    this.bind();
    this.#owner();
    const previous = this.#runs.get(id) ?? { revision: 0 };
    this.#active = id;
    const generation = this.#generation;
    const result = await this.#api<{
      state: RunState;
      automationPaused: boolean;
      revocationObserved: boolean;
    }>(this.#path(id, 'stop'), 'POST', { expectedRevision: previous.revision });
    const stopped = this.#adopt(result, id, generation);
    if (!this.#client.state.busy) this.#client.clearQuote();
    this.#review = false;
    const run = this.#current();
    this.#emit({
      error: null,
      notice:
        !result.automationPaused || !result.revocationObserved || stopped.revocationRequired === null
          ? 'Pause saved. Existing automation permissions could not be fully verified. Use Stop again to verify and remove them before further trading.'
          : stopped.revocationRequired
            ? 'Pause saved. Confirm removal of the existing trading permission to finish stopping execution.'
            : run?.action?.pending || run?.action?.prepared
              ? 'Future steps are paused. A transaction already handed to your wallet still needs its result confirmed.'
              : 'New simulated trades are paused. Existing simulated holdings remain recorded, and deposited funds remain in your Vault.',
    });
    if (!this.#working && run?.action?.phase === 'READY') await this.#task(() => this.#reviewNext());
    if (run?.action?.pending) this.#schedule();
  }
  async #reviewNext(): Promise<void> {
    const run = this.#current(),
      action = run?.action;
    this.#review = false;
    this.#reviewIdentity = null;
    if (!run || !action || action.phase !== 'READY' || !action.step || action.pending || action.prepared)
      return;
    if (run.paused && action.kind === 'DEPOSIT') return;
    const waiting = () =>
      ['AWAITING_WALLET', 'SUBMITTED', 'INCLUDED', 'CONFIRMED_L2', 'REORGED', 'RECOVERY_REQUIRED'].includes(
        this.#client.state.transaction.state,
      );
    if (waiting()) {
      await this.#client.refreshTransaction();
      if (waiting()) {
        this.#emit({
          notice:
            'Waiting for the previous wallet transaction to be confirmed. Deposit will continue after confirmation.',
        });
        // A workflow can already be READY while the separate transaction
        // tracker is still catching up. Keep polling without losing intent.
        if (this.#client.state.transaction.hash) this.#schedule();
        return;
      }
    }
    if (action.executionMode !== 'PAPER') throw new Error('PAPER_WORKFLOW_MODE_REQUIRED');
    if (action.step === 'BUY' || action.step === 'SELL') {
      throw new Error('PAPER_WORKFLOW_MODE_REQUIRED');
    } else if (action.step === 'REVOKE') {
      await this.#client.reviewExecutorPermission(run.strategyId, null);
    } else {
      await this.#client.review({
        strategyId: run.strategyId,
        operation: action.step === 'CREATE' ? 'CREATE_VAULT' : action.step,
        asset: 'AF_USDC',
        amountRaw: action.stepAmountRaw,
        slippageBps: 100,
      });
    }
    const fresh = await this.#read(run.strategyId);
    if (
      fresh.revision !== run.revision ||
      fresh.action?.actionId !== action.actionId ||
      (fresh.paused && action.kind === 'DEPOSIT')
    ) {
      this.#client.clearQuote();
      throw new Error('VAULT_RUN_STEP_CHANGED');
    }
    this.#review = true;
    this.#reviewIdentity = this.#walletReviewIdentity();
    this.#emit({
      notice:
        action.step === 'CLOSE'
          ? 'Closing returns the on-chain Vault cash and releases all locked PASS. Simulated profit is a ledger record and cannot be withdrawn.'
          : 'Review the next on-chain step. Simulated stock entries require no wallet transaction.',
    });
  }
  #walletReviewIdentity(): string {
    const state = this.#client.state;
    return JSON.stringify([state.quote?.id ?? null, state.executorReview?.data ?? null]);
  }
  async #beforeSend(): Promise<void> {
    const guard = this.#guard;
    if (!guard) return;
    if (guard.sequence && guard.sequence !== this.#depositSequence) throw new Error('VAULT_RUN_STEP_CHANGED');
    const run = await this.#read(guard.strategyId),
      action = run.action;
    if (
      (guard.sequence && guard.sequence !== this.#depositSequence) ||
      run.revision !== guard.revision ||
      !action ||
      action.actionId !== guard.actionId ||
      action.step !== guard.step ||
      action.executionMode !== 'PAPER' ||
      action.cancelled ||
      (run.paused && action.kind === 'DEPOSIT') ||
      action.prepared !== guard.prepared ||
      action.pending
    )
      throw new Error('VAULT_RUN_STEP_CHANGED');
    this.#handoff = true;
  }
  async confirm(continueDeposit = false): Promise<void> {
    return this.#task(async () => {
      const run = this.#current(),
        action = run?.action;
      if (!run || !action?.step || !this.#review) throw new Error('QUOTE_REVIEW_REQUIRED');
      if (action.executionMode !== 'PAPER' || ['BUY', 'SELL'].includes(action.step))
        throw new Error('PAPER_WORKFLOW_MODE_REQUIRED');
      if (this.#reviewIdentity !== this.#walletReviewIdentity()) throw new Error('QUOTE_REVIEW_REQUIRED');
      if (continueDeposit && action.kind === 'DEPOSIT' && ['CREATE', 'DEPOSIT'].includes(action.step)) {
        this.#depositSequence = {
          strategyId: run.strategyId,
          actionId: action.actionId,
          amountRaw: action.amountRaw,
        };
      }
      const sequence = this.#depositSequence;
      const fresh = await this.#read(run.strategyId);
      if (
        fresh.revision !== run.revision ||
        fresh.action?.actionId !== action.actionId ||
        (fresh.paused && action.kind === 'DEPOSIT')
      )
        throw new Error('VAULT_RUN_STEP_CHANGED');
      const approval = this.#client.state.quote?.allowance != null;
      let prepared = fresh;
      if (!approval)
        prepared = await this.#write(run.strategyId, 'prepare', {
          actionId: action.actionId,
          expectedRevision: fresh.revision,
          step: action.step,
        });
      this.#guard = {
        strategyId: run.strategyId,
        actionId: action.actionId,
        step: action.step,
        revision: prepared.revision,
        prepared: !approval,
        sequence,
      };
      this.#review = false;
      this.#handoff = false;
      const previousTransaction = this.#client.state.transaction;
      try {
        if (this.#client.state.stockReview) throw new Error('PAPER_WORKFLOW_MODE_REQUIRED');
        const review = this.#client.state.executorReview;
        if (
          !approval &&
          review &&
          (prepared.action?.expectedVersion !== review.snapshot.version ||
            prepared.vault?.toLowerCase() !== review.snapshot.vault.toLowerCase())
        )
          throw new Error('VAULT_RUN_VERSION_UNCONFIRMED');
        if (this.#client.state.executorReview) await this.#client.confirmExecutorPermission();
        else await this.#client.confirm();
        const tx = this.#client.state.transaction;
        if (approval) {
          this.#approval = { strategyId: run.strategyId, actionId: action.actionId, hash: tx.hash };
          if (!tx.hash) throw new Error('VAULT_RUN_RECOVERY_REQUIRED');
        } else {
          const current = await this.#read(run.strategyId);
          await this.#write(run.strategyId, tx.hash ? 'submitted' : 'uncertain', {
            actionId: action.actionId,
            expectedRevision: current.revision,
            step: action.step,
            ...(tx.hash ? { transactionHash: tx.hash } : {}),
          });
        }
      } catch (error) {
        if (!approval) {
          const tx = this.#client.state.transaction;
          const current = await this.#read(run.strategyId);
          if (current.action?.prepared) {
            const newHash = tx.hash !== null && tx.hash !== previousTransaction.hash;
            const unknown =
              newHash || (this.#handoff && tx !== previousTransaction && tx.state === 'RECOVERY_REQUIRED');
            await this.#write(run.strategyId, unknown ? 'uncertain' : 'rejected', {
              actionId: action.actionId,
              expectedRevision: current.revision,
              ...(unknown ? { step: action.step, ...(tx.hash ? { transactionHash: tx.hash } : {}) } : {}),
            });
          }
        }
        throw error;
      } finally {
        this.#guard = null;
        this.#handoff = false;
      }
      this.#schedule();
    });
  }
  async cancel(): Promise<void> {
    this.cancelWalletSequence();
    const run = this.#current();
    this.#client.clearQuote();
    this.#review = false;
    if (run) await this.stop(run.strategyId);
  }
  async recover(id: StrategyId, transactionHash?: string): Promise<void> {
    return this.#task(async () => {
      this.bind();
      this.#owner();
      await this.#read(id);
      this.#active = id;
      const run = this.#current(),
        action = run?.action;
      if (!run || !action || (!action.step && !this.#paperPending())) return;
      if (transactionHash) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new Error('INVALID_TRANSACTION_HASH');
        await this.#write(run.strategyId, 'submitted', {
          actionId: action.actionId,
          expectedRevision: run.revision,
          step: action.step,
          transactionHash,
        });
      }
      await this.#drive();
    });
  }
  #schedule(): void {
    if (this.#timer) return;
    this.#timer = this.#scheduleTimer(
      () => {
        this.#timer = null;
        if (this.#working) {
          this.#schedule();
          return;
        }
        void this.#task(() => this.#drive()).catch(() => {
          if (this.#paperPending()) this.#schedule();
        });
      },
      this.#paperPending() ? 30000 : 2000,
    );
  }
  async #drive(): Promise<void> {
    const run = this.#current();
    if (!run?.action) return;
    if (this.#approval) {
      await this.#client.refreshTransaction();
      const tx = this.#client.state.transaction;
      if (tx.hash !== this.#approval.hash || !['COMPLETED', 'REVERTED', 'REJECTED'].includes(tx.state)) {
        this.#schedule();
        return;
      }
      this.#approval = null;
      if (tx.state !== 'COMPLETED') throw new Error('WALLET_REJECTED');
      await this.#read(run.strategyId);
      await this.#reviewNext();
      return;
    }
    const chainPending = !!run.action.pending;
    if (chainPending || this.#paperPending()) {
      if (run.action.pending && !run.action.pending.transactionHash)
        throw new Error('VAULT_RUN_RECOVERY_REQUIRED');
      let next: RunState;
      try {
        next = await this.#write(run.strategyId, 'reconcile', { expectedRevision: run.revision });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !['VAULT_RUN_REVISION_CONFLICT', 'VAULT_RUN_NO_PENDING_TRANSACTION'].includes(error.message)
        )
          throw error;
        next = await this.#read(run.strategyId);
        if (next.action?.actionId !== run.action.actionId)
          throw new Error('VAULT_RUN_STEP_CHANGED', { cause: error });
      }
      if (next.action?.pending) {
        this.#schedule();
        return;
      }
      if (chainPending && next.action?.phase !== 'FAILED' && !next.action?.failure) {
        await this.#client.refreshTransaction();
        await this.#client.refresh();
      }
    }
    const action = this.#current()?.action;
    if (action?.phase === 'READY') await this.#reviewNext();
    else if (action?.phase === 'PAPER_PENDING') {
      if (this.#paperPending()) this.#schedule();
      this.#emit({
        notice:
          'Your deposit is confirmed. The server will automatically record the simulated entry when the market is open and a fresh authorized quote is available, even if you close this page. Stop cancels the pending entry; Withdraw returns the on-chain cash.',
      });
    } else if (action && terminal.has(action.phase))
      this.#emit({
        notice:
          action.executionMode !== 'PAPER'
            ? 'The previous on-chain workflow is shown separately. Simulated holdings and profits come from the simulation ledger.'
            : action.phase === 'CLOSED'
              ? 'On-chain Vault funds have been returned and all locked PASS released. Simulated results remain in the ledger history.'
              : action.phase === 'HOLDING'
                ? 'Your simulated stock position is recorded. Deposited funds remain on chain in your Vault.'
                : action.phase === 'STOPPED' || action.phase === 'PAUSED'
                  ? 'New simulated trades are paused. Existing simulated holdings remain recorded.'
                  : 'This step did not complete. Confirmed assets remain in your Vault.',
      });
  }
}
