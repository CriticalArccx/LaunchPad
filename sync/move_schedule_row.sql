-- Run this once in the Supabase SQL editor. It backs Bridge's LaunchPad
-- push (bridge-view.js: _syncItemToLaunchPadCore()) for the case where an
-- activity's date changes and its row therefore needs a new day-encoded id
-- (LaunchPad's own id scheme bakes the date into the id itself — see
-- launchPadNumericId() in bridge-view.js — so a date change can't be a
-- plain same-row UPDATE; it has to become a different row).
--
-- Before this function existed, that was two separate round-trips from the
-- browser (upsert the new row, then delete the old one). Each step could
-- succeed or fail independently — a dropped connection, a closed tab, or
-- two overlapping moves between those two calls could leave the new row
-- written but the old one never cleaned up, which is exactly the "moved,
-- but the old one is still there" bug. Wrapping both writes in one plpgsql
-- function makes Postgres run them as a single transaction: either the new
-- row lands AND the old one is removed, or neither happens — there's no
-- window where only half of the move can be observed.
--
-- p_place/p_trade_partners added per request: Bridge's Area/Contractor(s)
-- (bulk add and the single-item modal both collect them now) weren't
-- reaching Schedule's own Place/Trade Partners columns on this, the
-- day-changing move path — itemToLaunchPadRow() was updated to include
-- them, but this RPC's fixed column list silently dropped them again.
-- Dropped and recreated (not CREATE OR REPLACE) since adding parameters
-- changes the signature, which OR REPLACE can't do in place.
--
-- SECURITY INVOKER (the default — deliberately not DEFINER): this runs
-- with the CALLING role's own permissions, so it can only do what that
-- role could already do by calling insert/update/delete directly — no
-- privilege escalation. Row Level Security on the target table still
-- applies exactly as it would without this function. The table-name
-- allowlist check below is an extra guard specifically because the table
-- name is a parameter (dynamic per project, "{PROJECT_KEY}BackEndData") —
-- it only accepts names that already match that naming convention.
drop function if exists move_schedule_row(text, bigint, bigint, text, text, text, text);

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
        execute format('delete from %I where id = $1', p_table) using p_old_id;
    end if;
end;
$$;

-- Matches how the browser already authenticates when writing to
-- {PROJECT_KEY}BackEndData directly (anon key, RLS-gated) — this function
-- doesn't grant anything beyond what that role can already do per-row.
grant execute on function move_schedule_row(text, bigint, bigint, text, text, text, text, text, text) to anon, authenticated;
