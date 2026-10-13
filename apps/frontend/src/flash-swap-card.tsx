import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CrossExConvertQuoteRequestSchema } from '@gate-crossex/shared-types';
import { api, ApiError, type CrossExConvertQuoteResponse } from './api.js';
import { useLanguage } from './i18n.js';

interface FlashSwapCardProps {
  profileId: string | null;
  accountMode: string | undefined;
  availableUsd: string | null;
}

const ERROR_MESSAGES: Record<string, string> = {
  credential_changed: 'The active account changed. Refresh account data and request a new quote.',
  credential_not_configured: 'Configure Gate API credentials in Settings first.',
  convert_account_mode_unsupported: 'Kraken USD conversion requires cross-exchange account mode.',
  convert_amount_exceeds_available: 'The amount exceeds your available Kraken USD balance.',
  convert_source_balance_unavailable: 'Your available Kraken USD balance could not be verified.',
  convert_quotes_unavailable: 'Quotes are unavailable. Check your account connection and try again.',
  convert_quote_in_progress: 'A quote request is already running for this account. Wait for it to finish.',
  invalid_convert_quote_response: 'Gate returned an inconsistent quote. Request a new quote.',
  invalid_backend_response: 'Gate returned an inconsistent quote. Request a new quote.',
  request_timeout: 'The quote request timed out. Request a new quote.',
};

export function FlashSwapCard({ profileId, accountMode, availableUsd }: FlashSwapCardProps) {
  const { t } = useLanguage();
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<CrossExConvertQuoteResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const submitting = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const supportedMode = accountMode === 'CROSS_EXCHANGE';
  const valid = CrossExConvertQuoteRequestSchema.safeParse({ profileId, fromAmount: amount }).success;

  useEffect(() => () => {
    generation.current += 1;
    controller.current?.abort();
  }, []);

  function editAmount(value: string) {
    generation.current += 1;
    setAmount(value);
    setQuote(null);
    setError(null);
  }

  async function requestQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = CrossExConvertQuoteRequestSchema.safeParse({ profileId, fromAmount: amount });
    if (submitting.current || !supportedMode || !parsed.success) return;
    submitting.current = true;
    setBusy(true);
    setQuote(null);
    setError(null);
    const requestGeneration = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    try {
      const received = await api.convertQuote(parsed.data, abort.signal);
      if (abort.signal.aborted || requestGeneration !== generation.current) return;
      if (received.profileId !== parsed.data.profileId || received.fromAmount !== parsed.data.fromAmount) {
        setError(t('Gate returned an inconsistent quote. Request a new quote.'));
        return;
      }
      setQuote(received);
    } catch (failure) {
      if (abort.signal.aborted || requestGeneration !== generation.current) return;
      const message = failure instanceof ApiError && failure.status === 429
        ? 'Quote request limit reached. Try again later.'
        : failure instanceof ApiError && ERROR_MESSAGES[failure.code]
          ? ERROR_MESSAGES[failure.code]
          : 'The quote request failed. Check your API permissions and try again.';
      setError(`${t(message)}${failure instanceof ApiError && failure.label ? ` (${failure.label})` : ''}`);
    } finally {
      submitting.current = false;
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  return <article className="flash-swap-card terminal-panel" role="region" aria-labelledby="flash-swap-title">
    <div className="section-title">
      <div><p className="eyebrow">{t('Funding operations')}</p><h2 id="flash-swap-title">{t('Flash Swap')}</h2></div>
      <span className="flash-swap-badge">{t('Quotes only')}</span>
    </div>
    <div className="flash-swap-body">
      <form className="transfer-form" onSubmit={(event) => void requestQuote(event)}>
        <div className="flash-swap-route"><strong>Kraken · USD</strong><span aria-hidden="true">→</span><strong>CrossEx · USDT</strong></div>
        <label className="transfer-field">
          <span>{t('Amount')}<small>{t('Available')} {availableUsd ?? '—'} USD</small></span>
          <span className="transfer-input-wrap">
            <input aria-label={t('USD amount')} value={amount} onChange={(event) => editAmount(event.target.value)}
              inputMode="decimal" autoComplete="off" placeholder="0.00" />
            <strong>USD</strong>
          </span>
        </label>
        {!profileId ? <p className="transfer-note warn">{t('Configure Gate API credentials in Settings first.')}</p>
          : accountMode && !supportedMode ? <p className="transfer-note warn">{t('Kraken USD conversion requires cross-exchange account mode.')}</p>
            : !accountMode ? <p className="transfer-note">{t('Waiting for a fresh account snapshot.')}</p> : null}
        {profileId && amount.trim() && !valid && <p className="transfer-note warn">{t('Enter a positive USD amount with at most 16 decimal places.')}</p>}
        <p className="transfer-note">{t('Manual quotes. Gate allows up to 100 quote requests per day.')}</p>
        <button className="flash-swap-submit" type="submit" disabled={!valid || !supportedMode || busy}>
          {busy ? t('Requesting quote…') : t('Request quote')}
        </button>
      </form>
      <div className="flash-swap-result" aria-live="polite" aria-atomic="true">
        {quote ? <>
          <span>{t('You receive')}</span><strong className="flash-swap-receive">{quote.toAmount} USDT</strong>
          <dl><div><dt>{t('You sell')}</dt><dd>{quote.fromAmount} USD</dd></div>
            <div><dt>{t('Quoted rate')}</dt><dd>{quote.price} USDT / USD</dd></div></dl>
          <p>{t('Request a new quote to refresh the rate.')}</p>
        </> : <p>{t('Enter a USD amount and request a quote.')}</p>}
        {error && <p className="transfer-feedback error" role="alert">{error}</p>}
        <p className="flash-swap-note">{t('Quotes only. Conversion is not enabled.')}</p>
      </div>
    </div>
  </article>;
}
