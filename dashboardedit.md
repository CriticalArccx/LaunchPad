# Dashboard Edit Workflow — LaunchPad

Context for Claude sessions working on the LaunchPad dashboard in this repo. For the full file map, functions to review, and nomenclature, see [DASHBOARD-README.md](DASHBOARD-README.md).

## Ownership & scope
- The repo (`https://github.com/cbaldwin-oss/LaunchPad`) belongs to a coworker and is hosted on Vercel. **Production deploys from `main`.**
- I (Kennedy) am only editing the **dashboard portion**: mainly `dashboard.js`, plus small hooks in `index.html` when needed.
- Do not change other files unless I explicitly ask. That includes:
  - `bridge*`, `equipment-tracker*`, `tamperseal*`, `seal-form*`
  - `settings.js`, `wrangler.jsonc`
  - `sync/`, `.github/workflows/`

## Start from the current code
The local `main` can fall far behind GitHub; it was once 119 commits behind. Always work from `origin/main`, never from the local `main`:

```powershell
git fetch origin
git branch --show-current          # must be dashboard-edits
git merge origin/main              # bring the branch up to date before editing
```

## Where the dashboard's data comes from
```
Google Sheet (per project) → Apps Script (launchpad_projects.google_script_url, ?action=getDashboardData)
  → GitHub Action every 15 min (.github/workflows/sync-equipment-tracker-data.yml → sync/sync-equipment-data.mjs)
  → Supabase table launchpad_dashboard_data
  → dashboard.js loadProject()
```

- **`launchpad_dashboard_data`** has one row per project:
  - `project_key` (text, primary key), which matches `LP_CONFIG.projectKey`.
  - `data` (jsonb), one object holding the arrays `issues`, `checklists`, `tests`, `equipment` and `companies`, plus `project_name` and `data_synced_at`.
  - `synced_at` (timestamptz), when the sync job last wrote the row.
- The dashboard reads **one row**, for the selected project, and does all filtering and counting in the browser. There's no paging and no joins.
- The values inside `data` (statuses, `level`, `aging_category`, `days_open`, `building_phase`, `floor_parsed`) are computed by each project's **Apps Script (`buildDashboardJson_`)**, which is **not in this repo**. If a value is wrong at the source, the fix belongs in the Apps Script or the Sheet, not in `dashboard.js`.
- **`launchpad_checklist_snapshots`** holds weekly checklist counts for the Path to Completion history line. It is written only by the pg_cron job `weekly-checklist-snapshot` (Fridays 11 PM Central), which is defined in `dashboard-snapshots.sql`.
- The Path to Completion target date is stored per browser in `localStorage['ca_pace_target_<projectKey>']`.
- The dashboard's title can be overridden by an admin through Dashboard Settings. The override is stored in `launchpad_projects.dashboard_display_name` and read as `LP_CONFIG.dashboardDisplayName`.

## Hard rules: do not break the live site
1. **Never commit to, push to, merge into, or rebase `main`.** All work happens on the `dashboard-edits` branch (or another feature branch).
2. **Never force-push** and never rewrite shared history.
3. Before any git write, run `git branch --show-current` and confirm it is **not** `main`.
4. Keep `index.html` changes minimal and additive. The coworker actively edits that file, so large rewrites will cause merge conflicts.
5. Don't rename or remove existing globals, functions, or element IDs that other pages or scripts rely on. For the dashboard these are:
   - `window.caDashboardInstance`, `ensureDashboardMounted()`
   - `setDarkMode()`, `renderAll()`, `STATE.data.project_name` (called by `index.html`)
   - `#launchpad-dashboard-container`
6. `dashboard.js` is lazy-loaded as an **ES module** by `ensureDashboardMounted()` in `index.html`. It can't see top-level `const`s from classic `<script>` tags, so it shares values through `window.*`:
   - `window.launchpadSupabaseClient`, the Supabase client. Don't create a second one.
   - `window.LP_CONFIG`, the selected project (`projectKey`, `clientName`, `dashboardDisplayName`, ...).
7. Keep the data shape in step with the Apps Script output. `dashboard.js` expects the five arrays above and replaces any missing one with `[]`. If a new field is needed, it has to be added to `buildDashboardJson_` first.
8. Never put secrets in browser code. That covers `SUPABASE_SERVICE_KEY` (a GitHub Actions secret used only by the sync job) and any CxAlloy or Apps Script credentials. The browser only uses the public anon key.

## Database: read-only testing only
- `index.html` connects to the **live production Supabase** project. Local runs and Vercel preview deployments hit the **same real data**.
- **Branches isolate code, not data.** Don't write test code that inserts, updates, or deletes rows. Don't click save/submit/delete buttons with fake data during testing. On the dashboard, that includes **Dashboard Settings → Save**, which writes to `launchpad_projects`.
- Never write to `launchpad_dashboard_data` from the browser or by hand. Only the sync job writes it, and it overwrites the row on its next run anyway.
- Don't run `take_checklist_snapshot()` by hand. It rewrites that day's snapshot for **every** project.
- Don't trigger the "Sync Equipment Tracker & Dashboard Data" workflow without asking. It's the coworker's job and also refreshes the Equipment Tracker.
- If write testing is needed, stop and ask. The right fix is a separate Supabase dev project whose URL/key are used only on the edit branch.

## Local testing
It's a static site with no build step, and it must be served over http because `file://` breaks module imports and `fetch()`. From the repo root:

```powershell
npx serve .
# or
python -m http.server 8000
```

Open `http://localhost:3000` (or `:8000`), log in, pick a project, and open the Dashboard tab. Keep the browser DevTools console open and watch for errors:
- "Dashboard response is missing expected array field(s)" means that project's Apps Script isn't returning dashboard data. Check its `getDashboardData` action. `dashboard.js` isn't the cause.
- Test at least two different projects. Each project's Sheet can use different status and level names.

Hard-refresh (Ctrl+F5) after edits to avoid stale cached JS.

## Pushing edits
1. Confirm you're on the branch: `git branch --show-current` → `dashboard-edits`
2. Commit:
   ```powershell
   git add dashboard.js index.html
   git commit -m "Describe the dashboard change"
   ```
3. Push the branch (never `main`):
   ```powershell
   git push -u origin dashboard-edits
   ```
4. Vercel automatically builds a **Preview Deployment** for the branch, with a separate URL shown in Vercel or on the GitHub commit/PR. Test there. Production is unaffected.
   - If I don't have push access, fork the repo, push to the fork, and import the fork into my own Vercel account.
5. To stay current with the coworker's changes: `git fetch origin` then `git merge origin/main` **into the branch**. Resolve conflicts on the branch, never on `main`.
6. When the dashboard is ready, open a **Pull Request** `dashboard-edits → main` on GitHub. The coworker reviews and merges it. Claude should not merge it.
