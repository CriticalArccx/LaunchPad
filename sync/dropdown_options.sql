-- Shared dropdown options (ARC-238). Run once in the Supabase SQL editor;
-- safe to re-run.
--
-- Replaces the per-project "{prefix}dropdownoptions" tables with one table
-- for every project, one row per option, tagged with project_key and the list
-- it belongs to (Times, Places, Activities, Assets, Trade_Partners, Results,
-- Zone).
--
-- Insert-only. Every change (added, details changed, hidden, restored) is a
-- new row; the newest row for (project_key, list, value) is that option's
-- current state. launchpad_dropdown_options_current shows exactly that.
-- Nothing is ever updated or deleted.
--
-- Two sources:
--   sheet   the asset list from each project's Google Sheet Equipment tab,
--           written by sync/sync-dropdown-options.mjs (GitHub Actions, service
--           key) at the times set in Settings > Status Refresh Schedule. The
--           Sheet owns these: an asset that leaves the Sheet gets a new
--           inactive row; it can't be hidden by hand in LaunchPad.
--   manual  options added in LaunchPad (Settings, The Bridge), plus
--           everything copied from the old per-project tables. Shown together
--           with the Sheet assets; the sync never hides them.
--
-- The browser never writes to the table directly: reads and writes go
-- through the security-definer functions below, which check the caller's
-- role on the project once (lp_project_role) instead of once per row.
--
-- Transition (both systems side by side): the old {prefix}dropdownoptions
-- tables are not touched by this file. Each project keeps using its old
-- table until an admin ticks "Use the shared table for this project" in
-- Settings > Dropdown Management (launchpad_nav_config.sidebar_config
-- ->> 'dropdownSource' = 'shared'; see lp_dropdown_source below). Until then
-- the shared table still fills in (Sheet assets plus anything new in the old
-- table) so it can be checked against the old one before switching.

-- Same function as sync/feedback.sql and sync/power_flow.sql (identical
-- body), repeated so this file also works on its own.
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

-- 1. Tables ---------------------------------------------------------------

create table if not exists public.launchpad_dropdown_options (
    id           bigint generated always as identity primary key,
    project_key  text not null,
    list         text not null
                 check (list in ('Times', 'Places', 'Activities', 'Assets', 'Trade_Partners', 'Results', 'Zone')),
    value        text not null check (length(btrim(value)) > 0),
    -- Asset details (null for the other lists). place = the Sheet's Area.
    place        text,
    zone         text,
    equipment_id text,
    asset_type   text,
    source       text not null check (source in ('sheet', 'manual')),
    active       boolean not null default true,
    note         text,
    changed_by   text not null default coalesce(lower(auth.email()), 'system'),
    created_at   timestamptz not null default now()
);

create index if not exists launchpad_dropdown_options_current_idx
    on public.launchpad_dropdown_options (project_key, list, lower(value), id desc);

-- One row per sync attempt, so the sync knows when it last ran for a
-- project and Settings can show what it did.
create table if not exists public.launchpad_dropdown_sync_runs (
    id          bigint generated always as identity primary key,
    project_key text not null,
    ran_at      timestamptz not null default now(),
    trigger     text not null default 'schedule',
    ok          boolean not null,
    sheet_count integer,
    added       integer not null default 0,
    changed     integer not null default 0,
    removed     integer not null default 0,
    error       text
);

create index if not exists launchpad_dropdown_sync_runs_project_idx
    on public.launchpad_dropdown_sync_runs (project_key, ran_at desc);

-- Newest row per option. security_invoker, so it never shows more than the
-- caller could read from the table itself.
create or replace view public.launchpad_dropdown_options_current
with (security_invoker = true) as
select distinct on (project_key, list, lower(value))
       id, project_key, list, value, place, zone, equipment_id, asset_type,
       source, active, note, changed_by, created_at
  from public.launchpad_dropdown_options
 order by project_key, list, lower(value), id desc;

-- 2. Row-level security ---------------------------------------------------
-- Members can read (this is what Realtime uses to tell open pages that the
-- list changed). There are no INSERT, UPDATE or DELETE policies: writes go
-- through the functions below, or the sync's service key.

alter table public.launchpad_dropdown_options enable row level security;
alter table public.launchpad_dropdown_sync_runs enable row level security;

drop policy if exists "Project members can read dropdown options" on public.launchpad_dropdown_options;
create policy "Project members can read dropdown options" on public.launchpad_dropdown_options
    for select to authenticated
    using (public.lp_project_role(project_key) is not null);

drop policy if exists "Project members can read dropdown sync runs" on public.launchpad_dropdown_sync_runs;
create policy "Project members can read dropdown sync runs" on public.launchpad_dropdown_sync_runs
    for select to authenticated
    using (public.lp_project_role(project_key) is not null);

revoke all on public.launchpad_dropdown_options_current from anon;

