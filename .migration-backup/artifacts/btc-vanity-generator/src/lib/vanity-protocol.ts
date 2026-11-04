import type { AddressFormat } from "./bitcoin";

export type SearchMode = "random" | "range";

export const MAX_RECORDED_RANGE_CANDIDATES = 100_000_000_000_000;
export const CANDIDATE_BATCH_SIZE = 500;

export type StartSearch = {
  type: "start";
  mode: SearchMode;
  format: AddressFormat;
  prefix: string;
  suffix: string;
  targetAddress?: string;
  startHex?: string;
  endHex?: string;
  generateOnly?: boolean;
  candidateLimit?: number;
  workerCount?: number;
  candidateOffset?: number;
};

export type WorkerRequest = StartSearch | { type: "stop" };

export type SearchResult = {
  address: string;
  privateKeyWif: string;
  privateKeyHex: string;
};

export type CandidateRecord = {
  index: number;
  address: string;
  privateKeyWif: string;
  rangeStartHex: string;
  rangeEndHex: string;
};

export type WorkerResponse =
  | {
      type: "progress";
      attempts: number;
      elapsedMs: number;
      percent: number | null;
    }
  | {
      type: "found";
      attempts: number;
      elapsedMs: number;
      result: SearchResult;
    }
  | { type: "candidates"; candidates: CandidateRecord[] }
  | {
      type: "history-limit";
      attempts: number;
      elapsedMs: number;
      limit: number;
    }
  | { type: "generated"; attempts: number; elapsedMs: number }
  | { type: "exhausted"; attempts: number; elapsedMs: number }
  | { type: "stopped"; attempts: number; elapsedMs: number }
  | { type: "error"; message: string };
