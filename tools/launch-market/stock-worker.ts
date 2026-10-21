import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Wallet, getAddress, type TransactionRequest } from 'ethers';
import { readRegularBytes } from '../../packages/testnet/src/bounded-file.ts';
import { OrderJournal } from '../../packages/testnet/src/order-journal.ts';
import { claimNonceOwnership } from '../../packages/testnet/src/nonce-ownership.ts';
import { testnetSubmissionTransport } from '../../packages/testnet/src/submission-transport.ts';
import type { RestrictedSigner, SubmissionPolicy } from '../../packages/testnet/src/restricted-submission.ts';
import type { LaunchMarketManifest } from '../../packages/launch-market/src/types.ts';
import { RpcMarketChain } from '../../apps/server/src/launch-market-adapters/rpc-chain.ts';
import {
  StockAutomationWorker,
  type StockWorkerFeedBinding,
} from '../../apps/server/src/launch-market-adapters/stock-worker.ts';
import { StockWorkerJournal } from '../../apps/server/src/launch-market-adapters/stock-worker-journal.ts';
import { AlpacaStockWorkerSource } from '../../apps/server/src/launch-market-adapters/stock-worker-source.ts';
import {
  stockEvidenceHash,
  verifyStockConsent,
  type SignedStockConsent,
} from '../../apps/server/src/launch-market-adapters/stock-worker-policy.ts';
import { stockWorkerReadProvider } from '../../apps/server/src/launch-market-adapters/stock-worker-rpc.ts';

export interface StockWorkerConfiguration {
  readonly schemaVersion: 1;
  readonly manifestFile: string;
  readonly rpcUrl: string;
  readonly dataCredentialsFile: string;
  readonly sessionsFile: string;
  readonly directory: string;
  readonly nonceDirectory: string;
  readonly pollSeconds: number;
  readonly maxStorageBytes: number;
  readonly feeds: readonly StockWorkerFeedBinding[];
  readonly gas: SubmissionPolicy;
  readonly maxTotalGasCostWei: string;
  readonly signers: readonly {
    readonly address: string;
    readonly keystoreFile: string;
    readonly passwordFile: string;
  }[];
}
export function readStockWorkerPrivateJson(path: string, limit = 262144): unknown {
  return JSON.parse(privateText(path, limit));
}
function privateText(path: string, limit: number): string {
  const target = resolve(path),
    before = lstatSync(target);
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o077) !== 0 ||
    realpathSync(target) !== target
  )
    throw new Error('STOCK_WORKER_PRIVATE_FILE');
  const bytes = readRegularBytes(target, limit),
    after = lstatSync(target);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.uid !== before.uid ||
    after.mode !== before.mode ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  )
    throw new Error('STOCK_WORKER_PRIVATE_FILE_CHANGED');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
