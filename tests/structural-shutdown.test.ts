import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';

const prelude = `
  import { readFileSync } from 'node:fs';
  import { stripTypeScriptTypes } from 'node:module';
  import { spawn, ChildProcess } from 'node:child_process';
  import { once } from 'node:events';
  const strip = path => stripTypeScriptTypes(readFileSync(path, 'utf8')).replace(/^import .*;\\n/gm, '').replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url));
  const helper = strip('scripts/owned-process.ts');
  const { stopOwnedProcess, withShutdownDeadline } = new Function(helper + ';return { stopOwnedProcess, withShutdownDeadline };')();
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  const kill = pid => { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
`;

async function probe<T>(script: string): Promise<T> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', prelude + script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stdout!.on('data', chunk => { output += String(chunk); });
  child.stderr!.on('data', chunk => { errors += String(chunk); });
  const exit = once(child, 'exit', { signal: AbortSignal.timeout(18000) });
  try {
    const [code] = await exit;
    expect(code, errors).toBe(0);
    return JSON.parse(output) as T;
  } finally {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, 'SIGKILL');
  }
}

it('removes local app descendants before pool and database cleanup and reports forced shutdown', async () => {
  const result = await probe<{ events: { step: string; descendantAlive: boolean }[]; descendantAlive: boolean; failures: string[] }>(`
    const source = strip('scripts/db-local.ts');
    const body = source.slice(source.indexOf('function stop()'), source.indexOf('\\nfunction finish('));
    const descendant = 'process.on("SIGTERM",()=>{});console.log(process.pid);setInterval(()=>{},1000)';
    const wrapper = 'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",'+JSON.stringify(descendant)+'],{stdio:["ignore","pipe","ignore"]});child.stdout.on("data",data=>process.send({pid:Number(String(data))}));setInterval(()=>{},1000)';
    const child = spawn(process.execPath, ['-e', wrapper], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let pid;
    try {
      [{pid}] = await once(child, 'message', { signal: AbortSignal.timeout(3000) });
      const events = [], failures = [];
      const fixtures = { child, stopOwnedProcess, ChildProcess, endPool: async () => events.push({ step: 'pool-stop', descendantAlive: alive(pid) }), stopDatabase: async () => events.push({ step: 'database-stop', descendantAlive: alive(pid) }), fail: message => failures.push(message) };
      const stop = new Function(...Object.keys(fixtures), 'let requested=false,stopping;const startup=Promise.resolve(),database={};'+body+';return stop;')(...Object.values(fixtures));
      await stop();
      process.stdout.write(JSON.stringify({ events, descendantAlive: alive(pid), failures }));
    } finally { kill(-child.pid); if (pid) kill(pid); }
  `);
  expect(result.events).toEqual([{ step: 'pool-stop', descendantAlive: false }, { step: 'database-stop', descendantAlive: false }]);
  expect(result.descendantAlive).toBe(false);
  expect(result.failures.length).toBeGreaterThan(0);
});

it('drains a pending benchmark browser launch before database cleanup and stack settlement', async () => {
  const result = await probe<{ step: string; browserAlive: boolean }[]>(`
    const source = strip('scripts/bench/stack.ts');
    const begin = source.indexOf('  let database'), end = source.indexOf('\\n  try {\\n    database =');
    let child, resolveLaunch;
    const events = [];
    const controller = new AbortController();
    const stack = new Function('signal', 'withShutdownDeadline', 'stopOwnedProcess', 'fixtures', source.slice(begin,end)+';database=fixtures.database;return {own,stop};')(controller.signal, withShutdownDeadline, stopOwnedProcess, { database: { stop: async () => events.push({ step: 'database-stop', browserAlive: alive(child.pid) }) } });
    const benchmarkBrowser = new Function('webkit', strip('scripts/bench/browser.ts')+';return benchmarkBrowser;')({ launchServer: () => {
      child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return new Promise(resolve => { resolveLaunch = resolve; });
    } });
    const pending = benchmarkBrowser(stack, { executable: 'fixture' }, '', () => {}, { phase() {} }).catch(error => error.message);
    try {
      await once(child.stdout, 'data', { signal: AbortSignal.timeout(3000) });
      controller.abort();
      const stopping = stack.stop().catch(() => {});
      setTimeout(() => resolveLaunch({ process: () => child, close: () => stopOwnedProcess(child, 'signal', true) }), 100);
      await stopping;
      events.push({ step: 'stack-stop-settled', browserAlive: alive(child.pid) });
      await pending;
      process.stdout.write(JSON.stringify(events));
    } finally { kill(-child.pid); }
  `);
  expect(result).toEqual([{ step: 'database-stop', browserAlive: false }, { step: 'stack-stop-settled', browserAlive: false }]);
});

it('removes the pending E2E database worker group before launcher exit', async () => {
  const result = await probe<{ exitCode: number; workerAlive: boolean; descendantAlive: boolean }>(`
    const descendant = 'process.on("SIGINT",()=>{});process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)';
    const workerScript = \`
      const {spawn}=await import('node:child_process');const {once}=await import('node:events');
      const stopOwnedProcess=new Function(\${JSON.stringify(helper)}+';return stopOwnedProcess')();
      const mkdir=async()=>{},mkdtemp=async()=>'/not-written',rm=async()=>{},resolve=x=>x;
      class EmbeddedPostgres {
        async initialise(){}
        async start(){this.process=spawn(process.execPath,['-e',\${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore']});await once(this.process.stdout,'data');process.send({type:'fixture-child',pid:this.process.pid});await new Promise(()=>{});}
        async stop(){const exit=once(this.process,'exit');this.process.kill('SIGINT');await exit;}
      }
      \${strip('scripts/test-postgres.ts')}
    \`;
    const databaseSource = strip('tests/database.ts');
    const launcherScript = \`
      const {spawn}=await import('node:child_process');
      const stopOwnedProcess=new Function(\${JSON.stringify(helper)}+';return stopOwnedProcess')();
      const testDatabase=new Function('availablePort','spawn','fileURLToPath','createPool','migrate','stopOwnedProcess',\${JSON.stringify(databaseSource.slice(databaseSource.indexOf('async function testDatabase'))+';return testDatabase;')})(
        async()=>54321,(_exe,_args,options)=>{const child=spawn(process.execPath,['--input-type=module','-e',\${JSON.stringify(workerScript)},'dummy','54321','[]'],options);child.on('message',message=>{if(message.type==='fixture-child')process.send({...message,workerPid:child.pid});});return child;},x=>String(x),()=>{throw new Error('No pool before ready')},async()=>{},stopOwnedProcess);
      \${strip('scripts/e2e-server.ts')}
    \`;
    const launcher = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', launcherScript], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let info;
    try {
      [info] = await once(launcher, 'message', { signal: AbortSignal.timeout(3000) });
      const exit = once(launcher, 'exit', { signal: AbortSignal.timeout(10000) });
      launcher.send({ type: 'pb-shutdown' });
      await exit;
      process.stdout.write(JSON.stringify({ exitCode: launcher.exitCode, workerAlive: alive(info.workerPid), descendantAlive: alive(info.pid) }));
    } finally { if(info){kill(-info.workerPid);kill(info.pid);}kill(-launcher.pid); }
  `);
  expect(result).toEqual({ exitCode: 1, workerAlive: false, descendantAlive: false });
});
