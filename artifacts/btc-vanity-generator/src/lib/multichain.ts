import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

// ============================================================================
// الأنواع والثوابت
// ============================================================================

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
const EVM_RPC_TIMEOUT_MS = 30_000;
const EVM_MAX_CONCURRENT_CHUNKS = 4;

// إعدادات الكاش
const ADDRESS_CACHE_MAX_SIZE = 10_000;
const BALANCE_CACHE_MAX_SIZE = 5_000;
const BALANCE_CACHE_TTL_MS = 30_000;

// ثوابت مشتركة
const WEI_PER_ETH = 10n ** 18n;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const HEX_REGEX = /^[0-9a-fA-F]{64}$/;
const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const HEX_BALANCE_REGEX = /^0x[0-9a-fA-F]+$/;
const VANITY_HEX_REGEX = /^[a-fA-F0-9]{1,21}$/;

// ============================================================================
// LRU Cache عام
// ============================================================================

class LRUCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxSize: number;
  public hits = 0;
  public misses = 0;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }
}

// ============================================================================
// كاشات محددة
// ============================================================================

const addressCache = new LRUCache<string, string>(ADDRESS_CACHE_MAX_SIZE);
const hdAddressCache = new LRUCache<string, string>(ADDRESS_CACHE_MAX_SIZE);

type CachedBalance = { balanceWei: bigint; cachedAt: number };
const balanceCache = new LRUCache<string, CachedBalance>(BALANCE_CACHE_MAX_SIZE);

// ============================================================================
// كاش persistent اختياري (Cloudflare KV)
// ============================================================================

export type KVNamespace = {
  get(key: string, type?: 'text' | 'json'): Promise<string | null | unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

let kvNamespace: KVNamespace | null = null;

/**
 * تركيب KV namespace اختياري (فـ Cloudflare Workers).
 * إلا ما تركّبش، الكاش كيبقى غير فـ الذاكرة.
 */
export function setKvNamespace(kv: KVNamespace | null): void {
  kvNamespace = kv;
}

async function kvGetBalance(
  chain: Exclude<MultiChainName, 'btc'>,
  address: string,
): Promise<CachedBalance | null> {
  if (!kvNamespace) return null;
  try {
    const raw = await kvNamespace.get(`bal:${chain}:${address.toLowerCase()}`);
    if (typeof raw !== 'string') return null;
    const parsed = JSON.parse(raw) as { w: string; t: number };
    if (typeof parsed.w !== 'string' || typeof parsed.t !== 'number') return null;
    return { balanceWei: BigInt(parsed.w), cachedAt: parsed.t };
  } catch {
    return null;
  }
}

async function kvSetBalance(
  chain: Exclude<MultiChainName, 'btc'>,
  address: string,
  balance: CachedBalance,
): Promise<void> {
  if (!kvNamespace) return;
  try {
    const ttlSeconds = Math.max(60, Math.ceil(BALANCE_CACHE_TTL_MS / 1000));
    await kvNamespace.put(
      `bal:${chain}:${address.toLowerCase()}`,
      JSON.stringify({ w: balance.balanceWei.toString(), t: balance.cachedAt }),
      { expirationTtl: ttlSeconds },
    );
  } catch {
    // تجاهل أخطاء KV — الكاش ماشي حرج
  }
}

// ============================================================================
// أدوات مساعدة
// ============================================================================

function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 1) {
    result += bytes[i].toString(16).padStart(2, '0');
  }
  return result;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i += 1) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

function base58Encode(value: Uint8Array): string {
  let number = bytesToBigInt(value);
  let result = '';
  while (number > 0n) {
    const remainder = Number(number % 58n);
    result = BASE58_ALPHABET[remainder] + result;
    number /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === 0) {
    leadingZeroes += 1;
  }
  return '1'.repeat(leadingZeroes) + result;
}

function formatWeiToEth(balanceWei: bigint): string {
  const whole = balanceWei / WEI_PER_ETH;
  const fraction = balanceWei % WEI_PER_ETH;
  const fractionStr = fraction.toString().padStart(18, '0').slice(0, 8);
  return `${whole}.${fractionStr}`;
}

// ============================================================================
// توليد العناوين
// ============================================================================

function publicKeyToLegacyBitcoinAddress(publicKey: Uint8Array): string {
  const publicKeyHash = ripemd160(sha256(publicKey));
  const payload = new Uint8Array(21);
  payload[0] = 0x00;
  payload.set(publicKeyHash, 1);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  const addressBytes = new Uint8Array(25);
  addressBytes.set(payload, 0);
  addressBytes.set(checksum, 21);
  return base58Encode(addressBytes);
}

