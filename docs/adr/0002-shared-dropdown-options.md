# 0002: One shared dropdown-options table, with assets synced from each project's Sheet

Date: 2026-11-09   Status: Accepted

## Context

Each project had its own `{prefix}dropdownoptions` table, with one column per list
(Times, Places, Activities, Assets, Trade_Partners, Results, Zone). Every option was typed
in by hand, so a project's asset list fell behind its Google Sheet, which owns the
equipment list. The Settings editor was hard-coded to one project's table, and the
"Clear Empty Database Rows" button there hard-deleted rows.

## Decision

- One table, `launchpad_dropdown_options`, holds every project's options: one row per
  option, tagged with `project_key` and `list`. It is insert-only. Each change is a new row,
  and `launchpad_dropdown_options_current` shows the newest row per option.
- Assets have two sources:
  - `sheet`: the project's Sheet **Equipment** tab, via the new Apps Script action
    `getAssetList`. `sync/sync-dropdown-options.mjs` (GitHub Actions, service key) brings
    them in at the times admins set in Settings → Status Refresh Schedule, or once a day at
    06:00 when none are set. The Sheet owns these rows: an asset that leaves the Sheet gets
    an inactive row, and LaunchPad users can't hide or rename it.
  - `manual`: options added in LaunchPad, plus everything copied from the old tables. They
    are shown together with the Sheet assets, and the sync never hides them.
- The browser reads and writes only through security-definer functions that check
  `lp_project_role()` once per call. Two narrow functions return company names to the
  signed-out access-request and QR seal-form screens.
- **Projects move over one at a time.** Both tables work side by side. Each project keeps
  using its old table (adding and removing there as before) until an admin ticks "Use the
  shared table for this project" in Settings → Dropdown Management and saves. That is
  stored as `dropdownSource: 'shared'` in the project's `launchpad_nav_config.sidebar_config`;
  unticking it switches the project back. Until a project is switched, the shared table still
  fills in, with the Sheet's assets plus anything new in the old table, and Settings can show
  either table and count what each has that the other doesn't. A switched project falls back
  to its old table if the shared one can't be read. The old tables are never changed by the
  shared side.

## Alternatives rejected

- **The Apps Script pushes changes to Supabase on edit.** This needs a write key in every
  Sheet, and edit triggers miss changes made by formulas and imports.
- **Reading the Sheet live from the browser.** This is slow on every page load (Apps Script
  cold starts), and the list goes blank when Apps Script is down.
- **Assets only.** This would leave two systems to manage the other lists.
- **Updating rows in place.** This breaks the append-only rule and loses who changed what.

## Consequences

- One SQL file to run (`sync/dropdown_options.sql`). It copies every project's old table,
  and keeps topping up the shared table from it while the project is on the old table.
- Each project's Apps Script must be redeployed with `getAssetList`. Until then the sync
  logs a failed run, which Settings shows, and changes nothing.
- Assets from the Sheet are changed in the Sheet, not in LaunchPad.
- An asset's Place (the Sheet's Place, Location, Area, Space or Room column) comes with
  it and appears in the Places list. A Sheet with no such column keeps the place already
  saved.
- During the transition, a value removed from the old table stays in the shared table.
  Settings marks those differences, so they can be hidden there before switching.
- Once every project is switched and checked, the old-table code paths and tables can be
  retired in a later change.

Jira: ARC-238
