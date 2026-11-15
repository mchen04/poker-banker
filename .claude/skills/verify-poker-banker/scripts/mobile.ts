import { expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecipeContext } from './control';
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
    const result = {
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
  return page.evaluate(() => {
    const root = document.documentElement;
    const previous = root.style.fontSize;
    const style = document.createElement('style');
    style.textContent = '*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important} p{margin-bottom:2em!important}';
    document.head.append(style);
    const visible = (element: Element) => { const computed = getComputedStyle(element); const box = element.getBoundingClientRect(); return computed.display !== 'none' && computed.visibility !== 'hidden' && Number(computed.opacity) > 0 && box.width > 0 && box.height > 0; };
    const controls = () => [...document.querySelectorAll('button,input:not([type="checkbox"]),select,textarea,summary,[role="button"],a[href]')].filter(visible).length;
    const before = controls();
    root.style.fontSize = '32px';
    void document.body.offsetHeight;
    const clipped = [...document.querySelectorAll('h1,h2,h3,p,span,strong,small,label,dt,dd,li,button')]
      .filter(element => visible(element) && !element.closest('.sr-only') && !element.classList.contains('fit-text') && !element.classList.contains('meta-info') && !element.classList.contains('account-name'))
      .filter(element => { const computed = getComputedStyle(element); return (computed.overflow === 'hidden' || computed.textOverflow === 'ellipsis') && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1); })
      .slice(0, 20).map(element => (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60));
    const after = controls();
    const overflow = root.scrollWidth > innerWidth + 1;
    const offenders = [...document.querySelectorAll('body *')].filter(element => visible(element) && element.getBoundingClientRect().right > innerWidth + 1).slice(0, 10).map(element => ({ tag: element.tagName, name: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 60) }));
    const wide = [...document.querySelectorAll('body *')].filter(element => visible(element) && element.scrollWidth > element.clientWidth + 1).slice(0, 20).map(element => ({ tag: element.tagName, name: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60), scroll: element.scrollWidth, client: element.clientWidth }));
    style.remove();
    root.style.fontSize = previous;
    return { before, after, clipped, overflow, offenders, wide };
  });
}

async function motion(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const seconds = (value: string) => value.split(',').map(part => { const number = Number.parseFloat(part); return part.includes('ms') ? number / 1000 : number; });
    const elements = [...document.querySelectorAll('.skeleton-line,.notice,button,.sheet,.sheet-backdrop')].slice(0, 80);
    const durations = elements.flatMap(element => { const style = getComputedStyle(element); return [...seconds(style.animationDuration), ...seconds(style.transitionDuration)]; });
    return { checked: elements.length, max: Math.max(0, ...durations) };
  });
  await page.emulateMedia({ reducedMotion: null });
  return result;
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
    const scope = document.querySelector('.money-actions,.form-actions,.sticky-action,.sheet,.auth');
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
  const safe = audit.safeArea as { top: number | null; navigationPadding: number | null; actionsPadding: number | null; navigationButtonBottom: number | null; viewport: number };
  const spacing = audit.textSpacing as { before: number; after: number; clipped: unknown[]; overflow: boolean };
  const reduced = audit.motion as { max: number };
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
  if (reduced.max > .02) list.push('reduced-motion durations remain above 20ms');
  if (keyboardResult !== 'n/a' && (!keyboardResult.fieldVisible || !keyboardResult.primaryVisible)) list.push('focused field or primary action hidden by the keyboard');
  if (audit.offline !== 'n/a' && !audit.offline) list.push('offline status line missing');
  return list;
}

export default async function mobileUx({ page, context, browser, baseURL, evidence }: RecipeContext) {
  const dir = join(evidence, 'mobile-ux');
  await mkdir(dir, { recursive: true });
  const results: Audit[] = [];
  const write = async () => writeFile(join(dir, 'mobile-ux.json'), JSON.stringify({ results, violations: results.flatMap(result => result.violations.map(violation => `${result.state} ${result.viewport} ${result.scheme}: ${violation}`)) }, null, 2));
  async function run(target: Page, state: string, root: boolean, requirePrimary = true) {
    await shim(target);
    for (const viewport of viewports) {
      for (const scheme of schemes) {
        await target.setViewportSize({ width: viewport.width, height: viewport.height });
        await target.emulateMedia({ colorScheme: scheme });
        await target.evaluate(() => window.scrollTo(0, 0));
        await target.waitForTimeout(80);
        await target.screenshot({ path: join(dir, `${state}-${viewport.width}x${viewport.height}-${scheme}.png`) });
        const reduced = await motion(target);
        const statics = await staticAudit(target, state, root);
        const safe = await safeArea(target);
        const spacing = await textSpacing(target);
        const keyboardResult = await keyboard(target, requirePrimary);
        const focus = await focusAudit(target);
        const audit = { state, viewport: viewport.name, scheme, root, ...statics, focus, safeArea: safe, textSpacing: spacing, motion: reduced, keyboard: keyboardResult, violations: [] as string[] } as Audit;
        audit.violations = violations(audit);
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
  await page.goto('/');
  await workspaceReady(page);
  await run(page, 'table-empty', true);
  await newSession(page, 'Mobile UX home game');
  const justin = await addPlayer(page, 'Justin');
  const alexandra = await addPlayer(page, 'Alexandra Montgomery-Vanderbilt the Third');
  const sam = await addPlayer(page, 'Sam');
  const priya = await addPlayer(page, 'Priya');
  await money(page, justin.id, '100');
  await money(page, alexandra.id, '123456789.99', { method: 'venmo' });
  await money(page, sam.id, '50', { paid: false });
  await money(page, priya.id, '200', { method: 'zelle' });
  await run(page, 'table-playing', true);
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
  await menu('Close session');
  await run(page, 'sheet-close', false);
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
  await page.getByRole('button', { name: 'Filter · Off', exact: true }).click();
  await run(page, 'sheet-filter', false);
  await close();
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
  await context.setOffline(true);
  await page.waitForTimeout(600);
  await run(page, 'offline-table', true);
  await context.setOffline(false);
  await page.waitForTimeout(400);
  await page.locator('.session-board .entry-list button.entry-row').first().click();
  await page.getByRole('button', { name: 'Delete entry', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.getByTestId('save-status')).toContainText('Deleted');
  await page.locator('.session-board .entry-list li.is-voided button.entry-row').first().click();
  await run(page, 'sheet-deleted-entry', false);
  await close();
  await page.getByRole('navigation', { name: 'Table navigation', exact: true }).getByRole('button', { name: 'Players', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const discard = page.getByRole('dialog').getByRole('checkbox', { name: /Discard unsent entries and drafts/ });
  if (await discard.count()) await discard.check();
  await page.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to the bank', exact: true })).toBeVisible();
  await run(page, 'auth', true, false);
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await typeInput(page.getByLabel('Username', { exact: true }), `ux-${Date.now().toString(36)}`);
  await typeInput(page.getByLabel('Password', { exact: true }), 'mobile-ux-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery codes', exact: true })).toBeVisible();
  await run(page, 'recovery-codes', true, false);
  await write();
  const failed = results.flatMap(result => result.violations.map(violation => `${result.state} ${result.viewport} ${result.scheme}: ${violation}`));
  if (failed.length) throw new Error(`Mobile UX violations:\n${failed.join('\n')}`);
}
