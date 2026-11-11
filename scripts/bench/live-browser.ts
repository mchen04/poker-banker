import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { webkit, devices, expect, type Page } from '@playwright/test';
import type { SessionState } from '../../src/domain/session';
import { formatMoney } from '../../src/domain/money';
import { observationScript } from './observe';
import { publicCall, type LiveFixture } from './live-seed';
import type { LiveClient } from './live-client';
import type { RecordSample } from './types';

type ObservedWindow = Window & { __pbObserveSaved?: (note: string, total: string) => Promise<number> };
export async function liveBrowser(client: LiveClient, fixture: LiveFixture, record: RecordSample, reverse: boolean, samples: number, directory: string, allowLoopbackCertificate = false) {
  const browser = await webkit.launch();
  const errors: string[] = [];
  const retiring = new WeakSet<Page>();
  let state = await publicCall<SessionState>(client, `/api/sessions/${fixture.sessionId}`);
  const context = async (banker: boolean) => {
    const owned = await browser.newContext({ ...devices['iPhone 15'], baseURL: client.baseURL, locale: 'en-US', timezoneId: 'UTC', ignoreHTTPSErrors: allowLoopbackCertificate });
    if (banker) await owned.addCookies((await client.context.storageState()).cookies);
    await owned.addInitScript({ content: observationScript.replace('__PB_EXPECTED__', JSON.stringify({ name: state.session.name, total: formatMoney(BigInt(state.totals.total_in_minor), 'USD'), ids: fixture.playerIds.slice(0, 9), endpoint: banker ? `/api/sessions/${fixture.sessionId}` : `/api/view/${fixture.token}` })) });
    const page = await owned.newPage();
    page.on('pageerror', error => { if (!retiring.has(page)) errors.push(error.message.replaceAll(fixture.token, 'OWNED_TOKEN')); });
    page.on('response', response => { if (!retiring.has(page) && response.url().includes('/api/') && response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname.replaceAll(fixture.token, 'OWNED_TOKEN')}`); });
    await page.goto(banker ? `/?session=${fixture.sessionId}` : `/v/${fixture.token}`, { waitUntil: 'commit' });
    await expect(page.getByRole('heading', { name: state.session.name, exact: true })).toBeVisible();
    await expect(page.locator('.players .player-row')).toHaveCount(9);
    await expect(page.getByTestId('totals').locator('strong').first()).toHaveText(formatMoney(BigInt(state.totals.total_in_minor), 'USD'));
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    return { owned, page };
  };
  try {
    const banker = await context(true);
    async function save(note: string, paid: boolean) {
      const before = state.entries.length;
      await banker.page.getByTestId(`player-${fixture.playerId}`).click();
      await banker.page.getByRole('dialog').getByRole('button', { name: 'Buy-in', exact: true }).click();
      await expect(banker.page.getByLabel('Amount', { exact: true })).toBeEnabled();
      await banker.page.getByLabel('Amount', { exact: true }).fill('1');
      await banker.page.getByLabel('Paid now', { exact: true }).setChecked(paid);
      if (paid) await banker.page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Cash', exact: true }).click();
      await banker.page.getByText('Record an earlier time or note', { exact: true }).click();
      await banker.page.getByLabel('Note', { exact: true }).fill(note);
      const button = banker.page.getByRole('button', { name: 'Save entry', exact: true });
      await button.evaluate(button => button.addEventListener('click', () => { performance.clearMarks('live-benchmark-save'); performance.mark('live-benchmark-save'); }, { once: true }));
      const displayed = banker.page.evaluate(({ note, total }) => (window as ObservedWindow).__pbObserveSaved!(note, total), { note, total: formatMoney(BigInt(state.totals.total_in_minor) + 100n, 'USD') });
      void displayed.catch(() => {});
      await button.click();
      const confirmed = await displayed;
      const click = await banker.page.evaluate(() => performance.timeOrigin + performance.getEntriesByName('live-benchmark-save').at(-1)!.startTime);
      state = await publicCall(client, `/api/sessions/${fixture.sessionId}`);
      expect(state.entries.filter(entry => entry.note === note && entry.kind === 'buy_in')).toHaveLength(1);
      expect(state.entries.length - before).toBe(paid ? 2 : 1);
      expect(errors).toEqual([]);
      return { click, confirmed };
    }
    const actions = reverse ? ['25', '10', '1', 'save'] : ['save', '1', '10', '25'];
    for (const action of actions) {
      const count = action === 'save' ? 0 : Number(action);
      const viewers: { owned: Awaited<ReturnType<typeof context>>['owned']; page: Page }[] = [];
      try {
        for (let index = 0; index < count; index++) viewers.push(await context(false));
        for (let batch = 0; batch < samples; batch++) {
          const note = `Live benchmark ${randomUUID()}`;
          const expectedTotal = formatMoney(BigInt(state.totals.total_in_minor) + 100n, 'USD');
          const displayed = viewers.map(viewer => viewer.page.evaluate(({ note, total }) => (window as ObservedWindow).__pbObserveSaved!(note, total), { note, total: expectedTotal }));
          for (const promise of displayed) void promise.catch(() => {});
          try {
            const result = await save(note, count === 0);
            if (count === 0) record({ metric: 'entry.confirm', ms: result.confirmed - result.click, ok: true, work: { batch, ledger_rows_written: 2, buy_in_rows_written: 1, confirmedEpoch: result.confirmed, profile: 'visible unthrottled iPhone WebKit' } });
            else for (const [viewer, epoch] of (await Promise.all(displayed)).entries()) record({ metric: `viewer.delay.${count}`, ms: epoch - result.click, ok: true, work: { batch, concurrency: count, viewer, viewers_completed: count, ledger_rows_written: 1, renderedEpoch: epoch, banker_confirmed_ms: result.confirmed - result.click, confirmed_to_viewer_ms: epoch - result.confirmed, profile: 'visible unthrottled iPhone WebKit' } });
          } catch (error) { record({ metric: count ? `viewer.delay.${count}` : 'entry.confirm', ms: 0, ok: false, work: { batch, concurrency: count }, error: String(error).replaceAll(fixture.token, 'OWNED_TOKEN') }); throw error; }
        }
        await (viewers[0]?.page ?? banker.page).screenshot({ path: join(directory, count ? `viewers-${count}.png` : 'save-confirmed.png') });
      } finally { for (const viewer of viewers) { retiring.add(viewer.page); await viewer.owned.close(); } }
    }
    expect(errors).toEqual([]);
  } finally { for (const owned of browser.contexts()) for (const page of owned.pages()) retiring.add(page); await browser.close(); }
}
