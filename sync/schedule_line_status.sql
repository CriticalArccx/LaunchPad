-- Run this once in the Supabase SQL editor (ARC-298). Deleting a Schedule
-- line no longer removes it from the database. Every project's BackEndData
-- table gets a line_status column, and a deleted line stays in the table
-- with line_status = 'deleted', who deleted it and when.
--
-- Why a copy on a free id, not a flag on the row itself: a Schedule row's
-- id is its slot, date * 100 + row number (2026-04-20 row 5 = 2026042005).
-- Leaving a deleted row on its id would block that slot, and the next line
-- typed into it would overwrite the deleted one. So a BEFORE DELETE trigger
-- copies the row to a negative id (its old id kept in original_id), then
-- lets the delete of the slot go ahead. The slot is free, the line is kept.
--
-- line_status values:
--   live      a normal Schedule line (every existing row, and every new one)
--   deleted   deleted by someone; shown in Schedule's "Deleted lines" list
--   moved     the old copy left behind when a line moved to another day
--   restored  a deleted line that was put back (restored_to_id = its new id)
--
-- Only 'live' lines are visible to the app: a restrictive read policy hides
-- the rest, so Schedule, Bridge, Power Flow and the calendar feed need no
-- changes. The service-key sync jobs bypass row security, so they filter on
-- line_status themselves (sync/clean-status-only-rows.mjs,
-- sync/snapshot-schedule-data.mjs).
--
-- Kept rows can't be deleted by anyone; the trigger refuses. The existing
-- deletion log (sync/deletion_audit.sql) keeps recording every delete too.
--
-- Safe to re-run, all or nothing. Re-run after creating a project's tables
-- by hand (projects made with "Add new project" copy all of this).
-- Run this BEFORE merging the app change that uses it.

begin;

-- 1. Every BackEndData table must already use row level security, or the
--    read policy below would hide nothing. Stop before changing anything.
do $$
declare
    missing text;
begin
    select string_agg(c.relname, ', ') into missing
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname like '%BackEndData' and not c.relrowsecurity;
    if missing is not null then
        raise exception 'Row level security is off on: %. Nothing was changed.', missing;
    end if;
end $$;

-- 2. Columns.
do $$
declare
    t text;
