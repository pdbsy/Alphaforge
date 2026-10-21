import './deployment.css';
import { DEPLOYMENT_APPROVAL } from './deployment-approval.ts';
import { runDeploymentSequence } from './deployment-runner.ts';
import {
  DEPLOYMENT_ADMIN,
  DeploymentWalletSession,
  loadPinnedDeploymentPayload,
  withDeploymentWalletLock,
  type DeploymentAction,
  type DeploymentPayload,
  type DeploymentProvider,
} from './deployment-wallet.ts';

const app = document.querySelector<HTMLElement>('#deployment-app');
if (!app) throw new Error('DEPLOYMENT_ROOT_REQUIRED');
const root: HTMLElement = app;
const storageKey = 'alphaforge:deployment:46630:' + DEPLOYMENT_APPROVAL.payloadSha256;
let payload: DeploymentPayload | null = null;
let session: DeploymentWalletSession | null = null;
let provider: DeploymentProvider | undefined;
let lastWalletHash: string | null = null;
let busy = false;
let connected = false;
let verified = false;
let notice = 'Load and verify the approved plan before connecting your wallet.';
let error = false;
let recoveryHash: string | null = null;
let recoveryFeedback = '';
let recoveryError = false;
let continuousRun: AbortController | null = null;
const esc = (value: unknown): string =>
  String(value).replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
