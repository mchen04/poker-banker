import { constants } from 'node:fs';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { webkit, type BrowserServer } from '@playwright/test';
import { createProcessOwner, type ProcessOwner, withShutdownDeadline } from '../owned-process';
import { runOwned } from '../owned-command';
type OwnedProcess = { pid: number; group: number; executable: string };
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
  constructor(private readonly engine: string, private readonly server: BrowserServer, private readonly owner: ProcessOwner) {}
  private async processes(): Promise<OwnedProcess[]> {
    const groups = new Set(this.owner.groupIds());
    return (await runOwned(this.owner, 'ps', ['-Ao', 'pid=,pgid=,comm='])).split('\n').flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match || !groups.has(Number(match[2])) || !match[3]!.startsWith(`${this.engine}/`)) return [];
      const result = { pid: Number(match[1]), group: Number(match[2]), executable: match[3]! };
      this.seen.set(result.pid, { group: result.group, executable: result.executable });
      return [result];
    });
  }
  private async signal(value: 'SIGSTOP' | 'SIGCONT') {
    const processes = await this.processes();
    const groups = new Set(this.owner.signalGroups(value));
    return processes.filter(process => groups.has(process.group)).length;
  }
  async start() {
    if (this.enabled) return;
    if (this.server.process().exitCode !== null) throw new Error('Owned WebKit browser exited during CPU shaping');
    if (!(await this.processes()).some(value => value.executable.includes('WebContent'))) throw new Error('WebContent is not attributable to the exclusive engine directory');
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
      finally { if (!this.owner.signal.aborted) await this.signal('SIGCONT'); }
    })();
    void this.loop.catch(() => {});
  }
  pause() {
    this.enabled = false;
    return this.pausing ??= (async () => { try { await withShutdownDeadline('Benchmark CPU shaping pause', () => this.loop); } finally { if (!this.owner.signal.aborted) await this.signal('SIGCONT'); } })();
  }
  summary() {
    const active = this.cycles.reduce((sum, value) => sum + value.activeMs, 0);
    const stopped = this.cycles.reduce((sum, value) => sum + value.stoppedMs, 0);
    return { requested: '25ms runnable / 75ms stopped, registered process groups only', actualRunnableFraction: active / (active + stopped), cycles: this.cycles.length, minActiveMs: Math.min(...this.cycles.map(value => value.activeMs)), maxActiveMs: Math.max(...this.cycles.map(value => value.activeMs)), processes: [...this.seen].map(([pid, observed]) => ({ pid, ...observed })), source: 'Exclusive copy of installed Playwright WebKit with byte-identical executable hashes. Signals target only registered browser process groups; observations include only engine executables in those groups.' };
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
