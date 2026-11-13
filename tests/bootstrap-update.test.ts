import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

async function settled() { for (let i = 0; i < 16; i++) await Promise.resolve(); }

async function bootstrapHarness(options: { href?: string; storage?: Map<string, string>; storageFails?: boolean; updateStalls?: boolean } = {}) {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const source = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!source) throw new Error('The recovery bootstrap must be inline and independent of the entry bundle');
  const listeners = new Map<string, Set<(event: any) => void>>();
  const serviceListeners = new Map<string, Set<(event: any) => void>>();
  const events = (target: typeof listeners) => ({
    addEventListener: (name: string, callback: (event: any) => void) => { if (!target.has(name)) target.set(name, new Set()); target.get(name)!.add(callback); },
    removeEventListener: (name: string, callback: (event: any) => void) => target.get(name)?.delete(callback),
  });
  const dispatch = (name: string, event: object = {}) => { for (const callback of listeners.get(name) ?? []) callback(event); };
  const timers = new Map<number, { callback: () => void; delay: number; due: number }>();
  let nextTimer = 0;
  let now = 0;
  const storage = options.storage ?? new Map<string, string>();
  const root = { textContent: '' };
  const location = { href: options.href ?? 'https://banker.example/?session=kept#table', replace: vi.fn() };
  const entry = { tagName: 'SCRIPT', type: 'module', src: new URL('/assets/index-release.js', location.href).href };
  const history = { state: { retained: true }, replaceState: vi.fn() };
  const controller = { postMessage: vi.fn() };
  const registration = { update: vi.fn(() => options.updateStalls ? new Promise<void>(() => {}) : Promise.resolve()) };
  const serviceWorker = { ...events(serviceListeners), controller, register: vi.fn(async () => registration) };
  runInNewContext(source, {
    window: events(listeners), navigator: { serviceWorker }, location, history,
    document: { querySelector: (selector: string) => selector === 'script[type="module"][src]' ? entry : { content: 'html-B' }, getElementById: () => root },
    sessionStorage: {
      getItem: (key: string) => { if (options.storageFails) throw new Error('Unavailable'); return storage.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (options.storageFails) throw new Error('Unavailable'); storage.set(key, value); },
      removeItem: (key: string) => { if (options.storageFails) throw new Error('Unavailable'); storage.delete(key); },
    },
    setTimeout: (callback: () => void, delay: number) => { timers.set(++nextTimer, { callback, delay, due: now + delay }); return nextTimer; },
    clearTimeout: (id: number) => timers.delete(id), URL, Date, Math, Promise, Error,
  });
  return {
    dispatch, location, history, root, storage, controller, serviceWorker, registration,
    fail: () => dispatch('error', { target: entry }),
    evaluationFailure: () => dispatch('error', { filename: entry.src, message: 'Entry evaluation failed' }),
    started: () => dispatch('pb:app-started'),
    timer: (delay: number) => { const found = [...timers.entries()].find(([, timer]) => timer.delay === delay); if (found) { timers.delete(found[0]); found[1].callback(); } },
    advanceTo: (time: number) => {
      for (;;) {
        const found = [...timers.entries()].filter(([, timer]) => timer.due <= time).sort((a, b) => a[1].due - b[1].due)[0];
        if (!found) break;
        now = found[1].due;
        timers.delete(found[0]);
        found[1].callback();
      }
      now = time;
    },
    message: (data: unknown, source = controller) => { for (const callback of serviceListeners.get('message') ?? []) callback({ data, source }); },
  };
}

