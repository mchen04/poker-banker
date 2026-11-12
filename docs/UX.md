# Mobile UX

This inventory follows the approved UI continuation and the [independent baseline review](../evidence/turn3/audit/independent-baseline-ux.md). It describes the working design and acceptance scope; implementation alone does not establish that every state has passed visual or device verification. Service-worker and update behavior remain unchanged in this UX follow-up.

## Structure

The phone has one safe-area-aware bar: Table, one contextual action, and Players. For the current open session, the action is always Buy-in on Table and Players, including an empty table or everyone cashed out. It opens the explicit player chooser. Without a current open session it is New session; Reopen stays in Menu with its required reason. A money sheet never chooses a player implicitly. The session title opens Sessions; a visibly labelled + New beside it opens New session directly. A closed desktop session hides that duplicate and keeps the single New session action in the top navigation. Current and open sessions precede the month-grouped closed history. Desktop moves navigation to the top and places activity beside the wider table. Its toast is at most 420 px wide, aligned to the table column with reserved bottom clearance. Session names the saved record; Game in settings and reports means the poker variant.

The integrated bar replaces the former two-bar design. Rows keep player identity, position and payment balance together with a direct state-aware action. Playing rows show chips bought, never invented live profit; a net result appears only after cash-out. Financial review, duplicate-name checks, exact discrepancy acceptance and destructive confirmations remain.

The supplied Pookie Budget PDF was inspected offline, including its footer/navigation screenshots on pages 3 and 4. It shows one integrated bar with a central action. This revision follows that structural economy without copying its gradients or decoration. No reference-app visit or account access was performed.

## Screen, sheet and dialog inventory

| Surface | Contents and required states |
| --- | --- |
| Startup and account gate | Opening/loading; authenticated restoration; expired/revoked authentication; Account changed with explicit Reload account state; recovery-code restore failure with retry before table access. |
| Account access | Sign in; Sign up; Recover account with username, one-time code and new password; busy/error/password-reset feedback. |
| Recovery codes | Code display, saved acknowledgement and Continue; device-backup failure/retry; backup changed in another tab; restored unacknowledged codes. Codes remain visible until acknowledgement. |
| Table | First-session empty state; active session; empty table; seated, playing, cashed-out and re-entered players; open/closed balanced/closed discrepant session; loading/load error; read-only offline snapshot. |
| Session overview | Session/date/currency/location/game/blind, timer not started/live/stopped/unknown, chips bought/returned/in play or discrepancy, collect/pay totals, Total/Per hour/BB display, unavailable time/blind metrics, activity including original/void/replacement. |
| Sessions picker | New session, search, month groups, current-session marker, open/closed/currency labels, load more, no matches and load error. |
| New session / Session settings | Name, date, currency on creation, location/game suggestions and optional positive big blind; restoring/submitting/error/frozen form. Currency is fixed after creation; closed settings cannot be saved. |
| Session menu | Settings, Correct times, Share session and Close session or Reopen session. |
| Add player | Search/loading/results, reuse existing player, already seated, add new person, exact-name match with explicit different-person acknowledgement, error/frozen form. |
| Session player sheet | Balance, playing duration, Buy-in, Cash out, Record payment, Tips and meals, and that player's full entry history. Closed sessions retain history without write actions. |
| Financial sheets | Buy-in/rebuy, cash-out, payment in/out and tips/meals; player, amount/currency, appropriate suggestions, paid state/method, optional time/note, interpreted amount, validation, saving and pending result. Payment direction stays explicit. |
| Keep/discard money dialog | Cancel with typed work offers Keep draft and close, Discard draft or Keep editing; storage/discard failure remains visible. |
| Correct entry | Original player/action/amount/method, replacement amount, replacement payment method and optional time; Save correction or Void entry → Keep entry/Confirm void; busy/error/frozen states. Original and correction remain in activity. |
| Timing | Lasting retained-timer line after all buy-ins are voided; Manual Start timer; Correct times with start/end, recorded timing history, invalid bounds/error/frozen states and closed-session restriction. Reloading preserves recorded timing. |
| Close / Reopen | In-page Everyone has cashed out · Close session card and unsettled count; pending-entry and named-player blockers, balanced close, exact discrepancy acceptance and separate outstanding payments; reopen reason and explanation of removal from finalized results until reclosed; busy/error/frozen states. |
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
| Get access | Sign up → save/acknowledge recovery codes → table; sign in/return; recover password → sign in. Exercise restoration failure, invalid credentials and account change. |
| Start or resume a session | First session or picker → create/settings → table; switch between sessions with independently restored drafts; return from history/player reports to the chosen game. |
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
| Buy-in/rebuy amount | Positive minor-unit value; paid-now defaults on for a new buy-in. Last and typical use effective saved buy-ins; ×2 doubles the current valid input. Suggestions fit one row and remain reviewable. Typical means the most frequent session buy-in, with ties keeping the current suggestion; it is hidden when none exists. Method defaults to that player's last effective method, otherwise Cash. |
| Cash-out amount | Nonnegative; zero is valid for no chips left and creates no payment. Enter actual chips returned. Paid-out-now defaults off. |
| Payment in/out amount | Positive; direction and method explicit. Outstanding balance can seed a reviewable suggestion. |
| Tips/meals amount | Positive; expense detail separate; no buy-in amount shortcut. |
| Replacement amount | Same precision/range as the original kind; only cash-out replacements may be zero. |
| Session big blind | Blank means unset; otherwise positive, using the selected currency's precision. Applies to new sessions and settings. |
| Recovered major-unit fields | Amount, replacement amount and big blind use the same shared parser. Preserve invalid typed values and other fields so they can be corrected. |
| Legacy recovered raw minor units | Whole digits only, with actionable precision/range errors and exact bigint normalization; nullable blind and derived signed discrepancy are preserved. The API still enforces kind-specific zero rules. Missing currency for major-unit editing requires review. |
| Close discrepancy | Derived signed exact sum, accepted by checkbox against the current revision; no user decimal conversion. It may exceed one entry's limit because it is a sum. |

