# Mobile UX

This inventory follows the approved UI continuation and the [independent baseline review](../evidence/turn3/audit/independent-baseline-ux.md). It describes the working design and acceptance scope; implementation alone does not establish that every state has passed visual or device verification. Automatic PWA update adoption is a separate continuation item.

## Structure and alternatives

**A: compact shell with stable destinations, selected.** Workspace and Players remain visible destinations in a labelled bottom navigation bar. An open session has a separate contextual action bar: Add player leads on an empty table, Buy-in during play, and Close game becomes prominent when players have cashed out. One searchable, month-grouped session picker replaces the persistent recent-session strip. Concise session metadata, chips in play, money to collect/pay, player state and activity form the reading order. Direct Buy-in and Repeat last on a player open a review sheet; neither commits an entry.

**B: game command desk.** The table would become the root, with local table/activity/results sections, one changing command region and full-height financial editors. Roster and reports would move behind a directory entry. This recovers vertical space and simplifies an editor's keyboard geometry, but makes reusable players/results less discoverable, adds navigation and requires more restoration when returning to a game. A preserves the established roster/ledger model while improving repeated entry.

A deliberately spends phone height on two distinct footer regions. Redundant branding stays on desktop; the phone begins with the session picker. On phones, long titles/names clamp cleanly to two lines while their full text remains in the accessible name and detail/settings view. Their combined space, 136 px on phones plus the home indicator inset, is reserved in the document. The picker adds a step when returning to an immediately visible recent game; the gain is less permanent chrome and access to the complete history. Save review, duplicate-name checks, discrepancy acceptance and destructive-action confirmation remain more valuable than the smallest possible tap count.

## Screen, sheet and dialog inventory

| Surface | Contents and required states |
| --- | --- |
| Startup and account gate | Opening/loading; authenticated restoration; expired/revoked authentication; Account changed with explicit Reload account state; recovery-code restore failure with retry before workspace access. |
| Account access | Sign in; Sign up; Recover account with username, one-time code and new password; busy/error/password-reset feedback. |
| Recovery codes | Code display, saved acknowledgement and Continue; device-backup failure/retry; backup changed in another tab; restored unacknowledged codes. Codes remain visible until acknowledgement. |
| Workspace | First-session empty state; active session; empty table; seated, playing, cashed-out and re-entered players; open/closed balanced/closed discrepant session; loading/load error; read-only offline snapshot. |
| Session overview | Session/date/currency/location/game/blind, timer not started/live/stopped/unknown, chips bought/returned/in play or discrepancy, collect/pay totals, Total/Per hour/BB display, unavailable time/blind metrics, activity including original/void/replacement. |
| History picker | New session, search, month groups, current-session marker, open/closed/currency labels, load more, no matches and load error. |
| New session / Session settings | Name, date, currency on creation, location/game suggestions and optional positive big blind; restoring/submitting/error/frozen form. Currency is fixed after creation; closed settings cannot be saved. |
| Session menu | Settings, Correct times, Share session and Close game or Reopen game. |
| Add player | Search/loading/results, reuse existing player, already seated, add new person, exact-name match with explicit different-person acknowledgement, error/frozen form. |
| Session player sheet | Balance, playing duration, Buy-in, Cash out, Record payment, Tips and meals, and that player's full entry history. Closed sessions retain history without write actions. |
| Financial sheets | Buy-in/rebuy, cash-out, payment in/out and tips/meals; player, amount/currency, appropriate suggestions, paid state/method, optional time/note, interpreted amount, validation, saving and pending result. Payment direction stays explicit. |
| Keep/discard money dialog | Cancel with typed work offers Keep draft and close, Discard draft or Keep editing; storage/discard failure remains visible. |
| Correct entry | Original player/action/amount/method, replacement amount, replacement payment method and optional time; Save correction or Void entry → Keep entry/Confirm void; busy/error/frozen states. Original and correction remain in activity. |
| Timing | Manual Start timer; Correct times with start/end, recorded timing history, invalid bounds/error/frozen states and closed-session restriction. Reloading preserves recorded timing. |
| Close / Reopen | Pending-entry and named-player blockers, balanced close, exact discrepancy acceptance and separate outstanding payments; reopen reason and explanation of removal from finalized results until reclosed; busy/error/frozen states. |
| Sharing | Disabled/enabled, viewer link, copy success/fallback, rotate/disable confirmation dialogs and cancel choices, busy/error and closed-session restriction. Rotating/disabling revokes old access. |
| Players | Searchable reusable roster; finalized and outstanding results per currency; no results/empty/loading/load-error states; Account section and Sign out. |
| Player history and reports | Back to players, rename sheet, finalized results and outstanding balances, report groupings Overall/Location/Game/Weekday/Month, no matching finalized sessions, unavailable metrics and past-session links. |
| Report filter sheet | Location, game, weekday, month, from/to dates; Apply and Clear. Human-readable weekday/month labels identify active filters. Filters affect the report; Past sessions remains the player's full history. |
| Sign-out sheet | Local-work check, loading/error, warning that unconfirmed work may already exist, explicit discard-unsent-work checkbox when needed, Confirm sign out and busy state. Changes to local work invalidate an earlier discard choice. |
| Viewer | Login-free loading/live shared session, latest update time, player states/totals/timer/activity, offline/load failure and revoked/unavailable link. No banker navigation, transaction controls or other-session/account data. |
| Global recovery/status | Saved confirmation, offline, Not saved yet, rejected/uncertain entry with retry/check/discard, unconfirmed forms, Needs review, local draft-save failure/retry, cross-tab change notice and Update ready/Reload. These statuses must remain distinguishable from confirmed ledger totals. |

