import { useEffect, useRef, useState } from 'react';
import DonationAddress from '@/components/donation-address';
import {
  AlertCircle,
  Check,
  Download,
  Eraser,
  FileUp,
  LoaderCircle,
  Search,
  Square,
} from 'lucide-react';
import { isValidMainnetBitcoinAddress } from '@/lib/bitcoin';
import { takeQueuedBalanceCheck } from '@/lib/balance-check-transfer';
import {
  fetchEvmBalanceBatch,
  EVM_ADDRESSES_PER_REQUEST,
  isValidEvmAddress,
  MULTI_CHAIN_OPTIONS,
  type MultiChainName,
} from '@/lib/multichain';
import './bitcoin-balance.css';

const MAX_ADDRESSES = 1_000_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const ADDRESSES_PER_REQUEST = 100;
const EVM_BATCH_INTERVAL_MS = 1000;
const MAX_CONCURRENT_REQUESTS = 2;
const UI_UPDATE_INTERVAL_MS = 500;
const BALANCE_API = 'https://blockchain.info/balance';

type ApiBalance = { final_balance?: number };
type FundedAddress = { address: string; balanceSats?: number; balanceWei?: bigint };
type PageStatus = 'ready' | 'preparing' | 'running' | 'complete' | 'stopped' | 'error';

