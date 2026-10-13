import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const profileId = 'gate-crossex-default';
const secondProfileId = 'gate-crossex-secondary';
const timestamp = '2030-01-01T00:00:00.000Z';
const quoted = {
  quoteId: 'quote-1', profileId, fromCoin: 'KRAKEN_USD', toCoin: 'CROSSEX_USDT',
  fromAmount: '25', toAmount: '24.975', price: '0.999', validMs: '5000', quotedAt: timestamp, executionEnabled: false,
};

function accountConnection(activeProfileId = profileId, credentialGeneration = 0, lastVerifiedAt = timestamp) {
  return {
    configured: true, storage: 'memory_test_only', label: activeProfileId === profileId ? 'Quote account' : 'Second account',
    lastVerifiedAt, credentialGeneration, secureEntryPath: '/secure/credentials', readOnly: true, activeProfileId,
    profiles: [
      { id: profileId, label: 'Quote account', storage: 'memory_test_only', lastVerifiedAt: timestamp, active: activeProfileId === profileId },
      { id: secondProfileId, label: 'Second account', storage: 'memory_test_only', lastVerifiedAt: timestamp, active: activeProfileId === secondProfileId },
    ],
  };
}

function portfolioSnapshot(accountMode = 'CROSS_EXCHANGE', availableBalance = '100') {
  return {
    dataStatus: 'fresh', remoteStatus: 'healthy',
    snapshot: {
      account: { availableMargin: '1000', marginBalance: '1500', initialMargin: '500', maintenanceMargin: '200',
        initialMarginRate: '3', maintenanceMarginRate: '7.5', positionMode: 'SINGLE', accountMode,
        exchangeType: 'CROSSEX', remoteUpdatedAt: timestamp },
      balances: [{ venue: 'KRAKEN', coin: 'USD', balance: '1000', availableBalance, equity: '1000', unrealizedPnl: '0',
        futuresInitialMargin: '0', futuresMaintenanceMargin: '0', borrowingInitialMargin: '0', borrowingMaintenanceMargin: '0', liability: '0' }],
      futuresPositions: [], marginPositions: [], openOrders: [], recentFills: [], fetchedAt: timestamp,
      source: 'gate_crossex_authenticated_rest',
    },
    reconciliation: { id: 'reconciliation-1', createdAt: timestamp, status: 'clean', previousFetchedAt: null, currentFetchedAt: timestamp, issues: [] },
  };
}

async function mockPortfolio(page: Page, accountMode = 'CROSS_EXCHANGE', verificationTime = () => timestamp) {
  await page.routeWebSocket('**/ws/stream', (socket) => {
    socket.send(JSON.stringify({ type: 'mode.update', payload: { mode: 'readonly' } }));
  });
  await page.route('**/api/trading-mode', (route) => route.fulfill({ json: { mode: 'readonly' } }));
  await page.route('**/api/onboarding/connection', (route) => route.fulfill({ json: accountConnection(profileId, 0, verificationTime()) }));
  await page.route('**/api/crossex/portfolio-snapshot', (route) => route.fulfill({ json: portfolioSnapshot(accountMode) }));
  await page.route('**/api/strategies', (route) => route.fulfill({ json: { strategies: [] } }));
}

async function visitPortfolio(page: Page) {
  await page.goto('/portfolio');
  const dialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
  await dialog.waitFor({ state: 'visible', timeout: 500 }).catch(() => undefined);
  if (await dialog.isVisible()) {
    await dialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
    await dialog.getByRole('button', { name: /Continue in read-only mode/ }).click();
  }
  await expect(page.getByRole('heading', { name: 'Flash Swap', exact: true })).toBeVisible();
  return page.getByRole('region', { name: 'Flash Swap', exact: true });
}

async function openPortfolio(page: Page, accountMode = 'CROSS_EXCHANGE', verificationTime = () => timestamp) {
  await mockPortfolio(page, accountMode, verificationTime);
  return visitPortfolio(page);
}

async function switchToSecondAccount(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /^Manage and switch accounts/ }).click();
  const manager = page.getByRole('dialog', { name: 'Manage and switch accounts', exact: true });
  await manager.locator('article').filter({ hasText: 'Second account' }).getByRole('button', { name: 'Switch', exact: true }).click();
  await expect(manager.locator('article.active')).toContainText('Second account');
  await manager.getByRole('button', { name: 'Close', exact: true }).click();
}

