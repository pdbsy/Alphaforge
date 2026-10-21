import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getAddress, id, verifyMessage } from 'ethers';
import { address, hash, LAUNCH_CHAIN_ID } from './config.ts';
import {
  LaunchMarketError,
  type MarketAccount,
  type MarketQuote,
  type MarketTrackedOperation,
  type TrustedEmailIdentity,
  type ChainLocation,
} from './types.ts';

export interface ClaimVoucherRecord {
  readonly accountId: string;
  readonly accountKey: string;
  readonly wallet: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly deadline: number;
  readonly status: 'ISSUED' | 'SUBMITTED' | 'INCLUDED' | 'COMPLETED' | 'REORGED' | 'REVERTED' | 'EXPIRED';
  readonly transactionHash: string | null;
}
export interface WalletBindingChallenge {
  readonly nonce: string;
  readonly message: string;
  readonly expiresAt: number;
}
export interface WalletTestSession {
  readonly account: MarketAccount;
  readonly csrfToken: string;
  readonly expiresAt: number;
}
export interface OpenedWalletTestSession extends WalletTestSession {
  readonly token: string;
}
export function normalizeEmail(value: string): string {
  if (typeof value !== 'string') throw new LaunchMarketError('INVALID_EMAIL', 400);
  const pieces = value.trim().split('@');
  const email = pieces.length === 2 ? pieces[0] + '@' + pieces[1]!.toLowerCase() : value.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new LaunchMarketError('INVALID_EMAIL', 400);
  return email;
}
function seconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new LaunchMarketError('INVALID_TIME', 400);
}
const accountColumns = `id TEXT PRIMARY KEY,account_key TEXT NOT NULL UNIQUE,email TEXT UNIQUE,subject TEXT UNIQUE,verified_at INTEGER,wallet TEXT UNIQUE,created_at INTEGER NOT NULL,identity_kind TEXT NOT NULL CHECK(identity_kind IN('GOOGLE','WALLET_TEST')),CHECK((identity_kind='GOOGLE' AND email IS NOT NULL AND subject IS NOT NULL AND verified_at IS NOT NULL) OR (identity_kind='WALLET_TEST' AND email IS NULL AND subject IS NULL AND verified_at IS NULL AND wallet IS NOT NULL))`;
const walletTestDdl = `
CREATE TABLE market_wallet_test_identities(wallet TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES market_accounts(id),created_at INTEGER NOT NULL) STRICT;
CREATE TABLE market_wallet_test_challenges(nonce TEXT PRIMARY KEY,wallet TEXT NOT NULL,message TEXT NOT NULL,issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,consumed INTEGER NOT NULL CHECK(consumed IN(0,1))) STRICT;
CREATE TABLE "market_wallet_test_sessions"(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES market_accounts(id),wallet TEXT NOT NULL,csrf_token TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,identity_kind TEXT NOT NULL CHECK(identity_kind='WALLET_TEST')) STRICT;
CREATE INDEX wallet_sessions_by_account ON market_wallet_test_sessions(account_id,created_at,token_hash);`;
const ddl = `
CREATE TABLE market_identity(id INTEGER PRIMARY KEY CHECK(id=1),chain_id INTEGER NOT NULL,origin TEXT NOT NULL) STRICT;
CREATE TABLE "market_accounts"(${accountColumns}) STRICT;
CREATE TABLE market_wallet_challenges(nonce TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES market_accounts(id),wallet TEXT NOT NULL,message TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed INTEGER NOT NULL CHECK(consumed IN(0,1))) STRICT;
CREATE TABLE market_claim_vouchers(account_id TEXT PRIMARY KEY REFERENCES market_accounts(id),account_key TEXT NOT NULL UNIQUE,wallet TEXT NOT NULL,nonce TEXT NOT NULL UNIQUE,issued_at INTEGER NOT NULL,deadline INTEGER NOT NULL,status TEXT NOT NULL,transaction_hash TEXT UNIQUE) STRICT;
CREATE TABLE market_quotes(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES market_accounts(id),owner TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE market_operations(id TEXT PRIMARY KEY,quote_id TEXT NOT NULL UNIQUE REFERENCES market_quotes(id),owner TEXT NOT NULL,transaction_hash TEXT NOT NULL UNIQUE,payload TEXT NOT NULL) STRICT;
CREATE TABLE market_claim_events(chain_id INTEGER NOT NULL,transaction_hash TEXT NOT NULL,log_index INTEGER NOT NULL,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,account_key TEXT NOT NULL,wallet TEXT NOT NULL,canonical INTEGER NOT NULL CHECK(canonical IN(0,1)),PRIMARY KEY(chain_id,transaction_hash,log_index,block_hash)) STRICT;
CREATE UNIQUE INDEX one_canonical_account_claim ON market_claim_events(chain_id,account_key) WHERE canonical=1;
CREATE TABLE market_snapshots(chain_id INTEGER NOT NULL,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,parent_hash TEXT NOT NULL,version INTEGER NOT NULL UNIQUE,payload TEXT NOT NULL,canonical INTEGER NOT NULL CHECK(canonical IN(0,1)),PRIMARY KEY(chain_id,block_number,block_hash)) STRICT;
CREATE UNIQUE INDEX one_canonical_market_height ON market_snapshots(chain_id,block_number) WHERE canonical=1;
CREATE TABLE market_projection_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL) STRICT;
INSERT INTO market_projection_version VALUES(1,0);
${walletTestDdl}
PRAGMA user_version=3;`;

