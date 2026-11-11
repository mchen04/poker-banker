import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import type { Banker, DraftCursor } from '../src/client/data';
import type { PendingRecoveryCodes } from '../src/client/views/Auth';

const require = createRequire(import.meta.url);
const storageSource = readFileSync('tests/draft-versions.test.ts', 'utf8');
const sharedStorage = () => Function('vi', ts.transpileModule(`${storageSource.slice(storageSource.indexOf('type Row'), storageSource.indexOf("const owner ="))}\nreturn sharedStorage();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(vi);
const authSource = ts.transpileModule(readFileSync('src/client/views/Auth.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
type Node = { type: unknown; props: Record<string, any> };
const nodes = (node: any): Node[] => node && typeof node === 'object' ? [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)] : [];
const freshTab = async () => { vi.resetModules(); return import('../src/client/data'); };
type Tab = Awaited<ReturnType<typeof freshTab>>;
const value: PendingRecoveryCodes = { banker: { id: 'banker', username: 'banker' }, codes: ['one-time-code'] };
function mount(data: Tab, pendingCodes: PendingRecoveryCodes, pendingCursor: DraftCursor) {
  const slots: unknown[] = [];
  const dependencies: unknown[][] = [];
  const effects: (() => void)[] = [];
  let cursor = 0;
  let effectIndex = 0;
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useEffect(effect: () => void, deps: unknown[]) {
      const index = effectIndex++;
      if (!dependencies[index] || deps.some((dep, position) => dep !== dependencies[index][position])) { dependencies[index] = deps; effects.push(effect); }
    },
  };
  const signedIn = vi.fn<(banker: Banker) => void>();
  const module = { exports: {} as { Auth: (props: unknown) => unknown } };
  runInNewContext(authSource, { module, exports: module.exports, require: (name: string) => name === 'react' ? hooks : name === '../data' ? data : name === './common' ? { ErrorText: () => null } : require(name), localStorage });
  const render = () => {
    cursor = 0; effectIndex = 0;
    const tree = nodes(module.exports.Auth({ signedIn, pendingCodes, pendingCursor }));
    effects.splice(0).forEach(effect => effect());
    return tree;
  };
  render();
  return { render, signedIn, ready: () => vi.waitFor(() => { expect(render().find(node => node.props.children === 'Continue to workspace')?.props.disabled).toBe(true); expect(slots[6]).toBe(false); }) };
}
function setup() {
  const storage = sharedStorage();
  const reminders = new Map<string, string>();
  vi.stubGlobal('window', { setTimeout, clearTimeout, dispatchEvent() {} });
  vi.stubGlobal('localStorage', { getItem: (key: string) => reminders.get(key) ?? null, setItem: (key: string, value: string) => reminders.set(key, value), removeItem: (key: string) => reminders.delete(key) });
  return storage;
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('shows review guidance without a failed-save retry when another tab changed recovery codes', async () => {
  const storage = setup();
  const a = await freshTab();
  const key = a.draftKey(value.banker.id, 'account', 'recovery-codes');
  await a.writeDraft(key, value);
  const cursor: DraftCursor = {};
  await a.readDraft(key, cursor);
  const b = await freshTab();
  await b.readDraft(key);
  const newer = { ...value, codes: ['newer-one-time-code'] };
  await b.writeDraft(key, newer);
  const auth = mount(a, value, cursor);
  await auth.ready();
  expect(storage.draft(key)).toEqual(newer);
  expect(a.hasPendingLocalWrites()).toBe(false);
  expect(a.draftSaveFailed(key)).toBe(false);
  expect(auth.render().some(node => node.props.children === 'Retry saving draft')).toBe(false);
  expect(auth.render().some(node => typeof node.props.text === 'string' && node.props.text.includes('Not saved'))).toBe(false);
});

it('continues after another tab already acknowledged the same recovery codes', async () => {
  setup();
  const a = await freshTab();
  const key = a.draftKey(value.banker.id, 'account', 'recovery-codes');
  await a.writeDraft(key, value);
  const cursor: DraftCursor = {};
  await a.readDraft(key, cursor);
  const auth = mount(a, value, cursor);
  await auth.ready();
  const b = await freshTab();
  await b.readDraft(key);
  await b.deleteDraft(key);
  auth.render().find(node => node.type === 'input' && node.props.type === 'checkbox')!.props.onChange({ target: { checked: true } });
  auth.render().find(node => node.props.children === 'Continue to workspace')!.props.onClick();
  await vi.waitFor(() => expect(auth.signedIn).toHaveBeenCalledWith(value.banker));
});