async function unlock(spec: StockWorkerConfiguration['signers'][number]): Promise<RestrictedSigner> {
  const encoded = privateText(spec.keystoreFile, 1048576),
    key = JSON.parse(encoded),
    crypto = key.crypto ?? key.Crypto;
  if (
    key.version !== 3 ||
    typeof key.address !== 'string' ||
    getAddress('0x' + key.address) !== getAddress(spec.address) ||
    crypto?.cipher !== 'aes-128-ctr' ||
    crypto?.kdf !== 'scrypt' ||
    ![16384, 32768, 65536, 131072, 262144].includes(crypto.kdfparams?.n) ||
    crypto.kdfparams?.r !== 8 ||
    crypto.kdfparams?.p !== 1 ||
    crypto.kdfparams?.dklen !== 32
  )
    throw new Error('STOCK_WORKER_KEYSTORE');
  const password = privateText(spec.passwordFile, 1024).replace(/\r?\n$/, '');
  if (!password || /[\r\n]/.test(password)) throw new Error('STOCK_WORKER_PASSWORD');
  const wallet = await Wallet.fromEncryptedJson(encoded, password);
  if (getAddress(wallet.address) !== getAddress(spec.address)) throw new Error('STOCK_WORKER_KEY_IDENTITY');
  return {
    address: getAddress(spec.address).toLowerCase(),
    sign: (transaction) =>
      wallet.signTransaction({
        ...transaction,
        nonce: Number(transaction.nonce),
        type: 2,
      } as TransactionRequest),
  };
}
function claimDirectory(path: string, configurationHash: string) {
  const target = resolve(path),
    stat = lstatSync(target);
  if (
    !stat.isDirectory() ||
    realpathSync(target) !== target ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('STOCK_WORKER_PRIVATE_DIRECTORY');
  for (const name of [
    'orders.sqlite',
    'sources.sqlite',
    'orders.sqlite-wal',
    'orders.sqlite-shm',
    'sources.sqlite-wal',
    'sources.sqlite-shm',
  ]) {
    try {
      const file = lstatSync(join(target, name));
      if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0)
        throw new Error('STOCK_WORKER_PRIVATE_DATABASE');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  const lock = join(target, 'worker.lock'),
    evidence = JSON.stringify({ pid: process.pid, configurationHash, token: randomUUID() }) + '\n';
  writeFileSync(lock, evidence, { mode: 0o600, flag: 'wx' });
  return {
    target,
    writable: () => {
      try {
        return privateText(lock, 4096) === evidence;
      } catch {
        return false;
      }
    },
    release: () => {
      if (privateText(lock, 4096) !== evidence) throw new Error('STOCK_WORKER_LOCK_CHANGED');
      unlinkSync(lock);
    },
  };
}
function exportStatus(directory: string, value: unknown) {
  const temporary = join(directory, 'status-' + randomUUID() + '.json');
  writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, join(directory, 'status.json'));
}
/** No secret arguments. --prepare is one tick, --watch plans continuously, --activate requires a pinned private approval. */
export async function stockWorkerCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'stock-worker.ts --prepare|--watch PRIVATE_CONFIG.json; --activate PRIVATE_CONFIG.json PRIVATE_ACTIVATION.json',
    );
    return 0;
  }
  const activated = args.length === 3 && args[0] === '--activate';
  const watch = args.length === 2 && args[0] === '--watch';
  const prepare = args.length === 2 && args[0] === '--prepare';
  if (
    (!activated && !watch && !prepare) ||
    (activated &&
      (env.CI !== undefined ||
        env.GITHUB_ACTIONS !== undefined ||
        env.AF_STOCK_EXECUTION_ACK !== 'I_AUTHORIZE_STOCK_WORKER_46630'))
  ) {
    console.error('STOCK_WORKER_USAGE_OR_AUTHORIZATION');
    return 2;
  }
  let chain: RpcMarketChain | null = null,
    orders: OrderJournal | null = null,
    evidence: StockWorkerJournal | null = null;
  let worker: StockAutomationWorker | null = null,
    lock: ReturnType<typeof claimDirectory> | null = null;
  let nonceOwnership: ReturnType<typeof claimNonceOwnership> | null = null;
  const controller = new AbortController(),
    stop = () => {
      controller.abort();
      void worker?.close();
    };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const previousMask = process.umask(0o077);
  try {
    const config = readStockWorkerPrivateJson(args[1]!) as StockWorkerConfiguration;
    const fields = [
      'schemaVersion',
      'manifestFile',
      'rpcUrl',
      'dataCredentialsFile',
      'sessionsFile',
      'directory',
      'nonceDirectory',
      'pollSeconds',
      'maxStorageBytes',
      'feeds',
      'gas',
      'maxTotalGasCostWei',
      'signers',
    ];
    if (
      !config ||
      Object.keys(config).sort().join('|') !== fields.sort().join('|') ||
      config.schemaVersion !== 1 ||
      !Number.isSafeInteger(config.pollSeconds) ||
      config.pollSeconds < 3 ||
      config.pollSeconds > 15 ||
      !Number.isSafeInteger(config.maxStorageBytes) ||
      config.maxStorageBytes < 10485760 ||
      config.maxStorageBytes > 8000000000 ||
      !Array.isArray(config.signers) ||
      config.signers.length > 2
    )
      throw new Error('STOCK_WORKER_CONFIGURATION');
    const manifest = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(readRegularBytes(resolve(config.manifestFile))),
    ) as LaunchMarketManifest;
    const configurationHash = stockEvidenceHash({ config, manifest });
    const activation = activated
      ? (readStockWorkerPrivateJson(args[2]!, 4096) as {
          schemaVersion: number;
          chainId: number;
          configurationHash: string;
          validUntil: number;
          scope: string;
        })
      : null;
    const activationDigest = activation ? stockEvidenceHash(activation) : null;
    const activationValid = () => {
      if (!activated) return true;
      try {
        const current = readStockWorkerPrivateJson(args[2]!, 4096) as typeof activation;
        return (
          stockEvidenceHash(current) === activationDigest &&
          current?.schemaVersion === 1 &&
          current.chainId === 46630 &&
          current.configurationHash === configurationHash &&
          current.scope === 'STOCK_REFERENCE_AND_USER_CONSENT_EXECUTION' &&
          Number.isSafeInteger(current.validUntil) &&
          current.validUntil > Math.floor(Date.now() / 1000)
        );
      } catch {
        return false;
      }
    };
    if (!activationValid()) throw new Error('STOCK_WORKER_ACTIVATION_PIN');
    const credentials = readStockWorkerPrivateJson(config.dataCredentialsFile, 4096) as {
      apiKey: string;
      apiSecret: string;
    };
    if (
      !credentials ||
      Object.keys(credentials).sort().join('|') !== 'apiKey|apiSecret' ||
      typeof credentials.apiKey !== 'string' ||
      typeof credentials.apiSecret !== 'string'
    )
      throw new Error('STOCK_WORKER_SOURCE_CONFIGURATION');
    const currentSessions = () => {
      const current = readStockWorkerPrivateJson(config.sessionsFile, 1048576) as {
        schemaVersion: number;
        sessions: readonly SignedStockConsent[];
        revision?: number;
        entries?: readonly unknown[];
      };
      const keys = Object.keys(current ?? {})
        .sort()
        .join('|');
      if (
        !current ||
        !['schemaVersion|sessions', 'entries|revision|schemaVersion|sessions'].includes(keys) ||
        current.schemaVersion !== 1 ||
        !Array.isArray(current.sessions) ||
        current.sessions.length > 100 ||
        (keys.startsWith('entries|') &&
          (!Array.isArray(current.entries) ||
            !Number.isSafeInteger(current.revision) ||
            current.revision! < 0))
      )
        throw new Error('STOCK_WORKER_SESSION_REGISTRY');
      return current.sessions;
    };
    const loadSessions = async () => currentSessions();
    const sessionActive = (digest: string) => {
      try {
        return currentSessions().some((signed) => verifyStockConsent(signed) === digest);
      } catch {
        return false;
      }
    };
    chain = new RpcMarketChain(manifest, config.rpcUrl);
    await chain.initialize();
    lock = claimDirectory(config.directory, configurationHash);
    orders = new OrderJournal(join(lock.target, 'orders.sqlite'), configurationHash);
    evidence = new StockWorkerJournal(join(lock.target, 'sources.sqlite'), configurationHash);
    const canWrite = () => {
      if (!lock?.writable()) return false;
      try {
        let used = 0;
        for (const name of [
          'orders.sqlite',
          'sources.sqlite',
          'orders.sqlite-wal',
          'orders.sqlite-shm',
          'sources.sqlite-wal',
          'sources.sqlite-shm',
        ]) {
          try {
            used += lstatSync(join(lock.target, name)).size;
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
          }
        }
        return used + 1048576 < config.maxStorageBytes;
      } catch {
        return false;
      }
    };
    // Admission and consent checks run before decrypting any signer.
    const common = {
      manifest,
      provider: stockWorkerReadProvider(chain.provider),
      orders,
      evidence,
      sessions: await loadSessions(),
      sessionProvider: loadSessions,
      sessionActive,
      feeds: config.feeds,
      source: new AlpacaStockWorkerSource(credentials),
      gas: config.gas,
      maxTotalGasCostWei: config.maxTotalGasCostWei,
      canWrite,
      activationValid,
    };
    worker = new StockAutomationWorker(common);
    if (activated) {
      nonceOwnership = claimNonceOwnership(
        resolve(config.nonceDirectory),
        config.signers.map((s) => s.address),
        configurationHash,
      );
      const signers: RestrictedSigner[] = [];
      for (const spec of config.signers) signers.push(await unlock(spec));
      worker = new StockAutomationWorker({
        ...common,
        submission: { transport: testnetSubmissionTransport(config.rpcUrl), signers },
      });
    }
    do {
      if (controller.signal.aborted) break;
      await worker.tick();
      exportStatus(lock.target, {
        ...worker.safeStatus(),
        manifestDigest: stockEvidenceHash(manifest),
        executorAddresses: activated ? config.signers.map((s) => getAddress(s.address)) : [],
        sessionsFile: resolve(config.sessionsFile),
      });
      if (prepare) break;
      try {
        await delay(config.pollSeconds * 1000, undefined, { signal: controller.signal });
      } catch {
        break;
      }
    } while (!controller.signal.aborted);
    console.log(JSON.stringify(worker.safeStatus()));
    return 0;
  } catch {
    console.error('STOCK_WORKER_REJECTED');
    return 1;
  } finally {
    await worker?.close();
    evidence?.close();
    orders?.close();
    chain?.close();
    try {
      nonceOwnership?.close();
    } catch {
      console.error('STOCK_WORKER_NONCE_RECOVERY_REQUIRED');
    }
    try {
      lock?.release();
    } catch {
      console.error('STOCK_WORKER_LOCK_RECOVERY_REQUIRED');
    }
    process.umask(previousMask);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await stockWorkerCli(process.argv.slice(2), process.env);
