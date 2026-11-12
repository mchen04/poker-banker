import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, bankerClient, isProvenNotApplied } from '../src/client/data';

let sequence = 0;
function setup(response: Response) {
  const owner = `response-owner-${++sequence}`;
  const events = new EventTarget();
  vi.stubGlobal('window', { setTimeout, clearTimeout, dispatchEvent: events.dispatchEvent.bind(events) });
  const fetch = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetch);
  return { client: bankerClient(owner), owner, fetch };
}
afterEach(() => vi.unstubAllGlobals());

it('accepts a headerless unchanged poll only after sending its expected banker', async () => {
  const { client, owner, fetch } = setup(new Response(null, { status: 304 }));
  expect(await client.pollSession('/api/sessions/game', '7')).toBeUndefined();
  expect(fetch).toHaveBeenCalledOnce();
  const [path, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
  expect(path).toBe('/api/sessions/game?since=7');
  expect(new Headers(init.headers).get('X-PB-Expected-Banker-ID')).toBe(owner);
  expect(client.isCurrent()).toBe(true);
});

it.each([400, 403, 404, 409, 413, 431, 502, 503, 504])('keeps an unowned platform %s uncertain without blocking the banker', async status => {
  const { client } = setup(new Response(JSON.stringify({ error: { code: 'invalid_request', message: 'Untrusted platform response' } }), { status }));
  let problem: unknown;
  try { await client.api('/api/sessions/game/players', 'POST', { op_id: 'operation' }); }
  catch (failure) { problem = failure; }
  expect(problem).toMatchObject({ name: 'UnverifiedResponseError', responseStatus: status });
  expect(problem).not.toBeInstanceOf(ApiError);
  expect(isProvenNotApplied(problem)).toBe(false);
  expect(client.isCurrent()).toBe(true);
});

it('keeps an unowned HTTP authentication challenge nonsettling without trusting its error body', async () => {
  const { client } = setup(new Response(JSON.stringify({ error: { code: 'invalid_request', message: 'Untrusted 401 body' } }), { status: 401 }));
  let problem: unknown;
  try { await client.api('/api/sessions'); } catch (failure) { problem = failure; }
  expect(problem).toMatchObject({ status: 401, code: 'unauthorized' });
  expect((problem as Error).message).not.toBe('Untrusted 401 body');
  expect(isProvenNotApplied(problem)).toBe(false);
  expect(client.isCurrent()).toBe(true);
});

it.each([204, 205])('does not treat a bodiless %s as work acknowledgement with or without proof', async status => {
  for (const verified of [false, true]) {
    const { client, owner } = setup(new Response(null, { status }));
    if (verified) vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status, headers: { 'X-PB-Banker-ID': owner } })));
    let problem: unknown;
    try { await client.api('/api/sessions/game/players', 'POST', { op_id: 'operation' }); }
    catch (failure) { problem = failure; }
    expect(problem).toMatchObject({ name: 'UnverifiedResponseError', responseStatus: status });
    expect(isProvenNotApplied(problem)).toBe(false);
    expect(client.isCurrent()).toBe(true);
  }
});

it('does not accept a missing-proof data response or settle it', async () => {
  const { client } = setup(Response.json({ session: { id: 'unverified' } }));
  let problem: unknown;
  try { await client.api('/api/sessions/game', 'POST', { op_id: 'operation' }); }
  catch (failure) { problem = failure; }
  expect(problem).toMatchObject({ name: 'UnverifiedResponseError', responseStatus: 200 });
  expect(isProvenNotApplied(problem)).toBe(false);
  expect(client.isCurrent()).toBe(true);
});

it.each(['api GET', 'api POST', 'api HEAD', 'poll without revision', 'poll with empty revision', 'poll with query', 'poll with fragment'])('rejects an unexpected 304 for %s without accepting data or work', async kind => {
  const { client } = setup(new Response(null, { status: 304 }));
  let problem: unknown;
  try {
    if (kind === 'poll without revision') await client.pollSession('/api/sessions/game');
    else if (kind === 'poll with empty revision') await client.pollSession('/api/sessions/game', '');
    else if (kind === 'poll with query') await client.pollSession('/api/sessions/game?other=1', '7');
    else if (kind === 'poll with fragment') await client.pollSession('/api/sessions/game#fragment', '7');
    else await client.api('/api/sessions/game', kind.slice(4));
  } catch (failure) { problem = failure; }
  expect(problem).toMatchObject({ name: 'UnverifiedResponseError', responseStatus: 304 });
  expect(isProvenNotApplied(problem)).toBe(false);
  expect(client.isCurrent()).toBe(true);
});

it('never parses a HEAD response as data even with a matching owner', async () => {
  const { client, owner } = setup(new Response(null));
  const json = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('fetch', vi.fn(async () => {
    const response = new Response(null, { headers: { 'X-PB-Banker-ID': owner } });
    response.json = json;
    return response;
  }));
  await expect(client.api('/api/sessions/game', 'HEAD')).rejects.toMatchObject({ name: 'UnverifiedResponseError', responseStatus: 200 });
  expect(json).not.toHaveBeenCalled();
  expect(client.isCurrent()).toBe(true);
});

it.each([200, 204, 304, 401, 413, 504])('still blocks an explicitly foreign owner on %s', async status => {
  const { client } = setup(new Response(status === 200 ? '{}' : null, { status, headers: { 'X-PB-Banker-ID': 'another-owner' } }));
  await expect(client.pollSession('/api/sessions/game', '7')).rejects.toMatchObject({ status: 409, code: 'account_changed' });
  expect(client.isCurrent()).toBe(false);
});
