import type { LaunchMarketClient } from '../launch-market/client.ts';
import type { LaunchClientState } from '../launch-market/model.ts';
import type { Eip1193Provider } from '../chain-wallet.ts';
import { escapeHtml as esc } from '../launch-market/presentation.ts';
import { CommunityClient, communityError } from './client.ts';
import { forumCategories, type CommunityDraft, type CreatorStrategy, type StrategyPolicy } from './model.ts';
import {
  composeDialog,
  noteDialog,
  renderAccount,
  renderForum,
  renderLibrary,
  renderPost,
  renderStrategy,
  strategyDialog,
} from './shell.ts';

export interface CommunityHost {
  homeHtml?: string;
  launchState?: LaunchClientState;
  view: { priceRange?: string; tradeTab?: string };
  trade?: { content(strategy: { id: string }): string };
  pages: {
    market(): string;
    account(tab: string): string;
    forum?: () => string;
    post?: (id: string) => string;
    library?: (id: string) => string;
  };
  store?: {
    read(): {
      favorites?: string[];
      posts?: { id: string; title: string; body: string }[];
      draft?: { title: string; body: string; category: string };
    };
  };
  app: {
    render(options?: { preserve?: boolean }): void;
    openDialog(html: string): void;
    closeDialog(): void;
  };
}

export function strategyFields(
  data: FormData,
): Omit<
  CreatorStrategy,
  | 'id'
  | 'authorWallet'
  | 'version'
  | 'publishedVersion'
  | 'publicationRevision'
  | 'publishedAt'
  | 'createdAt'
  | 'updatedAt'
  | 'status'
  | 'digest'
  | 'executionStatus'
> {
  const text = (name: string) => String(data.get(name) ?? '').trim();
  const kind = text('kind');
  const allocationBps = Math.round(Number(text('allocation')) * 100);
  const maxSlippageBps = Math.round(Number(text('slippage')) * 100);
  if (
    !['BUY_AND_HOLD', 'EMA_CROSS', 'DCA'].includes(kind) ||
    !Number.isSafeInteger(allocationBps) ||
    allocationBps < 1 ||
    allocationBps > 10000 ||
    !Number.isSafeInteger(maxSlippageBps) ||
    maxSlippageBps < 1 ||
    maxSlippageBps > 500
  )
    throw new Error('Use an allocation between 0.01% and 100%, and slippage between 0.01% and 5%.');
  const policy: StrategyPolicy = { kind: kind as StrategyPolicy['kind'], allocationBps, maxSlippageBps };
  if (kind === 'EMA_CROSS') {
    const fastPeriod = Number(text('fastPeriod')),
      slowPeriod = Number(text('slowPeriod'));
    if (
      !Number.isSafeInteger(fastPeriod) ||
      fastPeriod < 2 ||
      fastPeriod > 200 ||
      !Number.isSafeInteger(slowPeriod) ||
      slowPeriod < 3 ||
      slowPeriod > 500 ||
      fastPeriod >= slowPeriod
    )
      throw new Error(
        'EMA periods must be whole numbers, with the fast period shorter than the slow period.',
      );
    Object.assign(policy, { fastPeriod, slowPeriod });
  }
  if (kind === 'DCA') {
    const intervalDays = Number(text('intervalDays'));
    if (!Number.isSafeInteger(intervalDays) || intervalDays < 1 || intervalDays > 90)
      throw new Error('Choose an interval between 1 and 90 whole days.');
    policy.intervalDays = intervalDays;
  }
  if (!['TSLA', 'AMZN'].includes(text('symbol'))) throw new Error('Choose a supported stock reference.');
  return {
    name: text('name'),
    symbol: text('symbol') as 'TSLA' | 'AMZN',
    summary: text('summary'),
    method: text('method'),
    risks: text('risks'),
    policy,
  };
}