export function publicKeyToEvmAddress(publicKey: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false).subarray(1);
  const hash = keccak_256(uncompressed);
  return `0x${bytesToHex(hash.subarray(12))}`;
}

function normalizePrivateKeyHex(value: string): Uint8Array {
  const raw = value.trim().replace(/^0x/i, '');
  if (!HEX_REGEX.test(raw)) {
    throw new Error('Private key must be a 32-byte hex value.');
  }
  const result = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    result[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}

function generateAddressUncached(privateKeyHex: string, chain: MultiChainName): string {
  const privateKey = normalizePrivateKeyHex(privateKeyHex);
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  if (chain === 'btc') {
    return publicKeyToLegacyBitcoinAddress(publicKey);
  }
  return publicKeyToEvmAddress(publicKey);
}

export function getMultiChainAddress(privateKeyHex: string, chain: MultiChainName): string {
  const normalizedKey = privateKeyHex.trim().replace(/^0x/i, '').toLowerCase();
  const cacheKey = `${chain}:${normalizedKey}`;

  const cached = addressCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const address = generateAddressUncached(privateKeyHex, chain);
  addressCache.set(cacheKey, address);
  return address;
}

export function deriveAddressFromPrivateKey(privateKey: Uint8Array, chain: MultiChainName): string {
  return getMultiChainAddress(bytesToHex(privateKey), chain);
}

export function getHdDerivationPath(
  chain: MultiChainName,
  index: number,
  useLegacyBtcPath = false,
): string {
  if (chain === 'btc' && useLegacyBtcPath) return `m/0/0/${index}`;
  const coinType = MULTI_CHAIN_OPTIONS.find((option) => option.id === chain)?.coinType ?? 60;
  return `m/44'/${coinType}'/0'/0/${index}`;
}

export function getMultiChainAddressFromHdKey(
  hdKey: HDKey,
  chain: MultiChainName,
  index: number,
  useLegacyBtcPath = false,
): string {
  if (!hdKey.publicKey) {
    throw new Error('HDKey must have a public key.');
  }
  const hdFingerprint = bytesToHex(hdKey.publicKey);
  const cacheKey = `${hdFingerprint}:${chain}:${index}:${useLegacyBtcPath ? 1 : 0}`;

  const cached = hdAddressCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const path = getHdDerivationPath(chain, index, useLegacyBtcPath);
  const derived = hdKey.derive(path);
  if (!derived.publicKey) {
    throw new Error(`No public key was available at index ${index}.`);
  }

  const address =
    chain === 'btc'
      ? publicKeyToLegacyBitcoinAddress(derived.publicKey)
      : publicKeyToEvmAddress(derived.publicKey);

  hdAddressCache.set(cacheKey, address);
  return address;
}

// ============================================================================
// Prewarm — تعمير الكاش مسبقاً
// ============================================================================

/**
 * توليد عناوين من HDKey مسبقاً وتخزينها فـ الكاش.
 * مفيد إلا كنتي عارف أنك غادي تحتاج عناوين 0..N.
 */
export function prewarmHdAddresses(
  hdKey: HDKey,
  chains: MultiChainName[],
  startIndex: number,
  count: number,
  useLegacyBtcPath = false,
): number {
  let generated = 0;
  for (const chain of chains) {
    for (let i = startIndex; i < startIndex + count; i += 1) {
      getMultiChainAddressFromHdKey(hdKey, chain, i, useLegacyBtcPath);
      generated += 1;
    }
  }
  return generated;
}

/**
 * توليد عناوين من مفاتيح خاصة مسبقاً.
 */
export function prewarmPrivateKeyAddresses(
  privateKeysHex: string[],
  chains: MultiChainName[],
): number {
  let generated = 0;
  for (const key of privateKeysHex) {
    for (const chain of chains) {
      try {
        getMultiChainAddress(key, chain);
        generated += 1;
      } catch {
        // تجاهل المفاتيح غير الصالحة
      }
    }
  }
  return generated;
}

/**
 * تعمير كاش الأرصدة مسبقاً (كيبعث للشبكة).
 */
export async function prewarmBalances(
  chain: Exclude<MultiChainName, 'btc'>,
  addresses: string[],
  signal?: AbortSignal,
): Promise<number> {
  const results = await fetchEvmBalanceBatch(chain, addresses, signal, false);
  return results.length;
}

// ============================================================================
// التحقق من العناوين
// ============================================================================

export function isValidEvmAddress(value: string): boolean {
  return EVM_ADDRESS_REGEX.test(value.trim());
}

export function matchesEvmVanityPattern(
  address: string,
  prefix: string,
  suffix: string,
): boolean {
  if (
    (prefix && !VANITY_HEX_REGEX.test(prefix)) ||
    (suffix && !VANITY_HEX_REGEX.test(suffix))
  ) {
    return false;
  }
  const normalizedAddress = address.toLowerCase();
  return (
    (!prefix || normalizedAddress.startsWith(`0x${prefix.toLowerCase()}`)) &&
    (!suffix || normalizedAddress.endsWith(suffix.toLowerCase()))
  );
}

// ============================================================================
// أدوات الشبكة
// ============================================================================

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

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EVM_RPC_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutId);
      throw new DOMException('The request was cancelled.', 'AbortError');
    }
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

