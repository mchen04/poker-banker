import { createHash } from 'node:crypto';
import type { Page, Request } from '@playwright/test';

export function evaluateInPage<T, A = undefined>(page: Page, action: (argument: A) => T | Promise<T>, argument?: A): Promise<Awaited<T>> {
  return page.evaluate(`((__name) => (${action.toString()})(${JSON.stringify(argument) ?? 'undefined'}))((value) => value)`);
}

export const safePath = (value: string) => new URL(value).pathname.replace(/\/api\/view\/[^/]+/g, '/api/view/OWNED_TOKEN').replace(/\/v\/[^/]+/g, '/v/OWNED_TOKEN');

function safeQuery(value: string) {
  const query = new URLSearchParams();
  const allowed: Record<string, RegExp> = { group: /^(overall|location|game|weekday|month)$/, game: /^(NLH|PLO)$/, currency: /^[A-Z]{3}$/, from: /^\d{4}-\d{2}-\d{2}$/, to: /^\d{4}-\d{2}-\d{2}$/, month: /^\d{4}-\d{2}$/, weekday: /^[1-7]$/, limit: /^\d{1,4}$/ };
  for (const [key, queryValue] of new URL(value).searchParams) if (allowed[key]?.test(queryValue)) query.append(key, queryValue);
  query.sort();
  return query.toString();
}

export function observeRequests(page: Page) {
  const requests: { request: Request; started: number }[] = [];
  const request = (value: Request) => { requests.push({ request: value, started: Date.now() }); };
  page.on('request', request);
  const start = Date.now();
  return async () => {
    const end = Date.now();
    page.off('request', request);
    const responses = await Promise.all(requests.map(async ({ request, started }) => {
      const metadata: Record<string, unknown> = { path: safePath(request.url()), query: safeQuery(request.url()), method: request.method(), requestStartedEpoch: started, status: null, responseBodyBytes: null, responseHeaderBytes: null, decodedBodyBytes: null, serverTiming: null, dbMs: null, dbCount: null };
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            const response = await request.response();
            if (!response) { metadata.outcome = request.failure() ? 'request-failed' : 'no-response'; metadata.unavailableReason = 'Request completed without response headers'; return; }
            metadata.status = response.status(); metadata.fromServiceWorker = response.fromServiceWorker();
            const headers = await response.allHeaders(); const timing = headers['server-timing'] ?? null;
            const db = timing?.match(/(?:^|,)\s*db;dur=([\d.]+)/); const count = timing?.match(/(?:^|,)\s*db_count;desc="(\d+)"/);
            Object.assign(metadata, { contentEncoding: headers['content-encoding'] ?? 'identity', contentLength: headers['content-length'] ?? null, serverTiming: timing, dbMs: db ? Number(db[1]) : null, dbCount: count ? Number(count[1]) : null });
            const bytes = await response.body().catch(() => null); const sizes = await request.sizes().catch(() => null); const requestTiming = request.timing();
            Object.assign(metadata, { responseBodyBytes: sizes?.responseBodySize ?? null, responseHeaderBytes: sizes?.responseHeadersSize ?? null, decodedBodyBytes: bytes?.length ?? null, responseFinishedAfterObservationStop: requestTiming.responseEnd >= 0 ? requestTiming.startTime + requestTiming.responseEnd > end : null, outcome: bytes ? 'complete' : 'body-unavailable' });
            if (/\.(?:js|css)$/.test(new URL(request.url()).pathname) && bytes) metadata.sha256 = createHash('sha256').update(bytes).digest('hex');
          })(),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Request metadata deadline exceeded')), 10000); }),
        ]);
      } catch { metadata.outcome = 'metadata-unavailable'; metadata.unavailableReason = 'Response metadata failed or exceeded the 10 second deadline'; }
      finally { if (timeout !== undefined) clearTimeout(timeout); }
      return { ...metadata };
    }));
    const gets = new Map<string, { path: string; query: string; count: number }>();
    for (const { request } of requests) if (request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/api/')) {
      const url = new URL(request.url()); url.searchParams.sort(); const key = url.pathname + url.search;
      const group = gets.get(key) ?? { path: safePath(request.url()), query: safeQuery(request.url()), count: 0 }; group.count++; gets.set(key, group);
    }
    const browser = await evaluateInPage(page, ({ start, end }) => {
      type Entry = { startTime: number; duration: number };
      const value = (window as Window & { __pbTelemetry?: { supported: string[]; entries: { event: Entry[]; longtask: Entry[] }; delays: { startTime: number; delay: number }[] } }).__pbTelemetry;
      const since = start - performance.timeOrigin;
      const until = end - performance.timeOrigin;
      const within = (item: { startTime: number }) => item.startTime >= since && item.startTime <= until;
      const resources = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(within).map(item => ({ path: new URL(item.name).pathname.replace(/\/api\/view\/[^/]+/g, '/api/view/OWNED_TOKEN').replace(/\/v\/[^/]+/g, '/v/OWNED_TOKEN'), duration: item.duration, startTime: item.startTime, transferSize: item.transferSize, encodedBodySize: item.encodedBodySize, decodedBodySize: item.decodedBodySize, workerStart: item.workerStart, responseStart: item.responseStart, responseEnd: item.responseEnd }));
      const tasks = value?.entries.longtask.filter(within) ?? [];
      return { resources, eventTiming: value?.supported.includes('event') ? { available: true, entries: value.entries.event.filter(within) } : { available: false, reason: 'PerformanceEventTiming unsupported by this browser; no INP claim' }, longTasks: value?.supported.includes('longtask') ? { available: true, entries: tasks, totalBlockingTimeMs: tasks.reduce((sum, item) => sum + Math.max(0, item.duration - 50), 0), method: 'Sum of long task duration beyond 50ms during observed interval; not Lighthouse navigation TBT' } : { available: false, reason: 'Long Tasks API unsupported by this browser; blocking time unavailable' }, eventLoopDelay: { method: '50ms interval lateness, includes synthetic CPU suspension; not INP or long-task duration', samples: value?.delays.filter(within) ?? [] }, domNodes: document.querySelectorAll('*').length, jsHeap: { available: false, reason: 'WebKit exposes no supported JS heap measurement API; process RSS is not JS heap' } };
    }, { start, end });
    return { responses, requestObservation: { startEpoch: start, endEpoch: end, method: 'Requests starting in the observation interval; response metadata may finish after confirmed render, with a 10 second per-request deadline; unknown query values omitted from evidence' }, duplicateGetRequests: [...gets.values()].reduce((sum, group) => sum + Math.max(0, group.count - 1), 0), repeatedGetPaths: [...gets.values()].filter(group => group.count > 1), ...browser };
  };
}
