import { expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecipeContext } from './control';
import { checkLayout } from './layout';
import { addPlayer, current, money, newSession, share, workspaceReady } from '../../../../e2e/helpers';
import { typeInput } from '../../../../e2e/input';

type Viewport = { name: string; width: number; height: number };
type Audit = Record<string, unknown> & { state: string; viewport: string; scheme: string; violations: string[] };
const viewports: Viewport[] = [{ name: 'phone', width: 393, height: 852 }, { name: 'narrow', width: 320, height: 568 }];
const schemes = ['light', 'dark'] as const;

async function shim(page: Page) {
  await page.evaluate('globalThis.__name = globalThis.__name || ((value) => value)');
}

async function staticAudit(page: Page, state: string, root: boolean) {
  return page.evaluate(({ state, root }) => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && box.width > 0 && box.height > 0;
    };
    const hidden = (element: Element) => !!element.closest('[aria-hidden="true"],.sr-only');
    const parse = (value: string) => {
      const match = /rgba?\(([^)]+)\)/.exec(value);
      if (!match) return null;
      const parts = match[1]!.split(',').map(Number);
      return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1] as [number, number, number, number];
    };
    const luminance = (color: [number, number, number, number]) => {
      const channel = (value: number) => { const scaled = value / 255; return scaled <= .03928 ? scaled / 12.92 : ((scaled + .055) / 1.055) ** 2.4; };
      return .2126 * channel(color[0]) + .7152 * channel(color[1]) + .0722 * channel(color[2]);
    };
    const ratio = (left: [number, number, number, number], right: [number, number, number, number]) => {
      const a = luminance(left), b = luminance(right);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    };
    const background = (element: Element) => {
      let node: Element | null = element;
      while (node) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color[3] > .95) return color;
        node = node.parentElement;
      }
      return [255, 255, 255, 1] as [number, number, number, number];
    };
    const label = (element: Element) => (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const textElements = [...document.querySelectorAll('h1,h2,h3,p,span,strong,small,label,dt,dd,li,button,a')]
      .filter(element => visible(element) && !hidden(element) && [...element.childNodes].some(node => node.nodeType === 3 && node.textContent!.trim()))
      .slice(0, 300);
    const text = textElements.map(element => {
      const style = getComputedStyle(element);
      const foreground = parse(style.color);
      if (!foreground) return null;
      const behind = background(element);
      const size = Number.parseFloat(style.fontSize);
      const weight = Number(style.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      const value = ratio(foreground, behind);
      return { text: label(element), tag: element.tagName, color: style.color, background: `rgb(${behind[0]}, ${behind[1]}, ${behind[2]})`, ratio: Number(value.toFixed(2)), need, pass: value >= need - .01 };
    }).filter(Boolean) as { text: string; tag: string; color: string; background: string; ratio: number; need: number; pass: boolean }[];
    const controls = [...document.querySelectorAll('input:not([type="checkbox"]),select,textarea,button,[role="button"],a[href]')].filter(element => visible(element) && !hidden(element)).slice(0, 250);
    const nonText = controls.map(element => {
      const style = getComputedStyle(element);
      if (element.matches(':disabled')) return null;
      const behind = element.matches('input,select,textarea') || element.getAttribute('aria-pressed') === 'true' || element.getAttribute('aria-current') === 'true' ? background(element) : background(element.parentElement ?? element);
      let foreground: [number, number, number, number] | null = null;
      if (element.matches('input,select,textarea')) foreground = parse(style.borderTopColor);
      else if (element.getAttribute('aria-pressed') === 'true' || element.getAttribute('aria-current') === 'true') foreground = style.outlineStyle !== 'none' ? parse(style.outlineColor) : null;
      else if (element.tagName === 'BUTTON' && style.borderTopStyle !== 'none' && (Number.parseFloat(style.borderLeftWidth) > 0 || Number.parseFloat(style.borderRightWidth) > 0 || Number.parseFloat(style.borderBottomWidth) > 0)) foreground = parse(style.borderTopColor);
      if (!foreground || foreground[3] < .5) return null;
      const value = ratio(foreground, behind);
      return { name: label(element), tag: element.tagName, color: style.borderTopColor, background: `rgb(${behind[0]}, ${behind[1]}, ${behind[2]})`, ratio: Number(value.toFixed(2)), pass: value >= 3 };
    }).filter(Boolean) as { name: string; tag: string; color: string; background: string; ratio: number; pass: boolean }[];
    const interactive = [...document.querySelectorAll('button,input:not([type="checkbox"]),select,textarea,summary,[role="button"],a[href]')].filter(element => visible(element) && !hidden(element) && !(element.tagName === 'A' && getComputedStyle(element).display === 'inline'));
    const targets = interactive.map(element => { const box = element.getBoundingClientRect(); return { name: label(element), tag: element.tagName, width: Math.round(box.width), height: Math.round(box.height) }; }).filter(target => target.width < 44 || target.height < 44);
    const inputs = [...document.querySelectorAll('input:not([type="checkbox"]),select,textarea')].filter(element => visible(element) && !hidden(element)).map(element => ({ name: label(element), size: Number.parseFloat(getComputedStyle(element).fontSize) }));
    const money = [...document.querySelectorAll('.money-value')].filter(element => visible(element) && !hidden(element));
    const tabular = money.filter(element => !getComputedStyle(element).fontVariantNumeric.includes('tabular-nums')).map(element => label(element));
    const back = root ? null : (() => {
      const element = [...document.querySelectorAll('button,a[href]')].find(candidate => visible(candidate) && !hidden(candidate) && /back|close|cancel/i.test(candidate.getAttribute('aria-label') ?? candidate.textContent ?? '') && candidate.getBoundingClientRect().width >= 44 && candidate.getBoundingClientRect().height >= 44);
      return element ? { label: label(element), width: Math.round(element.getBoundingClientRect().width), height: Math.round(element.getBoundingClientRect().height) } : null;
    })();
    const primaryScope = document.querySelector('.money-actions,.form-actions,.sticky-action,.bottom-navigation');
    const primaryElement = primaryScope ? [...primaryScope.querySelectorAll('button.primary')].filter(element => visible(element)).at(-1) : null;
    const primary = primaryElement ? (() => { const box = primaryElement.getBoundingClientRect(); const center = box.top + box.height / 2; return { label: label(primaryElement), center: Math.round(center), bottom: Math.round(box.bottom), viewport: innerHeight, lower40: center >= innerHeight * .6 }; })() : null;
    const overflow = document.documentElement.scrollWidth > innerWidth + 1;
    const offenders = [...document.querySelectorAll('body *')].filter(element => visible(element) && element.getBoundingClientRect().right > innerWidth + 1).slice(0, 10).map(element => ({ tag: element.tagName, name: label(element), right: Math.round(element.getBoundingClientRect().right) }));
    const offline = state.includes('offline') ? (() => { const banner = document.querySelector('.offline-banner'); return banner && visible(banner) ? label(banner) : null; })() : 'n/a';
    return {
      text: { checked: text.length, violations: text.filter(item => !item.pass) },
      nonText: { checked: nonText.length, violations: nonText.filter(item => !item.pass) },
      targets: { checked: interactive.length, violations: targets },
      inputs: { checked: inputs.length, violations: inputs.filter(input => input.size < 16) },
      tabular: { checked: money.length, violations: tabular },
      back,
      primary,
      overflow,
      offenders,
      offline,
    };
  }, { state, root });
}

