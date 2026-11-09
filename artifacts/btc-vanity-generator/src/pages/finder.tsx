import { useRef, useState, useEffect, type FormEvent } from 'react';
import { findHdAddressByXpub } from '@/lib/hd-address-finder';
import { MULTI_CHAIN_OPTIONS, type MultiChainName } from '@/lib/multichain';
import { saveSearchProgress, getSearchProgress } from '@/lib/persistence';
import { Sparkles, Eye, Copy, Cpu, Fingerprint, CircleAlert, Zap } from 'lucide-react';
import './finder.css';

export default function FinderPage() {
  const [mode, setMode] = useState<'range' | 'hd'>('range');
  const [startHex, setStartHex] = useState('1');
  const [endHex, setEndHex] = useState('FFFFFFFFFFFFFF');
  const [xpub, setXpub] = useState('');
  const [chain, setChain] = useState<MultiChainName>('eth');
  const [startIndex, setStartIndex] = useState('0');
  const [endIndex, setEndIndex] = useState('1000');
  const [targetAddress, setTargetAddress] = useState('');
  
  const [engine, setEngine] = useState<'cpu' | 'webgl' | 'webgpu'>('webgpu');
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
    try { await navigator.clipboard.writeText(value); } catch {}
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
        setError('Enter valid numeric HD indexes.');
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
          setAttempts(item.index - firstIndex + 1);
          setElapsedMs(now - startTimeRef.current);
          setKeysPerSec(item.keysPerSecond);
        },
      }).then((result) => {
        setMatch(result);
        setStatus(result ? 'HD match found!' : 'Search complete — no match');
      }).catch((searchError: unknown) => {
        if (controller.signal.aborted) {
          setStatus('Search stopped');
        } else {
          setError(searchError instanceof Error ? searchError.message : 'HD search failed.');
          setStatus('Error');
        }
      }).finally(() => {
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
        // Throttled State Updates for High Speed Telemetry (8M+ keys/sec support)
        if (now - lastUpdateRef.current > 80 || message.type === 'found') {
          const duration = Math.max(1, now - startTimeRef.current);
          const currentAttempts = message.attempts;
          const calculatedSpeed = Math.floor((currentAttempts / (duration / 1000)));

          setAttempts(currentAttempts);
          setElapsedMs(duration);
          setKeysPerSec(message.keysPerSecond || calculatedSpeed);
          if (message.percent !== undefined) setProgressPercent(message.percent);

          lastUpdateRef.current = now;
        }

        void saveSearchProgress('last_range_state', {
          cursor: startHex,
          targetAddress,
          chain,
          timestamp: Date.now()
        });
      } else if (message.type === 'found') {
        setMatch(message.result);
        setStatus('Found');
        setSearching(false);
        worker.terminate();
      } else if (message.type === 'exhausted') {
        setStatus('Exhausted');
        setSearching(false);
        worker.terminate();
      } else if (message.type === 'error') {
        setError(message.message);
        setStatus('Error');
        setSearching(false);
        worker.terminate();
      }
    };

    worker.postMessage({
      type: 'start',
      mode: 'range',
      startHex,
      endHex,
      targetAddress,
      chain,
      engine,
      batchSize: 500000, // Large Batching for GPU Compute
      workerCount: typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 8) : 8,
    });
  }

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
          {mode === 'hd' ? 'MULTICHAIN HD ADDRESS FINDER' : 'HIGH-SPEED MULTICHAIN BRUTE FORCE'}
        </div>
        <h1>{mode === 'hd' ? 'HD Address Finder' : 'Find Private Key by Address'}</h1>
        <p className="intro-copy">
          {mode === 'hd'
            ? 'Match a public address against indexes derived from an account xpub.'
            : 'Hardware-accelerated private key scanner powered by WebGPU & multi-threaded workers.'}
        </p>
      </section>

      <section className="workspace" aria-label="Address finder workspace">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '20px' }}>
          {savedCursor && mode === 'range' && !searching && (
            <div className="p-3 border rounded flex justify-between items-center" style={{ background: '#24170e', border: '1px solid #65401f', padding: '12px 16px', borderRadius: '10px' }}>
              <span style={{ color: '#f3c89c', fontSize: '12px' }}>Found previous search session. Do you want to resume?</span>
              <button onClick={handleResume} style={{ background: '#f7931a', color: '#14100a', border: 0, padding: '6px 12px', borderRadius: '6px', fontWeight: 700, fontSize: '11px' }}>
                Resume Last State
              </button>
            </div>
          )}

          <form className="panel search-panel" onSubmit={handleSearch}>
            <div className="panel-heading">
              <div>
                <div className="section-kicker"><span className="step-number">01</span> Configuration</div>
                <div className="subhead">Set mode, hardware engine, and target parameters.</div>
              </div>
            </div>

            <label className="field-label">Finder mode</label>
            <div className="select-wrap" style={{ marginBottom: 16 }}>
              <select
                className="select-control"
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value as 'range' | 'hd');
                  setSearching(false);
                  setStatus('Ready');
                  setError('');
                  setMatch(null);
                }}
                disabled={searching}
              >
                <option value="range">Private-key range (Brute Force)</option>
                <option value="hd">HD address lookup (xpub)</option>
              </select>
            </div>

            {mode === 'range' && (
              <div style={{ marginBottom: 16 }}>
                <label className="field-label">Compute Engine / Hardware Acceleration</label>
                <div className="select-wrap">
                  <select
                    className="select-control"
                    value={engine}
                    onChange={(e) => setEngine(e.target.value as 'cpu' | 'webgl' | 'webgpu')}
                    disabled={searching}
                  >
                    <option value="webgpu">WebGPU (Ultra Fast GPU Pipeline - Recommended for 8M+ keys/s)</option>
                    <option value="webgl">WebGL (GPU Shaders)</option>
                    <option value="cpu">CPU (Multi-threaded Workers)</option>
                  </select>
                </div>
              </div>
            )}

            {mode === 'hd' ? (
              <>
                <label className="field-label">Account extended public key (xpub)</label>
                <div className="input-row" style={{ marginBottom: 16 }}>
                  <input
                    className="target-input"
                    value={xpub}
                    onChange={(e) => setXpub(e.target.value.trim())}
                    placeholder="xpub..."
                    disabled={searching}
                    required
                  />
                </div>
                <div className="field-grid" style={{ marginBottom: 16 }}>
                  <div>
                    <label className="field-label">Chain</label>
                    <div className="select-wrap">
                      <select className="select-control" value={chain} onChange={(e) => setChain(e.target.value as MultiChainName)} disabled={searching}>
                        {MULTI_CHAIN_OPTIONS.map((opt) => (
                          <option key={opt.id} value={opt.id}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="field-label">Address to match</label>
                    <input
                      className="target-input"
                      value={targetAddress}
                      onChange={(e) => setTargetAddress(e.target.value)}
                      placeholder={chain === 'btc' ? '1... or bc1q...' : '0x...'}
                      disabled={searching}
                      required
                      style={{ paddingLeft: '12px' }}
                    />
                  </div>
                </div>
                <div className="field-grid">
                  <div>
                    <label className="field-label">Start index</label>
                    <input className="range-input" type="number" min="0" value={startIndex} onChange={(e) => setStartIndex(e.target.value)} disabled={searching} required />
                  </div>
                  <div>
                    <label className="field-label">End index</label>
                    <input className="range-input" type="number" min="0" value={endIndex} onChange={(e) => setEndIndex(e.target.value)} disabled={searching} required />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="field-grid" style={{ marginBottom: 16 }}>
                  <div>
                    <label className="field-label">Chain</label>
                    <div className="select-wrap">
                      <select className="select-control" value={chain} onChange={(e) => setChain(e.target.value as MultiChainName)} disabled={searching}>
                        {MULTI_CHAIN_OPTIONS.map((opt) => (
                          <option key={opt.id} value={opt.id}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="field-label">Address to find</label>
                    <input
                      className="target-input"
                      value={targetAddress}
                      onChange={(e) => setTargetAddress(e.target.value)}
                      placeholder={chain === 'btc' ? '1... or bc1q...' : '0x...'}
                      disabled={searching}
                      required
                      style={{ paddingLeft: '12px' }}
                    />
                  </div>
                </div>

                <div className="range-fields">
                  <div>
                    <label className="field-label">Start Key (Hex)</label>
                    <input className="range-input" type="text" value={startHex} onChange={(e) => setStartHex(e.target.value)} disabled={searching} required />
                  </div>
                  <div>
                    <label className="field-label">End Key (Hex)</label>
                    <input className="range-input" type="text" value={endHex} onChange={(e) => setEndHex(e.target.value)} disabled={searching} required />
                  </div>
                </div>
              </>
            )}

            <button className="primary-button" type="submit">
              {searching ? <CircleAlert size={16} /> : (engine === 'webgpu' ? <Zap size={16} /> : <Fingerprint size={16} />)}
              {searching ? 'Stop search' : 'Start High-Speed Search'}
            </button>
            {error && <div className="range-warning" style={{ marginTop: 12 }}>{error}</div>}
          </form>

          {/* Telemetry Display */}
          <aside className="panel status-panel" aria-label="Search telemetry" style={{ padding: '23px 27px' }}>
            <div className="result-head" style={{ marginBottom: 18 }}>
              <div>
                <div className="section-kicker"><span className="step-number">02</span> Telemetry Performance</div>
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
              <div className="address-box" style={{ padding: '10px', borderColor: keysPerSec > 1000000 ? '#f7931a' : undefined }}>
                <span className="result-label" style={{ color: keysPerSec > 1000000 ? '#ffbd72' : undefined }}>Speed</span>
                <div style={{ fontSize: '12px', fontWeight: 800, color: keysPerSec > 1000000 ? '#ffbd72' : '#f4f4f5', marginTop: '4px' }}>
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
                </div>
              </div>
            )}
          </aside>
        </div>
      </section>
    </main>
  );
        }
