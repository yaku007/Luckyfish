/// <reference lib="webworker" />

import { type WorkerRequest, type WorkerResponse } from './vanity-protocol';

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

let activeWorkers: Worker[] = [];

worker.onmessage = (event) => {
  const data = event.data;

  if (data.type === 'stop') {
    activeWorkers.forEach((w) => w.postMessage({ type: 'stop' }));
    activeWorkers = [];
    return;
  }

  if (data.type === 'start') {
    const workerCount = Math.max(1, data.workerCount ?? 4);
    activeWorkers.forEach((w) => w.terminate());
    activeWorkers = [];

    let totalAttempts = 0;
    let completedWorkers = 0;
    const startTime = performance.now();

    // تقسيم النطاق (Range) بين عمال الـ CPU المتعددين
    const startBig = BigInt(`0x${data.startHex.replace(/^0x/i, '')}`);
    const endBig = BigInt(`0x${data.endHex.replace(/^0x/i, '')}`);
    const totalSize = endBig - startBig + 1n;
    const chunkSize = totalSize / BigInt(workerCount);

    for (let i = 0; i < workerCount; i++) {
      const chunkStart = startBig + BigInt(i) * chunkSize;
      const chunkEnd = i === workerCount - 1 ? endBig : chunkStart + chunkSize - 1n;

      const subWorker = new Worker(new URL('./vanity.worker.ts', import.meta.url), { type: 'module' });
      activeWorkers.push(subWorker);

      subWorker.onmessage = (resEvent: MessageEvent<WorkerResponse>) => {
        const msg = resEvent.data;

        if (msg.type === 'progress') {
          totalAttempts += 1;
          worker.postMessage({
            type: 'progress',
            attempts: totalAttempts,
            elapsedMs: Math.max(1, performance.now() - startTime),
            percent: Number(((chunkStart - startBig) * 100n) / totalSize),
          });
        } else if (msg.type === 'candidates') {
          worker.postMessage(msg);
        } else if (msg.type === 'found') {
          activeWorkers.forEach((w) => w.terminate());
          worker.postMessage(msg);
        } else if (msg.type === 'exhausted' || msg.type === 'generated' || msg.type === 'stopped') {
          completedWorkers += 1;
          if (completedWorkers >= workerCount) {
            worker.postMessage({
              type: msg.type,
              attempts: totalAttempts,
              elapsedMs: Math.max(1, performance.now() - startTime),
            });
          }
        } else if (msg.type === 'error') {
          activeWorkers.forEach((w) => w.terminate());
          worker.postMessage(msg);
        }
      };

      subWorker.postMessage({
        ...data,
        startHex: chunkStart.toString(16),
        endHex: chunkEnd.toString(16),
        candidateOffset: i * Number(chunkSize),
      });
    }
  }
};
