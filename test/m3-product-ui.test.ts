import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asAddress, asTransactionHash } from '../packages/chain-adapter/src/types.ts';
import { ROBINHOOD_CHAIN_TESTNET } from '../packages/robinhood-chain/src/network.ts';
import {
  TRANSACTION_STATUSES,
  NETWORK_STATUSES,
  M3_CANONICAL_STRATEGY_ID,
  WALLET_STATUSES,
  extendM3ProductPages,
  renderM3AccountShell,
  renderWalletAccount,
  renderM3StrategyShell,
  renderNetworkStatus,
  onchainActionEnabled,
  transactionPresentationFromEvidence,
  transactionPresentationFromWalletSubmission,
  renderTransactionStatus,
  renderWalletStatus,
} from '../apps/web/src/m3-product-shell.ts';

const operationEvidenceDefaults = {
  receiptCanonical: true,
  chainStatus: 'INCLUDED' as const,
  l1Status: 'UNKNOWN' as const,
  finalityStatus: 'UNKNOWN' as const,
  indexerStatus: 'HEALTHY' as const,
  degradedReason: null,
};

test('My Account shows one wallet connection and unavailable holdings without exposing local balances', () => {
  const pages = extendM3ProductPages(
    { account: () => '<div>LOCAL BALANCE 10000</div>', trade: () => '' },
    { accountId: () => 'alice', contentProvenance: () => 'FIXTURE' },
  );
  const html = pages.account('trades');
  assert.match(html, /Connect Wallet/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.match(html, /ETH balance/);
  assert.match(html, /Pass holdings/);
  for (const tab of ['passes', 'saved', 'notes', 'funds', 'settings'])
    assert.match(
      html,
      new RegExp(`href="#/account/${tab}"`),
      'wallet account keeps product sections discoverable',
    );
  assert.doesNotMatch(html, /LOCAL BALANCE|alice|NOT DEPLOYED|API ACCOUNT|WALLET \/ TESTNET/);
});

test('My Account renders wallet ETH and Pass independently with an address connection button', () => {
  const chain = {
    wallet: {
      status: 'CONNECTED' as const,
      address: '0x1234567890abcdef1234567890abcdef12345678',
      ethBalanceWei: '1250000000000000001',
    },
    network: { status: 'CORRECT' as 'CORRECT' | 'WRONG', chainId: 46630 },
    transaction: { status: 'IDLE' as const },
    onchain: {
      deployment: 'CONFIGURED' as const,
      health: 'LIVE' as const,
      readiness: 'FINALITY_UNKNOWN' as const,
      owner: 'OWNER' as const,
      writeMode: 'DISABLED' as const,
      exitPath: 'UNAVAILABLE' as const,
      supportedActions: [],
      passAddress: '0x4444444444444444444444444444444444444444',
      passBalanceBaseUnits: '12000000000000000000',
    },
  };
  const pages = extendM3ProductPages(
    { account: () => '', trade: () => '' },
    { accountId: () => 'bob', contentProvenance: () => 'FIXTURE', chain: () => chain },
  );
  const html = pages.account('trades');
  assert.match(html, /0x1234…5678/);
  assert.match(html, /title="0x1234567890abcdef1234567890abcdef12345678"/);
  assert.match(html, /1\.250000000000000001/);
  assert.match(html, />12<\/strong>\s*<span>Pass/);
  assert.doesNotMatch(html, /Connect Wallet|LOCAL SIMULATION|DEPLOYED|Deposit|Withdraw/);
  chain.network.status = 'WRONG';
  const wrong = pages.account('trades');
  assert.doesNotMatch(wrong, /1\.250000000000000001|>12<\/strong>/);
  assert.match(wrong, /Switch to the configured Robinhood Chain network/);
});

test('page extension preserves the trade page without a chain diagnostics panel', () => {
  let accountId: string | null = 'alice';
  const pages = extendM3ProductPages(
    {
      account: (tab) => `<div>original account ${tab}</div>`,
      trade: (strategyId) => `<div>original trade ${strategyId}</div>`,
    },
    {
      accountId: () => accountId,
      contentProvenance: (strategyId) => (strategyId === 'trend' ? 'FIXTURE' : 'LOCAL SIMULATION'),
    },
  );

  const fixture = pages.trade('trend');
  assert.equal(fixture, '<div>original trade trend</div>');

  const local = pages.trade('core-flow-demo');
  assert.equal(local, '<div>original trade core-flow-demo</div>');

  assert.equal(pages.account('funds'), '<div>original account funds</div>');
  accountId = 'bob';
  assert.equal(pages.account('activity'), '<div>original account activity</div>');
});

test('every account subroute preserves its content without the retired diagnostic shell', () => {
  let chainReads = 0;
  const pages = extendM3ProductPages(
    { account: (tab) => `<main>account ${tab}</main>`, trade: () => '' },
    {
      accountId: () => 'alice',
      contentProvenance: () => 'FIXTURE',
      chain: () => {
        chainReads++;
        return undefined;
      },
    },
  );
  for (const tab of ['saved', 'notes', 'trials', 'funds', 'settings', 'activity']) {
    assert.equal(pages.account(tab), `<main>account ${tab}</main>`);
  }
  assert.equal(chainReads, 0, 'local account content must not acquire wallet authority');
  assert.match(pages.account('trades'), /Connect Wallet/);
  assert.equal(chainReads, 1);
});

test('strategy shell separates fixture content from unavailable Testnet capabilities', () => {
  const html = renderM3StrategyShell({
    strategyId: 'trend',
    contentProvenance: 'FIXTURE',
  });

  assert.match(html, /trend/);
  assert.match(html, /STRATEGY REFERENCE/);
  assert.doesNotMatch(html, /TESTNET|Testnet/);
  assert.match(html, /Robinhood Chain/);
  assert.match(html, new RegExp(String(ROBINHOOD_CHAIN_TESTNET.chainId)));
  assert.doesNotMatch(html, /CHAIN CONFIRMED/);
  assert.equal(M3_CANONICAL_STRATEGY_ID, 'trend');
  assert.match(html, /CANONICAL STRATEGY ID/);

  for (const action of ['Deposit', 'Withdraw', 'Approve']) {
    assert.match(html, new RegExp(`<button[^>]+disabled[^>]*>${action} · NOT IMPLEMENTED</button>`));
  }
  assert.match(html, /data-pass-transfer disabled>Transfer Pass/);
  assert.match(html, /Buy Pass · OUT OF PHASE ONE/);
  assert.match(html, /Sell Pass · OUT OF PHASE ONE/);
});

test('historical local strategy identities remain isolated from the canonical product strategy', () => {
  for (const strategyId of ['core-flow-demo', 'satellite-flow-demo']) {
    const html = renderM3StrategyShell({
      strategyId,
      contentProvenance: 'LOCAL SIMULATION',
    });
    assert.match(html, /HISTORICAL LOCAL IDENTITY/);
    assert.match(html, new RegExp(`${strategyId} remains isolated from trend`));
    assert.match(html, /Local records do not establish chain balances or ownership/);
  }
});

test('local account identity remains separate from wallet identity', () => {
  const html = renderM3AccountShell({ accountId: 'alice' });

  assert.match(html, /AlphaForge account/);
  assert.match(html, /alice/);
  assert.match(html, /LOCAL RECORDS/);
  assert.match(html, /Wallet/);
  assert.match(html, /DISCONNECTED/);
  assert.match(html, /Account and wallet are separate identities/);
});

test('every frozen wallet status has distinct human-readable output', () => {
  const messages = WALLET_STATUSES.map((status) => renderWalletStatus(status));

  assert.equal(new Set(messages).size, WALLET_STATUSES.length);
  assert.match(renderWalletStatus('CONNECTED'), /Connected/);
  assert.match(renderWalletStatus('CONNECTION_REJECTED'), /rejected/);
  assert.match(renderWalletStatus('ACCOUNT_CHANGED'), /changed/);
});

test('every required network status has distinct human-readable output', () => {
  const messages = NETWORK_STATUSES.map((status) => renderNetworkStatus(status));

  assert.equal(new Set(messages).size, NETWORK_STATUSES.length);
  assert.match(renderNetworkStatus('CORRECT'), /required Robinhood Chain network/);
  assert.match(renderNetworkStatus('WRONG'), /Wrong network/);
  assert.match(renderNetworkStatus('SWITCH_REJECTED'), /rejected/);
  assert.match(renderNetworkStatus('RPC_UNAVAILABLE'), /RPC is unavailable/);
});

test('every frozen transaction status has distinct human-readable output', () => {
  const messages = TRANSACTION_STATUSES.map((status) => renderTransactionStatus(status));

  assert.equal(new Set(messages).size, TRANSACTION_STATUSES.length);
  assert.match(renderTransactionStatus('CHAIN_CONFIRMED'), /receipt succeeded on-chain/i);
  assert.match(renderTransactionStatus('CHAIN_CONFIRMED'), /reconciliation/i);
  assert.match(renderTransactionStatus('READY'), /product state is updated/i);
  assert.doesNotMatch(renderTransactionStatus('READY'), /waiting for readback/i);
});

test('Macbeth03 operation evidence maps receipt success and product readback separately', () => {
  const base = {
    receiptCanonical: true,
    chainStatus: 'INCLUDED' as const,
    l1Status: 'UNKNOWN' as const,
    finalityStatus: 'UNKNOWN' as const,
    indexerStatus: 'HEALTHY' as const,
    degradedReason: null,

    receipt: 'SUCCESS' as const,
    confirmations: 1,
    reconciliation: 'PENDING' as const,
    projection: 'PENDING' as const,
    productReady: false,
  };

  assert.deepEqual(transactionPresentationFromEvidence({ ...base, lifecycle: 'MINED' }), {
    status: 'CHAIN_CONFIRMED',
  });
  assert.deepEqual(
    transactionPresentationFromEvidence({
      ...base,
      lifecycle: 'CONFIRMED',
      chainStatus: 'SOFT_READY',
      confirmations: 3,
      reconciliation: 'MATCHED',
    }),
    { status: 'INDEXING' },
  );
  assert.deepEqual(
    transactionPresentationFromEvidence({
      ...base,
      lifecycle: 'CONFIRMED',
      chainStatus: 'SOFT_READY',
      confirmations: 3,
      reconciliation: 'MATCHED',
      projection: 'READY',
      productReady: true,
    }),
    { status: 'READY' },
  );
});

test('reorg, reconciliation failure and stale projection never map to READY', () => {
  const failures = [
    {
      ...operationEvidenceDefaults,
      lifecycle: 'REORGED' as const,
      receiptCanonical: false,
      chainStatus: 'REORGED' as const,
      l1Status: 'UNKNOWN' as const,
      finalityStatus: 'UNKNOWN' as const,
      indexerStatus: 'HEALTHY' as const,
      degradedReason: null,
      receipt: 'SUCCESS' as const,
      confirmations: 3,
      reconciliation: 'PENDING' as const,
      projection: 'STALE' as const,
      productReady: false,
    },
    {
      ...operationEvidenceDefaults,
      lifecycle: 'RECONCILIATION_FAILED' as const,
      receiptCanonical: true,
      chainStatus: 'FAILED' as const,
      l1Status: 'UNKNOWN' as const,
      finalityStatus: 'UNKNOWN' as const,
      indexerStatus: 'HEALTHY' as const,
      degradedReason: null,
      receipt: 'SUCCESS' as const,
      confirmations: 3,
      reconciliation: 'FAILED' as const,
      projection: 'PENDING' as const,
      productReady: false,
    },
    {
      ...operationEvidenceDefaults,
      lifecycle: 'CONFIRMED' as const,
      receiptCanonical: true,
      chainStatus: 'SOFT_READY' as const,
      l1Status: 'UNKNOWN' as const,
      finalityStatus: 'UNKNOWN' as const,
      indexerStatus: 'HEALTHY' as const,
      degradedReason: null,
      receipt: 'SUCCESS' as const,
      confirmations: 3,
      reconciliation: 'MATCHED' as const,
      projection: 'STALE' as const,
      productReady: false,
    },
  ];

  for (const evidence of failures) {
    const presentation = transactionPresentationFromEvidence(evidence);
    assert.equal(presentation.status, 'FAILED');
    assert.notEqual(presentation.status, 'READY');
  }
  assert.equal(transactionPresentationFromEvidence(failures[0]!).errorCode, 'REORGED');
  assert.equal(transactionPresentationFromEvidence(failures[1]!).errorCode, 'RECONCILIATION_FAILED');
  assert.equal(transactionPresentationFromEvidence(failures[2]!).errorCode, 'PROJECTION_STALE');
});

test('failure evidence takes precedence over a contradictory productReady flag', () => {
  const contradictoryFailures = [
    {
      ...operationEvidenceDefaults,
      lifecycle: 'REORGED' as const,
      receiptCanonical: false,
      chainStatus: 'REORGED' as const,
      l1Status: 'UNKNOWN' as const,
      finalityStatus: 'UNKNOWN' as const,
      indexerStatus: 'HEALTHY' as const,
      degradedReason: null,
      receipt: 'SUCCESS' as const,
      confirmations: 3,
      reconciliation: 'MATCHED' as const,
      projection: 'READY' as const,
      productReady: true,
    },
    {
      ...operationEvidenceDefaults,
      lifecycle: 'CONFIRMED' as const,
      receiptCanonical: true,
      chainStatus: 'SOFT_READY' as const,
      l1Status: 'UNKNOWN' as const,
      finalityStatus: 'UNKNOWN' as const,
      indexerStatus: 'HEALTHY' as const,
      degradedReason: null,
      receipt: 'REVERTED' as const,
      confirmations: 3,
      reconciliation: 'MATCHED' as const,
      projection: 'READY' as const,
      productReady: true,
    },
    {
      ...operationEvidenceDefaults,
      lifecycle: 'CONFIRMED' as const,
      receiptCanonical: true,
      chainStatus: 'SOFT_READY' as const,
      l1Status: 'UNKNOWN' as const,
      finalityStatus: 'UNKNOWN' as const,
      indexerStatus: 'HEALTHY' as const,
      degradedReason: null,
      receipt: 'SUCCESS' as const,
      confirmations: 3,
      reconciliation: 'FAILED' as const,
      projection: 'READY' as const,
      productReady: true,
    },
    {
      ...operationEvidenceDefaults,
      lifecycle: 'CONFIRMED' as const,
      receiptCanonical: true,
      chainStatus: 'SOFT_READY' as const,
      l1Status: 'UNKNOWN' as const,
      finalityStatus: 'UNKNOWN' as const,
      indexerStatus: 'HEALTHY' as const,
      degradedReason: null,
      receipt: 'SUCCESS' as const,
      confirmations: 3,
      reconciliation: 'MATCHED' as const,
      projection: 'STALE' as const,
      productReady: true,
    },
  ];

  for (const evidence of contradictoryFailures) {
    assert.equal(transactionPresentationFromEvidence(evidence).status, 'FAILED');
  }
});

test('wallet submission maps submitted evidence without claiming receipt success', () => {
  const txHash = asTransactionHash(`0x${'ab'.repeat(32)}`);
  assert.deepEqual(
    transactionPresentationFromWalletSubmission({
      operationId: 'deposit-01',
      chainId: ROBINHOOD_CHAIN_TESTNET.chainId,
      owner: asAddress('0x1111111111111111111111111111111111111111'),
      target: asAddress('0x2222222222222222222222222222222222222222'),
      state: 'SUBMITTED',
      txHash,
      submittedAt: '2026-09-19T09:00:00.000Z',
    }),
    { status: 'SUBMITTED', txHash },
  );
});

test('every ambiguous wallet outcome is non-retryable and never maps to ready', () => {
  const reasons = [
    'SESSION_CHANGED',
    'POST_SUBMISSION_CHECK_FAILED',
    'PROVIDER_RESULT_UNKNOWN',
    'LOCAL_EVIDENCE_INVALID',
  ] as const;

  for (const [index, reason] of reasons.entries()) {
    const presentation = transactionPresentationFromWalletSubmission({
      operationId: `deposit-${index}`,
      requestedChainId: ROBINHOOD_CHAIN_TESTNET.chainId,
      requestedOwner: asAddress('0x1111111111111111111111111111111111111111'),
      target: asAddress('0x2222222222222222222222222222222222222222'),
      state: 'SUBMISSION_AMBIGUOUS',
      txHash: index % 2 === 0 ? asTransactionHash(`0x${'cd'.repeat(32)}`) : null,
      observedAt: index === 3 ? null : '2026-09-19T09:00:00.000Z',
      reason,
      retryable: false,
    });
    assert.equal(presentation.status, 'SUBMISSION_AMBIGUOUS');
    assert.equal(presentation.errorCode, reason);
    assert.notEqual(presentation.status, 'READY');
  }
  assert.match(renderTransactionStatus('SUBMISSION_AMBIGUOUS'), /do not retry/i);
});

test('presentation escapes route, account, address and error text', () => {
  const strategy = renderM3StrategyShell({
    strategyId: '<img src=x onerror=alert(1)>',
    contentProvenance: 'LOCAL SIMULATION',
    wallet: {
      status: 'CONNECTED',
      address: '<script>bad()</script>',
    },
    transaction: {
      status: 'FAILED',
      errorCode: '<b>REVERT</b>',
      errorMessage: '<svg onload=bad()>',
    },
  });
  const account = renderM3AccountShell({ accountId: '<iframe src=x>' });

  for (const html of [strategy, account]) {
    assert.doesNotMatch(html, /<img|<script|<svg|<iframe/);
  }
  assert.match(strategy, /&lt;img/);
  assert.match(strategy, /&lt;script/);
  assert.match(strategy, /&lt;b&gt;REVERT/);
  assert.match(account, /&lt;iframe/);
});

test('connected wallet shows full and short address and valid transaction evidence uses canonical explorer', () => {
  const address = '0x1234567890abcdef1234567890abcdef12345678';
  const txHash = `0x${'ab'.repeat(32)}`;
  const html = renderM3StrategyShell({
    strategyId: 'trend',
    contentProvenance: 'FIXTURE',
    wallet: { status: 'CONNECTED', address },
    network: { status: 'CORRECT', chainId: ROBINHOOD_CHAIN_TESTNET.chainId },
    transaction: { status: 'SUBMITTED', txHash },
  });

  assert.match(html, new RegExp(address));
  assert.match(html, /0x1234…5678/);
  assert.match(
    html,
    new RegExp(`${ROBINHOOD_CHAIN_TESTNET.explorerUrl}/tx/${txHash}`.replaceAll('/', '\\/')),
  );
  assert.match(html, /Chain ID 46630/);
});

test('invalid transaction hash is displayed as text without an explorer link', () => {
  const html = renderM3StrategyShell({
    strategyId: 'trend',
    contentProvenance: 'FIXTURE',
    transaction: { status: 'FAILED', txHash: 'javascript:alert(1)' },
  });

  assert.match(html, /javascript:alert\(1\)/);
  assert.doesNotMatch(html, /href=/);
});

test('soft-ready chain state is shown without claiming finality', () => {
  const html = renderM3StrategyShell({
    strategyId: 'trend',
    contentProvenance: 'FIXTURE',
    onchain: {
      deployment: 'CONFIGURED',
      health: 'LIVE',
      readiness: 'SOFT_READY',
      owner: 'OWNER',
      writeMode: 'INJECTED_MOCK',
      exitPath: 'LIVE_RPC',
      supportedActions: ['deposit', 'withdraw', 'close'],
    },
  });

  assert.match(html, /SOFT READY/);
  assert.match(html, /three confirmations/i);
  assert.match(html, /L1 finality remains unknown/i);
  assert.doesNotMatch(html, /finalized/i);
  assert.match(html, /Local provider reads are active/);
  assert.doesNotMatch(html, /Canonical chain reads are live/);
});

test('a newly connected owner cannot deposit without both Vault-only token allowances', () => {
  const onchain = {
    deployment: 'CONFIGURED' as const,
    health: 'LIVE' as const,
    readiness: 'SOFT_READY' as const,
    owner: 'OWNER' as const,
    writeMode: 'INJECTED_MOCK' as const,
    exitPath: 'SIMULATION' as const,
    supportedActions: ['deposit', 'withdraw', 'close'] as const,
    vaultAddress: '0x2222222222222222222222222222222222222222',
    depositAuthorization: {
      spender: '0x2222222222222222222222222222222222222222',
      afUsdcAllowanceBaseUnits: '0',
      passAllowanceBaseUnits: '0',
      approvalCapability: 'UNAVAILABLE' as const,
    },
  };
  const html = renderM3StrategyShell({
    strategyId: 'trend',
    contentProvenance: 'FIXTURE',
    onchain,
  });

  assert.equal(onchainActionEnabled(onchain, 'deposit'), false);
  assert.match(html, /AF-USDC allowance[\s\S]*0 base units/);
  assert.match(html, /Pass allowance[\s\S]*0 base units/);
  assert.match(html, /spender[\s\S]*0x2222222222222222222222222222222222222222/);
  assert.match(html, /two exact finite approvals/i);
  assert.match(html, /Approval flow is not implemented/i);
  assert.match(html, /infinite approval/i);
  assert.match(html, /data-chain-action="deposit"[^>]*disabled/);
  assert.equal(
    onchainActionEnabled(
      {
        ...onchain,
        depositAuthorization: {
          ...onchain.depositAuthorization,
          afUsdcAllowanceBaseUnits: '1',
          passAllowanceBaseUnits: '1',
        },
      },
      'deposit',
    ),
    false,
  );
});

test('configured approval capability opens Deposit review while keeping exact allowance enforcement', () => {
  const onchain = {
    deployment: 'CONFIGURED' as const,
    health: 'LIVE' as const,
    readiness: 'FINALITY_UNKNOWN' as const,
    owner: 'OWNER' as const,
    writeMode: 'LIVE_AUTHORIZED' as const,
    exitPath: 'SIMULATION' as const,
    supportedActions: ['deposit', 'withdraw', 'close'] as const,
    vaultAddress: '0x2222222222222222222222222222222222222222',
    depositAuthorization: {
      spender: '0x2222222222222222222222222222222222222222',
      afUsdcAllowanceBaseUnits: '0',
      passAllowanceBaseUnits: '0',
      approvalCapability: 'AVAILABLE' as const,
    },
  };
  const html = renderM3StrategyShell({
    strategyId: 'trend',
    contentProvenance: 'FIXTURE',
    onchain,
  });

  assert.equal(onchainActionEnabled(onchain, 'deposit'), true);
  assert.match(html, /Approve · USE DEPOSIT REVIEW/);
  assert.match(html, /approval flow is available from Deposit review/i);
  assert.doesNotMatch(html, /unlimited/i);
});

test('degraded indexer preserves owner withdraw and close through live RPC simulation', () => {
  const html = renderM3StrategyShell({
    strategyId: 'trend',
    contentProvenance: 'FIXTURE',
    onchain: {
      deployment: 'CONFIGURED',
      health: 'DEGRADED',
      readiness: 'FINALITY_UNKNOWN',
      owner: 'OWNER',
      writeMode: 'INJECTED_MOCK',
      exitPath: 'SIMULATION',
      supportedActions: ['deposit', 'withdraw', 'close'],
    },
  });

  assert.match(html, /INDEXER DEGRADED/);
  assert.match(html, /live RPC simulation/i);
  assert.match(html, /Local provider records/);
  assert.match(html, /do not authorize asset transfers/i);
  assert.match(html, /<button[^>]*data-chain-action="withdraw"[^>]*>Withdraw<\/button>/);
  assert.match(html, /<button[^>]*data-chain-action="close"[^>]*>Close<\/button>/);
  assert.match(html, /<button[^>]*data-chain-action="deposit"[^>]*disabled[^>]*>Deposit<\/button>/);
});

test('closed Vault keeps only owner post-close rescue actions available', () => {
  const onchain = {
    deployment: 'CONFIGURED' as const,
    health: 'DEGRADED' as const,
    readiness: 'FINALITY_UNKNOWN' as const,
    owner: 'OWNER' as const,
    writeMode: 'LIVE_AUTHORIZED' as const,
    exitPath: 'SIMULATION' as const,
    supportedActions: ['rescue-token', 'rescue-native'] as const,
    vaultAddress: '0x2222222222222222222222222222222222222222',
    vaultClosed: true,
  };

  for (const action of ['deposit', 'withdraw', 'close'] as const)
    assert.equal(onchainActionEnabled(onchain, action), false, action);
  assert.equal(onchainActionEnabled(onchain, 'rescue-token' as never), true);
  assert.equal(onchainActionEnabled(onchain, 'rescue-native' as never), true);

  const html = renderM3StrategyShell({ strategyId: 'trend', contentProvenance: 'FIXTURE', onchain });
  assert.match(html, /VAULT CLOSED/);
  assert.match(html, /data-chain-action="rescue-token"/);
  assert.match(html, /data-chain-action="rescue-native"/);
  assert.match(html, /Rescue untracked token/);
  assert.match(html, /Rescue native/);
});

test('configured Pass capability offers transfer while paid sale remains outside Phase One', () => {
  const html = renderM3StrategyShell({
    strategyId: 'trend',
    contentProvenance: 'FIXTURE',
    onchain: {
      deployment: 'CONFIGURED',
      health: 'LIVE',
      readiness: 'FINALITY_UNKNOWN',
      owner: 'NON_OWNER',
      writeMode: 'DISABLED',
      exitPath: 'UNAVAILABLE',
      supportedActions: [],
      passAddress: '0x4444444444444444444444444444444444444444',
      passBalanceBaseUnits: '1',
      passTransferMode: 'LIVE_AUTHORIZED',
      passInitialSupplyBaseUnits: '10000000000000000000',
      passInitialRecipient: '0x1111111111111111111111111111111111111111',
    } as never,
  });

  assert.match(html, /0x4444444444444444444444444444444444444444/);
  assert.match(html, /0\.000000000000000001 Pass/);
  assert.match(html, /1 base unit/);
  assert.match(html, /Initial Pass allocation/);
  assert.match(html, /10\.000000000000000000 Pass/);
  assert.match(html, /0x1111111111111111111111111111111111111111/);
  assert.match(html, /<button[^>]*data-pass-transfer[^>]*>Transfer Pass<\/button>/);
  assert.match(html, /Buy Pass · OUT OF PHASE ONE/);
  assert.match(html, /Sell Pass · OUT OF PHASE ONE/);
  assert.doesNotMatch(html, /Buy Pass · NOT IMPLEMENTED/);
});

test('Vault selection renders two reviewed choices while preserving a shared Pass identity', () => {
  const vaultA = asAddress('0x2222222222222222222222222222222222222222');
  const vaultB = asAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const sharedPass = '0x4444444444444444444444444444444444444444';
  const html = renderM3StrategyShell({
    strategyId: 'trend',
    contentProvenance: 'FIXTURE',
    vaultSelection: {
      selected: { chainId: 46_630, vaultAddress: vaultB },
      options: [
        { chainId: 46_630, vaultAddress: vaultA },
        { chainId: 46_630, vaultAddress: vaultB },
      ],
    },
    onchain: {
      deployment: 'CONFIGURED',
      health: 'LIVE',
      readiness: 'FINALITY_UNKNOWN',
      owner: 'OWNER',
      writeMode: 'INJECTED_MOCK',
      exitPath: 'SIMULATION',
      supportedActions: ['deposit', 'withdraw', 'close'],
      vaultAddress: vaultB,
      passAddress: sharedPass,
      passTransferMode: 'INJECTED_MOCK',
    },
  });

  assert.match(html, /data-chain-vault-select/);
  assert.match(html, new RegExp(`value="46630:${vaultA}"`));
  assert.match(html, new RegExp(`value="46630:${vaultB}" selected`));
  assert.match(html, /Reviewed deployment allowlist/);
  assert.match(html, new RegExp(sharedPass));
  assert.doesNotMatch(html, /Discover|Deploy new Vault/);
});

test('degraded indexer identifies a non-owner wallet without implying an owner exit path', () => {
  const html = renderM3StrategyShell({
    strategyId: 'trend',
    contentProvenance: 'FIXTURE',
    onchain: {
      deployment: 'CONFIGURED',
      health: 'DEGRADED',
      readiness: 'FINALITY_UNKNOWN',
      owner: 'NON_OWNER',
      writeMode: 'DISABLED',
      exitPath: 'UNAVAILABLE',
      supportedActions: ['withdraw', 'close'],
      vaultAddress: '0x2222222222222222222222222222222222222222',
    },
  });

  assert.match(html, /Current wallet is not the Vault owner; owner exits are unavailable/);
  assert.doesNotMatch(html, /Owner exit remains available/);
});

test('chain writes remain disabled without explicit write mode or wallet ownership', () => {
  for (const onchain of [
    {
      deployment: 'CONFIGURED' as const,
      health: 'LIVE' as const,
      readiness: 'SOFT_READY' as const,
      owner: 'OWNER' as const,
      writeMode: 'DISABLED' as const,
      exitPath: 'LIVE_RPC' as const,
      supportedActions: ['deposit', 'withdraw', 'close'] as const,
    },
    {
      deployment: 'CONFIGURED' as const,
      health: 'LIVE' as const,
      readiness: 'SOFT_READY' as const,
      owner: 'NON_OWNER' as const,
      writeMode: 'INJECTED_MOCK' as const,
      exitPath: 'LIVE_RPC' as const,
      supportedActions: ['deposit', 'withdraw', 'close'] as const,
    },
  ]) {
    const html = renderM3StrategyShell({
      strategyId: 'trend',
      contentProvenance: 'FIXTURE',
      onchain,
    });
    for (const action of ['deposit', 'withdraw', 'close']) {
      assert.match(html, new RegExp(`<button[^>]*data-chain-action="${action}"[^>]*disabled`));
    }
  }
});

test('reorged projection permits only owner exit actions backed by live simulation', () => {
  const html = renderM3StrategyShell({
    strategyId: 'trend',
    contentProvenance: 'FIXTURE',
    onchain: {
      deployment: 'CONFIGURED',
      health: 'LIVE',
      readiness: 'REORGED',
      owner: 'OWNER',
      writeMode: 'INJECTED_MOCK',
      exitPath: 'SIMULATION',
      supportedActions: ['deposit', 'withdraw', 'close'],
    },
  });

  assert.match(html, /data-chain-action="deposit"[^>]*disabled/);
  assert.match(html, /data-chain-action="withdraw"[^>]*>Withdraw<\/button>/);
  assert.match(html, /data-chain-action="close"[^>]*>Close<\/button>/);
});

test('wallet account reads the current address while local subroutes and trade stay free of diagnostics', () => {
  let health = 'LIVE' as 'LIVE' | 'DEGRADED';
  let walletAddress = '0x1111111111111111111111111111111111111111';
  const pages = extendM3ProductPages(
    {
      account: (tab) => `<div>account ${tab}</div>`,
      trade: (strategyId) => `<div>trade ${strategyId}</div>`,
    },
    {
      accountId: () => 'alice',
      contentProvenance: () => 'FIXTURE',
      chain: () => ({
        wallet: { status: 'CONNECTED', address: walletAddress },
        network: { status: 'CORRECT', chainId: ROBINHOOD_CHAIN_TESTNET.chainId },
        transaction: { status: 'INDEXING' },
        onchain: {
          deployment: 'CONFIGURED',
          health,
          readiness: 'SOFT_READY',
          owner: 'OWNER',
          writeMode: 'INJECTED_MOCK',
          exitPath: 'LIVE_RPC',
          supportedActions: ['deposit', 'withdraw', 'close'],
        },
      }),
    },
  );

  assert.equal(pages.trade('trend'), '<div>trade trend</div>');
  assert.equal(pages.account('funds'), '<div>account funds</div>');
  assert.match(pages.account('trades'), new RegExp(walletAddress));
  health = 'DEGRADED';
  walletAddress = '0x2222222222222222222222222222222222222222';
  assert.equal(pages.trade('trend'), '<div>trade trend</div>');
  assert.equal(pages.account('funds'), '<div>account funds</div>');
  assert.match(pages.account('trades'), new RegExp(walletAddress));
  assert.doesNotMatch(pages.account('trades'), /INDEXER DEGRADED|INDEXING|INJECTED MOCK/);
});

test('pending transaction evidence never promotes signature or confirmation to product readiness', () => {
  const base = {
    ...operationEvidenceDefaults,
    receipt: 'PENDING' as const,
    confirmations: 0,
    reconciliation: 'PENDING' as const,
    projection: 'PENDING' as const,
    productReady: false,
  };
  for (const [lifecycle, status] of [
    ['AWAITING_SIGNATURE', 'WALLET_APPROVAL_REQUIRED'],
    ['SUBMITTED', 'SUBMITTED'],
    ['MINED', 'CONFIRMING'],
  ] as const) {
    const presentation = transactionPresentationFromEvidence({ ...base, lifecycle });
    assert.equal(presentation.status, status);
    assert.equal(presentation.txHash, undefined);
    assert.notEqual(presentation.status, 'READY');
  }
});

test('message-only provider failures are escaped and explicitly lack an error code', () => {
  const html = renderM3AccountShell({
    wallet: { status: 'CONNECTION_REJECTED', errorMessage: '<script>fixture</script>' },
    transaction: { status: 'FAILED', errorMessage: 'transport & reconciliation unavailable' },
  });
  assert.equal((html.match(/UNSPECIFIED_ERROR/g) ?? []).length, 2);
  assert.match(html, /&lt;script&gt;fixture&lt;\/script&gt;/);
  assert.match(html, /transport &amp; reconciliation unavailable/);
  assert.doesNotMatch(html, /<script>/);
});

test('closed-state and owner exit capability restrict every action even if advertised by the backend', () => {
  const supportedActions = ['deposit', 'withdraw', 'close', 'rescue-token', 'rescue-native'] as const;
  const base = {
    deployment: 'CONFIGURED' as const,
    health: 'LIVE' as const,
    readiness: 'SOFT_READY' as const,
    owner: 'OWNER' as const,
    writeMode: 'INJECTED_MOCK' as const,
    supportedActions,
  };
  for (const vaultClosed of [false, true]) {
    for (const exitPath of ['LIVE_RPC', 'SIMULATION', 'UNAVAILABLE'] as const) {
      const onchain = { ...base, vaultClosed, exitPath };
      for (const action of supportedActions) {
        const rescue = action.startsWith('rescue-');
        const expected = rescue
          ? vaultClosed && exitPath !== 'UNAVAILABLE'
          : !vaultClosed && action !== 'deposit';
        assert.equal(onchainActionEnabled(onchain, action), expected, `${vaultClosed}/${exitPath}/${action}`);
      }
      const html = renderM3AccountShell({ onchain });
      assert.equal(
        html.includes('Owner-only post-close rescue remains available'),
        vaultClosed && exitPath !== 'UNAVAILABLE',
      );
    }
  }
  const degraded = renderM3AccountShell({
    onchain: { ...base, health: 'DEGRADED', exitPath: 'UNAVAILABLE' },
  });
  assert.doesNotMatch(degraded, /Owner-only post-close rescue remains available/);
  assert.match(degraded, /data-chain-action="withdraw"[^>]*disabled/);
});

test('unreviewed or cross-chain Vault selector metadata never becomes an actionable choice', () => {
  const vaultA = asAddress('0x2222222222222222222222222222222222222222');
  const vaultB = asAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const valid = { chainId: 46_630 as const, vaultAddress: vaultA };
  const options = [valid];
  const onchain = {
    deployment: 'CONFIGURED' as const,
    health: 'LIVE' as const,
    readiness: 'SOFT_READY' as const,
    owner: 'OWNER' as const,
    writeMode: 'INJECTED_MOCK' as const,
    exitPath: 'SIMULATION' as const,
    supportedActions: [] as const,
    passInitialSupplyBaseUnits: '1',
  };
  for (const selection of [
    { selected: { ...valid, chainId: 1 }, options },
    { selected: { ...valid, vaultAddress: 'bad-address' }, options },
    { selected: valid, options: [{ ...valid, chainId: 1 }] },
    { selected: valid, options: [{ ...valid, vaultAddress: 'bad-address' }] },
    { selected: { ...valid, vaultAddress: vaultB }, options },
  ]) {
    const html = renderM3AccountShell({ onchain, vaultSelection: selection as never });
    assert.doesNotMatch(html, /data-chain-vault-select/);
    assert.match(html, /Unavailable until reviewed deployment constructor values are configured/);
  }
  const pages = extendM3ProductPages(
    { account: () => '', trade: () => '' },
    {
      accountId: () => 'alice',
      contentProvenance: () => 'FIXTURE',
      chain: () => ({
        wallet: { status: 'CONNECTED' },
        network: { status: 'CORRECT' },
        transaction: { status: 'IDLE' },
        onchain,
        vaultSelection: { selected: valid, options },
      }),
    },
  );
  const account = renderM3AccountShell({ onchain, vaultSelection: { selected: valid, options } });
  assert.match(account, /data-chain-vault-select/);
  assert.match(account, new RegExp(`value="46630:${vaultA}" selected`));
  assert.doesNotMatch(pages.trade('trend'), /data-chain-vault-select/);
  assert.equal(pages.account('funds'), '');
});

test('wallet account preserves zero and wei precision and rejects invalid wallet values', () => {
  const wallet = { status: 'CONNECTED' as const, address: '0x1111111111111111111111111111111111111111' };
  const network = { status: 'CORRECT' as const, chainId: 46630 };
  for (const [raw, formatted] of [
    ['0', '0'],
    ['1', '0.000000000000000001'],
    ['1000000000000000000', '1'],
  ] as const) {
    assert.ok(
      renderWalletAccount({ wallet: { ...wallet, ethBalanceWei: raw }, network }).includes(
        `<strong>${formatted}</strong>`,
      ),
    );
  }
  for (const raw of ['-1', '01', '1.5', '<img src=x onerror=alert(1)>', (2n ** 256n).toString()]) {
    const html = renderWalletAccount({ wallet: { ...wallet, ethBalanceWei: raw }, network });
    assert.match(html, /<strong>—<\/strong>/);
    assert.doesNotMatch(html, /<img|onerror/);
  }
  for (const status of ['ACCOUNT_CHANGED', 'DISCONNECTED', 'CONNECTING'] as const) {
    const html = renderWalletAccount({
      wallet: { ...wallet, status, ethBalanceWei: '987000000000000000000' },
      network,
    });
    assert.doesNotMatch(html, /<strong>987/);
  }
  const malformed = renderWalletAccount({
    wallet: {
      status: 'CONNECTED',
      address: '<img onerror=alert(1)>',
      ethBalanceWei: '987000000000000000000',
    },
    network,
  });
  assert.match(malformed, /Connect Wallet/);
  assert.doesNotMatch(malformed, /<img|onerror|<strong>987/);
});

test('account connects a visibly mock wallet backed by the demo trading ledger', () => {
  const pages = extendM3ProductPages(
    { account: () => 'LOCAL ACCOUNT', trade: () => 'TRADE' },
    {
      accountId: () => 'bob',
      contentProvenance: () => 'FIXTURE',
      mockWallet: () => ({
        address: '0x000000000000000000000000000000000000de00',
        ethBalance: '9965.68',
        usdcBalance: '9997.5',
        holdings: [
          {
            id: 'trend',
            name: 'Ridgeline · Trend Following',
            quantity: 10,
            frozenPass: '2.5',
            availablePass: '7.5',
            allocatedUsdc: '2.5',
          },
        ],
      }),
    },
  );
  const html = pages.account('trades');
  assert.match(html, /Local wallet/);
  assert.match(html, /0x0000…de00/);
  assert.match(html, /9965\.68/);
  assert.match(html, /Ridgeline · Trend Following/);
  assert.match(html, />10<\/strong>/);
  assert.match(html, /Local balances/);
  assert.match(html, /<details[^>]*data-wallet-position="trend"/);
  assert.match(html, /<summary[^>]*wallet-pass-row/);
  assert.match(html, /data-wallet-funding-slot/);
  assert.match(html, /Use Pass/);
  assert.match(html, /Frozen \(in use\) 2\.5 · Available 7\.5/);
  assert.match(html, /Allocated 2\.5 USDC/);
  assert.match(html, /USDC · Available funds/);
  assert.match(html, /9997\.5/);
  assert.match(html, /href="#\/trade\/trend"/);
  assert.match(html, /1 strategy/);
  assert.match(html, /1 ETH = 2688 USDC/);
  assert.doesNotMatch(html, /Buy or sell Pass/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.doesNotMatch(pages.trade('trend'), /9965\.68|Mock wallet/);
});

test('Account invites an explicit Mock Wallet connection without showing local vault funds', () => {
  const pages = extendM3ProductPages(
    { account: () => 'DERICK VAULT 5000000 USDT', trade: () => '' },
    {
      accountId: () => 'derick',
      contentProvenance: () => 'FIXTURE',
      mockWallet: () => undefined,
    },
  );
  const html = pages.account('trades');
  assert.match(html, /data-wallet-choice="mock"[^>]*>[^]*Open local wallet/);
  assert.match(html, /Pass holdings/);
  assert.match(html, /Ridgeline · Prism · Echo/);
  assert.match(html, /Choose Browser Wallet/);
  assert.doesNotMatch(html, /DERICK VAULT|5000000|>2250<|API ACCOUNT/);
  assert.equal(pages.account('funds'), 'DERICK VAULT 5000000 USDT');
});

test('Pass Holdings shows a collection of independently allocated mock strategy Passes', () => {
  const pages = extendM3ProductPages(
    { account: () => 'API FUNDS', trade: () => '' },
    {
      accountId: () => 'alice',
      contentProvenance: () => 'FIXTURE',
      mockWallet: () => ({
        address: '0x000000000000000000000000000000000000de00',
        ethBalance: '10000',
        ethValueUsdc: '26880000',
        usdcBalance: '9900',
        holdings: [
          {
            id: 'trend',
            name: 'Ridgeline',
            quantity: 1000,
            frozenPass: '100',
            availablePass: '900',
            allocatedUsdc: '100',
          },
          {
            id: 'factor',
            name: 'Prism',
            quantity: 750,
            frozenPass: '0',
            availablePass: '750',
            allocatedUsdc: '0',
          },
          {
            id: 'mean',
            name: 'Echo',
            quantity: 500,
            frozenPass: '0',
            availablePass: '500',
            allocatedUsdc: '0',
          },
        ],
      }),
    },
  );
  const html = pages.account('trades');
  assert.match(html, /2,250 <span>PASS/);
  assert.match(html, /3 strategies/);
  for (const id of ['trend', 'factor', 'mean']) {
    assert.match(html, new RegExp(`data-wallet-position="${id}"`));
    assert.match(html, new RegExp(`href="#/trade/${id}"`));
  }
  assert.match(html, /Frozen \(in use\) 100 · Available 900/);
  assert.match(html, /Allocated 100 USDC/);
  assert.doesNotMatch(html, /API FUNDS|RWA|USDT/);
});

test('Mock Wallet invitation preserves the connected browser wallet presentation', () => {
  const pages = extendM3ProductPages(
    { account: () => '', trade: () => '' },
    {
      accountId: () => 'alice',
      contentProvenance: () => 'FIXTURE',
      mockWallet: () => undefined,
      chain: () => ({
        wallet: {
          status: 'CONNECTED',
          address: '0x1111111111111111111111111111111111111111',
          ethBalanceWei: '1000000000000000000',
        },
        network: { status: 'CORRECT', chainId: 46630 },
        transaction: { status: 'IDLE' },
        onchain: {
          deployment: 'UNAVAILABLE',
          health: 'UNAVAILABLE',
          readiness: 'UNKNOWN',
          owner: 'UNKNOWN',
          writeMode: 'DISABLED',
          exitPath: 'UNAVAILABLE',
          supportedActions: [],
        },
      }),
    },
  );
  const html = pages.account('trades');
  assert.match(html, /0x1111…1111/);
  assert.match(html, /<strong>1<\/strong>/);
  assert.doesNotMatch(html, /Connect Mock Wallet|Your first strategies/);
});

test('mock session persists only its connection and always reads fresh simulated balances', async () => {
  const { createMockWalletSession } = await import('../apps/web/src/mock-wallet.ts');
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
    removeItem: (key: string) => {
      stored.delete(key);
    },
  };
  let ledger: unknown = { cash: 996568, positions: { trend: { qty: 10 }, factor: { qty: 0 } } };
  const strategies = [
    { id: 'trend', name: 'Trend' },
    { id: 'factor', name: 'Factor' },
  ];
  const create = () => createMockWalletSession(() => ledger, strategies, storage);
  const session = create();
  assert.equal(session.snapshot(), undefined);
  session.connect();
  assert.equal(session.snapshot()?.ethBalance, '9965.68');
  assert.equal(session.snapshot()?.ethValueUsdc, '26787747.84');
  assert.deepEqual(session.snapshot()?.holdings, [{ id: 'trend', name: 'Trend', quantity: 10 }]);
  assert.equal(create().snapshot()?.ethBalance, '9965.68', 'reload keeps the explicit choice');
  assert.deepEqual([...stored.values()], ['connected'], 'no wallet key or private key is persisted');
  ledger = { cash: 123, positions: { trend: { qty: 2 }, factor: { qty: 3 } } };
  assert.equal(session.snapshot()?.ethBalance, '1.23');
  assert.equal(session.snapshot()?.holdings?.length, 2);
  ledger = {
    cash: 123,
    positions: { trend: { qty: 2 }, factor: { qty: 3 } },
    funding: { asset: 'USDC', cash: 1000000, allocations: { trend: 1500000, factor: 0 } },
  };
  assert.equal(session.snapshot()?.usdcBalance, '1');
  assert.equal(session.snapshot()?.holdings?.[0]?.allocatedUsdc, '1.5');
  assert.equal(session.snapshot()?.holdings?.[0]?.frozenPass, '1.5');
  assert.equal(session.snapshot()?.holdings?.[0]?.availablePass, '0.5');
  ledger = {
    cash: 123,
    positions: { trend: { qty: 2 }, factor: { qty: 3 } },
    funding: { asset: 'USDC', cash: 1000000, allocations: { trend: -1, factor: 0 } },
  };
  assert.equal(session.snapshot()?.holdings, undefined, 'damaged allocations cannot appear as zero');
  ledger = { cash: -1, positions: { trend: { qty: 100 }, factor: { qty: 0 } } };
  assert.equal(session.snapshot()?.ethBalance, undefined);
  assert.equal(session.snapshot()?.holdings, undefined, 'damaged ledger cannot fabricate balances');
  session.disconnect();
  assert.equal(session.snapshot(), undefined);
  assert.equal(create().snapshot(), undefined);
});

test('mock session works without persistent storage and keeps unknown balances unavailable', async () => {
  const { createMockWalletSession } = await import('../apps/web/src/mock-wallet.ts');
  const fail = (): never => {
    throw Error('Storage unavailable');
  };
  const session = createMockWalletSession(
    () => {
      throw Error('Unreadable ledger');
    },
    [],
    {
      getItem: fail,
      setItem: fail,
      removeItem: fail,
    },
  );
  session.connect();
  assert.match(session.snapshot()?.address ?? '', /^0x[0-9a-f]{40}$/);
  assert.equal(session.snapshot()?.ethBalance, undefined);
  session.disconnect();
  assert.equal(session.snapshot(), undefined);
});

test('USDC strategy funding freezes Pass one-to-one and preserves the ETH balance', async () => {
  const { mockExchangeFixture } = await import('./helpers/mock-exchange-fixture.ts');
  const { exchange, storage } = mockExchangeFixture();
  exchange.execute(exchange.review({ strategy: 'trend', side: 'buy', qty: 10 }));
  const before = exchange.read();
  assert.equal(exchange.fundingSnapshot('trend').maxDeposit, 10000000);
  const deposit = exchange.reviewFunding({ strategy: 'trend', kind: 'deposit', amount: 2500000 });
  assert.deepEqual(exchange.read(), before, 'review does not move money or lock Pass');
  exchange.executeFunding(deposit);
  const invested = exchange.read();
  assert.equal(invested.cash, before.cash, 'ETH cannot be spent as USDC');
  assert.equal(invested.funding.cash, before.funding.cash - 2500000);
  assert.equal(invested.funding.allocations.trend, 2500000);
  assert.deepEqual(invested.positions, before.positions, 'total Pass ownership stays unchanged');
  assert.deepEqual(
    { ...exchange.fundingSnapshot('trend') },
    {
      cash: invested.funding.cash,
      allocated: 2500000,
      passQty: 10,
      frozen: 2500000,
      available: 7500000,
      maxDeposit: 7500000,
    },
  );
  assert.equal(exchange.totals().equity, before.cash + 10 * 342);
  assert.throws(() => exchange.executeFunding(deposit));
  assert.throws(() => exchange.reviewFunding({ strategy: 'trend', kind: 'withdraw', amount: 2500001 }));
  assert.deepEqual(exchange.read(), invested, 'rejected operations preserve balances');
  const restored = mockExchangeFixture(storage.get('alphaforge.passmarket.v3')).exchange;
  assert.equal(restored.read().funding.allocations.trend, 2500000, 'allocation survives reload');
  restored.executeFunding(restored.reviewFunding({ strategy: 'trend', kind: 'withdraw', amount: 2500000 }));
  assert.equal(restored.read().cash, before.cash);
  assert.equal(restored.read().funding.cash, before.funding.cash);
  assert.equal(restored.fundingSnapshot('trend').frozen, 0);
  assert.equal(restored.fundingSnapshot('trend').available, 10000000);
  assert.deepEqual(restored.read().positions, before.positions);
});

test('strategy funding rejects missing access, invalid amounts, stale reviews and locked Pass sales', async () => {
  const { mockExchangeFixture } = await import('./helpers/mock-exchange-fixture.ts');
  const { exchange } = mockExchangeFixture();
  const request = { strategy: 'trend', kind: 'deposit', amount: 1000000 };
  assert.throws(() => exchange.reviewFunding(request), /Pass/);
  exchange.execute(exchange.review({ strategy: 'trend', side: 'buy', qty: 1 }));
  for (const amount of [0, -1, 0.1, NaN, Infinity, 1000001])
    assert.throws(() => exchange.reviewFunding({ ...request, amount }));
  assert.throws(() => exchange.reviewFunding({ ...request, strategy: 'factor' }), /Pass/);
  assert.throws(() => exchange.reviewFunding({ ...request, strategy: 'unknown' }));
  const first = exchange.reviewFunding(request);
  const stale = exchange.reviewFunding(request);
  exchange.executeFunding(first);
  const after = exchange.read();
  assert.equal(exchange.fundingSnapshot('trend').maxDeposit, 0);
  assert.throws(() => exchange.executeFunding(stale), /changed/);
  assert.throws(() => exchange.review({ strategy: 'trend', side: 'sell', qty: 1 }), /frozen/);
  assert.deepEqual(exchange.read(), after);
  const expired = exchange.reviewFunding({ strategy: 'trend', kind: 'withdraw', amount: 1 }, 1000);
  assert.throws(() => exchange.executeFunding(expired, 31000), /expired/);
  assert.deepEqual(exchange.read(), after);
  exchange.executeFunding(exchange.reviewFunding({ strategy: 'trend', kind: 'withdraw', amount: 1 }));
  assert.equal(
    exchange.fundingSnapshot('trend').available,
    1,
    'one micro-USDC releases the exact Pass fraction',
  );
  assert.equal(exchange.fundingSnapshot('trend').frozen, 999999);
  assert.throws(() => exchange.review({ strategy: 'trend', side: 'sell', qty: 1 }), /frozen/);
});

test('funding maximum is bounded by USDC balance and forged reviews cannot execute', async () => {
  const { mockExchangeFixture } = await import('./helpers/mock-exchange-fixture.ts');
  const seed = mockExchangeFixture().exchange.read();
  seed.positions.trend = { qty: 1, cost: 0 };
  seed.funding.cash = 500000;
  seed.funding.initialCapital = 500000;
  const { exchange } = mockExchangeFixture(JSON.stringify(seed));
  const before = exchange.read();
  assert.equal(exchange.fundingSnapshot('trend').maxDeposit, 500000);
  assert.throws(
    () => exchange.reviewFunding({ strategy: 'trend', kind: 'deposit', amount: 600000 }),
    /Insufficient/,
  );
  const review = exchange.reviewFunding({ strategy: 'trend', kind: 'deposit', amount: 500000 });
  assert.throws(() => exchange.executeFunding(structuredClone(review)), /Review/);
  assert.deepEqual(exchange.read(), before);
  exchange.executeFunding(review);
  assert.equal(exchange.read().funding.cash, 0);
  assert.equal(exchange.read().cash, before.cash);
  assert.equal(exchange.fundingSnapshot('trend').available, 500000);
  assert.equal(exchange.fundingSnapshot('trend').maxDeposit, 0);
});

test('legacy ETH allocation is refunded and retained without relabelling it as USDC', async () => {
  const { mockExchangeFixture } = await import('./helpers/mock-exchange-fixture.ts');
  const old = {
    version: 1,
    revision: 1,
    cash: 90000,
    initialCapital: 100000,
    realized: 0,
    fees: 0,
    positions: { trend: { qty: 10, cost: 0 }, factor: { qty: 0, cost: 0 } },
    allocations: { trend: 10000, factor: 0 },
    fundingHistory: [],
    orders: [],
    executed: [],
  };
  const { exchange, storage } = mockExchangeFixture(JSON.stringify(old));
  assert.equal(exchange.read().cash, 100000);
  assert.equal(exchange.read().legacyEthFunding?.refunded, 10000);
  assert.equal(exchange.read().legacyEthFunding?.allocations.trend, 10000);
  assert.equal(exchange.read().funding.allocations.trend, 0);
  assert.equal(exchange.fundingSnapshot('trend').maxDeposit, 10000000);
  exchange.executeFunding(exchange.reviewFunding({ strategy: 'trend', kind: 'deposit', amount: 10000000 }));
  const restored = mockExchangeFixture(storage.get('alphaforge.passmarket.v3')).exchange;
  assert.equal(restored.read().cash, 100000, 'migration refunds exactly once');
  assert.equal(restored.fundingSnapshot('trend').frozen, 10000000);
  assert.equal(restored.fundingSnapshot('trend').available, 0);
  restored.executeFunding(restored.reviewFunding({ strategy: 'trend', kind: 'withdraw', amount: 2000000 }));
  restored.execute(restored.review({ strategy: 'trend', side: 'sell', qty: 2 }));
  assert.equal(restored.read().positions.trend?.qty, 8);
  assert.equal(restored.fundingSnapshot('trend').frozen, 8000000);
});

test('strategy funding does not overwrite storage damaged after review', async () => {
  const { mockExchangeFixture } = await import('./helpers/mock-exchange-fixture.ts');
  const { exchange, storage } = mockExchangeFixture();
  exchange.execute(exchange.review({ strategy: 'trend', side: 'buy', qty: 1 }));
  const before = exchange.read();
  const reviewed = exchange.reviewFunding({ strategy: 'trend', kind: 'deposit', amount: 1000 });
  storage.set('alphaforge.passmarket.v3', '{damaged');
  assert.throws(() => exchange.executeFunding(reviewed), /unreadable/);
  assert.deepEqual(exchange.read(), before);
  assert.equal(storage.get('alphaforge.passmarket.v3'), '{damaged');
});
