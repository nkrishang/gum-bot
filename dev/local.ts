/**
 * One-command local environment: three Anvil chains (with Monad, Base and Arbitrum chain ids), the
 * real PaymentFactory and a mock USDC deployed on each, a mock Gum API that settles through the
 * factory, and the bot itself pointed at all of it.
 *
 *   pnpm local                                              # 50 movers, dashboard on :8080
 *   pnpm local --movers 9 --fail-rate 0.05 --api-latency 80
 *   pnpm local --infra-only                                 # chains + mock Gum only; prints env for `pnpm dev`
 *   pnpm local --rpc-port 9545 --gum-port 9090 --port 9080  # alongside another instance
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  toHex,
  type Abi,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { arbitrum, base, monad } from 'viem/chains';
import { CHAIN_INFO } from '../src/config.ts';
import { startMockGum, type MockChain } from './mock-gum.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  // pnpm forwards a literal `--` (`pnpm local -- --movers 9`); accept both spellings.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    movers: { type: 'string', default: '50' },
    'fail-rate': { type: 'string', default: '0' },
    'api-latency': { type: 'string', default: '0' },
    'block-time': { type: 'string', default: '1' },
    port: { type: 'string', default: '8080' },
    'gum-port': { type: 'string', default: '8090' },
    'rpc-port': { type: 'string', default: '8545' },
    'data-dir': { type: 'string' },
    'infra-only': { type: 'boolean', default: false },
    'keep-data': { type: 'boolean', default: false },
  },
});

const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const MOVER_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const API_KEY = 'gum_sk_local_dev';
const WEBHOOK_SECRET = 'local-webhook-secret';
const acct = (i: number) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i });
const deployer = acct(0);
const funder = acct(1);
const recovery = acct(8);
const settler = acct(9);
const moverCount = Number(args.movers);
const movers = Array.from({ length: moverCount }, (_, i) => mnemonicToAccount(MOVER_MNEMONIC, { addressIndex: i }));

const rpcPort = Number(args['rpc-port']);
const CHAINS: Array<{ slug: 'monad' | 'base' | 'arbitrum'; chain: Chain; port: number }> = [
  { slug: 'monad', chain: monad, port: rpcPort },
  { slug: 'base', chain: base, port: rpcPort + 1 },
  { slug: 'arbitrum', chain: arbitrum, port: rpcPort + 2 },
];

const artifact = (name: string) =>
  JSON.parse(readFileSync(join(root, 'dev/artifacts', `${name}.json`), 'utf8')) as { abi: Abi; bytecode: Hex };

const children: ChildProcess[] = [];
let bot: ChildProcess | undefined;
function cleanup() {
  for (const c of children) c.kill('SIGTERM');
}
process.on('exit', cleanup);
// Ctrl-C / SIGTERM: let the bot shut down gracefully first; its exit tears down the chains.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (bot && bot.exitCode === null) bot.kill('SIGTERM');
    else process.exit(0);
  });
}

async function startAnvil(port: number, chainId: number) {
  const child = spawn(
    'anvil',
    ['--port', String(port), '--chain-id', String(chainId), '--block-time', args['block-time']!, '--silent', '--mnemonic', ANVIL_MNEMONIC],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  children.push(child);
  child.on('exit', (code) => {
    if (code) console.error(`anvil on :${port} exited with ${code}`);
  });
  const client = createPublicClient({ transport: http(`http://127.0.0.1:${port}`) });
  for (let i = 0; i < 100; i++) {
    try {
      await client.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`anvil on :${port} did not start (is Foundry installed? https://getfoundry.sh)`);
}

async function setupChain(slug: 'monad' | 'base' | 'arbitrum', chain: Chain, port: number, preferredMovers: typeof movers): Promise<MockChain> {
  const url = `http://127.0.0.1:${port}`;
  const local: Chain = { ...chain, rpcUrls: { default: { http: [url] } } };
  const pub = createPublicClient({ chain: local, transport: http(url) }) as PublicClient;
  const wallet = createWalletClient({ account: deployer, chain: local, transport: http(url) });

  const deploy = async (name: string, args: unknown[] = []) => {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet.deployContract({ abi, bytecode, args });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    return receipt.contractAddress!;
  };
  // The mock USDC lives at the real USDC address, so the bot runs with its production registry.
  const token = CHAIN_INFO[slug].usdc;
  const deployed = await deploy('MockStablecoin', ['USD Coin', 'USDC']);
  const code = await pub.getCode({ address: deployed });
  await pub.request({ method: 'anvil_setCode' as never, params: [token, code] as never });
  for (let slot = 0; slot < 4; slot++) {
    // name/symbol live in the first slots; copy them so the token reads as "USD Coin" / "USDC".
    const value = await pub.getStorageAt({ address: deployed, slot: toHex(slot, { size: 32 }) });
    await pub.request({ method: 'anvil_setStorageAt' as never, params: [token, toHex(slot, { size: 32 }), value] as never });
  }
  const factory = await deploy('PaymentFactory');

  // A modest funder, so "funder low" and top-up arithmetic look like production.
  await pub.request({ method: 'anvil_setBalance' as never, params: [funder.address, `0x${parseEther('1').toString(16)}`] as never });
  // Each mover starts with 1 USDC on its preferred chain and no gas: the bot's first job is to fuel them.
  const { abi } = artifact('MockStablecoin');
  for (const mv of preferredMovers) {
    const hash = await wallet.writeContract({ address: token, abi, functionName: 'mint', args: [mv.address, 1_000_000n] });
    await pub.waitForTransactionReceipt({ hash });
  }
  const settlerWallet = createWalletClient({ account: settler, chain: local, transport: http(url) });
  return { slug, chain: local, public: pub, settler: settlerWallet, settlerAccount: settler, token, factory };
}

async function main() {
  console.log(`▸ starting 3 anvil chains (block time ${args['block-time']}s)`);
  await Promise.all(CHAINS.map((c) => startAnvil(c.port, c.chain.id)));

  console.log(`▸ deploying PaymentFactory + mock USDC, funding ${moverCount} movers with 1 USDC each`);
  const mockChains = await Promise.all(
    CHAINS.map((c, ci) => setupChain(c.slug, c.chain, c.port, movers.filter((_, i) => i % CHAINS.length === ci))),
  );

  const gumPort = Number(args['gum-port']);
  const botPort = Number(args.port);
  const mock = startMockGum({
    port: gumPort,
    apiKey: API_KEY,
    chains: mockChains,
    recovery: recovery.address,
    webhookSecret: WEBHOOK_SECRET,
    failRate: Number(args['fail-rate']),
    latencyMs: Number(args['api-latency']),
    log: (msg) => console.error(`[mock-gum] ${msg}`),
  });
  console.log(`▸ mock Gum API on http://127.0.0.1:${gumPort} (key ${API_KEY})`);

  const env: Record<string, string> = {
    GUM_API_URL: `http://127.0.0.1:${gumPort}`,
    GUM_API_KEY: API_KEY,
    GUM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PUBLIC_URL: `http://127.0.0.1:${botPort}`,
    FUNDER_PRIVATE_KEY: `0x${Buffer.from(funder.getHdKey().privateKey!).toString('hex')}`,
    MOVER_MNEMONIC,
    MOVER_COUNT: String(moverCount),
    CHAINS: 'monad,base,arbitrum',
    RPC_URL_MONAD: `http://127.0.0.1:${CHAINS[0]!.port}`,
    RPC_URL_BASE: `http://127.0.0.1:${CHAINS[1]!.port}`,
    RPC_URL_ARBITRUM: `http://127.0.0.1:${CHAINS[2]!.port}`,
    GAS_MIN_MONAD: '0.001',
    GAS_TOPUP_MONAD: '0.004',
    FUNDER_MIN_MONAD: '0.5',
    GAS_MIN_BASE: '0.001',
    GAS_TOPUP_BASE: '0.004',
    FUNDER_MIN_BASE: '0.5',
    GAS_MIN_ARBITRUM: '0.001',
    GAS_TOPUP_ARBITRUM: '0.004',
    FUNDER_MIN_ARBITRUM: '0.5',
    CYCLE_MIN_INTERVAL_MS: '5000',
    CYCLE_SETTLE_TIMEOUT_MS: '120000',
    STATUS_POLL_INTERVAL_MS: '1000',
    BALANCE_REFRESH_MS: '5000',
    DEPOSIT_EXPIRY_SECS: '600',
    MAX_DEPOSITS_PER_MINUTE: '0',
    PORT: String(botPort),
    DATA_DIR: args['data-dir'] ?? join(root, 'data/local'),
    LOG_FORMAT: 'pretty',
  };

  if (args['infra-only']) {
    console.log('\nInfra is up. Run the bot against it with:\n');
    console.log(Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' \\\n  ') + ' \\\n  pnpm dev\n');
    await new Promise(() => {});
  }

  if (!args['keep-data']) rmSync(env.DATA_DIR!, { recursive: true, force: true });
  if (!existsSync(join(root, 'dist/web/index.html'))) {
    console.log('▸ building dashboard');
    await run('pnpm', ['exec', 'vite', 'build', '--config', 'web/vite.config.ts', '--logLevel', 'warn']);
  }

  console.log(`▸ starting gum-bot → dashboard http://localhost:${botPort}\n`);
  bot = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/index.ts'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  children.push(bot);
  bot.on('exit', (code) => {
    mock.close();
    cleanup();
    process.exit(code ?? 0);
  });
}

function run(cmd: string, argv: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, argv, { cwd: root, stdio: 'inherit' });
    p.on('exit', (code) => (code ? reject(new Error(`${cmd} exited with ${code}`)) : resolve()));
  });
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
