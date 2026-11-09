import { useRef, useState, useEffect, type FormEvent } from 'react';
import { findHdAddressByXpub } from '@/lib/hd-address-finder';
import { MULTI_CHAIN_OPTIONS, type MultiChainName } from '@/lib/multichain';
import { saveSearchProgress, getSearchProgress } from '@/lib/persistence';
import { Sparkles, Eye, Copy, Cpu, Fingerprint, CircleAlert, Zap } from 'lucide-react';
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
  
  // 🚀 إضافات المحرك وحفظ التقدم
  const [engine, setEngine] = useState<'cpu' | 'webgl' | 'webgpu'>('cpu');
  const [savedCursor, setSavedCursor] = useState<string | null>(null);

  const [status, setStatus] = useState('Ready');
  const [attempts, setAttempts] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [keysPerSec, setKeysPerSec] = useState(0);
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [match, setMatch] = useState<any>(null);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const [showPrivateKey, setShowPrivateKey] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const hdControllerRef = useRef<AbortController | null>(null);
  const startTimeRef = useRef<number>(0);
  const lastUpdateRef = useRef<number>(0);

  // التحقق من وجود تقدم سابق عند تحميل الصفحة
  useEffect(() => {
    void getSearchProgress('last_range_state').then((data) => {
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
    } catch {
      // ignore
    }
  };

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
      setAttempts(0);
      setElapsedMs(0);
      setKeysPerSec(0);
      startTimeRef.current = performance.now();

      const controller = new AbortController();
      hdControllerRef.current = controller;

      void findHdAddressByXpub({
        xpub,
        startIndex: firstIndex,
        endIndex: lastIndex,
        targetAddress,
        chain,
        signal: controller.signal,
        onProgress: (item) => {
          const now = performance.now();
          const currentAttempts = item.index - firstIndex + 1;
          const duration = Math.max(1, now - startTimeRef.current);
          setAttempts(currentAttempts);
          setElapsedMs(duration);
          setKeysPerSec(item.keysPerSecond || Math.floor((currentAttempts / duration) * 1000));
        },
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
    setStatus('Running');
    setError('');
    setMatch(null);
    setAttempts(0);
    setElapsedMs(0);
    setKeysPerSec(0);
    setProgressPercent(0);
    startTimeRef.current = performance.now();
    lastUpdateRef.current = performance.now();

    const worker = new Worker(new URL('../lib/vanity-coordinator.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (event) => {
      const message = event.data;
      const now = performance.now();

      if (message.type === 'progress' || message.attempts) {
        if (now - lastUpdateRef.current > 80 || message.type === 'found') {
          const duration = Math.max(1, now - startTimeRef.current);
          const currentAttempts = message.attempts;
          const calculatedSpeed = Math.floor((currentAttempts / duration) * 1000);

          setAttempts(currentAttempts);
          setElapsedMs(duration);
          setKeysPerSec(message.keysPerSecond || calculatedSpeed);
          if (message.percent !== undefined) setProgressPercent(message.percent);

          lastUpdateRef.current = now;
        }

        // حفظ التقدم دورياً في IndexedDB
        void saveSearchProgress('last_range_state', {
          cursor: startHex,
          targetAddress,
          chain,
          timestamp: Date.now()
        });
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

    // إرسال البيانات للـ Coordinator مع تحديد الـ Engine
    worker.postMessage({
      type: 'start',
      mode: 'range',
      startHex,
      endHex,
      targetAddress,
      chain,
      engine, // 👈 تمرير نوع المحرك المختار (cpu, webgl, webgpu)
      batchSize: 500000,
      workerCount: 4,
    });
  }

  // دالة استئناف البحث من آخر نقطة
  function handleResume() {
    if (savedCursor) {
      setStartHex(savedCursor);
      setStatus('Ready');
    }
  }

  const formatSpeed = (speed: number) => {
    if (speed >= 1_000_000) return `${(speed / 1_000_000).toFixed(2)} M keys/sec`;
    if (speed >= 1_000) return `${(speed / 1_000).toFixed(1)} K keys/sec`;
    return `${speed.toLocaleString()} keys/sec`;
  };

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

      <section className="workspace" aria-label="Address finder workspace">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '20px' }}>
          {savedCursor && mode === 'range' && !searching && (
            <div className="p-3 rounded flex justify-between items-center" style={{ background: '#24170e', border: '1px solid #65401f', padding: '12px 16px', borderRadius: '10px' }}>
              <span className="text-sm" style={{ color: '#f3c89c', fontSize: '12px' }}>Found previous search session. Do you want to resume?</span>
              <button className="text-xs px-3 py-1 rounded font-bold" onClick={handleResume} style={{ background: '#f7931a', color: '#14100a', border: 0, padding: '6px 12px', borderRadius: '6px', fontWeight: 700, fontSize: '11px' }}>
                Resume Last State
              </button>
            </div>
          )}

          <form className="panel finder-panel" onSubmit={handleSearch}>
            <div className="panel-heading">
              <div>
                <div className="section-kicker"><span className="step-number">01</span> Configuration</div>
                <div className="subhead">Set search mode and target parameters.</div>
              </div>
            </div>

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
                  setProgressPercent(null);
                }}
                disabled={searching}
              >
                <option value="range">Private-key range (Brute Force)</option>
                <option value="hd">HD address lookup (xpub)</option>
              </select>
            </label>

            {/* ⚡ اختيار المحرك (Engine Selector) */}
            {mode === 'range' && (
              <label className="finder-field" style={{ marginTop: 16 }}>
                <span>Compute Engine / Hardware</span>
                <select
                  value={engine}
                  onChange={(event) => setEngine(event.target.value as 'cpu' | 'webgl' | 'webgpu')}
                  disabled={searching}
                >
                  <option value="cpu">CPU (Multi-threaded Workers - Stable)</option>
                  <option value="webgl">WebGL (GPU Accelerated)</option>
                  <option value="webgpu">WebGPU (Ultra Fast GPU)</option>
                </select>
              </label>
            )}

            {mode === 'hd' ? (
              <>
                <label className="finder-field" style={{ marginTop: 16 }}>
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
                <div className="finder-index-row" style={{ marginTop: 16 }}>
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
                <div className="finder-index-row" style={{ marginTop: 16 }}>
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
                <div className="finder-index-row" style={{ marginTop: 16 }}>
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

                <div className="finder-index-row" style={{ marginTop: 16 }}>
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

            <button className="primary-button" type="submit" style={{ marginTop: 20 }}>
              {searching ? <CircleAlert size={16} /> : (engine === 'webgpu' ? <Zap size={16} /> : <Fingerprint size={16} />)}
              {searching ? 'Stop search' : 'Start High-Speed Search'}
            </button>
            {error && <div className="range-warning" style={{ marginTop: 12 }}>{error}</div>}
          </form>

          {/* 📊 Telemetry & Results Dashboard */}
          <aside className="panel status-panel" aria-label="Search telemetry" style={{ padding: '23px 27px' }}>
            <div className="result-head" style={{ marginBottom: 18 }}>
              <div>
                <div className="section-kicker"><span className="step-number">02</span> Live telemetry &amp; Results</div>
              </div>
              <div className={`status-pill ${searching ? 'status-running' : ''}`}>
                <span className="status-dot" /> {status.toUpperCase()}
              </div>
            </div>

            <div className="metrics-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '10px' }}>
              <div className="address-box" style={{ padding: '10px' }}>
                <span className="result-label">Status</span>
                <div style={{ fontSize: '12px', fontWeight: 700, color: '#f4f4f5', marginTop: '4px' }}>{status}</div>
              </div>
              <div className="address-box" style={{ padding: '10px' }}>
                <span className="result-label">Attempts</span>
                <div style={{ fontSize: '12px', fontWeight: 700, color: '#f4f4f5', marginTop: '4px' }}>{attempts.toLocaleString()}</div>
              </div>
              <div className="address-box" style={{ padding: '10px' }}>
                <span className="result-label">Elapsed Time</span>
                <div style={{ fontSize: '12px', fontWeight: 700, color: '#f4f4f5', marginTop: '4px' }}>{(elapsedMs / 1000).toFixed(1)}s</div>
              </div>
              <div className="address-box" style={{ padding: '10px', borderColor: keysPerSec > 1_000_000 ? '#f7931a' : undefined }}>
                <span className="result-label" style={{ color: keysPerSec > 1_000_000 ? '#ffbd72' : undefined }}>Speed</span>
                <div style={{ fontSize: '12px', fontWeight: 800, color: keysPerSec > 1_000_000 ? '#ffbd72' : '#f4f4f5', marginTop: '4px' }}>
                  {formatSpeed(keysPerSec)}
                </div>
              </div>
            </div>

            {progressPercent !== null && mode === 'range' && (
              <div style={{ marginTop: 15 }}>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }} />
                </div>
              </div>
            )}

            {match && (
              <div className="result-main" style={{ marginTop: 18, gridTemplateColumns: '1fr' }}>
                <div className="address-box">
                  <div className="result-label"><Sparkles size={12} style={{ display: 'inline', marginRight: 4 }} /> Match Found!</div>
                  <div className="address-text" style={{ marginTop: 6 }}>{match.address}</div>
                  {match.privateKeyHex && (
                    <div style={{ marginTop: 10 }}>
                      <span className="result-label">Private Key (Hex)</span>
                      <div className="private-value" style={{ marginTop: 4 }}>
                        {showPrivateKey ? match.privateKeyHex : '••••••••••••••••••••••••••••••••••••'}
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <button className="small-button" type="button" onClick={() => setShowPrivateKey(!showPrivateKey)}>
                          <Eye size={12} /> {showPrivateKey ? 'Hide' : 'Reveal'}
                        </button>
                        {showPrivateKey && (
                          <button className="small-button" type="button" onClick={() => copyValue(match.privateKeyHex)}>
                            <Copy size={12} /> Copy Hex
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  {match.index !== undefined && (
                    <div style={{ marginTop: 10 }}>
                      <span className="result-label">HD Index:</span> <code style={{ color: '#f4f4f5' }}>{match.index}</code>
                    </div>
                  )}
                  {match.privateKeyWif && (
                    <div style={{ marginTop: 10 }}>
                      <span className="result-label">Private Key WIF:</span>
                      <div className="private-value" style={{ marginTop: 4 }}>{match.privateKeyWif}</div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </aside>
        </div>
      </section>
    </main>
  );
          }
