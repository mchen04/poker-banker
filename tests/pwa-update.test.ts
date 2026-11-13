import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

it('rechecks authentication busy state when an update finishes flushing local writes', async () => {
  const source = (await readFile(new URL('../src/client/pwa.ts', import.meta.url), 'utf8')).replace('import.meta.env.DEV', 'false');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const effects: (() => void | (() => void))[] = [];
  const holds = { sheetOpen: false, outboxCount: 0, busy: false };
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const flushing = new Promise<void>(resolve => { release = resolve; });
  let block = true;
  const worker = { postMessage: vi.fn() };
  const registration = { active: {}, waiting: worker, installing: null, addEventListener() {}, removeEventListener() {}, async update() {} };
  const react = {
    useState: (value: unknown) => [value, () => {}],
    useRef: (value: unknown) => ({ current: value }),
    useCallback: (callback: unknown) => callback,
    useEffect: (callback: () => void | (() => void)) => { effects.push(callback); },
  };
  const data = {
    flushDraftWrites: async () => { if (block) { started(); await flushing; } },
    hasAnyOutbox: async () => false,
    hasPendingLocalWrites: () => false,
    hasInFlightRequests: () => false,
  };
  const exports = {} as { usePwaUpdate: (value: typeof holds) => { activate: () => Promise<void> } };
  runInNewContext(compiled, {
    exports,
    require: (name: string) => { if (name === 'react') return react; if (name === './data') return data; throw new Error(`Unexpected module ${name}`); },
    navigator: { serviceWorker: { controller: { postMessage() {} }, addEventListener() {}, removeEventListener() {}, async register() { return registration; } } },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    window: { location: { reload: vi.fn() }, setInterval: () => 1, clearInterval() {}, addEventListener() {}, removeEventListener() {} },
    __APP_RELEASE__: 'busy-recheck', Map, Date, Error, String,
  });
  const update = exports.usePwaUpdate(holds);
  const cleanups = effects.map(effect => effect());
  try {
    await Promise.resolve();
    await Promise.resolve();
    const activating = update.activate();
    await entered;
    holds.busy = true;
    block = false;
    release();
    await activating;
    expect(worker.postMessage).not.toHaveBeenCalled();
    holds.busy = false;
    await update.activate();
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'ACTIVATE', updateProtocol: 1 });
  } finally { release(); for (const cleanup of cleanups) cleanup?.(); }
});

async function updateHarness(deferRegistration = false) {
  const source = (await readFile(new URL('../src/client/pwa.ts', import.meta.url), 'utf8')).replace('import.meta.env.DEV', 'false');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const effects: (() => void | (() => void))[] = [];
  const holds = { sheetOpen: true, outboxCount: 0, busy: false };
  const events = new EventTarget();
  const pageEvents = new EventTarget();
  const documentEvents = new EventTarget();
  const inputs: { disabled: boolean; readOnly: boolean; type: string; value: string; getClientRects: () => unknown[]; visibility: string }[] = [];
  const document = { visibilityState: 'visible', querySelectorAll: () => inputs, addEventListener: documentEvents.addEventListener.bind(documentEvents), removeEventListener: documentEvents.removeEventListener.bind(documentEvents) };
  const worker = { postMessage: vi.fn() };
  const controller = { postMessage: vi.fn() };
  const registration = { active: {}, waiting: worker, installing: null, addEventListener() {}, removeEventListener() {}, update: vi.fn(async () => {}) };
  const reload = vi.fn();
  const timers = new Map<number, () => void>();
  let finishRegistration!: () => void;
  const registered = deferRegistration ? new Promise<void>(resolve => { finishRegistration = resolve; }) : undefined;
  const react = {
    useState: (value: unknown) => [value, () => {}], useRef: (value: unknown) => ({ current: value }), useCallback: (callback: unknown) => callback,
    useEffect: (callback: () => void | (() => void)) => { effects.push(callback); },
  };
  const data = { flushDraftWrites: vi.fn(async () => {}), hasAnyOutbox: vi.fn(async () => false), hasPendingLocalWrites: vi.fn(() => false), hasInFlightRequests: vi.fn(() => false) };
  const exports = {} as { usePwaUpdate: (value: typeof holds) => { activate: () => Promise<void> } };
  runInNewContext(compiled, {
    exports, require: (name: string) => { if (name === 'react') return react; if (name === './data') return data; throw new Error(`Unexpected module ${name}`); },
    navigator: { serviceWorker: { controller, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), async register() { if (registered) await registered; return registration; } } },
    document, window: { location: { reload }, getComputedStyle: (input: typeof inputs[number]) => ({ visibility: input.visibility }), setInterval: (callback: () => void, delay: number) => { timers.set(delay, callback); return delay; }, clearInterval: (id: number) => timers.delete(id), addEventListener: pageEvents.addEventListener.bind(pageEvents), removeEventListener: pageEvents.removeEventListener.bind(pageEvents) },
    __APP_RELEASE__: 'manual-reconciliation', Map, Date, Error, String,
  });
  const update = exports.usePwaUpdate(holds);
  const cleanups = effects.map(effect => effect());
  await Promise.resolve(); await Promise.resolve();
  return {
    update, holds, document, inputs, worker, controller, registration, reload, data, timers, finishRegistration: () => finishRegistration?.(),
    tick: () => timers.get(3000)?.(), discover: () => timers.get(60000)?.(),
    dispatch: (name: string) => (name === 'visibilitychange' ? documentEvents : pageEvents).dispatchEvent(new Event(name)),
    message: (data: unknown, source: unknown = controller) => events.dispatchEvent(Object.assign(new Event('message'), { data, source })),
    controllerChanged: () => events.dispatchEvent(new Event('controllerchange')),
    close: () => { for (const cleanup of cleanups) cleanup?.(); },
  };
}

