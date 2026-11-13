import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const source = ts.transpileModule(readFileSync('src/client/views/common.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

it.each(['edit', 'discard', 'submit', 'queue', 'keep'] as const)('does not %s before the open form has observed its saved draft', async action => {
  const touched: string[] = [];
  const initial = { op_id: 'operation', amount: '10' };
  const data = Object.fromEntries(['writeDraft', 'deleteDraft', 'prepareDraftSubmission', 'enqueue'].map(name => [name, vi.fn(async () => { touched.push(name); return name === 'prepareDraftSubmission' ? { value: initial, previouslyConfirmed: false } : {}; })]));
  const hooks = {
    createContext: () => null, useContext: () => null, useEffect() {}, useLayoutEffect() {},
    useState: (value: unknown) => [value, () => {}], useRef: (value: unknown) => ({ current: value }),
  };
  const exports: Record<string, unknown> = {};
  runInNewContext(source, {
    exports, require: (name: string) => name === 'react' ? hooks : name === '../data' ? { ...data, readDraft: async () => action === 'keep' ? initial : undefined, replaySubmittedDraft: async () => ({}), draftSaveFailed: () => action === 'keep', hasRetainedDraft: () => action === 'keep', DraftConflictError: class extends Error {} } : {},
    window: { dispatchEvent() {} }, crypto: globalThis.crypto, structuredClone,
  });
  const useDraft = exports.useDraft as typeof import('../src/client/views/common').useDraft;
  const draft = useDraft('banker/session/buy_in/player', initial);
  expect(draft.ready).toBe(false);
  if (action === 'edit') draft.update({ ...initial, amount: '25' });
  else {
    const pending = action === 'keep' ? draft.keep() : action === 'discard' ? draft.clear() : action === 'submit'
      ? draft.submit('/api/sessions/session', { op_id: initial.op_id })
      : draft.queue({ banker_id: 'banker', session_id: 'session', path: '/api/sessions/session/entries', body: { op_id: initial.op_id }, label: 'Buy-in' });
    await expect(pending).rejects.toThrow('Restoring draft');
  }
  expect(touched).toEqual([]);
});
