/// <reference lib="webworker" />

import {
  deriveBitcoinAddress,
  deriveBitcoinAddressOnly,
  privateKeyFromRangeValue,
} from './bitcoin';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { MultiChainName } from '@/lib/multichain';

const PROGRESS_INTERVAL = 5000;
const YIELD_INTERVAL = 5000;

let stopped = false;

function privateKeyToEvmAddress(privateKey: Uint8Array): string {
  const pubKey = secp256k1.getPublicKey(privateKey, false);
  const hash = keccak_256(pubKey.subarray(1));
  let hex = '';
  for (let i = 12; i < 32; i++) hex += hash[i].toString(16).padStart(2, '0');
  return `0x${hex}`;
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  if (msg.type === 'stop') { stopped = true; return; }
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
  let lastTime = startedAt;
  let lastAttempts = 0;

  for (let i = current; i <= end; i++) {
    if (stopped) {
      self.postMessage({ type: 'exhausted' });
      return;
    }

    let key: Uint8Array;
    let address: string;

    try {
      key = privateKeyFromRangeValue(i);
      address = isBtc
        ? deriveBitcoinAddressOnly(key, format)
        : privateKeyToEvmAddress(key); // ✅ بلا WASM
    } catch {
      attempts++;
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
        } catch { /* نكملو */ }
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

    if (attempts % PROGRESS_INTERVAL === 0) {
      const now = (globalThis.performance?.now ?? Date.now)();
      const intervalSeconds = Math.max((now - lastTime) / 1000, 0.001);
      const intervalAttempts = attempts - lastAttempts;

      self.postMessage({
        type: 'progress',
        index: i.toString(),
        address,
        keysPerSecond: Math.floor(intervalAttempts / intervalSeconds),
      });

      lastTime = now;
      lastAttempts = attempts;

      await new Promise<void>((r) => globalThis.setTimeout(r, 0));
    }

    if (attempts % YIELD_INTERVAL === 0) {
      await new Promise<void>((r) => globalThis.setTimeout(r, 0));
    }
  }

  self.postMessage({ type: 'exhausted' });
};
