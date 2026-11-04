import { useEffect, useMemo, useState } from 'react';
import { Bitcoin, Check, Copy, Search } from 'lucide-react';
import { Link } from 'wouter';
import DonationAddress from '@/components/donation-address';
import { BITCOIN_PUZZLE_COUNT, getBitcoinPuzzleRange } from '@/lib/bitcoin-puzzle';
import './bitcoin-puzzle.css';

export default function BitcoinPuzzlePage({ active }: { active: boolean }) {
  const [query, setQuery] = useState('');
  const [copiedPuzzle, setCopiedPuzzle] = useState<number | null>(null);
  const [copyError, setCopyError] = useState(false);

  useEffect(() => {
    if (active) document.title = 'Bitcoin Puzzle | LUCKY BTC';
  }, [active]);

  const puzzles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return Array.from({ length: BITCOIN_PUZZLE_COUNT }, (_, index) => {
      const number = index + 1;
      return { number, ...getBitcoinPuzzleRange(number) };
    }).filter(({ number, startHex, endHex }) => {
      if (!normalizedQuery) return true;
      const keyQuery = normalizedQuery.replace(/^0x/, '');
      return (
        String(number).includes(normalizedQuery) ||
        startHex.includes(keyQuery) ||
        endHex.includes(keyQuery)
      );
    });
  }, [query]);

  async function copyRange(number: number, startHex: string, endHex: string) {
    try {
      await navigator.clipboard.writeText(`${startHex} - ${endHex}`);
      setCopiedPuzzle(number);
      setCopyError(false);
      window.setTimeout(() => setCopiedPuzzle(null), 1600);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <main className="puzzle-ref-page" data-testid="page-bitcoin-puzzle">
      <section className="puzzle-ref-intro" aria-labelledby="puzzle-ref-title">
        <div className="puzzle-ref-kicker">
          <Bitcoin aria-hidden="true" />
          Local puzzle index
        </div>
        <h1 id="puzzle-ref-title">Bitcoin Puzzle Challenge</h1>
        <p>
          Browse all {BITCOIN_PUZZLE_COUNT} public puzzle ranges here. Search by
          puzzle number or hexadecimal key, then copy a range without leaving
          this site.
        </p>
        <Link
          className="puzzle-ref-link puzzle-address-lookup-link"
          href="/puzzle-address-lookup"
          data-testid="link-puzzle-address-lookup"
        >
          <Search aria-hidden="true" />
          Find range by address
        </Link>
      </section>

      <section className="puzzle-ref-board" aria-labelledby="puzzle-ref-board-title">
        <div className="puzzle-ref-board-head">
          <div>
            <p className="puzzle-ref-label">PUZZLE INDEX</p>
            <h2 id="puzzle-ref-board-title">All puzzle ranges</h2>
          </div>
          <span className="puzzle-ref-count">
            <span aria-hidden="true" />
            {puzzles.length} of {BITCOIN_PUZZLE_COUNT} puzzles
          </span>
        </div>
        <label className="puzzle-ref-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search puzzles by number or key</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search puzzle number or hex key"
            inputMode="search"
            data-testid="input-puzzle-search"
          />
        </label>
        <div className="puzzle-ref-table-wrap">
          <table className="puzzle-ref-table">
            <thead>
              <tr>
                <th scope="col">Puzzle</th>
                <th scope="col">Private key range (hex)</th>
                <th scope="col">Key size</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {puzzles.map(({ number, startHex, endHex }) => (
                <tr key={number} data-testid={`row-puzzle-${number}`}>
                  <th scope="row">#{number}</th>
                  <td className="puzzle-ref-range">
                    <code>{startHex}</code>
                    <span aria-hidden="true"> - </span>
                    <code>{endHex}</code>
                  </td>
                  <td>{number} bit{number === 1 ? '' : 's'}</td>
                  <td className="puzzle-ref-action">
                    <button
                      type="button"
                      onClick={() => void copyRange(number, startHex, endHex)}
                      aria-label={`Copy key range for puzzle ${number}`}
                      title={`Copy range for puzzle ${number}`}
                      data-testid={`button-copy-puzzle-${number}`}
                    >
                      {copiedPuzzle === number ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {puzzles.length === 0 && (
            <p className="puzzle-ref-empty">No puzzles match that search.</p>
          )}
        </div>
        <p className="puzzle-ref-note" role="status" aria-live="polite">
          {copyError
            ? 'Clipboard access is unavailable in this browser.'
            : copiedPuzzle
              ? `Puzzle ${copiedPuzzle} range copied.`
              : 'Key ranges are calculated locally from each puzzle number.'}
        </p>
      </section>
      <footer className="donation-page-footer">
        <DonationAddress />
      </footer>
    </main>
  );
}
