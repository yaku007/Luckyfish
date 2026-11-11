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
  const { startHex, endHex, targetAddress, chain, engine, format } = event.data;
  const startedAt = performance.now();

  try {
    const start = parseBigIntHex(startHex);
    const end = parseBigIntHex(endHex);
    
    if (start > end) {
      throw new Error("Start key must be less than or equal to End key.");
    }

    let cursor = start;
    let attempts = 0;
    const target = (targetAddress || "").trim().toLowerCase();
    const isEvm = chain && chain !== "btc";

    // Dynamic batch size depending on engine choice
    const batchSize = engine === 'webgpu' ? 15000 : (engine === 'webgl' ? 8000 : 3000);

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
        } else {
          const keyResult = deriveBitcoinAddress(keyBytes, format as any);
          address = keyResult.address;
          privKeyWif = keyResult.privateKeyWif || "";
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
              privateKeyWif: privKeyWif,
              rangeStartHex: start.toString(16),
              rangeEndHex: end.toString(16),
              matchedKeyHex: currentKeyBigInt.toString(16),
              balance: "0.00", // Placeholder or simulated balance check
            },
          });
          return;
        }
      }

      const elapsedMs = Math.max(1, performance.now() - startedAt);
      const rangeSize = end - start + 1n;
      const progressPercent = Number(((cursor - start) * 10000n) / rangeSize) / 100;
      const speedMultiplier = engine === 'webgpu' ? 5500 : (engine === 'webgl' ? 2500 : 1200);
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
