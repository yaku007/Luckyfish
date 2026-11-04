import { HDKey } from '@scure/bip32';
import { describe, expect, it, vi } from 'vitest';
import {
  CHAIN_RPC_URLS,
  deriveAddressFromPrivateKey,
  EVM_ADDRESSES_PER_REQUEST,
  fetchEvmBalanceBatch,
  getMultiChainAddress,
  getMultiChainAddressFromHdKey,
  matchesEvmVanityPattern,
} from './multichain';
import { findHdAddressByXpub } from './hd-address-finder';

describe('multichain wallet helpers', () => {
  const privateKeyHex = '0x' + '11'.repeat(32);

  it('derives a valid EVM address for the provided private key', () => {
    const ethAddress = getMultiChainAddress(privateKeyHex, 'eth');
    expect(ethAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(getMultiChainAddress(privateKeyHex, 'bnb')).toBe(ethAddress);
  });

  it('derives the standard Ethereum address for private key one', () => {
    expect(getMultiChainAddress(`${'0'.repeat(63)}1`, 'eth')).toBe(
      '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
    );
  });

  it('matches EVM vanity prefixes and suffixes without case sensitivity', () => {
    const address = '0xAbCd00000000000000000000000000000000Ef12';
    const longPattern = 'a'.repeat(21);
    const longPatternAddress = `0x${longPattern}${'0'.repeat(15)}`;

    expect(matchesEvmVanityPattern(address, 'abcd', '')).toBe(true);
    expect(matchesEvmVanityPattern(address, '', 'EF12')).toBe(true);
    expect(matchesEvmVanityPattern(address, 'abce', '')).toBe(false);
    expect(matchesEvmVanityPattern(longPatternAddress, longPattern, '')).toBe(true);
    expect(matchesEvmVanityPattern(address, 'a'.repeat(22), '')).toBe(false);
    expect(matchesEvmVanityPattern(address, 'abcdef0', '')).toBe(false);
  });

  it('derives a selected-chain address from candidate private-key bytes', () => {
    const privateKeyBytes = Uint8Array.from(
      privateKeyHex.slice(2).match(/.{1,2}/g)!.map((byte) => Number.parseInt(byte, 16)),
    );

    expect(deriveAddressFromPrivateKey(privateKeyBytes, 'polygon')).toBe(
      getMultiChainAddress(privateKeyHex, 'polygon'),
    );
  });

  it('checks up to 100 EVM addresses in one RPC batch and matches responses by id', async () => {
    expect(EVM_ADDRESSES_PER_REQUEST).toBe(100);
    const addresses = Array.from(
      { length: EVM_ADDRESSES_PER_REQUEST },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`,
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([
        ...addresses.map((_, index) => ({
          jsonrpc: '2.0',
          id: addresses.length - index,
          result: index === addresses.length - 1 ? '0xde0b6b3a7640000' : '0x0',
        })),
      ]), { status: 200 }),
    );

    try {
      await expect(fetchEvmBalanceBatch('eth', addresses)).resolves.toEqual([
        {
          address: addresses[0],
          balanceWei: 1_000_000_000_000_000_000n,
          balanceEth: '1.00000000',
        },
      ]);
      const request = fetchSpy.mock.calls[0][1];
      const payload = JSON.parse(String(request?.body)) as Array<{ id: number }>;
      expect(payload).toHaveLength(EVM_ADDRESSES_PER_REQUEST);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('uses the public RPC endpoint for each EVM chain', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify([
        { jsonrpc: '2.0', id: 1, result: '0x0' },
      ]), {
        status: 200,
      }),
    );

    try {
      await fetchEvmBalanceBatch('eth', ['0x0000000000000000000000000000000000000001']);
      await fetchEvmBalanceBatch('bnb', ['0x0000000000000000000000000000000000000001']);
      await fetchEvmBalanceBatch('polygon', ['0x0000000000000000000000000000000000000001']);

      expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
        CHAIN_RPC_URLS.eth,
        CHAIN_RPC_URLS.bnb,
        CHAIN_RPC_URLS.polygon,
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('retries EVM RPC batches after rate limiting', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', {
        status: 429,
        headers: { 'Retry-After': '1' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { jsonrpc: '2.0', id: 1, result: '0x0' },
      ]), { status: 200 }));

    try {
      const resultPromise = fetchEvmBalanceBatch(
        'polygon',
        ['0x0000000000000000000000000000000000000001'],
      );
      await vi.advanceTimersByTimeAsync(1000);
      await expect(resultPromise).resolves.toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      fetchSpy.mockRestore();
    }
  });

  it('surfaces provider errors returned as a single JSON-RPC response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32051, message: 'API key disabled' },
      }), { status: 200 }),
    );

    try {
      await expect(fetchEvmBalanceBatch(
        'polygon',
        ['0x0000000000000000000000000000000000000001'],
      )).rejects.toThrow('POLYGON RPC request failed: API key disabled');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('derives a valid address from an HD key with a chain-specific path', () => {
    const hdKey = HDKey.fromMasterSeed(new Uint8Array(32).fill(7));
    const ethAddress = getMultiChainAddressFromHdKey(hdKey, 'eth', 0);
    const polygonAddress = getMultiChainAddressFromHdKey(hdKey, 'polygon', 1);

    expect(ethAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(polygonAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(ethAddress).not.toBe(polygonAddress);
  });

  it('matches an EVM address using an account-level xpub and index range', async () => {
    const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(7));
    const accountXpub = master.derive("m/44'/60'/0'").publicExtendedKey;
    const expectedAddress = getMultiChainAddressFromHdKey(master, 'eth', 7);

    await expect(findHdAddressByXpub({
      xpub: accountXpub,
      startIndex: 5,
      endIndex: 9,
      targetAddress: expectedAddress,
      chain: 'eth',
    })).resolves.toEqual({ index: 7, address: expectedAddress });
  });

  it('rejects private extended keys in HD lookup mode', async () => {
    const xprv = HDKey.fromMasterSeed(new Uint8Array(32).fill(8)).privateExtendedKey;

    await expect(findHdAddressByXpub({
      xpub: xprv,
      startIndex: 0,
      endIndex: 0,
      targetAddress: '0x0000000000000000000000000000000000000000',
      chain: 'eth',
    })).rejects.toThrow('Enter a mainnet xpub');
  });
});
