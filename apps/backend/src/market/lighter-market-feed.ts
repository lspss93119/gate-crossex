import WebSocket from 'ws';
import { z } from 'zod';
import type { LighterMarketDirectoryEntry } from '@gate-crossex/public-data';
import type { LiveMarket, MarketConnectionState } from './types.js';

export const DEFAULT_LIGHTER_PUBLIC_WS_URL = 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true';

const SOCKET_OPEN = 1;
const MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 45_000;
const DEFAULT_STALE_AFTER_MS = 60_000;
const DEFAULT_FUTURE_TOLERANCE_MS = 2_000;

const numericValue = z.union([z.string(), z.number().finite()]);
const timestampValue = z.union([z.string(), z.number().finite()]);
const LighterTickerFrameSchema = z.object({
  channel: z.string().regex(/^ticker:\d+$/),
  type: z.literal('update/ticker'),
  timestamp: timestampValue,
  ticker: z.object({
    s: z.string(),
    a: z.object({ price: numericValue, size: numericValue }),
    b: z.object({ price: numericValue, size: numericValue }),
  }).passthrough(),
}).passthrough();
const LighterStatsFrameSchema = z.object({
  channel: z.string().regex(/^market_stats:\d+$/),
  type: z.literal('update/market_stats'),
  timestamp: timestampValue,
  market_stats: z.object({
    symbol: z.string(),
    market_id: z.number().int().nonnegative(),
    index_price: numericValue.nullish(),
    mark_price: numericValue.nullish(),
    open_interest: numericValue.nullish(),
    last_trade_price: numericValue.nullish(),
    current_funding_rate: numericValue.nullish(),
    funding_rate: numericValue.nullish(),
    funding_timestamp: timestampValue.nullish(),
    daily_base_token_volume: numericValue.nullish(),
    daily_quote_token_volume: numericValue.nullish(),
    daily_price_low: numericValue.nullish(),
    daily_price_high: numericValue.nullish(),
    daily_price_change: numericValue.nullish(),
  }).passthrough(),
}).passthrough();

export interface LighterWebSocket {
  readonly readyState: number;
  on(event: 'open' | 'close' | 'error' | 'pong', listener: (...args: unknown[]) => void): this;
  on(event: 'message', listener: (data: { toString(): string }) => void): this;
  send(data: string): void;
  ping?(): void;
  close(): void;
  terminate?(): void;
}

export type LighterDirectoryProvider = () => Promise<LighterMarketDirectoryEntry[]>;

export interface LighterMarketFeedOptions {
  url?: string;
  directory: LighterDirectoryProvider;
  now?: () => number;
  webSocketFactory?: (url: string) => LighterWebSocket;
  /** Delay in milliseconds for reconnect attempt number zero-based. */
  backoffMs?: (attempt: number) => number;
  keepaliveIntervalMs?: number;
  staleAfterMs?: number;
  futureToleranceMs?: number;
}

interface LighterTickerState {
  bidPrice: string;
  bidSize: string;
  askPrice: string;
  askSize: string;
  sourceTimestamp: number;
  receivedAt: number;
}

interface LighterStatsState {
  indexPrice: string | null;
  markPrice: string | null;
  openInterest: string | null;
  lastPrice: string | null;
  fundingRate: string | null;
  fundingRateFallback: string | null;
  fundingTimestamp: number | null;
  baseVolume: string | null;
  quoteVolume: string | null;
  lowPrice: string | null;
  highPrice: string | null;
  change: string | null;
}

interface LighterMarketState {
  definition: { symbol: string; nativeSymbol: string; marketId: number; asset: string };
  ticker: LighterTickerState | null;
  stats: LighterStatsState;
  market: LiveMarket | null;
  connectionState: MarketConnectionState;
  lastTickerTimestamp: number | null;
  lastStatsTimestamp: number | null;
}

