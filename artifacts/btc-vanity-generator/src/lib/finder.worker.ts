/// <reference lib="webworker" />

import { 
  deriveBitcoinAddress, 
  privateKeyFromRangeValue 
} from './bitcoin';

self.onmessage = async (event) => {
  const { startHex, endHex, targetAddress } = event.data;
  let current = BigInt(`0x${startHex}`);
  const end = BigInt(`0x${endHex}`);
  const startedAt = performance.now();
  let attempts = 0;

  for (let i = current; i <= end; i++) {
    try {
      const key = privateKeyFromRangeValue(i);
      const result = deriveBitcoinAddress(key, 'legacy');

      if (result.address === targetAddress.trim()) {
        self.postMessage({ 
          type: 'found', 
          result: { 
            index: i.toString(), 
            address: result.address, 
            privateKeyHex: result.privateKeyHex, 
            privateKeyWif: result.privateKeyWif 
          } 
        });
        return;
      }

      attempts++;
      if (attempts % 5000 === 0) {
        const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
        self.postMessage({
          type: 'progress',
          index: i.toString(),
          address: result.address,
          keysPerSecond: Math.floor(attempts / elapsedSeconds),
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch (e) {
      // ignore
    }
  }
  self.postMessage({ type: 'exhausted' });
};
