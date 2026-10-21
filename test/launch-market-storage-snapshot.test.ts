import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  lstatSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Wallet } from 'ethers';
import { createHash } from 'node:crypto';
import { privateServerStorage } from '../packages/testnet/src/private-storage.ts';
import { LaunchMarketStore } from '../packages/launch-market/src/store.ts';
import { LaunchMarketService } from '../packages/launch-market/src/service.ts';
import { MarketEventIndexer } from '../apps/server/src/launch-market/indexer.ts';
import { snapshotLaunchStorage, expectedSchemaSha256 } from '../tools/launch-market/storage-snapshot.ts';
import type { LaunchMarketManifest } from '../packages/launch-market/src/types.ts';

const h = (n: number) => '0x' + n.toString(16).padStart(64, '0'),
  a = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const digest = h(42),
  origin = 'https://alphaforge.example.test';
const manifest: LaunchMarketManifest = {
  schemaVersion: 1,
  chainId: 46630,
  deploymentBlock: '1',
  usdc: a(1),
  claim: a(2),
  conversionReserve: a(3),
  router: a(4),
  poolFactory: a(5),
  vaultFactory: null,
  strategies: {
    TSLA: { pass: a(6), launch: a(7), pool: null, lpRecipient: a(20) },
    AMZN: { pass: a(8), launch: null, pool: a(9), lpRecipient: a(21) },
  },
  runtimeCodeHashes: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [a(n), h(99)])),
};
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'af-storage-snapshot-'))),
    source = join(parent, 'source'),
    lease = privateServerStorage(source, 512 * 1024 * 1024);
  lease.bindIdentity('PUBLIC_TESTNET', digest);
  const store = new LaunchMarketStore(lease.databasePath('market', 1095126347), origin),
    service = new LaunchMarketService({
      store,
      manifest,
      chain: null,
      ethReference: null,
      claimSigner: null,
      quoteSigner: null,
    });
  const indexer = new MarketEventIndexer({
    path: lease.databasePath('market-events', 1095126348),
    manifest,
    provider: {
      send: async () => {
        throw new Error('UNUSED');
      },
    },
    service,
  });
  return {
    parent,
    source,
    lease,
    store,
    service,
    indexer,
    cleanup: async () => {
      await indexer.close();
      store.close();
      lease.close();
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

test('offline WAL backup and restore preserve opaque accounts, completed vouchers, canonical events, and exact namespace bytes', async () => {
  const f = fixture();
  try {
    const wallet = Wallet.createRandom(),
      account = f.store.trustedAccount(
        { email: 'case+claim@example.test', subject: 'snapshot-fixture-person', emailVerified: true },
        1000,
      ),
      challenge = f.store.bindingChallenge(account.id, wallet.address, 1000);
    f.store.bindWallet(account.id, challenge.nonce, await wallet.signMessage(challenge.message), 1000);
    const voucher = f.store.reserveClaim(account.id, wallet.address, 1000, 1060, 0);
    f.store.observeClaim({
      accountKey: account.accountKey,
      wallet: wallet.address,
      location: {
        chainId: 46630,
        blockNumber: '2',
        blockHash: h(2),
        transactionHash: h(102),
        logIndex: 0,
        version: '1',
        confirmations: 3,
      },
    });
    f.indexer.db.prepare('INSERT INTO event_index_blocks VALUES(?,?,?,?,1)').run(2, h(2), h(1), 1000);
    f.indexer.db.prepare('INSERT INTO event_index_cursor VALUES(1,?,?)').run(2, h(2));
    f.indexer.db
      .prepare('INSERT INTO event_index_events VALUES(?,?,?,?,?,?,?,?,1)')
      .run(h(102), 0, h(2), 2, a(2), 'Claim', null, JSON.stringify({ accountKey: account.accountKey }));
    const identity = readFileSync(join(f.source, 'network-identity.json'));
    assert.ok(lstatSync(join(f.source, 'market.sqlite-wal')).size > 0);
    const mainBefore = readFileSync(join(f.source, 'market.sqlite')),
      walBefore = readFileSync(join(f.source, 'market.sqlite-wal'));
    // The fixture holds SQLite handles to keep committed WAL pages present; no application server holds the lease.
    f.lease.close();
    const backup = join(f.parent, 'backup'),
      restored = join(f.parent, 'restored');
    const copied = await snapshotLaunchStorage({
      action: 'backup',
      source: f.source,
      destination: backup,
      expectedDigest: digest,
    });
    assert.equal(copied.databases.length, 2);
    assert.equal(copied.databases[0]?.tables.find((table) => table.name === 'market_accounts')?.count, 1);
    assert.deepEqual(readFileSync(join(f.source, 'market.sqlite')), mainBefore);
    assert.deepEqual(readFileSync(join(f.source, 'market.sqlite-wal')), walBefore);
    assert.deepEqual(readFileSync(join(backup, 'network-identity.json')), identity);
    const restoredReport = await snapshotLaunchStorage({
      action: 'restore',
      source: backup,
      destination: restored,
      expectedDigest: digest,
    });
    assert.deepEqual(restoredReport.databases, copied.databases);
    for (const folder of [backup, restored]) {
      assert.equal(lstatSync(folder).mode & 0o777, 0o700);
      for (const file of [
        'network-identity.json',
        'market.sqlite',
        'market-events.sqlite',
        'storage-snapshot.json',
      ])
        assert.equal(lstatSync(join(folder, file)).mode & 0o777, 0o600);
    }
    const reopenedLease = privateServerStorage(restored, 512 * 1024 * 1024);
    reopenedLease.bindIdentity('PUBLIC_TESTNET', digest);
    const reopened = new LaunchMarketStore(reopenedLease.databasePath('market', 1095126347), origin);
    try {
      const recovered = reopened.trustedAccount(
        { email: 'case+claim@example.test', subject: 'snapshot-fixture-person', emailVerified: true },
        1100,
      );
      assert.equal(recovered.id, account.id);
      assert.equal(recovered.accountKey, account.accountKey);
      assert.equal(reopened.voucher(account.id)?.nonce, voucher.nonce);
      assert.equal(reopened.voucher(account.id)?.status, 'COMPLETED');
      assert.equal(
        reopened.db.prepare('SELECT COUNT(*) AS n FROM market_claim_events WHERE canonical=1').get()?.n,
        1,
      );
      assert.throws(() => reopened.reserveClaim(account.id, wallet.address, 1100, 1160, 1));
      const events = new DatabaseSync(reopenedLease.databasePath('market-events', 1095126348), {
        readOnly: true,
      });
      try {
        assert.equal(
          events
            .prepare("SELECT COUNT(*) AS n FROM event_index_events WHERE name='Claim' AND canonical=1")
            .get()?.n,
          1,
        );
      } finally {
        events.close();
      }
    } finally {
      reopened.close();
      reopenedLease.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('offline copies reject a held server lock, an existing destination, mismatched namespace and foreign database without overwriting', async () => {
  const f = fixture();
  try {
    const target = join(f.parent, 'target');
    await assert.rejects(
      snapshotLaunchStorage({
        action: 'backup',
        source: f.source,
        destination: target,
        expectedDigest: digest,
      }),
      /TESTNET_STORAGE_LOCKED/,
    );
    f.lease.close();
    await assert.rejects(
      snapshotLaunchStorage({
        action: 'backup',
        source: f.source,
        destination: target,
        expectedDigest: h(43),
      }),
      /SNAPSHOT_NETWORK_IDENTITY/,
    );
    await snapshotLaunchStorage({
      action: 'backup',
      source: f.source,
      destination: target,
      expectedDigest: digest,
    });
    const preserved = readFileSync(join(target, 'market.sqlite'));
    await assert.rejects(
      snapshotLaunchStorage({
        action: 'restore',
        source: target,
        destination: target,
        expectedDigest: digest,
      }),
      /SNAPSHOT_DESTINATION_EXISTS/,
    );
    assert.deepEqual(readFileSync(join(target, 'market.sqlite')), preserved);
    f.store.db.exec('PRAGMA application_id=123');
    await assert.rejects(
      snapshotLaunchStorage({
        action: 'backup',
        source: f.source,
        destination: join(f.parent, 'foreign'),
        expectedDigest: digest,
      }),
      /SNAPSHOT_DATABASE_IDENTITY/,
    );
  } finally {
    await f.cleanup();
  }
});

test('restore rejects altered eligibility data and source links or unrecognized files', async () => {
  const f = fixture();
  try {
    const wallet = Wallet.createRandom();
    const account = f.store.trustedAccount(
      { email: 'tamper-fixture@example.test', subject: 'tamper-fixture', emailVerified: true },
      1000,
    );
    const challenge = f.store.bindingChallenge(account.id, wallet.address, 1000);
    f.store.bindWallet(account.id, challenge.nonce, await wallet.signMessage(challenge.message), 1000);
    f.store.reserveClaim(account.id, wallet.address, 1000, 1060, 0);
    f.lease.close();
    const backup = join(f.parent, 'backup');
    await snapshotLaunchStorage({
      action: 'backup',
      source: f.source,
      destination: backup,
      expectedDigest: digest,
    });
    const changed = new DatabaseSync(join(backup, 'market.sqlite'));
    changed.prepare('UPDATE market_claim_vouchers SET nonce=?').run('1');
    changed.close();
    await assert.rejects(
      snapshotLaunchStorage({
        action: 'restore',
        source: backup,
        destination: join(f.parent, 'changed'),
        expectedDigest: digest,
      }),
      /SNAPSHOT_CONTENT_CHANGED/,
    );
    const outside = join(f.parent, 'outside');
    writeFileSync(outside, 'private', { mode: 0o600 });
    symlinkSync(outside, join(f.source, 'unknown-key'));
    await assert.rejects(
      snapshotLaunchStorage({
        action: 'backup',
        source: f.source,
        destination: join(f.parent, 'linked'),
        expectedDigest: digest,
      }),
      /TESTNET_STORAGE_UNSAFE/,
    );
    rmSync(join(f.source, 'unknown-key'));
    writeFileSync(join(f.source, 'unknown-key'), 'private', { mode: 0o600 });
    await assert.rejects(
      snapshotLaunchStorage({
        action: 'backup',
        source: f.source,
        destination: join(f.parent, 'unknown'),
        expectedDigest: digest,
      }),
      /SNAPSHOT_UNKNOWN_FILE/,
    );
  } finally {
    await f.cleanup();
  }
});

test('canonical schema pins reject a changed CHECK or unique predicate with unchanged table columns and index names', async () => {
  for (const altered of ['CHECK', 'UNIQUE_PREDICATE'] as const) {
    const f = fixture();
    try {
      const canonical = (db: DatabaseSync) =>
        createHash('sha256')
          .update(
            JSON.stringify(
              db
                .prepare(
                  'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type COLLATE BINARY,name COLLATE BINARY',
                )
                .all(),
            ),
          )
          .digest('hex');
      assert.equal(canonical(f.store.db), expectedSchemaSha256['market.sqlite']);
      assert.equal(canonical(f.indexer.db), expectedSchemaSha256['market-events.sqlite']);
      if (altered === 'CHECK') {
        const original = String(
          f.store.db.prepare("SELECT sql FROM sqlite_schema WHERE name='market_projection_version'").get()
            ?.sql,
        );
        f.store.db.exec('ALTER TABLE market_projection_version RENAME TO replaced_projection_version;');
        f.store.db.exec(original.replace('CHECK(id=1)', 'CHECK(id>=1)'));
        f.store.db.exec(
          'INSERT INTO market_projection_version SELECT * FROM replaced_projection_version; DROP TABLE replaced_projection_version;',
        );
      } else {
        f.store.db.exec(
          'DROP INDEX one_canonical_account_claim; CREATE UNIQUE INDEX one_canonical_account_claim ON market_claim_events(chain_id,account_key) WHERE canonical=0;',
        );
      }
      f.lease.close();
      await assert.rejects(
        snapshotLaunchStorage({
          action: 'backup',
          source: f.source,
          destination: join(f.parent, 'foreign-ddl'),
          expectedDigest: digest,
        }),
        /SNAPSHOT_UNKNOWN_SCHEMA/,
      );
    } finally {
      await f.cleanup();
    }
  }
});

test('target integrity rejects violated CHECK data under the unchanged canonical schema while retaining source bytes', async () => {
  const f = fixture();
  try {
    f.store.db.exec('PRAGMA ignore_check_constraints=ON;');
    f.store.db
      .prepare('INSERT INTO market_claim_events VALUES(?,?,?,?,?,?,?,?)')
      .run(46630, h(90), 0, 2, h(2), h(88), a(30), 2);
    f.store.db.exec('PRAGMA ignore_check_constraints=OFF;');
    f.lease.close();
    const main = readFileSync(join(f.source, 'market.sqlite')),
      wal = readFileSync(join(f.source, 'market.sqlite-wal'));
    await assert.rejects(
      snapshotLaunchStorage({
        action: 'backup',
        source: f.source,
        destination: join(f.parent, 'invalid-check'),
        expectedDigest: digest,
      }),
      /SNAPSHOT_DATABASE_INTEGRITY/,
    );
    assert.deepEqual(readFileSync(join(f.source, 'market.sqlite')), main);
    assert.deepEqual(readFileSync(join(f.source, 'market.sqlite-wal')), wal);
    const target = new DatabaseSync(join(f.parent, 'invalid-check', 'market.sqlite'));
    try {
      target.exec('PRAGMA query_only=ON;');
      assert.ok(
        target
          .prepare('PRAGMA integrity_check')
          .all()
          .some((row) => String(row.integrity_check).includes('CHECK constraint failed')),
      );
    } finally {
      target.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('schema v3 backup preserves genuine wallet sessions and opaque eligibility across restore', async () => {
  const f = fixture();
  try {
    const wallet = Wallet.createRandom(),
      challenge = f.store.walletTestChallenge(wallet.address, 1000),
      session = f.store.openWalletTestSession(
        challenge.nonce,
        await wallet.signMessage(challenge.message),
        1000,
      );
    f.lease.close();
    const saved = join(f.parent, 'wallet-backup'),
      restored = join(f.parent, 'wallet-restored');
    const copied = await snapshotLaunchStorage({
      action: 'backup',
      source: f.source,
      destination: saved,
      expectedDigest: digest,
    });
    assert.equal(
      copied.databases[0]?.tables.find((table) => table.name === 'market_wallet_test_sessions')?.count,
      1,
    );
    await snapshotLaunchStorage({
      action: 'restore',
      source: saved,
      destination: restored,
      expectedDigest: digest,
    });
    const recovered = new LaunchMarketStore(join(restored, 'market.sqlite'), origin);
    try {
      const login = recovered.walletTestSession(session.token, session.csrfToken, 1001, true);
      assert.equal(login?.account.id, session.account.id);
      assert.equal(login?.account.accountKey, session.account.accountKey);
      assert.equal(login?.account.email, null);
      assert.equal(login?.account.identityKind, 'WALLET_TEST');
    } finally {
      recovered.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('explicit legacy v1 schema remains admissible for backup before the account migration', async () => {
  const f = fixture();
  try {
    // Empty legacy fixture with the original exact DDL, not an altered production database.
    f.store.db.exec(`PRAGMA foreign_keys=OFF;
DROP TABLE market_wallet_test_sessions;
DROP TABLE market_wallet_test_challenges;
DROP TABLE market_wallet_test_identities;
DROP TABLE market_accounts;
CREATE TABLE market_accounts(id TEXT PRIMARY KEY,account_key TEXT NOT NULL UNIQUE,email TEXT NOT NULL UNIQUE,subject TEXT NOT NULL UNIQUE,verified_at INTEGER NOT NULL,wallet TEXT UNIQUE,created_at INTEGER NOT NULL) STRICT;
PRAGMA user_version=1;
PRAGMA foreign_keys=ON;`);
    f.lease.close();
    const saved = join(f.parent, 'legacy-backup'),
      restored = join(f.parent, 'legacy-restored');
    const copied = await snapshotLaunchStorage({
      action: 'backup',
      source: f.source,
      destination: saved,
      expectedDigest: digest,
    });
    assert.equal(
      copied.databases[0]?.tables.some((table) => table.name === 'market_wallet_test_sessions'),
      false,
    );
    await snapshotLaunchStorage({
      action: 'restore',
      source: saved,
      destination: restored,
      expectedDigest: digest,
    });
    const recovered = new LaunchMarketStore(join(restored, 'market.sqlite'), origin);
    try {
      assert.equal(recovered.db.prepare('PRAGMA user_version').get()?.user_version, 3);
      assert.equal(recovered.db.prepare('PRAGMA foreign_key_check').get(), undefined);
    } finally {
      recovered.close();
    }
  } finally {
    await f.cleanup();
  }
});
