/// <reference lib="webworker" />

import {
  deriveBitcoinAddress,
  deriveBitcoinAddressOnly,
  privateKeyFromRangeValue,
} from './bitcoin';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { MultiChainName } from '@/lib/multichain';

// ============================================================================
// أنواع الرسائل
// ============================================================================

type ScanMessage = {
  type: 'scan';
  startHex: string;
  endHex: string;
  targetAddress: string;
  chain?: MultiChainName;
  format?: 'legacy' | 'segwit' | 'taproot';
};

type StopMessage = { type: 'stop' };
type IncomingMessage = ScanMessage | StopMessage;

// ============================================================================
// ثوابت
// ============================================================================

const PROGRESS_INTERVAL = 5000;
const YIELD_INTERVAL = 5000;

// ============================================================================
// أدوات مساعدة (محسّنة)
// ============================================================================

/**
 * private key → EVM address
 * - subarray(1) بدل slice(1) → صفر نسخ
 * - حلقة for بدل Array.from → أسرع ~3x
 * - subarray(12) بدل slice(-20) → صفر نسخ
 */
function privateKeyToEvmAddress(privateKey: Uint8Array): string {
  const pubKey = secp256k1.getPublicKey(privateKey, false); // uncompressed 65 bytes
  const hash = keccak_256(pubKey.subarray(1)); // keccak(64 bytes)
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
// الحالة
// ============================================================================

let stopped = false;

// ============================================================================
// المعالج
// ============================================================================

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;

  if (msg.type === 'stop') {
    stopped = true;
    return;
  }

  if (msg.type !== 'scan') return;
  stopped = false;

  const {
    startHex,
    endHex,
    targetAddress,
    chain = 'btc',
    format = 'legacy',
  } = msg;

  const normalizedTarget = (targetAddress ?? '').trim();
  const isBtc = chain === 'btc';
  const targetLower = normalizedTarget.toLowerCase();

  let current: bigint;
  let end: bigint;
  try {
    current = BigInt(`0x${startHex}`);
    end = BigInt(`0x${endHex}`);
  } catch {
    self.postMessage({ type: 'error', message: 'Invalid hex range.' });
    return;
  }

  const startedAt = (globalThis.performance?.now ?? Date.now)();
  let attempts = 0;
  let lastProgressTime = startedAt;
  let lastProgressAttempts = 0;

  for (let i = current; i <= end; i++) {
    if (stopped) {
      self.postMessage({ type: 'exhausted' });
      return;
    }

    // ========== derive خارج try/catch ==========
    let key: Uint8Array;
    let address: string;

    try {
      key = privateKeyFromRangeValue(i);
      address = isBtc
        ? deriveBitcoinAddressOnly(key, format)
        : privateKeyToEvmAddress(key);
    } catch {
      // مفتاح غير صالح (خارج المنحنى) — نتجاوزو
      attempts++;
      continue;
    }

    // ========== فحص المطابقة ==========
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
          // نكملو بـ hex الافتراضي
        }
      }

      self.postMessage({
        type: 'found',
        result: {
          index: i.toString(),
          address,
          privateKeyHex,
          privateKeyWif,
        },
      });
      return;
    }

    attempts++;

    // ========== progress (throttled) ==========
    if (attempts % PROGRESS_INTERVAL === 0) {
      const now = (globalThis.performance?.now ?? Date.now)();
      const intervalSeconds = Math.max((now - lastProgressTime) / 1000, 0.001);
      const intervalAttempts = attempts - lastProgressAttempts;

      self.postMessage({
        type: 'progress',
        index: i.toString(),
        address,
        keysPerSecond: Math.floor(intervalAttempts / intervalSeconds),
      });

      lastProgressTime = now;
      lastProgressAttempts = attempts;

      // ========== yield ==========
      await yieldToEventLoop();
    }

    if (attempts % YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }

  self.postMessage({ type: 'exhausted' });
};
