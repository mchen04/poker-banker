# Mobile UX

Use after any change to tokens, layout, sheets, navigation, safe areas or PWA chrome. The recipe walks the real UI from the inventory in [docs/UX.md](../../../../docs/UX.md): empty table, playing and mixed tables, player sheets, every financial sheet, add player, correction, deleted entry, session menu, picker, settings, close, share, players, player report, filter, sign-out, viewer and offline. It ends on the auth and recovery-code screens by signing out and creating a disposable account.

## Run

Save the recipe block as `.cache/verify-mobile.ts`, copy only that file to the mini, then run it on a fresh local banker:

```ts
import { join } from 'node:path';
import mobileUx from '../.claude/skills/verify-poker-banker/scripts/mobile';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function (context: RecipeContext) {
  await mobileUx({ ...context, evidence: join(context.evidence, 'mobile-ux') });
}
```

```sh
./scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-mobile.ts --run RUN_ID --context iphone-standalone
./scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-mobile.ts --run RUN_ID --context desktop-webkit
./scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh cleanup --run RUN_ID
```

The recipe writes `mobile-ux/mobile-ux.json` and one screenshot per state, viewport and colour scheme. It fails on any violation; inspect the screenshots as well as the JSON.

## Checks

At 393×852 and 320×568 in light and dark, for every state:

- 44px targets, horizontal overflow and the exact rendered text and non-text contrast (4.5:1 for text, 3:1 for input borders, selected segments and focus rings).
- Input font size of at least 16px and tabular money.
- Focused-field and pinned-primary visibility with the visual viewport reduced to 380px, matching the keyboard emulation in `e2e/table-experience.ts`.
- Pinned primary action centre in the lower 40% of the viewport.
- Safe-area clearance with `--safe-top: 59px` and `--safe-bottom: 34px`; the bottom bar, sheet actions and controls must clear the home indicator.
- 200% text plus WCAG 1.4.12 spacing without clipped text, lost controls or horizontal overflow.
- Reduced-motion durations at or below 20ms.
- A 44px back or close control on every non-root view.
- The offline status line on the offline state.

## Limits

The recipe drives the real UI and uses only the run's seeded account and a second disposable signup for the recovery-code screen. Emulation does not prove a physical keyboard, Home Screen installation, iOS suspension or a physical safe-area inset. Contrast is computed from rendered colours; gradients, images and pseudo-elements are not sampled. Content-level choices that are not pinned, such as the player sheet's action grid, are recorded but are not treated as a pinned primary. Run layout recipes serially and clean up every run.
