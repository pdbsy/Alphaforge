const retiredPages = new Set([
  'automation',
  'executor',
  'authorize',
  'authorization',
  'market-data',
  'deployment',
  'testnet',
  'automata',
  'reference-paper',
]);

/** Retired setup links return to the account without opening a signing workflow. */
export function productPageRedirect(hash: string): string | null {
  let parts: string[];
  try {
    parts = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  const page = parts[0] === 'account' ? parts[1] : parts[0];
  return retiredPages.has(page ?? '') ? '#/account/trades' : null;
}

export function installProductPageCleanup(render: () => void): void {
  const redirect = () => {
    const next = productPageRedirect(location.hash);
    if (!next) return;
    history.replaceState(history.state, '', next);
    render();
  };
  window.addEventListener('hashchange', redirect);
  redirect();
}
