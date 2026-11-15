/**
 * WASM-accelerated EVM address derivation.
 * كيستعمل @hazae41/secp256k1-wasm (Rust k256 → WASM)
 * أسرع 2-5x من @noble/curves JS.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';

// تحميل lazy
let wasm: typeof import('@hazae41/secp256k1-wasm') | null = null;

async function loadWasm() {
  if (!wasm) {
    wasm = await import('@hazae41/secp256k1-wasm');
    await wasm.secp256k1Wasm.load();
  }
  return wasm;
}

/**
 * private key → EVM address (WASM)
 * - privateKey: 32 bytes
 * - returns: 0x + 40 hex
 */
export async function privateKeyToEvmAddressWasm(
  privateKey: Uint8Array,
): Promise<string> {
  const w = await loadWasm();

  // WASM: private → public (compressed 33 bytes)
  using keypair = new w.secp256k1Wasm.Secp256k1SigningKey(privateKey);
  using identity = keypair.verifying_key();
  const compressed = identity.to_bytes();

  // decompress → uncompressed 64 bytes (بدون 0x04)
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false).subarray(1);

  // keccak256 → آخر 20 بايت
  const hash = keccak_256(uncompressed);
  let hex = '';
  for (let i = 12; i < 32; i++) {
    hex += hash[i].toString(16).padStart(2, '0');
  }
  return `0x${hex}`;
}

/**
 * batch: عدة مفاتيح → عدة عناوين
 */
export async function privateKeysToEvmAddressesWasm(
  privateKeys: Uint8Array[],
): Promise<string[]> {
  const results: string[] = [];
  for (const key of privateKeys) {
    results.push(await privateKeyToEvmAddressWasm(key));
  }
  return results;
}
