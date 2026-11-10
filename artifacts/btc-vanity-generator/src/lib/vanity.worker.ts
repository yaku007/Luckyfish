/// <reference lib="webworker" />

import {
  deriveBitcoinAddress,
  PRIVATE_KEY_LIMIT,
  privateKeyFromRangeValue,
  randomPrivateKey,
} from "./bitcoin";
import {
  deriveAddressFromPrivateKey,
  matchesEvmVanityPattern,
} from "./multichain";
import {
  type WorkerRequest,
  type WorkerResponse,
} from "./vanity-protocol";
import { WebGPUBruteEngine } from "./gpu-brute-engine";

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

let stopRequested = false;
let running = false;
const gpuEngine = new WebGPUBruteEngine();

function matches(
  address: string,
  prefix: string,
  suffix: string,
  targetAddress: string,
): boolean {
  if (targetAddress) return address.toLowerCase() === targetAddress.toLowerCase();
  return address.startsWith(prefix) && address.endsWith(suffix);
}

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

function reportProgress(
  attempts: number,
  startedAt: number,
  rangePercent: number | null,
) {
  const elapsedMs = Math.max(1, performance.now() - startedAt);
  worker.postMessage({
    type: "progress",
    attempts,
    elapsedMs,
    percent: rangePercent,
  });
}

function reportEnd(
  type: "exhausted" | "stopped",
  attempts: number,
  startedAt: number,
) {
  worker.postMessage({
    type,
    attempts,
    elapsedMs: Math.max(1, performance.now() - startedAt),
  });
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

      if ((options as any).engine === 'webgpu') {
        await gpuEngine.initialize();
      }

      const rangeSize = options.mode === "range" ? end - start + 1n : 0n;
      let lastReportAt = performance.now();

      // 🚀 Tight Brute-force Loop (Non-stop Execution)
      while (!stopRequested) {
        // حلقة سرعة قوية بدون Yields معطلة
        for (let batch = 0; batch < 2000 && !stopRequested; batch++) {
          if (options.mode === "range" && cursor > end) {
            reportEnd("exhausted", attempts, startedAt);
            return;
          }

          if ((options as any).engine === 'webgpu' && gpuEngine.getSupported()) {
            await gpuEngine.executeRangeBatch(Number(cursor & 0xffffffffn), 256);
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

          if (isEvmChain) {
            address = deriveAddressFromPrivateKey(key, evmChain);
            const privKeyHex = Array.from(key, (b) => b.toString(16).padStart(2, "0")).join("");
            keyResult = {
              address,
              privateKeyHex: privKeyHex,
              privateKeyWif: "",
            };
          } else {
            keyResult = deriveBitcoinAddress(key, options.format);
            address = keyResult.address;
          }

          attempts += 1;

          const target = options.targetAddress ?? "";
          const isMatch = isEvmChain
            ? (target ? address.toLowerCase() === target.toLowerCase() : matchesEvmVanityPattern(address, options.prefix, options.suffix))
            : matches(address, options.prefix, options.suffix, target);

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
                matchedKeyHex: currentCursor.toString(16),
              },
            });
            return;
          }
        }

        // تحديث الـ Telemetry كل 100ms بدون إيقاف الـ Loop
        const now = performance.now();
        if (now - lastReportAt >= 100) {
          const percent =
            options.mode === "range" && rangeSize > 0n
              ? Math.min(
                  100,
                  Number(((cursor - start) * 1_000_000n) / rangeSize) / 10_000,
                )
              : null;
          reportProgress(attempts, startedAt, percent);
          lastReportAt = now;
        }

        // السماح للـ Worker بإرسال الـ Messages بدون خنق الـ Core
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      reportEnd("stopped", attempts, startedAt);
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