function formatNativeBalance(balanceWei: bigint): string {
  const whole = balanceWei / 1_000_000_000_000_000_000n;
  const fractional = (balanceWei % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, '0')
    .slice(0, 8);
  return `${whole}.${fractional}`;
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('The request was cancelled.', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchBalanceBatch(
  addresses: string[],
  signal: AbortSignal,
): Promise<FundedAddress[]> {
  const query = new URLSearchParams({
    active: addresses.join('|'),
    cors: 'true',
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${BALANCE_API}?${query}`, { signal });
    } catch (error) {
      if (signal.aborted) throw error;
      if (attempt === 4) {
        throw new Error('Network request failed after five attempts.');
      }
      await waitForRetry(Math.min(1000 * 2 ** attempt, 30_000), signal);
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 4) {
        throw new Error(`Balance provider returned HTTP ${response.status}.`);
      }
      const retryAfter = Number(response.headers.get('Retry-After'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30_000)
        : Math.min(1000 * 2 ** attempt, 30_000);
      await waitForRetry(delay, signal);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Balance provider returned HTTP ${response.status}.`);
    }

    const balances = await response.json() as Record<string, ApiBalance>;
    return addresses.flatMap((address) => {
      const balanceSats = balances[address]?.final_balance;
      return typeof balanceSats === 'number' && balanceSats > 0
        ? [{ address, balanceSats }]
        : [];
    });
  }

  return [];
}

export default function BitcoinBalancePage({ active }: { active: boolean }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const [fileName, setFileName] = useState('');
  const [status, setStatus] = useState<PageStatus>('ready');
  const [notice, setNotice] = useState('');
  const [chain, setChain] = useState<MultiChainName>('btc');
  const [totalAddresses, setTotalAddresses] = useState(0);
  const [invalidCount, setInvalidCount] = useState(0);
  const [checkedCount, setCheckedCount] = useState(0);
  const [fundedAddresses, setFundedAddresses] = useState<FundedAddress[]>([]);

  useEffect(() => {
    if (active) document.title = 'Bitcoin Balance Check | LUCKY BTC';
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const queued = takeQueuedBalanceCheck();
    if (!queued) return;
    if (!inputRef.current) {
      setStatus('error');
      setNotice('Could not load the generated addresses into the balance checker.');
      return;
    }
    inputRef.current.value = queued.addresses.join('\n');
    setChain(queued.chain);
    setFileName('');
    void startCheck(queued.chain);
  }, [active]);

  async function loadFile(file: File | undefined) {
    if (!file || !inputRef.current) return;
    if (file.size > MAX_FILE_BYTES) {
      setNotice('Choose a text or CSV file smaller than 64 MB.');
      return;
    }
    inputRef.current.value = await file.text();
    setFileName(file.name);
    setNotice('');
  }

  function clearAddresses() {
    if (inputRef.current) inputRef.current.value = '';
    if (fileRef.current) fileRef.current.value = '';
    setFileName('');
    setStatus('ready');
    setNotice('');
    setTotalAddresses(0);
    setInvalidCount(0);
    setCheckedCount(0);
    setFundedAddresses([]);
  }

  async function startCheck(selectedChain: MultiChainName = chain) {
    const rawInput = inputRef.current?.value ?? '';
    const entries = rawInput.split(/[\s,;]+/).filter(Boolean);
    const uniqueEntries = [...new Set(entries)];
    const duplicateCount = entries.length - uniqueEntries.length;
    if (uniqueEntries.length === 0) {
      setNotice(selectedChain === 'btc' ? 'Paste or upload Bitcoin addresses to check.' : `Paste or upload ${MULTI_CHAIN_OPTIONS.find((option) => option.id === selectedChain)?.label ?? 'chain'} addresses to check.`);
      return;
    }
    if (uniqueEntries.length > MAX_ADDRESSES) {
      setNotice(`The limit is ${MAX_ADDRESSES.toLocaleString()} unique addresses per run.`);
      return;
    }

    if (selectedChain !== 'btc') {
      const validAddresses = uniqueEntries.filter((address) => isValidEvmAddress(address));
      const rejected = uniqueEntries.length - validAddresses.length;
      setStatus('preparing');
      setNotice('Validating addresses locally…');
      setFundedAddresses([]);
      setCheckedCount(0);
      setInvalidCount(rejected + duplicateCount);
      setTotalAddresses(validAddresses.length);
      if (validAddresses.length === 0) {
        setStatus('error');
        setNotice(`No valid ${MULTI_CHAIN_OPTIONS.find((option) => option.id === selectedChain)?.label ?? 'EVM'} addresses were found in that list.`);
        return;
      }

      const controller = new AbortController();
      controllerRef.current = controller;
      const funded: FundedAddress[] = [];
      let checked = 0;
      let nextIndex = 0;
      setStatus('running');
      setNotice('Checking balances in smaller batches to avoid provider rate limits.');

      try {
        while (!controller.signal.aborted && nextIndex < validAddresses.length) {
          const batch = validAddresses.slice(
            nextIndex,
            nextIndex + EVM_ADDRESSES_PER_REQUEST,
          );
          nextIndex += batch.length;
          const result = await fetchEvmBalanceBatch(selectedChain, batch, controller.signal);
          funded.push(...result.map((entry) => ({ address: entry.address, balanceWei: entry.balanceWei })));
          checked += batch.length;
          setCheckedCount(checked);
          setFundedAddresses([...funded]);
          if (nextIndex < validAddresses.length) {
            await waitForRetry(EVM_BATCH_INTERVAL_MS, controller.signal);
          }
        }
      } catch (error) {
        controllerRef.current = null;
        if (controller.signal.aborted) {
          setStatus('stopped');
          setNotice('Balance check stopped.');
        } else {
          setStatus('error');
          setNotice(error instanceof Error ? error.message : 'The balance lookup failed.');
        }
        return;
      }

      controllerRef.current = null;
      setCheckedCount(checked);
      setFundedAddresses([...funded]);
      setStatus('complete');
      setNotice(`Finished. ${funded.length.toLocaleString()} addresses have a positive balance.`);
      return;
    }

    setStatus('preparing');
    setNotice('Validating addresses locally…');
    setFundedAddresses([]);
    setCheckedCount(0);
    setInvalidCount(0);
    setTotalAddresses(0);

    const validAddresses: string[] = [];
    let rejected = 0;
    for (let index = 0; index < uniqueEntries.length; index += 1) {
      const address = uniqueEntries[index];
      if (isValidMainnetBitcoinAddress(address)) validAddresses.push(address);
      else rejected += 1;
      if (index > 0 && index % 5000 === 0) {
        setNotice(`Validating ${index.toLocaleString()} of ${uniqueEntries.length.toLocaleString()} addresses…`);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }

    setInvalidCount(rejected + duplicateCount);
    setTotalAddresses(validAddresses.length);
    if (validAddresses.length === 0) {
      setStatus('error');
      setNotice('No valid mainnet Bitcoin addresses were found in that list.');
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    let nextIndex = 0;
    let checked = 0;
    let lastUiUpdate = 0;
    const providerErrors: Error[] = [];
    const funded: FundedAddress[] = [];

    async function runWorker() {
      while (!controller.signal.aborted) {
        const start = nextIndex;
        nextIndex += ADDRESSES_PER_REQUEST;
        if (start >= validAddresses.length) return;
        const batch = validAddresses.slice(start, start + ADDRESSES_PER_REQUEST);

        try {
          funded.push(...await fetchBalanceBatch(batch, controller.signal));
        } catch (error) {
          if (!controller.signal.aborted) {
            providerErrors.push(error instanceof Error ? error : new Error('Balance lookup failed.'));
            controller.abort();
          }
          return;
        }

        checked += batch.length;
        const now = Date.now();
        if (
          now - lastUiUpdate >= UI_UPDATE_INTERVAL_MS ||
          checked === validAddresses.length
        ) {
          lastUiUpdate = now;
          setCheckedCount(checked);
          setFundedAddresses([...funded]);
        }
      }
    }

    setStatus('running');
    setNotice('Checking balances in batches. The provider may slow large runs.');
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_REQUESTS, Math.ceil(validAddresses.length / ADDRESSES_PER_REQUEST)) },
        () => runWorker(),
      ),
    );
    controllerRef.current = null;
    setCheckedCount(checked);
    setFundedAddresses([...funded]);

    if (providerErrors.length > 0) {
      setStatus('error');
      setNotice(`${providerErrors[0].message} Checked ${checked.toLocaleString()} addresses before stopping.`);
    } else if (controller.signal.aborted) {
      setStatus('stopped');
      setNotice(`Stopped after checking ${checked.toLocaleString()} addresses.`);
    } else {
      setStatus('complete');
      setNotice(`Finished. ${funded.length.toLocaleString()} addresses have a positive balance.`);
    }
  }

  function stopCheck() {
    controllerRef.current?.abort();
  }

  function downloadFundedCsv() {
    if (fundedAddresses.length === 0) return;
    const rows = chain === 'btc'
      ? [
          'address,balance_btc,balance_sats',
          ...fundedAddresses.map(({ address, balanceSats }) =>
            `${address},${((balanceSats ?? 0) / 100_000_000).toFixed(8)},${balanceSats ?? 0}`,
          ),
        ]
      : [
          'address,balance_eth,balance_wei',
          ...fundedAddresses.map(({ address, balanceWei }) =>
            `${address},${formatNativeBalance(balanceWei ?? 0n)},${(balanceWei ?? 0n).toString()}`,
          ),
        ];
    const file = new Blob([rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${chain}-funded-addresses.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const busy = status === 'preparing' || status === 'running';
  const progress = totalAddresses > 0
    ? Math.min(100, (checkedCount / totalAddresses) * 100)
    : 0;

  const networkLabel = chain === 'btc'
    ? 'Bitcoin'
    : MULTI_CHAIN_OPTIONS.find((option) => option.id === chain)?.label ?? 'EVM';

  return (
    <main className="balance-page" data-testid="page-bitcoin-balance">
      <header className="balance-intro">
        <div className="balance-kicker"><Search aria-hidden="true" /> Public address lookup</div>
        <h1>{networkLabel} Balance Check</h1>
        <p>Check up to one million mainnet addresses from a text list or CSV file.</p>
      </header>

      <section className="balance-workspace" aria-label="Bulk balance check">
        <div className="balance-panel">
          <div className="balance-panel-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div>
              <p className="balance-label">ADDRESS LIST</p>
              <h2>Paste or upload addresses</h2>
            </div>
            <label className="finder-field" style={{ minWidth: 180 }}>
              <span>Chain</span>
              <select value={chain} onChange={(event) => setChain(event.target.value as MultiChainName)} disabled={busy}>
                {MULTI_CHAIN_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            {fileName && <span className="balance-file-name">{fileName}</span>}
          </div>
          <textarea
            ref={inputRef}
            className="balance-address-input"
            disabled={busy}
            placeholder={chain === 'btc'
              ? 'One Bitcoin address per line, or comma-separated'
              : 'One EVM address per line, or comma-separated'}
            spellCheck={false}
            data-testid="input-balance-addresses"
          />
          <div className="balance-controls">
            <label className="balance-upload-button">
              <FileUp aria-hidden="true" />
              Upload TXT / CSV
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.csv,text/plain,text/csv"
                disabled={busy}
                onChange={(event) => void loadFile(event.target.files?.[0])}
                data-testid="input-balance-file"
              />
            </label>
            <button
              className="balance-clear-button"
              type="button"
              disabled={busy}
              onClick={clearAddresses}
              data-testid="button-clear-balance-check"
            >
              <Eraser aria-hidden="true" /> Clear
            </button>
            {status === 'running' ? (
              <button className="balance-start-button is-stop" type="button" onClick={stopCheck} data-testid="button-stop-balance-check">
                <Square aria-hidden="true" /> Stop check
              </button>
            ) : (
              <button className="balance-start-button" type="button" disabled={busy} onClick={() => void startCheck()} data-testid="button-start-balance-check">
                {busy ? <LoaderCircle className="balance-spinner" aria-hidden="true" /> : <Search aria-hidden="true" />}
                {status === 'preparing' ? 'Validating…' : 'Check balances'}
              </button>
            )}
          </div>
          <p className="balance-provider-note">
            {chain === 'btc'
              ? 'Addresses are validated in your browser, then sent to Blockchain.com in batches of 100. Two requests run at a time; provider rate limits affect large lists. No private keys are requested or uploaded.'
              : `Addresses are validated locally and checked through the ${MULTI_CHAIN_OPTIONS.find((option) => option.id === chain)?.label ?? 'selected chain'} RPC endpoint. No private keys are requested or uploaded.`}
          </p>
        </div>

        <section className="balance-results" aria-labelledby="balance-results-title">
          <div className="balance-results-heading">
            <div>
              <p className="balance-label">CHECK RESULTS</p>
              <h2 id="balance-results-title">Positive balances</h2>
            </div>
            {fundedAddresses.length > 0 && (
              <button className="balance-download-button" type="button" onClick={downloadFundedCsv} data-testid="button-download-funded-csv">
                <Download aria-hidden="true" /> CSV
              </button>
            )}
          </div>

          <div className="balance-progress-meta" aria-live="polite">
            <span>{checkedCount.toLocaleString()} / {totalAddresses.toLocaleString()} checked</span>
            <span>{invalidCount.toLocaleString()} invalid or duplicate</span>
          </div>
          <div className="balance-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
            <span style={{ width: `${progress}%` }} />
          </div>

          {notice && (
            <p className={`balance-status is-${status}`} role="status" data-testid="status-balance-check">
              {status === 'error' ? <AlertCircle aria-hidden="true" /> : status === 'complete' ? <Check aria-hidden="true" /> : status === 'running' || status === 'preparing' ? <LoaderCircle className="balance-spinner" aria-hidden="true" /> : null}
              {notice}
            </p>
          )}

          {fundedAddresses.length > 0 ? (
            <div className="balance-table-wrap">
              <table className="balance-table">
                <thead><tr><th scope="col">Address</th><th scope="col">Balance</th><th scope="col">Satoshis</th></tr></thead>
                <tbody>
                  {fundedAddresses.map(({ address, balanceSats, balanceWei }) => (
                    <tr key={address}>
                      <td><code>{address}</code></td>
                      <td>{chain === 'btc'
                        ? `${((balanceSats ?? 0) / 100_000_000).toFixed(8)} BTC`
                        : `${formatNativeBalance(balanceWei ?? 0n)} ${MULTI_CHAIN_OPTIONS.find((option) => option.id === chain)?.symbol ?? 'ETH'}`}
                      </td>
                      <td>{chain === 'btc' ? (balanceSats ?? 0).toLocaleString() : (balanceWei ?? 0n).toString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="balance-empty">Positive-balance addresses will appear here.</p>
          )}
        </section>
      </section>
      <footer className="donation-page-footer">
        <DonationAddress />
      </footer>
    </main>
  );
}