# Verification feature map

Read [SKILL.md](../SKILL.md), launch from the repository root and require Doctor to identify the owned banker/build/base URL. Each ordinary recipe starts with `page.goto('/')` and `workspaceReady(page)`, creates uniquely named fixtures and closes extra contexts. The nine feature recipes can share one banker; repeat sessions alone on a fresh run for its welcome entry point. Update verification runs last because it changes `dist/`.

## Driver rules

- Save each exact recipe block at its named `.cache/verify-*.ts` path before invocation. The mini runner excludes `.cache/`; copy only that file explicitly, or write it inside the mini checkout.
- Use `e2e/helpers.ts` for real navigation, `e2e/input.ts` for physical-key typing, and `newContextLike` for secondary owned contexts without copied cookies.
- Run in `iphone-webkit`, `iphone-standalone` or `desktop-webkit`. Live mode requires a supplied, authorized `PB_BASE_URL` and new synthetic accounts only.
- Fixture setup through public APIs is labelled setup; it does not prove a UI mutation. Require visible action/result evidence and independent saved-state checks. Do not edit IndexedDB or manufacture test-only endpoints to obtain a pass.
- Capture the primary page with `step`. Extra pages need separate screenshots/ARIA. Keep passwords, cookies and recovery codes out of artifacts.
- Seal evidence, clean up after success or failure, and confirm evidence survives. A successful ledger drive does not prove another recipe.

## Features

| Feature | Proof |
| --- | --- |
| [Accounts and recovery](accounts-and-recovery.md) | Signup acknowledgement, signin/signout, one-use recovery, revocation and isolation. |
| [Sessions and drafts](sessions-and-drafts.md) | Creation/settings, suggestions, picker/history/pagination, player reuse and scoped drafts. |
| [Ledger and corrections](ledger-and-corrections.md) | Row/footer buy-ins, re-entry, expenses, full Activity, correction/void. |
| [Payments and methods](payments-and-methods.md) | Paid/unpaid, late settlements, directions, methods and correction. |
| [Timer](timer.md) | Auto/manual start, reload/another context, correction and close-stop. |
| [Close/reopen/cumulative](close-reopen-and-cumulative.md) | Blockers, exact discrepancy consent and closed-session counting. |
| [Sharing/live viewer](sharing-and-live-viewer.md) | Enable/copy, updates, rotate/disable and read-only access. |
| [Player reports](player-reports.md) | Roster/rename, five groupings, six filters and display-only rates. |
| [Offline and updates](offline-and-app-updates.md) | Snapshots, pending/rejected writes, replay, automatic adoption, pinned legacy compatibility, skew and storage bounds. |
| [Performance](performance.md) | Isolated datasets, current transport, baseline, profiles and interleaved comparison. |

## Layout and control-count capture

Run first on a fresh local banker because the approval helper measures first-session creation. Save as `.cache/verify-layout.ts`, copy only that file to the mini, then run `recipe .cache/verify-layout.ts --run RUN_ID --context iphone-standalone`; repeat on a fresh run with `desktop-webkit`.

```ts
import { join } from 'node:path';
import { uxApproval } from '../e2e/table-experience';
import { uxFollowups } from '../e2e/navigation-and-undo';
import { uxCloseReadiness } from '../e2e/close-readiness';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function (context: RecipeContext) {
  await uxApproval({ ...context, evidence: join(context.evidence, 'layout') });
  await uxFollowups({ ...context, evidence: join(context.evidence, 'navigation') });
  await uxCloseReadiness({ ...context, evidence: join(context.evidence, 'close-readiness') });
}
```

The helpers also drive `e2e/table-experience.spec.ts`. They retain fourteen control counts and light/dark captures: eight-player four/six-row visibility at 393×659/393×852, money sheets and focused validation above a 380px visual viewport, settings/picker, 1440×1000 desktop, live/revoked viewer, stable Table/Players footer, two-line names and Owes/Paid up contrast. Independent report fixtures require the grouped variation `$1,414.21`.

Undo keeps eight unpaused seconds; pointer/focus/sheets pause without resetting the remaining budget. Held-response/session-switch checks reject wrong-session feedback. Undo retains the timer; its lasting Correct times cue survives reload and clears only after timing correction or a new buy-in. Ready-close and create-another each take two controls; closed desktop has one New action and its 420px toast clears Activity and the last player row.

Pinned `dc2082b`/`30209c1` update builds keep explicit legacy branches in shared browser helpers; current recipes never fall back to old controls. Browser-evaluated callbacks must be self-contained so `tsx` does not serialize an unavailable function-name helper. Emulation does not prove physical keyboard/touch, Home Screen installation or iOS suspension; seal evidence and clean up every run.
