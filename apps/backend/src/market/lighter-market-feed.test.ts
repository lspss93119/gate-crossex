import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LighterMarketDirectoryEntry } from '@gate-crossex/public-data';
import { LighterMarketFeed, type LighterMarketFeedOptions, type LighterWebSocket } from './lighter-market-feed.js';

const NOW = 1_771_990_800_000;
const BTC_SYMBOL = 'LIGHTER_FUTURE_BTC_USDC';
const ETH_SYMBOL = 'LIGHTER_FUTURE_ETH_USDC';

const directory: LighterMarketDirectoryEntry[] = [
  { symbol: 'BTC', marketId: 1, marketType: 'perp', status: 'active', supportedSizeDecimals: 5,
    supportedPriceDecimals: 1, markPrice: '100', indexPrice: '99.5', lastTradePrice: '100',
    openInterest: '10', dailyPriceChange: '1.2' },
  { symbol: 'ETH', marketId: 2, marketType: 'perp', status: 'active', supportedSizeDecimals: 5,
    supportedPriceDecimals: 2, markPrice: '20', indexPrice: '19.9', lastTradePrice: '20',
    openInterest: '20', dailyPriceChange: '-2.5' },
  { symbol: 'OLD', marketId: 3, marketType: 'perp', status: 'inactive', supportedSizeDecimals: 5,
    supportedPriceDecimals: 2, markPrice: '1', indexPrice: '1', lastTradePrice: '1',
    openInterest: '0', dailyPriceChange: '0' },
  { symbol: 'SPOT', marketId: 4, marketType: 'spot', status: 'active', supportedSizeDecimals: 5,
    supportedPriceDecimals: 2, markPrice: '1', indexPrice: '1', lastTradePrice: '1',
    openInterest: '0', dailyPriceChange: '0' },
];

type Handler = (...args: unknown[]) => void;

class FakeLighterWebSocket {
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  pingCount = 0;
  closeCount = 0;
  terminateCount = 0;
  readyState = 0;
  private readonly handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  send(data: string): void { this.sent.push(data); }
  ping(): void { this.pingCount += 1; }
  close(): void { this.closeCount += 1; this.readyState = 3; this.emit('close'); }
  terminate(): void { this.terminateCount += 1; this.readyState = 3; this.emit('close'); }

