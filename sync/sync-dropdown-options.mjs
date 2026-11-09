#!/usr/bin/env node
// Keeps each project's asset dropdown in step with its Google Sheet (ARC-238).
//
// For every project with a google_script_url, at the times its admins set in
// Settings > Status Refresh Schedule (launchpad_schedule_config.
// status_refresh_schedule; once a day at 06:00 when none are set), this
// calls the project's Apps Script ?action=getAssetList (the Sheet's
// Equipment tab) and compares it with launchpad_dropdown_options:
//   - an asset that's new, or whose Place/Zone/ID/Type changed, gets a new
//     'sheet' row;
//   - an asset the Sheet owned that is no longer there gets a new inactive
//     row (never deleted, so old schedule rows and seals still show it);
//   - assets added by hand in LaunchPad ('manual') are never hidden. If the
//     Sheet later lists the same asset, the Sheet takes it over.
// Every attempt is logged in launchpad_dropdown_sync_runs.
//
// Runs for every project, including those still on their old
// {prefix}dropdownoptions table, so the shared table is ready (and can be
// compared in Settings) before a project is switched over.
//
// Run by .github/workflows/sync-dropdown-options.yml every 15 minutes; a
// project only syncs when one of its times has passed since its last run.
// "Run workflow" by hand syncs straight away (one project, or all).
// Needs SUPABASE_SERVICE_KEY (GitHub Actions secret, never in the browser).

const SUPABASE_URL = 'https://rcnxetcomdrlxvlarqoc.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ONLY_PROJECT = (process.env.SYNC_ONLY_PROJECT || '').trim();
const FORCE = process.env.FORCE_SYNC === 'true';
const DEFAULT_TIMES = ['06:00'];
const DEFAULT_TZ = 'America/New_York';
const PAGE = 1000;

if (!SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_SERVICE_KEY environment variable.');
    process.exit(1);
}

async function rest(path, options = {}) {
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
        const err = new Error(`Supabase request failed (${res.status} ${path.split('?')[0]}): ${body}`);
        err.status = res.status;
        throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

// Same retry as sync-equipment-data.mjs: Apps Script sometimes fails once
// before the script even runs, and succeeds moments later.
async function fetchAppsScriptJson(url, attempts = 3, delayMs = 3000) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            try {
                return JSON.parse(text);
            } catch {
                throw new Error(`Not JSON (starts with: ${text.slice(0, 80).replace(/\s+/g, ' ')})`);
            }
        } catch (e) {
            lastError = e;
            if (attempt < attempts) await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw lastError;
}

// ---- Time zones ----------------------------------------------------------

function tzOffsetMs(ts, tz) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(new Date(ts)).map(p => [p.type, p.value])
    );
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return asUtc - Math.floor(ts / 1000) * 1000;
}

function localDate(ts, tz) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(ts));
}

// "YYYY-MM-DD" + "HH:MM" in tz -> epoch ms.
function zonedToUtc(dateStr, hhmm, tz) {
    const [Y, M, D] = dateStr.split('-').map(Number);
    const [h, m] = hhmm.split(':').map(Number);
    const wall = Date.UTC(Y, M - 1, D, h, m);
    let ts = wall - tzOffsetMs(wall, tz);
    const second = tzOffsetMs(ts, tz);
    if (wall - second !== ts) ts = wall - second; // across a DST change
    return ts;
}

// The most recent scheduled time at or before now (today's or yesterday's).
function latestSlot(now, times, tz) {
    let best = null;
    for (const back of [0, 1]) {
        const day = localDate(now - back * 86400000, tz);
        for (const t of times) {
            const ts = zonedToUtc(day, t, tz);
            if (ts <= now && (best === null || ts > best)) best = ts;
        }
    }
    return best;
}

function scheduleFor(config) {
    const s = config && config.status_refresh_schedule;
    const times = (s && Array.isArray(s.times) ? s.times : []).filter(t => /^\d{1,2}:\d{2}$/.test(String(t)));
    let tz = (s && s.timezone) || DEFAULT_TZ;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = DEFAULT_TZ; }
    return { times: times.length ? times : DEFAULT_TIMES, tz, isDefault: !times.length };
}

// ---- Data ----------------------------------------------------------------

async function getProjects() {
    const rows = await rest('launchpad_projects?select=project_key,google_script_url&google_script_url=not.is.null');
    return rows.filter(p => p.project_key && p.google_script_url);
}

async function getConfigs() {
    try {
        const rows = await rest('launchpad_schedule_config?select=project_key,status_refresh_schedule');
        return Object.fromEntries(rows.map(r => [r.project_key, r]));
    } catch (e) {
        // status_refresh_schedule not added yet: everyone gets the default time.
        console.warn('Could not read Status Refresh Schedule, using the default time for every project:', e.message);
        return {};
    }
}

async function lastRunAt(projectKey) {
    const rows = await rest(`launchpad_dropdown_sync_runs?select=ran_at&project_key=eq.${encodeURIComponent(projectKey)}&order=ran_at.desc&limit=1`);
    return rows.length ? Date.parse(rows[0].ran_at) : null;
}

async function currentAssets(projectKey) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
        const rows = await rest(
            `launchpad_dropdown_options_current?select=value,place,zone,equipment_id,asset_type,source,active` +
            `&project_key=eq.${encodeURIComponent(projectKey)}&list=eq.Assets&order=id.asc`,
            { headers: { Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items' } }
        );
        out.push(...rows);
        if (rows.length < PAGE) break;
    }
    return out;
}

