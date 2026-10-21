import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { getAddress, Interface, ZeroAddress } from 'ethers';
import { address, hash, uint, validateManifest } from '../../../../packages/launch-market/src/config.ts';
import {
  LaunchMarketError,
  type ChainLocation,
  type LaunchMarketManifest,
  type StrategyId,
} from '../../../../packages/launch-market/src/types.ts';
import type { LaunchMarketService } from '../../../../packages/launch-market/src/service.ts';
import type { IndexedMarketClaim } from '../../../../packages/launch-market/src/projection.ts';

export interface MarketIndexProvider {
  send(method: string, params: unknown[]): Promise<unknown>;
}
interface IndexBlock {
  number: bigint;
  hash: string;
  parentHash: string;
  timestamp: number;
}
interface RawLog {
  address: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  topics: string[];
  data: string;
  removed?: boolean;
}
export interface IndexedMarketEvent {
  readonly name: string;
  readonly emitter: string;
  readonly strategyId: StrategyId | null;
  readonly fields: Readonly<Record<string, string | boolean>>;
  readonly timestamp: number;
  readonly location: ChainLocation;
}
export interface MarketEventIndexerOptions {
  readonly path: string;
  readonly manifest: LaunchMarketManifest;
  readonly provider: MarketIndexProvider;
  readonly service: LaunchMarketService;
  readonly pollIntervalMs?: number;
  readonly maxBlocksPerPoll?: number;
}
export const marketEventInterface = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event PoolCreated(address indexed pass,address indexed pool,address indexed lpRecipient,uint256 shares)',
  'event VaultCreated(address indexed owner,uint8 indexed strategyIndex,address vault,uint256 generation)',
  'event Swap(address indexed payer,address indexed recipient,bool buy,uint256 amountIn,uint256 amountOut,uint256 fee)',
  'event Sync(uint256 reservePass,uint256 reserveUsdc)',
  'event LiquidityAdded(address indexed recipient,uint256 passAmount,uint256 usdcAmount,uint256 shares)',
  'event LiquidityRemoved(address indexed recipient,uint256 passAmount,uint256 usdcAmount,uint256 shares)',
  'event Subscription(address indexed payer,uint256 passAmount,uint256 usdcAmount,uint256 ethAmount,uint256 totalSold)',
  'event SoldOut(uint256 totalSold)',
  'event Launch(address indexed pool,address indexed lpRecipient,uint256 passAmount,uint256 usdcAmount,uint256 lpShares)',
  'event MintOpened(uint256 publicInventory,uint256 lpPass,uint256 lpUsdc,address indexed lpRecipient)',
  'event Claim(bytes32 indexed accountId,address indexed wallet,uint256 indexed nonce,uint256 amount,uint256 totalClaims)',
  'event Conversion(bytes32 indexed accountId,address indexed payer,uint8 indexed operation,uint256 usdcAmount,uint256 ethAmount,uint256 fee)',
  'event NativeTrade(bytes32 indexed accountId,address indexed payer,address indexed pass,bool buy,uint256 passAmount,uint256 usdcAmount,uint256 ethAmount)',
  'event Deposited(address indexed owner,uint256 usdcAmount,uint256 passRaw,uint256 principalBasis,uint256 trackedUsdcBalance)',
  'event Withdrawn(address indexed owner,uint256 usdcAmount,uint256 profitAmount,uint256 principalAmount,uint256 passRawUnlocked,uint256 principalBasis,uint256 trackedUsdcBalance)',
  'event Closed(address indexed owner,uint256 usdcReturned,uint256 passRawReleased)',
  'event TrackedPositionChanged(address indexed token,uint256 previousAmount,uint256 newAmount)',
  'event TrackedUsdcBalanceChanged(uint256 previousBalance,uint256 newBalance)',
  'event Swapped(address indexed trader,bool buy,uint256 input,uint256 output)',
  'event ExecutorConfigured(address indexed executor,uint64 expiresAt,uint256 version)',
  'event StrategyExecuted(bool buy,uint256 input,uint256 output,uint256 version)',
  'event PassLocked(address indexed owner,uint256 amount)',
  'event PassUnlocked(address indexed owner,uint256 amount)',
]);
const vaultIdentity = new Interface([
  'function passLocker() view returns(address)',
  'function targetStock() view returns(address)',
]);
const q = (n: bigint) => '0x' + n.toString(16);
function number(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value))
    throw new LaunchMarketError('INVALID_INDEX_RPC', 503);
  return BigInt(value);
}
function block(value: unknown): IndexBlock {
  if (!value || typeof value !== 'object') throw new LaunchMarketError('INDEX_BLOCK_UNAVAILABLE', 503);
  const raw = value as Record<string, unknown>,
    height = number(raw.number),
    timestamp = number(raw.timestamp);
  if (height > BigInt(Number.MAX_SAFE_INTEGER) || timestamp > BigInt(Number.MAX_SAFE_INTEGER))
    throw new LaunchMarketError('INDEX_BLOCK_RANGE', 503);
  return {
    number: height,
    hash: hash(String(raw.hash)),
    parentHash: hash(String(raw.parentHash)),
    timestamp: Number(timestamp),
  };
}
function rows(value: unknown): RawLog[] {
  if (!Array.isArray(value) || value.length > 50_000) throw new LaunchMarketError('INDEX_LOG_LIMIT', 503);
  return value as RawLog[];
}
export class MarketEventIndexer {
  readonly db: DatabaseSync;
  readonly options: MarketEventIndexerOptions;
  readonly intervalMs: number;
  readonly maxBlocks: number;
  #tail: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #closing = false;
  #closed = false;
  #state: 'NOT_RUN' | 'SYNCING' | 'HEALTHY' | 'DEGRADED' = 'NOT_RUN';
  #error: string | null = null;
  #resetPending = false;
  /** Uses the existing canonical scan only; valuation reads must never fetch a block from RPC. */
  canonicalAnchor(blockNumber: string): { known: boolean; blockHash: string | null } {
    if (this.#tail || this.#closing || this.#closed || this.#state !== 'HEALTHY')
      return { known: false, blockHash: null };
    const height = uint(blockNumber);
    if (height > BigInt(Number.MAX_SAFE_INTEGER)) throw new LaunchMarketError('INDEX_BLOCK_RANGE', 503);
    const cursor = this.cursor();
    if (!cursor || cursor.number < height) return { known: false, blockHash: null };
    const row = this.db
      .prepare('SELECT hash FROM event_index_blocks WHERE number=? AND canonical=1')
      .get(Number(height));
    if (row) return { known: true, blockHash: String(row.hash) };
    // A missing height is not proof of an orphan: the scanner may not cover this range yet.
    return { known: false, blockHash: null };
  }
  constructor(options: MarketEventIndexerOptions) {
    validateManifest(options.manifest);
    this.options = options;
    this.intervalMs = options.pollIntervalMs ?? 5000;
    this.maxBlocks = options.maxBlocksPerPoll ?? 500;
    if (
      !Number.isInteger(this.intervalMs) ||
      this.intervalMs < 100 ||
      this.intervalMs > 30_000 ||
      !Number.isInteger(this.maxBlocks) ||
      this.maxBlocks < 1 ||
      this.maxBlocks > 2000
    )
      throw new LaunchMarketError('INVALID_INDEX_POLICY', 400);
    this.db = new DatabaseSync(options.path);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      const digest = createHash('sha256').update(JSON.stringify(options.manifest)).digest('hex');
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version === 0) {
        if (
          this.db
            .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .get()
        )
          throw new LaunchMarketError('UNKNOWN_INDEX_DATABASE');
        this.atomic(() => {
          this.db
            .exec(`CREATE TABLE event_index_identity(id INTEGER PRIMARY KEY CHECK(id=1),digest TEXT NOT NULL,chain_id INTEGER NOT NULL) STRICT;
CREATE TABLE event_index_blocks(number INTEGER NOT NULL,hash TEXT NOT NULL,parent_hash TEXT NOT NULL,timestamp INTEGER NOT NULL,canonical INTEGER NOT NULL CHECK(canonical IN(0,1)),PRIMARY KEY(number,hash)) STRICT;
CREATE UNIQUE INDEX one_market_index_height ON event_index_blocks(number) WHERE canonical=1;
CREATE TABLE event_index_cursor(id INTEGER PRIMARY KEY CHECK(id=1),number INTEGER NOT NULL,hash TEXT NOT NULL) STRICT;
CREATE TABLE event_index_watch(address TEXT NOT NULL,kind TEXT NOT NULL,strategy TEXT,number INTEGER NOT NULL,hash TEXT NOT NULL,canonical INTEGER NOT NULL CHECK(canonical IN(0,1)),PRIMARY KEY(address,hash)) STRICT;
CREATE TABLE event_index_events(transaction_hash TEXT NOT NULL,log_index INTEGER NOT NULL,block_hash TEXT NOT NULL,block_number INTEGER NOT NULL,emitter TEXT NOT NULL,name TEXT NOT NULL,strategy TEXT,payload TEXT NOT NULL,canonical INTEGER NOT NULL CHECK(canonical IN(0,1)),PRIMARY KEY(transaction_hash,log_index,block_hash)) STRICT;
CREATE INDEX market_event_order ON event_index_events(canonical,block_number,log_index);
PRAGMA user_version=1;`);
          this.db
            .prepare('INSERT INTO event_index_identity VALUES(1,?,?)')
            .run(digest, options.manifest.chainId);
          for (const target of Object.keys(options.manifest.runtimeCodeHashes))
            this.watch(
              target,
              'STATIC',
              this.strategyForAddress(target),
              uint(options.manifest.deploymentBlock),
              'STATIC',
            );
          for (const strategy of ['TSLA', 'AMZN'] as const) {
            const entry = options.manifest.strategies[strategy];
            this.watch(entry.pass, 'PASS', strategy, uint(options.manifest.deploymentBlock), 'STATIC');
            if (entry.pool)
              this.watch(entry.pool, 'POOL', strategy, uint(options.manifest.deploymentBlock), 'STATIC');
          }
        });
      } else if (version !== 1) throw new LaunchMarketError('INDEX_SCHEMA_MISMATCH');
      const identity = this.db.prepare('SELECT digest,chain_id FROM event_index_identity WHERE id=1').get();
      if (identity?.digest !== digest || identity.chain_id !== options.manifest.chainId)
        throw new LaunchMarketError('INDEX_IDENTITY_MISMATCH');
      if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        throw new LaunchMarketError('INDEX_DATABASE_CORRUPT');
      this.db.exec('PRAGMA journal_mode=WAL');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private strategyForPass(pass: string): StrategyId | null {
    for (const strategy of ['TSLA', 'AMZN'] as const)
      if (address(this.options.manifest.strategies[strategy].pass) === address(pass)) return strategy;
    return null;
  }
  private strategyForAddress(target: string): StrategyId | null {
    for (const strategy of ['TSLA', 'AMZN'] as const) {
      const entry = this.options.manifest.strategies[strategy];
      if (
        [entry.pass, entry.launch, entry.pool].some(
          (value) => value !== null && address(value) === address(target),
        )
      )
        return strategy;
    }
    return null;
  }
  private watch(
    target: string,
    kind: string,
    strategy: StrategyId | null,
    height: bigint,
    blockHash: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO event_index_watch VALUES(?,?,?,?,?,1) ON CONFLICT(address,hash) DO UPDATE SET kind=excluded.kind,strategy=excluded.strategy,canonical=1',
      )
      .run(address(target), kind, strategy, Number(height), blockHash);
  }
  private cursor(): IndexBlock | null {
    const row = this.db
      .prepare(
        'SELECT b.* FROM event_index_cursor c JOIN event_index_blocks b ON b.number=c.number AND b.hash=c.hash WHERE c.id=1 AND b.canonical=1',
      )
      .get();
    return row
      ? {
          number: BigInt(Number(row.number)),
          hash: String(row.hash),
          parentHash: String(row.parent_hash),
          timestamp: Number(row.timestamp),
        }
      : null;
  }
  status() {
    const cursor = this.cursor();
    return {
      state: this.#state,
      error: this.#error,
      chainId: this.options.manifest.chainId,
      blockNumber: cursor?.number.toString() ?? null,
      blockHash: cursor?.hash ?? null,
    };
  }
  private async header(height: bigint | 'latest'): Promise<IndexBlock> {
    const result = block(
      await this.options.provider.send('eth_getBlockByNumber', [
        height === 'latest' ? 'latest' : q(height),
        false,
      ]),
    );
    if (height !== 'latest' && result.number !== height)
      throw new LaunchMarketError('INDEX_BLOCK_IDENTITY', 503);
    return result;
  }
  private decode(
    raw: RawLog,
    headers: ReadonlyMap<string, IndexBlock>,
    head: bigint,
  ): IndexedMarketEvent | null {
    const height = number(raw.blockNumber),
      header = headers.get(height.toString());
    if (
      !header ||
      hash(raw.blockHash) !== header.hash ||
      raw.removed ||
      number(raw.logIndex) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new LaunchMarketError('INDEX_LOG_CANONICAL_MISMATCH', 503);
    let parsed;
    try {
      parsed = marketEventInterface.parseLog({ topics: raw.topics, data: raw.data });
    } catch {
      return null;
    }
    if (!parsed) return null;
    const emitter = address(raw.address),
      watched = this.db
        .prepare(
          'SELECT strategy FROM event_index_watch WHERE address=? AND canonical=1 ORDER BY number DESC LIMIT 1',
        )
        .get(emitter);
    let strategy = watched?.strategy === null || !watched ? null : (String(watched.strategy) as StrategyId);
    const fields: Record<string, string | boolean> = {};
    parsed.fragment.inputs.forEach((input, index) => {
      const value = parsed!.args[index];
      fields[input.name] =
        input.type === 'bool'
          ? Boolean(value)
          : input.type === 'address'
            ? getAddress(String(value)).toLowerCase()
            : String(value);
    });
    if (parsed.name === 'PoolCreated') strategy = this.strategyForPass(String(fields.pass));
    if (parsed.name === 'VaultCreated')
      strategy = fields.strategyIndex === '0' ? 'TSLA' : fields.strategyIndex === '1' ? 'AMZN' : null;
    if (parsed.name === 'NativeTrade') strategy = this.strategyForPass(String(fields.pass));
    return {
      name: parsed.name,
      emitter,
      strategyId: strategy,
      fields,
      timestamp: header.timestamp,
      location: {
        chainId: this.options.manifest.chainId,
        blockNumber: height.toString(),
        blockHash: header.hash,
        transactionHash: hash(raw.transactionHash),
        logIndex: Number(number(raw.logIndex)),
        version: '0',
        confirmations: Number(head - height + 1n),
      },
    };
  }
  private async rewind(head: IndexBlock): Promise<void> {
    const cursor = this.cursor();
    if (!cursor) return;
    if (cursor.number <= head.number && (await this.header(cursor.number)).hash === cursor.hash) return;
    let ancestor: IndexBlock | null = null;
    for (let offset = 1; offset <= 128; offset++) {
      const height = cursor.number - BigInt(offset);
      if (height < uint(this.options.manifest.deploymentBlock)) break;
      if (height > head.number) continue;
      const local = this.db
        .prepare('SELECT * FROM event_index_blocks WHERE number=? AND canonical=1')
        .get(Number(height));
      if (!local) continue;
      const remote = await this.header(height);
      if (remote.hash === local.hash) {
        ancestor = remote;
        break;
      }
    }
    if (!ancestor && cursor.number - uint(this.options.manifest.deploymentBlock) >= 128n)
      throw new LaunchMarketError('INDEX_REORG_DEPTH_EXCEEDED', 503);
    const from = ancestor ? ancestor.number + 1n : uint(this.options.manifest.deploymentBlock);
    this.atomic(() => {
      this.db.prepare('UPDATE event_index_blocks SET canonical=0 WHERE number>=?').run(Number(from));
      this.db.prepare('UPDATE event_index_events SET canonical=0 WHERE block_number>=?').run(Number(from));
      this.db
        .prepare("UPDATE event_index_watch SET canonical=0 WHERE number>=? AND hash<>'STATIC'")
        .run(Number(from));
      this.db.prepare('DELETE FROM event_index_cursor WHERE id=1').run();
      if (ancestor)
        this.db
          .prepare('INSERT INTO event_index_cursor VALUES(1,?,?)')
          .run(Number(ancestor.number), ancestor.hash);
    });
    this.#resetPending = this.options.service.projector.rollbackFrom(from.toString()) === null;
  }
  private async scan(from: bigint, to: bigint, head: IndexBlock): Promise<void> {
    const headers = new Map<string, IndexBlock>();
    for (let start = from; start <= to; start += 16n) {
      const heights: Array<bigint> = [];
      for (let n = start; n <= to && n < start + 16n; n++) heights.push(n);
      const values = await Promise.all(heights.map((height) => this.header(height)));
      for (const item of values) headers.set(item.number.toString(), item);
    }
    let previous = this.cursor();
    for (let height = from; height <= to; height++) {
      const current = headers.get(height.toString())!;
      if (previous && current.parentHash !== previous.hash)
        throw new LaunchMarketError('INDEX_PARENT_MISMATCH', 503);
      previous = current;
    }
    const discoveryTargets = [
      this.options.manifest.poolFactory,
      ...(this.options.manifest.vaultFactory ? [this.options.manifest.vaultFactory] : []),
    ];
    const discovery = rows(
      await this.options.provider.send('eth_getLogs', [
        { address: discoveryTargets, fromBlock: q(from), toBlock: q(to) },
      ]),
    );
    const discoveries: IndexedMarketEvent[] = [];
    for (const raw of discovery) {
      if (!discoveryTargets.some((target) => address(target) === address(raw.address)))
        throw new LaunchMarketError('INDEX_UNWATCHED_LOG', 503);
      const event = this.decode(raw, headers, head.number);
      if (
        event?.strategyId &&
        ((event.name === 'PoolCreated' && event.emitter === address(this.options.manifest.poolFactory)) ||
          (event.name === 'VaultCreated' && event.emitter === address(this.options.manifest.vaultFactory!)))
      )
        discoveries.push(event);
    }
    const dynamic: Array<{ target: string; kind: string; strategy: StrategyId; event: IndexedMarketEvent }> =
      [];
    for (const event of discoveries) {
      const target = String(event.fields[event.name === 'PoolCreated' ? 'pool' : 'vault']);
      dynamic.push({
        target,
        kind: event.name === 'PoolCreated' ? 'POOL' : 'VAULT',
        strategy: event.strategyId!,
        event,
      });
      if (event.name === 'VaultCreated')
        for (const [method, kind] of [
          ['passLocker', 'LOCKER'],
          ['targetStock', 'STOCK'],
        ] as const) {
          const encoded = await this.options.provider.send('eth_call', [
            { to: address(target), data: vaultIdentity.encodeFunctionData(method, []) },
            q(to),
          ]);
          const result = String(vaultIdentity.decodeFunctionResult(method, String(encoded))[0]);
          dynamic.push({ target: result, kind, strategy: event.strategyId!, event });
        }
    }
    const targets = [
      ...new Set([
        ...this.db
          .prepare('SELECT address FROM event_index_watch WHERE canonical=1')
          .all()
          .map((row) => String(row.address)),
        ...dynamic.map((item) => address(item.target)),
      ]),
    ];
    const rawEvents = rows(
      await this.options.provider.send('eth_getLogs', [
        { address: targets, fromBlock: q(from), toBlock: q(to) },
      ]),
    );
    for (const raw of rawEvents)
      if (!targets.includes(address(raw.address))) throw new LaunchMarketError('INDEX_UNWATCHED_LOG', 503);
    if ((await this.header(to)).hash !== headers.get(to.toString())!.hash)
      throw new LaunchMarketError('INDEX_REORG_DURING_SCAN', 503);
    this.atomic(() => {
      for (const item of dynamic)
        this.watch(
          item.target,
          item.kind,
          item.strategy,
          uint(item.event.location.blockNumber),
          item.event.location.blockHash,
        );
      const events = rawEvents
        .map((raw) => this.decode(raw, headers, head.number))
        .filter((event): event is IndexedMarketEvent => event !== null);
      for (const item of headers.values())
        this.db
          .prepare(
            'INSERT INTO event_index_blocks VALUES(?,?,?,?,1) ON CONFLICT(number,hash) DO UPDATE SET canonical=1',
          )
          .run(Number(item.number), item.hash, item.parentHash, item.timestamp);
      for (const event of events)
        this.db
          .prepare(
            'INSERT INTO event_index_events VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(transaction_hash,log_index,block_hash) DO UPDATE SET canonical=1,payload=excluded.payload',
          )
          .run(
            event.location.transactionHash!,
            event.location.logIndex!,
            event.location.blockHash,
            Number(uint(event.location.blockNumber)),
            event.emitter,
            event.name,
            event.strategyId,
            JSON.stringify(event),
          );
      const latest = headers.get(to.toString())!;
      this.db
        .prepare(
          'INSERT INTO event_index_cursor VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET number=excluded.number,hash=excluded.hash',
        )
        .run(Number(latest.number), latest.hash);
    });
  }
  poll(): Promise<void> {
    if (this.#closed) return Promise.reject(new LaunchMarketError('INDEX_CLOSED', 503));
    if (this.#tail) return this.#tail;
    const next = this.tick();
    this.#tail = next;
    void next
      .finally(() => {
        if (this.#tail === next) this.#tail = null;
      })
      .catch(() => {});
    return next;
  }
  private async tick(): Promise<void> {
    this.#state = 'SYNCING';
    try {
      if (
        number(await this.options.provider.send('eth_chainId', [])) !== BigInt(this.options.manifest.chainId)
      )
        throw new LaunchMarketError('INDEX_WRONG_CHAIN', 503);
      const head = await this.header('latest');
      await this.rewind(head);
      const cursor = this.cursor(),
        from = cursor ? cursor.number + 1n : uint(this.options.manifest.deploymentBlock),
        to =
          from + BigInt(this.maxBlocks) - 1n < head.number ? from + BigInt(this.maxBlocks) - 1n : head.number;
      if (from <= to) await this.scan(from, to, head);
      const latest = this.cursor();
      if (!latest || latest.number < head.number) {
        this.#state = 'SYNCING';
        return;
      }
      const snapshot = await this.options.service.readSnapshotAt({
        blockNumber: latest.number.toString(),
        blockHash: latest.hash,
      });
      const claims: IndexedMarketClaim[] = this.db
        .prepare(
          "SELECT payload FROM event_index_events WHERE emitter=? AND name='Claim' AND canonical=1 ORDER BY block_number,log_index",
        )
        .all(address(this.options.manifest.claim))
        .map((row) => {
          const event = JSON.parse(String(row.payload)) as IndexedMarketEvent;
          return {
            accountKey: String(event.fields.accountId),
            wallet: String(event.fields.wallet),
            location: {
              ...event.location,
              confirmations: Number(latest.number - uint(event.location.blockNumber) + 1n),
            },
          };
        });
      const previous = this.options.service.projector.latest();
      const previousCanonicalHash = previous
        ? (await this.header(uint(previous.location.blockNumber))).hash
        : null;
      const result = this.options.service.publish(snapshot, latest.parentHash, previousCanonicalHash, claims);
      if (this.#resetPending) {
        this.options.service.broker.publish({ type: 'REORG', location: result.location, snapshot: result });
        this.#resetPending = false;
      }
      this.#state = 'HEALTHY';
      this.#error = null;
    } catch (error) {
      this.#state = 'DEGRADED';
      this.#error = error instanceof LaunchMarketError ? error.code : 'INDEX_RPC_FAILED';
      throw error;
    }
  }
  start(): void {
    if (this.#closed || this.#timer) throw new LaunchMarketError('INDEX_ALREADY_STARTED');
    this.#timer = setInterval(() => void this.poll().catch(() => {}), this.intervalMs);
    this.#timer.unref();
    void this.poll().catch(() => {});
  }
  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#tail?.catch(() => {});
  }
  async close(): Promise<void> {
    this.#closing = true;
    await this.stop();
    this.#closed = true;
    if (this.db.isOpen) this.db.close();
  }
  /** Wait only for existing work; the synchronous reader cannot mix a scan with an older projection. */
  async readStableHistory<T>(read: () => T): Promise<T> {
    const unavailable = () => new LaunchMarketError('MARKET_HISTORY_SYNCING', 503);
    if (this.#closing || this.#closed || !this.options.service.projector.latest()) throw unavailable();
    if (!this.#tail) {
      if (this.#state !== 'HEALTHY') throw unavailable();
      return read();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(unavailable()), 5000);
      timer.unref();
    });
    try {
      // A subsequent poll may have started before this continuation; it shares the original deadline.
      while (this.#tail) {
        await Promise.race([this.#tail, deadline]).catch(() => {
          throw unavailable();
        });
      }
      if (
        this.#closing ||
        this.#closed ||
        this.#state !== 'HEALTHY' ||
        !this.options.service.projector.latest()
      )
        throw unavailable();
      return read();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  history(strategy: StrategyId, limit = 100): readonly IndexedMarketEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new LaunchMarketError('INVALID_HISTORY_LIMIT', 400);
    const head = this.cursor();
    return this.db
      .prepare(
        'SELECT payload FROM event_index_events WHERE strategy=? AND canonical=1 ORDER BY block_number DESC,log_index DESC LIMIT ?',
      )
      .all(strategy, limit)
      .map((row) => {
        const event = JSON.parse(String(row.payload)) as IndexedMarketEvent;
        return {
          ...event,
          location: {
            ...event.location,
            confirmations: head ? Number(head.number - uint(event.location.blockNumber) + 1n) : 0,
            version: this.options.service.projector.latest()?.location.version ?? '0',
          },
        };
      });
  }
  holders(strategy: StrategyId, limit = 100): readonly { owner: string; balanceRaw: string }[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new LaunchMarketError('INVALID_HISTORY_LIMIT', 400);
    const balances = new Map<string, bigint>(),
      pass = address(this.options.manifest.strategies[strategy].pass);
    for (const row of this.db
      .prepare(
        "SELECT payload FROM event_index_events WHERE emitter=? AND name='Transfer' AND canonical=1 ORDER BY block_number,log_index",
      )
      .iterate(pass)) {
      const event = JSON.parse(String(row.payload)) as IndexedMarketEvent,
        amount = uint(String(event.fields.value)),
        from = String(event.fields.from),
        to = String(event.fields.to);
      if (from !== ZeroAddress) balances.set(from, (balances.get(from) ?? 0n) - amount);
      if (to !== ZeroAddress) balances.set(to, (balances.get(to) ?? 0n) + amount);
    }
    if ([...balances.values()].some((balance) => balance < 0n))
      throw new LaunchMarketError('HOLDER_PROJECTION_INCOMPLETE', 503);
    return [...balances]
      .filter(([, balance]) => balance > 0n)
      .sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0))
      .slice(0, limit)
      .map(([owner, balance]) => ({ owner, balanceRaw: balance.toString() }));
  }
  candles(
    strategy: StrategyId,
    bucketSeconds = 60,
    limit = 100,
  ): readonly {
    timestamp: number;
    openRaw: string;
    highRaw: string;
    lowRaw: string;
    closeRaw: string;
    volumeUsdcRaw: string;
  }[] {
    if (
      ![60, 300, 900, 3600, 86400].includes(bucketSeconds) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new LaunchMarketError('INVALID_CANDLE_RANGE', 400);
    const buckets = new Map<
      number,
      { timestamp: number; open: bigint; high: bigint; low: bigint; close: bigint; volume: bigint }
    >();
    for (const row of this.db
      .prepare(
        "SELECT payload FROM event_index_events WHERE strategy=? AND name='Swap' AND canonical=1 ORDER BY block_number,log_index",
      )
      .iterate(strategy)) {
      const event = JSON.parse(String(row.payload)) as IndexedMarketEvent,
        buy = event.fields.buy === true,
        pass = uint(String(event.fields[buy ? 'amountOut' : 'amountIn'])),
        usdc = uint(String(event.fields[buy ? 'amountIn' : 'amountOut']));
      if (pass === 0n) continue;
      const price = (usdc * 10n ** 18n) / pass,
        timestamp = Math.floor(event.timestamp / bucketSeconds) * bucketSeconds;
      const current = buckets.get(timestamp);
      if (current) {
        current.high = price > current.high ? price : current.high;
        current.low = price < current.low ? price : current.low;
        current.close = price;
        current.volume += usdc;
      } else
        buckets.set(timestamp, {
          timestamp,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: usdc,
        });
    }
    return [...buckets.values()]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-limit)
      .map((item) => ({
        timestamp: item.timestamp,
        openRaw: item.open.toString(),
        highRaw: item.high.toString(),
        lowRaw: item.low.toString(),
        closeRaw: item.close.toString(),
        volumeUsdcRaw: item.volume.toString(),
      }));
  }
}
