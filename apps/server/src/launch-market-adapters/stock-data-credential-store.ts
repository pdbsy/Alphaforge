import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { LaunchMarketError } from '../../../../packages/launch-market/src/types.ts';

export interface StockDataSavedStatus {
  readonly saved: boolean;
  readonly updatedAt: number | null;
  readonly source: 'Alpaca IEX';
  readonly readOnlyEnabled: false;
  readonly tradingEnabled: false;
}
export interface StockDataCredentialInput {
  readonly apiKey: string;
  readonly apiSecret: string;
}
export interface StockDataSnapshot {
  readonly status: StockDataSavedStatus;
  readonly fingerprint: string;
}
function unavailable(): never {
  throw new LaunchMarketError('STOCK_DATA_STORAGE_UNAVAILABLE', 503);
}
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const currentUid = () => BigInt(process.getuid!());
const fingerprint = (file: BigIntStats | null) =>
  createHash('sha256')
    .update(
      file
        ? [file.dev, file.ino, file.uid, file.mode, file.nlink, file.size, file.mtimeNs, file.ctimeNs]
            .map(String)
            .join(':')
        : 'ABSENT',
    )
    .digest('hex');

/** A fixed private target. The HTTP status never reads, returns, or verifies a saved secret. */
export class StockDataCredentialStore {
  readonly #path: string;
  readonly #parent: string;
  readonly #directory: BigIntStats;
  constructor(path: string) {
    try {
      if (process.platform === 'win32' || !isAbsolute(path) || path !== resolve(path)) unavailable();
      this.#path = path;
      this.#parent = dirname(path);
      this.#directory = lstatSync(this.#parent, { bigint: true });
      this.assertParent();
      this.inspectFile();
    } catch {
      unavailable();
    }
  }
  private assertParent(): void {
    const parent = lstatSync(this.#parent, { bigint: true });
    if (
      !parent.isDirectory() ||
      !same(parent, this.#directory) ||
      parent.uid !== currentUid() ||
      (parent.mode & 0o777n) !== 0o700n ||
      realpathSync(this.#parent) !== this.#parent
    )
      unavailable();
  }
  private inspectFile(): BigIntStats | null {
    this.assertParent();
    try {
      const file = lstatSync(this.#path, { bigint: true });
      if (
        !file.isFile() ||
        file.nlink !== 1n ||
        file.uid !== currentUid() ||
        (file.mode & 0o777n) !== 0o600n ||
        file.size < 1n ||
        file.size > 4096n ||
        realpathSync(this.#path) !== this.#path
      )
        unavailable();
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  snapshot(): StockDataSnapshot {
    try {
      const file = this.inspectFile();
      const updatedAt = file ? Number(file.mtimeNs / 1_000_000_000n) : null;
      if (updatedAt !== null && (!Number.isSafeInteger(updatedAt) || updatedAt < 0)) unavailable();
      return {
        status: {
          saved: file !== null,
          updatedAt,
          source: 'Alpaca IEX',
          readOnlyEnabled: false,
          tradingEnabled: false,
        },
        fingerprint: fingerprint(file),
      };
    } catch {
      return unavailable();
    }
  }
  save(input: StockDataCredentialInput, expectedFingerprint: string): StockDataSavedStatus {
    const invalid = (): never => {
      throw new LaunchMarketError('INVALID_STOCK_DATA_CREDENTIALS', 400);
    };
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).sort().join('|') !== 'apiKey|apiSecret' ||
      typeof input.apiKey !== 'string' ||
      typeof input.apiSecret !== 'string' ||
      !/^[\x21-\x7e]{1,1024}$/.test(input.apiKey) ||
      !/^[\x21-\x7e]{1,1024}$/.test(input.apiSecret)
    )
      invalid();
    const bytes = Buffer.from(JSON.stringify({ apiKey: input.apiKey, apiSecret: input.apiSecret }) + '\n');
    if (bytes.length > 4096) invalid();
    const temporary = join(this.#parent, '.stock-data-save-' + randomUUID());
    let temporaryIdentity: BigIntStats | null = null;
    let renamed = false;
    try {
      const before = this.inspectFile();
      if (fingerprint(before) !== expectedFingerprint)
        throw new LaunchMarketError('STOCK_DATA_STATE_CHANGED', 409);
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        temporaryIdentity = fstatSync(fd, { bigint: true });
        if (
          !temporaryIdentity.isFile() ||
          temporaryIdentity.uid !== currentUid() ||
          temporaryIdentity.nlink !== 1n ||
          (temporaryIdentity.mode & 0o777n) !== 0o600n
        )
          unavailable();
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Recheck both directory and target after writing, so another device cannot overwrite a newer saved file.
      const current = this.inspectFile();
      if (fingerprint(current) !== expectedFingerprint)
        throw new LaunchMarketError('STOCK_DATA_STATE_CHANGED', 409);
      const staged = lstatSync(temporary, { bigint: true });
      if (
        !same(staged, temporaryIdentity!) ||
        staged.nlink !== 1n ||
        staged.uid !== currentUid() ||
        (staged.mode & 0o777n) !== 0o600n ||
        staged.size !== BigInt(bytes.length) ||
        realpathSync(temporary) !== temporary
      )
        unavailable();
      renameSync(temporary, this.#path);
      renamed = true;
      const parentFd = openSync(
        this.#parent,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        if (!same(fstatSync(parentFd, { bigint: true }), this.#directory)) unavailable();
        fsyncSync(parentFd);
      } finally {
        closeSync(parentFd);
      }
      return this.snapshot().status;
    } catch (error) {
      if (error instanceof LaunchMarketError && error.code === 'STOCK_DATA_STATE_CHANGED') throw error;
      // rename is the commit point. A later durability failure requires metadata readback, not a claim that the old file survived.
      if (renamed) throw new LaunchMarketError('STOCK_DATA_SAVE_UNCERTAIN', 503);
      return unavailable();
    } finally {
      bytes.fill(0);
      if (!renamed && temporaryIdentity) {
        try {
          const current = lstatSync(temporary, { bigint: true });
          if (same(current, temporaryIdentity)) unlinkSync(temporary);
        } catch {
          /* Never remove an unknown replacement or expose private filesystem details. */
        }
      }
    }
  }
}
