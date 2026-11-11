import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export type MultiChainName = 'btc' | 'eth' | 'bnb' | 'polygon';

export const MULTI_CHAIN_OPTIONS = [
  { id: 'btc', label: 'Bitcoin', symbol: 'BTC', coinType: 0 },
  { id: 'eth', label: 'Ethereum', symbol: 'ETH', coinType: 60 },
  { id: 'bnb', label: 'BNB Smart Chain', symbol: 'BNB', coinType: 714 },
  { id: 'polygon', label: 'Polygon', symbol: 'POL', coinType: 966 },
] as const satisfies readonly {
  id: MultiChainName;
  label: string;
  symbol: string;
  coinType: number;
}[];

export const CHAIN_RPC_URLS: Record<Exclude<MultiChainName, 'btc'>, string> = {
  eth: 'https://ethereum-rpc.publicnode.com',
  bnb: 'https://bsc-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
};

export const EVM_ADDRESSES_PER_REQUEST = 100;
const EVM_RPC_MAX_ATTEMPTS = 6;
const EVM_RPC_MAX_RETRY_DELAY_MS = 60_000;

function getRetryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('Retry-After')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const retryAt = Number.isFinite(seconds)
      ? Date.now() + seconds * 1000
      : Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      const delay = Math.max(0, retryAt - Date.now());
      if (delay > 0) return Math.min(delay, EVM_RPC_MAX_RETRY_DELAY_MS);
    }
  }
  return Math.min(1000 * 2 ** attempt, 30_000);
}

function waitForRpcRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('The request was cancelled.', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('The request was cancelled.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(`0x${bytesToHex(bytes)}`);
}

function base58Encode(value: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = bytesToBigInt(value);
  let result = '';
  while (number > 0n) {
    const remainder = Number(number % 58n);
    result = alphabet[remainder] + result;
    number /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === 0) {
    leadingZeroes += 1;
  }
  return `${'1'.repeat(leadingZeroes)}${result}`;
}

function publicKeyToLegacyBitcoinAddress(publicKey: Uint8Array): string {
  const publicKeyHash = ripemd160(sha256(publicKey));
  const payload = new Uint8Array(21);
  payload[0] = 0x00;
  payload.set(publicKeyHash, 1);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const addressBytes = new Uint8Array(payload.length + checksum.length);
  addressBytes.set(payload);
  addressBytes.set(checksum, payload.length);
  return base58Encode(addressBytes);
}

export function publicKeyToEvmAddress(publicKey: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false).slice(1);
  const hash = keccak_256(uncompressed);
  return `0x${Array.from(hash.slice(-20), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function normalizePrivateKeyHex(value: string): Uint8Array {
  const raw = value.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error('Private key must be a 32-byte hex value.');
  }
  return Uint8Array.from(
    raw.match(/.{1,2}/g)!.map((byte) => Number.parseInt(byte, 16)),
  );
}

export function getMultiChainAddress(privateKeyHex: string, chain: MultiChainName): string {
  if (chain === 'btc') {
    const privateKey = normalizePrivateKeyHex(privateKeyHex);
    const publicKey = secp256k1.getPublicKey(privateKey, true);
    return publicKeyToLegacyBitcoinAddress(publicKey);
  }
  const privateKey = normalizePrivateKeyHex(privateKeyHex);
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return publicKeyToEvmAddress(publicKey);
}

// الدالة الجديدة اللي كنستعملوها فـ الـ Workers
export function deriveAddressFromPrivateKey(privateKey: Uint8Array, chain: MultiChainName): string {
  const privateKeyHex = bytesToHex(privateKey);
  return getMultiChainAddress(privateKeyHex, chain);
}

export function getMultiChainAddressFromHdKey(
  hdKey: HDKey,
  chain: MultiChainName,
  index: number,
): string {
  const path = getHdDerivationPath(chain, index);
  const derived = hdKey.derive(path);
  if (!derived.publicKey) {
    throw new Error(`No public key was available at index ${index}.`);
  }
  if (chain === 'btc') {
    return publicKeyToLegacyBitcoinAddress(derived.publicKey);
  }
  return publicKeyToEvmAddress(derived.publicKey);
}

export function getHdDerivationPath(chain: MultiChainName, index: number): string {
  if (chain === 'btc') return `m/0/0/${index}`;
  const coinType = MULTI_CHAIN_OPTIONS.find((option) => option.id === chain)?.coinType ?? 60;
  return `m/44'/${coinType}'/0'/0/${index}`;
}

