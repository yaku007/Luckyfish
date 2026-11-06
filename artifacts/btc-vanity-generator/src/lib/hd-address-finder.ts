import { HDKey } from '@scure/bip32';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { isValidBitcoinAddressTarget } from '@/lib/bitcoin';
import {
  isValidEvmAddress,
  publicKeyToEvmAddress,
  type MultiChainName,
} from '@/lib/multichain';

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export type HdAddressProgress = {
  index: number;
  address: string;
  keysPerSecond: number;
};

export type HdAddressMatch = {
  index: number;
  address: string;
};

function base58Encode(bytes: Uint8Array): string {
  let value = BigInt(
    `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
  );
  let encoded = '';

  while (value > 0n) {
    const digit = Number(value % 58n);
    encoded = BASE58_ALPHABET[digit] + encoded;
    value /= 58n;
  }

  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) {
    leadingZeroes += 1;
  }

  return `${'1'.repeat(leadingZeroes)}${encoded}`;
}

function legacyAddressFromPublicKey(publicKey: Uint8Array): string {
  const publicKeyHash = ripemd160(sha256(publicKey));
  const payload = new Uint8Array(21);
  payload[0] = 0;
  payload.set(publicKeyHash, 1);

  const checksum = sha256(sha256(payload)).slice(0, 4);
  const addressBytes = new Uint8Array(payload.length + checksum.length);
  addressBytes.set(payload);
  addressBytes.set(checksum, payload.length);
  return base58Encode(addressBytes);
}

export async function findHdAddressByXpub({
  xpub,
  startIndex,
  endIndex,
  targetAddress,
  chain = 'btc',
  signal,
  onProgress,
}: {
  xpub: string;
  startIndex: number;
  endIndex: number;
  targetAddress: string;
  chain?: MultiChainName;
  signal?: AbortSignal;
  onProgress?: (progress: HdAddressProgress) => void;
}): Promise<HdAddressMatch | null> {
  const normalizedKey = xpub.trim();
  const normalizedTarget = targetAddress.trim();

  if (!normalizedKey.startsWith('xpub')) {
    throw new Error('Enter a mainnet xpub. Private extended keys are not accepted.');
  }
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) {
    throw new Error('Indexes must be whole numbers.');
  }
  if (startIndex < 0 || endIndex < startIndex || endIndex > 0x7fffffff) {
    throw new Error('Enter a valid index range.');
  }
  if (endIndex - startIndex > 100_000) {
    throw new Error('Search ranges are limited to 100,001 addresses per run.');
  }
  if (chain === 'btc' && !isValidBitcoinAddressTarget(normalizedTarget, 'legacy')) {
    throw new Error('Enter a valid mainnet Legacy Bitcoin address.');
  }
  if (chain !== 'btc' && !isValidEvmAddress(normalizedTarget)) {
    throw new Error(`Enter a valid ${chain.toUpperCase()} address.`);
  }

  let master: HDKey;
  try {
    master = HDKey.fromExtendedKey(normalizedKey);
  } catch {
    throw new Error('The extended key is invalid.');
  }

  if (master.privateKey) {
    throw new Error('Enter a public xpub, not a private extended key.');
  }

  const startedAt = performance.now();
  let checked = 0;
  for (let index = startIndex; index <= endIndex; index += 1) {
    if (signal?.aborted) throw new Error('Search stopped.');

    let child: HDKey;
    try {
      child = master.derive(chain === 'btc' ? `m/0/0/${index}` : `m/0/${index}`);
    } catch {
      throw new Error(`Could not derive address index ${index}.`);
    }

    if (!child.publicKey) {
      throw new Error(`No public key was available at index ${index}.`);
    }

    const address = chain === 'btc'
      ? legacyAddressFromPublicKey(child.publicKey)
      : publicKeyToEvmAddress(child.publicKey);
    if (address === normalizedTarget) {
      return { index, address };
    }

    checked += 1;
    if (onProgress && checked % 100 === 0) {
      const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
      onProgress({
        index,
        address,
        keysPerSecond: Math.floor(checked / elapsedSeconds),
      });
    }

    if (checked % 1_000 === 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  return null;
    }
