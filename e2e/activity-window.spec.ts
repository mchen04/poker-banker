import { randomUUID } from 'node:crypto';
import type { SessionState } from '../src/domain/session';
import { test, expect } from './fixtures';
import { addPlayer, call, createAccount, current, newContextLike, newSession, share, switchSession } from './helpers';
import { typeInput } from './input';

test('earlier Activity entries stay reachable, correctable, filtered and read only for viewers', async ({ page, browser, baseURL }) => {
  test.setTimeout(120000);
  await createAccount(page);
  let state = await newSession(page, 'Earlier Activity');
  const sessionId = state.session.id;
  const justin = await addPlayer(page, 'Justin');
  const morgan = await addPlayer(page, 'Morgan');
  for (let index = 0; index < 105; index++) {
    state = await call<SessionState>(page, `/sessions/${sessionId}/entries`, 'POST', {
      op_id: randomUUID(), player_id: justin.id, kind: 'buy_in', amount_minor: '100', paid_now: false, occurred_at: null, note: `Justin entry ${index + 1}`,
    });
  }
  state = await call<SessionState>(page, `/sessions/${sessionId}/entries`, 'POST', {
    op_id: randomUUID(), player_id: morgan.id, kind: 'buy_in', amount_minor: '200', paid_now: false, occurred_at: null, note: 'Morgan latest entry',
  });
  const oldest = state.entries.find(entry => entry.note === 'Justin entry 1')!;
  const second = state.entries.find(entry => entry.note === 'Justin entry 2')!;
  await page.reload();
  const activity = page.locator('.session-board').getByTestId('activity');
  await expect(activity.getByRole('listitem')).toHaveCount(50);
  await expect(activity).toContainText('Morgan latest entry');
  await expect(activity.getByTestId(`entry-${oldest.id}`)).toHaveCount(0);
  for (const count of [100, state.entries.length]) {
    await activity.getByRole('button', { name: 'Show earlier entries', exact: true }).click();
    await expect(activity.getByRole('listitem')).toHaveCount(count);
  }
  expect(await activity.getByRole('listitem').evaluateAll(rows => rows.map(row => row.getAttribute('data-testid')))).toEqual(state.entries.map(entry => `entry-${entry.id}`));
  await expect(activity.getByRole('button', { name: 'Show earlier entries', exact: true })).toHaveCount(0);
  await activity.getByTestId(`entry-${oldest.id}`).scrollIntoViewIfNeeded();
  await activity.getByTestId(`entry-${oldest.id}`).getByRole('button').click();
  await typeInput(page.getByLabel('Replacement amount', { exact: true }), '2');
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(activity.getByTestId(`entry-${oldest.id}`)).toContainText('Voided');
  await expect(activity.getByTestId(`entry-${oldest.id}`).getByRole('button')).toHaveCount(0);
  state = await current(page);
  const replacement = state.entries.find(entry => entry.player_id === justin.id && entry.kind === 'buy_in' && entry.amount_minor === '200' && !entry.voids_entry_id)!;
  await expect(activity.getByTestId(`entry-${replacement.id}`)).toContainText('$2.00');

  await page.getByTestId(`player-${justin.id}`).click();
  const filtered = page.getByRole('dialog').getByTestId('activity');
  await expect(filtered.getByRole('listitem')).toHaveCount(50);
  for (const count of [100, state.entries.filter(entry => entry.player_id === justin.id).length]) {
    await filtered.getByRole('button', { name: 'Show earlier entries', exact: true }).click();
    await expect(filtered.getByRole('listitem')).toHaveCount(count);
  }
  await expect(filtered).not.toContainText('Morgan');
  await expect(filtered.getByTestId(`entry-${oldest.id}`)).toContainText('Voided');
  await filtered.getByTestId(`entry-${second.id}`).scrollIntoViewIfNeeded();
  await filtered.getByTestId(`entry-${second.id}`).getByRole('button').click();
  await page.getByRole('button', { name: 'Void entry', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm void', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(activity.getByTestId(`entry-${second.id}`)).toContainText('Voided');
  await page.getByTestId(`player-${justin.id}`).click();
  await expect(filtered.getByRole('listitem')).toHaveCount(50);
  await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
  await newSession(page, 'Expansion reset');
  await switchSession(page, sessionId);
  await expect(activity.getByRole('listitem')).toHaveCount(50);

  const link = await share(page);
  state = await current(page);
  const viewerContext = await newContextLike(page, browser, baseURL!);
  try {
    const viewer = await viewerContext.newPage();
    await viewer.goto(link);
    const viewerActivity = viewer.getByTestId('activity');
    await expect(viewerActivity.getByRole('listitem')).toHaveCount(50);
    await expect(viewerActivity.getByRole('button', { name: /^Correct / })).toHaveCount(0);
    for (const count of [100, state.entries.length]) {
      await viewerActivity.getByRole('button', { name: 'Show earlier entries', exact: true }).click();
      await expect(viewerActivity.getByRole('listitem')).toHaveCount(count);
    }
    expect(await viewerActivity.getByRole('listitem').evaluateAll(rows => rows.map(row => row.getAttribute('data-testid')))).toEqual(state.entries.map(entry => `entry-${entry.id}`));
    await expect(viewerActivity.getByTestId(`entry-${oldest.id}`)).toContainText('Voided');
    await expect(viewerActivity.getByTestId(`entry-${second.id}`)).toContainText('Voided');
    await expect(viewerActivity.getByRole('button')).toHaveCount(0);
  } finally { await viewerContext.close(); }
});
