import type { LiveMarket, MarketConnectionState } from './types.js';
import { isLighterFundingSymbol, type LighterMarketFeed } from './lighter-market-feed.js';

export interface CompositeMarketDelegate {
  market(symbol: string): LiveMarket | null;
  ensureMarket?(symbol: string): boolean;
  connectionState?(): MarketConnectionState;
  connectionStateFor?(symbol: string): MarketConnectionState;
}

export class CompositeMarketSource {
  constructor(
    private readonly crossEx: CompositeMarketDelegate,
    private readonly lighter: Pick<LighterMarketFeed, 'market' | 'ensureMarket' | 'connectionState' | 'connectionStateFor' | 'start' | 'stop'>,
  ) {}

  async start(): Promise<void> {
    await this.lighter.start();
  }

  async stop(): Promise<void> {
    await this.lighter.stop();
  }

  market(symbol: string): LiveMarket | null {
    return isLighterFundingSymbol(symbol) ? this.lighter.market(symbol) : this.crossEx.market(symbol);
  }

  ensureMarket(symbol: string): boolean {
    if (isLighterFundingSymbol(symbol)) return this.lighter.ensureMarket(symbol);
    return this.crossEx.ensureMarket?.(symbol) ?? this.crossEx.market(symbol) !== null;
  }

  connectionState(): MarketConnectionState {
    return this.crossEx.connectionState?.() ?? 'disconnected';
  }

  connectionStateFor(symbol: string): MarketConnectionState {
    if (isLighterFundingSymbol(symbol)) return this.lighter.connectionStateFor(symbol);
    return this.crossEx.connectionStateFor?.(symbol) ?? this.crossEx.connectionState?.() ?? 'disconnected';
  }
}
