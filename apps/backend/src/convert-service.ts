import { Decimal } from 'decimal.js';
import {
  CrossExConvertQuoteResponseSchema,
  type CrossExConvertQuoteRequest,
  type CrossExConvertQuoteResponse,
} from '@gate-crossex/shared-types';
import { GateConvertQuoteResponseSchema, type ConvertQuoteCrossExGateway } from './crossex-client.js';
import type { GateCredentials } from './credential-vault.js';

export class ConvertQuoteError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
    this.name = 'ConvertQuoteError';
  }
}

export async function queryKrakenUsdQuote(
  gateway: ConvertQuoteCrossExGateway,
  credentials: GateCredentials,
  request: CrossExConvertQuoteRequest,
  assertCurrentAccount: () => void,
): Promise<CrossExConvertQuoteResponse> {
  const account = await gateway.queryAccount(credentials);
  assertCurrentAccount();
  if (account.account_mode !== 'CROSS_EXCHANGE') {
    throw new ConvertQuoteError('convert_account_mode_unsupported', 400);
  }
  const source = account.assets.find((asset) => asset.exchange_type === 'KRAKEN' && asset.coin === 'USD');
  let available: Decimal;
  try {
    available = new Decimal(source?.available_balance ?? 'NaN');
  } catch {
    throw new ConvertQuoteError('convert_source_balance_unavailable', 409);
  }
  if (!available.isFinite() || available.isNegative()) {
    throw new ConvertQuoteError('convert_source_balance_unavailable', 409);
  }
  if (new Decimal(request.fromAmount).gt(available)) {
    throw new ConvertQuoteError('convert_amount_exceeds_available', 400);
  }

  const raw = await gateway.queryConvertQuote(credentials, {
    exchange_type: 'KRAKEN', from_coin: 'KRAKEN_USD', to_coin: 'CROSSEX_USDT', from_amount: request.fromAmount,
  }, assertCurrentAccount);
  assertCurrentAccount();
  const parsed = GateConvertQuoteResponseSchema.safeParse(raw);
  if (!parsed.success || !new Decimal(parsed.data.from_amount).eq(request.fromAmount)) {
    throw new ConvertQuoteError('invalid_convert_quote_response', 502);
  }
  const quote = parsed.data;
  return CrossExConvertQuoteResponseSchema.parse({
    quoteId: quote.quote_id, profileId: request.profileId,
    fromCoin: quote.from_coin, toCoin: quote.to_coin, fromAmount: request.fromAmount,
    toAmount: quote.to_amount, price: quote.price, validMs: quote.valid_ms,
    quotedAt: new Date().toISOString(), executionEnabled: false,
  });
}
