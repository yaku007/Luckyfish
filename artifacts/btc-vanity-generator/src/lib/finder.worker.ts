/// <reference lib="webworker" />

import { 
  deriveBitcoinAddress, 
  deriveBitcoinAddressOnly,
  privateKeyFromRangeValue 
} from './bitcoin';
import { privateKeyToEvmAddressSync } from './evm-address-wasm';

let stopped = false;

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === 'stop') {
    stopped = true;
    return;
  }

  if (msg.type !== 'scan') return;
  stopped = false;

  const { startHex, endHex, targetAddress, chain = 'btc', format = 'legacy' } = msg;
  
  const normalizedTarget = (targetAddress ?? '').trim();
  const targetLower = normalizedTarget.toLowerCase();
  const isBtc = chain === 'btc';
  
  let current: bigint;
  let end: bigint;
  try {
    current = BigInt(`0x${startHex}`);
    end = BigInt(`0x${endHex}`);
  } catch {
    self.postMessage({ type: 'error', message: 'Invalid hex range.' });
    return;
  }

  if (end < current) {
    self.postMessage({ type: 'error', message: 'End key must be >= Start key.' });
    return;
  }
  
  const startedAt = Date.now();
  let attempts = 0;

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
        address = privateKeyToEvmAddressSync(key);
      }
    } catch (e: any) {
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
        } catch (e) {}
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
    
    // 🚀 تحديث الشاشة كل 100 محاولة (بدل 5000) باش ما يعلقش فـ النطاقات الصغيرة
    if (attempts % 100 === 0) {
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      self.postMessage({
        type: 'progress',
        index: `0x${i.toString(16)}`,
        address: address,
        keysPerSecond: Math.floor(attempts / elapsedSeconds),
      });
      
      // إعطاء فرصة للـ Event Loop
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  
  self.postMessage({ type: 'exhausted' });
};
