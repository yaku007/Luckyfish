import {
  type FormEvent,
  type ReactNode,
  useEffect,
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
import SelfTestPage from '@/pages/self-test';
import { queueBalanceCheck } from '@/lib/balance-check-transfer';
import { rememberGeneratedAddressRanges } from '@/lib/range-lookup-index';
import {
  ArrowUpRight,
  Bitcoin,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Cpu,
  Download,
  Eye,
  Fingerprint,
  Globe2,
  KeyRound,
  LockKeyhole,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import {
  isValidBitcoinAddressTarget,
  PRIVATE_KEY_LIMIT,
  type AddressFormat,
} from '@/lib/bitcoin';
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

function getMaxCpuWorkers(): number {
  const reportedCores =
    typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency;
  const availableCores =
    Number.isInteger(reportedCores) && reportedCores > 0 ? reportedCores : 2;
  return Math.max(1, Math.min(availableCores, MAX_CPU_WORKERS));
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
    typeof settings.batchSize === 'string' &&
    /^\d{1,78}$/.test(settings.batchSize)
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

function SiteHeader({
  activePage,
  children,
}: {
  activePage: 'generator' | 'puzzle' | 'balance' | 'range-lookup' | 'self-test';
  children: ReactNode;
}) {
  return (
    <header className="topbar">
      <Link href="/" className="brand" data-testid="link-brand-home" aria-label="LUCKY BTC home">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 40 40" fill="none">
            <path d="M8 12h10M13 12v16M8 28h10" />
            <path d="M31 13c-2.2-1.6-7.3-1.9-9.8.3-3 2.6-.5 5.2 4.2 6.2 4.8 1 6.4 3.4 4.1 6.1-2.3 2.9-8.1 3-11.3 1.3" />
          </svg>
        </span>
        <span>LUCKY BTC</span>
      </Link>
      <nav className="site-nav" aria-label="Main navigation">
        <Link
          href="/"
          className={`site-nav-link ${activePage === 'generator' ? 'active' : ''}`}
          aria-current={activePage === 'generator' ? 'page' : undefined}
          data-testid="link-vanity-generator"
        >
          Generator
        </Link>
        <Link
          href="/bitcoin-puzzle"
          className={`site-nav-link ${activePage === 'puzzle' ? 'active' : ''}`}
          aria-current={activePage === 'puzzle' ? 'page' : undefined}
          data-testid="link-bitcoin-puzzle"
        >
          Bitcoin Puzzle
        </Link>
        <Link
          href="/balance-check"
          className={`site-nav-link ${activePage === 'balance' ? 'active' : ''}`}
          aria-current={activePage === 'balance' ? 'page' : undefined}
          data-testid="link-balance-check"
        >
          Balance Check
        </Link>
        <Link
          href="/range-lookup"
          className={`site-nav-link ${activePage === 'range-lookup' ? 'active' : ''}`}
          aria-current={activePage === 'range-lookup' ? 'page' : undefined}
          data-testid="link-range-lookup"
        >
          Range Lookup
        </Link>
        <Link
          href="/self-test"
          className={`site-nav-link ${activePage === 'self-test' ? 'active' : ''}`}
          aria-current={activePage === 'self-test' ? 'page' : undefined}
          data-testid="link-self-test"
        >
          Self-test
        </Link>
      </nav>
      <div className="top-meta">{children}</div>
    </header>
  );
}

function getNextRange(
  endHex: string,
  batchSize: bigint,
  width: number,
): { startHex: string; endHex: string } | null {
  const end = parseRangeHex(endHex);
  if (end === null) return null;
  const nextStart = end + 1n;
  const maximumKey = PRIVATE_KEY_LIMIT - 1n;
  if (nextStart > maximumKey) return null;
  const nextEnd = nextStart + batchSize - 1n;
  return {
    startHex: formatRangeHex(nextStart, width),
    endHex: formatRangeHex(nextEnd > maximumKey ? maximumKey : nextEnd, width),
  };
}

function saveRangeResumeSettings(settings: RangeResumeSettings): boolean {
  try {
    window.sessionStorage.setItem(
      RANGE_RESUME_STORAGE_KEY,
      JSON.stringify(settings),
    );
    return true;
  } catch {
    try {
      window.sessionStorage.removeItem(RANGE_RESUME_STORAGE_KEY);
    } catch {
      // Storage is unavailable; the caller reports that auto-resume could not be saved.
    }
    return false;
  }
}

function clearRangeResumeSettings(): boolean {
  try {
    window.sessionStorage.removeItem(RANGE_RESUME_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function Home() {
  const [, setLocation] = useLocation();
  const maxCpuWorkers = getMaxCpuWorkers();
  const [cpuWorkers, setCpuWorkers] = useState(maxCpuWorkers);
  const [resumeLoad] = useState(readRangeResumeSettings);
  const initialResume = resumeLoad.settings;
  const [mode, setMode] = useState<'secure' | 'range'>(() =>
    initialResume ? 'range' : 'secure',
  );
  const [target, setTarget] = useState('');
  const [exactTarget, setExactTarget] = useState('');
  const [patternPosition, setPatternPosition] = useState<'prefix' | 'suffix'>('prefix');
  const [format, setFormat] = useState<AddressFormat>(
    () => initialResume?.format ?? 'legacy',
  );
  const [rangeStart, setRangeStart] = useState(
    () => initialResume?.startHex ?? '',
  );
  const [rangeEnd, setRangeEnd] = useState(() => initialResume?.endHex ?? '');
  const [continuationOriginStart, setContinuationOriginStart] = useState(
    () => initialResume?.startHex ?? '',
  );
  const [continuationBatchSize, setContinuationBatchSize] = useState(
    () => initialResume?.batchSize ?? '',
  );
  const [canContinueRange, setCanContinueRange] = useState(
    Boolean(initialResume),
  );
  const [rangeAccepted, setRangeAccepted] = useState(Boolean(initialResume));
  const [autoContinueRange, setAutoContinueRange] = useState(true);
  const [autoResumeEnabled, setAutoResumeEnabled] = useState(
    Boolean(initialResume),
  );
  const [autoResumePending, setAutoResumePending] = useState(
    Boolean(initialResume),
  );
  const [notice, setNotice] = useState('');
  const [searchStatus, setSearchStatus] = useState<
    | 'ready'
    | 'running'
    | 'stopping'
    | 'found'
    | 'stopped'
    | 'exhausted'
    | 'generated'
    | 'limit'
    | 'error'
  >('ready');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [candidateRecords, setCandidateRecords] = useState<CandidateRecord[]>([]);
  const [historyPage, setHistoryPage] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [price, setPrice] = useState<number | null>(null);
  const [priceChange, setPriceChange] = useState<number | null>(null);
  const [priceState, setPriceState] = useState<'loading' | 'ready' | 'error'>('loading');
  const formRef = useRef<HTMLFormElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const autoContinueRangeRef = useRef(true);

  const searching = searchStatus === 'running' || searchStatus === 'stopping';
  const historyPageSize = 100;
  const historyPageCount = Math.max(
    1,
    Math.ceil(candidateRecords.length / historyPageSize),
  );
  const historyStart = historyPage * historyPageSize;
  const visibleHistory = candidateRecords.slice(
    historyStart,
    historyStart + historyPageSize,
  );

  useEffect(() => {
    let active = true;
    const loadPrice = async () => {
      try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true');
        if (!response.ok) throw new Error('Price unavailable');
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
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(
    () => () => {
      const activeWorker = workerRef.current;
      if (activeWorker) {
        activeWorker.postMessage({ type: 'stop' });
        window.setTimeout(() => activeWorker.terminate(), 10_000);
      }
      workerRef.current = null;
    },
    [],
  );

  const copyTarget = async () => {
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target);
      setNotice('Search target copied.');
    } catch {
      setNotice('Clipboard access is unavailable in this browser.');
    }
  };

  const copyValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied to clipboard.`);
    } catch {
      setNotice('Clipboard access is unavailable in this browser.');
    }
  };

  const copyAllAddresses = async () => {
    if (candidateRecords.length === 0) return;

    try {
      await navigator.clipboard.writeText(
        candidateRecords.map((record) => record.address).join('\n'),
      );
      setNotice(
        `Copied all ${candidateRecords.length.toLocaleString()} addresses. Private keys were not copied.`,
      );
    } catch {
      setNotice('Clipboard access is unavailable in this browser.');
    }
  };

  const checkGeneratedBalances = () => {
    if (candidateRecords.length === 0 || searching || autoResumePending) return;
    queueBalanceCheck(candidateRecords.map((record) => record.address));
    setLocation('/balance-check');
  };

  const downloadAddressesCsv = () => {
    if (candidateRecords.length === 0) return;

    const escapeCsvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const csv = `\uFEFF${candidateRecords
      .map((record) => escapeCsvCell(record.address))
      .join('\r\n')}`;
    const file = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const fileUrl = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = fileUrl;
    link.download = `bitcoin-addresses-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(fileUrl), 0);
  };

  const downloadAddressesTxt = () => {
    if (candidateRecords.length === 0) return;

    const addresses = `${candidateRecords
      .map((record) => record.address)
      .join('\n')}\n`;
    const file = new Blob([addresses], { type: 'text/plain;charset=utf-8;' });
    const fileUrl = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = fileUrl;
    link.download = `bitcoin-addresses-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(fileUrl), 0);
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
  };

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (searching) {
      workerRef.current?.postMessage({ type: 'stop' });
      disableAutoResume();
      setSearchStatus('stopping');
      return;
    }

    const normalizedExactTarget =
      format === 'segwit' ? exactTarget.trim().toLowerCase() : exactTarget.trim();
    if (
      normalizedExactTarget &&
      !isValidBitcoinAddressTarget(normalizedExactTarget, format)
    ) {
      setNotice(
        format === 'legacy'
          ? 'Enter a valid mainnet Legacy address beginning with 1.'
          : 'Enter a valid mainnet Native SegWit address beginning with bc1q.',
      );
      return;
    }

    const pattern = target.trim();
    const generateOnly =
      mode === 'range' && !normalizedExactTarget && !pattern;
    if (!normalizedExactTarget && !pattern && !generateOnly) {
      setNotice('Enter a prefix or suffix, or paste a full target address.');
      return;
    }
    if (pattern && !normalizedExactTarget) {
      const allowed =
        format === 'legacy'
          ? /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/
          : /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/i;
      if (!allowed.test(pattern)) {
        setNotice(
          format === 'legacy'
            ? 'Use only valid Base58 characters for a Legacy pattern.'
            : 'Use only valid Bech32 characters for a Native SegWit pattern.',
        );
        return;
      }
    }
    if (mode === 'range' && !rangeAccepted) {
      setNotice('Confirm the custom-range safety warning before continuing.');
      return;
    }

    const selectedRangeSize = generateOnly
      ? getRangeSize(rangeStart, rangeEnd)
      : null;
    if (generateOnly && selectedRangeSize === null) {
      setNotice('Enter a valid low/high range before generating addresses.');
      return;
    }
    if (
      generateOnly &&
      candidateRecords.length >= MAX_RECORDED_RANGE_CANDIDATES
    ) {
      setSearchStatus('limit');
      setNotice(
        `The ${MAX_RECORDED_RANGE_CANDIDATES.toLocaleString()}-row display limit has been reached. Edit the range to start a new list.`,
      );
      setCanContinueRange(false);
      return;
    }
    const isContinuation =
      generateOnly &&
      canContinueRange &&
      Boolean(continuationOriginStart) &&
      Boolean(continuationBatchSize);
    const runBatchSize = generateOnly
      ? isContinuation
        ? BigInt(continuationBatchSize)
        : selectedRangeSize!
      : 0n;
    const runOriginStart = isContinuation
      ? continuationOriginStart
      : rangeStart;
    const existingRecordCount = isContinuation ? candidateRecords.length : 0;
    const candidateLimit =
      MAX_RECORDED_RANGE_CANDIDATES - existingRecordCount;
    if (generateOnly && candidateLimit <= 0) {
      setSearchStatus('limit');
      setNotice(
        `The ${MAX_RECORDED_RANGE_CANDIDATES.toLocaleString()}-row display limit has been reached. Edit the range to start a new list.`,
      );
      setCanContinueRange(false);
      return;
    }
    const rangeWidth = Math.max(
      rangeStart.replace(/^0x/i, '').length,
      rangeEnd.replace(/^0x/i, '').length,
    );
    const rangeResumeSaved = generateOnly
      ? saveRangeResumeSettings({
          format,
          startHex: runOriginStart,
          endHex: rangeEnd,
          batchSize: runBatchSize.toString(),
        })
      : false;
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
    const persistenceNotice =
      generateOnly && !rangeResumeSaved
        ? 'This browser blocked tab storage, so this range will not auto-restart after refresh.'
        : '';

    workerRef.current?.terminate();
    setResult(null);
    if (!isContinuation) {
      setCandidateRecords([]);
      setHistoryPage(0);
    }
    setShowPrivateKey(false);
    setAttempts(0);
    setElapsedMs(0);
    setProgressPercent(mode === 'range' ? 0 : null);
    setNotice(persistenceNotice);

    try {
      const worker = new Worker(
        new URL('./lib/vanity-coordinator.worker.ts', import.meta.url),
        { type: 'module' },
      );
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if ('attempts' in message) setAttempts(message.attempts);
        if ('elapsedMs' in message) setElapsedMs(message.elapsedMs);

        if (message.type === 'candidates') {
          rememberGeneratedAddressRanges(message.candidates);
          setCandidateRecords((previous) => [
            ...previous,
            ...message.candidates,
          ].sort((left, right) => left.index - right.index));
        } else if (message.type === 'progress') {
          setProgressPercent(message.percent);
          setSearchStatus('running');
        } else if (message.type === 'found') {
          setResult(message.result);
          setProgressPercent(100);
          setSearchStatus('found');
          setNotice(
            normalizedExactTarget
              ? 'Exact target found. The search stopped automatically.'
              : 'Address found. The search stopped automatically.',
          );
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
        } else if (message.type === 'exhausted') {
          setProgressPercent(100);
          setSearchStatus('exhausted');
          setNotice('The entire selected range was checked; there was no match.');
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
        } else if (message.type === 'history-limit') {
          if (generateOnly) {
            const runStart = parseRangeHex(rangeStart);
            const lastGenerated =
              runStart === null
                ? null
                : runStart + BigInt(message.attempts) - 1n;
            if (lastGenerated !== null) {
              setAutoResumeEnabled(
                saveRangeResumeSettings({
                  format,
                  startHex: runOriginStart,
                  endHex: formatRangeHex(lastGenerated, rangeWidth),
                  batchSize: runBatchSize.toString(),
                }),
              );
              setProgressPercent(100);
              setHistoryPage(
                Math.floor(
                  Math.max(0, existingRecordCount + message.attempts - 1) /
                    historyPageSize,
                ),
              );
            }
          }
          setCanContinueRange(false);
          setSearchStatus('limit');
          setNotice(
            `Stopped at the ${message.limit.toLocaleString()}-row safety limit. The generated rows remain visible; edit the range to start a new list.`,
          );
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
        } else if (message.type === 'generated') {
          const totalRecordCount = existingRecordCount + message.attempts;
          setProgressPercent(100);
          if (totalRecordCount >= MAX_RECORDED_RANGE_CANDIDATES) {
            setCanContinueRange(false);
            setSearchStatus('limit');
            setNotice(
              `Generated ${totalRecordCount.toLocaleString()} addresses and private keys. The ${MAX_RECORDED_RANGE_CANDIDATES.toLocaleString()}-row display limit has been reached.`,
            );
            setHistoryPage(
              Math.floor((totalRecordCount - 1) / historyPageSize),
            );
          } else {
            const nextRange = getNextRange(
              rangeEnd,
              runBatchSize,
              rangeWidth,
            );
            if (nextRange) {
              setRangeStart(nextRange.startHex);
              setRangeEnd(nextRange.endHex);
              setCanContinueRange(true);
              setContinuationOriginStart(runOriginStart);
              setContinuationBatchSize(runBatchSize.toString());
              setSearchStatus('generated');
              setNotice(
                `Generated ${message.attempts.toLocaleString()} addresses and WIF keys. Next block: ${nextRange.startHex}–${nextRange.endHex}.${persistenceNotice ? ` ${persistenceNotice}` : ''}`,
              );
              if (autoContinueRangeRef.current) setAutoResumePending(true);
              setHistoryPage(
                isContinuation
                  ? Math.floor((totalRecordCount - 1) / historyPageSize)
                  : 0,
              );
            } else {
              setCanContinueRange(false);
              setSearchStatus('generated');
              setNotice(
                `Generated ${message.attempts.toLocaleString()} addresses and WIF keys. The maximum valid Bitcoin private key has been reached.`,
              );
              setHistoryPage(
                isContinuation
                  ? Math.floor((totalRecordCount - 1) / historyPageSize)
                  : 0,
              );
            }
          }
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
        } else if (message.type === 'stopped') {
          setSearchStatus('stopped');
          setNotice('Search stopped. No result was found before stopping.');
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
        } else if (message.type === 'error') {
          clearRangeResumeSettings();
          setAutoResumeEnabled(false);
          setSearchStatus('error');
          setNotice(message.message);
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
        }
      };
      worker.onerror = () => {
        clearRangeResumeSettings();
        setAutoResumeEnabled(false);
        setSearchStatus('error');
        setNotice('The local search worker stopped unexpectedly.');
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
      };
      setSearchStatus('running');
      worker.postMessage({
        type: 'start',
        mode: mode === 'range' ? 'range' : 'random',
        format,
        prefix: normalizedExactTarget
          ? ''
          : patternPosition === 'prefix'
            ? format === 'legacy'
              ? `1${pattern}`
              : `bc1q${pattern.toLowerCase()}`
            : '',
        suffix:
          normalizedExactTarget || patternPosition === 'prefix'
            ? ''
            : pattern,
        targetAddress: normalizedExactTarget || undefined,
        startHex: rangeStart,
        endHex: rangeEnd,
        generateOnly,
        candidateLimit: mode === 'range' ? candidateLimit : undefined,
        candidateOffset: existingRecordCount,
        workerCount: cpuWorkers,
      });
    } catch {
      clearRangeResumeSettings();
      setAutoResumeEnabled(false);
      setSearchStatus('error');
      setNotice('Could not start the local search worker in this browser.');
    }
  };

  useEffect(() => {
    if (!resumeLoad.available) {
      setNotice(
        'This browser blocked tab storage, so automatic range restart is unavailable.',
      );
    }
  }, [resumeLoad.available]);

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

  const formattedPrice = price === null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(price);

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
          <p className="intro-copy">Search locally for a Bitcoin address with a pattern you choose. Your keys stay in this browser—never uploaded, never stored.</p>
        </section>

        <section className="workspace" aria-label="Vanity address search">
          <form ref={formRef} className="panel search-panel" onSubmit={handleSearch}>
            <div className="panel-heading">
              <div>
                <div className="section-kicker"><span className="step-number">01</span> Set your search</div>
                <div className="subhead">Choose a pattern and the address family to search.</div>
              </div>
              <div className="mode-switch" role="group" aria-label="Search mode">
                <button type="button" disabled={searching} className={`mode-option ${mode === 'secure' ? 'active' : ''}`} aria-pressed={mode === 'secure'} data-testid="button-mode-secure" onClick={() => { clearResumePreference(); setMode('secure'); setRangeAccepted(false); setNotice(''); }}>Auto · secure</button>
                <button type="button" disabled={searching} className={`mode-option ${mode === 'range' ? 'active' : ''}`} aria-pressed={mode === 'range'} data-testid="button-mode-range" onClick={() => { clearResumePreference(); setMode('range'); setNotice(''); }}>Custom range</button>
              </div>
            </div>

            <label className="field-label" htmlFor="exact-address">Exact full Bitcoin address <span style={{ color: '#91958f', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
            <div className="input-row">
              <input
                id="exact-address"
                className="target-input"
                style={{ paddingLeft: 14 }}
                value={exactTarget}
                onChange={(event) => { clearResumePreference(); setExactTarget(event.target.value.trim()); }}
                disabled={searching}
                placeholder="Paste a complete address to match exactly"
                autoComplete="off"
                spellCheck={false}
                data-testid="input-exact-address"
              />
              {exactTarget && <button className="small-button" type="button" aria-label="Clear exact address" data-testid="button-clear-exact-address" onClick={() => { clearResumePreference(); setExactTarget(''); }}>Clear</button>}
            </div>
            <div className="mode-note" data-testid="note-exact-address">
              <CircleAlert aria-hidden="true" />
              <span><strong>An address cannot reveal its private-key range.</strong> With a full target, the app compares generated addresses exactly and stops at a match, but finding a key for a complete address is computationally impractical. For vanity search, leave this blank and enter a short prefix or suffix below.</span>
            </div>

            <div className="pattern-label-row">
              <label className="field-label" htmlFor="target-prefix">{patternPosition === 'prefix' ? 'Address starts with' : 'Address ends with'}</label>
              <div className="pattern-toggle" role="group" aria-label="Pattern position">
                <button type="button" className={patternPosition === 'prefix' ? 'selected' : ''} disabled={Boolean(exactTarget) || searching} aria-pressed={patternPosition === 'prefix'} onClick={() => setPatternPosition('prefix')} data-testid="button-pattern-prefix">Prefix</button>
                <button type="button" className={patternPosition === 'suffix' ? 'selected' : ''} disabled={Boolean(exactTarget) || searching} aria-pressed={patternPosition === 'suffix'} onClick={() => setPatternPosition('suffix')} data-testid="button-pattern-suffix">Suffix</button>
              </div>
            </div>
            <div className="input-row">
              {patternPosition === 'prefix' && <span className="target-prefix" aria-hidden="true">{format === 'segwit' ? 'bc1q' : '1'}</span>}
              <input
                id="target-prefix"
                className="target-input"
                value={target}
                onChange={(event) => { clearResumePreference(); setTarget(event.target.value.replace(/\s/g, '')); }}
                disabled={Boolean(exactTarget) || searching}
                placeholder={patternPosition === 'prefix' ? 'your-pattern' : 'your-ending'}
                maxLength={format === 'segwit' ? 55 : 25}
                autoComplete="off"
                spellCheck={false}
                data-testid="input-search-target"
              />
              {target && <button className="small-button" type="button" aria-label="Copy pattern" data-testid="button-copy-target" onClick={() => void copyTarget()}><Copy /></button>}
            </div>
            <p className="hint">{exactTarget ? 'Pattern search is paused while an exact address is set.' : mode === 'range' && !target ? 'Leave the pattern and exact address blank to generate every address in the selected range.' : 'Enter the characters after the network prefix. Case-sensitive for legacy addresses.'}</p>

            <div className="field-grid">
              <div>
                <label className="field-label" htmlFor="address-format">Address format</label>
                <div className="select-wrap">
                  <select className="select-control" id="address-format" value={format} disabled={searching} onChange={(event) => { clearResumePreference(); setFormat(event.target.value as AddressFormat); }} data-testid="select-address-format">
                    <option value="legacy">Legacy · P2PKH (1…)</option>
                    <option value="segwit">Native SegWit · Bech32 (bc1q…)</option>
                  </select>
                  <ChevronDown aria-hidden="true" />
                </div>
              </div>
              <div>
                <label className="field-label" htmlFor="search-method">Key generation</label>
                <div className="select-wrap">
                  <select className="select-control" id="search-method" value={mode} disabled={searching} onChange={(event) => { clearResumePreference(); setMode(event.target.value as 'secure' | 'range'); setRangeAccepted(false); }} data-testid="select-key-method">
                    <option value="secure">Automatic · no range needed</option>
                    <option value="range">User-defined range</option>
                  </select>
                  <ChevronDown aria-hidden="true" />
                </div>
              </div>
              <div className="cpu-worker-control" data-testid="control-cpu-workers">
                <div className="cpu-worker-heading">
                  <label className="field-label" htmlFor="cpu-workers"><Cpu aria-hidden="true" /> CPU workers</label>
                  <output htmlFor="cpu-workers" data-testid="value-cpu-workers">{cpuWorkers} / {maxCpuWorkers} max</output>
                </div>
                <input
                  className="cpu-worker-slider"
                  id="cpu-workers"
                  type="range"
                  min={1}
                  max={maxCpuWorkers}
                  step={1}
                  value={cpuWorkers}
                  disabled={searching}
                  onChange={(event) => setCpuWorkers(Number(event.target.value))}
                  aria-label="Number of CPU workers"
                  data-testid="input-cpu-workers"
                />
                <p className="hint">{cpuWorkers === maxCpuWorkers ? `Using all ${maxCpuWorkers} available CPU worker${maxCpuWorkers === 1 ? '' : 's'} (maximum 32).` : 'Lower this number to leave more CPU capacity for other work.'}</p>
              </div>
            </div>

            {mode === 'secure' ? (
              <div className="mode-note" data-testid="status-secure-mode">
                <ShieldCheck aria-hidden="true" />
                <span><strong>Automatic search — no low/high range needed.</strong> The app generates random candidates securely in this browser and stops at the first match. Keep this device private while searching.</span>
              </div>
            ) : (
              <div data-testid="panel-custom-range">
                <div className="range-fields">
                  <div>
                    <label className="field-label" htmlFor="range-start">Low private-key bound (hex)</label>
                    <input className="range-input" id="range-start" disabled={searching} value={rangeStart} onChange={(event) => { clearResumePreference(); setRangeStart(event.target.value.replace(/[^0-9a-f]/gi, '').slice(0, 64)); }} placeholder="000000… (start)" autoComplete="off" data-testid="input-range-start" />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="range-end">High private-key bound (hex)</label>
                    <input className="range-input" id="range-end" disabled={searching} value={rangeEnd} onChange={(event) => { clearResumePreference(); setRangeEnd(event.target.value.replace(/[^0-9a-f]/gi, '').slice(0, 64)); }} placeholder="000000… (end)" autoComplete="off" data-testid="input-range-end" />
                  </div>
                </div>
                <label className="confirm-row">
                  <input type="checkbox" disabled={searching} checked={rangeAccepted} onChange={(event) => setRangeAccepted(event.target.checked)} data-testid="checkbox-range-risk" />
                  <span>I understand this scan displays every checked address and full WIF private key here. I will never use these keys to hold funds.</span>
                </label>
                <label className="confirm-row">
                  <input
                    type="checkbox"
                    checked={autoContinueRange}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      autoContinueRangeRef.current = checked;
                      setAutoContinueRange(checked);
                    }}
                    data-testid="checkbox-auto-continue-range"
                  />
                  <span>Automatically generate the next same-size block when this block finishes. Turn this off to pause after the current block.</span>
                </label>
                {autoResumeEnabled && <p className="hint" role="status" data-testid="status-range-autoresume">Automatic restart is enabled for this tab. Only the original low, last generated high, address format, and block size are saved here; generated addresses and WIF keys are not saved.</p>}
                <p className="hint">Leave the exact-address and pattern fields blank to generate every key/address from low to high, without looking for a match. The full history stops at 100,000,000,000,000 entries to protect browser memory.</p>
              </div>
            )}

            <button className="primary-button" type="submit" disabled={searchStatus === 'stopping' || (!searching && mode === 'range' && !rangeAccepted)} data-testid="button-start-search">
              {searching ? <CircleAlert aria-hidden="true" /> : <Fingerprint aria-hidden="true" />}
              {searching ? 'Stop search' : mode === 'range' && !target.trim() && !exactTarget.trim() ? canContinueRange ? 'Generate next block' : 'Generate all addresses' : 'Start local search'}
              {!searching && <ArrowUpRight aria-hidden="true" />}
            </button>
            {notice && <div className="range-warning" role="status" data-testid="status-search-notice">{notice}</div>}
          </form>

          <aside className="side-stack">
            <section className="panel side-panel">
              <h2 className="side-title"><LockKeyhole aria-hidden="true" /> Your keys stay yours</h2>
              <ul className="privacy-list">
                <li><Check aria-hidden="true" /><span>Private keys are created on this device.</span></li>
                <li><Check aria-hidden="true" /><span>Nothing is sent to a server or saved to an account.</span></li>
                <li><Check aria-hidden="true" /><span>Keep the result offline and back it up securely.</span></li>
              </ul>
            </section>

            <section className="panel price-card" aria-label="Bitcoin price">
              <h2 className="side-title"><Bitcoin aria-hidden="true" /> BTC / USD</h2>
              <div className="price-value" data-testid="value-btc-usd">{formattedPrice}</div>
              {priceChange !== null && <div className="price-change" data-testid="text-btc-change">{priceChange >= 0 ? '+' : ''}{priceChange.toFixed(2)}% over 24 hours</div>}
              <div className="price-footer">
                <span>{priceState === 'ready' ? 'Market reference' : priceState === 'error' ? 'Unable to refresh' : 'Fetching market price'}</span>
                {priceState === 'error' && <button className="small-button" type="button" data-testid="button-retry-price" onClick={() => { setPriceState('loading'); void fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true').then((response) => { if (!response.ok) throw new Error(); return response.json(); }).then((result) => { if (typeof result?.bitcoin?.usd === 'number') { setPrice(result.bitcoin.usd); setPriceChange(typeof result.bitcoin.usd_24h_change === 'number' ? result.bitcoin.usd_24h_change : null); setPriceState('ready'); } else setPriceState('error'); }).catch(() => setPriceState('error')); }}><RotateCw /> Retry</button>}
              </div>
            </section>

            <section className="panel side-panel">
              <h2 className="side-title"><SlidersHorizontal aria-hidden="true" /> Search, at a glance</h2>
              <ul className="privacy-list">
                <li><Sparkles aria-hidden="true" /><span>Longer patterns take exponentially more time.</span></li>
                <li><Globe2 aria-hidden="true" /><span>Price is a public market reference, not part of key generation.</span></li>
              </ul>
            </section>
          </aside>
        </section>

        <section className="panel result-panel" aria-label="Search result">
          <div className="result-head">
            <div>
              <div className="section-kicker"><span className="step-number">02</span> Search status &amp; result</div>
              <div className="subhead">Range searches show each checked address and its private key in the history below.</div>
            </div>
              <div className={`status-pill ${searching ? 'status-running' : ''}`} data-testid="status-search"><span className="status-dot" /> {searchStatus === 'ready' ? 'READY · NOT RUNNING' : searchStatus === 'running' ? 'SEARCHING LOCALLY' : searchStatus === 'stopping' ? 'STOPPING SEARCH' : searchStatus === 'found' ? 'MATCH FOUND' : searchStatus === 'exhausted' || searchStatus === 'generated' ? 'RANGE COMPLETE' : searchStatus === 'stopped' ? 'SEARCH STOPPED' : searchStatus === 'limit' ? 'HISTORY LIMIT REACHED' : 'SEARCH ERROR'}</div>
          </div>
          {!result && <div className="result-empty" data-testid="state-no-result">
            <strong>{searching ? 'Working on this device' : searchStatus === 'exhausted' ? 'No match in this range' : searchStatus === 'generated' ? 'Range generation complete' : searchStatus === 'stopped' ? 'Search stopped' : searchStatus === 'limit' ? 'History safety limit reached' : 'Waiting for a local search'}</strong>
            {searching
              ? 'The worker is processing candidates locally. Range addresses and private keys appear in the history as they are generated.'
              : searchStatus === 'exhausted'
                ? 'Try a different pattern or a wider range. Every key in the range has now been checked.'
                : searchStatus === 'generated'
                  ? `All ${attempts.toLocaleString()} addresses and private keys from the selected range are listed below.`
                  : searchStatus === 'limit'
                    ? 'The search stopped to keep the browser responsive. Narrow the range and start another search.'
                    : 'A real result appears here only when the local search finds a match. No sample address or key is displayed.'}
          </div>}
          {result && <div className="result-main" style={{ marginTop: 16 }}>
            <div className="address-box">
              <div className="result-label">Matched Bitcoin address</div>
              <div className="address-text" data-testid="value-result-address">{result.address}</div>
              <div className="result-actions">
                <button className="small-button" type="button" onClick={() => void copyValue(result.address, 'Address')} data-testid="button-copy-address"><Copy /> Copy address</button>
                <button className="small-button" type="button" onClick={() => void copyValue(result.privateKeyWif, 'Private key')} data-testid="button-copy-private-key"><Copy /> Copy private key</button>
              </div>
            </div>
            <div className="private-box">
              <div className="result-label">Private key · WIF</div>
              <div className="private-value" data-testid="value-masked-private-key">{showPrivateKey ? result.privateKeyWif : '••••••••••••••••••••••••••••••••••••'}</div>
              <div className="result-actions">
                <button className="small-button" type="button" onClick={() => setShowPrivateKey((visible) => !visible)} aria-label={showPrivateKey ? 'Hide private key' : 'Reveal private key'} data-testid="button-reveal-private-key"><Eye /> {showPrivateKey ? 'Hide key' : 'Reveal key'}</button>
              </div>
            </div>
          </div>}
          <div className="progress-track" aria-label="Search progress"><div className="progress-fill" data-testid="progress-search" style={{ width: `${progressPercent ?? (searching ? 12 : 0)}%` }} /></div>
          <div className="progress-meta"><span data-testid="text-attempt-count">{attempts.toLocaleString()} {searchStatus === 'generated' ? 'addresses generated' : 'candidates checked'}{elapsedMs > 0 ? ` · ${(elapsedMs / 1000).toFixed(1)}s` : ''}</span><span data-testid="text-search-rate">{elapsedMs > 0 ? `${Math.round(attempts / (elapsedMs / 1000)).toLocaleString()} keys / sec` : '— keys / sec'}</span></div>
          {candidateRecords.length > 0 && <section className="history-section" aria-label="Scanned addresses and private keys" data-testid="section-candidate-history">
            <div className="history-heading">
              <div>
                <div className="result-label">Custom range history</div>
                <div className="history-count" data-testid="text-history-count">{candidateRecords.length.toLocaleString()} addresses and private keys</div>
              </div>
              <div className="history-page-label" data-testid="text-history-page">Page {historyPage + 1} of {historyPageCount}</div>
            </div>
            <div className="history-warning" role="alert">
              This list contains full private keys. Anyone who sees or copies one can spend any funds sent to its address. Generated rows exist only in memory and clear on refresh, a new search, or when the tab closes. If automatic restart is enabled, this tab remembers only the original low, last generated high, format, and block size so it can rebuild the list.
            </div>
            <div className="history-table-wrap">
              <table className="history-table">
                <thead>
                  <tr><th scope="col">Candidate</th><th scope="col">Bitcoin address</th><th scope="col">Private key · WIF</th></tr>
                </thead>
                <tbody>
                  {visibleHistory.map((record) => (
                    <tr key={record.index} data-testid={`row-candidate-${record.index}`}>
                      <td>{record.index.toLocaleString()}</td>
                      <td><code data-testid={`value-address-${record.index}`}>{record.address}</code></td>
                      <td><code data-testid={`value-private-key-${record.index}`}>{record.privateKeyWif}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="history-pagination">
              <button className="small-button download-addresses-button" type="button" disabled={searching || autoResumePending} onClick={checkGeneratedBalances} data-testid="button-check-generated-balances"><ArrowUpRight aria-hidden="true" /> Check generated balances</button>
              <button className="small-button download-addresses-button" type="button" onClick={() => void copyAllAddresses()} data-testid="button-copy-all-addresses"><Copy aria-hidden="true" /> Copy all addresses</button>
              <button className="small-button download-addresses-button" type="button" onClick={downloadAddressesCsv} data-testid="button-download-addresses-csv"><Download aria-hidden="true" /> Download addresses CSV</button>
              <button className="small-button download-addresses-button" type="button" onClick={downloadAddressesTxt} data-testid="button-download-addresses-txt"><Download aria-hidden="true" /> Download addresses TXT</button>
              {historyPageCount > 1 && <>
                <button className="small-button" type="button" disabled={historyPage === 0} onClick={() => setHistoryPage((page) => Math.max(0, page - 1))} data-testid="button-history-newer">Earlier addresses</button>
                <button className="small-button" type="button" disabled={historyPage >= historyPageCount - 1} onClick={() => setHistoryPage((page) => Math.min(historyPageCount - 1, page + 1))} data-testid="button-history-older">Later addresses</button>
              </>}
            </div>
          </section>}
        </section>

        <footer className="footer-note">
          <span><KeyRound aria-hidden="true" /> Never share a private key. Anyone who has it can spend the funds.</span>
          <DonationAddress />
          <span><LockKeyhole aria-hidden="true" /> No login · no cloud storage</span>
        </footer>
      </main>
    </div>
  );
}

function Router() {
  const [location] = useLocation();
  const isHome = location === '/';
  const isBitcoinPuzzle = location === '/bitcoin-puzzle';
  const isPuzzleAddressLookup = location === '/puzzle-address-lookup';
  const isBitcoinBalance = location === '/balance-check';
  const isBitcoinRangeLookup = location === '/range-lookup';
  const isSelfTest = location === '/self-test';

  return (
    <RoutedErrorBoundary>
      <div hidden={!isHome} data-testid="preserved-generator-page">
        <Home />
      </div>
      <div hidden={!isBitcoinPuzzle} className="app-shell">
        <SiteHeader activePage="puzzle">
          <span>LOCAL PUZZLE INDEX</span>
        </SiteHeader>
        <BitcoinPuzzlePage active={isBitcoinPuzzle} />
      </div>
      <div hidden={!isPuzzleAddressLookup} className="app-shell">
        <SiteHeader activePage="puzzle">
          <span>PUZZLE ADDRESS LOOKUP</span>
        </SiteHeader>
        <BitcoinPuzzleAddressLookupPage active={isPuzzleAddressLookup} />
      </div>
      <div hidden={!isBitcoinBalance} className="app-shell">
        <SiteHeader activePage="balance">
          <span>BULK BALANCE CHECK</span>
        </SiteHeader>
        <BitcoinBalancePage active={isBitcoinBalance} />
      </div>
      <div hidden={!isBitcoinRangeLookup} className="app-shell">
        <SiteHeader activePage="range-lookup">
          <span>LOCAL RANGE LOOKUP</span>
        </SiteHeader>
        <BitcoinRangeLookupPage active={isBitcoinRangeLookup} />
      </div>
      <div hidden={!isSelfTest} className="app-shell">
        <SiteHeader activePage="self-test">
          <span>LOCAL DIAGNOSTICS</span>
        </SiteHeader>
        <SelfTestPage />
      </div>
      {!isHome && !isBitcoinPuzzle && !isPuzzleAddressLookup && !isBitcoinBalance && !isBitcoinRangeLookup && !isSelfTest && (
        <Switch>
          <Route component={NotFound} />
        </Switch>
      )}
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