/** This DB stores identity and chain projections. Token balances are always obtained from RPC. */
export class LaunchMarketStore {
  readonly db: DatabaseSync;
  readonly origin: string;
  readonly chainId: number;
  constructor(path: string, origin: string, chainId = LAUNCH_CHAIN_ID) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) ||
      chainId !== LAUNCH_CHAIN_ID
    )
      throw new LaunchMarketError('INVALID_STORE_IDENTITY', 400);
    this.origin = origin;
    this.chainId = chainId;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version === 0) {
        if (
          this.db
            .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .get()
        )
          throw new LaunchMarketError('UNKNOWN_DATABASE');
        this.atomic(() => {
          this.db.exec(ddl);
          this.db.prepare('INSERT INTO market_identity VALUES(1,?,?)').run(chainId, origin);
        });
      } else if (version !== 1 && version !== 2 && version !== 3)
        throw new LaunchMarketError('UNSUPPORTED_DATABASE_SCHEMA');
      const identity = this.db.prepare('SELECT chain_id,origin FROM market_identity WHERE id=1').get();
      if (identity?.chain_id !== chainId || identity.origin !== origin)
        throw new LaunchMarketError('DATABASE_IDENTITY_MISMATCH');
      if (version === 1) this.migrateWalletTestAccounts();
      if (version === 2) this.migrateMultipleWalletSessions();
      if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        throw new LaunchMarketError('DATABASE_CORRUPT');
      if (this.db.prepare('PRAGMA foreign_key_check').get())
        throw new LaunchMarketError('DATABASE_FOREIGN_KEY_CORRUPT');
      this.db.exec('PRAGMA journal_mode=WAL');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private migrateWalletTestAccounts(): void {
    // SQLite's generalized ALTER TABLE procedure: disable FK enforcement outside
    // the transaction, copy to a new table, then drop/rename and check before commit.
    // https://www.sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes
    const attachments = this.db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE tbl_name='market_accounts' AND type IN('index','trigger') AND sql IS NOT NULL",
      )
      .all();
    this.db.exec('PRAGMA foreign_keys=OFF;');
    try {
      this.atomic(() => {
        this.db.exec(`CREATE TABLE market_accounts_v2(${accountColumns}) STRICT;
INSERT INTO market_accounts_v2 SELECT id,account_key,email,subject,verified_at,wallet,created_at,'GOOGLE' FROM market_accounts;
DROP TABLE market_accounts;
ALTER TABLE market_accounts_v2 RENAME TO market_accounts;`);
        for (const attachment of attachments) this.db.exec(String(attachment.sql));
        this.db.exec(walletTestDdl);
        if (this.db.prepare('PRAGMA foreign_key_check').get())
          throw new LaunchMarketError('DATABASE_FOREIGN_KEY_CORRUPT');
        this.db.exec('PRAGMA user_version=3;');
      });
    } finally {
      this.db.exec('PRAGMA foreign_keys=ON;');
    }
  }
  private migrateMultipleWalletSessions(): void {
    this.atomic(() => {
      // Only the bearer-session table changes. Existing identities, claim keys,
      // vouchers, quotes, operations and financial projections are preserved.
      this.db
        .exec(`CREATE TABLE market_wallet_sessions_v3(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES market_accounts(id),wallet TEXT NOT NULL,csrf_token TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,identity_kind TEXT NOT NULL CHECK(identity_kind='WALLET_TEST')) STRICT;
INSERT INTO market_wallet_sessions_v3 SELECT token_hash,account_id,wallet,csrf_token,created_at,expires_at,identity_kind FROM market_wallet_test_sessions;
DROP TABLE market_wallet_test_sessions;
ALTER TABLE market_wallet_sessions_v3 RENAME TO market_wallet_test_sessions;
CREATE INDEX wallet_sessions_by_account ON market_wallet_test_sessions(account_id,created_at,token_hash);`);
      if (this.db.prepare('PRAGMA foreign_key_check').get())
        throw new LaunchMarketError('DATABASE_FOREIGN_KEY_CORRUPT');
      this.db.exec('PRAGMA user_version=3;');
    });
  }
  atomic<T>(work: () => T): T {
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
  close(): void {
    if (this.db.isOpen) this.db.close();
  }
  account(accountId: string): MarketAccount {
    const row = this.db
      .prepare('SELECT id,account_key,email,wallet,identity_kind FROM market_accounts WHERE id=?')
      .get(accountId);
    if (!row) throw new LaunchMarketError('ACCOUNT_REQUIRED', 401);
    return {
      id: String(row.id),
      accountKey: String(row.account_key),
      email: row.email === null ? null : String(row.email),
      identityKind: String(row.identity_kind) as 'GOOGLE' | 'WALLET_TEST',
      wallet: row.wallet === null ? null : String(row.wallet),
    };
  }
  private googleAccount(
    accountId: string,
  ): MarketAccount & { readonly email: string; readonly identityKind: 'GOOGLE' } {
    const account = this.account(accountId);
    if (account.email === null || account.identityKind !== 'GOOGLE')
      throw new LaunchMarketError('VERIFIED_EMAIL_REQUIRED', 401);
    return { ...account, email: account.email, identityKind: 'GOOGLE' };
  }
  trustedAccount(
    identity: TrustedEmailIdentity,
    now: number,
  ): MarketAccount & { readonly email: string; readonly identityKind: 'GOOGLE' } {
    seconds(now);
    if (identity.emailVerified !== true || !identity.subject || identity.subject.length > 200)
      throw new LaunchMarketError('VERIFIED_EMAIL_REQUIRED', 401);
    const email = normalizeEmail(identity.email);
    return this.atomic(() => {
      const existing = this.db.prepare('SELECT id,subject FROM market_accounts WHERE email=?').get(email);
      if (existing) {
        if (existing.subject !== identity.subject) throw new LaunchMarketError('IDENTITY_CHANGED', 401);
        return this.googleAccount(String(existing.id));
      }
      if (this.db.prepare('SELECT id FROM market_accounts WHERE subject=?').get(identity.subject))
        throw new LaunchMarketError('IDENTITY_EMAIL_CHANGED', 401);
      const accountId = randomUUID(),
        accountKey = id('AlphaForge verified account:' + accountId);
      this.db
        .prepare("INSERT INTO market_accounts VALUES(?,?,?,?,?,NULL,?,'GOOGLE')")
        .run(accountId, accountKey, email, identity.subject, now, now);
      return this.googleAccount(accountId);
    });
  }
  bindingChallenge(accountId: string, walletInput: string, now: number): WalletBindingChallenge {
    seconds(now);
    const account = this.account(accountId),
      wallet = address(walletInput),
      nonce = randomBytes(24).toString('hex'),
      expiresAt = now + 300;
    if (account.identityKind !== 'GOOGLE') throw new LaunchMarketError('VERIFIED_EMAIL_REQUIRED', 401);
    const message = `${new URL(this.origin).host} wants you to link your Ethereum account:\n${getAddress(wallet)}\n\nLink this wallet to AlphaForge account ${account.id}. This signature authorizes account linkage only. It does not move assets or authorize transactions.\n\nURI: ${this.origin}\nVersion: 1\nChain ID: ${this.chainId}\nNonce: ${nonce}\nIssued At: ${new Date(now * 1000).toISOString()}\nExpiration Time: ${new Date(expiresAt * 1000).toISOString()}`;
    this.atomic(() => {
      this.db
        .prepare('DELETE FROM market_wallet_challenges WHERE account_id=? OR expires_at<=?')
        .run(accountId, now);
      if (Number(this.db.prepare('SELECT count(*) n FROM market_wallet_challenges').get()!.n) >= 1000)
        throw new LaunchMarketError('CHALLENGE_LIMIT', 429);
      this.db
        .prepare('INSERT INTO market_wallet_challenges VALUES(?,?,?,?,?,0)')
        .run(nonce, accountId, wallet, message, expiresAt);
    });
    return { nonce, message, expiresAt };
  }
  bindWallet(accountId: string, nonce: string, signature: string, now: number): MarketAccount {
    seconds(now);
    if (!/^[a-f0-9]{48}$/.test(nonce) || !/^0x[0-9a-fA-F]{130}$/.test(signature))
      throw new LaunchMarketError('WALLET_SIGNATURE_REQUIRED', 401);
    const row = this.atomic(() => {
      const challenge = this.db
        .prepare(
          'SELECT wallet,message FROM market_wallet_challenges WHERE nonce=? AND account_id=? AND consumed=0 AND expires_at>?',
        )
        .get(nonce, accountId, now);
      if (!challenge) throw new LaunchMarketError('WALLET_CHALLENGE_EXPIRED', 401);
      this.db.prepare('UPDATE market_wallet_challenges SET consumed=1 WHERE nonce=?').run(nonce);
      return challenge;
    });
    let signer: string;
    try {
      signer = address(verifyMessage(String(row.message), signature));
    } catch {
      throw new LaunchMarketError('WALLET_SIGNATURE_REJECTED', 401);
    }
    if (signer !== row.wallet) throw new LaunchMarketError('WALLET_SIGNATURE_REJECTED', 401);
    return this.atomic(() => {
      const other = this.db
        .prepare('SELECT id,identity_kind FROM market_accounts WHERE wallet=? AND id<>?')
        .get(signer, accountId);
      if (other) {
        const current = this.db
          .prepare('SELECT email,subject,verified_at,wallet,identity_kind FROM market_accounts WHERE id=?')
          .get(accountId);
        const hasHistory =
          this.db.prepare('SELECT 1 FROM market_claim_vouchers WHERE account_id=?').get(accountId) ||
          this.db.prepare('SELECT 1 FROM market_quotes WHERE account_id=?').get(accountId) ||
          this.db.prepare('SELECT 1 FROM market_wallet_test_sessions WHERE account_id=?').get(accountId) ||
          this.db.prepare('SELECT 1 FROM market_wallet_test_identities WHERE account_id=?').get(accountId) ||
          this.db
            .prepare(
              'SELECT 1 FROM market_claim_events WHERE account_key=(SELECT account_key FROM market_accounts WHERE id=?)',
            )
            .get(accountId);
        if (
          other.identity_kind !== 'WALLET_TEST' ||
          current?.identity_kind !== 'GOOGLE' ||
          current.wallet !== null ||
          hasHistory
        )
          throw new LaunchMarketError('WALLET_ALREADY_BOUND');
        // Adopt the original account and claim key; only the unused Google shell
        // is removed. Vouchers, operations and original wallet-session provenance stay.
        this.db.prepare('DELETE FROM market_wallet_challenges WHERE account_id=?').run(accountId);
        this.db.prepare('DELETE FROM market_accounts WHERE id=?').run(accountId);
        this.db
          .prepare(
            "UPDATE market_accounts SET email=?,subject=?,verified_at=?,identity_kind='GOOGLE' WHERE id=?",
          )
          .run(String(current.email), String(current.subject), Number(current.verified_at), String(other.id));
        return this.account(String(other.id));
      }
      this.db.prepare('UPDATE market_accounts SET wallet=? WHERE id=?').run(signer, accountId);
      return this.account(accountId);
    });
  }
  /** Available only through server routes whose verified-email policy is explicitly OFF. */
  walletTestChallenge(walletInput: string, now: number): WalletBindingChallenge {
    seconds(now);
    const wallet = address(walletInput),
      nonce = randomBytes(24).toString('hex'),
      expiresAt = now + 300;
    const message = `${new URL(this.origin).host} wants you to sign in with your Ethereum account:\n${getAddress(wallet)}\n\nSign in to AlphaForge wallet-only mode. This proves control of this wallet; it does not verify an email, move assets or approve a transaction. Free credits are limited to one claim for this wallet and 100 claims in total.\n\nURI: ${this.origin}\nVersion: 1\nChain ID: ${this.chainId}\nNonce: ${nonce}\nIssued At: ${new Date(now * 1000).toISOString()}\nExpiration Time: ${new Date(expiresAt * 1000).toISOString()}`;
    this.atomic(() => {
      this.db.prepare('DELETE FROM market_wallet_test_challenges WHERE consumed=1 OR expires_at<=?').run(now);
      if (
        Number(
          this.db.prepare('SELECT count(*) n FROM market_wallet_test_challenges WHERE wallet=?').get(wallet)!
            .n,
        ) >= 5
      )
        throw new LaunchMarketError('CHALLENGE_LIMIT', 429);
      if (Number(this.db.prepare('SELECT count(*) n FROM market_wallet_test_challenges').get()!.n) >= 1000)
        throw new LaunchMarketError('CHALLENGE_LIMIT', 429);
      this.db
        .prepare('INSERT INTO market_wallet_test_challenges VALUES(?,?,?,?,?,0)')
        .run(nonce, wallet, message, now, expiresAt);
    });
    return { nonce, message, expiresAt };
  }
  openWalletTestSession(nonce: string, signature: string, now: number): OpenedWalletTestSession {
    seconds(now);
    if (!/^[a-f0-9]{48}$/.test(nonce) || !/^0x[0-9a-fA-F]{130}$/.test(signature))
      throw new LaunchMarketError('WALLET_SIGNATURE_REQUIRED', 401);
    const challenge = this.atomic(() => {
      const row = this.db
        .prepare(
          'SELECT wallet,message FROM market_wallet_test_challenges WHERE nonce=? AND consumed=0 AND issued_at<=? AND expires_at>?',
        )
        .get(nonce, now, now);
      if (!row) throw new LaunchMarketError('WALLET_CHALLENGE_EXPIRED', 401);
      this.db.prepare('UPDATE market_wallet_test_challenges SET consumed=1 WHERE nonce=?').run(nonce);
      return row;
    });
    let signer: string;
    try {
      signer = address(verifyMessage(String(challenge.message), signature));
    } catch {
      throw new LaunchMarketError('WALLET_SIGNATURE_REJECTED', 401);
    }
    if (signer !== challenge.wallet) throw new LaunchMarketError('WALLET_SIGNATURE_REJECTED', 401);
    return this.atomic(() => {
      let accountId = this.db
        .prepare('SELECT account_id FROM market_wallet_test_identities WHERE wallet=?')
        .get(signer)?.account_id;
      accountId ??= this.db.prepare('SELECT id FROM market_accounts WHERE wallet=?').get(signer)?.id;
      accountId ??= this.db
        .prepare('SELECT account_id FROM market_claim_vouchers WHERE wallet=?')
        .get(signer)?.account_id;
      if (accountId === undefined) {
        accountId = randomUUID();
        this.db
          .prepare("INSERT INTO market_accounts VALUES(?,?,NULL,NULL,NULL,?,?,'WALLET_TEST')")
          .run(String(accountId), id('AlphaForge wallet test account:' + accountId), signer, now);
      }
      if (this.account(String(accountId)).wallet !== signer)
        throw new LaunchMarketError('LINKED_WALLET_REQUIRED', 403);
      this.db
        .prepare('INSERT INTO market_wallet_test_identities VALUES(?,?,?) ON CONFLICT(wallet) DO NOTHING')
        .run(signer, String(accountId), now);
      const token = randomBytes(32).toString('base64url'),
        csrfToken = randomBytes(32).toString('base64url'),
        expiresAt = now + 3600;
      this.db.prepare('DELETE FROM market_wallet_test_sessions WHERE expires_at<=?').run(now);
      // Keep at most five devices. A new proof evicts only the oldest device,
      // and every remaining device retains its independent CSRF token.
      this.db
        .prepare(
          `DELETE FROM market_wallet_test_sessions WHERE token_hash IN(
SELECT token_hash FROM market_wallet_test_sessions WHERE account_id=?
ORDER BY created_at DESC,token_hash DESC LIMIT -1 OFFSET 4)`,
        )
        .run(String(accountId));
      if (Number(this.db.prepare('SELECT count(*) n FROM market_wallet_test_sessions').get()!.n) >= 10_000)
        throw new LaunchMarketError('WALLET_SESSION_LIMIT', 429);
      this.db
        .prepare("INSERT INTO market_wallet_test_sessions VALUES(?,?,?,?,?,?,'WALLET_TEST')")
        .run(
          createHash('sha256').update(token).digest('hex'),
          String(accountId),
          signer,
          csrfToken,
          now,
          expiresAt,
        );
      return { account: this.account(String(accountId)), token, csrfToken, expiresAt };
    });
  }
  walletTestSession(
    token: string,
    csrfToken: string | null | undefined,
    now: number,
    mutation: boolean,
  ): WalletTestSession | null {
    seconds(now);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db
      .prepare(
        'SELECT account_id,wallet,csrf_token,expires_at FROM market_wallet_test_sessions WHERE token_hash=? AND created_at<=? AND expires_at>?',
      )
      .get(createHash('sha256').update(token).digest('hex'), now, now);
    if (!row) return null;
    const expectedCsrf = String(row.csrf_token);
    if (
      mutation &&
      (typeof csrfToken !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(csrfToken) ||
        !timingSafeEqual(Buffer.from(csrfToken), Buffer.from(expectedCsrf)))
    )
      return null;
    const account = this.account(String(row.account_id));
    if (account.wallet !== row.wallet) return null;
    return { account, csrfToken: expectedCsrf, expiresAt: Number(row.expires_at) };
  }
  revokeWalletTestSession(token: string, csrfToken: string, now: number, allDevices = false): void {
    this.atomic(() => {
      const session = this.walletTestSession(token, csrfToken, now, true);
      if (!session) throw new LaunchMarketError('MARKET_SESSION_REQUIRED', 401);
      if (allDevices)
        this.db.prepare('DELETE FROM market_wallet_test_sessions WHERE account_id=?').run(session.account.id);
      else
        this.db
          .prepare('DELETE FROM market_wallet_test_sessions WHERE token_hash=?')
          .run(createHash('sha256').update(token).digest('hex'));
    });
  }
  requireWallet(accountId: string, owner: string): MarketAccount {
    const account = this.account(accountId);
    if (account.wallet !== address(owner)) throw new LaunchMarketError('LINKED_WALLET_REQUIRED', 403);
    return account;
  }
  voucher(accountId: string): ClaimVoucherRecord | null {
    const row = this.db.prepare('SELECT * FROM market_claim_vouchers WHERE account_id=?').get(accountId);
    return row
      ? {
          accountId: String(row.account_id),
          accountKey: String(row.account_key),
          wallet: String(row.wallet),
          nonce: String(row.nonce),
          issuedAt: Number(row.issued_at),
          deadline: Number(row.deadline),
          status: String(row.status) as ClaimVoucherRecord['status'],
          transactionHash: row.transaction_hash === null ? null : String(row.transaction_hash),
        }
      : null;
  }
  claimStatus(accountId: string): ClaimVoucherRecord['status'] | null {
    const account = this.account(accountId),
      own = this.voucher(accountId);
    if (own?.status === 'COMPLETED') return 'COMPLETED';
    if (account.wallet !== null) {
      if (
        this.db
          .prepare('SELECT 1 FROM market_claim_events WHERE chain_id=? AND wallet=? AND canonical=1')
          .get(this.chainId, account.wallet)
      )
        return 'COMPLETED';
      const other = this.db
        .prepare(
          "SELECT status FROM market_claim_vouchers WHERE wallet=? AND account_id<>? ORDER BY CASE WHEN status='COMPLETED' THEN 0 ELSE 1 END LIMIT 1",
        )
        .get(account.wallet, accountId);
      if (other) return String(other.status) as ClaimVoucherRecord['status'];
    }
    return own?.status ?? null;
  }
  reserveClaim(
    accountId: string,
    owner: string,
    now: number,
    deadline: number,
    chainSuccessfulClaims: number,
  ): ClaimVoucherRecord {
    seconds(now);
    seconds(deadline);
    if (
      deadline <= now ||
      deadline - now > 300 ||
      !Number.isInteger(chainSuccessfulClaims) ||
      chainSuccessfulClaims < 0 ||
      chainSuccessfulClaims > 100
    )
      throw new LaunchMarketError('INVALID_CLAIM_POLICY');
    return this.atomic(() => {
      const account = this.requireWallet(accountId, owner);
      // A public opaque claim key cannot reconstruct its private email/subject registry.
      // Refuse new vouchers after registry loss or while canonical events lag the RPC head.
      const observedClaims = Number(
        this.db
          .prepare('SELECT count(*) n FROM market_claim_events WHERE chain_id=? AND canonical=1')
          .get(this.chainId)!.n,
      );
      if (observedClaims !== chainSuccessfulClaims)
        throw new LaunchMarketError('CLAIM_RECONCILIATION_REQUIRED', 503);
      const missingRegistry = this.db
        .prepare(
          `
        SELECT 1 FROM market_claim_events e
        WHERE e.chain_id=? AND e.canonical=1 AND NOT EXISTS (
          SELECT 1 FROM market_accounts a JOIN market_claim_vouchers v ON v.account_id=a.id
          WHERE a.account_key=e.account_key AND v.account_key=e.account_key
            AND v.wallet=e.wallet AND v.transaction_hash=e.transaction_hash
            AND v.status IN('INCLUDED','COMPLETED')
        ) LIMIT 1`,
        )
        .get(this.chainId);
      if (missingRegistry) throw new LaunchMarketError('CLAIM_IDENTITY_RECOVERY_REQUIRED', 503);
      const walletClaim = this.db
        .prepare('SELECT 1 FROM market_claim_events WHERE chain_id=? AND wallet=? AND canonical=1')
        .get(this.chainId, account.wallet);
      if (walletClaim) throw new LaunchMarketError('ALREADY_CLAIMED');
      const otherVoucher = this.db
        .prepare('SELECT status FROM market_claim_vouchers WHERE wallet=? AND account_id<>? LIMIT 1')
        .get(account.wallet, accountId);
      if (otherVoucher)
        throw new LaunchMarketError(
          otherVoucher.status === 'COMPLETED' ? 'ALREADY_CLAIMED' : 'CLAIM_RECOVERY_REQUIRED',
        );
      const existing = this.voucher(accountId);
      const unresolved = Number(
        this.db
          .prepare(
            "SELECT count(*) n FROM market_claim_vouchers WHERE (status='ISSUED' AND deadline>?) OR status IN('SUBMITTED','REORGED','REVERTED','EXPIRED')",
          )
          .get(now)!.n,
      );
      if (existing) {
        if (existing.wallet !== account.wallet) throw new LaunchMarketError('CLAIM_BOUND_TO_ORIGINAL_WALLET');
        if (existing.status === 'COMPLETED') throw new LaunchMarketError('ALREADY_CLAIMED');
        if (
          existing.transactionHash !== null ||
          ['INCLUDED', 'REORGED', 'REVERTED'].includes(existing.status)
        )
          throw new LaunchMarketError('CLAIM_RECOVERY_REQUIRED');
        if (existing.deadline <= now) {
          if (chainSuccessfulClaims + unresolved >= 100) throw new LaunchMarketError('CLAIM_LIMIT_REACHED');
          this.db
            .prepare(
              "UPDATE market_claim_vouchers SET issued_at=?,deadline=?,status='ISSUED' WHERE account_id=?",
            )
            .run(now, deadline, accountId);
          return this.voucher(accountId)!;
        }
        return existing;
      }
      if (
        this.db
          .prepare('SELECT 1 FROM market_claim_events WHERE account_key=? AND canonical=1')
          .get(account.accountKey)
      )
        throw new LaunchMarketError('ALREADY_CLAIMED');
      if (chainSuccessfulClaims + unresolved >= 100) throw new LaunchMarketError('CLAIM_LIMIT_REACHED');
      const nonce = BigInt('0x' + randomBytes(32).toString('hex')).toString();
      this.db
        .prepare("INSERT INTO market_claim_vouchers VALUES(?,?,?,?,?,?,'ISSUED',NULL)")
        .run(account.id, account.accountKey, account.wallet!, nonce, now, deadline);
      return this.voucher(accountId)!;
    });
  }
  saveQuote(accountId: string, quote: MarketQuote): void {
    this.requireWallet(accountId, quote.owner);
    this.db
      .prepare('INSERT INTO market_quotes VALUES(?,?,?,?,?)')
      .run(quote.id, accountId, address(quote.owner), JSON.stringify(quote), quote.expiresAt);
  }
  quote(id: string, accountId: string): MarketQuote {
    const row = this.db
      .prepare('SELECT payload FROM market_quotes WHERE id=? AND account_id=?')
      .get(id, accountId);
    if (!row) throw new LaunchMarketError('QUOTE_NOT_FOUND', 404);
    return JSON.parse(String(row.payload)) as MarketQuote;
  }
  submit(accountId: string, quoteId: string, txHash: string): MarketTrackedOperation {
    const quote = this.quote(quoteId, accountId),
      transactionHash = hash(txHash);
    this.requireWallet(accountId, quote.owner);
    return this.atomic(() => {
      const existing = this.db.prepare('SELECT payload FROM market_operations WHERE quote_id=?').get(quoteId);
      if (existing) {
        const result = JSON.parse(String(existing.payload)) as MarketTrackedOperation;
        if (result.transactionHash !== transactionHash)
          throw new LaunchMarketError('QUOTE_ALREADY_SUBMITTED');
        return result;
      }
      if (this.db.prepare('SELECT id FROM market_operations WHERE transaction_hash=?').get(transactionHash))
        throw new LaunchMarketError('TRANSACTION_ALREADY_TRACKED');
      const operation: MarketTrackedOperation = {
        id: randomUUID(),
        quoteId,
        owner: quote.owner,
        transactionHash,
        state: 'SUBMITTED',
        confirmations: 0,
        location: null,
        error: null,
      };
      this.db
        .prepare('INSERT INTO market_operations VALUES(?,?,?,?,?)')
        .run(operation.id, quoteId, quote.owner, transactionHash, JSON.stringify(operation));
      if (quote.operation === 'CLAIM')
        this.db
          .prepare(
            "UPDATE market_claim_vouchers SET status='SUBMITTED',transaction_hash=? WHERE account_id=? AND transaction_hash IS NULL",
          )
          .run(transactionHash, accountId);
      return operation;
    });
  }
  operation(id: string, accountId: string): MarketTrackedOperation {
    const row = this.db
      .prepare(
        'SELECT o.payload FROM market_operations o JOIN market_quotes q ON q.id=o.quote_id WHERE o.id=? AND q.account_id=?',
      )
      .get(id, accountId);
    if (!row) throw new LaunchMarketError('OPERATION_NOT_FOUND', 404);
    return JSON.parse(String(row.payload)) as MarketTrackedOperation;
  }
  operations(accountId: string, owner: string): readonly MarketTrackedOperation[] {
    this.account(accountId);
    return this.db
      .prepare(
        'SELECT o.payload FROM market_operations o JOIN market_quotes q ON q.id=o.quote_id WHERE q.account_id=? AND o.owner=? ORDER BY o.rowid DESC LIMIT 50',
      )
      .all(accountId, address(owner))
      .map((row) => JSON.parse(String(row.payload)) as MarketTrackedOperation);
  }
  updateOperation(operation: MarketTrackedOperation): void {
    this.atomic(() => {
      this.db
        .prepare('UPDATE market_operations SET payload=? WHERE id=? AND transaction_hash=?')
        .run(JSON.stringify(operation), operation.id, operation.transactionHash);
      const status =
        operation.state === 'COMPLETED'
          ? 'COMPLETED'
          : operation.state === 'REORGED'
            ? 'REORGED'
            : operation.state === 'REVERTED'
              ? 'REVERTED'
              : operation.state === 'INCLUDED' || operation.state === 'CONFIRMED_L2'
                ? 'INCLUDED'
                : 'SUBMITTED';
      this.db
        .prepare('UPDATE market_claim_vouchers SET status=? WHERE transaction_hash=?')
        .run(status, operation.transactionHash);
    });
  }
  observeClaim(event: { accountKey: string; wallet: string; location: ChainLocation }): void {
    const l = event.location;
    if (
      l.chainId !== this.chainId ||
      l.transactionHash === null ||
      l.logIndex === null ||
      !Number.isSafeInteger(l.logIndex) ||
      l.logIndex < 0 ||
      !Number.isSafeInteger(l.confirmations) ||
      l.confirmations < 1 ||
      BigInt(l.blockNumber) > BigInt(Number.MAX_SAFE_INTEGER) ||
      BigInt(l.blockNumber) < 0n
    )
      throw new LaunchMarketError('INVALID_CLAIM_EVENT');
    const transactionHash = hash(l.transactionHash);
    const work = () => {
      this.db
        .prepare(
          'INSERT INTO market_claim_events VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(chain_id,transaction_hash,log_index,block_hash) DO UPDATE SET canonical=1',
        )
        .run(
          l.chainId,
          transactionHash,
          l.logIndex,
          Number(BigInt(l.blockNumber)),
          hash(l.blockHash),
          hash(event.accountKey),
          address(event.wallet),
        );
      this.db
        .prepare('UPDATE market_claim_vouchers SET status=?,transaction_hash=? WHERE account_key=?')
        .run(l.confirmations >= 3 ? 'COMPLETED' : 'INCLUDED', l.transactionHash, event.accountKey);
    };
    if (this.db.isTransaction) work();
    else this.atomic(work);
  }
  /** Reorgs retain spent/pending eligibility and require recovery; no second voucher is silently issued. */
  rollbackClaims(fromBlock: bigint): void {
    const work = () => {
      const rows = this.db
        .prepare(
          'SELECT transaction_hash FROM market_claim_events WHERE chain_id=? AND block_number>=? AND canonical=1',
        )
        .all(this.chainId, Number(fromBlock));
      for (const row of rows)
        this.db
          .prepare("UPDATE market_claim_vouchers SET status='REORGED' WHERE transaction_hash=?")
          .run(String(row.transaction_hash));
      this.db
        .prepare('UPDATE market_claim_events SET canonical=0 WHERE chain_id=? AND block_number>=?')
        .run(this.chainId, Number(fromBlock));
    };
    if (this.db.isTransaction) work();
    else this.atomic(work);
  }
  fingerprint(): string {
    const rows = this.db
      .prepare('SELECT id,account_key,email,subject,wallet FROM market_accounts ORDER BY id')
      .all();
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
}
