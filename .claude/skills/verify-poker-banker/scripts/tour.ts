import { expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecipeContext } from './control';
import { checkLayout, type LayoutIssue } from './layout';
import { addPlayer, current, money, newSession, menu, share } from '../../../../e2e/helpers';

const sizes = [
  { name: 'phone', width: 393, height: 852 },
  { name: 'mid', width: 375, height: 812 },
  { name: 'narrow', width: 320, height: 568 },
] as const;

const desktop = { name: 'desktop', width: 1440, height: 1000 } as const;

const layout: Record<string, LayoutIssue[]> = {};

async function shoot(page: Page, dir: string, name: string) {
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.waitForTimeout(120);
    await page.screenshot({ path: join(dir, `${name}.${size.name}.png`) });
    layout[`${name}.${size.name}`] = await checkLayout(page);
    await writeFile(join(dir, 'layout.json'), JSON.stringify(layout, null, 2));
  }
  await page.setViewportSize(sizes[0]);
}

async function shootDesktop(page: Page, dir: string, name: string) {
  await page.setViewportSize(desktop);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(dir, `${name}.${desktop.name}.png`) });
  layout[`${name}.${desktop.name}`] = await checkLayout(page);
  await writeFile(join(dir, 'layout.json'), JSON.stringify(layout, null, 2));
  await page.setViewportSize(sizes[0]);
  await page.waitForTimeout(150);
}

async function shootSafeArea(page: Page, dir: string, name: string) {
  await page.setViewportSize(sizes[0]);
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-top', '59px');
    document.documentElement.style.setProperty('--safe-bottom', '34px');
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(dir, `${name}.safe-area.png`) });
  layout[`${name}.safe-area`] = await checkLayout(page);
  await writeFile(join(dir, 'layout.json'), JSON.stringify(layout, null, 2));
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('--safe-top');
    document.documentElement.style.removeProperty('--safe-bottom');
  });
  await page.waitForTimeout(150);
}

