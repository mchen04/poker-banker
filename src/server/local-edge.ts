const cacheHeaders = new Set(['cache-control', 'content-location', 'date', 'etag', 'expires', 'last-modified', 'vary']);

export function emulateEdgeHeaders(response: Response): Response {
  if (response.status !== 304) return response;
  const headers = new Headers([...response.headers].filter(([name]) => cacheHeaders.has(name)));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
