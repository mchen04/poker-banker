#!/usr/bin/env -S pnpm exec tsx
import { type ChildProcess } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { webkit, devices, expect, type Browser, type BrowserServer, type BrowserContext, type Page } from '@playwright/test';
import type { SessionState } from '../../../../src/domain/session';
import { createAccount, signIn, current, workspaceReady } from '../../../../e2e/helpers';
import { ledger } from './ledger';
import { createProcessOwner, spawnOwned, stopOwned, withShutdownDeadline, type ProcessOwner } from '../../../../scripts/owned-process';
import { ownedMain, runOwned } from '../../../../scripts/owned-command';

export type RecipeContext = {
  page: Page; context: BrowserContext; browser: Browser; baseURL: string;
  banker: { id: string; username: string }; runId: string; evidence: string;
  step: (name: string) => Promise<void>; checkState: () => Promise<SessionState>;
};
type Mode = 'iphone-webkit' | 'iphone-standalone' | 'desktop-webkit';
type Meta = { runId: string; pid: number; socket: string; evidence: string; baseURL: string; local: boolean; state: 'starting' | 'ready' | 'stopped'; release?: string; port?: number; listenerPid?: number };
type Command = { action: string; mode?: Mode; recipe?: string };
const root = process.cwd();
const args = process.argv.slice(2);
const action = args[0] ?? '';
const option = (name: string) => args[args.indexOf(name) + 1];
const id = action === 'launch' ? `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}` : action === '_daemon' ? args[1] : args.includes('--run') ? option('--run') : undefined;
if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Use launch --local or --live, then pass its --run ID to every command');
const runId = id;
const cache = resolve('.cache/verify');
const metadata = join(cache, `${runId}.json`);
const evidence = resolve('evidence/verify', runId);
const socket = resolve('.cache', `pbv-${runId.slice(-8)}.sock`);
async function json(path: string, value: unknown) { await writeFile(path, JSON.stringify(value, null, 2)); }
async function request(command: Command): Promise<unknown> {
  const client = createConnection(socket);
  const pending = new Promise((resolve, reject) => {
    let output = '';
    client.setTimeout(180000, () => client.destroy(new Error('Verification command exceeded 180 seconds')));
    client.on('connect', () => client.write(`${JSON.stringify(command)}\n`));
    client.on('data', chunk => { output += String(chunk); });
    client.on('error', reject);
    client.on('end', () => {
      try { const result = JSON.parse(output) as { error?: string; result: unknown }; if (result.error) reject(new Error(result.error)); else resolve(result.result); }
      catch (error) { reject(error); }
    });
  });
  return command.action === 'cleanup' ? pending.finally(() => client.destroy()) : pending;
}
async function files(directory: string): Promise<string[]> {
  const values = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(values.map(value => value.isDirectory() ? files(join(directory, value.name)) : [join(directory, value.name)]))).flat();
}
async function owned(meta: Pick<Meta, 'pid' | 'runId'>, parent?: ProcessOwner) {
  const owner = createProcessOwner({ parent });
  let command: string;
  try { command = (await runOwned(owner, 'sh', ['-c', 'ps -p "$1" -o command= || [ "$?" -eq 1 ]', 'pb-owned-lookup', String(meta.pid)])).trim(); }
  finally { await owner.stop(); }
  if (!command.includes('control.ts') || !command.includes(`_daemon ${meta.runId}`)) throw new Error('PID no longer belongs to this verification run; refusing to signal it');
  return command;
}
async function manifest() {
  const entries = [];
  for (const path of (await files(evidence)).filter(path => !path.endsWith('/manifest.json'))) {
    const content = await readFile(path);
    entries.push({ file: relative(evidence, path), bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
  await json(join(evidence, 'manifest.json'), entries);
  return { evidence, files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
}
async function daemon() {
  const local = args.includes('--local');
  const target = local ? '' : process.env.PB_BASE_URL;
  if (!local && (!target || new URL(target).protocol !== 'https:')) throw new Error('Live mode requires explicit PB_BASE_URL=https://...');
  const meta: Meta = { runId, pid: process.pid, socket, evidence, baseURL: target ? new URL(target).origin : '', local, state: 'starting' };
  const owner = createProcessOwner();
  let server: ReturnType<typeof createServer> | undefined;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { void cleanup().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); }); });
  owner.addCleanup('Verification socket removal', 'cleanup', () => rm(socket, { force: true }));
  owner.addCleanup('Verification listener close', 'pool', () => { server?.close(); });
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  let browserServer: BrowserServer | undefined;
  let user: Awaited<ReturnType<typeof createAccount>> | undefined;
  const pages = new Map<Mode, Page>();
  let busy = false;
  let cleanupTask: Promise<void> | undefined;
  let startupTask: Promise<void> | undefined;
  let stopping = false;
  owner.addCleanup('Verification browser server close', 'cleanup', () => browserServer?.close());
  owner.addCleanup('Verification browser close', 'cleanup', () => browser?.close());
  const starting = () => owner.checkpoint();
  const saveMeta = () => json(metadata, meta);
  function cleanup(): Promise<void> {
    stopping = true;
    cleanupTask ??= (async () => {
      const errors = new Set<string>();
      const settle = async (action: () => unknown | Promise<unknown>) => { try { await action(); } catch (error) { errors.add(String(error)); } };
      const bounded = (label: string, action: () => unknown | Promise<unknown>) => settle(() => withShutdownDeadline(label, action));
      await settle(() => owner.stop());
      if (!errors.size) meta.state = 'stopped';
      let proofFiles: number | null = null;
      await bounded('Verification evidence enumeration', async () => { proofFiles = (await files(evidence)).filter(path => path.endsWith('.png') || path.endsWith('-result.json')).length; });
      await bounded('Verification cleanup evidence', () => json(join(evidence, 'cleanup.json'), { runId, stopped: new Date().toISOString(), ownedDaemonPid: process.pid, ownedServerPid: child?.pid ?? null, evidenceFilesPreserved: proofFiles, errors: [...errors] }));
      await bounded('Verification evidence manifest', manifest);
      if (!errors.size) await bounded('Verification metadata removal', () => rm(metadata, { force: true }));
      if (errors.size) throw new Error(`Owned cleanup errors: ${[...errors].join('; ')}`);
    })();
    return cleanupTask;
  }
  async function contextPage(mode: Mode) {
    const existing = pages.get(mode); if (existing) return existing;
    if (!browser) throw new Error('Browser is not ready');
    const context = await browser.newContext({ ...(mode === 'desktop-webkit' ? { viewport: { width: 1440, height: 1000 } } : devices['iPhone 15']), baseURL: meta.baseURL, ignoreHTTPSErrors: local, locale: 'en-US', timezoneId: 'UTC' });
    if (mode === 'iphone-standalone') await context.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
      const match = window.matchMedia.bind(window);
      window.matchMedia = query => { const result = match(query); if (query.includes('display-mode') && query.includes('standalone')) Object.defineProperty(result, 'matches', { configurable: true, value: true }); return result; };
    });
    const page = await context.newPage();
    if (user) await signIn(page, user.username);
    pages.set(mode, page); return page;
  }
  async function doctor() {
    if (meta.state !== 'ready') return { state: meta.state };
    await owned(meta);
    const page = pages.get('iphone-webkit')!;
    const me = await page.request.get(`${meta.baseURL}/api/auth/me`);
    expect(me.status()).toBe(200);
    expect((await me.json()).banker.id).toBe(user!.banker.id);
    const shell = await page.request.get(meta.baseURL);
    const release = (await shell.text()).match(/name="pb-release" content="([^"]+)"/)?.[1];
    expect(release).toBe(meta.release);
    const history = await page.request.get(`${meta.baseURL}/api/sessions`); expect(history.status()).toBe(200);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'Workspace', exact: true }).click();
    await workspaceReady(page);
    if (local) {
      const listener = Number((await runOwned(owner, 'lsof', ['-nP', `-iTCP:${meta.port}`, '-sTCP:LISTEN', '-t'])).trim());
      expect(listener).toBe(meta.listenerPid);
      let parent = listener;
      for (let depth = 0; parent !== child!.pid && depth < 10; depth++) parent = Number((await runOwned(owner, 'ps', ['-p', String(parent), '-o', 'ppid='])).trim());
      expect(parent).toBe(child!.pid);
    }
    const result = { state: 'ready', runId, baseURL: meta.baseURL, release, owner: meta.pid, local, account: user!.username, ownedListener: meta.listenerPid ?? null, authenticated: true, workspaceUsable: true };
    await json(join(evidence, 'doctor.json'), result); return result;
  }
  async function handle(command: Command) {
    if (command.action === 'cleanup') {
      try { await cleanup(); setTimeout(() => process.exit(0), 100); return { evidence, cleaned: true }; }
      catch (error) { setTimeout(() => process.exit(1), 100); throw error; }
    }
    if (command.action === 'doctor') return doctor();
    if (command.action === 'evidence') return manifest();
    if (meta.state !== 'ready' || !browser || !user) throw new Error('Launch has not reached a signed-up usable workspace');
    const mode = command.mode ?? 'iphone-webkit';
    if (!['iphone-webkit', 'iphone-standalone', 'desktop-webkit'].includes(mode)) throw new Error('Unknown verification context');
    const page = await contextPage(mode);
    const directory = join(evidence, mode, `${command.action}-${Date.now()}-${randomUUID().slice(0, 6)}`); await mkdir(directory, { recursive: true });
    let sequence = 0;
    const steps: unknown[] = [];
    const recipeContext: RecipeContext = { page, context: page.context(), browser, baseURL: meta.baseURL, banker: user.banker, runId, evidence: directory,
      step: async name => {
        const stem = `${String(++sequence).padStart(2, '0')}-${name.replace(/[^a-zA-Z0-9-]/g, '-')}`;
        await page.screenshot({ path: join(directory, `${stem}.png`), fullPage: true });
        await writeFile(join(directory, `${stem}.aria.txt`), await page.locator('body').ariaSnapshot());
        steps.push({ name, time: new Date().toISOString(), url: page.url(), screenshot: `${stem}.png` });
        await json(join(directory, 'steps.json'), steps);
      }, checkState: () => current(page) };
    try {
      if (command.action === 'drive' && command.recipe === 'ledger') await ledger(recipeContext);
      else if (command.action === 'recipe' && command.recipe) {
        const path = resolve(command.recipe);
        if (!path.startsWith(`${root}/`) || !path.endsWith('.ts')) throw new Error('Recipe must be a TypeScript file inside this repository');
        const loaded = await import(`${pathToFileURL(path).href}?run=${Date.now()}`) as { default: (context: RecipeContext) => Promise<void> };
        await loaded.default(recipeContext);
      } else throw new Error('Use drive ledger or recipe <repo-relative-file.ts>');
      const result = { passed: true, mode, recipe: command.recipe, steps: steps.length, evidence: directory };
      await json(join(directory, `${command.action}-result.json`), result); return result;
    } catch (error) {
      await recipeContext.step('failure');
      await json(join(directory, 'failure-result.json'), { passed: false, error: error instanceof Error ? error.message : String(error) }); throw error;
    }
  }
  server = createServer(connection => {
    let input = '';
    connection.on('data', chunk => {
      input += String(chunk); if (!input.endsWith('\n')) return;
      let command: Command;
      try { command = JSON.parse(input) as Command; } catch { connection.end(JSON.stringify({ error: 'Invalid verification command' })); return; }
      if (busy && command.action !== 'cleanup') { connection.end(JSON.stringify({ error: 'Another verification command is active' })); return; }
      busy = true;
      void handle(command).then(result => connection.end(JSON.stringify({ result }))).catch(error => connection.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))).finally(() => { busy = false; });
    });
  });
  try {
    await owner.launch(() => new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(socket, resolve); }));
    await owner.launch(() => chmod(socket, 0o600));
    await owner.launch(saveMeta);
  } catch (error) {
    if (stopping) { await cleanupTask; return; }
    console.error(error);
    await cleanup();
    process.exitCode = 1;
    return;
  }
  startupTask = (async () => {
    starting();
    if (local) {
      const portServer = createServer(); await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
      const address = portServer.address(); if (!address || typeof address === 'string') throw new Error('No owned local port');
      meta.port = address.port; await new Promise<void>(resolve => portServer.close(() => resolve()));
      meta.baseURL = `https://127.0.0.1:${meta.port}`;
      starting();
      child = spawnOwned(owner, process.execPath, ['--import', 'tsx', 'scripts/e2e-server.ts'], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PORT: String(meta.port) } });
      await new Promise<void>((resolve, reject) => {
        let output = ''; const timeout = setTimeout(() => reject(new Error('Owned local stack startup exceeded 30 seconds')), 30000);
        child!.stdout!.on('data', chunk => { process.stdout.write(chunk); output += String(chunk); if (output.includes('Poker banker ready at')) { clearTimeout(timeout); resolve(); } });
        child!.stderr!.on('data', chunk => process.stderr.write(chunk));
        child!.once('exit', code => { clearTimeout(timeout); reject(new Error(`Owned server exited ${code}`)); });
        child!.once('error', error => { clearTimeout(timeout); reject(error); });
      });
      starting();
      meta.listenerPid = Number((await runOwned(owner, 'lsof', ['-nP', `-iTCP:${meta.port}`, '-sTCP:LISTEN', '-t'])).trim());
    }
    starting();
    browserServer = await owner.launch(async () => browserServer = await webkit.launchServer({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }));
    starting();
    browser = await owner.launch(async () => browser = await webkit.connect(browserServer!.wsEndpoint()));
    starting();
    const page = await contextPage('iphone-webkit');
    starting();
    user = await createAccount(page);
    starting();
    await workspaceReady(page);
    const shell = await page.request.get(meta.baseURL);
    meta.release = (await shell.text()).match(/name="pb-release" content="([^"]+)"/)?.[1];
    if (!meta.release) throw new Error('Build release stamp is missing');
    await page.screenshot({ path: join(evidence, 'launch-workspace.png') });
    await json(join(evidence, 'launch-result.json'), { ready: true, runId, baseURL: meta.baseURL, release: meta.release, account: user.username, local, setup: local ? ['Production build', 'Fresh embedded Postgres with migrations', 'Throwaway loopback HTTPS certificate', 'Headless Playwright WebKit', 'Synthetic signup with codes acknowledgement'] : ['Existing HTTPS deployment', 'Headless Playwright WebKit', 'Unique synthetic signup with codes acknowledgement'] });
    starting();
    meta.state = 'ready'; await saveMeta(); await doctor();
  })();
  try { await startupTask; } catch (error) {
    if (!stopping) {
      console.error(error);
      try { await withShutdownDeadline('Verification launch failure evidence', () => json(join(evidence, 'launch-failure-result.json'), { error: error instanceof Error ? error.message : String(error) })); }
      catch (evidenceError) { console.error(evidenceError); }
      await cleanup(); process.exit(1);
    }
  }
}
await mkdir(cache, { recursive: true }); await mkdir(evidence, { recursive: true });
if (action === '_daemon') await daemon();
else if (action === 'launch') {
  const owner = createProcessOwner();
  let child: ChildProcess | undefined;
  let interrupted: string | undefined;
  let launchCleanup: Promise<void> | undefined;
  let handoffTask: Promise<void> | undefined;
  let handedOff = false;
  const stopLaunch = () => launchCleanup ??= (async () => {
    child?.ref();
    if (handoffTask) await handoffTask.catch(() => {});
    const errors: unknown[] = [];
    if (handedOff && child) {
      try { await request({ action: 'cleanup' }); } catch (error) { errors.push(error); }
      try { await stopOwned(child); } catch (error) { errors.push(error); }
    }
    try { await owner.stop(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Verification launch cleanup failed');
    await withShutdownDeadline('Verification launch socket removal', () => rm(socket, { force: true }));
    await withShutdownDeadline('Verification launch metadata removal', () => rm(metadata, { force: true }));
  })();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const handlers = signals.map(signal => { const handler = () => { if (interrupted) return; interrupted = signal; process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129; void stopLaunch().catch(() => {}); }; process.on(signal, handler); return { signal, handler }; });
  const local = args.includes('--local');
  if (local === args.includes('--live')) throw new Error('Choose exactly one of --local and --live');
  if (local) {
    for (const name of await readdir(cache)) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
      const previous = JSON.parse(await readFile(join(cache, name), 'utf8')) as Meta;
      if (!previous.local || previous.state === 'stopped') continue;
      try { await owned(previous, owner); } catch { owner.checkpoint(); continue; }
      throw new Error(`Local verification run ${previous.runId} owns dist; clean it up before another local launch or build`);
    }
    try { await runOwned(owner, 'pnpm', ['build'], { stdio: 'inherit', env: { ...process.env, RELEASE_VERSION: `verify-${runId}` } }); }
    catch (error) { await owner.stop(); throw error; }
  } else if (!process.env.PB_BASE_URL || new URL(process.env.PB_BASE_URL).protocol !== 'https:') throw new Error('Live launch requires PB_BASE_URL=https://...');
  const log = openSync(join(evidence, 'server.log'), 'a');
  child = spawnOwned(owner, process.execPath, ['--import', 'tsx', '.claude/skills/verify-poker-banker/scripts/control.ts', '_daemon', runId, local ? '--local' : '--live'], { detached: true, stdio: ['ignore', log, log] });
  closeSync(log); child.unref();
  let ready: unknown;
  try {
    for (let attempt = 0; attempt < 180 && !interrupted; attempt++) {
      await pause(500);
      if (interrupted) break;
      try { const result = await request({ action: 'doctor' }) as { state: string }; if (result.state === 'ready') { ready = result; break; } } catch {}
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Launch failed; evidence preserved at ${evidence}`);
    }
    if (interrupted) { await stopLaunch(); console.error(`Verification launch interrupted by ${interrupted}; evidence preserved at ${evidence}`); }
    else {
      if (!ready) { await stopLaunch(); throw new Error(`Launch never reached workspace; evidence preserved at ${evidence}`); }
      handoffTask = owner.handoff(child).then(() => { handedOff = true; });
      await handoffTask;
      if (interrupted) { await stopLaunch(); throw new Error('Verification launch was interrupted during handoff'); }
      if (child.connected) child.disconnect();
      await owner.stop();
      console.log(JSON.stringify({ runId, evidence, ready }, null, 2));
    }
  } finally {
    try { if (!ready || interrupted) await stopLaunch(); } finally { for (const { signal, handler } of handlers) process.removeListener(signal, handler); }
  }
} else await ownedMain(async owner => {
  const meta = JSON.parse(await readFile(metadata, 'utf8')) as Meta;
  await owned(meta, owner);
  owner.checkpoint();
  const mode = (args.includes('--context') ? option('--context') : 'iphone-webkit') as Mode;
  console.log(JSON.stringify(await request({ action, mode, recipe: args[1] }), null, 2));
});
