import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";

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

export function parsePrivateKeyHex(value: string): Uint8Array {
  const normalized = value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,64}$/.test(normalized)) {
    throw new Error("Enter a hexadecimal private key with 1 to 64 characters.");
  }
  const scalar = BigInt(`0x${normalized}`);
  if (scalar < 1n || scalar >= PRIVATE_KEY_LIMIT) {
    throw new Error("Private key must be between 1 and the secp256k1 limit.");
  }
  return bigIntToBytes(scalar);
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

function base58Decode(value: string): Uint8Array | null {
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 0xffn));
    number >>= 8n;
  }
  let leadingZeroes = 0;
  for (const character of value) {
    if (character !== "1") break;
    leadingZeroes += 1;
  }
  return Uint8Array.from([...new Array(leadingZeroes).fill(0), ...bytes]);
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

function addressFromPublicKeyHash(publicKeyHash: Uint8Array, format: AddressFormat): string {
  return format === "legacy"
    ? base58Check(Uint8Array.of(0x00, ...publicKeyHash))
    : segwitAddress(publicKeyHash);
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

// --- Validations ---

export function isValidBitcoinAddressTarget(value: string, format: AddressFormat): boolean {
  const normalized = value.trim();
  if (format === "legacy") {
    const decoded = base58Decode(normalized);
    if (!decoded || decoded.length !== 25 || decoded[0] !== 0x00) return false;
    const payload = decoded.slice(0, 21);
    const checksum = sha256(sha256(payload)).slice(0, 4);
    return checksum.every((byte, index) => byte === decoded[21 + index]);
  }
  if (
    normalized.length !== 42 ||
    normalized !== normalized.toLowerCase() ||
    !normalized.startsWith("bc1q")
  ) {
    return false;
  }
  const separator = normalized.lastIndexOf("1");
  const hrp = normalized.slice(0, separator);
  const encoded = normalized.slice(separator + 1);
  const data = Array.from(encoded, (character) => BECH32_ALPHABET.indexOf(character));
  if (data.some((value) => value < 0)) return false;
  const expandedHrp = [
    ...Array.from(hrp, (character) => character.charCodeAt(0) >> 5),
    0,
    ...Array.from(hrp, (character) => character.charCodeAt(0) & 31),
  ];
  try {
    return (
      hrp === "bc" &&
      data[0] === 0 &&
      bech32Polymod([...expandedHrp, ...data]) === 1 &&
      convertBits(Uint8Array.from(data.slice(1, -6)), 5, 8, false).length === 20
    );
  } catch {
    return false;
  }
}

export function isValidMainnetBitcoinAddress(value: string): boolean {
  const address = value.trim();
  if (address.length < 14 || address.length > 90) return false;
  if (/^bc1/i.test(address)) {
    if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
      return false;
    }
    const normalized = address.toLowerCase();
    const separator = normalized.lastIndexOf("1");
    if (
      separator < 1 ||
      separator + 7 > normalized.length ||
      normalized.slice(0, separator) !== "bc"
    ) {
      return false;
    }
    const data = Array.from(normalized.slice(separator + 1), (character) =>
      BECH32_ALPHABET.indexOf(character),
    );
    if (data.length < 7 || data.some((value) => value < 0)) return false;
    const version = data[0];
    if (version > 16) return false;
    const expandedHrp = [
      ...Array.from("bc", (character) => character.charCodeAt(0) >> 5),
      0,
      ...Array.from("bc", (character) => character.charCodeAt(0) & 31),
    ];
    const expectedChecksum = version === 0 ? 1 : 0x2bc830a3;
    if (bech32Polymod([...expandedHrp, ...data]) !== expectedChecksum) {
      return false;
    }
    try {
      const witnessProgram = convertBits(
        Uint8Array.from(data.slice(1, -6)),
        5,
        8,
        false,
      );
      if (version === 0) {
        return witnessProgram.length === 20 || witnessProgram.length === 32;
      }
      if (version === 1) return witnessProgram.length === 32;
      return witnessProgram.length >= 2 && witnessProgram.length <= 40;
    } catch {
      return false;
    }
  }
  const decoded = base58Decode(address);
  if (!decoded || decoded.length !== 25 || (decoded[0] !== 0x00 && decoded[0] !== 0x05)) {
    return false;
  }
  const payload = decoded.slice(0, 21);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return checksum.every((byte, index) => byte === decoded[21 + index]);
}

