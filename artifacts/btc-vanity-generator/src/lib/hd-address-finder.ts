import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";

export type AddressFormat = "legacy" | "segwit";

export const PRIVATE_KEY_LIMIT =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

// --- Helper Functions ---

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(`0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
}

function bigIntToBytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0");
  if (hex.length !== 64) {
    throw new Error("Private key must fit in 32 bytes.");
  }
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

export function randomPrivateKey(): Uint8Array {
  const key = new Uint8Array(32);
  do {
    crypto.getRandomValues(key);
  } while (bytesToBigInt(key) === 0n || bytesToBigInt(key) >= PRIVATE_KEY_LIMIT);
  return key;
}

export function privateKeyToHex(privateKey: Uint8Array): string {
  return Array.from(privateKey, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hash160(value: Uint8Array): Uint8Array {
  return ripemd160(sha256(value));
}

function base58Encode(value: Uint8Array): string {
  let number = bytesToBigInt(value);
  let result = "";
  while (number > 0n) {
    const remainder = Number(number % 58n);
    result = BASE58_ALPHABET[remainder] + result;
    number /= 58n;
  }
  for (const byte of value) {
    if (byte !== 0) break;
    result = `1${result}`;
  }
  return result || "1";
}

export function base58Check(value: Uint8Array): string {
  const checksum = sha256(sha256(value)).slice(0, 4);
  const payload = new Uint8Array(value.length + checksum.length);
  payload.set(value);
  payload.set(checksum, value.length);
  return base58Encode(payload);
}

function getPublicKeyHash(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 32) {
    throw new Error("Private key must be exactly 32 bytes.");
  }
  const scalar = bytesToBigInt(privateKey);
  if (scalar < 1n || scalar >= PRIVATE_KEY_LIMIT) {
    throw new Error("Private key is outside the valid secp256k1 range.");
  }
  return hash160(secp256k1.getPublicKey(privateKey, true));
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let accumulator = 0;
  let bits = 0;
  const output: number[] = [];
  const maxValue = (1 << toBits) - 1;
  const maxAccumulator = (1 << (fromBits + toBits - 1)) - 1;

  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) {
      throw new Error("Invalid bit group for SegWit address.");
    }
    accumulator = ((accumulator << fromBits) | value) & maxAccumulator;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      output.push((accumulator >> bits) & maxValue);
    }
  }
  if (pad && bits > 0) {
    output.push((accumulator << (toBits - bits)) & maxValue);
  } else if (bits >= fromBits || ((accumulator << (toBits - bits)) & maxValue) !== 0) {
    throw new Error("Invalid SegWit address data.");
  }
  return output;
}

function bech32Polymod(values: number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < 5; index += 1) {
      if ((top >>> index) & 1) checksum ^= generators[index];
    }
  }
  return checksum >>> 0;
}

export function segwitAddress(witnessProgram: Uint8Array): string {
  const hrp = "bc";
  const data = [0, ...convertBits(witnessProgram, 8, 5, true)];
  const expandedHrp = [
    ...Array.from(hrp, (character) => character.charCodeAt(0) >> 5),
    0,
    ...Array.from(hrp, (character) => character.charCodeAt(0) & 31),
  ];
  const values = [...expandedHrp, ...data, 0, 0, 0, 0, 0, 0];
  const polymod = bech32Polymod(values) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, index) =>
    (polymod >>> (5 * (5 - index))) & 31,
  );
  return `${hrp}1${[...data, ...checksum].map((value) => BECH32_ALPHABET[value]).join("")}`;
}

export function deriveBitcoinAddress(
  privateKey: Uint8Array,
  format: AddressFormat,
): { address: string; privateKeyWif: string; privateKeyHex: string } {
  const publicKeyHash = getPublicKeyHash(privateKey);
  const address = format === "legacy"
    ? base58Check(Uint8Array.of(0x00, ...publicKeyHash))
    : segwitAddress(publicKeyHash);

  const wifPayload = new Uint8Array(34);
  wifPayload[0] = 0x80;
  wifPayload.set(privateKey, 1);
  wifPayload[33] = 0x01;

  return {
    address,
    privateKeyWif: base58Check(wifPayload),
    privateKeyHex: privateKeyToHex(privateKey),
  };
}

// --- High Performance Search (Target Addresses List Mode + Max Keys/Sec) ---

export async function searchSpecificAddresses(
  targetAddresses: string[], // 📋 List dyal les adresses li bġiti t-qleb 3lihom
  format: AddressFormat = "legacy",
  maxIterations: number = 100_000_000,
  onProgress?: (currentKeyHex: string, speed: number, checkedCount: number) => void,
  onFound?: (result: { privateKeyHex: string; privateKeyWif: string; address: string }) => void
): Promise<boolean> {
  // 1. N-st3mlo Set bach l-lookup ykon O(1) sriiɛ bzaf
  const targetSet = new Set(targetAddresses.map((addr) => addr.trim()));

  if (targetSet.size === 0) {
    throw new Error("Target addresses list cannot be empty.");
  }

  let iterations = 0;
  const startTime = performance.now();
  
  // ⚡ BATCH_SIZE kbir bach n-rfeɛo l-sorɛa (Keys/second) w n-n9sso l-overhead dyal setTimeout
  const BATCH_SIZE = 20000; 

  while (iterations < maxIterations) {
    let lastKeyHex = "";
    
    for (let i = 0; i < BATCH_SIZE; i++) {
      const privateKeyBytes = randomPrivateKey();
      lastKeyHex = privateKeyToHex(privateKeyBytes);
      const result = deriveBitcoinAddress(privateKeyBytes, format);

      if (targetSet.has(result.address)) {
        if (onFound) {
          onFound({
            privateKeyHex: result.privateKeyHex,
            privateKeyWif: result.privateKeyWif,
            address: result.address
          });
        }
        return true;
      }
      iterations++;
    }

    const elapsed = (performance.now() - startTime) / 1000;
    const speed = elapsed > 0 ? Math.floor(iterations / elapsed) : 0;

    if (onProgress) {
      onProgress(lastKeyHex, speed, iterations);
    }

    // Yield khafif ll-UI thread bach l-browser mayt-blockich w y-bda y-bin l-keys/sec b srɛa
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return false;
           }
