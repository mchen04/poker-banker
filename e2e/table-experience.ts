import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { addPlayer, call, current, keepMoneyDraft, menu, money, newContextLike, switchSession, workspaceReady } from './helpers';
import { typeInput } from './input';

type Tap = { label: string; taps: number; controls: string[] };
export type UxApprovalOptions = { page: Page; browser: Browser; baseURL: string; evidence: string; runId: string };

async function keyboard(page: Page, height: number | null) {
  await page.evaluate(height => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('Visual viewport is required for keyboard emulation');
    if (height === null) delete (viewport as unknown as Record<string, unknown>).height;
    else Object.defineProperty(viewport, 'height', { configurable: true, value: height });
    viewport.dispatchEvent(new Event('resize'));
  }, height);
}

export async function capture(page: Page, evidence: string, name: string) {
  await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: false });
  await writeFile(join(evidence, `${name}.aria.txt`), await page.locator('body').ariaSnapshot());
  await writeFile(join(evidence, `${name}.geometry.json`), JSON.stringify(await page.evaluate(() => {
    return { viewport: { width: innerWidth, height: innerHeight, visualHeight: visualViewport?.height }, activeField: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.getAttribute('data-testid'), horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      controls: [...document.querySelectorAll('button,input,select,[data-testid^="player-"]')].filter(element => element.getClientRects().length).map(element => { const box = element.getBoundingClientRect(); return { name: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 100), testid: element.getAttribute('data-testid'), x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom }; }) };
  }), null, 2));
}

