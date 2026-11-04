import { useEffect, useState } from 'react';
import { Bitcoin, Search } from 'lucide-react';
import { Link } from 'wouter';
import DonationAddress from '@/components/donation-address';
import puzzleAddresses from '@/lib/bitcoin-puzzle-addresses.json';
import { getBitcoinPuzzleRange } from '@/lib/bitcoin-puzzle';
import './bitcoin-puzzle-address-lookup.css';

const PUZZLE_BY_ADDRESS = new Map(
  puzzleAddresses.map(({ number, address }) => [address, number]),
);

export default function BitcoinPuzzleAddressLookupPage({
  active,
}: {
  active: boolean;
}) {
  const [address, setAddress] = useState('');

  useEffect(() => {
    if (active) document.title = 'Find Puzzle Range by Address | LUCKY BTC';
  }, [active]);

  const normalizedAddress = address.trim();
  const puzzleNumber = PUZZLE_BY_ADDRESS.get(normalizedAddress);
  const range = puzzleNumber ? getBitcoinPuzzleRange(puzzleNumber) : null;

  return (
    <main className="puzzle-address-page" data-testid="page-puzzle-address-lookup">
      <section className="puzzle-address-intro" aria-labelledby="puzzle-address-title">
        <div className="puzzle-address-kicker">
          <Bitcoin aria-hidden="true" />
          Published puzzle index
        </div>
        <h1 id="puzzle-address-title">Find a Puzzle Range by Address</h1>
        <p>
          Look up an address from the published Bitcoin Puzzle challenge list to
          see its puzzle number and private-key range.
        </p>
      </section>

      <section className="puzzle-address-panel" aria-labelledby="puzzle-address-search-title">
        <p className="puzzle-address-label">ADDRESS LOOKUP</p>
        <h2 id="puzzle-address-search-title">Search puzzle addresses</h2>
        <label className="puzzle-address-field" htmlFor="puzzle-address-input">
          <span>Bitcoin puzzle address</span>
          <span className="puzzle-address-input-wrap">
            <Search aria-hidden="true" />
            <input
              id="puzzle-address-input"
              type="search"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="Paste a published puzzle address"
              autoComplete="off"
              spellCheck={false}
              data-testid="input-puzzle-address"
            />
          </span>
        </label>

        {normalizedAddress && range && puzzleNumber ? (
          <div className="puzzle-address-result" role="status" data-testid="puzzle-address-result">
            <p className="puzzle-address-result-label">MATCH FOUND</p>
            <h3>Puzzle #{puzzleNumber}</h3>
            <p>Published private-key range (hex)</p>
            <div className="puzzle-address-range">
              <code>{range.startHex}</code>
              <span aria-hidden="true"> - </span>
              <code>{range.endHex}</code>
            </div>
          </div>
        ) : normalizedAddress ? (
          <p className="puzzle-address-status" role="status" data-testid="puzzle-address-no-match">
            No exact match in the published Puzzle #1–{puzzleAddresses.length} address list.
            Bitcoin addresses are case-sensitive.
          </p>
        ) : (
          <p className="puzzle-address-status" role="status">
            Enter an address to check it against the published puzzle list.
          </p>
        )}

        <p className="puzzle-address-note">
          This is a local lookup of the published puzzle addresses only. It does
          not search for private keys or determine a range for arbitrary
          addresses. The address list is sourced from the{' '}
          <a
            href="https://mempool.space/tx/08389f34c98c606322740c0be6a7125d9860bb8d5cb182c02f98461e5fa6cd15"
            target="_blank"
            rel="noreferrer"
          >
            original puzzle funding transaction
          </a>
          .
        </p>
        <Link className="puzzle-address-back-link" href="/bitcoin-puzzle">
          Browse all puzzle ranges
        </Link>
      </section>

      <footer className="donation-page-footer">
        <DonationAddress />
      </footer>
    </main>
  );
}
