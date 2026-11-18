import { useRef, useState, type FormEvent } from 'react';
import { Zap, Sparkles } from 'lucide-react';
import { MULTI_CHAIN_OPTIONS, type MultiChainName } from '@/lib/multichain';
import './bitcoin-range-lookup.css';

export default function BitcoinPuzzlePage() {
  const [startHex, setStartHex] = useState('1');
  const [endHex, setEndHex] = useState('100000');
  const [chain, setChain] = useState<MultiChainName>('btc');
  const [numThreads, setNumThreads] = useState<number>(4);
  const [autoBlock, setAutoBlock] = useState<boolean>(true); // 🛠️ خيار البلوكات الأوتوماتيكية
  
  const [status, setStatus] = useState('Ready');
  const [keysPerSec, setKeysPerSec] = useState(0);
  const [currentKey, setCurrentKey] = useState('');
  const [currentBlock, setCurrentBlock] = useState('');
  const [match, setMatch] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const [searching, setSearching] = useState(false);

  const workersRef = useRef<Worker[]>([]);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    
    if (searching) {
      workersRef.current.forEach(w => {
        w.postMessage({ type: 'stop' });
        w.terminate();
      });
      workersRef.current = [];
      setSearching(false);
      setStatus('Stopped');
      setNotice('Search stopped by user.');
      return;
    }

    setSearching(true);
    setStatus('Running');
    setMatch(null);
    setKeysPerSec(0);
    setCurrentKey(startHex);
    setCurrentBlock(`Block: ${startHex} → ${endHex}`);
    setNotice('Fetching addresses from DB...');

    try {
      const startBig = BigInt(`0x${startHex.trim().replace(/^0x/i, '')}`);
      const endBig = BigInt(`0x${endHex.trim().replace(/^0x/i, '')}`);
      const totalKeys = endBig - startBig + 1n;

      if (totalKeys <= 0n) throw new Error("End must be >= Start");

      const chunkSize = totalKeys / BigInt(numThreads);
      
      let totalSpeed = 0;
      let finishedWorkers = 0;
      const speedMap = new Map<Worker, number>();

      for (let i = 0; i < numThreads; i++) {
        const chunkStart = startBig + BigInt(i) * chunkSize;
        let chunkEnd = chunkStart + chunkSize - 1n;
        if (i === numThreads - 1) chunkEnd = endBig;

        const worker = new Worker(new URL('../lib/keyhunter.worker.ts', import.meta.url), { type: 'module' });
        workersRef.current.push(worker);
        speedMap.set(worker, 0);

        worker.onmessage = (event) => {
          const message = event.data;

          if (message.type === 'progress') {
            speedMap.set(worker, message.speed);
            totalSpeed = Array.from(speedMap.values()).reduce((a, b) => a + b, 0);
            setKeysPerSec(totalSpeed);
            setCurrentKey(message.currentKeyHex);
            setNotice('Scanning Database...');
          } else if (message.type === 'block_done') {
            setCurrentBlock(`Block: ${message.blockStart} → ${message.blockEnd}`);
          } else if (message.type === 'found') {
            setMatch(message.result);
            setStatus('Found');
            setSearching(false);
            setNotice(`🎯 Match found: ${message.result.address}`);
            workersRef.current.forEach(w => w.terminate());
            workersRef.current = [];
          } else if (message.type === 'exhausted') {
            finishedWorkers++;
            if (finishedWorkers === numThreads) {
              setStatus('Exhausted');
              setSearching(false);
              setNotice('Range fully scanned. No match found in database.');
              workersRef.current.forEach(w => w.terminate());
              workersRef.current = [];
            }
          } else if (message.type === 'error') {
            setStatus('Error');
            setSearching(false);
            setNotice(message.message || 'Worker error.');
            workersRef.current.forEach(w => w.terminate());
            workersRef.current = [];
          }
        };

        worker.postMessage({
          type: 'scan',
          startHex: chunkStart.toString(16),
          endHex: chunkEnd.toString(16),
          chain,
          autoBlock, // 🛠️ كنصيفطو الخيار للـ Worker
        });
      }
    } catch (err: any) {
      setStatus('Error');
      setSearching(false);
      setNotice(err.message || 'Invalid range.');
    }
  }

  return (
    <main className="range-lookup-page" data-testid="page-bitcoin-puzzle">
      <header className="range-lookup-intro">
        <div className="range-lookup-kicker"><Zap aria-hidden="true" /> Database Engine Scanner</div>
        <h1>Bitcoin Puzzle Database Hunter</h1>
        <p>Search ranges directly against the live database of funded addresses.</p>
      </header>

      <section className="range-lookup-panel">
        <p className="range-lookup-label">CONFIG</p>
        <h2>Scan Parameters</h2>

        <form onSubmit={handleSearch}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '10px', marginTop: '10px' }}>
            <div className="range-lookup-field" style={{ marginTop: 0 }}>
              <span>Network</span>
              <select
                className="select-control"
                value={chain}
                onChange={(e) => setChain(e.target.value as MultiChainName)}
                disabled={searching}
                style={{ width: '100%', minHeight: '42px', padding: '0 10px', background: 'hsl(var(--background))', color: 'hsl(var(--foreground))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }}
              >
                {MULTI_CHAIN_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.label} ({opt.symbol})</option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '10px' }}>
            <div className="range-lookup-field" style={{ marginTop: 0 }}>
              <span>Start Hex</span>
              <input
                type="text"
                value={startHex}
                onChange={(e) => setStartHex(e.target.value)}
                disabled={searching}
                required
                style={{ width: '100%', minHeight: '42px', padding: '0 10px', background: 'hsl(var(--background))', color: 'hsl(var(--foreground))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }}
              />
            </div>
            <div className="range-lookup-field" style={{ marginTop: 0 }}>
              <span>End Hex</span>
              <input
                type="text"
                value={endHex}
                onChange={(e) => setEndHex(e.target.value)}
                disabled={searching}
                required
                style={{ width: '100%', minHeight: '42px', padding: '0 10px', background: 'hsl(var(--background))', color: 'hsl(var(--foreground))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }}
              />
            </div>
          </div>

          <div style={{ marginTop: '15px' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <span style={{ fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>CPU Threads (Workers)</span>
              <input
                type="range"
                min="1"
                max="8"
                step="1"
                value={numThreads}
                onChange={(e) => setNumThreads(Number(e.target.value))}
                disabled={searching}
                style={{ width: '100%', cursor: 'pointer' }}
              />
              <span style={{ textAlign: 'center', fontWeight: 'bold', color: '#ffbd72' }}>{numThreads} Threads</span>
            </label>
          </div>

          {/* 🛠️ خيار البلوكات الأوتوماتيكية */}
          <div style={{ marginTop: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="checkbox"
              id="autoBlock"
              checked={autoBlock}
              onChange={(e) => setAutoBlock(e.target.checked)}
              disabled={searching}
            />
            <label htmlFor="autoBlock" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', cursor: 'pointer' }}>
              Automatically generate the next same-size block when this block finishes.
            </label>
          </div>

          <div style={{ marginTop: '15px' }}>
            <button
              type="submit"
              className="range-lookup-search"
              style={{ width: '100%', padding: '12px', background: searching ? '#b23d32' : '#e77732', color: '#fff', border: 0, borderRadius: '8px', fontWeight: 700, cursor: 'pointer' }}
            >
              {searching ? 'Stop Scan' : 'Start Database Scan'}
            </button>
          </div>
        </form>

        {notice && <p style={{ marginTop: '10px', fontSize: '12px', color: '#ffbd72' }}>{notice}</p>}
      </section>

      <section style={{ marginTop: '20px', padding: '16px', background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontFamily: 'monospace' }}>
        <div style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', marginBottom: '6px' }}>LIVE TELEMETRY: {status.toUpperCase()}</div>
        {searching ? (
          <div style={{ fontSize: '13px', color: '#ffbd72' }}>
            Scanning Database...<br />
            <span style={{ display: 'block', wordBreak: 'break-all', marginTop: '4px', color: 'hsl(var(--foreground))' }}>
              Key: {currentKey}
            </span>
            {currentBlock && (
              <span style={{ display: 'block', marginTop: '4px', color: 'hsl(var(--muted-foreground))', fontSize: '11px' }}>
                {currentBlock}
              </span>
            )}
            <span style={{ display: 'block', marginTop: '4px', fontWeight: 'bold' }}>
              Speed: {keysPerSec.toLocaleString()} keys/sec
            </span>
          </div>
        ) : (
          <div style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>{status === 'Ready' ? 'Idle. Ready to scan.' : `Completed with status: ${status}`}</div>
        )}
      </section>

      {match && (
        <div style={{ marginTop: '20px', padding: '16px', background: 'hsl(var(--background))', border: '2px solid #e77732', borderRadius: '10px' }}>
          <div style={{ color: '#ffbd72', fontWeight: 700, marginBottom: '8px' }}><Sparkles size={14} style={{ display: 'inline', marginRight: 4 }} /> MATCH FOUND!</div>
          
          <div style={{ fontSize: '12px', marginBottom: '6px' }}>
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>Address:</span>
            <code style={{ display: 'block', color: 'hsl(var(--foreground))', wordBreak: 'break-all' }}>{match.address}</code>
          </div>

          <div style={{ fontSize: '12px', marginTop: '8px' }}>
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>Private Key (Hex):</span>
            <code style={{ display: 'block', wordBreak: 'break-all', color: 'hsl(var(--foreground))', marginTop: '2px' }}>{match.privateKeyHex}</code>
          </div>

          {match.privateKeyWif && (
            <div style={{ fontSize: '12px', marginTop: '8px' }}>
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>Private Key (WIF):</span>
              <code style={{ display: 'block', wordBreak: 'break-all', color: 'hsl(var(--foreground))', marginTop: '2px' }}>{match.privateKeyWif}</code>
            </div>
          )}
        </div>
      )}
    </main>
  );
              }
