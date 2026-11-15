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

const CHAIN_COIN_TYPES: Record<MultiChainName, number> = {
  btc: 0,
  eth: 60,
  bnb: 714,
  polygon: 966,
};

const PROGRESS_INTERVAL = 100;
const YIELD_INTERVAL = 2_000;

export type HdAddressProgress = {
  index: number;
  address: string;
  keysPerSecond: number;
};

export type HdAddressMatch = {
  index: number;
  address: string;
};

// ============================================================================
// أدوات مساعدة (محسّنة)
// ============================================================================

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i += 1) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

function base58Encode(bytes: Uint8Array): string {
  let value = bytesToBigInt(bytes);
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
  return '1'.repeat(leadingZeroes) + encoded;
}

function legacyAddressFromPublicKey(publicKey: Uint8Array): string {
  const publicKeyHash = ripemd160(sha256(publicKey));
  const payload = new Uint8Array(21);
  payload[0] = 0;
  payload.set(publicKeyHash, 1);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  const addressBytes = new Uint8Array(25);
  addressBytes.set(payload, 0);
  addressBytes.set(checksum, 21);
  return base58Encode(addressBytes);
}

// yield متوافق مع Workers + Node + Browser
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof globalThis.setTimeout === 'function') {
      globalThis.setTimeout(resolve, 0);
    } else {
      void Promise.resolve().then(resolve);
    }
  });
}

// ============================================================================
// الدالة الرئيسية
// ============================================================================

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

  // ========== التحقق ==========
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
  if (!master.publicKey) {
    throw new Error('The extended key has no public key.');
  }

  // ========== BIP44: m/44'/coin'/0'/0 ==========
  const isBtc = chain === 'btc';
  const coinType = CHAIN_COIN_TYPES[chain];

  let accountNode: HDKey;
  try {
    accountNode = master.derive(`m/44'/${coinType}'/0'/0`);
  } catch {
    throw new Error('Could not derive the BIP44 account path.');
  }

  // ========== الحلقة ==========
  const startedAt = (globalThis.performance?.now ?? Date.now)();
  let checked = 0;
  let lastProgressTime = startedAt;
  let lastProgressChecked = 0;

  for (let index = startIndex; index <= endIndex; index += 1) {
    if (signal?.aborted) throw new Error('Search stopped.');

    let child: HDKey;
    try {
      child = accountNode.deriveChild(index);
    } catch {
      throw new Error(`Could not derive address index ${index}.`);
    }

    if (!child.publicKey) {
      throw new Error(`No public key was available at index ${index}.`);
    }

    const address = isBtc
      ? legacyAddressFromPublicKey(child.publicKey)
      : publicKeyToEvmAddress(child.publicKey);

    if (address === normalizedTarget) {
      return { index, address };
    }

    checked += 1;

    if (onProgress && checked % PROGRESS_INTERVAL === 0) {
      const now = (globalThis.performance?.now ?? Date.now)();
      const intervalSeconds = Math.max((now - lastProgressTime) / 1000, 0.001);
      const intervalChecked = checked - lastProgressChecked;
      onProgress({
        index,
        address,
        keysPerSecond: Math.floor(intervalChecked / intervalSeconds),
      });
      lastProgressTime = now;
      lastProgressChecked = checked;
    }

    if (checked % YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }

  return null;
}
