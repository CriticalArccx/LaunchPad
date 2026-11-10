-- New projects from inside LaunchPad (ARC-307). Run once in the Supabase SQL
-- editor; safe to re-run.
--
-- Lets the platform owner (launchpad_platform_owners; just one person for
-- now) create a whole project from the "Add new project" form, and copy
-- settings between projects, without hand-written SQL:
--
--   lp_create_project(p jsonb)   one transaction, so it either all happens
--                                or none of it does:
--     1. the launchpad_projects row, with a new unique 6-digit access code;
--     2. the project's own tables ({key}authorized_editors, BackEndData,
--        Assets, ...), each a copy of the STRUCTURE of the same table in a
--        project you pick: columns, defaults, indexes, constraints, row-level
--        security and its policies, triggers, grants and realtime. Policies
--        and triggers that name the source project's tables or key are
--        pointed at the new project's instead. No rows are copied;
--     3. you (and any other admins you list) as admins of the new project,
--        with a launchpad_memberships row each so it shows in the picker;
--     4. whichever settings you tick, copied from a project you pick
--        (lp_copy_project_settings below).
--
--   lp_copy_project_settings(p_from, p_to, p_parts, p_lists)
--     Copies settings rows (schedule config, navigation, equivalent
--     activities, tamper seals, equipment tracker) the same way Save already
--     writes them, one row per project, and ADDS dropdown options. Nothing
--     is deleted.
--
-- Everything is security definer and checks lp_is_platform_owner() first,
-- so nobody else can call it, whatever the browser does.

-- 1. Who may create projects --------------------------------------------------

create table if not exists public.launchpad_platform_owners (
    email    text primary key check (email = lower(email)),
    added_at timestamptz not null default now()
);
alter table public.launchpad_platform_owners enable row level security;
-- No policies: only the functions below read it.

insert into public.launchpad_platform_owners (email)
values ('cbaldwin@criticalarccx.com')
on conflict (email) do nothing;

create or replace function public.lp_is_platform_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from launchpad_platform_owners
                    where email = lower(coalesce(auth.email(), '')))
$$;

-- 2. Helpers (not callable from the browser) ---------------------------------

-- The tables every project has, by the part after its prefix. A project
-- copies the ones its source project has (e.g. schedule_items only exists
-- for projects that aren't on the unified schedule).
create or replace function public.lp__project_table_suffixes()
returns text[]
language sql
immutable
as $$
    select array['authorized_editors', 'access_requests', 'edit_history', 'BackEndData',
                 'schedule_items', 'Assets', 'dropdownoptions',
                 'RequestedSeals', 'BrokenSeals', 'BreakRequests']
$$;

-- Points SQL text (a policy, trigger or constraint) at the new project:
-- the old project's table names become the new project's, and the old
-- project key as a quoted literal ('CASB') becomes the new one.
create or replace function public.lp__rewrite_refs(
    txt text, old_prefix text, new_prefix text, old_key text, new_key text)
returns text
language plpgsql
immutable
as $$
declare
    s text;
begin
    if txt is null then
        return null;
    end if;
    foreach s in array public.lp__project_table_suffixes() loop
        txt := replace(txt, quote_ident(old_prefix || s), quote_ident(new_prefix || s));
        -- all-lowercase names are written without quotes
        if old_prefix || s = lower(old_prefix || s) then
            txt := regexp_replace(txt, '\m' || (old_prefix || s) || '\M', quote_ident(new_prefix || s), 'g');
        end if;
    end loop;
    return replace(txt, quote_literal(old_key), quote_literal(new_key));
end $$;

-- Columns that can be copied from one row to another (not identity,
-- generated or sequence-numbered), minus the ones listed.
create or replace function public.lp__copyable_columns(p_table text, p_skip text[])
returns text[]
language sql
stable
as $$
    select coalesce(array_agg(column_name::text order by ordinal_position), '{}')
      from information_schema.columns
     where table_schema = 'public' and table_name = p_table
       and is_identity = 'NO' and is_generated = 'NEVER'
       and coalesce(column_default, '') not like 'nextval(%'
       and column_name <> all (p_skip)
$$;

-- Inserts one row built from a json object into a table, using only the
-- keys that are real columns (so a missing optional column never breaks it).
create or replace function public.lp__insert_json(p_table text, p_row jsonb)
returns void
language plpgsql
as $$
declare
    cols text;
begin
    select string_agg(quote_ident(c.column_name), ', ')
      into cols
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = p_table
       and p_row ? c.column_name;
    if cols is null then
        return;
    end if;
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)',
                   p_table, cols, cols, p_table)
    using p_row;