Money inputs have no artificial HTML maximum or text-length cap. Arithmetic and conversion use strings/BigInt, with no floating-point parsing or rounding. The parser accepts outer whitespace, a leading currency-appropriate standard/narrow symbol with optional following space, ordinary digits or strict three-digit comma groups, and a period with up to the currency's allowed decimal places. A trailing period is accepted. One unambiguous comma may act as a decimal separator; valid three-digit grouping takes precedence, and mixed decimal conventions such as `1.234,56` or malformed grouping are rejected. Fraction-only input is accepted when the currency has decimals: USD `12.5`, `12.50`, `.75`, `$1,234.56`. JPY accepts `¥1,234` and rejects decimal parts. KWD retains three-decimal precision. The existing supported-ISO-currency check remains unchanged; the session selector offers USD, JPY, CAD, EUR, GBP, SGD, HKD and AUD.

Negative values, junk, malformed grouping and excessive precision are rejected with a corrective example or precision instruction. Empty input asks for an amount; overflow names the actual maximum. Parsing zero is valid; the form/API/database enforce where zero is allowed.

The database/API per-entry maximum is **9,223,372,036,854,775,807 minor units**, the signed PostgreSQL bigint maximum. In major units this is USD **92,233,720,368,547,758.07**, JPY **9,223,372,036,854,775,807**, or KWD **9,223,372,036,854,775.807**. Positive fields begin at one minor unit (USD 0.01, JPY 1). Formatting retains exact cents even above JavaScript's safe-integer range. Computed ledger/report totals remain exact sums rather than being clipped to an entry limit.

## Measured action counts

A tap is a successful navigation, choice, toggle or commit control activation. Typing, focus, scrolling, fixture setup and screenshot-only actions are excluded. Each row names its starting surface. Round 35 and 37 are the judge-checked previous measurements; Round 39 comes from the same executed helper in the [phone control receipt](../evidence/verify/20261112T144719639Z-49606dff/iphone-standalone/recipe-1794494858788-07446d/approval/tap-counts.json) and [desktop receipt](../evidence/verify/20261112T144911445Z-33a9ae17/desktop-webkit/recipe-1794494969822-4a3d67/approval/tap-counts.json). All fourteen counts match across both contexts. Round 41 restores the two-control ready-card path while the centre action keeps its meaning; the Menu fallback remains available.

