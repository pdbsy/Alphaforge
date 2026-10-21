import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  LaunchMarketError,
  type MarketAccount,
  type StrategyId,
} from '../../../../packages/launch-market/src/types.ts';
import {
  qualifyVaultRunObservation,
  type VaultRunObservation,
  type VaultRunReceipt,
  type VaultRunState,
  type VaultRunStep,
  type VaultRunStore,
} from '../../../../packages/launch-market/src/vault-run.ts';
import {
  usablePaperEntryPrice,
  qualifyPaperFundingProof,
  type PaperExecutionPrice,
  type PaperFundingProof,
  type PaperLedger,
} from '../../../../packages/launch-market/src/paper-ledger.ts';
import type { PaperMarketQuote } from '../launch-market-adapters/paper-market-data.ts';
import type { VaultReferenceDemand } from '../launch-market-adapters/vault-reference-demand.ts';

export interface VaultRunRoutesOptions {
  readonly origin: string;
  readonly store: VaultRunStore;
  readonly demand: VaultReferenceDemand;
  readonly paper?: {
    readonly ledger: PaperLedger;
    readonly readPrice: (id: StrategyId) => Promise<PaperExecutionPrice | null>;
    readonly readFundingProof: (state: VaultRunState) => Promise<PaperFundingProof>;
    readonly canonicalAnchor: (height: string) => { known: boolean; blockHash: string | null };
    readonly referenceStatus?: () => unknown;
  };
  /** Same selected-wallet/CSRF resolver as funding and automation routes. */
  readonly resolveAccount: (request: FastifyRequest) => Promise<MarketAccount | null>;
  readonly readObservation: (
    owner: string,
    strategyId: StrategyId,
    options: { fresh: boolean },
  ) => Promise<VaultRunObservation>;
  /** Exact from/target/calldata/amount/version qualification; throws unless this step's actual transaction is found. */
  readonly qualifyTransaction: (state: VaultRunState, transactionHash: string) => Promise<void>;
  /** Must also qualify exact step for uncertain hashes, then verify canonical receipt and >= 3 confirmations. */
  readonly readReceipt: (state: VaultRunState) => Promise<VaultRunReceipt>;
  /** Retire every existing automation consent for this authenticated owner and strategy. */
  readonly pauseAutomation?: (owner: string, strategyId: StrategyId) => Promise<void> | void;
  readonly consumeRate: (key: string, limit: number, windowSeconds: number, now: number) => void;
  readonly canWrite: () => boolean;
  readonly now: () => number;
}
export type VaultRunOptions = Omit<
  VaultRunRoutesOptions,
  'origin' | 'resolveAccount' | 'consumeRate' | 'canWrite' | 'now'
