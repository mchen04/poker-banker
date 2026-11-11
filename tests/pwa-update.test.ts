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