function emptyStats(): LighterStatsState {
  return {
    indexPrice: null, markPrice: null, openInterest: null, lastPrice: null,
    fundingRate: null, fundingRateFallback: null, fundingTimestamp: null,
    baseVolume: null, quoteVolume: null, lowPrice: null, highPrice: null, change: null,
  };
}

function finiteText(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || !Number.isFinite(Number(text))) return null;
    return text;
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

function positiveText(value: unknown): { text: string; number: number } | null {
  const text = finiteText(value);
  if (text === null) return null;
  const number = Number(text);
  return number > 0 ? { text, number } : null;
}

function nonNegativeText(value: unknown): string | null {
  const text = finiteText(value);
  return text !== null && Number(text) >= 0 ? text : null;
}

/** Lighter documents milliseconds; protect against microsecond and nanosecond payloads. */
function normalizeTimestamp(value: unknown): number | null {
  const raw = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  const milliseconds = raw >= 100_000_000_000_000_000
    ? raw / 1_000_000
    : raw >= 100_000_000_000_000
      ? raw / 1_000
      : raw;
  return Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= 8.64e15
    ? milliseconds
    : null;
}

function channelMarketId(channel: string, prefix: 'ticker' | 'market_stats'): number | null {
  const match = new RegExp(`^${prefix}:(\\d+)$`).exec(channel);
  if (!match?.[1]) return null;
  const marketId = Number(match[1]);
  return Number.isSafeInteger(marketId) && marketId >= 0 ? marketId : null;
}

function internalSymbol(nativeSymbol: string): string {
  return `LIGHTER_FUTURE_${nativeSymbol}_USDC`;
}

export function isLighterFundingSymbol(symbol: string): boolean {
  return /^LIGHTER_FUTURE_[A-Z0-9]+_USDC$/.test(symbol);
}

function directoryEntryIsEligible(entry: LighterMarketDirectoryEntry): boolean {
  return entry.marketType === 'perp'
    && entry.status === 'active'
    && /^[A-Z0-9]+$/.test(entry.symbol)
    && Number.isSafeInteger(entry.marketId)
    && entry.marketId >= 0;
}

function defaultBackoff(attempt: number): number {
  return Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.min(5, Math.max(0, attempt)));
}

export class LighterMarketFeed {
  private readonly url: string;
  private readonly directory: LighterDirectoryProvider;
  private readonly now: () => number;
  private readonly webSocketFactory: (url: string) => LighterWebSocket;
  private readonly backoffMs: (attempt: number) => number;
  private readonly keepaliveIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly futureToleranceMs: number;
  private readonly directoryBySymbol = new Map<string, { nativeSymbol: string; marketId: number; asset: string }>();
  private readonly directoryByMarketId = new Map<number, string>();
  private readonly markets = new Map<string, LighterMarketState>();
  private readonly subscribedChannels = new Set<string>();
  private socket: LighterWebSocket | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private awaitingPong = false;
  private stopped = true;
  private state: MarketConnectionState = 'disconnected';

