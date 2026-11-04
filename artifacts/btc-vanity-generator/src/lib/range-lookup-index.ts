import type { CandidateRecord } from './vanity-protocol';

const MAX_INDEXED_ADDRESSES = 100_000;

export type AddressRangeLookup = {
  address: string;
  startHex: string;
  endHex: string;
};

const rangesByAddress = new Map<string, AddressRangeLookup[]>();
let indexedAddressCount = 0;

function normalizeAddress(address: string): string {
  return /^bc1/i.test(address) ? address.toLowerCase() : address;
}

export function rememberGeneratedAddressRanges(records: CandidateRecord[]): void {
  for (const record of records) {
    const key = normalizeAddress(record.address);
    const ranges = rangesByAddress.get(key);
    const range = {
      address: record.address,
      startHex: record.rangeStartHex,
      endHex: record.rangeEndHex,
    };
    if (ranges) {
      if (!ranges.some((item) => item.startHex === range.startHex && item.endHex === range.endHex)) {
        ranges.push(range);
      }
      continue;
    }

    if (indexedAddressCount >= MAX_INDEXED_ADDRESSES) {
      const oldestAddress = rangesByAddress.keys().next().value;
      if (oldestAddress !== undefined) {
        rangesByAddress.delete(oldestAddress);
        indexedAddressCount -= 1;
      }
    }
    rangesByAddress.set(key, [range]);
    indexedAddressCount += 1;
  }
}

export function findGeneratedAddressRanges(address: string): AddressRangeLookup[] {
  return rangesByAddress.get(normalizeAddress(address)) ?? [];
}
