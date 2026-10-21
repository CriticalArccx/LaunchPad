#!/usr/bin/env node
// Server-side counterpart to index.html's "Clean" button
// (cleanStatusOnlyRows()) — wipes the Status column on any Schedule row
// where every OTHER column is blank, so a ghost row (Activity/Asset were
// filled in, triggering a Status lookup, then cleared back out without
// Status itself ever getting cleared) doesn't sit around indefinitely
// until someone happens to open that project and click Clean by hand.
//
// Run via .github/workflows/clean-status-only-rows.yml (schedule + manual
// "Run workflow" trigger). Requires the SUPABASE_SERVICE_KEY env var (a
// Supabase service_role key, NOT the anon key used in the browser — it
// needs to bypass RLS to write) set as a GitHub Actions secret, same as
// sync-equipment-data.mjs.
//
// Covers every project in launchpad_projects — no per-project list to
// maintain here.

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

async function getProjects() {
    const res = await supabaseRequest('launchpad_projects?select=project_key,table_prefix');
    return res.json();
}

// Mirrors isRowReallyBlank()/cleanStatusOnlyRows()'s own definition of
// "blank" (index.html) — every Schedule column except Status, trimmed,
// either empty or null.
const BLANK_IF_EMPTY_COLUMNS = ['time', 'place', 'activity', 'asset', 'trade_partners', 'result', 'notes', 'duration', 'loto'];

function isBlank(value) {
    return value === null || value === undefined || String(value).trim() === '';
}

async function cleanProject(projectKey, tablePrefix) {
    const table = `${tablePrefix}BackEndData`;
    // Only fetch rows that could possibly match — Status actually set to
    // something — instead of pulling every row in the project.
    const res = await supabaseRequest(
        `${table}?select=id,${BLANK_IF_EMPTY_COLUMNS.join(',')},status&status=not.is.null`
    );
    const rows = await res.json();

    const toClean = rows.filter(row => {
        if (isBlank(row.status)) return false; // status=not.is.null still lets '' through
        return BLANK_IF_EMPTY_COLUMNS.every(col => isBlank(row[col]));
    });

    if (!toClean.length) {
        console.log(`[${projectKey}] nothing to clean (${rows.length} row(s) had a Status set).`);
        return;
    }

    for (const row of toClean) {
        await supabaseRequest(`${table}?id=eq.${row.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: '' }),
        });
    }
    console.log(`[${projectKey}] cleaned ${toClean.length} status-only row(s) out of ${rows.length} with a Status set.`);
}

async function main() {
    const projects = await getProjects();
    console.log(`Found ${projects.length} project(s).`);

    let hadError = false;
    for (const project of projects) {
        try {
            await cleanProject(project.project_key, project.table_prefix);
        } catch (e) {
            hadError = true;
            console.error(`[${project.project_key}] clean failed:`, e.message);
        }
    }
    if (hadError) process.exit(1);
}

main();
