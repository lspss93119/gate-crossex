# Kraken USD → CrossEx USDT quotes

This first stage adds a **Flash Swap** card to Portfolio. Enter the USD amount and
select **Request quote** to see the USDT amount offered by Gate. The card is
explicitly quote-only: it has no conversion confirmation button, and the backend
does not expose `/api/crossex/convert/orders`.

The change is based on `feature/lighter-integration` at
`471061394d90ba25b6ad80d36f5f139a38b73640`. It introduces no package dependencies,
database migrations, or changes to strategy execution and fund-transfer behavior.

## Gate contract

Official documentation: https://www.gate.com/docs/developers/crossex/

The backend sends a signed `POST /api/v4/crossex/convert/quote` with:

```json
{
  "exchange_type": "KRAKEN",
  "from_coin": "KRAKEN_USD",
  "to_coin": "CROSSEX_USDT",
  "from_amount": "25"
}
```

Kraken conversion requires `CROSS_EXCHANGE` account mode. Gate documents a limit
of 100 inquiry requests per day. The UI makes manual requests only. Its API helper
deliberately bypasses automatic retries; the local route also limits requests to
five per minute and permits only one pending inquiry per credential profile.
These local limits do not measure allowance consumed by other Gate clients.

Amounts remain strings. Requests accept positive plain decimals with at most 16
decimal places. Before requesting a quote, the backend reads the current Gate
account and checks Kraken's **available USD balance**, rather than equity or total
balance. Arbitrary exchange/coin parameters are rejected.

The local request is:

```json
{ "profileId": "gate-crossex-default", "fromAmount": "25" }
```

It requires `x-gct-read-intent: convert-quote` and inherits the existing local
host/origin checks. The supplied profile must match the active credential profile.
The backend checks credential generation after account lookup, immediately before
the queued quote reaches Gate, and after the quote returns. If the browser abandons
the response before quote dispatch, that quote is not sent. A request already sent
to Gate can still consume allowance even if its response is abandoned.

The card resets on profile, credential-generation, or account-mode changes; ordinary
verification timestamps do not clear entered amounts. Editing an amount discards
the result and ignores late responses for the previous amount. Unmounting aborts
the browser request.

Entering Portfolio loads the active account and its snapshot. Account or credential
changes trigger a new snapshot load; delayed connection and snapshot responses from
the previous context are ignored. These cancellable reads do not share a pending
response with a different account context.

## Remaining verification before execution

Gate's example returns `valid_ms: "5000"`, while the field description calls it a
millisecond timestamp. This stage preserves the raw value and does not infer an
executable deadline. A real authenticated **inquiry only** must establish the
response format, timing semantics, applicable permissions, and actual quoted rate.
No real credentials or inquiries were used in the automated tests.

A future executable stage needs explicit confirmation, durable submission identity,
ambiguous-result handling, and authoritative order/fill reconciliation. Receiving
an order ID must not be presented as a completed conversion.

## Validation and rollback

Run `npm test`, `npm run lint`, `npm run build`, and
`npm exec -- playwright test`. The added tests cover decimal preservation,
available-balance and account-mode checks, stale profile responses, cancellation,
queued dispatch, request overlap, amount edits, and quote-only operation. Existing
portfolio transfers and strategy tests remain part of the full suites.

Use the separate `feature/flash-swap-quote-ui` branch for review. Returning to
`feature/lighter-integration` at the base commit removes this UI/API feature
without a database downgrade. This stage is not a deployment or a fund conversion.
