import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator } from '@playwright/test';
import { addPlayer, current, fixtureSession, menu, money, newContextLike, newSession, openMoney, share, workspaceReady } from './helpers';
import { typeInput } from './input';
import { capture, type UxApprovalOptions } from './ux-approval';

function contrast(color: string, background: string) {
  const luminance = (text: string) => {
    const rgb = text.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!rgb || rgb.length !== 3) throw new Error(`Expected browser RGB color, received ${text}`);
    return rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index]!, 0);
  };
  const values = [luminance(color), luminance(background)].sort((a, b) => b - a);
  return (values[0]! + .05) / (values[1]! + .05);
}

export async function uxFollowups({ page, browser, baseURL, evidence, runId }: UxApprovalOptions) {
  await mkdir(evidence, { recursive: true });
  const original = page.viewportSize();
  const phone = (original?.width ?? 393) < 700;
  await page.setViewportSize(phone ? { width: 393, height: 659 } : { width: 1440, height: 1000 });
  const taps: { journey: string; taps: number; controls: string[] }[] = [];
  const proofs: Record<string, unknown> = {};
  const nav = page.getByRole('navigation', { name: 'Table navigation', exact: true });
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
    await writeFile(join(evidence, 'tap-counts.json'), JSON.stringify(taps, null, 2));
  }
  async function settled() { await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0); }
  try {
    await page.goto('/'); await workspaceReady(page);
    const name = `Footer and Undo ${runId.slice(-8)}-${randomUUID().slice(0, 4)}`;
    const session = await newSession(page, name);
    await expect(primary).toHaveText('Buy-in');
    await primary.click(); await expect(page.getByRole('dialog', { name: 'Choose player' })).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Add player', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
    const owing = await addPlayer(page, 'Alexandra Montgomery with a recognisable full name');
    const paid = await addPlayer(page, 'Riley Chen');
    await money(page, owing.id, '50', { paid: false });
    const first = await current(page);
    expect(first.session.started_at).not.toBeNull();
    const toast = page.getByTestId('saved-confirmation');
    const bounds = await toast.locator('span').first().boundingBox();
    if (!bounds) throw new Error('Saved toast must be on screen');
    await page.mouse.move(bounds.x + 5, bounds.y + 5); await page.mouse.down(); await page.mouse.move(1, 1);
    await page.waitForTimeout(8300); await expect(toast.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    await page.mouse.up();
    await toast.getByRole('button', { name: 'Undo', exact: true }).focus();
    await page.waitForTimeout(8300); await expect(toast).toBeVisible();
    await both('undo-toast-focused');
    await openMoney(page, paid.id); await page.waitForTimeout(8300);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(toast.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    await toast.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByTestId('save-status')).toContainText('Timer still running from');
    const undone = await current(page);
    expect(undone.session.started_at).toBe(first.session.started_at);
    expect(undone.entries.filter(entry => entry.voids_entry_id)).toHaveLength(1);
    const correction = page.getByTestId('save-status').getByRole('button', { name: 'Correct times', exact: true });
    await correction.focus(); await both('undo-first-buy-in-timer-explanation');
    await correction.click(); await expect(page.getByLabel('Started at', { exact: true })).not.toHaveValue('');
    await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
    proofs.undo = { pausedPointerMs: 8300, pausedFocusMs: 8300, pausedSheetMs: 8300, timerBefore: first.session.started_at, timerAfter: undone.session.started_at, voids: 1 };

    await money(page, owing.id, '50', { paid: false });
    await page.mouse.move(1, 1); await page.getByRole('button', { name: 'Switch session', exact: true }).focus();
    await page.waitForTimeout(4800); await expect(page.getByTestId('saved-confirmation')).toBeVisible();
    await page.getByTestId('saved-confirmation').getByRole('button', { name: 'Undo', exact: true }).focus();
    await page.waitForTimeout(8300); await expect(page.getByTestId('saved-confirmation')).toBeVisible();
    await page.getByRole('button', { name: 'Switch session', exact: true }).focus(); await page.mouse.move(1, 1);
    await page.waitForTimeout(3600); await expect(page.getByTestId('saved-confirmation')).toHaveCount(0);
    proofs.idleToast = { visibleAfterAvailableMs: 4800, pauseMs: 8300, absentAfterAvailableMs: 8400 };
    await money(page, paid.id, '50', { paid: true, method: 'cash' });
    await expect(page.locator('.session-heading').getByRole('button', { name: 'New session', exact: true })).toContainText('New');
    await expect(primary).toHaveText('Buy-in');
    const colors: unknown[] = [];
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const debt = await page.getByTestId(`player-${owing.id}`).locator('.player-balance').evaluate(element => ({ color: getComputedStyle(element).color, weight: Number(getComputedStyle(element).fontWeight), background: getComputedStyle(element.closest('.player-card')!).backgroundColor }));
      const paidColor = await page.getByTestId(`player-${paid.id}`).getByText('Paid up', { exact: true }).evaluate(element => getComputedStyle(element).color);
      expect(debt.color).not.toBe(paidColor); expect(debt.weight).toBeGreaterThanOrEqual(650);
      expect(contrast(debt.color, debt.background)).toBeGreaterThanOrEqual(4.5);
      colors.push({ colorScheme, ...debt, paidColor, contrast: contrast(debt.color, debt.background) });
      await capture(page, evidence, `open-footer-owes-paid-${colorScheme}`);
    }
    proofs.debt = colors;
    const lines = await page.getByTestId(`player-${owing.id}`).locator('strong[title]').evaluate(element => ({ height: element.getBoundingClientRect().height, line: Number.parseFloat(getComputedStyle(element).lineHeight), clamp: getComputedStyle(element).webkitLineClamp }));
    expect(lines.clamp).toBe('2'); if (phone) expect(lines.height).toBeGreaterThan(lines.line * 1.8); expect(lines.height).toBeLessThanOrEqual(lines.line * 2 + 1);
    proofs.name = lines;
    if (!phone) {
      const header = await page.locator('.app-bar').boundingBox(); const navigation = await nav.boundingBox();
      expect(header && navigation && navigation.y >= header.y && navigation.y + navigation.height <= header.y + header.height).toBe(true);
      proofs.desktopNavigation = { header, navigation };
    }
    const viewerLink = await share(page);
    const viewerContext = await newContextLike(page, browser, baseURL);
    try {
      const viewer = await viewerContext.newPage(); await viewer.goto(viewerLink);
      await expect(viewer.getByTestId(`player-${owing.id}`)).toContainText('Owes $50.00');
      await expect(viewer.getByRole('navigation', { name: 'Table navigation' })).toHaveCount(0);
      for (const colorScheme of ['light', 'dark'] as const) {
        await viewer.emulateMedia({ colorScheme });
        const color = await viewer.getByTestId(`player-${owing.id}`).locator('.player-balance').evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element.closest('.player-card')!).backgroundColor, weight: Number(getComputedStyle(element).fontWeight) }));
        expect(contrast(color.color, color.background)).toBeGreaterThanOrEqual(4.5); expect(color.weight).toBeGreaterThanOrEqual(650);
        await capture(viewer, evidence, `viewer-owes-paid-${colorScheme}`);
      }
    } finally { await viewerContext.close(); }
    await nav.getByRole('button', { name: 'Players', exact: true }).click(); await expect(primary).toHaveText('Buy-in');
    const rosterDebt = await page.getByTestId(`roster-player-${owing.id}`).getByText('Owes bank $50.00', { exact: true }).evaluate(element => ({ color: getComputedStyle(element).color, weight: Number(getComputedStyle(element).fontWeight), background: getComputedStyle(element.closest('.roster-list')!).backgroundColor }));
    const rosterZero = await page.getByTestId(`roster-player-${owing.id}`).getByText('Bank owes $0.00', { exact: true }).evaluate(element => ({ color: getComputedStyle(element).color, weight: Number(getComputedStyle(element).fontWeight) }));
    expect(rosterDebt.color).not.toBe(rosterZero.color); expect(rosterDebt.weight).toBeGreaterThan(rosterZero.weight); expect(contrast(rosterDebt.color, rosterDebt.background)).toBeGreaterThanOrEqual(4.5);
    proofs.rosterDebt = { ...rosterDebt, zero: rosterZero, contrast: contrast(rosterDebt.color, rosterDebt.background) };
    await both('players-open-session-footer');
    await measure('Footer buy-in from Players, choose player and Venmo', async tap => {
      await tap(primary); await expect(page.getByRole('dialog', { name: 'Choose player' })).toBeVisible();
      await tap(page.getByTestId(`choose-buy-in-${owing.id}`)); await expect(page.getByTestId('money-player')).toHaveText(owing.display_name);
      await typeInput(page.getByTestId('money-amount'), '10');
      await tap(page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Venmo', exact: true }));
      await tap(page.getByRole('button', { name: 'Save entry', exact: true })); await settled();
    });
    expect((await current(page)).session.id).toBe(session.session.id);
    await menu(page, 'Close session');
    const blockers = page.getByRole('dialog').locator('.close-blockers button');
    await expect(blockers).toHaveCount(2); await both('close-blockers');
    const blockerBounds = await blockers.evaluateAll(buttons => buttons.map(button => ({ align: getComputedStyle(button).textAlign, width: button.getBoundingClientRect().width, parent: button.parentElement!.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
    for (const row of blockerBounds) { expect(row.align).toBe('left'); expect(Math.abs(row.width - row.parent)).toBeLessThanOrEqual(1); expect(row.height).toBeGreaterThanOrEqual(44); }
    await page.getByRole('dialog').getByRole('button', { name: `Cash out ${owing.display_name}`, exact: true }).click();
    await expect(page.getByTestId('money-player')).toHaveText(owing.display_name);
    await typeInput(page.getByTestId('money-amount'), '60'); await page.getByRole('button', { name: 'Save entry', exact: true }).click(); await settled();
    await money(page, paid.id, '50', { kind: 'Cash out', paid: true });
    await expect(primary).toHaveText('Buy-in');
    await measure('Close a balanced session', async tap => {
      await tap(page.getByTestId('ready-to-close'));
      await tap(page.getByRole('dialog').getByRole('button', { name: 'Close session', exact: true })); await settled();
    });
    await expect(primary).toHaveText('New session'); await expect(nav.getByRole('button', { name: 'Reopen session', exact: true })).toHaveCount(0); await both('closed-session-footer');
    await nav.getByRole('button', { name: 'Players', exact: true }).click(); await expect(primary).toHaveText('New session'); await both('players-closed-session-footer');
    await nav.getByRole('button', { name: 'Table', exact: true }).click();
    await measure('Reopen through Menu with a reason', async tap => {
      await tap(page.getByRole('button', { name: 'Session menu', exact: true })); await tap(page.getByRole('dialog').getByRole('button', { name: 'Reopen session', exact: true }));
      await expect(page.getByLabel('Reason', { exact: true })).toHaveAttribute('required', '');
      await typeInput(page.getByLabel('Reason', { exact: true }), 'Review the recorded session');
      await tap(page.getByRole('dialog').getByRole('button', { name: 'Reopen session', exact: true })); await settled();
    });
    await expect(primary).toHaveText('Buy-in');

    const firstReport = await fixtureSession(page, undefined, { name: `Report even ${runId}`, day: '2026-11-08', result: '0', hours: 1 });
    const reportPlayer = firstReport.players[0]!.id;
    await fixtureSession(page, reportPlayer, { name: `Report win ${runId}`, day: '2026-11-09', result: '200000', hours: 1 });
    await nav.getByRole('button', { name: 'Players', exact: true }).click(); await page.getByTestId(`roster-player-${reportPlayer}`).click();
    await expect(page.getByTestId('report-variation_per_hour_minor')).toContainText('$1,414.21'); await both('report-grouped-variation');
    proofs.report = { sessionRatesMinor: ['0', '200000'], varianceMinorSquared: '20000000000', expectedDisplay: '$1,414.21' };
    await writeFile(join(evidence, 'ux-followups-proof.json'), JSON.stringify({ profile: phone ? 'phone' : 'desktop', sessionId: session.session.id, proofs, taps }, null, 2));
  } finally { await page.emulateMedia({ colorScheme: 'light' }); if (original) await page.setViewportSize(original); }
}
