/**
 * Mover setup: creates the mover wallets and makes sure each one holds 1 USDC on the chain it pays
 * on (`MOVER_CHAIN_ROTATION[i % n]`). Safe to re-run any number of times, including after a crash, a
 * stuck transaction or an RPC outage: it resumes where it stopped and never pays a mover twice.
 *
 *   pnpm setup-movers          # show the plan, confirm, send
 *   pnpm setup-movers --yes    # no prompt
 *
 * Funding is tracked per mover *per chain*, so changing the rotation and re-running funds movers on
 * their new chain: e.g. CHAINS=monad + MOVER_CHAIN_ROTATION=monad funds every mover on Monad, skipping
 * those already funded there. USDC a mover holds on a chain it no longer uses is left where it is.
 *
 * Reads FUNDER_PRIVATE_KEY and RPC_URL_<CHAIN> for each chain in CHAINS (plus MOVER_CHAIN_ROTATION,
 * MOVER_COUNT and DEPOSIT_AMOUNT if set) from the environment / .env. With GUM_API_KEY set, movers
 * that have a deposit in flight are skipped, so it is safe to run while the bot is running.
 *
 * How it avoids losing money:
 *  - Everything is written to the state file (.movers/state.json) *before* it happens: the keys
 *    before any address is funded, each signed transaction before it is broadcast. Writes are atomic.
 *  - Each transfer is bound to one funder nonce. Retries and fee bumps reuse that nonce, so at most
 *    one of them can ever be mined: a stuck transfer is replaced, never duplicated.
 *  - The chain decides: a transfer is "done" only on a successful receipt of one of its own
 *    transactions. If the nonce was consumed by something else, the mover's balance is checked before
 *    anything is sent again. Once a mover is confirmed on a chain it is never paid there again.
 *  - A lock file stops two runs from racing each other.
 *
 * The state file holds the mover private keys. Back it up: it is the only copy.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  keccak256,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base, monad } from 'viem/chains';
import { CHAIN_INFO, CHAIN_SLUGS, USDC_DECIMALS, type ChainSlug } from '../src/config.ts';
import { GumClient } from '../src/gum.ts';

const { values: args } = parseArgs({
  // pnpm forwards a literal `--` (`pnpm setup-movers -- --yes`); accept both spellings.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    yes: { type: 'boolean', default: false },
    state: { type: 'string', default: '.movers/state.json' },
    // A transfer not mined after this long is re-sent with higher fees (same nonce).
    'stuck-after': { type: 'string', default: '90' },
    // Fee bumps per transfer before this run gives up on it (a re-run continues from there).
    'max-bumps': { type: 'string', default: '6' },
  },
});

const VIEM_CHAINS: Record<ChainSlug, Chain> = { monad, base, arbitrum };
const STUCK_AFTER_MS = Number(args['stuck-after']) * 1000;
const MAX_BUMPS = Number(args['max-bumps']);
const POLL_MS = 2_000;

// ---- state ------------------------------------------------------------------------------------

interface Attempt {
  nonce: number;
  hash: Hex;
  raw: Hex;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  gas: string;
  signedAt: string;
  /** Accepted by the RPC (or already known to it). False if the process died before broadcasting. */
  broadcast: boolean;
  /** Refused by the RPC (nonce too low, underpriced); never entered the mempool. */
  rejected?: string;
}

/** One mover's 1 USDC on one chain. */
interface Funding {
  status: 'pending' | 'confirmed';
  tx?: Hex;
  block?: number;
  note?: string;
  /** Attempts for the nonce currently in flight. */
  attempts: Attempt[];
  /** Earlier nonces that were abandoned (reverted, or taken by another transaction), for the record. */
  history: Array<Attempt & { outcome: string }>;
}

interface MoverState {
  index: number;
  address: Hex;
  privateKey: Hex;
  fundings: Partial<Record<ChainSlug, Funding>>;
}

interface State {
  version: 2;
  createdAt: string;
  funder: Hex;
  amount: string;
  movers: MoverState[];
}

