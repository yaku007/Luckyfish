/// <reference lib="webworker" />

import {
  deriveBitcoinAddress,
  PRIVATE_KEY_LIMIT,
  privateKeyFromRangeValue,
} from "./bitcoin";
import {
  deriveAddressFromPrivateKey,
} from "./multichain";

interface ScanRequest {
  startHex: string;
  endHex: string;
  targetAddress: string;
  chain: string;
  engine: 'cpu' | 'webgl' | 'webgpu';
  format?: string;
  cursor?: string;
}

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<ScanRequest>) => void) | null;
  postMessage: (message: any) => void;
};

function parseBigIntHex(hex: string): bigint {
  const cleaned = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw new Error("Invalid hexadecimal range value.");
  }
  return BigInt(`0x${cleaned}`);
}

worker.onmessage = async (event) => {
  const { startHex, endHex, targetAddress, chain, engine, cursor: savedCursor } = event.data;
  const startedAt = performance.now();

  try {
    const start = parseBigIntHex(startHex);
    const end = parseBigIntHex(endHex);
    let cursor = savedCursor ? parseBigIntHex(savedCursor) : start;
    
    if (start > end) {
      throw new Error("Start key must be less than or equal to End key.");
    }

    let attempts = 0;
    const target = (targetAddress || "").trim().toLowerCase();
    const isEvm = chain && chain !== "btc";
    const batchSize = engine === 'webgpu' ? 25000 : (engine === 'webgl' ? 12000 : 5000);

    while (cursor <= end) {
      for (let batch = 0; batch < batchSize && cursor <= end; batch++) {
        const currentKeyBigInt = cursor;
        const keyBytes = privateKeyFromRangeValue(cursor++);
        attempts++;

        let address = "";
        let privKeyHex = "";
        let privKeyWif = "";

        privKeyHex = Array.from(keyBytes, (b) => b.toString(16).padStart(2, "0")).join("").padStart(64, "0");

        if (isEvm) {
          address = deriveAddressFromPrivateKey(keyBytes, chain as any);
          if (target && address.toLowerCase() === target) {
            sendFound(worker, attempts, startedAt, address, privKeyHex, "", start, end, currentKeyBigInt);
            return;
          }
        } else {
          // 🔍 فحص جميع صيغ البيتكوين الممكنة (Compressed, Uncompressed, SegWit) باش ما يضيع حتى عنوان
          const formats: Array<'compressed' | 'uncompressed' | 'p2wpkh'> = ['compressed', 'uncompressed', 'p2wpkh'];
          
          for (const fmt of formats) {
            try {
              const keyResult = deriveBitcoinAddress(keyBytes, fmt);
              if (keyResult && keyResult.address) {
                if (target && keyResult.address.toLowerCase() === target) {
                  sendFound(worker, attempts, startedAt, keyResult.address, privKeyHex, keyResult.privateKeyWif || "", start, end, currentKeyBigInt);
                  return;
                }
              }
            } catch (e) {
              // تجاوز أي صيغة غير متوافقة مع المفتاح الحالي
            }
          }
        }
      }

      const elapsedMs = Math.max(1, performance.now() - startedAt);
      const rangeSize = end - start + 1n;
      const progressPercent = Number(((cursor - start) * 10000n) / rangeSize) / 100;
      const calculatedSpeed = Math.floor((attempts / elapsedMs) * 1200);

      worker.postMessage({
        type: "progress",
        attempts,
        elapsedMs,
        speed: calculatedSpeed,
        percent: progressPercent,
        currentKeyHex: cursor.toString(16),
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    worker.postMessage({
      type: "exhausted",
      attempts,
      elapsedMs: Math.max(1, performance.now() - startedAt),
    });

  } catch (error: any) {
    worker.postMessage({
      type: "error",
      message: error?.message || "Range scan execution failed.",
    });
  }
};

function sendFound(worker: any, attempts: number, startedAt: number, address: string, privKeyHex: string, privKeyWif: string, start: bigint, end: bigint, currentKeyBigInt: bigint) {
  const elapsedMs = Math.max(1, performance.now() - startedAt);
  worker.postMessage({
    type: "found",
    attempts,
    elapsedMs,
    result: {
      address,
      privateKeyHex: privKeyHex,
      privateKeyWif: privKeyWif,
      rangeStartHex: start.toString(16),
      rangeEndHex: end.toString(16),
      matchedKeyHex: currentKeyBigInt.toString(16),
      balance: "0.00 BTC / ETH",
    },
  });
    }
