import { spawn as nativeSpawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createProcessOwner, stopOwnedProcess, withShutdownDeadline } from '../scripts/owned-process';

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
};

it('owns a complete detached command tree and leaves an unrelated sibling alive', async () => {
  const owner = createProcessOwner();
  const sibling = nativeSpawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
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
    sibling.kill('SIGKILL');
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
  const child = nativeSpawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout!, 'data');
    await expect(stopOwnedProcess(child)).rejects.toThrow('not registered');
    expect(alive(child.pid!)).toBe(true);
  } finally { child.kill('SIGKILL'); }
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
