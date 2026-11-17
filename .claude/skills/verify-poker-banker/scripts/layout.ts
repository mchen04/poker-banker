import type { Page } from '@playwright/test';

export type LayoutIssue = { kind: 'page-overflow' | 'offscreen' | 'wrapped-money' | 'clipped-money' | 'clipped-text' | 'small-target' | 'row-misaligned' | 'text-overlap' | 'mid-word-break' | 'wrapped-label' | 'title-text' | 'text-gap'; detail: string };

export async function checkLayout(page: Page, redactCodes = false): Promise<LayoutIssue[]> {
  await page.evaluate('globalThis.__name = globalThis.__name || (value => value)');
  return page.evaluate((redactCodes) => {
    const issues: { kind: string; detail: string }[] = [];
    const width = document.documentElement.clientWidth;
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
    };
    const secret = (node: Node | null) => redactCodes && (node?.nodeType === 1 ? node as Element : node?.parentElement)?.closest('[data-testid="recovery-codes"]');
    const label = (element: Element) => `${element.tagName.toLowerCase()}${element.getAttribute('data-testid') ? `[${element.getAttribute('data-testid')}]` : ''} "${secret(element) ? '[redacted]' : (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)}"`;
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
    const snippet = (node: Node) => secret(node) ? '[redacted]' : (node.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 44);
    const skipped = (element: Element) => !!element.closest('[aria-hidden="true"], .sr-only, .visually-hidden, script, style, input, textarea, select, option');
    const layer = (element: Element) => {
      for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).position === 'fixed') return node;
      }
      return null;
    };
    const overlay = (element: Element) => !!element.closest('.sticky-action, .sheet-header');
    if (document.scrollingElement && document.scrollingElement.scrollWidth > width + 1) issues.push({ kind: 'page-overflow', detail: `scrollWidth ${document.scrollingElement.scrollWidth} > ${width}` });
    for (const container of document.querySelectorAll('body *')) {
      const style = getComputedStyle(container);
      if (style.display !== 'flex' && style.display !== 'grid') continue;
      const children = [...container.children];
      if (children.length < 2 || !children.every(child => child.tagName === 'SPAN' && (child.textContent ?? '').trim() && child.getClientRects().length > 0)) continue;
      const dom = (container.textContent ?? '').replace(/\s+/g, ' ').trim();
      const shown = ((container as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
      if (dom && shown && dom !== shown && dom.replace(/\s+/g, '') === shown.replace(/\s+/g, '') && dom.length > shown.length) issues.push({ kind: 'text-gap', detail: `"${shown.slice(0, 40)}" vs "${dom.slice(0, 40)}"` });
    }
    for (const text of document.querySelectorAll('.notice-text')) {
      const parts = (['.notice-label', '.notice-name', '.notice-tail'].map(selector => text.querySelector(selector)?.getBoundingClientRect()).filter(Boolean) as DOMRect[]).sort((a, b) => a.left - b.left);
      for (let index = 1; index < parts.length; index++) {
        const left = parts[index - 1]!, right = parts[index]!;
        if (Math.abs(left.top + left.height / 2 - (right.top + right.height / 2)) > 6) continue;
        const gap = right.left - left.right;
        if (gap < 3) issues.push({ kind: 'text-gap', detail: `toast separator gap ${Math.round(gap)}px` });
      }
    }
    for (const name of document.querySelectorAll('.notice-name')) {
      const padded = (name as HTMLElement).clientWidth - (name as HTMLElement).scrollWidth;
      if (padded > 2) issues.push({ kind: 'text-gap', detail: `toast name padded by ${padded}px` });
    }
    for (const heading of document.querySelectorAll('h1[title]')) {
      const expected = (heading.getAttribute('title') ?? '').replace(/[\u200b\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
      const shown = (heading.textContent ?? '').replace(/[\u200b\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
      if (expected && shown !== expected) issues.push({ kind: 'title-text', detail: `"${shown}" vs "${expected}"` });
    }
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
    type TextBox = { node: Text; element: Element; rects: DOMRect[]; layer: Element | null };
    type WordBox = { text: string; element: Element; rects: DOMRect[]; layer: Element | null };
    const boxes: TextBox[] = [];
    const words: WordBox[] = [];
    const intersect = (left: DOMRect, right: DOMRect) => new DOMRect(Math.max(left.left, right.left), Math.max(left.top, right.top), Math.min(left.right, right.right) - Math.max(left.left, right.left), Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
    const clipOf = (element: Element) => {
      let rect: DOMRect | null = null;
      for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (!/(hidden|clip|auto|scroll)/.test(style.overflowX) && !/(hidden|clip|auto|scroll)/.test(style.overflowY)) continue;
        const box = node.getBoundingClientRect();
        rect = rect ? intersect(rect, box) : box;
      }
      return rect;
    };
    const viewport = new DOMRect(0, 0, innerWidth, innerHeight);
    const inClosedDetails = (element: Element) => {
      const details = element.closest('details');
      return !!details && !details.open && !element.closest('summary');
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      if (!text.trim()) continue;
      const element = node.parentElement;
      if (!element || skipped(element) || !visible(element) || inClosedDetails(element)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const clip = clipOf(element);
      const rects = Array.from(range.getClientRects()).map(rect => intersect(intersect(rect, clip ?? viewport), viewport)).filter(rect => rect.width > 1 && rect.height > 1);
      if (!rects.length) continue;
      boxes.push({ node: node as Text, element, rects, layer: layer(element) });
      for (const match of text.matchAll(/\S+/g)) {
        const wordRange = document.createRange();
        wordRange.setStart(node, match.index!);
        wordRange.setEnd(node, match.index! + match[0].length);
        const wordRects = Array.from(wordRange.getClientRects()).map(rect => intersect(intersect(rect, clip ?? viewport), viewport)).filter(rect => rect.width > 1 && rect.height > 1);
        if (wordRects.length) words.push({ text: match[0], element, rects: wordRects, layer: layer(element) });
      }
    }
    const overlap = (left: DOMRect, right: DOMRect) => Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left)) * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
    const elementBoxes = new Map<Element, DOMRect>();
    const boxOf = (element: Element) => {
      const cached = elementBoxes.get(element);
      if (cached) return cached;
      const box = element.getBoundingClientRect();
      elementBoxes.set(element, box);
      return box;
    };
    const reported = new Set<string>();
    for (let first = 0; first < words.length; first++) {
      for (let second = first + 1; second < words.length; second++) {
        const left = words[first]!, right = words[second]!;
        if (left.layer !== right.layer) continue;
        if (overlay(left.element) !== overlay(right.element)) continue;
        if (left.element === right.element || left.element.contains(right.element) || right.element.contains(left.element)) continue;
        if (overlap(boxOf(left.element), boxOf(right.element)) <= 0) continue;
        let hit = 0;
        for (const a of left.rects) for (const b of right.rects) {
          const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (vertical < Math.min(a.height, b.height) * 0.5) continue;
          hit = Math.max(hit, overlap(a, b));
        }
        if (hit <= 40) continue;
        const key = `${left.text}|${right.text}`;
        if (reported.has(key)) continue;
        reported.add(key);
        issues.push({ kind: 'text-overlap', detail: `"${left.text}" over "${right.text}" (${Math.round(hit)}px²) [${left.element.tagName}.${left.element.className} vs ${right.element.tagName}.${right.element.className}; y ${Math.round(left.rects[0]!.top)}/${Math.round(right.rects[0]!.top)}]` });
      }
    }
    const word = (text: string, index: number) => {
      let start = index, end = index;
      while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
      while (end < text.length && !/\s/.test(text[end]!)) end++;
      return text.slice(start, end);
    };
    for (const box of boxes) {
      const text = box.node.textContent ?? '';
      if (box.rects.length < 2 || text.length > 400) continue;
      const parent = box.node.parentElement;
      if (!/\s/.test(text.trim()) && parent && parent.scrollWidth <= parent.clientWidth + 1) continue;
      const tops: number[] = [];
      for (let index = 0; index < text.length; index++) {
        const range = document.createRange();
        range.setStart(box.node, index);
        range.setEnd(box.node, index + 1);
        const rect = range.getClientRects()[0];
        tops.push(rect ? Math.round(rect.top) : -1);
      }
      for (let index = 1; index < text.length; index++) {
        if (tops[index] === -1 || tops[index - 1] === -1 || tops[index] === tops[index - 1]) continue;
        const before = text[index - 1]!, after = text[index]!;
        if (/\s/.test(before) || /\s/.test(after) || before === '-') continue;
        issues.push({ kind: 'mid-word-break', detail: `"${word(text, index)}" in ${label(box.element)}` });
        break;
      }
      const inControl = box.element.closest('button, [role="button"], summary, a[href]');
      if (inControl && (inControl.textContent ?? '').trim() === text.trim() && text.trim().length <= 30) {
        const lines = new Set(box.rects.map(rect => Math.round(rect.top)));
        if (lines.size > 1) issues.push({ kind: 'wrapped-label', detail: `"${text.trim()}" spans ${lines.size} lines in ${label(inControl)}` });
      }
    }
    const money = /[−\-+]?(?:[$€£¥]|[A-Z]{1,3}\$)\s?\d[\d,]*(?:\.\d+)?/g;
    const clipRect = (element: Element) => {
      let rect: DOMRect | null = null;
      for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (!/(hidden|clip)/.test(style.overflowX) && !/(hidden|clip)/.test(style.overflowY)) continue;
        const box = node.getBoundingClientRect();
        rect = rect ? new DOMRect(Math.max(rect.left, box.left), Math.max(rect.top, box.top), Math.min(rect.right, box.right) - Math.max(rect.left, box.left), Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top)) : box;
      }
      return rect;
    };
    for (const box of boxes) {
      const text = box.node.textContent ?? '';
      for (const match of text.matchAll(money)) {
        const range = document.createRange();
        range.setStart(box.node, match.index!);
        range.setEnd(box.node, match.index! + match[0].length);
        const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0);
        const tops = new Set(rects.map(rect => Math.round(rect.top)));
        if (tops.size > 1) issues.push({ kind: 'wrapped-money', detail: `"${match[0]}" in ${label(box.element)}` });
        const clip = clipRect(box.element);
        const cut = rects.some(rect => clip && (rect.right > clip.right + 1 || rect.left < clip.left - 1));
        const ellipsized = (() => {
          for (let node: Element | null = box.element; node && node !== document.body; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.textOverflow === 'ellipsis' && node.scrollWidth > node.clientWidth + 1) return `${node.tagName}.${node.className}`;
            if (/(hidden|clip)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) return `${node.tagName}.${node.className}`;
          }
          return '';
        })();
        if (cut || ellipsized) issues.push({ kind: 'clipped-money', detail: `"${match[0]}" in ${label(box.element)} [${box.element.tagName}.${box.element.className}]${cut ? ' cut by a clipping box' : ` ellipsized by ${ellipsized}`}` });
      }
    }
    const rows = Array.from(document.querySelectorAll('[aria-label="Session players"] [data-testid^="player-"]')).filter(visible);
    if (rows.length > 1) {
      const edges = (selector: string, pick: (rect: DOMRect) => number) => rows.map(row => { const found = Array.from(row.parentElement?.querySelectorAll(selector) ?? []).filter(visible).map(element => pick(element.getBoundingClientRect())); return found.length ? Math.round(Math.max(...found)) : null; });
      const names = rows.map(row => { const name = row.querySelector('strong'); return name ? Math.round(name.getBoundingClientRect().left) : null; });
      const spread = (values: (number | null)[]) => { const real = values.filter((value): value is number => value !== null); return real.length > 1 ? Math.max(...real) - Math.min(...real) : 0; };
      if (spread(names) > 1) issues.push({ kind: 'row-misaligned', detail: `name left edges ${names.join(',')}` });
      const buttonRights = edges('.player-actions button', rect => rect.right);
      if (spread(buttonRights) > 1) issues.push({ kind: 'row-misaligned', detail: `row right edges ${buttonRights.join(',')}` });
      const amounts = rows.map(row => { const amount = row.querySelector('.player-detail'); return amount ? Math.round(amount.getBoundingClientRect().right) : null; });
      if (spread(amounts) > 1) issues.push({ kind: 'row-misaligned', detail: `amount right edges ${amounts.join(',')}` });
      for (const row of rows) {
        const amount = row.querySelector('.player-detail');
        const actions = row.parentElement?.querySelector('.player-actions');
        if (!amount || !actions || !visible(actions) || !actions.children.length) continue;
        const amountBox = amount.getBoundingClientRect();
        const actionsBox = actions.getBoundingClientRect();
        if (actionsBox.top >= amountBox.bottom || actionsBox.bottom <= amountBox.top) continue;
        const gap = actionsBox.left - amountBox.right;
        if (gap < 4) issues.push({ kind: 'row-misaligned', detail: `amount touches actions (${Math.round(gap)}px gap) in ${label(row)}` });
      }
      const heights = rows.filter(row => {
        if (row.closest('.player-card')?.classList.contains('amount-below')) return false;
        const actions = row.parentElement?.querySelector('.player-actions');
        if (actions && visible(actions) && actions.children.length && actions.getBoundingClientRect().top >= row.getBoundingClientRect().bottom - 1) return false;
        const status = row.querySelector('.player-state');
        const name = row.querySelector('.player-name strong');
        if (status && status.getBoundingClientRect().height > Number.parseFloat(getComputedStyle(status).lineHeight) + 1) return false;
        return !name || name.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(name).lineHeight) + 1;
      }).map(row => Math.round((row.closest('li, [role=listitem]') ?? row.parentElement ?? row).getBoundingClientRect().height));
      if (heights.length > 1 && Math.max(...heights) - Math.min(...heights) > 1) issues.push({ kind: 'row-misaligned', detail: `row heights ${heights.join(',')}` });
    }
    return issues;
  }, redactCodes) as Promise<LayoutIssue[]>;
}