// ============================================================================
// جلب الأرصدة
// ============================================================================

export type EvmTokenBalance = {
  address: string;
  balanceWei: bigint;
  balanceEth: string;
};

async function fetchEvmBalanceBatchChunk(
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
    if (signal?.aborted) {
      throw new DOMException('The request was cancelled.', 'AbortError');
    }

    try {
      response = await fetchWithTimeout(
        rpcUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      if (attempt === EVM_RPC_MAX_ATTEMPTS - 1) {
        throw new Error(
          `Network request failed for ${chain.toUpperCase()} after ${EVM_RPC_MAX_ATTEMPTS} attempts.`,
        );
      }
      await waitForRpcRetry(Math.min(1000 * 2 ** attempt, 30_000), signal);
      continue;
    }

    if (response.status !== 429 && response.status < 500) break;
    if (attempt === EVM_RPC_MAX_ATTEMPTS - 1) {
      if (response.status === 429) {
        throw new Error(
          `${chain.toUpperCase()} RPC rate limit reached (HTTP 429) after ${EVM_RPC_MAX_ATTEMPTS} attempts. Try again later.`,
        );
      }
      throw new Error(
        `RPC request failed for ${chain.toUpperCase()} with HTTP ${response.status} after ${EVM_RPC_MAX_ATTEMPTS} attempts.`,
      );
    }
    await waitForRpcRetry(getRetryDelay(response, attempt), signal);
  }

  if (!response?.ok) {
    throw new Error(
      `RPC request failed for ${chain.toUpperCase()} with HTTP ${response?.status ?? 'unknown'}.`,
    );
  }

  const json: unknown = await response.json();
  if (!Array.isArray(json)) {
    if (json && typeof json === 'object' && 'error' in json) {
      const rpcError = (json as { error: unknown }).error;
      const errorMessage =
        rpcError && typeof rpcError === 'object' && 'message' in rpcError &&
        typeof (rpcError as { message: unknown }).message === 'string'
          ? (rpcError as { message: string }).message
          : 'Unknown RPC error';
      throw new Error(`${chain.toUpperCase()} RPC request failed: ${errorMessage}`);
    }
    throw new Error(`RPC returned an invalid batch response for ${chain.toUpperCase()}.`);
  }

  const resultsById = new Map<number, Record<string, unknown>>();
  for (const value of json) {
    if (!value || typeof value !== 'object' || typeof (value as { id: unknown }).id !== 'number') {
      throw new Error(`RPC returned an invalid batch response for ${chain.toUpperCase()}.`);
    }
    resultsById.set((value as { id: number }).id, value as Record<string, unknown>);
  }

  const results: EvmTokenBalance[] = [];
  const now = Date.now();

  for (let index = 0; index < addresses.length; index += 1) {
    const item = resultsById.get(index + 1);
    if (!item) {
      throw new Error(
        `RPC omitted address ${index + 1} from the ${chain.toUpperCase()} batch response.`,
      );
    }
    if (item.error && typeof item.error === 'object') {
      const errorMessage =
        'message' in item.error && typeof (item.error as { message: unknown }).message === 'string'
          ? (item.error as { message: string }).message
          : 'Unknown RPC error';
      throw new Error(`${chain.toUpperCase()} RPC request failed: ${errorMessage}`);
    }
    const raw = item.result;
    if (typeof raw !== 'string' || !HEX_BALANCE_REGEX.test(raw)) {
      throw new Error(
        `RPC returned an invalid balance for address ${index + 1} on ${chain.toUpperCase()}.`,
      );
    }
    const balanceWei = BigInt(raw);

    const address = addresses[index];
    const cached: CachedBalance = { balanceWei, cachedAt: now };
    balanceCache.set(`${chain}:${address.toLowerCase()}`, cached);
    void kvSetBalance(chain, address, cached);

    if (balanceWei > 0n) {
      results.push({
        address,
        balanceWei,
        balanceEth: formatWeiToEth(balanceWei),
      });
    }
  }

  return results;
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= tasks.length) return;
      results[current] = await tasks[current]();
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

