import { randomBytes, randomUUID } from 'node:crypto';
import type { TypedDataDomain, TypedDataField } from 'ethers';
import { address, CLAIM_USDC, hash, uint, configuration } from './config.ts';
import { claimVoucherTypes, marketInterfaces, nativeQuoteTypes, validateQuoteTransaction } from './abi.ts';
import { ceilDiv, ethSaleOutput, minOutput, mintCost, usdcForEth } from './math.ts';
import { MarketEventBroker, MarketProjector, type IndexedMarketClaim } from './projection.ts';
import type { LaunchMarketStore } from './store.ts';
import type { EthReferenceProvider, MarketChain, MarketSnapshotTarget } from './chain.ts';
import {
  LaunchMarketError,
  type LaunchMarketManifest,
  type MarketAccount,
  type MarketQuote,
  type MarketSnapshot,
  type MarketTrackedOperation,
  type QuoteRequest,
  type TrustedEmailIdentity,
} from './types.ts';

export interface MarketQuoteSigner {
  getAddress(): Promise<string>;
  signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>,
  ): Promise<string>;
}
export interface LaunchMarketServiceOptions {
  readonly manifest: LaunchMarketManifest | null;
  readonly store: LaunchMarketStore;
  readonly chain: MarketChain | null;
  readonly ethReference: EthReferenceProvider | null;
  readonly quoteSigner: MarketQuoteSigner | null;
  readonly claimSigner: MarketQuoteSigner | null;
  readonly now?: () => number;
  readonly broker?: MarketEventBroker;
  /** The event indexer alone publishes projections; API reads cannot move its checkpoint. */
  readonly indexedSnapshots?: boolean;
  readonly vaultQuote?: (
    request: QuoteRequest,
    account: MarketAccount,
    snapshot: MarketSnapshot,
    expiresAt: number,
  ) => Promise<MarketQuote>;
}
export class LaunchMarketService {
  readonly options: LaunchMarketServiceOptions;
  readonly projector: MarketProjector;
  readonly broker: MarketEventBroker;
  readonly now: () => number;
  #refreshing: Promise<MarketSnapshot> | null = null;
  constructor(options: LaunchMarketServiceOptions) {
    configuration(options.manifest);
    this.options = options;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.broker = options.broker ?? new MarketEventBroker();
    this.projector = new MarketProjector(options.store, this.broker);
  }
  config() {
    return configuration(this.options.manifest);
  }
  /** Public indicative price only: does not create an account, order quote or signer nonce. */
  async ethReference(): Promise<{ ethUsdPriceRaw: string; observedAt: number; validUntil: number }> {
    const provider = this.options.ethReference;
    if (!provider) throw new LaunchMarketError('ETH_REFERENCE_NOT_CONFIGURED', 503);
    let reference;
    try {
      reference = await provider.read();
    } catch {
      throw new LaunchMarketError('ETH_REFERENCE_UNAVAILABLE', 503);
    }
    // Provider latency consumes the same freshness window as a cached price's age.
    const now = this.now();
    let price;
    try {
      price = uint(reference?.ethUsdPriceRaw);
    } catch {
      throw new LaunchMarketError('ETH_REFERENCE_INVALID', 503);
    }
    const observedAt = reference.observedAt;
    if (
      price === 0n ||
      !Number.isSafeInteger(observedAt) ||
      observedAt < 0 ||
      observedAt > Number.MAX_SAFE_INTEGER - 30
    )
      throw new LaunchMarketError('ETH_REFERENCE_INVALID', 503);
    const validUntil = observedAt + 30;
    if (!Number.isSafeInteger(now) || now < 0 || observedAt > now || now > validUntil)
      throw new LaunchMarketError('ETH_REFERENCE_STALE', 503);
    return { ethUsdPriceRaw: reference.ethUsdPriceRaw, observedAt, validUntil };
  }
  private deployed() {
    if (!this.options.manifest || !this.options.chain) throw new LaunchMarketError('NOT_DEPLOYED', 503);
    return { manifest: this.options.manifest, chain: this.options.chain };
  }
  account(identity: TrustedEmailIdentity): MarketAccount {
    return this.options.store.trustedAccount(identity, this.now());
  }
  async snapshot(): Promise<MarketSnapshot> {
    if (this.#refreshing) return this.#refreshing;
    const next = this.refresh();
    this.#refreshing = next;
    try {
      return await next;
    } finally {
      if (this.#refreshing === next) this.#refreshing = null;
    }
  }
  /** Read the scanner's captured checkpoint without publishing or modifying any projection. */
  async readSnapshotAt(at: MarketSnapshotTarget): Promise<MarketSnapshot> {
    const { chain, manifest } = this.deployed();
    const target = { blockNumber: uint(at.blockNumber).toString(), blockHash: hash(at.blockHash) };
    const snapshot = await chain.snapshot(target);
    if (
      snapshot.location.chainId !== manifest.chainId ||
      snapshot.location.blockNumber !== target.blockNumber ||
      snapshot.location.blockHash.toLowerCase() !== target.blockHash
    )
      throw new LaunchMarketError('INDEX_SNAPSHOT_FORK', 503);
    if ((await chain.canonicalBlockHash(target.blockNumber))?.toLowerCase() !== target.blockHash)
      throw new LaunchMarketError('NON_CANONICAL_MARKET_HEAD', 503);
    return snapshot;
  }
  private async refresh(): Promise<MarketSnapshot> {
    const { chain } = this.deployed();
    if (this.options.indexedSnapshots) return this.readIndexedSnapshot(chain);
    const snapshot = await chain.snapshot();
    if (
      (await chain.canonicalBlockHash(snapshot.location.blockNumber))?.toLowerCase() !==
      snapshot.location.blockHash.toLowerCase()
    )
      throw new LaunchMarketError('NON_CANONICAL_MARKET_HEAD', 503);
    const previous = this.projector.latest();
    let previousHash: string | null = null;
    if (previous) {
      previousHash = await chain.canonicalBlockHash(previous.location.blockNumber);
      if (
        previousHash?.toLowerCase() !== previous.location.blockHash.toLowerCase() ||
        uint(snapshot.location.blockNumber) < uint(previous.location.blockNumber)
      ) {
        let ancestor: { blockNumber: string; blockHash: string } | null = null;
        for (const candidate of this.projector.history()) {
          if (uint(candidate.blockNumber) > uint(snapshot.location.blockNumber)) continue;
          if (
            (await chain.canonicalBlockHash(candidate.blockNumber))?.toLowerCase() ===
            candidate.blockHash.toLowerCase()
          ) {
            ancestor = candidate;
            break;
          }
        }
        this.projector.rollbackFrom(
          ancestor ? (uint(ancestor.blockNumber) + 1n).toString() : this.options.manifest!.deploymentBlock,
        );
        previousHash = ancestor?.blockHash ?? null;
      }
    }
    const parent =
      uint(snapshot.location.blockNumber) === 0n
        ? hash('0x' + '00'.repeat(32))
        : await chain.canonicalBlockHash((uint(snapshot.location.blockNumber) - 1n).toString());
    if (!parent) throw new LaunchMarketError('BLOCK_UNAVAILABLE', 503);
    return this.projector.commit(snapshot, parent, previousHash);
  }
  private async readIndexedSnapshot(chain: MarketChain): Promise<MarketSnapshot> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const indexed = this.projector.latest();
      const snapshot = indexed ?? (await chain.snapshot());
      const canonical = await chain.canonicalBlockHash(snapshot.location.blockNumber);
      const current = this.projector.latest();
      if (
        indexed
          ? current?.location.version !== indexed.location.version ||
            current.location.blockHash !== indexed.location.blockHash
          : current !== null
      )
        continue;
      if (canonical?.toLowerCase() !== snapshot.location.blockHash.toLowerCase())
        throw new LaunchMarketError('NON_CANONICAL_MARKET_HEAD', 503);
      // A fresh bootstrap read keeps the UI available before the first complete indexed snapshot.
      // It neither creates a durable projection nor advances the event scanner's checkpoint.
      return indexed ?? { ...snapshot, location: { ...snapshot.location, version: '0' } };
    }
    throw new LaunchMarketError('MARKET_HISTORY_SYNCING', 503);
  }
  /** Root's event scanner supplies verified receipt/log identities for eligibility reconciliation. */
  publish(
    snapshot: MarketSnapshot,
    parentHash: string,
    previousCanonicalHash: string | null,
    claims: readonly IndexedMarketClaim[] = [],
  ): MarketSnapshot {
    return this.projector.commit(snapshot, parentHash, previousCanonicalHash, claims);
  }
  async wallet(ownerInput: string, accountId: string | null = null) {
    const { chain } = this.deployed(),
      owner = address(ownerInput),
      result = await chain.wallet(owner);
    if (address(result.owner) !== owner || result.location.chainId !== this.options.manifest!.chainId)
      throw new LaunchMarketError('WALLET_PROJECTION_MISMATCH', 503);
    const linked = accountId !== null && this.options.store.account(accountId).wallet === owner;
    return { ...result, accountId: linked ? accountId : null };
  }
  async quote(request: QuoteRequest, accountId: string): Promise<MarketQuote> {
    const { manifest, chain } = this.deployed(),
      store = this.options.store,
      account = store.requireWallet(accountId, request.owner);
    const amount = uint(request.amountRaw),
      owner = address(request.owner);
    let now = this.now();
    if (
      !['TSLA', 'AMZN'].includes(request.strategyId) ||
      !['ETH', 'AF_USDC'].includes(request.asset) ||
      !['MINT', 'BUY', 'SELL', 'CLAIM', 'CREATE_VAULT', 'DEPOSIT', 'WITHDRAW', 'CLOSE'].includes(
        request.operation,
      )
    )
      throw new LaunchMarketError('INVALID_QUOTE_REQUEST', 400);
    if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 500)
      throw new LaunchMarketError('SLIPPAGE_LIMIT', 400);
    let expiresAt = now + 60;
    const snapshot = await this.snapshot(),
      market = snapshot.markets[request.strategyId],
      strategy = manifest.strategies[request.strategyId];
    if (['CREATE_VAULT', 'DEPOSIT', 'WITHDRAW', 'CLOSE'].includes(request.operation)) {
      if (!this.options.vaultQuote) throw new LaunchMarketError('VAULT_NOT_CONFIGURED', 503);
      const result = await this.options.vaultQuote(request, account, snapshot, expiresAt);
      store.saveQuote(accountId, result);
      return result;
    }
    const wallet = await this.wallet(owner, accountId);
    now = this.now();
    expiresAt = now + 60;
    let output = 0n,
      minOut = 0n,
      feeUsdc = 0n,
      conversionFee = 0n,
      impact = 0,
      reference: MarketQuote['reference'] = null;
    let transaction: MarketQuote['transaction'],
      allowance: MarketQuote['allowance'] = null;
    if (request.operation === 'CLAIM') {
      if (amount !== 0n || !snapshot.claim.funded || snapshot.claim.remainingClaims === 0)
        throw new LaunchMarketError('CLAIM_UNAVAILABLE');
      if (!this.options.claimSigner) throw new LaunchMarketError('CLAIM_SIGNER_NOT_CONFIGURED', 503);
      const policy = await chain.signingPolicy();
      if (!policy.claimsOpened) throw new LaunchMarketError('CLAIM_NOT_OPEN');
      if (address(await this.options.claimSigner.getAddress()) !== address(policy.claimSigner))
        throw new LaunchMarketError('CLAIM_SIGNER_MISMATCH', 503);
      const voucher = store.reserveClaim(accountId, owner, now, expiresAt, snapshot.claim.successfulClaims);
      expiresAt = voucher.deadline;
      const value = {
        accountId: voucher.accountKey,
        wallet: owner,
        nonce: voucher.nonce,
        issuedAt: voucher.issuedAt,
        deadline: voucher.deadline,
        epoch: policy.claimEpoch,
      };
      const signature = await this.options.claimSigner.signTypedData(
        {
          name: 'AlphaForge Free AF-USDC',
          version: '1',
          chainId: manifest.chainId,
          verifyingContract: manifest.claim,
        },
        claimVoucherTypes,
        value,
      );
      transaction = {
        to: manifest.claim,
        data: marketInterfaces.claim.encodeFunctionData('claim', [value, signature]),
        value: '0',
      };
      output = CLAIM_USDC;
      minOut = output;
    } else {
      if (amount === 0n) throw new LaunchMarketError('INVALID_AMOUNT', 400);
      if (request.operation === 'MINT') {
        if (request.strategyId !== 'TSLA' || market.state !== 'MINTING' || !strategy.launch)
          throw new LaunchMarketError('MINT_NOT_OPEN');
        if (amount > uint(market.remainingRaw)) throw new LaunchMarketError('OVERSELL');
        output = amount;
        minOut = amount;
        mintCost(amount);
      } else {
        if (market.state !== 'LAUNCHED' || !market.pool) throw new LaunchMarketError('TRADING_NOT_OPEN');
        if (request.operation === 'SELL' && uint(wallet.passes[request.strategyId].availableRaw) < amount)
          throw new LaunchMarketError('INSUFFICIENT_AVAILABLE_PASS');
      }
      if (request.asset === 'ETH') {
        if (!this.options.ethReference || !this.options.quoteSigner)
          throw new LaunchMarketError('NATIVE_QUOTES_NOT_CONFIGURED', 503);
        if (
          request.operation === 'SELL'
            ? !snapshot.conversion.ethSellAvailable
            : request.operation === 'MINT'
              ? !(snapshot.conversion.ethMintAvailable ?? snapshot.conversion.ethBuyAvailable)
              : !snapshot.conversion.ethBuyAvailable
        )
          throw new LaunchMarketError('ETH_PATH_UNAVAILABLE');
        reference = await this.options.ethReference.read();
        now = this.now();
        expiresAt = now + 60;
        const price = uint(reference.ethUsdPriceRaw);
        if (
          price === 0n ||
          !Number.isSafeInteger(reference.observedAt) ||
          reference.observedAt > now ||
          now - reference.observedAt > 30
        )
          throw new LaunchMarketError('ETH_REFERENCE_STALE', 503);
        expiresAt = Math.min(expiresAt, reference.observedAt + 60);
        if (expiresAt <= now) throw new LaunchMarketError('ETH_REFERENCE_STALE', 503);
        const policy = await chain.signingPolicy();
        if (address(await this.options.quoteSigner.getAddress()) !== address(policy.quoteSigner))
          throw new LaunchMarketError('QUOTE_SIGNER_MISMATCH', 503);
        let usdcAmount: bigint,
          ethAmount: bigint,
          minUsdc = 0n;
        if (request.operation === 'MINT') {
          usdcAmount = mintCost(amount);
          ethAmount = ceilDiv(usdcAmount * 10n ** 18n, price);
        } else if (request.operation === 'BUY') {
          ethAmount = amount;
          usdcAmount = usdcForEth(amount, price, snapshot.conversion.feeBps);
          conversionFee = (amount * price) / 10n ** 18n - usdcAmount;
          if (usdcAmount > uint(snapshot.conversion.usdcReserveRaw))
            throw new LaunchMarketError('USDC_CONVERSION_LIQUIDITY');
          const quoted = await chain.quoteAmm(
            request.strategyId,
            'BUY',
            usdcAmount.toString(),
            snapshot.location.blockHash,
          );
          output = uint(quoted.outputRaw);
          feeUsdc = uint(quoted.feeRaw);
          minOut = minOutput(output, request.slippageBps);
        } else {
          const quoted = await chain.quoteAmm(
            request.strategyId,
            'SELL',
            amount.toString(),
            snapshot.location.blockHash,
          );
          usdcAmount = uint(quoted.outputRaw);
          minUsdc = minOutput(usdcAmount, request.slippageBps);
          ethAmount = ethSaleOutput(usdcAmount, price, snapshot.conversion.feeBps);
          output = ethAmount;
          minOut = ethSaleOutput(minUsdc, price, snapshot.conversion.feeBps);
          conversionFee = ceilDiv(usdcAmount * BigInt(snapshot.conversion.feeBps), 10_000n);
          if (ethAmount > uint(snapshot.conversion.ethReserveRaw))
            throw new LaunchMarketError('ETH_CONVERSION_LIQUIDITY');
          feeUsdc = (uint(quoted.feeRaw) * uint(market.reserveUsdcRaw)) / uint(market.reservePassRaw);
          allowance = { token: strategy.pass, spender: manifest.router, amountRaw: amount.toString() };
        }
        if (request.operation !== 'SELL' && uint(wallet.ethBalanceRaw) < ethAmount)
          throw new LaunchMarketError('INSUFFICIENT_ETH');
        const router = request.operation === 'MINT' ? strategy.launch! : manifest.router;
        const value = {
          router,
          payer: owner,
          accountId: account.accountKey,
          operation: ['MINT', 'BUY', 'SELL'].indexOf(request.operation),
          pass: strategy.pass,
          amountIn: (request.operation === 'SELL' ? amount : ethAmount).toString(),
          usdcAmount: (request.operation === 'SELL' ? minUsdc : usdcAmount).toString(),
          minOut: minOut.toString(),
          ethAmount: ethAmount.toString(),
          ethUsdPrice: price.toString(),
          nonce: BigInt('0x' + randomBytes(32).toString('hex')).toString(),
          issuedAt: now,
          deadline: expiresAt,
          epoch: policy.quoteEpoch,
        };
        const signature = await this.options.quoteSigner.signTypedData(
          {
            name: 'AlphaForge Native Conversion',
            version: '1',
            chainId: manifest.chainId,
            verifyingContract: manifest.conversionReserve,
          },
          nativeQuoteTypes,
          value,
        );
        const data =
          request.operation === 'MINT'
            ? marketInterfaces.launch.encodeFunctionData('subscribeEth', [amount, value, signature])
            : marketInterfaces.router.encodeFunctionData(
                request.operation === 'BUY' ? 'buyNative' : 'sellNative',
                [value, signature],
              );
        transaction = { to: router, data, value: request.operation === 'SELL' ? '0' : ethAmount.toString() };
      } else if (request.operation === 'MINT') {
        const cost = mintCost(amount);
        if (uint(wallet.usdcBalanceRaw) < cost) throw new LaunchMarketError('INSUFFICIENT_AF_USDC');
        transaction = {
          to: strategy.launch!,
          data: marketInterfaces.launch.encodeFunctionData('subscribeUsdc', [amount, expiresAt]),
          value: '0',
        };
        allowance = { token: manifest.usdc, spender: strategy.launch!, amountRaw: cost.toString() };
      } else {
        if (request.operation === 'BUY' && uint(wallet.usdcBalanceRaw) < amount)
          throw new LaunchMarketError('INSUFFICIENT_AF_USDC');
        const quoted = await chain.quoteAmm(
          request.strategyId,
          request.operation === 'BUY' ? 'BUY' : 'SELL',
          amount.toString(),
          snapshot.location.blockHash,
        );
        output = uint(quoted.outputRaw);
        minOut = minOutput(output, request.slippageBps);
        feeUsdc =
          request.operation === 'BUY'
            ? uint(quoted.feeRaw)
            : (uint(quoted.feeRaw) * uint(market.reserveUsdcRaw)) / uint(market.reservePassRaw);
        transaction = {
          to: market.pool!,
          data: marketInterfaces.pool.encodeFunctionData(request.operation === 'BUY' ? 'buy' : 'sell', [
            amount,
            minOut,
            owner,
            expiresAt,
          ]),
          value: '0',
        };
        allowance = {
          token: request.operation === 'BUY' ? manifest.usdc : strategy.pass,
          spender: market.pool!,
          amountRaw: amount.toString(),
        };
      }
      if (request.operation !== 'MINT') {
        const ammIn =
          request.operation === 'BUY' && request.asset === 'ETH'
            ? usdcForEth(amount, uint(reference!.ethUsdPriceRaw), snapshot.conversion.feeBps)
            : amount;
        const reserveIn = uint(request.operation === 'BUY' ? market.reserveUsdcRaw : market.reservePassRaw),
          reserveOut = uint(request.operation === 'BUY' ? market.reservePassRaw : market.reserveUsdcRaw);
        const spot = (ammIn * reserveOut) / reserveIn,
          ammOut =
            request.operation === 'SELL' && request.asset === 'ETH'
              ? uint(
                  (
                    await chain.quoteAmm(
                      request.strategyId,
                      'SELL',
                      amount.toString(),
                      snapshot.location.blockHash,
                    )
                  ).outputRaw,
                )
              : output;
        impact = spot === 0n ? 0 : Number(((spot > ammOut ? spot - ammOut : 0n) * 10_000n) / spot);
      }
    }
    const base: MarketQuote = {
      id: randomUUID(),
      owner,
      strategyId: request.strategyId,
      operation: request.operation,
      asset: request.asset,
      amountInRaw: amount.toString(),
      estimatedOutRaw: output.toString(),
      minOutRaw: minOut.toString(),
      feeUsdcRaw: feeUsdc.toString(),
      conversionFeeUsdcRaw: conversionFee.toString(),
      priceImpactBps: impact,
      expiresAt,
      reference,
      transaction,
      allowance,
      gasEstimateRaw: null,
      simulation: 'READY',
      location: snapshot.location,
    };
    validateQuoteTransaction(base, manifest, snapshot);
    let quote: MarketQuote;
    try {
      const gas = await chain.simulate(transaction, owner);
      if (uint(gas) === 0n) throw new LaunchMarketError('INVALID_GAS_ESTIMATE', 503);
      quote = { ...base, allowance: null, gasEstimateRaw: gas };
    } catch (error) {
      if (error instanceof LaunchMarketError && error.code === 'ALLOWANCE_REQUIRED' && allowance)
        quote = { ...base, simulation: 'APPROVAL_REQUIRED' };
      else throw error;
    }
    if (this.now() >= quote.expiresAt) throw new LaunchMarketError('QUOTE_EXPIRED');
    store.saveQuote(accountId, quote);
    return quote;
  }
  async submit(
    accountId: string,
    quoteId: string,
    txHashInput: string,
    ownerInput: string,
  ): Promise<MarketTrackedOperation> {
    const { chain, manifest } = this.deployed(),
      store = this.options.store,
      quote = store.quote(quoteId, accountId),
      owner = address(ownerInput),
      txHash = hash(txHashInput);
    store.requireWallet(accountId, owner);
    if (owner !== quote.owner) throw new LaunchMarketError('OWNER_MISMATCH', 403);
    const transaction = await chain.transaction(txHash);
    if (!transaction) throw new LaunchMarketError('TRANSACTION_NOT_OBSERVED', 503);
    if (
      transaction.chainId !== manifest.chainId ||
      address(transaction.from) !== owner ||
      address(transaction.to) !== address(quote.transaction.to) ||
      transaction.data.toLowerCase() !== quote.transaction.data.toLowerCase() ||
      uint(transaction.value) !== uint(quote.transaction.value) ||
      hash(transaction.hash) !== txHash
    )
      throw new LaunchMarketError('TRANSACTION_MISMATCH', 403);
    return store.submit(accountId, quoteId, txHash);
  }
  async operation(accountId: string, id: string): Promise<MarketTrackedOperation> {
    const { chain } = this.deployed(),
      store = this.options.store,
      old = store.operation(id, accountId),
      receipt = await chain.receipt(old.transactionHash);
    let next = old;
    if (!receipt) {
      if (old.location) next = { ...old, state: 'REORGED', confirmations: 0, error: 'RECEIPT_REMOVED' };
    } else {
      const canonical = await chain.canonicalBlockHash(receipt.blockNumber),
        snapshot = await this.snapshot();
      if (
        hash(receipt.transactionHash) !== old.transactionHash ||
        canonical?.toLowerCase() !== receipt.blockHash.toLowerCase()
      )
        next = { ...old, state: 'REORGED', confirmations: 0, error: 'NON_CANONICAL_RECEIPT' };
      else {
        // The event scanner can lag behind a newly mined transaction. Its
        // projection version remains metadata, never the confirmation clock.
        const head = chain.head
          ? await chain.head()
          : await chain.snapshot().then((value) => ({
              number: value.location.blockNumber,
              hash: value.location.blockHash,
            }));
        const headNumber = uint(BigInt(head.number).toString());
        if ((await chain.canonicalBlockHash(headNumber.toString()))?.toLowerCase() !== hash(head.hash))
          throw new LaunchMarketError('NON_CANONICAL_MARKET_HEAD', 503);
        const depth = headNumber - uint(receipt.blockNumber) + 1n;
        const confirmations = depth > 0n ? Number(depth) : 0;
        next = {
          ...old,
          state: receipt.status === 'REVERTED' ? 'REVERTED' : confirmations >= 3 ? 'COMPLETED' : 'INCLUDED',
          confirmations,
          location: {
            ...snapshot.location,
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash,
            transactionHash: old.transactionHash,
            confirmations,
          },
          error: receipt.status === 'REVERTED' ? 'TRANSACTION_REVERTED' : null,
        };
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(old)) {
      store.updateOperation(next);
      if (next.location) this.broker.publish({ type: 'OPERATION', location: next.location, operation: next });
    }
    return next;
  }
  close(): void {
    this.broker.close();
    this.options.store.close();
  }
}
