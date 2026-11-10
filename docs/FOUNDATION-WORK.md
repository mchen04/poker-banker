# Foundation work

Build Justin's saved poker bank with exact ledger arithmetic, isolated accounts, recovery, and a complete HTTP API.

## Playbook

1. `how` over the affected subsystem. Greenfield repository, grounded in the binding architecture.
2. `architect` for parallel design exploration. Architecture is approved and binding. Use its data model and module boundaries.
3. Write the throughput checkpoint as four todo items.
4. Delegate code-writing to a subagent using your configured feature model. Mini runner is a disjoint delegated file; the main implementation lane owns the coupled domain/database/API.
5. Verify on the matching surface.
6. Rebase into small, ordered commits. Stack follow-ups.
7. If the design is contested, `interrogate` before shipping. No contested design at start.
8. Run Opening a PR. Skip, user forbids PRs and pushes.

## Throughput checkpoint

- Blocking first steps. Read the approved model and establish mini access and capacity before checks.
- Independent workstreams. Mini runner is separate from the domain, migrations and API.
- Shared mutable state. Session writes lock one row; idempotency claims serialize one banker/key. Shared repo edits use disjoint files.
- Smallest safe decomposition. Keep the coupled database/API model with one owner to preserve transaction invariants.

## Verifiable units

- Scaffold and pure domain, checked by typecheck, build and domain tests.
- Migrations and local Postgres helpers, checked on a real empty database and rerun.
- Accounts and full HTTP API, checked by real database journeys.
- Concurrency, isolation, lifecycle and runner evidence, checked by the full mini suite.

## Completion

All verifiable units are complete. Mini typecheck passed and the full mini suite passed 54 tests in 4 files with real embedded Postgres. Node 22 build produced `dist/`. Local HTTP smoke checks verified the static shell, missing asset 404, and unauthenticated JSON API errors. Runner probes verified capacity rejection and artifact return after failure. See `REPORT.md` and ignored `test-results/` for receipts.

Review separation covered the complete implementation and comment scan. No application comments, docstrings or suppressions required removal. The unavailable deslop leaf was replaced by direct diff review. No architecture decision changed. PR and deployment steps remain skipped under the user's explicit limits.
