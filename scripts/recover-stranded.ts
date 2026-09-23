/**
 * Recovers USDC stranded at expired Gum payment addresses by calling the permissionless
 * `PaymentFactory.execute(...)` with each deposit's terms. After expiry, the deployed `Payment`
 * sends its whole balance to the deposit's `recovery` address (Gum's), never to anyone else, so
 * this key only pays gas.
 *
 *   pnpm recover-stranded .movers/stranded-2026-09-23.json          # plan (read-only)
 *   pnpm recover-stranded .movers/stranded-2026-09-23.json --yes    # send
 *
 * Reads FUNDER_PRIVATE_KEY (pays gas) and RPC_URL_<CHAIN> from the environment / .env.
 *
 * Safe to re-run, like setup-movers:
 *  - Progress lives in `<input>.recovery.json`, written before every broadcast.
 *  - One nonce per recovery. A stuck transaction is re-sent or replaced at the same nonce, never duplicated.
 *  - Before signing: a payment that is already executed (by anyone) is marked done, not sent again.
 *    Each execute is simulated and must not revert. It only runs if the deposit is expired, so the
 *    funds can only go to `recovery`.
 *  - Success means a receipt with `Recovered(recovery, token, amount)` emitted by the payment address.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base, monad } from 'viem/chains';

const { values: args, positionals } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  allowPositionals: true,
  options: { yes: { type: 'boolean', default: false }, 'stuck-after': { type: 'string', default: '60' } },
});
const input = resolve(positionals[0] ?? '.movers/stranded-2026-09-23.json');
const statePath = input.replace(/\.json$/, '') + '.recovery.json';
const STUCK_AFTER_MS = Number(args['stuck-after']) * 1000;

const factoryAbi = parseAbi([
  'function paymentAddress(address token, uint256 amount, address receiver, uint64 expirationTimestamp, address recovery, bytes32 salt, uint256 chainId) view returns (address)',
  'function execute(address token, uint256 amount, address receiver, uint64 expirationTimestamp, address recovery, bytes32 salt, uint256 chainId)',
]);
const recoveredEvent = parseAbi(['event Recovered(address indexed recovery, address indexed token, uint256 amount)']);
const CHAINS = { 143: ['monad', monad], 8453: ['base', base], 42161: ['arbitrum', arbitrum] } as const;

interface Attempt { nonce: number; hash: Hex; raw: Hex; maxFeePerGas: string; maxPriorityFeePerGas: string; gas: string; signedAt: string; broadcast: boolean; rejected?: string }
interface Item {
  status: 'pending' | 'recovered' | 'already_executed' | 'error';
  tx?: Hex;
  block?: number;
  recovered?: string;
  note?: string;
  attempts: Attempt[];
}
type State = { input: string; funder: Hex; items: Record<string, Item> };

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => {
  const x = e as { details?: string; shortMessage?: string; message?: string };
  return `${x.details ?? ''} ${x.shortMessage ?? ''} ${x.message ?? ''}`.toLowerCase();
};

const key = process.env.FUNDER_PRIVATE_KEY?.trim();
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) fail('FUNDER_PRIVATE_KEY must be set (it pays the gas)');
const signer = privateKeyToAccount(key as Hex);
if (!existsSync(input)) fail(`${input} not found`);
const doc = JSON.parse(readFileSync(input, 'utf8')) as {
  factory: Hex;
  deposits: Array<{ deposit_id: string; chain_id: number; payment_address: Hex; terms: { token: Hex; amount: string; receiver: Hex; expirationTimestamp: string; recovery: Hex; salt: Hex; chainId: string } }>;
};
const chainId = doc.deposits[0]?.chain_id as keyof typeof CHAINS;
if (!CHAINS[chainId] || doc.deposits.some((d) => d.chain_id !== chainId)) fail('all deposits must be on one supported chain');
const [slug, chainDef] = CHAINS[chainId];
const rpc = process.env[`RPC_URL_${slug.toUpperCase()}`]?.trim();
if (!rpc) fail(`RPC_URL_${slug.toUpperCase()} must be set`);
const pub = createPublicClient({ chain: { ...chainDef, rpcUrls: { default: { http: [rpc] } } }, transport: http(rpc, { retryCount: 3 }) }) as PublicClient;
const factory = getAddress(doc.factory);

mkdirSync(dirname(statePath), { recursive: true });
const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { input, funder: signer.address, items: {} };
if (state.funder.toLowerCase() !== signer.address.toLowerCase()) fail(`${statePath} was started with ${state.funder}; FUNDER_PRIVATE_KEY is ${signer.address}`);
const save = () => {
  writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${statePath}.tmp`, statePath);
};
const lock = `${statePath}.lock`;
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, 'utf8'));
  try {
    process.kill(pid, 0);
    fail(`another run (pid ${pid}) is in progress`);
  } catch {
    /* stale lock */
  }
}
writeFileSync(lock, String(process.pid));
process.on('exit', () => rmSync(lock, { force: true }));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(130));

