import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

/**
 * توليد عنوان EVM من مفتاح خاص.
 * دالة متزامنة (sync) لتحقيق أقصى سرعة في البحث (Brute Force).
 */
export function privateKeyToEvmAddressSync(privateKey: Uint8Array): string {
  const pubKey = secp256k1.getPublicKey(privateKey, false); // Uncompressed
  const hash = keccak_256(pubKey.subarray(1)); // نحيّدو 0x04 prefix
  
  let hex = '';
  for (let i = 12; i < 32; i++) {
    hex += hash[i].toString(16).padStart(2, '0');
  }
  return `0x${hex}`;
}
