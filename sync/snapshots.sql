-- Run this once in the Supabase SQL editor. Backs sync/snapshot-schedule-
-- data.mjs — periodic point-in-time backups of a project's BackEndData
-- table, so there's somewhere to recover real data from if a row (or many)
-- ever gets lost again, independent of whatever caused it. Scoped to
-- MSA3A first, per request; the snapshot script is already written to
-- take a list of projects, so covering another one later is just adding
-- its project_key there — no schema change needed.

create table if not exists launchpad_schedule_snapshots (
    id bigserial primary key,
    project_key text not null,
    snapshot_at timestamptz not null default now(),
    row_count integer not null,
    data jsonb not null
);
create index if not exists launchpad_schedule_snapshots_project_idx
    on launchpad_schedule_snapshots (project_key, snapshot_at desc);

alter table launchpad_schedule_snapshots enable row level security;
drop policy if exists "Allow anon read" on launchpad_schedule_snapshots;
create policy "Allow anon read" on launchpad_schedule_snapshots for select using (true);
-- No anon write policy, deliberately — only the scheduled GitHub Actions
-- job writes here, authenticated with the service_role key (bypasses RLS,
-- same convention as sync-equipment-data.mjs). Nothing using the app's
-- anon key should ever be able to touch snapshot history.
