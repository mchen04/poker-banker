---
name: verify-poker-banker
description: Drive Justin's poker banker web PWA through its real phone and desktop UI, check stored results, and retain evidence after cleanup. Use after changes or when a banker journey needs proof.
---

# Verify poker banker

Read [features/README.md](features/README.md), then the feature being checked. The primary surface is the browser UI. Read-only public API requests independently confirm saved data. Work only in this run's uniquely named test banker and its sessions.

For reproducible local performance baselines and matched experiments after functional verification, read [performance verification](features/performance.md). It uses the existing benchmark harness with its own isolated fixtures and cleanup; run it serially through the mini capacity runner.

## Launch

From the repository root, run:

```sh
.claude/skills/verify-poker-banker/scripts/verify.sh launch --local
```

Keep the returned run ID. Local launch builds production assets, starts a fresh embedded Postgres with migrations and the same local Hono server used by `pnpm start:local`, and starts an owned headless WebKit browser. Ready means the helper has signed up its own banker, acknowledged the recovery codes and loaded Table. Ready requires the active Table navigation plus the selected Switch session control or the empty table’s Create your first session action. A listening port alone is insufficient.

For a deployed URL, explicitly select live mode:

```sh
: "${PB_BASE_URL:?Set the intended deployed HTTPS URL explicitly}"
.claude/skills/verify-poker-banker/scripts/verify.sh launch --live
```

Set `PB_BASE_URL` to the intended deployment before that command. When invoking live launch through the mini runner, explicitly pass the target with `./scripts/mini.sh env PB_BASE_URL="$PB_BASE_URL" .claude/skills/verify-poker-banker/scripts/verify.sh launch --live`; SSH does not inherit this Mac's variable. This creates a new test banker through the public signup UI. It never signs in to an existing account. Live mode does not create a database, deploy code, load environment files or delete remote data. Do not execute live mode unless creating this disposable account is authorized for that target.

The checked browser binaries and Node 22 are on the mini. From this Mac, prefix each helper command with `./scripts/mini.sh`, for example:

```sh
./scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh launch --local
./scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh doctor --run RUN_ID
./scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh drive ledger --run RUN_ID --context iphone-webkit
./scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh evidence --run RUN_ID
./scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh cleanup --run RUN_ID
```

The runner checks capacity, synchronizes this checkout and copies evidence back. Alternatively, use `ssh mini`, then run `cd ~/worktrees/poker-banker` and `export PATH="$HOME/tools/node22/bin:$PATH"` before the direct commands. Local execution proves the owned setup; only evidence from an explicitly executed live run proves its target.

Only one local verification or build may run per checkout. Local servers share `dist/`; a concurrent build can invalidate another run. The helper refuses a second active local launch. Serialize Playwright builds, benchmark builds and update recipes too. Live targets do not use local `dist/`.

Every later command takes `--run RUN_ID`. Run IDs keep ports, data directories, browser profiles and evidence separate; the production build directory is shared. Use the actual ID printed by launch in place of `RUN_ID` below. Cleanup is required after successful and failed attempts.

## Doctor

```sh
.claude/skills/verify-poker-banker/scripts/verify.sh doctor --run RUN_ID
```

Require success before driving. This check returns the owned page to Table without dismissing an open sheet, then verifies the owned process, build identity, local port ownership when applicable, authenticated banker ID and usable Table. It must report the intended base URL and banker. On a mismatch, stop driving and clean up that run. Do not reuse another run or the user's browser.

## Drive

The owned contexts are `iphone-webkit`, `iphone-standalone` and `desktop-webkit`. The first uses iPhone 15 touch settings. Standalone adds display-mode and `navigator.standalone` emulation. Desktop uses WebKit at desktop size.

Run the complete ledger recipe once per desired context:

```sh
.claude/skills/verify-poker-banker/scripts/verify.sh drive ledger --run RUN_ID --context iphone-webkit
.claude/skills/verify-poker-banker/scripts/verify.sh drive ledger --run RUN_ID --context iphone-standalone
.claude/skills/verify-poker-banker/scripts/verify.sh drive ledger --run RUN_ID --context desktop-webkit
```

