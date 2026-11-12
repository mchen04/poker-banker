import { randomUUID } from 'node:crypto';
import { cp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { typeInput } from '../../e2e/input';
import { formatMoney } from '../../src/domain/money';
import type { SessionState } from '../../src/domain/session';
import type { benchmarkStack } from './stack';
import type { CpuBudget } from './profile';
import type { RecordSample } from './types';
import { evaluateInPage, observeRequests } from './browser-telemetry';

type Stack = Awaited<ReturnType<typeof benchmarkStack>>;
type Options = { samples: number; reverse: boolean; phase: (name: string) => void; metrics?: Set<string>; memoryCycles?: number; updateReleases?: { beforePath: string; afterPath: string; beforeRelease: string; afterRelease: string } };
type Render = { selector: string; text?: string; includes?: string; absent?: string; total?: string; attribute?: [string, string]; hasValue?: boolean; sessions?: number; note?: string };
type Timing = { start: number; confirmed: number; nextPaint: number | null; validation?: Record<string, unknown> };
type JourneyWindow = Window & { __pbJourney?: Promise<Timing> };
const total = (state: SessionState) => formatMoney(BigInt(state.totals.on_table_minor ?? state.totals.discrepancy_minor ?? '0'), state.session.currency);
const frames = (page: Page) => evaluateInPage(page, () => new Promise<number>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.timeOrigin + performance.now())))));

async function ready(page: Page, state: SessionState) {
  const rendered = await evaluateInPage(page, expected => {
    const valid = () => document.querySelector('h1')?.getAttribute('aria-label') === expected.name && document.querySelector('[data-testid="totals"] strong')?.textContent === expected.total && document.querySelectorAll('.players .player-row').length === expected.ids.length && expected.ids.every(id => !!document.querySelector(`[data-testid="player-${id}"]`));
    const initial = (window as Window & { __pbBenchMeaningful?: { epoch: number } }).__pbBenchMeaningful;
    if (initial && valid()) return initial.epoch;
    return new Promise<number>((resolve, reject) => {
      let pending = false;
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Session content did not render')); }, 30000);
      const check = () => { if (pending || !valid()) return; pending = true; requestAnimationFrame(() => requestAnimationFrame(() => { pending = false; if (!valid()) return; clearTimeout(timeout); observer.disconnect(); resolve(performance.timeOrigin + performance.now()); })); };
      const observer = new MutationObserver(check); observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true }); check();
    });
  }, { name: state.session.name, total: total(state), ids: state.players.map(player => player.id) });
  await expect(page.locator('h1')).toHaveAttribute('aria-label', state.session.name);
  await expect(page.getByTestId('totals').locator('strong').first()).toHaveText(total(state));
  await expect(page.locator('.players .player-row')).toHaveCount(state.players.length);
  for (const player of state.players) await expect(page.getByTestId(`player-${player.id}`)).toBeVisible();
  return rendered;
}

async function arm(page: Page, target: Locator | null, expected: Render) {
  await evaluateInPage(page, expected => {
    let start = 0, nextPaint = 0;
    (window as JourneyWindow).__pbJourney = new Promise<Timing>((resolve, reject) => {
      let pending = false;
      const valid = () => {
        const element = document.querySelector(expected.selector);
        return !!element?.getClientRects().length && (expected.text === undefined || element.textContent === expected.text) && (expected.includes === undefined || !!element.textContent?.includes(expected.includes)) && (!expected.absent || !document.querySelector(expected.absent)) && (expected.sessions === undefined || document.querySelector('.report-bucket > p.hint')?.textContent === `${expected.sessions} finalized sessions`) && (!expected.total || document.querySelector('[data-testid="totals"] strong')?.textContent === expected.total) && (!expected.attribute || element.getAttribute(expected.attribute[0]) === expected.attribute[1]) && (!expected.hasValue || element instanceof HTMLInputElement && element.value.length > 0) && (!expected.note || [...document.querySelectorAll('[data-testid^="entry-"] small')].some(element => element.textContent?.includes(expected.note!)));
      };
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Journey render timed out')); }, 30000);
      const check = () => {
        if (!start || pending || !valid()) return;
        pending = true;
        requestAnimationFrame(() => requestAnimationFrame(() => { pending = false; if (!valid()) return; observer.disconnect(); clearTimeout(timeout); resolve({ start, confirmed: performance.timeOrigin + performance.now(), nextPaint }); }));
      };
      const observer = new MutationObserver(check);
      observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
      const begin = () => { start = performance.timeOrigin + performance.now(); requestAnimationFrame(() => { nextPaint = performance.timeOrigin + performance.now(); check(); }); check(); };
      (window as Window & { __pbJourneyStart?: () => void }).__pbJourneyStart = begin;
    });
    void (window as JourneyWindow).__pbJourney!.catch(() => {});
  }, expected);
  if (target) await target.evaluate(element => element.addEventListener('click', () => (window as Window & { __pbJourneyStart?: () => void }).__pbJourneyStart!(), { capture: true, once: true }));
}
const result = (page: Page) => evaluateInPage(page, () => (window as JourneyWindow).__pbJourney!);
const begin = (page: Page) => evaluateInPage(page, () => (window as Window & { __pbJourneyStart?: () => void }).__pbJourneyStart!());

