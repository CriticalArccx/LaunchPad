-- Run this once in the Supabase SQL editor. Records every row deleted from
-- every project's BackEndData table — "a table or column that denotes when
-- activity line items have been deleted," per request. Started on MSA3A
-- only; now covers every project in launchpad_projects. Implemented as a
-- database trigger (not app code) specifically so it catches every
-- deletion regardless of what triggers it — Bridge's
-- clearOrphanedScheduleRows()/acceptPendingChanges(), a manual delete, a
-- future code path nobody's written yet — rather than only the ones
-- whichever JS function happens to call a logging helper.
--
-- One shared log table (not a per-project one), and the trigger-creation
-- loop at the bottom re-running this file is always safe (drop-if-exists
-- per project) — including picking up any project added after the fact,
-- just by running this file again.

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

-- One trigger per project's BackEndData table — skips any project that
-- doesn't have one (nothing to attach to), and is safe to re-run any time
-- (e.g. after a new project is added to launchpad_projects): drops and
-- recreates each trigger rather than erroring on a second run.
do $$
declare
    proj record;
begin
    for proj in select project_key, table_prefix from launchpad_projects loop
        if to_regclass(format('public.%I', proj.table_prefix || 'BackEndData')) is not null then
            execute format('drop trigger if exists trg_log_deletion on %I', proj.table_prefix || 'BackEndData');
            execute format(
                'create trigger trg_log_deletion after delete on %I for each row execute function log_backend_data_deletion(%L)',
                proj.table_prefix || 'BackEndData', proj.project_key
            );
        end if;
    end loop;
end $$;
