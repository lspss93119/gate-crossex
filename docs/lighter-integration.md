# Lighter integration: venue identity

The shared package owns `CROSSEX_VENUES` (the existing seven venues),
`EXTERNAL_VENUES` (`LIGHTER`), and `SUPPORTED_VENUES` (their union).
Generic venue validation, funding history requests and favorites accept the union.
CrossEx account validation remains restricted to `CrossExVenueSchema`.
Lighter uses `LIGHTER_FUTURE_BTC_USDC`-style symbols and the funding UI's official Lighter icon.

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

## Live public market feed (Phase 3)

Phase 3 adds a public, read-only Lighter market feed behind a composite market-source boundary.
The existing `CrossExMarketHub` remains CrossEx-only. `LighterMarketFeed` consumes the validated
directory returned by the existing public-data parser, and `CompositeMarketSource` routes only
explicit `LIGHTER_FUTURE_<ASSET>_USDC` symbols to it. Browser market streams, order books, trades,
klines, and order-intent validation continue to use CrossEx definitions only.

The default WebSocket endpoint is
`wss://mainnet.zklighter.elliot.ai/stream?readonly=true`; deployments may override it with
`GCT_LIGHTER_WS_URL`. The feed subscribes only to the documented public channels
`ticker/{MARKET_INDEX}` and `market_stats/{MARKET_INDEX}`. It does not subscribe to full order
books, trades, candles, authenticated channels, or transaction channels. The feed sends a WebSocket
ping every 45 seconds by default and terminates/reconnects a socket that does not answer the
keepalive; reconnect delay is bounded exponentially at 30 seconds and refreshes the metadata
directory before resubscribing.

The official protocol frames are documented in the
[Lighter WebSocket reference](https://apidocs.lighter.xyz/docs/websocket-reference). Ticker bid,
ask, and sizes are accepted only when numeric, positive/non-negative as appropriate, non-crossed,
and accompanied by a valid source timestamp plus local receipt time. Millisecond timestamps are
preserved; microsecond- and nanosecond-like values are normalized before freshness checks. Older,
future, malformed, or crossed updates are ignored. `market()` remains `null` until a valid BBO is
available, and stats updates never overwrite the BBO or its source/receipt timestamps.

The directory maps internal `LIGHTER_FUTURE_BTC_USDC` to native `BTC` and its metadata
`market_id`; the same rule maps `LIGHTER_FUTURE_ETH_USDC` to native `ETH`. Only active perpetual
rows are eligible; inactive, spot, unknown, and non-USDC symbols are rejected. The resulting
market uses `source: lighter_public_websocket` and per-symbol health, so a Lighter disconnect does
not make a healthy CrossEx symbol unusable.

Lighter remains funding-visible but non-executable. It is not added to `MARKET_VENUES`,
`CreateStrategyInputSchema`, CrossEx instrument catalog, authenticated integrations,
`TradingRuntime`, or any order/position/balance path.
