-- Run this once in the Supabase SQL editor. Records every row deleted from
-- a project's BackEndData table — "a table or column that denotes when
-- activity line items have been deleted," per request, scoped to MSA3A
-- first. Implemented as a database trigger (not app code) specifically so
-- it catches every deletion regardless of what triggers it — Bridge's
-- clearOrphanedScheduleRows()/acceptPendingChanges(), a manual delete, a
-- future code path nobody's written yet — rather than only the ones
-- whichever JS function happens to call a logging helper.
--
-- One shared log table (not a per-project one) so adding another project
-- later is just one more trigger statement at the bottom, not a new table.

create table if not exists launchpad_deleted_activities (
    id bigserial primary key,
    project_key text not null,
    source_table text not null,
    row_id bigint not null,
    row_data jsonb not null,
    deleted_at timestamptz not null default now()
);

alter table launchpad_deleted_activities enable row level security;
drop policy if exists "Allow anon read" on launchpad_deleted_activities;
create policy "Allow anon read" on launchpad_deleted_activities for select using (true);
-- No anon write policy, deliberately — the trigger function below runs
-- SECURITY DEFINER (see comment on it), so it doesn't need one to log a
-- deletion, and leaving writes closed means only that trigger can ever
-- add a row here, not anything using the app's anon key directly.

-- SECURITY DEFINER so this always succeeds and runs with the privileges
-- of whoever created it (the Supabase SQL editor's role), not the anon
-- role performing the delete — an audit log must never be the reason a
-- legitimate delete starts failing just because the anon role doesn't
-- have its own insert policy on the log table. search_path is pinned per
-- Postgres's own standard guidance for SECURITY DEFINER functions, so it
-- can't be hijacked by a session that's changed its search_path.
create or replace function log_backend_data_deletion() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into launchpad_deleted_activities (project_key, source_table, row_id, row_data, deleted_at)
    values (TG_ARGV[0], TG_TABLE_NAME, OLD.id, to_jsonb(OLD), now());
    return OLD;
end;
$$;

drop trigger if exists trg_log_deletion on "MSA3ABackEndData";
create trigger trg_log_deletion
after delete on "MSA3ABackEndData"
for each row execute function log_backend_data_deletion('MSA3A');

-- To extend this to another project later, run just this (swap the table
-- name and project_key):
--   drop trigger if exists trg_log_deletion on "{PREFIX}BackEndData";
--   create trigger trg_log_deletion
--   after delete on "{PREFIX}BackEndData"
--   for each row execute function log_backend_data_deletion('{PROJECT_KEY}');
