---
title: Justin's home poker banker
project: Poker app specification
status: approved
next: Apply Justin's feedback to the existing build and verify it.
pictures: Justin's attached report screenshot is retained as reference evidence; this specification is not proof of implementation.
---

A compact poker banking app with saved accounts, reusable players, and separate game sessions. The banker controls entries; a private link lets viewers see everyone's amounts without logging in. Michael approved this specification and authorized execution on November 10, 2026.

## Accounts, players, and history

Approved account rule: bankers use username and password to save games, their player list, and history. Anyone can create a banker account; viewing a shared game never requires one. Keep permissions simple, with a banker and read-only viewers, not configurable roles.

Store passwords securely, protect sign-in, support recovery, and isolate each account's records. A saved player is a roster entry, not a required user account. Identify players by stable records rather than names alone.

Each banker keeps a reusable player list. Adding a player to a session offers "Add existing player" or "Create new player" in the same compact flow. Search existing names first to discourage accidental duplicates. Renaming a player preserves their history.

Show each player's past sessions and running profit or loss within that banker's records. Sum finalized results only, keep currencies separate, and show outstanding payments separately. Viewing one shared game does not expose the banker's entire account history.

## One compact screen with session tabs

One-page means one consistent workspace, not one endless ledger. Use session tabs labeled by date and name, with a compact history picker as the list grows. Allow multiple games on one day. Switching sessions must not lose drafts or mix transactions.

Within a session, show compact game settings, shared totals, the player ledger, and recent activity. Everyone sees everyone's buy-ins, rebuys, cash-outs, payment status, and final results. Only the banker can edit.

Keep frequent controls near the phone's bottom edge. Use inline editors or small sheets for actions. Prioritize the real sequence: choose session, add existing or new player, record money, confirm the saved entry, cash out, reconcile, close. Allow readable vertical scrolling, not horizontal tables or tiny text.

## Visual design and iOS PWA

Research real interface references after approval and remove generic AI-looking design habits. Use consistent typography, spacing, colors, and restrained accents. Status must be readable without color. Optimize hierarchy, tap targets, focus, keyboard behavior, and clear feedback around user intent.

The app works in desktop browsers, iPhone Safari, and an installed iOS PWA. Live records update across viewers. Application updates must preserve authentication, drafts, active sessions, and saved data. Test updates while the app is installed, suspended, and reopened.

Study Pancake's PWA implementation as a reference for verified patterns, not an assumption that copying it proves this app works.

## Banking rules and verification

The approved model is a central banker recording money received and paid, without moving money. Use exact minor units, one currency per session, duplicate prevention, and traceable corrections. Never infer live winnings from buy-ins alone.

Support early cash-out and re-entry. Final results equal confirmed cash-outs minus confirmed buy-ins. Close as balanced only when everyone has cashed out and totals match. Display discrepancies and unpaid amounts explicitly. Reopening a game updates its recap and cumulative results without double-counting.

Use Claude to orchestrate and Codex to implement under Michael mode and poteto mode, with an executed project-specific verification skill. Cover authentication, account isolation, guest permissions, reusable players, session switching, cumulative arithmetic, concurrent writes, corrections, recovery, migrations, and installed-PWA updates through real user journeys.

## Build, performance, and delivery

Build on the main computer. Use Agent Desktop with Google Chrome signed in as `michaelluochen@gmail.com` there to create and use a dedicated Neon database. Michael explicitly authorized that database and has now approved execution. Vercel hosting, migrations, deployment, and live checks are included in the approved scope.

Run repeatable website and database performance evaluations with realistic session history and concurrent viewers. Measure loading, interactions, live-update delay, and important queries. Set measurable goals before hill-climbing each bottleneck. Change one thing, measure repeatedly, and keep only improvements beyond noise with correctness intact. Report baseline, final results, errors, and retained or reverted attempts.

Aggressively remove dead and legacy code and redundant tests without removing meaningful regression coverage. Update all affected documentation. Rerun verification, commit, push, squash-merge, apply migrations in the correct deployment order, deploy, and verify live behavior.

## Justin's feedback — payment details, time, and results

Michael authorized incorporating Justin's response to the shared specification. In the banking view, marking a buy-in or rebuy paid includes a compact payment-method selector: Zelle, Venmo, or cash. Persist and show the selected method with that payment, and preserve changes in the correction history. A payment-method tag records how money was received; it does not initiate a payment. Do not conflate an unpaid buy-in with received cash.

Show a session timer with persisted start and end times, surviving refreshes, suspension, reconnection, and device changes. Finishing a session stops its elapsed time. Allow the banker to correct the recorded timing with a visible history rather than silently resetting it.

