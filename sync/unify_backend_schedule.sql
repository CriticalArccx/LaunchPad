-- ============================================================================
-- sync/unify_backend_schedule.sql
--
-- Merges Bridge's "{prefix}schedule_items" table into Scheduler's
-- "{prefix}BackEndData" table, for every project in launchpad_projects, so
-- both apps read/write ONE table directly and the whole push/pull sync
-- layer in bridge-view.js (pullFromLaunchPad, repairLaunchPadLinks,
-- _syncItemToLaunchPadCore, move_schedule_row) becomes unnecessary for any
-- project that's been migrated.
--
-- SAFETY — read this before running:
--   - Every change this script makes to "{prefix}BackEndData" is ADDITIVE
--     ONLY: five new nullable columns, and an UPDATE that touches ONLY
--     those five columns. None of BackEndData's 11 existing columns (id,
--     day_label, time, place, activity, asset, status, trade_partners,
--     result, notes, duration, loto) are ever read, altered, or
--     overwritten by this script, and no row is ever deleted from it.
--   - "{prefix}schedule_items" is left in place for every project — this
--     script never drops it. It's referenced as a one-time data source for
--     the backfill (step 3) and then never touched again once a project's
--     flag flips. A commented-out cleanup statement is at the very bottom
--     for later, once you've confirmed things work.
--   - Each project is migrated independently. If a project's precondition
--     check fails (its schedule_items rows aren't fully linked yet, or it
--     has no schedule_items table at all), that project is SKIPPED — not
--     aborted — and keeps working exactly as it does today. Nothing about
--     one project's data can block another project's migration, or the
--     schema step (1) for every project.
--
-- BEFORE RUNNING: for each project, open Bridge and let its two existing,
-- already-automatic functions finish — repairLaunchPadLinks() (runs on
-- every load) and a full "Sync All to LaunchPad" pass — so every
-- schedule_items row has a launchpad_id set. Step 3 below checks this
-- itself and skips any project where it isn't true yet, so re-running this
-- whole script later is always safe.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Schema — additive only. Safe to run any time, safe to re-run.
-- ---------------------------------------------------------------------------
alter table launchpad_projects add column if not exists unified_schedule boolean not null default false;

do $$
declare
    proj record;
begin
    for proj in select table_prefix from launchpad_projects loop
        execute format(
            'alter table %I
                add column if not exists duration_hours numeric,
                add column if not exists bridge_type text,
                add column if not exists area text,
                add column if not exists asset_type text,
                add column if not exists predecessor_ids jsonb default ''[]''::jsonb',
            proj.table_prefix || 'BackEndData'
        );
    end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. New RPC, created once, used by every unified project (bridge-view.js
--    passes "{prefix}BackEndData" as p_table). Unlike the existing
--    move_schedule_row (which only carries 5 columns — fine when
--    BackEndData was a disposable shadow copy), this carries the FULL
--    column set: it copies time/status/result/duration/loto forward from
--    the OLD row untouched (those are Scheduler-owned fields Bridge
--    doesn't know about), while every other column takes Bridge's new
--    value, on the new id/day_label. Reusing the old function post-merge
--    would silently wipe those Scheduler-owned fields on every day-
--    changing move — this is what prevents that.
-- ---------------------------------------------------------------------------
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
                          trade_partners, result, notes, duration, loto,
                          duration_hours, bridge_type, area, asset_type, predecessor_ids)
         select $2, $3, time, $4, $5, $6, status,
                $7, result, $8, duration, loto,
                $9, $10, $11, $12, $13
         from %I where id = $1
         on conflict (id) do update set
             day_label = excluded.day_label, time = excluded.time, place = excluded.place,
             activity = excluded.activity, asset = excluded.asset, status = excluded.status,
             trade_partners = excluded.trade_partners, result = excluded.result,
             notes = excluded.notes, duration = excluded.duration, loto = excluded.loto,
             duration_hours = excluded.duration_hours, bridge_type = excluded.bridge_type,
             area = excluded.area, asset_type = excluded.asset_type,
             predecessor_ids = excluded.predecessor_ids',
        p_table, p_table
    ) using p_old_id, p_new_id, p_day_label, p_place, p_activity, p_asset,
            p_trade_partners, p_notes, p_duration_hours, p_bridge_type, p_area, p_asset_type, p_predecessor_ids;

    if p_old_id is not null and p_old_id <> p_new_id then
        -- Keeps the old copy as 'moved', not 'deleted' (sync/schedule_line_status.sql).
        perform set_config('launchpad.line_removal', 'moved', true);
        execute format('delete from %I where id = $1', p_table) using p_old_id;
    end if;
end;
$$;

grant execute on function move_unified_schedule_row(text, bigint, bigint, text, text, text, text, text, text, numeric, text, text, text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Per-project precondition check, backfill, and flag flip. Re-runnable:
--    only projects where unified_schedule is still false are considered,
--    so this can safely be re-run after fixing whatever caused a project
--    to be skipped.
-- ---------------------------------------------------------------------------
do $$
declare
    proj record;
    items_table text;
    backend_table text;
    unresolved_count int;
begin
    for proj in select project_key, table_prefix from launchpad_projects where not unified_schedule loop
        items_table := proj.table_prefix || 'schedule_items';
        backend_table := proj.table_prefix || 'BackEndData';

        if to_regclass(format('public.%I', items_table)) is null then
            raise notice 'Skipping %: no % table found (nothing to migrate — this project may already be BackEndData-only)', proj.project_key, items_table;
            continue;
        end if;

        execute format('select count(*) from %I where launchpad_id is null', items_table) into unresolved_count;
        if unresolved_count > 0 then
            raise notice 'Skipping %: % row(s) in % have no launchpad_id yet — open Bridge for this project (repairLaunchPadLinks + Sync All run automatically), then re-run this script', proj.project_key, unresolved_count, items_table;
            continue;
        end if;

        -- Only the 5 new columns are set below — every existing BackEndData
        -- column (b.*) is left exactly as it was; nothing here can lose
        -- Scheduler data. predecessor_ids is remapped from schedule_items'
        -- uuids to the corresponding launchpad_id (bigint) of each
        -- predecessor, by joining each predecessor uuid back to its own
        -- schedule_items row to read its launchpad_id.
        execute format(
            'update %I as b
                set duration_hours = s.duration_hours,
                    bridge_type = s.type,
                    area = s.area,
                    asset_type = s.asset_type,
                    predecessor_ids = coalesce(
                        (select jsonb_agg(pred_row.launchpad_id)
                         from jsonb_array_elements_text(coalesce(s.predecessor_ids, ''[]''::jsonb)) as pred(val)
                         join %I as pred_row on pred_row.id = pred.val::uuid),
                        ''[]''::jsonb
                    )
                from %I as s
                where b.id = s.launchpad_id',
            backend_table, items_table, items_table
        );

        execute format('update launchpad_projects set unified_schedule = true where project_key = %L', proj.project_key);
        raise notice 'Migrated %: % is now the single source of truth for schedule items', proj.project_key, backend_table;
    end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. OPTIONAL cleanup — NOT run by this script. Run these yourself, later,
--    one project at a time, only once you've used Bridge + Scheduler
--    against that project's BackEndData for a while and are confident
--    nothing needs schedule_items anymore. table_prefix comes from that
--    project's own launchpad_projects row.
-- ---------------------------------------------------------------------------
-- drop table "{table_prefix}schedule_items";
