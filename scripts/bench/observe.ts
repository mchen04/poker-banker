export const observationScript = String.raw`
((expected) => {
  window.__pbObserveSaved = (note, total) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Saved entry did not render')); }, 15000);
    const check = () => {
      if (document.querySelector('[data-testid="totals"] strong')?.textContent !== total || ![...document.querySelectorAll('[data-testid^="entry-"] small')].some(element => element.textContent?.includes(note))) return;
      observer.disconnect(); clearTimeout(timeout);
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.timeOrigin + performance.now())));
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true }); check();
  });
  let pending = false;
  const valid = () => document.querySelector('h1')?.getClientRects().length && (document.querySelector('h1')?.getAttribute('aria-label') || document.querySelector('h1')?.textContent) === expected.name && document.querySelector('[data-testid="totals"] strong')?.textContent === expected.total && document.querySelectorAll('.players .player-row').length === expected.ids.length && expected.ids.every(id => document.querySelector('[data-testid="player-' + id + '"]'));
  const check = () => {
    if (pending || window.__pbBenchMeaningful || !valid()) return;
    pending = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      pending = false;
      if (!valid()) return;
      const ms = performance.now();
      const currentHttp = performance.getEntriesByType('resource').some(entry => entry.name.includes(expected.endpoint) && entry.responseEnd > 0 && entry.responseEnd <= ms);
      window.__pbBenchMeaningful = { ms, currentHttp, epoch: performance.timeOrigin + ms }; observer.disconnect();
    }));
  };
  const observer = new MutationObserver(check);
  observer.observe(document, { childList: true, subtree: true, characterData: true }); check();
})(__PB_EXPECTED__);
`;

export const telemetryScript = String.raw`
(() => {
  const supported = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver.supportedEntryTypes || [] : [];
  const entries = { event: [], longtask: [] };
  for (const type of ['event', 'longtask']) if (supported.includes(type)) {
    try { new PerformanceObserver(list => { for (const entry of list.getEntries()) { const value = entry.toJSON(); entries[type].push(value); if (entries[type].length > 2000) entries[type].shift(); } }).observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) }); } catch {}
  }
  const delays = [];
  let previous = performance.now();
  const timer = setInterval(() => { const now = performance.now(); delays.push({ startTime: previous, delay: Math.max(0, now - previous - 50) }); if (delays.length > 2000) delays.shift(); previous = now; }, 50);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  window.__pbTelemetry = { supported, entries, delays };
})();
`;
