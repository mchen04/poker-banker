import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { addPlayer, call, captureContextProfile, current, keepMoneyDraft, money, newContextLike, newSession, workerReady, workspaceReady } from '../e2e/helpers';
import { ownedMain } from './owned-command';
import { buildArchivedUpdateRelease, buildUpdateRelease, type PreviousSourceInput, type ReleaseAsset, type WorkerObservationOptions } from './update-release';
import { capture, controllerRelease, databaseSnapshot, draft, releaseIs, restoredDraft, visible, type UpdateJourneyOptions } from './verify-update-journey';
import { createUpdateProofProxy } from './update-proof-proxy';

export const reviewBaselineSourceSha = '6cae494833f98de43e7003dd6d0e90188d86fd42';
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

type CacheInventory = { key: string; entries: { url: string; path: string; method: string; bytes: number; sha256: string }[]; bodyBytes: number };
async function cacheInventory(page: Page): Promise<CacheInventory[]> {
  for (let attempt = 1; ; attempt++) {
    try { return await cacheSnapshot(page); } catch (error) {
      if (attempt >= 5 || !String(error).includes('Cache entry disappeared during proof snapshot')) throw error;
      await page.waitForTimeout(250);
    }
  }
}
async function cacheSnapshot(page: Page): Promise<CacheInventory[]> {
  return page.evaluate(async () => {
    const result = [];
    for (const key of (await caches.keys()).filter(key => key.startsWith('poker-banker-') && !key.includes('metadata')).sort()) {
      const cache = await caches.open(key);
      const entries = [];
      for (const request of (await cache.keys()).slice().sort((left, right) => left.url.localeCompare(right.url))) {
        const response = await cache.match(request);
        if (!response) throw new Error('Cache entry disappeared during proof snapshot');
        const body = await response.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', body);
        entries.push({ url: request.url, path: new URL(request.url).pathname, method: request.method, bytes: body.byteLength, sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') });
      }
      result.push({ key, entries, bodyBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) });
    }
    return result;
  });
}
type CachePolicy = { clients: Record<string, { release?: string; pins?: string[] }>; manifests?: Record<string, string[]>; releases: Record<string, number>; inventories?: Record<string, string[]>; generation: number };
async function cachePolicy(page: Page): Promise<CachePolicy> {
  return page.evaluate(async () => {
    const request = indexedDB.open('poker-banker-updates');
    const database = await new Promise<IDBDatabase>((accept, reject) => { request.onsuccess = () => accept(request.result); request.onerror = () => reject(request.error); });
    try {
      return await new Promise<CachePolicy>((accept, reject) => {
        const read = database.transaction('policy', 'readonly').objectStore('policy').get('state');
        read.onsuccess = () => accept(read.result); read.onerror = () => reject(read.error);
      });
    } finally { database.close(); }
  });
}
type WorkerObservation = { release: string; instanceId: string; fetches: { at: number; clientId: string; method: string; path: string }[]; activations: { at: number; clientId: string | null; updateProtocol: number | null }[] };
async function observeWorker(page: Page, queryType: string, target: 'waiting' | 'active'): Promise<WorkerObservation> {
  return page.evaluate(async ({ queryType, target }) => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const worker = registration?.[target];
    if (!worker) throw new Error(`No ${target} worker for dispatch observation`);
    return new Promise<WorkerObservation>((accept, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Worker dispatch observation timed out')); }, 3000);
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); accept(event.data); };
      worker.postMessage({ type: queryType }, [channel.port2]);
    });
  }, { queryType, target });
}