begin
    for t in
        select tablename from pg_tables
        where schemaname = 'public' and tablename like '%BackEndData'
    loop
        execute format(
            'alter table public.%I
                add column if not exists line_status text not null default ''live'',
                add column if not exists original_id bigint,
                add column if not exists deleted_at timestamptz,
                add column if not exists deleted_by text,
                add column if not exists restored_at timestamptz,
                add column if not exists restored_by text,
                add column if not exists restored_to_id bigint', t);
        if not exists (select 1 from pg_constraint
                       where conrelid = format('public.%I', t)::regclass
                         and conname = 'line_status_values') then
            execute format(
                'alter table public.%I add constraint line_status_values
                 check (line_status in (''live'', ''deleted'', ''moved'', ''restored''))', t);
        end if;
    end loop;
end $$;

-- Ids for kept copies. Negative, so they never fall in a day's slot range.
create sequence if not exists launchpad_schedule_kept_line_seq;

-- The signed-in user's email from the request, or null (sync jobs, editor).
create or replace function lp__request_email() returns text
language sql stable
as $$
    select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', '')
$$;

-- 3. The trigger. SECURITY DEFINER so the kept copy is always written, even
--    though the app's role can't read or write non-live rows itself.
--    launchpad.line_removal is set to 'moved' by the move functions below
--    and by lp_schedule_remove_line(); anything else counts as 'deleted'.
create or replace function lp_schedule_keep_deleted_line() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    reason text := coalesce(nullif(current_setting('launchpad.line_removal', true), ''), 'deleted');
    kept jsonb;
begin
    if OLD.line_status <> 'live' then
        raise exception 'Schedule line % is kept for history and can''t be deleted', OLD.id;
    end if;
    if reason not in ('deleted', 'moved') then
        reason := 'deleted';
    end if;
    kept := to_jsonb(OLD) || jsonb_build_object(
        'id', -nextval('launchpad_schedule_kept_line_seq'),
        'line_status', reason,
        'original_id', OLD.id,
        'deleted_at', now(),
        'deleted_by', lp__request_email());
    execute format('insert into public.%I select * from jsonb_populate_record(null::public.%I, $1)',
                   TG_TABLE_NAME, TG_TABLE_NAME)
        using kept;
    return OLD;
end;
$$;

-- 4. Trigger and read policy on every BackEndData table.
--    launchpad.show_removed is set only inside the two functions in step 6,
--    which run with the caller's own rights, so they can't show anything
--    the caller couldn't already read.
do $$
declare
    t text;
begin
    for t in
        select tablename from pg_tables
        where schemaname = 'public' and tablename like '%BackEndData'
    loop
        execute format('drop trigger if exists trg_keep_deleted_line on public.%I', t);
        execute format(
            'create trigger trg_keep_deleted_line before delete on public.%I
             for each row execute function lp_schedule_keep_deleted_line()', t);
        execute format('drop policy if exists "Hide non-live schedule lines" on public.%I', t);
        execute format(
            'create policy "Hide non-live schedule lines" on public.%I
             as restrictive for select
             using (line_status = ''live'' or current_setting(''launchpad.show_removed'', true) = ''on'')', t);
    end loop;
end $$;

-- 5. Moving a line to another day writes it to a new slot and deletes the
--    old one. That old copy is kept as 'moved', not 'deleted', so it doesn't
--    show up in the Deleted lines list. Same functions as
--    sync/move_schedule_row.sql and sync/people_column.sql, plus that one
--    set_config line.
create or replace function move_schedule_row(
    p_table text,
    p_old_id bigint,
    p_new_id bigint,
    p_day_label text,
    p_activity text,
    p_asset text,
    p_notes text,
    p_place text default '',
    p_trade_partners text default ''
) returns void
language plpgsql
security invoker
as $$
begin
    if p_table !~ '^[A-Za-z0-9_]+BackEndData$' then
        raise exception 'move_schedule_row: refusing unrecognized table name %', p_table;
    end if;

    execute format(
        'insert into %I (id, day_label, activity, asset, notes, place, trade_partners)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (id) do update set
             day_label = excluded.day_label,
             activity = excluded.activity,
             asset = excluded.asset,
             notes = excluded.notes,
             place = excluded.place,
             trade_partners = excluded.trade_partners',
        p_table
    ) using p_new_id, p_day_label, p_activity, p_asset, p_notes, p_place, p_trade_partners;

    if p_old_id is not null and p_old_id <> p_new_id then
        perform set_config('launchpad.line_removal', 'moved', true);
        execute format('delete from %I where id = $1', p_table) using p_old_id;
    end if;
end;
$$;

grant execute on function move_schedule_row(text, bigint, bigint, text, text, text, text, text, text) to anon, authenticated;

create or replace function move_unified_schedule_row(
    p_table text,
    p_old_id bigint,
    p_new_id bigint,
    p_day_label text,
    p_activity text,
    p_asset text,
    p_notes text,
    p_place text,
    p_trade_partners text,
    p_duration_hours numeric,
    p_bridge_type text,
    p_area text,
    p_asset_type text,
    p_predecessor_ids jsonb
) returns void
language plpgsql
security invoker
as $$
begin
    if p_table !~ '^[A-Za-z0-9_]+BackEndData$' then
        raise exception 'move_unified_schedule_row: refusing unrecognized table name %', p_table;
    end if;

    execute format(
        'insert into %I (id, day_label, time, place, activity, asset, status,
                          trade_partners, result, notes, duration, loto, people,
                          duration_hours, bridge_type, area, asset_type, predecessor_ids)
         select $2, $3, time, $4, $5, $6, status,
                $7, result, $8, duration, loto, people,
                $9, $10, $11, $12, $13
         from %I where id = $1
         on conflict (id) do update set
             day_label = excluded.day_label, time = excluded.time, place = excluded.place,
             activity = excluded.activity, asset = excluded.asset, status = excluded.status,
             trade_partners = excluded.trade_partners, result = excluded.result,
             notes = excluded.notes, duration = excluded.duration, loto = excluded.loto,
             people = excluded.people,
             duration_hours = excluded.duration_hours, bridge_type = excluded.bridge_type,
             area = excluded.area, asset_type = excluded.asset_type,
             predecessor_ids = excluded.predecessor_ids',
        p_table, p_table
    ) using p_old_id, p_new_id, p_day_label, p_place, p_activity, p_asset,
            p_trade_partners, p_notes, p_duration_hours, p_bridge_type, p_area, p_asset_type, p_predecessor_ids;

    if p_old_id is not null and p_old_id <> p_new_id then
        perform set_config('launchpad.line_removal', 'moved', true);
        execute format('delete from %I where id = $1', p_table) using p_old_id;
    end if;
end;
$$;

grant execute on function move_unified_schedule_row(text, bigint, bigint, text, text, text, text, text, text, numeric, text, text, text, jsonb) to anon, authenticated;

-- 6. App functions. All SECURITY INVOKER: they run with the caller's own
--    rights, so the table's existing policies still decide who can do what.

-- Deletes a line from the browser, saying why. Scheduler's Move uses
-- 'moved'; everything else should just delete as before.
create or replace function lp_schedule_remove_line(p_table text, p_id bigint, p_reason text default 'deleted')
returns void
language plpgsql
security invoker
as $$
begin
    if p_table !~ '^[A-Za-z0-9_]+BackEndData$' then
        raise exception 'lp_schedule_remove_line: refusing unrecognized table name %', p_table;
    end if;
    if p_reason not in ('deleted', 'moved') then
        raise exception 'lp_schedule_remove_line: reason must be deleted or moved';
    end if;
    perform set_config('launchpad.line_removal', p_reason, true);
    execute format('delete from public.%I where id = $1', p_table) using p_id;
end;
$$;

-- The project's deleted lines, newest first.
create or replace function lp_schedule_deleted_lines(p_table text)
returns setof jsonb
language plpgsql
security invoker
as $$
begin
    if p_table !~ '^[A-Za-z0-9_]+BackEndData$' then
        raise exception 'lp_schedule_deleted_lines: refusing unrecognized table name %', p_table;
    end if;
    perform set_config('launchpad.show_removed', 'on', true);
    return query execute format(
        'select to_jsonb(t) from public.%I t where line_status = ''deleted''
         order by deleted_at desc nulls last limit 500', p_table);
end;
$$;

-- Puts a deleted line back on its day: its old slot if that's still free,
-- otherwise the first free one. The kept copy is marked 'restored' and
-- stays as history. Returns the line's new id.
create or replace function lp_schedule_restore_line(p_table text, p_id bigint)
returns bigint
language plpgsql
security invoker
as $$
declare
    kept jsonb;
    day text;
    base bigint;
    old_id bigint;
    new_id bigint;
    i int;
begin
    if p_table !~ '^[A-Za-z0-9_]+BackEndData$' then
        raise exception 'lp_schedule_restore_line: refusing unrecognized table name %', p_table;
    end if;
    perform set_config('launchpad.show_removed', 'on', true);

    execute format('select to_jsonb(t) from public.%I t where id = $1 and line_status = ''deleted'' for update', p_table)
        into kept using p_id;
    if kept is null then
        raise exception 'That line isn''t in the deleted list any more (it may already be restored).';
    end if;

    day := kept ->> 'day_label';
    if day is null or day !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'This line has no date, so it can''t be put back on the Schedule.';
    end if;
    base := replace(day, '-', '')::bigint * 100;
    old_id := (kept ->> 'original_id')::bigint;

    perform set_config('launchpad.show_removed', '', true);
    if old_id between base and base + 98 then
        execute format('select case when exists (select 1 from public.%I where id = $1) then null else $1 end', p_table)
            into new_id using old_id;
    end if;
    if new_id is null then
        for i in 0..98 loop
            execute format('select case when exists (select 1 from public.%I where id = $1) then null else $1 end', p_table)
                into new_id using base + i;
            exit when new_id is not null;
        end loop;
    end if;
    if new_id is null then
        raise exception 'Every row on % is taken. Clear a row on that day, then restore again.', day;
    end if;

    execute format('insert into public.%I select * from jsonb_populate_record(null::public.%I, $1)', p_table, p_table)
        using kept - 'deleted_at' - 'deleted_by' - 'restored_at' - 'restored_by' - 'restored_to_id'
              || jsonb_build_object('id', new_id, 'line_status', 'live', 'original_id', null,
                                    'draft', null, 'draft_deleted', false);

    perform set_config('launchpad.show_removed', 'on', true);
    execute format('update public.%I set line_status = ''restored'', restored_at = now(),
                        restored_by = $2, restored_to_id = $3 where id = $1', p_table)
        using p_id, lp__request_email(), new_id;
    return new_id;
end;
$$;

grant execute on function lp_schedule_remove_line(text, bigint, text) to anon, authenticated;
grant execute on function lp_schedule_deleted_lines(text) to anon, authenticated;
grant execute on function lp_schedule_restore_line(text, bigint) to anon, authenticated;

commit;
