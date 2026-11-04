import type { MultiChainName } from './multichain';

type QueuedBalanceCheck = {
  addresses: string[];
  chain: MultiChainName;
};

let pendingBalanceCheck: QueuedBalanceCheck | null = null;

export function queueBalanceCheck(
  addresses: string[],
  chain: MultiChainName = 'btc',
): void {
  pendingBalanceCheck = { addresses, chain };
}

export function takeQueuedBalanceCheck(): QueuedBalanceCheck | null {
  const pending = pendingBalanceCheck;
  pendingBalanceCheck = null;
  return pending;
}
