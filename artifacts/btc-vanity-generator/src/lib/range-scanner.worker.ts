/// <reference lib="webworker" />

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { saveSearchProgress } from "./persistence";

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

// دالة تحويل Hex لـ BigInt
function parseBigIntHex(hex: string): bigint {
  const cleaned = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error("Invalid hex.");
  return BigInt(`0x${cleaned}`);
}

let stopped = false;

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'stop') { stopped = true; return; }
  if (msg.type !== 'scan') return;

  stopped = false;
  const { startHex, endHex, targetAddress, chain = 'btc', cursor: savedCursor } = msg;
  
  const isEvm = chain && chain !== 'btc' && chain !== 'bitcoin';
  const target = targetAddress.trim().toLowerCase();
  
  let start: bigint, end: bigint, cursor: bigint;
  try {
    start = parseBigIntHex(startHex);
    end = parseBigIntHex(endHex);
    cursor = savedCursor ? parseBigIntHex(savedCursor) : start;
    if (start > end) throw new Error("Start > End.");
  } catch (e: any) {
    self.postMessage({ type: 'error', message: e.message });
    return;
  }

  const startedAt = Date.now();
  let attempts = 0;

  for (let i = cursor; i <= end; i++) {
    if (stopped) {
      self.postMessage({ type: 'exhausted' });
      return;
    }

    let privateKey = new Uint8Array(32);
    let temp = i;
    for (let j = 31; j >= 0; j--) {
      privateKey[j] = Number(temp & 0xffn);
      temp >>= 8n;
    }

    try {
      const pubKey = secp256k1.getPublicKey(privateKey, !isEvm); 
      const address = isEvm ? evmAddress(pubKey) : legacyBtcAddress(pubKey);
      
      const isMatch = isEvm ? address.toLowerCase() === target : address === targetAddress.trim();

      if (isMatch) {
        const privateKeyHex = i.toString(16).padStart(64, '0');
        const resultPayload = {
          address,
          privateKeyHex,
          privateKeyWif: isEvm ? `0x${privateKeyHex}` : "", // مبسط
          balance: isEvm ? `0.00 ${chain.toUpperCase()}` : "0.00 BTC",
          matchedKeyHex: i.toString(16),
          rangeStartHex: start.toString(16),
          rangeEndHex: end.toString(16),
          chain: isEvm ? chain : "btc",
        };

        saveSearchProgress(resultPayload);
        self.postMessage({ type: 'found', result: resultPayload });
        return;
      }
    } catch (e) {
      attempts++;
      continue;
    }

    attempts++;
    
    if (attempts % 5000 === 0) {
      const elapsedMs = Math.max(1, Date.now() - startedAt);
      const rangeSize = end - start + 1n;
      const progressPercent = Number(((i - start) * 10000n) / rangeSize) / 100;
      
      self.postMessage({
        type: "progress",
        attempts,
        elapsedMs,
        speed: Math.floor((attempts / elapsedMs) * 1000),
        percent: progressPercent,
        currentKeyHex: i.toString(16),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  
  self.postMessage({ type: 'exhausted', attempts, elapsedMs: Math.max(1, Date.now() - startedAt) });
};
