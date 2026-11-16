/// <reference lib="webworker" />

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function bytesToBigInt(bytes: Uint8Array): bigint {
  let r = 0n;
  for (let i = 0; i < bytes.length; i++) r = (r << 8n) | BigInt(bytes[i]);
  return r;
}

function base58Encode(bytes: Uint8Array): string {
  let v = bytesToBigInt(bytes);
  let out = '';
  while (v > 0n) { out = BASE58_ALPHABET[Number(v % 58n)] + out; v /= 58n; }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + out;
}

function privateKeyToWif(privateKey: Uint8Array): string {
  const payload = new Uint8Array(34);
  payload[0] = 0x80;
  payload.set(privateKey, 1);
  payload[33] = 0x01;
  const hash = sha256(sha256(payload));
  const wif = new Uint8Array(38);
  wif.set(payload, 0);
  wif.set(hash.subarray(0, 4), 34);
  return base58Encode(wif);
}

function legacyBtcAddress(pub: Uint8Array): string {
  const h = ripemd160(sha256(pub));
  const payload = new Uint8Array(21);
  payload[0] = 0;
  payload.set(h, 1);
  const cs = sha256(sha256(payload)).subarray(0, 4);
  const addr = new Uint8Array(25);
  addr.set(payload, 0);
  addr.set(cs, 21);
  return base58Encode(addr);
}

function evmAddress(pub: Uint8Array): string {
  const hash = keccak_256(pub.subarray(1));
  let hex = '';
  for (let i = 12; i < 32; i++) hex += hash[i].toString(16).padStart(2, '0');
  return `0x${hex}`;
}

let stopped = false;

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'stop') { stopped = true; return; }
  if (msg.type !== 'scan') return;

  stopped = false;
  const { startHex, endHex, chain = 'btc' } = msg;
  const isEvm = chain && chain !== 'btc' && chain !== 'bitcoin';
  
  let start = BigInt(`0x${startHex.replace(/^0x/i, "")}`);
  let end = BigInt(`0x${endHex.replace(/^0x/i, "")}`);

  // 🛠️ جلب العناوين من الداتابيز مرة واحدة
  let dbAddresses: Set<string> = new Set();
  try {
    const response = await fetch('/api/get-all-addresses');
    const data = await response.json();
    if (data.addresses && Array.isArray(data.addresses)) {
      dbAddresses = new Set(data.addresses.map((a: string) => isEvm ? a.toLowerCase() : a));
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: 'Failed to fetch addresses from DB' });
    return;
  }

  if (dbAddresses.size === 0) {
    self.postMessage({ type: 'error', message: 'No addresses in database. Run seed first.' });
    return;
  }

  const startedAt = Date.now();
  let attempts = 0;

  for (let i = start; i <= end; i++) {
    if (stopped) { self.postMessage({ type: 'exhausted' }); return; }

    let privateKey = new Uint8Array(32);
    let temp = i;
    for (let j = 31; j >= 0; j--) { privateKey[j] = Number(temp & 0xffn); temp >>= 8n; }

    const pubKey = secp256k1.getPublicKey(privateKey, !isEvm); 
    const address = isEvm ? evmAddress(pubKey) : legacyBtcAddress(pubKey);
    const privateKeyHex = i.toString(16).padStart(64, '0');
    const privateKeyWif = isEvm ? `0x${privateKeyHex}` : privateKeyToWif(privateKey);

    const isMatch = dbAddresses.has(isEvm ? address.toLowerCase() : address);

    if (isMatch) {
      self.postMessage({ 
        type: 'found', 
        result: {
          address, 
          privateKeyHex, 
          privateKeyWif, 
          matchedKeyHex: i.toString(16)
        }
      });
      return;
    }

    attempts++;
    if (attempts % 5000 === 0) {
      const elapsedMs = Math.max(1, Date.now() - startedAt);
      self.postMessage({ 
        type: "progress", 
        speed: Math.floor((attempts / elapsedMs) * 1000), 
        currentKeyHex: i.toString(16) 
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  
  self.postMessage({ type: 'exhausted' });
};
