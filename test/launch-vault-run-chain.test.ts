import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, ZeroAddress, keccak256 } from 'ethers';
import { VaultRunChain } from '../apps/server/src/launch-market-adapters/vault-run-chain.ts';
import type { RpcMarketChain } from '../apps/server/src/launch-market-adapters/rpc-chain.ts';
import type { VaultRunState } from '../packages/launch-market/src/vault-run.ts';

const owner = '0x1111111111111111111111111111111111111111';
const target = '0x2222222222222222222222222222222222222222';
const factoryAddress = '0x3333333333333333333333333333333333333333';
const hash = '0x' + 'ee'.repeat(32);
const blockHash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const vaultAbi = new Interface([
  'function deposit(uint256)',
  'function close()',
  'function execute(bool,uint256,uint256,uint64,uint256)',
  'event Deposited(address indexed owner,uint256 usdcAmount,uint256 passRaw,uint256 principalBasis,uint256 trackedUsdcBalance)',
  'event Closed(address indexed owner,uint256 usdcReturned,uint256 passRawReleased)',
]);
const factoryAbi = new Interface([
  'function vaults(address,uint8) view returns(address)',
  'function createVault(uint8)',
  'event VaultCreated(address indexed owner,uint8 indexed strategyIndex,address vault,uint256 generation)',
]);
const prepared = (): VaultRunState => ({
  schemaVersion: 1,
  owner,
  strategyId: 'TSLA',
  vault: target,
  paused: false,
  revocationRequired: false,
  revision: 2,
  updatedAt: 1000,
  action: {
    actionId: 'unique-owner-action-0001',
    kind: 'DEPOSIT',
    amountRaw: '1000000',
    step: 'DEPOSIT',
    stepAmountRaw: '1000000',
    expectedVersion: '1',
    preparedBlockNumber: '50',
    preparedBlockHash: blockHash(50),
    minimumNonceRaw: '4',
    previousVault: null,
    phase: 'SUBMITTED',
    cancelled: false,
    prepared: true,
    pending: { transactionHash: hash, verified: true },
    failure: null,
  },
});
function fixture() {
  const requests: string[] = [];
  const tx = {
    hash,
    nonce: '0x4',
    from: owner,
    to: target,
    input: vaultAbi.encodeFunctionData('deposit', ['1000000']),
    value: '0x0',
    chainId: '0xb626',
    blockNumber: '0x33',
    blockHash: blockHash(51),
  };
  const event = vaultAbi.encodeEventLog(vaultAbi.getEvent('Deposited')!, [
    owner,
    '1000000',
    '1',
    '1000000',
    '1000000',
  ]);
  const receipt = {
    transactionHash: hash,
    from: owner,
    to: target,
    blockNumber: '0x33',
    blockHash: blockHash(51),
    status: '0x1',
    logs: [{ address: target, ...event }],
  };
  let mapping = ZeroAddress;
  let reorg = false;
  const provider = {
    async send(method: string, params: readonly unknown[]) {
      requests.push(method);
      if (method === 'eth_chainId') return '0xb626';
      if (method === 'eth_getTransactionCount') {
        assert.deepEqual(params, [owner, 'pending']);
        return '0x4';
      }
      if (method === 'eth_getTransactionByHash') return tx;
      if (method === 'eth_getTransactionReceipt') return receipt;
      if (method === 'eth_getCode') return '0x11';
      if (method === 'eth_getBlockByNumber') {
        const n = params[0] === 'latest' ? 53 : Number(BigInt(String(params[0])));
        return {
          number: '0x' + n.toString(16),
          hash: reorg && n === 51 ? blockHash(100) : blockHash(n),
          timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
        };
      }
      if (method === 'eth_call') return factoryAbi.encodeFunctionResult('vaults', [mapping]);
      throw new Error('UNEXPECTED_RPC:' + method);
    },
  };
  const chain = {
    provider,
    manifest: {
      vaultFactory: factoryAddress,
      runtimeCodeHashes: {
        [factoryAddress.toLowerCase()]: keccak256('0x11'),
      },
      strategies: {},
    },
  } as unknown as RpcMarketChain;
  return {
    reader: new VaultRunChain(chain),
    tx,
    receipt,
    requests,
    setMapping: (value: string) => {
      mapping = value;
    },
    reorg: () => {
      reorg = true;
    },
  };
}

