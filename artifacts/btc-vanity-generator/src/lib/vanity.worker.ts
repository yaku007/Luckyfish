/// <reference lib="webworker" />

import {
  deriveBitcoinAddress,
  PRIVATE_KEY_LIMIT,
  privateKeyFromRangeValue,
  randomPrivateKey,
} from "./bitcoin";
import {
  deriveAddressFromPrivateKey,
} from "./multichain";
import {
  type WorkerRequest,
  type WorkerResponse,
} from "./vanity-protocol";

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

let stopRequested = false;
let running = false;

function parseRangeValue(value: string | undefined, label: string): bigint {
  const normalized = (value ?? "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,64}$/.test(normalized)) {
    throw new Error(`${label} must be a hexadecimal value with 1 to 64 characters.`);
  }
  const parsed = BigInt(`0x${normalized}`);
  if (parsed < 1n || parsed >= PRIVATE_KEY_LIMIT) {
    throw new Error(`${label} is outside the valid Bitcoin private-key range.`);
  }
  return parsed;
}

worker.onmessage = (event) => {
  if (event.data.type === "stop") {
    stopRequested = true;
    return;
  }
  if (running) return;

  const options = event.data;
  const startedAt = performance.now();
  stopRequested = false;
  running = true;

  void (async () => {
    let attempts = 0;
    let start = 0n;
    let end = 0n;
    let cursor = 0n;

    try {
      if (options.mode === "range") {
        start = parseRangeValue(options.startHex, "Start of range");
        end = parseRangeValue(options.endHex, "End of range");
        if (start > end) {
          throw new Error("The range start must be less than or equal to its end.");
        }
        cursor = start;
      }

      const rangeSize = options.mode === "range" ? end - start + 1n : 0n;
      let lastReportAt = performance.now();

      while (!stopRequested) {
        for (let batch = 0; batch < 2000 && !stopRequested; batch++) {
          if (options.mode === "range" && cursor > end) {
            worker.postMessage({
              type: "exhausted",
              attempts,
              elapsedMs: Math.max(1, performance.now() - startedAt),
            });
            return;
          }

          const currentCursor = cursor;
          const key =
            options.mode === "range"
              ? privateKeyFromRangeValue(cursor++)
              : randomPrivateKey();

          const evmChain = options.chain && options.chain !== "btc" ? options.chain : null;
          const isEvmChain = evmChain !== null;

          let address = "";
          let keyResult: any = null;

          // 🛠️ توحيد طريقة استخراج الـ Hex Private Key بـ 32 بايت مضبوطة (مطابقة للـ Generator)
          const privKeyHex = Array.from(key, (b) => b.toString(16).padStart(2, "0")).join("").padStart(64, "0");

          if (isEvmChain) {
            address = deriveAddressFromPrivateKey(key, evmChain);
            keyResult = {
              address,
              privateKeyHex: privKeyHex,
              privateKeyWif: "",
            };
          } else {
            keyResult = deriveBitcoinAddress(key, options.format);
            address = keyResult.address;
            keyResult.privateKeyHex = privKeyHex;
          }

          attempts += 1;

          const target = (options.targetAddress ?? "").trim().toLowerCase();
          const isMatch = target ? address.toLowerCase() === target : false;

          if (isMatch) {
            worker.postMessage({
              type: "found",
              attempts,
              elapsedMs: Math.max(1, performance.now() - startedAt),
              result: {
                ...keyResult,
                address,
                rangeStartHex: start.toString(16),
                rangeEndHex: end.toString(16),
                privateKeyHex: privKeyHex,
              },
            });
            return;
          }
        }

        const now = performance.now();
        if (now - lastReportAt >= 150) {
          const percent =
            options.mode === "range" && rangeSize > 0n
              ? Math.min(
                  100,
                  Number(((cursor - start) * 1_000_000n) / rangeSize) / 10_000,
                )
              : null;
          worker.postMessage({
            type: "progress",
            attempts,
            elapsedMs: Math.max(1, performance.now() - startedAt),
            percent,
          });
          lastReportAt = now;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      worker.postMessage({
        type: "stopped",
        attempts,
        elapsedMs: Math.max(1, performance.now() - startedAt),
      });
    } catch (error) {
      worker.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : "Search failed.",
      });
    } finally {
      running = false;
    }
  })();
};
