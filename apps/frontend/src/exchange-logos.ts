import binanceLogo from './assets/exchanges/binance.svg';
import bybitLogo from './assets/exchanges/bybit.svg';
import deribitLogo from './assets/exchanges/deribit.svg';
import gateLogo from './assets/exchanges/gate.svg';
import hyperliquidLogo from './assets/exchanges/hyperliquid.svg';
import krakenLogo from './assets/exchanges/kraken.svg';
import lighterLogo from './assets/exchanges/lighter.svg';
import okxLogo from './assets/exchanges/okx.svg';

export type ExchangeLogoId = 'gate' | 'binance' | 'okx' | 'bybit' | 'kraken' | 'hyperliquid' | 'deribit';

export const EXCHANGE_LOGOS: Record<ExchangeLogoId, string> = {
  gate: gateLogo,
  binance: binanceLogo,
  okx: okxLogo,
  bybit: bybitLogo,
  kraken: krakenLogo,
  hyperliquid: hyperliquidLogo,
  deribit: deribitLogo,
};

/** Funding-only venue assets stay separate from the executable venue map. */
export const FUNDING_VENUE_LOGOS: Record<string, string> = {
  lighter: lighterLogo,
};

export function exchangeLogoFor(exchangeId: string): string | undefined {
  return EXCHANGE_LOGOS[exchangeId.toLowerCase() as ExchangeLogoId];
}

export function fundingVenueLogoFor(exchangeId: string): string | undefined {
  const normalizedId = exchangeId.toLowerCase();
  return FUNDING_VENUE_LOGOS[normalizedId] ?? exchangeLogoFor(normalizedId);
}
