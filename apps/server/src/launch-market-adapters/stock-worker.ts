import { Interface, getAddress, keccak256, ZeroAddress } from 'ethers';
import type { LaunchMarketManifest, StrategyId } from '../../../../packages/launch-market/src/types.ts';
import { uint, hash, validateManifest } from '../../../../packages/launch-market/src/config.ts';
import { OrderJournal, type OrderIntent } from '../../../../packages/testnet/src/order-journal.ts';
import {
  submitRestrictedIntent,
  validateSubmissionPolicy,
  type RestrictedSigner,
  type RestrictedTransport,
  type SubmissionPolicy,
} from '../../../../packages/testnet/src/restricted-submission.ts';
import type { Eip1193Provider } from '../../../web/src/chain-wallet.ts';
import {
  readStockExecutionSnapshot,
  stockExecutionInterface,
} from '../../../web/src/launch-market/stock-execution.ts';
import { prepareStockReferenceUpdate, type ConfirmedStockReference } from './stock-reference.ts';
import {
  stockEvidenceHash,
  verifyStockConsent,
  decideStockOrder,
  type SignedStockConsent,
  type StockMinuteBar,
} from './stock-worker-policy.ts';
import { StockWorkerJournal } from './stock-worker-journal.ts';
import type { StockWorkerSource } from './stock-worker-source.ts';

