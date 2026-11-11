# Round 3 implementation contracts

## Ownership and checkpoint

The client data owner implements `src/client/data.ts` and browser storage tests. The UI owner implements client React views and CSS. The PWA owner implements worker/build/icons/local serving configuration and `src/client/pwa.ts`. The journey owner implements Playwright configuration, isolated local test server and browser journeys. Each owner edits only its assigned files. Root integrates, reviews and runs mini checks.

Blocking steps are the approved documents, these interfaces, and mini capacity. Independent files parallelize. Session writes and outbox heads serialize for their actual invariants. This is the smallest decomposition that keeps the UI and tests reviewable while one owner keeps persistence semantics together.

## Data exports

`src/client/data.ts` exports:

- `type Banker = {id: string; username: string}`.
- `api<T>(path: string, method = 'GET', body?: unknown): Promise<T>`. Use full `/api/...` paths. Errors have a readable message and status/code. GET 304 is handled by `pollSession` instead.
- `draftKey(bankerId, sessionId, form, playerId = ''): string` with slash separators.
- `readDraft<T>(key): Promise<T | undefined>`, `writeDraft(key,value): Promise<void>`, `deleteDraft(key): Promise<void>`, `flushDraftWrites(): Promise<void>`.
- `readSnapshot(bankerId,sessionId): Promise<SessionState | undefined>`, `storeSnapshot(bankerId,state)`, `listSnapshots(bankerId): Promise<SessionState[]>`.
- `type OutboxItem = {op_id:string; banker_id:string; session_id:string; path:string; method:'POST'|'PATCH'; body:Record<string,unknown>; label:string; order:number; status:'pending'|'sending'|'rejected'; error?:string; attempts:number; next_attempt_at:number; lease_until?:number}`.
- `enqueue({banker_id,session_id,path,method?,body,label,draft_key?}): Promise<OutboxItem>`. Body contains the stable draft's UUID v4 op_id. Atomically moves a draft to outbox, deduplicating op_id.
- `listOutbox(bankerId): Promise<OutboxItem[]>`, `retryItem(opId)`, `discardItem(opId)`, `clearBankerData(bankerId)`, `hasUnsent(bankerId): Promise<boolean>`.
- `syncOutbox(bankerId,onSaved:(state:SessionState,item:OutboxItem)=>void,onChange:()=>void): ()=>void`. It starts syncing online, retries transient failures with backoff, keeps and blocks a session at rejected heads, and returns cleanup. Changes dispatch window event `pb-data`.
- `pollSession(path, revision?): Promise<SessionState | undefined>` returning undefined on 304. UI schedules visible 2-second polling and immediate visibility/pageshow/focus/online refresh.
- `requestPersistence(): Promise<void>`.

Offline identity can be retained as non-secret banker id/username. Confirmed snapshots stay read-only; new drafts can be queued offline with explicit Not saved yet status and are excluded from totals. UI never adds queued amounts to SessionState.

## PWA exports

`src/client/pwa.ts` exports `usePwaUpdate({sheetOpen:boolean,outboxCount:number})` returning `{waiting:boolean,release:string,activate:()=>Promise<void>}`. Automatic activation requires visible document, no sheet, and empty outbox. Manual Reload permits a sheet but flushes drafts first and requires empty outbox and visibility. UI renders Update ready and a Reload button with `data-testid="update-reload"`.

Build version comes from `RELEASE_VERSION`, defaulting in the build script to the package version plus a unique build stamp. A build must always supply a nonempty release and precache list to the stamping step. The built worker answers a version message for verification.

## Browser test interface

Stable controls use accessible labels and/or data-testid. UI owner and journey owner agree the labels directly. Tests use their own browsers and a fresh embedded Postgres local server. No app-only backdoors or production test globals are added. Tests can inspect IndexedDB through normal browser APIs and use authenticated HTTP setup for independently computed report fixtures.
