import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test';
import { addPlayer, call, current, keepMoneyDraft, newContextLike, newSession, openMoney, workerReady, workspaceReady } from '../e2e/helpers';
import { typeInput } from '../e2e/input';
import type { OutboxItem } from '../src/client/data';
import { ownedMain } from './owned-command';
import { buildPreviousUpdateRelease, buildUpdateRelease } from './update-release';

type Draft = { key: string; banker_id: string; value: Record<string, unknown>; updated_at: number };
type Snapshot = { version: number; drafts: Draft[]; outbox: OutboxItem[]; snapshots: unknown[] };
type Seed = { context: BrowserContext; page: Page; session: string; name: string; player: string };
export type UpdateJourneyOptions = { page: Page; browser: Browser; baseURL: string; evidence: string; tag?: string };
export type UpdateCase = { case: string; before: string; after: string; bankerId: string; sessionId: string; [key: string]: unknown };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');

async function databaseSnapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const opening = indexedDB.open('poker-banker');
    const db = await new Promise<IDBDatabase>((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
    try {
      const [drafts, outbox, snapshots] = await Promise.all(['drafts', 'outbox', 'snapshots'].map(name => new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction(name, 'readonly').objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      })));
      return { version: db.version, drafts, outbox, snapshots };
    } finally { db.close(); }
  }) as Promise<Snapshot>;
}

async function controllerRelease(page: Page) {
  return page.evaluate(async () => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) return null;
    return new Promise<string>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); reject(new Error('Worker version reply timed out')); }, 5000);
      channel.port1.onmessage = event => { clearTimeout(timeout); channel.port1.close(); resolve(event.data.version); };
      controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    });
  });
}

async function releaseIs(page: Page, release: string, timeout = 25000) {
  await expect(page.locator('meta[name="pb-release"]')).toHaveAttribute('content', release, { timeout });
  await expect.poll(async () => {
    try { return await controllerRelease(page); } catch (error) {
      if (error instanceof Error && /Execution context was destroyed/.test(error.message)) return null;
      throw error;
    }
  }, { timeout }).toBe(release);
}

async function visible(page: Page, value: boolean) {
  await page.evaluate(value => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: value ? 'visible' : 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: !value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}

async function draft(page: Page, player: string, amount: string, method: 'Cash' | 'Venmo' | 'Zelle' = 'Venmo') {
  await openMoney(page, player);
  await typeInput(page.getByTestId('money-amount'), amount);
  await page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: method, exact: true }).click();
  await expect.poll(async () => (await databaseSnapshot(page)).drafts.some(row => row.value.amount === amount && row.value.method === method.toLowerCase())).toBe(true);
}

async function restoredDraft(page: Page, player: string, amount: string, method: 'Venmo' | 'Zelle' = 'Venmo') {
  await openMoney(page, player);
  await expect(page.getByTestId('money-amount')).toHaveValue(amount);
  await expect(page.getByRole('group', { name: 'Payment method', exact: true }).getByRole('button', { name: method, exact: true })).toHaveAttribute('aria-pressed', 'true');
}

async function capture(page: Page, evidence: string, name: string) {
  await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
  await writeFile(join(evidence, `${name}.aria.txt`), await page.locator('body').ariaSnapshot());
  const landmarks = await page.evaluate(() => [...document.querySelectorAll('main, nav, [role="dialog"], h1, h2')]
    .filter(element => element.getClientRects().length).map(element => ({ tag: element.tagName, role: element.getAttribute('role'), name: element.getAttribute('aria-label'), text: element.textContent?.trim().slice(0, 160) })));
  await writeFile(join(evidence, `${name}.landmarks.json`), JSON.stringify(landmarks, null, 2));
}

async function sameAccount(page: Page, banker: string) {
  const account = await call<{ banker: { id: string } }>(page, '/auth/me');
  expect(account.banker.id).toBe(banker);
  return account.banker.id;
}