function failureMessage(caught: unknown, fallback: string): string {
  if (!(caught instanceof Error)) return fallback;
  if (caught.message === 'DEPLOYMENT_CONTINUOUS_STOPPED')
    return 'Continuous deployment stopped. Any submitted transaction remains saved. Check its confirmations before continuing.';
  if (caught.message === 'DEPLOYMENT_CONTINUOUS_TAB_HIDDEN')
    return 'Continuous deployment stopped because this tab was hidden. Any submitted transaction remains saved. Return to this tab and check confirmations before continuing.';
  if (caught.message === 'DEPLOYMENT_CONTINUOUS_WALLET_CHANGED')
    return 'Continuous deployment stopped because the wallet or network changed. Reconnect the approved wallet and check the saved transaction.';
  if (caught.message === 'DEPLOYMENT_SEQUENCE_CONFIRMATION_TIMEOUT')
    return 'Confirmation is taking longer than expected. The transaction remains saved; check confirmations before continuing.';
  if (caught.message === 'DEPLOYMENT_SEQUENCE_RECOVERY_REQUIRED')
    return 'Continuous deployment stopped because a saved transaction needs recovery. Verify its actual wallet hash before continuing.';
  if (caught.message === 'DEPLOYMENT_READ_RPC_UNAVAILABLE')
    return `Could not read Robinhood Chain. Keep the saved transaction and try checking confirmations again. Error detail: ${caught.message}`;
  if (caught.message.startsWith('DEPLOYMENT_READ_RPC_'))
    return `The chain query could not be verified. Keep the saved transaction; verification has not advanced. Error detail: ${caught.message}`;
  if (caught.message.startsWith('INVALID_WALLET_RPC_RESPONSE:'))
    return `The chain query returned incomplete or invalid data. Keep the saved transaction; verification has not advanced. Error detail: ${caught.message}`;
  return caught.message;
}
function amount(value: string, decimals: number): string {
  const number = BigInt(value),
    divisor = 10n ** BigInt(decimals),
    fraction = (number % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (number / divisor).toString() + (fraction ? '.' + fraction : '');
}
function label(address: string): string {
  if (!payload) return address;
  const key = Object.entries(payload.plan.addresses).find(
    ([, value]) => value.toLowerCase() === address.toLowerCase(),
  )?.[0];
  return key === 'usdc'
    ? 'AF-USDC'
    : key === 'tslaPass'
      ? 'TSLA PASS'
      : key === 'amznPass'
        ? 'AMZN PASS'
        : key?.endsWith('Stock')
          ? key.replace('Stock', ' stock units')
          : (key ?? address);
}
function movement(action: DeploymentAction): string {
  if (!action.inputAssets.length) return 'No asset transfer';
  return action.inputAssets
    .map((asset, index) => {
      const name = asset === 'native ETH' ? 'ETH' : label(asset);
      const decimals = name === 'AF-USDC' ? 6 : 18;
      return amount(action.inputAmounts[index]!, decimals) + ' ' + name;
    })
    .join(' + ');
}
function progressNotice(ready: string): string {
  const pending = session?.journal.entries.find((entry) => entry.state !== 'CONFIRMED');
  if (pending?.state === 'SUBMITTED')
    return 'Transaction submitted. Waiting for the wallet and chain to synchronize. Click Check chain confirmations; keep this transaction instead of signing it again.';
  if (pending?.state === 'INCLUDED')
    return 'Transaction included. Click Check chain confirmations after 3 L2 blocks, including the inclusion block, before the next signature.';
  if (pending)
    return 'The saved transaction needs verification. Check chain confirmations or recover its actual wallet transaction hash before continuing.';
  return ready;
}
function render() {
  const entries = session?.journal.entries ?? [];
  const next = session?.nextIndex ?? 0;
  const current = session?.actions[next];
  const needsRecovery = entries.some((entry) => entry.state !== 'CONFIRMED');
  const savedRecoveryHash = entries.find((entry) => entry.state !== 'CONFIRMED')?.transactionHash ?? null;
  const complete = verified && entries.length === 41 && entries.every((entry) => entry.state === 'CONFIRMED');
  const blockedRecovery = entries.some(
    (entry) =>
      entry.state !== 'CONFIRMED' &&
      (!entry.transactionHash || !['SUBMITTED', 'INCLUDED'].includes(entry.state)),
  );
  root.innerHTML = `<header class="deployment-header"><a class="deployment-brand" href="./#/home">AlphaForge</a><span class="deployment-label">ROBINHOOD CHAIN · ADMINISTRATOR</span></header>
    <main><p class="deployment-label">APPROVED DEPLOYMENT / 46630</p><h1>Launch the market.</h1>
    <p class="deployment-lede">Connect your approved wallet → start the remaining steps → approve each transaction in your wallet. This page checks confirmations and continues automatically.</p>
    <section class="deployment-card"><h2>Ownership & funding</h2><dl>
      <div><dt>Deployer / administrator</dt><dd class="deployment-address">${DEPLOYMENT_ADMIN}</dd></div>
      <div><dt>TSLA & AMZN LP recipient</dt><dd class="deployment-address">${DEPLOYMENT_ADMIN}</dd></div>
      <div><dt>Subscription recipient</dt><dd class="deployment-address">${DEPLOYMENT_ADMIN}</dd></div>
      <div><dt>AF-USDC fixed supply</dt><dd>2,000,000 AF-USDC</dd></div>
      <div><dt>Conversion reserve</dt><dd>100,000 AF-USDC + 0.002 ETH</dd></div>
      <div><dt>Claim / TSLA LP / AMZN LP</dt><dd>100,000 / 250,000 / 250,000 AF-USDC</dd></div>
      <div><dt>ETH output limits</dt><dd>0.0002 per transaction · 0.001 per account/day · 0.0016 total/day</dd></div>
      <div><dt>ETH reserve minimum</dt><dd>0.0002 ETH</dd></div>
      <div><dt>Fees</dt><dd>AMM 0.30% to pool · Conversion 0% · Mint 0%</dd></div>
      ${
        payload
          ? `<div><dt>Independent stock reserves</dt><dd>${esc(amount(String(payload.plan.inputs.stockReserveUsdcRaw), 6))} AF-USDC per strategy</dd></div>
      <div><dt>Quote / claim signers</dt><dd class="deployment-address">${esc(payload.plan.inputs.quoteSigner)}<br>${esc(payload.plan.inputs.claimSigner)}</dd></div>
      <div><dt>Gas budget</dt><dd>Up to ${esc(amount(payload.budget.maxTotalGasCostWei, 18))} ETH total; ${esc(payload.budget.maxGasPerTransactionRaw)} gas per step</dd></div>
      <div><dt>Gas fee cap / tip</dt><dd>${esc(payload.budget.maxFeePerGasRaw)} / ${esc(payload.budget.maxPriorityFeePerGasRaw)} wei per gas</dd></div>
      <div><dt>Wallet retained balance</dt><dd>At least ${esc(amount(payload.budget.minimumRemainingEthRaw, 18))} ETH</dd></div>
      <div><dt>Plan signing window</dt><dd>${esc(new Date(payload.approvalExpiresAt * 1000).toISOString())}</dd></div>`
          : ''
      }
    </dl><p class="deployment-note">Asset values are not guaranteed. Connected user wallets retain their user role.</p></section>
    <section class="deployment-card"><div class="deployment-step-top"><h2>${complete ? 'Wallet transactions confirmed' : `Step ${Math.min(next + 1, 41)} / 41`}</h2><span>${verified ? entries.filter((entry) => entry.state === 'CONFIRMED').length + ' confirmed' : 'Chain verification required'}</span></div>
      <p class="deployment-feedback${error ? ' deployment-error' : ''}" role="status" aria-live="polite">${esc(notice)}</p>
      ${
        current
          ? `<h3>${esc(current.operation)}</h3><dl><div><dt>Function</dt><dd>${esc(current.function)}</dd></div>
      <div><dt>From</dt><dd class="deployment-address">${DEPLOYMENT_ADMIN}</dd></div>
      <div><dt>Asset movement</dt><dd>${esc(movement(current))}</dd></div>
      <div><dt>Recipient</dt><dd class="deployment-address">${esc(current.recipient)}</dd></div>
      <div><dt>Contract</dt><dd class="deployment-address">${esc(current.contractAddress)}</dd></div>
      <div><dt>Nonce / native value</dt><dd>${next} / ${esc(amount(current.unsigned!.value, 18))} ETH</dd></div></dl>
      <details><summary>Expected result & exact calldata</summary><pre>${esc(JSON.stringify(current.expectedOutput, null, 2))}</pre><pre>${esc(current.unsigned!.data)}</pre></details>`
          : ''
      }
      <div class="deployment-actions"><button class="${!connected ? 'deployment-primary' : ''}" data-connect ${busy || !session ? 'disabled' : ''}>${connected ? 'Reconnect approved wallet' : 'Connect approved wallet'}</button>
      <button class="${connected && needsRecovery ? 'deployment-primary' : ''}" data-check ${busy || !connected ? 'disabled' : ''}>Check chain confirmations</button>
      <button data-send ${busy || !connected || !verified || needsRecovery || complete ? 'disabled' : ''}>Review & sign this step</button></div>
      <div class="deployment-actions"><button class="deployment-primary" data-continue ${busy || !connected || !verified || blockedRecovery || complete ? 'disabled' : ''}>Start remaining steps</button>
      ${continuousRun ? `<button data-stop ${continuousRun.signal.aborted ? 'disabled' : ''}>${continuousRun.signal.aborted ? 'Stopping after current request…' : 'Stop continuing'}</button>` : ''}</div>
      <p class="deployment-note">Start once; approve each transaction in Phantom or your connected wallet. Keep this tab visible. Each successful step waits for chain confirmation before the next wallet request. Stop prevents further requests; an open wallet approval or an already submitted transaction must still be handled in your wallet. Reloading never resumes signing automatically.</p>
      <p class="deployment-note">Chain verification reads directly from the official Robinhood Chain interface. Your wallet signs and broadcasts each approved step.</p>
      <p class="deployment-note">A step advances after its transaction matches the plan, succeeds, and has 3 L2 blocks including its inclusion block. This does not mean L1 finality. Check confirmations after the wallet submits. Keep the displayed gas and fee values.</p>
      <p class="deployment-note">Open this workflow in one tab. The wallet handles each approval and broadcasts it itself. If an approval remains open past the signing window, reject it in your wallet. After a rejected or uncertain result, stop and check your wallet before continuing.</p>
      ${complete ? '<p>Server activation still requires actual contract, balance, pool, and permission verification. These wallet receipts alone do not mark the market live.</p>' : ''}
      <div class="deployment-actions"><button data-download ${busy || !complete ? 'disabled' : ''}>Download verification receipts</button><button data-copy ${busy || !complete ? 'disabled' : ''}>Copy transaction hashes</button></div>
      <details${needsRecovery || recoveryFeedback ? ' open' : ''}><summary>Recover an uncertain wallet result</summary><p>Use the actual transaction hash from your wallet. This only checks the chain; it never sends another transaction.</p>
      <label for="deployment-recovery">Transaction hash</label><input id="deployment-recovery" autocomplete="off" spellcheck="false" placeholder="0x…" maxlength="66" value="${esc(recoveryHash ?? savedRecoveryHash ?? '')}" aria-invalid="${recoveryError}" aria-describedby="deployment-recovery-feedback"><div class="deployment-actions"><button data-recover ${busy || !connected || !needsRecovery ? 'disabled' : ''}>Verify this hash</button><button data-use-hash ${busy || !savedRecoveryHash ? 'disabled' : ''}>Use saved transaction hash</button></div>
      <p id="deployment-recovery-feedback" role="status" aria-live="polite" class="deployment-feedback${recoveryError ? ' deployment-error' : ''}" ${recoveryFeedback ? '' : 'hidden'}>${esc(recoveryFeedback)}</p>
      ${lastWalletHash || session?.lastObservedHash || savedRecoveryHash ? `<p>Last wallet hash: <span class="deployment-address">${esc(lastWalletHash ?? session?.lastObservedHash ?? savedRecoveryHash)}</span></p>` : ''}</details>
    </section>
    <section class="deployment-card"><h2>Approved sequence</h2><ol class="deployment-sequence">${
      session
        ? session.actions
            .map((action, index) => {
              const entry = entries[index];
              return `<li><div><strong>${esc(action.operation)}</strong><span>${entry ? esc((verified ? '' : 'Saved hint: ') + entry.state) : 'NOT SIGNED'}</span></div><p>${esc(movement(action))} → <span class="deployment-address">${esc(action.recipient)}</span></p>${entry?.transactionHash ? `<p class="deployment-address">${esc(entry.transactionHash)}</p>` : ''}</li>`;
            })
            .join('')
        : '<li>Loading verified plan…</li>'
    }</ol>
    <p class="deployment-note">Fresh stock references are separate unsigned tasks. They require a real source and an open US trading session; this page does not invent prices.</p></section>
    <footer>Approved payload SHA-256: <span class="deployment-address">${esc(DEPLOYMENT_APPROVAL.payloadSha256)}</span></footer></main>`;
  root.querySelector('[data-connect]')?.addEventListener(
    'click',
    () =>
      void action(async () => {
        await session!.connect();
        connected = true;
        await session!.reconcile();
        verified = true;
        return progressNotice(
          'Approved wallet connected. Review the next step or check the saved transaction.',
        );
      }),
  );
  root.querySelector('[data-check]')?.addEventListener(
    'click',
    () =>
      void action(async () => {
        await session!.reconcile();
        verified = true;
        return progressNotice('Chain receipts checked. The next unsigned step is ready for review.');
      }),
  );
  root.querySelector('[data-send]')?.addEventListener(
    'click',
    () =>
      void action(async () => {
        recoveryHash = null;
        recoveryFeedback = '';
        recoveryError = false;
        await session!.sendNext();
        verified = true;
        return progressNotice('Wallet transaction confirmed. The next unsigned step is ready for review.');
      }),
  );
  root.querySelector('[data-continue]')?.addEventListener('click', () => {
    if (busy || !connected || !verified || blockedRecovery || complete) return;
    continuousRun = new AbortController();
    const controller = continuousRun;
    void action(async () => {
      recoveryHash = null;
      recoveryFeedback = '';
      recoveryError = false;
      await runDeploymentSequence({
        session: session!,
        signal: controller.signal,
        onProgress: async (progress) => {
          if (progress.phase !== 'COMPLETED' && Date.now() / 1000 >= payload!.approvalExpiresAt)
            throw new Error('DEPLOYMENT_APPROVAL_EXPIRED');
          verified = progress.phase !== 'VERIFYING';
          lastWalletHash = session?.lastObservedHash ?? lastWalletHash;
          notice =
            progress.phase === 'VERIFYING'
              ? 'Checking saved transactions before continuing…'
              : progress.phase === 'AWAITING_WALLET'
                ? `Review step ${progress.nextIndex + 1} / ${progress.total} below, then approve it in your wallet. You can stop before further wallet requests.`
                : progress.phase === 'WAITING_CONFIRMATIONS'
                  ? `Waiting for step ${progress.nextIndex + 1} / ${progress.total} to confirm on chain. The next wallet request opens automatically after verification.`
                  : 'All approved wallet transactions confirmed.';
          render();
          // Paint the next operation and asset movement before its wallet request.
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        },
      });
      verified = true;
      return 'All approved wallet transactions confirmed. Download the receipts for server activation verification.';
    });
  });
  root.querySelector('[data-stop]')?.addEventListener('click', () => {
    continuousRun?.abort(new Error('DEPLOYMENT_CONTINUOUS_STOPPED'));
    notice =
      'Stopping further wallet requests. If a wallet approval is already open, finish or reject it in your wallet; its result will remain saved.';
    render();
  });
  root.querySelector('[data-recover]')?.addEventListener('click', () => {
    if (busy) return;
    const transactionHash = root.querySelector<HTMLInputElement>('#deployment-recovery')?.value.trim() ?? '';
    recoveryHash = transactionHash;
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
      recoveryError = true;
      recoveryFeedback =
        'Enter the full transaction hash shown below. A wallet or contract address cannot verify a transaction. You can use the saved transaction hash.';
      render();
      root.querySelector<HTMLInputElement>('#deployment-recovery')?.focus();
      return;
    }
    recoveryError = false;
    recoveryFeedback = 'Checking the existing transaction on chain…';
    void action(async () => {
      try {
        await session!.recover(transactionHash);
        verified = true;
        recoveryFeedback = progressNotice(
          'Saved transaction verified. Continue with the next unsigned step.',
        );
        return recoveryFeedback;
      } catch (caught) {
        recoveryError = true;
        recoveryFeedback = failureMessage(
          caught,
          'The transaction could not be verified. Keep the saved transaction and check again.',
        );
        throw caught;
      }
    });
  });
  root.querySelector('[data-use-hash]')?.addEventListener('click', () => {
    if (busy) return;
    recoveryHash = savedRecoveryHash;
    recoveryError = false;
    recoveryFeedback =
      'Saved transaction hash selected. Click Verify this hash to check its existing receipt.';
    render();
    root.querySelector<HTMLInputElement>('#deployment-recovery')?.focus();
  });
  root.querySelector('[data-download]')?.addEventListener(
    'click',
    () =>
      void action(async () => {
        await session!.reconcile();
        verified = true;
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(session!.verificationReceipts(), null, 2) + '\n'], {
            type: 'application/json',
          }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = 'alphaforge-wallet-verification.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return 'All 41 actual transaction hashes downloaded for server verification.';
      }),
  );
  root.querySelector('[data-copy]')?.addEventListener(
    'click',
    () =>
      void action(async () => {
        await session!.reconcile();
        verified = true;
        await navigator.clipboard.writeText(JSON.stringify(session!.verificationReceipts(), null, 2));
        return 'All 41 verified transaction hashes copied with their approval digest.';
      }),
  );
}
function reloadDurableSession() {
  if (!provider || !payload) throw new Error('DEPLOYMENT_WALLET_UNAVAILABLE');
  const saved = localStorage.getItem(storageKey);
  session = new DeploymentWalletSession({
    provider,
    payload,
    payloadSha256: DEPLOYMENT_APPROVAL.payloadSha256,
    save: (journal) => localStorage.setItem(storageKey, JSON.stringify(journal)),
    ...(saved ? { journal: JSON.parse(saved) as unknown } : {}),
  });
}
async function action(work: () => Promise<string>) {
  if (busy) return;
  busy = true;
  error = false;
  notice = 'Checking the approved wallet and chain…';
  render();
  try {
    notice = await withDeploymentWalletLock(navigator.locks, async () => {
      // Every tab must reload durable intent while it owns the global chain + wallet lock.
      reloadDurableSession();
      verified = false;
      try {
        return await work();
      } finally {
        lastWalletHash = session?.lastObservedHash ?? lastWalletHash;
      }
    });
  } catch (caught) {
    verified = false;
    error = true;
    notice = failureMessage(caught, 'Wallet or chain request failed. Stop and check the actual transaction.');
  } finally {
    continuousRun = null;
    busy = false;
    render();
  }
}
render();
try {
  payload = await loadPinnedDeploymentPayload(
    DEPLOYMENT_APPROVAL.payloadUrl,
    DEPLOYMENT_APPROVAL.payloadSha256,
  );
  const wallets = window as unknown as {
    ethereum?: DeploymentProvider;
    phantom?: { ethereum?: DeploymentProvider };
  };
  provider = wallets.phantom?.ethereum ?? wallets.ethereum;
  if (!provider) throw new Error('Install or open your Ethereum wallet to continue.');
  if (!navigator.locks)
    throw new Error(
      'This browser cannot coordinate wallet requests safely. Use a current browser that supports Web Locks.',
    );
  reloadDurableSession();
  const walletChanged = () => {
    continuousRun?.abort(new Error('DEPLOYMENT_CONTINUOUS_WALLET_CHANGED'));
    connected = false;
    verified = false;
    notice = 'Wallet or network changed. Reconnect the approved wallet on Robinhood Chain.';
    render();
  };
  provider.on?.('accountsChanged', walletChanged);
  provider.on?.('chainChanged', walletChanged);
  provider.on?.('disconnect', walletChanged);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && continuousRun) {
      continuousRun.abort(new Error('DEPLOYMENT_CONTINUOUS_TAB_HIDDEN'));
      notice = failureMessage(continuousRun.signal.reason, 'Continuous deployment stopped.');
      render();
    }
  });
  window.addEventListener('pagehide', () => {
    continuousRun?.abort(new Error('DEPLOYMENT_CONTINUOUS_TAB_HIDDEN'));
  });
  notice = 'Approved plan verified. Connect 0x8676…64cf on Robinhood Chain (46630).';
} catch (caught) {
  error = true;
  notice = caught instanceof Error ? caught.message : 'The approved deployment plan could not be verified.';
}
render();