test('confirmed snapshot records pending owner nonce; transactions predating preparation cannot be recovered as a new deposit', async () => {
  const f = fixture();
  const observed = await f.reader.readObservation(owner, 'TSLA', { fresh: true });
  assert.equal(observed.ownerNonceRaw, '4');
  assert.equal(observed.blockNumber, '51');
  f.tx.nonce = '0x3';
  await assert.rejects(f.reader.qualifyTransaction(prepared(), hash), /VAULT_RUN_CHAIN_PROOF_INVALID/);
  f.tx.nonce = '0x4';
  f.tx.blockNumber = '0x32';
  f.tx.blockHash = blockHash(50);
  await assert.rejects(f.reader.qualifyTransaction(prepared(), hash), /VAULT_RUN_CHAIN_PROOF_INVALID/);
  assert.equal(
    f.requests.some((method) => /sendRaw|sendTransaction|sign/i.test(method)),
    false,
  );
});
test('canonical confirmation binds transaction, receipt, target, amount and deposit event', async () => {
  const f = fixture();
  assert.equal((await f.reader.readReceipt(prepared())).status, 'CONFIRMED');
  f.receipt.to = factoryAddress;
  await assert.rejects(f.reader.readReceipt(prepared()), /VAULT_RUN_CHAIN_PROOF_INVALID/);
  f.receipt.to = target;
  f.tx.blockHash = blockHash(52);
  await assert.rejects(f.reader.readReceipt(prepared()), /VAULT_RUN_CHAIN_PROOF_INVALID/);
  f.tx.blockHash = blockHash(51);
  f.tx.input = vaultAbi.encodeFunctionData('deposit', ['2000000']);
  await assert.rejects(f.reader.readReceipt(prepared()), /VAULT_RUN_CHAIN_PROOF_INVALID/);
  f.tx.input = vaultAbi.encodeFunctionData('deposit', ['1000000']);
  f.reorg();
  await assert.rejects(f.reader.readReceipt(prepared()), /VAULT_RUN_CHAIN_PROOF_INVALID/);
});
test('Vault creation event must match the factory mapping at the transaction block', async () => {
  const f = fixture(),
    state = prepared();
  const creating: VaultRunState = {
    ...state,
    vault: null,
    action: { ...state.action!, step: 'CREATE', stepAmountRaw: '0' },
  };
  f.tx.to = factoryAddress;
  f.tx.input = factoryAbi.encodeFunctionData('createVault', [0]);
  f.receipt.to = factoryAddress;
  f.receipt.logs = [
    {
      address: factoryAddress,
      ...factoryAbi.encodeEventLog(factoryAbi.getEvent('VaultCreated')!, [owner, 0, target, 1]),
    },
  ];
  await assert.rejects(f.reader.readReceipt(creating), /VAULT_RUN_CHAIN_PROOF_INVALID/);
  f.setMapping(target);
  assert.equal((await f.reader.readReceipt(creating)).status, 'CONFIRMED');
});

test('paper funding proof retains the real log identity and exact cash/PASS amounts without signing', async () => {
  const f = fixture();
  Object.assign(
    f.receipt.logs[0]!,
    vaultAbi.encodeEventLog(vaultAbi.getEvent('Deposited')!, [
      owner,
      '1000000',
      '1000000000000000000',
      '1000000',
      '1000000',
    ]),
    { logIndex: '0x7' },
  );
  const proof = await f.reader.readFundingProof(prepared());
  assert.equal(proof.kind, 'DEPOSIT');
  assert.equal(proof.amountRaw, '1000000');
  assert.equal(proof.passRaw, '1000000000000000000');
  assert.equal(proof.logIndex, 7);
  assert.equal(proof.blockHash, blockHash(51));
  assert.equal(proof.confirmations, 3);
  assert.equal(
    f.requests.some((method) => /sendRaw|sendTransaction|sign/i.test(method)),
    false,
  );
  f.reorg();
  await assert.rejects(f.reader.readFundingProof(prepared()), /VAULT_RUN_CHAIN_PROOF_INVALID/);
});

test('paper funding rejects absent log identity and incorrect PASS backing', async () => {
  const f = fixture();
  await assert.rejects(f.reader.readFundingProof(prepared()), /VAULT_RUN_CHAIN_PROOF_INVALID/);
  Object.assign(f.receipt.logs[0]!, { logIndex: '0x7' });
  await assert.rejects(f.reader.readFundingProof(prepared()), /VAULT_RUN_CHAIN_PROOF_INVALID/);
});

test('paper close proof records only the actual cash returned and all released PASS', async () => {
  const f = fixture(),
    state = prepared();
  const closing: VaultRunState = {
    ...state,
    action: { ...state.action!, kind: 'WITHDRAW', step: 'CLOSE', stepAmountRaw: '0' },
  };
  f.tx.input = vaultAbi.encodeFunctionData('close', []);
  Object.assign(
    f.receipt.logs[0]!,
    vaultAbi.encodeEventLog(vaultAbi.getEvent('Closed')!, [owner, '1000000', '1000000000000000000']),
    { logIndex: '0x9' },
  );
  const proof = await f.reader.readFundingProof(closing);
  assert.equal(proof.kind, 'CLOSE');
  assert.equal(proof.amountRaw, '1000000');
  assert.equal(proof.passRaw, '1000000000000000000');
  assert.equal(proof.logIndex, 9);
});
