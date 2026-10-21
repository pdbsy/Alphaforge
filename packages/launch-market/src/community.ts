import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { LaunchMarketError } from './types.ts';

export const COMMUNITY_APPLICATION_ID = 1095126349;
export const communityCategories = [
  'Research Notes',
  'Strategy Discussion',
  'Build Logs',
  'Workshop Proposals',
] as const;
export type CommunityCategory = (typeof communityCategories)[number];
export interface CommunityPostInput {
  readonly title: string;
  readonly body: string;
  readonly category: CommunityCategory;
  readonly strategyId?: string | null;
}
export interface CommunityNoteInput {
  readonly id?: string;
  readonly title: string;
  readonly body: string;
  readonly strategyId?: string | null;
}
export interface CommunityProfile {
  readonly displayName: string;
  readonly bio: string;
}
export interface CommunityPreferences {
  readonly defaultForumCategory: 'All' | CommunityCategory;
  readonly defaultForumSort: 'newest' | 'replies';
  readonly savedStrategies: readonly string[];
}
export interface CommunityAccountPatch {
  readonly revision: number;
  readonly profile?: CommunityProfile;
  readonly preferences?: CommunityPreferences;
  readonly draft?: CommunityPostInput | null;
}
export interface CommunityPost extends CommunityPostInput {
  readonly id: string;
  readonly authorWallet: string;
  readonly authorName: string;
  readonly strategyId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly likeCount: number;
  readonly replyCount: number;
  readonly liked: boolean;
  readonly bookmarked: boolean;
}
export interface CommunityReply {
  readonly id: string;
  readonly postId: string;
  readonly authorWallet: string;
  readonly authorName: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}
export interface CommunityNote extends CommunityNoteInput {
  readonly id: string;
  readonly strategyId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}