export async function uxApproval({ page, browser, baseURL, evidence, runId }: UxApprovalOptions) {
  const originalViewport = page.viewportSize();
  await mkdir(evidence, { recursive: true });
  await page.goto('/'); await workspaceReady(page);
  expect((await call<{ sessions: unknown[] }>(page, '/sessions')).sessions, 'Run this recipe first in a fresh local verification banker').toHaveLength(0);
  const tag = `${runId.slice(-8)}-${randomUUID().slice(0, 4)}`;
  const short = randomUUID().slice(0, 3);
  const taps: Tap[] = [];
  async function measure(label: string, action: (tap: (control: Locator) => Promise<void>) => Promise<void>) {
    const controls: string[] = [];
    await action(async control => { const name = await control.getAttribute('aria-label') ?? (await control.innerText()).trim(); await control.click(); controls.push(name); });
    taps.push({ label, taps: controls.length, controls });
    await writeFile(join(evidence, 'tap-counts.json'), JSON.stringify(taps, null, 2));
  }
  async function saved() { await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0); }
  async function sheets(name: string) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await keyboard(page, null);
      await capture(page, evidence, `${name}-${scheme}-393x659`);
      await keyboard(page, 380);
      await page.getByTestId('money-amount').focus();
      await expect(page.getByRole('button', { name: 'Save entry', exact: true })).toBeInViewport({ ratio: 1 });
      const visible = await page.getByRole('button', { name: 'Save entry', exact: true }).boundingBox();
      expect(visible && visible.y + visible.height <= 380, 'Save must clear the emulated keyboard').toBe(true);
      await expect(page.getByTestId('money-amount')).toBeInViewport({ ratio: 1 });
      for (const groupName of ['Payment method', 'Payment direction']) {
        const group = page.getByRole('group', { name: groupName, exact: true });
        if (!await group.count()) continue;
        for (const choice of await group.getByRole('button').all()) {
          await expect(choice).toBeInViewport({ ratio: 1 });
          const bounds = await choice.boundingBox();
          expect(bounds && visible && bounds.y >= 0 && bounds.y + bounds.height <= visible.y, `${groupName} must be fully above Save`).toBe(true);
        }
      }
      await capture(page, evidence, `${name}-${scheme}-393x659-keyboard`);
    }
    await keyboard(page, null); await page.emulateMedia({ colorScheme: 'light' });
  }
  await page.setViewportSize({ width: 393, height: 659 });
  const firstName = `Tap table ${tag}`;
  await measure('Create first session', async tap => {
    await expect(page.getByRole('heading', { name: 'No active sessions', exact: true })).toBeVisible();
    await tap(page.getByTestId('session-bottom-bar').getByRole('button', { name: 'New session', exact: true }));
    await typeInput(page.getByLabel('Session name', { exact: true }), firstName);
    await tap(page.getByRole('button', { name: 'Create session', exact: true }));
    await expect(page.getByRole('heading', { name: firstName, exact: true })).toBeVisible();
  });
  const first = await current(page);
  let playerId = '';
  const playerName = `Alexandra ${short}`;
  await measure('Add a new player', async tap => {
    await tap(page.getByRole('button', { name: 'Add player', exact: true }));
    await typeInput(page.getByLabel('Search players', { exact: true }), playerName);
    await tap(page.getByRole('button', { name: `Add '${playerName}' as new`, exact: true }));
    await saved(); playerId = (await current(page)).players[0]!.id;
  });
  await measure('Buy-in from player row, choose Venmo', async tap => {
    await tap(page.getByTestId(`buy-in-${playerId}`));
    await expect(page.getByTestId('money-player')).toHaveText(playerName);
    await typeInput(page.getByTestId('money-amount'), '12,50');
    await tap(page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Venmo', exact: true }));
    await tap(page.getByRole('button', { name: 'Save entry', exact: true })); await saved();
    const value = await current(page); expect(value.totals.total_in_minor).toBe('1250'); expect(value.players[0]!.payment_in_minor).toBe('1250');
  });
  await measure('Repeat last buy-in with player’s remembered method', async tap => {
    await tap(page.getByTestId(`repeat-buy-in-${playerId}`));
    await expect(page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Venmo', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await tap(page.getByRole('button', { name: 'Save entry', exact: true })); await saved();
  });
  const beforeUndo = await current(page);
  const buys = beforeUndo.entries.filter(entry => entry.kind === 'buy_in').sort((left, right) => BigInt(left.revision) < BigInt(right.revision) ? -1 : 1);
  expect(buys).toHaveLength(2);
  await expect(page.getByTestId('saved-confirmation')).toContainText(playerName);
  await expect(page.getByTestId('saved-confirmation')).toContainText('buy-in');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await current(page)).entries.filter(entry => entry.voids_entry_id).length).toBe(2);
  const undo = await current(page);
  expect(undo.entries.filter(entry => entry.voids_entry_id)).toHaveLength(2);
  expect(undo.entries.some(entry => entry.voids_entry_id === buys[0]!.id)).toBe(false);
  expect(undo.players[0]!.payment_in_minor).toBe('1250');
  await capture(page, evidence, 'undo-latest-identical-paid-buy-in');
  await measure('Cash out actual chips and mark paid', async tap => {
    await tap(page.getByTestId(`cash-out-${playerId}`));
    await typeInput(page.getByTestId('money-amount'), '12.50');
    await tap(page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Venmo', exact: true }));
    await sheets('cash-out');
    await tap(page.getByRole('button', { name: 'Save entry', exact: true })); await saved();
  });
  await money(page, playerId, '10', { paid: false });
  await money(page, playerId, '0', { kind: 'Cash out' });
  await measure('Record outstanding payment with Zelle', async tap => {
    await tap(page.getByTestId(`settle-${playerId}`));
    await expect(page.getByTestId('money-amount')).toHaveValue('10.00');
    await tap(page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Zelle', exact: true }));
    await sheets('record-payment');
    await tap(page.getByRole('button', { name: 'Save entry', exact: true })); await saved();
  });
  const payment = (await current(page)).entries.find(entry => entry.kind === 'payment_in' && entry.method === 'zelle')!;
  await measure('Correct a payment method', async tap => {
    await tap(page.getByTestId(`entry-${payment.id}`).getByRole('button'));
    await tap(page.getByRole('group', { name: 'Replacement method', exact: true }).getByRole('button', { name: 'Cash', exact: true }));
    await tap(page.getByRole('button', { name: 'Save correction', exact: true })); await saved();
  });
  await money(page, playerId, '10', { method: 'cash' });
  await money(page, playerId, '20', { kind: 'Cash out', paid: true, method: 'cash' });
  expect((await current(page)).totals.discrepancy_minor).toBe('0');
  await measure('Close a balanced session', async tap => {
    await tap(page.getByTestId('ready-to-close'));
    await tap(page.getByRole('dialog').getByRole('button', { name: 'Close session', exact: true })); await saved();
  });
  const secondName = `Eight at Justin’s ${tag}`;
  await measure('Create another session', async tap => {
    const headerAction = page.locator('.session-heading').getByRole('button', { name: 'New session', exact: true });
    await tap(await headerAction.isVisible() ? headerAction : page.getByTestId('session-bottom-bar').getByRole('button', { name: 'New session', exact: true }));
    await typeInput(page.getByLabel('Session name', { exact: true }), secondName);
    await tap(page.getByRole('button', { name: 'Create session', exact: true }));
    await expect(page.getByRole('heading', { name: secondName, exact: true })).toBeVisible();
  });
  const second = await current(page);
  await measure('Reuse an existing player', async tap => {
    await tap(page.getByRole('button', { name: 'Add player', exact: true }));
    await typeInput(page.getByLabel('Search players', { exact: true }), playerName);
    await tap(page.getByRole('dialog').getByRole('button', { name: playerName, exact: true })); await saved();
  });
  await money(page, playerId, '25', { paid: false });
  await measure('Return to another recent session', async tap => {
    await tap(page.getByRole('button', { name: 'Switch session', exact: true }));
    await tap(page.getByRole('dialog', { name: 'Sessions', exact: true }).getByTestId(`session-tab-${first.session.id}`));
    await expect(page.getByRole('heading', { name: firstName, exact: true })).toBeVisible();
  });
  await measure('Open player report and apply a filter', async tap => {
    await tap(page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Players', exact: true }));
    await tap(page.getByTestId(`roster-player-${playerId}`));
    await tap(page.getByRole('button', { name: 'Filter: Off', exact: true }));
    await typeInput(page.getByLabel('Filter location', { exact: true }), 'Home');
    await tap(page.getByRole('button', { name: 'Apply filters', exact: true }));
  });
  await page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Table', exact: true }).click();
  await switchSession(page, second.session.id);
  let viewerLink = '';
  await measure('Enable and copy viewer link', async tap => {
    await tap(page.getByRole('button', { name: 'Session menu', exact: true }));
    await tap(page.getByRole('dialog').getByRole('button', { name: 'Share session', exact: true }));
    await tap(page.getByRole('button', { name: 'Enable sharing', exact: true }));
    viewerLink = await page.getByLabel('Viewer link', { exact: true }).inputValue();
    await tap(page.getByRole('button', { name: 'Copy link', exact: true }));
    await expect(page.getByRole('dialog').getByRole('status')).toHaveText(/Link copied|Select the viewer link and copy it/);
  });
  await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
  const viewerContext = await newContextLike(page, browser, baseURL);
  try {
    const viewer = await viewerContext.newPage(); await viewer.goto(viewerLink);
    await expect(viewer.getByTestId(`player-${playerId}`)).toBeVisible();
    await money(page, playerId, '1.25', { method: 'venmo' });
    await expect(viewer.getByTestId('activity')).toContainText('$1.25', { timeout: 3000 });
    await expect(viewer.getByRole('button')).toHaveCount(0);
    const viewerCard = await viewer.getByTestId(`player-${playerId}`).evaluate(row => {
      const card = row.parentElement!;
      const style = getComputedStyle(card);
      return { card: card.classList.contains('player-card'), border: Number.parseFloat(style.borderTopWidth), background: style.backgroundColor };
    });
    expect(viewerCard.card).toBe(true); expect(viewerCard.border).toBeGreaterThan(0);
    expect(viewerCard.background).not.toBe('rgba(0, 0, 0, 0)');
    await writeFile(join(evidence, 'viewer-card-appearance.json'), JSON.stringify(viewerCard, null, 2));
    await capture(viewer, evidence, 'viewer-live');
    await viewer.emulateMedia({ colorScheme: 'dark' }); await capture(viewer, evidence, 'viewer-live-dark');
    await viewer.emulateMedia({ colorScheme: 'light' });
    await menu(page, 'Share'); await page.getByRole('button', { name: 'Rotate link', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm rotate', exact: true }).click();
    await viewer.reload(); await expect(viewer.getByText('This viewer link is unavailable', { exact: false })).toBeVisible();
    await expect(viewer.getByText('View only ·', { exact: false })).toHaveCount(0);
    await capture(viewer, evidence, 'viewer-revoked');
    await viewer.emulateMedia({ colorScheme: 'dark' }); await capture(viewer, evidence, 'viewer-revoked-dark');
    await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
  } finally { await viewerContext.close(); }
  const players = [playerId];
  for (const name of ['Riley', 'Sam', 'Morgan', 'Drew', 'Taylor', 'Casey', 'Jordan']) {
    const player = await addPlayer(page, `${name} ${short}`); players.push(player.id);
    await money(page, player.id, '25', { method: name === 'Jordan' ? 'zelle' : 'cash' });
  }
  await measure('Footer buy-in, explicitly choose player and Venmo', async tap => {
    await tap(page.getByTestId('session-bottom-bar').getByRole('button', { name: 'Buy-in', exact: true }));
    await expect(page.getByRole('dialog', { name: 'Choose player', exact: true })).toBeVisible();
    await expect(page.getByTestId('money-amount')).toHaveCount(0);
    await capture(page, evidence, 'footer-player-choice');
    await tap(page.getByTestId(`choose-buy-in-${players[1]}`));
    await expect(page.getByTestId('money-player')).toContainText('Riley');
    await expect(page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Cash', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await typeInput(page.getByTestId('money-amount'), '25');
    await tap(page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Venmo', exact: true }));
    await tap(page.getByRole('button', { name: 'Save entry', exact: true })); await saved();
  });
  await page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Players', exact: true }).click();
  await page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Table', exact: true }).click();
  await expect(page.getByTestId('saved-confirmation')).toHaveCount(0);
  const rowCounts: Record<string, number> = {};
  const rowMoneyFits: Record<string, boolean> = {};
  for (const height of [659, 852]) {
    await page.setViewportSize({ width: 393, height });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme }); await page.evaluate(() => scrollTo(0, 0));
      const fullyVisible = await page.locator('.players > .player-card').evaluateAll(rows => { const bar = document.querySelector('.bottom-navigation')!.getBoundingClientRect(); return rows.filter(row => { const box = row.getBoundingClientRect(); return box.top >= 0 && box.bottom <= bar.top; }).length; });
      rowCounts[`${height}-${scheme}`] = fullyVisible;
      const clippedMoney = await page.locator('.players .player-position,.players .player-balance').evaluateAll(values => values.filter(value => value.clientWidth === 0 || value.scrollWidth > value.clientWidth).map(value => ({ text: value.textContent, available: value.clientWidth, needed: value.scrollWidth })));
      rowMoneyFits[`${height}-${scheme}`] = clippedMoney.length === 0;
      expect(clippedMoney, 'Full positions and balances must remain visible').toEqual([]);
      expect(fullyVisible, `Complete player rows at 393×${height}`).toBeGreaterThanOrEqual(height === 659 ? 4 : 6);
      await capture(page, evidence, `eight-player-table-${scheme}-393x${height}`);
    }
  }
  await page.setViewportSize({ width: 393, height: 659 }); await page.emulateMedia({ colorScheme: 'light' });
  await page.getByTestId(`repeat-buy-in-${playerId}`).click();
  await expect(page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Venmo', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await typeInput(page.getByTestId('money-amount'), '12.50'); await sheets('buy-in');
  await typeInput(page.getByTestId('money-amount'), '12.505'); await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByTestId('money-amount')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('money-amount')).toBeFocused(); await expect(page.getByTestId('money-amount')).toHaveValue('12.505');
  await expect(page.getByRole('alert').filter({ hasText: 'Enter no more than 2 decimal places' })).toBeInViewport({ ratio: 1 });
  for (const scheme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: scheme }); await capture(page, evidence, `invalid-amount-${scheme}`); }
  await keepMoneyDraft(page);
  await menu(page, 'Session settings');
  await expect(page.getByLabel('Currency', { exact: true })).toBeDisabled();
  await expect(page.getByText('Currency is fixed after creation', { exact: false })).toBeVisible();
  expect((await page.getByLabel('Currency', { exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const scheme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: scheme }); await capture(page, evidence, `session-settings-${scheme}`); }
  await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
  await page.getByRole('button', { name: 'Switch session', exact: true }).click();
  await expect(page.getByLabel('Search sessions', { exact: true })).not.toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Sessions', exact: true }).getByTestId(`session-tab-${second.session.id}`)).toHaveAttribute('aria-current', 'true');
  for (const scheme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: scheme }); await capture(page, evidence, `session-picker-${scheme}`); }
  await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect((await page.locator('.session-board').boundingBox())!.width).toBeGreaterThan(1000);
  expect((await page.getByRole('navigation', { name: 'Table navigation', exact: true }).boundingBox())!.y).toBeLessThan(200);
  for (const scheme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.evaluate(() => scrollTo(0, 0)); await capture(page, evidence, `desktop-table-${scheme}-1440x1000`); }
  const result = { tag, taps, rowCounts, rowMoneyFits, sessionIds: [first.session.id, second.session.id], playerIds: players, limits: ['Visual viewport emulates a keyboard; physical iOS keyboard and Home Screen behavior require a device.', 'Clipboard fallback is allowed; the copy action must give visible feedback.', 'Input focus and typing are excluded from control-tap counts. Setup actions are excluded and each journey names its starting surface.'] };
  await writeFile(join(evidence, 'ux-approval-summary.json'), JSON.stringify(result, null, 2));
  if (originalViewport) await page.setViewportSize(originalViewport);
  await page.emulateMedia({ colorScheme: null });
  return result;
}
