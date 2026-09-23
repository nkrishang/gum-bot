/**
 * Seeds the movers from the funder: 1 deposit's worth of USDC on each mover's preferred chain (if it
 * has none anywhere) and a gas top-up where native balance is below the threshold. Reads the same
 * environment as the bot. Dry run by default: prints the plan and what it would cost.
 *
 *   pnpm bootstrap            # plan
 *   pnpm bootstrap --execute  # send the transactions
 */
import { parseArgs } from 'node:util';
import { erc20Abi, formatUnits } from 'viem';
import { createChainRuntime, type ChainRuntime } from '../src/chains.ts';
import { loadConfig, type ChainSlug } from '../src/config.ts';
import { GumClient } from '../src/gum.ts';
import { loadWallets } from '../src/keys.ts';

const { values } = parseArgs({
  // pnpm forwards a literal `--` (`pnpm local -- --movers 9`); accept both spellings.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: { execute: { type: 'boolean', default: false } },
});
const config = loadConfig();
const { funder, movers } = loadWallets(config);
const gum = new GumClient(config.gum.apiUrl, config.gum.apiKey, 5, 5);
const amount = config.deposit.amount;
const chains = new Map<ChainSlug, ChainRuntime>(config.chains.map((cc) => [cc.slug, createChainRuntime(cc)]));

type Bal = { native: bigint; token: bigint };
const read = async (c: ChainRuntime, address: `0x${string}`): Promise<Bal> => ({
  native: await c.public.getBalance({ address }),
  token: await c.public.readContract({ address: c.token.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
});

const balances = new Map<string, Bal>();
await Promise.all(
  [...chains.values()].flatMap((c) => [funder.address, ...movers.map((m) => m.address)].map(async (a) => balances.set(`${c.slug}:${a}`, await read(c, a)))),
);

// A mover whose deposit is still open has its USDC in flight (the settlement returns it), so it is
// not short of USDC. Asking Gum makes this safe to run while the bot is running.
const inFlight = new Set<string>();
for (const status of ['pending', 'partial_paid', 'paid']) {
  let cursor: string | undefined;
  do {
    const page = await gum.listDeposits({ status, limit: 200, cursor });
    for (const d of page.items) inFlight.add(d.receiver.toLowerCase());
    cursor = page.next_cursor;
  } while (cursor);
}

const plan: Array<{ chain: ChainSlug; mover: number; kind: 'usdc' | 'gas'; value: bigint }> = [];
movers.forEach((m, i) => {
  const preferred = config.moverChainRotation[i % config.moverChainRotation.length]!;
  const hasUsdcSomewhere =
    inFlight.has(m.address.toLowerCase()) || [...chains.keys()].some((s) => balances.get(`${s}:${m.address}`)!.token >= amount);
  const payChain = [...chains.keys()].find((s) => balances.get(`${s}:${m.address}`)!.token >= amount) ?? preferred;
  if (!hasUsdcSomewhere) plan.push({ chain: preferred, mover: i, kind: 'usdc', value: amount });
  const c = chains.get(payChain)!;
  if (balances.get(`${payChain}:${m.address}`)!.native < c.gasMin) plan.push({ chain: payChain, mover: i, kind: 'gas', value: c.gasTopup });
});

console.log(`funder ${funder.address} · ${inFlight.size} movers with a deposit in flight\n`);
for (const c of chains.values()) {
  const f = balances.get(`${c.slug}:${funder.address}`)!;
  const usdc = plan.filter((p) => p.chain === c.slug && p.kind === 'usdc');
  const gas = plan.filter((p) => p.chain === c.slug && p.kind === 'gas');
  const needUsdc = usdc.reduce((a, p) => a + p.value, 0n);
  const needGas = gas.reduce((a, p) => a + p.value, 0n);
  const ok = f.token >= needUsdc && f.native >= needGas;
  console.log(
    `${c.slug.padEnd(9)} funder ${formatUnits(f.native, 18)} ${c.nativeSymbol}, ${formatUnits(f.token, c.token.decimals)} ${c.token.symbol}` +
      `\n          plan: ${usdc.length} movers × ${formatUnits(amount, c.token.decimals)} ${c.token.symbol}, ${gas.length} gas top-ups × ${c.config.gasTopup} ${c.nativeSymbol}` +
      `${ok ? '' : '  ✗ funder cannot cover this'}\n`,
  );
}
if (!plan.length) {
  console.log('nothing to do: every mover has USDC and gas.');
  process.exit(0);
}
if (!values.execute) {
  console.log('dry run. re-run with --execute to send these transactions.');
  process.exit(0);
}

for (const [slug, c] of chains) {
  const wallet = c.wallet(funder);
  for (const p of plan.filter((x) => x.chain === slug)) {
    const to = movers[p.mover]!.address;
    const hash =
      p.kind === 'usdc'
        ? await wallet.writeContract({ account: funder, chain: c.public.chain, address: c.token.address, abi: erc20Abi, functionName: 'transfer', args: [to, p.value] })
        : await wallet.sendTransaction({ account: funder, chain: c.public.chain, to, value: p.value });
    const r = await c.public.waitForTransactionReceipt({ hash });
    console.log(`${slug} mover #${p.mover} ${p.kind} ${r.status} ${hash}`);
  }
}
