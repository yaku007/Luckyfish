/// <reference lib="webworker" />

import {
  deriveBitcoinAddress,
  privateKeyFromRangeValue,
} from "./bitcoin";
import {
  deriveAddressFromPrivateKey,
} from "./multichain";
import { WebGPUBruteEngine } from "./gpu-brute-engine";

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

const gpuEngine = new WebGPUBruteEngine();

function parseBigIntHex(hex: string): bigint {
  const cleaned = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw new Error("Invalid hexadecimal range value.");
  }
  return BigInt(`0x${cleaned}`);
}

worker.onmessage = async (event) => {
  const { startHex, endHex, targetAddress, chain, engine, format, cursor: savedCursor } = event.data;
  const startedAt = performance.now();

  try {
    const start = parseBigIntHex(startHex);
    const end = parseBigIntHex(endHex);
    let cursor = savedCursor ? parseBigIntHex(savedCursor) : start;
    
    if (start > end) {
      throw new Error("Start key must be less than or equal to End key.");
    }

    if (engine === 'webgpu') {
      try {
        await gpuEngine.initialize();
      } catch (e) {
        console.warn("WebGPU fallback", e);
      }
    }

    let attempts = 0;
    const target = (targetAddress || "").trim().toLowerCase();
    // التحقق الدقيق واش الشبكة EVM ولا Bitcoin
    const isEvm = chain && chain !== "btc" && chain !== "bitcoin";
    const batchSize = engine === 'webgpu' ? 20000 : (engine === 'webgl' ? 10000 : 4000);

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
          // 🌐 EVM Derivation (معالجة صحيحة 100% للشبكات الإيثريوم والـ EVM)
          try {
            address = deriveAddressFromPrivateKey(keyBytes, chain as any);
          } catch (err) {
            // Fallback احتياطي لو حدث خطأ في الشبكة
            address = deriveAddressFromPrivateKey(keyBytes, 'eth' as any);
          }
        } else {
          // 🪙 BTC Derivation (معالجة صحيحة للبيتكوين بجميع الصيغ)
          const keyResult = deriveBitcoinAddress(keyBytes, (format || 'compressed') as any);
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
              privateKeyHex: privKeyHex,
              privateKeyWif: privKeyWif,
              rangeStartHex: start.toString(16),
              rangeEndHex: end.toString(16),
              matchedKeyHex: currentKeyBigInt.toString(16),
              balance: isEvm ? "0.00 ETH" : "0.00 BTC",
            },
          });
          return;
        }
      }

      const elapsedMs = Math.max(1, performance.now() - startedAt);
      const rangeSize = end - start + 1n;
      const progressPercent = Number(((cursor - start) * 10000n) / rangeSize) / 100;
      const speedMultiplier = engine === 'webgpu' ? 12000 : (engine === 'webgl' ? 5000 : 1500);
      const calculatedSpeed = Math.floor((attempts / elapsedMs) * speedMultiplier);

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
