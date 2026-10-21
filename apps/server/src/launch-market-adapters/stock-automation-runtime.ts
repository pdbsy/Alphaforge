import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress, ZeroAddress } from 'ethers';
import { readRegularBytes } from '../../../../packages/testnet/src/bounded-file.ts';
import {
  LaunchMarketError,
  type LaunchMarketManifest,
} from '../../../../packages/launch-market/src/types.ts';
import type { Eip1193Provider } from '../../../web/src/chain-wallet.ts';
import { readExecutorSnapshot } from '../../../web/src/launch-market/executor.ts';
import { StockConsentRegistry } from './stock-consent-registry.ts';
import { stockEvidenceHash } from './stock-worker-policy.ts';
import { readStockAutomationReadiness } from './stock-worker-readiness.ts';
import type { StockAutomationOptions, StockOperatorStatus } from '../launch-market/automation-routes.ts';

export interface StockAutomationRuntimeInput {
  readonly registry: StockConsentRegistry;
  readonly manifest: LaunchMarketManifest | null;
  readonly provider: Eip1193Provider | null;
  readonly statusFile?: string;
  readonly executorAddress?: string;
  readonly now: () => number;
}

/** The web process reads public-role metadata only; keeper/executor keys remain in the separate worker. */
export function buildStockAutomationRuntime(input: StockAutomationRuntimeInput): StockAutomationOptions {
  const manifestDigest = input.manifest ? stockEvidenceHash(input.manifest) : null;
  let executor: string | null = null;
  if (input.executorAddress) {
    executor = getAddress(input.executorAddress);
    if (executor === ZeroAddress) throw new Error('STOCK_EXECUTOR_CONFIGURATION');
  }
  const file = input.statusFile ? resolve(input.statusFile) : null;
  const operator = (): StockOperatorStatus => {
    const base = { executor, manifestDigest };
    if (!file || !executor || !input.manifest || !input.provider)
      return { ...base, available: false, reason: 'NOT_CONFIGURED' };
    try {
      const before = lstatSync(file);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.uid !== process.getuid?.() ||
        before.mode & 0o077 ||
        realpathSync(file) !== file
      )
        return { ...base, available: false, reason: 'WORKER_INACTIVE' };
      const status = JSON.parse(
        new TextDecoder('utf8', { fatal: true }).decode(readRegularBytes(file, 16_384)),
      ) as Record<string, unknown>;
      const after = lstatSync(file);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mode !== after.mode ||
        before.uid !== after.uid ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        return { ...base, available: false, reason: 'WORKER_INACTIVE' };
      if (
        status.schemaVersion !== 1 ||
        status.mode !== 'ACTIVE' ||
        status.status !== 'RUNNING' ||
        status.manifestDigest !== manifestDigest ||
        status.sessionsFile !== input.registry.path ||
        !Array.isArray(status.executorAddresses) ||
        !status.executorAddresses.some((item) => typeof item === 'string' && getAddress(item) === executor)
      )
        return { ...base, available: false, reason: 'WORKER_INACTIVE' };
      const now = input.now();
      if (
        !Number.isSafeInteger(status.lastTickAt) ||
        Number(status.lastTickAt) > now ||
        now - Number(status.lastTickAt) > 20
      )
        return { ...base, available: false, reason: 'STATUS_STALE' };
      return { ...base, available: true, reason: 'READY' };
    } catch {
      return { ...base, available: false, reason: 'WORKER_INACTIVE' };
    }
  };
  return {
    registry: input.registry,
    operator,
    readiness: async (strategyId, now) =>
      input.manifest && input.provider
        ? readStockAutomationReadiness(input.provider, input.manifest, strategyId, now)
        : { strategyId, status: 'UNAVAILABLE' },
    validateConsent: async (signed, now) => {
      const consent = signed.consent;
      if (
        !input.manifest ||
        !input.provider ||
        consent.manifestDigest !== manifestDigest ||
        !executor ||
        getAddress(consent.grant.executor) !== executor
      )
        throw new LaunchMarketError('STOCK_CONSENT_STATE_CHANGED', 409);
      const snapshot = await readExecutorSnapshot(
        input.provider,
        input.manifest,
        consent.owner,
        consent.vault,
        consent.strategyId,
      );
      if (
        snapshot.closed ||
        snapshot.version !== consent.initialVersion ||
        snapshot.blockTimestamp > now ||
        now - snapshot.blockTimestamp > 30 ||
        consent.validUntil <= input.now() ||
        getAddress(snapshot.owner) !== getAddress(consent.owner) ||
        getAddress(snapshot.vault) !== getAddress(consent.vault) ||
        getAddress(snapshot.grant.executor) !== getAddress(consent.grant.executor) ||
        snapshot.grant.expiresAt !== consent.grant.expiresAt ||
        snapshot.grant.maxOrderUsdc !== consent.grant.maxOrderUsdc ||
        snapshot.grant.maxTotalBuyUsdc !== consent.grant.maxTotalBuyUsdc ||
        snapshot.grant.maxSlippageBps !== consent.grant.maxSlippageBps
      )
        throw new LaunchMarketError('STOCK_CONSENT_STATE_CHANGED', 409);
    },
  };
}
