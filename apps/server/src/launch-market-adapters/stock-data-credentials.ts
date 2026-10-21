import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readRegularBytes } from '../../../../packages/testnet/src/bounded-file.ts';
import { LaunchMarketError } from '../../../../packages/launch-market/src/types.ts';
import { VerifiedStockReference } from './stock-reference.ts';

/** Read-only market data client. Loading credentials never enables keeper signing or a trading worker. */
export function loadStockDataReference(
  path?: string,
  options: {
    readonly now?: () => number;
    readonly fetcher?: typeof fetch;
  } = {},
): VerifiedStockReference | null {
  if (path === undefined) return null;
  try {
    if (!isAbsolute(path) || path !== resolve(path) || realpathSync(dirname(path)) !== dirname(path))
      throw new Error('PRIVATE_PATH');
    const parent = lstatSync(dirname(path)),
      before = lstatSync(path);
    if (
      !parent.isDirectory() ||
      parent.uid !== process.getuid?.() ||
      parent.mode & 0o077 ||
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o077 ||
      realpathSync(path) !== path
    )
      throw new Error('PRIVATE_FILE');
    const bytes = readRegularBytes(path, 4096),
      after = lstatSync(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.uid !== after.uid ||
      before.mode !== after.mode ||
      before.nlink !== after.nlink ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('PRIVATE_FILE_CHANGED');
    const credentials = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (
      !credentials ||
      typeof credentials !== 'object' ||
      Array.isArray(credentials) ||
      Object.keys(credentials).sort().join('|') !== 'apiKey|apiSecret'
    )
      throw new Error('PRIVATE_FIELDS');
    const { apiKey, apiSecret } = credentials as Record<string, unknown>;
    if (
      typeof apiKey !== 'string' ||
      typeof apiSecret !== 'string' ||
      !/^[\x21-\x7e]{1,1024}$/.test(apiKey) ||
      !/^[\x21-\x7e]{1,1024}$/.test(apiSecret)
    )
      throw new Error('PRIVATE_CREDENTIALS');
    return new VerifiedStockReference({ apiKey, apiSecret, ...options });
  } catch {
    // A provider or parse error may otherwise include credentials and private paths in startup logs.
    throw new LaunchMarketError('STOCK_DATA_CREDENTIALS_UNAVAILABLE', 503);
  }
}