async function focusAudit(page: Page) {
  return page.evaluate(() => {
    const visible = (element: Element) => { const style = getComputedStyle(element); const box = element.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && box.width > 0 && box.height > 0; };
    const hidden = (element: Element) => !!element.closest('[aria-hidden="true"],.sr-only');
    const parse = (value: string) => { const match = /rgba?\(([^)]+)\)/.exec(value); if (!match) return null; const parts = match[1]!.split(',').map(Number); return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1] as [number, number, number, number]; };
    const luminance = (color: [number, number, number, number]) => { const channel = (value: number) => { const scaled = value / 255; return scaled <= .03928 ? scaled / 12.92 : ((scaled + .055) / 1.055) ** 2.4; }; return .2126 * channel(color[0]) + .7152 * channel(color[1]) + .0722 * channel(color[2]); };
    const ratio = (left: [number, number, number, number], right: [number, number, number, number]) => { const a = luminance(left), b = luminance(right); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
    const background = (element: Element) => { let node: Element | null = element; while (node) { const color = parse(getComputedStyle(node).backgroundColor); if (color && color[3] > .95) return color; node = node.parentElement; } return [255, 255, 255, 1] as [number, number, number, number]; };
    const target = [...document.querySelectorAll('input:not([type="checkbox"]),select,textarea,button,a[href]')].find(element => visible(element) && !hidden(element));
    if (!target) return null;
    (target as HTMLElement).focus();
    const style = getComputedStyle(target);
    const foreground = parse(style.outlineColor);
    const behind = background(target);
    const result = foreground && style.outlineStyle !== 'none' ? { name: (target.getAttribute('aria-label') ?? target.textContent ?? '').trim().slice(0, 80), color: style.outlineColor, background: `rgb(${behind[0]}, ${behind[1]}, ${behind[2]})`, ratio: Number(ratio(foreground, behind).toFixed(2)), pass: ratio(foreground, behind) >= 3 } : null;
    (target as HTMLElement).blur();
    return result;
  });
}

async function safeArea(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    root.style.setProperty('--safe-top', '59px');
    root.style.setProperty('--safe-bottom', '34px');
    void document.body.offsetHeight;
    const shell = document.querySelector('.app-shell');
    const navigation = document.querySelector('.bottom-navigation');
    const actions = document.querySelector('.money-actions,.form-actions,.sticky-action');
    const buttons = navigation ? [...navigation.querySelectorAll('button')].map(button => button.getBoundingClientRect().bottom) : [];
    const first = Math.min(...[...document.querySelectorAll('.workspace h1,.workspace h2,.workspace p,.workspace .totals,.workspace .players')].map(element => element.getBoundingClientRect().top).filter(value => value >= 0));
    const scrim = getComputedStyle(document.body, '::before');
    const result = {
      contentTop: Number.isFinite(first) ? Math.round(first) : null,
      scrimHeight: Number.parseFloat(scrim.height) || 0,
      top: shell ? Number.parseFloat(getComputedStyle(shell).paddingTop) : null,
      navigationPadding: navigation ? Number.parseFloat(getComputedStyle(navigation).paddingBottom) : null,
      actionsPadding: actions ? Number.parseFloat(getComputedStyle(actions).paddingBottom) : null,
      navigationButtonBottom: buttons.length ? Math.round(Math.max(...buttons)) : null,
      viewport: innerHeight,
    };
    root.style.removeProperty('--safe-top');
    root.style.removeProperty('--safe-bottom');
    return result;
  });
}

