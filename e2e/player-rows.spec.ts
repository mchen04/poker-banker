import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { addPlayer, createAccount, menu, money, newSession, openMoney, share } from './helpers';

async function rows(page: Page) {
  return page.locator('.players > .player-card').evaluateAll(cards => cards.map(card => {
    const amount = card.querySelector('.player-position')!.getBoundingClientRect();
    const actions = card.querySelector('.player-actions');
    const name = card.querySelector('.player-name strong')!;
    return {
      nameRight: Math.round(name.getBoundingClientRect().right),
      nameBottom: Math.round(name.getBoundingClientRect().bottom),
      amountBelow: card.classList.contains('amount-below'),
      actionsBelow: card.classList.contains('actions-below'),
      buttons: actions ? actions.querySelectorAll('button').length : 0,
      amountRight: Math.round(amount.right),
      amountTop: Math.round(amount.top),
      amountBottom: Math.round(amount.bottom),
      amountLeft: Math.round(card.querySelector('.player-position-wrap')!.getBoundingClientRect().left),
      cardRight: Math.round(card.getBoundingClientRect().right),
      nameTop: Math.round(name.getBoundingClientRect().top),
      actionsTop: actions?.querySelector('button') ? Math.round(actions.querySelector('button')!.getBoundingClientRect().top) : null,
      actionsLeft: actions?.querySelector('button') ? Math.round(actions.querySelector('button')!.getBoundingClientRect().left) : null,
      actionsRight: actions?.querySelector('button:last-child') ? Math.round(actions.querySelector('button:last-child')!.getBoundingClientRect().right) : null,
      label: card.querySelector('.position-label')?.textContent?.trim(),
      amountColor: getComputedStyle(card.querySelector('.player-position')!).color,
      amountSize: getComputedStyle(card.querySelector('.player-position')!).fontSize,
      nameColor: getComputedStyle(name).color,
    };
  }));
}

test('player rows keep one amount edge, never overlap the name and keep buttons below the amount when a name is wide', async ({ page, browser, baseURL }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await createAccount(page);
  await newSession(page, 'Row layout');
  const justin = await addPlayer(page, 'Justin');
  const sam = await addPlayer(page, 'Sam');
  await money(page, justin.id, '200');
  await money(page, justin.id, '150', { kind: 'Cash out', paid: true });
  await money(page, sam.id, '50', { paid: false });
  await expect(page.getByTestId(`result-${justin.id}`)).toContainText('$50.00');

  const compact = await rows(page);
  expect(compact.map(row => row.amountBelow)).toEqual([false, false]);
  expect(compact.map(row => row.label)).toEqual(['Result', 'In']);
  expect(compact[0]!.buttons).toBe(0);
  expect(new Set(compact.map(row => row.amountRight)).size).toBe(1);
  expect(compact[1]!.amountRight).toBeLessThanOrEqual(compact[1]!.actionsLeft! - 4);
  expect(compact[0]!.amountColor).toBe(compact[0]!.nameColor);
  for (const row of compact) expect(row.nameRight).toBeLessThanOrEqual(row.amountLeft);

  const long = await addPlayer(page, 'Alexandria Montgomery-Vanderbilt the Third');
  await money(page, long.id, '123456789.99');
  await expect(page.locator('.players > .player-card.amount-below')).toHaveCount(1);
  const stacked = await rows(page);
  await expect(page.getByTestId('saved-confirmation')).toBeVisible();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const clearance = await page.evaluate(() => document.querySelector('.notice')!.getBoundingClientRect().top - (document.querySelector('.workspace')!.getBoundingClientRect().bottom - Number.parseFloat(getComputedStyle(document.querySelector('.workspace')!).paddingBottom)));
  expect(clearance).toBeGreaterThanOrEqual(0);
  const before = await page.evaluate(() => document.querySelector('.players > .player-card:last-child')!.getBoundingClientRect().top);
  const steady = await page.evaluate(() => scrollY);
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => scrollY)).toBe(steady);
  await expect(page.getByTestId('saved-confirmation')).toHaveCount(0, { timeout: 15000 });
  expect(await page.evaluate(() => document.querySelector('.players > .player-card:last-child')!.getBoundingClientRect().top)).toBe(before);
  await page.evaluate(() => scrollTo(0, 0));
  expect(new Set(stacked.map(row => row.amountRight)).size, JSON.stringify(stacked.map(row => ({ label: row.label, right: row.amountRight, left: row.amountLeft, top: row.amountTop, bottom: row.amountBottom, nameTop: row.nameTop, nameRight: row.nameRight, buttons: row.buttons, actionsLeft: row.actionsLeft, actionsTop: row.actionsTop, below: row.amountBelow, card: row.cardRight })))).toBe(1);
  expect(stacked.map(row => row.actionsBelow)).toEqual([true, true, true]);
  for (const row of stacked) {
    expect(row.nameRight).toBeLessThanOrEqual(row.cardRight - 16);
    if (row.buttons) expect(row.actionsTop!).toBeGreaterThanOrEqual(row.amountBottom);
  }
  for (const row of stacked.filter(item => item.amountBelow)) expect(row.nameBottom).toBeLessThanOrEqual(row.amountTop);
  expect(Math.abs(stacked[0]!.amountTop - stacked[0]!.nameTop)).toBeLessThanOrEqual(24);

  const link = await share(page);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL, viewport: { width: 393, height: 852 }, locale: 'en-US', timezoneId: 'UTC' });
  try {
    const viewer = await context.newPage();
    await viewer.goto(link);
    await expect(viewer.getByText(/View only ·/)).toBeVisible();
    const shown = await rows(viewer);
    expect(shown.map(row => row.label)).toEqual(['Result', 'In', 'In']);
    expect(new Set(shown.map(row => row.cardRight - row.amountRight))).toEqual(new Set([16]));
    for (const row of shown) expect(row.amountBelow ? row.nameBottom <= row.amountTop : row.nameRight <= row.amountLeft).toBe(true);
  } finally { await context.close(); }
});

