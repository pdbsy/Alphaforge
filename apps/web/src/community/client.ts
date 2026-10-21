import type {
  CommunityAccount,
  CommunityPost,
  CommunityReply,
  CommunityState,
  CreatorStrategy,
} from './model.ts';

export class CommunityApiError extends Error {
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.status = status;
  }
}
export type CommunityApi = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

/** Every mutation binds to a fresh authenticated session token; no token survives a wallet change. */
export function createCommunityApi(fetcher: typeof fetch = fetch): CommunityApi {
  return async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const read = (url: string) =>
      fetcher(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
    let csrf: string | null = null;
    if (method !== 'GET') {
      const walletResponse = await read('/api/launch-market/wallet/test-session');
      const wallet = walletResponse.ok
        ? ((await walletResponse.json()) as { csrfToken?: unknown; identityKind?: string })
        : null;
      if (wallet?.identityKind === 'WALLET_TEST')
        csrf = typeof wallet.csrfToken === 'string' ? wallet.csrfToken : null;
      else {
        const response = await read('/auth/me');
        const account = response.ok
          ? ((await response.json()) as { csrfToken?: unknown; authKind?: string })
          : null;
        if (account?.authKind === 'google')
          csrf = typeof account.csrfToken === 'string' ? account.csrfToken : null;
      }
      if (!csrf || csrf.length < 16 || csrf.length > 256)
        throw new CommunityApiError('ACCOUNT_SESSION_REQUIRED', 401);
    }
    const response = await fetcher(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf! },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const result = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
      const nested =
        result?.error && typeof result.error === 'object' && 'code' in result.error
          ? result.error.code
          : null;
      const value = result?.code ?? nested ?? result?.error;
      throw new CommunityApiError(
        typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'COMMUNITY_UNAVAILABLE',
        response.status,
      );
    }
    return response.json() as Promise<T>;
  };
}

export function communityError(error: unknown): string {
  if (error instanceof CommunityApiError) {
    if (error.status === 401)
      return 'Sign in with your wallet to continue. Your writing has been kept in this form.';
    if (error.status === 409)
      return 'This record changed on another device. Refresh it before saving again. Your writing has been kept in this form.';
    if (error.status === 403)
      return 'Only the author can change this record. Check the wallet you signed in with.';
    if (error.status === 404) return 'This record is no longer available.';
    if (error.status === 429) return 'Too many requests. Please wait a moment and try again.';
    if (error.status === 400) return 'Check the required fields and limits, then try again.';
  }
  return 'The service could not complete this request. Your writing has been kept in this form. Please try again.';
}