async function textSpacing(page: Page) {
  return page.evaluate(async () => {
    const root = document.documentElement;
    const previous = root.style.fontSize;
    const style = document.createElement('style');
    style.textContent = '*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important} p{margin-bottom:2em!important}';
    document.head.append(style);
    const visible = (element: Element) => { const computed = getComputedStyle(element); const box = element.getBoundingClientRect(); return computed.display !== 'none' && computed.visibility !== 'hidden' && Number(computed.opacity) > 0 && box.width > 0 && box.height > 0; };
    const controls = () => [...document.querySelectorAll('button,input:not([type="checkbox"]),select,textarea,summary,[role="button"],a[href]')].filter(visible).length;
    const before = controls();
    root.style.fontSize = '32px';
    document.body.style.width = 'calc(100% - 8px)';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.body.style.width = '';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const clipped = [...document.querySelectorAll('h1,h2,h3,p,span,strong,small,label,dt,dd,li,button')]
      .filter(element => visible(element) && !element.closest('.sr-only') && !element.classList.contains('fit-text') && !element.classList.contains('meta-info') && !element.classList.contains('account-name'))
      .filter(element => { const computed = getComputedStyle(element); return (computed.overflow === 'hidden' || computed.textOverflow === 'ellipsis') && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1); })
      .slice(0, 20).map(element => (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60));
    const after = controls();
    const overflow = root.scrollWidth > innerWidth + 1;
    const offenders = [...document.querySelectorAll('body *')].filter(element => visible(element) && !element.closest('.sr-only') && element.getBoundingClientRect().right > innerWidth + 1).slice(0, 10).map(element => ({ tag: element.tagName, name: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 60) }));
    const wide = [...document.querySelectorAll('body *')].filter(element => visible(element) && !element.closest('.sr-only') && element.scrollWidth > element.clientWidth + 1).slice(0, 20).map(element => ({ tag: element.tagName, name: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60), scroll: element.scrollWidth, client: element.clientWidth }));
    style.remove();
    root.style.fontSize = previous;
    document.body.style.width = 'calc(100% - 8px)';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.body.style.width = '';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { before, after, clipped, overflow, offenders, wide };
  });
}

async function motion(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const seconds = (value: string) => value.split(',').map(part => { const number = Number.parseFloat(part); return part.includes('ms') ? number / 1000 : number; });
    const elements = [...document.querySelectorAll('.skeleton-line,.notice,button,.sheet,.sheet-backdrop')].slice(0, 80);
    let max = 0, worst = '';
    for (const element of elements) {
      const style = getComputedStyle(element);
      const value = Math.max(0, ...[...seconds(style.animationDuration), ...seconds(style.transitionDuration)]);
      if (value > max) { max = value; worst = `${element.tagName}.${String(element.className).slice(0, 30)}`; }
    }
    return { checked: elements.length, max, worst };
  });
  await page.emulateMedia({ reducedMotion: null });
  return result;
}

async function settleViewport(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const agreed = await page.evaluate(() => !window.visualViewport || Math.abs(window.visualViewport.height - innerHeight) < 1);
    if (agreed) break;
    await page.setViewportSize({ width, height: height + 1 });
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(200);
}

async function toastDock(page: Page) {
  return page.evaluate(() => {
    const notice = document.querySelector('.notice');
    const bar = document.querySelector('.bottom-navigation');
    if (!notice || !notice.getClientRects().length || !bar) return null;
    const box = notice.getBoundingClientRect();
    const barBox = bar.getBoundingClientRect();
    const docked = barBox.top > innerHeight / 2 ? barBox.top : innerHeight;
    return { gap: Math.round(docked - box.bottom), flush: Math.abs(docked - box.bottom) <= 1, width: Math.round(box.width), viewport: innerWidth };
  });
}

async function barFlush(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.bottom-navigation');
    if (!bar) return null;
    const box = bar.getBoundingClientRect();
    return { bottom: Math.round(box.bottom), viewport: innerHeight, gap: Math.round(innerHeight - box.bottom) };
  });
}

function redactSecrets(value: unknown, secrets: string[], seen = new Set<unknown>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') { if (secrets.some(secret => secret && item.includes(secret))) (value as Record<string, unknown>)[key] = '[redacted]'; }
    else redactSecrets(item, secrets, seen);
  }
}

async function codeClip(page: Page) {
  return page.evaluate(() => {
    const elements = [...document.querySelectorAll('code,pre')].filter(element => element.getClientRects().length > 0);
    return { checked: elements.length, clipped: elements.filter(element => element.scrollWidth > element.clientWidth + 1).length };
  });
}