it('keeps an accepted manual update moving while the worker is still waiting and a sheet stays open', async () => {
  const harness = await updateHarness();
  try {
    await harness.update.activate();
    expect(harness.worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'ACTIVATE', updateProtocol: 1 });
    harness.tick();
    await vi.waitFor(() => expect(harness.worker.postMessage).toHaveBeenCalledTimes(2));
    harness.controllerChanged();
    await vi.waitFor(() => expect(harness.reload).toHaveBeenCalledOnce());
  } finally { harness.close(); }
});

it('retains manual reload intent when controller change meets a failed draft flush', async () => {
  const harness = await updateHarness();
  try {
    await harness.update.activate();
    harness.data.flushDraftWrites.mockRejectedValueOnce(new Error('Not saved on this device'));
    harness.controllerChanged();
    await vi.waitFor(() => expect(harness.data.flushDraftWrites).toHaveBeenCalledTimes(2));
    expect(harness.reload).not.toHaveBeenCalled();
    harness.registration.waiting = null as unknown as typeof harness.worker;
    harness.tick();
    await vi.waitFor(() => expect(harness.reload).toHaveBeenCalledOnce());
  } finally { harness.close(); }
});

it.each(['hidden', 'busy', 'outbox', 'pending', 'request'] as const)('keeps the %s guard while reconciling an accepted manual update', async guard => {
  const harness = await updateHarness();
  try {
    await harness.update.activate();
    if (guard === 'hidden') harness.document.visibilityState = 'hidden';
    if (guard === 'busy') harness.holds.busy = true;
    if (guard === 'outbox') harness.holds.outboxCount = 1;
    if (guard === 'pending') harness.data.hasPendingLocalWrites.mockReturnValue(true);
    if (guard === 'request') harness.data.hasInFlightRequests.mockReturnValue(true);
    harness.tick();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(1);
    expect(harness.reload).not.toHaveBeenCalled();
    harness.document.visibilityState = 'visible'; harness.holds.busy = false; harness.holds.outboxCount = 0; harness.data.hasPendingLocalWrites.mockReturnValue(false); harness.data.hasInFlightRequests.mockReturnValue(false);
    harness.tick();
    await vi.waitFor(() => expect(harness.worker.postMessage).toHaveBeenCalledTimes(2));
  } finally { harness.close(); }
});

it('does not treat an automatic check or a quota-rejected click as accepted manual intent', async () => {
  const harness = await updateHarness();
  try {
    harness.tick();
    await Promise.resolve();
    expect(harness.worker.postMessage).not.toHaveBeenCalled();
    harness.data.flushDraftWrites.mockRejectedValueOnce(new Error('Not saved on this device'));
    await expect(harness.update.activate()).rejects.toThrow('Not saved on this device');
    harness.tick();
    await Promise.resolve(); await Promise.resolve();
    expect(harness.worker.postMessage).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();
    await harness.update.activate();
    expect(harness.worker.postMessage).toHaveBeenCalledOnce();
  } finally { harness.close(); }
});

