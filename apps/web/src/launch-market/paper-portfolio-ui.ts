import type {
  PaperLedgerValue,
  PaperCurvePoint,
} from '../../../../packages/launch-market/src/paper-ledger.ts';
import { escapeHtml as esc, rawAmount, signedAmount } from './presentation.ts';

const when = (value: number | null | undefined) =>
  value !== null && value !== undefined && Number.isSafeInteger(value)
    ? new Date(value * 1000).toLocaleString('en-US')
    : '—';
const money = (value: string | null | undefined) => (value == null ? '—' : `${rawAmount(value, 6)} AF-USDC`);
const pnl = (value: string | null | undefined) =>
  value == null ? '—' : `${BigInt(value) > 0n ? '+' : ''}${signedAmount(value)} AF-USDC`;
const row = (label: string, value: string) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
const percentage = (value: string | null, profit: string | null) => {
  if (value === null) return '—';
  const bps = BigInt(value),
    absolute = bps < 0n ? -bps : bps;
  if (bps === 0n && profit !== null && BigInt(profit) !== 0n)
    return `${BigInt(profit) < 0n ? '-' : '+'}<0.01%`;
  return `${bps < 0n ? '-' : bps > 0n ? '+' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}%`;
};

/** This chart contains only recorded observations, including genuine gaps in valuation. */
export function renderPaperCurve(points: readonly PaperCurvePoint[]): string {
  const values = points.filter((point) => point.profitRaw !== null).slice(-200);
  if (!values.length)
    return '<p class="small muted" data-paper-curve-empty>No valued observations yet. Recorded simulation values appear after a confirmed entry with authorized market data.</p>';
  const raw = values.map((point) => BigInt(point.profitRaw!));
  const min = raw.reduce((a, b) => (a < b ? a : b)),
    max = raw.reduce((a, b) => (a > b ? a : b));
  const span = max - min;
  const first = values[0]!.at,
    last = values.at(-1)!.at;
  const dots = values.map((point, i) => {
    const x = first === last ? 300 : 24 + ((point.at - first) * 552) / (last - first);
    // Normalize with fixed-point integers; Number is used only for the bounded SVG coordinate.
    const y = span === 0n ? 90 : 156 - Number(((raw[i]! - min) * 13200n) / span) / 100;
    return { x, y, point };
  });
  const segments: string[] = [];
  let segment: string[] = [];
  for (const point of points.slice(-200)) {
    if (point.profitRaw === null) {
      if (segment.length > 1) segments.push(segment.join(' '));
      segment = [];
    } else {
      const dot = dots.find((item) => item.point === point);
      if (dot) segment.push(`${dot.x.toFixed(2)},${dot.y.toFixed(2)}`);
    }
  }
  if (segment.length > 1) segments.push(segment.join(' '));
  return `<figure class="paper-value-curve" data-paper-curve><svg viewBox="0 0 600 180" width="100%" role="img" aria-label="Simulated PnL from recorded observations"><title>Simulated PnL</title><path d="M24 156H576" fill="none" stroke="currentColor" opacity="0.25"/>${segments.map((line) => `<polyline points="${line}" fill="none" stroke="var(--rust, currentColor)" stroke-width="2"/>`).join('')}${dots.map((dot) => `<circle cx="${dot.x.toFixed(2)}" cy="${dot.y.toFixed(2)}" r="2" fill="var(--rust, currentColor)"><title>${esc(when(dot.point.at))} · ${esc(pnl(dot.point.profitRaw))}</title></circle>`).join('')}</svg><figcaption class="small muted">${esc(when(first))} — ${esc(when(last))} · ${values.length} recorded observation${values.length === 1 ? '' : 's'}</figcaption></figure>`;
}

export function renderPaperHistory(value: PaperLedgerValue): string {
  const history = value.paper.history;
  const entered = BigInt(value.paper.costBasisRaw) > 0n || history.some((event) => event.kind === 'ENTRY');
  if (!history.length)
    return '<p class="small muted" data-paper-history-empty>No confirmed funding or simulated entries have been recorded for this Vault.</p>';
  const labels = { DEPOSIT: 'On-chain deposit', ENTRY: 'Simulated stock entry', CLOSE: 'On-chain close' };
  return `<details class="paper-history" data-paper-history><summary>Recorded activity · ${history.length}</summary>${history
    .slice()
    .reverse()
    .map(
      (event) =>
        `<article class="paper-history-event"><strong>${labels[event.kind]}</strong><dl class="order-quote">${row('Time', esc(when(event.at)))}${row(event.kind === 'ENTRY' ? 'Simulated cost' : event.kind === 'CLOSE' ? 'Funds returned on chain' : 'Funds deposited on chain', money(event.amountRaw))}${event.kind === 'ENTRY' ? row('Simulated units', rawAmount(event.quantityRaw, 18, 8)) : ''}${event.kind === 'ENTRY' || event.kind === 'CLOSE' ? row('Reference price', event.priceRaw === null ? '—' : money(event.priceRaw)) : ''}${event.kind === 'CLOSE' ? row('Realized simulated PnL', pnl(entered ? event.profitRaw : null)) : ''}${row('Transaction', `<span class="launch-hash" title="${esc(event.transactionHash)}">${esc(event.transactionHash.slice(0, 10))}…${esc(event.transactionHash.slice(-8))}</span>`)}</dl></article>`,
    )
    .join('')}</details>`;
}

