import { useCallback, useEffect, useRef, useState } from 'react';
import { flushDraftWrites, hasAnyOutbox, hasInFlightRequests, hasPendingLocalWrites } from './data';

declare const __APP_RELEASE__: string;

type Holds = { sheetOpen: boolean; outboxCount: number; busy: boolean };
let navigationStarted = false;

function hasVisibleInput() {
  return Array.from(document.querySelectorAll?.<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select') ?? []).some(input =>
    !input.disabled && !('readOnly' in input && input.readOnly) && !/^(checkbox|hidden|button|submit|reset|image)$/.test(input.type)
    && input.value.length > 0 && input.getClientRects().length > 0 && window.getComputedStyle(input).visibility !== 'hidden');
}

export function usePwaUpdate(holds: Holds) {
  const [waiting, setWaiting] = useState(false);
  const current = useRef(holds);
  current.current = holds;
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const activating = useRef(false);
  const pendingReload = useRef(false);
  const manualReload = useRef(false);

  const canReload = useCallback((manual: boolean, preparingManual = false) => !navigationStarted && document.visibilityState === 'visible' && !current.current.busy && (preparingManual || !hasInFlightRequests()) && current.current.outboxCount === 0 && (manual || manualReload.current || (!current.current.sheetOpen && !hasVisibleInput())), []);
  const reload = useCallback(async (manual: boolean) => {
    if (!pendingReload.current || !canReload(manual)) return;
    await flushDraftWrites();
    if (!pendingReload.current || !canReload(manual)) return;
    if (!await hasAnyOutbox() && !hasPendingLocalWrites() && canReload(manual)) {
      manualReload.current = false;
      navigationStarted = true;
      window.location.reload();
    }
  }, [canReload]);

  const activateWorker = useCallback(async (manual: boolean) => {
    if (activating.current || !canReload(manual, manual) || (!registration.current?.waiting && !pendingReload.current)) return;
    activating.current = true;
    try {
      await flushDraftWrites();
      if (await hasAnyOutbox() || hasPendingLocalWrites() || !canReload(manual, manual)) return;
      if (manual && (registration.current?.waiting || pendingReload.current)) manualReload.current = true;
      if (!canReload(manual)) return;
      if (pendingReload.current) { await reload(manual); return; }
      const worker = registration.current?.waiting;
      if (!worker) return;
      worker.postMessage({ type: 'ACTIVATE', updateProtocol: 1 });
    } finally {
      activating.current = false;
    }
  }, [canReload, reload]);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
    let stopped = false;
    let checking = false;
    let hadController = !!navigator.serviceWorker.controller;
    const workerListeners = new Map<ServiceWorker, () => void>();
    const waitingChanged = () => {
      if (!stopped) setWaiting((!!registration.current?.active && !!registration.current.waiting) || pendingReload.current);
    };
    const watchWorker = (worker: ServiceWorker | null) => {
      if (!worker || workerListeners.has(worker)) return;
      const changed = () => { if (worker.state === 'installed') waitingChanged(); };
      workerListeners.set(worker, changed);
      worker.addEventListener('statechange', changed);
    };
    const updateFound = () => watchWorker(registration.current?.installing ?? null);
    const check = async () => {
      if (stopped || checking || !registration.current || document.visibilityState !== 'visible') return;
      checking = true;
      try { await registration.current.update(); } catch {}
      finally { checking = false; }
      if (!stopped) { announceRelease(); waitingChanged(); }
    };
    const announceRelease = () => navigator.serviceWorker.controller?.postMessage({ type: 'CLIENT_RELEASE', release: __APP_RELEASE__, updateProtocol: 1 });
    const controllerChanged = () => {
      if (hadController) {
        pendingReload.current = true;
        setWaiting(true);
        const manual = manualReload.current;
        void reload(manual).catch(() => {});
      }
      hadController = true;
      announceRelease();
    };
    const visibility = () => {
      if (document.visibilityState !== 'visible') return;
      void check();
      void reload(false).catch(() => {});
      if (registration.current?.waiting && !current.current.sheetOpen && current.current.outboxCount === 0) void activateWorker(false).catch(() => {});
    };
    const online = () => { void check(); };
    const message = (event: MessageEvent) => {
      if (event.data?.type === 'CLIENT_RELEASE_REQUEST') {
        (event.source as ServiceWorker | null)?.postMessage({ type: 'CLIENT_RELEASE', requestId: event.data.requestId, release: __APP_RELEASE__, updateProtocol: 1 });
      } else if (event.data?.type === 'ASSET_ACCESSED') void check();
    };
    const preloadFailed = (event: Event) => { event.preventDefault(); void check(); };
    const rejected = (event: PromiseRejectionEvent) => {
      const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
      if (/chunkloaderror|loading chunk|dynamically imported|importing a module script/i.test(message)) void check();
    };
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
    navigator.serviceWorker.addEventListener('message', message);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pageshow', visibility);
    window.addEventListener('focus', visibility);
    window.addEventListener('online', online);
    window.addEventListener('vite:preloadError', preloadFailed);
    window.addEventListener('unhandledrejection', rejected);
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(result => {
      if (stopped) return;
      registration.current = result;
      result.addEventListener('updatefound', updateFound);
      watchWorker(result.installing);
      waitingChanged();
      announceRelease();
      void check();
    }).catch(() => {});
    const timer = window.setInterval(() => {
      if (pendingReload.current) void reload(false).catch(() => {});
      else if (registration.current?.waiting) void activateWorker(false).catch(() => {});
    }, 3000);
    const discovery = window.setInterval(() => { void check(); }, 60000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearInterval(discovery);
      registration.current?.removeEventListener('updatefound', updateFound);
      for (const [worker, listener] of workerListeners) worker.removeEventListener('statechange', listener);
      navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged);
      navigator.serviceWorker.removeEventListener('message', message);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pageshow', visibility);
      window.removeEventListener('focus', visibility);
      window.removeEventListener('online', online);
      window.removeEventListener('vite:preloadError', preloadFailed);
      window.removeEventListener('unhandledrejection', rejected);
    };
  }, [activateWorker, reload]);

  useEffect(() => {
    if (waiting) void activateWorker(false).catch(() => {});
  }, [activateWorker, holds.sheetOpen, holds.outboxCount, holds.busy, waiting]);

  return { waiting, release: __APP_RELEASE__, activate: () => activateWorker(true) };
}
