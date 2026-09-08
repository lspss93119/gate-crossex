# Lighter integration: venue identity

The shared package owns `CROSSEX_VENUES` (the existing seven venues),
`EXTERNAL_VENUES` (`LIGHTER`), and `SUPPORTED_VENUES` (their union).
Generic venue validation, funding history requests and favorites accept the union.
CrossEx account validation remains restricted to `CrossExVenueSchema`.
Lighter uses `LIGHTER_FUTURE_BTC_USDC`-style symbols and a text label fallback.

## Venue audit (Phase 1)

| Location | Classification and treatment |
| --- | --- |
| shared-types venue identity | A: centralized application identity |
| backend funding-history and app funding request schemas | A: supported symbols, same 24H/7D/30D windows and 90-day retention |
| public-data funding venue list | A: reuse CrossEx list until the Phase 2 adapter is present |
| frontend local-preferences, funding labels/colors | A/D: native identity and backward-compatible favorites |
| app catalog, leverage validators and market watch | B: CrossEx only; catalog list reuses shared constants |
| crossex-client IsolatedExchangeTypeSchema | B: shared CrossEx-only schema |
| trading-runtime venue/symbol validation | B: preserved unchanged, with an explicit rejection regression test |
| market-hub and scripts/e2e-server.mjs | B/D: CrossEx streams and synthetic CrossEx fixtures, preserved |
| candle-store and public-data candle parsing | B/C: existing candle/spread capability, preserved |
| public-data snapshot schemas and repository snapshot venue type | C: existing three implemented snapshot adapters, preserved |
| route-shared exchanges and exchange-logos | D: trading presentation remains CrossEx-only; Lighter funding label uses text |

No execution, credential, private-stream, strategy, candle or spread behavior is added.