/** A transfer to make: one mover, one chain. */
interface Job {
  m: MoverState;
  chain: ChainSlug;
  f: Funding;
}

const statePath = resolve(args.state!);
const lockPath = `${statePath}.lock`;

function save(state: State) {
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, statePath);
}

/** v1 files held one `chain` + `funding` per mover; v2 keeps a funding per chain. */
function load(): State {
  const raw = JSON.parse(readFileSync(statePath, 'utf8'));
  if (raw.version === 2) return raw as State;
  if (raw.version !== 1) fail(`${statePath}: unknown state version ${raw.version}`);
  const backup = statePath.replace(/\.json$/, '') + '.v1-backup.json';
  if (!existsSync(backup)) copyFileSync(statePath, backup);
  const state: State = {
    version: 2,
    createdAt: raw.createdAt,
    funder: raw.funder,
    amount: raw.amount,
    movers: raw.movers.map((m: { index: number; address: Hex; privateKey: Hex; chain: ChainSlug; funding: Funding }) => ({
      index: m.index,
      address: m.address,
      privateKey: m.privateKey,
      fundings: { [m.chain]: m.funding },
    })),
  };
  save(state);
  console.log(`Upgraded ${statePath} to per-chain funding (original kept at ${backup}).`);
  return state;
}

function lock() {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      /* stale lock */
    }
    if (alive) fail(`another setup-movers run (pid ${pid}) is in progress; wait for it or kill it`);
  }
  writeFileSync(lockPath, String(process.pid));
  const release = () => rmSync(lockPath, { force: true });
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(130));
}

// ---- config -------------------------------------------------------------------------------------

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const env = process.env;
const funderKey = env.FUNDER_PRIVATE_KEY?.trim();
if (!funderKey || !/^0x[0-9a-fA-F]{64}$/.test(funderKey)) fail('FUNDER_PRIVATE_KEY must be set to a 0x-prefixed 32-byte hex key');
const funder = privateKeyToAccount(funderKey as Hex);
const enabled = (env.CHAINS?.trim() || CHAIN_SLUGS.join(',')).split(',').map((s) => s.trim()) as ChainSlug[];
for (const s of enabled) if (!CHAIN_SLUGS.includes(s)) fail(`CHAINS: unknown chain "${s}"`);
const rotation = (env.MOVER_CHAIN_ROTATION?.trim() || enabled.join(',')).split(',').map((s) => s.trim()) as ChainSlug[];
for (const s of rotation) if (!enabled.includes(s)) fail(`MOVER_CHAIN_ROTATION: "${s}" is not in CHAINS`);
const moverCount = Number(env.MOVER_COUNT?.trim() || 50);
const amount = BigInt(env.DEPOSIT_AMOUNT?.trim() || 1_000_000);
const targetChain = (i: number) => rotation[i % rotation.length]!;

const clients = new Map<ChainSlug, PublicClient>();
for (const slug of enabled) {
  const url = env[`RPC_URL_${slug.toUpperCase()}`]?.trim();
  if (!url) fail(`RPC_URL_${slug.toUpperCase()} must be set (or remove ${slug} from CHAINS)`);
  const chain = { ...VIEM_CHAINS[slug], rpcUrls: { default: { http: [url] } } };
  clients.set(slug, createPublicClient({ chain, transport: http(url, { retryCount: 3, timeout: 20_000 }) }) as PublicClient);
}

// ---- chain helpers ------------------------------------------------------------------------------

const usdcBalance = (slug: ChainSlug, address: Hex) =>
  clients.get(slug)!.readContract({ address: CHAIN_INFO[slug].usdc, abi: erc20Abi, functionName: 'balanceOf', args: [address] });

async function receiptOf(pub: PublicClient, hash: Hex) {
  try {
    return await pub.getTransactionReceipt({ hash });
  } catch {
    return null; // not mined (or unknown)
  }
}

