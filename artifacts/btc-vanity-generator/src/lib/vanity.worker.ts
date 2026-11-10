/// <reference lib="webworker" />

import {
  deriveBitcoinAddress,
  deriveBitcoinAddressOnly,
  PRIVATE_KEY_LIMIT,
  privateKeyFromRangeValue,
  randomPrivateKey,
} from "./bitcoin";
import {
  deriveAddressFromPrivateKey,
  matchesEvmVanityPattern,
} from "./multichain";
import {
  CANDIDATE_BATCH_SIZE,
  MAX_RECORDED_RANGE_CANDIDATES,
  type CandidateRecord,
  type WorkerRequest,
  type WorkerResponse,
} from "./vanity-protocol";
import { WebGPUBruteEngine } from "./gpu-brute-engine";

const MAX_CANDIDATES_BETWEEN_YIELDS = 64;

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
  type: "exhausted" | "stopped" | "generated",
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
    let pendingCandidates: CandidateRecord[] = [];

    try {
      if (options.generateOnly && options.mode !== "range") {
        throw new Error("Generate-only mode requires a custom key range.");
      }

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
      let lastReportAt = 0;

      const flushCandidates = () => {
        if (pendingCandidates.length === 0) return;
        worker.postMessage({
          type: "candidates",
          candidates: pendingCandidates,
        });
        pendingCandidates = [];
      };

      while (!stopRequested) {
        for (
          let count = 0;
          count < MAX_CANDIDATES_BETWEEN_YIELDS && !stopRequested;
          count += 1
        ) {
          if (options.mode === "range" && cursor > end) {
            flushCandidates();
            reportEnd(
              options.generateOnly ? "generated" : "exhausted",
              attempts,
              startedAt,
            );
            return;
          }

          if ((options as any).engine === 'webgpu' && gpuEngine.getSupported()) {
            await gpuEngine.executeRangeBatch(Number(cursor & 0xffffffffn), 256);
          }

          const currentKeyVal = cursor;
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

          if (options.generateOnly && options.mode === "range") {
            pendingCandidates.push({
              index: (options.candidateOffset ?? 0) + attempts,
              address,
              selectedChainAddress: address,
              privateKeyWif: keyResult.privateKeyWif || "",
              privateKeyHex: keyResult.privateKeyHex,
              rangeStartHex: start.toString(16),
              rangeEndHex: end.toString(16),
            });
            if (pendingCandidates.length >= CANDIDATE_BATCH_SIZE) {
              flushCandidates();
            }
          }

          const target = options.targetAddress ?? "";
          const isMatch = isEvmChain
            ? (target ? address.toLowerCase() === target.toLowerCase() : matchesEvmVanityPattern(address, options.prefix, options.suffix))
            : matches(address, options.prefix, options.suffix, target);

          if (isMatch) {
            flushCandidates();
            worker.postMessage({
              type: "found",
              attempts,
              elapsedMs: Math.max(1, performance.now() - startedAt),
              result: {
                ...keyResult,
                address,
                rangeStartHex: start.toString(16),
                rangeEndHex: end.toString(16),
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
          reportProgress(attempts, startedAt, percent);
          lastReportAt = now;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      flushCandidates();
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
