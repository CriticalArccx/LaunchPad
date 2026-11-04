-- Feedback on LaunchPad (ARC-199). Run once in the Supabase SQL editor; safe
-- to re-run.
--
-- One table for every project. Feedback belongs to the project it was sent
-- from, and only that project's members (any role in its own
-- {prefix}authorized_editors) can read or send it. The module is hidden on
-- each project's sidebar until an admin turns it on in Settings.
--
-- Append-only, like the rest of LaunchPad's history: feedback is never
-- deleted or overwritten. Editing inserts a new row with supersedes_id set
-- and stamps the old row's superseded_at; removing an entry stamps
-- archived_at. A trigger rejects any other change to an existing row, and
-- there is no DELETE policy.

create table if not exists public.launchpad_feedback (
    id                   bigint generated always as identity primary key,
    project_key          text not null,
    type                 text not null check (type in ('Bug', 'Idea', 'Question', 'Other')),
    area                 text,
    title                text not null check (length(trim(title)) > 0),
    details              text,
    impact               text check (impact in ('Low', 'Medium', 'High')),
    context              jsonb,          -- screen, view and browser when it was sent
    submitted_by         text not null default lower(auth.email()),
    submitted_by_company text,
    created_at           timestamptz not null default now(),
    supersedes_id        bigint references public.launchpad_feedback (id),
    superseded_at        timestamptz,
    archived_at          timestamptz,
    archived_by          text
);

create index if not exists launchpad_feedback_project_idx
    on public.launchpad_feedback (project_key, created_at desc);

-- The signed-in user's role on a project: 'admin', 'editor', 'viewer' or
-- null. Same rule as the app's editorRole(): the row's role, or is_admin
-- when role is empty. security definer so the policies below can read the
-- project's own editors table, whichever project it is.
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

-- Existing rows only ever change by being superseded or archived, once.
create or replace function public.lp_feedback_guard()
returns trigger
language plpgsql
as $$
begin
    if (new.project_key, new.type, new.area, new.title, new.details, new.impact,
        new.context, new.submitted_by, new.submitted_by_company, new.created_at,
        new.supersedes_id)
       is distinct from
       (old.project_key, old.type, old.area, old.title, old.details, old.impact,
        old.context, old.submitted_by, old.submitted_by_company, old.created_at,
        old.supersedes_id) then
        raise exception 'Feedback is append-only: save an edit as a new version instead.';
    end if;
    if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
        raise exception 'This feedback has already been superseded.';
    end if;
    if old.archived_at is not null and
       (new.archived_at is distinct from old.archived_at or new.archived_by is distinct from old.archived_by) then
        raise exception 'This feedback has already been archived.';
    end if;
    return new;
end $$;

drop trigger if exists lp_feedback_guard on public.launchpad_feedback;
create trigger lp_feedback_guard
    before update on public.launchpad_feedback
    for each row execute function public.lp_feedback_guard();

alter table public.launchpad_feedback enable row level security;

drop policy if exists "Project members can read feedback" on public.launchpad_feedback;
create policy "Project members can read feedback" on public.launchpad_feedback
    for select to authenticated
    using (public.lp_project_role(project_key) is not null);

drop policy if exists "Project members can send feedback" on public.launchpad_feedback;
create policy "Project members can send feedback" on public.launchpad_feedback
    for insert to authenticated
    with check (lower(submitted_by) = lower(auth.email())
                and public.lp_project_role(project_key) is not null);

-- Supersede/archive: the person who sent it, or an admin of its project.
drop policy if exists "Sender or project admin can supersede or archive" on public.launchpad_feedback;
create policy "Sender or project admin can supersede or archive" on public.launchpad_feedback
    for update to authenticated
    using (lower(submitted_by) = lower(auth.email()) or public.lp_project_role(project_key) = 'admin')
    with check (lower(submitted_by) = lower(auth.email()) or public.lp_project_role(project_key) = 'admin');

-- Check (read-only): the three policies and the trigger should be listed.
select policyname, cmd from pg_policies where tablename = 'launchpad_feedback' order by cmd;
select tgname from pg_trigger where tgrelid = 'public.launchpad_feedback'::regclass and not tgisinternal;