export function isValidEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

export function matchesEvmVanityPattern(
  address: string,
  prefix: string,
  suffix: string,
): boolean {
  if (
    (prefix && !/^[a-fA-F0-9]{1,21}$/.test(prefix)) ||
    (suffix && !/^[a-fA-F0-9]{1,21}$/.test(suffix))
  ) {
    return false;
  }
  const normalizedAddress = address.toLowerCase();
  return (
    (!prefix || normalizedAddress.startsWith(`0x${prefix.toLowerCase()}`)) &&
    (!suffix || normalizedAddress.endsWith(suffix.toLowerCase()))
  );
}

export type EvmTokenBalance = {
  address: string;
  balanceWei: bigint;
  balanceEth: string;
};

export async function fetchEvmBalanceBatch(
  chain: Exclude<MultiChainName, 'btc'>,
  addresses: string[],
  signal?: AbortSignal,
): Promise<EvmTokenBalance[]> {
  const rpcUrl = CHAIN_RPC_URLS[chain];
  const payload = addresses.map((address, index) => ({
    jsonrpc: '2.0',
    id: index + 1,
    method: 'eth_getBalance',
    params: [address, 'latest'],
  }));

  let response: Response | undefined;
  for (let attempt = 0; attempt < EVM_RPC_MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (attempt === EVM_RPC_MAX_ATTEMPTS - 1) {
        throw new Error(`Network request failed for ${chain.toUpperCase()} after ${EVM_RPC_MAX_ATTEMPTS} attempts.`);
      }
      await waitForRpcRetry(Math.min(1000 * 2 ** attempt, 30_000), signal);
      continue;
    }

    if (response.status !== 429 && response.status < 500) break;
    if (attempt === EVM_RPC_MAX_ATTEMPTS - 1) {
      if (response.status === 429) {
        throw new Error(`${chain.toUpperCase()} RPC rate limit reached (HTTP 429) after ${EVM_RPC_MAX_ATTEMPTS} attempts. Try again later.`);
      }
      throw new Error(`RPC request failed for ${chain.toUpperCase()} with HTTP ${response.status} after ${EVM_RPC_MAX_ATTEMPTS} attempts.`);
    }
    await waitForRpcRetry(getRetryDelay(response, attempt), signal);
  }

  if (!response?.ok) {
    throw new Error(`RPC request failed for ${chain.toUpperCase()} with HTTP ${response?.status ?? 'unknown'}.`);
  }

  const json: unknown = await response.json();
  if (!Array.isArray(json)) {
    if (json && typeof json === 'object' && 'error' in json) {
      const rpcError = json.error;
      const errorMessage = rpcError && typeof rpcError === 'object' &&
        'message' in rpcError && typeof rpcError.message === 'string'
        ? rpcError.message
        : 'Unknown RPC error';
      throw new Error(`${chain.toUpperCase()} RPC request failed: ${errorMessage}`);
    }
    throw new Error(`RPC returned an invalid batch response for ${chain.toUpperCase()}.`);
  }

  const resultsById = new Map<number, Record<string, unknown>>();
  for (const value of json) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'number') {
      throw new Error(`RPC returned an invalid batch response for ${chain.toUpperCase()}.`);
    }
    resultsById.set(value.id, value);
  }

  const results: EvmTokenBalance[] = [];

  for (let index = 0; index < addresses.length; index += 1) {
    const item = resultsById.get(index + 1);
    if (!item) {
      throw new Error(`RPC omitted address ${index + 1} from the ${chain.toUpperCase()} batch response.`);
    }
    if (item.error && typeof item.error === 'object') {
      const errorMessage = 'message' in item.error && typeof item.error.message === 'string'
        ? item.error.message
        : 'Unknown RPC error';
      throw new Error(`${chain.toUpperCase()} RPC request failed: ${errorMessage}`);
    }
    const raw = item.result;
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) {
      throw new Error(`RPC returned an invalid balance for address ${index + 1} on ${chain.toUpperCase()}.`);
    }
    const balanceWei = BigInt(raw);
    if (balanceWei > 0n) {
      results.push({
        address: addresses[index],
        balanceWei,
        balanceEth: (Number(balanceWei) / 1e18).toFixed(8),
      });
    }
  }

  return results;
}
