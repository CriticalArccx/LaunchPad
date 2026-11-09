// Settings > System Data > Dropdown Management (ARC-238).
//
// Transition: both dropdown tables work side by side, one project at a time.
//   Old table     this project's "{prefix}dropdownoptions", used until the
//                 project is switched. Add and Remove work as they always did.
//   Shared table  launchpad_dropdown_options (see dropdown-options.js and
//                 sync/dropdown_options.sql). Fills in for every project
//                 (Sheet assets, plus anything new in the old table), so it
//                 can be checked here before switching. Nothing is deleted:
//                 Hide is a new row, and Restore brings it back.
// "Use the shared table for this project" (admins) is saved with the other
// settings as appConfig.dropdownSource and takes effect after the reload.
//
// Assets marked "Sheet" come from the project's Google Sheet Equipment tab
// and are kept in step by the asset sync, at the times in Status Refresh
// Schedule; change those in the Sheet. Everything else is "Manual".
const Settings = {
    containerId: 'settings-container',
    currentCategory: 'Assets', // the list name, matching launchpad_dropdown_options.list
    showHidden: false,
    view: null,                // 'legacy' | 'shared': which table this panel shows
    rowsByView: {},            // view -> rows, or null when that table can't be read

    CATEGORIES: [
        ['Times', 'Times (Col 1)'],
        ['Places', 'Places (Col 2)'],
        ['Activities', 'Activities (Col 3)'],
        ['Assets', 'Assets (Col 4)'],
        ['Trade_Partners', 'Trade Partners (Col 6)'],
        ['Results', 'Results (Col 7)'],
        ['Zone', 'Zones (The Bridge)']
    ],

    VIEW_NAMES: { legacy: 'Old table', shared: 'Shared table' },

    esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    canEdit() {
        return window.userRole === 'admin' || window.userRole === 'editor';
    },

    // The table the project is set to use (saved setting), and the one the
    // page actually reads (differs only if the shared table can't be read).
    inUse() {
        return window.dropdownMode === 'shared' ? 'shared' : 'legacy';
    },

    savedSource() {
        return (typeof appConfig !== 'undefined' && appConfig.dropdownSource === 'shared') ? 'shared' : 'legacy';
    },

    async init() {
        const container = document.getElementById(this.containerId);
        if (!container) return;
        if (!window.dropdownRows && typeof fetchDropdownOptions === 'function') {
            await fetchDropdownOptions();
        }
        this.view = this.view || this.inUse();
        this.renderShell(container);
        this.rowsByView = {};
        await this.loadViews();
        this.refreshList();
        this.loadSyncStatus();
    },

    // Both tables, so they can be compared. The one in use is already loaded.
    async loadViews() {
        const key = window.LP_CONFIG.projectKey, prefix = window.LP_CONFIG.tablePrefix;
        for (const v of ['legacy', 'shared']) {
            if (v === window.dropdownMode && window.dropdownRows) { this.rowsByView[v] = window.dropdownRows; continue; }
            const res = await LPOptions.load(_supabase, key, prefix, { source: v });
            this.rowsByView[v] = res.mode === v ? res.rows : null;
        }
    },

    renderShell(container) {
        const muted = 'var(--neutrals-lightmode-light-mode-Textsecondary, #6a675f)';
        const border = 'var(--neutrals-lightmode-light-mode-Border, #d6d3cb)';
        const strong = 'var(--neutrals-lightmode-light-mode-Borderstrong, #b2aea4)';
        container.innerHTML = `
            <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid ${border}; box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
                <h3 style="margin-top:0; font-size:16px; color:var(--neutrals-lightmode-light-mode-Textprimary, #141718);">📋 Dropdown Management</h3>

                <div style="background: var(--neutrals-lightmode-light-mode-Page, #f3f2ee); border: 1px solid ${border}; border-radius: 6px; padding: 10px 12px; margin-bottom: 12px; font-size: 13px;">
                    <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer;">
                        <input type="checkbox" id="cfg-dd-shared" style="margin-top:2px; transform:scale(1.15);">
                        <span><b>Use the shared table for this project</b><br>
                        <span id="dd-source-note" style="font-size:12px; color:${muted};"></span></span>
                    </label>
                </div>
                <div id="dd-sync-status" style="font-size:12px; color:${muted}; margin-bottom:12px;"></div>

                <div style="display:flex; gap:10px; align-items:flex-end; margin-bottom: 12px; flex-wrap: wrap;">
                    <label style="flex:1; min-width:150px; font-size: 12px; font-weight: bold;">Showing
                        <select id="dd-view-select" style="display:block; width: 100%; margin-top:5px; padding: 10px; border: 1px solid ${strong}; border-radius: 4px; font-size: 14px;">
                            <option value="legacy">Old table</option>
                            <option value="shared">Shared table</option>
                        </select>
                    </label>
                    <label style="flex:1; min-width:180px; font-size: 12px; font-weight: bold;">Category
                        <select id="setting-category-select" style="display:block; width: 100%; margin-top:5px; padding: 10px; border: 1px solid ${strong}; border-radius: 4px; font-size: 14px;">
                            ${this.CATEGORIES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
                        </select>
                    </label>
                    <label id="dd-show-hidden-wrap" style="font-size:12px; display:flex; align-items:center; gap:6px; padding-bottom:10px; cursor:pointer;">
                        <input type="checkbox" id="dd-show-hidden"> Show hidden
                    </label>
                </div>
                <div id="dd-compare" style="font-size:12px; color:${muted}; margin-bottom:8px;"></div>

                <div style="max-height: 320px; overflow-y: auto; border: 1px solid var(--neutrals-lightmode-light-mode-Subtle, #e7e5df); border-radius: 4px;">
                    <div id="dropdown-items-list" style="padding: 6px 10px;"></div>
                </div>

                <div id="dd-add-row" style="margin-top: 15px; display: flex; gap: 10px; flex-wrap: wrap;">
                    <input type="text" id="new-option-input" placeholder="New entry name..." style="flex: 2; min-width: 160px; padding: 10px; border: 1px solid ${strong}; border-radius: 4px;">
                    <input type="text" id="new-option-place" placeholder="Place (optional)" list="dd-place-options" style="flex: 1; min-width: 120px; padding: 10px; border: 1px solid ${strong}; border-radius: 4px;">
                    <datalist id="dd-place-options"></datalist>
                    <button id="add-opt-btn" style="background: var(--lp-action, #2f7a31); color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold;">Add</button>
                </div>
                <p id="dd-help" style="font-size:12px; color:${muted}; margin:10px 0 0;"></p>
            </div>
        `;
        const shared = document.getElementById('cfg-dd-shared');
        shared.checked = this.savedSource() === 'shared';
        shared.onchange = () => this.renderSourceNote();
        const view = document.getElementById('dd-view-select');
        view.value = this.view;
        view.onchange = () => { this.view = view.value; this.refreshList(); };
        const select = document.getElementById('setting-category-select');
        select.value = this.currentCategory;
        select.onchange = () => { this.currentCategory = select.value; this.refreshList(); };
        const hidden = document.getElementById('dd-show-hidden');
        hidden.checked = this.showHidden;
        hidden.onchange = () => { this.showHidden = hidden.checked; this.refreshList(); };
        document.getElementById('add-opt-btn').onclick = () => this.addOption();
        document.getElementById('new-option-input').onkeydown = e => { if (e.key === 'Enter') this.addOption(); };
        document.getElementById('dropdown-items-list').onclick = e => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            if (btn.dataset.act === 'remove') this.legacyRemove(btn.dataset.value);
            else this.setActive(btn.dataset.value, btn.dataset.act === 'restore');
        };
    },

    renderSourceNote() {
        const box = document.getElementById('cfg-dd-shared');
        const note = document.getElementById('dd-source-note');
        if (!box || !note) return;
        const sharedReady = !!this.rowsByView.shared;
        const isAdmin = window.userRole === 'admin';
        // Turning it off is always allowed, so a project can go back.
        box.disabled = !isAdmin || (!sharedReady && !box.checked);
        const saved = this.savedSource();
        const pending = (box.checked ? 'shared' : 'legacy') !== saved;
        let text = `This project uses the <b>${this.VIEW_NAMES[this.inUse()]}</b>.`;
        if (saved === 'shared' && this.inUse() !== 'shared') text += ' It is set to the shared table, but that couldn\'t be read, so the old table is used for now.';
        if (pending) text += ` Click Save at the bottom of Settings to switch to the ${this.VIEW_NAMES[box.checked ? 'shared' : 'legacy'].toLowerCase()}.`;
        else if (!sharedReady) text += ' The shared table isn\'t set up yet (run sync/dropdown_options.sql in Supabase).';
        else if (saved === 'legacy') text += ' The shared table keeps filling in alongside it, so you can compare the two below before switching. You can switch back at any time.';
        else text += ' Untick and Save to go back to the old table; it is left as it was.';
        if (!isAdmin) text += ' Only admins can change this.';
        note.innerHTML = text;
    },

    // Rows for the chosen list in the table being shown.
    rowsFor(list) {
        return (this.rowsByView[this.view] || [])
            .filter(r => r.list === list)
            .sort((a, b) => String(a.value).localeCompare(String(b.value)));
    },

    activeValues(view, list) {
        return new Set((this.rowsByView[view] || [])
            .filter(r => r.list === list && r.active !== false)
            .map(r => String(r.value).trim().toLowerCase()));
    },

    renderCompare(list) {
        const el = document.getElementById('dd-compare');
        if (!el) return;
        if (!this.rowsByView.legacy || !this.rowsByView.shared) { el.textContent = ''; return; }
        const other = this.view === 'shared' ? 'legacy' : 'shared';
        const here = this.activeValues(this.view, list), there = this.activeValues(other, list);
        const onlyHere = [...here].filter(v => !there.has(v)).length;
        const onlyThere = [...there].filter(v => !here.has(v)).length;
        el.textContent = onlyHere || onlyThere
            ? `Compared with the ${this.VIEW_NAMES[other].toLowerCase()}: ${onlyHere} here that it doesn't have, ${onlyThere} there that aren't here. Options only here are marked.`
            : `Same ${here.size} options as the ${this.VIEW_NAMES[other].toLowerCase()}.`;
        return there;
    },

    refreshList() {
        const listDiv = document.getElementById('dropdown-items-list');
        if (!listDiv) return;
        this.renderSourceNote();
        document.getElementById('dd-view-select').value = this.view;
        const list = this.currentCategory;
        const legacy = this.view === 'legacy';
        const available = !!this.rowsByView[this.view];
        const editable = this.canEdit() && available;
        const isAssets = list === 'Assets';

        document.getElementById('dd-show-hidden-wrap').style.display = legacy ? 'none' : 'flex';
        document.getElementById('dd-add-row').style.display = editable ? 'flex' : 'none';
        document.getElementById('new-option-place').style.display = isAssets ? '' : 'none';
        document.getElementById('dd-place-options').innerHTML =
            ((window.dropdownData && window.dropdownData.col2) || []).map(p => `<option value="${this.esc(p)}">`).join('');
        const which = this.view === this.inUse()
            ? `This is the table this project uses now.`
            : `This project doesn't use this table yet; changes here don't show in its dropdowns until it is switched.`;
        document.getElementById('dd-help').innerHTML = !available
            ? 'The shared table isn\'t set up yet. Run <code>sync/dropdown_options.sql</code> in Supabase.'
            : legacy
                ? `${which} Remove takes the value out of the old table, as before.`
                : isAssets
                    ? `${which} Assets marked <b>Sheet</b> come from the Google Sheet's Equipment tab and update at the times in Status Refresh Schedule; change those in the Sheet. Assets added here are marked <b>Manual</b>.`
                    : `${which} Hiding an option removes it from dropdowns for new entries. Existing rows keep their values, and Restore brings it back.`;

        const otherValues = this.renderCompare(list);
        const rows = this.rowsFor(list).filter(r => legacy || this.showHidden || r.active !== false);
        if (!available || rows.length === 0) {
            listDiv.innerHTML = `<p style="color:var(--neutrals-lightmode-light-mode-Textsecondary, #6a675f); text-align:center; padding:20px;">${available ? 'No entries found.' : 'Not available.'}</p>`;
            return;
        }

        const badge = (text, bg, fg) => `<span style="font-size:10px; font-weight:bold; text-transform:uppercase; letter-spacing:.03em; padding:2px 6px; border-radius:10px; background:${bg}; color:${fg};">${text}</span>`;
        const btnStyle = 'background:none; border:1px solid var(--neutrals-lightmode-light-mode-Border, #d6d3cb); border-radius:4px; cursor:pointer; font-size:12px; padding:3px 8px;';
        const otherName = this.VIEW_NAMES[this.view === 'shared' ? 'legacy' : 'shared'].toLowerCase();
        listDiv.innerHTML = rows.map(r => {
            const hidden = r.active === false;
            const fromSheet = r.source === 'sheet';
            const src = legacy ? '' : fromSheet ? badge('Sheet', '#e3f0e3', '#2f7a31') : badge('Manual', '#ececec', '#555');
            const onlyHere = otherValues && !hidden && !otherValues.has(String(r.value).trim().toLowerCase())
                ? badge(`Not in ${otherName}`, '#fff4d6', '#7a5a00') : '';
            const details = isAssets ? [r.place, r.zone && `Zone ${r.zone}`, r.asset_type, r.equipment_id && `ID ${r.equipment_id}`].filter(Boolean).join(' · ') : '';
            const why = hidden && r.note ? r.note : '';
            let action = '';
            if (editable && legacy) {
                action = `<button data-act="remove" data-value="${this.esc(r.value)}" title="Remove from the old table" style="${btnStyle} color:#b3261e;">Remove</button>`;
            } else if (editable && hidden) {
                action = `<button data-act="restore" data-value="${this.esc(r.value)}" title="Show this option in dropdowns again" style="${btnStyle}">Restore</button>`;
            } else if (editable && !fromSheet) {
                action = `<button data-act="hide" data-value="${this.esc(r.value)}" title="Hide from dropdowns (kept in the history)" style="${btnStyle} color:#b3261e;">Hide</button>`;
            }
            return `
            <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--neutrals-lightmode-light-mode-Subtle, #e7e5df); ${hidden ? 'opacity:.6;' : ''}">
                <div style="min-width:0;">
                    <div style="font-size:13px; color:var(--neutrals-lightmode-light-mode-Textprimary, #141718); ${hidden ? 'text-decoration:line-through;' : ''}">${this.esc(r.value)} ${src} ${onlyHere}</div>
                    ${details || why ? `<div style="font-size:11px; color:var(--neutrals-lightmode-light-mode-Textsecondary, #6a675f);">${this.esc([details, why].filter(Boolean).join(' · '))}</div>` : ''}
                </div>
                ${action}
            </div>`;
        }).join('');
    },

    async loadSyncStatus() {
        const el = document.getElementById('dd-sync-status');
        if (!el || !window.LP_CONFIG || !window.LP_CONFIG.projectKey) return;
        // Before sync/dropdown_options.sql has run there's no sync log to read.
        if (!this.rowsByView.shared) { el.textContent = ''; return; }
        const { data, error } = await _supabase
            .from('launchpad_dropdown_sync_runs')
            .select('ran_at, ok, sheet_count, added, changed, removed, error')
            .eq('project_key', window.LP_CONFIG.projectKey)
            .order('ran_at', { ascending: false })
            .limit(1);
        if (error || !data || !data.length) {
            el.textContent = error ? '' : 'Assets haven\'t synced from the Google Sheet into the shared table yet. They sync at the times in Status Refresh Schedule.';
            return;
        }
        const run = data[0];
        const when = new Date(run.ran_at).toLocaleString();
        el.innerHTML = run.ok
            ? `Shared table: assets last synced from the Google Sheet ${this.esc(when)}: ${run.sheet_count} in the Sheet, ${run.added} added, ${run.changed} changed, ${run.removed} hidden.`
            : `<span style="color:#b3261e;">Last asset sync into the shared table (${this.esc(when)}) didn't run: ${this.esc(run.error || 'unknown error')}</span>`;
    },

    // After a change: reload the page's dropdowns if the change was to the
    // table in use, and the panel's copy of the table shown.
    async reload() {
        const view = this.view;
        if (view === this.inUse()) {
            if (typeof fetchDropdownOptions === 'function') await fetchDropdownOptions();
            if (typeof refreshDropdowns === 'function') refreshDropdowns();
            this.rowsByView[view] = window.dropdownRows;
        } else {
            const res = await LPOptions.load(_supabase, window.LP_CONFIG.projectKey, window.LP_CONFIG.tablePrefix, { source: view });
            this.rowsByView[view] = res.mode === view ? res.rows : null;
        }
        this.refreshList();
    },

    async addOption() {
        const input = document.getElementById('new-option-input');
        const placeInput = document.getElementById('new-option-place');
        const btn = document.getElementById('add-opt-btn');
        const val = input.value.trim();
        if (!val) return;

        btn.disabled = true;
        btn.innerText = 'Saving...';
        try {
            const place = this.currentCategory === 'Assets' ? placeInput.value.trim() : '';
            if (this.view === 'legacy') {
                await LPOptions.legacyAdd(_supabase, window.LP_CONFIG.tablePrefix, this.currentCategory, val, { place });
            } else {
                await LPOptions.add(_supabase, window.LP_CONFIG.projectKey, this.currentCategory, val, { place });
            }
            input.value = '';
            placeInput.value = '';
            await this.reload();
        } catch (error) {
            console.error('Settings Add Error:', error);
            alert('Error: ' + (error.message || 'Failed to save option.'));
        } finally {
            btn.disabled = false;
            btn.innerText = 'Add';
        }
    },

    async legacyRemove(value) {
        if (!confirm(`Remove "${value}" from the old table?`)) return;
        try {
            await LPOptions.legacyRemove(_supabase, window.LP_CONFIG.tablePrefix, this.currentCategory, value);
            await this.reload();
        } catch (error) {
            console.error('Settings Remove Error:', error);
            alert('Error: ' + (error.message || 'Failed to remove option.'));
        }
    },

    async setActive(value, active) {
        if (!active && !confirm(`Hide "${value}" from dropdowns?\n\nExisting rows keep this value, and you can restore it later with "Show hidden".`)) return;
        try {
            await LPOptions.setActive(_supabase, window.LP_CONFIG.projectKey, this.currentCategory, value, active,
                active ? 'Restored in Settings' : 'Hidden in Settings');
            await this.reload();
        } catch (error) {
            console.error('Settings Hide/Restore Error:', error);
            alert('Error: ' + (error.message || 'Failed to update option.'));
        }
    }
};
