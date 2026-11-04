let pendingAddresses: string[] | null = null;

export function queueBalanceCheck(addresses: string[]): void {
  pendingAddresses = addresses;
}

export function takeQueuedBalanceCheck(): string[] | null {
  const addresses = pendingAddresses;
  pendingAddresses = null;
  return addresses;
}
