# LaunchPad

## 1. What it does and who uses it

LaunchPad is CriticalArc's commissioning project portal. Each project gets its own view of
schedule, equipment status, tamper seals, pull plans, and a commissioning dashboard, built
from that project's Google Sheet and LaunchPad's own Supabase data.

| Page | File |
|---|---|
| LaunchPad (schedule, dashboard tab, settings) | `index.html`, `dashboard.js`, `settings.js` |
| Pull Plan Scheduler | `bridge.html`, `bridge-view.js` |
| Equipment Status Tracker | `equipment-tracker.html`, `equipment-tracker-view.js` |
| Asset Tamper Seal Log | `tamperseal.html`, `tamperseal-view.js` |
| Tamper Seal Request | `seal-form.html`, `seal-form-view.js` |
| Power Flow Diagram (tab in LaunchPad, off until enabled in Settings; data in `sync/power_flow.sql`) | `powerflow-view.js` |

## 2. Stack

Static HTML and JavaScript with no build step, hosted on Vercel. Data lives in Supabase
(one production project). GitHub Actions in `.github/workflows/` sync and back up data on a
schedule; their logic is in `sync/`.

Database changes are SQL files in `sync/`, run by hand in the Supabase SQL editor.
`sync/editor_policies.sql` sets who can add or change each project's editors; re-run it
after creating a new project's tables.

## 3. Data flow

Google Sheet (per project) → Apps Script → GitHub Action (`sync/sync-equipment-data.mjs`)
→ Supabase → browser. See [DASHBOARD-README.md](DASHBOARD-README.md) for the dashboard's
tables and fields.

Dropdown options (every project, one table): `launchpad_dropdown_options`, from
`sync/dropdown_options.sql`, read and written through `dropdown-options.js`. Assets come
from each Sheet's Equipment tab via Apps Script `getAssetList` and
`sync/sync-dropdown-options.mjs`, at the project's Status Refresh Schedule times. Assets
added in LaunchPad are kept alongside them. Projects move over one at a time: each keeps
its old `{prefix}dropdownoptions` table until an admin switches it in Settings → Dropdown
Management. See
[ADR 0002](docs/adr/0002-shared-dropdown-options.md).

New projects: the platform owner creates them from "+ Add new project" in the project
picker or the Switch Project menu (`project-setup.js`, `sync/new_project.sql`). The new
project's tables copy the structure of an existing project's, and chosen settings can be
copied from any project, then or later from Settings → Copy Settings. See
[ADR 0003](docs/adr/0003-create-projects-in-launchpad.md).

Deleted Schedule lines are kept: each BackEndData row has a `line_status` (`live`,
`deleted`, `moved`, `restored`), and a delete keeps the line under a new id so its row is
free again. The app only sees live lines. Schedule → Deleted lines restores one
(`schedule-deleted-lines.js`, `sync/schedule_line_status.sql`). See
[ADR 0004](docs/adr/0004-keep-deleted-schedule-lines.md).

Tamper seal requests reach the CCM in one email a day. The seal form adds a row to
`launchpad_seal_notifications` (`sync/seal_digest.sql`), and `apps-script/SealDigest.gs` in the
project's Apps Script sends the digest to the recipients and at the time set in Tamper Seal
Settings → Notifications. See [ADR 0005](docs/adr/0005-daily-ccm-seal-digest.md).

Schedule → Google Calendar (Sandbox/CASB pilot): `apps-script/CalendarSync.gs`, added to the
project's Apps Script, reads the Schedule from Supabase every 10 minutes and keeps a shared
calendar in step, one way. Setup steps are at the top of that file; see
[ADR 0001](docs/adr/0001-schedule-to-google-calendar.md).

## 4. Run locally

```sh
npx serve .        # or: python -m http.server 8000
```

`env.js` picks the database. The live site uses production. Local runs and Vercel previews of
other branches use the **test** Supabase project once its URL and anon key are filled in
`env.js`; pages on it show a "TEST DATA" badge, and anything can be saved there. Until then
they use production: read-only testing only; see [dashboardedit.md](dashboardedit.md).
See [ADR 0006](docs/adr/0006-test-environment.md).

Setting up the test project (once, and again with `--reset` to bring its structure up to date):

1. Create a second Supabase project for test data.
2. Install the PostgreSQL client tools (`pg_dump`, `psql`, 17 or newer).
3. Put both connection strings (Supabase → Connect → Session pooler) in environment
   variables, `LP_PROD_DB_URL` and `LP_TEST_DB_URL`, and run
   `node test-env/setup-test-db.mjs --template <prefix of a production project> --owner <your email>`.
   It copies production's table structure (no rows) and adds a fake Demo project.
4. In the test project's Authentication, add your user and the redirect URLs the script
   prints, then put its URL and anon key in `env.js` under `TEST`.

After running a new `sync/*.sql` file on production, run it on the test project too.

## 5. Deploy

Merging to `main` deploys production on Vercel. Every branch gets a preview deployment.

## 6. Configuration and secrets

| Name | Where | Used by |
|---|---|---|
| Supabase URL + anon key, production and test | `env.js` (public by design) | Browser |
| `LP_PROD_DB_URL`, `LP_TEST_DB_URL` | Your own environment only, never in the repo | `test-env/setup-test-db.mjs` |
| `SUPABASE_SERVICE_KEY` | GitHub Actions secret | `sync/` jobs only |
| `ANTHROPIC_API_KEY` | GitHub org secret | Claude docs check on PRs |

## 7. Workflow and versioning

Work is tracked in Jira space ARC with the `launchpad` label. Branches are
`ARC-<number>-short-description`, PR titles are Conventional Commits with the key
(`feat(ARC-142): add forecast snapshot`), and PRs are squash-merged. Claude Code's
`/breakdown`, `/start`, `/ship`, and `/release` come from the arclab-workflow plugin.

| Bump | When | Example |
|---|---|---|
| Major | Breaking change to a data contract, schema, or API another product reads | 1.x to 2.0.0 |
| Minor | New feature or module | 1.3.0 to 1.4.0 |
| Patch | Bug fix, copy change, small UI fix | 1.4.0 to 1.4.1 |

release-please opens the release PR and writes `CHANGELOG.md`; the Jira version is
`launchpad-<version>`.

## 8. Feedback owner

Canny owner for LaunchPad: Quinn Harder (triages posts, creates Feature Requests by hand,
closes posts at release).

## 9. User guides

| Guide | Scribe link | Last updated version |
|---|---|---|
| _none yet_ | | |