Frozen forms offer **Check saved result** before further editing or a new copy. Needs review includes both recovered-edit versus saved-draft selection and an editable recovered command with save/resubmit/discard. Missing currency can be explicitly restored; an unknown legacy request remains readable/editable without inventing an endpoint. Concurrent changes require review before typing/submitting resumes. Discarding an uncertain entry or recovered command asks for confirmation that it may already exist and that discarding does not undo it.

## Complete journeys

| Journey | Route and correctness checkpoints |
| --- | --- |
| Get access | Sign up → save/acknowledge recovery codes → workspace; sign in/return; recover password → sign in. Exercise restoration failure, invalid credentials and account change. |
| Start or resume a game | First session or picker → create/settings → table; switch between sessions with independently restored drafts; return from history/player reports to the chosen game. |
| Seat players | Add → existing player or new person; distinguish identical names and prevent seating the same person twice. |
| Record play | Buy-in → amount/paid state/method → review/save; repeat/rebuy keeps prior history and opens review; unpaid buy-in records chips without inventing a payment. |
| Settle a player | Cash out actual chips, including zero → choose whether paid; record partial/full payment in either direction with Cash/Venmo/Zelle; re-entry returns a cashed-out player to Playing without showing a premature result. |
| Correct the record | Correct amount/method/time or void → preserved original plus correction; errors retain draft fields; tips/meals remain separate from chip and payment amounts. |
| Track time | First buy-in/manual start → reload/live timer → timing correction/history → stop at close; missing time stays unavailable rather than guessed. |
| Finish/reopen | Resolve playing/pending blockers → balanced close or explicit exact discrepancy → finalized report; outstanding payment balances remain distinct; reopen with reason removes the game from finalized results until closed again. |
| Review results | Players → player → grouping/filter; retain every approved metric, per-currency buckets, sessions-used counts and unavailable reasons. Past sessions leads back to the table. |
| Share | Enable → copy → login-free read-only viewer → confirm rotate/disable → old link unavailable; viewer updates must reflect saved entries without exposing banker controls. |
| Recover interrupted work | Offline entry → local pending state excluded from totals → reconnect → confirmed once; lost reply/frozen form → check saved result; recovered edit/conflicting tab → explicit review; local-save failure → retry without clearing work. |
| Leave safely | Sign out → inspect current local work → confirm or explicitly discard; concurrent and delayed replies cannot restore cleared private state or move work to another account. |