export async function verifyUpdateJourney({ page, browser, baseURL, evidence, tag }: UpdateJourneyOptions) {
  const target = new URL(baseURL);
  if (target.protocol !== 'https:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Update journey requires the owned loopback HTTPS server');
  if (new URL(page.url()).origin !== target.origin) throw new Error('The signed-in page must belong to the intended loopback server');
  const artifactRoot = resolve(evidence);
  if (!['evidence', 'test-results', '.cache'].some(root => artifactRoot.startsWith(`${resolve(root)}/`))) throw new Error('Update proof evidence must stay in an ignored checkout directory');
  return ownedMain(async owner => {
    await mkdir('.cache', { recursive: true });
    const lock = resolve('.cache/update-journey.lock');
    await mkdir(lock).catch(() => { throw new Error('Another update journey owns this checkout; serialize all builds and local verification'); });
    owner.addCleanup('Update journey exclusive build scope', 'cleanup', () => rm(lock, { recursive: true, force: true }));
    await mkdir(artifactRoot, { recursive: true });
    const contexts: BrowserContext[] = [];
    owner.addCleanup('Update journey browser contexts', 'cleanup', async () => {
      const results = await Promise.allSettled(contexts.map(context => context.close()));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Update proof context cleanup failed');
    });
    const id = `${(tag ?? 'update').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 24)}-${randomUUID().slice(0, 8)}`;
    const releaseLegacy = `r36-previous-${id}`, releaseA = `r36-A-${id}`, releaseB = `r36-B-${id}`;
    const banker = (await call<{ banker: { id: string } }>(page, '/auth/me')).banker.id;
    const cookies = (await page.context().cookies(baseURL)).filter(cookie => cookie.name === 'pb_session');
    expect(cookies).toHaveLength(1);
    const fresh = async () => {
      const context = await newContextLike(page, browser, baseURL);
      contexts.push(context);
      await context.addCookies(cookies);
      return context;
    };
    const seed = async (label: string, release: string): Promise<Seed> => {
      const context = await fresh();
      const next = await context.newPage();
      await next.goto('/'); await workspaceReady(next);
      const name = `Update ${label} ${id}`;
      const state = await newSession(next, name);
      const player = await addPlayer(next, `${label} ${id}`);
      await workerReady(next); await releaseIs(next, release);
      await sameAccount(next, banker);
      return { context, page: next, session: state.session.id, name, player: player.id };
    };
    const table: UpdateCase[] = [];
    const report = async (fixture: Seed, name: string, extra: Record<string, unknown> = {}) => {
      await expect(fixture.page.getByRole('heading', { name: fixture.name, exact: true })).toBeVisible();
      const bankerId = await sameAccount(fixture.page, banker);
      const snapshot = await databaseSnapshot(fixture.page);
      expect(snapshot.version).toBe(2);
      table.push({ case: name, before: releaseA, after: releaseB, bankerId, sessionId: fixture.session, idbVersion: snapshot.version, ...extra });
      await capture(fixture.page, artifactRoot, `${name}-result`);
    };
    let compatibility: Record<string, unknown> | undefined;
    try {
      const previousBuild = await buildPreviousUpdateRelease(owner, releaseLegacy);
      const legacy = await seed('previous-client', releaseLegacy);
      await draft(legacy.page, legacy.player, '31.', 'Zelle');
      await keepMoneyDraft(legacy.page);
      const durable = (await databaseSnapshot(legacy.page)).drafts.find(row => row.value.amount === '31.')!;
      const queuePlayer = await addPlayer(legacy.page, `Previous queued ${id}`);
      await legacy.context.setOffline(true);
      await draft(legacy.page, queuePlayer.id, '23', 'Venmo');
      await legacy.page.getByRole('button', { name: 'Save entry', exact: true }).click();
      await expect(legacy.page.getByText('Not saved yet', { exact: true }).first()).toBeVisible();
      const old = await databaseSnapshot(legacy.page);
      expect(old.version).toBe(2); expect(old.outbox).toHaveLength(1);
      const queued = old.outbox[0]!;
      await capture(legacy.page, artifactRoot, 'previous-client-offline-records');
      await legacy.page.close();
      const builtA = await buildUpdateRelease(owner, releaseA, previousBuild.previousDataPath);
      const requests: Record<string, unknown>[] = [];
      const observe = (request: Request) => {
        if (request.url() === `${baseURL}/api/sessions/${legacy.session}/entries` && request.method() === 'POST') requests.push(request.postDataJSON() as Record<string, unknown>);
      };
      legacy.context.on('request', observe);
      await legacy.context.setOffline(false);
      legacy.page = await legacy.context.newPage();
      await legacy.page.goto(`/?session=${legacy.session}`);
      await releaseIs(legacy.page, releaseA);
      await expect(legacy.page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
      await expect.poll(() => requests.length).toBeGreaterThan(0);
      const afterLegacy = await databaseSnapshot(legacy.page);
      expect(afterLegacy.version).toBe(2); expect(afterLegacy.outbox).toHaveLength(0);
      expect(afterLegacy.drafts.find(row => row.key === durable.key)).toEqual(durable);
      expect(requests.every(body => hash(body) === hash(queued.body))).toBe(true);
      const confirmed = await current(legacy.page, legacy.session);
      expect(confirmed.entries.filter(entry => entry.player_id === queuePlayer.id && entry.kind === 'buy_in' && entry.amount_minor === '2300')).toHaveLength(1);
      expect(confirmed.entries.filter(entry => entry.player_id === queuePlayer.id && entry.kind === 'payment_in' && entry.amount_minor === '2300' && entry.method === 'venmo')).toHaveLength(1);
      const replay = await legacy.page.request.post(`${baseURL}${queued.path}`, { headers: { origin: baseURL }, data: queued.body });
      expect(replay.status()).toBe(200);
      const replayed = await current(legacy.page, legacy.session);
      expect(replayed.revision).toBe(confirmed.revision); expect(replayed.entries).toEqual(confirmed.entries);
      await restoredDraft(legacy.page, legacy.player, '31.', 'Zelle');
      await sameAccount(legacy.page, banker);
      compatibility = { previousSource: previousBuild.sourceSha, previousArchiveSha256: previousBuild.archiveSha256, previousManifestSha256: previousBuild.manifestSha256, before: releaseLegacy, after: releaseA, bankerId: banker, sessionId: legacy.session,
        idbVersionBefore: old.version, idbVersionAfter: afterLegacy.version, draftBeforeSha256: hash(durable), draftAfterSha256: hash(afterLegacy.drafts.find(row => row.key === durable.key)),
        previousOutboxBody: queued.body, opId: queued.op_id, outgoingBodies: requests, bodyBeforeSha256: hash(queued.body), bodyAfterSha256: hash(requests[0]), serverEntryCount: 1, revisionAfterFirstReplay: confirmed.revision, revisionAfterIdempotentReplay: replayed.revision };
      await capture(legacy.page, artifactRoot, 'previous-client-current-draft-and-replay');
      legacy.context.off('request', observe);
      await legacy.context.close();

      const idle = await seed('idle', releaseA); await visible(idle.page, false);
      const typed = await seed('typed-sheet', releaseA); await draft(typed.page, typed.player, '37.'); await visible(typed.page, false);
      const offline = await seed('offline', releaseA);
      const reversePlayer = await addPlayer(offline.page, `Current draft ${id}`);
      await offline.context.setOffline(true);
      await draft(offline.page, offline.player, '20', 'Zelle');
      await offline.page.getByRole('button', { name: 'Save entry', exact: true }).click();
      await expect(offline.page.getByText('Not saved yet', { exact: true }).first()).toBeVisible();
      await draft(offline.page, reversePlayer.id, '7.50', 'Cash'); await keepMoneyDraft(offline.page);
      const currentRecords = await databaseSnapshot(offline.page);
      expect(currentRecords.version).toBe(2);
      const pending = currentRecords.outbox; expect(pending).toHaveLength(1);
      const currentDraft = currentRecords.drafts.find(row => row.value.amount === '7.50')!;
      if (!builtA.previousReader) throw new Error('A must precache the actual previous-source reader');
      const previousRead = await offline.page.evaluate(async ({ path, key, banker }) => {
        const reader = await import(/* @vite-ignore */ path) as { readDraft(key: string): Promise<unknown>; listOutbox(banker: string): Promise<unknown[]> };
        return { draft: await reader.readDraft(key), outbox: await reader.listOutbox(banker) };
      }, { path: builtA.previousReader, key: currentDraft.key, banker });
      expect(previousRead.draft).toEqual(currentDraft.value); expect(previousRead.outbox).toEqual(pending);
      const recordsAfterPreviousRead = await databaseSnapshot(offline.page);
      expect(recordsAfterPreviousRead.version).toBe(2); expect(hash(recordsAfterPreviousRead)).toBe(hash(currentRecords));
      compatibility.currentRecordsReadByPrevious = { readerSource: previousBuild.sourceSha, readerChunk: builtA.previousReader, writerRelease: releaseA, idbVersion: currentRecords.version,
        draftValue: previousRead.draft, draftBeforeSha256: hash(currentDraft.value), draftReadSha256: hash(previousRead.draft), outboxOpId: pending[0]!.op_id,
        outboxBeforeSha256: hash(pending), outboxReadSha256: hash(previousRead.outbox), idbBeforeSha256: hash(currentRecords), idbAfterSha256: hash(recordsAfterPreviousRead) };
      await capture(offline.page, artifactRoot, 'current-records-read-by-previous-client');
      const multi = await seed('two-tabs', releaseA); await draft(multi.page, multi.player, '41.'); await visible(multi.page, true);
      const other = await multi.context.newPage(); await other.goto(`/?session=${multi.session}`);
      await releaseIs(other, releaseA); await visible(other, false);
      const cold = await seed('closed-client', releaseA); await draft(cold.page, cold.player, '53.', 'Zelle'); await keepMoneyDraft(cold.page);
      const coldBefore = (await databaseSnapshot(cold.page)).drafts.find(row => row.value.amount === '53.')!;
      await capture(cold.page, artifactRoot, 'closed-client-before'); await cold.page.close();
      await capture(typed.page, artifactRoot, 'typed-sheet-before');
      await capture(offline.page, artifactRoot, 'offline-queue-before');
      await capture(multi.page, artifactRoot, 'two-tabs-held-before');
      await visible(idle.page, true);
      expect(await multi.page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.waiting)).toBe(false);
      await buildUpdateRelease(owner, releaseB);
      const deployedAt = Date.now();
      expect((await multi.page.request.get(`${baseURL}${builtA.discoveryProbe}`)).status()).toBe(404);
      const beforeChunkDiscovery = await multi.page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/');
        return { ageMs: performance.now(), visible: document.visibilityState, waiting: !!registration?.waiting, installing: !!registration?.installing };
      });
      expect(beforeChunkDiscovery.ageMs).toBeLessThan(60000); expect(beforeChunkDiscovery.visible).toBe('visible');
      expect(beforeChunkDiscovery.waiting).toBe(false); expect(beforeChunkDiscovery.installing).toBe(false);
      const discoveryImportedRelease = await multi.page.evaluate(async path => (await import(/* @vite-ignore */ path) as { release: string }).release, builtA.discoveryProbe);
      expect(discoveryImportedRelease).toBe(releaseA);
      await expect.poll(() => multi.page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.waiting)).toBe(true);
      await expect(multi.page.getByText('Update ready', { exact: true })).toBeVisible();
      await releaseIs(multi.page, releaseA);
      const discoveryObservedAgeMs = await multi.page.evaluate(() => performance.now());
      expect(discoveryObservedAgeMs).toBeLessThan(60000);
      await capture(multi.page, artifactRoot, 'two-tabs-chunk-triggered-b-discovery');
      await releaseIs(idle.page, releaseB, 85000);
      const adoptedAfterMs = Date.now() - deployedAt;
      if (Date.now() - deployedAt < 61000) await idle.page.waitForTimeout(61000 - (Date.now() - deployedAt));
      await report(idle, 'idle-visible', { adoptedAfterMs, idleObservationMs: Date.now() - deployedAt, discovery: 'real 60000ms runtime timer; no manual update or foreground signal after B' });

      await visible(typed.page, true);
      await expect(typed.page.getByText('Update ready', { exact: true })).toBeVisible();
      await expect.poll(() => typed.page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.waiting)).toBe(true);
      await expect(typed.page.locator('meta[name="pb-release"]')).toHaveAttribute('content', releaseA);
      await expect(typed.page.getByTestId('money-amount')).toHaveValue('37.');
      await typed.page.waitForTimeout(3200);
      await expect(typed.page.locator('meta[name="pb-release"]')).toHaveAttribute('content', releaseA);
      await expect(typed.page.getByTestId('money-amount')).toHaveValue('37.');
      await capture(typed.page, artifactRoot, 'typed-sheet-b-waiting');
      await keepMoneyDraft(typed.page); await releaseIs(typed.page, releaseB);
      await restoredDraft(typed.page, typed.player, '37.'); await report(typed, 'typed-sheet-safe-close', { amount: '37.', method: 'venmo', safePoint: 'Keep draft and close', observedOpenSheetHoldMs: 3200 });

      await offline.page.reload();
      await releaseIs(offline.page, releaseA);
      await expect(offline.page.getByText('Not saved yet', { exact: true }).first()).toBeVisible();
      await expect(offline.page.getByTestId('totals')).not.toContainText('$20.00');
      expect(hash((await databaseSnapshot(offline.page)).outbox[0]!.body)).toBe(hash(pending[0]!.body));
      await capture(offline.page, artifactRoot, 'offline-reload-cached-a');
      const delivered: Record<string, unknown>[] = [];
      offline.context.on('request', request => { if (request.url() === `${baseURL}${pending[0]!.path}` && request.method() === 'POST') delivered.push(request.postDataJSON() as Record<string, unknown>); });
      await offline.context.setOffline(false);
      await releaseIs(offline.page, releaseB);
      await expect(offline.page.getByText('Not saved yet', { exact: true })).toHaveCount(0);
      const saved = await current(offline.page, offline.session);
      expect(saved.entries.filter(entry => entry.player_id === offline.player && entry.kind === 'buy_in' && entry.amount_minor === '2000')).toHaveLength(1);
      expect(saved.entries.filter(entry => entry.player_id === offline.player && entry.kind === 'payment_in' && entry.amount_minor === '2000' && entry.method === 'zelle')).toHaveLength(1);
      expect(delivered.length).toBeGreaterThan(0); expect(delivered.every(body => hash(body) === hash(pending[0]!.body))).toBe(true);
      await report(offline, 'offline-reload-reconnect', { cachedOfflineRelease: releaseA, opId: pending[0]!.op_id, outboxBodySha256: hash(pending[0]!.body), outgoingBodiesSha256: delivered.map(hash), serverEntryCount: 1 });

      await visible(other, true); await releaseIs(other, releaseB);
      await expect.poll(() => controllerRelease(multi.page)).toBe(releaseB);
      await expect(multi.page.locator('meta[name="pb-release"]')).toHaveAttribute('content', releaseA);
      await expect(multi.page.getByTestId('money-amount')).toHaveValue('41.');
      await multi.page.waitForTimeout(3200);
      await expect(multi.page.locator('meta[name="pb-release"]')).toHaveAttribute('content', releaseA);
      await expect(multi.page.getByTestId('money-amount')).toHaveValue('41.');
      expect((await multi.page.request.get(`${baseURL}${builtA.probe}`)).status()).toBe(404);
      const retained = await multi.page.evaluate(async path => {
        const keys = await caches.keys();
        const pinned: string[] = [];
        for (const key of keys) if (await (await caches.open(key)).match(path)) pinned.push(key);
        const module = await import(/* @vite-ignore */ path) as { release: string };
        return { release: module.release, pinned };
      }, builtA.probe);
      expect(retained.release).toBe(releaseA); expect(retained.pinned).toContain(`poker-banker-${releaseA}`);
      await capture(multi.page, artifactRoot, 'two-tabs-active-b-old-a-module-import');
      await keepMoneyDraft(multi.page); await releaseIs(multi.page, releaseB);
      await restoredDraft(multi.page, multi.player, '41.');
      await report(multi, 'two-tabs-retained-old-chunk', { discoveryProbe: builtA.discoveryProbe, discoveryProbeHttpStatus: 404, discoveryImportedRelease, discoveryBefore: beforeChunkDiscovery, discoveryObservedAgeMs, discoveryReason: 'First cached dynamic import under A triggers real asset-access update discovery before the 60000ms timer; no post-deployment lifecycle signal', controllerWhileEditing: releaseB, documentWhileEditing: releaseA, observedOpenSheetHoldMs: 3200, probe: builtA.probe, probeHttpStatus: 404, actualImportedRelease: retained.release, retainedCaches: retained.pinned });

      cold.page = await cold.context.newPage();
      let coldNavigations = 0;
      cold.page.on('domcontentloaded', () => { coldNavigations++; });
      await cold.page.goto(`/?session=${cold.session}`);
      await expect.poll(() => coldNavigations).toBeGreaterThanOrEqual(2);
      await cold.page.waitForLoadState('domcontentloaded');
      await releaseIs(cold.page, releaseB);
      const coldAfter = (await databaseSnapshot(cold.page)).drafts.find(row => row.key === coldBefore.key);
      expect(coldAfter).toEqual(coldBefore);
      await restoredDraft(cold.page, cold.player, '53.', 'Zelle');
      await report(cold, 'closed-client-cold-start', { draftBeforeSha256: hash(coldBefore), draftAfterSha256: hash(coldAfter), amount: '53.', method: 'zelle', coldNavigations });
      const result = { table, compatibility, releaseA, releaseB, environment: { origin: target.origin, realTls: true, database: 'owned local PostgreSQL', browser: browser.browserType().name(), profile: await page.evaluate(() => ({ userAgent: navigator.userAgent, standalone: !!(navigator as Navigator & { standalone?: boolean }).standalone })) },
        limitations: ['Headless browser profile and standalone emulation; no physical iOS Home Screen installation or suspension proof.', 'Foreground cases emulate document visibility signals. Network, service workers, caches, UI writes and PostgreSQL responses are real.', 'Two build-only hashed lazy modules use the production precache: one first imports under A to trigger discovery; the other first imports under B to prove retained A cache compatibility.'] };
      await writeFile(join(artifactRoot, 'automatic-updates-summary.json'), JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      await writeFile(join(artifactRoot, 'automatic-updates-failure.json'), JSON.stringify({ table, compatibility, releaseA, releaseB, error: error instanceof Error ? error.message : String(error) }, null, 2));
      throw error;
    }
  });
}
