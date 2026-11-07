import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import DonationAddress from '@/components/donation-address';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import BitcoinPuzzlePage from '@/pages/bitcoin-puzzle';
import BitcoinPuzzleAddressLookupPage from '@/pages/bitcoin-puzzle-address-lookup';
import BitcoinBalancePage from '@/pages/bitcoin-balance';
import BitcoinRangeLookupPage from '@/pages/bitcoin-range-lookup';
import FinderPage from '@/pages/finder';
import SelfTestPage from '@/pages/self-test';
import { queueBalanceCheck } from '@/lib/balance-check-transfer';
import { rememberGeneratedAddressRanges } from '@/lib/range-lookup-index';
import { saveSearchProgress, getSearchProgress } from '@/lib/storage';
import {
  Bitcoin,
  ChevronDown,
  CircleAlert,
  Copy,
  Download,
  Eye,
  Sparkles,
} from 'lucide-react';
import {
  isValidBitcoinAddressTarget,
  privateKeyFromRangeValue,
  privateKeyToHex,
  PRIVATE_KEY_LIMIT,
  type AddressFormat,
} from '@/lib/bitcoin';
import {
  getMultiChainAddress,
  MULTI_CHAIN_OPTIONS,
  type MultiChainName,
} from '@/lib/multichain';
import {
  MAX_RECORDED_RANGE_CANDIDATES,
  type CandidateRecord,
  type SearchResult,
  type WorkerResponse,
} from '@/lib/vanity-protocol';
import {
  Link,
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

const RANGE_RESUME_STORAGE_KEY = 'bitcoin-vanity-generator:range-resume:v1';
const MAX_CPU_WORKERS = 32;

type GeneratedCandidateRecord = CandidateRecord & { privateKeyHex: string };

function getMaxCpuWorkers(): number {
  const reportedCores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency;
  const availableCores = Number.isInteger(reportedCores) && reportedCores > 0 ? reportedCores : 2;
  const optimizedCores = Math.max(availableCores, 8); 
  return Math.max(1, Math.min(optimizedCores, MAX_CPU_WORKERS));
}

type RangeResumeSettings = {
  format: AddressFormat;
  startHex: string;
  endHex: string;
  batchSize: string;
};

type RangeResumeLoad = {
  settings: RangeResumeSettings | null;
  available: boolean;
};

function parseRangeResumeSettings(value: unknown): RangeResumeSettings | null {
  if (!value || typeof value !== 'object') return null;
  const settings = value as Record<string, unknown>;
  if (
    (settings.format !== 'legacy' && settings.format !== 'segwit') ||
    typeof settings.startHex !== 'string' ||
    !/^[0-9a-f]{1,64}$/i.test(settings.startHex) ||
    typeof settings.endHex !== 'string' ||
    !/^[0-9a-f]{1,64}$/i.test(settings.endHex)
  ) {
    return null;
  }
  const start = BigInt(`0x${settings.startHex}`);
  const end = BigInt(`0x${settings.endHex}`);
  if (start < 1n || end < start || end >= PRIVATE_KEY_LIMIT) return null;
  const fallbackBatchSize = end - start + 1n;
  const storedBatchSize =
    typeof settings.batchSize === 'string' && /^\d{1,78}$/.test(settings.batchSize)
      ? BigInt(settings.batchSize)
      : fallbackBatchSize;
  if (storedBatchSize < 1n || storedBatchSize >= PRIVATE_KEY_LIMIT) return null;
  return {
    format: settings.format,
    startHex: settings.startHex,
    endHex: settings.endHex,
    batchSize: storedBatchSize.toString(),
  };
}

function readRangeResumeSettings(): RangeResumeLoad {
  if (typeof window === 'undefined') return { settings: null, available: false };
  try {
    const saved = window.sessionStorage.getItem(RANGE_RESUME_STORAGE_KEY);
    if (!saved) return { settings: null, available: true };
    const parsed: unknown = JSON.parse(saved);
    const settings = parseRangeResumeSettings(parsed);
    if (settings) return { settings, available: true };
    window.sessionStorage.removeItem(RANGE_RESUME_STORAGE_KEY);
    return { settings: null, available: true };
  } catch {
    return { settings: null, available: false };
  }
}

function parseRangeHex(value: string): bigint | null {
  const normalized = value.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,64}$/i.test(normalized)) return null;
  const parsed = BigInt(`0x${normalized}`);
  return parsed >= 1n && parsed < PRIVATE_KEY_LIMIT ? parsed : null;
}

function getRangeSize(startHex: string, endHex: string): bigint | null {
  const start = parseRangeHex(startHex);
  const end = parseRangeHex(endHex);
  if (start === null || end === null || start > end) return null;
  return end - start + 1n;
}

