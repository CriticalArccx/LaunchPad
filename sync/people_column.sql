-- Run this once in the Supabase SQL editor before turning on the Schedule's
-- People column (ARC-175) in any project. Adds a nullable "people" text
-- column to every project's BackEndData table. It holds the same
-- " | "-joined format as trade_partners: member emails, picked from the
-- project's authorized_editors and narrowed to the row's Trade Partners.
--
-- Additive only, and safe to re-run (skips tables that already have it).
-- Re-run after creating a new project's tables.

-- 1. Add the column to every BackEndData table.
do $$
declare
    t text;
begin
    for t in
        select tablename from pg_tables
        where schemaname = 'public' and tablename like '%BackEndData'
    loop
        execute format('alter table public.%I add column if not exists people text', t);
    end loop;
end $$;

-- 2. Unified projects: Bridge's day-changing move (move_unified_schedule_row)
--    re-inserts the row and copies Schedule-only fields forward. Same
--    function as sync/unify_backend_schedule.sql, plus people, so a Bridge
--    move doesn't wipe it. Run after step 1. Before running, compare with
--    the live version (read-only):
--      select pg_get_functiondef('move_unified_schedule_row'::regproc);
--    and stop if it differs from unify_backend_schedule.sql's.

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
        execute format('delete from %I where id = $1', p_table) using p_old_id;
    end if;
end;
$$;

grant execute on function move_unified_schedule_row(text, bigint, bigint, text, text, text, text, text, text, numeric, text, text, text, jsonb) to anon, authenticated;