Reports retain profit/loss, money per hour, money per session, playing duration, winning sessions and percentage, tips/meals, net after expenses, big blinds per hour, and variation across session rates in money/hour and BB/hour. Rates use results before expenses and exact recorded time. A sub-minute duration retains the required `0 min` display with a note explaining the hourly rate. Currency totals are never combined across currencies.

## Money field audit

| Field | Input and domain rule |
| --- | --- |
| Buy-in/rebuy amount | Positive minor-unit value; paid-now defaults on for a new buy-in. Last/default/double suggestions apply only to buy-ins and remain reviewable. The session-default shortcut is exactly 20 major units; there is no separate configurable default-amount field. |
| Cash-out amount | Nonnegative; zero is valid for no chips left and creates no payment. Enter actual chips returned. Paid-out-now defaults off. |
| Payment in/out amount | Positive; direction and method explicit. Outstanding balance can seed a reviewable suggestion. |
| Tips/meals amount | Positive; expense detail separate; no buy-in amount shortcut. |
| Replacement amount | Same precision/range as the original kind; only cash-out replacements may be zero. |
| Session big blind | Blank means unset; otherwise positive, using the selected currency's precision. Applies to new sessions and settings. |
| Recovered major-unit fields | Amount, replacement amount and big blind use the same shared parser. Preserve invalid typed values and other fields so they can be corrected. |
| Legacy recovered raw minor units | Whole digits only, with actionable precision/range errors and exact bigint normalization; nullable blind and derived signed discrepancy are preserved. The API still enforces kind-specific zero rules. Missing currency for major-unit editing requires review. |
| Close discrepancy | Derived signed exact sum, accepted by checkbox against the current revision; no user decimal conversion. It may exceed one entry's limit because it is a sum. |

Money inputs have no artificial HTML maximum or text-length cap. Arithmetic and conversion use strings/BigInt, with no floating-point parsing or rounding. The parser accepts outer whitespace, a leading currency-appropriate standard/narrow symbol with optional following space, ordinary digits or strict three-digit comma groups, and a period with up to the currency's allowed decimal places. Fraction-only input is accepted when the currency has decimals: USD `12.5`, `12.50`, `.75`, `$1,234.56`. JPY accepts `¥1,234` and rejects decimal parts. KWD retains three-decimal precision. The existing supported-ISO-currency check remains unchanged; the session selector offers USD, JPY, CAD, EUR, GBP, SGD, HKD and AUD.

Negative values, junk, malformed grouping and excessive precision are rejected with a corrective example or precision instruction. Empty input asks for an amount; overflow names the actual maximum. Parsing zero is valid; the form/API/database enforce where zero is allowed.

The database/API per-entry maximum is **9,223,372,036,854,775,807 minor units**, the signed PostgreSQL bigint maximum. In major units this is USD **92,233,720,368,547,758.07**, JPY **9,223,372,036,854,775,807**, or KWD **9,223,372,036,854,775.807**. Positive fields begin at one minor unit (USD 0.01, JPY 1). Formatting retains exact cents even above JavaScript's safe-integer range. Computed ledger/report totals remain exact sums rather than being clipped to an entry limit.

## Measured action counts

Counts below are measured baseline values from the [standalone recipe JSON](../evidence/verify/20261112T095229642Z-af582111/iphone-standalone/recipe-1794477518087-8a2415/tap-counts-before.json). A tap means a successful navigation, choice, toggle or commit control activation. Typing, field focus, scrolling and fixture setup are excluded. Each journey begins at its named current screen and ends after the stored result or displayed destination; counts are not universal task costs.

After counts come from the [standalone after recipe JSON](../evidence/verify/20261112T105401394Z-041661c4/iphone-standalone/recipe-1794480963336-0e1ea5/tap-counts-after.json). These counts were rerun on the final layout.

