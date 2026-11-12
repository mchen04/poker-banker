import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { webkit, devices, expect, type Page, type BrowserContext } from '@playwright/test';
import type { SessionState } from '../../src/domain/session';
import { formatMoney } from '../../src/domain/money';
import { observationScript } from './observe';
import { publicCall, type LiveFixture } from './live-seed';
import type { LiveClient } from './live-client';
import type { RecordSample } from './types';
import { stopOwnedProcess, withShutdownDeadline } from '../owned-process';

type ObservedWindow = Window & { __pbObserveSaved?: (note: string, total: string) => Promise<number> };
export async function scopeLiveBrowserRequests(context: BrowserContext, client: LiveClient) {
  if (!client.bypassEnabled) return;
  await context.route('**/*', async route => {
    try {
      const response = await route.fetch({ headers: client.scopedHeaders(route.request().url(), route.request().headers()), maxRedirects: 0 });
      if (response.status() >= 300 && response.status() < 400) {
        await withShutdownDeadline('Live browser response disposal', () => response.dispose());
        await withShutdownDeadline('Live browser redirect abort', () => route.abort('blockedbyclient'));
        return;
      }
      await route.fulfill({ response });
      await withShutdownDeadline('Live browser response disposal', () => response.dispose());
    } catch { await withShutdownDeadline('Live browser route abort', () => route.abort()).catch(() => {}); }
  });
}
export async function liveBrowser(client: LiveClient, fixture: LiveFixture, record: RecordSample, reverse: boolean, samples: number, directory: string, allowLoopbackCertificate = false) {
  let state = await publicCall<SessionState>(client, `/api/sessions/${fixture.sessionId}`);
  const server = await webkit.launchServer({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  const child = typeof server.process === 'function' ? server.process() : undefined;
  let closingServer: Promise<void> | undefined;
  const closeServer = () => closingServer ??= (async () => {
    const errors: unknown[] = [];
    try { await withShutdownDeadline('Live browser server close', () => server.close()); } catch (error) { errors.push(error); }
    try {
      if (child) await stopOwnedProcess(child, 'signal', true);
      else if (errors.length && typeof server.kill === 'function') await withShutdownDeadline('Live browser server kill', () => server.kill());
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Live browser server cleanup failed');
  })();
  let browser: Awaited<ReturnType<typeof webkit.connect>>;
  try { browser = await webkit.connect(server.wsEndpoint()); }
  catch (error) {
    try { await closeServer(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Live browser connection and cleanup failed'); }
    throw error;
  }
  const errors: string[] = [];
  const retiring = new WeakSet<Page>();
  const contextClosures = new WeakMap<BrowserContext, Promise<void>>();
  const closeContext = (owned: BrowserContext) => {
    let closing = contextClosures.get(owned);
    if (!closing) { closing = withShutdownDeadline('Live browser context close', () => owned.close()); contextClosures.set(owned, closing); }
    return closing;
  };
  const closeContexts = async (owned: BrowserContext[]) => {
    const results = await Promise.allSettled(owned.map(closeContext));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Live browser contexts failed to close');
  };
  let closingBrowser: Promise<void> | undefined;
  const closeBrowser = () => closingBrowser ??= withShutdownDeadline('Live browser close', () => browser.close());
  const context = async (banker: boolean) => {
    const owned = await browser.newContext({ ...devices['iPhone 15'], baseURL: client.baseURL, locale: 'en-US', timezoneId: 'UTC', ignoreHTTPSErrors: allowLoopbackCertificate, serviceWorkers: 'block' });
    await scopeLiveBrowserRequests(owned, client);
    if (banker) await owned.addCookies((await client.context.storageState()).cookies);
    await owned.addInitScript({ content: observationScript.replace('__PB_EXPECTED__', JSON.stringify({ name: state.session.name, total: formatMoney(BigInt(state.totals.total_in_minor), 'USD'), ids: fixture.playerIds.slice(0, 9), endpoint: banker ? `/api/sessions/${fixture.sessionId}` : `/api/view/${fixture.token}` })) });
    const page = await owned.newPage();
    page.on('pageerror', error => { if (!retiring.has(page)) errors.push(`Browser page failed (${error.name})`); });
    page.on('requestfailed', () => { if (!retiring.has(page)) errors.push('Browser request failed'); });
    page.on('response', response => { if (!retiring.has(page) && response.url().includes('/api/') && response.status() >= 400) errors.push(`Browser HTTP ${response.status()}`); });
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
          } catch (error) { record({ metric: count ? `viewer.delay.${count}` : 'entry.confirm', ms: 0, ok: false, work: { batch, concurrency: count }, error: `Browser benchmark failed (${error instanceof Error ? error.name : 'Error'})` }); throw new Error('Browser benchmark failed'); }
        }
        await (viewers[0]?.page ?? banker.page).screenshot({ path: join(directory, count ? `viewers-${count}.png` : 'save-confirmed.png') });
      } finally { for (const viewer of viewers) retiring.add(viewer.page); await closeContexts(viewers.map(viewer => viewer.owned)); }
    }
    expect(errors).toEqual([]);
  } catch { throw new Error('Browser benchmark failed'); } finally {
    for (const owned of browser.contexts()) for (const page of owned.pages()) retiring.add(page);
    const errors: unknown[] = [];
    try { await closeContexts(browser.contexts()); } catch (error) { errors.push(error); }
    try { await closeBrowser(); } catch (error) { errors.push(error); }
    try { await closeServer(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Live browser cleanup failed');
  }
}
