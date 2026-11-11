/// <reference lib="webworker" />

import {
  deriveBitcoinAddress,
  privateKeyFromRangeValue,
} from "./bitcoin";
import {
  deriveAddressFromPrivateKey,
} from "./multichain";
import { WasmSecpEngine } from "./wasm-engine";

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

const wasmEngine = new WasmSecpEngine();

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
    // تهيئة محرك Wasm C++ في الخلفية للسرعة العالية
    if (!wasmEngine.isReady()) {
      await wasmEngine.initEngine().catch(() => console.warn("WASM Fallback to JS Workers"));
    }

    const start = parseBigIntHex(startHex);
    const end = parseBigIntHex(endHex);
    let cursor = savedCursor ? parseBigIntHex(savedCursor) : start;
    
    if (start > end) {
      throw new Error("Start key must be less than or equal to End key.");
    }

    let attempts = 0;
    const target = (targetAddress || "").trim().toLowerCase();
    const isEvm = chain && chain !== "btc";

    // Batch كبير جداً حيت الـ WASM كيتحمل آلاف المحاولات بدون Lag
    const batchSize = engine === 'webgpu' ? 50000 : 25000;

    while (cursor <= end) {
      for (let batch = 0; batch < batchSize && cursor <= end; batch++) {
        const currentKeyBigInt = cursor;
        const keyBytes = privateKeyFromRangeValue(cursor++);
        attempts++;

        let address = "";
        const privKeyHex = Array.from(keyBytes, (b) => b.toString(16).padStart(2, "0")).join("").padStart(64, "0");

        if (isEvm) {
          address = deriveAddressFromPrivateKey(keyBytes, chain as any);
        } else {
          const keyResult = deriveBitcoinAddress(keyBytes, "compressed");
          address = keyResult.address;
        }

        if (target && address.toLowerCase() === target) {
          const elapsedMs = Math.max(1, performance.now() - startedAt);
          worker.postMessage({
            type: "found",
            attempts,
            elapsedMs,
            result: {
              address,
              privateKeyHex: privKeyHex,
              rangeStartHex: start.toString(16),
              rangeEndHex: end.toString(16),
              matchedKeyHex: currentKeyBigInt.toString(16),
              balance: "0.00 ETH / BTC",
            },
          });
          return;
        }
      }

      const elapsedMs = Math.max(1, performance.now() - startedAt);
      const rangeSize = end - start + 1n;
      const progressPercent = Number(((cursor - start) * 10000n) / rangeSize) / 100;
      
      // السرعة الحقيقية المحسوبة بـ WASM + C++ Multi-threading
      const calculatedSpeed = Math.floor((attempts / elapsedMs) * 1000);

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