test('narrow phones put row buttons below the amount, keep one amount edge and keep sheet actions in reach', async ({ page, browser, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await createAccount(page);
  await newSession(page, 'Narrow');
  const justin = await addPlayer(page, 'Justin');
  const priya = await addPlayer(page, 'Priya');
  await money(page, justin.id, '200');
  await money(page, priya.id, '200');
  const long = await addPlayer(page, 'Alexandria Montgomery-Vanderbilt the Third');
  await money(page, long.id, '50');
  await expect(page.locator('.players > .player-card.amount-below')).toHaveCount(1);
  const inline = await rows(page);
  expect(new Set(inline.map(row => row.cardRight - row.amountRight))).toEqual(new Set([16]));
  for (const row of inline.filter(item => item.buttons > 0)) expect(row.actionsTop!).toBeGreaterThan(row.amountTop);
  for (const row of inline) expect(row.nameRight).toBeLessThanOrEqual(row.cardRight - 16);

  const link = await share(page);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL, viewport: { width: 320, height: 568 }, locale: 'en-US', timezoneId: 'UTC' });
  try {
    const viewer = await context.newPage();
    await viewer.goto(link);
    await expect(viewer.getByText(/View only ·/)).toBeVisible();
    const shown = await rows(viewer);
    expect(new Set(shown.map(row => row.cardRight - row.amountRight))).toEqual(new Set([16]));
    for (const row of shown) expect(row.amountBelow ? row.nameBottom <= row.amountTop : Math.abs(row.amountTop - row.nameTop) <= 24).toBe(true);
  } finally { await context.close(); }
  await expect(page.getByTestId('saved-confirmation')).toHaveCount(0, { timeout: 15000 });
  await money(page, long.id, '123456789.99');
  await expect(page.locator('.players > .player-card.amount-below')).toHaveCount(1);
  await page.waitForTimeout(300);
  const apart = await rows(page);

  expect(new Set(apart.map(row => row.cardRight - row.amountRight))).toEqual(new Set([16]));
  for (const row of apart.filter(item => item.buttons > 0)) expect(row.actionsTop!).toBeGreaterThan(row.amountTop);
  expect(new Set(apart.map(row => row.amountSize))).toEqual(new Set(['17px']));

  await expect(page.getByTestId('saved-confirmation')).toHaveCount(0, { timeout: 15000 });
  await page.setViewportSize({ width: 320, height: 480 });
  await openMoney(page, long.id, 'Buy-in');
  const fields = page.locator('.money-fields');
  const footer = page.locator('.money-actions');
  await expect.poll(() => fields.evaluate(element => element.scrollHeight > element.clientHeight + 1)).toBe(true);
  await expect(footer).toHaveClass(/content-below/);
  await expect(page.locator('.quick-amounts button').first()).toBeEnabled();
  await expect.poll(async () => { await fields.evaluate(element => { element.scrollTop = element.scrollHeight; }); return footer.evaluate(element => element.classList.contains('content-below')); }).toBe(false);
  await page.getByText('Record an earlier time or note', { exact: true }).click();
  await expect(footer).toHaveClass(/content-below/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await menu(page, 'Close session');
  const sheet = page.locator('.sheet-fields');
  const close = page.getByRole('dialog').getByRole('button', { name: 'Close session', exact: true });
  await expect.poll(() => sheet.evaluate(element => element.scrollHeight > element.clientHeight + 1)).toBe(true);
  await expect(close).toBeDisabled();
  await expect(close).toBeInViewport({ ratio: 1 });
  await expect(close).toHaveAccessibleDescription('Cash out 3 players first');
  await expect.poll(() => sheet.evaluate(element => element.style.scrollPaddingBottom === `${element.querySelector<HTMLElement>('.sticky-action')!.offsetHeight + 16}px`)).toBe(true);
  const blockers = page.getByRole('dialog').locator('.close-blocker');
  for (let index = 0; index < 3; index += 1) {
    await blockers.nth(index).focus();
    await expect(blockers.nth(index)).toBeFocused();
    const clear = await blockers.nth(index).evaluate(element => element.getBoundingClientRect().bottom <= document.querySelector('.sticky-action')!.getBoundingClientRect().top + 1);
    expect(clear, `focused blocker ${index} stays above the Close bar`).toBe(true);
  }
});

test('a long single-word name moves the amount below instead of breaking mid-word', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await createAccount(page);
  await newSession(page, 'Single word');
  for (const name of ['Justin', 'Sam', 'Morgan', 'Drew', 'Taylor', 'Casey', 'Jordan']) { const row = await addPlayer(page, name); await money(page, row.id, '50', { paid: false }); }
  const singleWord = await addPlayer(page, 'Maximilianssonssonssonssons');
  await money(page, singleWord.id, '50', { paid: false });
  for (const width of [393, 320]) {
    await page.setViewportSize({ width, height: width === 393 ? 852 : 568 });
    await page.waitForTimeout(200);
    const single = await page.getByTestId(`player-${singleWord.id}`).locator('strong[title]').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); return { lines: range.getClientRects().length, below: element.closest('.player-card')!.classList.contains('amount-below') }; });
    expect(single.lines, `at ${width}`).toBe(1);
  }
});
