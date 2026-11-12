/// <reference lib="webworker" />

import { deriveBitcoinAddress, privateKeyFromRangeValue } from "./bitcoin";
import { deriveAddressFromPrivateKey } from "./multichain";
import { WasmEngine } from "./wasm-engine";

interface ScanRequest {
  startHex: string;
  endHex: string;
  targetAddress: string;
  chain: string;
  format?: string;
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

// دالة باش نحولو BigInt لـ 32 Bytes
function bigIntTo32Bytes(val: bigint): Uint8Array {
  const hex = val.toString(16).padStart(64, '0');
  return Uint8Array.from(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
}

// دالة باش نحولو 32 Bytes لـ BigInt
function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(`0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`);
}

worker.onmessage = async (event) => {
  const { startHex, endHex, targetAddress, chain, format, cursor: savedCursor } = event.data;
  const startedAt = performance.now();

  // 1. كنحملو الـ WASM
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
    
    const BATCH_SIZE = 2000; // عدد المفاتيح فـ كل دورة

    while (cursor <= end) {
      // 2. نجهزو Array ديال المفاتيح (Batch)
      const batchCount = Number(end - cursor + 1n) > BATCH_SIZE ? BATCH_SIZE : Number(end - cursor + 1n);
      const keysBuffer = new Uint8Array(batchCount * 32);

      // نعمر البافر بالمفاتيح الأولية
      let tempCursor = cursor;
      for (let i = 0; i < batchCount; i++) {
        const keyBytes = privateKeyFromRangeValue(tempCursor++);
        keysBuffer.set(keyBytes, i * 32);
      }

      // 3. نستعملو WASM باش نزيدو المفاتيح بـ +1 فـ نفس الوقت (في C++)
      if (wasm.isReady()) {
        wasm.incrementKeys(keysBuffer, batchCount);
      } else {
        // Fallback: نزيدوهم بـ JS إلا كان WASM ماشي خدام
        for (let i = 0; i < batchCount; i++) {
           let val = bytesToBigInt(keysBuffer.slice(i*32, (i+1)*32)) + 1n;
           keysBuffer.set(bigIntTo32Bytes(val), i*32);
        }
      }

      // 4. كنحسبو العناوين ونقارنو (فـ JS)
      for (let i = 0; i < batchCount && cursor <= end; i++) {
        const currentKeyBigInt = cursor++;
        const keyBytes = keysBuffer.slice(i * 32, (i + 1) * 32);
        attempts++;

        let address = "";
        let privKeyWif = "";

        if (isEvm) {
          address = deriveAddressFromPrivateKey(keyBytes, chain as any);
        } else {
          const keyResult = deriveBitcoinAddress(keyBytes, activeFormat as any);
          address = keyResult.address;
          privKeyWif = keyResult.privateKeyWif || "";
        }

        if (target && address && address.toLowerCase() === target) {
          const elapsedMs = Math.max(1, performance.now() - startedAt);
          worker.postMessage({
            type: "found",
            attempts,
            elapsedMs,
            result: {
              address,
              privateKeyHex: Array.from(keyBytes, (b) => b.toString(16).padStart(2, "0")).join(""),
              privateKeyWif: privKeyWif,
              matchedKeyHex: currentKeyBigInt.toString(16),
            },
          });
          return;
        }
      }

      // 5. تحديث الواجهة
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