const clean = v => (v == null ? '' : String(v).trim());

// The Sheet's Place column (Place, Location, Area, Space or Room) becomes the
// asset's place, which fills in Place when the asset is picked in the
// Schedule and The Bridge. If the tab has no such column (has_place false),
// the place already saved is kept instead of being blanked.
function sheetAssets(payload) {
    const byKey = new Map();
    const hasPlace = payload.has_place !== false;
    for (const r of payload.rows) {
        const value = clean(r.asset);
        if (!value) continue;
        byKey.set(value.toLowerCase(), {
            value,
            place: clean(r.place ?? r.area) || null,
            keepPlace: !hasPlace,
            zone: clean(r.zone) || null,
            equipment_id: clean(r.equipment_id) || null,
            asset_type: clean(r.type) || null,
        });
    }
    return byKey;
}

const DETAIL = ['place', 'zone', 'equipment_id', 'asset_type'];

async function syncProject(project, trigger) {
    const key = project.project_key;
    const run = { project_key: key, trigger, ok: false, sheet_count: null, added: 0, changed: 0, removed: 0, error: null };
    try {
        // Pick up anything new in the project's old table first (while
        // projects move over one at a time, both tables are in use).
        await rest('rpc/lp_copy_legacy_dropdown_options', {
            method: 'POST', body: JSON.stringify({ p_project_key: key }),
        });

        const payload = await fetchAppsScriptJson(`${project.google_script_url}?action=getAssetList`);
        if (!payload || !Array.isArray(payload.rows)) {
            throw new Error('getAssetList is not deployed in this project\'s Apps Script yet (no rows came back). Nothing changed.');
        }
        if (payload.error) throw new Error(`Apps Script: ${payload.error}. Nothing changed.`);
        const sheet = sheetAssets(payload);
        run.sheet_count = sheet.size;
        if (sheet.size === 0) {
            // An empty or renamed tab would otherwise hide every asset.
            throw new Error('The Equipment tab returned no assets, so nothing was hidden. Check the tab and its Asset/Name column.');
        }

        const current = new Map((await currentAssets(key)).map(r => [r.value.toLowerCase(), r]));
        const inserts = [];
        const now = new Date().toISOString();
        const row = (a, active, note) => ({
            project_key: key, list: 'Assets', value: a.value,
            place: a.place, zone: a.zone, equipment_id: a.equipment_id, asset_type: a.asset_type,
            source: 'sheet', active, note, changed_by: 'sheet sync', created_at: now,
        });

        for (const [k, a] of sheet) {
            const cur = current.get(k);
            if (a.keepPlace) a.place = cur ? (clean(cur.place) || null) : null;
            if (!cur) {
                inserts.push(row(a, true, 'Added from the Sheet'));
                run.added++;
            } else if (!cur.active || cur.source !== 'sheet' || cur.value !== a.value
                       || DETAIL.some(f => clean(cur[f]) !== clean(a[f]))) {
                inserts.push(row(a, true, cur.source !== 'sheet' ? 'Now listed in the Sheet' : !cur.active ? 'Back in the Sheet' : 'Updated from the Sheet'));
                if (!cur.active) run.added++; else run.changed++;
            }
        }
        for (const [k, cur] of current) {
            if (cur.source === 'sheet' && cur.active && !sheet.has(k)) {
                inserts.push(row({
                    value: cur.value, place: cur.place, zone: cur.zone,
                    equipment_id: cur.equipment_id, asset_type: cur.asset_type,
                }, false, 'No longer in the Sheet\'s Equipment tab'));
                run.removed++;
            }
        }

        for (let i = 0; i < inserts.length; i += 500) {
            await rest('launchpad_dropdown_options', {
                method: 'POST', body: JSON.stringify(inserts.slice(i, i + 500)),
                headers: { Prefer: 'return=minimal' },
            });
        }
        run.ok = true;
        console.log(`[${key}] assets: ${sheet.size} in the Sheet, ${run.added} added, ${run.changed} changed, ${run.removed} hidden`);
    } catch (e) {
        run.error = String(e.message || e).slice(0, 1000);
        console.error(`[${key}] asset sync failed: ${run.error}`);
    }
    await rest('launchpad_dropdown_sync_runs', {
        method: 'POST', body: JSON.stringify([run]), headers: { Prefer: 'return=minimal' },
    });
    return run.ok;
}

async function main() {
    let projects = await getProjects();
    if (ONLY_PROJECT) projects = projects.filter(p => p.project_key === ONLY_PROJECT);
    const configs = await getConfigs();
    const now = Date.now();
    let failures = 0;

    for (const project of projects) {
        const key = project.project_key;
        const { times, tz, isDefault } = scheduleFor(configs[key]);
        if (!FORCE) {
            const slot = latestSlot(now, times, tz);
            const last = await lastRunAt(key);
            if (slot === null || (last !== null && last >= slot)) {
                console.log(`[${key}] not due (times ${times.join(', ')} ${tz}${isDefault ? ', default' : ''})`);
                continue;
            }
        }
        const ok = await syncProject(project, FORCE ? 'manual' : 'schedule');
        if (!ok) failures++;
    }
    // A project whose Apps Script isn't redeployed yet is expected for a
    // while, so its failure is logged (and shown in Settings) without
    // failing the whole run. Only a crash above (e.g. Supabase down) does.
    if (failures) console.log(`${failures} project(s) failed; see launchpad_dropdown_sync_runs.`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
