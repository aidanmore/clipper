import { test, expect } from '@playwright/test';
test('editor tour: audition, keep, trim, undo, and transcript passage', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'take a look around' }).click();
  await expect(page.locator('#studio')).toBeVisible();
  await page.locator('[data-candidate="tour1"]').click();
  await page.locator('#player').evaluate((a) => a.pause());
  await page.locator('#keepClip').click();
  await page.locator('#tabShortlist').click();
  await expect(page.locator('#shortlist .moment-card')).toHaveCount(1);
  await page.locator('#startTime').fill('00:16.0');
  await page.locator('#startTime').press('Tab');
  await expect(page.locator('#clipDuration')).toHaveText('11.0s');
  await page.locator('#undoButton').click();
  await expect(page.locator('#startTime')).toHaveValue('00:15.0');
  await page.locator('#tabTranscript').click();
  await page.locator('#selectPassage').click();
  await page.locator('[data-word="4"]').click();
  await page.locator('[data-word="12"]').click();
  await expect(page.locator('#toast')).toContainText('Passage selected');
  await page.screenshot({ path: 'test-results/desktop-editor.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('connected project persists cuts and exports a downloadable stereo file', async ({
  page,
  request,
}) => {
  const response = await request.post('/api/login', {
    data: { password: 'browser-tests-only-password' },
  });
  const { token } = await response.json();
  await page.addInitScript((token) => {
    sessionStorage.setItem('clipper.session', token);
    localStorage.setItem('clipper.lastProject', 'browser-fixture');
  }, token);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#episodeTitle')).toHaveText('Test episode — a good exchange');
  await page.locator('[data-candidate="candidate-a"]').click();
  await page.locator('#player').evaluate((a) => a.pause());
  await page.locator('#shortVersion').click();
  await expect(page.locator('#startTime')).toHaveValue('00:15.0');
  await page.locator('#clipTitle').fill('My saved cut');
  await page.locator('#clipTitle').press('Tab');
  await page.locator('#keepClip').click();
  await expect(page.locator('#saveStatus')).toHaveText('all changes saved');
  await page.reload();
  await expect(page.locator('#clipTitle')).toHaveValue('My saved cut');
  await expect(page.locator('#keptCount')).toHaveText('1');
  await page.locator('#startTime').fill('00:16.0');
  await page.locator('#startTime').press('Tab');
  await expect(page.locator('#saveStatus')).toHaveText('all changes saved');
  const savedProject = await request.get('/api/projects/browser-fixture', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect((await savedProject.json()).clips[0].start).toBe(16);
  await page.locator('#exportCurrent').click();
  await page.locator('#exportFormat').selectOption('wav');
  await page.locator('#beginExport').click();
  const download = page.locator('#exportJobs a').first();
  await expect(download).toBeVisible({ timeout: 20000 });
  const result = await request.get(await download.getAttribute('href'));
  expect(result.status()).toBe(200);
  expect((await result.body()).subarray(0, 4).toString()).toBe('RIFF');
  expect(errors).toEqual([]);
});
test('phone layout, passage selection, and dialogs stay within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'take a look around' }).click();
  await page.locator('[data-candidate="tour2"]').click();
  await page.locator('#player').evaluate((a) => a.pause());
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.locator('#keepClip').click();
  await page.locator('#tabShortlist').click();
  await expect(page.locator('#shortlist .moment-card')).toHaveCount(1);
  await page.locator('#projectMenu').click();
  await expect(page.locator('#optionsDialog')).toBeVisible();
  expect(
    await page
      .locator('#optionsDialog')
      .evaluate((el) => el.getBoundingClientRect().right <= innerWidth),
  ).toBe(true);
  await page.locator('#optionsDialog [data-close]').click();
  await page.screenshot({ path: 'test-results/mobile-editor.png', fullPage: true });
});

test('connect settings transitions from the tour to the private workspace', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('#demoButton').click();
  await expect(page.locator('#studio')).toBeVisible();
  await page.locator('#connectionButton').click();
  await page.locator('#workspacePassword').fill('browser-tests-only-password');
  await page.locator('#connectForm button[type=submit]').click();
  await expect(page.locator('#connectDialog')).not.toBeVisible();
  await expect(page.locator('#welcome')).toBeVisible();
  await page.locator('[data-project="browser-fixture"]').click();
  await expect(page.locator('#episodeTitle')).toHaveText('Test episode — a good exchange');
  expect(errors).toEqual([]);
});
