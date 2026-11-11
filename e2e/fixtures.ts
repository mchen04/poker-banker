import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { test as base, expect, type Page, type TestInfo } from '@playwright/test';

async function availablePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No browser test port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
export const test = base.extend({
  baseURL: async ({}, use) => {
    const port = await availablePort();
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/e2e-server.ts'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Browser server did not start\n${output}`)), 30000);
        child.stdout.on('data', chunk => {
          output += String(chunk);
          if (output.includes('Poker banker ready at')) { clearTimeout(timeout); resolve(); }
        });
        child.stderr.on('data', chunk => { output += String(chunk); });
        child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Browser server exited ${code}\n${output}`)); });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
      });
      await use(`https://127.0.0.1:${port}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill('SIGTERM');
        await exited;
      }
    }
  },
  context: async ({ context }, use, testInfo) => {
    if (testInfo.project.name === 'iphone-standalone') await context.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = query => {
        const result = matchMedia(query);
        if (query.includes('display-mode') && query.includes('standalone')) Object.defineProperty(result, 'matches', { configurable: true, value: true });
        return result;
      };
    });
    await use(context);
  },
});
export { expect };

export async function screen(page: Page, testInfo: TestInfo, name: string) {
  await mkdir('evidence/screenshots', { recursive: true });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: `evidence/screenshots/${testInfo.project.name}-${name}-${colorScheme}.png`, fullPage: true });
  }
  const audit = await page.evaluate(() => {
    const unnamed = [...document.querySelectorAll('button')].filter(button => !button.getAttribute('aria-label')?.trim() && !button.textContent?.trim() && !button.querySelector('img[alt]')).map(button => button.outerHTML);
    const small: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!node.textContent?.trim() || !parent || ['SCRIPT', 'STYLE'].includes(parent.tagName)) continue;
      const style = getComputedStyle(parent);
      if (style.display !== 'none' && parent.getClientRects().length && Number.parseFloat(style.fontSize) < 11) small.push(parent.outerHTML);
    }
    return { unnamed, small };
  });
  expect(audit.unnamed).toEqual([]);
  expect(audit.small).toEqual([]);
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= 375)).toBe(true);
  if (viewport) await page.setViewportSize(viewport);
}
