import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { id } from 'ethers';
import { readRegularBytes } from '../../packages/testnet/src/bounded-file.ts';
import { privateServerStorage } from '../../packages/testnet/src/private-storage.ts';
import { LaunchMarketStore } from '../../packages/launch-market/src/store.ts';
import { CommunityStore } from '../../packages/launch-market/src/community.ts';
import { CreatorStrategyStore } from '../../packages/launch-market/src/creator.ts';
import { VaultRunStore, VAULT_RUN_APPLICATION_ID } from '../../packages/launch-market/src/vault-run.ts';
import { LaunchMarketService } from '../../packages/launch-market/src/service.ts';
import {
  LaunchMarketError,
  type LaunchMarketManifest,
  type StrategyId,
} from '../../packages/launch-market/src/types.ts';
import { AccessIdentityBridge } from '../../apps/server/src/launch-market-adapters/access-identity.ts';
import { AccessIdentitySocketClient } from '../../apps/server/src/launch-market-adapters/access-identity-socket.ts';
import { loadOfflineVoucherSigner } from '../../apps/server/src/launch-market-adapters/offline-voucher-signer.ts';
import { VerifiedEthReference } from '../../apps/server/src/launch-market-adapters/eth-reference.ts';
import { RpcMarketChain } from '../../apps/server/src/launch-market-adapters/rpc-chain.ts';
import { buildVaultQuote } from '../../apps/server/src/launch-market-adapters/vault-quotes.ts';
import { MarketEventIndexer } from '../../apps/server/src/launch-market/indexer.ts';
import { buildLaunchMarketServer } from '../../apps/server/src/launch-market/server.ts';
import { StockConsentRegistry } from '../../apps/server/src/launch-market-adapters/stock-consent-registry.ts';
import { buildStockAutomationRuntime } from '../../apps/server/src/launch-market-adapters/stock-automation-runtime.ts';
import { stockWorkerReadProvider } from '../../apps/server/src/launch-market-adapters/stock-worker-rpc.ts';
import { stockEvidenceHash } from '../../apps/server/src/launch-market-adapters/stock-worker-policy.ts';
import { VaultRunChain } from '../../apps/server/src/launch-market-adapters/vault-run-chain.ts';
import { VaultReferenceDemand } from '../../apps/server/src/launch-market-adapters/vault-reference-demand.ts';
import { VaultValuations } from '../../apps/server/src/launch-market-adapters/vault-valuation.ts';
import { loadStockDataReference } from '../../apps/server/src/launch-market-adapters/stock-data-credentials.ts';
import { StockDataCredentialStore } from '../../apps/server/src/launch-market-adapters/stock-data-credential-store.ts';
import { PaperLedger, PAPER_LEDGER_APPLICATION_ID } from '../../packages/launch-market/src/paper-ledger.ts';
import {
  PaperMarketDataCache,
  isPaperEntryQuote,
} from '../../apps/server/src/launch-market-adapters/paper-market-data.ts';
import { alpacaPaperMarketSource } from '../../apps/server/src/launch-market-adapters/alpaca-paper-market.ts';
import { readIndexedPaperReal } from '../../apps/server/src/launch-market-adapters/paper-real-projection.ts';
import { marketRpcEndpoint } from '../../apps/server/src/launch-market-adapters/market-rpc-endpoint.ts';
import {
  reconcileVaultRun,
  type VaultRunOptions,
} from '../../apps/server/src/launch-market/vault-run-routes.ts';

/** Retires all legacy consents for one owner/strategy, retaining their immutable authorization history. */
export function pauseVaultAutomation(
  registry: StockConsentRegistry,
  owner: string,
  strategyId: StrategyId,
  now: number,
): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    let owned = registry.owned(owner);
    const active = owned.sessions.filter(
      (entry) => entry.active && entry.signed.consent.strategyId === strategyId,
    );
    if (!active.length) return;
    try {
      for (const entry of active) owned = registry.pause(owner, entry.digest, owned.revision, now);
      if (
        !registry
          .owned(owner)
          .sessions.some((entry) => entry.active && entry.signed.consent.strategyId === strategyId)
      )
        return;
    } catch (error) {
      if (!(error instanceof LaunchMarketError) || error.code !== 'STOCK_SESSION_CONFLICT') throw error;
    }
  }
  throw new LaunchMarketError('STOCK_SESSION_CONFLICT', 409);
}

