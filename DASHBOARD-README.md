# LaunchPad Dashboard: File Map, Review List & Nomenclature

This covers every file involved in the commissioning dashboard shown under LaunchPad's **Dashboard** tab. For each file it lists:

- whether the file is used,
- which functions need review, and why,
- the names, vocabularies and conventions the file declares.

For branch and deploy rules, see [dashboardedit.md](dashboardedit.md).

> **Basis:** commit `632288a` (2026-09-29). `dashboard-edits`, `origin/dashboard-edits` and `origin/main` all point at this commit, so the line links below match both the working tree and production.

---

## 1. Where the dashboard's data comes from

Each LaunchPad project has its own data, keyed by `project_key`. The dashboard reads two Supabase tables.

```
Google Sheet (per project)                                  ← maintained in Google, not in this repo
  → Apps Script  (launchpad_projects.google_script_url, ?action=getDashboardData → buildDashboardJson_)
  → GitHub Action every 15 min  (.github/workflows/sync-equipment-tracker-data.yml → sync/sync-equipment-data.mjs)
  → launchpad_dashboard_data          one row per project: data jsonb (current state), synced_at
       │
       ├─► dashboard.js loadProject()      → every tab
       │
       └─► pg_cron, Fridays 11 PM Central  (dashboard-snapshots.sql → take_checklist_snapshot())
             → launchpad_checklist_snapshots   weekly checklist counts per project/type/discipline/contractor/status
             → dashboard.js loadSnapshots()   → Path to Completion history line
```

- **`launchpad_dashboard_data`** has one row per project. The `data` object holds the arrays `issues`, `checklists`, `tests`, `equipment` and `companies`, plus `project_name` and `data_synced_at`. As of 2026-09-25 there were 8 rows: CASB, MNO1A, PHXA7, RNO04, RSE1A, SANNT1B, SLC1 and STY4.
- **`launchpad_checklist_snapshots`** exists because `launchpad_dashboard_data` only holds each checklist's *current* status. Without the snapshots, past weekly progress would be lost.
- **Browser-only state:** the Path to Completion target date is kept in `localStorage['ca_pace_target_<projectKey>']`. It's per viewer and per browser, not shared.
- **Not visible from this repo:** the Apps Script code (`doGet`, `getDashboardData`, `buildDashboardJson_`) and the Sheets. That's where `level`, `aging_category`, `days_open`, `building_phase`, `floor_parsed` and every status name come from. A wrong value at the source has to be fixed there, not in `dashboard.js`.

---

## 2. File inventory

| File | Status | Role |
|---|---|---|
| [dashboard.js](dashboard.js) | ✅ **Used** | The whole dashboard: the `CriticalArcDashboard` class, with its UI, theming, data load and Plotly charts |
| [index.html](index.html) | ✅ **Used** | Lazy-loads Plotly and `dashboard.js`; provides `window.launchpadSupabaseClient` and `window.LP_CONFIG`; Dashboard Settings (title override) |
| [dashboard-snapshots.sql](dashboard-snapshots.sql) | ✅ **Used** (run once in Supabase) | Creates `launchpad_checklist_snapshots`, `take_checklist_snapshot()`, and the pg_cron job `weekly-checklist-snapshot` |
| [.github/workflows/sync-equipment-tracker-data.yml](.github/workflows/sync-equipment-tracker-data.yml) | ✅ **Used** | Every-15-minute schedule, plus a manual run with an optional single `project_key` |
| [sync/sync-equipment-data.mjs](sync/sync-equipment-data.mjs) | ✅ **Used** | Calls each project's Apps Script and upserts the result into Supabase |
| [sync/schema.sql](sync/schema.sql) | ✅ Used (run once) | Creates `launchpad_dashboard_data` and `launchpad_equipment_tracker_data`, their RLS, and `launchpad_projects.dashboard_display_name` |
| `sync/add_draft_columns.sql`, `sync/move_schedule_row.sql`, `sync/unify_backend_schedule.sql` | — Not dashboard-related | Schedule tables |
| `tools/cxalloy_vocab.py`, `tools/sync_logic.py` | 🛠 Local only (untracked) | Read-only check of CxAlloy vocabularies. Useful for comparing status names, but it reads CxAlloy directly, not the Sheets. `sync_logic.py` is the signed-API helper copied out of the old `shared-dashboard/`. |

**Removed in the 2026-09-29 cleanup:** `dashboard.html` (old standalone copy), `HOSTING.md` (old static-JSON hosting), `.gitmodules` (stale `shared-dashboard` submodule entry), and all of `shared-dashboard/` (old CxAlloy → SQLite → JSON pipeline, including the committed PHXA7 client JSON). They are still in git history before that commit.

