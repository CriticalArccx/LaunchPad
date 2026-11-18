-- Run this once in the Supabase SQL editor, after sync/schedule_line_status.sql.
--
-- Backs the History list in Bridge's detail panel (ARC-451): every Schedule
-- line for one asset + activity, including the copies kept when a line is
-- moved to another day or removed. Those copies are hidden from the app by
-- the "Hide non-live schedule lines" read policy; this function reads them
-- the same way lp_schedule_deleted_lines() does.
--
-- Read only. SECURITY INVOKER: it runs with the caller's own rights, so row
-- level security still applies and it can't show a project's lines to
-- someone who couldn't already read them. Returns only the columns the
-- history needs.
create or replace function lp_schedule_line_history(p_table text, p_asset text, p_activity text)
returns setof jsonb
language plpgsql
security invoker
as $$
begin
    if p_table !~ '^[A-Za-z0-9_]+BackEndData$' then
        raise exception 'lp_schedule_line_history: refusing unrecognized table name %', p_table;
    end if;
    perform set_config('launchpad.show_removed', 'on', true);
    return query execute format(
        'select jsonb_build_object(
             ''id'', j->''id'', ''day_label'', j->''day_label'', ''result'', j->''result'',
             ''line_status'', j->''line_status'', ''original_id'', j->''original_id'',
             ''deleted_at'', j->''deleted_at'', ''deleted_by'', j->''deleted_by'',
             ''restored_at'', j->''restored_at'', ''restored_by'', j->''restored_by'',
             ''superseded_by'', j->''superseded_by'')
         from (select to_jsonb(t) as j from public.%I t where t.asset = $1 and t.activity = $2) s
         order by j->>''day_label'', (j->>''id'')::bigint
         limit 300', p_table)
        using p_asset, p_activity;
end;
$$;

grant execute on function lp_schedule_line_history(text, text, text) to anon, authenticated;
