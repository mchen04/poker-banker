import { expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecipeContext } from './control';
import { checkLayout, type LayoutIssue } from './layout';
import { addPlayer, money, newSession, menu, share } from '../../../../e2e/helpers';

const sizes = [
  { name: 'phone', width: 393, height: 852 },
  { name: 'narrow', width: 320, height: 568 },
] as const;

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
  const names = ['Justin', 'Alexandria Montgomery-Vanderbilt the Third', 'Sam', 'Priya'];
  const players = [];
  for (const name of names) players.push(await addPlayer(page, name));
  await money(page, players[0]!.id, '100');
  await money(page, players[1]!.id, '123456789.99', { method: 'venmo' });
  await money(page, players[2]!.id, '50', { paid: false });
  await money(page, players[3]!.id, '200', { method: 'zelle' });
  await money(page, players[0]!.id, '100');
  await shoot(page, dir, '02-table-with-saved-toast');
  await page.waitForTimeout(9000);
  await shoot(page, dir, '03-table-playing');
  await page.getByTestId(`player-${players[1]!.id}`).click();
  await shoot(page, dir, '04-player-sheet-long-name');
  await page.getByRole('dialog').getByRole('button', { name: 'Buy-in', exact: true }).click();
  await shoot(page, dir, '05-buy-in-sheet');
  await dismiss(page);
  await money(page, players[0]!.id, '350', { kind: 'Cash out', paid: true });
  await money(page, players[2]!.id, '0', { kind: 'Cash out' });
  await page.waitForTimeout(9000);
  await shoot(page, dir, '06-table-mixed-states');
  await page.getByTestId(`player-${players[2]!.id}`).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record payment', exact: true }).click();
  await shoot(page, dir, '07-payment-sheet');
  await dismiss(page);
  await page.getByTestId(`player-${players[0]!.id}`).click();
  await shoot(page, dir, '08-player-sheet-cashed-out');
  const history = page.getByRole('dialog').getByRole('button', { name: /Correct|Edit/ }).first();
  if (await history.isVisible().catch(() => false)) {
    await history.click();
    await shoot(page, dir, '09-correct-entry');
  }
  await dismiss(page);
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
  const viewer = await page.context().newPage();
  try {
    await viewer.setViewportSize(sizes[0]);
    await filmstrip(viewer, dir, '16-viewer-load', () => viewer.goto(link));
    await shoot(viewer, dir, '17-viewer');
  } finally { await viewer.close(); }
  await page.emulateMedia({ colorScheme: 'dark' });
  await shoot(page, dir, '18-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await menu(page, 'Close session').catch(() => undefined);
  await shoot(page, dir, '19-close-sheet');
  await step('tour-complete');
}