test('manually quotes available Kraken USD and clears the result after editing', async ({ page }, testInfo) => {
  const requests: unknown[] = [];
  let executions = 0;
  await page.route('**/api/crossex/convert/quote', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: quoted });
  });
  await page.route('**/api/crossex/convert/orders', async (route) => {
    executions += 1;
    await route.fulfill({ status: 404 });
  });
  const card = await openPortfolio(page);
  await expect(card).toContainText('100 USD');
  await expect(card).toContainText('Quotes only');
  await expect(page.getByRole('heading', { name: 'Transfer funds' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Request quote', exact: true })).toBeDisabled();
  await card.getByRole('textbox', { name: 'USD amount' }).fill('25');
  await card.getByRole('button', { name: 'Request quote', exact: true }).click();
  await expect(card.getByText('24.975 USDT', { exact: true })).toBeVisible();
  await card.screenshot({ path: testInfo.outputPath('flash-swap-dark.png') });
  expect((await new AxeBuilder({ page }).include('.flash-swap-card').analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Light mode', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await card.screenshot({ path: testInfo.outputPath('flash-swap-light.png') });
  expect((await new AxeBuilder({ page }).include('.flash-swap-card').analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await card.screenshot({ path: testInfo.outputPath('flash-swap-mobile.png') });
  expect(requests).toEqual([{ profileId, fromAmount: '25' }]);
  await page.waitForTimeout(700);
  expect(requests).toHaveLength(1);
  expect(executions).toBe(0);
  await card.getByRole('textbox', { name: 'USD amount' }).fill('26');
  await expect(card.getByText('24.975 USDT', { exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: /Confirm|Convert/ })).toHaveCount(0);
});

test('ignores a delayed quote for an edited amount and prevents duplicate submits', async ({ page }) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route('**/api/crossex/convert/quote', async (route) => {
    requests += 1;
    await blocked;
    await route.fulfill({ json: quoted });
  });
  const card = await openPortfolio(page);
  await card.getByRole('textbox', { name: 'USD amount' }).fill('25');
  await card.locator('form').evaluate((form) => { (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit(); });
  await expect.poll(() => requests).toBe(1);
  await card.getByRole('textbox', { name: 'USD amount' }).fill('30');
  release();
  await expect(card.getByRole('button', { name: 'Request quote', exact: true })).toBeEnabled();
  await expect(card.getByText('24.975 USDT', { exact: true })).toHaveCount(0);
  expect(requests).toBe(1);
});

test('explains unsupported isolated mode and never requests a quote', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/crossex/convert/quote', async (route) => { requests += 1; await route.fulfill({ json: quoted }); });
  const card = await openPortfolio(page, 'ISOLATED_EXCHANGE');
  await card.getByRole('textbox', { name: 'USD amount' }).fill('25');
  await expect(card).toContainText('requires cross-exchange account mode');
  await expect(card.getByRole('button', { name: 'Request quote', exact: true })).toBeDisabled();
  expect(requests).toBe(0);
});

test('preserves an entered amount across ordinary account verification refreshes', async ({ page }) => {
  let verifiedAt = timestamp;
  const card = await openPortfolio(page, 'CROSS_EXCHANGE', () => verifiedAt);
  await card.getByRole('textbox', { name: 'USD amount' }).fill('25');
  verifiedAt = '2030-01-01T00:00:01.000Z';
  const refreshed = page.waitForResponse('**/api/onboarding/connection');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await expect(card.getByRole('textbox', { name: 'USD amount' })).toHaveValue('25');
});

test('keeps the selected account when the initial connection response arrives after a switch', async ({ page }) => {
  const card = await openPortfolio(page);
  await expect(card).toContainText('100 USD');
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let connectionRequests = 0;
  let activeProfileId = profileId;
  await page.route('**/api/onboarding/connection', async (route) => {
    const initial = ++connectionRequests === 1;
    const response = accountConnection(activeProfileId, activeProfileId === profileId ? 0 : 1);
    if (initial) await blocked;
    await route.fulfill({ json: response });
  });
  await page.route(`**/api/onboarding/accounts/${secondProfileId}/activate`, async (route) => {
    activeProfileId = secondProfileId;
    await route.fulfill({ json: accountConnection(secondProfileId, 1) });
  });
  let quotedProfile: string | undefined;
  await page.route('**/api/crossex/convert/quote', async (route) => {
    quotedProfile = route.request().postDataJSON().profileId;
    await route.fulfill({ json: { ...quoted, profileId: quotedProfile } });
  });
  await page.getByRole('button', { name: 'Funding Rates', exact: true }).click();
  await page.getByRole('button', { name: 'Portfolio', exact: true }).click();
  await expect.poll(() => connectionRequests).toBe(1);
  await switchToSecondAccount(page);
  const lateResponse = page.waitForResponse('**/api/onboarding/connection');
  release();
  await lateResponse;
  await card.getByRole('textbox', { name: 'USD amount' }).fill('25');
  await card.getByRole('button', { name: 'Request quote', exact: true }).click();
  await expect(card.getByText('24.975 USDT', { exact: true })).toBeVisible();
  expect(quotedProfile).toBe(secondProfileId);
});

test('loads the new account and ignores the old account portfolio response after switching', async ({ page }) => {
  await mockPortfolio(page);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let activeProfileId = profileId;
  let snapshotRequests = 0;
  let acknowledgeRelease!: () => void;
  const responseReleased = new Promise<void>((resolve) => { acknowledgeRelease = resolve; });
  await page.route('**/api/onboarding/connection', (route) => route.fulfill({ json: accountConnection(activeProfileId, activeProfileId === profileId ? 0 : 1) }));
  await page.route(`**/api/onboarding/accounts/${secondProfileId}/activate`, async (route) => {
    activeProfileId = secondProfileId;
    await route.fulfill({ json: accountConnection(secondProfileId, 1) });
  });
  await page.route('**/api/crossex/portfolio-snapshot', async (route) => {
    const initial = ++snapshotRequests === 1;
    if (initial) await blocked;
    try {
      await route.fulfill({ json: portfolioSnapshot('CROSS_EXCHANGE', initial ? '100' : '50') });
    } finally {
      if (initial) acknowledgeRelease();
    }
  });
  const card = await visitPortfolio(page);
  await expect.poll(() => snapshotRequests).toBe(1);
  await switchToSecondAccount(page);
  await expect(card).toContainText('50 USD');
  await card.getByRole('textbox', { name: 'USD amount' }).fill('25');
  release();
  await responseReleased;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(card).toContainText('50 USD');
  await expect(card.getByRole('textbox', { name: 'USD amount' })).toHaveValue('25');
});
