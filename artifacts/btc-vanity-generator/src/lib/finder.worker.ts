/// <reference lib="webworker" />

import { 
  deriveBitcoinAddress, 
  deriveBitcoinAddressOnly,
  privateKeyFromRangeValue 
} from './bitcoin';
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

// دالة توليد عناوين EVM (ETH, BNB, Polygon...)
function privateKeyToEvmAddress(privateKey: Uint8Array): string {
  const pubKey = secp256k1.getPublicKey(privateKey, false); // Uncompressed
  const pubKeyNoPrefix = pubKey.slice(1);
  const hash = keccak_256(pubKeyNoPrefix);
  const addressBytes = hash.slice(-20);
  const hex = Array.from(addressBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `0x${hex}`;
}

self.onmessage = async (event) => {
  const { startHex, endHex, targetAddress, chain = 'btc', format = 'legacy' } = event.data;
  const normalizedTarget = (targetAddress ?? '').trim();
  let current = BigInt(`0x${startHex}`);
  const end = BigInt(`0x${endHex}`);
  const startedAt = performance.now();
  let attempts = 0;

  for (let i = current; i <= end; i++) {
    try {
      const key = privateKeyFromRangeValue(i);
      let address = '';

      // التحقق واش الشبكة Bitcoin ولا EVM
      if (chain === 'btc') {
        address = deriveBitcoinAddressOnly(key, format);
      } else {
        address = privateKeyToEvmAddress(key);
      }

      const isMatch = chain === 'btc'
        ? address === normalizedTarget
        : address.toLowerCase() === normalizedTarget.toLowerCase();

      if (isMatch) {
        let privateKeyWif = '';
        let privateKeyHex = i.toString(16).padStart(64, '0');

        if (chain === 'btc') {
          const result = deriveBitcoinAddress(key, format);
          privateKeyWif = result.privateKeyWif;
          privateKeyHex = result.privateKeyHex;
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
      if (attempts % 5000 === 0) {
        const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
        self.postMessage({
          type: 'progress',
          index: i.toString(),
          address,
          keysPerSecond: Math.floor(attempts / elapsedSeconds),
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch (e) {
      // ignore individual errors
    }
  }
  self.postMessage({ type: 'exhausted' });
};
