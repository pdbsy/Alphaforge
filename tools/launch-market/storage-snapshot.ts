import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateServerStorage } from '../../packages/testnet/src/private-storage.ts';
import { readRegularBytes } from '../../packages/testnet/src/bounded-file.ts';

const capacity = 512 * 1024 * 1024;
/**
 * Explicit schema pins from LaunchMarketStore (v1/v2/v3) and MarketEventIndexer (v1), including SQLite's
 * constraint autoindexes. Canonical UTF-8 bytes are JSON.stringify() of rows selected in column
 * order type,name,tbl_name,sql, sorted by type COLLATE BINARY,name COLLATE BINARY, with no newline.
 * Any DDL change requires an explicit schema qualification and a new reviewed pin.
 */
export const expectedSchemaSha256 = {
  'market.sqlite': '6662ec65beb541cfb6bc12f3a27fe6ec595025bf51eea660de4ccb587f6427f4',
  'market-events.sqlite': 'd62a1400b85053ca785dc7a3e6b134b660cf47f92cb603865d03886a51f162e0',
} as const;
const legacyMarketSchemaSha256 = 'ebcd5b0c6de108735f97ebbac53d7e7545cfa9c35d0d2a5dc38d7c7d953b64a6';
const singleSessionSchemaSha256 = '8dc4daab94a91809ee8be9ff08fc3487870b630e6b4e1d76bf07e2f33808f7fe';
const specifications = [
  {
    file: 'market.sqlite',
    applicationId: 1095126347,
    identity: 'market_identity',
    indexes: ['one_canonical_account_claim', 'one_canonical_market_height'],
    tables: {
      market_identity: ['id', 'chain_id', 'origin'],
      market_accounts: ['id', 'account_key', 'email', 'subject', 'verified_at', 'wallet', 'created_at'],
      market_wallet_challenges: ['nonce', 'account_id', 'wallet', 'message', 'expires_at', 'consumed'],
      market_claim_vouchers: [
        'account_id',
        'account_key',
        'wallet',
        'nonce',
        'issued_at',
        'deadline',
        'status',
        'transaction_hash',
      ],
      market_quotes: ['id', 'account_id', 'owner', 'payload', 'expires_at'],
      market_operations: ['id', 'quote_id', 'owner', 'transaction_hash', 'payload'],
      market_claim_events: [
        'chain_id',
        'transaction_hash',
        'log_index',
        'block_number',
        'block_hash',
        'account_key',
        'wallet',
        'canonical',
      ],
      market_snapshots: [
        'chain_id',
        'block_number',
        'block_hash',
        'parent_hash',
        'version',
        'payload',
        'canonical',
      ],
      market_projection_version: ['id', 'version'],
    },
  },
  {
    file: 'market-events.sqlite',
    applicationId: 1095126348,
    identity: 'event_index_identity',
    indexes: ['one_market_index_height', 'market_event_order'],
    tables: {
      event_index_identity: ['id', 'digest', 'chain_id'],
      event_index_blocks: ['number', 'hash', 'parent_hash', 'timestamp', 'canonical'],
      event_index_cursor: ['id', 'number', 'hash'],
      event_index_watch: ['address', 'kind', 'strategy', 'number', 'hash', 'canonical'],
      event_index_events: [
        'transaction_hash',
        'log_index',
        'block_hash',
        'block_number',
        'emitter',
        'name',
        'strategy',
        'payload',
        'canonical',
      ],
    },
  },
] as const;
const walletTestTables: Readonly<Record<string, readonly string[]>> = {
  ...specifications[0].tables,
  market_accounts: [
    'id',
    'account_key',
    'email',
    'subject',
    'verified_at',
    'wallet',
    'created_at',
    'identity_kind',
  ],
  market_wallet_test_identities: ['wallet', 'account_id', 'created_at'],
  market_wallet_test_challenges: ['nonce', 'wallet', 'message', 'issued_at', 'expires_at', 'consumed'],
  market_wallet_test_sessions: [
    'token_hash',
    'account_id',
    'wallet',
    'csrf_token',
    'created_at',
    'expires_at',
    'identity_kind',
  ],
};
type Specification = (typeof specifications)[number];
interface NetworkIdentity {
  schemaVersion: 1;
  environment: 'robinhood-chain-testnet';
  chainId: 46630;
  profile: 'PUBLIC_TESTNET';
  digest: string;
}
export interface StorageDatabaseEvidence {
  readonly file: string;
  readonly applicationId: number;
  readonly schemaVersion: 1;
  readonly contentSha256: string;
  readonly tables: readonly { name: string; count: number }[];
}
export interface StorageSnapshotReport {
  readonly schemaVersion: 1;
  readonly kind: 'ALPHAFORGE_LAUNCH_STORAGE_SNAPSHOT';
  readonly action: 'backup' | 'restore';
  readonly createdAt: string;
  readonly chainId: 46630;
  readonly profile: 'PUBLIC_TESTNET';
  readonly networkDigest: string;
  readonly networkIdentitySha256: string;
  readonly databases: readonly StorageDatabaseEvidence[];
}
export interface StorageSnapshotOptions {
  readonly action: 'backup' | 'restore';
  readonly source: string;
  readonly destination: string;
  readonly expectedDigest: string;
}
function reject(code: string): never {
  throw new Error(code);
}
function sha(value: Uint8Array | string) {
  return createHash('sha256').update(value).digest('hex');
}
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function root(path: string): void {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path === resolve('/') ||
    realpathSync(dirname(path)) !== dirname(path)
  )
    reject('SNAPSHOT_UNSAFE_PATH');
}
function directory(path: string): void {
  root(path);
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    realpathSync(path) !== path ||
    stat.uid !== BigInt(process.getuid!()) ||
    (stat.mode & 0o777n) !== 0o700n
  )
    reject('SNAPSHOT_UNSAFE_DIRECTORY');
}
function regular(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    realpathSync(path) !== path ||
    stat.uid !== BigInt(process.getuid!()) ||
    (stat.mode & 0o777n) !== 0o600n
  )
    reject('SNAPSHOT_UNSAFE_FILE');
  return stat;
}
function encoded(value: unknown): unknown {
  if (typeof value === 'bigint') return { integer: value.toString() };
  if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString('hex') };
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encoded(item)]));
  return value;
}
function inspect(db: DatabaseSync, spec: Specification): StorageDatabaseEvidence {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (
    db.prepare('PRAGMA application_id').get()?.application_id !== spec.applicationId ||
    (version !== 1 && !(spec.file === 'market.sqlite' && (version === 2 || version === 3)))
  )
    reject('SNAPSHOT_DATABASE_IDENTITY');
  if (
    db
      .prepare('PRAGMA integrity_check')
      .all()
      .some((row) => row.integrity_check !== 'ok') ||
    db.prepare('PRAGMA foreign_key_check').get()
  )
    reject('SNAPSHOT_DATABASE_INTEGRITY');
  const completeSchema = db
    .prepare(
      'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type COLLATE BINARY,name COLLATE BINARY',
    )
    .all();
  const pin =
    spec.file === 'market.sqlite' && version === 1
      ? legacyMarketSchemaSha256
      : spec.file === 'market.sqlite' && version === 2
        ? singleSessionSchemaSha256
        : expectedSchemaSha256[spec.file];
  if (sha(JSON.stringify(completeSchema)) !== pin) reject('SNAPSHOT_UNKNOWN_SCHEMA');
  const schema = completeSchema.filter((row) => !String(row.name).startsWith('sqlite_'));
  const tableDefinitions =
    spec.file === 'market.sqlite' && (version === 2 || version === 3) ? walletTestTables : spec.tables;
  const expectedTables = Object.keys(tableDefinitions).sort(),
    tables = schema
      .filter((row) => row.type === 'table')
      .map((row) => String(row.name))
      .sort(),
    indexes = schema
      .filter((row) => row.type === 'index')
      .map((row) => String(row.name))
      .sort();
  const expectedIndexes =
    spec.file === 'market.sqlite' && version === 3
      ? [...spec.indexes, 'wallet_sessions_by_account'].sort()
      : [...spec.indexes].sort();
  if (
    JSON.stringify(tables) !== JSON.stringify(expectedTables) ||
    JSON.stringify(indexes) !== JSON.stringify(expectedIndexes) ||
    schema.some((row) => row.type !== 'table' && row.type !== 'index')
  )
    reject('SNAPSHOT_UNKNOWN_SCHEMA');
  for (const table of expectedTables) {
    const columns = db.prepare('PRAGMA table_xinfo("' + table + '")').all();
    if (
      JSON.stringify(columns.map((column) => column.name)) !==
        JSON.stringify((tableDefinitions as Readonly<Record<string, readonly string[]>>)[table]) ||
      columns.some((column) => column.hidden !== 0) ||
      !String(schema.find((row) => row.name === table)?.sql).endsWith('STRICT')
    )
      reject('SNAPSHOT_UNKNOWN_SCHEMA');
  }
  const identity = db.prepare('SELECT * FROM ' + spec.identity + ' WHERE id=1').get();
  if (
    !identity ||
    identity.chain_id !== 46630 ||
    db.prepare('SELECT COUNT(*) AS n FROM ' + spec.identity).get()?.n !== 1
  )
    reject('SNAPSHOT_DATABASE_NAMESPACE');
  if (spec.file === 'market.sqlite') {
    try {
      const url = new URL(String(identity.origin));
      if (
        url.origin !== identity.origin ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname))
      )
        reject('SNAPSHOT_DATABASE_NAMESPACE');
    } catch {
      reject('SNAPSHOT_DATABASE_NAMESPACE');
    }
  } else if (typeof identity.digest !== 'string' || !/^[a-f0-9]{64}$/.test(identity.digest))
    reject('SNAPSHOT_DATABASE_NAMESPACE');
  const digest = createHash('sha256');
  digest.update(JSON.stringify(encoded(schema)) + '\n');
  const counts: Array<{ name: string; count: number }> = [];
  for (const table of expectedTables) {
    digest.update(table + '\n');
    const statement = db.prepare('SELECT rowid AS snapshot_rowid,* FROM "' + table + '" ORDER BY rowid');
    statement.setReadBigInts(true);
    let count = 0;
    for (const row of statement.iterate()) {
      digest.update(JSON.stringify(encoded(row)) + '\n');
      count++;
    }
    counts.push({ name: table, count });
  }
  return {
    file: spec.file,
    applicationId: spec.applicationId,
    schemaVersion: 1,
    contentSha256: digest.digest('hex'),
    tables: counts,
  };
}
function writeExclusive(path: string, bytes: Uint8Array | string): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  regular(path);
}
function flushDirectory(folder: string): void {
  const fd = openSync(folder, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isDirectory()) reject('SNAPSHOT_UNSAFE_DIRECTORY');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Offline copy only. Sources are retained; failed new destinations are retained for inspection. */
export async function snapshotLaunchStorage(options: StorageSnapshotOptions): Promise<StorageSnapshotReport> {
  if (
    !['backup', 'restore'].includes(options.action) ||
    !/^0x[a-f0-9]{64}$/.test(options.expectedDigest) ||
    /^0x0+$/.test(options.expectedDigest)
  )
    reject('SNAPSHOT_INVALID_INPUT');
  directory(options.source);
  root(options.destination);
  if (present(options.destination)) reject('SNAPSHOT_DESTINATION_EXISTS');
  if (
    options.destination.startsWith(options.source + sep) ||
    options.source.startsWith(options.destination + sep)
  )
    reject('SNAPSHOT_OVERLAPPING_PATHS');
  const source = privateServerStorage(options.source, capacity);
  let destination: ReturnType<typeof privateServerStorage> | null = null;
  const opened: Array<{
    db: DatabaseSync;
    spec: Specification;
    stat: ReturnType<typeof regular>;
    evidence: StorageDatabaseEvidence;
  }> = [];
  try {
    source.bytes();
    const permitted = new Set([
      '.server.lock',
      'network-identity.json',
      'storage-snapshot.json',
      ...specifications.flatMap((spec) => [spec.file, spec.file + '-wal', spec.file + '-shm']),
    ]);
    for (const name of readdirSync(options.source)) {
      if (!permitted.has(name)) reject('SNAPSHOT_UNKNOWN_FILE');
      regular(join(options.source, name));
    }
    const identityPath = join(options.source, 'network-identity.json');
    regular(identityPath);
    const identityBytes = readRegularBytes(identityPath, 4096),
      text = new TextDecoder('utf-8', { fatal: true }).decode(identityBytes),
      identity = JSON.parse(text) as NetworkIdentity;
    if (
      identity.schemaVersion !== 1 ||
      identity.environment !== 'robinhood-chain-testnet' ||
      identity.chainId !== 46630 ||
      identity.profile !== 'PUBLIC_TESTNET' ||
      identity.digest !== options.expectedDigest ||
      text !==
        JSON.stringify({
          schemaVersion: 1,
          environment: 'robinhood-chain-testnet',
          chainId: 46630,
          profile: 'PUBLIC_TESTNET',
          digest: options.expectedDigest,
        }) +
          '\n'
    )
      reject('SNAPSHOT_NETWORK_IDENTITY');
    let previous: StorageSnapshotReport | null = null;
    if (present(join(options.source, 'storage-snapshot.json'))) {
      previous = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          readRegularBytes(join(options.source, 'storage-snapshot.json'), 65536),
        ),
      ) as StorageSnapshotReport;
      if (
        previous.schemaVersion !== 1 ||
        previous.kind !== 'ALPHAFORGE_LAUNCH_STORAGE_SNAPSHOT' ||
        previous.chainId !== 46630 ||
        previous.profile !== 'PUBLIC_TESTNET' ||
        previous.networkDigest !== identity.digest ||
        previous.networkIdentitySha256 !== sha(identityBytes) ||
        !Array.isArray(previous.databases)
      )
        reject('SNAPSHOT_UNKNOWN_MANIFEST');
    }
    if (options.action === 'restore' && !previous) reject('SNAPSHOT_VERIFIED_SOURCE_REQUIRED');
    for (const spec of specifications) {
      const path = join(options.source, spec.file);
      if (!present(path)) {
        if (spec.file === 'market.sqlite' || present(path + '-wal') || present(path + '-shm'))
          reject('SNAPSHOT_DATABASE_MISSING');
        continue;
      }
      const stat = regular(path),
        db = new DatabaseSync(path, { readOnly: true });
      try {
        db.exec('PRAGMA query_only=ON; BEGIN;');
        const evidence = inspect(db, spec);
        opened.push({ db, spec, stat, evidence });
      } catch (error) {
        db.close();
        throw error;
      }
    }
    if (
      options.action === 'restore' &&
      JSON.stringify(previous!.databases) !== JSON.stringify(opened.map((item) => item.evidence))
    )
      reject('SNAPSHOT_CONTENT_CHANGED');
    mkdirSync(options.destination, { mode: 0o700 });
    destination = privateServerStorage(options.destination, capacity);
    writeExclusive(join(options.destination, 'network-identity.json'), identityBytes);
    destination.bindIdentity(identity.profile, identity.digest);
    for (const item of opened) {
      const target = join(options.destination, item.spec.file);
      writeExclusive(target, '');
      const targetBefore = regular(target);
      await backup(item.db, target);
      const targetAfter = regular(target);
      if (targetBefore.dev !== targetAfter.dev || targetBefore.ino !== targetAfter.ino)
        reject('SNAPSHOT_TARGET_REPLACED');
      // Node 24's read-only SQLite connection omits CHECK verification in integrity_check.
      // A write-capable handle with query_only enabled validates CHECKs without issuing writes.
      const restored = new DatabaseSync(target);
      try {
        restored.exec('PRAGMA query_only=ON;');
        if (JSON.stringify(inspect(restored, item.spec)) !== JSON.stringify(item.evidence))
          reject('SNAPSHOT_CONTENT_CHANGED');
      } finally {
        restored.close();
      }
      const current = regular(join(options.source, item.spec.file));
      if (current.dev !== item.stat.dev || current.ino !== item.stat.ino) reject('SNAPSHOT_SOURCE_REPLACED');
    }
    if (sha(readRegularBytes(identityPath, 4096)) !== sha(identityBytes)) reject('SNAPSHOT_SOURCE_REPLACED');
    const report: StorageSnapshotReport = {
      schemaVersion: 1,
      kind: 'ALPHAFORGE_LAUNCH_STORAGE_SNAPSHOT',
      action: options.action,
      createdAt: new Date().toISOString(),
      chainId: 46630,
      profile: 'PUBLIC_TESTNET',
      networkDigest: identity.digest,
      networkIdentitySha256: sha(identityBytes),
      databases: opened.map((item) => item.evidence),
    };
    writeExclusive(
      join(options.destination, 'storage-snapshot.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    destination.bytes();
    flushDirectory(options.destination);
    return report;
  } finally {
    for (const item of opened) item.db.close();
    destination?.close();
    source.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, source, destination, expectedDigest, ...extra] = process.argv.slice(2);
  if (!action || !source || !destination || !expectedDigest || extra.length) {
    console.error('Usage: storage-snapshot.ts backup|restore <source-folder> <new-folder> <network-digest>');
    process.exitCode = 1;
  } else
    try {
      const report = await snapshotLaunchStorage({
        action: action as 'backup' | 'restore',
        source: resolve(source),
        destination: resolve(destination),
        expectedDigest,
      });
      console.log(
        JSON.stringify({
          action: report.action,
          verified: true,
          databases: report.databases.map((db) => ({ file: db.file, contentSha256: db.contentSha256 })),
          networkDigest: report.networkDigest,
        }),
      );
    } catch (error) {
      console.error(
        error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
          ? error.message
          : 'STORAGE_SNAPSHOT_REJECTED',
      );
      process.exitCode = 1;
    }
}
