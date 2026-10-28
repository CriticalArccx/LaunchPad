-- Row-level security for every project's "{prefix}authorized_editors" table.
--
-- Run in the Supabase SQL editor. Safe to re-run: it rebuilds the INSERT and
-- UPDATE policies on every table whose name ends in authorized_editors, each
-- one checking ITS OWN table, so a policy can never point at another
-- project's editors. Re-run it after creating a new project's tables.
--
-- Who counts as an admin matches the app's editorRole() in index.html:
-- the row's role, or is_admin when role is empty.
--
-- SELECT stays open (the login flow checks membership before sign-in).
-- There is deliberately no DELETE policy: editor rows are not hard-deleted.

-- 1. Check (read-only). Lists each INSERT/UPDATE policy on an editor table
--    and whether its check references only its own table. Any row with
--    own_table_only = false, or a missing UPDATE/INSERT row, needs step 2.
select p.tablename,
       p.cmd,
       p.policyname,
       regexp_replace(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''),
                      '\m' || p.tablename || '\M', '', 'g') !~ 'authorized_editors'
         as own_table_only
from pg_policies p
where p.schemaname = 'public'
  and p.tablename like '%authorized_editors'
  and p.cmd in ('INSERT', 'UPDATE')
order by p.tablename, p.cmd;

-- 2. Fix. Rebuilds both policies on every editor table.
do $$
declare
    t text;
    is_admin_check text;
begin
    for t in
        select tablename from pg_tables
        where schemaname = 'public' and tablename like '%authorized_editors'
    loop
        is_admin_check := format(
            'exists (select 1 from public.%I e
                     where lower(e.email) = lower(auth.email())
                       and coalesce(e.role, case when e.is_admin then ''admin'' else ''editor'' end) = ''admin'')',
            t);

        execute format('drop policy if exists "Allow admin to add new editors" on public.%I', t);
        execute format(
            'create policy "Allow admin to add new editors" on public.%I
             for insert to authenticated with check (%s)', t, is_admin_check);

        execute format('drop policy if exists "authenticated_can_update_members" on public.%I', t);
        execute format('drop policy if exists "Allow admin to update editors" on public.%I', t);
        execute format(
            'create policy "Allow admin to update editors" on public.%I
             for update to authenticated using (%s) with check (%s)', t, is_admin_check, is_admin_check);
    end loop;
end $$;