| Representative journey | Round 35 | Round 37 | Round 39 | Round 41 | Retained safeguard / trade-off |
| --- | ---: | ---: | ---: | ---: | --- |
| Create first session | 2 | 2 | 2 | 2 | Creation keeps name/date/currency review. |
| Add a new player | 2 | 2 | 2 | 2 | Duplicate-name safeguard remains. |
| Buy-in from player row, choose Venmo | 3 | 3 | 3 | 3 | Fixed chosen player and explicit Save. |
| Repeat last buy-in with player's remembered method | 2 | 2 | 2 | 2 | Prefill opens review; the player’s saved draft wins. |
| Cash out actual chips and mark paid | 5 | 3 | 3 | 3 | Actual chips remain typed; payout is explicit. |
| Record outstanding payment with Zelle | 4 | 3 | 3 | 3 | Direction is explicit; balance is a reviewable suggestion. |
| Correct a payment method | 3 | 3 | 3 | 3 | Original and replacement stay visible. |
| Close a balanced session | 2 | 2 | 3 | 2 | Ready card → confirm restores two taps; the footer stays Buy-in and financial checks remain. |
| Create another session | 3 | 2 | 2 | 2 | Phone header + New or the closed desktop’s single navigation action opens creation directly. |
| Reuse an existing player | 2 | 2 | 2 | 2 | Reuses the stable player identity. |
| Return to another recent session | 2 | 2 | 2 | 2 | Title plus choice replaces the duplicate switcher row. |
| Open player report and apply a filter | 4 | 4 | 4 | 4 | Filter application remains explicit. |
| Enable and copy viewer link | 4 | 4 | 4 | 4 | Rotation/disable need separate confirmation. |
| Footer buy-in, explicitly choose player and Venmo | Not measured | 4 | 4 | 4 | The extra player choice prevents wrong-player money. |

The original pre-Round-35 tab strip needed one tap for a visible recent session. The picker still needs two, but now the title itself is the trigger and the extra switcher row is gone. There was no historical footer measurement; no before value is invented. The new footer path is four taps when changing Cash to Venmo, or three when retaining the player's method. These are representative control counts, not full task costs including typing or reconnecting a device. The additional [phone follow-up receipt](../evidence/verify/20261112T144719639Z-49606dff/iphone-standalone/recipe-1794494858788-07446d/followups/tap-counts.json) and [desktop follow-up receipt](../evidence/verify/20261112T144911445Z-33a9ae17/desktop-webkit/recipe-1794494969822-4a3d67/followups/tap-counts.json) record footer buy-in from Players at four taps with Venmo, balanced close at three, and Menu reopen with its required reason at three. Those are the historical Round 39 counts. Round 41 restores balanced close to two controls through the in-page ready card, without removing confirmation; Menu still provides the three-control fallback and reason-required reopen.

## Safeguards and evidence boundaries

Sheets use a stable header, scrollable fields and an action region. Keyboard focus stays within the sheet and returns to its opener; dismissal is blocked while a financial action is busy. Visual-viewport resizing must keep focused fields, validation and Save reachable. Verify the final field of money/note, correction/time, session, timing and filter forms in a short viewport. Footer reservation, home-indicator clearance, long titles, 100-character/unbroken names, maximum money strings, light/dark states and desktop access require direct inspection. Layering and keyboard focus tests do not substitute for checking assistive-technology access to background controls.

Validation retains values and payment context. Queued/unconfirmed work remains separate from saved totals; a failed response cannot imply that a financial write did not occur. Existing draft ownership, cross-tab review, duplicate-submit protection, immutable submitted requests and sign-out safeguards remain part of acceptance. Lower tap counts do not justify bypassing these checks.