async function schemeSwitch(page: Page) {
  const probe = async () => page.evaluate(() => {
    const rgb = (value: string) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const lum = (value: string) => { const parts = rgb(value).map(part => part / 255).map(part => part <= .04045 ? part / 12.92 : ((part + .055) / 1.055) ** 2.4); return parts[0]! * .2126 + parts[1]! * .7152 + parts[2]! * .0722; };
    const contrast = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + .05) / (lo! + .05); };
    return [...document.querySelectorAll('.player-actions button, .session-bottom-bar button, .app-bar button.primary')].map(button => { const style = getComputedStyle(button); return { text: button.textContent?.trim().slice(0, 20), contrast: contrast(style.color, style.backgroundColor) }; });
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(250);
  const light = await probe();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(250);
  const dark = await probe();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(250);
  const failed = [...light, ...dark].filter(item => item.contrast < 4.5);
  return { checked: light.length + dark.length, failed };
}

async function topInset(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => { const root = document.documentElement; root.style.setProperty('--safe-top', '59px'); root.style.setProperty('--safe-bottom', '34px'); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const inset = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0);
  if (!inset) { await page.evaluate(() => { const root = document.documentElement; root.style.removeProperty('--safe-top'); root.style.removeProperty('--safe-bottom'); }); return { inset, first: 0, scrim: false }; }
  const first = await page.evaluate(() => { const scrim = getComputedStyle(document.body, '::before'); const usesScrim = scrim.position === 'fixed' && Number.parseFloat(scrim.height) >= 59; const items = [...document.querySelectorAll('.workspace h1,.workspace h2,.workspace p,.workspace .totals, .workspace button')].map(element => { const rect = element.getBoundingClientRect(); return { top: rect.top, width: rect.width, height: rect.height, tag: `${element.tagName.toLowerCase()}.${element.className}` }; }).filter(item => item.top >= 0 && item.width > 0 && item.height > 0).sort((a, b) => a.top - b.top); return { top: items[0]?.top ?? Number.POSITIVE_INFINITY, tag: items[0]?.tag ?? 'none', usesScrim, scrollTop: window.scrollY }; });
  await page.evaluate(() => { const root = document.documentElement; root.style.removeProperty('--safe-top'); root.style.removeProperty('--safe-bottom'); });
  return { inset, first: first.top, tag: first.tag, scrim: first.usesScrim, scrollTop: first.scrollTop };
}

async function keyboard(page: Page, requirePrimary: boolean) {
  const field = page.locator('input:not([type="checkbox"]),select,textarea').filter({ visible: true }).first();
  if (!await field.count()) return 'n/a';
  await field.focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    Object.defineProperty(viewport, 'height', { configurable: true, value: 380 });
    viewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(180);
  const result = await page.evaluate(() => {
    const active = document.activeElement;
    const box = active ? active.getBoundingClientRect() : null;
    const scope = document.querySelector('.sheet-backdrop .sheet') ?? document.querySelector('.money-actions,.form-actions,.sticky-action,.auth');
    const primary = scope ? [...scope.querySelectorAll('button.primary')].filter(element => element.getClientRects().length).at(-1) : null;
    const primaryBox = primary ? primary.getBoundingClientRect() : null;
    return {
      field: box ? { top: Math.round(box.top), bottom: Math.round(box.bottom) } : null,
      primary: primaryBox ? { top: Math.round(primaryBox.top), bottom: Math.round(primaryBox.bottom) } : null,
      visual: window.visualViewport?.height ?? null,
    };
  });
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    delete (viewport as unknown as Record<string, unknown>).height;
    viewport.dispatchEvent(new Event('resize'));
  });
  return { ...result, fieldVisible: !!result.field && result.field.top >= 0 && result.field.bottom <= 380, primaryVisible: !requirePrimary || !result.primary || result.primary.bottom <= 380 };
}