end $$;

-- Copies one table's structure (no rows) to a new name.
create or replace function public.lp__clone_table(
    p_src text, p_dst text, old_prefix text, new_prefix text, old_key text, new_key text)
returns void
language plpgsql
as $$
declare
    src_oid oid := format('public.%I', p_src)::regclass::oid;
    r record;
    seq text;
    def text;
begin
    execute format('create table public.%I (like public.%I including all)', p_dst, p_src);

    -- serial columns: their own sequence, not the source table's
    for r in
        select column_name from information_schema.columns
         where table_schema = 'public' and table_name = p_dst
           and column_default like 'nextval(%'
    loop
        seq := left(p_dst || '_' || r.column_name, 59) || '_seq';
        execute format('create sequence public.%I owned by public.%I.%I', seq, p_dst, r.column_name);
        execute format('alter table public.%I alter column %I set default nextval(%L::regclass)',
                       p_dst, r.column_name, 'public.' || quote_ident(seq));
    end loop;

    -- foreign keys (LIKE never copies them)
    for r in
        select conname, pg_get_constraintdef(oid) as def
          from pg_constraint where conrelid = src_oid and contype = 'f'
    loop
        execute format('alter table public.%I add constraint %I %s', p_dst,
                       public.lp__rewrite_refs(r.conname, old_prefix, new_prefix, old_key, new_key),
                       public.lp__rewrite_refs(r.def, old_prefix, new_prefix, old_key, new_key));
    end loop;

    -- row-level security and its policies
    if (select relrowsecurity from pg_class where oid = src_oid) then
        execute format('alter table public.%I enable row level security', p_dst);
    end if;
    if (select relforcerowsecurity from pg_class where oid = src_oid) then
        execute format('alter table public.%I force row level security', p_dst);
    end if;
    for r in
        select * from pg_policies where schemaname = 'public' and tablename = p_src
    loop
        def := format('create policy %I on public.%I as %s for %s to %s',
                      r.policyname, p_dst, r.permissive, r.cmd,
                      (select string_agg(case when x = 'public' then 'public' else quote_ident(x) end, ', ')
                         from unnest(r.roles) x));
        if r.qual is not null then
            def := def || ' using (' || public.lp__rewrite_refs(r.qual, old_prefix, new_prefix, old_key, new_key) || ')';
        end if;
        if r.with_check is not null then
            def := def || ' with check (' || public.lp__rewrite_refs(r.with_check, old_prefix, new_prefix, old_key, new_key) || ')';
        end if;
        execute def;
    end loop;

    -- triggers (e.g. the deletion log, which is told the project key)
    for r in
        select pg_get_triggerdef(oid) as def from pg_trigger
         where tgrelid = src_oid and not tgisinternal
    loop
        execute public.lp__rewrite_refs(r.def, old_prefix, new_prefix, old_key, new_key);
    end loop;

    -- grants to the API roles
    for r in
        select grantee, privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = p_src
           and grantee in ('anon', 'authenticated', 'service_role')
    loop
        execute format('grant %s on public.%I to %I', r.privilege_type, p_dst, r.grantee);
    end loop;

    -- realtime
    if (select relreplident from pg_class where oid = src_oid) = 'f' then
        execute format('alter table public.%I replica identity full', p_dst);
    end if;
    if exists (select 1 from pg_publication_tables
                where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = p_src) then
        execute format('alter publication supabase_realtime add table public.%I', p_dst);
    end if;
end $$;

revoke all on function public.lp__rewrite_refs(text, text, text, text, text) from public;
revoke all on function public.lp__copyable_columns(text, text[]) from public;
revoke all on function public.lp__insert_json(text, jsonb) from public;
revoke all on function public.lp__clone_table(text, text, text, text, text, text) from public;

-- 3. Functions the browser calls (owner only) --------------------------------

-- Every project, for the "copy from" choices, with the tables it has.
create or replace function public.lp_owner_projects()
returns table (project_key text, project_name text, client_name text, table_prefix text, tables text[])
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.lp_is_platform_owner() then
        raise exception 'Only the platform owner can do this' using errcode = '42501';
    end if;
    return query
        select p.project_key::text, p.project_name::text, p.client_name::text, p.table_prefix::text,
               array(select s from unnest(public.lp__project_table_suffixes()) s
                      where to_regclass(format('public.%I', p.table_prefix || s)) is not null)
          from launchpad_projects p
         order by p.client_name, p.project_name;
end $$;