export function renderClosedPaperSummary(values: readonly PaperLedgerValue[]): string {
  const entered = values.filter(
    (value) =>
      BigInt(value.paper.costBasisRaw) > 0n || value.paper.history.some((event) => event.kind === 'ENTRY'),
  );
  if (!entered.length) return '';
  const known = entered.filter((value) => value.paper.realizedRaw !== null);
  const total = known.reduce((sum, value) => sum + BigInt(value.paper.realizedRaw!), 0n);
  return `<section class="paper-closed-summary" aria-label="Personal closed simulated ledgers"><h2>Your past simulated results</h2><p>Known realized simulated PnL: <strong>${known.length ? pnl(String(total)) : '—'}</strong> · ${known.length} valued closed Vault${known.length === 1 ? '' : 's'}${entered.length > known.length ? ` · ${entered.length - known.length} awaiting final valuation` : ''}.</p><p class="small muted">These past simulated results remain separate from your current Vault principal and withdrawable funds.</p></section>`;
}

export function renderPaperPortfolio(value: PaperLedgerValue | undefined, error?: string | null): string {
  const paper = value?.paper;
  const entered =
    !!paper && (BigInt(paper.costBasisRaw) > 0n || paper.history.some((event) => event.kind === 'ENTRY'));
  const closed = paper?.status === 'CLOSED' || paper?.status === 'SETTLEMENT_PENDING';
  const freeCash = value ? BigInt(value.real.cashRaw) - BigInt(value.paper.allocatedPrincipalRaw) : 0n;
  const known =
    entered &&
    paper?.equityRaw !== null &&
    paper?.status !== 'REORG_REVIEW_REQUIRED' &&
    (closed || freeCash >= 0n);
  const totalValue = known ? String(BigInt(paper!.equityRaw!) + (closed ? 0n : freeCash)) : null;
  const unavailable = !paper || paper.quoteStatus === 'UNAVAILABLE';
  const exit = paper?.history
    .slice()
    .reverse()
    .find((event) => event.kind === 'CLOSE');
  const priceStatus = error
    ? 'The latest ledger update failed. Recorded history is retained; refresh to try again.'
    : paper?.status === 'REORG_REVIEW_REQUIRED'
      ? 'Funding confirmation changed. This ledger needs authoritative chain reconciliation.'
      : closed
        ? known
          ? `Final simulated result recorded at exit. Reference price time ${when(exit?.priceObservedAt)}. Later market quotes do not change this result.`
          : 'Final simulated valuation is unavailable. This does not affect the confirmed return of on-chain funds.'
        : paper?.marketSession === 'CLOSED'
          ? `Stock market closed. New simulated entries require the next open and a fresh quote. Last authorized price ${when(paper.priceObservedAt)}.`
          : unavailable
            ? 'Waiting for authorized market data. No stock price or simulated return is available.'
            : paper.quoteStatus === 'STALE'
              ? `The last authorized stock price is stale · ${when(paper.priceObservedAt)}.`
              : `Authorized stock price updated ${when(paper.priceObservedAt)}.`;
  const status =
    paper?.status === 'ENTRY_PENDING'
      ? 'Deposit confirmed · simulated entry awaiting authorized market data'
      : paper?.status === 'SETTLEMENT_PENDING'
        ? 'Vault closed · final simulated valuation is unavailable'
        : closed
          ? 'Closed simulated ledger'
          : value?.paused
            ? 'Stopped · simulated holdings remain recorded'
            : entered
              ? 'Simulated stock holding'
              : 'No simulated stock entry yet';
  return `<section class="launch-vault-performance paper-portfolio" aria-label="Personal simulated portfolio"><span class="section-label">YOUR SIMULATED PORTFOLIO</span><p class="small" role="status">${esc(status)}</p><h3>${closed ? 'Final simulated value' : 'Total simulated reference value'}</h3><div class="wallet-amount"><strong>${known ? rawAmount(totalValue, 6) : '—'}</strong><span>AF-USDC reference</span></div><dl class="order-quote">${row('Recorded simulated principal basis', paper ? money(paper.contributedRaw) : '—')}${!closed && value ? row('Unallocated on-chain cash', freeCash >= 0n ? money(String(freeCash)) : '—') : ''}${entered ? row('Simulated allocation value', money(paper!.equityRaw)) : ''}${row('Simulated holdings', entered ? `${rawAmount(paper!.quantityRaw, 18, 8)} units` : '—')}${row('Unrealized simulated PnL', entered ? pnl(paper!.unrealizedRaw) : '—')}${row('Realized simulated PnL', entered ? pnl(paper!.realizedRaw) : '—')}${row('Total simulated PnL', known ? pnl(paper!.profitRaw) : '—')}${row('Simulated allocation return', known ? esc(percentage(paper!.returnBps, paper!.profitRaw)) : '—')}</dl><p class="small muted" data-launch-valuation-status role="status">${esc(priceStatus)}${paper ? ` Ledger updated ${esc(when(paper.observedAt))}.` : ''}</p><p class="small muted">Simulated stock values and profits are ledger records. They cannot be withdrawn or added to on-chain funds.</p><h3>Simulated PnL history</h3><p class="small muted">Contributions are excluded from PnL. The curve uses recorded simulated profits and losses.</p>${renderPaperCurve(entered ? paper!.curve : [])}${value ? renderPaperHistory(value) : ''}</section>`;
}
