-- Power Flow Diagram module, phase 1 (ARC-237). Run once in the Supabase SQL
-- editor; safe to re-run.
--
-- Two insert-only tables, keyed by project_key:
--   launchpad_powerflow_imports  each power-flow file an admin imports. The
--                                newest one is the project's current drawing
--                                data; older ones stay as history.
--   launchpad_powerflow_log      the setup log: every import, Match-up
--                                decision and rule change, with who, when and
--                                why. The newest 'decision' row for a drawing
--                                tag is that tag's match, and the newest 'rule'
--                                row for a rule key is that rule. Undo is a new
--                                row, never an edit.
-- Neither table has an UPDATE or DELETE policy, so rows can't be changed or
-- removed from the browser.
--
-- Commissioning status, CHK/ISS, tamper seals and schedule are never stored
-- here; the module reads them live from LaunchPad and the project's Sheet.

-- Same function as sync/feedback.sql (identical body), repeated so this file
-- also works on its own.
create or replace function public.lp_project_role(p_project_key text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    prefix text;
    found_role text;
begin
    select table_prefix into prefix from launchpad_projects where project_key = p_project_key;
    if prefix is null then
        return null;
    end if;
    execute format(
        'select coalesce(role, case when is_admin then ''admin'' else ''editor'' end)
           from public.%I
          where lower(email) = lower(auth.email())
          order by case coalesce(role, case when is_admin then ''admin'' else ''editor'' end)
                   when ''admin'' then 1 when ''editor'' then 2 else 3 end
          limit 1',
        prefix || 'authorized_editors')
      into found_role;
    return found_role;
exception when undefined_table then
    return null;
end $$;

revoke all on function public.lp_project_role(text) from public;
grant execute on function public.lp_project_role(text) to authenticated;

create table if not exists public.launchpad_powerflow_imports (
    id          bigint generated always as identity primary key,
    project_key text not null,
    file_name   text,
    row_count   integer not null default 0,
    rows        jsonb not null default '[]'::jsonb,
    imported_by text not null default lower(auth.email()),
    created_at  timestamptz not null default now()
);

create index if not exists launchpad_powerflow_imports_project_idx
    on public.launchpad_powerflow_imports (project_key, created_at desc);

create table if not exists public.launchpad_powerflow_log (
    id          bigint generated always as identity primary key,
    project_key text not null,
    kind        text not null check (kind in ('import', 'decision', 'rule')),
    subject     text not null,
    value       jsonb not null default '{}'::jsonb,
    detail      text,
    reason      text,
    created_by  text not null default lower(auth.email()),
    created_at  timestamptz not null default now()
);

create index if not exists launchpad_powerflow_log_project_idx
    on public.launchpad_powerflow_log (project_key, created_at desc);

alter table public.launchpad_powerflow_imports enable row level security;
alter table public.launchpad_powerflow_log enable row level security;

-- Anyone on the project can read.
drop policy if exists "Project members can read power flow imports" on public.launchpad_powerflow_imports;
create policy "Project members can read power flow imports" on public.launchpad_powerflow_imports
    for select to authenticated
    using (public.lp_project_role(project_key) is not null);

drop policy if exists "Project members can read the power flow log" on public.launchpad_powerflow_log;
create policy "Project members can read the power flow log" on public.launchpad_powerflow_log
    for select to authenticated
    using (public.lp_project_role(project_key) is not null);

-- Only the project's admins set it up, and only as themselves.
drop policy if exists "Project admins can import power flow files" on public.launchpad_powerflow_imports;
create policy "Project admins can import power flow files" on public.launchpad_powerflow_imports
    for insert to authenticated
    with check (public.lp_project_role(project_key) = 'admin'
                and imported_by = lower(auth.email()));

drop policy if exists "Project admins can add to the power flow log" on public.launchpad_powerflow_log;
create policy "Project admins can add to the power flow log" on public.launchpad_powerflow_log
    for insert to authenticated
    with check (public.lp_project_role(project_key) = 'admin'
                and created_by = lower(auth.email()));

-- Check: should list two policies per table (select and insert) and no
-- update or delete.
select tablename, policyname, cmd
  from pg_policies
 where tablename in ('launchpad_powerflow_imports', 'launchpad_powerflow_log')
 order by tablename, cmd;
