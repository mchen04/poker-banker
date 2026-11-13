import { addPlayer, call, closeSession, createAccount, current, menu, newSession, openMoney, storedDraft, switchSession, keepMoneyDraft, money } from './helpers';
import { test, expect, screen } from './fixtures';
import { typeInput } from './input';
import { MAX_MINOR } from '../src/domain/money';
import type { SessionState } from '../src/domain/session';

test.describe("Money precision and reachable fields", () => {
  test('headline totals and player amounts show every digit and cent of the largest valid amount at phone width', async ({ page }, info) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await createAccount(page);
    const session = await newSession(page, 'Complete large totals');
    const unpaid = await addPlayer(page, 'Unpaid stack');
    const cashingOut = await addPlayer(page, 'Unpaid cash-out');
    const path = `/sessions/${session.session.id}/entries`;
    const amount = String(MAX_MINOR);
    await call(page, path, 'POST', { op_id: crypto.randomUUID(), player_id: unpaid.id, kind: 'buy_in', amount_minor: amount, paid_now: false, occurred_at: null });
    await call(page, path, 'POST', { op_id: crypto.randomUUID(), player_id: cashingOut.id, kind: 'buy_in', amount_minor: amount, paid_now: true, method: 'cash', occurred_at: null });
    const saved = await call<SessionState>(page, path, 'POST', { op_id: crypto.randomUUID(), player_id: cashingOut.id, kind: 'cash_out', amount_minor: amount, paid_now: false, occurred_at: null });
    expect(saved.totals).toMatchObject({ on_table_minor: amount, owed_to_banker_minor: amount, owed_by_banker_minor: amount });
    await page.reload();
    const totals = page.getByTestId('totals');
    await expect(totals.locator('strong')).toHaveText(['$92,233,720,368,547,758.07', '$92,233,720,368,547,758.07', '$92,233,720,368,547,758.07']);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const clipped = await page.locator('[data-testid="totals"] strong, .players .player-detail .money-value, .players .player-shortcuts .money-value').evaluateAll(elements => elements.flatMap(element => {
        const box = element.getBoundingClientRect();
        const card = element.closest('.totals,.player-card')!.getBoundingClientRect();
        const glyphs: DOMRect[] = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode;
          for (let index = 0; index < text.textContent!.length; index++) {
            if (!text.textContent![index]!.trim()) continue;
            const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + 1);
            glyphs.push(range.getBoundingClientRect());
          }
        }
        const visible = glyphs.length > 0 && element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight && glyphs.every(glyph => glyph.width > 0 && glyph.height > 0 && glyph.left >= Math.max(box.left, card.left, 0) - 1 && glyph.right <= Math.min(box.right, card.right, innerWidth) + 1 && glyph.top >= box.top - 1 && glyph.bottom <= box.bottom + 1);
        return visible ? [] : [{ amount: element.textContent, available: box.width, rendered: element.scrollWidth }];
      }));
      expect(clipped, `All headline and player money glyphs are rendered without clipping in ${colorScheme}`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await totals.screenshot({ path: info.outputPath(`largest-headline-${colorScheme}.png`) });
      await page.locator('.players').screenshot({ path: info.outputPath(`largest-player-amounts-${colorScheme}.png`) });
    }
  });

  test('cents, invalid precision and zero cash-out agree across saved entries, totals and reports', async ({ page }, info) => {
    const account = await createAccount(page);
    const session = await newSession(page, 'Cents at the kitchen table');
    const player = await addPlayer(page, 'Alexandra with a long player name');
    await page.getByTestId(`buy-in-${player.id}`).click();
    const amount = page.getByTestId('money-amount');
    await typeInput(amount, '12.005');
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await expect(page.getByText('Enter no more than 2 decimal places for USD.', { exact: true })).toBeVisible();
    await expect(amount).toBeFocused();
    await expect(amount).toHaveValue('12.005');
    const key = `${account.banker.id}/${session.session.id}/buy_in/${player.id}`;
    await expect.poll(async () => (await storedDraft<{ amount: string }>(page, key))?.amount).toBe('12.005');
    await typeInput(amount, '$12.50');
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('saved-confirmation')).toContainText('$12.50');
    let state = await current(page);
    expect(state.totals.total_in_minor).toBe('1250');
    expect(state.players[0]!.payment_in_minor).toBe('1250');
    await openMoney(page, player.id, 'Tips and meals');
    await typeInput(amount, '.75');
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
    await openMoney(page, player.id, 'Cash out');
    await expect(amount).toHaveValue('');
    await page.getByRole('button', { name: 'No chips left · $0.00', exact: true }).click();
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
    state = await current(page);
    expect(state.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '-1250' });
    expect(state.players[0]!.expense_minor).toBe('75');
    expect(state.players[0]!.balance_minor).toBe('0');
    expect(state.entries.filter(entry => entry.kind === 'payment_out')).toHaveLength(0);
    await expect(page.getByTestId(`result-${player.id}`)).toContainText('−$12.50');
    await closeSession(page, true);
    await page.getByRole('button', { name: 'Players', exact: true }).click();
    await page.getByTestId(`roster-player-${player.id}`).click();
    await expect(page.getByTestId('report-profit_loss_minor')).toContainText('−$12.50');
    await expect(page.getByTestId('report-net_after_expenses_minor')).toContainText('−$13.25');
    await expect(page.getByTestId('report-duration_ms')).toContainText('Under one minute; hourly rates use the exact time.');
    for (const label of ['Overall', 'Location', 'Game', 'Weekday', 'Month']) {
      const button = page.getByRole('button', { name: label, exact: true });
      expect(await button.evaluate(button => { const range = document.createRange(); range.selectNodeContents(button); return range.getClientRects().length === 1 && button.scrollWidth <= button.clientWidth; })).toBe(true);
    }
    await screen(page, info, 'ux-cents-report');
  });

  test('mobile chrome clears the last row and keyboard sheets keep their actions visible', async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await createAccount(page);
    await newSession(page, 'A long friendly Friday game name that wraps without pushing the menu off screen');
    const player = await addPlayer(page, 'Alexandra Montgomery with a very long name');
    const nav = page.getByRole('navigation', { name: 'Table navigation' });
    await expect(nav.getByRole('button', { name: 'Table', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const geometry = await page.evaluate(() => {
      const nav = document.querySelector('.bottom-navigation')!.getBoundingClientRect();
      const action = document.querySelector('[data-testid="session-bottom-bar"]')!.getBoundingClientRect();
      return { navBottom: nav.bottom, navTop: nav.top, actionTop: action.top, actionBottom: action.bottom, height: innerHeight, extraBar: !!document.querySelector('.bottom-bar') };
    });
    expect(geometry.navBottom).toBe(geometry.height);
    expect(geometry.actionTop).toBeGreaterThanOrEqual(geometry.navTop);
    expect(geometry.actionBottom).toBeLessThanOrEqual(geometry.navBottom);
    expect(geometry.extraBar).toBe(false);
    await page.getByTestId(`repeat-buy-in-${player.id}`).count().then(count => expect(count).toBe(0));
    await page.getByTestId(`buy-in-${player.id}`).click();
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: viewport.width, height: 430 });
    await typeInput(page.getByTestId('money-amount'), '12.50');
    await page.getByText('Record an earlier time or note', { exact: true }).click();
    await typeInput(page.getByLabel('Note', { exact: true }), 'Keyboard keeps this amount visible');
    await expect(page.getByRole('button', { name: 'Save entry', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByLabel('Note', { exact: true })).toBeInViewport({ ratio: 1 });
    await screen(page, info, 'ux-keyboard-sheet');
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
    await page.setViewportSize(viewport);
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    const last = await page.getByTestId('activity').locator('li').last().boundingBox();
    const bar = await page.getByRole('navigation', { name: 'Table navigation', exact: true }).boundingBox();
    expect(last && bar && last.y + last.height <= bar.y).toBe(true);
    const tooSmall = await nav.getByRole('button').evaluateAll(buttons => buttons.filter(button => button.getBoundingClientRect().height < 44).length);
    expect(tooSmall).toBe(0);
    await screen(page, info, 'ux-mobile-workspace');
    await menu(page, 'Share');
    await page.getByRole('button', { name: 'Enable sharing', exact: true }).click();
    const link = await page.getByLabel('Viewer link', { exact: true }).inputValue();
    await page.getByRole('button', { name: 'Rotate link', exact: true }).click();
    await expect(page.getByLabel('Viewer link', { exact: true })).toHaveValue(link);
    await page.getByRole('button', { name: 'Keep link', exact: true }).click();
    await expect(page.getByLabel('Viewer link', { exact: true })).toHaveValue(link);
  });

  test.describe('recovery layout', () => {
    test.use({ serviceWorkers: 'block' });

  test('expanded recovery controls remain reachable beside a money form at keyboard height', async ({ page }) => {
    const { banker } = await createAccount(page);
    const session = await newSession(page, 'Recovery at keyboard height');
    const player = await addPlayer(page, 'Recoverable player');
    const path = `/api/sessions/${session.session.id}/entries`;
    await page.route(`**${path}`, route => route.fulfill({ status: 409, contentType: 'application/json', headers: { 'X-PB-Banker-ID': banker.id }, body: JSON.stringify({ error: { code: 'idempotency_mismatch', message: 'Review the saved entry' } }) }));
    await page.evaluate(async ({ banker, session, player, path }) => {
      const db = await new Promise<IDBDatabase>(resolve => { const opening = indexedDB.open('poker-banker'); opening.onsuccess = () => resolve(opening.result); });
      const op = crypto.randomUUID();
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').put({ banker_id: banker, session_id: session, op_id: op, path, method: 'POST', body: { op_id: op, player_id: player, kind: 'payment_out', amount_minor: '5000', method: 'cash', occurred_at: null }, label: 'Recoverable payment', order: 1, status: 'pending', delivery: 'not_sent', attempts: 0, next_attempt_at: 0 });
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      db.close(); window.dispatchEvent(new Event('pb-data'));
    }, { banker: banker.id, session: session.session.id, player: player.id, path });
    await expect(page.getByRole('region', { name: 'Needs review', exact: true })).toBeVisible();
    await menu(page, 'Session settings');
    await expect(page.getByLabel('Session name', { exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Close sheet', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('dialog').getByText('Review recovered edit', { exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
    await page.getByTestId(`buy-in-${player.id}`).click();
    await page.setViewportSize({ width: 375, height: 430 });
    const recovery = page.getByRole('dialog').getByRole('region', { name: 'Needs review', exact: true });
    await recovery.getByText('Review recovered edit', { exact: true }).click();
    await typeInput(recovery.getByLabel('Amount', { exact: true }), '50.75');
    const discard = recovery.getByRole('button', { name: 'Discard recovered draft', exact: true });
    await discard.scrollIntoViewIfNeeded();
    await expect(discard).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: 'Save entry', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport({ ratio: 1 });
  });

  });
});

test.describe("Draft cancellation and remembered buy-ins", () => {
  test('money cancellation, last buy-in, method selection and compact controls preserve clear choices', async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await createAccount(page);
    const originalSession = await newSession(page, 'Clear choices');
    const player = await addPlayer(page, 'Justin');
    await money(page, player.id, '40', { method: 'cash' });
    await money(page, player.id, '60', { method: 'venmo' });
    const beforeVoid = await current(page);
    const firstBuy = beforeVoid.entries.find(entry => entry.kind === 'buy_in' && entry.amount_minor === '4000')!;
    await page.getByTestId(`entry-${firstBuy.id}`).getByRole('button').click();
    await page.getByRole('button', { name: 'Delete entry', exact: true }).click();
    await expect(page.getByRole('alertdialog', { name: 'Delete entry', exact: true })).toBeVisible();
    expect((await current(page)).revision).toBe(beforeVoid.revision);
    await page.getByRole('button', { name: 'Keep entry', exact: true }).click();
    await expect(page.getByLabel('Replacement amount', { exact: true })).toHaveValue('40.00');
    expect((await current(page)).revision).toBe(beforeVoid.revision);
    await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
    await openMoney(page, player.id);
    const amount = page.getByTestId('money-amount');
    await amount.focus();
    const focus = await amount.evaluate(input => { const style = getComputedStyle(input); return { width: style.outlineWidth, offset: style.outlineOffset, outline: style.outlineColor, border: style.borderTopColor, shadow: style.boxShadow }; });
    expect(focus).toMatchObject({ width: '2px', offset: '-2px', shadow: 'none' });
    expect(focus.outline).toBe(focus.border);
    await screen(page, info, 'focused-amount');
    await page.getByRole('button', { name: 'Last $60.00', exact: true }).click();
    await expect(amount).toHaveValue('60.00');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('Discard this typed amount?', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(amount).toHaveValue('60.00');
    const methods = page.getByRole('group', { name: 'Payment method', exact: true });
    const venmo = methods.getByRole('button', { name: 'Venmo', exact: true });
    const cash = methods.getByRole('button', { name: 'Cash', exact: true });
    await expect(venmo).toHaveAttribute('aria-pressed', 'true');
    await expect(cash).toHaveAttribute('aria-pressed', 'false');
    const selected = await venmo.evaluate(button => { const style = getComputedStyle(button); return { weight: Number(style.fontWeight), outline: style.outlineStyle }; });
    const normal = await cash.evaluate(button => Number(getComputedStyle(button).fontWeight));
    expect(selected.weight).toBeGreaterThan(normal);
    expect(selected.outline).not.toBe('none');
    await screen(page, info, 'polished-buy-in');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await openMoney(page, player.id);
    await expect(amount).toHaveValue('');
    await typeInput(amount, '17.');
    await keepMoneyDraft(page);
    await page.reload();
    await openMoney(page, player.id);
    await expect(amount).toHaveValue('17.');
    await keepMoneyDraft(page);
    expect((await current(page)).entries.filter(entry => entry.kind === 'buy_in')).toHaveLength(2);
    const early = await newSession(page, 'A long early session name that keeps its complete selected border');
    const later = await newSession(page, 'A long later session name that keeps its complete selected border');
    await switchSession(page, early.session.id);
    await page.getByRole('button', { name: 'Switch session', exact: true }).click();
    await page.getByRole('dialog').getByTestId(`session-tab-${later.session.id}`).click();
    const active = page.getByRole('button', { name: 'Switch session', exact: true });
    await expect(active).toHaveAttribute('data-testid', `session-tab-${later.session.id}`);
    expect(await active.evaluate(button => button.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await screen(page, info, 'selected-session-border');
    await switchSession(page, originalSession.session.id);
    await page.getByTestId(`repeat-buy-in-${player.id}`).click();
    await expect(amount).toHaveValue('17.');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await page.getByTestId(`repeat-buy-in-${player.id}`).click();
    await expect(amount).toHaveValue('60.00');
    await keepMoneyDraft(page);
    await page.reload();
    await openMoney(page, player.id);
    await expect(amount).toHaveValue('60.00');
    await keepMoneyDraft(page);
    await money(page, player.id, '100', { kind: 'Cash out' });
    for (const name of ['Total', 'Per hour', 'BB']) {
      const button = page.getByRole('button', { name, exact: true });
      const fits = await button.evaluate(button => {
        const range = document.createRange(); range.selectNodeContents(button);
        return range.getClientRects().length === 1 && button.scrollWidth <= button.clientWidth;
      });
      expect(fits, `${name} is a single line at 375px`).toBe(true);
    }

  });
});

test.describe("Zero-loss cash-outs and corrections", () => {
  test('a player losing the full buy-in cashes out zero with no zero payment', async ({ page }) => {
    await createAccount(page);
    await newSession(page, 'Lost whole stack');
    const player = await addPlayer(page, 'Justin');
    await openMoney(page, player.id);
    await typeInput(page.getByTestId('money-amount'), '0');
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Enter an amount above zero');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await money(page, player.id, '100', { paid: true, method: 'cash' });
    let state = await money(page, player.id, '0', { kind: 'Cash out', paid: true });
    expect(state.players[0]).toMatchObject({ state: 'cashed_out', result_minor: '-10000' });
    expect(state.entries.filter(entry => entry.kind === 'payment_out')).toHaveLength(0);
    await expect(page.getByTestId(`player-${player.id}`)).toContainText('−$100.00');
    for (const amount of ['20', '0']) {
      const voided = new Set(state.entries.flatMap(entry => entry.voids_entry_id ? [entry.voids_entry_id] : []));
      const cashout = state.entries.find(entry => entry.kind === 'cash_out' && !entry.voids_entry_id && !voided.has(entry.id))!;
      await page.getByTestId(`entry-${cashout.id}`).getByRole('button', { name: /^Correct/ }).click();
      await typeInput(page.getByLabel('Replacement amount', { exact: true }), amount);
      await page.getByRole('button', { name: 'Save correction', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      state = await current(page);
    }
    await expect(page.getByTestId(`player-${player.id}`)).toContainText('−$100.00');
    await menu(page, 'Close session');
    await page.getByLabel('Accept discrepancy of −$100.00', { exact: true }).check();
    await page.getByRole('button', { name: 'Close session', exact: true }).click();
    await expect.poll(async () => (await current(page)).session.status).toBe('closed');
  });
});
