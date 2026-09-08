import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FUNDING_VENUE_LOGOS, fundingVenueLogoFor } from './exchange-logos.js';
import { VenueIcon, fundingVenueColor } from './route-shared.js';

describe('funding venue visuals', () => {
  it('uses the official Lighter icon only through the funding venue resolver', () => {
    expect(FUNDING_VENUE_LOGOS.lighter).toBeDefined();
    expect(fundingVenueLogoFor('LIGHTER')).toBe(FUNDING_VENUE_LOGOS.lighter);
    expect(fundingVenueLogoFor('OKX')).not.toBe(FUNDING_VENUE_LOGOS.lighter);

    const fundingMarkup = renderToStaticMarkup(<VenueIcon id="lighter" short="LT" fundingOnly />);
    expect(fundingMarkup).toContain('<img');
    expect(fundingMarkup).not.toContain('>LT<');

    const tradingMarkup = renderToStaticMarkup(<VenueIcon id="lighter" short="LT" />);
    expect(tradingMarkup).toContain('>LT<');
  });

  it('keeps OKX unchanged while giving Lighter a distinct chart color', () => {
    expect(fundingVenueColor('OKX')).toBe('#dbe3eb');
    expect(fundingVenueColor('LIGHTER')).toBe('#f078a8');
    expect(fundingVenueColor('LIGHTER')).not.toBe(fundingVenueColor('OKX'));
  });
});