  constructor(options: LighterMarketFeedOptions);
  constructor(url: string, directory: LighterDirectoryProvider, options?: Omit<LighterMarketFeedOptions, 'url' | 'directory'>);
  constructor(
    optionsOrUrl: LighterMarketFeedOptions | string,
    directoryProvider?: LighterDirectoryProvider,
    legacyOptions: Omit<LighterMarketFeedOptions, 'url' | 'directory'> = {},
  ) {
    const options: LighterMarketFeedOptions = typeof optionsOrUrl === 'string'
      ? { ...legacyOptions, url: optionsOrUrl, directory: directoryProvider! }
      : optionsOrUrl;
    if (!options.directory) throw new Error('Lighter directory provider is required');
    this.url = options.url ?? DEFAULT_LIGHTER_PUBLIC_WS_URL;
    this.directory = options.directory;
    this.now = options.now ?? Date.now;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url) as unknown as LighterWebSocket);
    this.backoffMs = options.backoffMs ?? defaultBackoff;
    this.keepaliveIntervalMs = options.keepaliveIntervalMs && options.keepaliveIntervalMs > 0
      ? options.keepaliveIntervalMs
      : DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.futureToleranceMs = options.futureToleranceMs ?? DEFAULT_FUTURE_TOLERANCE_MS;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.state = 'connecting';
    const loaded = await this.refreshDirectory();
    if (this.stopped) return;
    if (!loaded) {
      this.state = 'disconnected';
      this.scheduleReconnect();
      return;
    }
    // A test or a degraded public-data gateway with no validated directory must not create a
    // socket that has no legal subscription.
    if (this.directoryBySymbol.size === 0) {
      this.state = 'disconnected';
      return;
    }
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.awaitingPong = false;
    this.subscribedChannels.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      if (socket.readyState === SOCKET_OPEN) socket.close();
      else if (socket.terminate) socket.terminate();
      else socket.close();
    }
    for (const market of this.markets.values()) market.connectionState = 'disconnected';
    this.state = 'disconnected';
  }

  /** Synchronous lookup after the asynchronous directory preload. */
  ensureMarket(symbol: string): boolean {
    if (this.stopped) return false;
    const definition = this.directoryBySymbol.get(symbol);
    if (!definition) return false;
    let market = this.markets.get(symbol);
    if (!market) {
      market = {
        definition: { symbol, nativeSymbol: definition.nativeSymbol, marketId: definition.marketId, asset: definition.asset },
        ticker: null,
        stats: emptyStats(),
        market: null,
        connectionState: this.socket ? 'connecting' : 'reconnecting',
        lastTickerTimestamp: null,
        lastStatsTimestamp: null,
      };
      this.markets.set(symbol, market);
    }
    if (this.socket && this.socket.readyState === SOCKET_OPEN) this.subscribeMarket(market);
    this.updateAggregateState();
    return true;
  }

  market(symbol: string): LiveMarket | null {
    return this.markets.get(symbol)?.market ?? null;
  }

  marketIdFor(symbol: string): number | null {
    return this.directoryBySymbol.get(symbol)?.marketId ?? null;
  }

  connectionStateFor(symbol: string): MarketConnectionState {
    return this.markets.get(symbol)?.connectionState ?? 'disconnected';
  }

  connectionState(): MarketConnectionState {
    return this.state;
  }

  private async refreshDirectory(): Promise<boolean> {
    try {
      const rows = await this.directory();
      const nextBySymbol = new Map<string, { nativeSymbol: string; marketId: number; asset: string }>();
      const nextByMarketId = new Map<number, string>();
      for (const row of rows) {
        if (!directoryEntryIsEligible(row)) continue;
        const symbol = internalSymbol(row.symbol);
        if (nextBySymbol.has(symbol) || nextByMarketId.has(row.marketId)) return false;
        nextBySymbol.set(symbol, { nativeSymbol: row.symbol, marketId: row.marketId, asset: row.symbol });
        nextByMarketId.set(row.marketId, symbol);
      }
      this.directoryBySymbol.clear();
      this.directoryByMarketId.clear();
      for (const [symbol, definition] of nextBySymbol) this.directoryBySymbol.set(symbol, definition);
      for (const [marketId, symbol] of nextByMarketId) this.directoryByMarketId.set(marketId, symbol);
      for (const [symbol, market] of this.markets) {
        const definition = nextBySymbol.get(symbol);
        if (!definition) {
          market.connectionState = 'disconnected';
          market.market = null;
          continue;
        }
        if (market.definition.marketId !== definition.marketId) {
          market.ticker = null;
          market.stats = emptyStats();
          market.market = null;
          market.lastTickerTimestamp = null;
          market.lastStatsTimestamp = null;
        }
        market.definition = { symbol, nativeSymbol: definition.nativeSymbol, marketId: definition.marketId, asset: definition.asset };
      }
      return true;
    } catch {
      return false;
    }
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    this.state = this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting';
    let socket: LighterWebSocket;
    try {
      socket = this.webSocketFactory(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) return;
      this.reconnectAttempt = 0;
      this.awaitingPong = false;
      this.subscribedChannels.clear();
      for (const market of this.markets.values()) {
        if (!this.directoryBySymbol.has(market.definition.symbol)) continue;
        market.connectionState = market.market ? this.quoteIsFresh(market) ? 'healthy' : 'stale' : 'connecting';
        this.subscribeMarket(market, socket);
      }
      this.startKeepalive(socket);
      this.updateAggregateState();
    });
    socket.on('pong', () => {
      if (this.socket === socket) this.awaitingPong = false;
    });
    socket.on('message', (data) => {
      if (this.socket !== socket || this.stopped) return;
      this.handleMessage(data.toString());
    });
    socket.on('error', () => undefined);
    socket.on('close', () => this.handleClose(socket));
  }

  private handleClose(socket: LighterWebSocket): void {
    if (this.socket !== socket) return;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    this.awaitingPong = false;
    this.socket = null;
    this.subscribedChannels.clear();
    for (const market of this.markets.values()) {
      market.connectionState = this.stopped ? 'disconnected' : 'reconnecting';
    }
    if (!this.stopped) {
      this.state = 'reconnecting';
      this.scheduleReconnect();
    } else {
      this.state = 'disconnected';
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const attempt = this.reconnectAttempt;
    this.reconnectAttempt += 1;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, Math.max(0, this.backoffMs(attempt)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.refreshAndConnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async refreshAndConnect(): Promise<void> {
    if (this.stopped) return;
    const loaded = await this.refreshDirectory();
    if (this.stopped) return;
    if (!loaded) {
      this.state = 'reconnecting';
      this.scheduleReconnect();
      return;
    }
    if (this.directoryBySymbol.size === 0) {
      this.state = 'disconnected';
      return;
    }
    this.connect();
  }

  private subscribeMarket(market: LighterMarketState, socket = this.socket): void {
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    for (const channel of [`ticker/${market.definition.marketId}`, `market_stats/${market.definition.marketId}`]) {
      if (this.subscribedChannels.has(channel)) continue;
      try {
        socket.send(JSON.stringify({ type: 'subscribe', channel }));
        this.subscribedChannels.add(channel);
      } catch {
        socket.terminate?.();
        return;
      }
    }
  }

  private startKeepalive(socket: LighterWebSocket): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      if (this.socket !== socket || this.stopped || socket.readyState !== SOCKET_OPEN) return;
      if (this.awaitingPong) {
        socket.terminate?.();
        return;
      }
      this.awaitingPong = true;
      if (socket.ping) socket.ping();
      else socket.send(JSON.stringify({ type: 'ping' }));
      this.refreshSymbolHealth();
    }, this.keepaliveIntervalMs);
    this.keepaliveTimer.unref?.();
  }

  private refreshSymbolHealth(): void {
    for (const market of this.markets.values()) {
      if (!market.market || market.connectionState === 'reconnecting') continue;
      market.connectionState = this.quoteIsFresh(market) ? 'healthy' : 'stale';
    }
    this.updateAggregateState();
  }

  private quoteIsFresh(market: LighterMarketState): boolean {
    if (!market.market) return false;
    const updatedAt = Date.parse(market.market.updatedAt);
    const now = this.now();
    return Number.isFinite(updatedAt) && Number.isFinite(now) && now - updatedAt <= this.staleAfterMs;
  }

  private updateAggregateState(): void {
    if (this.stopped) {
      this.state = 'disconnected';
      return;
    }
    if (!this.socket) {
      this.state = this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting';
      return;
    }
    const states = [...this.markets.values()].map((market) => market.connectionState);
    if (states.includes('healthy')) this.state = 'healthy';
    else if (states.includes('stale')) this.state = 'stale';
    else if (states.includes('reconnecting')) this.state = 'reconnecting';
    else this.state = 'connecting';
  }

  private stateForMarketId(marketId: number): LighterMarketState | null {
    const symbol = this.directoryByMarketId.get(marketId);
    return symbol ? this.markets.get(symbol) ?? null : null;
  }

  private handleMessage(raw: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof payload !== 'object' || payload === null || typeof (payload as { type?: unknown }).type !== 'string') return;
    const type = (payload as { type: string }).type;
    if (type === 'pong') {
      this.awaitingPong = false;
      return;
    }
    if (type === 'update/ticker') {
      const parsed = LighterTickerFrameSchema.safeParse(payload);
      if (parsed.success) this.handleTicker(parsed.data);
      return;
    }
    if (type === 'update/market_stats') {
      const parsed = LighterStatsFrameSchema.safeParse(payload);
      if (parsed.success) this.handleStats(parsed.data);
    }
  }

  private handleTicker(frame: z.infer<typeof LighterTickerFrameSchema>): void {
    const marketId = channelMarketId(frame.channel, 'ticker');
    const market = marketId === null ? null : this.stateForMarketId(marketId);
    if (!market || frame.ticker.s !== market.definition.nativeSymbol) return;
    const sourceTimestamp = normalizeTimestamp(frame.timestamp);
    const now = this.now();
    if (sourceTimestamp === null || !Number.isFinite(now) || sourceTimestamp > now + this.futureToleranceMs) return;
    if (market.lastTickerTimestamp !== null && sourceTimestamp < market.lastTickerTimestamp) return;
    const bid = positiveText(frame.ticker.b.price);
    const ask = positiveText(frame.ticker.a.price);
    const bidSize = nonNegativeText(frame.ticker.b.size);
    const askSize = nonNegativeText(frame.ticker.a.size);
    if (!bid || !ask || bid.number > ask.number || bidSize === null || askSize === null) return;
    market.lastTickerTimestamp = sourceTimestamp;
    market.ticker = { bidPrice: bid.text, bidSize, askPrice: ask.text, askSize, sourceTimestamp, receivedAt: now };
    this.publishMarket(market);
  }

  private handleStats(frame: z.infer<typeof LighterStatsFrameSchema>): void {
    const marketId = channelMarketId(frame.channel, 'market_stats');
    const market = marketId === null ? null : this.stateForMarketId(marketId);
    if (!market || frame.market_stats.market_id !== market.definition.marketId
      || frame.market_stats.symbol !== market.definition.nativeSymbol) return;
    const sourceTimestamp = normalizeTimestamp(frame.timestamp);
    const now = this.now();
    if (sourceTimestamp === null || !Number.isFinite(now) || sourceTimestamp > now + this.futureToleranceMs) return;
    if (market.lastStatsTimestamp !== null && sourceTimestamp < market.lastStatsTimestamp) return;
    const values = [
      frame.market_stats.index_price, frame.market_stats.mark_price, frame.market_stats.open_interest,
      frame.market_stats.last_trade_price, frame.market_stats.current_funding_rate, frame.market_stats.funding_rate,
      frame.market_stats.daily_base_token_volume, frame.market_stats.daily_quote_token_volume,
      frame.market_stats.daily_price_low, frame.market_stats.daily_price_high, frame.market_stats.daily_price_change,
    ];
    if (values.some((value) => value != null && finiteText(value) === null)) return;
    const fundingTimestamp = frame.market_stats.funding_timestamp == null
      ? null
      : normalizeTimestamp(frame.market_stats.funding_timestamp);
    if (frame.market_stats.funding_timestamp != null && fundingTimestamp === null) return;
    market.lastStatsTimestamp = sourceTimestamp;
    const stats = market.stats;
    stats.indexPrice = frame.market_stats.index_price == null ? stats.indexPrice : finiteText(frame.market_stats.index_price);
    stats.markPrice = frame.market_stats.mark_price == null ? stats.markPrice : finiteText(frame.market_stats.mark_price);
    stats.openInterest = frame.market_stats.open_interest == null ? stats.openInterest : finiteText(frame.market_stats.open_interest);
    stats.lastPrice = frame.market_stats.last_trade_price == null ? stats.lastPrice : finiteText(frame.market_stats.last_trade_price);
    stats.fundingRate = frame.market_stats.current_funding_rate == null ? stats.fundingRate : finiteText(frame.market_stats.current_funding_rate);
    stats.fundingRateFallback = frame.market_stats.funding_rate == null ? stats.fundingRateFallback : finiteText(frame.market_stats.funding_rate);
    stats.fundingTimestamp = fundingTimestamp ?? stats.fundingTimestamp;
    stats.baseVolume = frame.market_stats.daily_base_token_volume == null ? stats.baseVolume : finiteText(frame.market_stats.daily_base_token_volume);
    stats.quoteVolume = frame.market_stats.daily_quote_token_volume == null ? stats.quoteVolume : finiteText(frame.market_stats.daily_quote_token_volume);
    stats.lowPrice = frame.market_stats.daily_price_low == null ? stats.lowPrice : finiteText(frame.market_stats.daily_price_low);
    stats.highPrice = frame.market_stats.daily_price_high == null ? stats.highPrice : finiteText(frame.market_stats.daily_price_high);
    stats.change = frame.market_stats.daily_price_change == null ? stats.change : finiteText(frame.market_stats.daily_price_change);
    if (market.market) this.mergeStatsIntoMarket(market);
  }

  private publishMarket(market: LighterMarketState): void {
    if (!market.ticker) return;
    const stats = market.stats;
    market.market = {
      symbol: market.definition.symbol,
      venue: 'LIGHTER',
      asset: market.definition.asset,
      lastPrice: stats.lastPrice ?? '0',
      bidPrice: market.ticker.bidPrice,
      bidSize: market.ticker.bidSize,
      askPrice: market.ticker.askPrice,
      askSize: market.ticker.askSize,
      open24h: '0',
      high24h: stats.highPrice ?? '0',
      low24h: stats.lowPrice ?? '0',
      volume24h: stats.baseVolume ?? '0',
      quoteVolume24h: stats.quoteVolume ?? '0',
      fundingRate: stats.fundingRate ?? stats.fundingRateFallback ?? '0',
      nextFundingAt: stats.fundingTimestamp === null ? new Date(0).toISOString() : new Date(stats.fundingTimestamp).toISOString(),
      openInterest: stats.openInterest ?? '0',
      openInterestValue: '0',
      receivedAt: new Date(market.ticker.receivedAt).toISOString(),
      updatedAt: new Date(market.ticker.sourceTimestamp).toISOString(),
      source: 'lighter_public_websocket',
    };
    market.connectionState = 'healthy';
    this.updateAggregateState();
  }

  private mergeStatsIntoMarket(market: LighterMarketState): void {
    if (!market.market) return;
    const stats = market.stats;
    market.market = {
      ...market.market,
      lastPrice: stats.lastPrice ?? market.market.lastPrice,
      high24h: stats.highPrice ?? market.market.high24h,
      low24h: stats.lowPrice ?? market.market.low24h,
      volume24h: stats.baseVolume ?? market.market.volume24h,
      quoteVolume24h: stats.quoteVolume ?? market.market.quoteVolume24h,
      fundingRate: stats.fundingRate ?? stats.fundingRateFallback ?? market.market.fundingRate,
      nextFundingAt: stats.fundingTimestamp === null ? market.market.nextFundingAt : new Date(stats.fundingTimestamp).toISOString(),
      openInterest: stats.openInterest ?? market.market.openInterest,
    };
  }
}