Provide result-display toggles for total money, money per hour, and big-blind equivalent. Label net profit/loss separately from gross cash-out and outstanding payments; changing a display unit must never change the underlying ledger. Hourly results require a valid elapsed duration. Big-blind results require a positive, recorded big blind in the session currency. Show unavailable values explicitly rather than zero or invented statistics. Preserve exact money arithmetic and round only for display.

Justin also requested the reporting functions shown in his Cash Game Report screenshot. Add reporting for a selected saved player across the banker's finalized sessions: total profit/loss, money per hour, average money per session, total playing duration, winning-session count and percentage, tips/meals expenses, big blinds per hour, and variation in hourly results in both currency and big blinds. Expose Overall, Location, Game, Weekday, and Month views with clear filters. Keep these within the compact existing workspace and preserve account/history privacy. A player's report must not sum all players' results into a meaningless table-wide profit figure.

Explicit implementation defaults, not facts established by the screenshot: label the ambiguous "Cashed" metric as winning sessions (strictly positive net results out of all finalized sessions, with breakeven included in the denominator). Record optional tips/meals separately from chip cash-outs and settlements; show their effect on reported net performance without changing the bank's reconciliation. Use tracked player participation intervals for individual hourly results, including leaving and re-entering; never silently use the whole table's duration for a late arrival. Aggregate hourly results using total recorded net result divided by total valid playing time rather than an unweighted average of rates. Compute each session's big-blind result using its own recorded blind size, keeping currencies separate. Show unavailable results where history lacks the necessary timing or blinds.

For standard deviation, use the sample standard deviation of valid finalized session-level hourly rates, clearly labeled as variation across session rates, with unavailable shown for fewer than two valid sessions. These are descriptive statistics, not a confidence interval or forecast. The screenshot says "Big Bet/Hour", but Justin explicitly requested big blinds: use unambiguous big-blind labels, not an unstated big-bet conversion. The screenshot's Tourney navigation does not add tournament management to this cash-game app.

Verification must cover payment-method persistence and corrections, unpaid-to-paid changes, timer resume and finalization, all display modes, missing/zero denominators, and consistency with the same ledger result. Add independently checkable analytics fixtures for win/loss/breakeven, fees, late arrival/re-entry, variable blinds, unequal durations, sample-size limits, all five groupings, filters, corrected sessions, and currency/account isolation. Never copy the screenshot's sample amounts into app records.

## Proof

This revision incorporates Michael's requests for username/password login, login-free viewers, reusable player lists, sessions for different days, running totals, strong UI integration, dead-code cleanup, performance hill-climbing, and Pancake as a PWA reference. The feedback addition is authorized by Michael's exact request: "read justins feedback to the spec we sent and add it to the spec adn respond to him" (Discord 1569860032567312415). Mikebot verified Justin's reply to the sent PDF in direct chat 19, message row 241091: "Yeah tuff\nWould add\n- on the banking tab, a button/toggle to select how the payment method was received when you select that the buyin was paid (zelle, venmo, cash)\n- timer to track the length of session\n- the payout metrics can be toggled to be lump sum, hourly, and in big blinds". Justin's next PDF-thread reply, row 241093, says "Basically all these functions in the app" and includes IMG_7014.heic. Root visually verified its PNG copy at /Users/michaelchen/.hermes/kanban/attachments/t_04f9a06c/justin-report-reference.png. It shows Profit/Loss, $/Hour, $/Session, Duration, Cashed, Tips/Meals, Big Bet/Hour, BB/Hour Std Dev., $/Hour Std Dev., Overall/Location/Game/Weekday/Month groupings, and Filter: Off. The product definitions above are explicit implementation defaults where the screenshot supplies no formula. Related work: feedback card t_04f9a06c and existing build t_d2a2ebc9.

Approval, verbatim: "yes apporve the spec and execute w a claude orchestrate codex on the main computer with michael mode and create verififcaiton skill and send the spec pdf to justin tan and say we are making it". Received in Discord #general, message 1569856243672023084. Claude Opus 5.5 medium orchestration and Codex gpt-6.1-sol high implementation follow the default role settings because Michael specified the families and route, not effort.

This document records approval, not completed work. No implementation, database creation, deployment, or performance results are claimed here. Send Justin only the shareable product specification, without account emails or internal operational records.

The earlier original-request evidence is `/Users/michaelchen/.hermes/kanban/attachments/t_68e0df66/eaters-coding-requests-2026-11-10.pdf`. Pancake's recorded checkout is `mbp-main ~/Projects/Apps/pancake`; it has not been inspected for this proposal. The benchmark and hill-climb requirements follow the loaded pstack playbook and benchmark-checklist. No performance figures or passing tests are claimed.
