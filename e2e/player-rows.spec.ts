import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { addPlayer, createAccount, money, newSession, share } from './helpers';

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
      cardRight: Math.round(card.getBoundingClientRect().right),
      actionsLeft: actions?.querySelector('button') ? Math.round(actions.querySelector('button')!.getBoundingClientRect().left) : null,
      label: card.querySelector('.position-label')?.textContent?.trim(),
      amountColor: getComputedStyle(card.querySelector('.player-position')!).color,
      nameColor: getComputedStyle(name).color,
    };
  }));
}

test('player rows label amounts, keep them in one right-aligned column and switch layout together', async ({ page, browser, baseURL }) => {
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
  const withButtons = stacked.filter(row => row.buttons > 0);
  expect(withButtons.length).toBe(2);
  expect(new Set(withButtons.map(row => row.amountRight)).size).toBe(1);
  for (const row of withButtons) expect(row.amountRight).toBeLessThanOrEqual(row.actionsLeft!);
  expect(stacked[0]!.amountRight).toBe(stacked[0]!.cardRight - 16);
  for (const row of stacked) expect(row.nameRight).toBeLessThanOrEqual(row.cardRight - 16);

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
