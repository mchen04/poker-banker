import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { webkit, type BrowserServer } from '@playwright/test';
type OwnedProcess = { pid: number; executable: string };
export async function isolatedEngine() {
  const original = webkit.executablePath();
  const directory = await mkdtemp(resolve('.cache/bench-webkit-'));
  const engine = join(directory, 'engine');
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
    return { directory, engine, executable: join(engine, 'pw_run.sh'), hashes, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
export class CpuBudget {
  private enabled = false;
  private loop: Promise<void> | undefined;
  private cycles: { activeMs: number; stoppedMs: number; processes: number }[] = [];
  private seen = new Map<number, string>();
  constructor(private readonly engine: string, private readonly server: BrowserServer) {}
  private processes(): OwnedProcess[] {
    return execFileSync('ps', ['-Ao', 'pid=,comm='], { encoding: 'utf8' }).split('\n').flatMap(line => {
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
  async pause() { this.enabled = false; try { await this.loop; } finally { this.signal('SIGCONT'); } }
  summary() {
    const active = this.cycles.reduce((sum, value) => sum + value.activeMs, 0);
    const stopped = this.cycles.reduce((sum, value) => sum + value.stoppedMs, 0);
    return { requested: '25ms runnable / 75ms stopped, identity checked before every signal', actualRunnableFraction: active / (active + stopped), cycles: this.cycles.length, minActiveMs: Math.min(...this.cycles.map(value => value.activeMs)), maxActiveMs: Math.max(...this.cycles.map(value => value.activeMs)), processes: [...this.seen].map(([pid, executable]) => ({ pid, executable })), source: 'Exclusive copy of installed Playwright WebKit, byte-identical executable hashes; no signals to other executables' };
  }
}
export async function primeEngine(engine: Awaited<ReturnType<typeof isolatedEngine>>) {
  const server = await webkit.launchServer({ executablePath: engine.executable, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  let browser: Awaited<ReturnType<typeof webkit.connect>> | undefined;
  try { browser = await webkit.connect(server.wsEndpoint()); const page = await browser.newPage(); await page.setContent('<h1>Unreported engine readiness</h1>'); await page.screenshot(); }
  finally { try { await browser?.close(); } finally { await server.close(); } }
}
