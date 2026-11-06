import { useRef, useState, type FormEvent } from 'react';
import { MULTI_CHAIN_OPTIONS, type MultiChainName } from '@/lib/multichain';
import './finder.css';

export default function FinderPage() {
  const [startHex, setStartHex] = useState('1');
  const [endHex, setEndHex] = useState('FFFFF');
  const [targetAddress, setTargetAddress] = useState('');
  const [chain, setChain] = useState<MultiChainName>('btc');
  const [status, setStatus] = useState('Ready');
  const [progress, setProgress] = useState<{ index: string; address: string; keysPerSecond: number } | null>(null);
  const [match, setMatch] = useState<any>(null);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const workerRef = useRef<Worker | null>(null);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (searching) {
      workerRef.current?.terminate();
      setSearching(false);
      setStatus('Search stopped');
      return;
    }

    setSearching(true);
    setStatus('Searching with high performance...');
    setError('');
    setMatch(null);
    setProgress(null);

    const worker = new Worker(new URL('../lib/finder.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'progress') {
        setProgress({ 
          index: message.attempts?.toString() || '0', 
          address: message.currentKeyHex || '', 
          keysPerSecond: message.speed || 0 
        });
      } else if (message.type === 'found') {
        setMatch(message.result);
        setStatus('Match found!');
        setSearching(false);
        worker.terminate();
      } else if (message.type === 'exhausted' || message.type === 'stopped') {
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

    // ⚡ BATCH_SIZE كبيير و ارسال الـ Worker للبحث السريع
    worker.postMessage({
      startHex,
      endHex,
      targetAddresses: [targetAddress], // دعم الـ target list / address
      chain,
      batchSize: 20000, // رفع السرعة القصوى (Keys/Second)
    });
  }

  return (
    <main className="page-wrap finder-page">
      <section className="intro">
        <div className="eyebrow">
          MULTICHAIN ADDRESS FINDER (HIGH PERFORMANCE)
        </div>
        <h1>Find Private Key by Address</h1>
        <p className="intro-copy">
          Search a specific range of private keys with maximum speed (Keys/Second) to find the matching address.
        </p>
      </section>

      <section className="panel finder-panel" aria-label="Address finder">
        <form className="finder-form" onSubmit={handleSearch}>
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

          <button className="primary-button" type="submit">
            {searching ? 'Stop search' : 'Start High-Speed Search'}
          </button>
        </form>

        <div className="finder-status" role="status" aria-live="polite">
          <strong>{status}</strong>
          {progress && searching && (
            <span>
              Checked: {progress.index} keys · <strong>{progress.keysPerSecond.toLocaleString()} keys/sec</strong>
            </span>
          )}
          {error && <p className="finder-error">{error}</p>}
        </div>

        {match && (
          <div className="finder-match">
            <div className="section-kicker">Match found</div>
            <p><strong>Chain:</strong> {MULTI_CHAIN_OPTIONS.find((option) => option.id === chain)?.label}</p>
            <p><strong>Address:</strong> {match.address}</p>
            <p><strong>Private Key (Hex):</strong> {match.privateKeyHex}</p>
            {chain === 'btc' && match.privateKeyWif && <p><strong>Private Key (WIF):</strong> {match.privateKeyWif}</p>}
          </div>
        )}
      </section>
    </main>
  );
      }