// --- Derivations ---

export function deriveBitcoinAddress(
  privateKey: Uint8Array,
  format: AddressFormat,
): { address: string; privateKeyWif: string; privateKeyHex: string } {
  const publicKeyHash = getPublicKeyHash(privateKey);
  const address = addressFromPublicKeyHash(publicKeyHash, format);
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

export function deriveBitcoinAddressOnly(
  privateKey: Uint8Array,
  format: AddressFormat,
): string {
  return addressFromPublicKeyHash(getPublicKeyHash(privateKey), format);
}

export function privateKeyFromRangeValue(value: bigint): Uint8Array {
  if (value < 1n || value >= PRIVATE_KEY_LIMIT) {
    throw new Error("Range contains a private key outside the valid secp256k1 range.");
  }
  return bigIntToBytes(value);
}

// --- Search Range (Brute Force) ---

export async function searchRange(
  startHex: string,
  endHex: string,
  targetAddress: string,
  format: AddressFormat = "legacy",
  onProgress?: (currentKey: bigint, speed: number) => void,
  onFound?: (result: { privateKeyHex: string; privateKeyWif: string; address: string }) => void
): Promise<boolean> {
  const start = BigInt(`0x${startHex}`);
  const end = BigInt(`0x${endHex}`);

  if (start < 1n) throw new Error("Start key must be at least 1");
  if (end >= PRIVATE_KEY_LIMIT) throw new Error("End key exceeds secp256k1 limit");
  if (start > end) throw new Error("Start key must be less than or equal to end key");

  let current = start;
  let iterations = 0;
  const startTime = performance.now();

  while (current <= end) {
    const privateKeyBytes = privateKeyFromRangeValue(current);
    const result = deriveBitcoinAddress(privateKeyBytes, format);

    if (result.address === targetAddress) {
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

    if (onProgress && iterations % 2000 === 0) {
      const elapsed = (performance.now() - startTime) / 1000;
      const speed = Math.floor(iterations / elapsed);
      onProgress(current, speed);
    }

    current += 1n;

    if (iterations % 2000 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return false;
}

// --- Search HD Addresses (BIP32) ---

export async function searchHDAddresses(
  masterKeyOrXpub: string,
  startIndex: number,
  endIndex: number,
  targetAddress: string,
  format: AddressFormat = "legacy",
  onProgress?: (index: number, currentAddress: string, speed: number) => void,
  onFound?: (result: { index: number; address: string; privateKeyWif?: string; privateKeyHex?: string }) => void
): Promise<boolean> {
  let master: HDKey;
  try {
    master = HDKey.fromExtendedKey(masterKeyOrXpub);
  } catch (e) {
    throw new Error("Invalid HD Key format (xpub or xprv expected).");
  }

  if (startIndex < 0 || endIndex < startIndex) {
    throw new Error("Invalid index range.");
  }

  let iterations = 0;
  const startTime = performance.now();

  for (let index = startIndex; index <= endIndex; index++) {
    const child = master.derive(`m/0/0/${index}`);

    let address: string;
    let wif: string | undefined;
    let hex: string | undefined;

    if (format === "legacy") {
      const pubHash = hash160(child.publicKey!);
      address = base58Check(Uint8Array.of(0x00, ...pubHash));
    } else {
      const pubHash = hash160(child.publicKey!);
      address = segwitAddress(pubHash);
    }

    if (address === targetAddress) {
      if (child.privateKey) {
        const wifPayload = new Uint8Array(34);
        wifPayload[0] = 0x80;
        wifPayload.set(child.privateKey, 1);
        wifPayload[33] = 0x01;
        wif = base58Check(wifPayload);
        hex = privateKeyToHex(child.privateKey);
      }

      if (onFound) {
        onFound({
          index,
          address,
          privateKeyWif: wif,
          privateKeyHex: hex,
        });
      }
      return true;
    }

    iterations++;

    if (onProgress && iterations % 1000 === 0) {
      const elapsed = (performance.now() - startTime) / 1000;
      const speed = Math.floor(iterations / elapsed);
      onProgress(index, address, speed);
    }

    if (iterations % 1000 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return false;
}
