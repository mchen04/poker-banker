import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { addPlayer, call, createAccount, current, newSession } from './helpers';
import { typeInput } from './input';
import type { SessionState } from '../src/domain/session';

test.use({ serviceWorkers: 'block' });

type Command = { label: string; path: string; method?: 'POST' | 'PATCH'; body: Record<string, unknown>; field?: string; value?: string; select?: boolean };
async function queueLegacy(page: Page, banker: string, session: string, command: Command) {
  const op = crypto.randomUUID();
  await page.evaluate(async ({ banker, session, command, op }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('poker-banker');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const tx = db.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').put({ op_id: op, banker_id: banker, session_id: session, path: command.path, method: command.method ?? 'POST', body: { ...command.body, op_id: op }, label: command.label, order: Date.now(), status: 'pending', delivery: 'not_sent', attempts: 0, next_attempt_at: 0 });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    db.close();
    window.dispatchEvent(new Event('pb-data'));
  }, { banker, session, command, op });
  return op;
}

for (const group of ['ledger', 'commands'] as const) {
  test(`every recovered ${group} command remains reviewable, editable, and actionable`, async ({ page }) => {
    const { banker } = await createAccount(page);
    const initial = await newSession(page, `Recovery ${group}`);
    const session = initial.session.id;
    const player = await addPlayer(page, 'Recovery player');
    const base = `/api/sessions/${session}`;
    const commands: Command[] = group === 'ledger' ? [
      ...['buy_in', 'cash_out', 'payment_in', 'payment_out', 'expense'].map(kind => ({ label: kind, path: `${base}/entries`, body: { player_id: player.id, kind, amount_minor: '5000', ...(kind === 'buy_in' ? { paid_now: true, method: 'cash' } : kind === 'cash_out' ? { paid_now: false } : kind.startsWith('payment') ? { method: 'cash' } : {}), occurred_at: null }, field: 'Amount', value: '60.00' })),
    ] : [
      { label: 'start', path: `${base}/start`, body: {} },
      { label: 'add-player', path: `${base}/players`, body: { new_player_name: 'Recovered seat' }, field: 'New player name', value: 'Edited recovered seat' },
      { label: 'new-session', path: '/api/sessions', body: { name: 'Recovered session', played_on: '2026-11-11', currency: 'USD' }, field: 'Name', value: 'Edited recovered session' },
      { label: 'settings', path: base, method: 'PATCH', body: { location: 'Recovered location' }, field: 'Location', value: 'Edited recovered location' },
      { label: 'timing', path: `${base}/timing`, method: 'PATCH', body: { started_at: '2026-11-10T12:00:00.000Z', ended_at: null }, field: 'Started at', value: '2026-11-10T13:00:00.000Z' },
      { label: 'share', path: `${base}/share`, body: { action: 'enable' }, field: 'Sharing action', value: 'rotate' },
      { label: 'rename', path: `/api/players/${player.id}`, method: 'PATCH', body: { display_name: 'Recovered rename' }, field: 'Player name', value: 'Edited recovered rename' },
      { label: 'close', path: `${base}/close`, body: {} },
      { label: 'reopen', path: `${base}/reopen`, body: { reason: 'Recovered reason' }, field: 'Reason', value: 'Edited recovered reason' },
      { label: 'legacy-command', path: `${base}/legacy-command`, body: { detail: 'Retained unknown value' }, field: 'detail', value: 'Edited unknown value' },
    ];
    if (group === 'commands') {
      const directory = await call<SessionState>(page, '/sessions', 'POST', { op_id: crypto.randomUUID(), name: 'Recovery directory', played_on: '2026-11-11', currency: 'USD' });
      const reusable = await call<SessionState>(page, `/sessions/${directory.session.id}/players`, 'POST', { op_id: crypto.randomUUID(), new_player_name: 'Reusable recovered player' });
      commands.splice(2, 0, { label: 'existing-player', path: `${base}/players`, body: { player_id: player.id }, field: 'Player', value: reusable.players[0]!.id, select: true });
      const state = await call<SessionState>(page, `${base.slice(4)}/entries`, 'POST', { op_id: crypto.randomUUID(), player_id: player.id, kind: 'buy_in', amount_minor: '1000', paid_now: false, occurred_at: null });
      commands.splice(7, 0, { label: 'correction', path: `${base}/entries/${state.entries.find(entry => entry.kind === 'buy_in' && !entry.voids_entry_id)!.id}/void`, body: {} });
    }
    for (const command of commands) {
      const beforeEntries = group === 'ledger' ? (await current(page, session)).entries.filter(entry => entry.kind === command.label && !entry.voids_entry_id).length : 0;
      if (command.label === 'close') {
        const state = await current(page, session);
        command.body = { expected_revision: state.revision, accept_discrepancy_minor: state.totals.discrepancy_minor ?? '0' };
      }
      let intercepted = false;
      const requests: { op_id: string; [key: string]: unknown }[] = [];
      await page.route(`**${command.path}`, async route => {
        if (route.request().method() !== (command.method ?? 'POST')) { await route.continue(); return; }
        requests.push(route.request().postDataJSON());
        if (!intercepted) {
          intercepted = true;
          await route.fulfill({ status: 409, contentType: 'application/json', headers: { 'X-PB-Banker-ID': banker.id }, body: JSON.stringify({ error: { code: 'idempotency_mismatch', message: 'Review the original operation' } }) });
        } else await route.continue();
      });
      const oldOp = await queueLegacy(page, banker.id, session, command);
      const region = page.getByRole('region', { name: 'Needs review', exact: true });
      await expect(region).toBeVisible();
      await region.getByText('Review recovered edit', { exact: true }).click();
      if (command.field) {
        const field = command.select ? region.getByRole('combobox', { name: command.field, exact: true }) : region.getByLabel(command.field, { exact: true });
        if (command.select) { await expect(field).toHaveValue(player.id); await field.selectOption(command.value!); }
        else await typeInput(field, command.value!);
      }
      await region.getByRole('button', { name: 'Save recovered draft', exact: true }).click();
      if (command.field) await expect(command.select ? region.getByRole('combobox', { name: command.field, exact: true }) : region.getByLabel(command.field, { exact: true })).toHaveValue(command.value!);
      const response = page.waitForResponse(response => response.request().method() === (command.method ?? 'POST') && new URL(response.url()).pathname === command.path && response.request().postDataJSON().op_id !== oldOp);
      await region.getByRole('button', { name: 'Resubmit recovered draft', exact: true }).click();
      expect((await response).status(), command.label).toBe(command.label === 'legacy-command' ? 404 : 200);
      if (command.label === 'legacy-command') {
        await expect(region).toBeVisible();
        await region.getByText('Review recovered edit', { exact: true }).click();
        await expect(region.getByLabel('detail', { exact: true })).toHaveValue(command.value!);
        await region.getByRole('button', { name: 'Discard recovered draft', exact: true }).click();
      }
      await expect(region).toHaveCount(0);
      expect(requests, command.label).toHaveLength(2);
      expect(requests[0]!.op_id).toBe(oldOp);
      expect(requests[1]!.op_id).not.toBe(oldOp);
      if (group === 'ledger') {
        expect(requests[1]).toMatchObject({ kind: command.label, amount_minor: '6000', occurred_at: null });
        expect((await current(page, session)).entries.filter(entry => entry.kind === command.label && !entry.voids_entry_id)).toHaveLength(beforeEntries + 1);
      }
      if (command.label === 'existing-player') { expect(requests[1]).toMatchObject({ player_id: command.value }); expect(requests[1]).not.toHaveProperty('new_player_name'); }
      if (command.label === 'correction') expect(requests[1]).not.toHaveProperty('replacement_amount_minor');
      if (command.label === 'settings') expect(Object.keys(requests[1]!).sort()).toEqual(['location', 'op_id']);
      if (command.label === 'rename') await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
      await page.unroute(`**${command.path}`);
    }
  });
}
