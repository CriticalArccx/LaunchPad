# LaunchPad - product context for Claude Code

Workflow rules (Jira, Git, Definition of Done, commands) come from the
arclab-workflow plugin (see `.claude/settings.json`).
This file holds only what is specific to this product. Do not repeat plugin rules here.

## Product
- Product: launchpad. Module label: launchpad. Jira space: ARC. Jira versions: launchpad-<semver>.
- What it does and who uses it: README.md, section 1.
- Stack: static HTML/JS site (no build step) on Vercel + Supabase + GitHub Actions sync jobs.
  Production deploys from `main`; every branch gets a Vercel preview.

## Architecture
- Read README.md, docs/adr/, DASHBOARD-README.md and dashboardedit.md before proposing changes.
- Systems of record: CxAlloy (Cx work), Ajera (people, projects, financials),
  each project's Google Sheet + Apps Script (equipment, checklists, dashboard data),
  Supabase (LaunchPad operational data). Never create parallel ownership.
- Append-only: no hard deletes, no overwrites of historical rows. Archive or supersede.
- Keep cx_status and scheduling_status distinct.
- Match approved designs in docs/design/; flag any deviation in the PR.
- Feature Requests from Canny are created by the product owner, not by Claude.

## Data safety
- There is only one Supabase project, and it is production. Local runs and Vercel previews
  read and write real data. Never write test rows, click save/submit/delete with fake data,
  or run `take_checklist_snapshot()` or the sync workflows by hand. If write testing is
  needed, stop and ask.
- Never put secrets in browser code. The browser uses only the public anon key;
  `SUPABASE_SERVICE_KEY` lives only in GitHub Actions secrets.
- This repo is public: no client data, SSI, or credentials in code, commits, PRs, or Jira.

## Checks for /ship
- There are no automated tests or linters. Instead: serve the site locally
  (`npx serve .`), load at least two projects, and confirm the browser console has no errors.
  Report what you checked in the PR.
