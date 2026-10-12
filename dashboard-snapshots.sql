-- Weekly checklist snapshots for the dashboard's "Path to Completion" chart.
--
-- launchpad_dashboard_data only holds each checklist's CURRENT status, so the
-- number verified in any past week is lost. Every Friday evening this saves
-- a count of checklists per project / type / discipline / contractor /
-- status; dashboard.js draws the green "verified to date" line from it.
-- Counts are kept per status (not a single verified total) so the sidebar
-- filters still apply and the verified definition can change later.
--
-- Run once in the Supabase SQL editor. Additive only: it does not change
-- launchpad_dashboard_data or the sync job.

-- 1. Table ---------------------------------------------------------------
create table if not exists launchpad_checklist_snapshots (
    project_key      text not null,
    snapshot_date    date not null,
    type_name        text not null default '',
    discipline       text not null default '',
    assigned_company text not null default '',
    status           text not null default '',
    checklist_count  integer not null,
    taken_at         timestamptz not null default now(),
    primary key (project_key, snapshot_date, type_name, discipline, assigned_company, status)
);

alter table launchpad_checklist_snapshots enable row level security;
drop policy if exists "Allow anon read" on launchpad_checklist_snapshots;
create policy "Allow anon read" on launchpad_checklist_snapshots for select using (true);

-- 2. Snapshot function ---------------------------------------------------
-- Dated in Central time, so a Friday-evening run is stamped as that Friday.
-- Re-running for the same date replaces that date's rows.
create or replace function take_checklist_snapshot(p_date date default null)
returns integer
language plpgsql
set search_path = public
as $$
declare
    d date := coalesce(p_date, (now() at time zone 'America/Chicago')::date);
    n integer;
begin
    delete from launchpad_checklist_snapshots where snapshot_date = d;

    insert into launchpad_checklist_snapshots
        (project_key, snapshot_date, type_name, discipline, assigned_company, status, checklist_count)
    select dd.project_key, d,
           coalesce(c->>'type_name', ''), coalesce(c->>'discipline', ''),
           coalesce(c->>'assigned_company', ''), coalesce(c->>'status', ''),
           count(*)
    from launchpad_dashboard_data dd,
         jsonb_array_elements(dd.data->'checklists') c
    where jsonb_typeof(dd.data->'checklists') = 'array'
    group by 1, 2, 3, 4, 5, 6;

    get diagnostics n = row_count;
    return n;
end;
$$;

-- Supabase exposes functions over its API; only the scheduler should run this.
revoke execute on function take_checklist_snapshot(date) from public, anon, authenticated;

-- 3. Schedule: Fridays 11 PM Central ------------------------------------
-- pg_cron runs in UTC. Saturday 04:00 UTC is Friday 11 PM CDT / 10 PM CST.
create extension if not exists pg_cron;
select cron.unschedule('weekly-checklist-snapshot')
where exists (select 1 from cron.job where jobname = 'weekly-checklist-snapshot');
select cron.schedule('weekly-checklist-snapshot', '0 4 * * 6', $$select take_checklist_snapshot()$$);
