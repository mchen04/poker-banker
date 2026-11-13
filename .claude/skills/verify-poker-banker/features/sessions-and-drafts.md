# Sessions, picker and drafts

Each game has its own settings and drafts. A banker can create multiple games on one day, switch through searchable, month-grouped history, reuse players and reopen exactly the unfinished amount for the selected session.

## Sub-features

- `sessions-welcome-create` creates through the empty Table.
- `sessions-header-create` creates through the visible header + New; `sessions-picker-create` creates through Switch session → New session.
- `sessions-settings` saves location, game and big blind with past-value suggestions.
- `sessions-picker-history` switches through searchable month history and player history.
- `sessions-pagination` loads another history page when more than 30 sessions exist.
- `sessions-reuse-player` searches before adding, warns on exact matches and allows explicitly different people.
- `sessions-draft-scope` restores separate drafts after reload; Cancel can keep or discard one.

## How to get to it (user POV)

- Choose `Create your first session` in an empty Table, or the visible `+ New` button (accessible name `New session`) next to the current title.
- Choose `Switch session`, then search Sessions and choose a dated game; choose `Load more sessions` for older games.
- Choose `Session menu` → `Session settings` to edit settings.
- Choose `Add player` in a session, search an existing name, or choose `Add 'Name' as new`.
- Open a player through `Players` and choose one of their Past sessions.
- In a money sheet, choose `Cancel`, then `Keep draft and close`, `Discard draft` or `Keep editing`.

## Driving it with Playwright

Preconditions:

- Doctor succeeds. The recipe returns to Table and creates its own uniquely named sessions; earlier recipes may already have sessions.
- This recipe intentionally creates 31 additional empty sessions through the public API as history-pagination setup. That setup does not prove the Create session UI.

- **Create, reuse, switch and restore.** Run `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .claude/skills/verify-poker-banker/scripts/sessions.ts --run RUN_ID --context iphone-webkit`. The two named games share one date, while their typed amounts remain different after reload.


- **Open from player history.** The report recipe exercises Players → player detail → Past sessions, then proves the session heading and selected session ID. That entry point is not counted by the picker/history proof above.

## Gotchas

- Table can briefly show the welcome before its history arrives. The recipe reads this banker's public session list and waits for the matching loaded UI before choosing the entry.
- The recipe records the actual creation entry point. Its isolated fresh run proves the welcome path; a shared run with prior sessions proves the header path. The second creation explicitly proves the picker path. None is reported as another entry point.
- Save settings and Add player must close their sheets before saved-state reads. A completed click alone does not mean the request has committed.
- Search must retain the actual typed text while results load. Wait for the warning or matching result, not a fixed sleep or a retry.
- Exact duplicate names represent separate IDs only after `This is a different person` is checked. Never merge them by text alone.
- Drafts are scoped to banker, session, form and player. Test two different partial values; identical values cannot detect mixing.
- History pagination searches this invocation's unique prefix before loading its 33 matching sessions. Earlier recipes' sessions do not change that fixture.
