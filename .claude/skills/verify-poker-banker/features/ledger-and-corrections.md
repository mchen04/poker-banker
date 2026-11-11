# Ledger entries and corrections

The banker records buy-ins and cash-outs without losing the original ledger. Results appear only after cash-out. Re-entry returns a player to playing, and corrections preserve visible void and replacement rows.

## Sub-features

- `ledger-bottom-buy-in` records from the thumb-reachable bottom bar.
- `ledger-player-buy-in` records from a player sheet, including a rebuy.
- `ledger-select-player` changes the player in the money sheet without mixing drafts.
- `ledger-cash-out-reentry` covers early cash-out, re-entry and final cash-out.
- `ledger-expense` records tips and meals from a player sheet.
- `ledger-global-correct` corrects from global Activity.
- `ledger-player-correct` corrects from Player entries.
- `ledger-void-replacement` retains the original, explicit void and replacement; void-only remains available.

## How to get to it (user POV)

- Choose `Buy-in` in the fixed bottom bar, then use `Player` if needed.
- Choose a player row, then `Buy-in`, `Cash out` or `Tips and meals`.
- Choose `Correct` beside an entry in global Activity or in that player's entries.
- Use `Replacement amount` and `Save correction`, or choose `Void entry` without replacement.
- Add and reuse players through the [sessions recipe](sessions-and-drafts.md); that recipe owns new/existing-name search and exact-match confirmation.

## Driving it with Playwright

Preconditions:

- Doctor succeeds for this run. The banker is owned by this run and online.
- The harness can create a fresh session and two uniquely named players. Missing players or a closed session fail this recipe rather than skip an entry point.

- **Drive all entry points.** Run `.claude/skills/verify-poker-banker/scripts/verify.sh drive ledger --run RUN_ID --context iphone-webkit`. The built-in recipe exercises the bottom-bar and player-sheet buy-ins, money-sheet player selector, cash-out/re-entry, tips and meals, both correction entry points, a method correction and void-only history. Each path must appear in its action/result evidence.
- **Repeat the same recipe in standalone.** Run `.claude/skills/verify-poker-banker/scripts/verify.sh drive ledger --run RUN_ID --context iphone-standalone`. Its artifacts identify the emulated standalone context. This does not prove a real Home Screen install.
- **Repeat on desktop WebKit.** Run `.claude/skills/verify-poker-banker/scripts/verify.sh drive ledger --run RUN_ID --context desktop-webkit`. Its independent session and artifacts prove the same controls at desktop size.
- **Confirm the stored ledger.** The drive reads the selected session through `checkState()`. Require distinct saved entry IDs, the expected stored integer amounts, hidden results while playing, a cashed-out result, expenses, void relationships and the replacement row. A toast by itself fails this proof.
- **Seal the evidence.** Run `.claude/skills/verify-poker-banker/scripts/verify.sh evidence --run RUN_ID`, then cleanup. Retain the manifest and each context's screenshots, ARIA and saved-state checks.

## Gotchas

- Paid buy-in also creates a payment entry. A payment method belongs to that payment row, not the buy-in row.
- `entry-${id}`, `player-${id}` and `result-${id}` use IDs returned by the real saved-state response. Never invent them or select rows by position.
- Correcting a voided row is unavailable. Preserve its original proof and use the effective replacement for later changes.
- Entries marked Not saved yet do not change confirmed totals. Do not confuse an offline draft with a confirmed ledger row.
- The built-in drive's successful execution proves only the entry points present in its evidence; it does not automatically verify the other feature files.