Phone WebKit and standalone emulation can establish viewport, engine and application behavior. They do not prove an actual iOS Home Screen installation, software-keyboard behavior, process suspension, storage eviction or physical safe-area clearance. Record those limitations and obtain real-device evidence separately. Baseline/after screenshots, measured controls and complete-flow results must be assessed together; a passing test suite alone is insufficient UX evidence.

## Observed layout

The approval recipe captures eight players at 393×659 and 393×852 in light and dark. It requires four and six complete rows respectively above the single bar, checks focused fields and Save against a 380 px emulated visual viewport, and checks desktop width at 1440×1000. The executed [standalone run](../evidence/verify/20261112T130200912Z-14f6b34d) and [desktop WebKit run](../evidence/verify/20261112T130627916Z-add7b2ee) each passed the approval capture, ledger drive and all nine feature recipes. The eight-player fixture shows **4 complete rows at 393×659 and 6 at 393×852**, in both themes. Money values fit without ellipsis. All payment choices and Save fit above the 380 px visual viewport. Desktop has a table wider than 1000 px, top navigation and a separate activity column. Both cleanup receipts have no errors and retain 108 screenshots each. A separate [pagination run](../evidence/verify/20261112T132011045Z-1261a0b5/) then passed the stronger sessions recipe in both contexts: an open 2024 session is absent from the first history page but visible in the pinned section without Load more. Its cleanup also succeeded. These observations do not establish physical iOS safe-area or keyboard behavior.

## Judge findings

| Finding | Implemented response |
| --- | --- |
| M1 | One 64 px phone bar plus safe area; compact header/totals and rows meet 4/6-row targets. |
| M2 | Footer opens an explicit chooser; the money sheet fixes the chosen player as text. |
| M3 | Unpaid/Cash/Venmo/Zelle, own-player method, one quick row and visual-viewport compact layout. |
| M4 | Linked field errors focus the input; request errors stay above Save; values remain intact. |
| M5 | Reset select appearance, 48 px height, explicit payment direction and disabled currency hint. |
| M6 | Title switcher, independently loaded open sessions and direct two-tap creation. |
| M7 | State-aware buy-in/rebuy/cash-out/settlement, readable position/owed values and results-only display modes. |
| M8 | Wide desktop table/activity layout with top navigation. |
| m1 | One inset focus ring for all fields. |
| m2 | Eight seconds of available toast time, paused while touched, hovered, focused or editing; latest-receipt atomic Undo remains guarded. |
| m3 | Session names throughout, Table destination and one leading Cancel convention. |
| m4 | Typical stake comes from effective saved buy-ins and is absent without history. |
| m5 | Money spans do not break the sign from the value. |
| m6 | Each close blocker opens that player's cash-out sheet. |
| m7 | Currency has a disabled style and fixed-after-creation hint. |
| m8 | State and money detail use 13–15 px; 12 px is tertiary. |
| m9 | Exact comma-decimal and trailing-period parsing, with precision/range tests. |
| m10 | Sessions search does not autofocus; actual device keyboard behavior remains unverified. |
| m11 | Read-only viewer cards show position/owed values; revoked links have no live-update label. |
| m12 | Rebuy/repeat use that player's effective method. |
| m13 | Offline reference PDF read; all 14 representative journeys measured, including footer. |

Undo is available for eight seconds of unpaused time and only while its original receipt is the latest revision. The budget pauses during touch, hover, focus, open sheets and busy Undo; resuming keeps the remaining time. A first-buy-in Undo preserves the independently recorded timer, explicitly names its running start and offers Correct times. This follows the approved rule for visible timing corrections instead of silently resetting recorded time. It reverses a newly saved entry and its generated payment in one database transaction; newer work is never reversed by that button. Voids/corrections retain their explicit review flow. Cash-out stays blank with an explicit zero shortcut because buy-ins cannot determine the actual chips returned. No ledger safeguard was removed to reduce taps. After a void leaves a running timer with no confirmed buy-ins, a lasting Timer started … · Correct times line survives toast expiry and reload. It is derived from confirmed entries and timing revisions, clears after a later timing correction or a new buy-in, and can return after another Undo.

## Round 39 follow-up proof

