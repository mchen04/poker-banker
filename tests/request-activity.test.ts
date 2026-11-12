import { afterEach, expect, it, vi } from 'vitest';
import { api, bankerClient, discoverAccount, hasInFlightRequests, pollSession } from '../src/client/data';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function browser() { vi.stubGlobal('window', { setTimeout, clearTimeout, dispatchEvent() {} }); }

it.each(['discovery', 'auth', 'viewer', 'viewer-poll', 'banker-read', 'banker-command'] as const)('tracks a %s request synchronously through response body consumption', async kind => {
  browser();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; controller.enqueue(new TextEncoder().encode('{"ok":')); } }), { headers: { 'X-PB-Banker-ID': 'activity-owner' } });
  vi.stubGlobal('fetch', vi.fn(async () => response));
  const client = bankerClient('activity-owner');
  expect(hasInFlightRequests()).toBe(false);
  const pending = kind === 'discovery' ? discoverAccount()
    : kind === 'auth' ? api('/api/auth/login', 'POST', { username: 'activity', password: 'test' })
    : kind === 'viewer' ? api('/api/view/public-token')
    : kind === 'viewer-poll' ? pollSession('/api/view/public-token')
    : client.api('/api/sessions', kind === 'banker-command' ? 'POST' : 'GET', kind === 'banker-command' ? {} : undefined);
  expect(hasInFlightRequests()).toBe(true);
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(hasInFlightRequests()).toBe(true);
    body.enqueue(new TextEncoder().encode('true}'));
    body.close();
    expect(await pending).toEqual({ ok: true });
    expect(hasInFlightRequests()).toBe(false);
  } finally { if (hasInFlightRequests()) { body.error(new Error('test cleanup')); await pending.catch(() => {}); } }
});

it('keeps activity while any overlapping request remains in flight', async () => {
  browser();
  const releases: ((response: Response) => void)[] = [];
  vi.stubGlobal('fetch', () => new Promise<Response>(resolve => releases.push(resolve)));
  const first = discoverAccount();
  const second = api('/api/view/public-token');
  expect(hasInFlightRequests()).toBe(true);
  releases[0]!(Response.json({ banker: { id: 'activity-owner', username: 'activity' } }));
  await first;
  expect(hasInFlightRequests()).toBe(true);
  releases[1]!(Response.json({ ok: true }));
  await second;
  expect(hasInFlightRequests()).toBe(false);
});

it.each(['fetch', 'parse', 'owner'] as const)('clears request activity after a %s failure', async kind => {
  browser();
  vi.stubGlobal('fetch', async () => {
    if (kind === 'fetch') throw new Error('network unavailable');
    return new Response(kind === 'parse' ? 'not JSON' : '{}');
  });
  const result = (kind === 'owner' ? bankerClient('activity-owner').api('/api/sessions') : discoverAccount()).catch(problem => problem);
  expect(hasInFlightRequests()).toBe(true);
  expect(await result).toBeInstanceOf(Error);
  expect(hasInFlightRequests()).toBe(false);
});

it('keeps the request active until an aborted response body rejects', async () => {
  vi.useFakeTimers();
  browser();
  vi.stubGlobal('fetch', async (_path: string, options: RequestInit) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"banker":'));
    options.signal!.addEventListener('abort', () => controller.error(new Error('request deadline')));
  } })));
  const result = discoverAccount().catch(problem => problem);
  expect(hasInFlightRequests()).toBe(true);
  await vi.advanceTimersByTimeAsync(14999);
  expect(hasInFlightRequests()).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect((await result).message).toBe('request deadline');
  expect(hasInFlightRequests()).toBe(false);
});