export class CommunityClient {
  readonly api: CommunityApi;
  readonly state: CommunityState = {
    account: null,
    accountLoaded: false,
    posts: [],
    nextCursor: null,
    post: null,
    replies: [],
    replyCursor: null,
    strategies: [],
    strategyCursor: null,
    ownedStrategies: [],
    strategy: null,
    loading: false,
    busy: false,
    error: null,
    notice: null,
  };
  #generation = 0;
  #readEpoch = 0;
  #wallet: string | null = null;
  constructor(api: CommunityApi = createCommunityApi()) {
    this.api = api;
  }
  bindWallet(wallet: string | null | undefined): void {
    this.#wallet = wallet?.toLowerCase() ?? null;
  }
  invalidate(): void {
    ++this.#generation;
    ++this.#readEpoch;
    Object.assign(this.state, {
      account: null,
      accountLoaded: false,
      posts: [],
      nextCursor: null,
      post: null,
      replies: [],
      replyCursor: null,
      ownedStrategies: [],
      strategy: null,
      busy: false,
      loading: false,
      error: null,
      notice: null,
    });
  }
  async account(): Promise<void> {
    const generation = this.#generation;
    try {
      const account = await this.api<CommunityAccount>('/api/community/account');
      if (generation !== this.#generation) return;
      if (!/^0x[0-9a-fA-F]{40}$/.test(account.wallet) || !Number.isSafeInteger(account.revision))
        throw new Error('INVALID_ACCOUNT');
      if (this.#wallet && account.wallet.toLowerCase() !== this.#wallet) {
        this.state.account = null;
        this.state.accountLoaded = true;
        return;
      }
      this.state.account = account;
      this.state.accountLoaded = true;
    } catch (error) {
      if (generation !== this.#generation) return;
      if (!(error instanceof CommunityApiError) || error.status !== 401) throw error;
      this.state.account = null;
      this.state.accountLoaded = true;
    }
  }
  async load(
    kind: 'forum' | 'post' | 'account' | 'library' | 'strategy' | 'creator',
    id = '',
    query = '',
    append = false,
  ): Promise<void> {
    const epoch = ++this.#readEpoch;
    const generation = this.#generation;
    this.state.loading = true;
    this.state.error = null;
    try {
      await this.account();
      if (generation !== this.#generation || epoch !== this.#readEpoch) return;
      let patch: Partial<CommunityState> = {};
      if (kind === 'forum') {
        const result = await this.api<{ posts: CommunityPost[]; nextCursor: string | null }>(
          `/api/community/posts${query}`,
        );
        patch = {
          posts: append
            ? [
                ...this.state.posts,
                ...result.posts.filter((p) => !this.state.posts.some((old) => old.id === p.id)),
              ]
            : result.posts,
          nextCursor: result.nextCursor,
        };
      } else if (kind === 'post') {
        const result = await this.api<{
          post: CommunityPost;
          replies: CommunityReply[];
          nextCursor: string | null;
        }>(`/api/community/posts/${encodeURIComponent(id)}${query}`);
        patch = {
          post: result.post,
          replies: append
            ? [
                ...this.state.replies,
                ...result.replies.filter((r) => !this.state.replies.some((old) => old.id === r.id)),
              ]
            : result.replies,
          replyCursor: result.nextCursor,
        };
      } else if (kind === 'library') {
        const result = await this.api<{ strategies: CreatorStrategy[]; nextCursor: string | null }>(
          `/api/strategies${query}`,
        );
        patch = {
          strategies: append
            ? [
                ...this.state.strategies,
                ...result.strategies.filter((s) => !this.state.strategies.some((old) => old.id === s.id)),
              ]
            : result.strategies,
          strategyCursor: result.nextCursor,
        };
      } else if (kind === 'strategy') {
        patch = {
          strategy: (
            await this.api<{ strategy: CreatorStrategy }>(`/api/strategies/${encodeURIComponent(id)}`)
          ).strategy,
        };
      } else if (kind === 'creator' && this.state.account) {
        patch = {
          ownedStrategies: (await this.api<{ strategies: CreatorStrategy[] }>('/api/creator/strategies'))
            .strategies,
        };
      }
      if (generation === this.#generation && epoch === this.#readEpoch) Object.assign(this.state, patch);
    } catch (error) {
      if (generation === this.#generation && epoch === this.#readEpoch)
        this.state.error = communityError(error);
    } finally {
      if (generation === this.#generation && epoch === this.#readEpoch) this.state.loading = false;
    }
  }
  async mutate<T>(path: string, method: string, body: unknown): Promise<T> {
    if (this.state.busy) throw new CommunityApiError('COMMUNITY_REQUEST_PENDING', 409);
    if (!this.state.account) throw new CommunityApiError('ACCOUNT_SESSION_REQUIRED', 401);
    const generation = this.#generation;
    this.state.busy = true;
    this.state.notice = null;
    this.state.error = null;
    try {
      const result = await this.api<T>(path, method, body);
      if (generation !== this.#generation) throw new CommunityApiError('ACCOUNT_SESSION_REQUIRED', 401);
      return result;
    } catch (error) {
      if (generation === this.#generation && error instanceof CommunityApiError && error.status === 401) {
        this.state.account = null;
        this.state.ownedStrategies = [];
      }
      throw error;
    } finally {
      if (generation === this.#generation) this.state.busy = false;
    }
  }
}