it('checks for a worker and recovers an initial entry failure with a cache-busted URL preserving the session and route', async () => {
  const harness = await bootstrapHarness({ href: 'https://banker.example/v/shared?session=kept&account=unchanged#table' });
  harness.fail();
  await settled();
  expect(harness.serviceWorker.register).toHaveBeenCalledExactlyOnceWith('/sw.js', { updateViaCache: 'none' });
  expect(harness.registration.update).toHaveBeenCalledOnce();
  expect(harness.location.replace).toHaveBeenCalledOnce();
  const next = new URL(harness.location.replace.mock.calls[0]![0]);
  expect(next.pathname).toBe('/v/shared');
  expect(next.searchParams.get('session')).toBe('kept');
  expect(next.searchParams.get('account')).toBe('unchanged');
  expect(next.hash).toBe('#table');
  expect(next.searchParams.get('__pb_boot')).toMatch(/\.1$/);
  expect(harness.controller.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ACTIVATE' }));
});

it('bounds a persistent initial entry failure to two navigations even when session storage is unavailable', async () => {
  let href = 'https://banker.example/?session=kept';
  for (let attempt = 0; attempt < 3; attempt++) {
    const harness = await bootstrapHarness({ href, storageFails: true });
    harness.fail();
    harness.fail();
    await settled();
    if (attempt < 2) {
      expect(harness.location.replace).toHaveBeenCalledOnce();
      href = harness.location.replace.mock.calls[0]![0];
    } else {
      expect(harness.location.replace).not.toHaveBeenCalled();
      expect(harness.serviceWorker.register).not.toHaveBeenCalled();
      expect(harness.root.textContent).toBe('Poker banker could not load. Check your connection and reopen the app.');
    }
  }
});

it('honors a higher recorded incident budget without changing unrelated session storage', async () => {
  const storage = new Map([
    ['pb-bootstrap-recovery', JSON.stringify({ path: '/?session=kept#table', incident: 'existing', attempts: 2 })],
    ['banker-auth', 'unchanged'], ['drafts', 'unchanged'], ['outbox', 'unchanged'],
  ]);
  const harness = await bootstrapHarness({ href: 'https://banker.example/?session=kept&__pb_boot=existing.1#table', storage });
  harness.fail();
  await settled();
  expect(harness.location.replace).not.toHaveBeenCalled();
  expect(storage.get('banker-auth')).toBe('unchanged');
  expect(storage.get('drafts')).toBe('unchanged');
  expect(storage.get('outbox')).toBe('unchanged');
});

it('coalesces resource, evaluation and chunk errors while discovery or the recovery navigation stalls', async () => {
  const harness = await bootstrapHarness({ updateStalls: true });
  harness.fail();
  harness.fail();
  harness.evaluationFailure();
  await settled();
  expect(harness.location.replace).not.toHaveBeenCalled();
  harness.timer(1500);
  await settled();
  expect(harness.location.replace).toHaveBeenCalledOnce();
  harness.fail();
  harness.dispatch('unhandledrejection', { reason: new Error('Loading chunk failed') });
  harness.dispatch('focus');
  await settled();
  expect(harness.location.replace).toHaveBeenCalledOnce();
});

it('waits for a healthy slow entry through 15, 18 and 30 seconds before handing off to the app', async () => {
  const harness = await bootstrapHarness();
  for (const elapsed of [15000, 18000, 30000]) {
    harness.advanceTo(elapsed);
    await settled();
    expect(harness.serviceWorker.register).not.toHaveBeenCalled();
    expect(harness.location.replace).not.toHaveBeenCalled();
  }
  harness.started();
  harness.evaluationFailure();
  harness.advanceTo(60000);
  await settled();
  expect(harness.serviceWorker.register).not.toHaveBeenCalled();
  expect(harness.location.replace).not.toHaveBeenCalled();
});

it('waits for a browser failure when an initial download remains stalled indefinitely', async () => {
  const harness = await bootstrapHarness();
  harness.advanceTo(24 * 60 * 60 * 1000);
  await settled();
  expect(harness.serviceWorker.register).not.toHaveBeenCalled();
  expect(harness.location.replace).not.toHaveBeenCalled();
  harness.fail();
  await settled();
  expect(harness.location.replace).toHaveBeenCalledOnce();
});

it('bounds top-level entry evaluation failures to two recovery navigations without session storage', async () => {
  let href = 'https://banker.example/?session=kept';
  for (let attempt = 0; attempt < 3; attempt++) {
    const harness = await bootstrapHarness({ href, storageFails: true });
    harness.evaluationFailure();
    await settled();
    if (attempt < 2) {
      expect(harness.serviceWorker.register).toHaveBeenCalledOnce();
      expect(harness.location.replace).toHaveBeenCalledOnce();
      href = harness.location.replace.mock.calls[0]![0];
    } else {
      expect(harness.serviceWorker.register).not.toHaveBeenCalled();
      expect(harness.location.replace).not.toHaveBeenCalled();
      expect(harness.root.textContent).toBe('Poker banker could not load. Check your connection and reopen the app.');
    }
  }
});

it('never reloads after the entry body starts, including during an outstanding discovery', async () => {
  const harness = await bootstrapHarness({ updateStalls: true });
  harness.fail();
  await settled();
  harness.started();
  harness.timer(1500);
  harness.advanceTo(30000);
  harness.fail();
  harness.evaluationFailure();
  harness.dispatch('unhandledrejection', { reason: new Error('Loading chunk failed') });
  await settled();
  expect(harness.location.replace).not.toHaveBeenCalled();
});

it('clears only recovery state on a healthy boot and hands release replies to the app', async () => {
  const storage = new Map([['pb-bootstrap-recovery', 'old'], ['drafts', 'kept']]);
  const harness = await bootstrapHarness({ href: 'https://banker.example/?session=kept&__pb_boot=existing.1#table', storage });
  const source = { postMessage: vi.fn() };
  harness.message({ type: 'CLIENT_RELEASE_REQUEST', requestId: 'C:1' }, source);
  expect(source.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'CLIENT_RELEASE', requestId: 'C:1', release: 'html-B', updateProtocol: 0 });
  harness.started();
  expect(harness.history.replaceState).toHaveBeenCalledExactlyOnceWith(harness.history.state, '', '/?session=kept#table');
  expect(storage.has('pb-bootstrap-recovery')).toBe(false);
  expect(storage.get('drafts')).toBe('kept');
  source.postMessage.mockClear();
  harness.message({ type: 'CLIENT_RELEASE_REQUEST', requestId: 'C:2' }, source);
  expect(source.postMessage).not.toHaveBeenCalled();
  harness.advanceTo(30000);
  expect(harness.location.replace).not.toHaveBeenCalled();
});

it('ignores unrelated resource errors before startup', async () => {
  const harness = await bootstrapHarness();
  harness.dispatch('error', { target: { tagName: 'IMG' } });
  harness.dispatch('error', { target: { tagName: 'SCRIPT', type: 'module', src: 'https://banker.example/assets/injected.js' } });
  harness.dispatch('error', { filename: 'chrome-extension://extension/content.js' });
  harness.dispatch('error', { filename: 'https://third-party.example/assets/index-release.js' });
  harness.dispatch('error', { filename: 'https://banker.example/unrelated.js' });
  harness.dispatch('error', { filename: 'https://banker.example/assets/image.png' });
  harness.dispatch('unhandledrejection', { reason: new Error('Unrelated failure') });
  await settled();
  expect(harness.serviceWorker.register).not.toHaveBeenCalled();
  expect(harness.location.replace).not.toHaveBeenCalled();
});
