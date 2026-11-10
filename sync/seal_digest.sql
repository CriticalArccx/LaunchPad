-- Daily CCM digest for tamper seals (ARC-323). Run once in the Supabase SQL
-- editor; safe to re-run.
--
-- The seal form (seal-form-view.js) used to call the project's Apps Script
-- (?action=notifyCCM) on every Break Request and Work Completed submit, and
-- waited for it before showing the success screen. Now it adds a row here
-- instead, and apps-script/SealDigest.gs sends the CCM recipients one email
-- a day, at the time set in Tamper Seal Settings -> Notifications, listing
-- what was added since the last email.
--
-- One table for every project. Append-only: the form only inserts, nothing
-- updates or deletes. The digest keeps track of what it has sent itself (in
-- its own Script Properties), so rows never need to be marked.
--
-- Read access matches each project's {prefix}BreakRequests table, which
-- already holds the same requestor details for the app and the digest to
-- read with the public anon key. Tightening reads per project belongs with
-- the RLS work in ARC-248.

create table if not exists public.launchpad_seal_notifications (
    id                bigint generated always as identity primary key,
    project_key       text not null,
    event             text not null check (event in ('break_request', 'ready_for_reseal')),
    asset_name        text,
    location          text,
    seal_numbers      text,
    reason            text,
    requestor_name    text,
    requestor_company text,
    requestor_email   text,
    created_at        timestamptz not null default now()
);

create index if not exists launchpad_seal_notifications_project_idx
    on public.launchpad_seal_notifications (project_key, created_at);

alter table public.launchpad_seal_notifications enable row level security;

-- Field users submit the seal form without signing in, so anon can add a
-- row, but only for a real project and stamped with the database's own time
-- (created_at can't be back- or forward-dated, so the digest window holds).
drop policy if exists "Seal form can add notifications" on public.launchpad_seal_notifications;
create policy "Seal form can add notifications" on public.launchpad_seal_notifications
    for insert to anon, authenticated
    with check (
        exists (select 1 from public.launchpad_projects p where p.project_key = launchpad_seal_notifications.project_key)
        and created_at between now() - interval '1 minute' and now() + interval '1 minute'
    );

drop policy if exists "Allow anon read" on public.launchpad_seal_notifications;
create policy "Allow anon read" on public.launchpad_seal_notifications
    for select to anon, authenticated using (true);

grant select, insert on public.launchpad_seal_notifications to anon, authenticated;
-- No update or delete grant or policy: rows are never changed.