export async function startMarketServer(env: Readonly<Record<string, string | undefined>>) {
  const origin = env.AF_MARKET_ORIGIN;
  if (!origin || !env.AF_MARKET_DATA_DIR) throw new Error('MARKET_ORIGIN_AND_PRIVATE_STORAGE_REQUIRED');
  if (env.AF_ACCESS_IDENTITY_DB && env.AF_ACCESS_IDENTITY_SOCKET)
    throw new Error('IDENTITY_BRIDGE_CONFIGURATION_CONFLICT');
  const folder = resolve(env.AF_MARKET_DATA_DIR),
    storage = privateServerStorage(folder, 512 * 1024 * 1024);
  let communityStorage: ReturnType<typeof privateServerStorage> | null = null;
  let community: CommunityStore | null = null,
    creators: CreatorStrategyStore | null = null,
    vaultRuns: VaultRunStore | null = null;
  let paperLedger: PaperLedger | null = null;
  let marketTimer: ReturnType<typeof setInterval> | null = null;
  let maintenanceJob: Promise<void> | null = null;
  let closing = false;
  let chain: RpcMarketChain | null = null,
    store: LaunchMarketStore | null = null,
    bridge: AccessIdentityBridge | null = null,
    indexer: MarketEventIndexer | null = null;
  try {
    const manifest = env.AF_MARKET_MANIFEST
      ? (JSON.parse(
          new TextDecoder().decode(readRegularBytes(resolve(env.AF_MARKET_MANIFEST))),
        ) as LaunchMarketManifest)
      : null;
    storage.bindIdentity('PUBLIC_TESTNET', id('FairLaunchV3:' + origin + ':' + JSON.stringify(manifest)));
    store = new LaunchMarketStore(storage.databasePath('market', 1095126347), origin);
    communityStorage = privateServerStorage(
      resolve(env.AF_COMMUNITY_DATA_DIR ?? folder + '-community'),
      128 * 1024 * 1024,
    );
    communityStorage.bindIdentity('PUBLIC_TESTNET', id('AlphaForgeCommunity:' + origin));
    community = new CommunityStore(communityStorage.databasePath('community', 1095126349), origin);
    creators = new CreatorStrategyStore(communityStorage.databasePath('creator', 1095126350), origin);
    vaultRuns = new VaultRunStore(communityStorage.databasePath('vault-run', VAULT_RUN_APPLICATION_ID), {
      origin,
      manifestDigest: stockEvidenceHash(manifest),
    });
    paperLedger = new PaperLedger(communityStorage.databasePath('vault-paper', PAPER_LEDGER_APPLICATION_ID), {
      origin,
      manifestDigest: stockEvidenceHash(manifest),
    });
    if (manifest) {
      chain = new RpcMarketChain(manifest, marketRpcEndpoint(env));
      await chain.initialize();
    }
    if (env.AF_ACCESS_IDENTITY_DB) bridge = new AccessIdentityBridge(resolve(env.AF_ACCESS_IDENTITY_DB));
    const identityClient = env.AF_ACCESS_IDENTITY_SOCKET
      ? new AccessIdentitySocketClient(env.AF_ACCESS_IDENTITY_SOCKET)
      : null;
    const quoteSigner = await loadOfflineVoucherSigner({
        ...(env.AF_MARKET_QUOTE_SIGNER_FILE ? { rawFile: env.AF_MARKET_QUOTE_SIGNER_FILE } : {}),
        ...(env.AF_MARKET_QUOTE_KEYSTORE_FILE ? { keystoreFile: env.AF_MARKET_QUOTE_KEYSTORE_FILE } : {}),
        ...(env.AF_MARKET_QUOTE_UNLOCK_FILE ? { unlockFile: env.AF_MARKET_QUOTE_UNLOCK_FILE } : {}),
      }),
      claimSigner = await loadOfflineVoucherSigner({
        ...(env.AF_MARKET_CLAIM_SIGNER_FILE ? { rawFile: env.AF_MARKET_CLAIM_SIGNER_FILE } : {}),
        ...(env.AF_MARKET_CLAIM_KEYSTORE_FILE ? { keystoreFile: env.AF_MARKET_CLAIM_KEYSTORE_FILE } : {}),
        ...(env.AF_MARKET_CLAIM_UNLOCK_FILE ? { unlockFile: env.AF_MARKET_CLAIM_UNLOCK_FILE } : {}),
      });
    const feed = new VerifiedEthReference();
    const reader = chain;
    const registry = new StockConsentRegistry(
      resolve(env.AF_COMMUNITY_DATA_DIR ?? folder + '-community', 'stock-owner-consents.json'),
    );
    const automation = buildStockAutomationRuntime({
      registry,
      manifest,
      provider: reader ? stockWorkerReadProvider(reader.provider) : null,
      now: () => Math.floor(Date.now() / 1000),
      ...(env.AF_STOCK_STATUS_FILE ? { statusFile: env.AF_STOCK_STATUS_FILE } : {}),
      ...(env.AF_STOCK_EXECUTOR_ADDRESS ? { executorAddress: env.AF_STOCK_EXECUTOR_ADDRESS } : {}),
    });
    const vaultReader = reader ? new VaultRunChain(reader) : null;
    const stockSource = loadStockDataReference(env.AF_STOCK_DATA_CREDENTIALS);
    const credentialsPath = resolve(communityStorage.folder, 'stock-data-credentials.json');
    const credentials = new StockDataCredentialStore(credentialsPath);
    const ledger = paperLedger;
    const paperMarket = new PaperMarketDataCache({
      source: alpacaPaperMarketSource(credentialsPath),
      sourceAuthorization: env.AF_PAPER_DATA_AUTHORIZED === '1',
    });
    const recordedFrames = new Map<StrategyId, number>();
    const readMarket = async () => {
      const snapshot = await paperMarket.read();
      // One shared mark per symbol/frame. Ledger insertion is idempotent across simultaneous viewers.
      for (const strategyId of ['TSLA', 'AMZN'] as const) {
        const quote = snapshot.quotes[strategyId];
        if (
          isPaperEntryQuote(quote, Math.floor(Date.now() / 1000)) &&
          recordedFrames.get(strategyId) !== quote.fetchedAt
        ) {
          ledger.recordMark(quote, Math.floor(Date.now() / 1000));
          recordedFrames.set(strategyId, quote.fetchedAt);
        }
      }
      return snapshot;
    };
    const readPrice = async (strategyId: StrategyId) => {
      const quote = (await readMarket()).quotes[strategyId];
      return isPaperEntryQuote(quote, Math.floor(Date.now() / 1000)) ? quote : null;
    };
    const canonicalAnchor = (height: string) =>
      indexer?.canonicalAnchor(height) ?? { known: false, blockHash: null };
    const requireVaultReader = () => {
      if (!vaultReader) throw new LaunchMarketError('VAULT_RUN_NOT_CONFIGURED', 503);
      return vaultReader;
    };
    const service = new LaunchMarketService({
      manifest,
      store,
      chain,
      quoteSigner,
      claimSigner,
      indexedSnapshots: true,
      ethReference: {
        read: async () => {
          const reference = await feed.read();
          return { ethUsdPriceRaw: reference.priceRaw, observedAt: reference.observedAt };
        },
      },
      ...(reader
        ? {
            vaultQuote: (request, account, snapshot, expiry) =>
              buildVaultQuote(reader, request, account, snapshot, expiry),
          }
        : {}),
    });
    if (manifest && chain)
      indexer = new MarketEventIndexer({
        path: storage.databasePath('market-events', 1095126348),
        manifest,
        provider: chain.provider,
        service,
        pollIntervalMs: 30_000,
        maxBlocksPerPoll: 2000,
      });
    const runStore = vaultRuns;
    const runOptions: VaultRunOptions = {
      store: runStore,
      demand: new VaultReferenceDemand({ sourceConfigured: stockSource !== null }),
      readObservation: (owner, strategyId, options) =>
        requireVaultReader().readObservation(owner, strategyId, options),
      qualifyTransaction: (state, transactionHash) =>
        requireVaultReader().qualifyTransaction(state, transactionHash),
      readReceipt: (state) => requireVaultReader().readReceipt(state),
      pauseAutomation: (owner, strategyId) =>
        pauseVaultAutomation(registry, owner, strategyId, service.now()),
      paper: {
        ledger,
        readPrice,
        readFundingProof: (state) => requireVaultReader().readFundingProof(state),
        canonicalAnchor,
        referenceStatus: () => paperMarket.status(),
      },
    };
    let reconciliationCursor: { owner: string; strategyId: StrategyId } | undefined;
    const maintain = (): Promise<void> => {
      if (closing) return Promise.resolve();
      if (maintenanceJob) return maintenanceJob;
      maintenanceJob = (async () => {
        await readMarket().catch(() => {});
        let batch = runStore.pendingPaperRuns(20, reconciliationCursor);
        if (!batch.length && reconciliationCursor) {
          reconciliationCursor = undefined;
          batch = runStore.pendingPaperRuns(20);
        }
        for (const run of batch) {
          if (closing) break;
          reconciliationCursor = { owner: run.owner, strategyId: run.strategyId };
          try {
            await reconcileVaultRun(
              { ...runOptions, now: service.now },
              run.owner,
              run.strategyId,
              run.revision,
            );
          } catch {
            // Unconfirmed/unknown/reorganized funding remains durable for the next bounded attempt.
          }
        }
      })().finally(() => {
        maintenanceJob = null;
      });
      return maintenanceJob;
    };
    const server = await buildLaunchMarketServer({
      service,
      origin,
      community,
      creators,
      automation,
      ...(env.AF_MARKET_RPC_MODE === 'OFFICIAL' ? { rpcProvider: 'OFFICIAL_PUBLIC' as const } : {}),
      paperMarketData: { read: readMarket, status: () => paperMarket.status() },
      paperVault: {
        ledger,
        store: vaultRuns,
        readReal: (owner, strategyId, options) => {
          if (!indexer) throw new LaunchMarketError('PAPER_CHAIN_INDEX_SYNCING', 503);
          const stableIndex = indexer;
          return stableIndex.readStableHistory(() =>
            readIndexedPaperReal(stableIndex, owner, strategyId, options.vault),
          );
        },
        readMarket,
        canonicalAnchor,
      },
      operatorStockData: {
        // Operator role and target path come only from this trusted deployment configuration.
        operatorWallet: '0x86767116cd40bf6b4f8cf88E08D11E38B04364Cf',
        store: credentials,
        readOnlyEnabled: () => paperMarket.status().sourceAuthorized && credentials.snapshot().status.saved,
      },
      vaultRun: runOptions,
      ...(vaultReader
        ? {
            vaultValuations: new VaultValuations({
              chain: vaultReader,
              ...(stockSource
                ? {
                    readPrice: async (strategyId) => {
                      const reference = await stockSource.read(strategyId);
                      return reference.status === 'OPEN' && reference.priceRaw
                        ? { priceRaw: reference.priceRaw, observedAt: reference.observedAt }
                        : null;
                    },
                  }
                : {}),
            }),
          }
        : {}),
      canCommunityWrite: () => communityStorage?.canWrite() ?? false,
      ...(indexer ? { indexer } : {}),
      webRoot: env.AF_MARKET_WEB_ROOT
        ? resolve(env.AF_MARKET_WEB_ROOT)
        : resolve(new URL('../../apps/web/dist', import.meta.url).pathname),
      trustedIdentity: async (request) => {
        const identity = identityClient ? await identityClient.identity(request) : bridge?.identity(request);
        return identity ? { email: identity.email, subject: identity.subject, emailVerified: true } : null;
      },
      verificationRequired: async () =>
        identityClient ? identityClient.verificationRequired() : (bridge?.verificationRequired() ?? true),
      beforeClose: async () => {
        closing = true;
        if (marketTimer) clearInterval(marketTimer);
        await maintenanceJob?.catch(() => {});
      },
      dispose: async () => {
        ledger.close();
        bridge?.close();
        chain?.close();
        communityStorage?.close();
        storage.close();
      },
    });
    const port = Number(env.AF_MARKET_PORT ?? '4101');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
    await server.start('127.0.0.1', port);
    // Shared quotes and already signed funding confirmations only. No stock-order signer or user strategy process.
    void maintain().catch(() => {});
    marketTimer = setInterval(() => void maintain().catch(() => {}), 30_000);
    marketTimer.unref();
    return server;
  } catch (error) {
    if (marketTimer) clearInterval(marketTimer);
    paperLedger?.close();
    await indexer?.close();
    bridge?.close();
    store?.close();
    community?.close();
    creators?.close();
    vaultRuns?.close();
    chain?.close();
    communityStorage?.close();
    storage.close();
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = await startMarketServer(process.env);
    const shutdown = () => {
      void server.stop().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    console.log(
      'Fair Launch reader ready on loopback. Wallets submit transactions; server signs bounded vouchers only.',
    );
  } catch {
    console.error('FAIR_LAUNCH_STARTUP_REJECTED');
    process.exitCode = 1;
  }
}
