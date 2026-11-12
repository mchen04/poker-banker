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
  };
  const exports = {} as { usePwaUpdate: (value: typeof holds) => { activate: () => Promise<void> } };
  runInNewContext(compiled, {
    exports,
    require: (name: string) => { if (name === 'react') return react; if (name === './data') return data; throw new Error(`Unexpected module ${name}`); },
    navigator: { serviceWorker: { controller: {}, addEventListener() {}, removeEventListener() {}, async register() { return registration; } } },
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
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'ACTIVATE' });
  } finally { release(); for (const cleanup of cleanups) cleanup?.(); }
});

async function updateHarness() {
  const source = (await readFile(new URL('../src/client/pwa.ts', import.meta.url), 'utf8')).replace('import.meta.env.DEV', 'false');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const effects: (() => void | (() => void))[] = [];
  const holds = { sheetOpen: true, outboxCount: 0, busy: false };
  const events = new EventTarget();
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const worker = { postMessage: vi.fn() };
  const registration = { active: {}, waiting: worker, installing: null, addEventListener() {}, removeEventListener() {}, async update() {} };
  const reload = vi.fn();
  let tick = () => {};
  const react = {
    useState: (value: unknown) => [value, () => {}], useRef: (value: unknown) => ({ current: value }), useCallback: (callback: unknown) => callback,
    useEffect: (callback: () => void | (() => void)) => { effects.push(callback); },
  };
  const data = { flushDraftWrites: vi.fn(async () => {}), hasAnyOutbox: vi.fn(async () => false), hasPendingLocalWrites: vi.fn(() => false) };
  const exports = {} as { usePwaUpdate: (value: typeof holds) => { activate: () => Promise<void> } };
  runInNewContext(compiled, {
    exports, require: (name: string) => { if (name === 'react') return react; if (name === './data') return data; throw new Error(`Unexpected module ${name}`); },
    navigator: { serviceWorker: { controller: {}, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), async register() { return registration; } } },
    document, window: { location: { reload }, setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval() {}, addEventListener() {}, removeEventListener() {} },
    __APP_RELEASE__: 'manual-reconciliation', Map, Date, Error, String,
  });
  const update = exports.usePwaUpdate(holds);
  const cleanups = effects.map(effect => effect());
  await Promise.resolve(); await Promise.resolve();
  return { update, holds, document, worker, registration, reload, data, tick: () => tick(), controllerChanged: () => events.dispatchEvent(new Event('controllerchange')), close: () => { for (const cleanup of cleanups) cleanup?.(); } };
}

it('keeps an accepted manual update moving while the worker is still waiting and a sheet stays open', async () => {
  const harness = await updateHarness();
  try {
    await harness.update.activate();
    expect(harness.worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'ACTIVATE' });
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

it.each(['hidden', 'busy', 'outbox', 'pending'] as const)('keeps the %s guard while reconciling an accepted manual update', async guard => {
  const harness = await updateHarness();
  try {
    await harness.update.activate();
    if (guard === 'hidden') harness.document.visibilityState = 'hidden';
    if (guard === 'busy') harness.holds.busy = true;
    if (guard === 'outbox') harness.holds.outboxCount = 1;
    if (guard === 'pending') harness.data.hasPendingLocalWrites.mockReturnValue(true);
    harness.tick();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(harness.worker.postMessage).toHaveBeenCalledTimes(1);
    expect(harness.reload).not.toHaveBeenCalled();
    harness.document.visibilityState = 'visible'; harness.holds.busy = false; harness.holds.outboxCount = 0; harness.data.hasPendingLocalWrites.mockReturnValue(false);
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
