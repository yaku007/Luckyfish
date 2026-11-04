/// <reference lib="webworker" />

import {
  MAX_RECORDED_RANGE_CANDIDATES,
  type StartSearch,
  type WorkerRequest,
  type WorkerResponse,
} from './vanity-protocol';

const MAX_CPU_WORKERS = 32;

const coordinator = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

type RangePlan = {
  start: bigint;
  size: bigint;
  workSize: bigint;
  tasks: StartSearch[];
};

type ChildState = {
  attempts: number;
  percent: number | null;
  done: boolean;
  endType?: 'generated' | 'exhausted' | 'stopped' | 'history-limit';
};

let running = false;
let stopRequested = false;
let activeWorkers: Worker[] = [];

function parseRangeValue(value: string | undefined, label: string): bigint {
  const normalized = (value ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,64}$/.test(normalized)) {
    throw new Error(`${label} must be a hexadecimal value with 1 to 64 characters.`);
  }
  const parsed = BigInt(`0x${normalized}`);
  if (parsed < 1n) {
    throw new Error(`${label} is outside the valid Bitcoin private-key range.`);
  }
  return parsed;
}

function formatRangeValue(value: bigint, width: number): string {
  return value.toString(16).padStart(width, '0');
}

function createRangePlan(options: StartSearch, workerCount: number): RangePlan {
  const start = parseRangeValue(options.startHex, 'Start of range');
  const end = parseRangeValue(options.endHex, 'End of range');
  if (start > end) {
    throw new Error('The range start must be less than or equal to its end.');
  }

  const size = end - start + 1n;
  const candidateLimit = options.candidateLimit ?? MAX_RECORDED_RANGE_CANDIDATES;
  if (
    !Number.isInteger(candidateLimit) ||
    candidateLimit < 1 ||
    candidateLimit > MAX_RECORDED_RANGE_CANDIDATES
  ) {
    throw new Error('Candidate history limit is outside the allowed range.');
  }
  const workSize =
    size < BigInt(candidateLimit) ? size : BigInt(candidateLimit);
  const count = Math.min(workerCount, Number(workSize));
  const baseSize = workSize / BigInt(count);
  const remainder = Number(workSize % BigInt(count));
  const originalWidth = Math.max(
    (options.startHex ?? '').replace(/^0x/i, '').length,
    (options.endHex ?? '').replace(/^0x/i, '').length,
  );
  const width = Math.max(1, originalWidth);
  const startingIndex = options.candidateOffset ?? 0;
  if (!Number.isSafeInteger(startingIndex) || startingIndex < 0) {
    throw new Error('Candidate history offset is invalid.');
  }

  const tasks: StartSearch[] = [];
  let offset = 0n;
  for (let index = 0; index < count; index += 1) {
    const chunkSize = baseSize + (index < remainder ? 1n : 0n);
    const chunkStart = start + offset;
    const chunkEnd = chunkStart + chunkSize - 1n;
    tasks.push({
      ...options,
      startHex: formatRangeValue(chunkStart, width),
      endHex: formatRangeValue(chunkEnd, width),
      candidateOffset: startingIndex + Number(offset),
      candidateLimit: Number(chunkSize),
    });
    offset += chunkSize;
  }

  return { start, size, workSize, tasks };
}

function elapsedSince(startedAt: number): number {
  return Math.max(1, performance.now() - startedAt);
}