>;
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const key = { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' };
const step = { type: 'string', enum: ['CREATE', 'DEPOSIT', 'BUY', 'REVOKE', 'SELL', 'CLOSE'] };
const transactionHash = { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' };
const params = {
  type: 'object',
  additionalProperties: false,
  required: ['strategyId'],
  properties: { strategyId: { type: 'string', enum: ['TSLA', 'AMZN'] } },
};
const schema = (properties: Record<string, unknown>, required: readonly string[]) => ({
  params,
  body: { type: 'object', additionalProperties: false, required, properties },
});
type Identity = { strategyId: StrategyId };
type ActionBody = { actionId: string; expectedRevision: number };
type StepBody = ActionBody & { step: VaultRunStep };
const base = '/api/launch-market/vault-run/:strategyId';

export type VaultRunReconcileOptions = Pick<
  VaultRunRoutesOptions,
  'store' | 'paper' | 'readObservation' | 'readReceipt' | 'now'
>;
function auditPaperAnchors(
  options: Pick<VaultRunRoutesOptions, 'paper'>,
  owner: string,
  id: StrategyId,
): void {
  if (!options.paper) return;
  for (const anchor of options.paper.ledger.anchors(owner, id)) {
    const canonical = options.paper.canonicalAnchor(anchor.blockNumber);
    if (!canonical.known) throw new LaunchMarketError('PAPER_CHAIN_INDEX_SYNCING', 503);
    if (canonical.blockHash?.toLowerCase() !== anchor.blockHash) {
      options.paper.ledger.setCanonical(anchor.proofId, canonical.blockHash);
      throw new LaunchMarketError('PAPER_REORG_REVIEW_REQUIRED', 503);
    }
  }
}
/** Reconciles only previously authorized funding intent. Never signs, submits, or prepares a new wallet step. */
export async function reconcileVaultRun(
  options: VaultRunReconcileOptions,
  owner: string,
  id: StrategyId,
  expectedRevision: number,
): Promise<VaultRunState> {
  const present = (state: VaultRunState): VaultRunState =>
    options.paper ? { ...state, executionMode: 'PAPER' } : state;
  const auditPaper = (owner: string, id: StrategyId) => auditPaperAnchors(options, owner, id);
  const state = options.store.get(owner, id);
  if (state.revision !== expectedRevision) throw new LaunchMarketError('VAULT_RUN_REVISION_CONFLICT', 409);
  if (options.paper && state.action?.executionMode === 'PAPER' && state.action.phase === 'PAPER_PENDING') {
    if (state.paused || state.action.cancelled || !state.vault)
      throw new LaunchMarketError('VAULT_RUN_STEP_CHANGED', 409);
    auditPaper(owner, id);
    const proof = options.paper.ledger.depositProof(owner, id, state.vault, state.action.actionId);
    if (!proof) throw new LaunchMarketError('PAPER_REORG_REVIEW_REQUIRED', 503);
    let price: PaperExecutionPrice | null = null;
    try {
      price = await options.paper.readPrice(id);
    } catch {
      /* Wait for a real authorized reference. */
    }
    auditPaper(owner, id);
    const fresh = options.store.get(owner, id);
    if (
      fresh.action?.actionId !== state.action.actionId ||
      fresh.action.phase !== 'PAPER_PENDING' ||
      fresh.paused ||
      fresh.action.cancelled
    )
      throw new LaunchMarketError('VAULT_RUN_STEP_CHANGED', 409);
    if (
      !options.paper.ledger.hasEntry(fresh.action.actionId) &&
      !usablePaperEntryPrice(price, id, options.now())
    )
      return present(fresh);
    options.paper.ledger.recordDeposit(
      proof,
      { actionId: fresh.action.actionId, paused: false, price },
      options.now(),
    );
    if (!options.paper.ledger.hasEntry(fresh.action.actionId)) return present(fresh);
    return present(
      options.store.completePaperEntry(owner, id, fresh.action.actionId, fresh.revision, options.now()),
    );
  }
  if (!state.action?.pending) throw new LaunchMarketError('VAULT_RUN_NO_PENDING_TRANSACTION', 409);
  if (!state.action.pending.transactionHash) return present(state); // Unknown wallet outcome is never treated as a dropped transaction.
  const receipt = await options.readReceipt(state);
  if (receipt.status === 'UNKNOWN' || receipt.status === 'PENDING') return present(state);
  const observation = await options.readObservation(owner, id, { fresh: true });
  qualifyVaultRunObservation(owner, id, observation);
  const fresh = options.store.get(owner, id);
  if (
    fresh.action?.actionId !== state.action.actionId ||
    fresh.action.pending?.transactionHash !== state.action.pending.transactionHash
  )
    throw new LaunchMarketError('VAULT_RUN_STEP_CHANGED', 409);
  let paperFunded = false;
  if (
    options.paper &&
    fresh.action?.executionMode === 'PAPER' &&
    receipt.status === 'CONFIRMED' &&
    ['DEPOSIT', 'CLOSE'].includes(fresh.action.step ?? '')
  ) {
    let price: PaperExecutionPrice | null = null;
    try {
      price = await options.paper.readPrice(id);
    } catch {
      /* Confirmed cash must not depend on a quote request succeeding. */
    }
    const proof = await options.paper.readFundingProof(fresh);
    qualifyPaperFundingProof(proof);
    if (
      proof.owner.toLowerCase() !== owner.toLowerCase() ||
      proof.strategyId !== id ||
      proof.vault.toLowerCase() !== fresh.vault ||
      proof.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
      proof.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      proof.blockNumber !== receipt.blockNumber ||
      proof.kind !== fresh.action.step ||
      (proof.kind === 'DEPOSIT' && proof.amountRaw !== fresh.action.amountRaw)
    )
      throw new LaunchMarketError('PAPER_LEDGER_PROOF_INVALID', 503);
    // All asynchronous reads precede this synchronous ledger/workflow handoff. A racing Stop wins.
    const latest = options.store.get(owner, id);
    if (
      latest.action?.actionId !== fresh.action.actionId ||
      latest.action.pending?.transactionHash !== fresh.action.pending?.transactionHash
    )
      throw new LaunchMarketError('VAULT_RUN_STEP_CHANGED', 409);
    if (proof.kind === 'DEPOSIT') {
      options.paper.ledger.recordDeposit(
        proof,
        { actionId: latest.action.actionId, paused: latest.paused || latest.action.cancelled, price },
        options.now(),
      );
      paperFunded = options.paper.ledger.hasEntry(latest.action.actionId);
    } else
      options.paper.ledger.recordClose(proof, { actionId: latest.action.actionId, price }, options.now());
    return present(
      options.store.reconcile(owner, id, latest.revision, receipt, observation, options.now(), paperFunded),
    );
  }
  return present(options.store.reconcile(owner, id, fresh.revision, receipt, observation, options.now()));
}

export function registerVaultRunRoutes(app: FastifyInstance, options: VaultRunRoutesOptions): void {
  const present = (state: VaultRunState): VaultRunState =>
    options.paper ? { ...state, executionMode: 'PAPER' } : state;
  const auditPaper = (owner: string, id: StrategyId) => auditPaperAnchors(options, owner, id);
  const actor = async (request: FastifyRequest, mutation: boolean, capacity = false): Promise<string> => {
    if (
      mutation &&
      (request.headers.origin !== options.origin || request.headers['sec-fetch-site'] === 'cross-site')
    )
      throw new LaunchMarketError('INVALID_REQUEST_ORIGIN', 403);
    const account = await options.resolveAccount(request);
    if (!account?.wallet) throw new LaunchMarketError('LINKED_WALLET_REQUIRED', 401);
    if (capacity && !options.canWrite()) throw new LaunchMarketError('VAULT_RUN_STORAGE_FULL', 503);
    options.consumeRate('vault-run:' + account.wallet, 120, 60, options.now());
    if (capacity) options.consumeRate('vault-run-start:' + account.wallet, 30, 3600, options.now());
    return account.wallet;
  };
  const observe = async (owner: string, id: StrategyId, fresh: boolean) => {
    const observation = await options.readObservation(owner, id, { fresh });
    qualifyVaultRunObservation(owner, id, observation);
    return observation;
  };
  const current = (owner: string, id: StrategyId, body: ActionBody): VaultRunState => {
    const state = options.store.get(owner, id);
    if (state.revision !== body.expectedRevision)
      throw new LaunchMarketError('VAULT_RUN_REVISION_CONFLICT', 409);
    if (state.action?.actionId !== body.actionId) throw new LaunchMarketError('VAULT_RUN_STEP_CHANGED', 409);
    return state;
  };
  app.get<{ Params: Identity }>(
    base + '/state',
    { schema: { params, querystring: { type: 'object', additionalProperties: false, properties: {} } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return present(options.store.get(await actor(request, false), request.params.strategyId));
    },
  );
  app.get<{ Params: Identity }>(base, { schema: { params } }, async (request) => {
    const owner = await actor(request, false),
      id = request.params.strategyId;
    return {
      state: present(options.store.get(owner, id)),
      observation: await observe(owner, id, false),
      reference: options.paper?.referenceStatus?.() ?? options.demand.status(),
    };
  });
  app.post<{ Params: Identity; Body: ActionBody & { amountRaw: string } }>(
    base + '/deposit',
    {
      bodyLimit: 2048,
      schema: schema(
        {
          actionId: key,
          expectedRevision: revision,
          amountRaw: { type: 'string', pattern: '^[1-9][0-9]{0,77}$' },
        },
        ['actionId', 'expectedRevision', 'amountRaw'],
      ),
    },
    async (request) => {
      const owner = await actor(request, true, true),
        id = request.params.strategyId;
      // Confirmed cash may wait through a verified closed session. Execution still requires a fresh OPEN price.
      if (options.paper) {
        auditPaper(owner, id);
        const price = await options.paper.readPrice(id);
        const reference = options.paper.referenceStatus?.() as
          { quotes?: Partial<Record<StrategyId, PaperMarketQuote>> } | undefined;
        const quote = reference?.quotes?.[id];
        const now = options.now();
        const closedSession =
          quote?.strategyId === id &&
          quote.sourceAuthorized === true &&
          quote.sourceId === 'ALPACA_IEX' &&
          quote.status === 'MARKET_CLOSED' &&
          quote.marketState === 'CLOSED' &&
          quote.priceRaw === null &&
          Number.isSafeInteger(quote.fetchedAt) &&
          quote.fetchedAt !== null &&
          quote.fetchedAt <= now &&
          now - quote.fetchedAt < 30 &&
          Number.isSafeInteger(quote.observedAt) &&
          quote.observedAt !== null &&
          quote.observedAt <= now &&
          now - quote.observedAt <= 60;
        if (!usablePaperEntryPrice(price, id, now) && !closedSession)
          throw new LaunchMarketError('PAPER_PRICE_UNAVAILABLE', 503);
      } else {
        if (!options.demand.status().available)
          throw new LaunchMarketError('STOCK_REFERENCE_NOT_CONFIGURED', 503);
        const reference = await options.demand.request(id);
        if (reference.status !== 'READY') throw new LaunchMarketError(reference.reason, 503);
      }
      const observation = await observe(owner, id, true);
      if (options.paper) {
        auditPaper(owner, id);
        if (
          options.paper.ledger.book(owner, id, observation.vault, null, options.now()).status ===
          'REORG_REVIEW_REQUIRED'
        )
          throw new LaunchMarketError('PAPER_REORG_REVIEW_REQUIRED', 503);
      }
      return present(
        options.store.begin(
          owner,
          id,
          'DEPOSIT',
          request.body.actionId,
          request.body.expectedRevision,
          request.body.amountRaw,
          observation,
          options.now(),
          options.paper ? 'PAPER' : 'CHAIN',
        ),
      );
    },
  );
  app.post<{ Params: Identity; Body: { expectedRevision: number } }>(
    base + '/stop',
    {
      schema: schema({ expectedRevision: revision }, ['expectedRevision']),
    },
    async (request) => {
      const owner = await actor(request, true),
        id = request.params.strategyId;
      // Make cancellation durable before any unavailable worker/chain access. Never undo Stop on failure.
      let state = options.store.stop(owner, id, request.body.expectedRevision, options.now());
      options.paper?.ledger.pause(owner, id);
      let automationPaused = true,
        revocationObserved = true;
      try {
        await options.pauseAutomation?.(owner, id);
      } catch {
        automationPaused = false;
      }
      try {
        const observation = await observe(owner, id, true);
        state = options.store.planStop(
          owner,
          id,
          state.revision,
          observation,
          options.now(),
          options.paper ? 'PAPER' : 'CHAIN',
        );
      } catch {
        revocationObserved = false;
        state = options.store.get(owner, id);
      }
      return { state: present(state), automationPaused, revocationObserved };
    },
  );
  app.post<{ Params: Identity; Body: ActionBody }>(
    base + '/withdraw',
    {
      schema: schema({ actionId: key, expectedRevision: revision }, ['actionId', 'expectedRevision']),
    },
    async (request) => {
      const owner = await actor(request, true),
        id = request.params.strategyId;
      const previous = options.store.get(owner, id);
      if (previous.revision !== request.body.expectedRevision)
        throw new LaunchMarketError('VAULT_RUN_REVISION_CONFLICT', 409);
      // Cancellation remains durable even if market data, chain reads, quota, or old consent storage is down.
      const paused = options.store.stop(owner, id, previous.revision, options.now());
      options.paper?.ledger.pause(owner, id);
      try {
        await options.pauseAutomation?.(owner, id);
      } catch {
        throw new LaunchMarketError('VAULT_RUN_AUTOMATION_PAUSE_FAILED', 503);
      }
      const observation = await observe(owner, id, true);
      // Existing cash can always exit even when new-action storage has reached its intake limit.
      options.consumeRate('vault-run-start:' + owner, 30, 3600, options.now());
      return present(
        options.store.begin(
          owner,
          id,
          'WITHDRAW',
          request.body.actionId,
          paused.revision,
          '0',
          observation,
          options.now(),
          options.paper ? 'PAPER' : 'CHAIN',
        ),
      );
    },
  );
  app.post<{ Params: Identity; Body: StepBody }>(
    base + '/prepare',
    {
      schema: schema({ actionId: key, expectedRevision: revision, step }, [
        'actionId',
        'expectedRevision',
        'step',
      ]),
    },
    async (request) => {
      const owner = await actor(request, true),
        id = request.params.strategyId;
      const state = current(owner, id, request.body);
      if (
        state.action?.phase !== 'READY' ||
        state.action.cancelled ||
        state.action.prepared ||
        state.action.pending
      )
        throw new LaunchMarketError('VAULT_RUN_STEP_CHANGED', 409);
      if (
        options.paper &&
        (state.action?.executionMode !== 'PAPER' || ['BUY', 'SELL'].includes(request.body.step))
      )
        throw new LaunchMarketError('PAPER_WALLET_STEP_UNSUPPORTED', 409);
      if (['BUY', 'SELL'].includes(request.body.step)) {
        const reference = await options.demand.request(id);
        if (reference.status !== 'READY') throw new LaunchMarketError(reference.reason, 503);
      }
      const observation = await observe(owner, id, true);
      return present(
        options.store.prepare(
          owner,
          id,
          request.body.actionId,
          request.body.expectedRevision,
          request.body.step,
          observation,
          options.now(),
        ),
      );
    },
  );
  app.post<{ Params: Identity; Body: StepBody & { transactionHash: string } }>(
    base + '/submitted',
    {
      schema: schema({ actionId: key, expectedRevision: revision, step, transactionHash }, [
        'actionId',
        'expectedRevision',
        'step',
        'transactionHash',
      ]),
    },
    async (request) => {
      const owner = await actor(request, true),
        id = request.params.strategyId;
      const state = current(owner, id, request.body);
      if (!state.action?.prepared || state.action.step !== request.body.step)
        throw new LaunchMarketError('VAULT_RUN_STEP_CHANGED', 409);
      await options.qualifyTransaction(state, request.body.transactionHash);
      // Stop may have raced the asynchronous chain read. Preserve the real broadcast while retaining paused=true.
      const fresh = options.store.get(owner, id);
      if (
        fresh.action?.actionId !== state.action.actionId ||
        fresh.action.step !== state.action.step ||
        !fresh.action.prepared
      )
        throw new LaunchMarketError('VAULT_RUN_STEP_CHANGED', 409);
      return present(
        options.store.submitted(
          owner,
          id,
          request.body.actionId,
          fresh.revision,
          request.body.step,
          request.body.transactionHash,
          true,
          options.now(),
        ),
      );
    },
  );
  app.post<{ Params: Identity; Body: StepBody & { transactionHash?: string } }>(
    base + '/uncertain',
    {
      schema: schema({ actionId: key, expectedRevision: revision, step, transactionHash }, [
        'actionId',
        'expectedRevision',
        'step',
      ]),
    },
    async (request) =>
      present(
        options.store.submitted(
          await actor(request, true),
          request.params.strategyId,
          request.body.actionId,
          request.body.expectedRevision,
          request.body.step,
          request.body.transactionHash ?? null,
          false,
          options.now(),
        ),
      ),
  );
  app.post<{ Params: Identity; Body: ActionBody }>(
    base + '/rejected',
    {
      schema: schema({ actionId: key, expectedRevision: revision }, ['actionId', 'expectedRevision']),
    },
    async (request) =>
      present(
        options.store.rejected(
          await actor(request, true),
          request.params.strategyId,
          request.body.actionId,
          request.body.expectedRevision,
          options.now(),
        ),
      ),
  );
  app.post<{ Params: Identity; Body: { expectedRevision: number } }>(
    base + '/reconcile',
    {
      schema: schema({ expectedRevision: revision }, ['expectedRevision']),
    },
    async (request) =>
      reconcileVaultRun(
        options,
        await actor(request, true),
        request.params.strategyId,
        request.body.expectedRevision,
      ),
  );
  app.post<{ Params: Identity; Body: Record<string, never> }>(
    base + '/reference',
    {
      schema: schema({}, []),
    },
    async (request) => {
      await actor(request, true);
      return options.demand.request(request.params.strategyId);
    },
  );
}
