# Interface and PWA research

Collected before implementation on 2026-11-10. These notes ground the UI and update decisions in `ARCHITECTURE.md`.

## Interface references

- Linear's redesign: neutral base, one accent with limited tint, fewer separators, fewer and smaller icons, no colored icon backgrounds. https://linear.app/blog/how-we-redesigned-the-linear-ui
- Apple HIG color and accessibility: never use color as the only signal; pair state with text or glyph shape; color only status and primary actions. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/color.json , https://developer.apple.com/tutorials/data/design/human-interface-guidelines/accessibility.json
- Apple HIG lists: scan text in lists with short rows; push detail into a detail view. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/lists-and-tables.json
- Apple HIG typography: iOS defaults of 28, 20, 17 (body), 15, 13 and 11 points. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/typography.json
- Tabular figures for aligned amounts. https://developer.mozilla.org/en-US/docs/Web/CSS/font-variant-numeric
- Tap targets of at least 44 by 44 points and safe-area padding. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/layout.json
- Tab bars are for app sections and segmented controls stay at five segments or fewer, so session switching uses a compact scrollable tab strip plus a history picker sheet rather than a tab bar. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/tab-bars.json , https://developer.apple.com/tutorials/data/design/human-interface-guidelines/segmented-controls.json
- Sheets: medium detent, grabber, cancel leading, confirm trailing, confirm before discarding a typed value, never stack sheets. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/sheets.json
- Search-first add flow: show recent players before typing, filter on type, end with "Add 'Name' as new". https://developer.apple.com/tutorials/data/design/human-interface-guidelines/searching.json
- `inputmode="decimal"` for amounts. https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/inputmode
- Monzo shows extra row detail only when it adds information. https://monzo.com/blog/how-we-unified-our-customers-activity-on-the-new-home-screen
- Home-game bankers report the bank coming up short from unrecorded buy-ins, and poker apps advertise undo for buy-ins. https://www.pokerchipforum.com/threads/how-do-you-handle-money-in-home-cash-games-%E2%80%94-collect-upfront-or-settle-at-the-end.140488/ , https://apps.apple.com/app/pokersquad/id6757091892
- Bottom toolbars keep few items with one prominent primary action. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/toolbars.json

Research gaps: poker app store listings gave text only with no screenshots. Splitwise, PartyPot and Tricount pages failed to load. Copilot and Wallet notes come from reviews and support pages.

## Anti-patterns to avoid

Gradient hero cards, glass effects, emoji, avatar color blobs, pills on every value, horizontal grids, colored backgrounds on many controls, stacked sheets, color-only amounts, proportional digits for money.

## Pancake PWA reference (read-only inspection)

Pancake is an Expo Router static web export on Vercel with Supabase. What carries over:

- Hand-written `sw.js` with a stamped release version and precache list. The build fails without a version.
- Vercel headers: immutable caching for hashed assets, and a `404` with `no-store` for missing asset paths so a stale chunk never gets HTML.
- The worker never handles non-GET, auth or API requests, and never caches responses with `Set-Cookie`, `private` or `no-store`.
- `skipWaiting` is gated on open pages reporting no "hold". Editors, unsent forms and in-flight mutations hold the update. Update checks run on visibility, on `online` and hourly.
- Request IDs are reused on replay for idempotency.

What this app does differently, and why:

- Drafts and the outbox go to IndexedDB, not `sessionStorage` or `localStorage`. Pancake's own review notes that `sessionStorage` drafts die when an iOS standalone app is killed.
- Auth is an `HttpOnly` cookie instead of a token in `localStorage`, so scripts cannot read it and storage eviction does not sign the banker out of the server session.
- Holds come from state the app already knows (an open sheet, a non-empty outbox) rather than a per-window message round trip with a 750 ms timeout, which Pancake's review found can delay activation indefinitely on a suspended iOS page.
- Pancake's update test runs only in Chromium. This app tests updates in WebKit as well and labels what emulation cannot prove.
