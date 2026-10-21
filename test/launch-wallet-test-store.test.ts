import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Wallet } from 'ethers';
import { LaunchMarketStore } from '../packages/launch-market/src/store.ts';
import type { TrustedEmailIdentity } from '../packages/launch-market/src/types.ts';

const origin = 'https://www.ikol.top';
const h = (n: number) => '0x' + n.toString(16).padStart(64, '0');
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'af-wallet-test-store-'));
  const path = join(folder, 'market.sqlite');
  const store = new LaunchMarketStore(path, origin);
  return {
    store,
    path,
    close() {
      store.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
function identity(n: number): TrustedEmailIdentity {
  return { email: `user${n}@example.test`, subject: `google:${n}`, emailVerified: true };
}
async function signIn(store: LaunchMarketStore, wallet: Wallet, now = 1000) {
  const challenge = store.walletTestChallenge(wallet.address, now);
  return store.openWalletTestSession(challenge.nonce, await wallet.signMessage(challenge.message), now);
}
function completeClaim(store: LaunchMarketStore, accountId: string, wallet: string) {
  const voucher = store.reserveClaim(accountId, wallet, 1000, 1060, 0);
  store.observeClaim({
    accountKey: voucher.accountKey,
    wallet,
    location: {
      chainId: 46630,
      blockNumber: '10',
      blockHash: h(10),
      transactionHash: h(11),
      logIndex: 0,
      version: '1',
      confirmations: 3,
    },
  });
  return store.voucher(accountId)!;
}

test('wallet sign-in and account-link messages checksum the public administrator address while retaining normalized database identity', () => {
  const f = fixture();
  try {
    // Public address only; this test never has or requests the administrator's private key.
    const administrator = '0x86767116cd40bf6b4f8cf88e08d11e38b04364cf';
    const checksumAdministrator = '0x86767116cd40bf6b4f8cf88E08D11E38B04364Cf';
    assert.notEqual(checksumAdministrator, administrator);
    const account = f.store.trustedAccount(identity(900), 1000);
    for (const input of [administrator, checksumAdministrator]) {
      const login = f.store.walletTestChallenge(input, 1000);
      assert.equal(login.message.split('\n')[1], checksumAdministrator);
      assert.equal(
        f.store.db.prepare('SELECT wallet FROM market_wallet_test_challenges WHERE nonce=?').get(login.nonce)!
          .wallet,
        administrator,
      );
      const binding = f.store.bindingChallenge(account.id, input, 1000);
      assert.equal(binding.message.split('\n')[1], checksumAdministrator);
      assert.equal(
        f.store.db.prepare('SELECT wallet FROM market_wallet_challenges WHERE nonce=?').get(binding.nonce)!
          .wallet,
        administrator,
      );
    }
  } finally {
    f.close();
  }
});

test('wallet test login proves possession without fabricating email verification and hashes bearer tokens', async () => {
  const f = fixture();
  try {
    const wallet = new Wallet(h(100));
    const challenge = f.store.walletTestChallenge(wallet.address, 1000);
    assert.match(challenge.message, /URI: https:\/\/www\.ikol\.top/);
    assert.match(challenge.message, /Chain ID: 46630/);
    assert.match(challenge.message, /does not verify an email/);
    const result = f.store.openWalletTestSession(
      challenge.nonce,
      await wallet.signMessage(challenge.message),
      1001,
    );
    assert.equal(result.account.identityKind, 'WALLET_TEST');
    assert.equal(result.account.email, null);
    assert.equal(result.account.wallet, wallet.address.toLowerCase());
    assert.equal(result.expiresAt, 4601);
    const row = f.store.db.prepare('SELECT * FROM market_accounts').get()!;
    assert.equal(row.subject, null);
    assert.equal(row.verified_at, null);
    const session = f.store.db.prepare('SELECT * FROM market_wallet_test_sessions').get()!;
    assert.equal(session.token_hash, createHash('sha256').update(result.token).digest('hex'));
    assert.ok(!Object.values(session).includes(result.token));
    assert.equal(session.identity_kind, 'WALLET_TEST');
    assert.throws(
      () => f.store.bindingChallenge(result.account.id, wallet.address, 1002),
      /VERIFIED_EMAIL_REQUIRED/,
    );
  } finally {
    f.close();
  }
});

test('wallet challenge rejects wrong signer, domain, chain, premature use, expiry and replay', async () => {
  const f = fixture();
  try {
    const wallet = new Wallet(h(101)),
      wrong = new Wallet(h(102));
    for (const signedMessage of [
      (message: string) => message.replace(origin, 'https://elsewhere.example.test'),
      (message: string) => message.replace('Chain ID: 46630', 'Chain ID: 1'),
    ]) {
      const challenge = f.store.walletTestChallenge(wallet.address, 1000);
      const signature = await wallet.signMessage(signedMessage(challenge.message));
      assert.throws(
        () => f.store.openWalletTestSession(challenge.nonce, signature, 1000),
        /WALLET_SIGNATURE_REJECTED/,
      );
      assert.throws(
        () => f.store.openWalletTestSession(challenge.nonce, signature, 1000),
        /WALLET_CHALLENGE_EXPIRED/,
      );
    }
    const challenge = f.store.walletTestChallenge(wallet.address, 1000);
    const signature = await wallet.signMessage(challenge.message);
    assert.throws(
      () => f.store.openWalletTestSession(challenge.nonce, signature, 999),
      /WALLET_CHALLENGE_EXPIRED/,
    );
    assert.throws(
      () => f.store.openWalletTestSession(challenge.nonce, signature, 1300),
      /WALLET_CHALLENGE_EXPIRED/,
    );
    const wrongSignature = await wrong.signMessage(challenge.message);
    assert.throws(
      () => f.store.openWalletTestSession(challenge.nonce, wrongSignature, 1000),
      /WALLET_SIGNATURE_REJECTED/,
    );
    const valid = f.store.walletTestChallenge(wallet.address, 1001);
    const validSignature = await wallet.signMessage(valid.message);
    f.store.openWalletTestSession(valid.nonce, validSignature, 1001);
    assert.throws(
      () => f.store.openWalletTestSession(valid.nonce, validSignature, 1001),
      /WALLET_CHALLENGE_EXPIRED/,
    );
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM market_accounts').get()!.n, 1);
  } finally {
    f.close();
  }
});

test('wallet sessions enforce CSRF and time boundaries and retain independent devices across restart', async () => {
  const f = fixture();
  try {
    const wallet = new Wallet(h(103));
    const session = await signIn(f.store, wallet);
    assert.equal(f.store.walletTestSession(session.token, null, 999, false), null);
    assert.equal(f.store.walletTestSession(session.token, null, 1000, true), null);
    assert.equal(f.store.walletTestSession(session.token, 'x'.repeat(43), 1000, true), null);
    assert.equal(f.store.walletTestSession(session.token, 'é'.repeat(43), 1000, true), null);
    assert.equal(f.store.walletTestSession(session.token, null, 4600, false), null);
    assert.equal(f.store.walletTestSession('x'.repeat(43), null, 1000, false), null);
    assert.equal(f.store.walletTestSession(session.token, null, 1000, false)!.csrfToken, session.csrfToken);
    f.store.close();
    const reopened = new LaunchMarketStore(f.path, origin);
    try {
      assert.equal(
        reopened.walletTestSession(session.token, session.csrfToken, 1001, true)!.account.id,
        session.account.id,
      );
      const newSession = await signIn(reopened, wallet, 1002);
      assert.equal(newSession.account.id, session.account.id);
      assert.equal(newSession.account.accountKey, session.account.accountKey);
      assert.equal(
        reopened.walletTestSession(session.token, session.csrfToken, 1003, true)?.account.id,
        session.account.id,
      );
      assert.equal(reopened.walletTestSession(newSession.token, session.csrfToken, 1003, true), null);
      assert.notEqual(newSession.token, session.token);
      assert.equal(reopened.db.prepare('SELECT count(*) n FROM market_wallet_test_sessions').get()!.n, 2);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});

test('independent devices retain individual CSRF and support local or all-device revocation', async () => {
  const f = fixture();
  try {
    const wallet = new Wallet(h(120)),
      stranger = new Wallet(h(121));
    const sessions: Awaited<ReturnType<typeof signIn>>[] = [];
    for (let n = 0; n < 6; n++) sessions.push(await signIn(f.store, wallet, 1000 + n));
    assert.equal(f.store.walletTestSession(sessions[0]!.token, null, 1010, false), null);
    for (const session of sessions.slice(1))
      assert.equal(
        f.store.walletTestSession(session.token, session.csrfToken, 1010, true)?.account.id,
        session.account.id,
      );
    const unrelated = await signIn(f.store, stranger, 1006);
    assert.throws(
      () => f.store.revokeWalletTestSession(sessions[1]!.token, unrelated.csrfToken, 1010),
      /MARKET_SESSION_REQUIRED/,
    );
    f.store.revokeWalletTestSession(sessions[1]!.token, sessions[1]!.csrfToken, 1010);
    assert.equal(f.store.walletTestSession(sessions[1]!.token, null, 1010, false), null);
    assert.ok(f.store.walletTestSession(sessions[2]!.token, null, 1010, false));
    f.store.revokeWalletTestSession(sessions[2]!.token, sessions[2]!.csrfToken, 1010, true);
    for (const session of sessions)
      assert.equal(f.store.walletTestSession(session.token, null, 1010, false), null);
    assert.ok(f.store.walletTestSession(unrelated.token, null, 1010, false));
  } finally {
    f.close();
  }
});

test('schema two migration retains live bearer and all financial histories without creating a new identity', async () => {
  const f = fixture();
  try {
    const wallet = new Wallet(h(122));
    const original = await signIn(f.store, wallet);
    const voucher = completeClaim(f.store, original.account.id, wallet.address);
    f.store.db
      .prepare('INSERT INTO market_quotes VALUES(?,?,?,?,?)')
      .run('migration-quote', original.account.id, wallet.address.toLowerCase(), '{}', 1060);
    f.store.db
      .prepare('INSERT INTO market_operations VALUES(?,?,?,?,?)')
      .run('migration-operation', 'migration-quote', wallet.address.toLowerCase(), h(201), '{}');
    f.store.db.exec(`DROP INDEX wallet_sessions_by_account;
ALTER TABLE market_wallet_test_sessions RENAME TO temporary_sessions;
CREATE TABLE market_wallet_test_sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL UNIQUE REFERENCES market_accounts(id),wallet TEXT NOT NULL,csrf_token TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,identity_kind TEXT NOT NULL CHECK(identity_kind='WALLET_TEST')) STRICT;
INSERT INTO market_wallet_test_sessions SELECT * FROM temporary_sessions;
DROP TABLE temporary_sessions; PRAGMA user_version=2;`);
    const before = f.store.fingerprint();
    f.store.close();
    const next = new LaunchMarketStore(f.path, origin);
    try {
      assert.equal(next.db.prepare('PRAGMA user_version').get()!.user_version, 3);
      assert.equal(next.fingerprint(), before);
      assert.equal(
        next.walletTestSession(original.token, original.csrfToken, 1002, true)?.account.id,
        original.account.id,
      );
      const second = await signIn(next, wallet, 1003);
      assert.equal(second.account.accountKey, original.account.accountKey);
      assert.ok(next.walletTestSession(original.token, original.csrfToken, 1003, true));
      assert.equal(next.voucher(second.account.id)!.nonce, voucher.nonce);
      assert.equal(next.db.prepare('SELECT count(*) n FROM market_operations').get()!.n, 1);
      assert.equal(next.db.prepare('PRAGMA foreign_key_check').get(), undefined);
      assert.throws(
        () => next.reserveClaim(second.account.id, wallet.address, 1003, 1063, 1),
        /ALREADY_CLAIMED/,
      );
    } finally {
      next.close();
    }
  } finally {
    f.close();
  }
});

test('test accounts share the existing durable claim registry and cannot claim again after a new login', async () => {
  const f = fixture();
  try {
    const wallet = new Wallet(h(104));
    const first = await signIn(f.store, wallet);
    const voucher = completeClaim(f.store, first.account.id, wallet.address);
    const second = await signIn(f.store, wallet, 1002);
    assert.equal(second.account.id, first.account.id);
    assert.equal(f.store.voucher(second.account.id)!.nonce, voucher.nonce);
    assert.throws(
      () => f.store.reserveClaim(second.account.id, wallet.address, 1002, 1062, 1),
      /ALREADY_CLAIMED/,
    );
    assert.throws(
      () =>
        f.store.trustedAccount(
          { ...identity(1), emailVerified: false } as unknown as TrustedEmailIdentity,
          1002,
        ),
      /VERIFIED_EMAIL_REQUIRED/,
    );
    assert.equal(f.store.trustedAccount(identity(1), 1002).identityKind, 'GOOGLE');
  } finally {
    f.close();
  }
});

test('wallet session capacity rejects new accounts atomically and frees expired sessions', async () => {
  const f = fixture();
  try {
    f.store.atomic(() => {
      const account = f.store.db.prepare(
        "INSERT INTO market_accounts VALUES(?,?,NULL,NULL,NULL,?,1000,'WALLET_TEST')",
      );
      const session = f.store.db.prepare(
        "INSERT INTO market_wallet_test_sessions VALUES(?,?,?,?,1000,4600,'WALLET_TEST')",
      );
      for (let n = 0; n < 10_000; n++) {
        const wallet = '0x' + (n + 1000).toString(16).padStart(40, '0');
        account.run('capacity-' + n, h(n + 1000), wallet);
        session.run(h(n + 1000).slice(2), 'capacity-' + n, wallet, 'x'.repeat(43));
      }
    });
    const wallet = new Wallet(h(118));
    await assert.rejects(() => signIn(f.store, wallet, 1001), /WALLET_SESSION_LIMIT/);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM market_accounts').get()!.n, 10_000);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM market_wallet_test_sessions').get()!.n, 10_000);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM market_wallet_test_identities').get()!.n, 0);
    const result = await signIn(f.store, wallet, 4600);
    assert.equal(result.account.wallet, wallet.address.toLowerCase());
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM market_wallet_test_sessions').get()!.n, 1);
  } finally {
    f.close();
  }
});

test('test and Google accounts count against the same 100 claim slots', async () => {
  const f = fixture();
  try {
    // Existing Google reservations represent 99 prior authenticated users.
    for (let n = 0; n < 99; n++) {
      const account = f.store.trustedAccount(identity(n), 1000);
      const wallet = '0x' + (n + 1000).toString(16).padStart(40, '0');
      f.store.db.prepare('UPDATE market_accounts SET wallet=? WHERE id=?').run(wallet, account.id);
      f.store.reserveClaim(account.id, wallet, 1000, 1060, 0);
    }
    const lastWallet = new Wallet(h(105)),
      extraWallet = new Wallet(h(106));
    const last = await signIn(f.store, lastWallet);
    f.store.reserveClaim(last.account.id, lastWallet.address, 1000, 1060, 0);
    const extra = await signIn(f.store, extraWallet);
    assert.throws(
      () => f.store.reserveClaim(extra.account.id, extraWallet.address, 1000, 1060, 0),
      /CLAIM_LIMIT_REACHED/,
    );
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM market_claim_vouchers').get()!.n, 100);
  } finally {
    f.close();
  }
});

test('a proven Google account adopts the original test key, completed claim and operation records', async () => {
  const f = fixture();
  try {
    const wallet = new Wallet(h(107));
    const testSession = await signIn(f.store, wallet);
    const voucher = completeClaim(f.store, testSession.account.id, wallet.address);
    f.store.db
      .prepare('INSERT INTO market_quotes VALUES(?,?,?,?,?)')
      .run('test-quote', testSession.account.id, wallet.address.toLowerCase(), '{}', 1060);
    f.store.db
      .prepare('INSERT INTO market_operations VALUES(?,?,?,?,?)')
      .run('test-operation', 'test-quote', wallet.address.toLowerCase(), h(20), '{}');
    const google = f.store.trustedAccount(identity(2), 1001);
    const challenge = f.store.bindingChallenge(google.id, wallet.address, 1001);
    const adopted = f.store.bindWallet(
      google.id,
      challenge.nonce,
      await wallet.signMessage(challenge.message),
      1001,
    );
    assert.equal(adopted.id, testSession.account.id);
    assert.equal(adopted.accountKey, testSession.account.accountKey);
    assert.equal(adopted.email, identity(2).email);
    assert.equal(adopted.identityKind, 'GOOGLE');
    assert.equal(f.store.trustedAccount(identity(2), 1002).id, adopted.id);
    assert.throws(() => f.store.account(google.id), /ACCOUNT_REQUIRED/);
    assert.equal(f.store.voucher(adopted.id)!.nonce, voucher.nonce);
    assert.equal(f.store.db.prepare('SELECT account_id FROM market_quotes').get()!.account_id, adopted.id);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM market_operations').get()!.n, 1);
    assert.equal(
      f.store.db.prepare('SELECT identity_kind FROM market_wallet_test_sessions').get()!.identity_kind,
      'WALLET_TEST',
    );
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').get(), undefined);
    assert.throws(() => f.store.reserveClaim(adopted.id, wallet.address, 1002, 1062, 1), /ALREADY_CLAIMED/);
    const otherWallet = new Wallet(h(108));
    const rebind = f.store.bindingChallenge(adopted.id, otherWallet.address, 1003);
    f.store.bindWallet(adopted.id, rebind.nonce, await otherWallet.signMessage(rebind.message), 1003);
    assert.equal(f.store.walletTestSession(testSession.token, testSession.csrfToken, 1004, true), null);
    await assert.rejects(() => signIn(f.store, wallet, 1004), /LINKED_WALLET_REQUIRED/);
    const next = await signIn(f.store, otherWallet, 1005);
    assert.equal(next.account.id, adopted.id);
    assert.throws(
      () => f.store.reserveClaim(adopted.id, otherWallet.address, 1005, 1065, 1),
      /CLAIM_BOUND_TO_ORIGINAL_WALLET/,
    );
  } finally {
    f.close();
  }
});

test('adoption refuses to discard a bound Google account or an account with financial history', async () => {
  const f = fixture();
  try {
    const wallet = new Wallet(h(109));
    const original = await signIn(f.store, wallet);
    for (const withWallet of [false, true]) {
      const google = f.store.trustedAccount(identity(withWallet ? 4 : 3), 1001);
      if (withWallet)
        f.store.db
          .prepare('UPDATE market_accounts SET wallet=? WHERE id=?')
          .run(new Wallet(h(110)).address.toLowerCase(), google.id);
      else
        f.store.db
          .prepare('INSERT INTO market_quotes VALUES(?,?,?,?,?)')
          .run('google-history', google.id, wallet.address.toLowerCase(), '{}', 1060);
      const challenge = f.store.bindingChallenge(google.id, wallet.address, 1001);
      const signature = await wallet.signMessage(challenge.message);
      assert.throws(
        () => f.store.bindWallet(google.id, challenge.nonce, signature, 1001),
        /WALLET_ALREADY_BOUND/,
      );
      assert.equal(f.store.account(google.id).identityKind, 'GOOGLE');
      assert.equal(f.store.account(original.account.id).identityKind, 'WALLET_TEST');
    }
  } finally {
    f.close();
  }
});

test('a Google wallet change cannot give the claimed wallet a new eligibility key', async () => {
  const f = fixture();
  try {
    const wallet = new Wallet(h(113)),
      replacement = new Wallet(h(114));
    const session = await signIn(f.store, wallet);
    completeClaim(f.store, session.account.id, wallet.address);
    const google = f.store.trustedAccount(identity(6), 1001);
    const adopt = f.store.bindingChallenge(google.id, wallet.address, 1001);
    const adopted = f.store.bindWallet(google.id, adopt.nonce, await wallet.signMessage(adopt.message), 1001);
    const change = f.store.bindingChallenge(adopted.id, replacement.address, 1002);
    f.store.bindWallet(adopted.id, change.nonce, await replacement.signMessage(change.message), 1002);
    const another = f.store.trustedAccount(identity(7), 1003);
    const binding = f.store.bindingChallenge(another.id, wallet.address, 1003);
    f.store.bindWallet(another.id, binding.nonce, await wallet.signMessage(binding.message), 1003);
    assert.equal(f.store.claimStatus(another.id), 'COMPLETED');
    assert.throws(() => f.store.reserveClaim(another.id, wallet.address, 1004, 1064, 1), /ALREADY_CLAIMED/);
    await assert.rejects(() => signIn(f.store, wallet, 1004), /LINKED_WALLET_REQUIRED/);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM market_claim_vouchers').get()!.n, 1);
    assert.equal(f.store.voucher(adopted.id)!.accountKey, session.account.accountKey);
  } finally {
    f.close();
  }
});

test('wallet-wide pending eligibility takes precedence over a different wallet expired voucher', async () => {
  const f = fixture();
  try {
    const wallet = new Wallet(h(115)),
      oldWallet = new Wallet(h(116)),
      replacement = new Wallet(h(117));
    const first = f.store.trustedAccount(identity(8), 1000);
    const second = f.store.trustedAccount(identity(9), 1000);
    for (const [account, selectedWallet] of [
      [first, wallet],
      [second, oldWallet],
    ] as const) {
      const challenge = f.store.bindingChallenge(account.id, selectedWallet.address, 1000);
      f.store.bindWallet(
        account.id,
        challenge.nonce,
        await selectedWallet.signMessage(challenge.message),
        1000,
      );
      f.store.reserveClaim(account.id, selectedWallet.address, 1000, 1060, 0);
    }
    f.store.db.prepare("UPDATE market_claim_vouchers SET status='EXPIRED' WHERE account_id=?").run(second.id);
    const firstChange = f.store.bindingChallenge(first.id, replacement.address, 1001);
    f.store.bindWallet(first.id, firstChange.nonce, await replacement.signMessage(firstChange.message), 1001);
    const secondChange = f.store.bindingChallenge(second.id, wallet.address, 1002);
    f.store.bindWallet(second.id, secondChange.nonce, await wallet.signMessage(secondChange.message), 1002);
    assert.equal(f.store.claimStatus(second.id), 'ISSUED');
    assert.throws(
      () => f.store.reserveClaim(second.id, wallet.address, 1003, 1063, 0),
      /CLAIM_RECOVERY_REQUIRED/,
    );
    assert.equal(f.store.voucher(second.id)!.status, 'EXPIRED');
    assert.equal(f.store.voucher(first.id)!.status, 'ISSUED');
  } finally {
    f.close();
  }
});

// Schema 1 is deliberately fixed here: qualification must exercise the deployed
// NOT NULL schema, not create old data using the implementation under test.
const schema1 = `
CREATE TABLE market_identity(id INTEGER PRIMARY KEY CHECK(id=1),chain_id INTEGER NOT NULL,origin TEXT NOT NULL) STRICT;
CREATE TABLE market_accounts(id TEXT PRIMARY KEY,account_key TEXT NOT NULL UNIQUE,email TEXT NOT NULL UNIQUE,subject TEXT NOT NULL UNIQUE,verified_at INTEGER NOT NULL,wallet TEXT UNIQUE,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE market_wallet_challenges(nonce TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES market_accounts(id),wallet TEXT NOT NULL,message TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed INTEGER NOT NULL CHECK(consumed IN(0,1))) STRICT;
CREATE TABLE market_claim_vouchers(account_id TEXT PRIMARY KEY REFERENCES market_accounts(id),account_key TEXT NOT NULL UNIQUE,wallet TEXT NOT NULL,nonce TEXT NOT NULL UNIQUE,issued_at INTEGER NOT NULL,deadline INTEGER NOT NULL,status TEXT NOT NULL,transaction_hash TEXT UNIQUE) STRICT;
CREATE TABLE market_quotes(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES market_accounts(id),owner TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE market_operations(id TEXT PRIMARY KEY,quote_id TEXT NOT NULL UNIQUE REFERENCES market_quotes(id),owner TEXT NOT NULL,transaction_hash TEXT NOT NULL UNIQUE,payload TEXT NOT NULL) STRICT;
CREATE TABLE market_claim_events(chain_id INTEGER NOT NULL,transaction_hash TEXT NOT NULL,log_index INTEGER NOT NULL,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,account_key TEXT NOT NULL,wallet TEXT NOT NULL,canonical INTEGER NOT NULL CHECK(canonical IN(0,1)),PRIMARY KEY(chain_id,transaction_hash,log_index,block_hash)) STRICT;
CREATE UNIQUE INDEX one_canonical_account_claim ON market_claim_events(chain_id,account_key) WHERE canonical=1;
CREATE TABLE market_snapshots(chain_id INTEGER NOT NULL,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,parent_hash TEXT NOT NULL,version INTEGER NOT NULL UNIQUE,payload TEXT NOT NULL,canonical INTEGER NOT NULL CHECK(canonical IN(0,1)),PRIMARY KEY(chain_id,block_number,block_hash)) STRICT;
CREATE UNIQUE INDEX one_canonical_market_height ON market_snapshots(chain_id,block_number) WHERE canonical=1;
CREATE TABLE market_projection_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL) STRICT;
PRAGMA user_version=1;`;
function version1(path: string) {
  const db = new DatabaseSync(path);
  db.exec(schema1);
  db.prepare('INSERT INTO market_identity VALUES(1,46630,?)').run(origin);
  const wallet = new Wallet(h(111)).address.toLowerCase();
  db.prepare('INSERT INTO market_accounts VALUES(?,?,?,?,?,?,?)').run(
    'retained-account',
    h(31),
    identity(5).email,
    identity(5).subject,
    990,
    wallet,
    980,
  );
  db.prepare('INSERT INTO market_wallet_challenges VALUES(?,?,?,?,?,?)').run(
    'retained-challenge',
    'retained-account',
    wallet,
    'retained-message',
    1060,
    1,
  );
  db.prepare('INSERT INTO market_claim_vouchers VALUES(?,?,?,?,?,?,?,?)').run(
    'retained-account',
    h(31),
    wallet,
    '123456',
    1000,
    1060,
    'COMPLETED',
    h(32),
  );
  db.prepare('INSERT INTO market_quotes VALUES(?,?,?,?,?)').run(
    'retained-quote',
    'retained-account',
    wallet,
    '{"retained":"quote"}',
    1060,
  );
  db.prepare('INSERT INTO market_operations VALUES(?,?,?,?,?)').run(
    'retained-operation',
    'retained-quote',
    wallet,
    h(33),
    '{"retained":"operation"}',
  );
  db.prepare('INSERT INTO market_claim_events VALUES(?,?,?,?,?,?,?,?)').run(
    46630,
    h(32),
    0,
    10,
    h(10),
    h(31),
    wallet,
    1,
  );
  db.prepare('INSERT INTO market_snapshots VALUES(?,?,?,?,?,?,?)').run(
    46630,
    10,
    h(10),
    h(9),
    17,
    '{"retained":"snapshot"}',
    1,
  );
  db.prepare('INSERT INTO market_projection_version VALUES(1,17)').run();
  return db;
}
function schema(db: DatabaseSync) {
  return db
    .prepare(
      'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type COLLATE BINARY,name COLLATE BINARY',
    )
    .all();
}

test('schema 1 migration preserves every account, claim, quote, operation, event, snapshot and foreign key', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'af-wallet-test-migration-'));
  const path = join(folder, 'market.sqlite');
  const legacy = version1(path);
  const tables = legacy
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all()
    .map((row) => String(row.name));
  const before = new Map(
    tables.map((table) => [table, legacy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
  legacy.close();
  const store = new LaunchMarketStore(path, origin);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 3);
    assert.equal(store.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').get(), undefined);
    for (const table of tables) {
      const after = store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      if (table === 'market_accounts') {
        assert.equal(after[0]!.identity_kind, 'GOOGLE');
        const oldColumns = { ...after[0]! };
        delete oldColumns.identity_kind;
        assert.deepEqual(oldColumns, { ...before.get(table)![0] });
      } else assert.deepEqual(after, before.get(table), table);
    }
    assert.equal(store.trustedAccount(identity(5), 1001).id, 'retained-account');
    assert.throws(
      () => store.reserveClaim('retained-account', new Wallet(h(111)).address, 1001, 1061, 1),
      /ALREADY_CLAIMED/,
    );
    const fresh = new LaunchMarketStore(':memory:', origin);
    try {
      assert.deepEqual(schema(store.db), schema(fresh.db));
    } finally {
      fresh.close();
    }
    const signedIn = await signIn(store, new Wallet(h(112)), 1001);
    assert.equal(signedIn.account.email, null);
    store.close();
    const reopened = new LaunchMarketStore(path, origin);
    try {
      assert.equal(
        reopened.walletTestSession(signedIn.token, signedIn.csrfToken, 1002, true)!.account.id,
        signedIn.account.id,
      );
      assert.equal(reopened.voucher('retained-account')!.nonce, '123456');
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('wrong-origin admission and failed foreign-key migration preserve the original schema and records', () => {
  const folder = mkdtempSync(join(tmpdir(), 'af-wallet-test-migration-failure-'));
  const path = join(folder, 'market.sqlite');
  const legacy = version1(path);
  const before = schema(legacy);
  legacy.close();
  try {
    assert.throws(
      () => new LaunchMarketStore(path, 'https://elsewhere.example.test'),
      /DATABASE_IDENTITY_MISMATCH/,
    );
    const corrupt = new DatabaseSync(path);
    assert.deepEqual(schema(corrupt), before);
    corrupt.exec('PRAGMA foreign_keys=OFF;');
    corrupt.prepare('UPDATE market_quotes SET account_id=?').run('missing-account');
    corrupt.close();
    assert.throws(() => new LaunchMarketStore(path, origin), /DATABASE_FOREIGN_KEY_CORRUPT/);
    const unchanged = new DatabaseSync(path);
    try {
      assert.deepEqual(schema(unchanged), before);
      assert.equal(unchanged.prepare('PRAGMA user_version').get()!.user_version, 1);
      assert.equal(unchanged.prepare('SELECT account_key FROM market_accounts').get()!.account_key, h(31));
      assert.equal(
        unchanged.prepare('SELECT account_id FROM market_quotes').get()!.account_id,
        'missing-account',
      );
    } finally {
      unchanged.close();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
