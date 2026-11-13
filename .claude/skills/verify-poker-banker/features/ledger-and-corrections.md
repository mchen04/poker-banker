# Ledger entries and corrections

The banker records buy-ins and cash-outs without losing the original ledger. Results appear only after cash-out. Re-entry returns a player to playing, and corrections preserve visible void and replacement rows.

## Sub-features

- `ledger-bottom-buy-in` records from the thumb-reachable bottom bar.
- `ledger-player-buy-in` records from a player sheet, including a rebuy.
- `ledger-row-buy-in` opens review directly from a player row without recording an entry.
- `ledger-repeat-review` suggests the last effective buy-in while retaining an existing draft.
- `ledger-undo` offers eight seconds of available Undo time, paused during touch/focus/editing; a first-buy-in Undo explains the retained timer and links to Correct times.
- `ledger-player-choice` requires an explicit footer player choice before opening a fixed-player money sheet.
- `ledger-cash-out-reentry` covers early cash-out, re-entry and final cash-out.
- `ledger-expense` records tips and meals from a player sheet.
- `ledger-global-correct` corrects from global Activity.
- `ledger-player-correct` corrects from Player entries.
- `ledger-void-replacement` retains the original, explicit void and replacement; void-only requires Confirm void.

## How to get to it (user POV)

- Choose `Buy-in` in the single bottom navigation bar on Table or Players while the current session is open, then explicitly choose a player. The money sheet displays that player as fixed text; choose another player by cancelling and returning to the chooser.
- Choose the row’s `Buy-in` or `Rebuy` shortcut to review an amount. Choose the player’s name for `Buy-in`, `Cash out`, payments and `Tips and meals`.
- Choose `Correct` beside an entry in global Activity or in that player's entries.
- Use `Replacement amount` and `Save correction`, or choose `Void entry` → `Confirm void` without replacement. `Keep entry` returns to the editor with its draft intact.
- Add and reuse players through the [sessions recipe](sessions-and-drafts.md); that recipe owns new/existing-name search and exact-match confirmation.

## Driving it with Playwright

Preconditions:

- Doctor succeeds for this run. The banker is owned by this run and online.
- The harness can create a fresh session and two uniquely named players. Missing players or a closed session fail this recipe rather than skip an entry point.

- **Drive ledger and correction entry points.** Run `.claude/skills/verify-poker-banker/scripts/verify.sh drive ledger --run RUN_ID --context iphone-webkit`. The built-in recipe exercises the bottom-bar and player-sheet buy-ins, explicit player chooser, cash-out/re-entry, tips and meals, both correction entry points, a method correction and void-only history. Each path must appear in its action/result evidence.
- **Repeat the same recipe in standalone.** Run `.claude/skills/verify-poker-banker/scripts/verify.sh drive ledger --run RUN_ID --context iphone-standalone`. Its artifacts identify the emulated standalone context. This does not prove a real Home Screen install.
- **Repeat on desktop WebKit.** Run `.claude/skills/verify-poker-banker/scripts/verify.sh drive ledger --run RUN_ID --context desktop-webkit`. Its independent session and artifacts prove the same controls at desktop size.
- **Check row shortcuts separately.** The focused `e2e/money-forms.spec.ts` journey checks direct Buy-in, Repeat last and saved-draft precedence. Require unchanged saved entries until Save entry is chosen; the built-in ledger drive alone does not prove these shortcuts.
- **Confirm the stored ledger.** The drive reads the selected session through `checkState()`. Require distinct saved entry IDs, the expected stored integer amounts, hidden results while playing, a cashed-out result, expenses, void relationships and the replacement row. A toast by itself fails this proof.
- **Seal the evidence.** Run `.claude/skills/verify-poker-banker/scripts/verify.sh evidence --run RUN_ID`, then cleanup. Retain the manifest and each context's screenshots, ARIA and saved-state checks.

## Gotchas

- Paid buy-in also creates a payment entry. A payment method belongs to that payment row, not the buy-in row.
- `entry-${id}`, `player-${id}` and `result-${id}` use IDs returned by the real saved-state response. Never invent them or select rows by position.
- Correcting a voided row is unavailable. Preserve its original proof and use the effective replacement for later changes.
- Entries marked Not saved yet do not change confirmed totals. Do not confuse an offline draft with a confirmed ledger row.
- The built-in drive's successful execution proves only the entry points present in its evidence; it does not automatically verify the other feature files.

Activity retains the complete newest-first ledger. `e2e/activity-history.spec.ts` covers 106 entries, oldest-entry correction, player-filtered voids and anonymous viewing.
