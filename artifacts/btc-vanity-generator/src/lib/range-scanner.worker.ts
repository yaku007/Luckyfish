/// <reference lib="webworker" />

import { deriveBitcoinAddress, privateKeyFromRangeValue } from "./bitcoin";
import { deriveAddressFromPrivateKey } from "./multichain";
import { WasmEngine } from "./wasm-engine";
import { saveSearchProgress } from "./persistence";

interface ScanRequest {
  startHex: string;
  endHex: string;
  targetAddress: string;
  chain: string;
  format?: string;
  engine?: 'cpu' | 'webgl' | 'webgpu';
  cursor?: string;
}

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<ScanRequest>) => void) | null;
  postMessage: (message: any) => void;
};

const wasm = new WasmEngine();

function parseBigIntHex(hex: string): bigint {
  const cleaned = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error("Invalid hex.");
  return BigInt(`0x${cleaned}`);
}

function bigIntTo32Bytes(val: bigint): Uint8Array {
  const hex = val.toString(16).padStart(64, '0');
  return Uint8Array.from(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(`0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`);
}

worker.onmessage = async (event) => {
  const { startHex, endHex, targetAddress, chain, format, cursor: savedCursor } = event.data;
  const startedAt = performance.now();

  await wasm.init();

  try {
    const start = parseBigIntHex(startHex);
    const end = parseBigIntHex(endHex);
    let cursor = savedCursor ? parseBigIntHex(savedCursor) : start;
    
    if (start > end) throw new Error("Start > End.");

    let attempts = 0;
    const target = (targetAddress || "").trim().toLowerCase();
    const isEvm = chain && chain !== "btc" && chain !== "bitcoin";
    
    const activeFormat = (format === 'segwit' || format === 'legacy') ? format : 'legacy';
    const BATCH_SIZE = 2000;

    while (cursor <= end) {
      const batchCount = Number(end - cursor + 1n) > BATCH_SIZE ? BATCH_SIZE : Number(end - cursor + 1n);
      const keysBuffer = new Uint8Array(batchCount * 32);

      let tempCursor = cursor;
      for (let i = 0; i < batchCount; i++) {
        const keyBytes = privateKeyFromRangeValue(tempCursor++);
        keysBuffer.set(keyBytes, i * 32);
      }

      if (wasm.isReady()) {
        wasm.incrementKeys(keysBuffer, batchCount);
      } else {
        for (let i = 0; i < batchCount; i++) {
           let val = bytesToBigInt(keysBuffer.slice(i*32, (i+1)*32)) + 1n;
           keysBuffer.set(bigIntTo32Bytes(val), i*32);
        }
      }

      for (let i = 0; i < batchCount && cursor <= end; i++) {
        const currentKeyBigInt = cursor++;
        const keyBytes = keysBuffer.slice(i * 32, (i + 1) * 32);
        attempts++;

        let address = "";
        let privKeyWif = "";
        const privKeyHex = Array.from(keyBytes, (b) => b.toString(16).padStart(2, "0")).join("");

        if (isEvm) {
          address = deriveAddressFromPrivateKey(keyBytes, chain as any);
          privKeyWif = `0x${privKeyHex}`;
        } else {
          const keyResult = deriveBitcoinAddress(keyBytes, activeFormat as any);
          address = keyResult.address;
          privKeyWif = keyResult.privateKeyWif || "";
        }

        if (target && address && address.toLowerCase() === target) {
          const elapsedMs = Math.max(1, performance.now() - startedAt);
          const resultPayload = {
            address,
            privateKeyHex: privKeyHex,
            privateKeyWif: privKeyWif,
            balance: isEvm ? `0.00 ${chain.toUpperCase()}` : "0.00 BTC",
            matchedKeyHex: currentKeyBigInt.toString(16),
            rangeStartHex: start.toString(16),
            rangeEndHex: end.toString(16),
            chain: isEvm ? chain : "btc",
          };

          // حفظ النتائج في التخزين المحلي عبر persistence.ts
          saveSearchProgress(resultPayload);

          worker.postMessage({
            type: "found",
            attempts,
            elapsedMs,
            result: resultPayload,
          });
          return;
        }
      }

      const elapsedMs = Math.max(1, performance.now() - startedAt);
      const rangeSize = end - start + 1n;
      const progressPercent = Number(((cursor - start) * 10000n) / rangeSize) / 100;
      
      worker.postMessage({
        type: "progress",
        attempts,
        elapsedMs,
        speed: Math.floor((attempts / elapsedMs) * 1000),
        percent: progressPercent,
        currentKeyHex: cursor.toString(16),
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    worker.postMessage({ type: "exhausted", attempts, elapsedMs: Math.max(1, performance.now() - startedAt) });

  } catch (error: any) {
    worker.postMessage({ type: "error", message: error?.message || "Scan failed." });
  }
};
