import {
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  constants,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readRegularBytes } from '../../../../packages/testnet/src/bounded-file.ts';
import { address } from '../../../../packages/launch-market/src/config.ts';
import { LaunchMarketError } from '../../../../packages/launch-market/src/types.ts';
import { verifyStockConsent, type SignedStockConsent } from './stock-worker-policy.ts';

export interface StockConsentEntry {
  readonly digest: string;
  readonly signed: SignedStockConsent;
  readonly active: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}
interface RegistryDocument {
  schemaVersion: 1;
  revision: number;
  entries: StockConsentEntry[];
  sessions: SignedStockConsent[];
}
function fail(code: string, status = 503): never {
  throw new LaunchMarketError(code, status);
}
function removeTemporary(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Primary atomic registry: a pause and the worker's active session list share one durable write. */
export class StockConsentRegistry {
  readonly path: string;
  private validated: { hash: string; document: RegistryDocument } | null = null;
  constructor(path: string) {
    const parent = dirname(path),
      meta = lstatSync(parent);
    if (
      !isAbsolute(path) ||
      realpathSync(parent) !== parent ||
      !meta.isDirectory() ||
      meta.mode & 0o077 ||
      meta.uid !== process.getuid?.()
    )
      fail('STOCK_REGISTRY_PRIVATE_STORAGE');
    this.path = path;
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.write({ schemaVersion: 1, revision: 0, entries: [], sessions: [] });
    }
    this.read();
  }
  private read(): RegistryDocument {
    try {
      const meta = lstatSync(this.path);
      if (
        !meta.isFile() ||
        meta.nlink !== 1 ||
        realpathSync(this.path) !== this.path ||
        meta.uid !== process.getuid?.() ||
        meta.mode & 0o077
      )
        fail('STOCK_REGISTRY_PRIVATE_STORAGE');
      const bytes = readRegularBytes(this.path, 1024 * 1024);
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (this.validated?.hash === hash) return structuredClone(this.validated.document);
      const doc = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as RegistryDocument;
      if (
        doc?.schemaVersion !== 1 ||
        !Number.isSafeInteger(doc.revision) ||
        doc.revision < 0 ||
        !Array.isArray(doc.entries) ||
        doc.entries.length > 1000 ||
        !Array.isArray(doc.sessions) ||
        doc.sessions.length > 100 ||
        Object.keys(doc).sort().join('|') !== 'entries|revision|schemaVersion|sessions'
      )
        fail('STOCK_REGISTRY_CORRUPT');
      for (const e of doc.entries)
        if (
          !e ||
          verifyStockConsent(e.signed) !== e.digest ||
          typeof e.active !== 'boolean' ||
          !Number.isSafeInteger(e.createdAt) ||
          !Number.isSafeInteger(e.updatedAt)
        )
          fail('STOCK_REGISTRY_CORRUPT');
      if (
        new Set(doc.entries.map((e) => e.digest)).size !== doc.entries.length ||
        JSON.stringify(doc.sessions) !==
          JSON.stringify(doc.entries.filter((e) => e.active).map((e) => e.signed))
      )
        fail('STOCK_REGISTRY_CORRUPT');
      this.validated = { hash, document: structuredClone(doc) };
      return doc;
    } catch (error) {
      if (error instanceof LaunchMarketError) throw error;
      return fail('STOCK_REGISTRY_CORRUPT');
    }
  }
  private write(doc: RegistryDocument): void {
    doc.sessions = doc.entries.filter((e) => e.active).map((e) => e.signed);
    const bytes = Buffer.from(JSON.stringify(doc) + '\n');
    if (bytes.length > 900 * 1024) fail('STOCK_SESSION_CAPACITY', 429);
    const temporary = join(dirname(this.path), '.stock-registry-' + randomUUID());
    try {
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.path);
      const parent = openSync(dirname(this.path), constants.O_RDONLY);
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } finally {
      removeTemporary(temporary);
    }
  }
  owned(wallet: string): { revision: number; sessions: StockConsentEntry[] } {
    const doc = this.read(),
      owner = address(wallet);
    return {
      revision: doc.revision,
      sessions: doc.entries.filter((e) => address(e.signed.consent.owner) === owner),
    };
  }
  start(
    wallet: string,
    signed: SignedStockConsent,
    expectedRevision: number,
    now: number,
  ): { revision: number; sessions: StockConsentEntry[] } {
    const owner = address(wallet),
      digest = verifyStockConsent(signed),
      doc = this.read();
    if (address(signed.consent.owner) !== owner) fail('LINKED_WALLET_REQUIRED', 403);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== doc.revision)
      fail('STOCK_SESSION_CONFLICT', 409);
    if (signed.consent.validUntil <= now) fail('STOCK_CONSENT_EXPIRED', 400);
    const prior = doc.entries.find((e) => e.digest === digest);
    if (prior) {
      if (!prior.active) fail('STOCK_CONSENT_ALREADY_USED', 409);
      return this.owned(owner);
    }
    doc.entries = doc.entries.map((e) =>
      e.active && e.signed.consent.validUntil <= now ? { ...e, active: false, updatedAt: now } : e,
    );
    if (doc.entries.length >= 1000 || doc.entries.filter((e) => e.active).length >= 100)
      fail('STOCK_SESSION_CAPACITY', 429);
    if (
      doc.entries.some((e) => e.active && address(e.signed.consent.vault) === address(signed.consent.vault))
    )
      fail('STOCK_SESSION_ALREADY_ACTIVE', 409);
    doc.entries.push({ digest, signed, active: true, createdAt: now, updatedAt: now });
    doc.revision++;
    this.write(doc);
    return this.owned(owner);
  }
  pause(
    wallet: string,
    digest: string,
    expectedRevision: number,
    now: number,
  ): { revision: number; sessions: StockConsentEntry[] } {
    const owner = address(wallet),
      doc = this.read();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== doc.revision)
      fail('STOCK_SESSION_CONFLICT', 409);
    const entry = doc.entries.find((e) => e.digest === digest && address(e.signed.consent.owner) === owner);
    if (!entry) fail('STOCK_SESSION_NOT_FOUND', 404);
    if (entry.active) {
      doc.entries = doc.entries.map((e) => (e === entry ? { ...e, active: false, updatedAt: now } : e));
      doc.revision++;
      this.write(doc);
    }
    return this.owned(owner);
  }
}
