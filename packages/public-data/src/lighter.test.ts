import { describe, expect, it, vi } from 'vitest';
import { PublicMarketSnapshotSchema } from '@gate-crossex/shared-types';
import { PublicMarketDataError, VenuePublicMarketDataClient } from './index.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-08T01:30:00Z');
const BTC = { symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active',
  supported_size_decimals: 5, supported_price_decimals: 1, mark_price: '80000', index_price: '80001',
  last_trade_price: 79999, open_interest: 2000, daily_price_change: -1.2 };
const metadata = { code: 200, order_book_details: [BTC, { ...BTC, symbol: 'ETH', market_id: 0 },
  { ...BTC, symbol: 'OLD', market_id: 10, status: 'inactive' }, { ...BTC, symbol: 'SPOT', market_type: 'spot', market_id: 2048 }], spot_order_book_details: [] };
const funding = { code: 200, funding_rates: [
  { market_id: 1, exchange: 'binance', symbol: 'BTC', rate: 0.01 },
  { market_id: 1, exchange: 'lighter', symbol: 'BTC', rate: 0.000096 },
  { market_id: 999, exchange: 'lighter', symbol: 'FAKE', rate: 0.001 },
] };
const json = (data: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(data), { status, headers });
function clientFor(history: (url: URL, init?: RequestInit) => Response | Promise<Response> = () => json({ code: 200, resolution: '1h', fundings: [] })) {
  const urls: URL[] = [];
  const sleep = vi.fn(async () => undefined);
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url);
    expect(url.origin).toBe('https://mainnet.zklighter.elliot.ai');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(init?.body).toBeUndefined();
    if (url.pathname.endsWith('/orderBookDetails')) return json(metadata);
    if (url.pathname.endsWith('/funding-rates')) return json(funding);
    if (url.pathname.endsWith('/fundings')) return history(url, init);
    throw new Error(`Unexpected public endpoint: ${url.pathname}`);
  });
  return { client: new VenuePublicMarketDataClient(request as typeof fetch, () => NOW, { sleep }), urls, sleep, request };
}

