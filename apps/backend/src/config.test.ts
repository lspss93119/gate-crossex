import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('backend configuration', () => {
  it('uses the readonly Lighter mainnet WebSocket by default', () => {
    const config = loadConfig({ GCT_DATA_DIR: '/tmp/gate-crossex-config-test' });

    expect(config.lighterPublicWebSocketUrl).toBe('wss://mainnet.zklighter.elliot.ai/stream?readonly=true');
  });

  it('allows the public Lighter WebSocket endpoint to be overridden without credentials', () => {
    const config = loadConfig({
      GCT_DATA_DIR: '/tmp/gate-crossex-config-test',
      GCT_LIGHTER_WS_URL: 'wss://lighter.example.test/stream?readonly=true',
    });

    expect(config.lighterPublicWebSocketUrl).toBe('wss://lighter.example.test/stream?readonly=true');
    expect(Object.keys(config).some((key) => key.toLowerCase().includes('lighter') && key.toLowerCase().includes('credential'))).toBe(false);
  });
});
