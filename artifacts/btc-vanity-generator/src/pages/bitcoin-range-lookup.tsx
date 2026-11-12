import { useRef, useState, useEffect, type FormEvent } from 'react';
import { Zap, Eye, Copy, Sparkles } from 'lucide-react';
import DonationAddress from '@/components/donation-address';
import { MULTI_CHAIN_OPTIONS, type MultiChainName } from '@/lib/multichain';
import { saveSearchProgress, getSearchProgress } from '@/lib/persistence';
import './bitcoin-range-lookup.css';

// دالة جديدة باش نجيبو الرصيد من Blockchain.com (بحال صفحة Balance Check)
async function fetchBitcoinBalance(address: string): Promise<string> {
  try {
    const response = await fetch(`https://blockchain.info/q/addressbalance/${address}`);
    if (!response.ok) return "0.00000000";
    const satoshi = await response.json();
    const btc = satoshi / 100000000;
    return btc.toFixed(8);
  } catch (e) {
    return "Error fetching balance";
  }
}

export default function BitcoinRangeLookupPage({ active }: { active: boolean }) {
  const [startHex, setStartHex] = useState('1');
  const [endHex, setEndHex] = useState('5000');
  const [chain, setChain] = useState<MultiChainName>('btc'); // بدلناها لـ btc باش الرصيد يخدم
  const [targetAddress, setTargetAddress] = useState('');
  const [engine, setEngine] = useState<'cpu' | 'webgl' | 'webgpu'>('cpu'); // بدلناها لـ cpu باش تخدم دابا
  const [savedCursor, setSavedCursor] = useState<string | null>(null);

  const [status, setStatus] = useState('Ready');
  const [attempts, setAttempts] = useState(0);
  const [keysPerSec, setKeysPerSec] = useState(0);
  const [currentKey, setCurrentKey] = useState('');
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [match, setMatch] = useState<any>(null);
  const [notice, setNotice] = useState('');
  const [searching, setSearching] = useState(false);
  const [showPrivateKey, setShowPrivateKey] = useState(false);

  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    if (active) document.title = 'Isolated Hardware Range Scanner | LUCKY BTC';
    void getSearchProgress('range_lookup_state').then((data) => {
      if (data && data.cursor) {
        setSavedCursor(data.cursor);
        if (data.targetAddress) setTargetAddress(data.targetAddress);
        if (data.chain) setChain(data.chain);
      }
    });
  }, [active]);

  const copyValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice('Copied to clipboard!');
    } catch {
      setNotice('Clipboard copy failed.');
    }
  };

  function handleResume() {
    if (savedCursor) {
      setStartHex(savedCursor);
      setNotice('Resumed from previous cursor state.');
      setSavedCursor(null);
    }
  }

  function handleSearch(event: FormEvent<HTMLFormElement>, resumeKey?: string) {
    event.preventDefault();
    if (searching) {
      workerRef.current?.terminate();
      setSearching(false);
      setStatus('Stopped');
      setNotice('Scan stopped by user.');
      return;
    }

    if (!targetAddress.trim()) {
      setNotice('Please enter a target address.');
      return;
    }

    setSearching(true);
    setStatus('Running');
    setNotice('');
    setMatch(null);
    setAttempts(0);
    setKeysPerSec(0);
    setCurrentKey(resumeKey || startHex);
    setProgressPercent(0);

    try {
      const worker = new Worker(new URL('../lib/range-scanner.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;

      // هنا كنستقبلو الرسائل من الـ Worker
      worker.onmessage = async (event) => {
        const message = event.data;

        if (message.type === 'found') {
          setAttempts(message.attempts);
          
          // 1. ملي كيلقى المطابقة، كنجيبو الرصيد
          const balance = chain === 'btc' ? await fetchBitcoinBalance(message.result.address) : 'N/A';
          
          // 2. كنحدثو الحالة (State) باش يبان كلشي
          setMatch({
            ...message.result,
            balance: balance
          });
          
          setStatus('Found');
          setSearching(false);
          setNotice('Target private key found successfully!');
          worker.terminate();
        } else if (message.type === 'progress') {
          setAttempts(message.attempts);
          setKeysPerSec(message.speed || 0);
          setCurrentKey(message.currentKeyHex || '');
          if (message.percent !== undefined) setProgressPercent(message.percent);

          void saveSearchProgress('range_lookup_state', {
            cursor: message.currentKeyHex,
            targetAddress,
            chain,
            timestamp: Date.now()
          });
        } else if (message.type === 'exhausted') {
          setStatus('Exhausted');
          setSearching(false);
          setNotice('Range fully scanned. No match found.');
          worker.terminate();
        } else if (message.type === 'error') {
          setStatus('Error');
          setSearching(false);
          setNotice(message.message || 'Worker execution error.');
          worker.terminate();
        }
      };

      worker.onerror = () => {
        setStatus('Error');
        setSearching(false);
        setNotice('Critical worker error.');
        worker.terminate();
      };

      worker.postMessage({
        startHex: (resumeKey || startHex).trim().replace(/^0x/i, ''),
        endHex: endHex.trim().replace(/^0x/i, ''),
        targetAddress: targetAddress.trim(),
        chain,
        engine,
        cursor: resumeKey || undefined,
      });
    } catch {
      setStatus('Error');
      setSearching(false);
      setNotice('Could not initialize worker.');
    }
  }

  const formatSpeed = (speed: number) => {
    if (speed >= 1_000_000) return `${(speed / 1_000_000).toFixed(2)}M`;
    if (speed >= 1_000) return `${(speed / 1_000).toFixed(1)}K`;
    return `${speed}`;
  };

  return (
    <main className="range-lookup-page" data-testid="page-bitcoin-range-lookup">
      <header className="range-lookup-intro">
        <div className="range-lookup-kicker"><Zap aria-hidden="true" /> WebGPU / WebGL Engine</div>
        <h1>BitCrack &amp; Kangaroo Range Brute-Force</h1>
        <p>Direct cryptographic key space scanner with persistence and hardware acceleration.</p>
      </header>

      {savedCursor && !searching && (
        <div style={{ background: '#24170e', border: '1px solid #65401f', padding: '12px 16px', borderRadius: '10px', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#f3c89c', fontSize: '12px' }}>Found previous saved scanning session. Do you want to resume?</span>
          <button onClick={handleResume} style={{ background: '#f7931a', color: '#14100a', border: 0, padding: '6px 12px', borderRadius: '6px', fontWeight: 700, fontSize: '11px', cursor: 'pointer' }}>
            Resume State ({savedCursor.slice(0, 8)}...)
          </button>
        </div>
      )}

      <section className="range-lookup-panel">
        <p className="range-lookup-label">CONFIG</p>
        <h2>Scan Parameters</h2>

        <form onSubmit={(e) => handleSearch(e)}>
          <div className="range-lookup-field" style={{ marginTop: '10px' }}>
            <span>Compute Engine</span>
            <select
              className="select-control"
              value={engine}
              onChange={(e) => setEngine(e.target.value as 'cpu' | 'webgl' | 'webgpu')}
              disabled={searching}
              style={{ width: '100%', minHeight: '42px', padding: '0 10px', background: 'hsl(var(--background))', color: 'hsl(var(--foreground))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }}
            >
              <option value="webgpu">WebGPU (GPU VRAM - 10M+ keys/sec)</option>
              <option value="webgl">WebGL (Shader Accelerator)</option>
              <option value="cpu">CPU (Multi-threaded Workers)</option>
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '10px' }}>
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
            <div className="range-lookup-field" style={{ marginTop: 0 }}>
              <span>Target Address</span>
              <input
                type="text"
                value={targetAddress}
                onChange={(e) => setTargetAddress(e.target.value)}
                placeholder="1... or 0x..."
                disabled={searching}
                required
                style={{ width: '100%', minHeight: '42px', padding: '0 10px', background: 'hsl(var(--background))', color: 'hsl(var(--foreground))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }}
              />
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
            <button
              type="submit"
              className="range-lookup-search"
              style={{ width: '100%', padding: '12px', background: searching ? '#b23d32' : '#e77732', color: '#fff', border: 0, borderRadius: '8px', fontWeight: 700, cursor: 'pointer' }}
            >
              {searching ? 'Stop Scan' : 'Start Hardware Scan'}
            </button>
          </div>
        </form>

        {notice && <p style={{ marginTop: '10px', fontSize: '12px', color: '#ffbd72' }}>{notice}</p>}
      </section>

      {/* Minimalist Live Stream Telemetry */}
      <section style={{ marginTop: '20px', padding: '16px', background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontFamily: 'monospace' }}>
        <div style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))', marginBottom: '6px' }}>LIVE TELEMETRY: {status.toUpperCase()}</div>
        {searching ? (
          <div style={{ fontSize: '13px', color: '#ffbd72' }}>
            Searching...<br />
            Key: {currentKey} · {formatSpeed(keysPerSec)} keys/sec
          </div>
        ) : (
          <div style={{ fontSize: '13px', color: 'hsl(var(--foreground))' }}>{status === 'Ready' ? 'Idle. Ready to scan.' : `Completed with status: ${status}`}</div>
        )}

        {progressPercent !== null && (
          <div style={{ marginTop: '10px', height: '4px', background: 'hsl(var(--border))', borderRadius: '99px', overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%`, height: '100%', background: '#e77732' }} />
          </div>
        )}
      </section>

      {/* Match Found Card */}
      {match && (
        <div style={{ marginTop: '20px', padding: '16px', background: 'hsl(var(--background))', border: '2px solid #e77732', borderRadius: '10px' }}>
          <div style={{ color: '#ffbd72', fontWeight: 700, marginBottom: '8px' }}><Sparkles size={14} style={{ display: 'inline', marginRight: 4 }} /> MATCH FOUND!</div>
          
          <div style={{ fontSize: '12px', marginBottom: '6px' }}>
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>Address:</span>
            <code style={{ display: 'block', color: 'hsl(var(--foreground))', wordBreak: 'break-all' }}>{match.address}</code>
          </div>

          <div style={{ fontSize: '12px', marginBottom: '6px' }}>
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>Balance:</span>
            <span style={{ color: '#4ade80', fontWeight: 700, marginLeft: '6px' }}>{match.balance} {chain.toUpperCase()}</span>
          </div>

          <div style={{ fontSize: '12px', marginBottom: '6px' }}>
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>Range Discovered:</span>
            <span style={{ color: '#ffbd72', marginLeft: '6px' }}>{match.rangeStartHex} → {match.rangeEndHex}</span>
          </div>

          <div style={{ fontSize: '12px', marginTop: '8px' }}>
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>Private Key (Hex):</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
              <code style={{ wordBreak: 'break-all', color: 'hsl(var(--foreground))' }}>{showPrivateKey ? match.privateKeyHex : '••••••••••••••••••••••••••••••••••••'}</code>
              <button type="button" onClick={() => setShowPrivateKey(!showPrivateKey)} style={{ padding: '4px 8px', fontSize: '10px', cursor: 'pointer' }}>
                <Eye size={10} /> {showPrivateKey ? 'Hide' : 'Reveal'}
              </button>
              {showPrivateKey && (
                <button type="button" onClick={() => copyValue(match.privateKeyHex)} style={{ padding: '4px 8px', fontSize: '10px', cursor: 'pointer' }}>
                  <Copy size={10} /> Copy
                </button>
              )}
            </div>
          </div>

          {/* عرض الـ Private Key WIF */}
          {match.privateKeyWif && (
            <div style={{ fontSize: '12px', marginTop: '8px' }}>
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>Private Key (WIF):</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                <code style={{ wordBreak: 'break-all', color: 'hsl(var(--foreground))' }}>{showPrivateKey ? match.privateKeyWif : '••••••••••••••••••••••••••••••••••••'}</code>
                {showPrivateKey && (
                  <button type="button" onClick={() => copyValue(match.privateKeyWif)} style={{ padding: '4px 8px', fontSize: '10px', cursor: 'pointer' }}>
                    <Copy size={10} /> Copy
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <footer className="donation-page-footer" style={{ marginTop: '20px' }}>
        <DonationAddress />
      </footer>
    </main>
  );
            }
