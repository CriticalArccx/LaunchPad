# LaunchPad test environment (ARC-326)

Local runs and Vercel previews of branches other than `main` use a separate **test**
Supabase project, so save, submit and delete can be tried without touching live data. The
live site always uses production. Background: [ADR 0006](../docs/adr/0006-test-environment.md).

| File | What it does |
|---|---|
| `../env.js` | Chooses production or test by the page's address. The test URL and anon key go here. |
| `setup-test-db.ps1` | Windows wrapper. Asks for the connection strings and runs the script below. |
| `setup-test-db.mjs` | Copies production's table structure (no rows) into the test project, then runs `seed.sql`. Only reads production. |
| `seed.sql` | Adds the fake "Empty template" and "Demo project" projects, and makes you their admin. |

## One-time setup

1. **Create the test project.** In Supabase, choose New project (the free plan is fine),
   for example `launchpad-test`, in the same region as production. Save its database
   password in your password manager.

2. **Install the PostgreSQL client tools, version 17 or newer.** Use the EDB installer
   from postgresql.org/download/windows and tick only *Command Line Tools*. Or run:
   ```powershell
   winget install PostgreSQL.PostgreSQL.17
   ```
   The wrapper finds `C:\Program Files\PostgreSQL\17\bin` by itself.

3. **Copy both connection strings.** In each Supabase project, go to Connect →
   **Session pooler**. Copy the URI, then replace `[YOUR-PASSWORD]` with that project's
   database password. Don't save these anywhere in the repo.

4. **Build the test database** from the repo folder:
   ```powershell
   .\test-env\setup-test-db.ps1 -Template <prefix> -Owner cbaldwin@criticalarccx.com
   ```
   - `-Template` is the table prefix of a production project whose table layout is
     current. Only its structure is copied, never its rows.
   - The script asks for the production string first, then the test string.
   - It stops if the test string points at production, or if the test database already
     has real projects.
   - A few "did not load" lines about things Supabase already has are normal.

5. **Set up sign-in on the test project.**
   - Authentication → Users → Add user: your email, with a password. This is your test
     PIN, at least 6 digits.
   - Authentication → URL Configuration:
     - Site URL: `http://localhost:3000`
     - Redirect URLs: `http://localhost:*/**` and `https://sty4a-launch-pad-*.vercel.app/**`

6. **Point previews at it.** In the test project, go to Project Settings → API Keys and
   copy the Project URL and the **anon / public** key. Never use the service_role key.
   Paste them into `env.js` under `TEST`:
   ```js
   supabaseUrl: 'https://<test-ref>.supabase.co',
   supabaseKey: '<test anon key>',
   ```
   Commit that on a branch and merge it as usual.

7. **Check it works.**
   - Run `npx serve .` and open http://localhost:3000.
   - The **TEST DATA** badge should show in the bottom-left corner.
   - Sign in and pick **Demo project**.
   - Then open a branch's Vercel preview. It should show the badge too. The live site
     never shows it.

## Keeping it in step

- **After a new `sync/*.sql` file:** when you run one on production, run it in the test
  project's SQL editor too.
- **To recopy everything:** add `-Reset`. This wipes the test database and copies the
  structure again; anything saved in test is lost.
  ```powershell
  .\test-env\setup-test-db.ps1 -Template <prefix> -Owner cbaldwin@criticalarccx.com -Reset
  ```
- **What doesn't run on test:** sync jobs, Apps Script, snapshots and the seal digest only
  talk to production. Sheet-fed data and emails don't appear in test.
- **More test users:** add them in the test project's Authentication. Then add them to
  Demo project from LaunchPad's own user management on a test page.

macOS or Linux: set `LP_PROD_DB_URL` and `LP_TEST_DB_URL` yourself and run
`node test-env/setup-test-db.mjs --template <prefix> --owner <email>`.
