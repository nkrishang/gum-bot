import { mnemonicToAccount, privateKeyToAccount, type Account } from 'viem/accounts';
import type { Config } from './config.ts';

export interface Wallets {
  funder: Account;
  movers: Account[];
}

/** Movers come from an explicit key list or from `m/44'/60'/0'/0/i` of a mnemonic. */
export function loadWallets(config: Config): Wallets {
  const funder = privateKeyToAccount(config.funderKey);
  const movers: Account[] = config.movers.privateKeys
    ? config.movers.privateKeys.map((k) => privateKeyToAccount(k))
    : Array.from({ length: config.movers.count }, (_, i) =>
        mnemonicToAccount(config.movers.mnemonic!, { addressIndex: i }),
      );
  const seen = new Set<string>([funder.address.toLowerCase()]);
  for (const m of movers) {
    const a = m.address.toLowerCase();
    if (seen.has(a)) throw new Error(`duplicate wallet ${m.address}: the funder and every mover must be distinct`);
    seen.add(a);
  }
  return { funder, movers };
}