export async function benchmarkJourneys(args: { stack: Stack; browser: Browser; context: (banker: boolean) => Promise<BrowserContext>; memoryContext: () => Promise<BrowserContext>; closeContext: (context: BrowserContext) => Promise<void>; watch: (page: Page) => void; markOffline: (page: Page, value: boolean) => void; markUpdate: (page: Page, value: boolean) => void; budget: CpuBudget; record: RecordSample; options: Options; output: string }) {
  const { stack, context, closeContext, watch, budget, record, options, output } = args;
  const fixture = stack.fixture;
  const wanted = (metric: string) => !options.metrics || options.metrics.has(metric);
  const state = async (id = fixture.sessionId) => { const response = await stack.client.request(`/api/sessions/${id}`); expect(response.status).toBe(200); return response.body as SessionState; };
  const call = async (path: string, body: unknown) => { const response = await stack.client.request(path, { method: 'POST', body }); expect(response.status).toBe(200); return response.body as SessionState; };
  let noteSequence = 0;
  const nextNote = () => `B${++noteSequence}`;
  const workspace = `/?session=${fixture.sessionId}`;
  const switchHistory = wanted('session.switch') ? await stack.client.request('/api/sessions?status=closed') : undefined;
  if (switchHistory) expect(switchHistory.status).toBe(200);
  const switchTarget = (switchHistory?.body as { sessions: { id: string; name: string }[] } | undefined)?.sessions[0];
  async function worker(page: Page) { await expect.poll(() => page.evaluate(async () => !!navigator.serviceWorker.controller && !!(await navigator.serviceWorker.getRegistration('/'))?.active), { timeout: 20000 }).toBe(true); }
  async function prepare(owned: BrowserContext, selected?: SessionState) { const current = selected ?? await state(); const page = await owned.newPage(); watch(page); await page.goto(`/?session=${current.session.id}`, { waitUntil: 'commit' }); await ready(page, current); await worker(page); return page; }
  async function sample(metric: string, index: number, page: Page, action: () => Promise<Timing>, work: Record<string, string | number | boolean> = {}) {
    const observe = observeRequests(page);
    options.phase(metric);
    try {
      const timing = await action();
      const evidence = await observe();
      console.log(`[browser] ${metric} sample ${index + 1}: ${(timing.confirmed - timing.start).toFixed(1)}ms`);
      record({ metric, ms: timing.confirmed - timing.start, ok: true, work: { sample: index, workload: fixture.workload ?? 'large', players: fixture.counts.main_open_players!, ledger_entries_initial: fixture.counts.main_open_entries!, installed: true, profile: 'synthetic phone', ...(typeof timing.validation?.ledgerRowsWritten === 'number' ? { ledger_rows_written: timing.validation.ledgerRowsWritten } : {}), ...work }, evidence: { ...evidence, ...(timing.validation ? { validation: timing.validation } : {}), interaction: { eventEpoch: timing.start, confirmedEpoch: timing.confirmed, available: timing.nextPaint !== null, method: timing.nextPaint === null ? 'Navigation or foreground adoption; click responsiveness not applicable' : 'DOM event dispatch to next rAF callback; save confirmation ends after two animation frames; not INP', dispatchToNextAnimationFrameMs: timing.nextPaint === null ? null : timing.nextPaint - timing.start, confirmedRenderMs: timing.confirmed - timing.start }, resourceSizes: 'Response body size reflects wire bytes where browser exposes sizes; decoded body/hash computed from actual response; ResourceTiming cached transferSize=0 is legitimate', network: stack.proxy.profile(), cpu: 'Existing owned WebKit CpuBudget, requested 25ms runnable / 75ms stopped' } });
      return timing;
    } catch (error) {
      await observe().catch(() => {});
      record({ metric, ms: 0, ok: false, work: { sample: index, ...work }, error: String(error).replaceAll(fixture.username, 'OWNED_USER').replaceAll(fixture.password, 'OWNED_SECRET').replaceAll(fixture.token, 'OWNED_TOKEN') });
      if (metric === 'update.adoption') {
        const diagnosis = await evaluateInPage(page, async () => ({
          htmlRelease: document.querySelector('meta[name="pb-release"]')?.getAttribute('content'), visibility: document.visibilityState,
          inputs: [...document.querySelectorAll<HTMLInputElement>('input')].map(input => ({ type: input.type, hasValue: !!input.value, visible: !!input.getClientRects().length })),
          dialogs: document.querySelectorAll('[role="dialog"]').length, pending: document.querySelectorAll('[data-testid^="pending-"]').length,
          worker: await navigator.serviceWorker.getRegistration('/').then(registration => ({ active: registration?.active?.state, waiting: registration?.waiting?.state, installing: registration?.installing?.state })),
        })).catch(() => null);
        await writeFile(join(output, 'update-failure.json'), JSON.stringify(diagnosis, null, 2)).catch(() => {});
      }
      if (metric !== 'auth.signin') await page.screenshot({ path: join(output, 'journey-failure.png') }).catch(() => {});
      throw error;
    }
  }
  async function tap(page: Page, button: Locator, expected: Render) { await arm(page, button, expected); await button.click(); return result(page); }
  async function undo(page: Page, before: SessionState, entryId: string) {
    const response = page.waitForResponse(response => response.url().includes(`/entries/${entryId}/undo`) && response.request().method() === 'POST');
    const timing = await tap(page, page.getByRole('button', { name: 'Undo', exact: true }), { selector: '[data-testid="save-status"]', includes: 'Entry undone.', total: total(before) });
    const reply = await response; expect(reply.status()).toBe(200);
    const after = await reply.json() as SessionState;
    expect(after.totals).toEqual(before.totals);
    expect(after.entries.filter(entry => entry.voids_entry_id === entryId)).toHaveLength(1);
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
    timing.validation = { entryId, voidEntryIds: after.entries.filter(entry => entry.voids_entry_id === entryId).map(entry => entry.id), revisionBefore: before.revision, revisionAfter: after.revision, totalsRestored: true };
    return timing;
  }
  async function moneyForm(page: Page, before: SessionState, kind: 'buy_in' | 'cash_out', note: string, paid: boolean) {
    const player = before.players.find(player => player.id === fixture.playerId)!;
    await page.getByTestId(`player-${player.id}`).click();
    await page.getByRole('dialog').getByRole('button', { name: kind === 'buy_in' ? 'Buy-in' : 'Cash out', exact: true }).click();
    await expect(page.getByTestId('money-player')).toHaveText(player.display_name);
    await expect(page.getByTestId('money-amount')).toBeEnabled();
    await typeInput(page.getByTestId('money-amount'), '1');
    const method = paid ? before.entries.filter(entry => entry.player_id === player.id && entry.method).at(-1)?.method ?? 'cash' : null;
    await page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: method ? method[0]!.toUpperCase() + method.slice(1) : 'Unpaid', exact: true }).click();
    await page.getByText('Record an earlier time or note', { exact: true }).click();
    await typeInput(page.getByLabel('Note', { exact: true }), note);
    return { player, method };
  }
  async function save(page: Page, before: SessionState, kind: 'buy_in' | 'cash_out', note: string, method: string | null) {
    const delta = kind === 'buy_in' ? 100n : -100n;
    const response = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${before.session.id}/entries`) && response.request().method() === 'POST' && response.request().postDataJSON().note === note);
    const timing = await tap(page, page.getByRole('button', { name: 'Save entry', exact: true }), { selector: '[data-testid="saved-confirmation"]', includes: '$1.00', total: formatMoney(BigInt(before.totals.on_table_minor ?? before.totals.discrepancy_minor ?? '0') + delta, before.session.currency), absent: '[role="dialog"]', note });
    const reply = await response; expect(reply.status()).toBe(200);
    const after = await reply.json() as SessionState;
    const entry = after.entries.find(entry => entry.kind === kind && entry.note === note)!;
    expect(entry).toBeDefined(); expect(entry.player_id).toBe(fixture.playerId); expect(entry.amount_minor).toBe('100');
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
    expect(BigInt(after.totals.total_in_minor) - BigInt(before.totals.total_in_minor)).toBe(kind === 'buy_in' ? 100n : 0n);
    expect(BigInt(after.totals.total_out_minor) - BigInt(before.totals.total_out_minor)).toBe(kind === 'cash_out' ? 100n : 0n);
    const created = after.entries.filter(row => row.revision === after.revision);
    expect(created).toHaveLength(method ? 2 : 1);
    if (method) expect(created.find(row => row.kind === (kind === 'buy_in' ? 'payment_in' : 'payment_out'))?.method).toBe(method);
    const count = (await stack.database.pool.query('SELECT count(*)::int AS count FROM ledger_entries WHERE banker_id=$1 AND session_id=$2 AND note=$3 AND kind=$4', [fixture.bankerId, before.session.id, note, kind])).rows[0]!.count;
    expect(count).toBe(1); await expect(page.getByTestId(`entry-${entry.id}`)).toBeVisible();
    timing.validation = { entryId: entry.id, playerId: entry.player_id, amountMinor: entry.amount_minor, kind: entry.kind, method, revisionBefore: before.revision, revisionAfter: after.revision, ledgerRowsBefore: before.entries.length, ledgerRowsAfter: after.entries.length, ledgerRowsWritten: created.length, onceOnlyLedgerCount: count, displayedTotal: total(after) };
    return { timing, entry, after };
  }
  async function run(metric: string, index: number) {
    const owned = await context(metric !== 'auth.signin' && metric !== 'viewer.open' && metric !== 'viewer.first');
    let second: BrowserContext | undefined;
    try {
      stack.proxy.enabled = true;
      const before = await state();
      if (metric === 'auth.signin') {
        const page = await owned.newPage(); watch(page); await page.goto(workspace, { waitUntil: 'commit' });
        await typeInput(page.getByLabel('Username', { exact: true }), fixture.username); await typeInput(page.getByLabel('Password', { exact: true }), fixture.password);
        await budget.start();
        await sample(metric, index, page, () => tap(page, page.getByRole('button', { name: 'Sign in to table', exact: true }), { selector: `[data-testid="session-tab-${fixture.sessionId}"]`, total: total(before) }));
        await ready(page, before); return;
      }
      if (metric === 'viewer.open' || metric === 'viewer.first') {
        const page = await owned.newPage(); watch(page);
        if (metric === 'viewer.open') { await page.goto('/v/' + fixture.token, { waitUntil: 'commit' }); await ready(page, before); await worker(page); await page.goto('about:blank'); }
        await budget.start();
        await sample(metric, index, page, async () => { const start = Date.now(); await page.goto('/v/' + fixture.token, { waitUntil: 'commit' }); const confirmed = await ready(page, before); return { start, confirmed, nextPaint: null }; }, { cache: metric === 'viewer.first' ? 'fresh public viewer context; empty HTTP/IDB/service worker at navigation' : 'installed service worker; HTTP/IDB retained; document cold' });
        await expect(page.getByRole('navigation', { name: 'Table navigation', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: /Save entry|Session menu|Correct / })).toHaveCount(0); return;
      }
      const page = await prepare(owned, before);
      if (metric === 'ui.open.cold') {
        await page.goto('about:blank'); await budget.start();
        await sample(metric, index, page, async () => { const start = Date.now(); await page.goto(workspace, { waitUntil: 'commit' }); const confirmed = await ready(page, before); return { start, confirmed, nextPaint: null }; }, { cache: 'installed service worker; HTTP/IDB retained; document cold' }); return;
      }
      if (metric === 'ui.return.warm') {
        await visibility(page, false); await budget.start();
        await sample(metric, index, page, async () => { await arm(page, null, { selector: `[data-testid="session-tab-${fixture.sessionId}"]`, total: total(before) }); await visibility(page, true, true); return result(page); }, { cache: 'foreground existing installed DOM; no navigation' }); return;
      }
      if (metric === 'nav.players' || metric === 'report.open' || metric === 'report.filter') {
        const players = page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Players', exact: true });
        if (metric === 'nav.players') { await budget.start(); await sample(metric, index, page, () => tap(page, players, { selector: `[data-testid="roster-player-${fixture.playerId}"]` })); return; }
        await players.click();
        if (metric === 'report.open') {
          await budget.start(); await sample(metric, index, page, () => tap(page, page.getByTestId(`roster-player-${fixture.playerId}`), { selector: '[data-testid="report-profit_loss_minor"]', includes: '$', sessions: fixture.counts.main_player_report_sessions }));
          await expect(page.locator('.report-bucket > p.hint').first()).toHaveText(`${fixture.counts.main_player_report_sessions} finalized sessions`); return;
        }
        await page.getByTestId(`roster-player-${fixture.playerId}`).click(); await expect(page.getByTestId('report-profit_loss_minor').first()).toBeVisible();
        await page.getByRole('button', { name: 'Filter: Off', exact: true }).click(); await typeInput(page.getByLabel('Filter game', { exact: true }), 'NLH');
        const expectedReply = await stack.client.request(`/api/players/${fixture.playerId}/report?group=overall&game=NLH`); expect(expectedReply.status).toBe(200); const expectedReport = expectedReply.body as { groups: { sessions_count: number }[] }; const filteredCount = expectedReport.groups[0]!.sessions_count;
        const response = page.waitForResponse(response => response.url().includes(`/api/players/${fixture.playerId}/report?`) && new URL(response.url()).searchParams.get('game') === 'NLH');
        await budget.start();
        await sample(metric, index, page, async () => { const timing = await tap(page, page.getByRole('button', { name: 'Apply filters', exact: true }), { selector: '.report-bucket > p.hint', text: `${filteredCount} finalized session${filteredCount === 1 ? '' : 's'}`, absent: '[role="dialog"]' }); const reply = await response; expect(reply.status()).toBe(200); const report = await reply.json() as { groups: { sessions_count: number }[] }; expect(report).toEqual(expectedReport); await expect(page.locator('.report-bucket')).toHaveCount(report.groups.length); timing.validation = { playerId: fixture.playerId, filter: 'game=NLH', finalizedSessions: filteredCount, responseMatchedExpectedReport: true }; return timing; }, { filter: 'game=NLH' }); return;
      }
      if (metric === 'session.switch') {
        await page.getByRole('button', { name: 'Switch session', exact: true }).click();
        expect(switchTarget).toBeDefined(); await typeInput(page.getByLabel('Search sessions', { exact: true }), switchTarget!.name);
        const button = page.getByRole('dialog', { name: 'Sessions', exact: true }).getByTestId(`session-tab-${switchTarget!.id}`);
        await expect(button).toBeVisible(); const id = switchTarget!.id; const other = await state(id);
        await budget.start(); await sample(metric, index, page, () => tap(page, button, { selector: `[data-testid="session-tab-${id}"]`, total: total(other), absent: '[role="dialog"]' })); await ready(page, other); return;
      }
      if (metric === 'session.close') {
        await budget.pause(); stack.proxy.enabled = false;
        let disposable = await call('/api/sessions', { op_id: randomUUID(), name: 'Benchmark disposable close', played_on: new Date().toISOString().slice(0, 10), currency: 'USD' });
        disposable = await call(`/api/sessions/${disposable.session.id}/players`, { op_id: randomUUID(), player_id: fixture.playerIds[1]! });
        disposable = await call(`/api/sessions/${disposable.session.id}/entries`, { op_id: randomUUID(), player_id: fixture.playerIds[1]!, kind: 'buy_in', amount_minor: '100', paid_now: false });
        disposable = await call(`/api/sessions/${disposable.session.id}/entries`, { op_id: randomUUID(), player_id: fixture.playerIds[1]!, kind: 'cash_out', amount_minor: '100', paid_now: false });
        await page.goto(`/?session=${disposable.session.id}`, { waitUntil: 'commit' }); await ready(page, disposable); await page.getByRole('button', { name: 'Session menu', exact: true }).click(); await page.getByTestId('session-close').click();
        const response = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${disposable.session.id}/close`) && response.request().method() === 'POST'); stack.proxy.enabled = true; await budget.start();
        await sample(metric, index, page, () => tap(page, page.getByRole('dialog').getByRole('button', { name: 'Close session', exact: true }), { selector: '.status-line', text: 'Closed · chips balanced', absent: '[role="dialog"]' }));
        const reply = await response; expect(reply.status()).toBe(200); const closed = await reply.json() as SessionState; expect(closed.session.status).toBe('closed'); expect(closed.totals.discrepancy_minor).toBe('0'); return;
      }
      if (metric === 'entry.confirm' || metric === 'cash_out.confirm' || metric === 'undo.confirm') {
        const kind = metric === 'cash_out.confirm' ? 'cash_out' : 'buy_in'; const note = nextNote(); const form = await moneyForm(page, before, kind, note, true); await budget.start();
        let saved: Awaited<ReturnType<typeof save>>;
        if (metric === 'undo.confirm') { saved = await save(page, before, kind, note, form.method); await sample(metric, index, page, () => undo(page, before, saved.entry.id)); }
        else { await sample(metric, index, page, async () => { saved = await save(page, before, kind, note, form.method); return saved.timing; }); await undo(page, before, saved!.entry.id); }
        return;
      }
      if (metric === 'payment.confirm') {
        const note = nextNote(); const form = await moneyForm(page, before, 'buy_in', note, false); const bought = await save(page, before, 'buy_in', note, form.method); const current = bought.after;
        await page.getByTestId(`player-${fixture.playerId}`).click(); await page.getByRole('dialog').getByRole('button', { name: 'Record payment', exact: true }).click(); await expect(page.getByTestId('money-amount')).toBeEnabled(); await typeInput(page.getByTestId('money-amount'), '1'); await page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: 'Zelle', exact: true }).click(); await page.getByText('Record an earlier time or note', { exact: true }).click(); const paymentNote = nextNote(); await typeInput(page.getByLabel('Note', { exact: true }), paymentNote);
        const response = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${fixture.sessionId}/entries`) && response.request().method() === 'POST' && response.request().postDataJSON().note === paymentNote); await budget.start();
        await sample(metric, index, page, () => tap(page, page.getByRole('button', { name: 'Save entry', exact: true }), { selector: '[data-testid="saved-confirmation"]', includes: '$1.00', total: total(current), absent: '[role="dialog"]', note: paymentNote }), { method: 'zelle', settlement: 'Unpaid buy-in followed by exact payment' });
        const reply = await response; expect(reply.status()).toBe(200); const settled = await reply.json() as SessionState; const payment = settled.entries.find(entry => entry.note === paymentNote)!; expect(payment.kind).toBe('payment_in'); expect(payment.method).toBe('zelle'); expect(payment.player_id).toBe(fixture.playerId); expect(payment.amount_minor).toBe('100'); expect(settled.entries.filter(entry => entry.note === paymentNote)).toHaveLength(1); expect(settled.players.find(player => player.id === fixture.playerId)!.balance_minor).toBe(before.players.find(player => player.id === fixture.playerId)!.balance_minor);
        await undo(page, current, payment.id); const restored = await call(`/api/sessions/${fixture.sessionId}/entries/${bought.entry.id}/void`, { op_id: randomUUID() }); expect(restored.totals).toEqual(before.totals); return;
      }
      if (metric === 'share.enable') {
        let disposable = await call('/api/sessions', { op_id: randomUUID(), name: 'Benchmark disposable share', played_on: new Date().toISOString().slice(0, 10), currency: 'USD' }); expect(disposable.session.share_token).toBeNull();
        await page.goto(`/?session=${disposable.session.id}`, { waitUntil: 'commit' }); await ready(page, disposable); await page.getByRole('button', { name: 'Session menu', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Share session', exact: true }).click();
        const response = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${disposable.session.id}/share`) && response.request().method() === 'POST'); await budget.start();
        await sample(metric, index, page, () => tap(page, page.getByRole('button', { name: 'Enable sharing', exact: true }), { selector: 'input[readonly]', hasValue: true }), { trigger: 'Enable sharing for new unshared disposable session' });
        const reply = await response; expect(reply.status()).toBe(200); disposable = await reply.json() as SessionState; const link = await page.getByLabel('Viewer link', { exact: true }).inputValue(); expect(new URL(link).pathname).toBe(`/v/${disposable.session.share_token}`); await budget.pause(); stack.proxy.enabled = false; second = await context(false); const viewer = await second.newPage(); watch(viewer); await viewer.goto(link, { waitUntil: 'commit' }); await ready(viewer, disposable); await expect(viewer.getByRole('navigation', { name: 'Table navigation', exact: true })).toHaveCount(0); return;
      }
      if (metric === 'offline.replay') {
        const note = nextNote(); await moneyForm(page, before, 'buy_in', note, false); args.markOffline(page, true); await owned.setOffline(true); await page.getByRole('button', { name: 'Save entry', exact: true }).click(); await expect(page.getByRole('region', { name: 'Unsent entries', exact: true })).toBeVisible(); await expect(page.getByTestId('totals').locator('strong').first()).toHaveText(total(before)); expect((await state()).revision).toBe(before.revision);
        const response = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${fixture.sessionId}/entries`) && response.request().method() === 'POST' && response.request().postDataJSON().note === note); await budget.start();
        await sample(metric, index, page, async () => { await arm(page, null, { selector: '[data-testid="saved-confirmation"]', includes: '$1.00', total: formatMoney(BigInt(before.totals.on_table_minor!) + 100n, before.session.currency), absent: '[data-testid^="pending-"]' }); await begin(page); await owned.setOffline(false); args.markOffline(page, false); return result(page); }, { trigger: 'network reconnect; queued unpaid buy-in excluded before reconnect' });
        const reply = await response; expect(reply.status()).toBe(200); const after = await reply.json() as SessionState; const entry = after.entries.find(entry => entry.note === note && entry.kind === 'buy_in')!; expect(entry.amount_minor).toBe('100'); expect(entry.player_id).toBe(fixture.playerId); expect(after.entries.filter(entry => entry.note === note)).toHaveLength(1); expect((await state()).entries.filter(entry => entry.note === note)).toHaveLength(1); await undo(page, before, entry.id); return;
      }
      if (metric === 'viewer.delay.1') {
        second = await context(false); const viewer = await second.newPage(); watch(viewer); await viewer.goto(`/v/${fixture.token}`, { waitUntil: 'commit' }); await ready(viewer, before); const note = nextNote(); const form = await moneyForm(page, before, 'buy_in', note, false); await budget.start();
        await arm(viewer, null, { selector: '[data-testid="activity"]', includes: note, total: formatMoney(BigInt(before.totals.on_table_minor!) + 100n, before.session.currency) }); let saved: Awaited<ReturnType<typeof save>>;
        await sample(metric, index, viewer, async () => { await begin(viewer); saved = await save(page, before, 'buy_in', note, form.method); const displayed = await result(viewer); return { ...displayed, start: saved.timing.start, nextPaint: saved.timing.nextPaint }; }, { concurrency: 1, trigger: 'banker click to visible read-only viewer render' }); await expect(viewer.getByTestId(`entry-${saved!.entry.id}`)).toBeVisible(); await expect(viewer.getByRole('navigation', { name: 'Table navigation', exact: true })).toHaveCount(0); await undo(page, before, saved!.entry.id); return;
      }
      throw new Error(`Unknown browser journey ${metric}`);
    } finally { try { await budget.pause(); } finally { if (second) await closeContext(second); await closeContext(owned); } }
  }
  const metrics = ['ui.open.cold', 'ui.return.warm', 'auth.signin', 'nav.players', 'session.switch', 'entry.confirm', 'cash_out.confirm', 'undo.confirm', 'payment.confirm', 'session.close', 'report.open', 'report.filter', 'share.enable', 'viewer.first', 'viewer.open', 'viewer.delay.1', 'offline.replay'];
  for (let index = 0; index < options.samples; index++) for (const metric of (options.reverse !== !!(index % 2) ? [...metrics].reverse() : metrics).filter(wanted)) await run(metric, index);
  if ((options.memoryCycles ?? 0) > 0 && wanted('memory.cycles')) {
    const owned = await args.memoryContext();
    try {
      await budget.pause(); stack.proxy.enabled = false; const page = await prepare(owned); const cdp = await owned.newCDPSession(page); const cycles: unknown[] = []; const initial = await state();
      await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.collectGarbage');
      const beforeHeap = await cdp.send('Runtime.getHeapUsage'); const beforeDom = await cdp.send('Memory.getDOMCounters'); const observe = observeRequests(page);
      await cdp.send('Profiler.enable');
      for (let index = 0; index < options.memoryCycles!; index++) {
        if (index === 0) await cdp.send('Profiler.start');
        const before = await state(); const note = `M${index + 1}`; const form = await moneyForm(page, before, 'buy_in', note, true); const saved = await save(page, before, 'buy_in', note, form.method); const undone = await undo(page, before, saved.entry.id); const after = await state(); expect(after.totals).toEqual(initial.totals); expect(BigInt(after.revision) - BigInt(before.revision)).toBe(2n); expect(after.entries.length - before.entries.length).toBe(4); const dom = await cdp.send('Memory.getDOMCounters'); const heap = await cdp.send('Runtime.getHeapUsage'); cycles.push({ cycle: index + 1, dom, heap, renderedDomNodes: await page.locator('*').count(), saveMs: saved.timing.confirmed - saved.timing.start, undoMs: undone.confirmed - undone.start, entries: after.entries.length, revision: after.revision });
        if (index === 0) { const profile = await cdp.send('Profiler.stop'); await writeFile(join(output, 'first-cycle-cpu.json'), JSON.stringify(profile)); }
      }
      await cdp.send('HeapProfiler.collectGarbage'); const afterHeap = await cdp.send('Runtime.getHeapUsage'); const afterDom = await cdp.send('Memory.getDOMCounters'); const final = await state();
      const responsiveness = await observe();
      const evidence = { cycles, chromiumVersion: owned.browser()!.version(), beforeHeap, afterHeap, beforeDom, afterDom, ledgerRowsBefore: initial.entries.length, ledgerRowsAfter: final.entries.length, revisionBefore: initial.revision, revisionAfter: final.revision, totalsUnchanged: true, responses: responsiveness.responses, duplicateGetRequests: responsiveness.duplicateGetRequests, resources: responsiveness.resources, firstCycleCpuProfile: 'first-cycle-cpu.json; diagnostic profiler overhead, not an A/B timing', eventTiming: responsiveness.eventTiming, longTasks: responsiveness.longTasks, eventLoopDelay: responsiveness.eventLoopDelay, webkitJsHeap: { available: false, reason: 'WebKit has no supported JS heap API; no RSS substitution' }, method: 'Supplementary owned Chromium CDP Runtime.getHeapUsage and Memory.getDOMCounters; explicit GC before and after, same context and DOM throughout; unshaped', expectedGrowth: 'Each paid buy-in plus Undo adds four append-only audit rows and rendered activity rows; DOM growth alone does not establish a memory leak' };
      record({ metric: 'memory.cycles', ms: 0, ok: true, work: { cycles: options.memoryCycles!, reloads: 0, workload: fixture.workload ?? 'large', profile: 'unshaped supplementary owned Chromium CDP' }, evidence }); await writeFile(join(output, 'memory-cycles.json'), JSON.stringify(evidence, null, 2));
    } finally { try { await budget.pause(); } finally { await closeContext(owned); } }
  }
  if (wanted('update.adoption') && options.updateReleases) {
    const releases = options.updateReleases; const owned = await context(true);
    try {
      stack.proxy.enabled = true; const before = await state(); const page = await prepare(owned, before); await expect(page.locator('meta[name="pb-release"]')).toHaveAttribute('content', releases.beforeRelease); await expect.poll(() => version(page), { timeout: 15000 }).toBe(releases.beforeRelease); await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration('/'))!.update(); }); await visibility(page, false);
      await rm(resolve('dist'), { recursive: true, force: true }); await cp(releases.afterPath, resolve('dist'), { recursive: true }); await budget.start();
      await sample('update.adoption', 0, page, async () => { args.markUpdate(page, true); try { const start = Date.now(); await visibility(page, true); await expect(page.locator('meta[name="pb-release"]')).toHaveAttribute('content', releases.afterRelease, { timeout: 45000 }); await expect.poll(() => version(page), { timeout: 15000 }).toBe(releases.afterRelease); const confirmed = await ready(page, before); return { start, confirmed, nextPaint: null }; } finally { args.markUpdate(page, false); } }, { trigger: 'hidden to foreground; application automatic discovery and adoption; no manual update or reload' }); expect((await state()).revision).toBe(before.revision);
    } finally { try { await budget.pause(); } finally { try { await closeContext(owned); } finally { await rm(resolve('dist'), { recursive: true, force: true }); await cp(releases.beforePath, resolve('dist'), { recursive: true }); } } }
  }
}

async function visibility(page: Page, visible: boolean, timed = false) { await evaluateInPage(page, ({ visible, timed }) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => !visible }); if (timed) (window as Window & { __pbJourneyStart?: () => void }).__pbJourneyStart!(); document.dispatchEvent(new Event('visibilitychange')); }, { visible, timed }); }
async function version(page: Page) { return evaluateInPage(page, () => new Promise<string | null>((resolve, reject) => { const worker = navigator.serviceWorker.controller; if (!worker) { resolve(null); return; } const channel = new MessageChannel(); const timeout = setTimeout(() => reject(new Error('Worker version query timed out')), 5000); channel.port1.onmessage = event => { clearTimeout(timeout); resolve(event.data.version); }; worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]); })); }
