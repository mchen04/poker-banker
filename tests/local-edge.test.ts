import { expect, it } from 'vitest';
import { emulateEdgeHeaders } from '../src/server/local-edge';

it('strips custom headers from unchanged responses while preserving cache metadata and status', async () => {
  const cache = { 'Cache-Control': 'private, no-store', 'Content-Location': '/api/sessions/example', Date: 'Wed, 11 Nov 2026 12:00:00 GMT', ETag: '"revision-3"', Expires: '0', 'Last-Modified': 'Wed, 11 Nov 2026 11:00:00 GMT', Vary: 'Cookie' };
  const response = emulateEdgeHeaders(new Response(null, { status: 304, statusText: 'Not Modified', headers: { ...cache, 'X-PB-Banker-ID': 'owner', 'Server-Timing': 'app;dur=1.000', 'X-Debug': 'debug', 'X-Other': 'other', 'X-Trace-ID': 'trace' } }));
  expect(response.status).toBe(304);
  expect(response.statusText).toBe('Not Modified');
  expect(await response.text()).toBe('');
  expect(response.headers.get('X-PB-Banker-ID')).toBeNull();
  expect(response.headers.get('Server-Timing')).toBeNull();
  expect([...response.headers.keys()]).toEqual(Object.keys(cache).map(name => name.toLowerCase()).sort());
  for (const [name, value] of Object.entries(cache)) expect(response.headers.get(name)).toBe(value);
});

it('preserves complete responses including owner, security headers and body', async () => {
  const response = new Response('{"revision":4}', { headers: { 'X-PB-Banker-ID': 'owner', 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Server-Timing': 'app;dur=1.000' } });
  const result = emulateEdgeHeaders(response);
  expect(result).toBe(response);
  expect(result.status).toBe(200);
  expect(result.headers.get('X-PB-Banker-ID')).toBe('owner');
  expect(await result.text()).toBe('{"revision":4}');
});