describe('Lighter public funding', () => {
  it('joins actual active markets and normalizes the API 8h rate back to hourly exactly once', async () => {
    const { client } = clientFor();
    const rows = await client.queryVenueFundingStats('LIGHTER');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ venue: 'LIGHTER', base: 'BTC', quote: 'USDC', fundingRate: '0.000012',
      fundingIntervalHours: 1, fundingRate8h: '0.000096', nextFundingAt: '2026-09-08T02:00:00.000Z',
      openInterestValue: '160000000', lastPrice: '79999', change24h: '-0.012' });
    expect(rows[1]?.fundingRate).toBeNull();
    expect(rows.map((row) => row.base)).toEqual(['BTC', 'ETH']);
  });

  it('provides a public-only snapshot with no fabricated BBO', async () => {
    const { client } = clientFor();
    const snapshot = await client.querySnapshot('LIGHTER_FUTURE_BTC_USDC');
    expect(PublicMarketSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({ symbol: 'LIGHTER_FUTURE_BTC_USDC', venue: 'LIGHTER', fundingRate: '0.000012',
      markPrice: '80000', indexPrice: '80001', bidPrice: null, askPrice: null, predictedFundingRate: null,
      lastPrice: '79999', source: 'lighter_public_rest' });
  });

  it('retrieves 30 days in bounded time pages and preserves signed percentage rates, filtering, ordering and deduplication', async () => {
    const end = Math.floor(NOW / HOUR) * HOUR;
    const start = end - 720 * HOUR;
    const settlements = Array.from({ length: 721 }, (_, i) => ({ timestamp: (start + i * HOUR) / 1000,
      value: '0.96000000', rate: '0.0012', direction: i % 2 === 0 ? 'long' : 'short' }));
    const { client, urls, sleep } = clientFor((url) => {
      expect(url.searchParams.get('market_id')).toBe('1');
      expect(url.searchParams.get('resolution')).toBe('1h');
      expect(url.searchParams.get('count_back')).toBe('100');
      const from = Number(url.searchParams.get('start_timestamp'));
      const to = Number(url.searchParams.get('end_timestamp'));
      expect(Number.isInteger(from)).toBe(true);
      expect(Number.isInteger(to)).toBe(true);
      expect(to - from).toBeLessThanOrEqual(99 * 3600 + 1);
      const rows = settlements.filter((row) => row.timestamp > from && row.timestamp < to);
      const pageRows = rows.length === 99 ? [...rows, rows.at(-1)] : rows;
      return json({ code: 200, resolution: '1h', fundings: [...pageRows, settlements[0],
        { timestamp: (end + HOUR) / 1000, value: '1', rate: '0.1', direction: 'long' }].reverse() });
    });
    const points = await client.queryFundingHistory('LIGHTER_FUTURE_BTC_USDC', start, end);
    expect(points).toHaveLength(720);
    expect(points[0]).toEqual({ timestamp: start + HOUR, rate: '-0.000012' });
    expect(points.at(-1)).toEqual({ timestamp: end, rate: '0.000012' });
    expect(points.every((point, i) => i === 0 || point.timestamp > points[i - 1]!.timestamp)).toBe(true);
    expect(urls.filter((url) => url.pathname.endsWith('/fundings'))).toHaveLength(8);
    expect(sleep).toHaveBeenCalledWith(1500, undefined);
  });

  it('continues after a full conservative page instead of treating the page limit as complete history', async () => {
    const end = Math.floor(NOW / HOUR) * HOUR;
    const start = end - 198 * HOUR;
    const settlements = Array.from({ length: 199 }, (_, i) => ({ timestamp: (start + i * HOUR) / 1000,
      value: '0.96000000', rate: '0.0012', direction: 'long' as const }));
    const { client, urls } = clientFor((url) => {
      const from = Number(url.searchParams.get('start_timestamp'));
      const to = Number(url.searchParams.get('end_timestamp'));
      const rows = settlements.filter((row) => row.timestamp > from && row.timestamp < to);
      const fullPage = rows.length >= 99 ? [...rows.slice(0, 99), rows[98]] : rows;
      return json({ code: 200, resolution: '1h', fundings: fullPage });
    });

    const points = await client.queryFundingHistory('LIGHTER_FUTURE_BTC_USDC', start, end);

    expect(points).toHaveLength(198);
    expect(urls.filter((url) => url.pathname.endsWith('/fundings'))).toHaveLength(2);
  });

  it('rejects a nonempty page that stops before the requested time boundary', async () => {
    const end = Math.floor(NOW / HOUR) * HOUR;
    const start = end - 10 * HOUR;
    const { client } = clientFor(() => json({ code: 200, resolution: '1h', fundings: [{
      timestamp: (start + HOUR) / 1000, value: '0.96', rate: '0.0012', direction: 'long',
    }] }));

    await expect(client.queryFundingHistory('LIGHTER_FUTURE_BTC_USDC', start, end))
      .rejects.toMatchObject({ code: 'INCOMPLETE_HISTORY' });
  });

  it('fails closed when a full page cannot be continued to a covered boundary', async () => {
    const end = Math.floor(NOW / HOUR) * HOUR;
    const start = end - 198 * HOUR;
    const fullPage = [...Array.from({ length: 99 }, (_, i) => ({
      timestamp: (start + i * HOUR) / 1000, value: '0.96', rate: '0.0012', direction: 'long' as const,
    })), { timestamp: (start + 98 * HOUR) / 1000, value: '0.96', rate: '0.0012', direction: 'long' as const }];
    const { client } = clientFor((url) => Number(url.searchParams.get('start_timestamp')) === start / 1000
      ? json({ code: 200, resolution: '1h', fundings: fullPage })
      : json({ code: 200, resolution: '1h', fundings: [] }));

    await expect(client.queryFundingHistory('LIGHTER_FUTURE_BTC_USDC', start, end))
      .rejects.toMatchObject({ code: 'INCOMPLETE_HISTORY' });
  });

  it('returns a successful empty range without zero settlements', async () => {
    expect(await clientFor().client.queryFundingHistory('LIGHTER_FUTURE_BTC_USDC', NOW - HOUR, NOW)).toEqual([]);
  });

  it.each(['LIGHTER_FUTURE_FAKE_USDC', 'LIGHTER_FUTURE_OLD_USDC', 'LIGHTER_FUTURE_BTC_USDT'])(
    'rejects unsupported market %s', async (symbol) => {
      await expect(clientFor().client.queryFundingHistory(symbol, NOW - HOUR, NOW)).rejects.toBeInstanceOf(PublicMarketDataError);
    });

  it('does not retry 429 immediately and preserves Retry-After beyond the legacy 10s cap', async () => {
    const { client, urls } = clientFor(() => json({}, 429, { 'Retry-After': '120' }));
    await expect(client.queryFundingHistory('LIGHTER_FUTURE_BTC_USDC', NOW - HOUR, NOW))
      .rejects.toMatchObject({ code: 'UPSTREAM_HTTP_429', retryAfterMs: 120_000 });
    expect(urls.filter((url) => url.pathname.endsWith('/fundings'))).toHaveLength(1);
  });

  it.each([500, 503])('bounds retries for HTTP %s', async (status) => {
    const { client, urls } = clientFor(() => json({}, status));
    await expect(client.queryFundingHistory('LIGHTER_FUTURE_BTC_USDC', NOW - HOUR, NOW))
      .rejects.toMatchObject({ code: `UPSTREAM_HTTP_${status}` });
    expect(urls.filter((url) => url.pathname.endsWith('/fundings'))).toHaveLength(3);
  });

  it('maps network and timeout failures into the existing retryable error', async () => {
    const { client, urls } = clientFor(() => { throw new TypeError('fetch failed'); });
    await expect(client.queryFundingHistory('LIGHTER_FUTURE_BTC_USDC', NOW - HOUR, NOW)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(urls.filter((url) => url.pathname.endsWith('/fundings'))).toHaveLength(3);
  });

  it.each([
    { code: 200, resolution: '1h', fundings: [{ timestamp: 1, rate: 'NaN', value: '0', direction: 'long' }] },
    { code: 200, resolution: '1h', fundings: [{ timestamp: 1, rate: '0.1', value: '0', direction: 'unknown' }] },
    { code: 200, resolution: '1d', fundings: [] },
    { code: 400, resolution: '1h', fundings: [] },
  ])('rejects malformed history without marking it covered', async (payload) => {
    const { client } = clientFor(() => json(payload));
    await expect(client.queryFundingHistory('LIGHTER_FUTURE_BTC_USDC', NOW - HOUR, NOW)).rejects.toMatchObject({ code: 'INVALID_RESPONSE_SCHEMA' });
  });

  it('honors pre-aborted and in-flight AbortSignals', async () => {
    const before = new AbortController(); before.abort();
    const first = clientFor();
    await expect(first.client.queryFundingHistory('LIGHTER_FUTURE_BTC_USDC', NOW - HOUR, NOW, before.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(first.urls).toHaveLength(0);
    const active = new AbortController();
    const second = clientFor((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      active.abort();
    }));
    await expect(second.client.queryFundingHistory('LIGHTER_FUTURE_BTC_USDC', NOW - HOUR, NOW, active.signal)).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