async function inMempool(pub: PublicClient, hash: Hex) {
  try {
    await pub.getTransaction({ hash });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => {
  const err = e as { details?: string; shortMessage?: string; message?: string };
  return `${err.details ?? ''} ${err.shortMessage ?? ''} ${err.message ?? ''}`.toLowerCase();
};
const log = (j: Job, msg: string) => console.log(`  ${j.chain.padEnd(8)} #${String(j.m.index).padStart(2)} ${msg}`);

/**
 * Movers whose USDC is in flight in an open Gum deposit, per chain id. Their balance reads zero but
 * they are not unfunded: settlement returns the USDC. Only checked when GUM_API_KEY is available.
 */
async function moversInFlight(): Promise<Set<string> | undefined> {
  const key = env.GUM_API_KEY?.trim();
  if (!key) return undefined;
  const gum = new GumClient((env.GUM_API_URL?.trim() || 'https://api.gum.money').replace(/\/+$/, ''), key, 5, 5);
  const busy = new Set<string>();
  try {
    for (const status of ['pending', 'partial_paid', 'paid']) {
      let cursor: string | undefined;
      do {
        const page = await gum.listDeposits({ status, limit: 200, cursor });
        for (const d of page.items) busy.add(`${d.chain_id}:${getAddress(d.receiver)}`);
        cursor = page.next_cursor;
      } while (cursor);
    }
  } catch (e) {
    fail(`could not ask Gum which movers have deposits in flight (${(e as Error).message}); retry, or unset GUM_API_KEY if the bot is not running`);
  }
  return busy;
}

// ---- the transfer state machine -----------------------------------------------------------------

type Resolution = 'confirmed' | 'reverted' | 'nonce_taken' | 'pending';

/**
 * What happened to the transfer's current nonce? Only a receipt of one of our own transactions
 * counts as success.
 */
async function resolveAttempts(state: State, j: Job): Promise<Resolution> {
  const pub = clients.get(j.chain)!;
  const live = j.f.attempts.filter((a) => !a.rejected);
  for (const a of live) {
    const r = await receiptOf(pub, a.hash);
    if (!r) continue;
    if (r.status === 'success') {
      Object.assign(j.f, { status: 'confirmed', tx: a.hash, block: Number(r.blockNumber) });
      save(state);
      return 'confirmed';
    }
    return 'reverted';
  }
  const nonce = j.f.attempts[0]!.nonce;
  const mined = await pub.getTransactionCount({ address: funder.address, blockTag: 'latest' });
  if (mined <= nonce) return 'pending';
  // The nonce is used, but not visibly by us. Give a lagging RPC one more look before concluding.
  await sleep(POLL_MS);
  for (const a of live) {
    const r = await receiptOf(pub, a.hash);
    if (r) return r.status === 'success' ? resolveAttempts(state, j) : 'reverted';
  }
  return 'nonce_taken';
}

function retire(state: State, j: Job, outcome: string) {
  j.f.history.push(...j.f.attempts.map((a) => ({ ...a, outcome })));
  j.f.attempts = [];
  save(state);
}

/** Signs the transfer with the given nonce and fees and records it, before any broadcast. */
async function signAttempt(state: State, j: Job, nonce: number, previous?: Attempt): Promise<Attempt> {
  const pub = clients.get(j.chain)!;
  const usdc = CHAIN_INFO[j.chain].usdc;
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [j.m.address, amount] });
  const fees = await pub.estimateFeesPerGas();
  let maxFeePerGas = fees.maxFeePerGas;
  let maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  if (previous) {
    // A replacement must beat the previous fees by a margin (10% on most nodes); use 25%.
    const bump = (v: string) => (BigInt(v) * 125n) / 100n + 1n;
    maxFeePerGas = [maxFeePerGas, bump(previous.maxFeePerGas)].reduce((a, b) => (a > b ? a : b));
    maxPriorityFeePerGas = [maxPriorityFeePerGas, bump(previous.maxPriorityFeePerGas)].reduce((a, b) => (a > b ? a : b));
  }
  if (maxPriorityFeePerGas > maxFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
  const gas = previous ? BigInt(previous.gas) : ((await pub.estimateGas({ account: funder.address, to: usdc, data })) * 12n) / 10n;
  const raw = await funder.signTransaction({
    type: 'eip1559',
    chainId: VIEM_CHAINS[j.chain].id,
    to: usdc,
    data,
    nonce,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    value: 0n,
  });
  const attempt: Attempt = {
    nonce,
    hash: keccak256(raw),
    raw,
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    gas: gas.toString(),
    signedAt: new Date().toISOString(),
    broadcast: false,
  };
  j.f.attempts.push(attempt);
  save(state);
  return attempt;
}

/** Sends a recorded attempt. Refusals are recorded; anything unexpected aborts this chain. */
async function broadcast(state: State, j: Job, a: Attempt) {
  try {
    await clients.get(j.chain)!.sendRawTransaction({ serializedTransaction: a.raw });
    a.broadcast = true;
  } catch (e) {
    const t = errText(e);
    if (/already known|known transaction|already imported|alreadyknown/.test(t)) a.broadcast = true;
    else if (/nonce too low|nonce has already been used|nonce is too low|oldnonce/.test(t)) a.rejected = 'nonce too low';
    else if (/underpriced|replacement fee too low|fee too low/.test(t)) a.rejected = 'underpriced';
    else if (/insufficient funds/.test(t)) {
      a.rejected = 'insufficient funds for gas';
      save(state);
      throw new Error(`funder has insufficient ${VIEM_CHAINS[j.chain].nativeCurrency.symbol} for gas on ${j.chain}`);
    } else {
      save(state);
      throw new Error(`broadcast failed on ${j.chain}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  save(state);
}

/** Drives one transfer to a confirmed receipt, or throws to stop this chain for now. */
async function fund(state: State, j: Job) {
  const pub = clients.get(j.chain)!;
  for (;;) {
    if (j.f.status === 'confirmed') return;

    if (j.f.attempts.length === 0) {
      // Nothing in flight. Adopt a mover that already has the USDC; otherwise start a transfer.
      if ((await usdcBalance(j.chain, j.m.address)) >= amount) {
        j.f.status = 'confirmed';
        j.f.note = 'already held the USDC';
        save(state);
        log(j, 'already funded');
        return;
      }
      const nonce = await pub.getTransactionCount({ address: funder.address, blockTag: 'pending' });
      const a = await signAttempt(state, j, nonce);
      await broadcast(state, j, a);
      log(j, `sent ${a.hash} (nonce ${nonce})`);
      continue;
    }

    const outcome = await resolveAttempts(state, j);
    if (outcome === 'confirmed') {
      log(j, `confirmed ${j.f.tx} (block ${j.f.block})`);
      return;
    }
    if (outcome === 'reverted') {
      retire(state, j, 'reverted');
      log(j, 'transfer reverted; retrying with a new nonce');
      continue;
    }
    if (outcome === 'nonce_taken') {
      // Our nonce went to some other funder transaction. Only pay if the mover still needs it.
      retire(state, j, 'nonce taken by another transaction');
      log(j, 'nonce was used elsewhere; re-checking the balance before sending again');
      continue;
    }

    // Pending: make sure it is actually out there, replace it if it is stuck, otherwise wait.
    const last = j.f.attempts[j.f.attempts.length - 1]!;
    const age = Date.now() - Date.parse(last.signedAt);
    if (last.rejected === 'underpriced' || (last.broadcast && age > STUCK_AFTER_MS)) {
      const bumps = j.f.attempts.length - 1;
      if (bumps >= MAX_BUMPS) {
        throw new Error(`transfer to #${j.m.index} still unmined after ${bumps} fee bumps (nonce ${last.nonce}); re-run later to keep going`);
      }
      const next = await signAttempt(state, j, last.nonce, maxFees(j.f.attempts));
      await broadcast(state, j, next);
      log(j, `stuck; replaced with higher fees ${next.hash} (same nonce ${next.nonce})`);
      continue;
    }
    if (!last.broadcast || last.rejected || !(await inMempool(pub, last.hash))) {
      // Signed but never sent (crash), or dropped from the mempool: send the same bytes again.
      if (last.rejected) delete last.rejected;
      await broadcast(state, j, last);
      if (last.broadcast) log(j, `re-broadcast ${last.hash} (nonce ${last.nonce})`);
      if (last.rejected === 'nonce too low') continue; // resolveAttempts sorts out who used the nonce
    }
    await sleep(POLL_MS);
  }
}

/** The highest fees among the attempts, so a replacement always outbids every one of them. */
function maxFees(attempts: Attempt[]): Attempt {
  const top = { ...attempts[attempts.length - 1]! };
  for (const a of attempts) {
    if (BigInt(a.maxFeePerGas) > BigInt(top.maxFeePerGas)) top.maxFeePerGas = a.maxFeePerGas;
    if (BigInt(a.maxPriorityFeePerGas) > BigInt(top.maxPriorityFeePerGas)) top.maxPriorityFeePerGas = a.maxPriorityFeePerGas;
  }
  return top;
}

// ---- main ------------------------------------------------------------------------------------------

async function main() {
  lock();

  let state: State;
  if (existsSync(statePath)) {
    state = load();
    if (state.funder.toLowerCase() !== funder.address.toLowerCase()) {
      fail(`${statePath} was created for funder ${state.funder}, but FUNDER_PRIVATE_KEY is ${funder.address}`);
    }
    if (state.amount !== amount.toString()) fail(`${statePath} was created for amount ${state.amount}; DEPOSIT_AMOUNT is ${amount}`);
    console.log(`Resuming from ${statePath} (${state.movers.length} movers).`);
  } else {
    state = { version: 2, createdAt: new Date().toISOString(), funder: funder.address, amount: amount.toString(), movers: [] };
  }
  // Keys are created once and never replaced; raising MOVER_COUNT later only appends new movers.
  for (let i = state.movers.length; i < moverCount; i++) {
    const privateKey = generatePrivateKey();
    state.movers.push({ index: i, address: privateKeyToAccount(privateKey).address, privateKey, fundings: {} });
  }
  save(state);

  // Each mover needs its USDC on the chain it pays on now.
  const movers = state.movers.slice(0, moverCount);
  const jobs: Job[] = movers.map((m) => {
    const chain = targetChain(m.index);
    const f = (m.fundings[chain] ??= { status: 'pending', attempts: [], history: [] });
    return { m, chain, f };
  });
  save(state);
  const busy = await moversInFlight();
  const isBusy = (j: Job) => j.f.status !== 'confirmed' && j.f.attempts.length === 0 && busy?.has(`${VIEM_CHAINS[j.chain].id}:${getAddress(j.m.address)}`);

  // ---- plan ----
  const todo = jobs.filter((j) => j.f.status !== 'confirmed' && !isBusy(j));
  console.log(`\nFunder ${funder.address} · ${formatUnits(amount, USDC_DECIMALS)} USDC per mover\n`);
  const blocked = new Set<ChainSlug>();
  for (const slug of enabled) {
    const here = jobs.filter((j) => j.chain === slug);
    if (!here.length) continue;
    const pub = clients.get(slug)!;
    const pendingHere = todo.filter((j) => j.chain === slug);
    const inFlight = pendingHere.filter((j) => j.f.attempts.length > 0).length;
    const busyHere = here.filter(isBusy).length;
    const [usdc, native] = await Promise.all([usdcBalance(slug, funder.address), pub.getBalance({ address: funder.address })]);
    const need = BigInt(pendingHere.length - inFlight) * amount;
    const sym = VIEM_CHAINS[slug].nativeCurrency.symbol;
    const funded = here.filter((j) => j.f.status === 'confirmed').length;
    let line = `  ${slug.padEnd(9)} ${funded}/${here.length} funded`;
    if (pendingHere.length) line += `, ${pendingHere.length} to fund`;
    if (inFlight) line += ` (${inFlight} already in flight)`;
    if (busyHere) line += `, ${busyHere} skipped (deposit in flight)`;
    line += ` · needs up to ${formatUnits(need, USDC_DECIMALS)} USDC · funder has ${formatUnits(usdc, USDC_DECIMALS)} USDC, ${formatUnits(native, 18)} ${sym}`;
    if (usdc < need) {
      line += '  ✗ not enough USDC; this chain is skipped';
      blocked.add(slug);
    } else if (native === 0n && pendingHere.length) {
      line += `  ✗ no ${sym} for gas; this chain is skipped`;
      blocked.add(slug);
    }
    console.log(line);
  }
  // USDC left behind on chains movers no longer pay on: reported, never moved by this script.
  const elsewhere = new Map<string, number>();
  for (const j of jobs) {
    for (const [slug, f] of Object.entries(j.m.fundings)) {
      if (slug !== j.chain && f?.status === 'confirmed') elsewhere.set(slug, (elsewhere.get(slug) ?? 0) + 1);
    }
  }
  if (elsewhere.size) {
    const list = [...elsewhere].map(([s, n]) => `${n} on ${s}`).join(', ');
    console.log(`\n  Also funded earlier on chains they no longer pay on: ${list}. That USDC stays with the movers.`);
  }

  const runnable = todo.filter((j) => !blocked.has(j.chain));
  if (!runnable.length) {
    const skippedBusy = jobs.filter(isBusy).length;
    if (todo.length) console.log('\nNothing can be sent until the funder is topped up.');
    else if (skippedBusy) console.log(`\nNothing to send now; ${skippedBusy} mover${skippedBusy === 1 ? ' has a deposit' : 's have deposits'} in flight. Re-run later.`);
    else console.log('\nEvery mover is funded.');
    writeEnvFile(state);
    process.exit(todo.length ? 1 : 0);
  }
  if (!args.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nFund ${runnable.length} movers now? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Nothing sent. The keys are saved; re-run whenever you are ready.');
      return;
    }
  }

  // ---- send: chains in parallel, one transfer at a time per chain (a single nonce sequence) ----
  console.log('');
  const chainsToRun = enabled.filter((slug) => !blocked.has(slug) && runnable.some((j) => j.chain === slug));
  const results = await Promise.allSettled(
    chainsToRun.map(async (slug) => {
      for (const j of runnable.filter((x) => x.chain === slug)) await fund(state, j);
    }),
  );

  const done = jobs.filter((j) => j.f.status === 'confirmed').length;
  console.log(`\n${done}/${jobs.length} movers funded on the chain they pay on.`);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`  ✗ ${chainsToRun[i]}: ${(r.reason as Error).message}`);
  });
  writeEnvFile(state);
  if (done < jobs.length) {
    console.log('Re-run the same command to continue; nothing already sent will be sent again.');
    process.exit(1);
  }
}

/** The bot's MOVER_PRIVATE_KEYS line, next to the state file (same permissions). */
function writeEnvFile(state: State) {
  const envPath = resolve(dirname(statePath), 'movers.env');
  const keys = state.movers.map((m) => m.privateKey).join(',');
  writeFileSync(envPath, `# ${state.movers.length} movers, generated by setup-movers\nMOVER_PRIVATE_KEYS=${keys}\n`, { mode: 0o600 });
  console.log(`\nMover keys: ${statePath}\nBot config: ${envPath} (copy MOVER_PRIVATE_KEYS into .env / Railway)`);
  console.log('Back up the state file: it is the only copy of the mover keys.');
  const current = env.MOVER_PRIVATE_KEYS?.trim();
  if (current && current !== keys) console.log('⚠ MOVER_PRIVATE_KEYS in your environment is a different set of keys than these.');
}

main().catch((e) => fail((e as Error).message));
