# 0006: A separate test database for local runs and previews

Date: 2026-11-10   Status: Accepted

## Context

Every branch already gets a Vercel preview, so changes to the screens can be seen before
they go live. But every page had the production Supabase URL and anon key written into it
(`index.html`, `bridge-view.js`, `equipment-tracker-view.js`, `seal-form-view.js`,
`tamperseal-view.js`), so previews and local runs read and wrote the live data. Save,
submit and delete could not be tried before merging.

## Decision

- A second Supabase project holds test data only.
- `env.js`, loaded by every page before Supabase, picks the project from the address:
  - **Live site** (`sty4a-launch-pad.vercel.app`, the `main` branch alias, or any custom
    domain): production.
  - **Local runs** (localhost, LAN addresses) and **other Vercel previews**: test.

  The pages read `window.LAUNCHPAD_ENV` instead of their own copies of the URL and key.
  Test pages show a "TEST DATA" badge. Until the test project's URL and anon key are put
  in `env.js`, test pages keep using production, as before.
- `test-env/setup-test-db.mjs` copies production's table structure (the public schema,
  with no rows) into the test project. Then `test-env/seed.sql` adds a fake TEMPLATE
  project and a DEMO project, made with `lp_create_project` the same way the app makes
  projects. The script only reads production and stops if the test connection is
  production.

## Alternatives rejected

- **Read-only previews on production.** Safe, but save, submit and delete still couldn't
  be tested.
- **Copying production rows into the test project.** That would put client data in a
  second place. The test project starts empty.
- **Building the test schema from `sync/*.sql`.** Those files don't cover everything:
  some tables (`launchpad_projects` among them) were made by hand. A structure-only dump
  matches production exactly.
- **Choosing the project with a Vercel environment variable.** The site has no build step
  to put it into the pages.

## Consequences

- Live and test have to stay in step. After running a new `sync/*.sql` file on
  production, run it on the test project too, or re-run the setup script with `--reset`.
- The GitHub Actions sync jobs, Apps Script, and the daily seal digest only talk to
  production. In the test project, Sheet data, snapshots and emails don't happen.
- Test users sign in with accounts made in the test project's Authentication.
- The Forgot PIN email links back to the page it was sent from: the live site on
  production, the preview on test.

Jira: ARC-326
