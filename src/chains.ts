import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseUnits,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { arbitrum, base, monad } from 'viem/chains';
import { CHAIN_INFO, USDC_DECIMALS, type ChainConfig, type ChainSlug } from './config.ts';
import { TokenBucket } from './ratelimit.ts';

const VIEM_CHAINS: Record<ChainSlug, Chain> = { monad, base, arbitrum };

export interface ChainRuntime {
  slug: ChainSlug;
  chainId: number;
  nativeSymbol: string;
  explorerUrl: string;
  config: ChainConfig;
  gasMin: bigint;
  gasTopup: bigint;
  funderMin: bigint;
  /** Circle's native USDC on this chain. */
  token: { address: `0x${string}`; decimals: number; symbol: string };
  public: PublicClient;
  wallet(account: Account): WalletClient;
  /** Paces every RPC call (reads, sends, receipt polls) to the provider's limit. */
  rpcLimiter: TokenBucket;
}

/**
 * Wraps a transport so each JSON-RPC call first takes a token. Providers count every call inside a
 * batch (QuickNode Build: 50/s), so pacing happens per call, before viem groups them into batches.
 */
function paced(transport: Transport, bucket: TokenBucket): Transport {
  return ((opts) => {
    const t = transport(opts);
    const request = (async (args, options) => {
      await bucket.take();
      return t.request(args, options);
    }) as typeof t.request;
    return { ...t, request };
  }) as Transport;
}

export function createChainRuntime(cfg: ChainConfig): ChainRuntime {
  const info = CHAIN_INFO[cfg.slug];
  const base = VIEM_CHAINS[cfg.slug];
  const chain: Chain = { ...base, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
  // One budget for every client on this chain. Any rolling second can see rate + burst calls, so the
  // burst is kept small: at RPC_RPS 40 that is at most 48, under a 50/s provider cap.
  const rpcLimiter = new TokenBucket(cfg.rpcRps, Math.max(1, Math.floor(cfg.rpcRps / 5)));
  // Balance sweeps issue dozens of reads at once; batching keeps them to a few HTTP requests.
  const transport = paced(http(cfg.rpcUrl, { batch: { batchSize: 20, wait: 10 }, retryCount: 3, timeout: 20_000 }), rpcLimiter);
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  const wallets = new Map<string, WalletClient>();
  return {
    slug: cfg.slug,
    chainId: base.id,
    nativeSymbol: base.nativeCurrency.symbol,
    explorerUrl: info.explorer,
    config: cfg,
    gasMin: parseUnits(cfg.gasMin, 18),
    gasTopup: parseUnits(cfg.gasTopup, 18),
    funderMin: parseUnits(cfg.funderMin, 18),
    token: { address: info.usdc, decimals: USDC_DECIMALS, symbol: 'USDC' },
    public: pub,
    rpcLimiter,
    wallet(account) {
      let w = wallets.get(account.address);
      if (!w) {
        w = createWalletClient({ account, chain, transport: paced(http(cfg.rpcUrl, { retryCount: 1, timeout: 30_000 }), rpcLimiter) });
        wallets.set(account.address, w);
      }
      return w;
    },
  };
}

export { erc20Abi };
