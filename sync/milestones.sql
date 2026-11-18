-- Bridge Milestones (ARC-348, ARC-349, ARC-350). Run once in the Supabase SQL
-- editor; safe to re-run.
--
-- One insert-only table, keyed by project_key:
--   launchpad_milestones  each version of a project's milestones (key dates
--                         such as "FR1"). A milestone is only a name and a due
--                         date. milestone_key ties its versions together: the
--                         newest row for a key is the milestone as it is now.
--                         Editing adds a new row; removing adds a row with
--                         archived = true. Nothing is ever changed or deleted.
-- There is no UPDATE or DELETE policy, so rows can't be changed or removed
-- from the browser.
--
-- Which schedule lines a milestone needs is never stored here: Bridge works
-- it out from the lines' dates and predecessors each time.

-- Same function as sync/feedback.sql and sync/power_flow.sql (identical body),
-- repeated so this file also works on its own.
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

create table if not exists public.launchpad_milestones (
    id            bigint generated always as identity primary key,
    project_key   text not null,
    milestone_key text not null,
    name          text not null check (length(trim(name)) between 1 and 60),
    due_date      date not null,
    archived      boolean not null default false,
    created_by    text not null default lower(auth.email()),
    created_at    timestamptz not null default now()
);

create index if not exists launchpad_milestones_project_idx
    on public.launchpad_milestones (project_key, milestone_key, created_at desc);

alter table public.launchpad_milestones enable row level security;

-- Anyone on the project can read.
drop policy if exists "Project members can read milestones" on public.launchpad_milestones;
create policy "Project members can read milestones" on public.launchpad_milestones
    for select to authenticated
    using (public.lp_project_role(project_key) is not null);

-- Admins and editors add, edit and remove milestones, only as themselves.
drop policy if exists "Project editors can add milestones" on public.launchpad_milestones;
create policy "Project editors can add milestones" on public.launchpad_milestones
    for insert to authenticated
    with check (public.lp_project_role(project_key) in ('admin', 'editor')
                and created_by = lower(auth.email()));

-- Check: should list two policies (select and insert) and no update or delete.
select tablename, policyname, cmd
  from pg_policies
 where tablename = 'launchpad_milestones'
 order by cmd;
