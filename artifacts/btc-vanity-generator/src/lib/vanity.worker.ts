/// <reference lib="webworker" />

import {
  deriveBitcoinAddress,
  deriveBitcoinAddressOnly,
  randomPrivateKey,
} from "./bitcoin";

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
    const targetAddresses: string[] = options.targetAddresses ?? [];

    try {
      if (targetAddresses.length === 0) {
        throw new Error("Enter at least one target address to search for.");
      }

      // ⚡ N-st3mlo Set bach l-lookup ykon O(1) sriiɛ bzaf
      const targetSet = new Set(targetAddresses.map((addr: string) => addr.trim()));
      const format = options.format ?? "legacy";
      const BATCH_SIZE = 20000; // Batch kbir l a3la sorɛa (Keys/sec)
      let lastReportAt = 0;

      while (!stopRequested) {
        for (let i = 0; i < BATCH_SIZE && !stopRequested; i++) {
          const key = randomPrivateKey();
          const address = deriveBitcoinAddressOnly(key, format);
          attempts += 1;

          if (targetSet.has(address)) {
            const result = deriveBitcoinAddress(key, format);
            worker.postMessage({
              type: "found",
              attempts,
              elapsedMs: Math.max(1, performance.now() - startedAt),
              result: {
                privateKeyHex: result.privateKeyHex,
                privateKeyWif: result.privateKeyWif,
                address: result.address,
              },
            });
            return;
          }
        }

        const now = performance.now();
        if (now - lastReportAt >= 200) {
          const elapsedMs = Math.max(1, now - startedAt);
          const speed = Math.floor((attempts / elapsedMs) * 1000);
          worker.postMessage({
            type: "progress",
            attempts,
            elapsedMs,
            speed,
          });
          lastReportAt = now;
        }

        // Yield khafif ll-worker thread bach l-UI ma y-blockich
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
