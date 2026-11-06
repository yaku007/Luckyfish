/// <reference lib="webworker" />

import {
  deriveBitcoinAddress,
  deriveBitcoinAddressOnly,
  privateKeyFromRangeValue,
} from "./bitcoin";
import {
  deriveAddressFromPrivateKey,
  matchesEvmVanityPattern,
} from "./multichain";

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<any>) => void) | null;
  postMessage: (message: any) => void;
};

let stopRequested = false;
let running = false;

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

    try {
      const startHex = options.startHex ?? "1";
      const endHex = options.endHex ?? "FFFFF";
      
      const start = BigInt(`0x${startHex.trim().replace(/^0x/i, "")}`);
      const end = BigInt(`0x${endHex.trim().replace(/^0x/i, "")}`);
      
      if (start > end) {
        throw new Error("Start range must be less than or equal to End range.");
      }

      let cursor = start;
      const rangeSize = end - start + 1n;
      const targetAddress = (options.targetAddress ?? "").trim();
      const chain = options.chain ?? "btc";
      const format = options.format ?? "legacy";
      const BATCH_SIZE = 10000; // دفعات سريعة
      let lastReportAt = 0;

      while (!stopRequested && cursor <= end) {
        for (let i = 0; i < BATCH_SIZE && cursor <= end && !stopRequested; i++) {
          const key = privateKeyFromRangeValue(cursor);
          const address = chain !== "btc"
            ? deriveAddressFromPrivateKey(key, chain)
            : deriveBitcoinAddressOnly(key, format);

          attempts += 1;

          const isMatch = chain !== "btc"
            ? matchesEvmVanityPattern(address, "", "") && address.toLowerCase() === targetAddress.toLowerCase()
            : address === targetAddress;

          if (isMatch) {
            const result = deriveBitcoinAddress(key, format);
            worker.postMessage({
              type: "found",
              attempts,
              elapsedMs: Math.max(1, performance.now() - startedAt),
              result: {
                ...result,
                address,
                index: cursor.toString(),
              },
            });
            return;
          }

          cursor += 1n;
        }

        const now = performance.now();
        if (now - lastReportAt >= 200) {
          const elapsedMs = Math.max(1, now - startedAt);
          const speed = Math.floor((attempts / elapsedMs) * 1000);
          const percent = Number(((cursor - start) * 10000n) / rangeSize) / 100;

          worker.postMessage({
            type: "progress",
            attempts,
            elapsedMs,
            speed,
            index: cursor.toString(),
            currentKeyHex: cursor.toString(16),
            percent,
          });
          lastReportAt = now;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      if (cursor > end) {
        worker.postMessage({
          type: "exhausted",
          attempts,
          elapsedMs: Math.max(1, performance.now() - startedAt),
        });
      } else {
        worker.postMessage({
          type: "stopped",
          attempts,
          elapsedMs: Math.max(1, performance.now() - startedAt),
        });
      }
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
