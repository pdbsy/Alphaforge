import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { StockConsentRegistry } from '../apps/server/src/launch-market-adapters/stock-consent-registry.ts';
import {
  stockConsentMessage,
  stockEvidenceHash,
  type StockAutomationConsent,
} from '../apps/server/src/launch-market-adapters/stock-worker-policy.ts';
import { config, NOW } from './helpers/launch-market-ui-fixture.ts';
const owner = new Wallet('0x' + '11'.repeat(32));
const other = new Wallet('0x' + '22'.repeat(32));
async function signed(nonce = 'consent_registry_0001', lifetime = 3600) {
  const consent: StockAutomationConsent = {
    schemaVersion: 1,
    chainId: 46630,
    manifestDigest: stockEvidenceHash(config().manifest!),
    owner: owner.address,
    vault: '0x' + '33'.repeat(20),
    strategyId: 'TSLA',
    initialVersion: '2',
    grant: {
      executor: other.address,
      expiresAt: String(NOW + lifetime),
      maxOrderUsdc: '10000000',
      maxTotalBuyUsdc: '50000000',
      maxSlippageBps: 100,
    },
    policy: { kind: 'BUY_AND_HOLD' },
    validUntil: NOW + lifetime,
    maxPositionUsdcRaw: '50000000',
    stopPriceUsdcRaw: '0',
    takePriceUsdcRaw: '0',
    nonce,
  };
  return { consent, signature: await owner.signMessage(stockConsentMessage(consent)) };
}
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'af-consent-registry-'));
  chmodSync(folder, 0o700);
  const path = join(folder, 'sessions.json');
  return {
    folder,
    path,
    registry: new StockConsentRegistry(path),
    close: () => rmSync(folder, { recursive: true, force: true }),
  };
}
test('owner-scoped registry persists consent and atomically pauses worker membership', async () => {
  const f = fixture();
  try {
    const c = await signed();
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')).sessions, []);
    assert.throws(() => f.registry.start(other.address, c, 0, NOW), /LINKED_WALLET_REQUIRED/);
    const start = f.registry.start(owner.address, c, 0, NOW);
    assert.equal(start.revision, 1);
    assert.equal(f.registry.owned(other.address).sessions.length, 0);
    const digest = start.sessions[0]!.digest;
    assert.throws(() => f.registry.pause(other.address, digest, 1, NOW), /STOCK_SESSION_NOT_FOUND/);
    assert.throws(() => f.registry.pause(owner.address, digest, 0, NOW), /STOCK_SESSION_CONFLICT/);
    const reopened = new StockConsentRegistry(f.path);
    assert.equal(reopened.owned(owner.address).sessions[0]!.active, true);
    assert.equal(reopened.pause(owner.address, digest, 1, NOW + 1).revision, 2);
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')).sessions, []);
    assert.equal(f.registry.owned(owner.address).sessions[0]!.active, false);
    assert.throws(() => reopened.start(owner.address, c, 2, NOW + 2), /STOCK_CONSENT_ALREADY_USED/);
  } finally {
    f.close();
  }
});
test('new consent retires expired membership without discarding its signed history', async () => {
  const f = fixture();
  try {
    f.registry.start(owner.address, await signed('consent_registry_0001', 30), 0, NOW);
    const result = f.registry.start(owner.address, await signed('consent_registry_0002', 3600), 1, NOW + 31);
    assert.equal(result.revision, 2);
    assert.deepEqual(
      result.sessions.map((s) => s.active),
      [false, true],
    );
    assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).sessions.length, 1);
  } finally {
    f.close();
  }
});
test('private registry rejects permissive files and tampered worker membership', async () => {
  const f = fixture();
  try {
    f.registry.start(owner.address, await signed(), 0, NOW);
    chmodSync(f.path, 0o644);
    assert.throws(() => new StockConsentRegistry(f.path), /STOCK_REGISTRY_PRIVATE_STORAGE/);
    chmodSync(f.path, 0o600);
    const doc = JSON.parse(readFileSync(f.path, 'utf8'));
    doc.sessions = [];
    writeFileSync(f.path, JSON.stringify(doc));
    assert.throws(() => f.registry.owned(owner.address), /STOCK_REGISTRY_CORRUPT/);
    assert.throws(() => new StockConsentRegistry(f.path), /STOCK_REGISTRY_CORRUPT/);
    rmSync(f.path);
    assert.throws(() => f.registry.owned(owner.address), /STOCK_REGISTRY_CORRUPT/);
  } finally {
    f.close();
  }
});