export async function verifyUpdateReviewCases(options: UpdateJourneyOptions & { mode?: ReviewMode; cases?: string[]; lockHeld?: boolean }) {
  const { page, browser, baseURL } = options;
  const profile = options.profile ?? await captureContextProfile(page);
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
      const context = await newContextLike(page, browser, proxy.origin, profile);
      await context.addCookies(cookies);
      contexts.add(context);
      return context;
    };
    const close = async (context: BrowserContext) => { await context.close(); contexts.delete(context); };
    const id = randomUUID().slice(0, 8);
    const builds: unknown[] = [];
    const build = async (release: string, legacy = false, observation?: WorkerObservationOptions) => {
      const result = legacy ? await buildArchivedUpdateRelease(owner, release, liveLegacySourceSha, fixture('PB_UPDATE_LIVE_LEGACY'), observation) : mode === 'baseline'
        ? await buildArchivedUpdateRelease(owner, release, reviewBaselineSourceSha, fixture('PB_UPDATE_BASELINE'), observation) : await buildUpdateRelease(owner, release, undefined, observation);
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
        const expectedRegression = mode === 'baseline' && name === 'R7-failed-install-cache-bound';
        expect(result.regressionObserved, `${name} ${mode} expected regression=${expectedRegression}`).toBe(expectedRegression);
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
        expect(stalledRealResponses.every(record => record.status === 200 && record.bodyBytes! > 0 && record.contentType?.includes('text/html'))).toBe(true);
        if (mode === 'fixed') {
          expect(beforeRelease).toHaveLength(1);
          await releaseIs(state.page, b, 10000);
          await capture(state.page, evidence, `R1-${phase}-cached-fallback-completed`);
        }
          scenarios.push({ phase, regressionObserved: beforeRelease.length > 1, before: a, after: b, lifecycleSignals: signals, actualNavigationRequests: beforeRelease, fallbackDeadlineMs: 3000, withheldActualHtmlResponses: stalledRealResponses.map(record => ({ status: record.status, contentType: record.contentType, bodySha256: record.bodySha256 })), finalDocument: await state.page.locator('meta[name="pb-release"]').getAttribute('content') });
          } finally { gate.release(); await close(state.context); }
        }
        return { case: 'R1-stalled-navigation', regressionObserved: scenarios.every(scenario => scenario.regressionObserved), scenarios };
      } finally { for (const state of states) if (contexts.has(state.context)) await close(state.context); }
    });

    await run('R2-unknown-client-cache-bound', async () => {
      const legacyRelease = `r38-legacy-302-R2-${id}`;
      const legacyBuild = await build(legacyRelease, true);
      const state = await seed(await fresh(), legacyRelease, 'R2 legacy');
      await draft(state.page, state.player, '61.');
      const initial = await cacheInventory(state.page);
      const original = initial.find(cache => cache.key === `poker-banker-${legacyRelease}`)!;
      expect(original.entries.length).toBeGreaterThan(0);
      const rootHtml = original.entries.find(entry => entry.path === '/index.html')!;
      expect(rootHtml).toBeTruthy();
      const firstAsset = original.entries.find(entry => entry.path.startsWith('/assets/'))!;
      expect(firstAsset).toBeTruthy();
      const inventories = new Map<string, ReleaseAsset[]>([[legacyRelease, legacyBuild.assets]]);
      const records: { release: string; phase: string; caches: CacheInventory[]; totalEntries: number; totalBodyBytes: number; allowedRequestKeys: string[]; allowedCaches: string[]; allowedBodyBytes: number; allowedEntryCount: number; obsoleteEntries: { cache: string; path: string; bytes: number }[] }[] = [];
      const snapshot = async (release: string, phase: string, liveReleases: string[]) => {
        const caches = await cacheInventory(state.page);
        const allowed = new Map<string, number>();
        const candidates = [...inventories.keys()].filter(value => value !== legacyRelease);
        const boundedReleases = [...new Set([legacyRelease, candidates[0]!, candidates.at(-2), ...liveReleases].filter((value): value is string => !!value))];
        const allowedCaches = boundedReleases.map(value => `poker-banker-${value}`);
        for (const entry of original.entries) allowed.set(entry.url, entry.bytes);
        for (const live of boundedReleases) for (const asset of inventories.get(live) ?? []) {
          const key = new URL(asset.path, proxy.origin).href;
          allowed.set(key, Math.max(asset.bytes, allowed.get(key) ?? 0));
        }
        const obsoleteEntries = caches.flatMap(cache => cache.entries.filter(entry => entry.method !== 'GET' || !allowed.has(entry.url)).map(entry => ({ cache: cache.key, path: entry.path, bytes: entry.bytes })));
        const actualLegacy = caches.find(cache => cache.key === original.key)!;
        expect(actualLegacy).toBeTruthy();
        for (const entry of original.entries) expect(actualLegacy.entries.find(value => value.url === entry.url)).toEqual(entry);
        const allowedBodyBytes = [...allowed.values()].reduce((sum, bytes) => sum + bytes, 0) * allowedCaches.length;
        const allowedEntryCount = allowed.size * allowedCaches.length;
        const record = { release, phase, caches, totalEntries: caches.reduce((sum, cache) => sum + cache.entries.length, 0), totalBodyBytes: caches.reduce((sum, cache) => sum + cache.bodyBytes, 0), allowedRequestKeys: [...allowed.keys()].sort(), allowedCaches, allowedBodyBytes, allowedEntryCount, obsoleteEntries };
        records.push(record);
        return record;
      };
      try {
        for (const letter of ['A', 'B', 'C', 'D', 'E', 'F']) {
          const release = `r40-R2-${letter}-${id}`;
          const built = await build(release);
          inventories.set(release, built.assets);
          const candidate = await state.context.newPage();
          await candidate.goto(`/?session=${state.session}`);
          await expect(candidate.locator('meta[name="pb-release"]')).toHaveAttribute('content', release);
          await expect.poll(() => candidateRelease(candidate), { timeout: 25000 }).toBe(release);
          await candidate.waitForTimeout(1800);
          await expect(state.page.getByTestId('money-amount')).toHaveValue('61.');
          await snapshot(release, 'candidate-open-after-install', [release]);
          await candidate.close();
          await state.page.waitForTimeout(1200);
          await snapshot(release, 'candidate-closed-awaiting-next-worker-check', [release]);
        }
        const release = `r40-R2-G-${id}`;
        const built = await build(release);
        inventories.set(release, built.assets);
        const finalCandidate = await state.context.newPage();
        await finalCandidate.goto(`/?session=${state.session}`);
        await expect.poll(() => candidateRelease(finalCandidate), { timeout: 25000 }).toBe(release);
        await finalCandidate.waitForTimeout(1800);
        const final = await snapshot(release, 'next-install-cleans-closed-candidates', [release]);
        await finalCandidate.close();
        const obsoleteGrowth = final.obsoleteEntries.length > 0;
        if (mode === 'fixed') {
          expect(final.obsoleteEntries).toEqual([]);
          expect(final.totalBodyBytes).toBeLessThanOrEqual(final.allowedBodyBytes);
          const sameWorkingSet = records.filter(record => record.phase === 'candidate-open-after-install').slice(2);
          for (const record of [...sameWorkingSet, final]) {
            expect(record.caches.every(cache => record.allowedCaches.includes(cache.key))).toBe(true);
            for (const cache of record.caches) {
              expect(cache.entries.length).toBeLessThanOrEqual(record.allowedRequestKeys.length);
              expect(cache.bodyBytes).toBeLessThanOrEqual(record.allowedBodyBytes / record.allowedCaches.length);
            }
            expect(record.totalEntries).toBeLessThanOrEqual(record.allowedEntryCount);
            expect(record.totalBodyBytes).toBeLessThanOrEqual(record.allowedBodyBytes);
            expect(record.obsoleteEntries).toEqual([]);
          }
        }
        const retainedAsset = await state.page.evaluate(async ({ key, path }) => {
          const response = await (await caches.open(key)).match(path);
          if (!response) throw new Error('First legacy asset was removed');
          const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
          return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        }, { key: original.key, path: firstAsset.path });
        expect(retainedAsset).toBe(firstAsset.sha256);
        await capture(state.page, evidence, 'R2-legacy-still-editing-after-seven-candidates');
        return { case: 'R2-unknown-client-cache-bound', regressionObserved: obsoleteGrowth, legacySource: liveLegacySourceSha, legacyRelease, initial, snapshots: records, releaseInventories: Object.fromEntries(inventories), workingSetRule: 'Immutable original legacy inventory, first-observed candidate fallback, prior waiting worker and current installed candidate; closed intermediate candidate assets must be removed across every retained cache by the following install. Entry and byte ceilings derive from this finite working set, including cross-cache copies.', firstLegacyAsset: firstAsset, firstLegacyAssetFinalSha256: retainedAsset, originalRootHtml: rootHtml, originalHtmlAssetsRetained: true, legacyDocument: await state.page.locator('meta[name="pb-release"]').getAttribute('content'), permanentNonresponse: 'Unmodified 30209c1 client has no CLIENT_RELEASE_REQUEST listener; same live document across all candidates' };
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
      await visible(state.page, false);
      const queryType = `PB_PROOF_OBSERVE_${id}_R3`;
      const observedBuild = await build(b, false, { workerObservation: { queryType } });
      await lifecycle(editor);
      await expect.poll(() => candidateRelease(editor), { timeout: 25000 }).toBe(b);
      await expect.poll(() => editor.evaluate(async () => (await navigator.serviceWorker.getRegistration('/'))?.waiting?.state)).toBe('installed');
      expect((await current(editor, state.session)).session.started_at).toBeNull();
      const beforePost = await observeWorker(editor, queryType, 'waiting');
      expect(beforePost.fetches).toEqual([]);
      expect(beforePost.activations).toEqual([]);
      const gate = proxy.hold({ path: `/api/sessions/${state.session}/start`, method: 'POST', phase: 'body' });
      let timerReloads = 0;
      state.page.on('request', request => { if (request.isNavigationRequest() && request.frame() === state.page.mainFrame()) timerReloads++; });
      try {
        await state.page.getByRole('button', { name: 'Start timer', exact: true }).click();
        await expect.poll(() => gate.records.filter(record => record.upstreamFinishedAt).length).toBe(1);
        expect(gate.records[0]!.status).toBe(200);
        expect((await current(editor, state.session)).session.started_at).not.toBeNull();
        await lifecycle(state.page);
        await expect.poll(async () => (await observeWorker(editor, queryType, 'waiting')).activations.length).toBeGreaterThan(0);
        await state.page.waitForTimeout(4200);
        const duringHeldPost = await observeWorker(editor, queryType, 'waiting');
        expect(duringHeldPost.instanceId).toBe(beforePost.instanceId);
        expect(duringHeldPost.fetches).toEqual([]);
        expect(duringHeldPost.activations.length).toBeGreaterThan(0);
        expect(gate.records[0]!.releasedAt).toBeUndefined();
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
        const positivePath = `/manifest.webmanifest?pb-proof=${id}`;
        const positiveStatus = await cold.evaluate(async path => (await fetch(path, { cache: 'no-store' })).status, positivePath);
        expect(positiveStatus).toBe(200);
        const afterColdPositiveControl = await observeWorker(cold, queryType, 'active');
        expect(afterColdPositiveControl.fetches.some(event => event.method === 'GET' && event.path === '/manifest.webmanifest' && event.clientId.length > 0)).toBe(true);
        await restoredDraft(cold, state.player, '43.', 'Zelle');
        await capture(cold, evidence, 'R3-cold-B-restores-302-draft-and-replays-outbox');
        return { case: 'R3-live-production-client', regressionObserved: prematureReloads > 0, legacySource: liveLegacySourceSha, before: legacyRelease, after: b, prematureReloads, realPost: gate.records[0], timerCommittedBeforeGateRelease: true, observedBuild, dispatchObservation: { beforePost, duringHeldPost, afterColdPositiveControl, heldObservationMs: 4200, genuineStartDispatchedAfterBInstalled: true, positivePath, positiveStatus }, quietActivationCounterexample: 'A fully installed waiting B receives legacy ACTIVATE messages while the real committed Start response remains withheld for over 3500ms, yet B receives zero fetch events; a zero waiting-worker request counter cannot establish legacy request quiescence. Removing clients.claim does not avoid controllerchange for already controlled clients: the Service Workers Activate algorithm changes their active worker before dispatching activate.', activationAlgorithm: 'https://www.w3.org/TR/service-workers/#activation-algorithm', activationConstraint: 'New worker waits until every unmodified legacy document closes; no hot-upgrade safety claim for the old client', draftBeforeSha256: sha(durable), draftAfterSha256: sha(after.drafts.find(row => row.key === durable.key)), outboxBodySha256: sha(queued.body), outgoingBodiesSha256: outgoing.map(sha), idbVersion: after.version, bankerId: banker, sessionId: state.session };
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
        const htmlResponse = [...proxy.records].reverse().find(record => record.status === 200 && record.contentType?.includes('text/html') && new URL(record.path, proxy.origin).searchParams.get('session') === state.session && record.decodedBodySha256 === shaHtml(htmlB));
        expect(htmlResponse?.decodedBodySha256).toBe(shaHtml(htmlB));
        expect(htmlResponse?.bodyDecodingError).toBeUndefined();
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
        const result: ReviewRow = { case: 'R4-initial-html-bundle-skew', regressionObserved: finalDocument === b && !started, before: a, deliveredHtml: b, deployedBeforeModuleFetch: c, initialModule: entryB, initialModuleActualHttpStatus: 404, deliveredHtmlSha256: htmlResponse?.decodedBodySha256, moduleForwardedAfterDeployment: gate.records[0], finalDocument, appStarted: started };
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
    await run('R5-slow-successful-initial-entry', async () => {
      const b = `r40-R5-B-${id}`;
      const built = await build(b);
      const html = await readFile('dist/index.html', 'utf8');
      const entry = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
      if (!entry?.startsWith('/assets/')) throw new Error('Slow startup must hold the actual emitted initial module');
      const context = await fresh();
      const next = await context.newPage();
      const navigations: { url: string; at: number }[] = [];
      const pageErrors: string[] = [];
      const failedRequests: { path: string; error: string | null }[] = [];
      next.on('request', request => { if (request.isNavigationRequest() && request.frame() === next.mainFrame()) navigations.push({ url: request.url(), at: Date.now() }); });
      next.on('pageerror', error => pageErrors.push(error.message));
      next.on('requestfailed', request => failedRequests.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText ?? null }));
      const gate = proxy.hold({ path: entry, method: 'GET', phase: 'request' });
      try {
        await next.goto('/?review-slow-entry=1', { waitUntil: 'commit' });
        await expect.poll(() => gate.records.length).toBeGreaterThan(0);
        await expect(next.locator('meta[name="pb-release"]')).toHaveAttribute('content', b);
        expect(await next.evaluate(async () => ({ controller: !!navigator.serviceWorker.controller, registered: !!await navigator.serviceWorker.getRegistration('/') }))).toEqual({ controller: false, registered: false });
        const pendingStartedAt = gate.records[0]!.startedAt;
        const remaining = 18000 - (Date.now() - pendingStartedAt);
        if (remaining > 0) await next.waitForTimeout(remaining);
        const heldForMs = Date.now() - pendingStartedAt;
        const beforeRelease = [...navigations];
        const pendingErrors = [...pageErrors];
        expect(heldForMs).toBeGreaterThanOrEqual(18000);
        expect(gate.records.every(record => record.upstreamFinishedAt === undefined)).toBe(true);
        if (mode === 'fixed') {
          expect(beforeRelease).toHaveLength(1);
          expect(pendingErrors).toEqual([]);
          expect(failedRequests).toEqual([]);
          await expect(next.locator('meta[name="pb-release"]')).toHaveAttribute('content', b);
        }
        gate.release();
        await workspaceReady(next);
        await workerReady(next);
        await releaseIs(next, b);
        await expect.poll(() => gate.records.filter(record => record.status === 200 && record.bodyBytes! > 0).length).toBeGreaterThan(0);
        await next.waitForTimeout(1200);
        if (mode === 'fixed') { expect(navigations).toHaveLength(1); expect(pageErrors).toEqual([]); expect(failedRequests).toEqual([]); }
        const moduleAsset = built.assets.find(asset => asset.path === entry)!;
        expect(gate.records.filter(record => record.status === 200).map(record => record.bodyDecodingError).filter(Boolean)).toEqual([]);
        expect(gate.records.some(record => record.status === 200 && record.decodedBodySha256 === moduleAsset.sha256 && record.decodedBodyBytes === moduleAsset.bytes)).toBe(true);
        await capture(next, evidence, 'R5-healthy-entry-started-after-eighteen-second-hold');
        return { case: 'R5-slow-successful-initial-entry', regressionObserved: beforeRelease.length > 1, release: b, initialModule: entry, moduleAsset, heldForMs, buildUnchangedThroughoutHold: true, freshContextWithoutWorkerAtHold: true, navigationsBeforeRelease: beforeRelease, navigationsAfterSuccess: navigations, errorsBeforeRelease: pendingErrors, pageErrors, failedRequests, actualModuleResponses: gate.records, finalController: await controllerRelease(next), finalDocument: await next.locator('meta[name="pb-release"]').getAttribute('content'), appStarted: true };
      } finally { gate.release(); await close(context); }
    });

    await run('R6-held-undo-response', async () => {
      const a = `r40-R6-A-${id}`, b = `r40-R6-B-${id}`;
      await build(a);
      const state = await seed(await fresh(), a, 'R6 Undo');
      const draftPlayer = await addPlayer(state.page, `R6 durable ${id}`);
      await draft(state.page, draftPlayer.id, '47.', 'Zelle');
      await keepMoneyDraft(state.page);
      const durable = (await databaseSnapshot(state.page)).drafts.find(row => row.value.amount === '47.')!;
      const saved = await money(state.page, state.player, '25', { method: 'venmo' });
      const originalBuyIn = saved.entries.find(entry => entry.player_id === state.player && entry.kind === 'buy_in' && !entry.voids_entry_id)!;
      const originalPayment = saved.entries.find(entry => entry.player_id === state.player && entry.kind === 'payment_in' && !entry.voids_entry_id)!;
      expect(originalBuyIn).toBeTruthy(); expect(originalPayment).toBeTruthy();
      expect((await databaseSnapshot(state.page)).outbox).toEqual([]);
      await expect(state.page.getByRole('dialog')).toHaveCount(0);
      const path = `/api/sessions/${state.session}/entries/${originalBuyIn.id}/undo`;
      const gate = proxy.hold({ path, method: 'POST', phase: 'body' });
      const navigations: { url: string; at: number }[] = [];
      state.page.on('request', request => { if (request.isNavigationRequest() && request.frame() === state.page.mainFrame()) navigations.push({ url: request.url(), at: Date.now() }); });
      const readerContext = await fresh();
      const reader = await readerContext.newPage();
      try {
        await state.page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect.poll(() => gate.records.filter(record => record.upstreamFinishedAt).length).toBe(1);
        expect(gate.records[0]!.status).toBe(200);
        await visible(state.page, false);
        await build(b);
        await reader.goto(`/?session=${state.session}`); await workspaceReady(reader);
        const committed = await current(reader, state.session);
        expect(committed.entries.filter(entry => entry.voids_entry_id === originalBuyIn.id)).toHaveLength(1);
        expect(committed.entries.filter(entry => entry.voids_entry_id === originalPayment.id)).toHaveLength(1);
        expect(committed.entries.filter(entry => entry.voids_entry_id)).toHaveLength(2);
        await lifecycle(state.page);
        await expect.poll(() => candidateRelease(state.page), { timeout: 25000 }).toBe(b);
        await state.page.waitForTimeout(4200);
        const beforeRelease = [...navigations];
        expect(gate.records[0]!.releasedAt).toBeUndefined();
        expect(beforeRelease).toEqual([]);
        await expect(state.page.locator('meta[name="pb-release"]')).toHaveAttribute('content', a);
        await expect(state.page.getByRole('dialog')).toHaveCount(0);
        expect((await databaseSnapshot(state.page)).outbox).toEqual([]);
        expect((await databaseSnapshot(state.page)).drafts.find(row => row.key === durable.key)).toEqual(durable);
        await expect(state.page.getByTestId('update-reload')).toBeDisabled();
        await capture(state.page, evidence, 'R6-closed-sheet-empty-outbox-undo-body-still-held');
        gate.release();
        await releaseIs(state.page, b);
        await workspaceReady(state.page);
        const after = await databaseSnapshot(state.page);
        expect(after.drafts.find(row => row.key === durable.key)).toEqual(durable);
        expect(after.outbox).toEqual([]);
        const confirmed = await current(reader, state.session);
        expect(confirmed.entries.filter(entry => entry.voids_entry_id === originalBuyIn.id)).toHaveLength(1);
        expect(confirmed.entries.filter(entry => entry.voids_entry_id === originalPayment.id)).toHaveLength(1);
        expect(confirmed.entries.filter(entry => entry.voids_entry_id)).toHaveLength(2);
        expect(gate.records).toHaveLength(1);
        expect((await call<{ banker: { id: string } }>(state.page, '/auth/me')).banker.id).toBe(banker);
        await restoredDraft(state.page, draftPlayer.id, '47.', 'Zelle');
        await capture(state.page, evidence, 'R6-B-restores-draft-after-one-paid-undo');
        return { case: 'R6-held-undo-response', regressionObserved: beforeRelease.length > 0, before: a, after: b, originalBuyInId: originalBuyIn.id, originalPaymentId: originalPayment.id, committedBeforeResponseRelease: true, ledgerAndPaymentVoidCounts: [1, 1], postCount: gate.records.length, actualUndoResponse: gate.records[0], observationMs: 4200, navigationsBeforeResponseRelease: beforeRelease, navigationsAfterSafePoint: navigations, closedSheetAndEmptyOutboxDuringHold: true, draftBeforeSha256: sha(durable), draftAfterSha256: sha(after.drafts.find(row => row.key === durable.key)), bankerId: banker, sessionId: state.session };
      } finally { gate.release(); await close(readerContext); await close(state.context); }
    });
    await run('R7-failed-install-cache-bound', async () => {
      const a = `r38-legacy-302-R7-A-${id}`, anchor = `r42-R7-anchor-${id}`, b = `r42-R7-B-${id}`;
      const builtA = await build(a, true);
      const state = await seed(await fresh(), a, 'R7 legacy');
      await draft(state.page, state.player, '61.');
      await visible(state.page, false);
      const initial = await cacheInventory(state.page);
      expect(initial.find(cache => cache.key === `poker-banker-${a}`)?.entries.length).toBeGreaterThan(0);
      const builtAnchor = await build(anchor);
      const anchorPage = await state.context.newPage();
      await anchorPage.goto(`/?session=${state.session}`);
      await workspaceReady(anchorPage);
      await expect.poll(() => candidateRelease(anchorPage), { timeout: 25000 }).toBe(anchor);
      await anchorPage.close();
      await state.page.waitForTimeout(1200);
      const afterAnchor = await cacheInventory(state.page);
      const original = afterAnchor.find(cache => cache.key === `poker-banker-${a}`)!;
      expect(original?.entries.length).toBeGreaterThan(0);
      const anchorPolicy = await cachePolicy(state.page);
      expect(anchorPolicy.inventories?.[original.key]?.slice().sort()).toEqual(original.entries.map(entry => entry.url).sort());
      const builtB = await build(b);
      const htmlB = await readFile('dist/index.html', 'utf8');
      const mainB = htmlB.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
      if (!mainB?.startsWith('/assets/')) throw new Error('Failed-install B requires its real initial module');
      const missing = builtB.assets.find(asset => /\/icon-(?:512|192)\.png$/.test(asset.path));
      if (!missing) throw new Error('Failed-install proof requires a normally emitted precached app icon');
      await rm(join('dist', missing.path.slice(1)));
      const editor = await state.context.newPage();
      await editor.addInitScript(() => {
        const observation = { identity: crypto.randomUUID(), states: [] as string[] };
        Object.defineProperty(window, '__pbFailedInstallProof', { value: observation });
        void navigator.serviceWorker.getRegistration('/').then(registration => {
          if (!registration) return;
          registration.addEventListener('updatefound', () => {
            const worker = registration.installing;
            if (!worker) return;
            observation.states.push(worker.state);
            worker.addEventListener('statechange', () => observation.states.push(worker.state));
          });
          const worker = registration.installing;
          if (worker) {
            observation.states.push(worker.state);
            worker.addEventListener('statechange', () => observation.states.push(worker.state));
          }
        });
      });
      const proofState = () => editor.evaluate(() => (window as unknown as { __pbFailedInstallProof: { identity: string; states: string[] } }).__pbFailedInstallProof);
      const editorNavigations: { url: string; at: number }[] = [];
      editor.on('request', request => { if (request.isNavigationRequest() && request.frame() === editor.mainFrame()) editorNavigations.push({ url: request.url(), at: Date.now() }); });
      const firstRequest = proxy.records.length;
      const inventories = new Map<string, ReleaseAsset[]>([[a, builtA.assets], [anchor, builtAnchor.assets], [b, builtB.assets]]);
      const snapshots: Record<string, unknown>[] = [];
      try {
        await editor.goto(`/?session=${state.session}`);
        await workspaceReady(editor);
        await expect(editor.locator('meta[name="pb-release"]')).toHaveAttribute('content', b);
        const player = await addPlayer(editor, `R7 B draft ${id}`);
        await draft(editor, player.id, '73.', 'Zelle');
        await visible(editor, false);
        await expect.poll(async () => (await proofState()).states.includes('redundant'), { timeout: 25000 }).toBe(true);
        await expect.poll(() => proxy.records.slice(firstRequest).some(record => new URL(record.path, proxy.origin).pathname === missing.path && record.status === 404)).toBe(true);
        await expect.poll(async () => (await cacheInventory(editor)).some(cache => cache.key === `poker-banker-${b}`)).toBe(false);
        expect(await candidateRelease(editor)).toBe(anchor);
        const failedInstall = await proofState();
        const durable = (await databaseSnapshot(editor)).drafts.find(row => row.value.amount === '73.')!;
        expect(durable).toBeTruthy();
        const afterFailedInstall = await cacheInventory(editor);
        const bAssets = afterFailedInstall.find(cache => cache.key === original.key)!.entries.filter(entry => builtB.assets.some(asset => asset.path === entry.path && asset.sha256 === entry.sha256) && entry.path.startsWith('/assets/'));
        expect(bAssets.some(entry => entry.path === mainB)).toBe(true);
        const policyAfterFailure = await cachePolicy(editor);
        await writeFile(join(evidence, 'R7-failed-install.json'), JSON.stringify({ failedInstall, policyAfterFailure, afterFailedInstall, missing, bAssets, draftSha256: sha(durable) }, null, 2));
        if (mode === 'fixed') expect(policyAfterFailure.manifests?.[b]?.slice().sort()).toEqual(builtB.assets.map(asset => asset.path).sort());
        const snapshot = async (release: string, phase: string, previous: string | undefined, bOpen = true) => {
          const caches = await cacheInventory(state.page);
          const policy = await cachePolicy(state.page);
          const boundedReleases = [...new Set([a, ...(bOpen ? [b] : []), anchor, previous, release].filter((value): value is string => !!value))];
          const allowedCaches = boundedReleases.filter(value => value !== b).map(value => `poker-banker-${value}`);
          const allowed = new Map<string, number>();
          for (const entry of original.entries) allowed.set(entry.url, entry.bytes);
          for (const live of boundedReleases) for (const asset of inventories.get(live) ?? []) {
            const key = new URL(asset.path, proxy.origin).href;
            allowed.set(key, Math.max(asset.bytes, allowed.get(key) ?? 0));
          }
          const obsoleteEntries = caches.flatMap(cache => cache.entries.filter(entry => entry.method !== 'GET' || !allowed.has(entry.url)).map(entry => ({ cache: cache.key, path: entry.path, bytes: entry.bytes })));
          const allowedBodyBytes = [...allowed.values()].reduce((sum, bytes) => sum + bytes, 0) * allowedCaches.length;
          const allowedEntryCount = allowed.size * allowedCaches.length;
          const totalBodyBytes = caches.reduce((sum, cache) => sum + cache.bodyBytes, 0);
          const totalEntries = caches.reduce((sum, cache) => sum + cache.entries.length, 0);
          expect(caches.some(cache => cache.key === `poker-banker-${b}`)).toBe(false);
          const legacy = caches.find(cache => cache.key === original.key)!;
          expect(legacy).toBeTruthy();
          for (const entry of original.entries) expect(legacy.entries.find(value => value.url === entry.url)).toEqual(entry);
          if (bOpen) {
            for (const entry of bAssets) expect(legacy.entries.find(value => value.url === entry.url)).toEqual(entry);
            await expect(editor.getByTestId('money-amount')).toHaveValue('73.');
            await expect(editor.locator('meta[name="pb-release"]')).toHaveAttribute('content', b);
            await expect(state.page.getByTestId('money-amount')).toHaveValue('61.');
            expect((await proofState()).identity).toBe(failedInstall.identity);
            expect(editorNavigations).toHaveLength(1);
            expect((await databaseSnapshot(editor)).drafts.find(row => row.key === durable.key)).toEqual(durable);
            if (mode === 'fixed') expect(policy.manifests?.[b]?.slice().sort()).toEqual(builtB.assets.map(asset => asset.path).sort());
          }
          const workers = await state.page.evaluate(async () => {
            const registration = await navigator.serviceWorker.getRegistration('/');
            return Promise.all((['active', 'waiting', 'installing'] as const).map(async role => {
              const worker = registration?.[role];
              if (!worker) return { role, release: null, state: null };
              const release = await new Promise<string | null>(accept => {
                const channel = new MessageChannel();
                const timer = setTimeout(() => { channel.port1.close(); accept(null); }, 1500);
                channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); accept(event.data.version); };
                worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
              });
              return { role, release, state: worker.state };
            }));
          });
          const record = { release, phase, caches, policy, workers, bDocumentOpen: bOpen, bManifestPresent: !!policy.manifests?.[b], bCacheAbsent: true, boundedReleases, allowedCaches, allowedRequestKeys: [...allowed.keys()].sort(), allowedBodyBytes, allowedEntryCount, totalBodyBytes, totalEntries, obsoleteEntries, bDraftSha256: bOpen ? sha(durable) : null, bDocumentIdentity: bOpen ? failedInstall.identity : null };
          snapshots.push(record);
          await writeFile(join(evidence, 'R7-cache-snapshots.json'), JSON.stringify({ initial, afterAnchor, anchorPolicy, snapshots, releaseInventories: Object.fromEntries(inventories) }, null, 2));
          if (mode === 'fixed') {
            expect(caches.every(cache => allowedCaches.includes(cache.key))).toBe(true);
            expect(obsoleteEntries).toEqual([]);
            expect(totalBodyBytes).toBeLessThanOrEqual(allowedBodyBytes);
            expect(totalEntries).toBeLessThanOrEqual(allowedEntryCount);
            for (const cache of caches) {
              expect(cache.entries.length).toBeLessThanOrEqual(allowed.size);
              expect(cache.bodyBytes).toBeLessThanOrEqual(allowedBodyBytes / allowedCaches.length);
            }
          }
          return record;
        };
        let previous: string | undefined = anchor;
        for (const letter of ['C', 'D', 'E', 'F', 'G', 'H', 'I']) {
          const release = `r42-R7-${letter}-${id}`;
          const built = await build(release);
          inventories.set(release, built.assets);
          const candidate = await state.context.newPage();
          await candidate.goto(`/?session=${state.session}`);
          await workspaceReady(candidate);
          await expect(candidate.locator('meta[name="pb-release"]')).toHaveAttribute('content', release);
          await expect.poll(() => candidateRelease(candidate), { timeout: 25000 }).toBe(release);
          await candidate.waitForTimeout(1800);
          await snapshot(release, 'candidate-installed-B-document-still-editing', previous);
          await candidate.close();
          await state.page.waitForTimeout(1200);
          await snapshot(release, 'candidate-closed-B-document-still-editing', previous);
          previous = release;
        }
        const finalLive = snapshots.at(-1)!;
        const direct = await state.context.request.get(`${proxy.origin}${mainB}`);
        expect(direct.status()).toBe(404);
        const protectedBAsset = await editor.evaluate(async path => {
          const response = await fetch(path, { cache: 'no-store' });
          const body = await response.arrayBuffer();
          const digest = await crypto.subtle.digest('SHA-256', body);
          return { status: response.status, bytes: body.byteLength, sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
        }, mainB);
        const originalBMain = bAssets.find(entry => entry.path === mainB)!;
        expect(protectedBAsset).toEqual({ status: 200, bytes: originalBMain.bytes, sha256: originalBMain.sha256 });
        await capture(editor, evidence, 'R7-failed-install-B-still-editing-after-seven-deployments');
        const beforeClose = { document: await editor.locator('meta[name="pb-release"]').getAttribute('content'), controller: await controllerRelease(editor), proof: await proofState(), draftSha256: sha((await databaseSnapshot(editor)).drafts.find(row => row.key === durable.key)), navigations: [...editorNavigations] };
        await editor.close();
        const j = `r42-R7-J-${id}`;
        inventories.set(j, (await build(j)).assets);
        const cleanup = await state.context.newPage();
        await cleanup.goto(`/?session=${state.session}`); await workspaceReady(cleanup);
        await expect.poll(() => candidateRelease(cleanup), { timeout: 25000 }).toBe(j);
        await cleanup.waitForTimeout(1800);
        const afterClose = await snapshot(j, 'B-closed-next-install-collects-manifest-and-extra-assets', previous, false);
        expect(afterClose.policy.manifests?.[b]).toBeUndefined();
        const bOnlyPaths = bAssets.map(entry => entry.path).filter(path => !afterClose.allowedRequestKeys.includes(new URL(path, proxy.origin).href));
        expect(bOnlyPaths).toContain(mainB);
        expect(afterClose.caches.flatMap(cache => cache.entries).filter(entry => bOnlyPaths.includes(entry.path))).toEqual([]);
        expect((await databaseSnapshot(cleanup)).drafts.find(row => row.key === durable.key)).toEqual(durable);
        const collectedAfterBClose = { caches: afterClose.caches, policy: afterClose.policy };
        return { case: 'R7-failed-install-cache-bound', regressionObserved: (finalLive.obsoleteEntries as unknown[]).length > 0, legacySource: liveLegacySourceSha, baselineSource: mode === 'baseline' ? reviewBaselineSourceSha : null, legacyRelease: a, anchorRelease: anchor, failedRelease: b, missingActualEmittedAsset: missing, failedInstall, policyAfterFailure, afterFailedInstall, initial, afterAnchor, anchorPolicy, originalLegacyInventory: original, preservedBMainAssets: bAssets, bDraftBeforeSha256: sha(durable), snapshots, beforeClose, directBMainHttpStatusAfterSupersession: direct.status(), protectedBAsset, releaseInventories: Object.fromEntries(inventories), collectedAfterBClose, missingAssetActual404s: proxy.records.slice(firstRequest).filter(record => new URL(record.path, proxy.origin).pathname === missing.path && record.status === 404), workingSetRule: 'Successful anchor installation records the immutable legacy A inventory before B loads, including finite anchor contamination. The live failed-install B manifest, anchor fallback, previous waiting worker and current candidate then bound at most five release inventories and four actual caches independently of deployment count. B cache never exists and B is never reinstalled. Closing B collects its manifest and unique main assets while legacy A stays open; activation remains covered by the separate legacy case.', legacyNonresponse: 'Unmodified 30209c1 A document remains open through J without a CLIENT_RELEASE_REQUEST listener.' };
      } finally { await close(state.context); }
    });
    const result = { mode, rows, errors, builds, origin: proxy.origin, upstream: baseURL, bankerId: banker, actualForwarding: true, limitations: ['Loopback TLS, owned PostgreSQL and real HTTP bodies; no production writes.', 'Desktop/phone browser emulation does not prove physical iOS suspension or Home Screen behavior.', 'Legacy activation is explicitly deferred until all legacy documents close.'] };
    await writeFile(join(evidence, 'review-cases-summary.json'), JSON.stringify(result, null, 2));
    if (errors.length) {
      const details = errors.map(error => `${error.case}: ${error.error}`).join('\n\n');
      process.stderr.write(`Update review proof failed\n${details}\n`);
      throw new AggregateError(errors.map(error => new Error(`${error.case}: ${error.error}`)), `Update review proof failed in ${errors.map(error => error.case).join(', ')}\n\n${details}`);
    }
    return result;
  });
}
