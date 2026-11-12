import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit, devices, expect, type Browser, type Page, type BrowserContext, type BrowserServer } from '@playwright/test';
import { formatMoney } from '../../src/domain/money';
import type { SessionState } from '../../src/domain/session';
import { observationScript, telemetryScript } from './observe';
import { benchmarkJourneys } from './journeys';
import { safePath } from './browser-telemetry';
import { typeInput } from '../../e2e/input';
import { CpuBudget, type isolatedEngine } from './profile';
import type { benchmarkStack } from './stack';
import type { RecordSample } from './types';
import { createProcessOwner, withShutdownDeadline } from '../owned-process';
type Stack = Awaited<ReturnType<typeof benchmarkStack>>;
type Engine = Awaited<ReturnType<typeof isolatedEngine>>;
type ObservedWindow = Window & { __pbObserveSaved?: (note: string, total: string) => Promise<number> };
type Target = 'workspace' | 'viewer';
export async function benchmarkBrowser(stack: Stack, engine: Engine, output: string, record: RecordSample, options: { samples: number; reverse: boolean; phase: (name: string) => void; metrics?: Set<string>; journeys?: boolean; memoryCycles?: number; updateReleases?: { beforePath: string; afterPath: string; beforeRelease: string; afterRelease: string } }) {
  const bounded = withShutdownDeadline;
  const owner = createProcessOwner({ parent: stack.owner });
  const memoryOnly = options.journeys && options.metrics?.size === 1 && options.metrics.has('memory.cycles');
  const wanted = (metric: string) => !options.metrics || options.metrics.has(metric);
  const hasWrites = wanted('entry.confirm') || [1,10,25].some(count => wanted(`viewer.delay.${count}`));
  const profiled = !memoryOnly && (options.journeys || wanted('entry.confirm') || ['workspace.cold','workspace.warm','viewer.cold','viewer.warm'].some(wanted));
  let server: BrowserServer | undefined;
  let browser: Awaited<ReturnType<typeof webkit.connect>> | undefined;
  let budget: CpuBudget | undefined;
  let memoryServer: BrowserServer | undefined;
  let memoryBrowser: Browser | undefined;
  owner.addCleanup('Benchmark browser server close', 'cleanup', () => server?.close());
  owner.addCleanup('Benchmark browser close', 'cleanup', () => browser?.close());
  owner.addCleanup('Benchmark CPU budget pause', 'pool', () => budget?.pause());
  owner.addCleanup('Benchmark memory browser server close', 'cleanup', () => memoryServer?.close());
  owner.addCleanup('Benchmark memory browser close', 'cleanup', () => memoryBrowser?.close());
  const closeBrowser = () => owner.stop();
  server = await owner.launch(async () => server = memoryOnly ? await chromium.launchServer({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }) : await webkit.launchServer({ executablePath: engine.executable, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }));
  try { browser = await owner.launch(async () => browser = await (memoryOnly ? chromium : webkit).connect(server!.wsEndpoint())); }
  catch (error) {
    try { await closeBrowser(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Benchmark browser connection and cleanup failed'); }
    throw error;
  }
  const connectedBrowser = browser;
  budget = new CpuBudget(engine.engine, server, owner);
  const errors: string[] = [];
  const teardownErrors: { url: string; message: string }[] = [];
  const pageErrors: { page: Page; url: string; message: string }[] = [];
  const offline = new WeakSet<Page>();
  const offlineFailures: { page: Page; url: string; failure: string }[] = [];
  const expectedOfflineErrors: { page: string; requestPath: string; message: string }[] = [];
  const closing = new WeakSet<Page>();
  const fixture = stack.fixture;
  let initial: Awaited<ReturnType<typeof stack.client.request>>;
  try { initial = await stack.client.request(`/api/sessions/${fixture.sessionId}`); expect(initial.status).toBe(200); } catch (error) { await closeBrowser(); throw error; }
  let state = initial.body as SessionState;
  expect(state.entries).toHaveLength(fixture.counts.main_open_entries!);
  const context = async (banker: boolean, target: Browser = connectedBrowser) => {
    const value = await target.newContext({ ...devices['iPhone 15'], baseURL: stack.origin, ignoreHTTPSErrors: true, locale: 'en-US', timezoneId: 'UTC' });
    await value.addInitScript({ content: `Object.defineProperty(navigator, 'standalone', { configurable: true, value: true }); { const native = window.matchMedia.bind(window); window.matchMedia = query => { const result = native(query); if (query.includes('display-mode') && query.includes('standalone')) Object.defineProperty(result, 'matches', { configurable: true, value: true }); return result; }; }` });
    await value.addInitScript({ content: telemetryScript });
    await value.addInitScript({ content: observationScript.replace('__PB_EXPECTED__', JSON.stringify({ name: state.session.name, total: formatMoney(BigInt(state.totals.on_table_minor ?? state.totals.discrepancy_minor ?? '0'), state.session.currency), ids: state.players.map(player => player.id), endpoint: banker ? `/api/sessions/${fixture.sessionId}` : `/api/view/${fixture.token}` })) });
    if (banker) await value.addCookies([{ name: 'pb_session', value: stack.client.cookie().slice('pb_session='.length), url: stack.origin, httpOnly: true, secure: true, sameSite: 'Lax' }]);
    return value;
  };
  function watch(page: Page) {
    page.on('pageerror', error => { if (closing.has(page)) teardownErrors.push({ url: safePath(page.url()), message: error.message }); else pageErrors.push({ page, url: safePath(page.url()), message: error.message }); });
    page.on('requestfailed', request => { if (offline.has(page)) offlineFailures.push({ page, url: request.url(), failure: request.failure()?.errorText ?? 'Request failed while explicitly offline' }); });
    page.on('response', response => { const path = safePath(response.url()); if (response.url().includes('/api/') && response.status() >= 400 && !(options.journeys && path === '/api/auth/me' && response.status() === 401)) errors.push(`${response.status()} ${path}`); });
  }
  const closingContexts = new WeakMap<BrowserContext, Promise<void>>();
  function closeContext(context: BrowserContext) {
    let pending = closingContexts.get(context);
    if (!pending) {
      for (const page of context.pages()) closing.add(page);
      pending = bounded('Benchmark browser context close', () => context.close());
      closingContexts.set(context, pending);
    }
    return pending;
  }
  owner.addCleanup('Benchmark browser contexts close', 'cleanup', async () => {
    const results = await Promise.allSettled(connectedBrowser.contexts().map(closeContext));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
    if (errors.length) throw new AggregateError(errors, 'Benchmark browser contexts failed to close');
  });
  async function meaningful(page: Page) {
    await expect.poll(() => page.evaluate(() => !!(window as Window & { __pbBenchMeaningful?: unknown }).__pbBenchMeaningful), { timeout: 20000 }).toBe(true);
    const proof = await page.evaluate(() => ({ marker: (window as Window & { __pbBenchMeaningful?: { ms: number; currentHttp: boolean; epoch: number } }).__pbBenchMeaningful!, name: document.querySelector('h1')?.getAttribute('aria-label') || document.querySelector('h1')?.textContent, total: document.querySelector('[data-testid="totals"] strong')?.textContent, players: [...document.querySelectorAll('.players .player-row')].map(row => row.getAttribute('data-testid')), visible: !!document.querySelector('h1')?.getClientRects().length }));
    expect(proof.name).toBe(state.session.name); expect(proof.visible).toBe(true);
    expect(proof.total).toBe(formatMoney(BigInt(state.totals.on_table_minor ?? state.totals.discrepancy_minor ?? '0'), state.session.currency));
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
      stack.proxy.enabled = true; await budget!.start();
      options.phase(`prepare.${target}.${cache}`);
      if (cache === 'warm') { await page.goto(path(target), { waitUntil: 'commit' }); await meaningful(page); await worker(page); currentResponses = 0; }
      options.phase(`${target}.${cache}`);
      if (cache === 'warm') await page.reload({ waitUntil: 'commit' }); else await page.goto(path(target), { waitUntil: 'commit' });
      const marker = await meaningful(page);
      expect(errors).toEqual([]);
      record({ metric, ms: marker.ms, ok: true, work: { players: state.players.length, ledger_entries: state.entries.length, profile: 'synthetic phone', cache, current_http_observed_at_render: marker.currentHttp, sample: index, renderedEpoch: marker.epoch } });
      await expect.poll(() => currentResponses, { timeout: 15000 }).toBeGreaterThan(0);
      const resources = await page.evaluate(() => (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map(entry => ({ path: new URL(entry.name).pathname.replace(/\/api\/view\/[^/]+/, '/api/view/OWNED_TOKEN'), startTime: entry.startTime, responseStart: entry.responseStart, responseEnd: entry.responseEnd, duration: entry.duration, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize, workerStart: entry.workerStart })));
      await writeFile(join(output, `${target}-${cache}-${index}-resources.json`), JSON.stringify({ marker, resources }, null, 2));
      if (index === 0) {
        await page.screenshot({ path: join(output, `${target}-${cache}.png`) });
        await writeFile(join(output, `${target}-${cache}.aria.txt`), await page.locator('body').ariaSnapshot());
      }
    } catch (error) { await writeFile(join(output, 'browser-failure.json'), JSON.stringify({ errors, error: String(error) }, null, 2)); await page.screenshot({ path: join(output, 'browser-failure.png') }); record({ metric, ms: 0, ok: false, work: { sample: index }, error: String(error) }); throw error; }
    finally { try { await bounded('Benchmark CPU budget pause', () => budget!.pause()); } finally { await closeContext(owned); } }
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
    await typeInput(page.getByLabel('Amount', { exact: true }), '1');
    await page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: paid ? 'Cash' : 'Unpaid', exact: true }).click();
    await page.getByText('Record an earlier time or note', { exact: true }).click();
    await typeInput(page.getByLabel('Note', { exact: true }), note);
    const button = page.getByRole('button', { name: 'Save entry', exact: true });
    await button.evaluate(button => button.addEventListener('click', () => { performance.clearMarks('benchmark-save'); performance.mark('benchmark-save'); }, { once: true }));
    const displayed = page.evaluate(({ note, total }) => (window as ObservedWindow).__pbObserveSaved!(note, total), { note, total: formatMoney(BigInt(state.totals.on_table_minor ?? state.totals.discrepancy_minor ?? '0') + 100n, state.session.currency) });
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
    await expect(page.getByTestId('totals').locator('strong').first()).toHaveText(formatMoney(BigInt(state.totals.on_table_minor ?? state.totals.discrepancy_minor ?? '0'), state.session.currency));
    const click = await page.evaluate(() => performance.timeOrigin + performance.getEntriesByName('benchmark-save').at(-1)!.startTime);
    const timing = { click, confirmed };
    const count = (await stack.database.pool.query('SELECT count(*)::int AS count FROM ledger_entries WHERE banker_id=$1 AND session_id=$2 AND note=$3 AND kind=\'buy_in\'', [fixture.bankerId, fixture.sessionId, note])).rows[0]!.count;
    expect(count).toBe(1); expect(errors).toEqual([]);
    return { ...timing, entry, revision: state.revision, entries: state.entries.length };
  }
  const observers: BrowserContext[] = [];
  let bankerContext: BrowserContext | undefined;
  try {
    const memoryContext = async () => {
      if (memoryOnly) return context(true);
      memoryServer = await owner.launch(async () => memoryServer = await chromium.launchServer({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }));
      memoryBrowser = await owner.launch(async () => memoryBrowser = await chromium.connect(memoryServer!.wsEndpoint()));
      return context(true, memoryBrowser);
    };
    const markOffline = (page: Page, value: boolean) => { if (value) offline.add(page); else offline.delete(page); };
    if (options.journeys) await benchmarkJourneys({ stack, browser: connectedBrowser, context, memoryContext, closeContext, watch, markOffline, budget, record, options, output });
    if (!options.journeys) {
    const targets: Target[] = options.reverse ? ['viewer', 'workspace'] : ['workspace', 'viewer'];
    const caches = options.reverse ? ['warm', 'cold'] as const : ['cold', 'warm'] as const;
    for (let index = 0; index < options.samples; index++) for (const target of targets) for (const cache of caches) if (wanted(`${target}.${cache}`)) await load(target, cache, index);
    if (hasWrites) {
    options.phase('prepare.banker');
    bankerContext = await context(true);
    const banker = await prepareBanker(bankerContext);
    stack.proxy.enabled = wanted('entry.confirm'); if (wanted('entry.confirm')) await budget!.start();
    for (let index = 0; index < (wanted('entry.confirm') ? options.samples : 0); index++) {
      try {
        const before = state.entries.length;
        const result = await save(banker, `Benchmark save ${randomUUID()}`, true);
        expect(result.entries - before).toBe(2);
        record({ metric: 'entry.confirm', ms: result.confirmed - result.click, ok: true, work: { ledger_rows_written: 2, buy_in_rows_written: 1, confirmedEpoch: result.confirmed, revision: result.revision, ledger_rows_after: result.entries, profile: 'synthetic phone' } });
      } catch (error) { record({ metric: 'entry.confirm', ms: 0, ok: false, work: {}, error: String(error) }); throw error; }
    }
    await bounded('Benchmark CPU budget pause', () => budget!.pause()); stack.proxy.enabled = false;
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
          const seen = viewers.map(page => page.evaluate(({ note, total }) => (window as ObservedWindow).__pbObserveSaved!(note, total), { note, total: formatMoney(BigInt(state.totals.on_table_minor ?? state.totals.discrepancy_minor ?? '0') + 100n, state.session.currency) }));
          for (const promise of seen) void promise.catch(() => {});
          try {
            const result = await save(banker, note, false);
            const displayed = await Promise.all(seen);
            expect(displayed).toHaveLength(count);
            for (const [viewer, epoch] of displayed.entries()) {
              await expect(viewers[viewer]!.getByTestId(`entry-${result.entry!.id}`)).toBeVisible();
              await expect(viewers[viewer]!.getByTestId('totals').locator('strong').first()).toHaveText(formatMoney(BigInt(state.totals.on_table_minor ?? state.totals.discrepancy_minor ?? '0'), state.session.currency));
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
    }
    const sanitize = (value: string) => value.replaceAll(fixture.username, 'OWNED_USER').replaceAll(fixture.password, 'OWNED_SECRET').replace(/\/(api\/view|v)\/[A-Za-z0-9_-]+/g, '/$1/OWNED_TOKEN');
    for (const error of pageErrors) {
      const failed = /due to access control checks\.?/i.test(error.message) ? offlineFailures.find(failure => {
        if (failure.page !== error.page) return false;
        if (error.message.includes(failure.url)) return true;
        const path = new URL(failure.url).pathname; const index = error.message.indexOf(path);
        return index >= 0 && /^(?:[?\s"'.,)]|$)/.test(error.message.slice(index + path.length));
      }) : undefined;
      if (failed) expectedOfflineErrors.push({ page: error.url, requestPath: safePath(failed.url), message: sanitize(error.message) });
      else errors.push(`${error.url}: ${sanitize(error.message)}`);
    }
    expect(errors).toEqual([]);
    const cpu = profiled ? budget!.summary() : null;
    if (cpu) { expect(cpu.cycles).toBeGreaterThan(0);
    expect(cpu.actualRunnableFraction).toBeGreaterThan(.15); expect(cpu.actualRunnableFraction).toBeLessThan(.35); }
    await writeFile(join(output, 'profile.json'), JSON.stringify({ cpu, network: stack.proxy.profile(), proxyCounts: stack.proxy.counts, engineHashes: engine.hashes, browserVersion: connectedBrowser.version(), browserErrors: errors, teardownErrors, expectedOfflineErrors, expectedOfflineFailures: offlineFailures.map(failure => ({ page: safePath(failure.page.url()), requestPath: safePath(failure.url), failure: sanitize(failure.failure) })) }, null, 2));
    return { cpu, errors };
  } finally {
    stack.proxy.enabled = false;
    for (const context of connectedBrowser.contexts()) for (const page of context.pages()) closing.add(page);
    await closeBrowser();
  }
}
