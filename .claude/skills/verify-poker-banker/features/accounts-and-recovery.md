# Accounts and recovery

A banker creates a private account, explicitly saves recovery codes, signs in and out, and recovers with a single-use code. Recovery invalidates older sessions.

## Sub-features

- `accounts-signup` requires acknowledging the recovery codes before Workspace.
- `accounts-signin` accepts the new account and rejects a wrong password.
- `accounts-signout` lives under Players → Account and protects unsent work.
- `accounts-recover` accepts a saved code once and rejects its reuse.
- `accounts-revoke` rejects a session cookie issued before recovery.
- `accounts-isolation` keeps another newly created banker's sessions and player reports private.

## How to get to it (user POV)

- At the access screen, choose `Sign up`, `Sign in` or `Recover account`.
- In Workspace, choose `Players`, then `Sign out` in Account.
- Recovery uses `Username`, `Recovery code` and `New password`, followed by `Reset password`.

## Driving it with Playwright

Preconditions:

- Doctor identifies this run's banker. All extra contexts below are fresh and create their own test accounts.
- Keep recovery codes and cookies only in memory. Do not screenshot or write them to evidence.

- **Exercise access and recovery.** Save the block as `.cache/verify-accounts.ts`, then run `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-accounts.ts --run RUN_ID --context iphone-webkit`. The assertions prove acknowledgement, signin, wrong-password rejection, code reuse rejection and revoked cookies. The primary banker's data remains untouched.

```ts
import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { addPlayer, createAccount, newSession, signIn, signOut } from '../e2e/helpers';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function ({ browser, baseURL, evidence, step }: RecipeContext) {
  const options = { baseURL, ignoreHTTPSErrors: new URL(baseURL).hostname === '127.0.0.1', locale: 'en-US', timezoneId: 'UTC' };
  const accountContext = await browser.newContext(options);
  const oldContext = await browser.newContext(options);
  const recoveryContext = await browser.newContext(options);
  const otherContext = await browser.newContext(options);
  try {
    const accountPage = await accountContext.newPage();
    const account = await createAccount(accountPage);
    const saved = await newSession(accountPage, 'Owned recovery check');
    const player = await addPlayer(accountPage, 'Owned recovery player');
    await oldContext.addCookies(await accountContext.cookies());
    expect((await oldContext.request.get(`${baseURL}/api/auth/me`)).status()).toBe(200);
    await signOut(accountPage);
    await accountPage.getByLabel('Username', { exact: true }).fill(account.username);
    await accountPage.getByLabel('Password', { exact: true }).fill('deliberately-wrong-password');
    await accountPage.getByRole('button', { name: 'Sign in to workspace', exact: true }).click();
    await expect(accountPage.getByRole('alert')).toBeVisible();
    await signIn(accountPage, account.username);
    const recover = await recoveryContext.newPage();
    await recover.goto('/');
    await recover.getByRole('button', { name: 'Recover account', exact: true }).click();
    await recover.screenshot({ path: `${evidence}/accounts-recovery-before.png` });
    await writeFile(`${evidence}/accounts-recovery-before.aria.txt`, await recover.locator('body').ariaSnapshot());
    await recover.getByLabel('Username', { exact: true }).fill(account.username);
    await recover.getByLabel('Recovery code', { exact: true }).fill(account.codes[0]!);
    await recover.getByLabel('New password', { exact: true }).fill('owned-recovery-password-2026');
    await recover.getByRole('button', { name: 'Reset password', exact: true }).click();
    await expect(recover.getByText('Password reset. Sign in with your new password.', { exact: true })).toBeVisible();
    expect((await oldContext.request.get(`${baseURL}/api/auth/me`)).status()).toBe(401);
    const reused = await recoveryContext.request.post(`${baseURL}/api/auth/recover`, { headers: { origin: baseURL }, data: { username: account.username, recovery_code: account.codes[0], new_password: 'unused-recovery-password-2026' } });
    expect(reused.status()).toBe(401);
    await signIn(recover, account.username, 'owned-recovery-password-2026');
    await recover.goto(`/?session=${saved.session.id}`);
    await expect(recover.getByRole('heading', { name: 'Owned recovery check', exact: true })).toBeVisible();
    const other = await otherContext.newPage();
    await createAccount(other);
    expect((await other.request.get(`${baseURL}/api/sessions/${saved.session.id}`)).status()).toBe(404);
    expect((await other.request.get(`${baseURL}/api/players/${player.id}/report`)).status()).toBe(404);
    await other.goto(`/?session=${saved.session.id}`);
    await expect(other.getByText('Session not found. It may belong to another account.', { exact: true })).toBeVisible();
    await recover.screenshot({ path: `${evidence}/accounts-recovered.png` });
    await writeFile(`${evidence}/accounts-recovered.aria.txt`, await recover.locator('body').ariaSnapshot());
    await other.screenshot({ path: `${evidence}/accounts-isolated.png` });
    await writeFile(`${evidence}/accounts-proof.json`, JSON.stringify({ acknowledgement: true, wrongPasswordRejected: true, recoverySucceeded: true, usedCodeRejected: true, oldSessionStatus: 401, otherBankerStatus: 404, otherBankerReportStatus: 404 }, null, 2));
    await step('accounts-secondary-context-proofs-retained');
  } finally {
    await accountContext.close(); await oldContext.close(); await recoveryContext.close(); await otherContext.close();
  }
}
```

- **Exercise the unsent signout guard.** Use the offline recipe's queued-write prerequisite, then choose `Players` → `Sign out`. `Confirm sign out` must be disabled until the pending work saves or `Discard unsent entries and drafts` is checked. Capture both states before choosing; never discard another feature's evidence or remote data.

## Gotchas

- This recipe's secondary authentication contexts use desktop defaults. The selected mode applies to the primary harness page; these secondary screenshots do not prove phone or standalone layout. Use the ledger context drives for those layouts.

- The helper `createAccount` asserts the acknowledgement button is disabled, checks `I saved these codes`, and continues through the real UI. Its codes must not be logged.
- Five failures lock the source IP as well as the username. Do not run a lockout experiment against a deployed shared IP. It requires a separate owned local instance and must run last because recovery shares the lockout window.
- Password change and recovery-code regeneration currently have HTTP endpoints but no user-facing controls. This map does not claim UI coverage for them.
- A browser context copied from the old cookie proves revocation; a newly signed-out page alone does not.
