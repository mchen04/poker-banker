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
  const valid = () => document.querySelector('h1')?.getClientRects().length && document.querySelector('h1')?.textContent === expected.name && document.querySelector('[data-testid="totals"] strong')?.textContent === expected.total && document.querySelectorAll('.players .player-row').length === 9 && expected.ids.every(id => document.querySelector('[data-testid="player-' + id + '"]'));
  const check = () => {
    if (pending || window.__pbBenchMeaningful || !valid()) return;
    pending = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      pending = false;
      if (!valid()) return;
      const ms = performance.now();
      const currentHttp = performance.getEntriesByType('resource').some(entry => entry.name.includes(expected.endpoint) && entry.responseEnd > 0 && entry.responseEnd <= ms);
      window.__pbBenchMeaningful = { ms, currentHttp }; observer.disconnect();
    }));
  };
  const observer = new MutationObserver(check);
  observer.observe(document, { childList: true, subtree: true, characterData: true }); check();
})(__PB_EXPECTED__);
`;
