import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

/**
 * توليد عنوان EVM من مفتاح خاص.
 * كنستعملو @noble/curves اللي ديجا مثبتة فـ المشروع
 * باش نتجنبو مشاكل Vercel و WASM imports.
 */

export async function privateKeyToEvmAddressWasm(
  privateKey: Uint8Array,
): Promise<string> {
  // كنخدمو async باش ما نضطروش نبدلو finder.worker.ts
  const pubKey = secp256k1.getPublicKey(privateKey, false); // Uncompressed
  const hash = keccak_256(pubKey.subarray(1)); // نحيّدو 0x04
  let hex = '';
  for (let i = 12; i < 32; i++) {
    hex += hash[i].toString(16).padStart(2, '0');
  }
  return `0x${hex}`;
}

export async function privateKeysToEvmAddressesWasm(
  privateKeys: Uint8Array[],
): Promise<string[]> {
  const results: string[] = [];
  for (const key of privateKeys) {
    results.push(await privateKeyToEvmAddressWasm(key));
  }
  return results;
}
