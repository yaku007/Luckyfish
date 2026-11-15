/// <reference lib="webworker" />

import { 
  deriveBitcoinAddress, 
  deriveBitcoinAddressOnly,
  privateKeyFromRangeValue 
} from './bitcoin';
import { privateKeyToEvmAddressWasm } from './evm-address-wasm';
import type { MultiChainName } from '@/lib/multichain';

// ============================================================================
// الثوابت
// ============================================================================

const PROGRESS_INTERVAL = 5000;
const YIELD_INTERVAL = 5000;

// ============================================================================
// الحالة
// ============================================================================

let stopped = false;

// ============================================================================
// المعالج
// ============================================================================

self.onmessage = async (event) => {
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
    format = 'legacy' 
  } = msg;

  const normalizedTarget = (targetAddress ?? '').trim();
  const isBtc = chain === 'btc';
  const targetLower = normalizedTarget.toLowerCase();

  let current = BigInt(`0x${startHex}`);
  const end = BigInt(`0x${endHex}`);
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
    let address = '';

    try {
      key = privateKeyFromRangeValue(i);
      
      if (isBtc) {
        address = deriveBitcoinAddressOnly(key, format);
      } else {
        // هنا كنستعملو الدالة من evm-address-wasm.ts
        address = await privateKeyToEvmAddressWasm(key);
      }
    } catch (e) {
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
        } catch {}
      }

      self.postMessage({ 
        type: 'found', 
        result: { 
          index: i.toString(), 
          address, 
          privateKeyHex, 
          privateKeyWif 
        } 
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
