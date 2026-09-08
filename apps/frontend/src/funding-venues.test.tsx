import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FundingOverviewResponse } from './api.js';
import { LanguageContext } from './i18n.js';
import { FundingRatesView } from './funding-route.js';
import * as routeShared from './route-shared.js';

type FundingVenueDefinition = { id: string; name: string; short: string };

describe('funding-only venue boundary', () => {
  it('includes Lighter in the funding venue list without changing the seven-venue trading list', () => {
    const fundingExchanges = (routeShared as unknown as { fundingExchanges?: FundingVenueDefinition[] }).fundingExchanges;

    expect(routeShared.exchanges.map((venue) => venue.id)).toEqual([
      'gate', 'binance', 'okx', 'bybit', 'kraken', 'hyperliquid', 'deribit',
    ]);
    expect(fundingExchanges?.map((venue) => venue.id)).toEqual([
      'gate', 'binance', 'okx', 'bybit', 'kraken', 'hyperliquid', 'deribit', 'lighter',
    ]);
  });

  it('does not offer a hedge strategy action when Lighter is part of the best spread', () => {
    const isExecutableFundingVenue = (routeShared as unknown as {
      isExecutableFundingVenue?: (id: string) => boolean;
    }).isExecutableFundingVenue;

    expect(isExecutableFundingVenue?.('lighter')).toBe(false);
    expect(isExecutableFundingVenue?.('gate')).toBe(true);
  });

  it('renders Lighter funding data in the matrix while keeping its read-only spread non-executable', () => {
    const timestamp = '2026-09-08T02:00:00.000Z';
    const overview: FundingOverviewResponse = {
      assets: [{
        asset: 'BTC',
        venues: [
          {
            venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', quote: 'USDT', fundingRate: '0.0001',
            fundingIntervalHours: 8, fundingRate8h: '0.0001', nextFundingAt: null,
            openInterestValue: '10000000', lastPrice: '80000', change24h: null, fetchedAt: timestamp,
          },
          {
            venue: 'LIGHTER', symbol: 'LIGHTER_FUTURE_BTC_USDC', quote: 'USDC', fundingRate: '0.001',
            fundingIntervalHours: 1, fundingRate8h: '0.008', nextFundingAt: timestamp,
            openInterestValue: '10000000', lastPrice: '80000', change24h: null, fetchedAt: timestamp,
          },
        ],
      }],
      venueStatus: [], fetchedAt: timestamp, cacheStatus: 'fresh',
    };

    const html = renderToStaticMarkup(
      <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
        <FundingRatesView
          marketSnapshot={null}
          onMarketFallback={vi.fn(async () => undefined)}
          onOpenAsset={vi.fn()}
          onOpenStrategy={vi.fn()}
          metric="Per interval"
          onMetricChange={vi.fn()}
          fundingOverview={overview}
          onFundingOverview={vi.fn()}
          fundingHistoryCache={{ 1: {}, 7: {}, 30: {} }}
          onFundingHistoryEntries={vi.fn()}
        />
      </LanguageContext.Provider>,
    );

    expect(html).toContain('Lighter');
    expect(html).toContain('+0.1000%');
    expect(html).not.toContain('Open hedge strategy');
  });
});