function violations(audit: Audit) {
  const list: string[] = [];
  const text = audit.text as { violations: unknown[] };
  const nonText = audit.nonText as { violations: unknown[] };
  const targets = audit.targets as { violations: unknown[] };
  const inputs = audit.inputs as { violations: unknown[] };
  const tabular = audit.tabular as { violations: unknown[] };
  const focus = audit.focus as { pass: boolean } | null;
  const back = audit.back as { label: string } | null;
  const primary = audit.primary as { lower40: boolean } | null;
  const switched = audit.schemeCheck as { checked: number; failed: { text: string; contrast: number }[] } | null;
  const inset = audit.topInset as { inset: number; first: number; tag?: string; scrim: boolean; scrollTop?: number } | null;
  const codes = audit.codes as { checked: number; clipped: number } | undefined;
  const bar = audit.bar as { bottom: number; viewport: number; gap: number } | null;
  const barAtCapture = audit.barAtCapture as { gap: number } | null;
  const barAfter = audit.barAfter as { gap: number } | null;
  const toastAtCapture = audit.toastAtCapture as { gap: number; flush: boolean; width: number; viewport: number } | null;
  const insetSafe = audit.safeArea as { contentTop: number | null; scrimHeight: number } | null;
  const safe = audit.safeArea as { top: number | null; navigationPadding: number | null; actionsPadding: number | null; navigationButtonBottom: number | null; viewport: number };
  const spacing = audit.textSpacing as { before: number; after: number; clipped: unknown[]; overflow: boolean };
  const reduced = audit.motion as { max: number; worst?: string };
  const keyboardResult = audit.keyboard as { fieldVisible: boolean; primaryVisible: boolean } | 'n/a';
  if (text.violations.length) list.push(`${text.violations.length} text contrast violations`);
  if (nonText.violations.length) list.push(`${nonText.violations.length} non-text contrast violations`);
  if (targets.violations.length) list.push(`${targets.violations.length} targets below 44px`);
  if (inputs.violations.length) list.push(`${inputs.violations.length} inputs below 16px`);
  if (tabular.violations.length) list.push(`${tabular.violations.length} non-tabular money values`);
  if (focus && !focus.pass) list.push('focus ring below 3:1');
  if (audit.overflow) list.push('horizontal overflow');
  if (!audit.root && !back) list.push('missing 44px back or close control');
  if (primary && !primary.lower40) list.push('pinned primary action outside the lower 40%');
  if (safe.top !== null && safe.top < 59) list.push('top safe area not applied');
  if (safe.navigationPadding !== null && safe.navigationPadding < 34) list.push('bottom bar does not clear the home indicator');
  if (safe.actionsPadding !== null && safe.actionsPadding < 34) list.push('sheet actions do not clear the home indicator');
  if (safe.navigationButtonBottom !== null && safe.navigationButtonBottom > safe.viewport - 34 + 1) list.push('bottom bar controls enter the home indicator');
  if (spacing.clipped.length) list.push(`${spacing.clipped.length} clipped text nodes at 200%`);
  if (spacing.after < spacing.before) list.push('controls lost at 200% text');
  if (spacing.overflow) list.push('horizontal overflow at 200% text');
  if (reduced.max > .02) list.push(`reduced-motion durations remain above 20ms (${reduced.worst} ${Math.round(reduced.max * 1000)}ms)`);
  if (keyboardResult !== 'n/a' && (!keyboardResult.fieldVisible || !keyboardResult.primaryVisible)) list.push('focused field or primary action hidden by the keyboard');
  if (audit.offline !== 'n/a' && !audit.offline) list.push('offline status line missing');
  if (switched && switched.failed.length) list.push(`scheme switch contrast: ${switched.failed.map(item => `${item.text} ${item.contrast.toFixed(2)}:1`).join(', ')}`);
  if (inset && inset.inset > 0 && (inset.scrollTop ?? 0) === 0 && (!inset.scrim || inset.first < inset.inset)) list.push(`content in top inset: first at ${Math.round(inset.first)}px under ${inset.inset}px (${inset.tag ?? '?'})`);
  if (codes && codes.clipped) list.push(`clipped code elements: ${codes.clipped} of ${codes.checked}`);
  const fitOversize = audit.fitOversize as string[] | undefined;
  if (fitOversize && fitOversize.length) list.push(`fit-text oversized: ${fitOversize.slice(0, 3).join(', ')}`);
  const rowAlign = audit.rowAlign as { below: boolean; delta: number; single: boolean; lines: number }[] | undefined;
  if (rowAlign) { const bad = rowAlign.filter(row => (!row.below && Math.abs(row.delta) > 24) || (row.single && row.lines > 1)); if (bad.length) list.push(`row name breaks mid-word or amount off the name line: ${bad.length}`); }
  if (bar && bar.gap > 2) list.push(`bottom bar not flush: ends ${bar.gap}px above the viewport`);
  if (barAtCapture && barAtCapture.gap > 2) list.push(`bottom bar not flush on the captured frame: ${barAtCapture.gap}px gap`);
  if (barAfter && barAfter.gap > 2) list.push(`bottom bar not flush after 1s: ${barAfter.gap}px gap`);
  if (toastAtCapture && !toastAtCapture.flush) list.push(`toast not docked above the bar: ${toastAtCapture.gap}px gap`);
  if (toastAtCapture && toastAtCapture.width < toastAtCapture.viewport - 1) list.push('toast does not span the viewport width');
  if (insetSafe && insetSafe.contentTop !== null && insetSafe.contentTop < 59 && insetSafe.scrimHeight < 59) list.push(`content under the 59px top inset: first at ${insetSafe.contentTop}px with no scrim`);
  return list;
}

