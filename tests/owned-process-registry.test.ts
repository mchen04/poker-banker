import { ChildProcess, spawn as nativeSpawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createProcessOwner, stopOwnedProcess, withShutdownDeadline } from '../scripts/owned-process';

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
};

it('owns a complete detached command tree and leaves an unrelated sibling alive', async () => {
  const owner = createProcessOwner();
  const siblingOwner = createProcessOwner();
  const sibling = siblingOwner.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const descendant = 'process.on("SIGTERM",()=>process.exit(0));console.log(process.pid);setInterval(()=>{},1000)';
  const wrapper = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore']});child.stdout.on('data',data=>process.send({pid:Number(String(data))}));process.on('SIGTERM',()=>{});child.on('exit',()=>process.exit(0));setInterval(()=>{},1000);`;
  const child = owner.spawn(process.execPath, ['-e', wrapper], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let descendantPid: number | undefined;
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(3000) });
    descendantPid = (message as { pid: number }).pid;
    await owner.stopProcesses();
    expect(alive(child.pid!)).toBe(false);
    expect(alive(descendantPid)).toBe(false);
    expect(alive(sibling.pid!)).toBe(true);
  } finally {
    await owner.stopProcesses().catch(() => {});
    await siblingOwner.stop();
    if (descendantPid && alive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
  }
});

it('owns a native SDK child while its launch promise is still pending', async () => {
  const owner = createProcessOwner();
  let sdkChild: ReturnType<typeof nativeSpawn> | undefined;
  let complete!: () => void;
  const launch = owner.launch(async () => {
    await Promise.resolve();
    sdkChild = nativeSpawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { detached: false, stdio: ['ignore', 'pipe', 'ignore'] });
    await once(sdkChild.stdout!, 'data');
    await new Promise<void>(resolve => { complete = resolve; });
    return sdkChild;
  });
  const rejectedLaunch = expect(launch).rejects.toThrow('stopping');
  try {
    await withShutdownDeadline('SDK launch fixture', async () => { while (!complete) await new Promise(resolve => setTimeout(resolve, 5)); });
    const stopping = owner.stopProcesses();
    complete();
    await stopping;
    await rejectedLaunch;
    expect(alive(sdkChild!.pid!)).toBe(false);
  } finally { await owner.stopProcesses().catch(() => {}); }
});

it('prevents a native SDK process from spawning after cancellation', async () => {
  const owner = createProcessOwner();
  let resume!: () => void;
  let spawned = false;
  const launch = owner.launch(async () => {
    await new Promise<void>(resolve => { resume = resolve; });
    nativeSpawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    spawned = true;
  });
  const rejectedLaunch = expect(launch).rejects.toThrow('stopping');
  const stopping = owner.stopProcesses();
  resume();
  await stopping;
  await rejectedLaunch;
  expect(spawned).toBe(false);
  expect(() => owner.spawn(process.execPath, ['-e', 'process.exit(0)'])).toThrow('stopping');
});

it('rejects arbitrary unowned processes without delivering a signal', async () => {
  const child = new ChildProcess();
  Object.assign(child, { pid: process.pid });
  await expect(stopOwnedProcess(child)).rejects.toThrow('not registered');
  expect(alive(process.pid)).toBe(true);
});

it('reports forced group shutdown as failure after every group member is gone', async () => {
  const owner = createProcessOwner();
  const child = owner.spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout!, 'data');
    await expect(owner.stopProcesses()).rejects.toThrow('SIGKILL');
    expect(alive(child.pid!)).toBe(false);
  } finally { await owner.stopProcesses().catch(() => {}); }
});

it('joins a stalled launch deadline before reaping the native child and releasing its pool', async () => {
  const owner = createProcessOwner();
  let child!: ReturnType<typeof nativeSpawn>;
  const launch = owner.launch(async () => {
    child = nativeSpawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(child.stdout!, 'data');
    await new Promise<void>(() => {});
  });
  const cancelled = expect(launch).rejects.toThrow('stopping');
  await once(child.stdout!, 'data');
  let poolStopped = false;
  owner.addCleanup('Fixture pool', 'pool', () => { expect(alive(child.pid!)).toBe(false); poolStopped = true; });
  await expect(owner.stop()).rejects.toThrow('pending launches');
  await cancelled;
  expect(poolStopped).toBe(true);
  expect(alive(child.pid!)).toBe(false);
});

