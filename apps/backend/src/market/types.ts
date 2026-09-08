export const CROSS_EX_MARKET_VENUES = ['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT'] as const;

export type CrossExMarketVenue = typeof CROSS_EX_MARKET_VENUES[number];
export type LiveMarketVenue = CrossExMarketVenue | 'LIGHTER';
export type MarketConnectionState = 'connecting' | 'healthy' | 'reconnecting' | 'stale' | 'disconnected';
export type LiveMarketSource = 'gate_crossex_websocket' | 'lighter_public_websocket' | 'demo_seed';

export interface LiveMarket {
  symbol: string;
  venue: LiveMarketVenue;
  asset: string;
  lastPrice: string;
  bidPrice: string;
  bidSize: string;
  askPrice: string;
  askSize: string;
  open24h: string;
  high24h: string;
  low24h: string;
  volume24h: string;
  quoteVolume24h: string;
  fundingRate: string;
  nextFundingAt: string;
  openInterest: string;
  openInterestValue: string;
  /** Local receipt time for the source quote. */
  receivedAt: string;
  /** Source-provided timestamp for the source quote. */
  updatedAt: string;
  source: LiveMarketSource;
}

export interface MarketSnapshot {
  connectionState: MarketConnectionState;
  updatedAt: string;
  markets: LiveMarket[];
}

/** CrossEx instrument definitions remain separate from funding-only venues. */
export interface MarketDefinition {
  symbol: string;
  venue: CrossExMarketVenue;
  asset: string;
}
