import { AsyncLocalStorage } from 'node:async_hooks';
import { ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export const SHUTDOWN_GRACE_MS = 3000;
type Phase = 'process' | 'database';
type CleanupPhase = 'pool' | 'database' | 'cleanup';
type Group = { id: string; pid: number; phase: Phase; child?: ChildProcess; closed?: Promise<void>; control?: Duplex; intents?: Map<string, { group: Group; expected: string; resolve: (gone: boolean) => void; reject: (error: Error) => void }>; descendants: Group[]; parent?: Group; retired?: boolean; handedOff?: boolean; termRequested?: boolean; error?: Error; stopping?: Promise<void> };
type Cleanup = { label: string; phase: CleanupPhase; action: () => unknown | Promise<unknown>; pending?: Promise<unknown> };
type NativeOptions = { file: string; detached?: boolean; stdio?: SpawnOptions['stdio']; envPairs?: string[] };
type SharedState = { scope: AsyncLocalStorage<{ owner: ProcessOwner; phase: Phase }>; registered: WeakMap<ChildProcess, Group>; capture: WeakMap<ProcessOwner, (child: ChildProcess, phase: Phase, token: string, controlFd: number) => void>; groups: Map<string, Group>; upstream?: Socket; upstreamDetached?: boolean; installed: boolean };
const sharedKey = Symbol.for('poker-banker.owned-process');
const shared = (globalThis as typeof globalThis & { [key: symbol]: SharedState })[sharedKey] ??= { scope: new AsyncLocalStorage(), registered: new WeakMap(), capture: new WeakMap(), groups: new Map(), installed: false };
const { scope, registered, capture } = shared;
const nativePrototype = ChildProcess.prototype as ChildProcess & { spawn(options: NativeOptions): number };
const nativeSpawn = nativePrototype.spawn;

export async function withShutdownDeadline<T>(label: string, action: () => Promise<T> | T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded shutdown deadline (${SHUTDOWN_GRACE_MS}ms)`)), SHUTDOWN_GRACE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function exists(group: Group) {
  if (group.retired) return false;
  try { process.kill(-group.pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') { group.retired = true; return false; }
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

function signal(group: Group, value: NodeJS.Signals) {
  if (group.retired) return false;
  try { if (!process.kill(-group.pid, value)) throw new Error(`Owned process group did not receive ${value}`); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; group.retired = true; return false; }
}

async function waitGone(group: Group) {
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (exists(group)) {
    if (Date.now() >= deadline) throw new Error(`Owned process group ${group.pid} is still running`);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

function upstream(message: Record<string, unknown>, force = false) {
  if (shared.upstreamDetached && !force) return true;
  const fd = Number(process.env.PB_OWNED_CONTROL_FD);
  const token = process.env.PB_OWNED_CONTROL_TOKEN;
  if (!Number.isSafeInteger(fd) || fd < 3 || !token || Number(process.env.PB_OWNED_CONTROL_PARENT_PID) !== process.ppid) return true;
  try { writeSync(fd, `${JSON.stringify({ ...message, token })}\n`); return true; }
  catch { return false; }
}

async function authorizeTerm(group: Group): Promise<boolean> {
  if (!exists(group)) return true;
  if (group.child) { group.termRequested = true; return false; }
  const route = group.parent;
  if (!route?.control || route.control.destroyed || route.control.writableEnded) return false;
  const request = randomUUID();
  try {
    const gone = await withShutdownDeadline('Owned supervisor TERM intent', () => new Promise<boolean>((resolve, reject) => {
      (route.intents ??= new Map()).set(request, { group, expected: 'pb-owned-term-ack', resolve, reject });
      route.control!.write(`${JSON.stringify({ type: 'pb-owned-term', token: route.id, id: group.id, pid: group.pid, request })}\n`, error => { if (error) reject(error); });
    }));
    if (gone) group.retired = true;
    else group.termRequested = true;
    return gone;
  } finally { route.intents?.delete(request); }
}

function stopGroup(group: Group): Promise<void> {
  return group.stopping ??= (async () => {
    const errors: unknown[] = [];
    try {
      if (exists(group)) {
        try { await authorizeTerm(group); } catch (error) { errors.push(error); }
        try { if (signal(group, 'SIGTERM')) group.termRequested = true; signal(group, 'SIGCONT'); await waitGone(group); }
        catch (error) {
          errors.push(error, new Error(`Owned process group ${group.pid} required SIGKILL`));
          try { signal(group, 'SIGKILL'); await waitGone(group); } catch (failure) { errors.push(failure); }
        }
      }
    } catch (error) { errors.push(error); }
    if (group.closed) {
      try { await withShutdownDeadline('Owned process channels', () => group.closed!); } catch (error) { errors.push(error); }
    }
    if (group.error) errors.push(group.error);
    if (group.child?.exitCode !== null && group.child?.exitCode !== undefined && group.child.exitCode !== 0 && !(group.termRequested && group.child.exitCode === 143)) errors.push(new Error(`Owned process exited ${group.child.exitCode}`));
    if (group.child?.signalCode && !(group.termRequested && group.child.signalCode === 'SIGTERM')) errors.push(new Error(`Owned process exited ${group.child.signalCode}`));
    if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; '));
  })();
}

async function stopTree(group: Group) {
  const errors: unknown[] = [];
  try { await stopGroup(group); } catch (error) { errors.push(error); }
  for (let index = group.descendants.length - 1; index >= 0; index--) {
    try { await stopTree(group.descendants[index]!); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; '));
}

export function stopOwned(child: ChildProcess): Promise<void> {
  const group = registered.get(child);
  if (!group) return Promise.reject(new Error('Process is not registered to an owner'));
  return group.pid ? stopTree(group) : Promise.reject(group.error ?? new Error('Owned process failed to start'));
}

export const stopOwnedProcess = stopOwned;

export class ProcessOwner {
  private readonly controller = new AbortController();
  private readonly groups = new Map<number, Group>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly cleanups: Cleanup[] = [];
  private readonly children = new Set<ProcessOwner>();
  private readonly parent: ProcessOwner | undefined;
  private readonly phase: Phase;
  private stopping: Promise<void> | undefined;
  private processesStopping: Promise<void> | undefined;
  readonly signal = this.controller.signal;

  constructor(options: { phase?: Phase; parent?: ProcessOwner } = {}) {
    capture.set(this, (child, phase, token, controlFd) => this.register(child, phase, token, controlFd));
    this.parent = options.parent ?? scope.getStore()?.owner;
    this.phase = options.phase ?? scope.getStore()?.phase ?? 'process';
    this.parent?.children.add(this);
    if (this.parent?.signal.aborted) this.cancel();
  }

  checkpoint() {
    if (this.signal.aborted) throw new Error('Owned process owner is stopping');
  }

  cancel() {
    if (!this.signal.aborted) this.controller.abort();
    for (const child of this.children) child.cancel();
  }

  spawn(executable: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess {
    this.checkpoint();
    const phase = scope.getStore()?.owner === this ? scope.getStore()!.phase : this.phase;
    return scope.run({ owner: this, phase }, () => spawn(executable, args, options));
  }

  launch<T>(action: () => Promise<T> | T, phase: Phase = this.phase): Promise<T> {
    this.checkpoint();
    let pending: Promise<T>;
    try { pending = Promise.resolve(scope.run({ owner: this, phase }, action)); }
    catch (error) { pending = Promise.reject(error); }
    this.track(pending);
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => reject(new Error('Owned process owner is stopping'));
      this.signal.addEventListener('abort', cancelled, { once: true });
      pending.then(value => { this.signal.removeEventListener('abort', cancelled); if (this.signal.aborted) cancelled(); else resolve(value); }, error => { this.signal.removeEventListener('abort', cancelled); reject(error); });
      if (this.signal.aborted) cancelled();
    });
  }

  addCleanup(label: string, phase: CleanupPhase, action: () => unknown | Promise<unknown>) {
    this.checkpoint();
    this.registerCleanup({ label, phase, action });
  }

  private registerCleanup(cleanup: Cleanup) {
    this.cleanups.push(cleanup);
    this.parent?.registerCleanup(cleanup);
  }

  private track(pending: Promise<unknown>) {
    this.pending.add(pending);
    pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    this.parent?.track(pending);
  }

  private register(child: ChildProcess, phase: Phase, token: string, controlFd: number) {
    const group: Group = { id: token, pid: child.pid!, phase, child, control: child.stdio[controlFd] as Duplex | undefined, closed: new Promise(resolve => child.once('close', () => resolve())), descendants: [] };
    registered.set(child, group);
    child.on('error', error => { group.error = error; });
    if (!child.pid) { group.error = new Error('Owned process failed to start'); this.groups.set(-this.groups.size - 1, group); return; }
    this.registerGroup(group);
    child.once('close', () => {
      const retire = () => {
        try {
          if (!exists(group)) { if (!group.handedOff) this.publish(group, 'pb-owned-group-gone'); }
          else setTimeout(retire, 10).unref();
        } catch (error) { group.error = error instanceof Error ? error : new Error(String(error)); }
      };
      retire();
    });
    const receive = (message: unknown) => {
      if (group.handedOff || !message || typeof message !== 'object' || !('type' in message) || !('token' in message) || message.token !== token || !('id' in message) || typeof message.id !== 'string' || !('pid' in message) || !Number.isSafeInteger(message.pid) || Number(message.pid) <= 0 || message.pid === process.pid) return;
      const pid = Number(message.pid);
      if ((message.type === 'pb-owned-term-ack' || message.type === 'pb-owned-handoff-ack') && 'request' in message && typeof message.request === 'string') {
        const intent = group.intents?.get(message.request);
        if (!intent || intent.expected !== message.type || intent.group.id !== message.id || intent.group.pid !== pid) return;
        if ('status' in message && message.status === 'gone') intent.resolve(true);
        else if ('status' in message && message.status === 'ready') intent.resolve(false);
        else intent.reject(new Error('Owned supervisor TERM intent was rejected'));
        return;
      }
      if (pid === child.pid) return;
      const previous = this.groups.get(pid);
      if (message.type === 'pb-owned-group-gone' && previous?.id === message.id) { previous.retired = true; this.publish(previous, 'pb-owned-group-gone'); return; }
      if (message.type === 'pb-owned-group-handoff' && previous?.id === message.id) { this.removeGroup(previous); this.publish(previous, 'pb-owned-group-handoff'); return; }
      if (message.type !== 'pb-owned-group' || (previous && !previous.retired) || !('phase' in message) || (message.phase !== 'process' && message.phase !== 'database')) return;
      const descendant: Group = { id: message.id, pid, phase: message.phase, descendants: [], parent: group };
      group.descendants.push(descendant);
      this.registerGroup(descendant);
    };
    const control = group.control;
    let buffer = '';
    control?.setEncoding('utf8');
    control?.on('data', (data: string) => {
      buffer += data;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try { receive(JSON.parse(line)); } catch { group.error = new Error('Owned process control record was invalid'); }
      }
      if (buffer.length > 65536) { buffer = ''; group.error = new Error('Owned process control record exceeded its limit'); }
    });
    control?.on('error', error => { group.error = error; });
  }

  private registerGroup(group: Group) {
    this.groups.set(group.pid, group);
    shared.groups.set(group.id, group);
    if (this.parent) this.parent.registerGroup(group);
    else this.publish(group, 'pb-owned-group');
  }

  private publish(group: Group, type: string) {
    if (this.parent) this.parent.publish(group, type);
    else {
      if (!upstream({ type, id: group.id, pid: group.pid, phase: group.phase })) {
        this.cancel();
        void this.stop().catch(() => { process.exitCode = 1; });
      }
    }
  }

  private removeGroup(group: Group, detach = true) {
    group.handedOff = true;
    if (this.groups.get(group.pid) === group) this.groups.delete(group.pid);
    for (const descendant of group.descendants) this.removeGroup(descendant, false);
    if (detach && group.parent) group.parent.descendants = group.parent.descendants.filter(descendant => descendant !== group);
    this.parent?.removeGroup(group, detach);
  }

  async handoff(child: ChildProcess) {
    this.checkpoint();
    const group = registered.get(child);
    if (!group || this.groups.get(group.pid) !== group) throw new Error('Process is not registered to this owner');
    if (!group.control || group.control.destroyed || group.control.writableEnded) throw new Error('Owned process has no live handoff channel');
    const request = randomUUID();
    const pending = withShutdownDeadline('Owned process handoff', () => new Promise<boolean>((resolve, reject) => {
      (group.intents ??= new Map()).set(request, { group, expected: 'pb-owned-handoff-ack', resolve, reject });
      group.control!.write(`${JSON.stringify({ type: 'pb-owned-handoff', token: group.id, id: group.id, pid: group.pid, request })}\n`, error => { if (error) reject(error); });
    }));
    const transaction = pending.then(() => {
      this.removeGroup(group);
      this.publish(group, 'pb-owned-group-handoff');
    }).finally(() => group.intents?.delete(request));
    this.track(transaction);
    await transaction;
  }

  private async joinPending(errors: unknown[]) {
    try { await withShutdownDeadline('Owned pending launches', () => Promise.allSettled([...this.pending])); }
    catch (error) { errors.push(error); }
  }

  private async stopPhase(phase: Phase, errors: unknown[]) {
    const visited = new Set<Group>();
    while (true) {
      const groups = [...this.groups.values()].filter(group => group.phase === phase && !visited.has(group)).reverse();
      if (!groups.length) return;
      for (const group of groups) {
        visited.add(group);
        try { if (group.pid) await stopGroup(group); else throw group.error; } catch (error) { errors.push(error); }
      }
    }
  }

  private async cleanupPhase(phase: CleanupPhase, errors: unknown[]) {
    for (const cleanup of this.cleanups.filter(cleanup => cleanup.phase === phase).reverse()) {
      try { await (cleanup.pending ??= withShutdownDeadline(cleanup.label, cleanup.action)); } catch (error) { errors.push(error); }
    }
  }

  groupsGone(phase?: Phase) {
    return [...this.groups.values()].every(group => !group.pid || (phase && group.phase !== phase) || !exists(group));
  }

  groupIds(phase?: Phase) {
    return [...this.groups.values()].filter(group => group.pid && (!phase || group.phase === phase) && exists(group)).map(group => group.pid);
  }

  signalGroups(value: 'SIGSTOP' | 'SIGCONT') {
    if (value === 'SIGSTOP') this.checkpoint();
    const signalled: number[] = [];
    for (const group of this.groups.values()) if (group.pid && exists(group) && signal(group, value)) signalled.push(group.pid);
    return signalled;
  }

  stopProcesses(): Promise<void> {
    this.cancel();
    return this.processesStopping ??= (async () => {
      const errors: unknown[] = [];
      await this.joinPending(errors);
      await this.stopPhase('process', errors);
      if (this.groupsGone('process')) await this.stopPhase('database', errors);
      if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; '));
    })();
  }

  stop(): Promise<void> {
    this.cancel();
    return this.stopping ??= (async () => {
      const errors: unknown[] = [];
      await this.joinPending(errors);
      await this.stopPhase('process', errors);
      if (this.groupsGone('process')) {
        await this.cleanupPhase('pool', errors);
        await this.cleanupPhase('database', errors);
        await this.stopPhase('database', errors);
        if (this.groupsGone()) {
          await this.cleanupPhase('cleanup', errors);
        }
      }
      if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; '));
    })();
  }
}

export function createProcessOwner(options: ConstructorParameters<typeof ProcessOwner>[0] = {}) { return new ProcessOwner(options); }
export function spawnOwned(owner: ProcessOwner, executable: string, args: readonly string[] = [], options: SpawnOptions = {}) { return owner.spawn(executable, args, options); }

if (!shared.installed) nativePrototype.spawn = function (options: NativeOptions) {
  const active = scope.getStore();
  if (!active) return nativeSpawn.call(this, options);
  active.owner.checkpoint();
  const token = randomUUID();
  const stdio = Array.isArray(options.stdio) ? [...options.stdio] : [options.stdio ?? 'pipe', options.stdio ?? 'pipe', options.stdio ?? 'pipe'];
  while (stdio.length < 3) stdio.push('pipe');
  const controlFd = stdio.length;
  stdio.push('pipe');
  const ownedOptions = { ...options, detached: true, stdio: stdio as SpawnOptions['stdio'], envPairs: (options.envPairs ?? []).filter(value => !value.startsWith('PB_OWNED_CONTROL_') && !value.startsWith('PB_OWNED_PROCESS_TOKEN=')) };
  ownedOptions.envPairs.push(`PB_OWNED_CONTROL_TOKEN=${token}`, `PB_OWNED_CONTROL_FD=${controlFd}`, `PB_OWNED_CONTROL_PARENT_PID=${process.pid}`);
  const result = nativeSpawn.call(this, ownedOptions);
  capture.get(active.owner)!(this, active.phase, token, controlFd);
  return result;
};
shared.installed = true;

if (!shared.upstream && !shared.upstreamDetached && Number.isSafeInteger(Number(process.env.PB_OWNED_CONTROL_FD)) && Number(process.env.PB_OWNED_CONTROL_FD) >= 3 && process.env.PB_OWNED_CONTROL_TOKEN && Number(process.env.PB_OWNED_CONTROL_PARENT_PID) === process.ppid) {
  const socket = new Socket({ fd: Number(process.env.PB_OWNED_CONTROL_FD), readable: true, writable: true });
  shared.upstream = socket;
  socket.unref();
  socket.on('error', () => {});
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (data: string) => {
    buffer += data;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message: unknown;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || typeof message !== 'object' || !('type' in message) || (message.type !== 'pb-owned-term' && message.type !== 'pb-owned-handoff') || !('token' in message) || message.token !== process.env.PB_OWNED_CONTROL_TOKEN || !('id' in message) || typeof message.id !== 'string' || !('pid' in message) || !Number.isSafeInteger(message.pid) || !('request' in message) || typeof message.request !== 'string') continue;
      const { id, pid, request } = message;
      if (message.type === 'pb-owned-handoff') {
        if (id !== process.env.PB_OWNED_CONTROL_TOKEN || pid !== process.pid) continue;
        shared.upstreamDetached = true;
        upstream({ type: 'pb-owned-handoff-ack', id, pid, request, status: 'ready' }, true);
        socket.destroy();
        continue;
      }
      const group = shared.groups.get(id);
      if (!group || group.pid !== pid || group.handedOff) { upstream({ type: 'pb-owned-term-ack', id, pid, request, status: 'rejected' }); continue; }
      void authorizeTerm(group).then(gone => upstream({ type: 'pb-owned-term-ack', id, pid, request, status: gone ? 'gone' : 'ready' }), () => upstream({ type: 'pb-owned-term-ack', id, pid, request, status: 'rejected' }));
    }
    if (buffer.length > 65536) buffer = '';
  });
}
