import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { webkit, devices, expect, type Page, type BrowserContext } from '@playwright/test';
import { formatMoney } from '../../src/domain/money';
import type { SessionState } from '../../src/domain/session';
import { observationScript } from './observe';
import { CpuBudget, type isolatedEngine } from './profile';
import type { benchmarkStack } from './stack';
import type { RecordSample } from './types';
type Stack = Awaited<ReturnType<typeof benchmarkStack>>;
type Engine = Awaited<ReturnType<typeof isolatedEngine>>;
type ObservedWindow = Window & { __pbObserveSaved?: (note: string, total: string) => Promise<number> };
type Target = 'workspace' | 'viewer';
export async function benchmarkBrowser(stack: Stack, engine: Engine, output: string, record: RecordSample, options: { samples: number; reverse: boolean; phase: (name: string) => void; metrics?: Set<string> }) {
  const wanted = (metric: string) => !options.metrics || options.metrics.has(metric);
  const hasWrites = wanted('entry.confirm') || [1,10,25].some(count => wanted(`viewer.delay.${count}`));
  const profiled = wanted('entry.confirm') || ['workspace.cold','workspace.warm','viewer.cold','viewer.warm'].some(wanted);
  const server = await webkit.launchServer({ executablePath: engine.executable, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  let browser: Awaited<ReturnType<typeof webkit.connect>>;
  try { browser = await webkit.connect(server.wsEndpoint()); } catch (error) { await server.close(); throw error; }
  const budget = new CpuBudget(engine.engine, server);
  let closingBrowser: Promise<void> | undefined;
  const closeBrowser = () => closingBrowser ??= (async () => { try { await budget.pause(); } finally { try { await browser.close(); } finally { await server.close(); } } })();
  const releaseBrowser = await stack.own(closeBrowser);
  const errors: string[] = [];
  const teardownErrors: { url: string; message: string }[] = [];
  const closing = new WeakSet<Page>();
  const fixture = stack.fixture;
  let initial: Awaited<ReturnType<typeof stack.client.request>>;
  try { initial = await stack.client.request(`/api/sessions/${fixture.sessionId}`); expect(initial.status).toBe(200); } catch (error) { try { await closeBrowser(); } finally { releaseBrowser(); } throw error; }
  let state = initial.body as SessionState;
  expect(state.entries).toHaveLength(60);
  const context = async (banker: boolean) => {
    const value = await browser.newContext({ ...devices['iPhone 15'], baseURL: stack.origin, ignoreHTTPSErrors: true, locale: 'en-US', timezoneId: 'UTC' });
    await value.addInitScript({ content: observationScript.replace('__PB_EXPECTED__', JSON.stringify({ name: state.session.name, total: formatMoney(BigInt(state.totals.total_in_minor), 'USD'), ids: state.players.map(player => player.id), endpoint: banker ? `/api/sessions/${fixture.sessionId}` : `/api/view/${fixture.token}` })) });
    if (banker) await value.addCookies([{ name: 'pb_session', value: stack.client.cookie().slice('pb_session='.length), url: stack.origin, httpOnly: true, secure: true, sameSite: 'Lax' }]);
    return value;
  };
  function watch(page: Page) {
    page.on('pageerror', error => { if (closing.has(page)) teardownErrors.push({ url: page.url(), message: error.message }); else errors.push(`${page.url()}: ${error.message}`); });
    page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  }
  async function closeContext(context: BrowserContext) { for (const page of context.pages()) closing.add(page); await context.close(); }
  async function meaningful(page: Page) {
    await expect.poll(() => page.evaluate(() => !!(window as Window & { __pbBenchMeaningful?: unknown }).__pbBenchMeaningful), { timeout: 20000 }).toBe(true);
    const proof = await page.evaluate(() => ({ marker: (window as Window & { __pbBenchMeaningful?: { ms: number; currentHttp: boolean; epoch: number } }).__pbBenchMeaningful!, name: document.querySelector('h1')?.textContent, total: document.querySelector('[data-testid="totals"] strong')?.textContent, players: [...document.querySelectorAll('.players .player-row')].map(row => row.getAttribute('data-testid')), visible: !!document.querySelector('h1')?.getClientRects().length }));
    expect(proof.name).toBe(state.session.name); expect(proof.visible).toBe(true);
    expect(proof.total).toBe(formatMoney(BigInt(state.totals.total_in_minor), 'USD'));
    expect(new Set(proof.players)).toEqual(new Set(state.players.map(player => `player-${player.id}`)));
    return proof.marker;
  }
  async function worker(page: Page) {
    await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.active), { timeout: 15000 }).toBe(true);
  }
  const path = (target: Target) => target === 'workspace' ? `/?session=${fixture.sessionId}` : `/v/${fixture.token}`;
  async function load(target: Target, cache: 'cold' | 'warm', index: number) {
    const metric = `${target}.${cache}`;
    const owned = await context(target === 'workspace');
    const page = await owned.newPage(); watch(page);
    let currentResponses = 0;
    page.on('response', response => { if (response.url().includes(target === 'workspace' ? `/api/sessions/${fixture.sessionId}` : `/api/view/${fixture.token}`)) currentResponses++; });
    try {
      stack.proxy.enabled = true; budget.start();
      options.phase(`prepare.${target}.${cache}`);
      if (cache === 'warm') { await page.goto(path(target), { waitUntil: 'commit' }); await meaningful(page); await worker(page); currentResponses = 0; }
      options.phase(`${target}.${cache}`);
      if (cache === 'warm') await page.reload({ waitUntil: 'commit' }); else await page.goto(path(target), { waitUntil: 'commit' });
      const marker = await meaningful(page);
      expect(errors).toEqual([]);
      record({ metric, ms: marker.ms, ok: true, work: { players: 9, ledger_entries: state.entries.length, profile: 'synthetic phone', cache, current_http_observed_at_render: marker.currentHttp, sample: index, renderedEpoch: marker.epoch } });
      await expect.poll(() => currentResponses, { timeout: 15000 }).toBeGreaterThan(0);
      const resources = await page.evaluate(() => (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map(entry => ({ path: new URL(entry.name).pathname.replace(/\/api\/view\/[^/]+/, '/api/view/OWNED_TOKEN'), startTime: entry.startTime, responseStart: entry.responseStart, responseEnd: entry.responseEnd, duration: entry.duration, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize, workerStart: entry.workerStart })));
      await writeFile(join(output, `${target}-${cache}-${index}-resources.json`), JSON.stringify({ marker, resources }, null, 2));
      if (index === 0) {
        await page.screenshot({ path: join(output, `${target}-${cache}.png`) });
        await writeFile(join(output, `${target}-${cache}.aria.txt`), await page.locator('body').ariaSnapshot());
      }
    } catch (error) { await writeFile(join(output, 'browser-failure.json'), JSON.stringify({ errors, error: String(error) }, null, 2)); await page.screenshot({ path: join(output, 'browser-failure.png') }); record({ metric, ms: 0, ok: false, work: { sample: index }, error: String(error) }); throw error; }
    finally { try { await budget.pause(); } finally { await closeContext(owned); } }
  }
  async function prepareBanker(owned: BrowserContext) {
    const page = await owned.newPage(); watch(page);
    await page.goto(path('workspace'), { waitUntil: 'commit' }); await meaningful(page); await worker(page); return page;
  }
  async function save(page: Page, note: string, paid: boolean) {
    options.phase(stack.proxy.enabled ? 'prepare.entry' : 'prepare.viewer-write');
    const player = fixture.playerId;
    await page.getByTestId(`player-${player}`).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Buy-in', exact: true }).click();
    await expect(page.getByLabel('Amount', { exact: true })).toBeEnabled();
    await page.getByLabel('Amount', { exact: true }).fill('1');
    await page.getByLabel('Paid now', { exact: true }).setChecked(paid);
    if (paid) await page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Cash', exact: true }).click();
    await page.getByText('Record an earlier time or note', { exact: true }).click();
    await page.getByLabel('Note', { exact: true }).fill(note);
    const button = page.getByRole('button', { name: 'Save entry', exact: true });
    await button.evaluate(button => button.addEventListener('click', () => { performance.clearMarks('benchmark-save'); performance.mark('benchmark-save'); }, { once: true }));
    const displayed = page.evaluate(({ note, total }) => (window as ObservedWindow).__pbObserveSaved!(note, total), { note, total: formatMoney(BigInt(state.totals.total_in_minor) + 100n, 'USD') });
    void displayed.catch(() => {});
    options.phase(stack.proxy.enabled ? 'entry.confirm' : 'viewer.delay');
    const responsePromise = page.waitForResponse(response => response.url().includes(`/api/sessions/${fixture.sessionId}/entries`) && response.request().method() === 'POST' && response.request().postDataJSON().note === note);
    void responsePromise.catch(() => {});
    await button.click();
    const confirmed = await displayed;
    const response = await responsePromise; expect(response.status()).toBe(200);
    state = await response.json() as SessionState;
    const entry = state.entries.find(entry => entry.note === note && entry.kind === 'buy_in'); expect(entry).toBeDefined();
    await expect(page.getByTestId(`entry-${entry!.id}`)).toBeVisible();
    await expect(page.getByTestId('totals').locator('strong').first()).toHaveText(formatMoney(BigInt(state.totals.total_in_minor), 'USD'));
    const click = await page.evaluate(() => performance.timeOrigin + performance.getEntriesByName('benchmark-save').at(-1)!.startTime);
    const timing = { click, confirmed };
    const count = (await stack.database.pool.query('SELECT count(*)::int AS count FROM ledger_entries WHERE banker_id=$1 AND session_id=$2 AND note=$3 AND kind=\'buy_in\'', [fixture.bankerId, fixture.sessionId, note])).rows[0]!.count;
    expect(count).toBe(1); expect(errors).toEqual([]);
    return { ...timing, entry, revision: state.revision, entries: state.entries.length };
  }
  const observers: BrowserContext[] = [];
  let bankerContext: BrowserContext | undefined;
  try {
    const targets: Target[] = options.reverse ? ['viewer', 'workspace'] : ['workspace', 'viewer'];
    const caches = options.reverse ? ['warm', 'cold'] as const : ['cold', 'warm'] as const;
    for (let index = 0; index < options.samples; index++) for (const target of targets) for (const cache of caches) if (wanted(`${target}.${cache}`)) await load(target, cache, index);
    if (hasWrites) {
    options.phase('prepare.banker');
    bankerContext = await context(true);
    const banker = await prepareBanker(bankerContext);
    stack.proxy.enabled = wanted('entry.confirm'); if (wanted('entry.confirm')) budget.start();
    for (let index = 0; index < (wanted('entry.confirm') ? options.samples : 0); index++) {
      try {
        const before = state.entries.length;
        const result = await save(banker, `Benchmark save ${randomUUID()}`, true);
        expect(result.entries - before).toBe(2);
        record({ metric: 'entry.confirm', ms: result.confirmed - result.click, ok: true, work: { ledger_rows_written: 2, buy_in_rows_written: 1, confirmedEpoch: result.confirmed, revision: result.revision, ledger_rows_after: result.entries, profile: 'synthetic phone' } });
      } catch (error) { record({ metric: 'entry.confirm', ms: 0, ok: false, work: {}, error: String(error) }); throw error; }
    }
    await budget.pause(); stack.proxy.enabled = false;
    for (const count of (options.reverse ? [25, 10, 1] : [1, 10, 25]).filter(count => wanted(`viewer.delay.${count}`))) {
      options.phase(`prepare.viewers.${count}`);
      const viewers: Page[] = [];
      try {
        for (let index = 0; index < count; index++) {
          const owned = await context(false); observers.push(owned);
          const page = await owned.newPage(); watch(page); viewers.push(page);
          await page.goto(path('viewer'), { waitUntil: 'commit' }); await meaningful(page);
          expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
        }
        for (let index = 0; index < options.samples; index++) {
          const note = `Benchmark live ${randomUUID()}`;
          const seen = viewers.map(page => page.evaluate(({ note, total }) => (window as ObservedWindow).__pbObserveSaved!(note, total), { note, total: formatMoney(BigInt(state.totals.total_in_minor) + 100n, 'USD') }));
          for (const promise of seen) void promise.catch(() => {});
          try {
            const result = await save(banker, note, false);
            const displayed = await Promise.all(seen);
            expect(displayed).toHaveLength(count);
            for (const [viewer, epoch] of displayed.entries()) {
              await expect(viewers[viewer]!.getByTestId(`entry-${result.entry!.id}`)).toBeVisible();
              await expect(viewers[viewer]!.getByTestId('totals').locator('strong').first()).toHaveText(formatMoney(BigInt(state.totals.total_in_minor), 'USD'));
              record({ metric: `viewer.delay.${count}`, ms: epoch - result.click, ok: true, work: { concurrency: count, viewers_completed: count, viewer, batch: index, renderedEpoch: epoch, ledger_rows_written: 1, revision: result.revision, banker_confirmed_ms: result.confirmed - result.click, confirmed_to_viewer_ms: epoch - result.confirmed, profile: 'unthrottled load generator; real visible WebKit contexts' } });
            }
            if (index === 0) await viewers[0]!.screenshot({ path: join(output, `live-${count}-viewers.png`) });
          } catch (error) { record({ metric: `viewer.delay.${count}`, ms: 0, ok: false, work: { concurrency: count, batch: index }, error: String(error) }); throw error; }
        }
      } finally {
        for (const page of viewers) { const owned = page.context(); await closeContext(owned); observers.splice(observers.indexOf(owned), 1); }
      }
    }
    }
    expect(errors).toEqual([]);
    const cpu = profiled ? budget.summary() : null;
    if (cpu) { expect(cpu.cycles).toBeGreaterThan(0);
    expect(cpu.actualRunnableFraction).toBeGreaterThan(.15); expect(cpu.actualRunnableFraction).toBeLessThan(.35); }
    await writeFile(join(output, 'profile.json'), JSON.stringify({ cpu, network: stack.proxy.profile(), proxyCounts: stack.proxy.counts, engineHashes: engine.hashes, browserVersion: browser.version(), browserErrors: errors, teardownErrors }, null, 2));
    return { cpu, errors };
  } finally {
    try { await budget.pause(); } finally {
      stack.proxy.enabled = false;
      try { for (const owned of observers) await closeContext(owned); if (bankerContext) await closeContext(bankerContext); } finally { try { await closeBrowser(); } finally { releaseBrowser(); } }
    }
  }
}
