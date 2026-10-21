import type { PaperMarketDataSource } from './paper-market-data.ts';
import { loadStockDataReference } from './stock-data-credentials.ts';

/** The existing private GET-only verifier, with one clock/calendar read shared by both symbols. */
export function alpacaPaperMarketSource(
  credentialsPath: string,
  options: { fetcher?: typeof fetch; now?: () => number } = {},
): PaperMarketDataSource {
  const fetcher = options.fetcher ?? fetch;
  return {
    sourceId: 'ALPACA_IEX',
    async readBatch({ signal }) {
      const reads = new Map<string, Promise<{ status: number; bytes: Uint8Array | null }>>();
      const sharedFetch: typeof fetch = async (input, init) => {
        if (signal.aborted) throw new Error('ALPACA_READ_CANCELLED');
        const url = String(input);
        let pending = reads.get(url);
        if (!pending) {
          pending = (async () => {
            const response = await fetcher(input, {
              ...init,
              signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
            });
            if (!response.ok || !response.body) {
              await response.body?.cancel();
              return { status: response.status, bytes: null };
            }
            const reader = response.body.getReader(),
              chunks: Uint8Array[] = [];
            let length = 0;
            try {
              for (;;) {
                const next = await reader.read();
                if (next.done) break;
                length += next.value.length;
                if (length > 262144) throw new Error('STOCK_REFERENCE_TOO_LARGE');
                chunks.push(next.value);
              }
            } finally {
              await reader.cancel();
            }
            return { status: response.status, bytes: Buffer.concat(chunks) };
          })();
          reads.set(url, pending);
        }
        const response = await pending;
        if (signal.aborted) throw new Error('ALPACA_READ_CANCELLED');
        return new Response(response.bytes as BodyInit | null, { status: response.status });
      };
      const source = loadStockDataReference(credentialsPath, {
        fetcher: sharedFetch,
        ...(options.now ? { now: options.now } : {}),
      });
      if (!source) throw new Error('STOCK_REFERENCE_NOT_CONFIGURED');
      const [tsla, amzn] = await Promise.all([source.read('TSLA'), source.read('AMZN')]);
      if (signal.aborted) throw new Error('ALPACA_READ_CANCELLED');
      return {
        TSLA: {
          strategyId: 'TSLA',
          marketState: tsla.status,
          priceRaw: tsla.priceRaw,
          observedAt: tsla.observedAt,
        },
        AMZN: {
          strategyId: 'AMZN',
          marketState: amzn.status,
          priceRaw: amzn.priceRaw,
          observedAt: amzn.observedAt,
        },
      };
    },
  };
}
