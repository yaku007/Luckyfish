/// <reference lib="webworker" />

import { 
  deriveBitcoinAddress, 
  deriveBitcoinAddressOnly,
  privateKeyFromRangeValue 
} from './bitcoin';
import { privateKeyToEvmAddressWasm } from './evm-address-wasm';

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
        // BTC: دالة متزامنة وسريعة (بلا await)
        address = deriveBitcoinAddressOnly(key, format);
      } else {
        // EVM: كتستعمل await ولكن خاصها تكون سريعة
        address = await privateKeyToEvmAddressWasm(key);
      }
    } catch (e: any) {
      attempts++;
      // باش نعرفو واش كاين مشكل فـ الدوال ديال bitcoin
      if (attempts === 1) {
        console.error("Error on derivation:", e);
      }
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
    
    // تحديث الشاشة كل 1000 محاولة باش تبان الحركة دغيا
    if (attempts % 1000 === 0) {
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      self.postMessage({
        type: 'progress',
        index: i.toString(),
        address: address, // باش نتأكدو واش العناوين كتتولد
        keysPerSecond: Math.floor(attempts / elapsedSeconds),
      });
      
      // إعطاء فرصة للـ Event Loop باش ما يتبلوكاش
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  
  // ملي كيسالي بلا ما يلقى
  self.postMessage({ type: 'exhausted' });
};