| Measured journey | Before | After | Trade-off / retained safeguard |
| --- | ---: | ---: | --- |
| Create first session | 2 | 2 | Explicit creation keeps date/currency review. |
| Create another session | 2 | 3 | One extra picker step removes a persistent navigation row. |
| Return to another recent session | 1 | 2 | One extra picker step gives one searchable history control. |
| Add a new player | 2 | 2 | Exact-name duplicate warning stays; fixture uses a unique name. |
| Reuse an existing player | 2 | 2 | Reuses identity instead of creating a duplicate player. |
| Buy-in from player row, choose Venmo | 4 | 3 | Amount, paid state, method and Save remain explicit. |
| Repeat last buy-in with remembered method | 4 | 2 | Opens review; never writes immediately, and existing drafts win. |
| Record outstanding payment with Zelle | 4 | 4 | Direction/method stay explicit; balance is only a suggestion. |
| Enable and copy viewer link | 4 | 4 | Copy may offer manual fallback; rotate/disable require separate confirmation. |
| Cash out actual chips and mark paid | 5 | 5 | Actual chips are entered; payment-out is never assumed. |
| Correct a payment method | 3 | 3 | Original entry and replacement remain visible. |
| Close a balanced session | 3 | 2 | Close still reviews blockers; nonzero discrepancy also requires consent. |
| Open player report and apply a filter | 4 | 4 | Filter application stays explicit; metrics and currency buckets remain unchanged. |

## Safeguards and evidence boundaries

Sheets use a stable header, scrollable fields and an action region. Keyboard focus stays within the sheet and returns to its opener; dismissal is blocked while a financial action is busy. Visual-viewport resizing must keep focused fields, validation and Save reachable. Verify the final field of money/note, correction/time, session, timing and filter forms in a short viewport. Footer reservation, home-indicator clearance, long titles, 100-character/unbroken names, maximum money strings, light/dark states and desktop access require direct inspection. Layering and keyboard focus tests do not substitute for checking assistive-technology access to background controls.

Validation retains values and payment context. Queued/unconfirmed work remains separate from saved totals; a failed response cannot imply that a financial write did not occur. Existing draft ownership, cross-tab review, duplicate-submit protection, immutable submitted requests and sign-out safeguards remain part of acceptance. Lower tap counts do not justify bypassing these checks.

The Pookie reference was limited to its public login page at 393×852: clear primary action, no observed horizontal overflow, and 48 px password/action heights. Authenticated footer/navigation/update behavior was unavailable; the supplied retained PDF was absent on this filesystem. No account access or reference-app changes were performed. This supports comparison of observed public dimensions only and no claim of universal superiority.

Phone WebKit and standalone emulation can establish viewport, engine and application behavior. They do not prove an actual iOS Home Screen installation, software-keyboard behavior, process suspension, storage eviction or physical safe-area clearance. Record those limitations and obtain real-device evidence separately. Baseline/after screenshots, measured controls and complete-flow results must be assessed together; a passing test suite alone is insufficient UX evidence.

## Observed layout

The final local captures are retained in [standalone phone](../evidence/verify/20261112T105401394Z-041661c4/) and [desktop WebKit](../evidence/verify/20261112T105721785Z-bc2d4ff9/). Both include the ledger and all nine feature recipes. Captures wait for the roster, report and authentication landmarks; light/dark viewport images complement full-page flow evidence. Secondary contexts retain the chosen viewport, touch and standalone profile while starting without shared cookies.

At 393×659, the normal two-player fixture starts its first card at 372 px. The long-title/two-player and eight-player fixtures start it at 400 px and finish it at 522 px, above actions beginning at 523 px. Only one complete row is visible before scrolling. The long fixture has less than one pixel of headroom, so this is a fixture-specific observation, not a guarantee for extra metadata, larger text or physical safe areas. The last activity row can scroll fully above both bars. Desktop 1440×1000 retains a complete first row in the same long fixture, with no horizontal page overflow.

The first proposed layout failed this review: its first player began at 778 px on the same short phone viewport. Compact metadata/totals, two-line headings, a player action rail and removal of the phone brand bar replaced it. Independent code and visual reviews cover the revised result; physical iOS checks remain open as described above.