coordinator.onmessage = (event) => {
  if (event.data.type === 'stop') {
    stopRequested = true;
    for (const worker of activeWorkers) {
      worker.postMessage({ type: 'stop' });
    }
    return;
  }
  if (running) return;

  const options = event.data;
  const startedAt = performance.now();
  stopRequested = false;
  running = true;
  activeWorkers = [];

  const terminateWorkers = () => {
    for (const worker of activeWorkers) worker.terminate();
    activeWorkers = [];
  };

  const finishWithError = (message: string) => {
    terminateWorkers();
    running = false;
    coordinator.postMessage({ type: 'error', message });
  };

  try {
    const requestedWorkers = options.workerCount ?? 1;
    if (
      !Number.isInteger(requestedWorkers) ||
      requestedWorkers < 1 ||
      requestedWorkers > MAX_CPU_WORKERS
    ) {
      throw new Error(`Choose between 1 and ${MAX_CPU_WORKERS} CPU workers.`);
    }

    let rangePlan: RangePlan | null = null;
    let tasks: StartSearch[];
    if (options.mode === 'range') {
      rangePlan = createRangePlan(options, requestedWorkers);
      tasks = rangePlan.tasks;
    } else {
      tasks = Array.from({ length: requestedWorkers }, () => options);
    }

    const states: ChildState[] = tasks.map(() => ({
      attempts: 0,
      percent: options.mode === 'range' ? 0 : null,
      done: false,
    }));
    const totalWeight = rangePlan ? Number(rangePlan.workSize) : 0;
    let finalized = false;

    const totalAttempts = () =>
      states.reduce((total, state) => total + state.attempts, 0);

    const sendProgress = () => {
      if (finalized) return;
      const percent =
        rangePlan && totalWeight > 0
          ? states.reduce((total, state, index) => {
              const taskWeight = Number(
                BigInt(tasks[index].candidateLimit ?? 0),
              );
              return total + taskWeight * (state.percent ?? 0);
            }, 0) / totalWeight
          : null;
      coordinator.postMessage({
        type: 'progress',
        attempts: totalAttempts(),
        elapsedMs: elapsedSince(startedAt),
        percent,
      });
    };

    const finish = (message: WorkerResponse) => {
      if (finalized) return;
      finalized = true;
      terminateWorkers();
      running = false;
      coordinator.postMessage(message);
    };

    const finishWhenAllChildrenStop = () => {
      if (finalized || states.some((state) => !state.done)) return;

      const attempts = totalAttempts();
      const elapsedMs = elapsedSince(startedAt);
      if (stopRequested || states.every((state) => state.endType === 'stopped')) {
        finish({ type: 'stopped', attempts, elapsedMs });
      } else if (rangePlan && rangePlan.size > rangePlan.workSize) {
        finish({
          type: 'history-limit',
          attempts,
          elapsedMs,
          limit: MAX_RECORDED_RANGE_CANDIDATES,
        });
      } else if (states.some((state) => state.endType === 'history-limit')) {
        finish({
          type: 'history-limit',
          attempts,
          elapsedMs,
          limit: MAX_RECORDED_RANGE_CANDIDATES,
        });
      } else if (states.every((state) => state.endType === 'generated')) {
        finish({ type: 'generated', attempts, elapsedMs });
      } else if (states.every((state) => state.endType === 'exhausted')) {
        finish({ type: 'exhausted', attempts, elapsedMs });
      } else {
        finishWithError('The CPU workers stopped before the search completed.');
      }
    };

    const workers: Worker[] = [];
    tasks.forEach(() => {
      workers.push(
        new Worker(new URL('./vanity.worker.ts', import.meta.url), {
          type: 'module',
        }),
      );
      activeWorkers = workers;
    });

    workers.forEach((worker, index) => {
      worker.onmessage = (childEvent: MessageEvent<WorkerResponse>) => {
        if (finalized) return;
        const message = childEvent.data;
        const state = states[index];

        if (message.type === 'candidates') {
          coordinator.postMessage(message);
          return;
        }

        if ('attempts' in message) state.attempts = message.attempts;
        if (message.type === 'progress') {
          state.percent = message.percent;
          sendProgress();
          return;
        }

        if (message.type === 'found') {
          finish({
            type: 'found',
            attempts: totalAttempts(),
            elapsedMs: elapsedSince(startedAt),
            result: message.result,
          });
          return;
        }

        if (message.type === 'error') {
          finishWithError(message.message);
          return;
        }

        if (
          message.type === 'generated' ||
          message.type === 'exhausted' ||
          message.type === 'stopped' ||
          message.type === 'history-limit'
        ) {
          state.endType = message.type;
          state.percent = 100;
          state.done = true;
          sendProgress();
          finishWhenAllChildrenStop();
        }
      };

      worker.onerror = () => {
        if (!finalized) {
          finishWithError('A CPU worker stopped unexpectedly.');
        }
      };
      worker.postMessage({ ...tasks[index], type: 'start' });
    });
  } catch (error) {
    finishWithError(
      error instanceof Error ? error.message : 'Could not start CPU workers.',
    );
  }
};