export interface CommunityAccount {
  readonly wallet: string;
  readonly profile: CommunityProfile;
  readonly preferences: CommunityPreferences;
  readonly draft: CommunityPostInput | null;
  readonly notes: readonly CommunityNote[];
  readonly likedPosts: readonly CommunityPost[];
  readonly bookmarkedPosts: readonly CommunityPost[];
  readonly revision: number;
}
type Row = Record<string, SQLOutputValue>;
const ddl = `
CREATE TABLE community_identity(id INTEGER PRIMARY KEY CHECK(id=1),origin TEXT NOT NULL) STRICT;
CREATE TABLE community_accounts(wallet TEXT PRIMARY KEY,profile TEXT NOT NULL,preferences TEXT NOT NULL,draft TEXT,revision INTEGER NOT NULL) STRICT;
CREATE TABLE community_posts(id TEXT PRIMARY KEY,wallet TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,category TEXT NOT NULL,strategy_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,revision INTEGER NOT NULL) STRICT;
CREATE INDEX community_post_order ON community_posts(created_at DESC,id DESC);
CREATE INDEX community_post_wallet ON community_posts(wallet);
CREATE TABLE community_replies(id TEXT PRIMARY KEY,post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,wallet TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,revision INTEGER NOT NULL) STRICT;
CREATE INDEX community_reply_order ON community_replies(post_id,created_at DESC,id DESC);
CREATE TABLE community_reactions(wallet TEXT NOT NULL,post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN('like','bookmark')),PRIMARY KEY(wallet,post_id,kind)) STRICT;
CREATE TABLE community_notes(wallet TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,strategy_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(wallet,id)) STRICT;
CREATE TABLE community_rate_limits(key_hash TEXT NOT NULL,window INTEGER NOT NULL,expires_at INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(key_hash,window)) STRICT;
CREATE INDEX community_rate_expiry ON community_rate_limits(expires_at);
PRAGMA user_version=1;`;
const defaults = (): CommunityPreferences => ({
  defaultForumCategory: 'All',
  defaultForumSort: 'newest',
  savedStrategies: [],
});
const fail = (code = 'INVALID_COMMUNITY_INPUT', status = 400): never => {
  throw new LaunchMarketError(code, status);
};
export function communityWallet(value: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value))
    return fail('LINKED_WALLET_REQUIRED', 401);
  return value.toLowerCase();
}
function text(value: unknown, max: number, min = 0): string {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  )
    return fail();
  const result = value.trim().normalize('NFC');
  if (result.length < min || result.length > max) return fail();
  return result;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) return fail();
  return value;
}
function strategy(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) return fail();
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail();
  return Number(value);
}
function clock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000) fail();
}
function postInput(input: CommunityPostInput): CommunityPostInput & { strategyId: string | null } {
  if (!input || !communityCategories.includes(input.category)) return fail();
  return {
    title: text(input.title, 120, 2),
    body: text(input.body, 6000, 2),
    category: input.category,
    strategyId: strategy(input.strategyId),
  };
}
function draftInput(input: CommunityPostInput): CommunityPostInput & { strategyId: string | null } {
  if (!input || !communityCategories.includes(input.category)) return fail();
  return {
    title: text(input.title, 120),
    body: text(input.body, 6000),
    category: input.category,
    strategyId: strategy(input.strategyId),
  };
}
function noteInput(input: CommunityNoteInput) {
  if (!input) return fail();
  return {
    title: text(input.title, 120, 1),
    body: text(input.body, 6000, 1),
    strategyId: strategy(input.strategyId),
  };
}
function profileInput(input: CommunityProfile): CommunityProfile {
  if (!input) return fail();
  return { displayName: text(input.displayName, 60, 1), bio: text(input.bio, 300) };
}
function preferencesInput(input: CommunityPreferences): CommunityPreferences {
  if (
    !input ||
    !['All', ...communityCategories].includes(input.defaultForumCategory) ||
    !['newest', 'replies'].includes(input.defaultForumSort) ||
    !Array.isArray(input.savedStrategies) ||
    input.savedStrategies.length > 100
  )
    return fail();
  const savedStrategies = input.savedStrategies.map((value) => strategy(value)!);
  if (
    savedStrategies.some((value) => value === null) ||
    new Set(savedStrategies).size !== savedStrategies.length
  )
    return fail();
  return {
    defaultForumCategory: input.defaultForumCategory,
    defaultForumSort: input.defaultForumSort,
    savedStrategies,
  };
}
const iso = (value: SQLOutputValue): string => new Date(Number(value) * 1000).toISOString();
const shortWallet = (wallet: string): string => wallet.slice(0, 6) + '…' + wallet.slice(-4);
function cursor(row: Row | undefined): string | null {
  return row
    ? Buffer.from(JSON.stringify([Number(row.created_at), String(row.id)])).toString('base64url')
    : null;
}
function readCursor(value?: string): readonly [number, string] | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) return fail();
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || parsed[0] < 0)
      return fail();
    return [parsed[0] as number, id(parsed[1])];
  } catch {
    return fail();
  }
}
function privatePath(path: string): void {
  if (path === ':memory:') return;
  if (!isAbsolute(path) || path !== resolve(path) || realpathSync(dirname(path)) !== dirname(path))
    fail('COMMUNITY_STORAGE_UNSAFE', 503);
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.())
    fail('COMMUNITY_STORAGE_UNSAFE', 503);
  try {
    const fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const file = lstatSync(path + suffix);
      if (
        !file.isFile() ||
        file.nlink !== 1 ||
        (file.mode & 0o077) !== 0 ||
        file.uid !== parent.uid ||
        realpathSync(path + suffix) !== path + suffix
      )
        fail('COMMUNITY_STORAGE_UNSAFE', 503);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Separate, durable community data. The caller supplies a server-authenticated wallet, never a body owner. */
export class CommunityStore {
  readonly db: DatabaseSync;
  readonly origin: string;
  constructor(path: string, origin: string) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol))
      fail('INVALID_COMMUNITY_ORIGIN');
    privatePath(path);
    this.origin = origin;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      // One write lock covers version inspection and migration so simultaneous startup cannot race DDL.
      this.atomic(() => {
        const applicationId = this.db.prepare('PRAGMA application_id').get()!.application_id;
        if (applicationId !== 0 && applicationId !== COMMUNITY_APPLICATION_ID)
          fail('COMMUNITY_DATABASE_IDENTITY', 503);
        const version = this.db.prepare('PRAGMA user_version').get()!.user_version;
        if (version === 0) {
          if (
            this.db
              .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
              .get()
          )
            fail('COMMUNITY_DATABASE_UNKNOWN', 503);
          this.db.exec(ddl);
          this.db.prepare('INSERT INTO community_identity VALUES(1,?)').run(origin);
          this.db.exec('PRAGMA application_id=' + COMMUNITY_APPLICATION_ID);
        } else if (version !== 1) fail('COMMUNITY_SCHEMA_UNSUPPORTED', 503);
        if (this.db.prepare('SELECT origin FROM community_identity WHERE id=1').get()?.origin !== origin)
          fail('COMMUNITY_DATABASE_IDENTITY', 503);
      });
      if (
        this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
        this.db.prepare('PRAGMA foreign_key_check').get()
      )
        fail('COMMUNITY_DATABASE_CORRUPT', 503);
      this.db.exec('PRAGMA journal_mode=WAL;');
      privatePath(path);
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
  close(): void {
    if (this.db.isOpen) this.db.close();
  }
  consumeRate(key: string, limit: number, windowSeconds: number, now: number): void {
    clock(now);
    if (
      !key ||
      key.length > 256 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10000 ||
      !Number.isSafeInteger(windowSeconds) ||
      windowSeconds < 1 ||
      windowSeconds > 86400
    )
      fail();
    const keyHash = createHash('sha256')
        .update(key + ':' + windowSeconds)
        .digest('hex'),
      window = Math.floor(now / windowSeconds),
      expiresAt = (window + 1) * windowSeconds;
    this.atomic(() => {
      this.db.prepare('DELETE FROM community_rate_limits WHERE expires_at<=?').run(now);
      const row = this.db
        .prepare('SELECT count FROM community_rate_limits WHERE key_hash=? AND window=?')
        .get(keyHash, window);
      if (Number(row?.count ?? 0) >= limit) fail('COMMUNITY_RATE_LIMITED', 429);
      if (!row && Number(this.db.prepare('SELECT count(*) n FROM community_rate_limits').get()!.n) >= 50000)
        fail('COMMUNITY_RATE_LIMITED', 429);
      this.db
        .prepare(
          'INSERT INTO community_rate_limits VALUES(?,?,?,1) ON CONFLICT(key_hash,window) DO UPDATE SET count=count+1',
        )
        .run(keyHash, window, expiresAt);
    });
  }
  private authorName(wallet: string): string {
    const row = this.db.prepare('SELECT profile FROM community_accounts WHERE wallet=?').get(wallet);
    return row ? (JSON.parse(String(row.profile)) as CommunityProfile).displayName : shortWallet(wallet);
  }
  private post(row: Row, viewer: string | null): CommunityPost {
    const wallet = String(row.wallet),
      postId = String(row.id);
    return {
      id: postId,
      authorWallet: wallet,
      authorName: this.authorName(wallet),
      title: String(row.title),
      body: String(row.body),
      category: String(row.category) as CommunityCategory,
      strategyId: row.strategy_id === null ? null : String(row.strategy_id),
      createdAt: iso(row.created_at!),
      updatedAt: iso(row.updated_at!),
      revision: Number(row.revision),
      likeCount: Number(
        this.db
          .prepare("SELECT count(*) n FROM community_reactions WHERE post_id=? AND kind='like'")
          .get(postId)!.n,
      ),
      replyCount: Number(
        this.db.prepare('SELECT count(*) n FROM community_replies WHERE post_id=?').get(postId)!.n,
      ),
      liked:
        viewer !== null &&
        !!this.db
          .prepare("SELECT 1 FROM community_reactions WHERE wallet=? AND post_id=? AND kind='like'")
          .get(viewer, postId),
      bookmarked:
        viewer !== null &&
        !!this.db
          .prepare("SELECT 1 FROM community_reactions WHERE wallet=? AND post_id=? AND kind='bookmark'")
          .get(viewer, postId),
    };
  }
  listPosts(
    options: {
      cursor?: string;
      query?: string;
      category?: CommunityCategory;
      strategyId?: string;
      limit?: number;
      sort?: 'newest' | 'replies';
    } = {},
    viewer: string | null = null,
  ) {
    const limit = options.limit ?? 30,
      sort = options.sort ?? 'newest',
      clauses: string[] = [],
      params: (string | number)[] = [];
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !['newest', 'replies'].includes(sort)) fail();
    if (viewer !== null) viewer = communityWallet(viewer);
    if (options.category !== undefined) {
      if (!communityCategories.includes(options.category)) fail();
      clauses.push('category=?');
      params.push(options.category);
    }
    if (options.strategyId !== undefined) {
      clauses.push('strategy_id=?');
      params.push(strategy(options.strategyId)!);
    }
    if (options.query !== undefined) {
      const query = text(options.query, 120).replace(/[\\%_]/g, '\\$&');
      clauses.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
      params.push('%' + query + '%', '%' + query + '%');
    }
    if (options.cursor !== undefined) {
      if (sort === 'newest') {
        const after = readCursor(options.cursor)!;
        clauses.push('(created_at<? OR (created_at=? AND id<?))');
        params.push(after[0], after[0], after[1]);
      } else {
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(options.cursor)) fail();
        let after: unknown;
        try {
          after = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        } catch {
          fail();
        }
        if (
          !Array.isArray(after) ||
          after.length !== 3 ||
          !Number.isSafeInteger(after[0]) ||
          after[0] < 0 ||
          !Number.isSafeInteger(after[1]) ||
          after[1] < 0
        )
          fail();
        const tuple = after as [number, number, string];
        id(tuple[2]);
        clauses.push('(reply_count<? OR (reply_count=? AND (created_at<? OR (created_at=? AND id<?))))');
        params.push(tuple[0], tuple[0], tuple[1], tuple[1], tuple[2]);
      }
    }
    const rows = this.db
      .prepare(
        `WITH feed AS (SELECT p.*,(SELECT count(*) FROM community_replies r WHERE r.post_id=p.id) AS reply_count FROM community_posts p) SELECT * FROM feed ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY ${sort === 'replies' ? 'reply_count DESC,' : ''}created_at DESC,id DESC LIMIT ?`,
      )
      .all(...params, limit + 1);
    const last = rows[limit - 1];
    return {
      posts: rows.slice(0, limit).map((row) => this.post(row, viewer)),
      nextCursor:
        rows.length > limit
          ? sort === 'newest'
            ? cursor(last)
            : Buffer.from(
                JSON.stringify([Number(last!.reply_count), Number(last!.created_at), String(last!.id)]),
              ).toString('base64url')
          : null,
    };
  }
  getPost(postId: string, viewer: string | null = null): CommunityPost {
    const row = this.db.prepare('SELECT * FROM community_posts WHERE id=?').get(id(postId));
    if (!row) return fail('COMMUNITY_POST_NOT_FOUND', 404);
    return this.post(row, viewer === null ? null : communityWallet(viewer));
  }
  private owned(
    table: 'community_posts' | 'community_replies',
    recordId: string,
    wallet: string,
    expected: number,
  ): Row {
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id(recordId));
    if (!row) return fail('COMMUNITY_RECORD_NOT_FOUND', 404);
    if (row.wallet !== wallet) return fail('COMMUNITY_AUTHOR_REQUIRED', 403);
    if (Number(row.revision) !== revision(expected)) return fail('COMMUNITY_REVISION_CONFLICT', 409);
    return row;
  }
  createPost(wallet: string, input: CommunityPostInput, now: number): CommunityPost {
    wallet = communityWallet(wallet);
    clock(now);
    const value = postInput(input),
      recordId = randomUUID();
    this.atomic(() => {
      if (
        Number(this.db.prepare('SELECT count(*) n FROM community_posts WHERE wallet=?').get(wallet)!.n) >=
        1000
      )
        fail('COMMUNITY_CAPACITY_REACHED', 409);
      this.db
        .prepare('INSERT INTO community_posts VALUES(?,?,?,?,?,?,?,?,1)')
        .run(recordId, wallet, value.title, value.body, value.category, value.strategyId, now, now);
      const account = this.accountRow(wallet);
      if (account?.draft) {
        const draft = draftInput(JSON.parse(String(account.draft)) as CommunityPostInput);
        if (JSON.stringify(draft) === JSON.stringify(value))
          this.db
            .prepare('UPDATE community_accounts SET draft=NULL,revision=revision+1 WHERE wallet=?')
            .run(wallet);
      }
    });
    return this.getPost(recordId, wallet);
  }
  updatePost(
    wallet: string,
    postId: string,
    input: CommunityPostInput,
    expected: number,
    now: number,
  ): CommunityPost {
    wallet = communityWallet(wallet);
    clock(now);
    const value = postInput(input);
    this.atomic(() => {
      this.owned('community_posts', postId, wallet, expected);
      this.db
        .prepare(
          'UPDATE community_posts SET title=?,body=?,category=?,strategy_id=?,updated_at=?,revision=revision+1 WHERE id=?',
        )
        .run(value.title, value.body, value.category, value.strategyId, now, postId);
    });
    return this.getPost(postId, wallet);
  }
  deletePost(wallet: string, postId: string, expected: number): void {
    wallet = communityWallet(wallet);
    this.atomic(() => {
      this.owned('community_posts', postId, wallet, expected);
      this.db.prepare('DELETE FROM community_posts WHERE id=?').run(postId);
    });
  }
  listReplies(postId: string, options: { cursor?: string; limit?: number } = {}) {
    this.getPost(postId);
    const after = readCursor(options.cursor),
      limit = options.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail();
    const rows = this.db
      .prepare(
        `SELECT * FROM community_replies WHERE post_id=? ${after ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(postId, ...(after ? [after[0], after[0], after[1]] : []), limit + 1);
    return {
      replies: rows.slice(0, limit).map((row) => this.reply(row)),
      nextCursor: rows.length > limit ? cursor(rows[limit - 1]) : null,
    };
  }
  private reply(row: Row): CommunityReply {
    return {
      id: String(row.id),
      postId: String(row.post_id),
      authorWallet: String(row.wallet),
      authorName: this.authorName(String(row.wallet)),
      body: String(row.body),
      createdAt: iso(row.created_at!),
      updatedAt: iso(row.updated_at!),
      revision: Number(row.revision),
    };
  }
  createReply(wallet: string, postId: string, body: string, now: number): CommunityReply {
    wallet = communityWallet(wallet);
    clock(now);
    const value = text(body, 2000, 2),
      replyId = randomUUID();
    this.atomic(() => {
      this.getPost(postId);
      if (
        Number(this.db.prepare('SELECT count(*) n FROM community_replies WHERE post_id=?').get(postId)!.n) >=
          10000 ||
        Number(this.db.prepare('SELECT count(*) n FROM community_replies WHERE wallet=?').get(wallet)!.n) >=
          5000
      )
        fail('COMMUNITY_CAPACITY_REACHED', 409);
      this.db
        .prepare('INSERT INTO community_replies VALUES(?,?,?,?,?,?,1)')
        .run(replyId, postId, wallet, value, now, now);
    });
    return this.reply(this.db.prepare('SELECT * FROM community_replies WHERE id=?').get(replyId)!);
  }
  updateReply(wallet: string, replyId: string, body: string, expected: number, now: number): CommunityReply {
    wallet = communityWallet(wallet);
    clock(now);
    const value = text(body, 2000, 2);
    this.atomic(() => {
      this.owned('community_replies', replyId, wallet, expected);
      this.db
        .prepare('UPDATE community_replies SET body=?,updated_at=?,revision=revision+1 WHERE id=?')
        .run(value, now, replyId);
    });
    return this.reply(this.db.prepare('SELECT * FROM community_replies WHERE id=?').get(replyId)!);
  }
  deleteReply(wallet: string, replyId: string, expected: number): void {
    wallet = communityWallet(wallet);
    this.atomic(() => {
      this.owned('community_replies', replyId, wallet, expected);
      this.db.prepare('DELETE FROM community_replies WHERE id=?').run(replyId);
    });
  }
  react(wallet: string, postId: string, kind: 'like' | 'bookmark', active: boolean): CommunityPost {
    wallet = communityWallet(wallet);
    if (!['like', 'bookmark'].includes(kind) || typeof active !== 'boolean') fail();
    this.atomic(() => {
      this.getPost(postId);
      if (active) {
        const existing = this.db
          .prepare('SELECT 1 FROM community_reactions WHERE wallet=? AND post_id=? AND kind=?')
          .get(wallet, postId, kind);
        if (
          !existing &&
          Number(
            this.db
              .prepare('SELECT count(*) n FROM community_reactions WHERE wallet=? AND kind=?')
              .get(wallet, kind)!.n,
          ) >= 500
        )
          fail('COMMUNITY_CAPACITY_REACHED', 409);
        this.db
          .prepare('INSERT INTO community_reactions VALUES(?,?,?) ON CONFLICT DO NOTHING')
          .run(wallet, postId, kind);
      } else
        this.db
          .prepare('DELETE FROM community_reactions WHERE wallet=? AND post_id=? AND kind=?')
          .run(wallet, postId, kind);
    });
    return this.getPost(postId, wallet);
  }
  private accountRow(wallet: string) {
    return this.db.prepare('SELECT * FROM community_accounts WHERE wallet=?').get(wallet);
  }
  account(wallet: string): CommunityAccount {
    wallet = communityWallet(wallet);
    const row = this.accountRow(wallet),
      posts = (kind: string) =>
        this.db
          .prepare(
            'SELECT p.* FROM community_posts p JOIN community_reactions r ON r.post_id=p.id WHERE r.wallet=? AND r.kind=? ORDER BY p.created_at DESC,p.id DESC LIMIT 500',
          )
          .all(wallet, kind)
          .map((post) => this.post(post, wallet));
    return {
      wallet,
      profile: row ? JSON.parse(String(row.profile)) : { displayName: shortWallet(wallet), bio: '' },
      preferences: row ? JSON.parse(String(row.preferences)) : defaults(),
      draft: row?.draft ? JSON.parse(String(row.draft)) : null,
      revision: Number(row?.revision ?? 0),
      notes: this.db
        .prepare('SELECT * FROM community_notes WHERE wallet=? ORDER BY updated_at DESC,id DESC LIMIT 500')
        .all(wallet)
        .map((note) => this.note(note)),
      likedPosts: posts('like'),
      bookmarkedPosts: posts('bookmark'),
    };
  }
  private updateAccountWithin(wallet: string, patch: CommunityAccountPatch): void {
    const expected = revision(patch.revision),
      row = this.accountRow(wallet);
    if (Number(row?.revision ?? 0) !== expected) fail('COMMUNITY_REVISION_CONFLICT', 409);
    const profile =
        patch.profile === undefined
          ? row
            ? JSON.parse(String(row.profile))
            : { displayName: shortWallet(wallet), bio: '' }
          : profileInput(patch.profile),
      preferences =
        patch.preferences === undefined
          ? row
            ? JSON.parse(String(row.preferences))
            : defaults()
          : preferencesInput(patch.preferences),
      draft =
        patch.draft === undefined
          ? row?.draft
            ? JSON.parse(String(row.draft))
            : null
          : patch.draft === null
            ? null
            : draftInput(patch.draft);
    this.db
      .prepare(
        'INSERT INTO community_accounts VALUES(?,?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET profile=excluded.profile,preferences=excluded.preferences,draft=excluded.draft,revision=excluded.revision',
      )
      .run(
        wallet,
        JSON.stringify(profile),
        JSON.stringify(preferences),
        draft === null ? null : JSON.stringify(draft),
        expected + 1,
      );
  }
  updateAccount(wallet: string, patch: CommunityAccountPatch): CommunityAccount {
    wallet = communityWallet(wallet);
    this.atomic(() => this.updateAccountWithin(wallet, patch));
    return this.account(wallet);
  }
  private note(row: Row): CommunityNote {
    return {
      id: String(row.id),
      title: String(row.title),
      body: String(row.body),
      strategyId: row.strategy_id === null ? null : String(row.strategy_id),
      createdAt: iso(row.created_at!),
      updatedAt: iso(row.updated_at!),
      revision: Number(row.revision),
    };
  }
  private createNoteWithin(wallet: string, input: CommunityNoteInput, now: number): CommunityNote {
    const value = noteInput(input),
      noteId = input.id === undefined ? randomUUID() : id(input.id);
    if (this.db.prepare('SELECT 1 FROM community_notes WHERE wallet=? AND id=?').get(wallet, noteId))
      return fail('COMMUNITY_REVISION_CONFLICT', 409);
    if (
      Number(this.db.prepare('SELECT count(*) n FROM community_notes WHERE wallet=?').get(wallet)!.n) >= 500
    )
      fail('COMMUNITY_CAPACITY_REACHED', 409);
    this.db
      .prepare('INSERT INTO community_notes VALUES(?,?,?,?,?,?,?,1)')
      .run(wallet, noteId, value.title, value.body, value.strategyId, now, now);
    return this.note(
      this.db.prepare('SELECT * FROM community_notes WHERE wallet=? AND id=?').get(wallet, noteId)!,
    );
  }
  createNote(wallet: string, input: CommunityNoteInput, now: number): CommunityNote {
    wallet = communityWallet(wallet);
    clock(now);
    return this.atomic(() => this.createNoteWithin(wallet, input, now));
  }
  updateNote(
    wallet: string,
    noteId: string,
    input: CommunityNoteInput,
    expected: number,
    now: number,
  ): CommunityNote {
    wallet = communityWallet(wallet);
    id(noteId);
    clock(now);
    const value = noteInput(input);
    this.atomic(() => {
      const row = this.db
        .prepare('SELECT revision FROM community_notes WHERE wallet=? AND id=?')
        .get(wallet, noteId);
      if (!row) fail('COMMUNITY_NOTE_NOT_FOUND', 404);
      if (Number(row!.revision) !== revision(expected)) fail('COMMUNITY_REVISION_CONFLICT', 409);
      this.db
        .prepare(
          'UPDATE community_notes SET title=?,body=?,strategy_id=?,updated_at=?,revision=revision+1 WHERE wallet=? AND id=?',
        )
        .run(value.title, value.body, value.strategyId, now, wallet, noteId);
    });
    return this.note(
      this.db.prepare('SELECT * FROM community_notes WHERE wallet=? AND id=?').get(wallet, noteId)!,
    );
  }
  deleteNote(wallet: string, noteId: string, expected: number): void {
    wallet = communityWallet(wallet);
    id(noteId);
    this.atomic(() => {
      const row = this.db
        .prepare('SELECT revision FROM community_notes WHERE wallet=? AND id=?')
        .get(wallet, noteId);
      if (!row) fail('COMMUNITY_NOTE_NOT_FOUND', 404);
      if (Number(row!.revision) !== revision(expected)) fail('COMMUNITY_REVISION_CONFLICT', 409);
      this.db.prepare('DELETE FROM community_notes WHERE wallet=? AND id=?').run(wallet, noteId);
    });
  }
  importAccount(
    wallet: string,
    input: CommunityAccountPatch & { readonly notes: readonly CommunityNoteInput[] },
    now: number,
  ): CommunityAccount {
    wallet = communityWallet(wallet);
    clock(now);
    if (!Array.isArray(input.notes) || input.notes.length > 50) fail();
    this.atomic(() => {
      this.updateAccountWithin(wallet, input);
      for (const note of input.notes) {
        if (note.id === undefined) fail();
        this.createNoteWithin(wallet, note, now);
      }
    });
    return this.account(wallet);
  }
}
