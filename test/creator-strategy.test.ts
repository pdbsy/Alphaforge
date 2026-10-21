import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreatorStrategyStore, validateCreatorStrategy } from '../packages/launch-market/src/creator.ts';

const wallet = '0x' + '11'.repeat(20),
  other = '0x' + '22'.repeat(20);
const input = {
  name: 'Steady TSLA exposure',
  symbol: 'TSLA',
  summary: 'Hold a bounded TSLA allocation through regular sessions.',
  method: 'Purchase the configured allocation once after an explicit owner approval.',
  risks: 'Equity prices can fall and gaps may exceed the configured tolerance.',
  policy: { kind: 'BUY_AND_HOLD', allocationBps: 2500, maxSlippageBps: 100 },
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'af-creator-'));
  const path = join(dir, 'creator.sqlite');
  const store = new CreatorStrategyStore(path, 'https://www.ikol.top');
  return {
    store,
    path,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('publication preserves immutable policy versions while private edits stay private', () => {
  const f = fixture();
  try {
    const draft = f.store.create(wallet, input, 1000);
    assert.throws(() => f.store.publicDetail(draft.id), /STRATEGY_NOT_FOUND/);
    const published = f.store.publish(wallet, draft.id, 1, 1001, 0);
    assert.equal(published.executionStatus, 'DOCUMENT_ONLY');
    assert.equal(f.store.publicDetail(draft.id).digest, draft.digest);
    assert.equal(f.store.publish(wallet, draft.id, 1, 1002, 0).publishedAt, 1001);
    const edited = f.store.update(
      wallet,
      draft.id,
      1,
      {
        ...input,
        name: 'Steady TSLA revised',
        policy: { kind: 'DCA', allocationBps: 2000, maxSlippageBps: 50, intervalDays: 7 },
      },
      1003,
    );
    assert.equal(edited.version, 2);
    assert.equal(edited.draftChanges, true);
    assert.equal(f.store.publicDetail(draft.id).name, input.name);
    assert.equal(f.store.publicDetail(draft.id).digest, draft.digest);
    assert.throws(() => f.store.publish(wallet, draft.id, 1, 1004, 1), /STRATEGY_VERSION_CONFLICT/);
    f.store.publish(wallet, draft.id, 2, 1004, 1);
    assert.equal(f.store.publicDetail(draft.id).name, edited.name);
    assert.notEqual(f.store.publicDetail(draft.id).digest, draft.digest);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM creator_publications').get()!.n, 2);
    f.store.unpublish(wallet, draft.id, 2, 2);
    assert.throws(() => f.store.publicDetail(draft.id), /STRATEGY_NOT_FOUND/);
    assert.equal(f.store.publicList().strategies.length, 0);
    assert.equal(f.store.owned(wallet)[0]!.status, 'UNLISTED');
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM creator_publications').get()!.n, 2);
    f.store.close();
    const reopened = new CreatorStrategyStore(f.path, 'https://www.ikol.top');
    try {
      assert.equal(reopened.owned(wallet)[0]!.version, 2);
      assert.equal(reopened.owned(other).length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});
test('creator ownership and optimistic updates reject another wallet and stale devices', () => {
  const f = fixture();
  try {
    const draft = f.store.create(wallet, input, 1000);
    assert.throws(() => f.store.update(other, draft.id, 1, input, 1001), /STRATEGY_NOT_FOUND/);
    assert.throws(() => f.store.publish(other, draft.id, 1, 1001, 0), /STRATEGY_NOT_FOUND/);
    assert.throws(() => f.store.unpublish(other, draft.id, 1, 0), /STRATEGY_NOT_FOUND/);
    f.store.update(wallet, draft.id, 1, input, 1001);
    assert.throws(() => f.store.update(wallet, draft.id, 1, input, 1002), /STRATEGY_VERSION_CONFLICT/);
    assert.throws(
      () => new CreatorStrategyStore(f.path, 'https://elsewhere.example'),
      /CREATOR_DATABASE_IDENTITY/,
    );
    assert.equal(f.store.owned(wallet).length, 1);
  } finally {
    f.close();
  }
});
test('two devices cannot overwrite a changed publication state and retries are idempotent', () => {
  const f = fixture();
  try {
    const draft = f.store.create(wallet, input, 1000);
    const publicVersion = f.store.publish(wallet, draft.id, 1, 1001, 0);
    assert.equal(publicVersion.publicationRevision, 1);
    assert.throws(() => f.store.unpublish(wallet, draft.id, 1, 0), /STRATEGY_PUBLICATION_CONFLICT/);
    const hidden = f.store.unpublish(wallet, draft.id, 1, 1);
    assert.equal(hidden.publicationRevision, 2);
    assert.equal(f.store.unpublish(wallet, draft.id, 1, 1).publicationRevision, 2);
    assert.throws(() => f.store.publish(wallet, draft.id, 1, 1002, 0), /STRATEGY_PUBLICATION_CONFLICT/);
    assert.equal(f.store.publish(wallet, draft.id, 1, 1003, 2).publicationRevision, 3);
    assert.equal(f.store.publish(wallet, draft.id, 1, 1003, 2).publicationRevision, 3);
  } finally {
    f.close();
  }
});
test('declarative policy validation rejects arbitrary code, invalid periods and excess exposure', () => {
  for (const invalid of [
    { ...input, symbol: 'UNLISTED' },
    { ...input, method: '\u0000' + input.method },
    { ...input, execute: 'eval(userCode)' },
    { ...input, policy: { ...input.policy, allocationBps: 10001 } },
    { ...input, policy: { ...input.policy, maxSlippageBps: 501 } },
    { ...input, policy: { ...input.policy, code: 'sendAllFunds()' } },
    {
      ...input,
      policy: { kind: 'EMA_CROSS', allocationBps: 1000, maxSlippageBps: 100, fastPeriod: 20, slowPeriod: 10 },
    },
    { ...input, policy: { kind: 'DCA', allocationBps: 1000, maxSlippageBps: 100, intervalDays: 0 } },
  ])
    assert.throws(() => validateCreatorStrategy(invalid), /INVALID_STRATEGY/);
});
test('public pagination uses immutable published content and excludes other wallets drafts', () => {
  const f = fixture();
  try {
    for (let n = 0; n < 5; n++) {
      const draft = f.store.create(wallet, { ...input, name: 'Published strategy ' + n }, 1000 + n);
      f.store.publish(wallet, draft.id, 1, 1000 + n, 0);
    }
    f.store.create(other, { ...input, name: 'Private strategy document' }, 1006);
    const first = f.store.publicList(undefined, 2),
      second = f.store.publicList(first.nextCursor!, 2),
      third = f.store.publicList(second.nextCursor!, 2);
    assert.equal(
      new Set([...first.strategies, ...second.strategies, ...third.strategies].map((s) => s.id)).size,
      5,
    );
    assert.equal(third.nextCursor, null);
    assert.throws(() => f.store.publicList('../invalid'), /INVALID_CURSOR/);
  } finally {
    f.close();
  }
});