export async function fetchEvmBalanceBatch(
  chain: Exclude<MultiChainName, 'btc'>,
  addresses: string[],
  signal?: AbortSignal,
  useCache = true,
): Promise<EvmTokenBalance[]> {
  if (addresses.length === 0) return [];

  const uniqueAddresses = Array.from(new Set(addresses));
  const now = Date.now();
  const results: EvmTokenBalance[] = [];
  const toFetch: string[] = [];

  // فحص الكاش المحلي أولاً + KV بالتوازي
  const kvChecks: Array<Promise<{ address: string; cached: CachedBalance | null }>> = [];

  for (const address of uniqueAddresses) {
    if (!useCache) {
      toFetch.push(address);
      continue;
    }
    const cacheKey = `${chain}:${address.toLowerCase()}`;
    const cached = balanceCache.get(cacheKey);
    if (cached && now - cached.cachedAt < BALANCE_CACHE_TTL_MS) {
      if (cached.balanceWei > 0n) {
        results.push({
          address,
          balanceWei: cached.balanceWei,
          balanceEth: formatWeiToEth(cached.balanceWei),
        });
      }
      continue;
    }
    // ما لقيناش فـ الذاكرة — نجربو KV إلا كان متوفر
    if (kvNamespace) {
      kvChecks.push(
        kvGetBalance(chain, address).then((kvCached) => ({ address, cached: kvCached })),
      );
    } else {
      toFetch.push(address);
    }
  }

  // معالجة نتائج KV
  if (kvChecks.length > 0) {
    const kvResults = await Promise.all(kvChecks);
    for (const { address, cached } of kvResults) {
      if (cached && now - cached.cachedAt < BALANCE_CACHE_TTL_MS) {
        balanceCache.set(`${chain}:${address.toLowerCase()}`, cached);
        if (cached.balanceWei > 0n) {
          results.push({
            address,
            balanceWei: cached.balanceWei,
            balanceEth: formatWeiToEth(cached.balanceWei),
          });
        }
      } else {
        toFetch.push(address);
      }
    }
  }

  if (toFetch.length === 0) return results;

  // تقسيم لـ chunks
  const chunks: string[][] = [];
  for (let i = 0; i < toFetch.length; i += EVM_ADDRESSES_PER_REQUEST) {
    chunks.push(toFetch.slice(i, i + EVM_ADDRESSES_PER_REQUEST));
  }

  const tasks = chunks.map((chunk) => () =>
    fetchEvmBalanceBatchChunk(chain, chunk, signal),
  );

  const chunkResults = await runWithConcurrency(tasks, EVM_MAX_CONCURRENT_CHUNKS);

  for (const chunkResult of chunkResults) {
    results.push(...chunkResult);
  }

  return results;
}

// ============================================================================
// إحصائيات وإدارة الكاش
// ============================================================================

export type CacheStats = {
  address: { size: number; hits: number; misses: number; hitRate: number };
  hdAddress: { size: number; hits: number; misses: number; hitRate: number };
  balance: { size: number; hits: number; misses: number; hitRate: number };
  kvEnabled: boolean;
};

export const CacheControl = {
  /** إحصائيات كل الكاشات */
  stats(): CacheStats {
    return {
      address: {
        size: addressCache.size,
        hits: addressCache.hits,
        misses: addressCache.misses,
        hitRate: addressCache.hitRate,
      },
      hdAddress: {
        size: hdAddressCache.size,
        hits: hdAddressCache.hits,
        misses: hdAddressCache.misses,
        hitRate: hdAddressCache.hitRate,
      },
      balance: {
        size: balanceCache.size,
        hits: balanceCache.hits,
        misses: balanceCache.misses,
        hitRate: balanceCache.hitRate,
      },
      kvEnabled: kvNamespace !== null,
    };
  },

  /** مسح كل الكاشات */
  clearAll(): void {
    addressCache.clear();
    hdAddressCache.clear();
    balanceCache.clear();
  },

  /** مسح كاش العناوين فقط */
  clearAddresses(): void {
    addressCache.clear();
    hdAddressCache.clear();
  },

  /** مسح كاش الأرصدة فقط */
  clearBalances(): void {
    balanceCache.clear();
  },

  /** حذف رصيد واحد (إجبار refresh) */
  invalidateBalance(chain: Exclude<MultiChainName, 'btc'>, address: string): void {
    balanceCache.delete(`${chain}:${address.toLowerCase()}`);
  },

  /** حذف عنوان واحد من الكاش */
  invalidateAddress(privateKeyHex: string, chain: MultiChainName): void {
    const normalizedKey = privateKeyHex.trim().replace(/^0x/i, '').toLowerCase();
    addressCache.delete(`${chain}:${normalizedKey}`);
  },
};