const factory = new Interface([
  'function strategy(uint8) view returns(tuple(address creator,address pass,address usdc,address targetStock,address otherStock,address stockReserve,address referenceFeed,bytes32 strategyRef,uint32 maxPriceAge))',
]);
const feedAbi = new Interface([
  'function keeper() view returns(address)',
  'function referenceIdentity() view returns(bytes32)',
  'function price() view returns(uint256,uint64,bytes32)',
  'function calendarObservedAt() view returns(uint64)',
  'function regularOpen() view returns(uint64)',
  'function regularClose() view returns(uint64)',
  'function update(uint256,uint64,bytes32)',
  'function updateSession(uint64,uint64,uint64,bytes32)',
  'event ReferenceUpdated(uint256 usdcRaw,uint64 observedAt,bytes32 indexed sourceDigest)',
  'event SessionUpdated(uint64 regularOpen,uint64 regularClose,uint64 observedAt,bytes32 indexed sourceDigest)',
]);
const executionEvent = new Interface([
  'event StrategyExecuted(bool buy,uint256 input,uint256 output,uint256 version)',
]);
const same = (a: string, b: string) => getAddress(a) === getAddress(b);
const quantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value))
    throw new Error('STOCK_WORKER_RPC');
  return BigInt(value);
};
export interface StockWorkerFeedBinding {
  readonly strategyId: StrategyId;
  readonly keeper: string;
  readonly referenceIdentity: string;
  readonly operatorOwner: string;
}
export interface StockWorkerOptions {
  readonly manifest: LaunchMarketManifest;
  readonly provider: Eip1193Provider;
  readonly orders: OrderJournal;
  readonly evidence: StockWorkerJournal;
  readonly sessions: readonly SignedStockConsent[];
  readonly feeds: readonly StockWorkerFeedBinding[];
  readonly source: StockWorkerSource;
  readonly gas: SubmissionPolicy;
  readonly maxTotalGasCostWei: string;
  readonly canWrite: () => boolean;
  readonly activationValid: () => boolean;
  /** Owner-controlled opt-in/pause is independent of creator research publication. */
  readonly sessionActive?: (consentDigest: string) => boolean;
  /** Optional authenticated private registry. Failure pauses execution; entries remain owner signed. */
  readonly sessionProvider?: () => Promise<readonly SignedStockConsent[]>;
  readonly now?: () => number;
  readonly readSnapshot?: typeof readStockExecutionSnapshot;
  /** Explicit operator activation only. Absence never unlocks keys or transmits transactions. */
  readonly submission?: {
    readonly transport: RestrictedTransport;
    readonly signers: readonly RestrictedSigner[];
  };
}
export interface StockWorkerStatus {
  readonly schemaVersion: 1;
  readonly mode: 'PREPARE' | 'ACTIVE';
  readonly status: string;
  readonly lastTickAt: number | null;
  readonly strategies: readonly {
    readonly strategyId: StrategyId;
    readonly status: string;
    readonly pendingHash: string | null;
  }[];
}
/** No account identifiers, provider credentials, signed envelopes or raw evidence enter the UI status. */
export class StockAutomationWorker {
  readonly options: StockWorkerOptions;
  status = 'NOT_STARTED';
  lastTickAt: number | null = null;
  readonly strategyStatus = new Map<StrategyId, { status: string; pendingHash: string | null }>();
  consentDigests: readonly string[];
  #sessions: readonly SignedStockConsent[];
  #closed = false;
  #tail: Promise<void> = Promise.resolve();
  #reconcileCursor = '';
  readonly #referenceTargets = new Map<StrategyId, ConfirmedStockReference>();
  constructor(options: StockWorkerOptions) {
    validateManifest(options.manifest);
    if (
      !options.manifest.vaultFactory ||
      options.sessions.length > 100 ||
      options.feeds.length > 2 ||
      new Set(options.sessions.map((s) => getAddress(s.consent.vault))).size !== options.sessions.length ||
      new Set(options.feeds.map((f) => f.strategyId)).size !== options.feeds.length
    )
      throw new Error('STOCK_WORKER_CONFIGURATION');
    validateSubmissionPolicy(options.gas);
    if (uint(options.maxTotalGasCostWei) < uint(options.gas.maxGasCostWei))
      throw new Error('STOCK_WORKER_GAS_BUDGET');
    const digest = stockEvidenceHash(options.manifest);
    this.consentDigests = options.sessions.map((s) => {
      if (s.consent.manifestDigest !== digest) throw new Error('STOCK_POLICY_MANIFEST');
      return verifyStockConsent(s);
    });
    for (const binding of options.feeds) {
      if (
        !['TSLA', 'AMZN'].includes(binding.strategyId) ||
        same(binding.keeper, binding.operatorOwner) ||
        [getAddress(binding.keeper), getAddress(binding.operatorOwner)].includes(ZeroAddress)
      )
        throw new Error('STOCK_FEED_AUTHORITY');
      hash(binding.referenceIdentity);
    }
    if (
      options.submission &&
      new Set(options.submission.signers.map((s) => getAddress(s.address))).size !==
        options.submission.signers.length
    )
      throw new Error('STOCK_WORKER_SIGNER_IDENTITY');
    this.options = options;
    this.#sessions = options.sessions;
  }
  safeStatus(): StockWorkerStatus {
    return {
      schemaVersion: 1,
      mode: this.options.submission ? 'ACTIVE' : 'PREPARE',
      status: this.status,
      lastTickAt: this.lastTickAt,
      strategies: (['TSLA', 'AMZN'] as const).map((strategyId) => ({
        strategyId,
        ...(this.strategyStatus.get(strategyId) ?? { status: 'NOT_CONFIGURED', pendingHash: null }),
      })),
    };
  }
  async #call(target: string, abi: Interface, name: string, args: readonly unknown[], block: string) {
    return abi.decodeFunctionResult(
      name,
      String(
        await this.options.provider.request({
          method: 'eth_call',
          params: [{ to: target, data: abi.encodeFunctionData(name, args) }, block],
        }),
      ),
    );
  }
  async #head() {
    if (quantity(await this.options.provider.request({ method: 'eth_chainId' })) !== 46630n)
      throw new Error('STOCK_WORKER_CHAIN');
    const block = (await this.options.provider.request({
      method: 'eth_getBlockByNumber',
      params: ['latest', false],
    })) as { number: string; hash: string; timestamp: string };
    const now = this.options.now?.() ?? Math.floor(Date.now() / 1000);
    if (
      !block ||
      !Number.isSafeInteger(now) ||
      quantity(block.timestamp) > BigInt(now) ||
      BigInt(now) - quantity(block.timestamp) > 30n
    )
      throw new Error('STOCK_WORKER_CHAIN_STALE');
    hash(block.hash);
    quantity(block.number);
    return block;
  }
  async #canonical(block: { number: string; hash: string }) {
    const current = (await this.options.provider.request({
      method: 'eth_getBlockByNumber',
      params: [block.number, false],
    })) as { hash: string } | null;
    if (!current || hash(current.hash) !== hash(block.hash)) throw new Error('STOCK_WORKER_REORG');
  }
  async #feedState(binding: StockWorkerFeedBinding) {
    const block = await this.#head();
    const configured = (
      await this.#call(
        this.options.manifest.vaultFactory!,
        factory,
        'strategy',
        [binding.strategyId === 'TSLA' ? 0 : 1],
        block.number,
      )
    )[0];
    if (
      !same(String(configured.pass), this.options.manifest.strategies[binding.strategyId].pass) ||
      !same(String(configured.usdc), this.options.manifest.usdc) ||
      Number(configured.maxPriceAge) < 1 ||
      Number(configured.maxPriceAge) > 60
    )
      throw new Error('STOCK_FEED_ROUTE');
    const target = getAddress(String(configured.referenceFeed));
    const code = String(
      await this.options.provider.request({ method: 'eth_getCode', params: [target, block.number] }),
    );
    // RpcMarketChain.initialize also verifies the whole manifest; bind this exact feed here.
    if (keccak256(code).toLowerCase() !== this.options.manifest.runtimeCodeHashes[target.toLowerCase()])
      throw new Error('STOCK_FEED_CODE');
    const [keeper, identity, price, calendar, opens, closes] = await Promise.all([
      this.#call(target, feedAbi, 'keeper', [], block.number),
      this.#call(target, feedAbi, 'referenceIdentity', [], block.number),
      this.#call(target, feedAbi, 'price', [], block.number),
      this.#call(target, feedAbi, 'calendarObservedAt', [], block.number),
      this.#call(target, feedAbi, 'regularOpen', [], block.number),
      this.#call(target, feedAbi, 'regularClose', [], block.number),
    ]);
    if (
      !same(String(keeper[0]), binding.keeper) ||
      hash(String(identity[0])) !== hash(binding.referenceIdentity)
    )
      throw new Error('STOCK_FEED_IDENTITY');
    await this.#canonical(block);
    return {
      block,
      target,
      priceAt: Number(price[1]),
      calendarAt: Number(calendar[0]),
      opens: Number(opens[0]),
      closes: Number(closes[0]),
    };
  }
  async #submit(intent: OrderIntent, revalidate: () => Promise<void>) {
    if (this.#closed || !this.options.canWrite() || !this.options.activationValid())
      throw new Error('STOCK_WORKER_AUTHORIZATION');
    this.options.orders.prepare(intent);
    if (!this.options.submission) {
      this.status = 'PREPARED_SIGNING_DISABLED';
      return;
    }
    if (
      BigInt(this.options.orders.attempts() + 1) * uint(this.options.gas.maxGasCostWei) >
      uint(this.options.maxTotalGasCostWei)
    )
      throw new Error('STOCK_WORKER_GAS_BUDGET');
    const signer = this.options.submission.signers.find((s) => same(s.address, intent.executor));
    if (!signer) throw new Error('STOCK_WORKER_SIGNER_NOT_CONFIGURED');
    await submitRestrictedIntent(
      this.options.orders,
      intent,
      this.options.gas,
      signer,
      this.options.submission.transport,
      async () => {
        if (this.#closed || !this.options.canWrite() || !this.options.activationValid())
          throw new Error('STOCK_WORKER_AUTHORIZATION');
        await revalidate();
      },
    );
    this.status = 'AWAITING_CANONICAL_RECEIPT';
  }
  async #maintainFeed(binding: StockWorkerFeedBinding, reference: ConfirmedStockReference): Promise<boolean> {
    const state = await this.#feedState(binding),
      now = this.options.now?.() ?? Math.floor(Date.now() / 1000);
    if (this.options.orders.blocked(binding.keeper)) {
      this.status = 'PAUSED_UNCERTAIN_SUBMISSION';
      const pending = this.options.orders.db
        .prepare(
          "SELECT transaction_hash FROM orders WHERE executor=? AND state IN('RESERVED','SIGNED','BROADCAST_UNCERTAIN','REORGED') LIMIT 1",
        )
        .get(binding.keeper.toLowerCase());
      this.strategyStatus.set(binding.strategyId, {
        status: this.status,
        pendingHash: typeof pending?.transaction_hash === 'string' ? pending.transaction_hash : null,
      });
      return true;
    }
    const actions = prepareStockReferenceUpdate(state.target, reference, now).actions;
    const calendarNeeded =
      reference.calendarObservedAt > state.calendarAt &&
      (now - state.calendarAt >= 30 ||
        state.opens !== (reference.status === 'OPEN' ? reference.regularOpen : 0) ||
        state.closes !== (reference.status === 'OPEN' ? reference.regularClose : 0));
    const next = calendarNeeded
      ? actions[0]
      : actions[1] && reference.observedAt > state.priceAt
        ? actions[1]
        : undefined;
    if (!next) return false;
    const sourceDigest = this.options.evidence.capture({
      reference,
      action: next,
      providerEvidence: this.options.source.evidence?.(reference.strategyId) ?? null,
    });
    const basis = {
      purpose: 'FEED_UPDATE' as const,
      feed: state.target.toLowerCase(),
      chainId: 46630,
      owner: getAddress(binding.operatorOwner).toLowerCase(),
      executor: getAddress(binding.keeper).toLowerCase(),
      vault: this.options.manifest.vaultFactory!.toLowerCase(),
      manifestDigest: stockEvidenceHash(this.options.manifest),
      sourceDigest,
      grantVersion: '0',
      stateVersion: String(quantity(state.block.number)),
      snapshotHash: stockEvidenceHash({ state, reference }),
      calldata: next.data,
      createdAt: now * 1000,
    };
    const intent = { id: stockEvidenceHash({ feed: state.target, calldata: next.data }).slice(2), ...basis };
    // The same prepared feed action has immutable evidence, even if a later tick uses another head.
    const existing = this.options.orders.get(intent.id);
    if (existing && existing.state !== 'PREPARED') return false;
    await this.#submit(existing?.intent ?? intent, async () => {
      const fresh = await this.#feedState(binding),
        at = this.options.now?.() ?? Math.floor(Date.now() / 1000);
      const parsed = feedAbi.parseTransaction({ data: next.data })!;
      const observed = Number(parsed.args[parsed.name === 'update' ? 1 : 2]);
      if (
        observed > Number(quantity(fresh.block.timestamp)) ||
        at - observed > 60 ||
        (parsed.name === 'update' ? observed <= fresh.priceAt : observed < fresh.calendarAt)
      )
        throw new Error('STOCK_FEED_CHANGED_OR_STALE');
      if (parsed.name === 'update' && (at < reference.regularOpen || at >= reference.regularClose))
        throw new Error('STOCK_FEED_SESSION');
      await this.options.provider.request({
        method: 'eth_call',
        params: [
          { from: binding.keeper, to: fresh.target, data: next.data, value: '0x0' },
          fresh.block.number,
        ],
      });
    });
    this.strategyStatus.set(binding.strategyId, {
      status: this.status,
      pendingHash: this.options.orders.get(intent.id)?.transactionHash ?? null,
    });
    return true;
  }
  async #session(signed: SignedStockConsent, consentDigest: string, reference: ConfirmedStockReference) {
    if (this.options.sessionActive && !this.options.sessionActive(consentDigest))
      throw new Error('STOCK_SESSION_PAUSED');
    const c = signed.consent,
      now = this.options.now?.() ?? Math.floor(Date.now() / 1000);
    const decisions = this.options.evidence.decisions(consentDigest);
    let expectedVersion = uint(c.initialVersion),
      lastBuyAt: number | null = null,
      riskStopped = false;
    const completed = decisions
      .map((d) => ({ d, order: this.options.orders.get(d.id) }))
      .filter((v) => v.order?.state === 'RECONCILED')
      .sort((a, b) => (uint(a.d.version) < uint(b.d.version) ? -1 : 1));
    for (const { d, order } of completed) {
      if (uint(d.version) !== expectedVersion || !order?.evidence) throw new Error('STOCK_SESSION_HISTORY');
      const evidence = JSON.parse(order.evidence) as { version: string; timestamp: number; buy: boolean };
      if (uint(evidence.version) !== expectedVersion + 1n || !Number.isSafeInteger(evidence.timestamp))
        throw new Error('STOCK_SESSION_HISTORY');
      expectedVersion++;
      if (evidence.buy) lastBuyAt = evidence.timestamp;
      if (d.reason === 'RISK_EXIT') riskStopped = true;
    }
    const snapshot = await (this.options.readSnapshot ?? readStockExecutionSnapshot)(
      this.options.provider,
      this.options.manifest,
      c.owner,
      c.vault,
      c.strategyId,
    );
    if (uint(snapshot.version) !== expectedVersion) throw new Error('STOCK_SESSION_VERSION_CHANGED');
    if (this.options.orders.blocked(c.grant.executor)) throw new Error('STOCK_SESSION_PENDING');
    let bars: readonly StockMinuteBar[] = [];
    const priceNow = uint(snapshot.stockPriceUsdcRaw);
    const riskReached =
      riskStopped ||
      (uint(c.stopPriceUsdcRaw) > 0n && priceNow <= uint(c.stopPriceUsdcRaw)) ||
      (uint(c.takePriceUsdcRaw) > 0n && priceNow >= uint(c.takePriceUsdcRaw));
    if (c.policy.kind === 'EMA_CROSS' && !riskReached)
      bars = await this.options.source.minuteBars(reference, c.policy.slow * 3 + 1);
    const decision = decideStockOrder(c, snapshot, now, { lastBuyAt, riskStopped }, bars);
    if (!decision) {
      this.strategyStatus.set(c.strategyId, {
        status: riskStopped ? 'RISK_EXIT_COMPLETE' : 'WAITING_SIGNAL',
        pendingHash: null,
      });
      return;
    }
    const price = uint(snapshot.stockPriceUsdcRaw),
      input = uint(decision.inputRaw);
    const output = decision.buy ? (input * 10n ** 18n) / price : (input * price) / 10n ** 18n;
    const minOut = (output * BigInt(10000 - c.grant.maxSlippageBps)) / 10000n;
    const deadline = Math.min(
      now + 30,
      c.validUntil - 1,
      Number(c.grant.expiresAt) - 1,
      snapshot.referenceObservedAt + snapshot.maxPriceAge,
      snapshot.calendarObservedAt + 60,
      snapshot.regularClose - 1,
    );
    if (
      !output ||
      !minOut ||
      deadline <= now ||
      output > uint(decision.buy ? snapshot.reserveStockRaw : snapshot.reserveUsdcRaw) ||
      input > uint(decision.buy ? snapshot.vaultUsdcRaw : snapshot.vaultStockRaw)
    )
      throw new Error('STOCK_SESSION_CAPACITY_OR_DUST');
    const calldata = stockExecutionInterface.encodeFunctionData('execute', [
      decision.buy,
      input,
      minOut,
      deadline,
      expectedVersion,
    ]);
    const sourceDigest = this.options.evidence.capture({
      reference,
      bars,
      snapshot,
      decision,
      consentDigest,
      providerEvidence: this.options.source.evidence?.(reference.strategyId) ?? null,
    });
    const basis = {
      purpose: 'EXECUTE' as const,
      chainId: 46630,
      owner: getAddress(c.owner).toLowerCase(),
      executor: getAddress(c.grant.executor).toLowerCase(),
      vault: getAddress(c.vault).toLowerCase(),
      manifestDigest: c.manifestDigest,
      sourceDigest,
      grantVersion: c.initialVersion,
      stateVersion: String(expectedVersion),
      snapshotHash: stockEvidenceHash(snapshot),
      calldata,
      createdAt: now * 1000,
    };
    const intent: OrderIntent = {
      id: stockEvidenceHash({ consentDigest, version: String(expectedVersion), calldata }).slice(2),
      ...basis,
    };
    // Cancel only unsigned drafts. Reserved/signed/uncertain nonces remain blocked after expiry or crash.
    for (const d of decisions)
      if (
        d.version === String(expectedVersion) &&
        d.id !== intent.id &&
        this.options.orders.get(d.id)?.state === 'PREPARED'
      )
        this.options.orders.cancel(d.id);
    this.options.evidence.decision(
      intent.id,
      consentDigest,
      String(expectedVersion),
      decision.reason,
      sourceDigest,
    );
    const existing = this.options.orders.get(intent.id);
    if (existing && existing.state !== 'PREPARED') throw new Error('STOCK_SESSION_ATTEMPT_ALREADY_EXISTS');
    await this.#submit(existing?.intent ?? intent, async () => {
      if (this.options.sessionActive && !this.options.sessionActive(consentDigest))
        throw new Error('STOCK_SESSION_PAUSED');
      const fresh = await (this.options.readSnapshot ?? readStockExecutionSnapshot)(
        this.options.provider,
        this.options.manifest,
        c.owner,
        c.vault,
        c.strategyId,
      );
      const at = this.options.now?.() ?? Math.floor(Date.now() / 1000);
      const current = decideStockOrder(c, fresh, at, { lastBuyAt, riskStopped }, bars);
      if (
        !current ||
        current.buy !== decision.buy ||
        current.inputRaw !== decision.inputRaw ||
        fresh.version !== String(expectedVersion) ||
        fresh.referenceDigest !== snapshot.referenceDigest ||
        fresh.stockPriceUsdcRaw !== snapshot.stockPriceUsdcRaw ||
        fresh.calendarDigest !== snapshot.calendarDigest ||
        at >= deadline
      )
        throw new Error('STOCK_SESSION_STATE_CHANGED');
      await this.options.provider.request({
        method: 'eth_call',
        params: [
          { from: c.grant.executor, to: c.vault, data: calldata, value: '0x0' },
          `0x${uint(fresh.blockNumber).toString(16)}`,
        ],
      });
    });
    this.strategyStatus.set(c.strategyId, {
      status: this.status,
      pendingHash: this.options.orders.get(intent.id)?.transactionHash ?? null,
    });
  }
  async #tick() {
    if (this.#closed || !this.options.canWrite() || !this.options.activationValid())
      throw new Error('STOCK_WORKER_AUTHORIZATION');
    this.lastTickAt = this.options.now?.() ?? Math.floor(Date.now() / 1000);
    await this.reconcile();
    if (this.options.sessionProvider) {
      const sessions = await this.options.sessionProvider();
      if (
        sessions.length > 100 ||
        new Set(sessions.map((s) => getAddress(s.consent.vault))).size !== sessions.length
      )
        throw new Error('STOCK_WORKER_CONFIGURATION');
      const digests = sessions.map((signed) => {
        if (signed.consent.manifestDigest !== stockEvidenceHash(this.options.manifest))
          throw new Error('STOCK_POLICY_MANIFEST');
        return verifyStockConsent(signed);
      });
      this.#sessions = sessions;
      this.consentDigests = digests;
    }
    let feedAction = false;
    const references = new Map<StrategyId, ConfirmedStockReference>();
    for (const strategyId of new Set([
      ...this.options.feeds.map((f) => f.strategyId),
      ...this.#sessions.map((s) => s.consent.strategyId),
    ])) {
      try {
        const now = this.options.now?.() ?? Math.floor(Date.now() / 1000);
        let reference = this.#referenceTargets.get(strategyId);
        if (!reference || now - Math.min(reference.calendarObservedAt, reference.observedAt) > 30) {
          reference = await this.options.source.read(strategyId);
          this.#referenceTargets.set(strategyId, reference);
        }
        references.set(strategyId, reference);
        this.options.evidence.capture(reference);
        const binding = this.options.feeds.find((f) => f.strategyId === strategyId);
        if (binding && !feedAction) {
          feedAction = await this.#maintainFeed(binding, reference);
          if (!feedAction) this.#referenceTargets.delete(strategyId);
        }
        if (reference.status === 'CLOSED')
          this.strategyStatus.set(strategyId, { status: 'MARKET_CLOSED', pendingHash: null });
      } catch (error) {
        references.delete(strategyId);
        this.strategyStatus.set(strategyId, { status: safeReason(error), pendingHash: null });
      }
    }
    // A feed update must reconcile before it can be used for orders. Shared signers never race nonces.
    if (feedAction) return;
    for (let i = 0; i < this.#sessions.length; i++) {
      const signed = this.#sessions[i]!,
        reference = references.get(signed.consent.strategyId);
      if (!reference || reference.status !== 'OPEN') continue;
      try {
        await this.#session(signed, this.consentDigests[i]!, reference);
      } catch (error) {
        this.strategyStatus.set(signed.consent.strategyId, { status: safeReason(error), pendingHash: null });
      }
    }
    this.status = this.options.submission ? 'RUNNING' : 'PREPARE_ONLY';
  }
  tick(): Promise<void> {
    const next = this.#tail
      .then(() => this.#tick())
      .catch((error: unknown) => {
        this.status = safeReason(error);
      });
    this.#tail = next;
    return next;
  }
  async reconcile(): Promise<void> {
    const active = this.options.orders.db
      .prepare("SELECT id FROM orders WHERE state='BROADCAST_UNCERTAIN' ORDER BY id LIMIT 101")
      .all();
    if (active.length > 100) throw new Error('STOCK_WORKER_RECONCILIATION_LIMIT');
    const historical = this.options.orders.reconcileCandidates(this.#reconcileCursor);
    this.#reconcileCursor = historical.at(-1)?.intent.id ?? '';
    const ids = new Set([...active.map((r) => String(r.id)), ...historical.map((o) => o.intent.id)]);
    for (const id of ids) await reconcileStockWorkerOrder(this.options.provider, this.options.orders, id);
  }
  async close() {
    this.#closed = true;
    await this.#tail;
  }
}
function safeReason(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.message)
    ? error.message
    : 'STOCK_WORKER_UNAVAILABLE';
}
/** Three canonical confirmations, exact envelope and emitted execution version. Never rebroadcast. */
export async function reconcileStockWorkerOrder(
  provider: Eip1193Provider,
  orders: OrderJournal,
  id: string,
): Promise<void> {
  const order = orders.get(id);
  if (!order?.transactionHash) return;
  if (quantity(await provider.request({ method: 'eth_chainId' })) !== 46630n)
    throw new Error('STOCK_WORKER_CHAIN');
  const receipt = (await provider.request({
    method: 'eth_getTransactionReceipt',
    params: [order.transactionHash],
  })) as {
    transactionHash: string;
    from: string;
    to: string;
    status: string;
    blockNumber: string;
    blockHash: string;
    logs: readonly {
      address: string;
      data: string;
      topics: readonly string[];
      transactionHash: string;
      removed?: boolean;
    }[];
  } | null;
  if (!receipt) {
    if (['RECONCILED', 'REVERTED', 'REORGED'].includes(order.state))
      orders.recordOutcome(id, 'REORGED', JSON.stringify({ reason: 'RECEIPT_REMOVED' }));
    return;
  }
  const tx = (await provider.request({
    method: 'eth_getTransactionByHash',
    params: [order.transactionHash],
  })) as {
    hash: string;
    from: string;
    to: string;
    input: string;
    value: string;
    nonce: string;
    blockHash: string;
    blockNumber: string;
  } | null;
  const target = order.intent.feed ?? order.intent.vault;
  if (
    !tx ||
    hash(tx.hash) !== order.transactionHash ||
    !same(tx.from, order.intent.executor) ||
    !same(tx.to, target) ||
    tx.input.toLowerCase() !== order.intent.calldata.toLowerCase() ||
    quantity(tx.value) !== 0n ||
    String(quantity(tx.nonce)) !== order.nonce ||
    hash(receipt.transactionHash) !== order.transactionHash ||
    !same(receipt.from, order.intent.executor) ||
    !same(receipt.to, target) ||
    !['0x0', '0x1'].includes(receipt.status) ||
    tx.blockNumber !== receipt.blockNumber ||
    hash(tx.blockHash) !== hash(receipt.blockHash)
  )
    throw new Error('STOCK_WORKER_RECEIPT_IDENTITY');
  const block = (await provider.request({
    method: 'eth_getBlockByNumber',
    params: [receipt.blockNumber, false],
  })) as { hash: string; timestamp: string } | null;
  if (!block || hash(block.hash) !== hash(receipt.blockHash)) {
    orders.recordOutcome(
      id,
      'REORGED',
      JSON.stringify({ reason: 'NON_CANONICAL_RECEIPT', blockHash: receipt.blockHash }),
    );
    return;
  }
  const head = quantity(await provider.request({ method: 'eth_blockNumber' }));
  if (head < quantity(receipt.blockNumber) + 2n) return;
  const timestamp = Number(quantity(block.timestamp));
  if (!Number.isSafeInteger(timestamp)) throw new Error('STOCK_WORKER_RECEIPT_TIME');
  if (receipt.status === '0x0') {
    const final = (await provider.request({
      method: 'eth_getBlockByNumber',
      params: [receipt.blockNumber, false],
    })) as { hash: string } | null;
    if (!final || hash(final.hash) !== hash(receipt.blockHash)) throw new Error('STOCK_WORKER_REORG');
    orders.recordOutcome(id, 'REVERTED', JSON.stringify({ blockHash: receipt.blockHash, timestamp }));
    return;
  }
  const abi = order.intent.purpose === 'FEED_UPDATE' ? feedAbi : executionEvent;
  const events = receipt.logs
    .filter((l) => same(l.address, target) && !l.removed && hash(l.transactionHash) === order.transactionHash)
    .map((log) => abi.parseLog({ data: log.data, topics: [...log.topics] }))
    .filter((v) => v !== null);
  let evidence: Record<string, unknown> = { blockHash: receipt.blockHash, timestamp };
  if (order.intent.purpose === 'FEED_UPDATE') {
    const call = feedAbi.parseTransaction({ data: order.intent.calldata })!;
    const eventName = call.name === 'update' ? 'ReferenceUpdated' : 'SessionUpdated';
    if (
      events.length !== 1 ||
      events[0]!.name !== eventName ||
      events[0]!.args.length !== call.args.length ||
      events[0]!.args.some((v, i) => String(v).toLowerCase() !== String(call.args[i]).toLowerCase())
    )
      throw new Error('STOCK_WORKER_FEED_RECEIPT');
  } else {
    const call = stockExecutionInterface.parseTransaction({ data: order.intent.calldata });
    const event = events[0];
    if (
      !call ||
      events.length !== 1 ||
      event!.name !== 'StrategyExecuted' ||
      event!.args[0] !== call.args[0] ||
      event!.args[1] !== call.args[1] ||
      event!.args[2] < call.args[2] ||
      event!.args[3] !== uint(order.intent.stateVersion) + 1n
    )
      throw new Error('STOCK_WORKER_EXECUTION_RECEIPT');
    evidence = {
      ...evidence,
      buy: Boolean(event!.args[0]),
      output: String(event!.args[2]),
      version: String(event!.args[3]),
    };
  }
  // Pin again after the receipt/log reads so an in-flight reorganization cannot be accepted.
  const final = (await provider.request({
    method: 'eth_getBlockByNumber',
    params: [receipt.blockNumber, false],
  })) as { hash: string } | null;
  if (!final || hash(final.hash) !== hash(receipt.blockHash)) throw new Error('STOCK_WORKER_REORG');
  orders.recordOutcome(id, 'RECONCILED', JSON.stringify(evidence));
}
