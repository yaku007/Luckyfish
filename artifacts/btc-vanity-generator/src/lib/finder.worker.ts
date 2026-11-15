/// <reference lib="webworker" />

import { 
  deriveBitcoinAddress, 
  deriveBitcoinAddressOnly,
  privateKeyFromRangeValue 
} from './bitcoin';
import { privateKeyToEvmAddressSync } from './evm-address-wasm';

self.onmessage = async (event) => {
  const { startHex, endHex, targetAddress, chain = 'btc', format = 'legacy' } = event.data;
  
  const normalizedTarget = (targetAddress ?? '').trim();
  const targetLower = normalizedTarget.toLowerCase();
  const isBtc = chain === 'btc';
  
  let current = BigInt(`0x${startHex}`);
  const end = BigInt(`0x${endHex}`);
  
  const startedAt = Date.now();
  let attempts = 0;

  for (let i = current; i <= end; i++) {
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
    
    // تحديث الشاشة كل 5000 محاولة (باش نعطيو فرصة للـ Event Loop)
    if (attempts % 5000 === 0) {
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      self.postMessage({
        type: 'progress',
        index: i.toString(),
        address: address,
        keysPerSecond: Math.floor(attempts / elapsedSeconds),
      });
      
      // إعطاء فرصة للـ Event Loop
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  
  self.postMessage({ type: 'exhausted' });
};