The [standalone run](../evidence/verify/20261112T144719639Z-49606dff) and [desktop WebKit run](../evidence/verify/20261112T144911445Z-33a9ae17) each passed the 14-journey approval capture, focused follow-up recipe and ledger drive. The runs retained 75 screenshots each after cleanup. Both themes show the open/closed Table and Players footers, actionable close blockers, debt/Paid up rows, Undo and its retained-timer explanation, and grouped report variation. The eight-player fixture still shows 4 complete rows at 393×659 and 6 at 393×852. Long names receive two lines before truncation. Debt text in the session, viewer, roster and player detail has weight 700 and measured contrast of 6.72:1 in light and 9.13:1 in dark.

The timer remains recorded after Undo because the approved spec requires explicit correction with visible history instead of a silent reset. Its toast states the retained running start and opens Correct times. Pointer hold, focus and an open sheet each preserved Undo for 8.3 seconds. A separate check spent 4.8 seconds, paused 8.3, then spent 3.6 more and required dismissal, proving that resuming keeps the remaining budget. A held real Undo response followed by a session switch produces no wrong-session timing action. No physical iPhone or full-suite claim is made.

| Follow-up finding | Current response |
| --- | --- |
| R2-M1 | Buy-in stays in the centre for the current open session on both tabs, including empty/cashed-out tables. Closed or absent current session uses New session. Reopen stays in Menu with a reason. |
| n1 | Full-width, left-aligned blocker rows name the player/state and open that exact cash-out. |
| n2 | Owes/owed use warning colour and weight 700; Paid up stays muted, with text retaining the distinction. |
| n3 | Eight seconds of available Undo time, paused during touch, focus, hover and sheets; the remaining budget is preserved. |
| n4 | Header creation visibly says + New and retains the New session accessible name. |
| n5 | Desktop navigation uses a transparent backing aligned above the header rule. |
| n6 | Player names clamp after two readable lines; money groups do not gain ellipsis. |
| n7 | Variation uses the exact grouped currency formatter after half-even rounding; hand-derived sample displays $1,414.21. |
| n8 | Recorded timing is preserved and explained, with an actionable Correct times link. |

## Round 41 judge follow-ups

The [standalone control receipt](../evidence/verify/20261112T155941765Z-faf1cebe/iphone-standalone/recipe-1794499269682-ecbf27/approval/tap-counts.json) and [desktop control receipt](../evidence/verify/20261112T160347750Z-0a3dfd0a/desktop-webkit/recipe-1794499556949-afa95e/approval/tap-counts.json) remeasure all 14 journeys; their counts match. Balanced close is now **2 taps** through Everyone has cashed out · Close session and confirmation. Create another remains **2 taps**, using the header on phone or the single navigation action on a closed desktop session. The footer meaning and all financial confirmations remain unchanged.

The [phone captures](../evidence/verify/20261112T155941765Z-faf1cebe/iphone-standalone/recipe-1794499269682-ecbf27/followups/) and [desktop captures](../evidence/verify/20261112T160347750Z-0a3dfd0a/desktop-webkit/recipe-1794499556949-afa95e/followups/) show all four follow-ups in light and dark. Desktop toast width is **420 px**, its right edge stays left of Activity, and the last player row can scroll above it. The retained timer line survives reload with the toast gone, clears after a saved timing correction, returns after another Undo, then disappears when a new buy-in is confirmed. The recorded timer is never reset silently. Each run retains 38 screenshots across approval and focused captures, plus geometry, ARIA and control receipts. No physical-device or full-suite claim is made.

| Judge finding | Current response |
| --- | --- |
| R3-1 | Ready card above Players when no one is playing and someone has cashed out; includes the unsettled count and opens the existing close flow. |
| R3-2 | Closed desktop hides the duplicate header New and keeps the navigation action; phone header/footer are unchanged. |
| R3-3 | Desktop toast is capped at 420 px in the table column; bottom clearance keeps the last row reachable. |
| R3-4 | Lasting Timer started … · Correct times is reconstructed from confirmed ledger/timing history until correction or a new buy-in. |
