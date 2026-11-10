// New projects and copying settings between projects (ARC-307).
//
// Shown only to the platform owner (launchpad_platform_owners, checked by
// lp_is_platform_owner()). The database functions in sync/new_project.sql do
// the work and check the owner again themselves, so hiding the buttons is
// only for tidiness, not security.
//
//   "+ Add new project"   in the project picker and the Switch Project
//                         popover. Asks for everything a project needs,
//                         creates it in one step (lp_create_project), then
//                         opens it straight away.
//   "Copy settings from another project"   in Settings, for the project
//                         that's open (lp_copy_project_settings).
(function () {
    'use strict';

    const PARTS = [
        ['schedule', 'Schedule columns, status colours, working days, blackout dates, refresh times', true],
        ['navigation', 'Navigation menu (which modules are shown)', true],
        ['equivalent_activities', 'Equivalent activity statuses', true],
        ['tamper_seals', 'Tamper seal settings', true],
        ['equipment_tracker', 'Equipment tracker settings', true],
        ['dropdowns', 'Dropdown lists', true]
    ];
    const LISTS = [
        ['Times', 'Times', true], ['Activities', 'Activities', true], ['Results', 'Results', true],
        ['Trade_Partners', 'Trade Partners', true], ['Places', 'Places', false],
        ['Assets', 'Assets', false], ['Zone', 'Zones', false]
    ];

    const C = {
        text: 'var(--neutrals-lightmode-light-mode-Textprimary, #141718)',
        muted: 'var(--neutrals-lightmode-light-mode-Textsecondary, #6a675f)',
        border: 'var(--neutrals-lightmode-light-mode-Border, #d6d3cb)',
        strong: 'var(--neutrals-lightmode-light-mode-Borderstrong, #b2aea4)',
        page: 'var(--neutrals-lightmode-light-mode-Page, #f3f2ee)',
        action: 'var(--lp-action, #2f7a31)'
    };
    const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const input = 'width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid ' + C.strong + '; border-radius:6px; font-size:14px;';
    const label = 'display:block; font-size:12px; font-weight:600; color:' + C.text + '; margin-bottom:10px;';

    // Asked once per page (per client); any failure, including the SQL not
    // being installed yet, means "not the owner".
    const ownerChecks = new WeakMap();
    function isOwner(sb) {
        if (!ownerChecks.has(sb)) {
            ownerChecks.set(sb, (async () => {
                try {
                    const { data, error } = await sb.rpc('lp_is_platform_owner');
                    return !error && data === true;
                } catch (e) { return false; }
            })());
        }
        return ownerChecks.get(sb);
    }

    function friendly(error) {
        const msg = (error && error.message) || String(error || 'Unknown error');
        if ((error && (error.code === 'PGRST202' || error.code === '42883')) || /Could not find the function/i.test(msg)) {
            return 'Project setup isn\'t installed yet. Run sync/new_project.sql in Supabase.';
        }
        return msg;
    }

    async function loadProjects(sb) {
        const { data, error } = await sb.rpc('lp_owner_projects');
        if (error) throw new Error(friendly(error));
        return data || [];
    }

    function modal(title) {
        const back = document.createElement('div');
        back.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:20000; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:24px 16px; box-sizing:border-box;';
        back.innerHTML = `
            <div role="dialog" aria-modal="true" aria-label="${esc(title)}" style="background:white; color:${C.text}; border-radius:12px; width:100%; max-width:640px; box-shadow:0 10px 30px rgba(0,0,0,0.25); text-align:left;">
                <div style="display:flex; justify-content:space-between; align-items:center; padding:16px 20px; border-bottom:1px solid ${C.border};">
                    <h2 style="margin:0; font-size:18px;">${esc(title)}</h2>
                    <button data-close style="background:none; border:none; font-size:24px; line-height:1; cursor:pointer; color:${C.muted};" aria-label="Close">&times;</button>
                </div>
                <div data-body style="padding:16px 20px 20px;"></div>
            </div>`;
        document.body.appendChild(back);
        const close = () => back.remove();
        back.querySelector('[data-close]').onclick = close;
        back.addEventListener('click', e => { if (e.target === back) close(); });
        return { el: back, body: back.querySelector('[data-body]'), close };
    }

    function projectOptions(projects, selected) {
        return projects.map(p => `<option value="${esc(p.project_key)}" ${p.project_key === selected ? 'selected' : ''}>${esc(p.project_name || p.project_key)} (${esc(p.project_key)}) · ${esc(p.client_name || '')}</option>`).join('');
    }

    function partsHtml(prefix) {
        return `
            <div style="display:grid; gap:6px; font-size:13px;">
                ${PARTS.map(([v, l, on]) => `<label style="display:flex; gap:8px; align-items:flex-start; cursor:pointer;"><input type="checkbox" data-part="${v}" ${on ? 'checked' : ''} style="margin-top:2px;"> ${esc(l)}</label>`).join('')}
            </div>
            <div data-lists style="margin:8px 0 0 24px; display:flex; flex-wrap:wrap; gap:6px 14px; font-size:13px;">
                ${LISTS.map(([v, l, on]) => `<label style="cursor:pointer;"><input type="checkbox" data-list="${v}" ${on ? 'checked' : ''}> ${esc(l)}</label>`).join('')}
            </div>
            <p style="font-size:12px; color:${C.muted}; margin:8px 0 0;">Dropdown options are only added, never removed. Places, Assets and Zones are usually project-specific, so they start unticked.</p>`;
    }

    function readParts(root) {
        const parts = [...root.querySelectorAll('[data-part]:checked')].map(c => c.dataset.part);
        const lists = [...root.querySelectorAll('[data-list]:checked')].map(c => c.dataset.list);
        return { parts, lists: parts.includes('dropdowns') ? lists : [] };
    }

    function wireLists(root) {
        const dd = root.querySelector('[data-part="dropdowns"]');
        const box = root.querySelector('[data-lists]');
        const sync = () => { box.style.opacity = dd.checked ? '1' : '.45'; box.querySelectorAll('input').forEach(i => { i.disabled = !dd.checked; }); };
        dd.onchange = sync; sync();
    }

    // Suggested key from the project name: its capital letters and digits,
    // or the first letters, made unique against the existing keys.
    function suggestKey(name, taken) {
        const words = String(name).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
        let base = words.length > 1 ? words.map(w => w[0]).join('') : (words[0] || '').slice(0, 4);
        base = base.toUpperCase().replace(/^[^A-Z]+/, '').slice(0, 8);
        if (base.length < 2) base = (base + 'PRJ').slice(0, 3);
        let key = base, n = 2;
        const set = new Set(taken.map(k => k.toLowerCase()));
        while (set.has(key.toLowerCase())) key = base + (n++);
        return key;
    }

    async function openCreate(sb, opts) {
        opts = opts || {};
        const m = modal('Add new project');
        m.body.innerHTML = `<p style="color:${C.muted}; font-size:14px;">Loading projects...</p>`;
        let projects;
        try { projects = await loadProjects(sb); } catch (e) {
            m.body.innerHTML = `<p style="color:#b3261e; font-size:14px;">${esc(e.message)}</p>`;
            return;
        }
        if (!projects.length) { m.body.innerHTML = `<p style="font-size:14px;">There's no existing project to copy the tables from.</p>`; return; }
        const me = String(opts.email || '').toLowerCase();
        const fromDefault = opts.currentProjectKey && projects.some(p => p.project_key === opts.currentProjectKey) ? opts.currentProjectKey : projects[0].project_key;
        const clients = [...new Set(projects.map(p => p.client_name).filter(Boolean))].sort();
        const today = new Date();
        const monday = new Date(today); monday.setDate(today.getDate() + ((8 - today.getDay()) % 7 || 7));
        const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        m.body.innerHTML = `
            <form data-form novalidate>
                <h3 style="font-size:14px; margin:0 0 10px;">Project</h3>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:0 14px;">
                    <label style="${label}">Project name *<input name="project_name" required style="${input}" placeholder="e.g. Building C Fit-out"></label>
                    <label style="${label}">Client *<input name="client_name" required list="lp-np-clients" style="${input}"><datalist id="lp-np-clients">${clients.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
                    <label style="${label}">Project key *<input name="project_key" required maxlength="16" style="${input} text-transform:none;" placeholder="e.g. BLDC">
                        <span data-key-note style="display:block; font-weight:400; color:${C.muted}; margin-top:3px;">Also the start of the project's table names. Letters and digits, can't be changed later.</span></label>
                    <label style="${label}">Start date *<input name="start_date" type="date" required value="${iso(monday)}" style="${input}"></label>
                    <label style="${label}">Duration (weeks) *<input name="duration_weeks" type="number" min="1" max="520" required value="12" style="${input}"></label>
                    <label style="${label}">Theme colour<input name="theme_color" type="color" value="#1b5e20" style="${input} height:40px; padding:3px;"></label>
                </div>
                <label style="${label}">Google Apps Script web app URL<input name="google_script_url" type="url" style="${input}" placeholder="https://script.google.com/macros/s/.../exec">
                    <span style="display:block; font-weight:400; color:${C.muted}; margin-top:3px;">From the project's Google Sheet. You can leave it blank and add it later.</span></label>
                <label style="${label}">Logo URL<input name="logo_url" type="url" style="${input}" placeholder="Optional"></label>

                <h3 style="font-size:14px; margin:16px 0 10px;">Copy from another project</h3>
                <label style="${label}">Tables shaped like *<select name="structure_from" style="${input}">${projectOptions(projects, fromDefault)}</select>
                    <span data-tables-note style="display:block; font-weight:400; color:${C.muted}; margin-top:3px;"></span></label>
                <label style="${label}">Settings from<select name="settings_from" style="${input}">${projectOptions(projects, fromDefault)}</select></label>
                <div data-parts style="background:${C.page}; border:1px solid ${C.border}; border-radius:8px; padding:10px 12px;">${partsHtml()}</div>

                <h3 style="font-size:14px; margin:16px 0 10px;">Admins</h3>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:0 14px;">
                    <label style="${label}">Admin email *<input name="admin_email" type="email" required value="${esc(me)}" style="${input}"></label>
                    <label style="${label}">Company<input name="company" value="CriticalArc" style="${input}"></label>
                </div>
                <label style="${label}">Other admins<input name="admins" style="${input}" placeholder="Emails, separated by commas">
                    <span style="display:block; font-weight:400; color:${C.muted}; margin-top:3px;">You're added as an admin too. Everyone else joins with the project's access code.</span></label>

                <p data-error role="alert" style="display:none; color:#b3261e; font-size:13px; font-weight:600; margin:10px 0 0;"></p>
                <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:16px; flex-wrap:wrap;">
                    <button type="button" data-cancel style="background:white; border:1px solid ${C.border}; border-radius:6px; padding:10px 16px; cursor:pointer; font-size:14px;">Cancel</button>
                    <button type="submit" data-submit style="background:${C.action}; color:white; border:none; border-radius:6px; padding:10px 18px; cursor:pointer; font-weight:bold; font-size:14px;">Create project</button>
                </div>
            </form>`;

        const form = m.body.querySelector('[data-form]');
        const f = n => form.elements[n];
        const taken = projects.map(p => p.project_key).concat(projects.map(p => p.table_prefix || ''));
        let keyTouched = false;
        f('project_key').oninput = () => { keyTouched = true; checkKey(); };
        f('project_name').oninput = () => { if (!keyTouched) { f('project_key').value = suggestKey(f('project_name').value, taken); checkKey(); } };
        const keyNote = form.querySelector('[data-key-note]');
        const keyHelp = keyNote.textContent;
        function checkKey() {
            const k = f('project_key').value.trim();
            let msg = '';
            if (k && !/^[A-Za-z][A-Za-z0-9]{1,15}$/.test(k)) msg = '2 to 16 letters or digits, starting with a letter.';
            else if (k && taken.some(t => t.toLowerCase() === k.toLowerCase())) msg = `${k} is already used by another project.`;
            keyNote.textContent = msg || keyHelp;
            keyNote.style.color = msg ? '#b3261e' : '';
            return !msg;
        }
        const tablesNote = form.querySelector('[data-tables-note]');
        const showTables = () => {
            const p = projects.find(x => x.project_key === f('structure_from').value);
            tablesNote.textContent = p ? `Creates ${p.tables.length} empty tables: ${p.tables.join(', ')}. No rows are copied.` : '';
        };
        f('structure_from').onchange = () => { showTables(); };
        showTables();
        wireLists(form.querySelector('[data-parts]'));
        form.querySelector('[data-cancel]').onclick = m.close;

        form.onsubmit = async e => {
            e.preventDefault();
            const err = form.querySelector('[data-error]');
            err.style.display = 'none';
            const missing = ['project_name', 'client_name', 'project_key', 'start_date', 'duration_weeks', 'admin_email'].filter(n => !String(f(n).value).trim());
            if (missing.length || !checkKey()) {
                err.textContent = missing.length ? 'Fill in the fields marked *.' : 'Fix the project key.';
                err.style.display = 'block';
                (missing.length ? f(missing[0]) : f('project_key')).focus();
                return;
            }
            const { parts, lists } = readParts(form);
            const body = {
                project_key: f('project_key').value.trim(),
                project_name: f('project_name').value.trim(),
                client_name: f('client_name').value.trim(),
                start_date: f('start_date').value,
                duration_weeks: parseInt(f('duration_weeks').value, 10),
                theme_color: f('theme_color').value,
                google_script_url: f('google_script_url').value.trim(),
                logo_url: f('logo_url').value.trim(),
                structure_from: f('structure_from').value,
                settings_from: f('settings_from').value,
                copy_parts: parts,
                copy_lists: lists,
                admin_email: f('admin_email').value.trim().toLowerCase(),
                company: f('company').value.trim(),
                admins: f('admins').value.split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
            };
            if (!confirm(`Create project ${body.project_key} (${body.project_name})?\n\nThis creates its tables in the live database.`)) return;
            const btn = form.querySelector('[data-submit]');
            btn.disabled = true; btn.textContent = 'Creating...';
            try {
                const { data, error } = await sb.rpc('lp_create_project', { p: body });
                if (error) throw new Error(friendly(error));
                showCreated(m, data, body);
            } catch (ex) {
                console.warn('Create project failed:', ex.message || ex);
                err.textContent = ex.message || 'Creating the project failed. Nothing was created.';
                err.style.display = 'block';
                btn.disabled = false; btn.textContent = 'Create project';
            }
        };
        f('project_name').focus();
    }

    function showCreated(m, result, body) {
        const settings = (result.settings || []).map(s => `<li>${esc(s.part.replace(/_/g, ' '))}: ${esc(s.result)}</li>`).join('');
        m.body.innerHTML = `
            <p style="font-size:15px; margin-top:0;"><b>${esc(body.project_name)}</b> (${esc(result.project_key)}) is ready.</p>
            <div style="background:${C.page}; border:1px solid ${C.border}; border-radius:8px; padding:12px; margin-bottom:12px;">
                <div style="font-size:12px; color:${C.muted};">Access code to share with the team</div>
                <div style="font-size:26px; font-weight:700; letter-spacing:4px;">${esc(result.access_code)}</div>
            </div>
            <ul style="font-size:13px; padding-left:18px; margin:0 0 12px;">
                <li>${(result.tables || []).length} tables created</li>
                <li>Admins: ${esc((result.admins || []).join(', '))}</li>
                ${settings}
            </ul>
            <p style="font-size:13px; color:${C.muted};">${body.google_script_url ? 'Next: make sure the project\'s Apps Script has the LaunchPad actions deployed.' : 'Next: add the Google Apps Script URL when the project\'s Sheet is ready.'}</p>
            <div style="display:flex; justify-content:flex-end; gap:10px; flex-wrap:wrap;">
                <button data-done style="background:white; border:1px solid ${C.border}; border-radius:6px; padding:10px 16px; cursor:pointer; font-size:14px;">Close</button>
                <button data-open style="background:${C.action}; color:white; border:none; border-radius:6px; padding:10px 18px; cursor:pointer; font-weight:bold; font-size:14px;">Open project</button>
            </div>`;
        m.body.querySelector('[data-done]').onclick = () => { m.close(); location.reload(); };
        m.body.querySelector('[data-open]').onclick = () => {
            sessionStorage.setItem('launchpad_skip_picker_once', result.project_key);
            location.reload();
        };
    }

    async function openCopySettings(sb, currentKey) {
        const m = modal('Copy settings from another project');
        m.body.innerHTML = `<p style="color:${C.muted}; font-size:14px;">Loading projects...</p>`;
        let projects;
        try { projects = (await loadProjects(sb)).filter(p => p.project_key !== currentKey); } catch (e) {
            m.body.innerHTML = `<p style="color:#b3261e; font-size:14px;">${esc(e.message)}</p>`;
            return;
        }
        if (!projects.length) { m.body.innerHTML = '<p style="font-size:14px;">There are no other projects to copy from.</p>'; return; }
        m.body.innerHTML = `
            <label style="${label}">Copy from<select data-from style="${input}">${projectOptions(projects)}</select></label>
            <div data-parts style="background:${C.page}; border:1px solid ${C.border}; border-radius:8px; padding:10px 12px;">${partsHtml()}</div>
            <p style="font-size:12px; color:${C.muted};">The ticked settings replace this project's (${esc(currentKey)}) current ones, the same as saving them here. The page reloads afterwards.</p>
            <p data-error role="alert" style="display:none; color:#b3261e; font-size:13px; font-weight:600;"></p>
            <div style="display:flex; justify-content:flex-end; gap:10px; flex-wrap:wrap;">
                <button data-cancel style="background:white; border:1px solid ${C.border}; border-radius:6px; padding:10px 16px; cursor:pointer; font-size:14px;">Cancel</button>
                <button data-go style="background:${C.action}; color:white; border:none; border-radius:6px; padding:10px 18px; cursor:pointer; font-weight:bold; font-size:14px;">Copy settings</button>
            </div>`;
        wireLists(m.body.querySelector('[data-parts]'));
        m.body.querySelector('[data-cancel]').onclick = m.close;
        m.body.querySelector('[data-go]').onclick = async e => {
            const btn = e.currentTarget;
            const err = m.body.querySelector('[data-error]');
            const from = m.body.querySelector('[data-from]').value;
            const { parts, lists } = readParts(m.body);
            if (!parts.length) { err.textContent = 'Tick at least one setting to copy.'; err.style.display = 'block'; return; }
            if (!confirm(`Copy ${parts.length} setting group(s) from ${from} into ${currentKey}?`)) return;
            btn.disabled = true; btn.textContent = 'Copying...';
            try {
                const { data, error } = await sb.rpc('lp_copy_project_settings', { p_from: from, p_to: currentKey, p_parts: parts, p_lists: lists });
                if (error) throw new Error(friendly(error));
                alert('Copied:\n' + (data || []).map(s => `• ${s.part.replace(/_/g, ' ')}: ${s.result}`).join('\n'));
                location.reload();
            } catch (ex) {
                console.warn('Copy settings failed:', ex.message || ex);
                err.textContent = ex.message || 'Copying failed. Nothing was changed.';
                err.style.display = 'block';
                btn.disabled = false; btn.textContent = 'Copy settings';
            }
        };
    }

    // Owner-only entry points. Each fills its slot only for the owner.
    async function mountPicker(sb, slot, email) {
        if (!slot || !(await isOwner(sb))) return;
        slot.innerHTML = `<button type="button" style="width:100%; margin-bottom:14px; padding:11px; border:1px dashed ${C.action}; border-radius:10px; background:white; color:${C.action}; font-weight:700; font-size:14px; cursor:pointer;">+ Add new project</button>`;
        slot.querySelector('button').onclick = () => openCreate(sb, { email });
    }

    async function mountPopover(sb, slot, email, currentProjectKey) {
        if (!slot || !(await isOwner(sb))) return;
        slot.innerHTML = `<button type="button" style="width:100%; margin-top:6px; text-align:left; background:white; border:1px dashed ${C.action}; border-radius:7px; padding:8px 10px; font-size:13px; font-weight:600; color:${C.action}; cursor:pointer;">+ Add new project</button>`;
        slot.querySelector('button').onclick = e => {
            e.stopPropagation();
            const pop = document.getElementById('switch-project-popover');
            if (pop) pop.remove();
            openCreate(sb, { email, currentProjectKey });
        };
    }

    async function mountSettings(sb, slot, currentKey) {
        if (!slot || !(await isOwner(sb))) return;
        slot.style.display = '';
        slot.innerHTML = `
            <h2 style="color:${C.text}; margin:0;">Copy Settings</h2>
            <p style="font-size:12px; color:${C.muted}; margin:0 0 12px;">Copy schedule, navigation, seal, tracker and dropdown settings from another project into this one. Only you can see this.</p>
            <button type="button" style="background:white; border:1px solid ${C.action}; color:${C.action}; border-radius:6px; padding:9px 14px; cursor:pointer; font-weight:600; font-size:14px;">Copy settings from another project...</button>`;
        slot.querySelector('button').onclick = () => openCopySettings(sb, currentKey);
    }

    window.LPProjectSetup = { isOwner, openCreate, openCopySettings, mountPicker, mountPopover, mountSettings, suggestKey };
})();
