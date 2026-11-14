# Screen tour and layout

Proves every banker and viewer screen at iPhone width (393×852), 375×812 and the narrowest supported phone (320×568), checks layout automatically, and records load filmstrips for flicker. It needs a fresh banker because it creates its own players by name.

## Run

```sh
RUN=$(./scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh launch --local | grep -o '"runId": "[^"]*"' | head -1 | cut -d'"' -f4)
./scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh recipe .claude/skills/verify-poker-banker/scripts/tour.ts --run "$RUN" --context iphone-standalone
./scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh cleanup --run "$RUN"
rsync -az "mini:worktrees/poker-banker/evidence/verify/$RUN/" "evidence/verify/$RUN/"
```

Repeat on a fresh run with `--context desktop-webkit`. The tour lives in the skill's `scripts/` folder, so the mini runner syncs it without a manual copy.

## What it captures

`tour/` holds one PNG per screen and width: empty and seated tables, saved toast, long-name player sheet, buy-in, payment, correction, session menu, sessions picker, Players, player report, cold reload, viewer, dark theme, the close sheet, and the deletion screens: delete-entry confirm and toast, Deleted activity row, Restore entry sheet, Remove from game confirm and toast, Removed disclosure, Session menu with Delete session, delete-session confirm and toast, the empty table's Recently deleted, a second player report and the delete-player confirm, toast and Recently deleted list. Fixtures use a 43-character name, "Alexandria Montgomery-Whitfield", a $123,456,789.99 buy-in and a $123,456,789.00 buy-in and payment so wrapping and clipping show up.

`layout.json` comes from `scripts/layout.ts` and lists, per screen and width:

| Kind | Meaning |
| --- | --- |
| `page-overflow` | The page scrolls sideways. |
| `offscreen` | A leaf element extends past the viewport outside a scrolling container. |
| `wrapped-money` | An amount breaks across lines. Money must stay on one line. |
| `clipped-text` | Text is cut off without an ellipsis. |
| `small-target` | A control is under 44×44 CSS px. |
| `row-misaligned` | Player rows disagree on the name's left edge, the rightmost control's right edge or row height. |

`14-cold-reload-frames.json` and `16-viewer-load-frames.json` record the text of each frame captured while the page loads. A pass has no frame showing a different or empty state before the real one (for example, "No active sessions" on a banker who already has sessions), and no loading chatter.

## Judging

Zero `wrapped-money`, `offscreen`, `page-overflow` and `clipped-text` entries are required. Check every `small-target` and `row-misaligned` entry against the screenshots. Then look at the PNGs yourself: the checker doesn't judge hierarchy, spacing rhythm or tone, and it ignores ellipsized text, so confirm that full player names, session names and transaction kinds (Player paid bank, Buy-in, Deleted) are readable in rows, sheet and report headers, confirms and toasts. Compare them with the previous run's tour. Emulation doesn't prove real iOS keyboard, safe-area or Home Screen behaviour.
