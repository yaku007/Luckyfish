import { useRef, useState, type FormEvent } from 'react';
import { findHdAddressByXpub } from '@/lib/hd-address-finder';
import { MULTI_CHAIN_OPTIONS, type MultiChainName } from '@/lib/multichain';
import './finder.css';

export default function FinderPage() {
  const [mode, setMode] = useState<'range' | 'hd'>('range');
  const [startHex, setStartHex] = useState('1');
  const [endHex, setEndHex] = useState('FFFFF');
  const [xpub, setXpub] = useState('');
  const [chain, setChain] = useState<MultiChainName>('btc');
  const [startIndex, setStartIndex] = useState('0');
  const [endIndex, setEndIndex] = useState('1000');
  const [targetAddress, setTargetAddress] = useState('');
  const [status, setStatus] = useState('Ready');
  const [progress, setProgress] = useState<{ index: string; address: string; keysPerSecond: number } | null>(null);
  const [match, setMatch] = useState<any>(null);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const hdControllerRef = useRef<AbortController | null>(null);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (searching) {
      if (mode === 'hd') {
        hdControllerRef.current?.abort();
      } else {
        workerRef.current?.terminate();
        setSearching(false);
        setStatus('Search stopped');
      }
      return;
    }

    if (mode === 'hd') {
      const firstIndex = Number(startIndex);
      const lastIndex = Number(endIndex);
      if (!/^\d+$/.test(startIndex) || !/^\d+$/.test(endIndex)) {
        setError('Enter whole-number HD indexes.');
        return;
      }
      if (!Number.isSafeInteger(firstIndex) || !Number.isSafeInteger(lastIndex) || lastIndex < firstIndex) {
        setError('Enter a valid HD index range.');
        return;
      }
      if (lastIndex - firstIndex > 100_000) {
        setError('Search ranges are limited to 100,001 addresses per run.');
        return;
      }

      setSearching(true);
      setStatus('Searching HD indexes...');
      setError('');
      setMatch(null);
      setProgress(null);
      const controller = new AbortController();
      hdControllerRef.current = controller;

      void findHdAddressByXpub({
        xpub,
        startIndex: firstIndex,
        endIndex: lastIndex,
        targetAddress,
        chain,
        signal: controller.signal,
        onProgress: (item) => setProgress({
          index: String(item.index),
          address: item.address,
          keysPerSecond: item.keysPerSecond,
        }),
      }).then((result) => {
        setMatch(result);
        setStatus(result ? 'HD address match found!' : 'Search complete — no match found');
      }).catch((searchError: unknown) => {
        if (controller.signal.aborted) {
          setStatus('Search stopped');
        } else {
          setError(searchError instanceof Error ? searchError.message : 'HD search failed.');
          setStatus('Search could not start');
        }
      }).finally(() => {
        if (hdControllerRef.current === controller) hdControllerRef.current = null;
        setSearching(false);
      });
      return;
    }

    setSearching(true);
    setStatus('Searching...');
    setError('');
    setMatch(null);
    setProgress(null);

    const worker = new Worker(new URL('../lib/finder.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'progress') {
        setProgress({ index: message.index, address: message.address, keysPerSecond: message.keysPerSecond });
      } else if (message.type === 'found') {
        setMatch(message.result);
        setStatus('Match found!');
        setSearching(false);
        worker.terminate();
      } else if (message.type === 'exhausted') {
        setStatus('Search complete — no match found');
        setSearching(false);
        worker.terminate();
      } else if (message.type === 'error') {
        setError(message.message);
        setStatus('Search could not start');
        setSearching(false);
        worker.terminate();
      }
    };

    // هنا زدنا chain باش الـ Worker يعرف فين يقلب
    worker.postMessage({
      startHex,
      endHex,
      targetAddress,
      chain, 
    });
  }

  return (
    <main className="page-wrap finder-page">
      <section className="intro">
        <div className="eyebrow">
          {mode === 'hd' ? 'MULTICHAIN HD ADDRESS FINDER' : 'MULTICHAIN ADDRESS FINDER (BRUTE FORCE)'}
        </div>
        <h1>{mode === 'hd' ? 'HD Address Finder' : 'Find Private Key by Address'}</h1>
        <p className="intro-copy">
          {mode === 'hd'
            ? 'Match a public address against indexes derived from an account xpub.'
            : 'Search a specific range of private keys to find the matching address.'}
        </p>
      </section>

      <section className="panel finder-panel" aria-label="Address finder">
        <form className="finder-form" onSubmit={handleSearch}>
          <label className="finder-field">
            <span>Finder mode</span>
            <select
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as 'range' | 'hd');
                setSearching(false);
                setStatus('Ready');
                setError('');
                setMatch(null);
                setProgress(null);
              }}
              disabled={searching}
            >
              <option value="range">Private-key range (Brute Force)</option>
              <option value="hd">HD address lookup (xpub)</option>
            </select>
          </label>

          {mode === 'hd' ? (
            <>
              <label className="finder-field">
                <span>Account extended public key (xpub)</span>
                <input
                  autoComplete="off"
                  spellCheck={false}
                  value={xpub}
                  onChange={(event) => setXpub(event.target.value.trim())}
                  placeholder="xpub..."
                  disabled={searching}
                  required
                />
              </label>
              <div className="finder-index-row">
                <label className="finder-field">
                  <span>Chain</span>
                  <select value={chain} onChange={(event) => setChain(event.target.value as MultiChainName)} disabled={searching}>
                    {MULTI_CHAIN_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="finder-field">
                  <span>Address to match</span>
                  <input
                    autoComplete="off"
                    spellCheck={false}
                    value={targetAddress}
                    onChange={(event) => setTargetAddress(event.target.value)}
                    placeholder={chain === 'btc' ? 'Legacy address (1...)' : '0x...'}
                    disabled={searching}
                    required
                  />
                </label>
              </div>
              <div className="finder-index-row">
                <label className="finder-field">
                  <span>Start index</span>
                  <input type="number" min="0" max="2147483647" value={startIndex} onChange={(event) => setStartIndex(event.target.value)} disabled={searching} required />
                </label>
                <label className="finder-field">
                  <span>End index</span>
                  <input type="number" min="0" max="2147483647" value={endIndex} onChange={(event) => setEndIndex(event.target.value)} disabled={searching} required />
                </label>
              </div>
            </>
          ) : (
            <>
              <div className="finder-index-row">
                <label className="finder-field">
                  <span>Chain</span>
                  <select value={chain} onChange={(event) => setChain(event.target.value as MultiChainName)} disabled={searching}>
                    {MULTI_CHAIN_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="finder-field">
                  <span>Address to find</span>
                  <input
                    autoComplete="off"
                    spellCheck={false}
                    value={targetAddress}
                    onChange={(event) => setTargetAddress(event.target.value)}
                    placeholder={chain === 'btc' ? '1... or bc1q...' : '0x...'}
                    disabled={searching}
                    required
                  />
                </label>
              </div>

              <div className="finder-index-row">
                <label className="finder-field">
                  <span>Start Key (Hex)</span>
                  <input type="text" value={startHex} onChange={(e) => setStartHex(e.target.value)} disabled={searching} required />
                </label>
                <label className="finder-field">
                  <span>End Key (Hex)</span>
                  <input type="text" value={endHex} onChange={(e) => setEndHex(e.target.value)} disabled={searching} required />
                </label>
              </div>
            </>
          )}

          <button className="primary-button" type="submit">
            {searching ? 'Stop search' : 'Start Search'}
          </button>
        </form>

        <div className="finder-status" role="status" aria-live="polite">
          <strong>{status}</strong>
          {progress && searching && (
            <span>
              {mode === 'hd' ? 'Index' : 'Key'}: {progress.index} · {progress.keysPerSecond.toLocaleString()} keys/sec
            </span>
          )}
          {error && <p className="finder-error">{error}</p>}
        </div>

        {match && (
          mode === 'hd' ? (
            <div className="finder-match">
              <div className="section-kicker">HD address match</div>
              <p><strong>Chain:</strong> {MULTI_CHAIN_OPTIONS.find((option) => option.id === chain)?.label}</p>
              <p><strong>Index:</strong> {match.index}</p>
              <p><strong>Address:</strong> {match.address}</p>
            </div>
          ) : (
            <div className="finder-match">
              <div className="section-kicker">Match found</div>
              <p><strong>Chain:</strong> {MULTI_CHAIN_OPTIONS.find((option) => option.id === chain)?.label}</p>
              <p><strong>Address:</strong> {match.address}</p>
              <p><strong>Private Key (Hex):</strong> {match.privateKeyHex}</p>
              {chain === 'btc' && <p><strong>Private Key (WIF):</strong> {match.privateKeyWif}</p>}
            </div>
          )
        )}
      </section>
    </main>
  );
    }
