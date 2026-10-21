import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadStockDataReference } from '../apps/server/src/launch-market-adapters/stock-data-credentials.ts';

test('readonly source loader admits only private exact credentials and failures never expose secrets or paths', () => {
  const folder = mkdtempSync(join(tmpdir(), 'af-stock-source-'));
  const path = join(folder, 'stock-data.json'),
    alias = join(folder, 'alias.json');
  const key = 'sample-readonly-api-key',
    secret = 'sample-readonly-secret';
  const good = JSON.stringify({ apiKey: key, apiSecret: secret });
  const reject = (target = path) =>
    assert.throws(
      () => loadStockDataReference(target),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'STOCK_DATA_CREDENTIALS_UNAVAILABLE');
        assert.equal(JSON.stringify(error).includes(secret), false);
        assert.equal(error.message.includes(folder), false);
        return true;
      },
    );
  try {
    assert.equal(loadStockDataReference(), null);
    let requests = 0;
    writeFileSync(path, good, { mode: 0o600 });
    const source = loadStockDataReference(path, {
      fetcher: async () => {
        requests++;
        throw new Error('not-called');
      },
    });
    assert.ok(source);
    assert.equal(JSON.stringify(source).includes(secret), false);
    assert.equal(requests, 0);
    chmodSync(path, 0o644);
    reject();
    chmodSync(path, 0o600);
    chmodSync(folder, 0o755);
    reject();
    chmodSync(folder, 0o700);
    symlinkSync(path, alias);
    reject(alias);
    unlinkSync(alias);
    linkSync(path, alias);
    reject();
    unlinkSync(alias);
    for (const invalid of [
      JSON.stringify({ apiKey: key, apiSecret: secret, signer: secret }),
      JSON.stringify({ apiKey: key, apiSecret: '' }),
      JSON.stringify({ apiKey: key, apiSecret: secret + '\n' }),
      'invalid-json-' + secret,
      'x'.repeat(4097),
    ]) {
      writeFileSync(path, invalid);
      reject();
    }
    reject(join(folder, 'missing.json'));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