function formatRangeHex(value: bigint, width: number): string {
  return value.toString(16).padStart(width, '0');
}

function SiteHeader({ activePage, children }: { activePage: 'generator' | 'puzzle' | 'balance' | 'range-lookup' | 'finder' | 'self-test'; children: ReactNode; }) {
  return (
    <header className="topbar">
      <Link href="/" className="brand"><span className="brand-mark"><svg viewBox="0 0 40 40" fill="none"><path d="M8 12h10M13 12v16M8 28h10" /><path d="M31 13c-2.2-1.6-7.3-1.9-9.8.3-3 2.6-.5 5.2 4.2 6.2 4.8 1 6.4 3.4 4.1 6.1-2.3 2.9-8.1 3-11.3 1.3" /></svg></span><span>LUCKY BTC</span></Link>
      <nav className="site-nav">
        <Link href="/" className={`site-nav-link ${activePage === 'generator' ? 'active' : ''}`}>Generator</Link>
        <Link href="/bitcoin-puzzle" className={`site-nav-link ${activePage === 'puzzle' ? 'active' : ''}`}>Bitcoin Puzzle</Link>
        <Link href="/balance-check" className={`site-nav-link ${activePage === 'balance' ? 'active' : ''}`}>Balance Check</Link>
        <Link href="/range-lookup" className={`site-nav-link ${activePage === 'range-lookup' ? 'active' : ''}`}>Range Lookup</Link>
        <Link href="/finder" className={`site-nav-link ${activePage === 'finder' ? 'active' : ''}`}>HD Finder</Link>
        <Link href="/self-test" className={`site-nav-link ${activePage === 'self-test' ? 'active' : ''}`}>Self-test</Link>
      </nav>
      <div className="top-meta">{children}</div>
    </header>
  );
}

function getNextRange(endHex: string, batchSize: bigint, width: number): { startHex: string; endHex: string } | null {
  const end = parseRangeHex(endHex);
  if (end === null) return null;
  const nextStart = end + 1n;
  const maximumKey = PRIVATE_KEY_LIMIT - 1n;
  if (nextStart > maximumKey) return null;
  const nextEnd = nextStart + batchSize - 1n;
  return { startHex: formatRangeHex(nextStart, width), endHex: formatRangeHex(nextEnd > maximumKey ? maximumKey : nextEnd, width) };
}

function saveRangeResumeSettings(settings: RangeResumeSettings): boolean {
  try { window.sessionStorage.setItem(RANGE_RESUME_STORAGE_KEY, JSON.stringify(settings)); return true; } catch { return false; }
}

function clearRangeResumeSettings(): boolean {
  try { window.sessionStorage.removeItem(RANGE_RESUME_STORAGE_KEY); return true; } catch { return false; }
}

