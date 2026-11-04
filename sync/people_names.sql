-- People's names (ARC-209). Run once in the Supabase SQL editor; safe to
-- re-run.
--
-- A name is entered at sign-up (or on the invite "Create your PIN" screen,
-- or a one-time prompt for existing users) and saved on the person's own
-- Supabase Auth account (user_metadata.full_name). The browser can only read
-- the signed-in person's own account, so the name is also written here,
-- which lets admins see it in Manage Access, edit history and Feedback.
--
-- Append-only: a name change adds a row, it never overwrites one. The
-- launchpad_people_current view gives each email's latest name.
--
-- Also adds full_name to every project's {prefix}access_requests (below).
-- Re-run this file after creating a new project's tables.

create table if not exists public.launchpad_people_names (
    id         bigint generated always as identity primary key,
    email      text not null,
    full_name  text not null check (length(trim(full_name)) > 0),
    created_at timestamptz not null default now()
);

create index if not exists launchpad_people_names_email_idx
    on public.launchpad_people_names (lower(email), created_at desc);

alter table public.launchpad_people_names enable row level security;

drop policy if exists "Signed-in users can read names" on public.launchpad_people_names;
create policy "Signed-in users can read names" on public.launchpad_people_names
    for select to authenticated using (true);

drop policy if exists "People can add their own name" on public.launchpad_people_names;
create policy "People can add their own name" on public.launchpad_people_names
    for insert to authenticated
    with check (lower(email) = lower(auth.email()));

-- No UPDATE or DELETE policy: rows are never changed or removed.

create or replace view public.launchpad_people_current
with (security_invoker = true) as
select distinct on (lower(email)) lower(email) as email, full_name, created_at
from public.launchpad_people_names
order by lower(email), created_at desc;

grant select on public.launchpad_people_current to authenticated;

-- Access requests are sent from the project picker before the person is
-- signed in, so they can't write to the table above yet. Each request
-- carries the name instead, for admins to see in Pending Requests.
do $$
declare
    proj record;
begin
    for proj in select table_prefix from launchpad_projects loop
        if to_regclass(format('public.%I', proj.table_prefix || 'access_requests')) is not null then
            execute format('alter table public.%I add column if not exists full_name text',
                           proj.table_prefix || 'access_requests');
        end if;
    end loop;
end $$;

-- Check (read-only): two policies should be listed.
select policyname, cmd from pg_policies where tablename = 'launchpad_people_names' order by cmd;
