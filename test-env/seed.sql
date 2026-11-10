-- Test database starter data (ARC-326). Run by test-env/setup-test-db.mjs,
-- only ever against the TEST Supabase project, after the production table
-- structure (no rows) has been loaded into it. Safe to re-run.
--
-- psql variables (the setup script passes them):
--   template_prefix  table prefix of a production project whose (empty)
--                    tables the demo project copies the structure of
--   owner_email      your LaunchPad sign-in email; made platform owner and
--                    admin of the demo project
--
-- Adds, all fake:
--   TEMPLATE  "Empty template": points at the template_prefix tables, which
--             are empty here. Only there so the demo project (and any you
--             add with "+ Add new project") have tables to copy.
--   DEMO      "Demo project", created with lp_create_project exactly as the
--             app does it. Starts empty: add lines, seals and so on in the
--             test site.

\set ON_ERROR_STOP on

select set_config('lp_seed.template_prefix', :'template_prefix', false),
       set_config('lp_seed.owner_email', lower(btrim(:'owner_email')), false);

do $$
declare
    tp text := current_setting('lp_seed.template_prefix');
    owner text := current_setting('lp_seed.owner_email');
begin
    -- Refuse to touch a database with real projects in it (that's production).
    if exists (select 1 from launchpad_projects where project_key not in ('TEMPLATE', 'DEMO')) then
        raise exception 'This database has real projects in it. seed.sql only runs on the test database.';
    end if;
    if to_regclass(format('public.%I', tp || 'authorized_editors')) is null then
        raise exception 'No table %authorized_editors here. Pass the table prefix of an existing production project.', tp;
    end if;
    if owner !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'owner_email % is not an email', owner;
    end if;

    insert into launchpad_platform_owners (email) values (owner) on conflict (email) do nothing;

    if not exists (select 1 from launchpad_projects where project_key = 'TEMPLATE') then
        perform lp__insert_json('launchpad_projects', jsonb_build_object(
            'project_key', 'TEMPLATE',
            'table_prefix', tp,
            'project_name', 'Empty template',
            'client_name', 'LaunchPad test',
            'start_date', current_date,
            'duration_weeks', 52,
            'admin_email', owner,
            'access_code', '100000'));
    end if;

    if not exists (select 1 from launchpad_projects where project_key = 'DEMO') then
        -- lp_create_project checks the caller is the platform owner, through
        -- auth.email(), which reads the request's claims.
        perform set_config('request.jwt.claims', json_build_object('email', owner, 'role', 'authenticated')::text, true);
        perform lp_create_project(jsonb_build_object(
            'project_key', 'DEMO',
            'project_name', 'Demo project',
            'client_name', 'LaunchPad test',
            'structure_from', 'TEMPLATE',
            'start_date', current_date,
            'duration_weeks', 26,
            'admin_email', owner));
        perform set_config('request.jwt.claims', '', true);
    end if;
end $$;

select project_key, project_name, access_code from launchpad_projects order by project_key;
