import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { webkit, type BrowserServer } from '@playwright/test';
import { SHUTDOWN_GRACE_MS, stopOwnedProcess, withShutdownDeadline } from '../owned-process';
type OwnedProcess = { pid: number; executable: string };
export async function isolatedEngine() {
  const original = webkit.executablePath();
  const directory = await mkdtemp(resolve('.cache/bench-webkit-'));
  const engine = join(directory, 'engine');
  let cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= withShutdownDeadline('Exclusive benchmark engine cleanup', () => rm(directory, { recursive: true, force: true }));
  try {
    await cp(dirname(original), engine, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    const binaries = ['pw_run.sh', 'Playwright.app/Contents/MacOS/Playwright', 'com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development', 'com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking.Development', 'com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU.Development'];
    const hashes: Record<string, string> = {};
    for (const binary of binaries) {
      const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
      const expected = digest(await readFile(join(dirname(original), binary)));
      const actual = digest(await readFile(join(engine, binary)));
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
  private seen = new Map<number, string>();
  constructor(private readonly engine: string, private readonly server: BrowserServer) {}
  private processes(): OwnedProcess[] {
    return execFileSync('ps', ['-Ao', 'pid=,comm='], { encoding: 'utf8', timeout: SHUTDOWN_GRACE_MS, killSignal: 'SIGKILL' }).split('\n').flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match || !match[2]!.startsWith(`${this.engine}/`)) return [];
      const result = { pid: Number(match[1]), executable: match[2]! }; this.seen.set(result.pid, result.executable); return [result];
    });
  }
  private signal(signal: NodeJS.Signals) {
    const processes = this.processes();
    for (const processInfo of processes) { try { process.kill(processInfo.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    return processes.length;
  }
  start() {
    if (this.enabled) return;
    if (this.server.process().exitCode !== null) throw new Error('Owned WebKit browser exited during CPU shaping');
    if (!this.processes().some(value => value.executable.includes('WebContent'))) throw new Error('WebContent is not attributable to the exclusive engine directory');
    this.enabled = true;
    this.pausing = undefined;
    this.loop = (async () => {
      let scanMs = 5;
      try {
        while (this.enabled) {
          this.signal('SIGCONT'); const active = performance.now();
          await pause(Math.max(1, 25 - scanMs));
          if (!this.enabled) break;
          const scan = performance.now(); const count = this.signal('SIGSTOP');
          scanMs = performance.now() - scan;
          const stopped = performance.now(); await pause(75);
          this.signal('SIGCONT'); const resumed = performance.now();
          this.cycles.push({ activeMs: stopped - active, stoppedMs: resumed - stopped, processes: count });
        }
      } finally { this.signal('SIGCONT'); }
    })();
    void this.loop.catch(() => {});
  }
  pause() {
    this.enabled = false;
    return this.pausing ??= (async () => { try { await withShutdownDeadline('Benchmark CPU shaping pause', () => this.loop); } finally { this.signal('SIGCONT'); } })();
  }
  summary() {
    const active = this.cycles.reduce((sum, value) => sum + value.activeMs, 0);
    const stopped = this.cycles.reduce((sum, value) => sum + value.stoppedMs, 0);
    return { requested: '25ms runnable / 75ms stopped, identity checked before every signal', actualRunnableFraction: active / (active + stopped), cycles: this.cycles.length, minActiveMs: Math.min(...this.cycles.map(value => value.activeMs)), maxActiveMs: Math.max(...this.cycles.map(value => value.activeMs)), processes: [...this.seen].map(([pid, executable]) => ({ pid, executable })), source: 'Exclusive copy of installed Playwright WebKit, byte-identical executable hashes; no signals to other executables' };
  }
}
export async function primeEngine(engine: Awaited<ReturnType<typeof isolatedEngine>>, signal?: AbortSignal) {
  let server: BrowserServer | undefined;
  let browser: Awaited<ReturnType<typeof webkit.connect>> | undefined;
  let stopping = false;
  const closures = new WeakMap<object, Promise<void>>();
  const close = (owner: object, action: () => Promise<void>) => {
    let pending = closures.get(owner);
    if (!pending) { pending = Promise.resolve().then(action); closures.set(owner, pending); }
    return pending;
  };
  const closeServer = (owned: BrowserServer) => close(owned, async () => {
    const child = typeof owned.process === 'function' ? owned.process() : undefined;
    const errors: unknown[] = [];
    try { await withShutdownDeadline('Primed browser server graceful close', () => owned.close()); }
    catch (error) { errors.push(error); }
    try {
      if (child) await stopOwnedProcess(child, 'signal', true);
      else if (errors.length && typeof owned.kill === 'function') await withShutdownDeadline('Primed browser server kill', () => owned.kill());
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Primed browser server cleanup failed');
  });
  const closeBrowser = (owned: NonNullable<typeof browser>) => close(owned, () => withShutdownDeadline('Primed browser close', () => owned.close()));
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal?.reason ?? new Error('Benchmark priming interrupted'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  void interrupted.catch(() => {});
  const run = <T>(task: Promise<T>): Promise<T> => Promise.race([task, interrupted]);
  try {
    if (signal?.aborted) throw signal.reason;
    server = await run<BrowserServer>(webkit.launchServer({ executablePath: engine.executable, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }).then(async owned => {
      if (stopping || signal?.aborted) { await closeServer(owned); throw signal?.reason ?? new Error('Benchmark priming stopped'); }
      return owned;
    }));
    browser = await run<NonNullable<typeof browser>>(webkit.connect(server.wsEndpoint()).then(async owned => {
      if (stopping || signal?.aborted) { await closeBrowser(owned); throw signal?.reason ?? new Error('Benchmark priming stopped'); }
      return owned;
    }));
    const owned = browser;
    await run((async () => { const page = await owned.newPage(); await page.setContent('<h1>Unreported engine readiness</h1>'); await page.screenshot(); })());
  } finally {
    stopping = true;
    signal?.removeEventListener('abort', abort);
    const results = await Promise.allSettled([
      browser ? closeBrowser(browser) : Promise.resolve(),
      server ? closeServer(server) : Promise.resolve(),
    ]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Primed browser cleanup failed');
  }
}
