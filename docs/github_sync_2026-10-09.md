# GitHub sync: October 9, 2026

The remote `main` was at `9578c9f` (July 25, 2026). This sync preserves the
12 existing local commits and commits the current dashboard, ATM/skew collectors,
options-surface work, tests, deployment templates, and documentation.

## Reproducibility fixes

- Include all `frontend/src/lib/` application helpers; the broad Python `lib/`
  ignore rule previously hid them from Git.
- Store the frozen October 7 Deribit book summary in `project/tests/fixtures/`
  and make the surface validation test load it from there.
- Ignore local root-level `runtime/` captures, including screenshots and
  downloaded reference bundles. Existing committed frozen diagnostics remain.
- Ignore SQLite WAL and shared-memory sidecars alongside the database itself.
- Document the frontend's actual Node requirements and use `npm ci` for setup.

History databases, checkpoints, collected quote archives, environments, local
credentials, installed dependencies, and built frontend assets remain local.
New installs must restore the data separately or initialize it with backfill.

## Validation

- Backend suite: 417 passed, 1 skipped.
- Relocated frozen-market fixture: all 20 surface validation gate tests passed.
- Production frontend build passed, including a fresh `npm ci` and build from
  an export of the staged Git files.
- Term curve, listed-expiry retention, regime inspection, and smile alignment
  checks passed in that clean export.
- Staged whitespace checks passed. A pattern scan found no apparent private
  keys, GitHub tokens, AWS access keys, or credential assignments in the staged
  files. This is a targeted check, not an exhaustive secret audit.

Full frontend lint remains failing with 17 errors and one warning in the
existing source: component/helper export rules, ref access during render,
unused variables/assignments, `prefer-const`, and the TanStack Virtual React
Compiler compatibility warning. The production build also reports the existing
large JavaScript chunk warning. These are recorded rather than obscured by this
source sync.

## Continuous collection

See [Continuous worker hosting](continuous_worker_hosting.md) and the ATM/skew
systemd templates in `deploy/`. These are deployment instructions and templates;
they have not been installed or exercised on a Linux host. No runner or remote
server was provisioned, and no new deployment workflow was enabled by this sync.
