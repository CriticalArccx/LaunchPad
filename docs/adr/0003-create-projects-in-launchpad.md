# 0003: Create projects from inside LaunchPad by copying an existing project's tables

Date: 2026-11-09   Status: Accepted

## Context

Setting up a project meant hand-written SQL in Supabase: a `launchpad_projects` row, about
ten `{prefix}` tables (authorized_editors, access_requests, edit_history, BackEndData,
schedule_items, Assets, dropdownoptions, RequestedSeals, BrokenSeals, BreakRequests), their
row-level security, the deletion-log trigger, realtime, the first admin, and then each
setting copied over by hand. Each of those tables has picked up columns and policies over
time from separate `sync/*.sql` files, so no single script describes them.

## Decision

- `sync/new_project.sql` adds `lp_create_project(jsonb)`, a security-definer function that
  creates the whole project in one transaction (all or nothing).
- The new tables copy the **structure** of the same tables in an existing project the owner
  picks: `create table ... (like ... including all)`, plus foreign keys, row-level security
  and its policies, triggers, grants, replica identity and the realtime publication. Policy,
  trigger and constraint text that names the source project's tables or its key is
  rewritten to the new project's. No rows are copied.
- `lp_copy_project_settings` copies the settings rows (schedule, navigation, equivalent
  activities, tamper seals, equipment tracker) the way Save writes them, and adds dropdown
  options. The target keeps its own choice of dropdown table (ADR 0002).
- Only people in `launchpad_platform_owners` (one person for now) can call these. The
  functions check that themselves; `project-setup.js` only hides the buttons from everyone
  else.

## Alternatives rejected

- **A hand-maintained CREATE TABLE script per table.** It would drift from the real tables
  every time another `sync/*.sql` adds a column or policy.
- **A GitHub Action or Edge Function holding the service key.** More moving parts, and the
  owner check would still be needed; the security-definer function needs no secret in the
  browser.
- **Copying rows as well.** Projects share no schedule or seal data, and copying it would
  create false history.

## Consequences

- The new project's tables are only as complete as the project they're copied from. Pick
  one that's up to date (has had every `sync/*.sql` run).
- New projects start on the old dropdown table, like every other project, and can be
  switched in Settings.
- The Google Sheet and its Apps Script are still made by hand; the form takes the Apps
  Script URL, or it can be added later.
- Adding a platform owner is one insert into `launchpad_platform_owners`.

Jira: ARC-307