it('stops application groups before pools and database groups before scratch cleanup', async () => {
  const owner = createProcessOwner();
  const databaseOwner = createProcessOwner({ phase: 'database', parent: owner });
  const app = owner.spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const database = databaseOwner.spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await Promise.all([once(app.stdout!, 'data'), once(database.stdout!, 'data')]);
  const steps: string[] = [];
  owner.addCleanup('Fixture pool', 'pool', () => { expect(alive(app.pid!)).toBe(false); expect(alive(database.pid!)).toBe(true); steps.push('pool'); });
  databaseOwner.addCleanup('Fixture database', 'database', () => { expect(alive(database.pid!)).toBe(true); steps.push('database'); });
  owner.addCleanup('Fixture scratch', 'cleanup', () => { expect(alive(database.pid!)).toBe(false); steps.push('cleanup'); });
  await owner.stop();
  expect(steps).toEqual(['pool', 'database', 'cleanup']);
});

it('supervises detached groups forwarded by a forced nested owner', async () => {
  const owner = createProcessOwner();
  const script = `
    import {createProcessOwner} from ${JSON.stringify(new URL('../scripts/owned-process.ts', import.meta.url).href)};
    const owner=createProcessOwner({phase:'database'});
    const child=owner.spawn(process.execPath,['-e','console.log("ready");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore']});
    child.stdout.once('data',()=>process.send({type:'fixture-ready',pid:child.pid}));
    process.on('SIGTERM',()=>{});
    setInterval(()=>{},1000);
  `;
  const wrapper = owner.spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const descendantPid = await withShutdownDeadline('Nested owner fixture', () => new Promise<number>(resolve => wrapper.on('message', message => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'fixture-ready' && 'pid' in message) resolve(Number(message.pid));
  })));
  try {
    await expect(owner.stop()).rejects.toThrow('SIGKILL');
    expect(alive(wrapper.pid!)).toBe(false);
    expect(alive(descendantPid)).toBe(false);
  } finally {
    await owner.stop().catch(() => {});
    if (alive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
  }
});

it('shares the native boundary and ownership proof after a module reload', async () => {
  vi.resetModules();
  const reloaded = await import('../scripts/owned-process');
  const owner = reloaded.createProcessOwner();
  const child = owner.spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout!, 'data');
  await stopOwnedProcess(child);
  await owner.stop();
  expect(alive(child.pid!)).toBe(false);
});

it.each([false, true])('hands a ready service to its own lifecycle with concurrent cancellation %s', async cancelled => {
  const owner = createProcessOwner();
  const script = `
    import {once} from 'node:events';
    import {createProcessOwner} from ${JSON.stringify(new URL('../scripts/owned-process.ts', import.meta.url).href)};
    const owner=createProcessOwner();
    process.on('message',async message=>{if(message.type==='doctor'){const child=owner.spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});await once(child,'close');process.send({type:'doctor-done',code:child.exitCode})}});
    process.on('SIGTERM',async()=>{await owner.stop();process.exit(0)});
    console.log('ready');setInterval(()=>{},1000);
  `;
  const child = owner.spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore', 'ipc'] });
  await once(child.stdout!, 'data');
  const handoff = owner.handoff(child);
  const stopping = cancelled ? owner.stop() : undefined;
  await handoff;
  try {
    await (stopping ?? owner.stop());
    expect(owner.groupIds()).toEqual([]);
    expect(alive(child.pid!)).toBe(true);
    const doctor = once(child, 'message', { signal: AbortSignal.timeout(3000) });
    child.send({ type: 'doctor' });
    expect((await doctor)[0]).toEqual({ type: 'doctor-done', code: 0 });
  } finally { await stopOwnedProcess(child); }
});

it('never signals a retired group even if its old process identifier is reused', async () => {
  const owner = createProcessOwner();
  const child = owner.spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(child, 'close');
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('Retired process identifier was touched'); });
  try { await owner.stop(); expect(kill).not.toHaveBeenCalled(); }
  finally { kill.mockRestore(); }
});

