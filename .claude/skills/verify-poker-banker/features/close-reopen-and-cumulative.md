# Close and reopen with cumulative results

The banker closes only after everyone with entries has cashed out. A mismatch needs explicit acceptance. Reopening removes the game from finalized totals until it closes again, and reclosure counts that game once.

## Sub-features

- `close-playing-blocker` explains who still needs to cash out.
- `close-pending-blocker` explains unsaved entries separately.
- `close-balanced` closes matching chip totals.
- `close-ready-card` offers Everyone has cashed out · Close session and an unsettled count once no player is playing.
- `close-discrepancy` requires acceptance of the exact displayed difference.
- `reopen-reason` records why the game reopened.
- `cumulative-reclose-once` counts closed games once and keeps outstanding payments separate.

## How to get to it (user POV)

- After everyone has cashed out, choose `Everyone has cashed out · Close session`, then confirm. The card also names outstanding settlements; it does not bypass the existing blockers or discrepancy acceptance.
- In an open session, choose `Session menu` → `Close session`. The centre action remains Buy-in on Table and Players; closing never replaces it.
- Tap a full-width blocker row to open that player’s cash-out. Save or discard Not saved yet entries before closing.
- If chip totals differ, check `Accept discrepancy of …`, then choose `Close session`.
- In a closed game, choose `Session menu` → `Reopen session`, enter `Reason`, then choose `Reopen session`.
- Choose `Players` and a player to inspect finalized and outstanding amounts and Past sessions.

## Driving it with Playwright

Preconditions:

- Doctor succeeds. The recipe creates two players and its own new sessions.
- Run the offline recipe for the separate unsaved-entry blocker; no queued item is manufactured inside storage.

- **Close, reopen and count once.** Run `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .claude/skills/verify-poker-banker/scripts/close.ts --run RUN_ID --context iphone-webkit`. The balanced game's two player results are +$40 and −$40. The second game's −$10 result makes the first player's finalized total +$30.


## Gotchas

- Outstanding payments do not block a balanced chip close. They remain visible separately and are not player profit.
- Discrepancy is chips returned minus chips bought; it is separate from payments. A $90 cash-out against a $100 buy-in displays −$10.00, including the consent label and closed recap.
- Discrepancy consent belongs to the displayed revision. If another write changes it, inspect the new amount and consent again.
- Reopen does not erase timing history or unset the end. This recipe re-closes without resuming play.
- A positive result must show a plus sign, a negative result a minus sign and zero Even. Color alone is insufficient.
- A queued-write blocker is a different path from a playing-player blocker and needs its own offline evidence.
