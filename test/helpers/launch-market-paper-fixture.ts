import type { PaperLedgerValue } from '../../packages/launch-market/src/paper-ledger.ts';
import type { LaunchClientState, LaunchWallet } from '../../apps/web/src/launch-market/model.ts';
import { account, config, wallet, snapshot, OWNER, NOW, BLOCK, HASH } from './launch-market-ui-fixture.ts';

export const PAPER_VAULT = '0x3333333333333333333333333333333333333333';
export const CLOSED_PAPER_VAULT = '0x4444444444444444444444444444444444444444';
export function paperValue(vault = PAPER_VAULT): PaperLedgerValue {
  return {
    schemaVersion: 2,
    executionMode: 'PAPER',
    owner: OWNER,
    strategyId: 'TSLA',
    vault,
    paused: false,
    closedVaults: [],
    real: {
      principalRaw: '10000000',
      cashRaw: '10000000',
      withdrawableRaw: '10000000',
      lockedPassRaw: '10000000000000000000',
      observedAt: NOW,
      blockNumber: '100',
      blockHash: BLOCK,
      confirmations: 3,
    },
    paper: {
      status: 'EMPTY',
      contributedRaw: '0',
      allocatedPrincipalRaw: '0',
      costBasisRaw: '0',
      quantityRaw: '0',
      idleRaw: '0',
      equityRaw: null,
      realizedRaw: null,
      unrealizedRaw: null,
      profitRaw: null,
      returnBps: null,
      history: [],
      curve: [],
      observedAt: NOW,
      priceObservedAt: null,
      quoteStatus: 'UNAVAILABLE',
      marketSession: 'UNKNOWN',
      sourceId: null,
    },
  };
}
export function paperVault(
  address = PAPER_VAULT,
  status: 'OPEN' | 'CLOSED' = 'OPEN',
): LaunchWallet['vaults'][number] {
  return {
    address,
    strategyId: 'TSLA',
    status,
    principalBasisRaw: status === 'CLOSED' ? '0' : '10000000',
    cashRaw: status === 'CLOSED' ? '0' : '10000000',
    lockedPassRaw: status === 'CLOSED' ? '0' : '10000000000000000000',
    holdings: [],
    equityRaw: status === 'CLOSED' ? '0' : '10000000',
    unrealizedPnlRaw: null,
    realizedPnlRaw: '0',
    withdrawableProfitRaw: '0',
    withdrawablePrincipalRaw: status === 'CLOSED' ? '0' : '10000000',
    valuationState: 'FRESH',
  };
}
export function paperState(): LaunchClientState {
  return {
    enabled: true,
    owner: OWNER,
    account: account(),
    wallet: { ...wallet(), vaults: [paperVault()] },
    snapshot: snapshot(),
    config: config(),
    connecting: false,
    busy: false,
    quote: null,
    quoteRequest: null,
    error: null,
    notice: null,
    transaction: { state: 'IDLE', owner: null, hash: null, id: null, approval: false, confirmations: 0 },
  };
}
export function pricedPaper(value = paperValue()): PaperLedgerValue {
  return {
    ...value,
    paper: {
      ...value.paper,
      status: 'OPEN',
      contributedRaw: '10000000',
      allocatedPrincipalRaw: '10000000',
      costBasisRaw: '10000000',
      quantityRaw: '1000000000000000000',
      equityRaw: '8000000',
      profitRaw: '-2000000',
      unrealizedRaw: '-2000000',
      returnBps: '-2000',
      quoteStatus: 'FRESH',
      marketSession: 'OPEN',
      sourceId: 'ALPACA_IEX',
      priceObservedAt: NOW - 2,
      history: [
        {
          eventId: 'entry',
          kind: 'ENTRY',
          transactionHash: HASH,
          blockHash: BLOCK,
          at: NOW - 10,
          amountRaw: '10000000',
          quantityRaw: '1000000000000000000',
          priceRaw: '10000000',
          priceObservedAt: NOW - 11,
          sourceId: 'ALPACA_IEX',
          profitRaw: null,
        },
      ],
      curve: [
        { at: NOW - 10, contributedRaw: '10000000', equityRaw: '10000000', profitRaw: '0' },
        { at: NOW, contributedRaw: '10000000', equityRaw: '8000000', profitRaw: '-2000000' },
      ],
    },
  };
}
export function closedPaper(): PaperLedgerValue {
  const value = pricedPaper(paperValue(CLOSED_PAPER_VAULT));
  return {
    ...value,
    real: { ...value.real, cashRaw: '0', principalRaw: '0', withdrawableRaw: '0', lockedPassRaw: '0' },
    paper: {
      ...value.paper,
      status: 'CLOSED',
      allocatedPrincipalRaw: '0',
      quantityRaw: '0',
      equityRaw: '12000000',
      realizedRaw: '2000000',
      unrealizedRaw: null,
      profitRaw: '2000000',
      returnBps: '2000',
      curve: [{ at: NOW, contributedRaw: '10000000', equityRaw: '12000000', profitRaw: '2000000' }],
      history: [
        ...value.paper.history,
        {
          eventId: 'close',
          kind: 'CLOSE',
          transactionHash: HASH,
          blockHash: BLOCK,
          at: NOW,
          amountRaw: '10000000',
          quantityRaw: '1000000000000000000',
          priceRaw: '12000000',
          priceObservedAt: NOW - 1,
          sourceId: 'ALPACA_IEX',
          profitRaw: '2000000',
        },
      ],
    },
  };
}
