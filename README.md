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

## 2. Stack

Static HTML and JavaScript with no build step, hosted on Vercel. Data lives in Supabase
(one production project). GitHub Actions in `.github/workflows/` sync and back up data on a
schedule; their logic is in `sync/`.

## 3. Data flow

Google Sheet (per project) → Apps Script → GitHub Action (`sync/sync-equipment-data.mjs`)
→ Supabase → browser. See [DASHBOARD-README.md](DASHBOARD-README.md) for the dashboard's
tables and fields.

## 4. Run locally

```sh
npx serve .        # or: python -m http.server 8000
```

Local runs and Vercel previews use the **production** Supabase data. Read-only testing only;
see [dashboardedit.md](dashboardedit.md).

## 5. Deploy

Merging to `main` deploys production on Vercel. Every branch gets a preview deployment.

## 6. Configuration and secrets

| Name | Where | Used by |
|---|---|---|
| Supabase URL + anon key | `index.html` (public by design) | Browser |
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
