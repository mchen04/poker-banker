import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator } from '@playwright/test';
import { addPlayer, call, current, money, newSession, workspaceReady } from './helpers';
import { typeInput } from './input';
import { capture, type UxApprovalOptions } from './ux-approval';

export async function uxCloseReadiness({ page, evidence, runId }: UxApprovalOptions) {
  await mkdir(evidence, { recursive: true });
  const original = page.viewportSize();
  const phone = (original?.width ?? 393) < 700;
  await page.setViewportSize(phone ? { width: 393, height: 659 } : { width: 1440, height: 1000 });
  const taps: { journey: string; taps: number; controls: string[] }[] = [];
  const proofs: Record<string, unknown> = { profile: phone ? 'iphone-standalone' : 'desktop' };
  const primary = page.getByTestId('session-bottom-bar').getByRole('button');
  async function both(name: string) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await capture(page, evidence, `${name}-${colorScheme}`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
  }
  async function measure(journey: string, action: (tap: (control: Locator) => Promise<void>) => Promise<void>) {
    const controls: string[] = [];
    await action(async control => { controls.push(await control.getAttribute('aria-label') ?? (await control.innerText()).trim()); await control.click(); });
    taps.push({ journey, taps: controls.length, controls });
  }
  try {
    await page.goto('/'); await workspaceReady(page);
    const tag = `${runId.slice(-8)}-${randomUUID().slice(0, 4)}`;
    const session = await newSession(page, `Ready to close ${tag}`);
    const cue = page.getByTestId('ready-to-close');
    await expect(cue).toHaveCount(0);
    const player = await addPlayer(page, 'Avery at the table');
    await addPlayer(page, 'Jordan not bought in');
    for (let index = 0; index < 6; index++) await call(page, `/sessions/${session.session.id}/players`, 'POST', { op_id: randomUUID(), new_player_name: `Waiting player ${index + 1}` });
    await money(page, player.id, '10', { paid: false });
    for (let index = 0; index < 8; index++) await call(page, `/sessions/${session.session.id}/entries`, 'POST', { op_id: randomUUID(), player_id: player.id, kind: 'buy_in', amount_minor: '1000', paid_now: false });
    await money(page, player.id, '10', { paid: false });
    await expect(cue).toHaveCount(0); await expect(primary).toHaveText('Buy-in');
    const toast = page.getByTestId('saved-confirmation');
    await toast.getByRole('button', { name: 'Undo', exact: true }).focus();
    const toastBox = await toast.boundingBox();
    const activityBox = await page.getByTestId('activity').boundingBox();
    expect(toastBox && activityBox).toBeTruthy();
    if (!phone) {
      expect(toastBox!.width).toBeLessThanOrEqual(420);
      expect(toastBox!.x + toastBox!.width).toBeLessThanOrEqual(activityBox!.x);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const lastPlayer = await page.locator('.players .player-card').last().boundingBox();
      const currentToast = await toast.boundingBox();
      expect(lastPlayer && currentToast && lastPlayer.y + lastPlayer.height <= currentToast.y).toBe(true);
      proofs.lastRowClearance = { lastPlayer, toast: currentToast };
    }
    proofs.toast = { toastBox, activityBox, setup: 'Six extra reusable seats and eight $10 unpaid rebuys seeded through the public API; first and last $10 entries saved through UI. Ten buy-ins total $100.' };
    await both('narrow-toast-and-activity');
    await money(page, player.id, '100', { kind: 'Cash out', paid: true });
    await expect(cue).toHaveText('Everyone has cashed out · Close session · 1 unsettled');
    expect((await current(page)).totals.discrepancy_minor).toBe('0');
    await page.evaluate(() => window.scrollTo(0, 0)); await both('everyone-cashed-out');
    await measure('Close a balanced session from the ready card', async tap => {
      await tap(cue);
      await expect(page.getByRole('dialog', { name: 'Close session', exact: true })).toBeVisible();
      await tap(page.getByRole('dialog').getByRole('button', { name: 'Close session', exact: true }));
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
    await expect(cue).toHaveCount(0); await expect(primary).toHaveText('New session');
    const closed = await current(page);
    expect(closed.session.status).toBe('closed');
    expect(closed.players.find(row => row.id === player.id)!.balance_minor).toBe('10000');
    const headerNew = page.locator('.session-heading').getByRole('button', { name: 'New session', exact: true });
    if (phone) await expect(headerNew).toBeVisible();
    else { await expect(headerNew).toBeHidden(); await expect(page.getByRole('button', { name: 'New session', exact: true })).toHaveCount(1); }
    await page.evaluate(() => window.scrollTo(0, 0)); await both('closed-single-desktop-new');
    await measure('Create another session from the closed table', async tap => {
      await tap(phone ? headerNew : primary);
      await typeInput(page.getByLabel('Session name', { exact: true }), `Retained timer ${tag}`);
      await tap(page.getByRole('button', { name: 'Create session', exact: true }));
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
    const emptyTimer = await current(page);
    const undonePlayer = await addPlayer(page, 'Taylor first buy-in Undo');
    await money(page, undonePlayer.id, '25', { paid: false });
    const beforeUndo = await current(page);
    await page.getByTestId('saved-confirmation').getByRole('button', { name: 'Undo', exact: true }).click();
    const retained = page.getByTestId('retained-timer-notice');
    await expect(retained).toContainText('Timer started');
    await page.reload(); await workspaceReady(page);
    await expect(page.getByTestId('save-status')).toHaveCount(0);
    await expect(retained).toBeVisible(); await expect(retained.getByRole('button', { name: 'Correct times', exact: true })).toBeVisible();
    const undone = await current(page);
    expect(undone.session.id).toBe(emptyTimer.session.id);
    expect(undone.session.started_at).toBe(beforeUndo.session.started_at);
    expect(undone.players[0]!.buy_in_count).toBe(0);
    await both('lasting-retained-timer-after-reload');
    await retained.getByRole('button', { name: 'Correct times', exact: true }).click();
    await expect(page.getByLabel('Started at', { exact: true })).not.toHaveValue('');
    await page.getByRole('button', { name: 'Save timing', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(retained).toHaveCount(0);
    const corrected = await current(page);
    expect(corrected.events.filter(event => event.kind === 'timing_corrected')).toHaveLength(1);
    await page.reload(); await workspaceReady(page); await expect(retained).toHaveCount(0);
    await money(page, undonePlayer.id, '25', { paid: false });
    await page.getByTestId('saved-confirmation').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(retained).toBeVisible();
    await money(page, undonePlayer.id, '25', { paid: false }); await expect(retained).toHaveCount(0);
    const final = await current(page);
    expect(final.players[0]!.buy_in_count).toBe(1);
    proofs.timer = { sessionId: final.session.id, startedBeforeUndo: beforeUndo.session.started_at, startedAfterUndo: undone.session.started_at, survivedReload: true, clearedByCorrection: true, laterUndoRestoresNotice: true, clearedByNewBuyIn: true, ledgerVoids: final.entries.filter(entry => entry.voids_entry_id).length };
    expect(taps.map(row => row.taps)).toEqual([2, 2]);
    await writeFile(join(evidence, 'tap-counts.json'), JSON.stringify(taps, null, 2));
    await writeFile(join(evidence, 'ux-close-readiness-proof.json'), JSON.stringify({ proofs, taps, limitations: ['Standalone and viewport are emulated; no physical iOS keyboard/suspension proof.'] }, null, 2));
  } finally { await page.emulateMedia({ colorScheme: 'light' }); if (original) await page.setViewportSize(original); }
}
