import { describe, expect, it, vi } from 'vitest';
import type { LiveMarket, MarketConnectionState } from './types.js';
import { CompositeMarketSource, type CompositeMarketDelegate } from './composite-market-source.js';

const crossExMarket: LiveMarket = {
  symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', asset: 'BTC', lastPrice: '100', bidPrice: '99.9', bidSize: '1',
  askPrice: '100.1', askSize: '1', open24h: '99', high24h: '101', low24h: '98', volume24h: '10',
  quoteVolume24h: '1000', fundingRate: '0.0001', nextFundingAt: new Date(0).toISOString(), openInterest: '1',
  openInterestValue: '100', receivedAt: new Date(1_771_990_800_000).toISOString(),
  updatedAt: new Date(1_771_990_800_000).toISOString(), source: 'gate_crossex_websocket',
};
const lighterMarket: LiveMarket = { ...crossExMarket, symbol: 'LIGHTER_FUTURE_BTC_USDC', venue: 'LIGHTER',
  bidPrice: '100.2', askPrice: '100.3', source: 'lighter_public_websocket' };

function createDelegates() {
  const crossEx: CompositeMarketDelegate = {
    market: vi.fn((symbol: string) => symbol === crossExMarket.symbol ? crossExMarket : null),
    ensureMarket: vi.fn((symbol: string) => symbol === crossExMarket.symbol),
    connectionState: vi.fn(() => 'healthy' as const),
  };
  let lighterState: MarketConnectionState = 'healthy';
  const lighter = {
    market: vi.fn((symbol: string) => symbol === lighterMarket.symbol ? lighterMarket : null),
    ensureMarket: vi.fn((symbol: string) => symbol === lighterMarket.symbol),
    connectionState: vi.fn(() => lighterState),
    connectionStateFor: vi.fn(() => lighterState),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    setState: (state: MarketConnectionState) => { lighterState = state; },
  };
  return { crossEx, lighter, setLighterState: lighter.setState };
}

describe('CompositeMarketSource routing', () => {
  it('routes explicit Lighter funding symbols to Lighter and CrossEx symbols to CrossEx', () => {
    const delegates = createDelegates();
    const source = new CompositeMarketSource(delegates.crossEx, delegates.lighter);

    expect(source.market(crossExMarket.symbol)).toBe(crossExMarket);
    expect(source.market(lighterMarket.symbol)).toBe(lighterMarket);
    expect(source.ensureMarket(crossExMarket.symbol)).toBe(true);
    expect(source.ensureMarket(lighterMarket.symbol)).toBe(true);
    expect(delegates.crossEx.market).toHaveBeenCalledWith(crossExMarket.symbol);
    expect(delegates.lighter.market).toHaveBeenCalledWith(lighterMarket.symbol);
    expect(delegates.crossEx.ensureMarket).toHaveBeenCalledWith(crossExMarket.symbol);
    expect(delegates.lighter.ensureMarket).toHaveBeenCalledWith(lighterMarket.symbol);
  });

  it('keeps CrossEx health usable while Lighter is disconnected', () => {
    const delegates = createDelegates();
    const source = new CompositeMarketSource(delegates.crossEx, delegates.lighter);
    delegates.setLighterState('disconnected');

    expect(source.connectionStateFor(lighterMarket.symbol)).toBe('disconnected');
    expect(source.connectionStateFor(crossExMarket.symbol)).toBe('healthy');
    expect(source.connectionState()).toBe('healthy');
    expect(source.market(crossExMarket.symbol)).toBe(crossExMarket);
  });

  it('delegates Lighter lifecycle without owning the CrossEx socket', async () => {
    const delegates = createDelegates();
    const source = new CompositeMarketSource(delegates.crossEx, delegates.lighter);

    await source.start();
    await source.stop();

    expect(delegates.lighter.start).toHaveBeenCalledOnce();
    expect(delegates.lighter.stop).toHaveBeenCalledOnce();
  });
});