export default async function mobileUx({ browser, baseURL, evidence }: RecipeContext) {
  const dir = join(evidence, 'mobile-ux');
  await mkdir(dir, { recursive: true });
  const walkContext = await browser.newContext({ viewport: { width: 393, height: 852 }, ignoreHTTPSErrors: true, baseURL, locale: 'en-US', timezoneId: 'UTC' });
  const page = await walkContext.newPage();
  const results: Audit[] = [];
  const write = async () => writeFile(join(dir, 'mobile-ux.json'), JSON.stringify({ results, violations: results.flatMap(result => result.violations.map(violation => `${result.state} ${result.viewport} ${result.scheme}: ${violation}`)) }, null, 2));
  async function run(target: Page, state: string, root: boolean, requirePrimary = true, maskCodes = false) {
    await shim(target);
    for (const viewport of viewports) {
      for (const scheme of schemes) {
        await settleViewport(target, viewport.width, viewport.height);
        await target.emulateMedia({ colorScheme: scheme });
        const noticeVisible = await target.evaluate(() => !!document.querySelector('.notice'));
        if (!noticeVisible) await target.evaluate(() => window.scrollTo(0, 0));
        if (noticeVisible) {
          await target.evaluate(() => {
            const name = document.querySelector('.notice-name')?.textContent?.trim();
            if (!name) return;
            const row = [...document.querySelectorAll('.player-card')].find(card => (card.textContent ?? '').includes(name));
            if (!row) return;
            const padding = Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) || 0;
            const rect = row.getBoundingClientRect();
            if (rect.top >= 0 && rect.bottom <= innerHeight - padding) return;
            row.scrollIntoView({ block: 'nearest' });
          });
          await target.waitForTimeout(450);
        }
        await target.waitForTimeout(80);
        const barAtCapture = root ? await barFlush(target) : null;
        const toastAtCapture = await toastDock(target);
        if (state === 'recovery-codes' && !maskCodes) throw new Error('recovery-code captures must be masked');
        await target.screenshot({ path: join(dir, `${state}-${viewport.width}x${viewport.height}-${scheme}.png`), ...(maskCodes ? { mask: [target.locator('code, pre')], maskColor: '#000000' } : {}) });
        await target.waitForTimeout(1000);
        const barAfter = root ? await barFlush(target) : null;
        const reduced = await motion(target);
        const statics = await staticAudit(target, state, root);
        const layoutFindings = await checkLayout(target, maskCodes);
        const safe = await safeArea(target);
        const spacing = await textSpacing(target);
        const rowAlign = await target.evaluate(() => [...document.querySelectorAll('.player-card')].map(card => { const name = card.querySelector('.player-name strong'); const amount = card.querySelector('.player-detail'); if (!name || !amount) return null; const n = name.getBoundingClientRect(); const a = amount.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(name); return { below: card.classList.contains('amount-below'), delta: Math.round(a.top - n.top), single: !(name.textContent ?? '').trim().includes(' '), lines: range.getClientRects().length }; }).filter(Boolean));
        const fitOversize = await target.evaluate(() => [...document.querySelectorAll<HTMLElement>('.fit-text')].map(element => { const inline = element.style.fontSize; if (!inline) return null; element.style.fontSize = ''; const base = Number.parseFloat(getComputedStyle(element).fontSize); element.style.fontSize = inline; const fitted = Number.parseFloat(inline); return fitted > base + .5 ? `${(element.textContent ?? '').slice(0, 16)} ${Math.round(fitted)}px > ${Math.round(base)}px` : null; }).filter(Boolean));
        const keyboardResult = await keyboard(target, requirePrimary);
        const focus = await focusAudit(target);
        const schemeCheck = state.startsWith('table') || state === 'viewer' ? await schemeSwitch(target) : null;
        const inset = root ? await topInset(target) : null;
        const codes = await codeClip(target);
        const bar = root ? await barFlush(target) : null;
        const audit = { state, viewport: viewport.name, scheme, root, ...statics, layout: layoutFindings, focus, safeArea: safe, textSpacing: spacing, fitOversize, rowAlign, motion: reduced, keyboard: keyboardResult, schemeCheck, topInset: inset, codes, bar, barAtCapture, barAfter, toastAtCapture, violations: [] as string[] } as Audit;
        if (maskCodes) {
          const secretCodes = await target.evaluate(() => [...document.querySelectorAll('[data-testid="recovery-codes"] code')].map(element => element.textContent ?? ''));
          redactSecrets(audit, secretCodes);
          const serialized = JSON.stringify(audit);
          if (secretCodes.some(code => code && serialized.includes(code))) throw new Error('recovery-code text leaked into the audit');
        }
        audit.violations = [...violations(audit), ...layoutFindings.map(issue => `${issue.kind}: ${issue.detail}`)];
        results.push(audit);
        await write();
      }
    }
    await target.emulateMedia({ colorScheme: 'light' });
    await target.setViewportSize({ width: 393, height: 852 });
  }
  async function close() {
    const dialog = page.getByRole('dialog');
    if (!await dialog.count()) return;
    const cancel = dialog.getByRole('button', { name: /^(Cancel|Close sheet)$/ }).first();
    if (await cancel.isVisible().catch(() => false)) await cancel.click();
    const discard = page.getByRole('button', { name: 'Discard draft', exact: true });
    if (await discard.isVisible().catch(() => false)) await discard.click();
    else if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  async function menu(item: string) {
    await page.getByRole('button', { name: 'Session menu', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: item, exact: true }).click();
  }
  async function toastScenario(playerId: string, longId: string) {
    for (const viewport of viewports) {
      await settleViewport(page, viewport.width, viewport.height);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(150);
      await money(page, playerId, '25');
      await page.waitForTimeout(700);
      const dock = await toastDock(page);
      const changed = await page.evaluate(id => {
        const row = document.querySelector(`[data-player="${id}"]`);
        if (!row) return null;
        const rect = row.getBoundingClientRect();
        const padding = Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) || 0;
        return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), limit: Math.round(innerHeight - padding), visible: rect.top >= 0 && rect.bottom <= innerHeight - padding + 1 };
      }, playerId);
      const steady = await page.evaluate(() => Math.round(scrollY));
      await page.waitForTimeout(2000);
      const after = await page.evaluate(() => Math.round(scrollY));
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(250);
      const clear = await page.evaluate(() => {
        const notice = document.querySelector('.notice');
        const rows = [...document.querySelectorAll('.player-card')];
        const last = rows[rows.length - 1];
        if (!notice || !last) return null;
        const top = notice.getBoundingClientRect().top;
        const boxes = [...last.querySelectorAll('.money-value, button')].map(node => node.getBoundingClientRect());
        return { top: Math.round(top), lowest: Math.round(Math.max(...boxes.map(rect => rect.bottom))), clear: boxes.every(rect => rect.bottom <= top + 1) };
      });
      const violations: string[] = [];
      if (!dock || !dock.flush) violations.push(`toast not docked above the bar: ${dock ? dock.gap : 'missing'}px gap`);
      if (dock && dock.width < dock.viewport - 1) violations.push('toast does not span the viewport width');
      if (!changed || !changed.visible) violations.push(`just-changed row not fully visible: ${changed ? `${changed.bottom} > ${changed.limit}` : 'missing'}`);
      if (after !== steady) violations.push(`scroll moved while the notice was visible: ${steady} -> ${after}`);
      if (!clear || !clear.clear) violations.push(`last row not clear of the chrome at max scroll: ${clear ? `${clear.lowest} > ${clear.top}` : 'missing'}`);
      const nameFit = await page.evaluate(() => { const name = document.querySelector('.notice-name'); return name ? { padded: name.clientWidth - name.scrollWidth } : null; });
      if (nameFit && nameFit.padded > 2) violations.push(`toast name padded by ${nameFit.padded}px`);
      if (viewport.width === 320) {
        await money(page, longId, '123456789.99', { kind: 'Record payment', paid: true });
        await page.waitForTimeout(700);
        const metrics = await page.evaluate(() => {
          const notice = document.querySelector('.notice');
          const name = notice?.querySelector('.notice-name')?.getBoundingClientRect();
          const tail = notice?.querySelector('.notice-tail')?.getBoundingClientRect();
          const undo = notice?.querySelector('button')?.getBoundingClientRect();
          return notice ? { nameWidth: name?.width ?? 0, tailRight: tail?.right ?? 0, undoLeft: undo?.left ?? 0, height: notice.getBoundingClientRect().height } : null;
        });
        if (!metrics) violations.push('toast missing for the large payment');
        else {
          if (metrics.nameWidth < 40) violations.push(`toast name collapsed to ${Math.round(metrics.nameWidth)}px`);
          if (metrics.tailRight > metrics.undoLeft + 1) violations.push('toast amount runs under Undo');
          if (metrics.height > 80) violations.push(`toast taller than two lines: ${Math.round(metrics.height)}px`);
        }
      }
      results.push({ state: 'toast-dock', viewport: viewport.name, scheme: 'light', root: true, dock, changed, steady, after, clear, violations } as unknown as Audit);
      await write();
    }
    await settleViewport(page, 393, 852);
  }
  try {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to the bank', exact: true })).toBeVisible();
  await run(page, 'auth', true, false);
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await typeInput(page.getByLabel('Username', { exact: true }), `ux-${Date.now().toString(36)}`);
  await typeInput(page.getByLabel('Password', { exact: true }), 'mobile-ux-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery codes', exact: true })).toBeVisible();
  await run(page, 'recovery-codes', true, true, true);
  await page.getByRole('checkbox', { name: 'I saved these codes' }).check();
  await page.getByRole('button', { name: 'Continue to table', exact: true }).click();
  await workspaceReady(page);
  await run(page, 'table-empty', true);
  await newSession(page, 'Mobile UX home game');
  const justin = await addPlayer(page, 'Mobile Justin');
  const alexandra = await addPlayer(page, 'Mobile Alexandra Montgomery-Vanderbilt the Third');
  const sam = await addPlayer(page, 'Mobile Sam');
  const priya = await addPlayer(page, 'Mobile Priya');

  await money(page, justin.id, '100');
  await money(page, alexandra.id, '123456789.99', { method: 'venmo' });
  await money(page, sam.id, '50', { paid: false });
  await money(page, priya.id, '200', { method: 'zelle' });
  await run(page, 'table-playing', true);
  await toastScenario(sam.id, alexandra.id);
  await money(page, justin.id, '350', { kind: 'Cash out', paid: true });
  await money(page, priya.id, '350', { kind: 'Cash out' });
  await run(page, 'table-mixed', true);
  await page.getByTestId(`player-${justin.id}`).click();
  await run(page, 'sheet-player-cashed-out', false);
  await close();
  await page.getByTestId(`player-${alexandra.id}`).click();
  await run(page, 'sheet-player-owing', false);
  await close();
  await page.getByTestId(`player-${alexandra.id}`).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Buy-in', exact: true }).click();
  await run(page, 'sheet-buy-in', false);
  await close();
  await page.getByTestId(`cash-out-${sam.id}`).click();
  await run(page, 'sheet-cash-out', false);
  await close();
  await page.getByTestId(`player-${sam.id}`).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record payment', exact: true }).click();
  await run(page, 'sheet-payment-in', false);
  await close();
  await page.getByTestId(`settle-${priya.id}`).click();
  await run(page, 'sheet-payment-out', false);
  await close();
  await page.getByTestId(`player-${sam.id}`).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Tips and meals', exact: true }).click();
  await run(page, 'sheet-expense', false);
  await close();
  await page.locator('.session-board .entry-list button.entry-row').first().click();
  await run(page, 'sheet-correction', false);
  await close();
  await page.getByRole('button', { name: 'Add player', exact: true }).click();
  await run(page, 'sheet-add-player', false);
  await close();
  await page.getByRole('button', { name: 'Session menu', exact: true }).click();
  await run(page, 'sheet-session-menu', false);
  await page.getByRole('dialog').getByRole('button', { name: 'Session settings', exact: true }).click();
  await run(page, 'sheet-settings', false);
  await close();
  await page.getByRole('button', { name: 'Session menu', exact: true }).click();
  await run(page, 'sheet-session-menu-blocked', false);
  await close();
  await menu('Share session');
  await run(page, 'sheet-share', false);
  await close();
  await page.getByRole('button', { name: 'Switch session', exact: true }).click();
  await run(page, 'sheet-picker', false);
  await close();
  await page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Players', exact: true }).click();
  await page.waitForTimeout(500);
  await run(page, 'players', true);
  await page.getByTestId(`roster-player-${justin.id}`).click();
  await expect(page.getByTestId('player-report')).toHaveAttribute('aria-busy', 'false');
  await run(page, 'player-report', false);
  await page.getByRole('button', { name: 'Back to players', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await run(page, 'sheet-signout', false);
  await close();
  await page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Table', exact: true }).click();
  const link = await share(page);
  const viewerContext = await browser.newContext({ viewport: { width: 393, height: 852 }, ignoreHTTPSErrors: true, baseURL, locale: 'en-US', timezoneId: 'UTC' });
  try {
    const viewer = await viewerContext.newPage();
    await viewer.goto(link);
    await expect(viewer.getByText(/View only ·/)).toBeVisible();
    await run(viewer, 'viewer', true);
  } finally { await viewerContext.close(); }
  await walkContext.setOffline(true);
  await page.waitForTimeout(600);
  await run(page, 'offline-table', true);
  await walkContext.setOffline(false);
  await page.waitForTimeout(400);
  await page.locator('.session-board .entry-list button.entry-row').first().click();
  await page.getByRole('button', { name: 'Delete entry', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.getByTestId('save-status')).toContainText('Deleted');
  await page.locator('.session-board .entry-list li.is-voided button.entry-row').first().click();
  await run(page, 'sheet-deleted-entry', false);
  await close();
  await page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Table', exact: true }).click();
  await money(page, sam.id, '0', { kind: 'Cash out' });
  await money(page, alexandra.id, '123456789.99', { kind: 'Cash out' });
  for (const player of [justin, priya]) {
    const state = await current(page);
    if (state.players.find(row => row.id === player.id)?.state === 'playing') await money(page, player.id, '0', { kind: 'Cash out' });
  }
  await settleViewport(page, 320, 568);
  await page.getByTestId(`player-${priya.id}`).click();
  await page.getByRole('button', { name: 'Remove from game', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm remove', exact: true }).click();
  await expect(page.getByTestId('save-status')).toContainText(/Removed/, { timeout: 15000 });
  await page.getByTestId('removed-players').getByText(/^Removed/).click();
  await page.waitForTimeout(700);
  const removedClearance = await page.evaluate(() => {
    const restore = document.querySelector<HTMLElement>('[data-testid="removed-players"] button');
    const toast = document.querySelector<HTMLElement>('.notice');
    if (!restore) return null;
    const box = restore.getBoundingClientRect();
    return { top: Math.round(box.top), bottom: Math.round(box.bottom), toastTop: toast ? Math.round(toast.getBoundingClientRect().top) : Math.round(innerHeight) };
  });
  const removedViolations: string[] = [];
  if (!removedClearance || removedClearance.top < 0 || removedClearance.bottom > removedClearance.toastTop) removedViolations.push(`removed restore row not clear of the toast: ${removedClearance ? `${removedClearance.bottom} > ${removedClearance.toastTop}` : 'missing'}`);
  results.push({ state: 'removed-row', viewport: 'narrow', scheme: 'light', root: true, clearance: removedClearance, violations: removedViolations } as unknown as Audit);
  await write();
  await settleViewport(page, 393, 852);
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: 'Session menu', exact: true }).click();
  await run(page, 'sheet-session-menu-ready', false);
  await close();
  await menu('Close session');
  await run(page, 'sheet-close', false);
  const accept = page.getByRole('dialog').getByRole('checkbox', { name: /^Accept / });
  if (await accept.count()) await accept.check();
  await page.getByRole('dialog').getByRole('button', { name: 'Close session', exact: true }).click();
  await expect(page.getByTestId('save-status')).toContainText(/closed/i);
  await page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Players', exact: true }).click();
  await page.getByTestId(`roster-player-${justin.id}`).click();
  await expect(page.getByTestId('player-report')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: /^Filter/ }).click();
  await run(page, 'sheet-filter', false);
  await close();
  await page.getByRole('button', { name: 'Back to players', exact: true }).click();
  await write();
  } finally { await walkContext.close(); }
  const failed = results.flatMap(result => result.violations.map(violation => `${result.state} ${result.viewport} ${result.scheme}: ${violation}`));
  if (failed.length) throw new Error(`Mobile UX violations:\n${failed.join('\n')}`);
}
