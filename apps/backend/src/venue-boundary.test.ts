import { describe, expect, it } from 'vitest';
import { CreateStrategyInputSchema } from './trading-runtime.js';

describe('CrossEx strategy boundary', () => {
  it('rejects Lighter while preserving every existing CrossEx venue', () => {
    const input = { kind: 'position', asset: 'BTC', leftVenue: 'GATE', rightVenue: 'BINANCE',
      leftSide: 'SELL', rightSide: 'BUY', entryBps: '0', totalAmount: '100', perOrderQuantity: '10',
      reduceOnly: false, executionMethod: 'TAKER_TAKER' };
    expect(CreateStrategyInputSchema.safeParse({ ...input, leftVenue: 'LIGHTER' }).success).toBe(false);
    for (const leftVenue of ['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT']) {
      expect(CreateStrategyInputSchema.safeParse({ ...input, leftVenue, rightVenue: leftVenue === 'BINANCE' ? 'GATE' : 'BINANCE' }).success).toBe(true);
    }
  });
});
