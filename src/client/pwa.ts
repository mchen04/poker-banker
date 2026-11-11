import { useCallback, useEffect, useRef, useState } from 'react';
import { flushDraftWrites, hasAnyOutbox } from './data';

declare const __APP_RELEASE__: string;

type Holds = { sheetOpen: boolean; outboxCount: number };

export function usePwaUpdate(holds: Holds) {
  const [waiting, setWaiting] = useState(false);
  const current = useRef(holds);
  current.current = holds;
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const activating = useRef(false);
  const pendingReload = useRef(false);
  const manualReload = useRef(false);

  const canReload = useCallback((manual: boolean) => document.visibilityState === 'visible' && current.current.outboxCount === 0 && (manual || !current.current.sheetOpen), []);
  const reload = useCallback(async (manual: boolean) => {
    if (!pendingReload.current || !canReload(manual)) return;
    await flushDraftWrites();
    if (!await hasAnyOutbox() && canReload(manual)) window.location.reload();
  }, [canReload]);

  const activateWorker = useCallback(async (manual: boolean) => {
    if (activating.current || !canReload(manual)) return;
    activating.current = true;
    try {
      await flushDraftWrites();
      if (await hasAnyOutbox() || !canReload(manual)) return;
      if (pendingReload.current) { await reload(manual); return; }
      const worker = registration.current?.waiting;
      if (!worker) return;
      manualReload.current = manual;
      worker.postMessage({ type: 'ACTIVATE' });
    } finally {
      activating.current = false;
    }
  }, [canReload, reload]);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
    let stopped = false;
    let lastCheck = 0;
    let hadController = !!navigator.serviceWorker.controller;
    const workerListeners = new Map<ServiceWorker, () => void>();
    const waitingChanged = () => {
      if (!stopped) setWaiting(!!registration.current?.waiting || pendingReload.current);
    };
    const watchWorker = (worker: ServiceWorker | null) => {
      if (!worker || workerListeners.has(worker)) return;
      const changed = () => { if (worker.state === 'installed') waitingChanged(); };
      workerListeners.set(worker, changed);
      worker.addEventListener('statechange', changed);
    };
    const updateFound = () => watchWorker(registration.current?.installing ?? null);
    const check = async (force = false) => {
      if (stopped || document.visibilityState !== 'visible') return;
      if (!force && Date.now() - lastCheck < 300000) return;
      lastCheck = Date.now();
      try { await registration.current?.update(); } catch {}
      waitingChanged();
    };
    const controllerChanged = () => {
      if (hadController) {
        pendingReload.current = true;
        setWaiting(true);
        void reload(manualReload.current);
      }
      hadController = true;
    };
    const visibility = () => {
      if (document.visibilityState !== 'visible') return;
      void check();
      void reload(false);
      if (registration.current?.waiting && !current.current.sheetOpen && current.current.outboxCount === 0) void activateWorker(false);
    };
    const online = () => { void check(true); };
    const preloadFailed = (event: Event) => { event.preventDefault(); void check(true); };
    const rejected = (event: PromiseRejectionEvent) => {
      const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
      if (/chunkloaderror|loading chunk|dynamically imported|importing a module script/i.test(message)) void check(true);
    };
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', online);
    window.addEventListener('vite:preloadError', preloadFailed);
    window.addEventListener('unhandledrejection', rejected);
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(result => {
      if (stopped) return;
      registration.current = result;
      result.addEventListener('updatefound', updateFound);
      watchWorker(result.installing);
      waitingChanged();
      void check(true);
    }).catch(() => {});
    const timer = window.setInterval(() => {
      if (pendingReload.current) void reload(false);
      else if (registration.current?.waiting) void activateWorker(false);
    }, 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      registration.current?.removeEventListener('updatefound', updateFound);
      for (const [worker, listener] of workerListeners) worker.removeEventListener('statechange', listener);
      navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', online);
      window.removeEventListener('vite:preloadError', preloadFailed);
      window.removeEventListener('unhandledrejection', rejected);
    };
  }, [activateWorker, reload]);

  useEffect(() => {
    if (waiting) void activateWorker(false);
  }, [activateWorker, holds.sheetOpen, holds.outboxCount, waiting]);

  return { waiting, release: __APP_RELEASE__, activate: () => activateWorker(true) };
}