Not dashboard-related: `bridge*`, `equipment-tracker*`, `tamperseal*`, `seal-form*`, `settings.js`, `wrangler.jsonc`.

---

## 3. `dashboard.js`: functions to review & nomenclature

**Lifecycle:** `constructor` → `mount()` → `injectCSS()` → `injectHTML()` → `applyTheme()` → `bindEvents()` → `init()` → `waitForProjectConfig_()` → `loadProject()` → `loadSnapshots()` → `rebuildFilterOptions()` → `renderAll()` → `renderIssues` / `renderChecklists` (→ `renderPace`) / `renderTests` / `renderEquipment`.

### 3.1 Functions to review

Priorities: 🔴 likely bug · 🟡 hardcoded vocabulary or inconsistent logic · ⚪ cleanup.

| Pri | Function | Line | What to check |
|---|---|---|---|
| 🔴 | `applyFilters()` | [348](dashboard.js#L348) | The **Status** filter's options are *issue* statuses ([438](dashboard.js#L438)), but the filter is also applied to checklists, tests, equipment **and the Friday snapshots** ([949](dashboard.js#L949)). Checking "Open" empties the Checklists and Tests tabs and zeroes the Path to Completion chart. The **Contractor** filter uses `assigned_company`, which equipment rows may not have. |
| 🔴 | `table()`, `renderEqBody()` | [320](dashboard.js#L320), [1164](dashboard.js#L1164) | Sheet values (such as issue `description`) and the search text go into `innerHTML` without HTML escaping. `buildCheckGroup()` already has an `esc()` helper that could be reused. |
| 🟡 | `renderPace()` | [931](dashboard.js#L931) | The history line comes from snapshots while the "today" point comes from live rows, so they can disagree. The Building Phase filter doesn't apply to history (the caption says so). The scope is `type_name === 'Pre-Functional'` as an exact match ([798](dashboard.js#L798)); any other spelling falls back to *all* checklists. "Current Pace" needs at least 2 Fridays of snapshots. The target date lives only in this browser. |
| 🟡 | `loadSnapshots()` | [573](dashboard.js#L573) | Errors are swallowed and the chart just shows no history. If the table or cron job is missing, the only sign is a console warning. |
| 🟡 | `renderChecklists()` | [774](dashboard.js#L774) | `levelIsFlat` ([784](dashboard.js#L784)): if a project has only one `level` value, charts group by `type_name` instead. Check that this is what each project expects. Hardcoded color maps: `dcStatusColors`, `levelColors`, `discColors`, `discAbbr`. Unknown values get `autoColor()`. |
| 🟡 | `isComplete` / `isVerified` | [25-34](dashboard.js#L25-L34) | Completion is based on status names. If a project's Sheet uses a different word for complete or verified, it counts as not done. Keep these lists in step with every project's statuses. |
| 🟡 | `renderIssues()` | [619](dashboard.js#L619) | "Open" here is `status !== 'Closed'` ([623](dashboard.js#L623)), so `Void` counts as open. `renderEquipment()` uses `ISSUE_OPEN_STATUSES` instead ([1117](dashboard.js#L1117)), so the tabs can disagree. The KPIs use 30/60/90-day bands, while the table uses `aging_category` labels (`>60 Days`, `45-60 Days`, `Under 45 Days`). High priority is `priority.includes('High')`. |
| 🟡 | `renderTests()` | [1026](dashboard.js#L1026) | `TEST_PASS_STATUSES = ['Passed']` and `TEST_FAIL_STATUSES = ['Failed']` are still open (GOLD-DESIGN Q5). `unitOf()` ([1065](dashboard.js#L1065)) assumes asset names start with letters+digits. |
| 🟡 | `renderEquipment()` | [1110](dashboard.js#L1110) | KPI statuses are hardcoded: `Delivered`, `Installation in Progress`, `Released` ([1128-1130](dashboard.js#L1128-L1130)). |
| 🟡 | `loadProject()` | [502](dashboard.js#L502) | `synced_at` is selected but never used. "Data as of" reads `data.data_synced_at`, and if Apps Script doesn't set that field, the header falls back to the browser's clock ([608-611](dashboard.js#L608-L611)). |
| 🟡 | `weekKey()` / `renderBurndown()` | [342](dashboard.js#L342), [713](dashboard.js#L713) | Monday is computed in local time, then keyed in UTC (`toISOString`). In US time zones some weeks can drop out of the burndown. |
| ⚪ | refresh handler in `bindEvents()` | [380](dashboard.js#L380) | `REFRESH_ENDPOINT` is `null`, so "Refresh Data" only re-reads Supabase. New data only arrives with the next 15-minute sync. |

### 3.2 Nomenclature

**Instance state and config (constructor):**

| Name | Meaning |
|---|---|
| `STATE` | `{ project, data, snapshots, filters:{discipline,contractor,status,phase}, eqPhase, openIssues }`. `eqPhase` is a map from `equipment_id` to `building_phase`. |
| `EQ_FILTER`, `EQ_SEARCH` | Equipment tab's Building/Floor dropdowns, and its search text plus "Incomplete only" toggle |
| `ISS_THRESH` | Escalation slider's day threshold (default 30) |
| `COMPLETE_STATUSES` | `Finished`, `Checklist Complete`, `Verified`, `Verified - Not Included in Sampling`. The contractor is done. |
| `VERIFIED_STATUSES` | `Finished`, `Verified`, `Verified - Not Included in Sampling`. Cx has approved. |
| `isComplete(c)` / `isVerified(c)` | `c.is_verified === true`, or the status is in the matching list above |
| `TEST_PASS_STATUSES` / `TEST_FAIL_STATUSES` | `['Passed']` / `['Failed']` |
| `ISSUE_STATUS_ORDER` | `Open, In Progress, Pending Review, Closed`. Only orders the filter. |
| `ISSUE_OPEN_STATUSES` | `Open, In Progress, Pending Review` |
| `REFRESH_ENDPOINT` | Optional URL to POST to before a refresh (currently `null`) |
| `FONT`, `COND`, `C`, `CFG` | Fonts, colors and Plotly config. `C.green/red/yellow/blue` are status colors, fixed in both themes. |
| `darkMode`, `THEMES` | `localStorage['launchpad_dark_mode']`. Theme values fill the CSS variables `--bg`, `--panel`, `--border`, `--line`, `--text`, `--muted`, `--input-bg`, `--meta-text`, `--td-text`, `--td-border` and `--hover-row`. |
| `paceKey()` | `'ca_pace_target_' + projectKey`, the localStorage key for the target date |

**Supabase reads:**

| Table | Columns | Filter |
|---|---|---|
| `launchpad_dashboard_data` | `data, synced_at` | `project_key` (one row) |
| `launchpad_checklist_snapshots` | `snapshot_date, type_name, discipline, assigned_company, status, checklist_count` | `project_key`, sorted by `snapshot_date`, 1,000 rows per page |

**Data contract.** This is what `buildDashboardJson_` must return:

| Key | Fields read |
|---|---|
| `project_name` | Title, unless `LP_CONFIG.dashboardDisplayName` overrides it |
| `data_synced_at` | "Data as of" |
| `issues[]` | `name, description, status, priority, discipline, assigned_company, assigned_name, aging_category, days_open, date_created, in_progress_date, date_closed, asset_key` |
| `checklists[]` | `level, type_name, status, discipline, assigned_company, assigned_type, asset_key`, plus optional `is_verified` and `building_phase` |
| `tests[]` | `name, status, assigned_company, assigned_name, discipline, attempt_count, asset_name, asset_key` |
| `equipment[]` | `equipment_id, name, type, discipline, status, space, building_phase, floor_parsed` |
| `companies[]` | `name` |
| `error` | If present, the dashboard shows it as the load error |

If any array is missing, the dashboard fills it with `[]` and logs a console warning. That usually means `getDashboardData` isn't wired into `doGet`, or the Apps Script wasn't redeployed as a new version.

**Field conventions:**

- `asset_key` on checklists, tests and issues joins to `equipment_id` on equipment.
- `phaseOf(r)` returns the row's `building_phase`, else the linked equipment's phase, else `'Unknown'`.
- `isBad(v)` treats `null`, `''`, `'nan'`, `'none'` and `'0'` as empty.
- `orderVals(values, preferred)` puts known values first, then everything else sorted. Use it for any new list.
- Checklist level display order: `L2, L3, L4, FAT, Pre-Functional, Functional, Documentation Review, Closeout`. If `level` is flat, charts group by `type_name` (null becomes `Untyped`).
- Unassigned markers: `not assigned yet`, `not assigned`, `''`, `nan`, `none`. A checklist with `assigned_type === 'role'` counts as pending assignment.
- Status colors: `Checklist Complete` is light green `#8BD17C`, `Verified` / `Finished` is green `#39B54A`, and `Verified - Not Included in Sampling` is dark green `#1E7A34`.

**DOM and CSS naming:** every element ID and class is prefixed `ca-`. The Path to Completion elements are `ca-pace-date`, `ca-pace-kpis`, `ca-pace-chart` and `ca-pace-caption`. The style tag ID is `ca-dashboard-styles`. The tab keys are `issues`, `checklists`, `tests` and `equipment`.

---

## 4. `index.html`: dashboard hooks only

| Line | What |
|---|---|
| [1482](index.html#L1482) | Sidebar nav: `switchMainView('dashboard', this)` |
| [1655](index.html#L1655) | `#dashboard-view` → `#launchpad-dashboard-container` |
| `ensureDashboardMounted()` | Lazy-loads Plotly `2.35.2`, then `import('./dashboard.js')`, then `new CriticalArcDashboard(...)` and `.mount()`. It retries on the next tab switch if loading fails. |
| `toggleDarkMode()` | Calls `caDashboardInstance.setDarkMode(isDark)` |
| [4621](index.html#L4621) | `window.launchpadSupabaseClient = _supabase` is the client `dashboard.js` uses |
| `openDashboardSettingsModal()` / `saveDashboardSettings()` | Admin title override, saved to `launchpad_projects.dashboard_display_name` |
| `applyProjectConfig()` | Fills `LP_CONFIG` from `launchpad_projects` |

**Nomenclature:** `window.LP_CONFIG` is `{ projectKey, clientName, tablePrefix, googleScriptUrl, adminEmail, logoUrl, themeColor, startDate, durationWeeks, dashboardDisplayName }`. The other globals are `window.launchpadSupabaseClient`, `window.caDashboardInstance` and `_dashboardMountPromise`. `T(name)` is the per-project table prefix, which the dashboard tables **don't** use; they're shared tables keyed by `project_key`.

---

## 5. Supabase side

### 5.1 [sync/sync-equipment-data.mjs](sync/sync-equipment-data.mjs) and its workflow
| Function | What it does | Review note |
|---|---|---|
| `getProjectsToSync()` | Every `launchpad_projects` row with a non-empty `google_script_url` | Projects without a script URL get no dashboard |
| `fetchAppsScriptJson()` | 3 attempts, 3 s apart; treats non-JSON as a temporary error | — |
| `syncDashboard()` | `?action=getDashboardData` → upsert `launchpad_dashboard_data` | **Failures are only warnings**, so the Action stays green. Search the logs for `dashboard sync failed`. |
| `syncEquipmentTracker()` | Default `doGet` → `launchpad_equipment_tracker_data` | Failures fail the run |
| `main()` | Loops over the projects; respects `SYNC_ONLY_PROJECT` | One project at a time |

The workflow runs on cron `*/15 * * * *` and on manual dispatch, using the secret `SUPABASE_SERVICE_KEY`.

### 5.2 [dashboard-snapshots.sql](dashboard-snapshots.sql)
- **Table `launchpad_checklist_snapshots`:** primary key `(project_key, snapshot_date, type_name, discipline, assigned_company, status)`, plus `checklist_count` and `taken_at`. Blank values are stored as `''`.
- **Function `take_checklist_snapshot(p_date)`:** dated in America/Chicago time. It deletes and rewrites that date's rows for **all** projects from whatever is in `launchpad_dashboard_data` at that moment. If the 15-minute sync had been failing, that week's snapshot records stale data. Execute permission is revoked from `anon` and `authenticated`.
- **Cron job `weekly-checklist-snapshot`:** runs at `0 4 * * 6` UTC, which is Friday 11 PM CDT or 10 PM CST.
- **Review:** the dashboard reads snapshot history paged but not grouped. Snapshots add one row per combination of type, discipline, contractor and status each week, so the payload grows every week.

### 5.3 RLS
`launchpad_dashboard_data`, `launchpad_equipment_tracker_data` and `launchpad_checklist_snapshots` all use **"Allow anon read" with `using (true)`**. Anyone with the public anon key can read every project's data.

---

## 6. Open questions

1. **Who owns each project's Apps Script `buildDashboardJson_`?** Does it set `data_synced_at`? Where are `level` and `aging_category` defined?
2. **Vocabulary per project.** Do all Sheets use the complete, verified, test and equipment status names listed in §3.2? Anything else is miscounted.
3. **Test pass/fail (GOLD-DESIGN Q5).** Does `Partially Passed (Test to be Repeated)` count as a pass? Do `Voided` and `Deferred to 1B` leave the denominator?
4. **Possibly duplicated data.** As of the 2026-09-25 sync, MNO1A, RSE1A and SLC1 all have `tests: []` and start with the same issue `CHK-45375-1`. Do their `google_script_url` values point to the same Apps Script or Sheet? CASB's JSON is formatted differently, so its row may come from a different script version.
5. **RLS.** Is anon read of all projects intended for the three tables above?
6. **Pace target date.** Should it move from localStorage to a column on `launchpad_projects`, so every viewer sees the same target?
7. **Client data in git history.** The PHXA7 JSON is gone from the tree but still in past commits. Purging it would need a history rewrite, which is the repo owner's call.
