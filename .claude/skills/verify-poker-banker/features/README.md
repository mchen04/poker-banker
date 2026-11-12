# Poker banker verification map

This directory is the maintained source for checking user-facing poker banker behavior. Read this index and the matching feature before driving the app.

## Baseline preconditions

- Launch from the repository root with `.claude/skills/verify-poker-banker/scripts/verify.sh launch --local`, or the mini runner prefix shown in [SKILL.md](../SKILL.md).
- Keep the returned run ID and evidence directory. Require `doctor --run RUN_ID` to identify this run's banker, build and base URL.
- Use only the owned browser contexts. Each recipe operates on the run's unique banker; additional accounts must be newly created test accounts.
- Every recipe returns its primary page to Table before setup. The ten recipes can share one run and banker; each creates its own fixture and closes its extra contexts. Run sessions alone on a fresh run as well to prove the welcome creation entry point.
- In live mode, use only a supplied `PB_BASE_URL` and newly created test accounts. Never read credential files, use another account, deploy or delete remote records.

## Driving conventions

- Save the exact TypeScript recipe block at the named repository-relative `.cache/verify-*.ts` path before invoking it.
- The mini runner excludes `.cache/`; copy only the newly written recipe with the explicit rsync command in SKILL.md, or write it inside the mini checkout.
- Replace `RUN_ID` in commands with the run ID from launch. Select `iphone-webkit`, `iphone-standalone` or `desktop-webkit` explicitly.
- Start each recipe with `page.goto('/')` and `workspaceReady(page)`. Use `openNewSession(page)` for creation and `switchSession(page, id)` for picker choices.
- Secondary contexts use `newContextLike(page, browser, baseURL)` to retain the current viewport, touch profile and standalone emulation without copying cookies.
- Import repository browser helpers from `../e2e/helpers`. They use real UI controls and public production endpoints.
- API fixture setup is named as setup. It does not prove a UI mutation. Saved-state proof uses read-only production API responses.
- Capture `step` evidence before and after meaningful actions. Additional pages need their own screenshots and ARIA snapshots because `step` captures the primary page.
- Never weaken a recipe when a prerequisite or expected result is missing. Fail with its reason.

## Proof and skip reporting

- Record feature and entry point with every proof. Do not mark an unused entry point verified through a different one.
- A mutation needs a visible outcome and an independent read-only saved-state check.
- Keep account passwords, cookies and recovery codes out of artifacts. They belong only in the owned browser or daemon memory.
- Run `evidence --run RUN_ID`, then `cleanup --run RUN_ID`, even after failure. Confirm the evidence survives cleanup.
- Recipes are mapped until their own execution artifacts prove them. Keep the sequential run and each isolated run's actual command results; a successful ledger drive does not prove another recipe.

## Features

- [Accounts and recovery](accounts-and-recovery.md) covers signup acknowledgement, signin, signout, recovery and revoked sessions.
- [Sessions, picker and drafts](sessions-and-drafts.md) covers creation, settings, suggestions, the session picker, history entry points and scoped drafts.
- [Ledger entries and corrections](ledger-and-corrections.md) covers both buy-in entry points, re-entry, expenses, correction and void history.
- [Payments and methods](payments-and-methods.md) covers paid/unpaid entries, later settlement, directions and method correction.
- [Timer](timer.md) covers manual and automatic start, reload, another context, corrections and close-stop.
- [Close and reopen with cumulative results](close-reopen-and-cumulative.md) covers blockers, discrepancy consent and counting closed sessions once.
- [Sharing and live viewer](sharing-and-live-viewer.md) covers enable, copy, live updates, rotate, disable and readonly access.
- [Player reports](player-reports.md) covers roster, rename, five groupings, six filters and display-only rates.
- [Offline and app updates](offline-and-app-updates.md) covers snapshots, queued/rejected writes, replay and real automatic A/B adoption via `drive updates` or its shared recipe, including pinned previous-client compatibility.

## UX approval capture and action counts

Run this recipe **first** after a fresh local launch. It measures first-session creation, so a banker with earlier sessions is rejected rather than silently skipping that journey. The shared helper also supplies `e2e/r37-ux.spec.ts`; it records all fourteen measured journeys, real ledger checks, latest-entry Undo, and exact required approval screens.

Save this block as `.cache/r37-ux.ts`, copy only that file to the mini, then run `recipe .cache/r37-ux.ts --run RUN_ID --context iphone-standalone`. Use a separate fresh local launch for `desktop-webkit`. Evidence includes viewport and visual-viewport geometry alongside light/dark screenshots, eight-player complete-row counts, tap controls, live/revoked viewer and the saved ledger. The outer phone viewport stays 393×659 while a 380 px visual viewport emulates a keyboard; this cannot prove a physical iOS keyboard. The desktop captures use 1440×1000. Finish each run with evidence and cleanup.

```ts
import { uxApproval } from '../e2e/ux-approval';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function ({ page, browser, baseURL, evidence, runId }: RecipeContext) {
  await uxApproval({ page, browser, baseURL, evidence, runId });
}
```

The shared browser helpers retain an explicit `r36-previous-` release-fixture branch for the pinned `dc2082b` update proof. Only that archived client uses its old navigation, picker and paid-checkbox controls. Current-release journeys require Table navigation and the current segmented controls; there is no generic old-label fallback.

The recipe daemon uses `tsx`. Keep browser-evaluated callbacks self-contained; named local arrow helpers can serialize an unavailable `__name` helper. The shared capture helper uses inline callbacks and was executed through the skill in both contexts.