For local automatic-update verification, follow the pinned previous-source setup in [offline and app updates](features/offline-and-app-updates.md), launch with its fixture metadata, then run `drive updates --run RUN_ID --context iphone-standalone`. It uses the same shared five-case journey plus seven update-review cases as the focused browser test. Run it last because it changes the shared build; cleanup preserves its release table and compatibility evidence.

The other feature files contain copyable Playwright recipes. Save each supplied block at its named `.cache/verify-*.ts` path, then invoke it through the same run:

```sh
.claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-sessions.ts --run RUN_ID --context iphone-webkit
```

The mini runner deliberately excludes `.cache/`. After writing a recipe on this Mac, copy only that new file explicitly before running it, for example:

```sh
rsync -az .cache/verify-sessions.ts mini:worktrees/poker-banker/.cache/verify-sessions.ts
./scripts/mini.sh .claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-sessions.ts --run RUN_ID --context iphone-webkit
```

Alternatively write the shown recipe inside the mini checkout. Do not synchronize other cache content.

A recipe exports an async default function receiving `RecipeContext` from `.claude/skills/verify-poker-banker/scripts/control.ts`. Its `page` is already signed into this run's banker. `step(name)` captures the primary page's action/result evidence. `checkState()` reads the selected session through the public API. Use `expect`, ARIA names and repository test IDs. Navigate through `workspaceReady`, `openNewSession` and `switchSession` from `e2e/helpers.ts`; session choices live in the History dialog opened by Switch session. Do not set application state, edit IndexedDB or call test-only endpoints to manufacture a pass. Fresh contexts created by a recipe must be closed in `finally`.

Run each feature from its declared prerequisites. A missing fixture fails the recipe and belongs in its Gotchas. A convenient path does not prove the other listed entry points. These files are maintained recipes, not a claim that every feature was executed this round.

## Evidence

```sh
.claude/skills/verify-poker-banker/scripts/verify.sh evidence --run RUN_ID
```

Evidence stays under the returned `evidence/verify/<timestamp-ID>/` directory, which is gitignored. Retain screenshots, ARIA snapshots, action/result logs, build and context identity, and read-only saved-state checks. Each command gets its own directory under the run and context; use the CLI-returned path or manifest instead of assuming a fixed ledger filename. The evidence command produces the manifest and hashes. Capture the action and result, not only a final screen. A Saved message needs a matching stored entry and amount. Record each feature ID and entry point used; report missing or unexecuted paths explicitly.

The local stand-in adds a generated loopback TLS certificate, embedded Postgres and a local production server. These steps do not prove a deployed Vercel/Neon configuration. Browser emulation does not prove real Home Screen installation, real iOS suspension or a real keyboard. Read [docs/TESTING.md](../../../docs/TESTING.md) from the repository root for those limits.

## Cleanup

```sh
.claude/skills/verify-poker-banker/scripts/verify.sh cleanup --run RUN_ID
find evidence/verify -name '*cleanup*' -type f
```

Cleanup verifies ownership and stops only the daemon, browser, application server and embedded database started by that run. It removes its scratch state and preserves evidence, including the cleanup receipt. It never kills by process name, touches the user's apps or deletes remote accounts. After cleanup, confirm the reported evidence directory still contains its manifest, screenshots and receipt. Run cleanup after every failed iteration too.

## Helpers

The executable entry point is `.claude/skills/verify-poker-banker/scripts/verify.sh`; `scripts/control.ts` and `scripts/ledger.ts` in that same skill directory implement the owned harness and supply the recipe invoked by `drive ledger`. Launch, doctor, ledger drive, recipe, evidence and cleanup invocations are shown above. Do not start the TypeScript daemon manually or inspect authentication state. Authentication stays in daemon memory; run metadata contains only ownership and artifact paths.

Use `/maintain-verification-skill` when user paths or selectors change so the feature map remains accurate.
