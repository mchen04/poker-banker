import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { addPlayer, call, current, keepMoneyDraft, newContextLike, newSession, workerReady, workspaceReady } from '../e2e/helpers';
import { ownedMain } from './owned-command';
import { buildArchivedUpdateRelease, buildUpdateRelease, type PreviousSourceInput } from './update-release';
import { capture, controllerRelease, databaseSnapshot, draft, releaseIs, restoredDraft, visible, type UpdateJourneyOptions } from './verify-update-journey';
import { createUpdateProofProxy } from './update-proof-proxy';

export const reviewBaselineSourceSha = '958e1141117b7a2a44e8de27544b9e2ad258e55f';
export const liveLegacySourceSha = '30209c1bff774172c89e8dba1901a1e597e860b6';
type ReviewMode = 'baseline' | 'fixed';
type ReviewRow = { case: string; regressionObserved: boolean; [key: string]: unknown };
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const shaHtml = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(prefix: string): PreviousSourceInput | undefined {
  return process.env[`${prefix}_MANIFEST`] ? { manifest: process.env[`${prefix}_MANIFEST`]!, manifestSha256: process.env[`${prefix}_MANIFEST_SHA256`] ?? '' } : undefined;
}
async function candidateRelease(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const worker = registration?.waiting ?? registration?.active;
    if (!worker) return null;
    return new Promise<string | null>(accept => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); accept(null); }, 1500);
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); accept(event.data.version); };
      worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    });
  }).catch(error => { if (error instanceof Error && /context was destroyed|navigation/i.test(error.message)) return null; throw error; });
}
async function lifecycle(page: Page) {
  await visible(page, true);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); window.dispatchEvent(new Event('online')); });
}