-- The settings that can be copied, as (part, table).
create or replace function public.lp__settings_tables()
returns table (part text, tbl text)
language sql
immutable
as $$
    values ('schedule', 'launchpad_schedule_config'),
           ('navigation', 'launchpad_nav_config'),
           ('equivalent_activities', 'launchpad_equivalent_activities'),
           ('tamper_seals', 'launchpad_tamperseal_config'),
           ('equipment_tracker', 'launchpad_equipment_tracker_config')
$$;

-- Copies the chosen settings from one project to another.
--   p_parts: any of schedule, navigation, equivalent_activities,
--            tamper_seals, equipment_tracker, dropdowns
--   p_lists: for dropdowns, which lists (Times, Places, Activities, Assets,
--            Trade_Partners, Results, Zone)
-- Settings rows are written the way Save writes them (one row per project);
-- the target keeps its own choice of dropdown table.
-- Dropdown options are only ever added, into whichever table the target
-- project uses for its dropdowns. Returns what was copied.
create or replace function public.lp_copy_project_settings(
    p_from text, p_to text, p_parts text[], p_lists text[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    from_prefix text;
    to_prefix text;
    s record;
    cols text[];
    col_list text;
    copied jsonb := '[]'::jsonb;
    me text := lower(coalesce(auth.email(), ''));
    l text;
    n integer := 0;
    k integer;
    has_row boolean;
    use_shared boolean;
    from_shared boolean;
    keep_source jsonb;
begin
    if not public.lp_is_platform_owner() then
        raise exception 'Only the platform owner can do this' using errcode = '42501';
    end if;
    select table_prefix into from_prefix from launchpad_projects where project_key = p_from;
    select table_prefix into to_prefix from launchpad_projects where project_key = p_to;
    if from_prefix is null or to_prefix is null then
        raise exception 'Unknown project (% or %)', p_from, p_to;
    end if;
    if p_from = p_to then
        raise exception 'Pick a different project to copy from';
    end if;

    for s in select * from public.lp__settings_tables() where part = any (p_parts) loop
        if to_regclass('public.' || s.tbl) is null then
            continue;
        end if;
        execute format('select exists (select 1 from public.%I where project_key = $1)', s.tbl)
           into has_row using p_from;
        if not has_row then
            copied := copied || jsonb_build_object('part', s.part, 'result', 'nothing saved in the source project');
            continue;
        end if;
        -- Which dropdown table the target uses (ARC-238) is its own choice,
        -- never copied: it's put back after the navigation settings.
        if s.tbl = 'launchpad_nav_config' then
            select sidebar_config -> 'dropdownSource' into keep_source
              from launchpad_nav_config where project_key = p_to;
        end if;
        cols := public.lp__copyable_columns(s.tbl, array['project_key']);
        select string_agg(quote_ident(c), ', ') into col_list from unnest(cols) c;
        execute format('select exists (select 1 from public.%I where project_key = $1)', s.tbl)
           into has_row using p_to;
        if has_row then
            execute format('update public.%I t set (%s) = (select %s from public.%I f where f.project_key = $1) where t.project_key = $2',
                           s.tbl, col_list, col_list, s.tbl)
            using p_from, p_to;
        else
            execute format('insert into public.%I (project_key, %s) select $2, %s from public.%I where project_key = $1',
                           s.tbl, col_list, col_list, s.tbl)
            using p_from, p_to;
        end if;
        if s.tbl = 'launchpad_nav_config' then
            update launchpad_nav_config
               set sidebar_config = (sidebar_config::jsonb - 'dropdownSource')
                                    || case when keep_source is null or keep_source = 'null'::jsonb then '{}'::jsonb
                                       else jsonb_build_object('dropdownSource', keep_source) end
             where project_key = p_to;
        end if;
        if 'updated_by' = any (cols) then
            execute format('update public.%I set updated_by = $1 where project_key = $2', s.tbl) using me, p_to;
        end if;
        if 'updated_at' = any (cols) then
            execute format('update public.%I set updated_at = now() where project_key = $1', s.tbl) using p_to;
        end if;
        copied := copied || jsonb_build_object('part', s.part, 'result', 'copied');
    end loop;

    -- Dropdown lists: read from the table the source project uses, add any
    -- value the target doesn't have yet to the table the target uses.
    if 'dropdowns' = any (p_parts) and coalesce(array_length(p_lists, 1), 0) > 0 then
        from_shared := to_regprocedure('public.lp_dropdown_source(text)') is not null
                       and public.lp_dropdown_source(p_from) = 'shared';
        use_shared := to_regprocedure('public.lp_dropdown_source(text)') is not null
                      and public.lp_dropdown_source(p_to) = 'shared';
        create temporary table if not exists lp__opts (list text, value text, place text, zone text) on commit drop;
        truncate lp__opts;
        if from_shared then
            insert into lp__opts
                select o.list, o.value, o.place, o.zone from launchpad_dropdown_options_current o
                 where o.project_key = p_from and o.active and o.list = any (p_lists);
        elsif to_regclass(format('public.%I', from_prefix || 'dropdownoptions')) is not null then
            foreach l in array p_lists loop
                execute format($f$
                    insert into lp__opts
                    select distinct on (lower(btrim(j ->> %L))) %L, btrim(j ->> %L),
                           case when %L = 'Assets' then nullif(btrim(j ->> 'Places'), '') end,
                           case when %L = 'Assets' then nullif(btrim(j ->> 'Zone'), '') end
                      from (select to_jsonb(t) j from public.%I t) x
                     where nullif(btrim(j ->> %L), '') is not null
                     order by lower(btrim(j ->> %L))
                $f$, l, l, l, l, l, from_prefix || 'dropdownoptions', l, l);
            end loop;
        end if;

        if use_shared then
            insert into launchpad_dropdown_options
                   (project_key, list, value, place, zone, source, active, note, changed_by)
            select p_to, o.list, o.value, o.place, o.zone, 'manual', true, 'Copied from ' || p_from, me
              from lp__opts o
             where not exists (select 1 from launchpad_dropdown_options_current c
                                where c.project_key = p_to and c.list = o.list
                                  and lower(c.value) = lower(o.value) and c.active);
            get diagnostics n = row_count;
        elsif to_regclass(format('public.%I', to_prefix || 'dropdownoptions')) is not null then
            foreach l in array p_lists loop
                execute format($f$
                    insert into public.%I (%I %s)
                    select o.value %s from lp__opts o
                     where o.list = %L
                       and not exists (select 1 from public.%I d where lower(btrim(d.%I::text)) = lower(o.value))
                $f$,
                to_prefix || 'dropdownoptions', l,
                case when l = 'Assets' then ', "Places", "Zone"' else '' end,
                case when l = 'Assets' then ', o.place, o.zone' else '' end,
                l, to_prefix || 'dropdownoptions', l);
                get diagnostics k = row_count;
                n := n + k;
            end loop;
        end if;
        copied := copied || jsonb_build_object('part', 'dropdowns', 'result', format('%s option(s) added', n));
    end if;

    return copied;
end $$;

-- Creates a project. p is a json object:
--   project_key*       letters and digits, starting with a letter (also the
--                      table prefix)
--   project_name*, client_name*
--   structure_from*    the project whose tables to copy the structure of
--   start_date*, duration_weeks*
--   google_script_url, logo_url, theme_color      (optional)
--   admin_email        defaults to the caller
--   admins             more admin emails (array)
--   company            the admins' company (default 'CriticalArc')
--   settings_from      project to copy settings from (default structure_from)
--   copy_parts, copy_lists   what to copy (see lp_copy_project_settings)
-- Returns { project_key, access_code, tables, settings }.
create or replace function public.lp_create_project(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    me text := lower(coalesce(auth.email(), ''));
    new_key text := btrim(coalesce(p ->> 'project_key', ''));
    src_key text := btrim(coalesce(p ->> 'structure_from', ''));
    src launchpad_projects;
    code text;
    proj jsonb;
    s text;
    tables text[] := '{}';
    admins text[];
    a text;
    company text := coalesce(nullif(btrim(p ->> 'company'), ''), 'CriticalArc');
    admin_email text := lower(coalesce(nullif(btrim(p ->> 'admin_email'), ''), me));
    settings jsonb := '[]'::jsonb;
begin
    if not public.lp_is_platform_owner() then
        raise exception 'Only the platform owner can create projects' using errcode = '42501';
    end if;

    -- Check everything before changing anything.
    if new_key !~ '^[A-Za-z][A-Za-z0-9]{1,15}$' then
        raise exception 'Project key must be 2 to 16 letters or digits, starting with a letter';
    end if;
    if exists (select 1 from launchpad_projects where lower(project_key) = lower(new_key)
                                                    or lower(table_prefix) = lower(new_key)) then
        raise exception 'A project with key % already exists', new_key;
    end if;
    foreach s in array public.lp__project_table_suffixes() loop
        if exists (select 1 from pg_tables where schemaname = 'public' and lower(tablename) = lower(new_key || s)) then
            raise exception 'A table named % already exists', new_key || s;
        end if;
    end loop;
    if nullif(btrim(p ->> 'project_name'), '') is null or nullif(btrim(p ->> 'client_name'), '') is null then
        raise exception 'Project name and client name are required';
    end if;
    if nullif(p ->> 'start_date', '') is null or coalesce((p ->> 'duration_weeks')::int, 0) < 1 then
        raise exception 'Start date and a duration of at least 1 week are required';
    end if;
    if admin_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'Admin email % is not a valid email', admin_email;
    end if;
    select * into src from launchpad_projects where project_key = src_key;
    if src.project_key is null then
        raise exception 'Pick an existing project to copy the tables from';
    end if;
    if to_regclass(format('public.%I', src.table_prefix || 'authorized_editors')) is null then
        raise exception 'Project % has no authorized_editors table to copy', src_key;
    end if;

    -- A 6-digit access code no other project has.
    loop
        code := lpad((floor(random() * 900000) + 100000)::int::text, 6, '0');
        exit when not exists (select 1 from launchpad_projects where access_code::text = code);
    end loop;

    -- 1. The project row. From the source project only the layout choices
    -- (unified schedule, colour, length) carry over; nothing that ties the
    -- new project to the old one's Sheet, calendar or logo.
    proj := jsonb_strip_nulls(jsonb_build_object(
        'project_key', new_key,
        'table_prefix', new_key,
        'project_name', btrim(p ->> 'project_name'),
        'client_name', btrim(p ->> 'client_name'),
        'start_date', p ->> 'start_date',
        'duration_weeks', (p ->> 'duration_weeks')::int,
        'google_script_url', nullif(btrim(p ->> 'google_script_url'), ''),
        'logo_url', nullif(btrim(p ->> 'logo_url'), ''),
        'theme_color', coalesce(nullif(btrim(p ->> 'theme_color'), ''), to_jsonb(src) ->> 'theme_color'),
        'admin_email', admin_email,
        'access_code', code,
        'unified_schedule', to_jsonb(src) -> 'unified_schedule'));
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'launchpad_projects' and column_name = 'public_uuid') then
        proj := proj || jsonb_build_object('public_uuid', gen_random_uuid());
    end if;
    perform public.lp__insert_json('launchpad_projects', proj);

    -- 2. The project's tables, shaped like the source project's.
    foreach s in array public.lp__project_table_suffixes() loop
        if to_regclass(format('public.%I', src.table_prefix || s)) is not null then
            perform public.lp__clone_table(src.table_prefix || s, new_key || s,
                                           src.table_prefix, new_key, src.project_key, new_key);
            tables := tables || (new_key || s);
        end if;
    end loop;

    -- 3. Admins.
    admins := array[admin_email];
    if me <> '' and me <> admin_email then
        admins := admins || me;
    end if;
    if jsonb_typeof(p -> 'admins') = 'array' then
        for a in select lower(btrim(x)) from jsonb_array_elements_text(p -> 'admins') x loop
            if a ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and a <> all (admins) then
                admins := admins || a;
            end if;
        end loop;
    end if;
    foreach a in array admins loop
        perform public.lp__insert_json(new_key || 'authorized_editors',
            jsonb_build_object('email', a, 'role', 'admin', 'is_admin', true, 'company', company));
        if to_regclass('public.launchpad_memberships') is not null
           and not exists (select 1 from launchpad_memberships where lower(email) = a and project_key = new_key) then
            perform public.lp__insert_json('launchpad_memberships',
                jsonb_build_object('email', a, 'project_key', new_key, 'is_admin', true, 'company', company));
        end if;
    end loop;

    -- 4. Settings.
    if jsonb_typeof(p -> 'copy_parts') = 'array' and jsonb_array_length(p -> 'copy_parts') > 0 then
        settings := public.lp_copy_project_settings(
            coalesce(nullif(btrim(p ->> 'settings_from'), ''), src_key),
            new_key,
            array(select jsonb_array_elements_text(p -> 'copy_parts')),
            coalesce(array(select jsonb_array_elements_text(p -> 'copy_lists')), '{}'));
    end if;

    return jsonb_build_object('project_key', new_key, 'access_code', code,
                              'tables', to_jsonb(tables), 'admins', to_jsonb(admins),
                              'settings', settings);
end $$;

revoke all on function public.lp_is_platform_owner() from public;
revoke all on function public.lp_owner_projects() from public;
revoke all on function public.lp_copy_project_settings(text, text, text[], text[]) from public;
revoke all on function public.lp_create_project(jsonb) from public;
grant execute on function public.lp_is_platform_owner() to authenticated;
grant execute on function public.lp_owner_projects() to authenticated;
grant execute on function public.lp_copy_project_settings(text, text, text[], text[]) to authenticated;
grant execute on function public.lp_create_project(jsonb) to authenticated;