async function dismiss(page: Page) {
  for (let attempt = 0; attempt < 4 && await page.getByRole('dialog').count(); attempt++) {
    const discard = page.getByRole('button', { name: 'Discard draft', exact: true });
    if (await discard.isVisible().catch(() => false)) { await discard.click(); continue; }
    const cancel = page.getByRole('dialog').last().getByRole('button', { name: /^(Cancel|Close sheet|Close)$/ }).first();
    if (await cancel.isVisible().catch(() => false)) await cancel.click();
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function filmstrip(page: Page, dir: string, name: string, action: () => Promise<unknown>) {
  const frames: { at: number; text: string; file: string }[] = [];
  const started = Date.now();
  const pending = action();
  for (let index = 0; index < 24; index++) {
    const file = `${name}-frame-${String(index).padStart(2, '0')}.png`;
    try {
      await page.screenshot({ path: join(dir, file), timeout: 2000 });
      const text = (await page.locator('body').innerText({ timeout: 500 }).catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      frames.push({ at: Date.now() - started, text, file });
    } catch { frames.push({ at: Date.now() - started, text: '(no frame)', file: '' }); }
    if (Date.now() - started > 2500) break;
  }
  await pending;
  const distinct = frames.filter((frame, index) => index === 0 || frame.text !== frames[index - 1]!.text);
  await writeFile(join(dir, `${name}-frames.json`), JSON.stringify({ frames, distinct: distinct.length }, null, 2));
}

export default async function tour({ page, evidence, step }: RecipeContext) {
  const dir = join(evidence, 'tour');
  await mkdir(dir, { recursive: true });
  await page.setViewportSize(sizes[0]);
  await dismiss(page);
  await shoot(page, dir, '00-empty-table');
  await newSession(page, 'Friday home game');
  await shoot(page, dir, '01-new-session-table');
  await menu(page, 'Session settings');
  await page.getByLabel('Session name', { exact: true }).fill('Friday Supercalifragilisticexpialidocious');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 568 });
  await shoot(page, dir, '01b-long-title');
  await menu(page, 'Session settings');
  await page.getByLabel('Session name', { exact: true }).fill('Friday home game');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.setViewportSize({ width: 393, height: 852 });
  const names = ['Justin', 'Alexandria Montgomery-Vanderbilt the Third', 'Sam', 'Priya', 'Alexandria Montgomery-Whitfield'];
  const players = [];
  for (const name of names) players.push(await addPlayer(page, name));
  await money(page, players[0]!.id, '100');
  await money(page, players[1]!.id, '123456789.99', { method: 'venmo' });
  await money(page, players[2]!.id, '50', { paid: false });
  await money(page, players[3]!.id, '200', { method: 'zelle' });
  await money(page, players[4]!.id, '123456789', { paid: false });
  await money(page, players[4]!.id, '123456789', { kind: 'Record payment' });
  await money(page, players[0]!.id, '100');
  await shoot(page, dir, '02-table-with-saved-toast');
  await page.waitForTimeout(9000);
  await shoot(page, dir, '03-table-playing');
  await shootDesktop(page, dir, '03-table-playing');
  await shootSafeArea(page, dir, '03-table-playing');
  await page.getByTestId(`player-${players[1]!.id}`).click();
  await shoot(page, dir, '04-player-sheet-long-name');
  await page.getByRole('dialog').getByRole('button', { name: 'Buy-in', exact: true }).click();
  await shoot(page, dir, '05-buy-in-sheet');
  await dismiss(page);
  await money(page, players[0]!.id, '350', { kind: 'Cash out', paid: true });
  await money(page, players[2]!.id, '0', { kind: 'Cash out' });
  await page.waitForTimeout(9000);
  await shoot(page, dir, '06-table-mixed-states');
  await shootDesktop(page, dir, '06-table-mixed-states');
  await page.getByTestId(`player-${players[2]!.id}`).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record payment', exact: true }).click();
  await shoot(page, dir, '07-payment-sheet');
  await dismiss(page);
  await page.getByTestId(`player-${players[0]!.id}`).click();
  await shoot(page, dir, '08-player-sheet-cashed-out');
  const history = page.getByRole('dialog').getByRole('button', { name: /Correct|Edit/ }).first();
  await history.click();
  await shoot(page, dir, '09-correct-entry');
  await dismiss(page);
  const whitfield = players[4]!.id;
  const payment = (await current(page)).entries.find(entry => entry.player_id === whitfield && entry.kind === 'payment_in')!;
  await page.locator('.session-board').getByTestId(`entry-${payment.id}`).getByRole('button').click();
  await page.getByRole('button', { name: 'Delete entry', exact: true }).click();
  await shoot(page, dir, '09b-delete-entry-confirm');
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.getByTestId('save-status')).toContainText('Deleted payment');
  await shoot(page, dir, '09c-delete-entry-toast');
  await page.locator('.session-board').getByTestId(`entry-${payment.id}`).scrollIntoViewIfNeeded();
  await shoot(page, dir, '09d-activity-deleted-entry');
  await page.locator('.session-board').getByTestId(`entry-${payment.id}`).getByRole('button').click();
  await shoot(page, dir, '09e-restore-entry-sheet');
  await page.getByRole('button', { name: 'Restore entry', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: 'Session menu', exact: true }).click();
  await shoot(page, dir, '10-session-menu');
  await dismiss(page);
  await page.getByRole('button', { name: 'Switch session', exact: true }).click();
  await shoot(page, dir, '11-sessions-picker');
  await dismiss(page);
  const link = await share(page);
  await page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Players', exact: true }).click();
  await page.waitForTimeout(800);
  await shoot(page, dir, '12-players');
  await page.getByText(names[1]!, { exact: true }).first().click();
  await page.waitForTimeout(800);
  await shoot(page, dir, '13-player-report');
  await page.goto(page.url().replace(/[?#].*$/, ''));
  await step('reloaded');
  await filmstrip(page, dir, '14-cold-reload', () => page.reload());
  await shoot(page, dir, '15-after-reload');
  await shootDesktop(page, dir, '15-after-reload');
  await shootSafeArea(page, dir, '15-after-reload');
  const viewer = await page.context().newPage();
  try {
    await viewer.setViewportSize(sizes[0]);
    await filmstrip(viewer, dir, '16-viewer-load', () => viewer.goto(link));
    await shoot(viewer, dir, '17-viewer');
    await shootDesktop(viewer, dir, '17-viewer');
  } finally { await viewer.close(); }
  await page.emulateMedia({ colorScheme: 'dark' });
  await shoot(page, dir, '18-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await menu(page, 'Close session').catch(() => undefined);
  await shoot(page, dir, '19-close-sheet');
  await dismiss(page);
  await page.getByTestId(`player-${whitfield}`).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove from game', exact: true }).scrollIntoViewIfNeeded();
  await shoot(page, dir, '20-player-sheet-remove');
  await page.getByRole('dialog').getByRole('button', { name: 'Remove from game', exact: true }).click();
  await shoot(page, dir, '21-remove-player-confirm');
  await page.getByRole('button', { name: 'Confirm remove', exact: true }).click();
  await expect(page.getByTestId('save-status')).toContainText('Removed Alexandria Montgomery-Whitfield');
  await shoot(page, dir, '22-remove-player-toast');
  await page.waitForTimeout(9000);
  await page.getByTestId('removed-players').getByText('Removed (1)', { exact: true }).click();
  await page.getByTestId('removed-players').scrollIntoViewIfNeeded();
  await shoot(page, dir, '23-removed-disclosure');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: 'Session menu', exact: true }).click();
  await shoot(page, dir, '24-session-menu-delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete session', exact: true }).click();
  await shoot(page, dir, '25-delete-session-confirm');
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.getByTestId('save-status')).toContainText('Deleted Friday home game');
  await shoot(page, dir, '26-delete-session-toast');
  await page.waitForTimeout(9000);
  const recent = page.getByTestId('recently-deleted-sessions');
  await recent.getByText('Recently deleted (1)', { exact: true }).click();
  await shoot(page, dir, '27-empty-table-recently-deleted');
  await page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Players', exact: true }).click();
  await page.getByTestId(`roster-player-${whitfield}`).click();
  await expect(page.getByTestId('player-report')).toHaveAttribute('aria-busy', 'false');
  await shoot(page, dir, '28-player-report-whitfield');
  await page.getByRole('button', { name: 'Delete player', exact: true }).click();
  await shoot(page, dir, '29-delete-player-confirm');
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.getByTestId('save-status')).toContainText('Deleted Alexandria Montgomery-Whitfield');
  await shoot(page, dir, '30-delete-player-toast');
  await page.getByTestId('recently-deleted-players').getByText(/^Recently deleted/).click();
  await shoot(page, dir, '31-recently-deleted-players');
  const failed = Object.entries(layout).flatMap(([state, issues]) => issues.map(issue => `${state}: ${issue.kind}: ${issue.detail}`));
  if (failed.length) throw new Error(`Layout issues (${failed.length}):\n${failed.slice(0, 40).join('\n')}`);
  await step('tour-complete');
}
