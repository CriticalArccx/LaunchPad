#!/usr/bin/env node
// Takes a full point-in-time snapshot of each listed project's BackEndData
// table and stores it in launchpad_schedule_snapshots, so there's a backup
// to recover real data from if rows are ever lost again — independent of
// whatever the cause turns out to be each time.
//
// Run via .github/workflows/snapshot-schedule-data.yml (schedule + manual
// "Run workflow" trigger). Requires the SUPABASE_SERVICE_KEY env var (a
// Supabase service_role key, NOT the anon key used in the browser — it
// needs to bypass RLS to write) set as a GitHub Actions secret, same as
// sync-equipment-data.mjs.
//
// Deliberately an explicit list, not every project in launchpad_projects
// (unlike the other sync/clean scripts) — scoped to MSA3A per request;
// add a project_key here to cover it too, no schema change needed.
const PROJECTS_TO_SNAPSHOT = ['MSA3A'];

const SUPABASE_URL = 'https://rcnxetcomdrlxvlarqoc.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_SERVICE_KEY environment variable.');
    process.exit(1);
}

async function supabaseRequest(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers: {
            apikey: SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            ...options.headers,
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Supabase request failed (${res.status} ${path}): ${body}`);
    }
    return res;
}

async function getTablePrefix(projectKey) {
    const res = await supabaseRequest(`launchpad_projects?project_key=eq.${encodeURIComponent(projectKey)}&select=table_prefix`);
    const rows = await res.json();
    if (!rows.length) throw new Error(`No launchpad_projects row found for project_key='${projectKey}'`);
    return rows[0].table_prefix;
}

async function snapshotProject(projectKey) {
    const tablePrefix = await getTablePrefix(projectKey);
    const table = `${tablePrefix}BackEndData`;

    // PostgREST defaults to capping a plain select at 1000 rows — paginate
    // explicitly so a project with more rows than that still gets a
    // complete snapshot, not a silently-truncated one (the exact class of
    // bug this whole effort exists to protect against).
    const PAGE_SIZE = 1000;
    let allRows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
        const res = await supabaseRequest(`${table}?select=*&order=id.asc`, {
            headers: { Range: `${offset}-${offset + PAGE_SIZE - 1}` },
        });
        const page = await res.json();
        allRows = allRows.concat(page);
        if (page.length < PAGE_SIZE) break;
    }

    await supabaseRequest('launchpad_schedule_snapshots', {
        method: 'POST',
        body: JSON.stringify([{
            project_key: projectKey,
            row_count: allRows.length,
            data: allRows,
        }]),
    });
    console.log(`[${projectKey}] snapshotted ${allRows.length} row(s) from ${table}.`);
}

async function main() {
    let hadError = false;
    for (const projectKey of PROJECTS_TO_SNAPSHOT) {
        try {
            await snapshotProject(projectKey);
        } catch (e) {
            hadError = true;
            console.error(`[${projectKey}] snapshot failed:`, e.message);
        }
    }
    if (hadError) process.exit(1);
}

main();
