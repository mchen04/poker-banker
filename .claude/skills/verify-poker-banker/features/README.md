# Poker banker verification map

This directory is the maintained source for checking user-facing poker banker behavior. Read this index and the matching feature before driving the app.

## Baseline preconditions

- Launch from the repository root with `.claude/skills/verify-poker-banker/scripts/verify.sh launch --local`, or the mini runner prefix shown in [SKILL.md](../SKILL.md).
- Keep the returned run ID and evidence directory. Require `doctor --run RUN_ID` to identify this run's banker, build and base URL.
- Use only the owned browser contexts. Each recipe operates on the run's unique banker; additional accounts must be newly created test accounts.
- Start a fresh run for a feature whose prerequisites say empty banker. Prior feature mutations are not a substitute for the specified fixture.
- In live mode, use only a supplied `PB_BASE_URL` and newly created test accounts. Never read credential files, use another account, deploy or delete remote records.

## Driving conventions

- Save the exact TypeScript recipe block at the named repository-relative `.cache/verify-*.ts` path before invoking it.
- The mini runner excludes `.cache/`; copy only the newly written recipe with the explicit rsync command in SKILL.md, or write it inside the mini checkout.
- Replace `RUN_ID` in commands with the run ID from launch. Select `iphone-webkit`, `iphone-standalone` or `desktop-webkit` explicitly.
- Import repository browser helpers from `../e2e/helpers`. They use real UI controls and public production endpoints.
- API fixture setup is named as setup. It does not prove a UI mutation. Saved-state proof uses read-only production API responses.
- Capture `step` evidence before and after meaningful actions. Additional pages need their own screenshots and ARIA snapshots because `step` captures the primary page.
- Never weaken a recipe when a prerequisite or expected result is missing. Fail with its reason.

## Proof and skip reporting

- Record feature and entry point with every proof. Do not mark an unused entry point verified through a different one.
- A mutation needs a visible outcome and an independent read-only saved-state check.
- Keep account passwords, cookies and recovery codes out of artifacts. They belong only in the owned browser or daemon memory.
- Run `evidence --run RUN_ID`, then `cleanup --run RUN_ID`, even after failure. Confirm the evidence survives cleanup.
- Recipes are mapped until their own execution artifacts prove them. The required initial end-to-end execution covers the ledger feature only.

## Features

- [Accounts and recovery](accounts-and-recovery.md) covers signup acknowledgement, signin, signout, recovery and revoked sessions.
- [Sessions, tabs and drafts](sessions-and-drafts.md) covers creation, settings, suggestions, history entry points and scoped drafts.
- [Ledger entries and corrections](ledger-and-corrections.md) covers both buy-in entry points, re-entry, expenses, correction and void history.
- [Payments and methods](payments-and-methods.md) covers paid/unpaid entries, later settlement, directions and method correction.
- [Timer](timer.md) covers manual and automatic start, reload, another context, corrections and close-stop.
- [Close and reopen with cumulative results](close-reopen-and-cumulative.md) covers blockers, discrepancy consent and counting closed sessions once.
- [Sharing and live viewer](sharing-and-live-viewer.md) covers enable, copy, live updates, rotate, disable and readonly access.
- [Player reports](player-reports.md) covers roster, rename, five groupings, six filters and display-only rates.
- [Offline and app updates](offline-and-app-updates.md) covers snapshots, queued/rejected writes, replay and the safe update path.
