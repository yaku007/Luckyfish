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
  
  // مصفوفة باش نخزنو عدة Workers
  const workersRef = useRef<Worker[]>([]);
  const hdControllerRef = useRef<AbortController | null>(null);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    
    if (searching) {
      if (mode === 'hd') {
        hdControllerRef.current?.abort();
      } else {
        // وقف جميع الـ Workers
        workersRef.current.forEach(w => w.terminate());
        workersRef.current = [];
        setSearching(false);
        setStatus('Search stopped');
      }
      return;
    }

    if (mode === 'hd') {
      // ... (نفس كود HD اللي عندك)
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

    // ========================================================================
    // Private Key Range (Brute Force) - Multi-Thread Mode 🚀
    // ========================================================================
    setSearching(true);
    setStatus('Searching with multiple threads...');
    setError('');
    setMatch(null);
    setProgress(null);

    try {
      const startBig = BigInt(`0x${startHex}`);
      const endBig = BigInt(`0x${endHex}`);
      const totalKeys = endBig - startBig + 1n;

      if (totalKeys <= 0n) {
        throw new Error("End key must be greater than start key");
      }

      // عدد الـ Threads (خدينا 4 أو 8 على حساب الجهاز)
      const numThreads = Math.min(8, Math.max(4, navigator.hardwareConcurrency || 4));
      const chunkSize = totalKeys / BigInt(numThreads);
      
      let totalSpeed = 0;
      const speedMap = new Map<Worker, number>();

      for (let i = 0; i < numThreads; i++) {
        const chunkStart = startBig + BigInt(i) * chunkSize;
        let chunkEnd = chunkStart + chunkSize - 1n;
        
        // آخر Thread كياخد الباقي كامل
        if (i === numThreads - 1) chunkEnd = endBig;

        const worker = new Worker(new URL('../lib/finder.worker.ts', import.meta.url), { type: 'module' });
        workersRef.current.push(worker);
        speedMap.set(worker, 0);

        worker.onmessage = (event) => {
          const message = event.data;
          
          if (message.type === 'progress') {
            speedMap.set(worker, message.keysPerSecond);
            // نجمعو سرعة جميع الـ Workers باش نعرضوها فـ الشاشة
            totalSpeed = Array.from(speedMap.values()).reduce((a, b) => a + b, 0);
            
            setProgress({ 
              index: message.index, 
              address: message.address, 
              keysPerSecond: totalSpeed 
            });
          } else if (message.type === 'found') {
            setMatch(message.result);
            setStatus('Match found!');
            setSearching(false);
            // وقف جميع الـ Workers حيت لقينا المفتاح
            workersRef.current.forEach(w => w.terminate());
            workersRef.current = [];
          } else if (message.type === 'exhausted') {
            // نتأكدو واش كاملين سالو
            const stillRunning = workersRef.current.filter(w => w !== worker && w.onmessage !== null);
            if (stillRunning.length === 0) {
              setStatus('Search complete — no match found');
              setSearching(false);
              workersRef.current.forEach(w => w.terminate());
              workersRef.current = [];
            }
          } else if (message.type === 'error') {
            setError(message.message);
            setStatus('Search could not start');
            setSearching(false);
            workersRef.current.forEach(w => w.terminate());
            workersRef.current = [];
          }
        };

        worker.postMessage({
          startHex: chunkStart.toString(16),
          endHex: chunkEnd.toString(16),
          targetAddress,
          chain, 
        });
      }

    } catch (err: any) {
      setError(err.message || 'Invalid keys');
      setSearching(false);
    }
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
             // ... (نفس كود الـ HD inputs اللي عندك)
             <></>
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
             // ... (نفس كود عرض HD match)
             <></>
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
