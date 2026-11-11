# Sharing and live viewer

A banker shares one session through a private read-only link. A fresh logged-out viewer sees saved updates, cannot navigate private history or mutate the bank, and loses access when the link rotates or is disabled.

## Sub-features

- `sharing-enable` creates a link for one open session.
- `sharing-copy` invokes Copy link and distinguishes success from clipboard fallback.
- `sharing-viewer` opens the token in a fresh logged-out context without banker controls.
- `sharing-live` shows a uniquely identifiable confirmed save within three seconds.
- `sharing-rotate-disable` invalidates both old and disabled tokens.
- `sharing-scope` exposes only the shared session and no private roster/history/report.

## How to get to it (user POV)

- Choose `Session menu` → `Share session`, then `Enable sharing`.
- Choose `Copy link`, `Rotate link` or `Disable sharing` in that sheet.
- Open the Viewer link in a fresh logged-out context.

## Driving it with Playwright

Preconditions:

- Doctor succeeds. The owned banker is online and can create two sessions.
- The viewer context starts without the banker's cookies; only the generated session link is passed to it.

- **Share, watch and revoke.** Save as `.cache/verify-sharing.ts`, then run `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-sharing.ts --run RUN_ID --context iphone-webkit`. Retain both viewer and banker evidence.

```ts
import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { addPlayer, menu, money, newSession, share } from '../e2e/helpers';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function ({ page, browser, baseURL, runId, evidence, step }: RecipeContext) {
  const shared = await newSession(page, 'Verify shared game');
  const player = await addPlayer(page, `Share ${runId.slice(-8)}`);
  await money(page, player.id, '40', { method: 'venmo' });
  await newSession(page, 'Verify private other game');
  await page.getByTestId(`session-tab-${shared.session.id}`).click();
  const link = await share(page);
  const viewerContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: new URL(baseURL).hostname === '127.0.0.1', viewport: page.viewportSize() ?? undefined, locale: 'en-US', timezoneId: 'UTC' });
  try {
    const viewer = await viewerContext.newPage();
    await viewer.goto(link);
    await expect(viewer.getByText(/View only, updated/)).toBeVisible();
    await expect(viewer.getByTestId('activity')).toContainText('Venmo');
    await expect(viewer.getByText('Verify private other game', { exact: false })).toHaveCount(0);
    for (const name of ['Add player', 'Buy-in', 'Session menu', 'Players', 'History']) await expect(viewer.getByRole('button', { name, exact: true })).toHaveCount(0);
    expect((await viewer.request.get(`${baseURL}/api/sessions`)).status()).toBe(401);
    expect((await viewer.request.get(`${baseURL}/api/players/${player.id}/report`)).status()).toBe(401);
    const blocked = await viewer.request.post(`${baseURL}/api/sessions/${shared.session.id}/entries`, { headers: { origin: baseURL }, data: {} });
    expect(blocked.status()).toBe(401);
    await step('sharing-banker-save-before');
    await money(page, player.id, '5', { method: 'venmo' });
    const confirmedAt = Date.now();
    await expect(viewer.getByTestId(`player-${player.id}`)).toContainText('in $45.00', { timeout: 3000 });
    const delay = Date.now() - confirmedAt;
    expect(delay).toBeLessThan(3000);
    await viewer.screenshot({ path: `${evidence}/sharing-viewer-live.png` });
    await writeFile(`${evidence}/sharing-viewer-live.aria.txt`, await viewer.locator('body').ariaSnapshot());
    await menu(page, 'Share');
    await page.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('status')).toHaveText(/Link copied|Select the viewer link and copy it\./);
    const copyResult = await page.getByRole('dialog').getByRole('status').textContent();
    await step('sharing-copy-result');
    await page.getByRole('button', { name: 'Rotate link', exact: true }).click();
    await expect(page.getByLabel('Viewer link', { exact: true })).not.toHaveValue(link);
    const rotated = await page.getByLabel('Viewer link', { exact: true }).inputValue();
    await viewer.reload();
    await expect(viewer.getByText('This viewer link is unavailable. Ask the banker for a current link.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Disable sharing', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Enable sharing', exact: true })).toBeVisible();
    await viewer.goto(rotated);
    await expect(viewer.getByText('This viewer link is unavailable. Ask the banker for a current link.', { exact: true })).toBeVisible();
    await viewer.screenshot({ path: `${evidence}/sharing-viewer-revoked.png` });
    await writeFile(`${evidence}/sharing-proof.json`, JSON.stringify({ viewerDelayAfterConfirmationMs: delay, copyResult, loggedOutPrivateStatus: 401, mutationStatus: blocked.status(), rotatedAndDisabledUnavailable: true }, null, 2));
    await step('sharing-disabled-result');
  } finally { await viewerContext.close(); }
}
```

## Gotchas

- A viewer that inherited banker cookies does not prove read-only logged-out access.
- Copy link may show a fallback because clipboard permission is unavailable. Record that fallback; do not call it a successful clipboard write.
- Sharing changes are disabled for closed games. Reopen through the normal flow before changing a link.
- The three-second check starts after the banker sees confirmation; it is a journey assertion, not a benchmark of end-to-end input latency.
- Viewer tokens are bearer links. Keep verification evidence private even though its game contains only synthetic data.
