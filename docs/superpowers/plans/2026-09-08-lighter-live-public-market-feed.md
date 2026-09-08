# Lighter Live Public Market Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded Phase 3 public Lighter market-data feed that supplies live, validated funding-only quotes to the existing strategy market-source boundary without changing execution, strategy schemas, or CrossEx behavior.

**Architecture:** Keep `CrossExMarketHub` and its seven CrossEx venues unchanged as the CrossEx source. Add a standalone `LighterMarketFeed` that preloads and reuses the Phase 2 Lighter REST metadata parser, lazily subscribes to only `ticker/{marketId}` and `market_stats/{marketId}`, and exposes per-symbol live snapshots. Add `CompositeMarketSource` above both sources so routing, health, freshness, and transport-lag checks are per symbol. Wire the composite only into `StrategyEngine`; keep browser market routes, orderbook/trades/klines, and execution paths on CrossEx-only definitions.

**Tech Stack:** TypeScript, Node `ws`, Zod schemas in `@gate-crossex/public-data`, Vitest/Node test runner already used by the workspace, existing `LiveMarket` and `StrategyEngine` contracts.

**Spec:** `/Users/liaoyuchen/.codex/attachments/5c648be8-9183-41f0-970f-a1125081989d/pasted-text.txt`

## Global Constraints

- Work only in `/private/tmp/gate-crossex-lighter-V0pPLS/repo` on `feature/lighter-integration`, starting at `c963b316e1e10379bc20d8591eb1262273591e80`.
- Keep Lighter public-data only: no credentials, signers, private WebSocket channels, orders, positions, balances, or full order-book subscriptions.
- Keep Lighter out of `MARKET_VENUES`, `CreateStrategyInputSchema`, tradable strategy symbols, `TradingRuntime`, `StrategyEngine` execution decisions, and CrossEx browser market endpoints.
- Do not alter funding retention, funding-history semantics, spread calculations, or strategy behavior.
- Use tests with injected WebSocket, clock, metadata, and backoff seams; unit tests must not access the network.
- Keep all changes in one focused commit titled `feat(market): add Lighter public market feed` only after every requested quality gate passes.

## Task 1: Extend the existing Lighter metadata boundary

**Files:** `packages/public-data/src/index.ts`, `packages/public-data/src/lighter.test.ts`

- [x] Add the exported normalized `LighterMarketDirectoryEntry` shape with `symbol`, `marketId`, `marketType`, `status`, supported decimal fields, and nullable REST price/open-interest fields.
- [x] Extend `PublicMarketDataGateway` with optional `queryLighterMarketDirectory(): Promise<LighterMarketDirectoryEntry[]>`.
- [x] Refactor the existing private Lighter metadata path so one Zod parser/cache validates raw `/api/v1/orderBookDetails` rows and the new public method maps them to camelCase without duplicating the parser.
- [x] Preserve the existing eligible-perpetual filtering used by funding REST methods; the directory method retains enough metadata for the feed to reject inactive and spot rows itself.
- [x] Add tests proving the directory mapping preserves BTC and another active perpetual, and retains inactive/spot rows for eligibility tests; retain existing funding and REST snapshot assertions.
- [x] Run the focused public-data tests and typecheck before proceeding.

## Task 2: Define reusable live-market and Lighter feed contracts

**Files:** `apps/backend/src/market/types.ts`, `apps/backend/src/market-hub.ts`

- [x] Move the shared `LiveMarket`, `MarketSnapshot`, and `MarketDefinition` contracts needed by both feeds into `apps/backend/src/market/types.ts`, preserving the existing CrossEx source union and public imports through `market-hub.ts`.
- [x] Add `LIGHTER` only to the live-market source/venue type used by the funding feed; do not add it to the CrossEx `MARKET_VENUES` tuple or CrossEx catalog.
- [x] Preserve `updatedAt` as the source timestamp and `receivedAt` as local receipt time while preserving existing CrossEx serialized fields and payload compatibility.
- [x] Keep CrossEx pending/demo seed behavior isolated to CrossEx code; the Lighter feed never constructs a `demo_seed` quote.
- [x] Run backend typecheck to catch import and type-boundary regressions before implementing the feed.

## Task 3: Implement the public `LighterMarketFeed`