it('retains explicit Reload intent accepted during a background request while a sheet stays open', async () => {
  const harness = await updateHarness();
  try {
    harness.data.hasInFlightRequests.mockReturnValue(true);
    await harness.update.activate();
    expect(harness.data.flushDraftWrites).toHaveBeenCalledOnce();
    expect(harness.worker.postMessage).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();
    harness.data.hasInFlightRequests.mockReturnValue(false);
    harness.tick();
    await settled();
    expect(harness.worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'ACTIVATE', updateProtocol: 1 });
    harness.controllerChanged();
    await settled();
    expect(harness.reload).toHaveBeenCalledOnce();
  } finally { harness.close(); }
});

it('does not retain explicit Reload intent when a request overlaps a quota-rejected flush', async () => {
  const harness = await updateHarness();
  try {
    harness.data.hasInFlightRequests.mockReturnValue(true);
    harness.data.flushDraftWrites.mockRejectedValueOnce(new Error('Not saved on this device'));
    await expect(harness.update.activate()).rejects.toThrow('Not saved on this device');
    harness.data.hasInFlightRequests.mockReturnValue(false);
    harness.tick();
    await settled();
    expect(harness.worker.postMessage).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();
  } finally { harness.close(); }
});

async function settled() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

it('discovers on launch, each foreground entry, reconnection and cached asset access', async () => {
  const harness = await updateHarness();
  try {
    await settled();
    expect(harness.registration.update).toHaveBeenCalledOnce();
    for (const name of ['visibilitychange', 'pageshow', 'focus', 'online']) {
      harness.dispatch(name);
      await settled();
    }
    harness.message({ type: 'ASSET_ACCESSED' });
    await settled();
    expect(harness.registration.update).toHaveBeenCalledTimes(6);
    harness.document.visibilityState = 'hidden';
    for (const name of ['visibilitychange', 'pageshow', 'focus', 'online']) harness.dispatch(name);
    harness.message({ type: 'ASSET_ACCESSED' });
    await settled();
    expect(harness.registration.update).toHaveBeenCalledTimes(6);
  } finally { harness.close(); }
});

it('checks an untouched visible page every minute while keeping the three-second safe activation retry', async () => {
  const harness = await updateHarness();
  try {
    await settled();
    expect([...harness.timers.keys()].sort((a, b) => a - b)).toEqual([3000, 60000]);
    harness.tick();
    await settled();
    expect(harness.registration.update).toHaveBeenCalledOnce();
    harness.discover();
    await settled();
    expect(harness.registration.update).toHaveBeenCalledTimes(2);
    harness.document.visibilityState = 'hidden';
    harness.discover();
    await settled();
    expect(harness.registration.update).toHaveBeenCalledTimes(2);
    harness.document.visibilityState = 'visible';
    harness.dispatch('visibilitychange');
    await settled();
    expect(harness.registration.update).toHaveBeenCalledTimes(3);
    harness.close();
    expect(harness.timers.size).toBe(0);
  } finally { harness.close(); }
});

it('checks on the first discovery interval even when registration finishes after the timer was created', async () => {
  const harness = await updateHarness(true);
  try {
    expect(harness.registration.update).not.toHaveBeenCalled();
    expect(harness.timers.has(60000)).toBe(true);
    harness.finishRegistration();
    await settled();
    expect(harness.registration.update).toHaveBeenCalledOnce();
    harness.discover();
    await settled();
    expect(harness.registration.update).toHaveBeenCalledTimes(2);
  } finally { harness.finishRegistration(); harness.close(); }
});

it('coalesces discovery while the browser update is still running', async () => {
  const harness = await updateHarness();
  let release!: () => void;
  try {
    await settled();
    harness.registration.update.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    harness.dispatch('focus');
    harness.dispatch('pageshow');
    harness.message({ type: 'ASSET_ACCESSED' });
    expect(harness.registration.update).toHaveBeenCalledTimes(2);
    release();
    await settled();
    harness.message({ type: 'ASSET_ACCESSED' });
    await settled();
    expect(harness.registration.update).toHaveBeenCalledTimes(3);
  } finally { release?.(); harness.close(); }
});

it.each(['activation', 'reload'] as const)('waits when an HTTP request starts during the %s draft flush', async phase => {
  const harness = await updateHarness();
  try {
    if (phase === 'reload') await harness.update.activate();
    harness.data.flushDraftWrites.mockImplementationOnce(async () => { harness.data.hasInFlightRequests.mockReturnValue(true); });
    if (phase === 'activation') await harness.update.activate();
    else { harness.controllerChanged(); await settled(); }
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(phase === 'activation' ? 0 : 1);
    expect(harness.reload).not.toHaveBeenCalled();
    harness.data.hasInFlightRequests.mockReturnValue(false);
    if (phase === 'activation') await harness.update.activate();
    else { harness.tick(); await settled(); }
    if (phase === 'activation') expect(harness.worker.postMessage).toHaveBeenCalledOnce();
    else expect(harness.reload).toHaveBeenCalledOnce();
  } finally { harness.close(); }
});

