/// <reference lib="webworker" />

import { 
  deriveBitcoinAddress, 
  deriveBitcoinAddressOnly,
  privateKeyFromRangeValue 
} from './bitcoin';
import { privateKeyToEvmAddressSync } from './evm-address-wasm';

// متغير باش نعرفو واش المستعمل دار Stop
let stopped = false;

self.onmessage = async (event) => {
  const msg = event.data;

  // 🛑 التحقق من رسالة التوقف
  if (msg.type === 'stop') {
    stopped = true;
    return;
  }

  if (msg.type !== 'scan') return;
  stopped = false; // تصفير الحالة عند بداية بحث جديد

  const { startHex, endHex, targetAddress, chain = 'btc', format = 'legacy' } = msg;
  
  const normalizedTarget = (targetAddress ?? '').trim();
  const targetLower = normalizedTarget.toLowerCase();
  const isBtc = chain === 'btc';
  
  // 🛡️ حماية من الأخطاء فـ تحويل النطاق
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
    // 🛑 التحقق من التوقف فـ كل دورة
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
        // دالة sync سريعة جداً (بلا await)
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
    
    // تحديث الشاشة كل 5000 محاولة
    if (attempts % 5000 === 0) {
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      
      // ✅ زدنا 0x باش يبان الرقم بشكل احترافي
      self.postMessage({
        type: 'progress',
        index: `0x${i.toString(16)}`,
        address: address,
        keysPerSecond: Math.floor(attempts / elapsedSeconds),
      });
      
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  
  self.postMessage({ type: 'exhausted' });
};