-- 3. Copy a project's old {prefix}dropdownoptions table ---------------------
-- Copies each distinct value of every list that the shared table doesn't
-- have yet (in any state) as a 'manual' option. An asset keeps the Place and
-- Zone that sat on the same row. Safe to call again and again: while a
-- project is still on its old table, lp_dropdown_options() and the sync call
-- it to pick up anything added there since. An option hidden in the shared
-- table is never brought back, and nothing removed from the old table is
-- hidden here (check those in Settings before switching).

create or replace function public.lp_copy_legacy_dropdown_options(p_project_key text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    prefix text;
    copied integer := 0;
begin
    select table_prefix into prefix from launchpad_projects where project_key = p_project_key;
    if prefix is null or to_regclass('public.' || quote_ident(prefix || 'dropdownoptions')) is null then
        return 0;
    end if;
    -- Two pages opening at once must not copy twice.
    perform pg_advisory_xact_lock(hashtext('lp_dropdown_copy:' || p_project_key));
    execute format($f$
        with src as (
            select to_jsonb(t) as j from public.%I t
        ), vals as (
            select l.list,
                   btrim(s.j ->> l.list) as value,
                   case when l.list = 'Assets' then nullif(btrim(s.j ->> 'Places'), '') end as place,
                   case when l.list = 'Assets' then nullif(btrim(s.j ->> 'Zone'), '') end as zone
              from src s
             cross join unnest(array['Times', 'Places', 'Activities', 'Assets', 'Trade_Partners', 'Results', 'Zone']) as l(list)
             where nullif(btrim(s.j ->> l.list), '') is not null
        ), one as (
            select distinct on (list, lower(value)) list, value, place, zone
              from vals
             order by list, lower(value), place nulls last, zone nulls last
        )
        insert into public.launchpad_dropdown_options
               (project_key, list, value, place, zone, source, active, note, changed_by)
        select $1, one.list, one.value, one.place, one.zone, 'manual', true, $2, 'migration'
          from one
         where not exists (select 1 from public.launchpad_dropdown_options o
                            where o.project_key = $1 and o.list = one.list
                              and lower(o.value) = lower(one.value))
    $f$, prefix || 'dropdownoptions')
    using p_project_key, 'Copied from ' || prefix || 'dropdownoptions';
    get diagnostics copied = row_count;
    return copied;
end $$;

revoke all on function public.lp_copy_legacy_dropdown_options(text) from public;
grant execute on function public.lp_copy_legacy_dropdown_options(text) to service_role;

-- Which table a project's dropdowns use: 'shared' once an admin has switched
-- it in Settings, otherwise 'legacy' (the old {prefix}dropdownoptions table).
create or replace function public.lp_dropdown_source(p_project_key text)
returns text
language sql
stable
security definer
set search_path = public
as $$
    select case when (select sidebar_config ->> 'dropdownSource'
                        from launchpad_nav_config where project_key = p_project_key) = 'shared'
                then 'shared' else 'legacy' end
$$;

revoke all on function public.lp_dropdown_source(text) from public;
grant execute on function public.lp_dropdown_source(text) to service_role;

-- 4. Functions the browser calls --------------------------------------------

-- Every option for one project, current state (active and hidden). Members
-- only. While the project is still on its old table, anything new there is
-- copied in first.
create or replace function public.lp_dropdown_options(p_project_key text)
returns setof public.launchpad_dropdown_options_current
language plpgsql
security definer
set search_path = public
as $$
begin
    if public.lp_project_role(p_project_key) is null then
        raise exception 'Not a member of project %', p_project_key using errcode = '42501';
    end if;
    if public.lp_dropdown_source(p_project_key) = 'legacy'
       or not exists (select 1 from launchpad_dropdown_options where project_key = p_project_key) then
        perform public.lp_copy_legacy_dropdown_options(p_project_key);
    end if;
    return query
        select * from launchpad_dropdown_options_current
         where project_key = p_project_key
         order by list, lower(value);
end $$;

-- Add an option by hand (admins and editors). If it is already active,
-- nothing new is written and the current row comes back.
create or replace function public.lp_dropdown_option_add(
    p_project_key text,
    p_list text,
    p_value text,
    p_place text default null,
    p_zone text default null,
    p_note text default null)
returns public.launchpad_dropdown_options
language plpgsql
security definer
set search_path = public
as $$
declare
    caller_role text := public.lp_project_role(p_project_key);
    v text := btrim(coalesce(p_value, ''));
    cur_id bigint;
    cur_active boolean;
    result public.launchpad_dropdown_options;
begin
    if caller_role is null or caller_role not in ('admin', 'editor') then
        raise exception 'Only project admins and editors can add dropdown options' using errcode = '42501';
    end if;
    if v = '' then
        raise exception 'The option is empty' using errcode = '22023';
    end if;
    select id, active into cur_id, cur_active
      from launchpad_dropdown_options_current
     where project_key = p_project_key and list = p_list and lower(value) = lower(v);
    if found and cur_active then
        select * into result from launchpad_dropdown_options where id = cur_id;
        return result;
    end if;
    insert into launchpad_dropdown_options
           (project_key, list, value, place, zone, source, active, note, changed_by)
    values (p_project_key, p_list, v,
            nullif(btrim(coalesce(p_place, '')), ''), nullif(btrim(coalesce(p_zone, '')), ''),
            'manual', true, nullif(btrim(coalesce(p_note, '')), ''), lower(auth.email()))
    returning * into result;
    return result;
end $$;

-- Hide or restore an option (admins and editors). Assets from the Sheet
-- can't be hidden here: the Sheet owns them, so change them there.
-- Restoring an asset the Sheet removed keeps it as a manual option.
create or replace function public.lp_dropdown_option_set_active(
    p_project_key text,
    p_list text,
    p_value text,
    p_active boolean,
    p_note text default null)
returns public.launchpad_dropdown_options
language plpgsql
security definer
set search_path = public
as $$
declare
    caller_role text := public.lp_project_role(p_project_key);
    cur public.launchpad_dropdown_options;
    result public.launchpad_dropdown_options;
begin
    if caller_role is null or caller_role not in ('admin', 'editor') then
        raise exception 'Only project admins and editors can change dropdown options' using errcode = '42501';
    end if;
    select o.* into cur
      from launchpad_dropdown_options o
      join launchpad_dropdown_options_current c on c.id = o.id
     where c.project_key = p_project_key and c.list = p_list and lower(c.value) = lower(btrim(p_value));
    if not found then
        raise exception 'No % option called "%"', p_list, p_value using errcode = 'P0002';
    end if;
    if cur.active = p_active then
        return cur;
    end if;
    if cur.source = 'sheet' and cur.active and not p_active then
        raise exception '"%" comes from the Google Sheet''s Equipment tab. Remove or rename it there.', cur.value
            using errcode = 'P0001';
    end if;
    insert into launchpad_dropdown_options
           (project_key, list, value, place, zone, equipment_id, asset_type, source, active, note, changed_by)
    values (cur.project_key, cur.list, cur.value, cur.place, cur.zone, cur.equipment_id, cur.asset_type,
            'manual', p_active, nullif(btrim(coalesce(p_note, '')), ''), lower(auth.email()))
    returning * into result;
    return result;
end $$;

-- Company names for the two signed-out screens: the access request (by
-- access code) and the QR tamper-seal form (by the project's public uuid).
-- Returns only active Trade Partner names, nothing else, and nothing at all
-- for a project still on its old table (the page then reads that table).
create or replace function public.lp_trade_partners_by_access_code(p_code text)
returns setof text
language plpgsql
security definer
set search_path = public
as $$
declare
    key text;
begin
    select project_key into key from launchpad_projects where access_code::text = btrim(p_code) limit 1;
    if key is null or public.lp_dropdown_source(key) <> 'shared' then
        return;
    end if;
    return query
        select value from launchpad_dropdown_options_current
         where project_key = key and list = 'Trade_Partners' and active
         order by lower(value);
end $$;

create or replace function public.lp_trade_partners_by_public_uuid(p_uuid text)
returns setof text
language plpgsql
security definer
set search_path = public
as $$
declare
    key text;
begin
    select project_key into key from launchpad_projects where public_uuid::text = btrim(p_uuid) limit 1;
    if key is null or public.lp_dropdown_source(key) <> 'shared' then
        return;
    end if;
    return query
        select value from launchpad_dropdown_options_current
         where project_key = key and list = 'Trade_Partners' and active
         order by lower(value);
end $$;

revoke all on function public.lp_dropdown_options(text) from public;
revoke all on function public.lp_dropdown_option_add(text, text, text, text, text, text) from public;
revoke all on function public.lp_dropdown_option_set_active(text, text, text, boolean, text) from public;
revoke all on function public.lp_trade_partners_by_access_code(text) from public;
revoke all on function public.lp_trade_partners_by_public_uuid(text) from public;
grant execute on function public.lp_dropdown_options(text) to authenticated;
grant execute on function public.lp_dropdown_option_add(text, text, text, text, text, text) to authenticated;
grant execute on function public.lp_dropdown_option_set_active(text, text, text, boolean, text) to authenticated;
grant execute on function public.lp_trade_partners_by_access_code(text) to anon, authenticated;
grant execute on function public.lp_trade_partners_by_public_uuid(text) to anon, authenticated;

-- 5. Realtime: open pages refresh their dropdowns when an option changes. --
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (select 1 from pg_publication_tables
                        where pubname = 'supabase_realtime' and schemaname = 'public'
                          and tablename = 'launchpad_dropdown_options') then
        alter publication supabase_realtime add table public.launchpad_dropdown_options;
    end if;
end $$;

-- 6. Copy every existing project's old table now, then show the result. ----
-- Every project stays on its old table (dropdown_source 'legacy') until it is
-- switched in Settings.
select p.project_key,
       public.lp_dropdown_source(p.project_key) as dropdown_source,
       public.lp_copy_legacy_dropdown_options(p.project_key) as rows_copied_now,
       (select count(*) from public.launchpad_dropdown_options o where o.project_key = p.project_key) as rows_total
  from public.launchpad_projects p
 order by p.project_key;
