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
      stacked: card.classList.contains('actions-below'),
      buttons: actions ? actions.querySelectorAll('button').length : 0,
      amountRight: Math.round(amount.right),
      bottomGap: Math.round(card.getBoundingClientRect().bottom - amount.bottom),
      amountLeft: Math.round(card.querySelector('.player-position-wrap')!.getBoundingClientRect().left),
      cardRight: Math.round(card.getBoundingClientRect().right),
      amountTop: Math.round(amount.top),
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

test('player rows label amounts and keep stacked amounts on one right edge with buttons beside them', async ({ page, browser, baseURL }) => {
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
  expect(compact.map(row => row.stacked)).toEqual([false, false]);
  expect(compact.map(row => row.label)).toEqual(['Result', 'In']);
  expect(compact[0]!.buttons).toBe(0);
  expect(compact[0]!.amountRight).toBe(compact[0]!.cardRight - 16);
  expect(compact[1]!.amountRight).toBeLessThanOrEqual(compact[1]!.actionsLeft!);
  expect(compact[0]!.amountColor).toBe(compact[0]!.nameColor);

  const long = await addPlayer(page, 'Alexandria Montgomery-Vanderbilt the Third');
  await money(page, long.id, '123456789.99');
  await expect(page.locator('.players > .player-card.actions-below')).toHaveCount(3);
  const stacked = await rows(page);
  await expect(page.getByTestId('saved-confirmation')).toBeVisible();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const clearance = await page.evaluate(() => document.querySelector('.notice')!.getBoundingClientRect().top - (document.querySelector('.workspace')!.getBoundingClientRect().bottom - Number.parseFloat(getComputedStyle(document.querySelector('.workspace')!).paddingBottom)));
  expect(clearance).toBeGreaterThanOrEqual(0);
  await page.evaluate(() => scrollTo(0, 0));
  const withButtons = stacked.filter(row => row.buttons > 0);
  expect(withButtons.length).toBe(2);
  expect(new Set(stacked.map(row => row.cardRight - row.amountRight))).toEqual(new Set([16]));
  for (const row of withButtons) expect(row.amountLeft).toBeGreaterThan(row.actionsRight!);
  for (const row of stacked) expect(row.nameRight).toBeLessThanOrEqual(row.cardRight - 16);
  expect(stacked[0]!.bottomGap).toBeLessThanOrEqual(9);

  const link = await share(page);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL, viewport: { width: 393, height: 852 }, locale: 'en-US', timezoneId: 'UTC' });
  try {
    const viewer = await context.newPage();
    await viewer.goto(link);
    await expect(viewer.getByText(/View only ·/)).toBeVisible();
    await expect(viewer.locator('.players > .player-card.actions-below')).toHaveCount(3);
    const shown = await rows(viewer);
    expect(shown.map(row => row.label)).toEqual(['Result', 'In', 'In']);
    expect(new Set(shown.map(row => row.cardRight - row.amountRight))).toEqual(new Set([16]));
  } finally { await context.close(); }
});

test('narrow phones keep one amount position, put buttons beside amounts when they fit and keep sheet actions in reach', async ({ page, browser, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await createAccount(page);
  await newSession(page, 'Narrow');
  const justin = await addPlayer(page, 'Justin');
  const priya = await addPlayer(page, 'Priya');
  await money(page, justin.id, '200');
  await money(page, priya.id, '200');
  const long = await addPlayer(page, 'Alexandria Montgomery-Vanderbilt the Third');
  await money(page, long.id, '50');
  await expect(page.locator('.players.inline-actions > .player-card.actions-below')).toHaveCount(3);
  const inline = await rows(page);
  expect(new Set(inline.map(row => row.cardRight - row.amountRight))).toEqual(new Set([16]));
  for (const row of inline) {
    expect(row.amountLeft).toBeGreaterThan(row.actionsRight!);
    expect(row.amountTop).toBeGreaterThanOrEqual(row.actionsTop!);
  }

  const link = await share(page);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL, viewport: { width: 320, height: 568 }, locale: 'en-US', timezoneId: 'UTC' });
  try {
    const viewer = await context.newPage();
    await viewer.goto(link);
    await expect(viewer.getByText(/View only ·/)).toBeVisible();
    await expect(viewer.locator('.players > .player-card.actions-below')).toHaveCount(3);
    await expect(viewer.locator('.players.inline-actions')).toHaveCount(0);
    const shown = await rows(viewer);
    expect(new Set(shown.map(row => row.cardRight - row.amountRight))).toEqual(new Set([16]));
    for (const row of shown) expect(row.bottomGap).toBeLessThanOrEqual(9);
  } finally { await context.close(); }
  await expect(page.getByTestId('saved-confirmation')).toHaveCount(0, { timeout: 15000 });
  await money(page, long.id, '123456789.99');
  await expect(page.locator('.players > .player-card.actions-below')).toHaveCount(3);
  await expect(page.locator('.players.inline-actions')).toHaveCount(0);
  const apart = await rows(page);
  expect(new Set(apart.map(row => row.cardRight - row.amountRight))).toEqual(new Set([16]));
  for (const row of apart) expect(row.actionsTop!).toBeGreaterThan(row.amountTop);
  expect(new Set(apart.map(row => row.amountSize))).toEqual(new Set(['16px']));


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
