import { expect, test, type Page } from '@playwright/test';

async function setLimit(page: Page, m: number) {
  const num = page.getByLabel('Maximum distance between rests in meters');
  await num.fill(String(m));
  await num.press('Enter');
}

async function pickDemoTrip(page: Page) {
  await page.goto('/');
  await page.getByLabel('Saved demo trips').selectOption('slider-demo');
  await expect(page.getByTestId('status-heading')).toBeVisible();
}

test('feasible flow: slider changes the route from real results', async ({ page }) => {
  await pickDemoTrip(page);
  await expect(page.getByTestId('demo-indicator')).toBeVisible();
  await expect(page.getByTestId('status-heading')).toContainText('Within your selected limit');
  await expect(page.getByTestId('metric-total')).toHaveText('622 m');
  await expect(page.getByTestId('metric-rests')).toHaveText('1');
  await setLimit(page, 150);
  await expect(page.getByTestId('metric-total')).toHaveText('904 m');
  await expect(page.getByTestId('metric-rests')).toHaveText('8');
  await expect(page.getByTestId('status-heading')).toContainText('(150 m)');
  // route drawn as map paths, numbered seats shown
  await expect(page.locator('path.route-leg:not(.over)')).toHaveCount(9);
  await expect(page.locator('.map-pin.stop')).toHaveCount(8);
});

test('limit-unmet flow: fallback shows smallest achievable gap and amber legs', async ({ page }) => {
  await pickDemoTrip(page);
  await setLimit(page, 100);
  await expect(page.getByTestId('status-heading')).toContainText('Limit not met');
  await expect(page.getByTestId('status-message')).toContainText('smallest achievable longest gap is 136 m');
  await expect(page.locator('button.leg.over')).toHaveCount(2);
  await expect(page.locator('path.route-leg.over')).toHaveCount(2);
  // selecting a leg highlights it
  await page.locator('button.leg.over').first().click();
  await expect(page.locator('button.leg.over').first()).toHaveAttribute('aria-pressed', 'true');
});

test('no-data flow: Flushing pilot without imported data says so', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Flushing pilot' }).click();
  await expect(page.getByTestId('live-unavailable')).toContainText('has not been imported');
  const map = page.locator('.leaflet-container');
  await page.getByRole('button', { name: 'Set on map' }).first().click();
  await map.click({ position: { x: 300, y: 300 } });
  await page.getByRole('button', { name: 'Set on map' }).nth(1).click();
  await map.click({ position: { x: 500, y: 350 } });
  await page.getByRole('button', { name: 'Find route' }).click();
  await expect(page.getByTestId('status-heading')).toHaveText('Pilot data not available');
  await expect(page.locator('path.route-leg:not(.over)')).toHaveCount(0);
});

test('disconnected trip is explained, not drawn', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Saved demo trips').selectOption('disconnected');
  await expect(page.getByTestId('status-heading')).toHaveText('No connected walking route');
});

test('map tile failure leaves route lines and text usable', async ({ page }) => {
  await page.route(/tile\.openstreetmap\.org/, (r) => r.abort());
  await pickDemoTrip(page);
  await page.getByLabel('Show basemap').check();
  await expect(page.getByTestId('tile-error')).toBeVisible();
  await expect(page.getByTestId('leg-list')).toBeVisible();
  await expect(page.locator('path.route-leg:not(.over)').first()).toBeVisible();
});

test('excluding a seat recalculates', async ({ page }) => {
  await pickDemoTrip(page);
  await expect(page.getByTestId('metric-total')).toHaveText('622 m');
  await page.getByRole('button', { name: 'Exclude this seat' }).first().click();
  await expect(page.getByTestId('metric-total')).toHaveText('868 m');
  await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible();
});

test('print view shows a text summary without the map', async ({ page }) => {
  await pickDemoTrip(page);
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('print-summary')).toBeVisible();
  await expect(page.getByTestId('print-summary')).toContainText('Total distance: 622 m');
  await expect(page.locator('.leaflet-container')).toBeHidden();
});

test('keyboard: limit can be changed with the keyboard @mobile', async ({ page }) => {
  await pickDemoTrip(page);
  const slider = page.getByLabel('Maximum distance between rests (slider)');
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByLabel('Maximum distance between rests in meters')).toHaveValue('390');
  await expect(page.getByTestId('status-heading')).toContainText('(390 m)');
});

test('mobile: results panel collapses @mobile', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile only');
  await pickDemoTrip(page);
  const toggle = page.getByRole('button', { name: 'Hide route details' });
  await toggle.click();
  await expect(page.getByTestId('leg-list')).toBeHidden();
  await page.getByRole('button', { name: 'Show route details' }).click();
  await expect(page.getByTestId('leg-list')).toBeVisible();
});

test('propose a hypothetical bench closes the gap at 100 m', async ({ page }) => {
  await pickDemoTrip(page);
  await setLimit(page, 100);
  await expect(page.getByTestId('status-heading')).toContainText('Limit not met');
  const gapLeg = page.locator('path.route-leg.over').first();
  const box = await gapLeg.boundingBox();
  await page.getByText('Propose a bench (planning experiment)').click();
  await page.getByRole('button', { name: 'Place a hypothetical bench' }).click();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.getByTestId('status-heading')).toContainText('Within your selected limit');
  await expect(page.getByTestId('hypo-compare')).toContainText('Limit not met');
  await expect(page.getByTestId('hypo-compare')).toContainText('136 m');
  await expect(page.locator('.map-pin.stop.hyp')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear all' }).click();
  await expect(page.getByTestId('status-heading')).toContainText('Limit not met');
});

test('switching data sets while the map moves throws no page errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Flushing pilot' }).click();
    await page.getByRole('button', { name: 'Demo (synthetic)' }).click();
  }
  await page.getByLabel('Saved demo trips').selectOption('slider-demo');
  await expect(page.getByTestId('metric-total')).toHaveText('622 m');
  await page.getByRole('button', { name: 'Flushing pilot' }).click();
  await page.getByRole('button', { name: 'Demo (synthetic)' }).click();
  expect(errors).toEqual([]);
});
