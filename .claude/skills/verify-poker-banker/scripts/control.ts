#!/usr/bin/env -S pnpm exec tsx
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { webkit, devices, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { SessionState } from '../../../../src/domain/session';
import { createAccount, signIn, current } from '../../../../e2e/helpers';
import { ledger } from './ledger';

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
  return new Promise((resolve, reject) => {
    const client = createConnection(socket);
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
}
async function files(directory: string): Promise<string[]> {
  const values = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(values.map(value => value.isDirectory() ? files(join(directory, value.name)) : [join(directory, value.name)]))).flat();
}
function owned(meta: Meta) {
  const command = execFileSync('ps', ['-p', String(meta.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
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
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  let user: Awaited<ReturnType<typeof createAccount>> | undefined;
  const pages = new Map<Mode, Page>();
  let busy = false;
  let cleanupTask: Promise<void> | undefined;
  const saveMeta = () => json(metadata, meta);
  function cleanup(): Promise<void> {
    cleanupTask ??= (async () => {
      const errors: string[] = [];
      try { await browser?.close(); } catch (error) { errors.push(String(error)); }
      try {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
          if (child.connected) child.send({ type: 'pb-shutdown' }); else child.kill('SIGTERM');
          await exited;
        }
      } catch (error) { errors.push(String(error)); }
      try {
        meta.state = 'stopped';
        const proofFiles = (await files(evidence)).filter(path => path.endsWith('.png') || path.endsWith('-result.json'));
        await json(join(evidence, 'cleanup.json'), { runId, stopped: new Date().toISOString(), ownedDaemonPid: process.pid, ownedServerPid: child?.pid ?? null, evidenceFilesPreserved: proofFiles.length, errors });
        await manifest();
      } finally {
        server.close(); await rm(socket, { force: true }); await rm(metadata, { force: true });
      }
      if (errors.length) throw new Error(`Owned cleanup errors: ${errors.join('; ')}`);
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
    owned(meta);
    const page = pages.get('iphone-webkit')!;
    const me = await page.request.get(`${meta.baseURL}/api/auth/me`);
    expect(me.status()).toBe(200);
    expect((await me.json()).banker.id).toBe(user!.banker.id);
    const shell = await page.request.get(meta.baseURL);
    const release = (await shell.text()).match(/name="pb-release" content="([^"]+)"/)?.[1];
    expect(release).toBe(meta.release);
    const history = await page.request.get(`${meta.baseURL}/api/sessions`); expect(history.status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toBeVisible();
    if (local) {
      const listener = Number(execFileSync('lsof', ['-nP', `-iTCP:${meta.port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim());
      expect(listener).toBe(meta.listenerPid);
      let parent = listener;
      for (let depth = 0; parent !== child!.pid && depth < 10; depth++) parent = Number(execFileSync('ps', ['-p', String(parent), '-o', 'ppid='], { encoding: 'utf8' }).trim());
      expect(parent).toBe(child!.pid);
    }
    const result = { state: 'ready', runId, baseURL: meta.baseURL, release, owner: meta.pid, local, account: user!.username, ownedListener: meta.listenerPid ?? null, authenticated: true, workspaceUsable: true };
    await json(join(evidence, 'doctor.json'), result); return result;
  }
  async function handle(command: Command) {
    if (command.action === 'cleanup') { await cleanup(); setTimeout(() => process.exit(0), 100); return { evidence, cleaned: true }; }
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
  const server = createServer(connection => {
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
  await new Promise<void>(resolve => server.listen(socket, resolve)); await chmod(socket, 0o600); await saveMeta();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void cleanup().finally(() => process.exit(0)); });
  try {
    if (local) {
      const portServer = createServer(); await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
      const address = portServer.address(); if (!address || typeof address === 'string') throw new Error('No owned local port');
      meta.port = address.port; await new Promise<void>(resolve => portServer.close(() => resolve()));
      meta.baseURL = `https://127.0.0.1:${meta.port}`;
      child = spawn(process.execPath, ['--import', 'tsx', 'scripts/e2e-server.ts'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PORT: String(meta.port) } });
      await new Promise<void>((resolve, reject) => {
        let output = ''; const timeout = setTimeout(() => reject(new Error('Owned local stack startup exceeded 30 seconds')), 30000);
        child!.stdout!.on('data', chunk => { process.stdout.write(chunk); output += String(chunk); if (output.includes('Poker banker ready at')) { clearTimeout(timeout); resolve(); } });
        child!.stderr!.on('data', chunk => process.stderr.write(chunk));
        child!.once('exit', code => { clearTimeout(timeout); reject(new Error(`Owned server exited ${code}`)); });
        child!.once('error', reject);
      });
      meta.listenerPid = Number(execFileSync('lsof', ['-nP', `-iTCP:${meta.port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim());
    }
    browser = await webkit.launch();
    const page = await contextPage('iphone-webkit');
    user = await createAccount(page);
    await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
    const shell = await page.request.get(meta.baseURL);
    meta.release = (await shell.text()).match(/name="pb-release" content="([^"]+)"/)?.[1];
    if (!meta.release) throw new Error('Build release stamp is missing');
    await page.screenshot({ path: join(evidence, 'launch-workspace.png') });
    await json(join(evidence, 'launch-result.json'), { ready: true, runId, baseURL: meta.baseURL, release: meta.release, account: user.username, local, setup: local ? ['Production build', 'Fresh embedded Postgres with migrations', 'Throwaway loopback HTTPS certificate', 'Headless Playwright WebKit', 'Synthetic signup with codes acknowledgement'] : ['Existing HTTPS deployment', 'Headless Playwright WebKit', 'Unique synthetic signup with codes acknowledgement'] });
    meta.state = 'ready'; await saveMeta(); await doctor();
  } catch (error) {
    console.error(error); await json(join(evidence, 'launch-failure-result.json'), { error: error instanceof Error ? error.message : String(error) });
    await cleanup(); process.exit(1);
  }
}
await mkdir(cache, { recursive: true }); await mkdir(evidence, { recursive: true });
if (action === '_daemon') await daemon();
else if (action === 'launch') {
  const local = args.includes('--local');
  if (local === args.includes('--live')) throw new Error('Choose exactly one of --local and --live');
  if (local) {
    for (const name of await readdir(cache)) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
      const previous = JSON.parse(await readFile(join(cache, name), 'utf8')) as Meta;
      if (!previous.local || previous.state === 'stopped') continue;
      try { owned(previous); } catch { continue; }
      throw new Error(`Local verification run ${previous.runId} owns dist; clean it up before another local launch or build`);
    }
    const build = spawnSync('pnpm', ['build'], { stdio: 'inherit', env: { ...process.env, RELEASE_VERSION: `verify-${runId}` } });
    if (build.status !== 0) throw new Error('Verification production build failed');
  } else if (!process.env.PB_BASE_URL || new URL(process.env.PB_BASE_URL).protocol !== 'https:') throw new Error('Live launch requires PB_BASE_URL=https://...');
  const log = openSync(join(evidence, 'server.log'), 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', '.claude/skills/verify-poker-banker/scripts/control.ts', '_daemon', runId, local ? '--local' : '--live'], { detached: true, stdio: ['ignore', log, log] });
  closeSync(log); child.unref();
  let ready: unknown;
  for (let attempt = 0; attempt < 180; attempt++) {
    await pause(500);
    try { const result = await request({ action: 'doctor' }) as { state: string }; if (result.state === 'ready') { ready = result; break; } } catch {}
    try { process.kill(child.pid!, 0); } catch { throw new Error(`Launch failed; evidence preserved at ${evidence}`); }
  }
  if (!ready) { try { await request({ action: 'cleanup' }); } catch { const meta = JSON.parse(await readFile(metadata, 'utf8')) as Meta; owned(meta); process.kill(meta.pid, 'SIGTERM'); } throw new Error(`Launch never reached workspace; evidence preserved at ${evidence}`); }
  console.log(JSON.stringify({ runId, evidence, ready }, null, 2));
} else {
  const meta = JSON.parse(await readFile(metadata, 'utf8')) as Meta;
  owned(meta);
  const mode = (args.includes('--context') ? option('--context') : 'iphone-webkit') as Mode;
  console.log(JSON.stringify(await request({ action, mode, recipe: args[1] }), null, 2));
}
