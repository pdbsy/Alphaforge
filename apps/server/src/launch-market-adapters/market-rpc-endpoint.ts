export const OFFICIAL_ROBINHOOD_RPC = 'https://rpc.testnet.chain.robinhood.com';

/** The deployment chooses OFFICIAL explicitly; an API credential never selects a chain or RPC. */
export function marketRpcEndpoint(env: Readonly<Record<string, string | undefined>>): string {
  if (env.AF_MARKET_RPC_MODE === 'OFFICIAL') return OFFICIAL_ROBINHOOD_RPC;
  if (env.AF_MARKET_RPC_MODE !== undefined && env.AF_MARKET_RPC_MODE !== 'CONFIGURED')
    throw new Error('MARKET_RPC_MODE_INVALID');
  if (!env.AF_MARKET_RPC_URL) throw new Error('RPC_REQUIRED');
  return env.AF_MARKET_RPC_URL;
}
