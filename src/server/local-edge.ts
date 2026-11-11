const cacheHeaders = new Set(['cache-control', 'content-location', 'date', 'etag', 'expires', 'last-modified', 'vary']);

export function emulateEdgeHeaders(response: Response): Response {
  if (response.status !== 304) return response;
  const headers = new Headers(response.headers);
  for (const name of headers.keys()) if (!cacheHeaders.has(name)) headers.delete(name);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
