# UX inventory and decisions

Phone and installed-PWA first: one safe-area-aware bar contains Table, a single contextual action and Players. For the current open session, the centre always means Buy-in, on either tab, and starts with an explicit player choice. With no current open session it means New session. Reopen stays in Menu with a reason. The session title is the picker, with current/open sessions pinned before searchable month-grouped history. The header keeps the title and its chevron on one line with two 44px icon buttons, New session (+) and Session menu (…); one meta line follows: date · location · game · currency · blind · status · timer, with Start timer only before the timer has started. The + gives two-control creation; a closed desktop session shows only one New action.

Compact rows distinguish Playing, Cashed out and Paid up from Owes/Owed using text, weight and colour. Net result appears only after cash-out. Rows share one grid: name and state on the left, amount and balance in one right-aligned column, actions in one fixed-width column, so edges line up across rows. Names stay on one line with ellipsis (full name in the title and player sheet); money never wraps, loses its sign or gains ellipsis, and shrinks to fit instead. Below 375px the row actions move under the row. Zero balances and redundant labels are not shown. Desktop uses top navigation and a wider table beside Activity. Its toast is capped at 420px in the table column. Fixed chrome reserves enough content clearance for the last row. Use one type/spacing scale, restrained neutral surfaces, 44px targets, visible focus, light/dark themes, sheets with the title on the left and one 44px close button on the right (named Cancel on money sheets, Close sheet elsewhere), sized to their content up to about 92% of the screen, scrollable, with the primary action pinned under the content and above the visual keyboard.

## Screen, sheet and dialog inventory

| Surface | Contents and required states |
| --- | --- |
| Startup and account gate | Snapshot-first paint: a returning device shows a table skeleton, then the remembered session from its local snapshot, never the empty state before the real session has been checked; authenticated restoration; expired/revoked authentication; Account changed with explicit Reload account state; recovery-code restore failure with retry before table access. |
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
| Close / Reopen | In-page Everyone has cashed out · Close session card and unsettled count; pending-entry and named-player blockers, balanced close, exact discrepancy acceptance and separate outstanding payments (shown only when non-zero); reopen reason and explanation of removal from finalized results until reclosed; busy/error/frozen states. |
| Sharing | Disabled/enabled, viewer link, copy success/fallback, rotate/disable confirmation dialogs and cancel choices, busy/error and closed-session restriction. Rotating/disabling revokes old access. |
| Players | Searchable reusable roster (Find a player); name left and finalized net right, with a sub-line only for non-zero outstanding balances; no results/empty/loading/load-error states; one quiet Signed in as … row with Sign out. |
| Player history and reports | Back to players, rename sheet, finalized results and outstanding balances, report groupings Overall/Location/Game/Weekday/Month, no matching finalized sessions, unavailable metrics and past-session links. |
| Report filter sheet | Location, game, weekday, month, from/to dates; Apply and Clear. Human-readable weekday/month labels identify active filters. Filters affect the report; Past sessions remains the player's full history. |
| Sign-out sheet | Local-work check, loading/error, warning that unconfirmed work may already exist, explicit discard-unsent-work checkbox when needed, Confirm sign out and busy state. Changes to local work invalidate an earlier discard choice. |
| Viewer | Login-free loading/live shared session, one quiet `View only · <time>` line, player states/totals/timer/activity, offline/load failure and revoked/unavailable link. No banker navigation, transaction controls or other-session/account data. |
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

## Measured controls

Count successful choice/navigation/commit activations, excluding typing, focus, scrolling and fixture setup. Earlier values are the first measured phone redesign; current values are the latest executed [standalone receipt](../evidence/verify/20261112T155941765Z-faf1cebe/iphone-standalone/recipe-1794499269682-ecbf27/approval/tap-counts.json) and [desktop receipt](../evidence/verify/20261112T160347750Z-0a3dfd0a/desktop-webkit/recipe-1794499556949-afa95e/approval/tap-counts.json), which match all fourteen journeys. No earlier footer count was measured.

| Journey | Earlier measured controls | Current controls | Safeguard / trade-off |
| --- | ---: | ---: | --- |
| Create first session | 2 | 2 | Creation keeps name/date/currency review. |
| Add a new player | 2 | 2 | Duplicate-name safeguard remains. |
| Buy-in from player row, choose Venmo | 3 | 3 | Fixed chosen player and explicit Save. |
| Repeat last buy-in with player's remembered method | 2 | 2 | Prefill opens review; the player’s saved draft wins. |
| Cash out actual chips and mark paid | 5 | 3 | Actual chips remain typed; payout is explicit. |
| Record outstanding payment with Zelle | 4 | 3 | Direction is explicit; balance is a reviewable suggestion. |
| Correct a payment method | 3 | 3 | Original and replacement stay visible. |
| Close a balanced session | 2 | 2 | Ready card → confirm restores two taps; the footer stays Buy-in and financial checks remain. |
| Create another session | 3 | 2 | Phone header + New or the closed desktop’s single navigation action opens creation directly. |
| Reuse an existing player | 2 | 2 | Reuses the stable player identity. |
| Return to another recent session | 2 | 2 | Title plus choice replaces the duplicate switcher row. |
| Open player report and apply a filter | 4 | 4 | Filter application remains explicit. |
| Enable and copy viewer link | 4 | 4 | Rotation/disable need separate confirmation. |
| Footer buy-in, explicitly choose player and Venmo | Not measured | 4 | The extra player choice prevents wrong-player money. |

A visible session tab formerly switched in one tap; the current title-plus-choice uses two to remove a competing navigation row. Footer buy-in takes three controls with the remembered method, four when choosing Venmo. Close is two through the ready card when eligible; Menu remains a three-control fallback, and reopen remains three with its required reason.

## Safeguards and proof

Financial suggestions only prefill a reviewable form; they never write automatically. Cash-out stays blank with an explicit zero shortcut because buy-ins cannot determine chips returned. Field errors focus and retain input. Destructive changes, exact discrepancy consent, duplicate-name checks, immutable submitted bodies and account/outbox/draft guards are retained.

Saved feedback names the player, action and amount. Undo offers eight seconds of available time, paused during touch, hover, focus, sheets and busy Undo; resuming keeps its remaining budget. It only reverses the latest owned receipt and generated payment atomically. It preserves recorded timing and offers Correct times. If no confirmed buy-in remains but a timer runs, a lasting Timer started … · Correct times line survives reload until a timing correction or new buy-in.

Executed captures show four complete rows at 393×659 and six at 393×852 in both themes, keyboard-bound Save/fields, and a wide 1440×1000 desktop. Final [phone captures](../evidence/verify/20261112T155941765Z-faf1cebe/iphone-standalone/recipe-1794499269682-ecbf27/followups/) and [desktop captures](../evidence/verify/20261112T160347750Z-0a3dfd0a/desktop-webkit/recipe-1794499556949-afa95e/followups/) retain ready-close, duplicate-New removal, toast clearance and the lasting timer cue. Earlier complete layout/feature proofs remain in `evidence/verify/20261112T130200912Z-14f6b34d` and `20261112T130627916Z-add7b2ee`.

The [verification feature map](../.claude/skills/verify-poker-banker/features/README.md) gives the shared capture recipes. Emulation does not prove actual Home Screen installation, software keyboard, iOS suspension, eviction or physical safe-area clearance; see [TESTING](TESTING.md). Existing reference research is incorporated here; the offline Pookie Budget footer reference informed the single-bar structure, without copying its decoration.