/** Installs real online records into the existing router without changing chain funding actions. */
export function installCommunity(
  host: CommunityHost,
  launch?: LaunchMarketClient | null,
  client = new CommunityClient(),
): { client: CommunityClient; attachLaunch(launch: LaunchMarketClient): void } {
  let market = launch;
  const state = client.state;
  const originalAccount = host.pages.account;
  const originalMarket = host.pages.market;
  if (host.store) {
    const readLocal = host.store.read.bind(host.store);
    host.store.read = () => ({
      ...readLocal(),
      favorites:
        state.account?.preferences.savedStrategies.map((id) =>
          ['TSLA', 'AMZN'].includes(id.toUpperCase()) ? id.toLowerCase() : id,
        ) ?? [],
    });
  }
  let requested = '';
  let query = '',
    category = 'All',
    sort = 'newest',
    strategyFilter = '';
  let preferenceIdentity = '';
  let generation = 0;
  let identity = launch ? `${launch.state.owner?.toLowerCase() ?? ''}/${launch.state.account?.id ?? ''}` : '';
  client.bindWallet(launch?.state.owner);
  const originalRender = host.app.render;
  let renderedRoute = location.hash,
    renderedGeneration = generation;
  host.app.render = (options) => {
    const sameContext = renderedRoute === location.hash && renderedGeneration === generation;
    const forms =
      options?.preserve && sameContext
        ? [...document.querySelectorAll<HTMLFormElement>('#main form[data-community-form]')].filter(
            (form) => state.account && form.dataset.communityForm === 'reply',
          )
        : [];
    const active = document.activeElement;
    originalRender.call(host.app, options);
    for (const form of forms)
      document
        .querySelector(`#main form[data-community-form="${CSS.escape(form.dataset.communityForm!)}"]`)
        ?.replaceWith(form);
    if (active instanceof HTMLElement && active.isConnected && forms.some((form) => form.contains(active)))
      active.focus({ preventScroll: true });
    renderedRoute = location.hash;
    renderedGeneration = generation;
    updateBookmarks();
    const storage = document.getElementById('storage-warning');
    if (storage)
      storage.textContent =
        'Browser storage is unavailable. Your wallet notebook is stored online; local imports and transaction recovery storage are unavailable in this browser.';
  };
  const filters = () => {
    const params = new URLSearchParams({ limit: '25', sort });
    if (query) params.set('query', query);
    if (category !== 'All') params.set('category', category);
    if (strategyFilter) params.set('strategyId', strategyFilter);
    return params;
  };
  const route = () => {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    let id = '';
    try {
      id = decodeURIComponent(parts[parts[0] === 'forum' && parts[1] === 'post' ? 2 : 1] ?? '');
    } catch {
      /* Invalid links render an empty record. */
    }
    return { name: parts[0] ?? '', id, post: parts[0] === 'forum' && parts[1] === 'post' };
  };
  const render = () => {
    host.app.render({ preserve: true });
    updateBookmarks();
  };
  const applyPreferences = () => {
    if (state.account && preferenceIdentity !== state.account.wallet) {
      category = state.account.preferences.defaultForumCategory;
      sort = state.account.preferences.defaultForumSort;
      preferenceIdentity = state.account.wallet;
    }
  };
  const refresh = async (append = false) => {
    const current = route();
    if (!state.accountLoaded) {
      try {
        await client.account();
        applyPreferences();
      } catch (error) {
        state.error = communityError(error);
      }
    }
    if (current.name === 'forum') {
      if (current.post) {
        const params = new URLSearchParams({ limit: '25' });
        if (append && state.replyCursor) params.set('cursor', state.replyCursor);
        await client.load('post', current.id, '?' + params, append);
      } else {
        const params = filters();
        if (append && state.nextCursor) params.set('cursor', state.nextCursor);
        await client.load('forum', '', '?' + params, append);
      }
    } else if (current.name === 'library')
      await client.load(
        current.id ? 'strategy' : 'library',
        current.id,
        append && state.strategyCursor ? '?cursor=' + encodeURIComponent(state.strategyCursor) : '',
        append,
      );
    else if (current.name === 'account' && ['saved', 'notes', 'settings', 'creator'].includes(current.id))
      await client.load(current.id === 'creator' ? 'creator' : 'account');
    else {
      try {
        await client.account();
      } catch (error) {
        state.error = communityError(error);
      }
    }
    applyPreferences();
    render();
  };
  const ensure = (key: string) => {
    if (requested === key) return;
    requested = key;
    state.error = null;
    if (key.startsWith('post/')) {
      state.post = null;
      state.replies = [];
    }
    if (key.startsWith('strategy/')) state.strategy = null;
    state.loading = true;
    queueMicrotask(() => {
      void refresh();
    });
  };
  host.pages.forum = () => {
    ensure('forum');
    return renderForum(state, { query, category, sort });
  };
  host.pages.post = (id) => {
    ensure('post/' + id);
    return renderPost(state);
  };
  host.pages.library = (id) => {
    ensure(id ? 'strategy/' + id : 'library');
    return id ? renderStrategy(state) : renderLibrary(state);
  };
  host.pages.account = (tab) => {
    if (!['saved', 'notes', 'settings', 'creator'].includes(tab)) return originalAccount(tab);
    ensure('account/' + tab);
    return renderAccount(state, tab);
  };
  host.pages.market = () =>
    originalMarket() +
    '<div class="wrap community-library-link"><p class="small muted">Explore methods published by the community.</p><a class="text-link" href="#/library">Open strategy library ↗</a><a class="text-link" href="#/account/creator">Create a strategy ↗</a></div>';
  if (host.trade) {
    const originalContent = host.trade.content;
    host.trade.content = (strategy) =>
      host.view.tradeTab === 'discussion'
        ? `<div class="trade-reading"><span class="section-label">STRATEGY DISCUSSION</span><h2>Keep the conversation going.</h2><p>Read and publish shared research about this strategy in the community.</p><button class="outline-btn" data-community="strategy-discussions" data-id="${esc(strategy.id.toUpperCase())}">Read discussions ↗</button><button class="text-link" data-community="discuss-strategy" data-id="${esc(strategy.id.toUpperCase())}">Write a public note ✎</button></div>`
        : originalContent(strategy);
  }
  // The home remains the original composition; these exact labels now reflect the online service.
  if (host.homeHtml)
    host.homeHtml = host.homeHtml
      .replace('SAVED ON THIS DEVICE', 'SHARED ONLINE')
      .replace(
        'Your notes stay in this browser. Shared online discussions are not available yet.',
        'Share public notes in the community. Private research follows your wallet across devices.',
      );
  const nav = document.querySelector('#nav-links');
  if (nav && !nav.querySelector('[data-nav="library"]'))
    nav.insertAdjacentHTML('beforeend', '<a href="#/library" data-nav="library">Library</a>');
  const settingsLink = document.querySelector('.footer-links a[href="#/account/settings"]');
  if (settingsLink) settingsLink.textContent = 'Workspace settings';

  function updateBookmarks() {
    for (const element of document.querySelectorAll<HTMLElement>('[data-save]')) {
      const id = element.dataset.save ?? '';
      const saved =
        state.account?.preferences.savedStrategies.some(
          (value) => value.toLowerCase() === id.toLowerCase(),
        ) ?? false;
      element.setAttribute('aria-pressed', String(saved));
      const name = (element.getAttribute('aria-label') ?? 'strategy').replace(
        /^(Remove bookmark:\s*|Bookmark:\s*|Bookmark\s*)/,
        '',
      );
      element.setAttribute('aria-label', (saved ? 'Remove bookmark: ' : 'Bookmark: ') + name);
      const label = element.querySelector('span');
      if (label) label.textContent = saved ? 'Bookmarked' : 'Save this idea';
    }
  }
  const requireAccount = () => {
    if (state.account) return true;
    host.app.openDialog(
      '<h2>Your workspace follows your wallet.</h2><p>Sign in with your wallet to write, reply and save ideas across devices.</p><a class="primary-btn" href="#/account/trades" data-close-on-route>Continue with wallet ↗</a>',
    );
    return false;
  };
  const formError = (form: HTMLFormElement | null, message: string) => {
    const element = form?.querySelector('[data-community-form-error]');
    if (element) element.textContent = message;
    else {
      state.error = message;
      render();
    }
  };
  const run = async (operation: () => Promise<void>, form: HTMLFormElement | null = null) => {
    if (state.busy) return;
    const epoch = generation;
    const buttons = [
      ...(form ?? document).querySelectorAll<HTMLButtonElement>(
        'button[data-community],button[type="submit"]',
      ),
    ];
    buttons.forEach((button) => {
      button.disabled = true;
    });
    try {
      await operation();
    } catch (error) {
      if (epoch === generation)
        formError(
          form,
          error instanceof Error &&
            !(error.name === 'CommunityApiError') &&
            !/^[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : communityError(error),
        );
    } finally {
      if (epoch === generation)
        buttons
          .filter((button) => button.isConnected)
          .forEach((button) => {
            button.disabled = false;
          });
    }
  };
  const updateAccount = async (patch: unknown) => {
    const account = state.account!;
    await client.mutate('/api/community/account', 'PUT', {
      revision: account.revision,
      ...(patch as object),
    });
    await client.account();
  };
  const savedStrategy = async (id: string, remove = false) => {
    const account = state.account!;
    const old = account.preferences.savedStrategies;
    const saved = old.some((value) => value.toLowerCase() === id.toLowerCase());
    const next =
      saved || remove
        ? old.filter((value) => value.toLowerCase() !== id.toLowerCase())
        : [...old, id.toUpperCase() === 'TSLA' || id.toUpperCase() === 'AMZN' ? id.toUpperCase() : id];
    await updateAccount({ preferences: { ...account.preferences, savedStrategies: next } });
    state.notice = saved || remove ? 'Bookmark removed.' : 'Strategy saved to your wallet bookmarks.';
    render();
  };
  let importNotes: { id: string; title: string; body: string }[] = [];
  const reviewImport = () => {
    const local = host.store?.read();
    const rows = local?.posts ?? [];
    importNotes = rows
      .filter((note) => note.title.trim() && note.body.trim())
      .filter((note) => !state.account!.notes.some((online) => online.id === note.id))
      .slice(0, 50)
      .map((note) => ({ id: note.id, title: note.title, body: note.body }));
    host.app.openDialog(
      `<h2>Bring your research with you.</h2><p>Copy ${importNotes.length} device-only notes${rows.length > 50 ? ' (the first 50; import in batches)' : ''} to the private notebook for <span class="community-wallet">${esc(state.account!.wallet)}</span>. Your local originals are kept. Nothing is published publicly.</p><ul>${importNotes.map((note) => `<li>${esc(note.title)}</li>`).join('')}</ul><p class="form-error" data-community-form-error role="alert"></p><button class="primary-btn" data-community="confirm-import" ${importNotes.length ? '' : 'disabled'}>Import ${importNotes.length} private notes ↗</button>`,
    );
  };
  const confirmation = (label: string, text: string, action: string, id: string) =>
    host.app.openDialog(
      `<h2>${esc(label)}</h2><p>${esc(text)}</p><div class="dialog-actions"><button class="primary-btn" data-community="${esc(action)}" data-id="${esc(id)}">Confirm ${esc(label.toLowerCase())}</button><button class="text-link" data-close>Cancel</button></div>`,
    );

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button,a') : null;
      if (!target) return;
      const action = target.dataset.community;
      const localAction = target.dataset.action;
      if (
        !action &&
        !target.hasAttribute('data-save') &&
        !target.hasAttribute('data-open') &&
        !['compose', 'profile', 'design'].includes(localAction ?? '')
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = target.dataset.id ?? '';
      if (localAction === 'design' || target.hasAttribute('data-open')) {
        host.app.openDialog(
          '<span class="section-label">ALPHAFORGE / THE WORKSHOP</span><h2>From an idea to a clear method.</h2><p>Explore deployed PASS markets, share public research and publish a versioned strategy policy.</p><p>Your private notebook, profile, preferences and bookmarks follow your signed-in wallet across devices. Public notes and replies are shared with the community.</p><p>A published research strategy describes a method and its limits. Wallet execution requires an approved deployment. Deposits and withdrawals use your own Vault and require your wallet confirmation.</p><div class="inline-actions"><a class="text-link" href="#/library" data-close-on-route>Read strategy publications ↗</a><a class="text-link" href="#/forum" data-close-on-route>Open community ↗</a></div>',
        );
        return;
      }
      if (action === 'retry') {
        void refresh();
        return;
      }
      if (action === 'category') {
        category = target.dataset.category ?? 'All';
        void refresh();
        return;
      }
      if (action === 'more-posts' || action === 'more-replies' || action === 'more-strategies') {
        void refresh(true);
        return;
      }
      if (action === 'strategy-discussions') {
        category = 'Strategy Discussion';
        query = '';
        location.hash = '#/forum';
        // The filter is explicit and applies to the authoritative post listing.
        strategyFilter = id;
        requested = '';
        render();
        return;
      }
      if (!requireAccount()) return;
      if (target.hasAttribute('data-save')) {
        void run(() => savedStrategy(target.dataset.save ?? ''));
        return;
      }
      if (action === 'save-strategy' || action === 'remove-saved') {
        void run(() => savedStrategy(id, action === 'remove-saved'));
        return;
      }
      if (action === 'compose' || localAction === 'compose') {
        host.app.openDialog(composeDialog(state.account!.draft));
        return;
      }
      if (action === 'discuss-strategy') {
        host.app.openDialog(
          composeDialog({ title: '', body: '', category: 'Strategy Discussion', strategyId: id }),
        );
        return;
      }
      if (action === 'new-note') {
        host.app.openDialog(noteDialog());
        return;
      }
      if (action === 'edit-note') {
        host.app.openDialog(noteDialog(state.account!.notes.find((n) => n.id === id)));
        return;
      }
      if (action === 'share-note') {
        const note = state.account!.notes.find((n) => n.id === id);
        if (note)
          host.app.openDialog(
            composeDialog({
              title: note.title,
              body: note.body,
              category: 'Research Notes',
              strategyId: note.strategyId,
            }),
          );
        return;
      }
      if (action === 'edit-post') {
        if (state.post) host.app.openDialog(composeDialog(null, state.post));
        return;
      }
      if (action === 'delete-post') {
        confirmation(
          'Delete this public note?',
          'The note and its replies will be removed from the community. This cannot be undone.',
          'confirm-delete-post',
          state.post!.id,
        );
        return;
      }
      if (action === 'delete-note') {
        confirmation(
          'Delete this private note?',
          'This removes the note from your synced notebook on every device. This cannot be undone.',
          'confirm-delete-note',
          id,
        );
        return;
      }
      if (action === 'delete-reply') {
        confirmation(
          'Delete this reply?',
          'Your reply will be removed from the public conversation.',
          'confirm-delete-reply',
          id,
        );
        return;
      }
      if (action === 'edit-reply') {
        const reply = state.replies.find((r) => r.id === id);
        if (reply)
          host.app.openDialog(
            `<h2>Refine your reply.</h2><form data-community-form="edit-reply" data-id="${esc(id)}" data-revision="${reply.revision}"><label for="edit-reply-body">Your reply</label><textarea id="edit-reply-body" name="body" rows="6" minlength="2" maxlength="2000" required autofocus>${esc(reply.body)}</textarea><p class="form-error" data-community-form-error role="alert"></p><button class="primary-btn" type="submit">Save public reply ↗</button></form>`,
          );
        return;
      }
      if (action === 'new-strategy') {
        host.app.openDialog(strategyDialog());
        return;
      }
      if (action === 'edit-strategy') {
        const strategy = state.ownedStrategies.find((s) => s.id === id);
        if (strategy) host.app.openDialog(strategyDialog(strategy));
        return;
      }
      if (action === 'publish-strategy' || action === 'unpublish-strategy') {
        const strategy = state.ownedStrategies.find((s) => s.id === id);
        if (strategy)
          confirmation(
            action === 'publish-strategy' ? 'Publish this strategy version?' : 'Unlist this strategy?',
            action === 'publish-strategy'
              ? `${strategy.name}, version ${strategy.version}, will be shared publicly with its method, risks and policy. This does not deploy a PASS or start wallet execution.`
              : 'This removes the strategy from the public library. Its private draft and publication history are kept.',
            action === 'publish-strategy' ? 'confirm-publish-strategy' : 'confirm-unpublish-strategy',
            id,
          );
        return;
      }
      if (action === 'profile' || localAction === 'profile') {
        const profile = state.account!.profile;
        host.app.openDialog(
          `<h2>Your name in the workshop.</h2><form data-community-form="profile"><label for="online-name">Display name</label><input id="online-name" name="displayName" minlength="2" maxlength="40" required autofocus value="${esc(profile.displayName)}"><label for="online-bio">About you</label><textarea id="online-bio" name="bio" rows="4" maxlength="300">${esc(profile.bio)}</textarea><p class="dialog-notice">This profile is shared with your public notes and replies.</p><p class="form-error" data-community-form-error role="alert"></p><button class="primary-btn" type="submit">Save profile ↗</button></form>`,
        );
        return;
      }
      if (action === 'preferences') {
        const p = state.account!.preferences;
        host.app.openDialog(
          `<h2>Your discussion preferences.</h2><form data-community-form="preferences"><label for="preferred-category">Default section</label><select name="defaultForumCategory" id="preferred-category">${forumCategories.map((c) => `<option ${p.defaultForumCategory === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select><label for="preferred-sort">Default order</label><select name="defaultForumSort" id="preferred-sort"><option value="newest" ${p.defaultForumSort === 'newest' ? 'selected' : ''}>Latest notes</option><option value="replies" ${p.defaultForumSort === 'replies' ? 'selected' : ''}>Most replies</option></select><p class="form-error" data-community-form-error role="alert"></p><button class="primary-btn" type="submit">Save preferences ↗</button></form>`,
        );
        return;
      }
      if (action === 'signout' || action === 'signout-all') {
        confirmation(
          action === 'signout-all' ? 'Sign out all devices?' : 'Sign out of this device?',
          action === 'signout-all'
            ? 'Every device signed in to this wallet will need to sign in again. Your synced notebook is kept.'
            : 'Your synced notebook is kept. Sign in again to read it on this device.',
          action === 'signout-all' ? 'confirm-signout-all' : 'confirm-signout',
          '',
        );
        return;
      }
      if (action === 'export') {
        const blob = new Blob(
          [
            JSON.stringify(
              {
                format: 'alphaforge-notebook-v1',
                exportedAt: new Date().toISOString(),
                account: state.account,
              },
              null,
              2,
            ),
          ],
          { type: 'application/json' },
        );
        const url = URL.createObjectURL(blob),
          link = document.createElement('a');
        link.href = url;
        link.download = 'AlphaForge_notebook.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }
      if (action === 'import-local') {
        reviewImport();
        return;
      }
      if (action === 'save-draft') {
        const form = target.closest<HTMLFormElement>('form')!;
        const data = new FormData(form);
        const draft: CommunityDraft = {
          title: String(data.get('title') ?? ''),
          body: String(data.get('body') ?? ''),
          category: String(data.get('category')),
          strategyId: String(data.get('strategyId') ?? '') || null,
        };
        void run(async () => {
          await updateAccount({ draft });
          state.notice = 'Draft saved to your wallet notebook.';
          host.app.closeDialog();
          render();
        }, form);
        return;
      }
      void run(async () => {
        if (action === 'confirm-signout' || action === 'confirm-signout-all') {
          await client.mutate('/api/launch-market/wallet/logout', 'POST', {
            allDevices: action === 'confirm-signout-all',
          });
          ++generation;
          client.invalidate();
          host.app.closeDialog();
          await market?.refresh();
          state.notice = 'Signed out. Your online notebook has been kept.';
        } else if (action === 'like' || action === 'bookmark') {
          const post = state.post!;
          await client.mutate(`/api/community/posts/${encodeURIComponent(post.id)}/${action}`, 'PUT', {
            active: action === 'like' ? !post.liked : !post.bookmarked,
          });
        } else if (action === 'confirm-delete-post') {
          await client.mutate(`/api/community/posts/${encodeURIComponent(id)}`, 'DELETE', {
            revision: state.post!.revision,
          });
          host.app.closeDialog();
          location.hash = '#/forum';
        } else if (action === 'confirm-delete-note') {
          const note = state.account!.notes.find((n) => n.id === id)!;
          await client.mutate(`/api/community/notes/${encodeURIComponent(id)}`, 'DELETE', {
            revision: note.revision,
          });
          host.app.closeDialog();
        } else if (action === 'confirm-delete-reply') {
          const reply = state.replies.find((r) => r.id === id)!;
          await client.mutate(`/api/community/replies/${encodeURIComponent(id)}`, 'DELETE', {
            revision: reply.revision,
          });
          host.app.closeDialog();
        } else if (action === 'confirm-import') {
          await client.mutate('/api/community/account/import', 'POST', {
            revision: state.account!.revision,
            notes: importNotes,
          });
          host.app.closeDialog();
          state.notice = 'Your device-only notes were copied to your private notebook.';
        } else if (action === 'confirm-publish-strategy' || action === 'confirm-unpublish-strategy') {
          const strategy = state.ownedStrategies.find((s) => s.id === id)!;
          await client.mutate(
            `/api/creator/strategies/${encodeURIComponent(id)}/${action === 'confirm-publish-strategy' ? 'publish' : 'unpublish'}`,
            'POST',
            { expectedVersion: strategy.version, expectedPublicationRevision: strategy.publicationRevision },
          );
          host.app.closeDialog();
          state.notice =
            action === 'confirm-publish-strategy'
              ? 'Strategy version published to the library.'
              : 'Strategy removed from the public library.';
        }
        await refresh();
      });
    },
    true,
  );

  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-community-form')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const type = form.dataset.communityForm!,
        data = new FormData(form);
      const text = (key: string) => String(data.get(key) ?? '').trim();
      if (type === 'search') {
        query = text('query');
        sort = text('sort');
        strategyFilter = '';
        void refresh();
        return;
      }
      if (!requireAccount()) return;
      formError(form, '');
      void run(async () => {
        const id = form.dataset.id;
        if (type === 'post') {
          const result = await client.mutate<{ post: { id: string } }>(
            `/api/community/posts${id ? '/' + encodeURIComponent(id) : ''}`,
            id ? 'PUT' : 'POST',
            {
              title: text('title'),
              body: text('body'),
              category: text('category'),
              strategyId: text('strategyId') || null,
              ...(id ? { revision: Number(form.dataset.revision) } : {}),
            },
          );
          host.app.closeDialog();
          location.hash = '#/forum/post/' + encodeURIComponent(result.post.id);
        } else if (type === 'reply') {
          await client.mutate(`/api/community/posts/${encodeURIComponent(state.post!.id)}/replies`, 'POST', {
            body: text('body'),
          });
          form.reset();
        } else if (type === 'edit-reply') {
          await client.mutate(`/api/community/replies/${encodeURIComponent(id!)}`, 'PUT', {
            body: text('body'),
            revision: Number(form.dataset.revision),
          });
          host.app.closeDialog();
        } else if (type === 'note') {
          await client.mutate(
            `/api/community/notes${id ? '/' + encodeURIComponent(id) : ''}`,
            id ? 'PUT' : 'POST',
            {
              title: text('title'),
              body: text('body'),
              strategyId: text('strategyId') || null,
              ...(id ? { revision: Number(form.dataset.revision) } : {}),
            },
          );
          host.app.closeDialog();
          state.notice = 'Private note saved across your devices.';
        } else if (type === 'profile') {
          await updateAccount({ profile: { displayName: text('displayName'), bio: text('bio') } });
          host.app.closeDialog();
          state.notice = 'Wallet profile saved.';
        } else if (type === 'preferences') {
          await updateAccount({
            preferences: {
              ...state.account!.preferences,
              defaultForumCategory: text('defaultForumCategory'),
              defaultForumSort: text('defaultForumSort'),
            },
          });
          category = text('defaultForumCategory');
          sort = text('defaultForumSort');
          host.app.closeDialog();
          state.notice = 'Preferences saved.';
        } else if (type === 'strategy') {
          const fields = strategyFields(data);
          await client.mutate(
            `/api/creator/strategies${id ? '/' + encodeURIComponent(id) : ''}`,
            id ? 'PUT' : 'POST',
            { ...fields, ...(id ? { expectedVersion: Number(form.dataset.version) } : {}) },
          );
          host.app.closeDialog();
          state.notice = 'Strategy draft saved. Review it before publishing.';
        }
        await refresh();
      }, form);
    },
    true,
  );
  document.addEventListener(
    'input',
    (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.id === 'community-query') query = target.value;
    },
    true,
  );
  document.addEventListener(
    'change',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
      if (target.id === 'community-sort') sort = target.value;
      if (target.id === 'strategy-policy') {
        for (const element of target.form!.querySelectorAll<HTMLElement>('[data-policy-fields]'))
          element.hidden = element.dataset.policyFields !== target.value;
      }
      if (target instanceof HTMLInputElement && target.hasAttribute('data-community-upload')) {
        const file = target.files?.[0],
          form = target.form!;
        if (!file) return;
        void (async () => {
          try {
            if (file.size > 128 * 1024)
              throw new Error('Choose a JSON strategy document smaller than 128 KiB.');
            const value: unknown = JSON.parse(await file.text());
            if (!value || typeof value !== 'object' || Array.isArray(value))
              throw new Error('The document must contain a strategy object.');
            const document = value as Record<string, unknown>,
              policy = document.policy;
            if (
              Object.keys(document).some(
                (key) => !['name', 'symbol', 'summary', 'method', 'risks', 'policy'].includes(key),
              ) ||
              !policy ||
              typeof policy !== 'object' ||
              Array.isArray(policy)
            )
              throw new Error('Use only name, symbol, summary, method, risks and policy fields.');
            const p = policy as Record<string, unknown>;
            if (
              Object.keys(p).some(
                (key) =>
                  ![
                    'kind',
                    'allocationBps',
                    'maxSlippageBps',
                    'fastPeriod',
                    'slowPeriod',
                    'intervalDays',
                  ].includes(key),
              )
            )
              throw new Error('The policy contains unsupported fields.');
            const updates = {
              name: document.name,
              symbol: document.symbol,
              summary: document.summary,
              method: document.method,
              risks: document.risks,
              kind: p.kind,
              allocation: typeof p.allocationBps === 'number' ? p.allocationBps / 100 : '',
              slippage: typeof p.maxSlippageBps === 'number' ? p.maxSlippageBps / 100 : '',
              fastPeriod: p.fastPeriod ?? 12,
              slowPeriod: p.slowPeriod ?? 26,
              intervalDays: p.intervalDays ?? 7,
            };
            if (
              ['name', 'symbol', 'summary', 'method', 'risks'].some(
                (key) => typeof document[key] !== 'string',
              )
            )
              throw new Error('All strategy text fields are required.');
            const old = new FormData(form);
            for (const [key, val] of Object.entries(updates)) {
              const input = form.elements.namedItem(key);
              if (
                input instanceof HTMLInputElement ||
                input instanceof HTMLTextAreaElement ||
                input instanceof HTMLSelectElement
              )
                input.value = String(val ?? '');
            }
            try {
              strategyFields(new FormData(form));
              if (!form.checkValidity())
                throw new Error('The document has missing fields or values outside the supported limits.');
            } catch (error) {
              for (const [key, val] of old) {
                const input = form.elements.namedItem(key);
                if (
                  input instanceof HTMLInputElement ||
                  input instanceof HTMLTextAreaElement ||
                  input instanceof HTMLSelectElement
                )
                  input.value = String(val);
              }
              throw error;
            }
            form.querySelector('#strategy-policy')!.dispatchEvent(new Event('change', { bubbles: true }));
            formError(form, 'Document loaded. Review the fields, then save your private draft.');
          } catch (error) {
            formError(form, error instanceof Error ? error.message : 'The JSON document could not be read.');
          }
        })();
      }
    },
    true,
  );

  const attachLaunch = (nextMarket: LaunchMarketClient) => {
    market = nextMarket;
    identity = `${market.state.owner?.toLowerCase() ?? ''}/${market.state.account?.id ?? ''}`;
    client.bindWallet(market.state.owner);
    if (
      state.account &&
      market.state.owner &&
      state.account.wallet.toLowerCase() !== market.state.owner.toLowerCase()
    ) {
      ++generation;
      requested = '';
      preferenceIdentity = '';
      client.invalidate();
      host.app.closeDialog();
      render();
      void refresh();
    }
    market.subscribe((next) => {
      const current = `${next.owner?.toLowerCase() ?? ''}/${next.account?.id ?? ''}`;
      if (current !== identity) {
        identity = current;
        ++generation;
        requested = '';
        preferenceIdentity = '';
        client.invalidate();
        client.bindWallet(next.owner);
        host.app.closeDialog();
        render();
        void refresh();
      }
    });
  };
  if (launch) attachLaunch(launch);
  for (const event of ['accountsChanged', 'disconnect'] as const)
    (window as Window & { ethereum?: Eip1193Provider }).ethereum?.on(event, () => {
      ++generation;
      requested = '';
      preferenceIdentity = '';
      client.invalidate();
      host.app.closeDialog();
      render();
    });
  window.addEventListener('hashchange', () => {
    updateBookmarks();
  });
  void refresh();
  render();
  return { client, attachLaunch };
}