**Files:** `apps/backend/src/market/lighter-market-feed.ts`, `apps/backend/src/market/lighter-market-feed.test.ts`

- [x] Implement a feed with `start(): Promise<void>`, `stop(): Promise<void>`, synchronous `ensureMarket(symbol): boolean`, `market(symbol): LiveMarket | null`, `connectionStateFor(symbol)`, and a feed-level `connectionState()`.
- [x] Preload the injected metadata directory during `start()` without blocking the event loop; accept only active `perp` entries with supported base/quote mapping, reject spot/inactive/unknown symbols, and map `LIGHTER_FUTURE_BTC_USDC` plus a second asset to native symbol and `marketId`.
- [x] Make `ensureMarket` lazy and idempotent: repeated calls produce one socket subscription per requested market and never subscribe non-Lighter symbols.
- [x] Connect to `GCT_LIGHTER_WS_URL` with default `wss://mainnet.zklighter.elliot.ai/stream?readonly=true`; support the server’s `ticker/{MARKET_INDEX}` and `market_stats/{MARKET_INDEX}` channel payloads only.
- [x] Normalize ticker bid/ask prices and sizes from `ticker.a`/`ticker.b`; merge stats into the existing snapshot without overwriting a valid BBO; publish only when the quote has finite positive bid/ask, non-negative sizes, and both source and local received timestamps.
- [x] Normalize source timestamp units explicitly: milliseconds remain milliseconds, microsecond-like values are divided to milliseconds, and invalid/future/out-of-order updates are ignored fail-closed. Reject malformed messages and crossed BBOs without fabricating executable data.
- [x] Set `source: 'lighter_public_websocket'`, `venue: 'LIGHTER'`, and the correct asset; return `null` until a valid quote exists.
- [x] Track per-symbol health, including connecting/healthy/reconnecting/stale/disconnected; a symbol without a valid quote is not healthy.
- [x] Implement bounded reconnect/backoff with one active socket, resubscription of requested market IDs, no duplicate state, and metadata reload/revalidation on reconnect failure or stale directory.
- [x] Implement a 30–60 second keepalive using WebSocket ping when available and handle pong; do not add any private/authenticated messages.
- [x] Ensure stop closes/terminates the socket, clears reconnect and keepalive timers, resolves lifecycle promises, and leaves no timer/socket leaks.
- [x] Add network-free tests for metadata eligibility/mapping, ensure/idempotence, ticker normalization, stats merge, timestamp units, out-of-order and malformed messages, crossed BBO, disconnect, reconnect/resubscribe, keepalive, and start/stop cleanup.
- [x] Run the focused Lighter feed tests and typecheck.

## Task 4: Add per-symbol composite routing

**Files:** `apps/backend/src/market/composite-market-source.ts`, `apps/backend/src/market/composite-market-source.test.ts`

- [x] Implement `CompositeMarketSource` over the CrossEx `MarketSource` and `LighterMarketFeed` with `market`, synchronous `ensureMarket`, global `connectionState`, and optional `connectionStateFor(symbol)`.
- [x] Route CrossEx symbols to CrossEx first and Lighter symbols to Lighter only; do not infer Lighter execution support from a generic symbol regex.
- [x] Delegate Lighter lifecycle from app startup/shutdown while preserving CrossEx lifecycle ownership and existing CrossEx subscriptions.
- [x] Add tests proving Lighter routing, CrossEx routing, idempotent ensure, unknown-symbol rejection, and that a disconnected Lighter does not make a healthy CrossEx market unavailable.
- [x] Run focused composite tests and backend typecheck.

## Task 5: Generalize StrategyEngine health checks without widening execution scope

**Files:** `apps/backend/src/strategy-engine.ts`, `apps/backend/src/strategy-engine.test.ts`

