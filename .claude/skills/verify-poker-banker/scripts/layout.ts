import type { Page } from '@playwright/test';

export type LayoutIssue = { kind: 'page-overflow' | 'offscreen' | 'wrapped-money' | 'clipped-text' | 'small-target' | 'row-misaligned'; detail: string };

export async function checkLayout(page: Page): Promise<LayoutIssue[]> {
  await page.evaluate('globalThis.__name = globalThis.__name || (value => value)');
  return page.evaluate(() => {
    const issues: { kind: string; detail: string }[] = [];
    const width = document.documentElement.clientWidth;
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
    };
    const label = (element: Element) => `${element.tagName.toLowerCase()}${element.getAttribute('data-testid') ? `[${element.getAttribute('data-testid')}]` : ''} "${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)}"`;
    const hiddenText = (element: Element) => !!element.closest('.sr-only, .visually-hidden') || getComputedStyle(element).clip === 'rect(0px, 0px, 0px, 0px)' || getComputedStyle(element).clipPath === 'inset(50%)';
    const clippedByAncestor = (element: Element) => {
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(hidden|clip)/.test(style.overflowX) && style.textOverflow === 'ellipsis') return true;
      }
      return false;
    };
    const scrolls = (element: Element | null): boolean => {
      for (let node = element; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth) return true;
      }
      return false;
    };
    if (document.scrollingElement && document.scrollingElement.scrollWidth > width + 1) issues.push({ kind: 'page-overflow', detail: `scrollWidth ${document.scrollingElement.scrollWidth} > ${width}` });
    for (const element of Array.from(document.querySelectorAll('body *'))) {
      if (!visible(element) || element.closest('[aria-hidden="true"]') || hiddenText(element)) continue;
      const box = element.getBoundingClientRect();
      if ((box.right > width + 1 || box.left < -1) && !scrolls(element.parentElement) && !clippedByAncestor(element) && element.children.length === 0) issues.push({ kind: 'offscreen', detail: `${label(element)} spans ${Math.round(box.left)}..${Math.round(box.right)} of ${width}` });
      const style = getComputedStyle(element);
      if (element.children.length === 0 && element.scrollWidth > element.clientWidth + 1 && style.overflowX === 'hidden' && style.textOverflow !== 'ellipsis' && !/(INPUT|TEXTAREA|SELECT)/.test(element.tagName)) issues.push({ kind: 'clipped-text', detail: label(element) });
      if (element.matches('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab]') && !element.closest('.visually-hidden, .sr-only')) {
        const target = element.closest('label') ?? element;
        const rect = target.getBoundingClientRect();
        if ((rect.height < 43.5 || rect.width < 43.5) && !(element as HTMLInputElement).type?.match(/checkbox|radio/)) issues.push({ kind: 'small-target', detail: `${label(element)} ${Math.round(rect.width)}x${Math.round(rect.height)}` });
      }
    }
    const money = /[−\-+]?(?:[$€£¥]|[A-Z]{1,3}\$)\s?\d[\d,]*(?:\.\d+)?/g;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      const parent = node.parentElement;
      if (!parent || !visible(parent) || parent.closest('[aria-hidden="true"], input, textarea')) continue;
      for (const match of text.matchAll(money)) {
        const range = document.createRange();
        range.setStart(node, match.index!);
        range.setEnd(node, match.index! + match[0].length);
        const tops = new Set(Array.from(range.getClientRects()).filter(rect => rect.width > 0).map(rect => Math.round(rect.top)));
        if (tops.size > 1) issues.push({ kind: 'wrapped-money', detail: `"${match[0]}" in ${label(parent)}` });
      }
    }
    const rows = Array.from(document.querySelectorAll('[aria-label="Session players"] [data-testid^="player-"]')).filter(visible);
    if (rows.length > 1) {
      const edges = (selector: string, pick: (rect: DOMRect) => number) => rows.map(row => { const found = Array.from(row.parentElement?.querySelectorAll(selector) ?? []).filter(visible).map(element => pick(element.getBoundingClientRect())); return found.length ? Math.round(Math.max(...found)) : null; });
      const names = rows.map(row => { const name = row.querySelector('strong'); return name ? Math.round(name.getBoundingClientRect().left) : null; });
      const spread = (values: (number | null)[]) => { const real = values.filter((value): value is number => value !== null); return real.length > 1 ? Math.max(...real) - Math.min(...real) : 0; };
      if (spread(names) > 1) issues.push({ kind: 'row-misaligned', detail: `name left edges ${names.join(',')}` });
      const buttonRights = edges('button', rect => rect.right);
      if (spread(buttonRights) > 1) issues.push({ kind: 'row-misaligned', detail: `row right edges ${buttonRights.join(',')}` });
      const heights = rows.map(row => Math.round((row.closest('li, [role=listitem]') ?? row.parentElement ?? row).getBoundingClientRect().height));
      if (Math.max(...heights) - Math.min(...heights) > 1) issues.push({ kind: 'row-misaligned', detail: `row heights ${heights.join(',')}` });
    }
    return issues;
  }) as Promise<LayoutIssue[]>;
}
