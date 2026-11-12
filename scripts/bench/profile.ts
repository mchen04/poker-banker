import { constants } from 'node:fs';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { webkit, type BrowserServer } from '@playwright/test';
import { createProcessOwner, type ProcessOwner, withShutdownDeadline } from '../owned-process';
import { runOwned } from '../owned-command';
type OwnedProcess = { pid: number; group: number; started: string; executable: string };
const createScannerOwner = AsyncResource.bind(() => createProcessOwner());

export function engineProcesses(snapshot: string, engine: string): OwnedProcess[] {
  return snapshot.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!match || Number(match[1]) <= 0 || !match[4]!.startsWith(`${engine}/`)) return [];
    return [{ pid: Number(match[1]), group: Number(match[2]), started: match[3]!.replace(/\s+/g, ' '), executable: match[4]! }];
  });
}
export async function isolatedEngine(parent?: ProcessOwner) {
  const owner = createProcessOwner({ parent });
  let ownedDirectory: string | undefined;
  owner.addCleanup('Exclusive benchmark engine cleanup', 'cleanup', () => ownedDirectory ? rm(ownedDirectory, { recursive: true, force: true }) : undefined);
  const cleanup = () => owner.stop();
  const original = webkit.executablePath();
  try {
    const directory = await owner.launch(async () => ownedDirectory = await mkdtemp(resolve('.cache/bench-webkit-')));
    const engine = join(directory, 'engine');
    await owner.launch(() => cp(dirname(original), engine, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE }));
    const binaries = ['pw_run.sh', 'Playwright.app/Contents/MacOS/Playwright', 'com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development', 'com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking.Development', 'com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU.Development'];
    const hashes: Record<string, string> = {};
    for (const binary of binaries) {
      const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
      const expected = digest(await owner.launch(() => readFile(join(dirname(original), binary))));
      const actual = digest(await owner.launch(() => readFile(join(engine, binary))));
      if (actual !== expected) throw new Error(`Copied engine differs at ${binary}`);
      hashes[binary] = actual;
    }
    return { directory, engine, executable: join(engine, 'pw_run.sh'), hashes, cleanup };
  } catch (error) { try { await cleanup(); } catch (failure) { throw new AggregateError([error, failure], 'Benchmark engine setup and cleanup failed'); } throw error; }
}
export class CpuBudget {
  private enabled = false;
  private loop: Promise<void> | undefined;
  private pausing: Promise<void> | undefined;
  private cycles: { activeMs: number; stoppedMs: number; processes: number }[] = [];
  private seen = new Map<number, Omit<OwnedProcess, 'pid'>>();
  private stopped = new Map<number, OwnedProcess>();
  private readonly scanner = createScannerOwner();
  constructor(private readonly engine: string, private readonly server: BrowserServer, private readonly owner: ProcessOwner) {
    const abort = () => { void this.pause().catch(() => {}); };
    owner.signal.addEventListener('abort', abort, { once: true });
    owner.addCleanup('Benchmark CPU scanner close', 'cleanup', async () => { owner.signal.removeEventListener('abort', abort); try { await this.pause(); } finally { await this.scanner.stop(); } });
  }
  private async processes(): Promise<OwnedProcess[]> {
    const snapshot = await withShutdownDeadline('Benchmark CPU process scan', () => runOwned(this.scanner, 'ps', ['-Ao', 'pid=,pgid=,lstart=,comm='], { env: { ...process.env, LC_ALL: 'C' } }));
    const values = engineProcesses(snapshot, this.engine);
    for (const value of values) this.seen.set(value.pid, { group: value.group, started: value.started, executable: value.executable });
    return values;
  }
  private async signal(value: 'SIGSTOP' | 'SIGCONT') {
    if (value === 'SIGCONT' && !this.stopped.size) return 0;
    const processes = await this.processes();
    if (value === 'SIGSTOP') this.owner.checkpoint();
    let count = 0;
    const targets = value === 'SIGSTOP' ? processes : [...this.stopped.values()];
    for (const target of targets) {
      const current = processes.find(candidate => candidate.pid === target.pid && candidate.started === target.started && candidate.executable === target.executable);
      if (!current) { this.stopped.delete(target.pid); continue; }
      try {
        process.kill(current.pid, value); count++;
        if (value === 'SIGSTOP') this.stopped.set(current.pid, current);
        else this.stopped.delete(current.pid);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; this.stopped.delete(current.pid); }
    }
    return count;
  }
  async start() {
    if (this.enabled) return;
    if (this.server.process().exitCode !== null) throw new Error('Owned WebKit browser exited during CPU shaping');
    if (!(await this.processes()).some(value => value.executable.includes('WebContent'))) throw new Error('WebContent is not attributable to the exclusive engine directory');
    this.owner.checkpoint();
    this.enabled = true;
    this.pausing = undefined;
    this.loop = (async () => {
      let scanMs = 5;
      try {
        while (this.enabled) {
          await this.signal('SIGCONT'); const active = performance.now();
          await pause(Math.max(1, 25 - scanMs));
          if (!this.enabled) break;
          const scan = performance.now(); const count = await this.signal('SIGSTOP');
          scanMs = performance.now() - scan;
          const stopped = performance.now(); await pause(75);
          await this.signal('SIGCONT'); const resumed = performance.now();
          this.cycles.push({ activeMs: stopped - active, stoppedMs: resumed - stopped, processes: count });
        }
      } catch (error) { if (!this.owner.signal.aborted) throw error; }
      finally { await this.signal('SIGCONT'); }
    })();
    void this.loop.catch(() => {});
  }
  pause() {
    this.enabled = false;
    return this.pausing ??= (async () => { try { await withShutdownDeadline('Benchmark CPU shaping pause', () => this.loop); } finally { await this.signal('SIGCONT'); } })();
  }
  summary() {
    const active = this.cycles.reduce((sum, value) => sum + value.activeMs, 0);
    const stopped = this.cycles.reduce((sum, value) => sum + value.stoppedMs, 0);
    return { requested: '25ms runnable / 75ms stopped, individually verified positive PIDs only', actualRunnableFraction: active / (active + stopped), cycles: this.cycles.length, minActiveMs: Math.min(...this.cycles.map(value => value.activeMs)), maxActiveMs: Math.max(...this.cycles.map(value => value.activeMs)), processes: [...this.seen].map(([pid, observed]) => ({ pid, ...observed })), source: 'Exclusive byte-identical WebKit clone. macOS XPC process groups are not assumed to inherit the launcher group. Every STOP scans the exact cloned executable prefix; CONT revalidates executable and process start time against the stopped set using an independently owned ps scanner that remains available during cancellation. No process-group signals.' };
  }
}
export async function primeEngine(engine: Awaited<ReturnType<typeof isolatedEngine>>, signal?: AbortSignal) {
  const owner = createProcessOwner();
  let server: BrowserServer | undefined;
  let browser: Awaited<ReturnType<typeof webkit.connect>> | undefined;
  owner.addCleanup('Primed browser server close', 'cleanup', () => server?.close());
  owner.addCleanup('Primed browser close', 'cleanup', () => browser?.close());
  const abort = () => { void owner.stop().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) owner.cancel();
  try {
    server = await owner.launch(async () => server = await webkit.launchServer({ executablePath: engine.executable, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }));
    browser = await owner.launch(async () => browser = await webkit.connect(server!.wsEndpoint()));
    await owner.launch(async () => { const page = await browser!.newPage(); await page.setContent('<h1>Unreported engine readiness</h1>'); await page.screenshot(); });
  } finally {
    signal?.removeEventListener('abort', abort);
    await owner.stop();
  }
}