function Home() {
  const [, setLocation] = useLocation();
  const maxCpuWorkers = getMaxCpuWorkers();
  const [cpuWorkers, setCpuWorkers] = useState(maxCpuWorkers);
  const [resumeLoad] = useState(readRangeResumeSettings);
  const initialResume = resumeLoad.settings;

  const [mode, setMode] = useState<'secure' | 'range'>(() => initialResume ? 'range' : 'secure');
  const [target, setTarget] = useState('');
  const [exactTarget, setExactTarget] = useState('');
  const [patternPosition, setPatternPosition] = useState<'prefix' | 'suffix'>('prefix');
  const [format, setFormat] = useState<AddressFormat>(() => initialResume?.format ?? 'legacy');
  const [chain, setChain] = useState<MultiChainName>('btc');
  
  // اختيار المحرك (CPU, WebGL, WebGPU)
  const [computeEngine, setComputeEngine] = useState<'cpu' | 'webgl' | 'webgpu'>('cpu');

  const [rangeStart, setRangeStart] = useState(() => initialResume?.startHex ?? '');
  const [rangeEnd, setRangeEnd] = useState(() => initialResume?.endHex ?? '');
  const [continuationOriginStart, setContinuationOriginStart] = useState(() => initialResume?.startHex ?? '');
  const [continuationBatchSize, setContinuationBatchSize] = useState(() => initialResume?.batchSize ?? '');
  const [canContinueRange, setCanContinueRange] = useState(Boolean(initialResume));
  const [rangeAccepted, setRangeAccepted] = useState(Boolean(initialResume));
  const [autoResumeEnabled, setAutoResumeEnabled] = useState(Boolean(initialResume));
  const [autoResumePending, setAutoResumePending] = useState(Boolean(initialResume));
  const [notice, setNotice] = useState('');
  const [searchStatus, setSearchStatus] = useState<'ready' | 'running' | 'stopping' | 'found' | 'stopped' | 'exhausted' | 'generated' | 'limit' | 'error'>('ready');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [candidateRecords, setCandidateRecords] = useState<GeneratedCandidateRecord[]>([]);
  const [generatedOnly, setGeneratedOnly] = useState(false);
  const [generatedAddressSearch, setGeneratedAddressSearch] = useState('');
  const [historyPage, setHistoryPage] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [price, setPrice] = useState<number | null>(null);
  const [priceChange, setPriceChange] = useState<number | null>(null);
  const [priceState, setPriceState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [multiChainKey] = useState('');
  const [multiChainChain] = useState<MultiChainName>('eth');

  const formRef = useRef<HTMLFormElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const autoContinueRangeRef = useRef(false);

  const searching = searchStatus === 'running' || searchStatus === 'stopping';
  const historyPageSize = 100;
  const getCandidateAddress = (record: GeneratedCandidateRecord) =>
    generatedOnly
      ? record.selectedChainAddress
      : record.address;
  const generatedAddresses = useMemo(
    () => candidateRecords.map((record) => ({
      record,
      address: getCandidateAddress(record),
    })),
    [candidateRecords, generatedOnly, chain],
  );
  const normalizedAddressSearch = generatedAddressSearch.trim().toLowerCase();
  const filteredGeneratedAddresses = useMemo(
    () => normalizedAddressSearch
      ? generatedAddresses.filter(({ address }) =>
          address.toLowerCase().includes(normalizedAddressSearch),
        )
      : generatedAddresses,
    [generatedAddresses, normalizedAddressSearch],
  );
  const historyPageCount = Math.max(
    1,
    Math.ceil(filteredGeneratedAddresses.length / historyPageSize),
  );
  const historyStart = historyPage * historyPageSize;
  const visibleHistory = filteredGeneratedAddresses.slice(
    historyStart,
    historyStart + historyPageSize,
  );

  useEffect(() => {
    let active = true;
    const loadPrice = async () => {
      try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true');
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (!active || typeof result?.bitcoin?.usd !== 'number') return;
        setPrice(result.bitcoin.usd);
        setPriceChange(typeof result.bitcoin.usd_24h_change === 'number' ? result.bitcoin.usd_24h_change : null);
        setPriceState('ready');
      } catch {
        if (active) setPriceState('error');
      }
    };
    void loadPrice();
    const interval = window.setInterval(loadPrice, 60_000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  useEffect(() => () => {
      const activeWorker = workerRef.current;
      if (activeWorker) {
        activeWorker.postMessage({ type: 'stop' });
        window.setTimeout(() => activeWorker.terminate(), 10_000);
      }
      workerRef.current = null;
  }, []);

  const copyValue = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); setNotice(`${label} copied to clipboard.`); } catch { setNotice('Clipboard access is unavailable in this browser.'); }
  };

  const copyAllAddresses = async () => {
    if (candidateRecords.length === 0) return;
    try {
      await navigator.clipboard.writeText(generatedAddresses.map(({ address }) => address).join('\n'));
      setNotice(`Copied all ${candidateRecords.length.toLocaleString()} addresses. Private keys were not copied.`);
    } catch {
      setNotice('Clipboard access is unavailable in this browser.');
    }
  };

  const downloadAddresses = (format: 'csv' | 'txt') => {
    if (candidateRecords.length === 0) return;
    const addresses = generatedAddresses.map(({ address }) => address);
    const content = format === 'csv'
      ? `\uFEFF${addresses.map((address) => `"${address.replace(/"/g, '""')}"`).join('\r\n')}`
      : `${addresses.join('\n')}\n`;
    const file = new Blob([content], {
      type: format === 'csv' ? 'text/csv;charset=utf-8;' : 'text/plain;charset=utf-8;',
    });
    const fileUrl = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = fileUrl;
    link.download = `${chain}-addresses-${new Date().toISOString().slice(0, 10)}.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(fileUrl), 0);
  };

  const checkGeneratedBalances = () => {
    if (
      candidateRecords.length === 0 ||
      searching ||
      autoResumePending
    ) {
      return;
    }
    queueBalanceCheck(generatedAddresses.map(({ address }) => address), chain);
    setLocation('/balance-check');
  };

  const disableAutoResume = () => {
    clearRangeResumeSettings();
    setAutoResumeEnabled(false);
    setAutoResumePending(false);
    setCanContinueRange(false);
    setContinuationOriginStart('');
    setContinuationBatchSize('');
  };

  const clearResumePreference = () => {
    disableAutoResume();
    setCandidateRecords([]);
    setHistoryPage(0);
    setGeneratedAddressSearch('');
  };

  useEffect(() => {
    if (!autoResumePending) return;
    const timeout = window.setTimeout(() => {
      setAutoResumePending(false);
      if (!formRef.current) {
        clearRangeResumeSettings();
        setAutoResumeEnabled(false);
        setNotice('The saved range could not be restarted in this tab.');
        return;
      }
      formRef.current.requestSubmit();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [autoResumePending]);

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (searching) {
      workerRef.current?.postMessage({ type: 'stop' });
      disableAutoResume();
      setSearchStatus('stopping');
      return;
    }

    const normalizedExactTarget = format === 'segwit' ? exactTarget.trim().toLowerCase() : exactTarget.trim();

    if (chain === 'btc' && normalizedExactTarget && !isValidBitcoinAddressTarget(normalizedExactTarget, format)) {
      setNotice('Enter a valid mainnet Bitcoin address.');
      return;
    }
    if (chain !== 'btc' && normalizedExactTarget) {
      setNotice('Exact EVM address matching is unavailable. Use a short hex prefix or suffix to generate a new vanity address.');
      return;
    }

    const pattern = target.trim();
    const generateOnly = mode === 'range' && !normalizedExactTarget && !pattern;

    if (chain !== 'btc' && !generateOnly && mode !== 'secure') {
      setNotice('Vanity searches on EVM networks use Auto · secure. Custom range supports address generation only.');
      return;
    }

    if (chain !== 'btc' && !generateOnly && !/^[0-9a-fA-F]{1,21}$/.test(pattern)) {
      setNotice('Enter a hexadecimal EVM prefix or suffix between 1 and 21 characters.');
      return;
    }

    if (!normalizedExactTarget && !pattern && !generateOnly) {
      setNotice('Enter a prefix or suffix, or paste a full target address.');
      return;
    }

    if (mode === 'range' && !rangeAccepted) {
      setNotice('Confirm the custom-range safety warning before continuing.');
      return;
    }

    const selectedRangeSize = generateOnly ? getRangeSize(rangeStart, rangeEnd) : null;
    if (generateOnly && selectedRangeSize === null) {
      setNotice('Enter a valid low/high range before generating addresses.');
      return;
    }
    if (generateOnly && candidateRecords.length >= MAX_RECORDED_RANGE_CANDIDATES) {
      setSearchStatus('limit');
      setNotice(`The ${MAX_RECORDED_RANGE_CANDIDATES.toLocaleString()}-row display limit has been reached. Edit the range to start a new list.`);
      setCanContinueRange(false);
      return;
    }

    const isContinuation = generateOnly && canContinueRange && Boolean(continuationOriginStart) && Boolean(continuationBatchSize);
    const runBatchSize = generateOnly ? (isContinuation ? BigInt(continuationBatchSize) : selectedRangeSize!) : 0n;
    const runOriginStart = isContinuation ? continuationOriginStart : rangeStart;
    const existingRecordCount = isContinuation ? candidateRecords.length : 0;
    const candidateLimit = MAX_RECORDED_RANGE_CANDIDATES - existingRecordCount;
    if (generateOnly && candidateLimit <= 0) {
      setSearchStatus('limit');
      setNotice(`The ${MAX_RECORDED_RANGE_CANDIDATES.toLocaleString()}-row display limit has been reached. Edit the range to start a new list.`);
      setCanContinueRange(false);
      return;
    }

    const rangeWidth = Math.max(rangeStart.replace(/^0x/i, '').length, rangeEnd.replace(/^0x/i, '').length);
    const rangeResumeSaved = generateOnly ? saveRangeResumeSettings({ format, startHex: runOriginStart, endHex: rangeEnd, batchSize: runBatchSize.toString() }) : false;

    if (!generateOnly) {
      clearRangeResumeSettings();
      setContinuationOriginStart('');
      setContinuationBatchSize('');
    }
    setAutoResumeEnabled(rangeResumeSaved);
    setAutoResumePending(false);
    if (generateOnly) {
      setContinuationOriginStart(runOriginStart);
      setContinuationBatchSize(runBatchSize.toString());
    }
    setCanContinueRange(false);

    workerRef.current?.terminate();
    setResult(null);
    if (!isContinuation) {
      setCandidateRecords([]);
      setHistoryPage(0);
      setGeneratedAddressSearch('');
    }
    setGeneratedOnly(generateOnly);
    setShowPrivateKey(false);
    setAttempts(0);
    setElapsedMs(0);
    setProgressPercent(mode === 'range' ? 0 : null);
    setNotice('');

    try {
      const worker = new Worker(new URL('./lib/vanity-coordinator.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if ('attempts' in message) setAttempts(message.attempts);
        if ('elapsedMs' in message) setElapsedMs(message.elapsedMs);

        if (message.type === 'candidates') {
          rememberGeneratedAddressRanges(message.candidates);
          const candidates = message.candidates.map((record) => {
            const privateKeyValue =
              BigInt(`0x${rangeStart.replace(/^0x/i, '')}`) +
              BigInt(record.index - existingRecordCount - 1);
            return {
              ...record,
              privateKeyHex: privateKeyToHex(
                privateKeyFromRangeValue(privateKeyValue),
              ),
            };
          });
          setCandidateRecords((previous) => [
            ...previous,
            ...candidates,
          ].sort((left, right) => left.index - right.index));

          // حفظ التقدم عبر IndexedDB
          void saveSearchProgress('last_range_state', {
            cursor: rangeStart,
            chain,
            timestamp: Date.now()
          });
        } else if (message.type === 'progress') {
          setProgressPercent(message.percent);
          setSearchStatus('running');
        } else if (message.type === 'found') {
          setResult(message.result);
          setProgressPercent(100);
          setSearchStatus('found');
          setNotice(chain === 'btc' ? 'Target found! The search stopped.' : 'Vanity address found! The search stopped.');
          worker.terminate();
        } else if (message.type === 'exhausted') {
          setProgressPercent(100);
          setSearchStatus('exhausted');
          setNotice('The entire selected range was checked; no match.');
          worker.terminate();
        } else if (message.type === 'history-limit') {
          const runStart = parseRangeHex(rangeStart);
          const lastGenerated = runStart === null
            ? null
            : runStart + BigInt(message.attempts) - 1n;
          if (generateOnly && lastGenerated !== null) {
            setAutoResumeEnabled(saveRangeResumeSettings({
              format,
              startHex: runOriginStart,
              endHex: formatRangeHex(lastGenerated, rangeWidth),
              batchSize: runBatchSize.toString(),
            }));
            setHistoryPage(Math.floor(
              Math.max(0, existingRecordCount + message.attempts - 1) / historyPageSize,
            ));
          }
          setCanContinueRange(false);
          setSearchStatus('limit');
          setNotice(`Stopped at the ${message.limit.toLocaleString()}-row safety limit. The generated rows remain visible; edit the range to start a new list.`);
          worker.terminate();
        } else if (message.type === 'generated') {
          const totalRecordCount = existingRecordCount + message.attempts;
          setProgressPercent(100);
          if (totalRecordCount >= MAX_RECORDED_RANGE_CANDIDATES) {
            setCanContinueRange(false);
            setSearchStatus('limit');
            setNotice(`Generated ${totalRecordCount.toLocaleString()} addresses and private keys. The ${MAX_RECORDED_RANGE_CANDIDATES.toLocaleString()}-row display limit has been reached.`);
            setHistoryPage(Math.floor((totalRecordCount - 1) / historyPageSize));
          } else {
            const nextRange = getNextRange(rangeEnd, runBatchSize, rangeWidth);
            if (nextRange) {
              setRangeStart(nextRange.startHex);
              setRangeEnd(nextRange.endHex);
              setCanContinueRange(true);
              setContinuationOriginStart(runOriginStart);
              setContinuationBatchSize(runBatchSize.toString());
              setSearchStatus('generated');
              setNotice(`Generated ${message.attempts.toLocaleString()} addresses and private keys. Next block: ${nextRange.startHex}–${nextRange.endHex}.`);
              if (autoContinueRangeRef.current) setAutoResumePending(true);
              setHistoryPage(isContinuation
                ? Math.floor((totalRecordCount - 1) / historyPageSize)
                : 0);
            } else {
              setCanContinueRange(false);
              setSearchStatus('generated');
              setNotice('Generated the final block. The maximum valid private key has been reached.');
              setHistoryPage(isContinuation
                ? Math.floor((totalRecordCount - 1) / historyPageSize)
                : 0);
            }
          }
          worker.terminate();
        } else if (message.type === 'stopped') {
          setSearchStatus('stopped');
          setNotice('Search stopped by user.');
          worker.terminate();
        } else if (message.type === 'error') {
          setSearchStatus('error');
          setNotice(message.message);
          worker.terminate();
        }
      };

      worker.onerror = () => {
        setSearchStatus('error');
        setNotice('Worker error.');
        worker.terminate();
      };

      setSearchStatus('running');
      worker.postMessage({
        type: 'start',
        mode: mode === 'range' ? 'range' : 'random',
        format,
        chain,
        prefix: normalizedExactTarget ? '' : (patternPosition === 'prefix' ? (chain === 'btc' ? `1${pattern}` : pattern.toLowerCase()) : ''),
        suffix: normalizedExactTarget || patternPosition === 'prefix' ? '' : (chain === 'btc' ? pattern : pattern.toLowerCase()),
        targetAddress: chain === 'btc' ? normalizedExactTarget || undefined : undefined,
        startHex: rangeStart,
        endHex: rangeEnd,
        generateOnly,
        candidateLimit: mode === 'range' ? candidateLimit : undefined,
        candidateOffset: existingRecordCount,
        workerCount: cpuWorkers,
        engine: computeEngine, // <--- تمرير الـ Engine للـ Worker
      });
    } catch {
      setSearchStatus('error');
      setNotice('Could not start worker.');
    }
  };

  const formattedPrice = price === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(price);
  const isGeneratingRangeOnly = mode === 'range' && !target.trim() && !exactTarget.trim();

  return (
    <div className="app-shell">
      <SiteHeader activePage="generator">
        <span>LOCAL KEY GENERATION</span>
        <div className="price-line" data-testid="text-live-btc-price">
          <span className="price-dot" />
          <span>BTC {formattedPrice}</span>
        </div>
        <span className="price-status" data-testid="status-price">
          {priceState === 'ready' ? 'LIVE · 60s' : priceState === 'error' ? 'PRICE OFFLINE' : 'UPDATING'}
        </span>
      </SiteHeader>

      <main className="page-wrap">
        <section className="intro">
          <div className="eyebrow">A tool for your own keys</div>
          <h1>Make an address<br />that feels like yours.</h1>
          <p className="intro-copy">Search locally for an address with a pattern you choose. Your keys stay in this browser.</p>
        </section>

        <section className="workspace" aria-label="Address search">
          <form ref={formRef} className="panel search-panel" onSubmit={handleSearch}>
            <div className="panel-heading">
              <div>
                <div className="section-kicker"><span className="step-number">01</span> Set your search</div>
                <div className="subhead">Choose a pattern and the address family to search.</div>
              </div>
              <div className="mode-switch" role="group">
                <button type="button" disabled={searching} className={`mode-option ${mode === 'secure' ? 'active' : ''}`} onClick={() => { clearResumePreference(); setMode('secure'); setRangeAccepted(false); setNotice(''); }}>Auto · secure</button>
                <button type="button" disabled={searching} className={`mode-option ${mode === 'range' ? 'active' : ''}`} onClick={() => { clearResumePreference(); setMode('range'); setNotice(''); }}>Custom range</button>
              </div>
            </div>

            <div className="field-grid">
              <div>
                <label className="field-label">Blockchain Network</label>
                <div className="select-wrap">
                  <select className="select-control" value={chain} disabled={searching} onChange={(event) => {
                    const selectedChain = event.target.value as MultiChainName;
                    clearResumePreference();
                    setChain(selectedChain);
                    setExactTarget('');
                    setTarget('');
                  }}>
                    {MULTI_CHAIN_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>{option.label} ({option.symbol})</option>
                    ))}
                  </select>
                  <ChevronDown aria-hidden="true" />
                </div>
                <p className="hint">
                  {chain === 'btc'
                    ? 'Custom-range generation displays Bitcoin addresses. Bitcoin supports exact-address and pattern matching.'
                    : 'Auto · secure searches up to 21 hexadecimal characters for a new EVM vanity address. Longer patterns may take a very long time. Custom range generates addresses only.'}
                </p>
              </div>
              {chain === 'btc' && (
                <div>
                  <label className="field-label">Address format</label>
                  <div className="select-wrap">
                    <select className="select-control" value={format} disabled={searching} onChange={(event) => { clearResumePreference(); setFormat(event.target.value as AddressFormat); }}>
                      <option value="legacy">Legacy · P2PKH (1…)</option>
                      <option value="segwit">Native SegWit · Bech32 (bc1q…)</option>
                    </select>
                    <ChevronDown aria-hidden="true" />
                  </div>
                </div>
              )}
            </div>

            {/* Compute Engine Selector (CPU, WebGL, WebGPU) */}
            {mode === 'range' && (
              <div className="field-grid">
                <div>
                  <label className="field-label">Compute Engine / Hardware</label>
                  <div className="select-wrap">
                    <select
                      className="select-control"
                      value={computeEngine}
                      disabled={searching}
                      onChange={(event) => setComputeEngine(event.target.value as 'cpu' | 'webgl' | 'webgpu')}
                    >
                      <option value="cpu">CPU (Multi-threaded Workers - Stable)</option>
                      <option value="webgl">WebGL (GPU Accelerated)</option>
                      <option value="webgpu">WebGPU (Ultra Fast GPU)</option>
                    </select>
                    <ChevronDown aria-hidden="true" />
                  </div>
                </div>
                <div className="cpu-worker-control">
                  <label className="field-label" htmlFor="cpu-workers-range">
                    CPU Workers: <strong>{cpuWorkers}</strong>
                  </label>
                  <input
                    id="cpu-workers-range"
                    type="range"
                    min="1"
                    max={maxCpuWorkers}
                    value={cpuWorkers}
                    disabled={searching}
                    onChange={(event) => setCpuWorkers(Number(event.target.value))}
                    className="worker-range-slider"
                  />
                </div>
              </div>
            )}

            <label className="field-label" htmlFor="exact-address">
              {chain === 'btc' ? 'Exact full BTC address (optional)' : 'Exact full EVM address matching unavailable'}
            </label>
            <div className="input-row">
              <input
                id="exact-address"
                className="target-input"
                value={exactTarget}
                onChange={(event) => { clearResumePreference(); setExactTarget(event.target.value.trim()); }}
                disabled={searching || chain !== 'btc'}
                placeholder={chain === 'btc' ? 'Paste a complete BTC address to match exactly' : 'Use a short hex prefix or suffix below'}
              />
            </div>

            <div className="pattern-label-row">
              <label className="field-label" htmlFor="target-prefix">{patternPosition === 'prefix' ? 'Address starts with' : 'Address ends with'}</label>
              <div className="pattern-toggle" role="group">
                <button type="button" className={patternPosition === 'prefix' ? 'selected' : ''} disabled={Boolean(exactTarget) || searching} onClick={() => setPatternPosition('prefix')}>Prefix</button>
                <button type="button" className={patternPosition === 'suffix' ? 'selected' : ''} disabled={Boolean(exactTarget) || searching} onClick={() => setPatternPosition('suffix')}>Suffix</button>
              </div>
            </div>
            <div className="input-row">
              {patternPosition === 'prefix' && chain === 'btc' && <span className="target-prefix">{format === 'segwit' ? 'bc1q' : '1'}</span>}
              {patternPosition === 'prefix' && chain !== 'btc' && <span className="target-prefix">0x</span>}
              <input
                id="target-prefix"
                className="target-input"
                value={target}
                onChange={(event) => { clearResumePreference(); setTarget(event.target.value.replace(/\s/g, '')); }}
                disabled={Boolean(exactTarget) || searching}
                placeholder={patternPosition === 'prefix' ? 'your-pattern' : 'your-ending'}
                maxLength={chain === 'btc' ? (format === 'segwit' ? 55 : 25) : 21}
              />
            </div>

            <div className="field-grid">
              <div>
                <label className="field-label">Key generation</label>
                <div className="select-wrap">
                  <select className="select-control" value={mode} disabled={searching} onChange={(event) => { clearResumePreference(); setMode(event.target.value as 'secure' | 'range'); setRangeAccepted(false); }}>
                    <option value="secure">Automatic · no range needed</option>
                    <option value="range">User-defined range</option>
                  </select>
                  <ChevronDown aria-hidden="true" />
                </div>
              </div>
            </div>

            {mode === 'range' && (
              <div className="custom-range-box">
                <div className="section-kicker">Custom key range</div>
                <div className="field-grid">
                  <div>
                    <label className="field-label" htmlFor="range-start">Start Key (Hex)</label>
                    <input
                      id="range-start"
                      className="target-input"
                      value={rangeStart}
                      onChange={(event) => { clearResumePreference(); setRangeStart(event.target.value.trim()); }}
                      disabled={searching}
                      placeholder="1"
                    />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="range-end">End Key (Hex)</label>
                    <input
                      id="range-end"
                      className="target-input"
                      value={rangeEnd}
                      onChange={(event) => { clearResumePreference(); setRangeEnd(event.target.value.trim()); }}
                      disabled={searching}
                      placeholder="FFFFF"
                    />
                  </div>
                </div>
                <div className="range-acceptance">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={rangeAccepted}
                      disabled={searching}
                      onChange={(event) => setRangeAccepted(event.target.checked)}
                    />
                    <span>I understand the key space and wish to scan this explicit range.</span>
                  </label>
                </div>
              </div>
            )}

            {autoResumeEnabled && (
              <div className="auto-resume-banner">
                <span>Session persistence active. You can resume scanning if interrupted.</span>
                <button type="button" className="text-button" onClick={clearResumePreference}>Reset State</button>
              </div>
            )}

            <div className="submit-row">
              <button
                type="submit"
                className={`primary-button ${searching ? 'danger' : ''}`}
                data-testid="button-start-search"
              >
                {searching ? 'Stop Search' : mode === 'range' && isGeneratingRangeOnly ? 'Generate Addresses' : 'Start Search'}
              </button>
            </div>

            {notice && (
              <div className="notice-box" role="status">
                <CircleAlert aria-hidden="true" />
                <span>{notice}</span>
              </div>
            )}
          </form>

          <aside className="panel status-panel" aria-label="Search status">
            <div className="panel-heading">
              <div className="section-kicker"><span className="step-number">02</span> Live telemetry</div>
              <div className="subhead">Real-time worker performance</div>
            </div>

            <div className="metrics-grid">
              <div className="metric-card">
                <span className="metric-label">Status</span>
                <span className="metric-value capitalize">{searchStatus}</span>
              </div>
              <div className="metric-card">
                <span className="metric-label">Attempts</span>
                <span className="metric-value">{attempts.toLocaleString()}</span>
              </div>
              <div className="metric-card">
                <span className="metric-label">Elapsed Time</span>
                <span className="metric-value">{(elapsedMs / 1000).toFixed(1)}s</span>
              </div>
              <div className="metric-card">
                <span className="metric-label">Speed</span>
                <span className="metric-value">
                  {elapsedMs > 0 ? Math.floor((attempts / elapsedMs) * 1000).toLocaleString() : '0'} keys/sec
                </span>
              </div>
            </div>

            {progressPercent !== null && (
              <div className="progress-container">
                <div className="progress-labels">
                  <span>Range Progress</span>
                  <span>{progressPercent.toFixed(2)}%</span>
                </div>
                <div className="progress-bar-bg">
                  <div className="progress-bar-fill" style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }} />
                </div>
              </div>
            )}

            {result && (
              <div className="result-card" data-testid="card-search-result">
                <div className="result-header">
                  <Sparkles aria-hidden="true" />
                  <span>Match Found!</span>
                </div>
                <div className="result-detail">
                  <span>Address:</span>
                  <code>{result.address}</code>
                  <button className="icon-btn" onClick={() => copyValue(result.address, 'Address')}>
                    <Copy size={14} />
                  </button>
                </div>
                <div className="result-detail">
                  <span>Private Key (Hex):</span>
                  <code>{showPrivateKey ? result.privateKeyHex : '••••••••••••••••••••••••••••••••'}</code>
                  <button className="icon-btn" onClick={() => setShowPrivateKey(!showPrivateKey)}>
                    <Eye size={14} />
                  </button>
                  {showPrivateKey && (
                    <button className="icon-btn" onClick={() => copyValue(result.privateKeyHex, 'Private Key Hex')}>
                      <Copy size={14} />
                    </button>
                  )}
                </div>
                {result.privateKeyWif && (
                  <div className="result-detail">
                    <span>Private Key (WIF):</span>
                    <code>{showPrivateKey ? result.privateKeyWif : '••••••••••••••••••••••••••••••••'}</code>
                    {showPrivateKey && (
                      <button className="icon-btn" onClick={() => copyValue(result.privateKeyWif, 'Private Key WIF')}>
                        <Copy size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </aside>
        </section>

        {candidateRecords.length > 0 && (
          <section className="panel results-panel" aria-label="Generated rows">
            <div className="panel-heading">
              <div>
                <div className="section-kicker">Generated List</div>
                <div className="subhead">{candidateRecords.length.toLocaleString()} items recorded in this session</div>
              </div>
              <div className="results-actions">
                <button type="button" className="action-btn" onClick={copyAllAddresses}>
                  <Copy size={14} /> Copy All
                </button>
                <button type="button" className="action-btn" onClick={() => downloadAddresses('csv')}>
                  <Download size={14} /> CSV
                </button>
                <button type="button" className="action-btn primary" onClick={checkGeneratedBalances}>
                  <Bitcoin size={14} /> Check Balances
                </button>
              </div>
            </div>

            <div className="search-filter-row">
              <input
                type="text"
                className="filter-input"
                placeholder="Filter generated addresses..."
                value={generatedAddressSearch}
                onChange={(event) => { setGeneratedAddressSearch(event.target.value); setHistoryPage(0); }}
              />
            </div>

            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Address</th>
                    <th>Private Key (Hex)</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleHistory.map(({ record, address }) => (
                    <tr key={`${record.index}-${address}`}>
                      <td>{record.index}</td>
                      <td><code>{address}</code></td>
                      <td><code>{record.privateKeyHex}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {historyPageCount > 1 && (
              <div className="pagination-row">
                <button
                  type="button"
                  disabled={historyPage === 0}
                  onClick={() => setHistoryPage((p) => Math.max(0, p - 1))}
                >
                  Previous
                </button>
                <span>Page {historyPage + 1} of {historyPageCount}</span>
                <button
                  type="button"
                  disabled={historyPage >= historyPageCount - 1}
                  onClick={() => setHistoryPage((p) => Math.min(historyPageCount - 1, p + 1))}
                >
                  Next
                </button>
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="footer">
        <DonationAddress />
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter>
            <Switch>
              <Route path="/" component={Home} />
              <Route path="/bitcoin-puzzle" component={BitcoinPuzzlePage} />
              <Route path="/bitcoin-puzzle-address-lookup" component={BitcoinPuzzleAddressLookupPage} />
              <Route path="/balance-check" component={BitcoinBalancePage} />
              <Route path="/range-lookup" component={BitcoinRangeLookupPage} />
              <Route path="/finder" component={FinderPage} />
              <Route path="/self-test" component={SelfTestPage} />
              <Route component={NotFound} />
            </Switch>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
