type Request = { result?: unknown; error?: Error; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void };
type Transaction = { error?: Error; oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: (name: string) => { get: (key: string) => Request; put: (value: unknown, key: string) => void } };
type PolicyState = { clients: Record<string, { release?: string; updateProtocol?: number; pins?: string[] }>; releases: Record<string, number>; generation: number; manifests?: Record<string, string[]>; inventories?: Record<string, string[]> };

export function updatePolicyDatabase(initial?: PolicyState) {
  const records = new Map<string, unknown>();
  if (initial) records.set('state', structuredClone(initial));
  let opened = false;
  let sequence = Promise.resolve();
  let lock = Promise.resolve();
  let unavailable = false;
  const database = {
    createObjectStore() {},
    transaction(): Transaction {
      let finish!: () => void;
      const ready = sequence;
      sequence = new Promise<void>(resolve => { finish = resolve; });
      const transaction: Transaction = {
        objectStore: () => ({
          get(key) {
            const request: Request = {};
            void ready.then(() => {
              request.result = structuredClone(records.get(key));
              request.onsuccess?.();
              transaction.oncomplete?.();
              finish();
            });
            return request;
          },
          put: (value, key) => { records.set(key, structuredClone(value)); },
        }),
      };
      return transaction;
    },
  };
  return {
    indexedDB: {
      open() {
        const request: Request = { result: database };
        queueMicrotask(() => {
          if (unavailable) { request.error = new Error('Update policy unavailable'); request.onerror?.(); return; }
          if (!opened) { opened = true; request.onupgradeneeded?.(); }
          request.onsuccess?.();
        });
        return request;
      },
    },
    locks: {
      request<T>(_name: string, callback: () => Promise<T>) {
        const pending = lock.catch(() => {}).then(callback);
        lock = pending.then(() => {}, () => {});
        return pending;
      },
    },
    state: () => structuredClone(records.get('state')) as PolicyState,
    fail: () => { unavailable = true; },
  };
}