export async function verifyUpdateReviewCases(options: UpdateJourneyOptions & { mode?: ReviewMode; cases?: string[]; lockHeld?: boolean }) {
  const { page, browser, baseURL } = options;
  const mode = options.mode ?? (process.env.PB_UPDATE_REVIEW_MODE === 'baseline' ? 'baseline' : 'fixed');
  const selected = options.cases ?? process.env.PB_UPDATE_REVIEW_CASES?.split(',');
  const evidence = resolve(options.evidence);
  if (!['evidence', 'test-results', '.cache'].some(root => evidence.startsWith(`${resolve(root)}/`))) throw new Error('Review evidence must stay in an ignored checkout directory');
  return ownedMain(async owner => {
    await mkdir('.cache', { recursive: true });
    if (!options.lockHeld) {
      const lock = resolve('.cache/update-journey.lock');
      await mkdir(lock).catch(() => { throw new Error('Another update journey owns this checkout; serialize all local builds'); });
      owner.addCleanup('Update review exclusive build scope', 'cleanup', () => rm(lock, { recursive: true, force: true }));
    }
    await mkdir(evidence, { recursive: true });
    const proxy = await createUpdateProofProxy(owner, baseURL);
    const cookies = (await page.context().cookies(baseURL)).filter(cookie => cookie.name === 'pb_session');
    expect(cookies).toHaveLength(1);
    const banker = (await call<{ banker: { id: string } }>(page, '/auth/me')).banker.id;
    const contexts = new Set<BrowserContext>();
    owner.addCleanup('Update review browser contexts', 'cleanup', async () => { await Promise.all([...contexts].map(context => context.close())); });
    const fresh = async () => {
      const context = await newContextLike(page, browser, proxy.origin);
      await context.addCookies(cookies);
      contexts.add(context);
      return context;
    };
    const close = async (context: BrowserContext) => { await context.close(); contexts.delete(context); };
    const id = randomUUID().slice(0, 8);
    const builds: unknown[] = [];
    const build = async (release: string, legacy = false) => {
      const result = legacy ? await buildArchivedUpdateRelease(owner, release, liveLegacySourceSha, fixture('PB_UPDATE_LIVE_LEGACY')) : mode === 'baseline'
        ? await buildArchivedUpdateRelease(owner, release, reviewBaselineSourceSha, fixture('PB_UPDATE_BASELINE')) : await buildUpdateRelease(owner, release);
      builds.push(result);
      return result;
    };
    const seed = async (context: BrowserContext, release: string, label: string) => {
      const next = await context.newPage();
      await next.goto('/'); await workspaceReady(next);
      const state = await newSession(next, `${label} ${id}`);
      const player = await addPlayer(next, `${label} player ${id}`);
      await workerReady(next); await releaseIs(next, release);
      expect((await call<{ banker: { id: string } }>(next, '/auth/me')).banker.id).toBe(banker);
      return { page: next, context, session: state.session.id, player: player.id };
    };
    const rows: ReviewRow[] = [];
    const errors: { case: string; error: string }[] = [];
    const run = async (name: string, action: () => Promise<ReviewRow>) => {
      if (selected && !selected.includes(name)) return;
      const first = proxy.records.length;
      try {
        const result = await action();
        rows.push(result);
        expect(result.regressionObserved, `${name} ${mode} expected regression=${mode === 'baseline'}`).toBe(mode === 'baseline');
      } catch (error) { errors.push({ case: name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
      finally {
        await writeFile(join(evidence, `${name}-forwarded-requests.json`), JSON.stringify(proxy.records.slice(first), null, 2));
        await writeFile(join(evidence, 'review-cases-progress.json'), JSON.stringify({ mode, rows, errors, builds }, null, 2));
      }
    };

    await run('R1-stalled-navigation', async () => {
      const a = `r38-R1-A-${id}`, b = `r38-R1-B-${id}`;
      await build(a);
      const states = await Promise.all(['headers', 'body'].map(async phase => {
        const state = await seed(await fresh(), a, `R1 ${phase}`);
        await visible(state.page, false);
        return state;
      }));
      await build(b);
      const scenarios: Record<string, unknown>[] = [];
      try {
        for (const [index, phase] of (['headers', 'body'] as const).entries()) {
          const state = states[index]!;
          const gate = proxy.hold({ navigation: true, phase });
          const navigations: { url: string; at: number }[] = [];
          state.page.on('request', request => { if (request.isNavigationRequest() && request.frame() === state.page.mainFrame()) navigations.push({ url: request.url(), at: Date.now() }); });
          try {
        let signals = 0;
        await state.page.exposeFunction('__pbProofLifecycleSignal', () => { signals++; });
        await state.page.evaluate(() => {
          const timer = window.setInterval(() => {
            void (window as unknown as { __pbProofLifecycleSignal: () => Promise<void> }).__pbProofLifecycleSignal().catch(() => {});
            document.dispatchEvent(new Event('visibilitychange'));
            window.dispatchEvent(new Event('focus'));
            window.dispatchEvent(new Event('pageshow'));
            window.dispatchEvent(new Event('online'));
          }, 250);
          window.setTimeout(() => clearInterval(timer), 6000);
        });
        await lifecycle(state.page);
        await expect.poll(() => gate.records.filter(record => record.upstreamFinishedAt).length).toBeGreaterThan(0);
        await state.page.waitForTimeout(4200);
        const beforeRelease = [...navigations];
        expect(signals).toBeGreaterThan(0);
        const stalledRealResponses = gate.records.filter(record => record.upstreamFinishedAt);
        expect(stalledRealResponses.every(record => record.status === 200 && record.bodyBytes! > 0 && record.headers?.['content-type']?.includes('text/html'))).toBe(true);
        if (mode === 'fixed') {
          expect(beforeRelease).toHaveLength(1);
          await releaseIs(state.page, b, 10000);
          await capture(state.page, evidence, `R1-${phase}-cached-fallback-completed`);
        }
          scenarios.push({ phase, regressionObserved: beforeRelease.length > 1, before: a, after: b, lifecycleSignals: signals, actualNavigationRequests: beforeRelease, fallbackDeadlineMs: 3000, withheldActualHtmlResponses: stalledRealResponses.map(record => ({ status: record.status, headers: record.headers, bodySha256: record.bodySha256 })), finalDocument: await state.page.locator('meta[name="pb-release"]').getAttribute('content') });
          } finally { gate.release(); await close(state.context); }
        }
        return { case: 'R1-stalled-navigation', regressionObserved: scenarios.every(scenario => scenario.regressionObserved), scenarios };
      } finally { for (const state of states) if (contexts.has(state.context)) await close(state.context); }
    });

    await run('R2-unknown-client-cache-bound', async () => {
      const legacyRelease = `r38-legacy-302-R2-${id}`;
      await build(legacyRelease, true);
      const state = await seed(await fresh(), legacyRelease, 'R2 legacy');
      await draft(state.page, state.player, '61.');
      const records: { release: string; caches: string[] }[] = [];
      try {
        for (const letter of ['A', 'B', 'C', 'D', 'E', 'F']) {
          const release = `r38-R2-${letter}-${id}`;
          await build(release);
          const candidate = await state.context.newPage();
          await candidate.goto(`/?session=${state.session}`);
          await expect(candidate.locator('meta[name="pb-release"]')).toHaveAttribute('content', release);
          await expect.poll(() => candidateRelease(candidate), { timeout: 25000 }).toBe(release);
          await candidate.waitForTimeout(1800);
          await expect(state.page.getByTestId('money-amount')).toHaveValue('61.');
          records.push({ release, caches: await state.page.evaluate(async () => (await caches.keys()).filter(key => key.startsWith('poker-banker-') && !key.includes('metadata'))) });
          await candidate.close();
        }
        const final = records.at(-1)!;
        if (mode === 'fixed') { expect(final.caches.length).toBeLessThanOrEqual(5); expect(final.caches).toContain(`poker-banker-${legacyRelease}`); }
        await capture(state.page, evidence, 'R2-legacy-still-editing-after-six-candidates');
        return { case: 'R2-unknown-client-cache-bound', regressionObserved: final.caches.length > 5, legacySource: liveLegacySourceSha, legacyRelease, snapshots: records, retainedCacheBound: 5, legacyDocument: await state.page.locator('meta[name="pb-release"]').getAttribute('content'), permanentNonresponse: 'Unmodified 30209c1 client has no CLIENT_RELEASE_REQUEST listener; same live document across all candidates' };
      } finally { await close(state.context); }
    });

    await run('R3-live-production-client', async () => {
      const legacyRelease = `r38-legacy-302-R3-${id}`, b = `r38-R3-B-${id}`;
      await build(legacyRelease, true);
      const state = await seed(await fresh(), legacyRelease, 'R3 timer');
      const queuedPlayer = await addPlayer(state.page, `R3 queued ${id}`);
      const editor = await state.context.newPage();
      await editor.goto(`/?session=${state.session}`); await releaseIs(editor, legacyRelease);
      await draft(editor, state.player, '43.', 'Zelle');
      const durable = (await databaseSnapshot(editor)).drafts.find(row => row.value.amount === '43.')!;
      const queuePage = await state.context.newPage();
      await queuePage.goto(`/?session=${state.session}`); await releaseIs(queuePage, legacyRelease);
      await visible(queuePage, false);
      const gate = proxy.hold({ path: `/api/sessions/${state.session}/start`, method: 'POST', phase: 'body' });
      let timerReloads = 0;
      state.page.on('request', request => { if (request.isNavigationRequest() && request.frame() === state.page.mainFrame()) timerReloads++; });
      try {
        await state.page.getByRole('button', { name: 'Start timer', exact: true }).click();
        await expect.poll(() => gate.records.filter(record => record.upstreamFinishedAt).length).toBe(1);
        expect(gate.records[0]!.status).toBe(200);
        expect((await current(editor, state.session)).session.started_at).not.toBeNull();
        await build(b);
        await lifecycle(state.page);
        await expect.poll(() => candidateRelease(state.page), { timeout: 25000 }).toBe(b);
        await state.page.waitForTimeout(4200);
        const prematureReloads = timerReloads;
        await expect(editor.getByTestId('money-amount')).toHaveValue('43.');
        await expect(editor.locator('meta[name="pb-release"]')).toHaveAttribute('content', legacyRelease);
        if (mode === 'fixed') { expect(prematureReloads).toBe(0); expect(await controllerRelease(state.page)).toBe(legacyRelease); }
        await capture(editor, evidence, 'R3-live-302-typed-draft-and-held-post');
        await state.page.close();
        await state.context.setOffline(true);
        await expect(queuePage.locator('meta[name="pb-release"]')).toHaveAttribute('content', legacyRelease);
        await draft(queuePage, queuedPlayer.id, '29', 'Venmo');
        await queuePage.getByRole('button', { name: 'Save entry', exact: true }).click();
        await expect(queuePage.getByText('Not saved yet', { exact: true }).first()).toBeVisible();
        const queued = (await databaseSnapshot(queuePage)).outbox[0]!;
        expect(queued).toBeTruthy();
        await keepMoneyDraft(editor);
        await queuePage.close();
        await capture(editor, evidence, 'R3-302-durable-draft-and-real-offline-outbox');
        await editor.close();
        gate.release();
        await state.context.setOffline(false);
        const cold = await state.context.newPage();
        const outgoing: unknown[] = [];
        cold.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === queued.path) outgoing.push(request.postDataJSON()); });
        await cold.goto(`/?session=${state.session}`); await releaseIs(cold, b);
        await expect.poll(async () => (await databaseSnapshot(cold)).outbox.length).toBe(0);
        expect(outgoing.length).toBeGreaterThan(0);
        expect(outgoing.every(body => sha(body) === sha(queued.body))).toBe(true);
        const after = await databaseSnapshot(cold);
        expect(after.drafts.find(row => row.key === durable.key)).toEqual(durable);
        const confirmed = await current(cold, state.session);
        expect(confirmed.entries.filter(entry => entry.player_id === queuedPlayer.id && entry.kind === 'buy_in' && entry.amount_minor === '2900')).toHaveLength(1);
        await restoredDraft(cold, state.player, '43.', 'Zelle');
        await capture(cold, evidence, 'R3-cold-B-restores-302-draft-and-replays-outbox');
        return { case: 'R3-live-production-client', regressionObserved: prematureReloads > 0, legacySource: liveLegacySourceSha, before: legacyRelease, after: b, prematureReloads, realPost: gate.records[0], timerCommittedBeforeGateRelease: true, activationConstraint: 'New worker waits until every unmodified legacy document closes; no hot-upgrade safety claim for the old client', draftBeforeSha256: sha(durable), draftAfterSha256: sha(after.drafts.find(row => row.key === durable.key)), outboxBodySha256: sha(queued.body), outgoingBodiesSha256: outgoing.map(sha), idbVersion: after.version, bankerId: banker, sessionId: state.session };
      } finally { gate.release(); await close(state.context); }
    });

    await run('R4-initial-html-bundle-skew', async () => {
      const a = `r38-R4-A-${id}`, b = `r38-R4-B-${id}`, c = `r38-R4-C-${id}`, d = `r38-R4-D-${id}`;
      await build(a);
      const state = await seed(await fresh(), a, 'R4 skew');
      await state.page.close();
      await build(c);
      const staging = await mkdtemp(resolve('.cache/update-skew-'));
      owner.addCleanup('Update skew staged release', 'cleanup', () => rm(staging, { recursive: true, force: true }));
      await cp('dist', join(staging, 'C'), { recursive: true });
      await build(b);
      const htmlB = await readFile('dist/index.html', 'utf8');
      const entryB = htmlB.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
      if (!entryB) throw new Error('B production HTML must reference its real hashed initial module');
      const next = await state.context.newPage();
      const gate = proxy.hold({ path: entryB, method: 'GET', phase: 'request' });
      const navigation = next.goto(`/?session=${state.session}`, { waitUntil: 'commit' });
      try {
        await navigation;
        await expect.poll(() => gate.records.length).toBeGreaterThan(0);
        await expect(next.locator('meta[name="pb-release"]')).toHaveAttribute('content', b);
        const htmlResponse = [...proxy.records].reverse().find(record => record.status === 200 && record.headers?.['content-type']?.includes('text/html') && new URL(record.path, proxy.origin).searchParams.get('session') === state.session && record.bodySha256 === shaHtml(htmlB));
        expect(htmlResponse?.bodySha256).toBe(shaHtml(htmlB));
        expect(gate.records[0]!.upstreamFinishedAt).toBeUndefined();
        await rm('dist', { recursive: true, force: true });
        await cp(join(staging, 'C'), 'dist', { recursive: true });
        gate.release();
        expect(await next.evaluate(async path => {
          for (const key of await caches.keys()) if (await (await caches.open(key)).match(path)) return true;
          return false;
        }, entryB)).toBe(false);
        await expect.poll(() => proxy.records.some(record => new URL(record.path, proxy.origin).pathname === entryB && record.status === 404)).toBe(true);
        if (mode === 'fixed') { await releaseIs(next, c, 25000); await workspaceReady(next); }
        else await next.waitForTimeout(18000);
        const finalDocument = await next.locator('meta[name="pb-release"]').getAttribute('content');
        const started = await next.getByRole('navigation', { name: 'Table navigation', exact: true }).isVisible();
        await capture(next, evidence, 'R4-real-initial-module-404-result');
        const result: ReviewRow = { case: 'R4-initial-html-bundle-skew', regressionObserved: finalDocument === b && !started, before: a, deliveredHtml: b, deployedBeforeModuleFetch: c, initialModule: entryB, initialModuleActualHttpStatus: 404, deliveredHtmlSha256: htmlResponse?.bodySha256, moduleForwardedAfterDeployment: gate.records[0], finalDocument, appStarted: started };
        await close(state.context);
        if (mode === 'fixed') {
          await build(d);
          const htmlD = await readFile('dist/index.html', 'utf8');
          const entryD = htmlD.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
          if (!entryD?.startsWith('/assets/')) throw new Error('D initial entry must be an emitted asset');
          await rm(join('dist', entryD.slice(1)));
          const brokenContext = await fresh();
          const broken = await brokenContext.newPage();
          const navigations: string[] = [];
          broken.on('request', request => { if (request.isNavigationRequest() && request.frame() === broken.mainFrame()) navigations.push(request.url()); });
          await broken.goto('/?review-budget=1', { waitUntil: 'domcontentloaded' });
          await expect.poll(() => navigations.length, { timeout: 25000 }).toBe(3);
          const stopped = navigations.length;
          await broken.waitForTimeout(17000);
          expect(navigations).toHaveLength(stopped);
          expect(new URL(broken.url()).searchParams.get('__pb_boot')).toMatch(/\.2$/);
          result.persistent404 = { navigationCount: navigations.length, urls: navigations, finalUrl: broken.url(), stoppedObservationMs: 17000, actualMissingModule: entryD };
          await capture(broken, evidence, 'R4-persistent-404-budget-stops');
          await close(brokenContext);
          await build(c);
          const normalContext = await fresh();
          const normal = await normalContext.newPage();
          let normalNavigations = 0;
          normal.on('request', request => { if (request.isNavigationRequest() && request.frame() === normal.mainFrame()) normalNavigations++; });
          await normal.goto('/'); await workspaceReady(normal); await workerReady(normal);
          await normal.waitForTimeout(17000);
          expect(normalNavigations).toBe(1);
          result.normalBoot = { navigationCount: normalNavigations, observationMs: 17000, url: normal.url() };
          await close(normalContext);
        }
        return result;
      } finally { gate.release(); await navigation.catch(() => {}); if (contexts.has(state.context)) await close(state.context); }
    });
    const result = { mode, rows, errors, builds, origin: proxy.origin, upstream: baseURL, bankerId: banker, actualForwarding: true, limitations: ['Loopback TLS, owned PostgreSQL and real HTTP bodies; no production writes.', 'Desktop/phone browser emulation does not prove physical iOS suspension or Home Screen behavior.', 'Legacy activation is explicitly deferred until all legacy documents close.'] };
    await writeFile(join(evidence, 'review-cases-summary.json'), JSON.stringify(result, null, 2));
    if (errors.length) throw new AggregateError(errors.map(error => new Error(`${error.case}: ${error.error}`)), `Update review proof failed in ${errors.map(error => error.case).join(', ')}`);
    return result;
  });
}
