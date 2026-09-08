import { describe, expect, it } from 'vitest';
import { parseStoredFavorites } from './local-preferences.js';

describe('local preferences', () => {
  it('preserves existing favorites alongside a native Lighter favorite', () => {
    const symbols = ['GATE_FUTURE_BTC_USDT', 'BINANCE_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT',
      'BYBIT_FUTURE_BTC_USDT', 'KRAKEN_FUTURE_BTC_USD', 'HYPERLIQUID_FUTURE_BTC_USDC',
      'DERIBIT_FUTURE_BTC_USDC', 'LIGHTER_FUTURE_BTC_USDC'];
    expect(parseStoredFavorites(JSON.stringify([...symbols, 'UNKNOWN_FUTURE_BTC_USDC', 'LIGHTER_FUTURE_BTC_USDC']))).toEqual(symbols);
  });
  it('returns an empty list for missing, corrupt, or wrongly shaped browser storage', () => {
    expect(parseStoredFavorites(null)).toEqual([]);
    expect(parseStoredFavorites('{broken')).toEqual([]);
    expect(parseStoredFavorites('{"symbol":"GATE_FUTURE_BTC_USDT"}')).toEqual([]);
  });

  it('keeps only unique supported CrossEx symbols', () => {
    expect(parseStoredFavorites(JSON.stringify([
      'GATE_FUTURE_BTC_USDT',
      'GATE_FUTURE_BTC_USDT',
      'unknown',
      42,
      'BINANCE_FUTURE_ETH_USDC',
    ]))).toEqual([
      'GATE_FUTURE_BTC_USDT',
      'BINANCE_FUTURE_ETH_USDC',
    ]);
  });
});