type Deposit = (typeof doc.deposits)[number];
const argsOf = (d: Deposit) =>
  [getAddress(d.terms.token), BigInt(d.terms.amount), getAddress(d.terms.receiver), BigInt(d.terms.expirationTimestamp), getAddress(d.terms.recovery), d.terms.salt, BigInt(d.terms.chainId)] as const;
const deployed = async (a: Hex) => {
  const c = await pub.getCode({ address: a });
  return !!c && c !== '0x';
};

/** The receipt, if mined, and what it recovered to whom. */
async function inspect(d: Deposit, hash: Hex) {
  const r = await pub.getTransactionReceipt({ hash }).catch(() => null);
  if (!r) return null;
  let recovered: bigint | undefined;
  for (const log of r.logs) {
    if (getAddress(log.address) !== getAddress(d.payment_address)) continue;
    try {
      const ev = decodeEventLog({ abi: recoveredEvent, data: log.data, topics: log.topics });
      if (getAddress(ev.args.recovery) === getAddress(d.terms.recovery)) recovered = (recovered ?? 0n) + ev.args.amount;
    } catch {
      /* other event */
    }
  }
  return { receipt: r, recovered };
}

async function signAndRecord(d: Deposit, item: Item, nonce: number, previous?: Attempt) {
  const data = (await import('viem')).encodeFunctionData({ abi: factoryAbi, functionName: 'execute', args: argsOf(d) });
  const fees = await pub.estimateFeesPerGas();
  const bump = (v: string) => (BigInt(v) * 125n) / 100n + 1n;
  let maxFeePerGas = previous ? [fees.maxFeePerGas, bump(previous.maxFeePerGas)].reduce((a, b) => (a > b ? a : b)) : fees.maxFeePerGas;
  const maxPriorityFeePerGas = previous ? [fees.maxPriorityFeePerGas, bump(previous.maxPriorityFeePerGas)].reduce((a, b) => (a > b ? a : b)) : fees.maxPriorityFeePerGas;
  if (maxPriorityFeePerGas > maxFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
  const gas = previous ? BigInt(previous.gas) : ((await pub.estimateGas({ account: signer.address, to: factory, data })) * 12n) / 10n;
  const raw = await signer.signTransaction({ type: 'eip1559', chainId: chainDef.id, to: factory, data, nonce, gas, maxFeePerGas, maxPriorityFeePerGas, value: 0n });
  const a: Attempt = { nonce, hash: keccak256(raw), raw, maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: maxPriorityFeePerGas.toString(), gas: gas.toString(), signedAt: new Date().toISOString(), broadcast: false };
  item.attempts.push(a);
  save();
  return a;
}

async function broadcast(a: Attempt) {
  try {
    await pub.sendRawTransaction({ serializedTransaction: a.raw });
    a.broadcast = true;
  } catch (e) {
    const t = errText(e);
    if (/already known|known transaction|higher priority/.test(t)) a.broadcast = true;
    else if (/nonce too low|nonce has already been used/.test(t)) a.rejected = 'nonce too low';
    else if (/underpriced|fee too low/.test(t)) a.rejected = 'underpriced';
    else if (/took too long|timeout|timed out|fetch failed|http request failed|econnreset|socket|503|502|429/.test(t)) {
      // Unknown whether the node took it. Leave it unconfirmed: the loop checks for a receipt and
      // re-sends the same bytes if the node doesn't know the transaction.
      console.log(`    broadcast uncertain (${String((e as Error).message).slice(0, 80)}); will re-check`);
    } else {
      save();
      throw new Error(`broadcast failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  save();
}

async function recover(d: Deposit, item: Item) {
  const tag = `${d.deposit_id.slice(0, 13)} ${d.payment_address.slice(0, 10)}…`;
  let lookedAgain = false;
  for (;;) {
    if (item.status !== 'pending') return;
    if (item.attempts.length === 0) {
      if (await deployed(d.payment_address)) {
        const left = await pub.readContract({ address: d.terms.token, abi: erc20Abi, functionName: 'balanceOf', args: [d.payment_address] });
        Object.assign(item, { status: 'already_executed', note: `payment already executed by someone else; ${left} left at the address` });
        save();
        console.log(`  ${tag} already executed elsewhere`);
        return;
      }
      const head = await pub.getBlock();
      if (head.timestamp <= BigInt(d.terms.expirationTimestamp)) {
        Object.assign(item, { status: 'error', note: 'not expired: executing would pay the receiver, not recovery' });
        save();
        console.log(`  ${tag} NOT EXPIRED; skipped`);
        return;
      }
      try {
        await pub.simulateContract({ account: signer.address, address: factory, abi: factoryAbi, functionName: 'execute', args: argsOf(d) });
      } catch (e) {
        Object.assign(item, { status: 'error', note: `simulation reverted: ${(e as Error).message.split('\n')[0]}` });
        save();
        console.log(`  ${tag} simulation reverted; skipped`);
        return;
      }
      const a = await signAndRecord(d, item, await pub.getTransactionCount({ address: signer.address, blockTag: 'pending' }));
      await broadcast(a);
      console.log(`  ${tag} sent ${a.hash} (nonce ${a.nonce})`);
      continue;
    }
    // Resolve the nonce in flight: only a receipt of one of our own attempts counts.
    for (const a of item.attempts.filter((x) => !x.rejected)) {
      const r = await inspect(d, a.hash);
      if (!r) continue;
      if (r.receipt.status === 'success' && r.recovered !== undefined) {
        Object.assign(item, { status: 'recovered', tx: a.hash, block: Number(r.receipt.blockNumber), recovered: r.recovered.toString() });
        save();
        console.log(`  ${tag} recovered ${formatUnits(r.recovered, 6)} USDC → ${d.terms.recovery} (block ${r.receipt.blockNumber})`);
        return;
      }
      // Reverted (e.g. executed by someone else first): the address now tells.
      const done = await deployed(d.payment_address);
      Object.assign(item, { status: done ? 'already_executed' : 'error', tx: a.hash, note: `tx ${r.receipt.status}; payment deployed=${done}` });
      save();
      console.log(`  ${tag} ${done ? 'executed by someone else first' : 'REVERTED'} (${a.hash})`);
      return;
    }
    const last = item.attempts.at(-1)!;
    const mined = await pub.getTransactionCount({ address: signer.address, blockTag: 'latest' });
    if (mined > last.nonce) {
      // The nonce is used but no receipt of ours is visible. Give a lagging RPC one more look (the loop
      // re-checks our receipts), then start over: the fresh path re-checks whether the payment is executed.
      if (!lookedAgain) {
        lookedAgain = true;
        await sleep(2_000);
        continue;
      }
      lookedAgain = false;
      item.attempts = [];
      save();
      console.log(`  ${tag} nonce ${last.nonce} used elsewhere; re-checking`);
      continue;
    }
    if (last.rejected === 'underpriced' || (last.broadcast && Date.now() - Date.parse(last.signedAt) > STUCK_AFTER_MS)) {
      if (item.attempts.length > 6) throw new Error(`${tag} still unmined after 6 fee bumps; re-run later`);
      const next = await signAndRecord(d, item, last.nonce, last);
      await broadcast(next);
      console.log(`  ${tag} stuck; replaced at nonce ${next.nonce} with higher fees`);
      continue;
    }
    const known = await pub.getTransaction({ hash: last.hash }).then(() => true, () => false);
    if (!last.broadcast || !known) {
      delete last.rejected;
      await broadcast(last);
    }
    await sleep(1_500);
  }
}

async function main() {
  const tokenBal = (a: Hex) => pub.readContract({ address: doc.deposits[0]!.terms.token, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
  const recoveries = [...new Set(doc.deposits.map((d) => getAddress(d.terms.recovery)))];
  // Plan: verify each deposit's terms against the factory and see what is still stranded.
  let stranded = 0n;
  let todo = 0;
  for (const d of doc.deposits) {
    const item = (state.items[d.deposit_id] ??= { status: 'pending', attempts: [] });
    const derived = await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'paymentAddress', args: argsOf(d) });
    if (getAddress(derived) !== getAddress(d.payment_address)) fail(`${d.deposit_id}: terms do not derive its payment address; refusing`);
    if (item.status === 'pending') {
      todo++;
      stranded += await tokenBal(d.payment_address);
    }
    await sleep(60);
  }
  save();
  const gas = await pub.getBalance({ address: signer.address });
  const before = await Promise.all(recoveries.map(tokenBal));
  console.log(`${doc.deposits.length} deposits on ${slug} · ${todo} to recover (${formatUnits(stranded, 6)} USDC still at their addresses)`);
  console.log(`funds go to: ${recoveries.join(', ')} (from each deposit's terms) · gas payer ${signer.address} (${formatUnits(gas, 18)} ${chainDef.nativeCurrency.symbol})`);
  if (!todo) return console.log('Nothing left to recover.');
  if (!args.yes) return console.log('\nPlan only. Re-run with --yes to send.');

  console.log('');
  for (const d of doc.deposits) await recover(d, state.items[d.deposit_id]!);

  const counts = Object.values(state.items).reduce((a: Record<string, number>, i) => ((a[i.status] = (a[i.status] ?? 0) + 1), a), {});
  const total = Object.values(state.items).reduce((a, i) => a + BigInt(i.recovered ?? '0'), 0n);
  const after = await Promise.all(recoveries.map(tokenBal));
  console.log(`\n${JSON.stringify(counts)} · recovered ${formatUnits(total, 6)} USDC this file · recovery address balance ${recoveries.map((r, i) => `${formatUnits(before[i]!, 6)} → ${formatUnits(after[i]!, 6)}`).join(', ')}`);
  console.log(`progress: ${statePath}`);
}

main().catch((e) => fail((e as Error).message));
