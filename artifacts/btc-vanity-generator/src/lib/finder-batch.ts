/**
 * Batch processing للـ finder.
 * كيعالج 256 مفتاح فـ batch، وكيقلل overhead استدعاءات الدوال.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  deriveBitcoinAddress,
  deriveBitcoinAddressOnly,
  privateKeyFromRangeValue,
} from './bitcoin';
import type { MultiChainName } from '@/lib/multichain';

const BATCH_SIZE = 256;

// ============================================================================
// أدوات مساعدة (محسّنة)
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

export type BatchFinderOptions = {
  startHex: string;
  endHex: string;
  targetAddress: string;
  chain?: MultiChainName;
  format?: 'legacy' | 'segwit' | 'taproot';
  signal?: AbortSignal;
  onProgress?: (p: { index: string; keysPerSecond: number; checked: number }) => void;
};

export type BatchFinderResult =
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

export async function findBatch({
  startHex,
  endHex,
  targetAddress,
  chain = 'btc',
  format = 'legacy',
  signal,
  onProgress,
}: BatchFinderOptions): Promise<BatchFinderResult> {
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

  const startedAt = (globalThis.performance?.now ?? Date.now)();
  let checked = 0;
  let lastTime = startedAt;
  let lastChecked = 0;

  // batch buffers
  const keys = new Array<Uint8Array>(BATCH_SIZE);
  const indices = new Array<bigint>(BATCH_SIZE);

  while (current <= end) {
    if (signal?.aborted) throw new Error('Search stopped.');

    const batchCount = Number(
      end - current + 1n > BigInt(BATCH_SIZE)
        ? BigInt(BATCH_SIZE)
        : end - current + 1n,
    );

    // ========== 1. توليد المفاتيح والعناوين ==========
    for (let i = 0; i < batchCount; i++) {
      const idx = current + BigInt(i);
      indices[i] = idx;

      try {
        const key = privateKeyFromRangeValue(idx);
        keys[i] = key;
      } catch {
        keys[i] = new Uint8Array(0); // علامة فشل
      }
    }

    // ========== 2. فحص الـ batch ==========
    for (let i = 0; i < batchCount; i++) {
      const key = keys[i];
      if (key.length === 0) {
        checked++;
        continue;
      }

      let address: string;
      try {
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
        let privateKeyHex = indices[i].toString(16).padStart(64, '0');

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
            index: indices[i].toString(),
            address,
            privateKeyHex,
            privateKeyWif,
          },
        };
      }

      checked++;

      // ========== 3. progress ==========
      if (onProgress && checked % 1000 === 0) {
        const now = (globalThis.performance?.now ?? Date.now)();
        const intervalSeconds = Math.max((now - lastTime) / 1000, 0.001);
        const intervalChecked = checked - lastChecked;
        onProgress({
          index: indices[i].toString(),
          keysPerSecond: Math.floor(intervalChecked / intervalSeconds),
          checked,
        });
        lastTime = now;
        lastChecked = checked;
      }
    }

    current += BigInt(batchCount);

    // ========== 4. yield ==========
    await yieldToEventLoop();
  }

  return { found: false };
                     }
