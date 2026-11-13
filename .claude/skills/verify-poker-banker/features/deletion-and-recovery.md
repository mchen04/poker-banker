# Deletion and recovery

The banker can delete a ledger entry, remove a player from a game, delete a session and delete a roster player. Each takes one confirm, updates totals immediately after the server confirms, offers Undo in the toast and stays recoverable after the toast is gone. Nothing is erased: deletes write void rows or deleted markers that restore exactly.

## Sub-features

- `delete-entry` deletes one entry from Correct entry → Delete entry → Confirm delete. The row stays in Activity struck through as Deleted; its void row is hidden.
- `delete-entry-undo` restores it from the toast ("Deleted buy-in · Sam · $50.00" → Undo → "Restored …"). The restored copy is a new live row; the original disappears from Activity.
- `delete-entry-restore` restores later by opening the Deleted row → Deleted entry sheet → Restore entry. Corrected (replaced) entries cannot be restored; the server's reason is shown.
- `delete-entry-offline` queues the delete in the outbox: Not saved yet, row marked Delete pending, confirmed totals unchanged, survives reload, sends once on reconnect and then shows the Deleted toast with Undo.
- `remove-player` removes a seated player from the session player sheet (Remove from game → Confirm remove). The confirm states how many entries are deleted. All their effective entries are voided atomically and marked Removed.
- `remove-player-undo` and `remove-player-restore` re-seat the player with exactly those entries, from the toast or the Removed (n) disclosure under Players.
- `delete-session` deletes from Session menu → Delete session → Confirm delete, moves to the next most recent session (or the empty table) and kills the viewer link.
- `delete-session-undo` and `delete-session-restore` restore from the toast or Recently deleted (n) at the bottom of the Sessions picker, also shown on the empty table. Restoring does not revive the old viewer link.
- `delete-player` deletes a roster player from the player report (trash icon next to Rename → Confirm delete). A player still seated in any game gets "Remove them from their games first" and no delete control.
- `delete-player-undo` and `delete-player-restore` restore from the toast or Recently deleted (n) under the Players list.

## How to get to it (user POV)

- Activity row or player-sheet entry → Delete entry → Confirm delete (3 controls). Undo is 1.
- Player row → Remove from game (bottom of the sheet) → Confirm remove (3).
- Session menu (…) → Delete session (last, red, separated) → Confirm delete (3).
- Players → player → Delete player → Confirm delete (4 from the Players tab).
- Recently deleted and Removed are collapsed disclosures that only appear when non-empty.

## Driving it with Playwright

Preconditions:

- Doctor succeeds. The banker is online, with an active service worker (the recipe calls `workerReady`).
- The recipe creates its own uniquely tagged sessions and players. It can share a banker with other recipes; the session it moves to after deleting may belong to another recipe.

- **Run the journey.** The recipe lives in the skill's `scripts/` folder, so the mini runner syncs it:
  `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .claude/skills/verify-poker-banker/scripts/deletions.ts --run RUN_ID --context iphone-webkit`
  Repeat with `--context iphone-standalone` and `--context desktop-webkit`.
- **What it proves.** Exact `total_in_minor` before and after every delete, Undo and later Restore (including a $123,456,789.00 buy-in and a 31-character name), one offline delete that is excluded from totals, survives reload and syncs once, the Removed disclosure, the deleted session's viewer link showing "This viewer link is unavailable", Recently deleted for sessions and roster players, and the seated-player refusal.
- **Evidence.** `steps.json` with a screenshot and ARIA snapshot per step, `deletions-proof.json` with the saved IDs and totals, and `deleted-session-viewer.png`. Seal with `evidence`, then `cleanup`.
- **Focused test.** `e2e/deletions.spec.ts` covers the same four paths on a fresh account per test in all Playwright projects.
- **Layout.** `scripts/tour.ts` captures every confirm, toast, Deleted row, Restore sheet, Removed disclosure and Recently deleted list at 393, 375 and 320 wide.

## Gotchas

- Deletes of entries, players and sessions go through the outbox, so the toast with Undo appears only after the server confirms. Offline you see Not saved yet instead. Restores and roster deletes need a connection; their buttons are disabled offline.
- Deleting a paid buy-in deletes only the buy-in; its generated payment row stays and can be deleted separately. The Saved-toast Undo still reverses both atomically.
- Restoring writes a copy with `restores_entry_id`; select the copy's ID for a second delete, not the original. The copy keeps the original's place in chip order, so a restored buy-in never flips a cashed-out player back to Playing.
- Restoring a session or a removed seat also restores a deleted roster player in it, so their balance stays visible on Players.
- Deleting a session with unsettled balances shows an amber line naming the amounts owed to and by the banker.
- A queued entry rejected because its session was deleted on another device stays under Not saved yet with Retry and Discard.
- Undo follows the Saved-toast rules: eight unpaused seconds, paused by touch, focus, hover and open sheets. Wait about nine seconds before reaching for Removed or Recently deleted, or the toast may cover them.
- A removed player cannot be re-added through Add player ("Removed from this game"); restore them instead.
