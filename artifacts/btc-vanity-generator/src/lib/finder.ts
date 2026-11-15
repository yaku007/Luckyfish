/**
 * Main thread finder — للـ ranges الصغيرة (< 10,000).
 * ما كيستعملش Worker — مباشرة فـ الـ main thread.
 * مناسب للـ UI اللي كيحتاج نتائج فورية.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  deriveBitcoinAddress,
  deriveBitcoinAddressOnly,
  privateKeyFromRangeValue,
} from './bitcoin';
import type { MultiChainName } from '@/lib/multichain';

const PROGRESS_INTERVAL = 500;
const YIELD_INTERVAL = 2000;

// ============================================================================
// أدوات مساعدة
// ============================================================================

function privateKeyToEvmAddress(privateKey: Uint8Array): string {
  const pubKey = secp256k1.getPublicKey(privateKey, false);
  const hash = keccak_256(pubKey.subarray(1));
  let hex = '';
  for (let i = 12; i < 32; i++) {
    hex += hash[i].toString(16).padStart(2, '0');
  }
  return `0x${hex}`;
}

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
// الأنواع
// ============================================================================

export type FinderOptions = {
  startHex: string;
  endHex: string;
  targetAddress: string;
  chain?: MultiChainName;
  format?: 'legacy' | 'segwit' | 'taproot';
  signal?: AbortSignal;
  onProgress?: (p: { index: string; address: string; keysPerSecond: number }) => void;
};

export type FinderResult =
  | {
      found: true;
      result: {
        index: string;
        address: string;
        privateKeyHex: string;
        privateKeyWif: string;
      };
    }
  | { found: false };

// ============================================================================
// الدالة الرئيسية
// ============================================================================

export async function find({
  startHex,
  endHex,
  targetAddress,
  chain = 'btc',
  format = 'legacy',
  signal,
  onProgress,
}: FinderOptions): Promise<FinderResult> {
  const normalizedTarget = targetAddress.trim();
  const isBtc = chain === 'btc';
  const targetLower = normalizedTarget.toLowerCase();

  let current: bigint;
  let end: bigint;
  try {
    current = BigInt(`0x${startHex}`);
    end = BigInt(`0x${endHex}`);
  } catch {
    throw new Error('Invalid hex range.');
  }

  if (end < current) {
    throw new Error('End must be >= start.');
  }

  const startedAt = (globalThis.performance?.now ?? Date.now)();
  let checked = 0;
  let lastTime = startedAt;
  let lastChecked = 0;

  for (let i = current; i <= end; i++) {
    if (signal?.aborted) throw new Error('Search stopped.');

    let key: Uint8Array;
    let address: string;

    try {
      key = privateKeyFromRangeValue(i);
      address = isBtc
        ? deriveBitcoinAddressOnly(key, format)
        : privateKeyToEvmAddress(key);
    } catch {
      checked++;
      continue;
    }

    const isMatch = isBtc
      ? address === normalizedTarget
      : address.toLowerCase() === targetLower;

    if (isMatch) {
      let privateKeyWif = '';
      let privateKeyHex = i.toString(16).padStart(64, '0');

      if (isBtc) {
        try {
          const result = deriveBitcoinAddress(key, format);
          privateKeyWif = result.privateKeyWif;
          privateKeyHex = result.privateKeyHex;
        } catch {
          /* نكملو */
        }
      }

      return {
        found: true,
        result: {
          index: i.toString(),
          address,
          privateKeyHex,
          privateKeyWif,
        },
      };
    }

    checked++;

    if (onProgress && checked % PROGRESS_INTERVAL === 0) {
      const now = (globalThis.performance?.now ?? Date.now)();
      const intervalSeconds = Math.max((now - lastTime) / 1000, 0.001);
      const intervalChecked = checked - lastChecked;
      onProgress({
        index: i.toString(),
        address,
        keysPerSecond: Math.floor(intervalChecked / intervalSeconds),
      });
      lastTime = now;
      lastChecked = checked;
    }

    if (checked % YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }

  return { found: false };
                                   }
