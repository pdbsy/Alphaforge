import { getAddress } from 'ethers';
import type { StrategyId } from '../../../../packages/launch-market/src/types.ts';
import { LaunchMarketError } from '../../../../packages/launch-market/src/types.ts';
import type { MarketEventIndexer, IndexedMarketEvent } from '../launch-market/indexer.ts';

export interface IndexedPaperReal {
  readonly vault: string | null;
  readonly principalRaw: string;
  readonly cashRaw: string;
  readonly withdrawableRaw: string;
  readonly lockedPassRaw: string;
  readonly observedAt: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly confirmations: 3;
}
const fail = (): never => {
  throw new LaunchMarketError('PAPER_CHAIN_INDEX_SYNCING', 503);
};
const amount = (input: unknown): bigint => {
  if (typeof input !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(input)) return fail();
  const value = BigInt(input);
  if (value >= 1n << 256n) return fail();
  return value;
};
const event = (payload: unknown): IndexedMarketEvent => {
  const value = JSON.parse(String(payload)) as IndexedMarketEvent;
  if (!value?.fields || !value.location) return fail();
  return value;
};

/** Confirmed cash only. Reading a profit panel never performs a network or RPC request. */
export function readIndexedPaperReal(
  indexer: MarketEventIndexer,
  ownerInput: string,
  id: StrategyId,
  requestedVault?: string,
): IndexedPaperReal {
  const owner = getAddress(ownerInput).toLowerCase();
  if (!['TSLA', 'AMZN'].includes(id)) return fail();
  const cursor = indexer.db.prepare('SELECT number FROM event_index_cursor WHERE id=1').get();
  if (!cursor || !Number.isSafeInteger(cursor.number) || Number(cursor.number) < 2) return fail();
  const height = Number(cursor.number) - 2;
  const block = indexer.db
    .prepare('SELECT hash,timestamp FROM event_index_blocks WHERE number=? AND canonical=1')
    .get(height);
  if (!block || !/^0x[0-9a-f]{64}$/i.test(String(block.hash)) || !Number.isSafeInteger(block.timestamp))
    return fail();
  const base = {
    vault: null as string | null,
    principalRaw: '0',
    cashRaw: '0',
    withdrawableRaw: '0',
    lockedPassRaw: '0',
    observedAt: Number(block.timestamp),
    blockNumber: String(height),
    blockHash: String(block.hash),
    confirmations: 3 as const,
  };
  const factory = indexer.options.manifest.vaultFactory;
  if (!factory) return base;
  const selected = requestedVault ? getAddress(requestedVault).toLowerCase() : null;
  const created = indexer.db
    .prepare(
      `SELECT payload FROM event_index_events
    WHERE canonical=1 AND name='VaultCreated' AND emitter=? AND strategy=? AND block_number<=?
      AND lower(json_extract(payload,'$.fields.owner'))=?
      AND (? IS NULL OR lower(json_extract(payload,'$.fields.vault'))=?)
    ORDER BY block_number DESC,log_index DESC LIMIT 1`,
    )
    .get(factory.toLowerCase(), id, height, owner, selected, selected);
  if (!created) {
    if (selected) throw new LaunchMarketError('PAPER_VAULT_NOT_OWNED', 403);
    return base;
  }
  const generation = event(created.payload);
  if (getAddress(String(generation.fields.owner)).toLowerCase() !== owner || generation.strategyId !== id)
    return fail();
  const vault = getAddress(String(generation.fields.vault)).toLowerCase();
  const rows = indexer.db
    .prepare(
      `SELECT payload FROM event_index_events
    WHERE canonical=1 AND emitter=? AND block_number<=? AND name IN
      ('Deposited','Withdrawn','Closed','TrackedUsdcBalanceChanged')
    ORDER BY block_number,log_index LIMIT 10001`,
    )
    .all(vault, height);
  if (rows.length > 10000) return fail();
  let cash = 0n,
    principal = 0n,
    locked = 0n,
    closed = false;
  for (const row of rows) {
    const value = event(row.payload),
      fields = value.fields;
    if (
      value.name !== 'TrackedUsdcBalanceChanged' &&
      getAddress(String(fields.owner)).toLowerCase() !== owner
    )
      return fail();
    if (value.name === 'Deposited') {
      if (closed) return fail();
      const deposited = amount(fields.usdcAmount),
        pass = amount(fields.passRaw);
      if (pass !== deposited * 10n ** 12n) return fail();
      cash = amount(fields.trackedUsdcBalance);
      principal = amount(fields.principalBasis);
      locked += pass;
    } else if (value.name === 'Withdrawn') {
      cash = amount(fields.trackedUsdcBalance);
      principal = amount(fields.principalBasis);
      locked -= amount(fields.passRawUnlocked);
    } else if (value.name === 'TrackedUsdcBalanceChanged') {
      cash = amount(fields.newBalance);
    } else if (value.name === 'Closed') {
      if (amount(fields.passRawReleased) !== locked) return fail();
      cash = 0n;
      principal = 0n;
      locked = 0n;
      closed = true;
    }
    if (locked < 0n || locked >= 1n << 256n) return fail();
  }
  return {
    ...base,
    vault,
    principalRaw: String(principal),
    cashRaw: String(cash),
    withdrawableRaw: String(cash),
    lockedPassRaw: String(locked),
  };
}
