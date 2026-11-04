export const BITCOIN_PUZZLE_COUNT = 160;

export function getBitcoinPuzzleRange(number: number) {
  const start = 1n << BigInt(number - 1);
  const end = (1n << BigInt(number)) - 1n;
  const hexWidth = Math.ceil(number / 4);

  return {
    startHex: start.toString(16).padStart(hexWidth, '0'),
    endHex: end.toString(16).padStart(hexWidth, '0'),
  };
}
