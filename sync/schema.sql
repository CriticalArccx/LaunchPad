-- Run this once in the Supabase SQL editor before the sync workflow's
-- first run. It creates two small cache tables that hold the latest
-- snapshot of data that's still actually maintained in Google Sheets
-- (equipment status rows + Phase Rules, and the dashboard's rollup data),
-- pulled in periodically by sync/sync-equipment-data.mjs instead of the
-- app calling the slow Apps Script endpoint live on every page load.
--
-- Writes come only from the sync job, authenticated with the Supabase
-- service_role key (which bypasses RLS) — never from the browser. Reads
-- come from the app's anon key, same as every other launchpad_* table.
-- Adjust the two "Allow anon read" policies below if this project's other
-- launchpad_* tables use a different read policy convention.

create table if not exists launchpad_equipment_tracker_data (
    project_key text primary key,
    data jsonb not null default '[]'::jsonb,
    phase_rules jsonb not null default '[]'::jsonb,
    checklist_types_by_phase jsonb not null default '{}'::jsonb,
    synced_at timestamptz not null default now()
);
alter table launchpad_equipment_tracker_data add column if not exists checklist_types_by_phase jsonb not null default '{}'::jsonb;

create table if not exists launchpad_dashboard_data (
    project_key text primary key,
    data jsonb not null default '{}'::jsonb,
    synced_at timestamptz not null default now()
);

alter table launchpad_equipment_tracker_data enable row level security;
drop policy if exists "Allow anon read" on launchpad_equipment_tracker_data;
create policy "Allow anon read" on launchpad_equipment_tracker_data for select using (true);

alter table launchpad_dashboard_data enable row level security;
drop policy if exists "Allow anon read" on launchpad_dashboard_data;
create policy "Allow anon read" on launchpad_dashboard_data for select using (true);

-- Optional per-project override for the KPI dashboard's title (otherwise
-- it's whatever project_name comes through in the synced Apps
-- Script/Sheets data — see dashboard.js renderAll()). Set from the
-- Dashboard tab's own Settings (gear icon), admin-gated the same way the
-- existing access_code regeneration on this table already is — no new RLS
-- policy needed since that update already runs through whatever policy
-- currently allows an authorized admin to update their own project's row.
alter table launchpad_projects add column if not exists dashboard_display_name text;
