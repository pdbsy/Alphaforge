import type { JsonRpcProvider } from 'ethers';
import type { Eip1193Provider, Eip1193Request } from '../../../web/src/chain-wallet.ts';
/** The planner can read/simulate; only the separately activated restricted transport can submit. */
export function stockWorkerReadProvider(provider: Pick<JsonRpcProvider, 'send'>): Eip1193Provider {
  const methods = new Set([
    'eth_chainId',
    'eth_getBlockByNumber',
    'eth_getCode',
    'eth_call',
    'eth_estimateGas',
    'eth_getTransactionReceipt',
    'eth_getTransactionByHash',
    'eth_blockNumber',
  ]);
  return {
    request: (input: Eip1193Request) => {
      if (!methods.has(input.method)) return Promise.reject(new Error('STOCK_WORKER_READ_ONLY'));
      return provider.send(input.method, [...(input.params ?? [])]);
    },
    on: () => undefined,
    removeListener: () => undefined,
  };
}
