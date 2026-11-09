// Shared dropdown options (ARC-238): one place for the Schedule, The Bridge,
// Tamper Seals, Seal Form and Settings to read and change a project's
// dropdown lists.
//
// The lists live in launchpad_dropdown_options (one row per option, tagged
// with project_key and list; see sync/dropdown_options.sql). Assets come from
// the project's Google Sheet (source 'sheet', kept in step by
// sync/sync-dropdown-options.mjs) plus anything added here (source 'manual').
// Reads and writes go through database functions that check the caller's
// role on the project.
//
// Transition: both tables work side by side. A project uses its old
// "{prefix}dropdownoptions" table until an admin ticks "Use the shared table
// for this project" in Settings (launchpad_nav_config.sidebar_config
// .dropdownSource = 'shared'); see source(). Even then, if the shared
// functions aren't there yet (the SQL hasn't been run) or fail, reads fall
// back to the old table, so nothing goes blank.
(function () {
    'use strict';

    const LISTS = ['Times', 'Places', 'Activities', 'Assets', 'Trade_Partners', 'Results', 'Zone'];
    const PAGE = 1000;
    const clean = v => (v == null ? '' : String(v).trim());

    function friendlyError(error) {
        const code = error && error.code;
        const msg = (error && error.message) || String(error || 'Unknown error');
        if (code === 'PGRST202' || code === '42883' || /function .* does not exist|Could not find the function/i.test(msg)) {
            return 'Shared dropdown options are not set up yet. Run sync/dropdown_options.sql in Supabase.';
        }
        if (code === '42501') return 'You need editor access on this project to change dropdown options.';
        return msg;
    }

    // Old per-project table: one column per list, every non-empty cell is an
    // option. An asset's Place/Zone is whatever sits on the same row.
    async function loadLegacy(sb, prefix) {
        const rows = [];
        const seen = new Map();
        for (let from = 0; ; from += PAGE) {
            const { data, error } = await sb.from(`${prefix}dropdownoptions`).select('*').range(from, from + PAGE - 1);
            if (error) { if (from === 0) throw error; break; }
            (data || []).forEach(r => LISTS.forEach(list => {
                const value = clean(r[list]);
                if (!value) return;
                const key = list + '\u0000' + value.toLowerCase();
                let row = seen.get(key);
                if (!row) {
                    row = { list, value, place: null, zone: null, source: 'legacy', active: true };
                    seen.set(key, row);
                    rows.push(row);
                }
                if (list === 'Assets') {
                    if (clean(r.Places)) row.place = clean(r.Places);
                    if (clean(r.Zone)) row.zone = clean(r.Zone);
                }
            }));
            if (!data || data.length < PAGE) break;
        }
        return rows;
    }

    // Which table this project's dropdowns use: 'shared' or 'legacy'.
    // Read once per page from the project's saved settings; anything other
    // than an explicit 'shared' (or a failed read) means the old table.
    const sourceCache = new Map();
    function source(sb, projectKey) {
        if (!sourceCache.has(projectKey)) {
            sourceCache.set(projectKey, (async () => {
                try {
                    const { data, error } = await sb.from('launchpad_nav_config')
                        .select('sidebar_config').eq('project_key', projectKey).maybeSingle();
                    if (error) throw error;
                    return data && data.sidebar_config && data.sidebar_config.dropdownSource === 'shared' ? 'shared' : 'legacy';
                } catch (e) {
                    console.warn('Could not read which dropdown table this project uses; using the old one:', e.message || e);
                    return 'legacy';
                }
            })());
        }
        return sourceCache.get(projectKey);
    }

    async function loadShared(sb, projectKey) {
        const rows = [];
        for (let from = 0; ; from += PAGE) {
            const { data, error } = await sb.rpc('lp_dropdown_options', { p_project_key: projectKey })
                .range(from, from + PAGE - 1);
            if (error) throw error;
            rows.push(...(data || []));
            if (!data || data.length < PAGE) break;
        }
        return rows;
    }

    // Every option for the project, active and hidden, from the table the
    // project uses (or opts.source: 'shared' | 'legacy', e.g. Settings
    // comparing the two).
    // Returns { mode: 'shared' | 'legacy', wanted, rows: [{ list, value,
    // place, zone, equipment_id, asset_type, source, active, note,
    // changed_by, created_at }] }. mode is what was actually read: 'legacy'
    // with wanted 'shared' means the shared table couldn't be read.
    async function load(sb, projectKey, prefix, opts) {
        const wanted = (opts && opts.source) || await source(sb, projectKey);
        if (wanted === 'legacy') {
            try {
                return { mode: 'legacy', wanted, rows: await loadLegacy(sb, prefix || projectKey) };
            } catch (e) {
                console.error('Could not load dropdown options:', e);
                return { mode: 'legacy', wanted, rows: [] };
            }
        }
        try {
            const rows = await loadShared(sb, projectKey);
            if (rows.length) return { mode: 'shared', wanted, rows };
        } catch (e) {
            console.warn('Shared dropdown options unavailable, reading the old table instead:', friendlyError(e));
        }
        try {
            return { mode: 'legacy', wanted, rows: await loadLegacy(sb, prefix || projectKey) };
        } catch (e) {
            console.error('Could not load dropdown options:', e);
            return { mode: 'legacy', wanted, rows: [] };
        }
    }

    // Changes to the old table, for projects still on it. Same as LaunchPad
    // did before ARC-238: a new row holding just the one value, and removing
    // clears that value from every row that has it.
    async function legacyAdd(sb, prefix, list, value, extra) {
        const row = { [list]: clean(value) };
        // An asset's Place sits on the same row in the old table.
        if (list === 'Assets' && extra && clean(extra.place)) row.Places = clean(extra.place);
        const { error } = await sb.from(`${prefix}dropdownoptions`).insert([row]);
        if (error) throw new Error(friendlyError(error));
    }

    async function legacyRemove(sb, prefix, list, value) {
        const { error } = await sb.from(`${prefix}dropdownoptions`).update({ [list]: null }).eq(list, value);
        if (error) throw new Error(friendlyError(error));
    }

    // Active options grouped by list, sorted, with each asset's Place/Zone.
    // An asset's Place and Zone are also offered in the Places/Zone lists.
    function build(rows) {
        const lists = Object.fromEntries(LISTS.map(l => [l, []]));
        const seen = Object.fromEntries(LISTS.map(l => [l, new Set()]));
        const placeByAsset = {};
        const zoneByAsset = {};
        const push = (list, v) => {
            const k = v.toLowerCase();
            if (!seen[list].has(k)) { seen[list].add(k); lists[list].push(v); }
        };
        (rows || []).forEach(r => {
            if (r.active === false || !lists[r.list]) return;
            const v = clean(r.value);
            if (!v) return;
            push(r.list, v);
            if (r.list === 'Assets') {
                if (clean(r.place)) placeByAsset[v] = clean(r.place);
                if (clean(r.zone)) zoneByAsset[v] = clean(r.zone);
            }
        });
        Object.values(placeByAsset).forEach(p => push('Places', p));
        Object.values(zoneByAsset).forEach(z => push('Zone', z));
        LISTS.forEach(l => lists[l].sort());
        return { lists, placeByAsset, zoneByAsset };
    }

    async function add(sb, projectKey, list, value, extra) {
        extra = extra || {};
        const { data, error } = await sb.rpc('lp_dropdown_option_add', {
            p_project_key: projectKey, p_list: list, p_value: value,
            p_place: extra.place || null, p_zone: extra.zone || null, p_note: extra.note || null,
        });
        if (error) throw new Error(friendlyError(error));
        return data;
    }

    async function setActive(sb, projectKey, list, value, active, note) {
        const { data, error } = await sb.rpc('lp_dropdown_option_set_active', {
            p_project_key: projectKey, p_list: list, p_value: value, p_active: !!active, p_note: note || null,
        });
        if (error) throw new Error(friendlyError(error));
        return data;
    }

    // A rename is the new name added and the old one hidden, so the history
    // keeps both.
    async function rename(sb, projectKey, list, oldValue, newValue, extra) {
        const row = await add(sb, projectKey, list, newValue, extra);
        if (clean(oldValue).toLowerCase() !== clean(newValue).toLowerCase()) {
            await setActive(sb, projectKey, list, oldValue, false, `Renamed to ${clean(newValue)}`);
        }
        return row;
    }

    // Company names. Signed-out screens pass accessCode (access request) or
    // publicUuid (QR seal form); signed-in screens pass projectKey.
    async function tradePartners(sb, opts) {
        opts = opts || {};
        const legacy = async () => {
            if (!opts.prefix) return [];
            const rows = await loadLegacy(sb, opts.prefix).catch(() => []);
            return build(rows).lists.Trade_Partners;
        };
        const viaRpc = async (fn, args) => {
            const { data, error } = await sb.rpc(fn, args);
            if (error) throw error;
            return (data || []).map(r => (typeof r === 'string' ? r : Object.values(r)[0])).map(clean).filter(Boolean);
        };
        if (!opts.accessCode && !opts.publicUuid && opts.projectKey) {
            // load() already falls back to the old table on its own.
            return build((await load(sb, opts.projectKey, opts.prefix)).rows).lists.Trade_Partners;
        }
        try {
            let list = [];
            if (opts.accessCode) list = await viaRpc('lp_trade_partners_by_access_code', { p_code: String(opts.accessCode) });
            else if (opts.publicUuid) list = await viaRpc('lp_trade_partners_by_public_uuid', { p_uuid: String(opts.publicUuid) });
            if (list.length) return list.sort();
        } catch (e) {
            console.warn('Shared company list unavailable, reading the old table instead:', friendlyError(e));
        }
        return legacy();
    }

    window.LPOptions = { LISTS, source, load, build, add, setActive, rename, legacyAdd, legacyRemove, tradePartners, friendlyError };
})();