- [x] Extend `MarketSource` with optional `connectionStateFor(symbol)` and keep the current global method for compatibility with existing stubs.
- [x] Update `freshMarket` to select per-symbol health when available, allow exactly `gate_crossex_websocket` and `lighter_public_websocket`, and continue rejecting `demo_seed` and unknown sources.
- [x] Preserve the defaults of 15,000 ms freshness, 3,000 ms transport lag, and 2,000 ms future tolerance; compute age and transport lag from the validated source/received timestamps for both feeds.
- [x] Ensure no execution strategy schema or tradable venue list accepts Lighter merely because the market source can observe a Lighter quote.
- [x] Add tests for healthy/fresh Lighter quotes, stale Lighter quotes, excessive transport lag, future timestamps, unknown/demo sources, per-symbol Lighter disconnect, and healthy CrossEx behavior while Lighter is disconnected.
- [x] Run the focused strategy tests and typecheck.

## Task 6: Wire configuration and lifecycle at the application boundary

**Files:** `apps/backend/src/config.ts`, `apps/backend/src/config.test.ts`, `apps/backend/src/app.ts`, `apps/backend/src/app.test.ts`, `apps/backend/src/server.ts`

- [x] Add `lighterPublicWebSocketUrl` to backend configuration from `GCT_LIGHTER_WS_URL`, defaulting to the readonly mainnet URL, with no credential fields.
- [x] Construct `LighterMarketFeed` and `CompositeMarketSource` in `buildApp`/server startup using the existing public-data gateway directory method and injected seams for tests.
- [x] Pass the composite only to `StrategyEngine`; keep `marketHub` as the CrossEx-only object used by `/api/markets`, market-stream websocket, orderbook/trades/klines, and order-intent paths.
- [x] Start the Lighter feed before starting the strategy engine when market streaming is enabled, and stop it during app close with all timers and sockets cleaned up.
- [x] Keep browser/funding UI Lighter visibility from Phase 2 intact while preserving the funding-only/non-executable venue boundary.
- [x] Add app-level tests for default/override URL, lifecycle start/stop, CrossEx endpoint isolation, Lighter funding-source routing, and CreateStrategyInputSchema rejection of Lighter.
- [x] Run app tests and the focused frontend/backend test commands.

## Task 7: Document the Phase 3 boundary and run complete validation

**Files:** `docs/lighter-integration.md`, `docs/superpowers/plans/2026-09-08-lighter-live-public-market-feed.md`

- [x] Document the Phase 3 public-feed architecture, readonly WebSocket URL, exact allowed channels, timestamp/quote validity rules, per-symbol health, reconnect/keepalive behavior, and the explicit non-executable boundary.
- [x] Record the implementation’s BTC mapping and one additional asset mapping based on the validated directory, without documenting credentials or private API details.
- [x] Run one bounded public read-only smoke against the official metadata/WebSocket surface; keep it separate from the deterministic test suite and report its result without making it a release gate.
- [x] Run fresh quality gates from the clean implementation state:
  - `npm run lint`
  - `npm run typecheck`
  - `npm test`
  - `npm run test:bootstrap`
  - `npm run test:release`
  - `npm run build`
  - `npm audit --audit-level=high`
  - `npm run test:e2e`
- [x] Inspect `git diff`, verify no credentials or unrelated strategy/trading files changed, and verify the working tree before committing.

## Task 8: Commit and publish only the requested branch

**Files:** all implementation files listed above

- [x] Create exactly one focused commit: `feat(market): add Lighter public market feed`.
- [x] Verify the commit contains only Phase 3 public market-feed/UI-boundary work and that the starting commit remains its parent.
- [x] Push only `HEAD` to `origin/feature/lighter-integration`; do not merge, open a PR, force-push, or start Phase 4.
- [x] Re-read branch, HEAD, status, and push result for the final report, including exact test results and the required stop marker.

## Final Report Checklist

- [x] Starting HEAD and ending HEAD.
- [x] Commit SHA and changed files.
- [x] Exact Lighter WebSocket URL/default and readonly behavior.
- [x] Exact subscribed channels and keepalive interval.
- [x] Reconnect/backoff behavior and metadata revalidation.
- [x] BTC and one additional asset mapping.
- [x] Ticker/stats quote normalization and timestamp validation.
- [x] Per-symbol health and StrategyEngine freshness/transport-lag behavior.
- [x] Tests, build, audit, E2E, and optional live-smoke results.
- [x] Confirmation that Lighter remains funding-visible/funding-only and non-executable, and CrossEx remains unaffected.
- [x] End exactly with: `STOPPED AFTER PHASE 3 — PHASE 4 NOT STARTED`