it('holds a page claimed by another tab until its sheet closes and announces the page release', async () => {
  const harness = await updateHarness();
  try {
    expect(harness.controller.postMessage).toHaveBeenCalledWith({ type: 'CLIENT_RELEASE', release: 'manual-reconciliation', updateProtocol: 1 });
    harness.controllerChanged();
    await settled();
    expect(harness.reload).not.toHaveBeenCalled();
    harness.holds.sheetOpen = false;
    harness.tick();
    await settled();
    expect(harness.reload).toHaveBeenCalledOnce();
    const source = { postMessage: vi.fn() };
    harness.message({ type: 'CLIENT_RELEASE_REQUEST', requestId: 'new-worker:1' }, source);
    expect(source.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'CLIENT_RELEASE', requestId: 'new-worker:1', release: 'manual-reconciliation', updateProtocol: 1 });
  } finally { harness.close(); }
});

it('does not infer release ordering or reload from an initial worker version mismatch', async () => {
  const harness = await updateHarness();
  try {
    harness.holds.sheetOpen = false;
    harness.message({ type: 'WORKER_RELEASE', release: 'older-worker' });
    await settled();
    expect(harness.reload).not.toHaveBeenCalled();
  } finally { harness.close(); }
});

it('holds automatic updates for a visible unsheeted edit while explicit Reload keeps its existing consent', async () => {
  const harness = await updateHarness();
  try {
    harness.holds.sheetOpen = false;
    harness.inputs.push({ disabled: false, readOnly: false, type: 'search', value: 'Unfinished search', getClientRects: () => [{}], visibility: 'visible' });
    harness.tick();
    await settled();
    expect(harness.worker.postMessage).not.toHaveBeenCalled();
    await harness.update.activate();
    expect(harness.worker.postMessage).toHaveBeenCalledOnce();
    harness.controllerChanged();
    await settled();
    expect(harness.reload).toHaveBeenCalledOnce();
  } finally { harness.close(); }
});

it.each(['empty', 'disabled', 'readOnly', 'checkbox', 'hidden', 'offscreen', 'invisible'] as const)('does not hold automatic updates for %s input', async kind => {
  const harness = await updateHarness();
  try {
    harness.holds.sheetOpen = false;
    harness.inputs.push({ disabled: kind === 'disabled', readOnly: kind === 'readOnly', type: kind === 'checkbox' || kind === 'hidden' ? kind : 'text', value: kind === 'empty' ? '' : 'Default', getClientRects: () => kind === 'offscreen' ? [] : [{}], visibility: kind === 'invisible' ? 'hidden' : 'visible' });
    harness.tick();
    await settled();
    expect(harness.worker.postMessage).toHaveBeenCalledOnce();
  } finally { harness.close(); }
});

it('starts one navigation when lifecycle events and timer flushes overlap and navigation stalls', async () => {
  const harness = await updateHarness();
  let release!: () => void;
  try {
    harness.holds.sheetOpen = false;
    const flushing = new Promise<void>(resolve => { release = resolve; });
    harness.data.flushDraftWrites.mockImplementation(() => flushing);
    harness.controllerChanged();
    for (const name of ['visibilitychange', 'pageshow', 'focus']) harness.dispatch(name);
    harness.tick();
    expect(harness.data.flushDraftWrites.mock.calls.length).toBeGreaterThan(1);
    release();
    await settled();
    expect(harness.reload).toHaveBeenCalledOnce();
    for (let i = 0; i < 5; i++) {
      harness.tick();
      harness.dispatch('focus');
      harness.dispatch('pageshow');
      harness.controllerChanged();
      await settled();
    }
    await harness.update.activate();
    expect(harness.reload).toHaveBeenCalledOnce();
  } finally { release?.(); harness.close(); }
});

it('rechecks the reload guards after the asynchronous outbox read', async () => {
  const harness = await updateHarness();
  let release!: (value: boolean) => void;
  try {
    harness.holds.sheetOpen = false;
    harness.data.hasAnyOutbox.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
    harness.controllerChanged();
    await settled();
    harness.data.hasInFlightRequests.mockReturnValue(true);
    release(false);
    await settled();
    expect(harness.reload).not.toHaveBeenCalled();
    harness.data.hasInFlightRequests.mockReturnValue(false);
    harness.tick();
    await settled();
    expect(harness.reload).toHaveBeenCalledOnce();
  } finally { release?.(false); harness.close(); }
});
