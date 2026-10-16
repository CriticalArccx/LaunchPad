#!/usr/bin/env node
// Pulls fresh equipment-tracker + dashboard data from a project's Google
// Apps Script endpoint (the same one the app used to call live) and
// upserts it into Supabase, so the app can read a fast, recent snapshot
// instead of waiting on Apps Script's cold-start + Sheets-read latency on
// every page load.
//
// This does NOT change what the Apps Script does — it still owns the
// clean/format logic that turns the raw Sheet into the shape the app
// expects. This script just calls that same endpoint on a schedule instead
// of the browser calling it live.
//
// Run via .github/workflows/sync-equipment-tracker-data.yml (schedule +
// manual "Run workflow" trigger). Requires the SUPABASE_SERVICE_KEY env var
// (a Supabase service_role key, NOT the anon key used in the browser — it
// needs to bypass RLS to write) set as a GitHub Actions secret.
//
// Covers every project in launchpad_projects that has a google_script_url
// on file — no per-project list to maintain here.

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
            Prefer: 'resolution=merge-duplicates',
            ...options.headers,
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Supabase request failed (${res.status} ${path}): ${body}`);
    }
    return res;
}

// Google Apps Script web apps occasionally return a transient
// platform-level error — a raw non-200 status, or an HTML error page
// instead of JSON — before the script itself even runs (confirmed: these
// failures never show up in that project's Apps Script Executions log,
// which only logs actual script invocations). A genuinely broken
// deployment fails the same way every time; a transient platform hiccup
// usually succeeds moments later, so a short retry clears most of these up.
async function fetchAppsScriptJson(url, attempts = 3, delayMs = 3000) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            try {
                return JSON.parse(text);
            } catch (e) {
                throw new Error(`Non-JSON response, likely a transient Apps Script platform error: ${text.slice(0, 80)}`);
            }
        } catch (e) {
            lastError = e;
            if (attempt < attempts) {
                console.warn(`  (attempt ${attempt}/${attempts} failed: ${e.message} — retrying in ${delayMs}ms)`);
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
    }
    throw lastError;
}

async function getProjectsToSync() {
    const res = await supabaseRequest(
        `launchpad_projects?select=project_key,google_script_url&google_script_url=not.is.null`
    );
    const rows = await res.json();
    console.log(`Raw query returned ${rows.length} row(s): ${rows.map(p => `${p.project_key}(${p.google_script_url ? 'has url' : 'EMPTY'})`).join(', ') || '(none)'}`);
    // Belt-and-suspenders: also drop rows where the column is an empty
    // string rather than a real null (PostgREST's not.is.null only
    // excludes actual NULLs).
    const filtered = rows.filter(p => p.project_key && p.google_script_url);
    if (filtered.length !== rows.length) {
        console.log(`Filtered out ${rows.length - filtered.length} row(s) with an empty (non-null) google_script_url.`);
    }
    return filtered;
}

async function syncEquipmentTracker(projectKey, scriptUrl) {
    // Calls Apps Script's default (no-action) doGet branch directly, same
    // as the original approach — it does the checklist/test/issue
    // combining live on each request. (There's also a getCachedEquipmentData
    // action available in some projects' scripts from an earlier caching
    // experiment, reading from an "API Cache" sheet populated by
    // generateChecklistMatrix() — not used here for now.)
    const payload = await fetchAppsScriptJson(scriptUrl);
    if (payload.error) throw new Error(`Apps Script returned an error: ${payload.error}`);

    await supabaseRequest('launchpad_equipment_tracker_data', {
        method: 'POST',
        body: JSON.stringify([{
            project_key: projectKey,
            data: payload.data || [],
            phase_rules: (payload.config && payload.config.phaseRules) || [],
            checklist_types_by_phase: (payload.config && payload.config.checklistTypesByPhase) || {},
            synced_at: new Date().toISOString(),
        }]),
    });
    console.log(`[${projectKey}] equipment tracker: synced ${(payload.data || []).length} row(s)`);
}

async function syncDashboard(projectKey, scriptUrl) {
    const data = await fetchAppsScriptJson(`${scriptUrl}?action=getDashboardData`);
    if (data.error) throw new Error(`Apps Script returned an error: ${data.error}`);

    await supabaseRequest('launchpad_dashboard_data', {
        method: 'POST',
        body: JSON.stringify([{
            project_key: projectKey,
            data,
            synced_at: new Date().toISOString(),
        }]),
    });
    console.log(`[${projectKey}] dashboard: synced`);
}

async function main() {
    let projects = await getProjectsToSync();
    console.log(`Found ${projects.length} project(s) with a google_script_url set.`);

    // Optional single-project filter, for testing one project (e.g. after
    // an Apps Script change) without waiting on/affecting the other seven.
    // Set via the workflow's "Run workflow" dialog (project_key input) or
    // directly as an env var for a local run.
    const onlyProjectKey = (process.env.SYNC_ONLY_PROJECT || '').trim();
    if (onlyProjectKey) {
        const totalFound = projects.length;
        projects = projects.filter(p => p.project_key === onlyProjectKey);
        console.log(`SYNC_ONLY_PROJECT set — restricting to '${onlyProjectKey}' (${projects.length} match(es)).`);
        if (projects.length === 0) {
            console.error(`No project with project_key='${onlyProjectKey}' found among the ${totalFound} with a google_script_url set.`);
            process.exit(1);
        }
    }

    // Equipment tracker is the primary thing this pipeline exists for, so
    // its failures fail the whole run (so a real problem gets noticed).
    // Dashboard failures are logged clearly but don't fail the run — a
    // project's dashboard Apps Script action can be broken/undeployed
    // independently (e.g. a 404 because getDashboardData was never wired
    // into doGet, or the deployment needs a new version) without that
    // being a reason to keep alerting on every scheduled run once it's a
    // known, separate issue to fix on that project's Apps Script side.
    let hadCriticalError = false;
    for (const project of projects) {
        const projectKey = project.project_key;
        try {
            await syncEquipmentTracker(projectKey, project.google_script_url);
        } catch (e) {
            hadCriticalError = true;
            console.error(`[${projectKey}] equipment tracker sync failed:`, e.message);
        }
        try {
            await syncDashboard(projectKey, project.google_script_url);
        } catch (e) {
            console.warn(`[${projectKey}] dashboard sync failed (non-fatal):`, e.message);
        }
    }
    if (hadCriticalError) process.exit(1);
}

main();
