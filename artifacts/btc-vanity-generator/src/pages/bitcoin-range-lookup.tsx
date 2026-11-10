import { useRef, useState, useEffect, type FormEvent } from 'react';
import { AlertCircle, Zap, Eye, Copy, Sparkles, CircleAlert } from 'lucide-react';
import DonationAddress from '@/components/donation-address';
import { MULTI_CHAIN_OPTIONS, type MultiChainName } from '@/lib/multichain';
import { saveSearchProgress, getSearchProgress } from '@/lib/persistence';
import './bitcoin-range-lookup.css';

export default function BitcoinRangeLookupPage({ active }: { active: boolean }) {
  const [startHex, setStartHex] = useState('0000000000000000000000000000000000000000000000000000000000000001');
  const [endHex, setEndHex] = useState('000000000000000000000000000000000000000000000000000000000000ffff');
  const [chain, setChain] = useState<MultiChainName>('btc');
  const [targetAddress, setTargetAddress] = useState('');
  
  const [engine, setEngine] = useState<'cpu' | 'webgl' | 'webgpu'>('cpu');
  const [savedCursor, setSavedCursor] = useState<string | null>(null);

  const [status, setStatus] = useState('Ready');
  const [attempts, setAttempts] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [keysPerSec, setKeysPerSec] = useState(0);
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [match, setMatch] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const [noticeIsError, setNoticeIsError] = useState(false);
  const [searching, setSearching] = useState(false);
  const [showPrivateKey, setShowPrivateKey] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const startTimeRef = useRef<number>(0);
  const lastUpdateRef = useRef<number>(0);

  useEffect(() => {
    if (active) document.title = 'High-Speed Range Brute-Force | LUCKY BTC';
  }, [active]);

  useEffect(() => {
    void getSearchProgress('range_lookup_state').then((data) => {
      if (data && data.cursor) {
        setSavedCursor(data.cursor);
        if (data.targetAddress) setTargetAddress(data.targetAddress);
        if (data.chain) setChain(data.chain);
      }
    });
  }, []);

  const copyValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice('Copied to clipboard!');
      setNoticeIsError(false);
    } catch {
      setNotice('Clipboard access failed.');
      setNoticeIsError(true);
    }
  };

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (searching) {
      workerRef.current?.postMessage({ type: 'stop' });
      workerRef.current?.terminate();
      setSearching(false);
      setStatus('Stopped');
      setNotice('Range brute-force stopped by user.');
      setNoticeIsError(false);
      return;
    }

    setSearching(true);
    setStatus('Running');
    setNotice('');
    setMatch(null);
    setAttempts(0);
    setElapsedMs(0);
    setKeysPerSec(0);
    setProgressPercent(0);
    startTimeRef.current = performance.now();
    lastUpdateRef.current = performance.now();

    try {
      const worker = new Worker(new URL('../lib/vanity.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;

      worker.onmessage = (event) => {
        const message = event.data;
        const now = performance.now();

        // 🎯 تصحيح شرط الاستقبال: التمييز الدقيق بين الماتش والتحديث الدوري
        if (message.type === 'found') {
          const duration = Math.max(1, now - startTimeRef.current);
          setAttempts(message.attempts || 0);
          setElapsedMs(duration);
          setMatch(message.result);
          setStatus('Found');
          setSearching(false);
          setNotice('Target private key found successfully in range!');
          setNoticeIsError(false);
          worker.terminate();
        } else if (message.type === 'progress') {
          if (now - lastUpdateRef.current > 80) {
            const duration = Math.max(1, now - startTimeRef.current);
            const currentAttempts = message.attempts;
            const calculatedSpeed = Math.floor((currentAttempts / duration) * 1000);

            setAttempts(currentAttempts);
            setElapsedMs(duration);
            setKeysPerSec(message.keysPerSecond || calculatedSpeed);
            if (message.percent !== undefined) setProgressPercent(message.percent);

            void saveSearchProgress('range_lookup_state', {
              cursor: startHex,
              targetAddress,
              chain,
              timestamp: Date.now()
            });
            lastUpdateRef.current = now;
          }
        } else if (message.type === 'exhausted') {
          setStatus('Exhausted');
          setSearching(false);
          setNotice('The entire specified private key range was scanned; no match found.');
          setNoticeIsError(false);
          worker.terminate();
        } else if (message.type === 'error') {
          setStatus('Error');
          setSearching(false);
          setNotice(message.message || 'Worker execution error.');
          setNoticeIsError(true);
          worker.terminate();
        }
      };

      worker.onerror = () => {
        setStatus('Error');
        setSearching(false);
        setNotice('Critical worker error occurred.');
        setNoticeIsError(true);
        worker.terminate();
      };

      worker.postMessage({
        type: 'start',
        mode: 'range',
        startHex: startHex.trim().replace(/^0x/i, ''),
        endHex: endHex.trim().replace(/^0x/i, ''),
        targetAddress: targetAddress.trim() || undefined,
        chain,
        engine,
        workerCount: typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 8) : 8,
      });
    } catch {
      setStatus('Error');
      setSearching(false);
      setNotice('Could not initialize hardware compute worker.');
      setNoticeIsError(true);
    }
  }

  function handleResume() {
    if (savedCursor) {
      setStartHex(savedCursor);
      setStatus('Ready');
      setNotice('Resumed previous range cursor.');
      setNoticeIsError(false);
    }
  }

  const formatSpeed = (speed: number) => {
    if (speed >= 1_000_000) return `${(speed / 1_000_000).toFixed(2)} M keys/sec`;
    if (speed >= 1_000) return `${(speed / 1_000).toFixed(1)} K keys/sec`;
    return `${speed.toLocaleString()} keys/sec`;
  };

  return (
    <main className="range-lookup-page" data-testid="page-bitcoin-range-lookup">
      <header className="range-lookup-intro">
        <div className="range-lookup-kicker"><Zap aria-hidden="true" /> Hardware-Accelerated Range Scanner</div>
        <h1>GPU Range Brute-Force (BitCrack / Kangaroo Engine)</h1>
        <p>Scan custom private-key ranges using parallel multi-threaded compute pipelines directly in your browser.</p>
      </header>

      {savedCursor && !searching && (
        <div style={{ background: '#24170e', border: '1px solid #65401f', padding: '12px 16px', borderRadius: '10px', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#f3c89c', fontSize: '12px' }}>Found previous range scanning session. Do you want to resume?</span>
          <button onClick={handleResume} style={{ background: '#f7931a', color: '#14100a', border: 0, padding: '6px 12px', borderRadius: '6px', fontWeight: 700, fontSize: '11px', cursor: 'pointer' }}>
            Resume State
          </button>
        </div>
      )}

      <section className="range-lookup-panel" aria-labelledby="range-lookup-title">
        <p className="range-lookup-label">BRUTE-FORCE CONFIGURATION</p>
        <h2 id="range-lookup-title">Configure range &amp; compute engine</h2>

        <form onSubmit={handleSearch}>
          <div className="range-lookup-field">
            <span>Compute Engine / Hardware Acceleration</span>
            <div className="select-wrap" style={{ position: 'relative' }}>
              <select
                className="select-control"
                value={engine}
                onChange={(e) => setEngine(e.target.value as 'cpu' | 'webgl' | 'webgpu')}
                disabled={searching}
                style={{ width: '100%', minHeight: '46px', padding: '0 13px', border: '1px solid hsl(var(--border))', borderRadius: '8px', background: 'hsl(var(--background))', color: 'hsl(var(--foreground))', fontFamily: 'var(--app-font-mono)', fontSize: '12px' }}
              >
                <option value="cpu">CPU (Multi-threaded Workers - Highly Stable)</option>
                <option value="webgpu">WebGPU (Ultra Fast GPU Pipeline)</option>
                <option value="webgl">WebGL (GPU Shaders)</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginTop: '15px' }}>
            <div className="range-lookup-field" style={{ marginTop: 0 }}>
              <span>Blockchain Network</span>
              <select
                className="select-control"
                value={chain}
                onChange={(e) => setChain(e.target.value as MultiChainName)}
                disabled={searching}
                style={{ width: '100%', minHeight: '46px', padding: '0 13px', border: '1px solid hsl(var(--border))', borderRadius: '8px', background: 'hsl(var(--background))', color: 'hsl(var(--foreground))', fontFamily: 'var(--app-font-mono)', fontSize: '12px' }}
              >
                {MULTI_CHAIN_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.label} ({opt.symbol})</option>
                ))}
              </select>
            </div>
            <div className="range-lookup-field" style={{ marginTop: 0 }}>
              <span>Target Address to Find (Optional)</span>
              <input
                type="text"
                value={targetAddress}
                onChange={(event) => setTargetAddress(event.target.value)}
                placeholder="Paste target address..."
                autoComplete="off"
                spellCheck={false}
                disabled={searching}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginTop: '15px' }}>
            <div className="range-lookup-field" style={{ marginTop: 0 }}>
              <span>Start Key (Hex)</span>
              <input
                type="text"
                value={startHex}
                onChange={(event) => setStartHex(event.target.value)}
                placeholder="1"
                autoComplete="off"
                spellCheck={false}
                disabled={searching}
                required
              />
            </div>
            <div className="range-lookup-field" style={{ marginTop: 0 }}>
              <span>End Key (Hex)</span>
              <input
                type="text"
                value={endHex}
                onChange={(event) => setEndHex(event.target.value)}
                placeholder="5000"
                autoComplete="off"
                spellCheck={false}
                disabled={searching}
                required
              />
            </div>
          </div>

          <div className="range-lookup-controls" style={{ marginTop: '20px' }}>
            <span className="range-lookup-scope">
              Executes full hardware-accelerated private key derivation and target matching in parallel threads.
            </span>
            <button
              className="range-lookup-search"
              type="submit"
              data-testid="button-search-address-range"
              style={{ background: searching ? '#b23d32' : '#e77732' }}
            >
              {searching ? <CircleAlert aria-hidden="true" /> : <Zap aria-hidden="true" />}
              {searching ? 'Stop Scan' : 'Start GPU Scan'}
            </button>
          </div>
        </form>

        {notice && (
          <p
            className={`range-lookup-notice${noticeIsError ? ' is-error' : ''}`}
            role={noticeIsError ? 'alert' : 'status'}
            data-testid="status-range-lookup"
          >
            {noticeIsError && <AlertCircle aria-hidden="true" />}
            {notice}
          </p>
        )}
      </section>

      {/* 📊 Live Telemetry & Performance Dashboard */}
      <section className="range-lookup-results" aria-labelledby="range-lookup-results-title" style={{ marginTop: '20px' }}>
        <div className="range-lookup-results-heading">
          <div>
            <p className="range-lookup-label">LIVE TELEMETRY</p>
            <h2 id="range-lookup-results-title">Performance &amp; Scan Status</h2>
          </div>
          <span>{status.toUpperCase()}</span>
        </div>

        <div className="metrics-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '10px', marginBottom: '15px' }}>
          <div className="address-box" style={{ padding: '12px', background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}>
            <span className="range-lookup-label">Status</span>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'hsl(var(--foreground))', marginTop: '4px' }}>{status}</div>
          </div>
          <div className="address-box" style={{ padding: '12px', background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}>
            <span className="range-lookup-label">Attempts</span>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'hsl(var(--foreground))', marginTop: '4px' }}>{attempts.toLocaleString()}</div>
          </div>
          <div className="address-box" style={{ padding: '12px', background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }}>
            <span className="range-lookup-label">Elapsed Time</span>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'hsl(var(--foreground))', marginTop: '4px' }}>{(elapsedMs / 1000).toFixed(1)}s</div>
          </div>
          <div className="address-box" style={{ padding: '12px', background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', borderRadius: '8px', borderColor: keysPerSec > 1_000_000 ? '#f7931a' : undefined }}>
            <span className="range-lookup-label" style={{ color: keysPerSec > 1_000_000 ? '#ffbd72' : undefined }}>Speed</span>
            <div style={{ fontSize: '13px', fontWeight: 800, color: keysPerSec > 1_000_000 ? '#ffbd72' : 'hsl(var(--foreground))', marginTop: '4px' }}>
              {formatSpeed(keysPerSec)}
            </div>
          </div>
        </div>

        {progressPercent !== null && (
          <div style={{ marginBottom: '15px' }}>
            <div className="progress-track" style={{ height: '6px', background: 'hsl(var(--border))', borderRadius: '99px', overflow: 'hidden' }}>
              <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%`, height: '100%', background: '#e77732', transition: 'width 0.3s' }} />
            </div>
          </div>
        )}

        {match && (
          <div className="match-result-card" style={{ padding: '16px', background: 'hsl(var(--background))', border: '1px solid #e77732', borderRadius: '8px', marginTop: '15px' }}>
            <div className="range-lookup-label" style={{ color: '#ffbd72' }}><Sparkles size={14} style={{ display: 'inline', marginRight: 4 }} /> MATCH FOUND!</div>
            
            <div style={{ marginTop: '8px' }}>
              <span className="range-lookup-label">Matched Address:</span>
              <code style={{ display: 'block', color: 'hsl(var(--foreground))', wordBreak: 'break-all', marginTop: '2px' }}>{match.address}</code>
            </div>

            <div style={{ marginTop: '10px' }}>
              <span className="range-lookup-label">Discovered in Range:</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '4px', background: 'hsl(var(--card))', padding: '8px', borderRadius: '6px', border: '1px solid hsl(var(--border))' }}>
                <div>
                  <span style={{ fontSize: '10px', color: 'hsl(var(--muted-foreground))', display: 'block' }}>Range Start:</span>
                  <code style={{ fontSize: '11px', color: '#ffbd72', wordBreak: 'break-all' }}>{match.rangeStartHex || startHex}</code>
                </div>
                <div>
                  <span style={{ fontSize: '10px', color: 'hsl(var(--muted-foreground))', display: 'block' }}>Range End:</span>
                  <code style={{ fontSize: '11px', color: '#ffbd72', wordBreak: 'break-all' }}>{match.rangeEndHex || endHex}</code>
                </div>
              </div>
            </div>

            <div style={{ marginTop: '10px' }}>
              <span className="range-lookup-label">Private Key (Hex):</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                <code style={{ color: 'hsl(var(--foreground))', wordBreak: 'break-all' }}>{showPrivateKey ? (match.privateKeyHex || match.privateKey) : '••••••••••••••••••••••••••••••••••••'}</code>
                <button className="range-lookup-search" type="button" onClick={() => setShowPrivateKey(!showPrivateKey)} style={{ padding: '4px 8px', minHeight: '30px', fontSize: '11px' }}>
                  <Eye size={12} /> {showPrivateKey ? 'Hide' : 'Reveal'}
                </button>
                {showPrivateKey && (
                  <button className="range-lookup-search" type="button" onClick={() => copyValue(match.privateKeyHex || match.privateKey)} style={{ padding: '4px 8px', minHeight: '30px', fontSize: '11px' }}>
                    <Copy size={12} /> Copy
                  </button>
                )}
              </div>
            </div>
            {match.privateKeyWif && (
              <div style={{ marginTop: '10px' }}>
                <span className="range-lookup-label">Private Key (WIF):</span>
                <code style={{ display: 'block', color: 'hsl(var(--foreground))', wordBreak: 'break-all', marginTop: '2px' }}>{match.privateKeyWif}</code>
              </div>
            )}
          </div>
        )}
      </section>

      <footer className="donation-page-footer">
        <DonationAddress />
      </footer>
    </main>
  );
  }