  open(): void { this.readyState = FakeLighterWebSocket.OPEN; this.emit('open'); }
  pong(): void { this.emit('pong'); }
  push(payload: unknown): void { this.emit('message', { toString: () => JSON.stringify(payload) }); }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

interface Harness {
  feed: LighterMarketFeed;
  sockets: FakeLighterWebSocket[];
  now: { value: number };
}

function createHarness(options: Partial<LighterMarketFeedOptions> = {}): Harness {
  const sockets: FakeLighterWebSocket[] = [];
  const now = { value: NOW };
  const feed = new LighterMarketFeed({
    url: 'wss://lighter.test/stream?readonly=true',
    directory: async () => directory,
    now: () => now.value,
    webSocketFactory: () => {
      const socket = new FakeLighterWebSocket();
      sockets.push(socket);
      return socket as unknown as LighterWebSocket;
    },
    backoffMs: () => 0,
    keepaliveIntervalMs: 50,
    staleAfterMs: 500,
    ...options,
  });
  return { feed, sockets, now };
}

async function startHarness(harness: Harness): Promise<FakeLighterWebSocket> {
  await harness.feed.start();
  const socket = harness.sockets[0];
  if (!socket) throw new Error('socket was not created');
  socket.open();
  return socket;
}

function subscriptionChannels(socket: FakeLighterWebSocket): string[] {
  return socket.sent.map((raw) => (JSON.parse(raw) as { channel: string }).channel);
}

function ticker(timestamp: number, bid = '100', ask = '100.5') {
  return { channel: 'ticker:1', type: 'update/ticker', timestamp,
    ticker: { s: 'BTC', a: { price: ask, size: '2' }, b: { price: bid, size: '1' } } };
}

function stats(timestamp: number, overrides: Record<string, unknown> = {}) {
  return { channel: 'market_stats:1', type: 'update/market_stats', timestamp,
    market_stats: { symbol: 'BTC', market_id: 1, index_price: '99.9', mark_price: '100.1',
      open_interest: '12', last_trade_price: '100.2', current_funding_rate: '0.0001',
      funding_rate: '0.00009', funding_timestamp: timestamp + 30_000,
      daily_base_token_volume: 10, daily_quote_token_volume: 1000, daily_price_low: 90,
      daily_price_high: 110, daily_price_change: 1.5, ...overrides } };
}

const activeFeeds: LighterMarketFeed[] = [];
afterEach(async () => {
  for (const feed of activeFeeds.splice(0)) await feed.stop();
  vi.useRealTimers();
});

describe('Lighter public market feed', () => {
  it('preloads eligible metadata and lazily subscribes each requested market once', async () => {
    const harness = createHarness();
    activeFeeds.push(harness.feed);
    const socket = await startHarness(harness);

    expect(harness.feed.ensureMarket(BTC_SYMBOL)).toBe(true);
    expect(harness.feed.ensureMarket(BTC_SYMBOL)).toBe(true);
    expect(harness.feed.ensureMarket(ETH_SYMBOL)).toBe(true);
    expect(harness.feed.ensureMarket('LIGHTER_FUTURE_OLD_USDC')).toBe(false);
    expect(harness.feed.ensureMarket('LIGHTER_FUTURE_SPOT_USDC')).toBe(false);
    expect(harness.feed.ensureMarket('GATE_FUTURE_BTC_USDT')).toBe(false);
    expect(harness.feed.market(BTC_SYMBOL)).toBeNull();
    expect(harness.feed.marketIdFor(BTC_SYMBOL)).toBe(1);

    expect(subscriptionChannels(socket)).toEqual([
      'ticker/1', 'market_stats/1', 'ticker/2', 'market_stats/2',
    ]);
  });

  it('normalizes official ticker frames and merges stats without overwriting the BBO', async () => {
    const harness = createHarness();
    activeFeeds.push(harness.feed);
    const socket = await startHarness(harness);
    harness.feed.ensureMarket(BTC_SYMBOL);

    socket.push(stats(NOW - 1_000));
    socket.push(ticker(NOW - 500));

    expect(harness.feed.market(BTC_SYMBOL)).toMatchObject({
      symbol: BTC_SYMBOL, venue: 'LIGHTER', asset: 'BTC', source: 'lighter_public_websocket',
      bidPrice: '100', bidSize: '1', askPrice: '100.5', askSize: '2',
      lastPrice: '100.2', fundingRate: '0.0001', openInterest: '12',
    });
    const beforeStats = harness.feed.market(BTC_SYMBOL);
    expect(beforeStats?.updatedAt).toBe(new Date(NOW - 500).toISOString());
    expect(Date.parse(beforeStats?.receivedAt ?? '')).toBe(NOW);

    socket.push(stats(NOW - 100, { mark_price: '101', last_trade_price: '101.2', open_interest: '13' }));
    expect(harness.feed.market(BTC_SYMBOL)).toMatchObject({
      bidPrice: '100', askPrice: '100.5',
      lastPrice: '101.2', openInterest: '13',
    });
    expect(harness.feed.market(BTC_SYMBOL)?.updatedAt).toBe(new Date(NOW - 500).toISOString());
  });

  it('normalizes microsecond timestamps and rejects out-of-order, malformed, and crossed quotes', async () => {
    const harness = createHarness();
    activeFeeds.push(harness.feed);
    const socket = await startHarness(harness);
    harness.feed.ensureMarket(BTC_SYMBOL);

    socket.push(ticker((NOW - 200) * 1_000, '100', '100.5'));
    expect(harness.feed.market(BTC_SYMBOL)?.updatedAt).toBe(new Date(NOW - 200).toISOString());

    socket.push(ticker(NOW - 300, '90', '90.5'));
    expect(harness.feed.market(BTC_SYMBOL)?.bidPrice).toBe('100');
    socket.push(ticker(NOW - 100, '101', '100.5'));
    expect(harness.feed.market(BTC_SYMBOL)?.bidPrice).toBe('100');
    socket.push({ ...ticker(NOW - 50), ticker: { s: 'BTC', a: { price: 'bad', size: '2' }, b: { price: '100', size: '1' } } });
    expect(harness.feed.market(BTC_SYMBOL)?.bidPrice).toBe('100');
  });

  it('reports per-symbol health, reconnects with bounded backoff, and resubscribes without duplication', async () => {
    const harness = createHarness();
    activeFeeds.push(harness.feed);
    const socket = await startHarness(harness);
    harness.feed.ensureMarket(BTC_SYMBOL);
    socket.push(ticker(NOW - 100));
    expect(harness.feed.connectionStateFor(BTC_SYMBOL)).toBe('healthy');

    socket.close();
    expect(harness.feed.connectionStateFor(BTC_SYMBOL)).toBe('reconnecting');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(harness.sockets).toHaveLength(2);
    const reconnected = harness.sockets[1]!;
    reconnected.open();
    expect(subscriptionChannels(reconnected)).toEqual(['ticker/1', 'market_stats/1']);
    reconnected.push(ticker(NOW - 50, '101', '101.5'));
    expect(harness.feed.market(BTC_SYMBOL)?.bidPrice).toBe('101');
    expect(harness.feed.connectionStateFor(BTC_SYMBOL)).toBe('healthy');
  });

  it('sends WebSocket keepalive and terminates a socket that does not answer pong', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ keepaliveIntervalMs: 50 });
    activeFeeds.push(harness.feed);
    const socket = await startHarness(harness);
    harness.feed.ensureMarket(BTC_SYMBOL);

    await vi.advanceTimersByTimeAsync(50);
    expect(socket.pingCount).toBe(1);
    socket.push({ type: 'pong' });
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.terminateCount).toBe(0);
    expect(socket.pingCount).toBe(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.terminateCount).toBe(1);

    await harness.feed.stop();
    const internals = harness.feed as unknown as { keepaliveTimer: unknown; reconnectTimer: unknown; socket: unknown };
    expect(internals.keepaliveTimer).toBeNull();
    expect(internals.reconnectTimer).toBeNull();
    expect(internals.socket).toBeNull();
  });
});