it('keeps ownership records separate from an application IPC protocol', async () => {
  const owner = createProcessOwner();
  const script = `
    import {createProcessOwner} from ${JSON.stringify(new URL('../scripts/owned-process.ts', import.meta.url).href)};
    const send=process.send.bind(process);
    process.send=()=>{throw new Error('Application IPC cannot carry ownership records')};
    const childOwner=createProcessOwner();
    const child=childOwner.spawn(process.execPath,['-e','console.log("ready");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore']});
    child.stdout.once('data',()=>send({type:'fixture-ready',pid:child.pid}));
    process.on('SIGTERM',()=>process.exit(0));
    setInterval(()=>{},1000);
  `;
  const wrapper = owner.spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages: unknown[] = [];
  wrapper.on('message', message => messages.push(message));
  const descendantPid = await withShutdownDeadline('Private control fixture', () => new Promise<number>(resolve => wrapper.on('message', message => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'fixture-ready' && 'pid' in message) resolve(Number(message.pid));
  })));
  expect(owner.groupIds()).toContain(descendantPid);
  const originalKill = process.kill.bind(process);
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, value) => originalKill(pid, value));
  try {
    await owner.stop();
    expect(kill.mock.calls.filter(([, value]) => value === 'SIGTERM').map(([pid]) => pid)).toEqual([-descendantPid, -wrapper.pid!]);
    expect(messages).toEqual([{ type: 'fixture-ready', pid: descendantPid }]);
    expect(alive(descendantPid)).toBe(false);
  } finally { kill.mockRestore(); await owner.stop().catch(() => {}); }
});

it('accepts exit 143 only after this owner sent the process group SIGTERM', async () => {
  const owner = createProcessOwner();
  const child = owner.spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(143));console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout!, 'data');
  await owner.stop();
  expect(child.exitCode).toBe(143);
});

it.each([1, 17, 143])('preserves an unexpected natural exit %s as failure', async code => {
  const owner = createProcessOwner();
  const child = owner.spawn(process.execPath, ['-e', `process.exit(${code})`], { stdio: 'ignore' });
  await once(child, 'close');
  await expect(owner.stop()).rejects.toThrow(`Owned process exited ${code}`);
});

it('sends CPU shaping signals only to groups held by the requested owner', async () => {
  const owner = createProcessOwner();
  const siblingOwner = createProcessOwner();
  const child = owner.spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const sibling = siblingOwner.spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await Promise.all([once(child.stdout!, 'data'), once(sibling.stdout!, 'data')]);
  const originalKill = process.kill.bind(process);
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, value) => originalKill(pid, value));
  try {
    expect(owner.signalGroups('SIGSTOP')).toEqual([child.pid]);
    owner.cancel();
    expect(owner.signalGroups('SIGCONT')).toEqual([child.pid]);
    expect(kill.mock.calls.filter(([, value]) => value === 'SIGSTOP' || value === 'SIGCONT')).toEqual([[-child.pid!, 'SIGSTOP'], [-child.pid!, 'SIGCONT']]);
  } finally { kill.mockRestore(); await owner.stop(); await siblingOwner.stop(); }
});

it.each([0, 1])('authorizes supervisor SIGTERM through %s relay owners before accepting descendant exit 143', async depth => {
  const moduleUrl = JSON.stringify(new URL('../scripts/owned-process.ts', import.meta.url).href);
  const script = (remaining: number): string => `
    import {createProcessOwner} from ${moduleUrl};
    const owner=createProcessOwner();
    const child=owner.spawn(process.execPath,${JSON.stringify(remaining ? ['--import', 'tsx', '--input-type=module', '-e', script(remaining - 1)] : ['-e', 'process.on("SIGTERM",()=>process.exit(143));console.log("ready");setInterval(()=>{},1000)'])},{stdio:['ignore',${remaining ? "'ignore'" : "'pipe'"},'pipe','ipc']});
    ${remaining ? "child.on('message',message=>{if(message.type==='fixture-ready')process.send(message)});" : "child.stdout.once('data',()=>process.send({type:'fixture-ready',pid:child.pid}));"}
    process.on('SIGTERM',async()=>{try{await owner.stop();process.exit(0)}catch(error){console.error(error);process.exit(1)}});
    setInterval(()=>{},1000);
  `;
  const owner = createProcessOwner();
  const wrapper = owner.spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script(depth)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  await withShutdownDeadline('Supervisor intent fixture', () => new Promise<void>(resolve => wrapper.on('message', message => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'fixture-ready') resolve();
  })));
  const pids = owner.groupIds();
  expect(pids).toHaveLength(depth + 2);
  await owner.stop();
  expect(wrapper.exitCode).toBe(0);
  expect(pids.map(pid => alive(pid))).toEqual(pids.map(() => false));
});
