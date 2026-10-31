// <seal-form-view> — the field-facing Tamper Seal request form.
//
// Used two ways:
//   1. Standalone: seal-form.html loads this module directly and the
//      element reads `?id=<project-uuid>` from the page URL itself — this
//      is the URL printed/shown as a QR code and scanned by field workers
//      with no LaunchPad login at all. This contract (param name `id`,
//      zero dependency on any other script) must keep working exactly as
//      before.
//   2. Embedded: index.html's "Seal Form Preview" tab dynamically imports
//      this module and mounts <seal-form-view project-uuid="..." embedded>
//      directly into the shell, passing the project uuid it already knows
//      and (as an optimization) its own already-authenticated Supabase
//      client instead of letting this element create a second one.
//
// Shadow DOM gives this element its own style/DOM scope so its markup and
// CSS (and the same for the Equipment Tracker / Bridge / Tamper Seals
// elements) can't collide with each other or with the shell, the way four
// separate iframed documents' globals never could either — but as one real
// custom element instead of four extra browsing contexts.

const SUPABASE_URL = 'https://rcnxetcomdrlxvlarqoc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjbnhldGNvbWRybHh2bGFycW9jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0NDIyMjksImV4cCI6MjA5MjAxODIyOX0.gP37sT5OrCOVRZXekMrBZHm5mtfnr6JrC2YGflWsDQU';

// Same sensible default as tamperseal.html's own makeDefaultWorkflow, used
// only if no config has ever been saved for this project yet. Pure — no
// instance state — so it stays a plain module function.
function getDefaultWorkflows() {
    return [{
        id: 'default', name: 'Default Workflow', active: true,
        statuses: [
            { id: 'intact', name: 'Intact', color: '#c8e6c9' },
            { id: 'break_requested', name: 'Break Requested (Pending Approval)', color: '#bbdefb' },
            { id: 'break_approved', name: 'Break Approved by CCM', color: '#e1bee7' },
            { id: 'broken_approved', name: 'Broken - CCM Approved', color: '#fff9c4' },
            { id: 'ready_for_reseal', name: 'Ready for Reseal', color: '#ffe0b2' },
            { id: 'replaced_approved', name: 'Replaced (Approved)', color: '#e0e0e0' },
            { id: 'non_approved_break', name: 'Non-Approved Break', color: '#ffcdd2' },
            { id: 'replaced_non_approved', name: 'Replaced (Non-Approved)', color: '#e0e0e0' }
        ],
        transitions: [
            { id: 't1', from: ['intact'], to: 'break_requested', formTrigger: 'break-request' },
            { id: 't2', from: ['break_approved'], to: 'broken_approved', formTrigger: 'break-seals' },
            { id: 't3', from: ['broken_approved'], to: 'ready_for_reseal', formTrigger: 'work-completed' }
        ]
    }];
}

const sectionConfig = {
    'break-request': { title: 'Break Request', subtitle: 'Request approval to break a seal' },
    'break-seals': { title: 'Break Seals', subtitle: 'Log an approved seal break' },
    'work-completed': { title: 'Work Completed', subtitle: 'Mark seals ready for reseal' }
};

// Builds a message that's honest about partial failures — pure, no
// instance state, stays a plain module function.
function buildResultMessage(result, successMessage) {
    const totalProblems = result.skipped.length + result.blocked.length;
    if (totalProblems === 0) return { title: 'Success', message: successMessage };

    const parts = [];
    if (result.skipped.length > 0) {
        parts.push(`No configured transition exists for their current status via this form: ${result.skipped.join(', ')}. Ask your site admin to check the Status Flow settings.`);
    }
    if (result.blocked.length > 0) {
        parts.push(`The database rejected the update for: ${result.blocked.join(', ')}. This usually means a permissions (RLS) policy is missing on this project's Assets table — ask your site admin to check that.`);
    }

    if (!result.anyUpdated) {
        return { title: 'Nothing Updated', message: parts.join(' ') };
    }
    return {
        title: 'Partially Completed',
        message: `${result.updatedCount} seal(s) updated successfully. ${parts.join(' ')}`
    };
}

const STYLE = `
<style>
    :host { display: block; font-family: Roboto, 'Segoe UI', sans-serif; background: var(--neutrals-lightmode-light-mode-Page, #f3f2ee); color: #222; }
    .header { background: var(--lp-action-hover, #276629); color: white; padding: 22px 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 20px; }
    .header p { margin: 4px 0 0; font-size: 13px; opacity: 0.9; }
    .container { max-width: 500px; margin: 0 auto; padding: 20px; }
    .card { background: white; border-radius: 10px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); box-sizing: border-box; }
    .card p { color: var(--neutrals-lightmode-light-mode-Textsecondary, #6a675f); font-size: 14px; line-height: 1.5; margin-top: 0; }
    label { display: block; font-weight: 600; font-size: 14px; margin: 14px 0 6px; }
    input[type=text], input[type=email], input[type=date], textarea, select {
        width: 100%; padding: 12px; border: 1px solid var(--neutrals-lightmode-light-mode-Border, #d6d3cb); border-radius: 8px; font-size: 16px; box-sizing: border-box; font-family: inherit;
    }
    textarea { min-height: 80px; resize: vertical; }
    button.submit-btn {
        width: 100%; padding: 16px; background: var(--lp-action-hover, #276629); color: white; border: none; border-radius: 8px;
        font-size: 16px; font-weight: bold; margin-top: 20px; cursor: pointer;
    }
    button.submit-btn:disabled { background: #aaa; }
    .success { text-align: center; padding: 40px 20px; }
    .success .icon { font-size: 48px; }
    .error-box { background: #ffebee; color: #c62828; padding: 12px; border-radius: 8px; margin-top: 12px; font-size: 14px; }
    .loading { text-align: center; padding: 60px 20px; color: var(--neutrals-lightmode-light-mode-Textsecondary, #6a675f); }
    .empty-note { color: var(--neutrals-lightmode-light-mode-Textsecondary, #6a675f); text-align: center; padding: 10px 0; font-size: 14px; }
    .ccm-banner {
        background: #fff3e0; border: 1px solid #ffb74d; color: #e65100; border-radius: 8px;
        padding: 12px 14px; font-size: 13px; font-weight: 600; margin-bottom: 16px; line-height: 1.4;
    }
    .form-explainer {
        background: var(--lp-action-tint, #eaf6ea); border-left: 3px solid var(--lp-action, #2f7a31); padding: 10px 12px; border-radius: 4px;
        font-size: 13px; color: #33513a; margin-bottom: 16px; line-height: 1.4;
    }

    .action-btn {
        display: block; width: 100%; padding: 20px; margin-bottom: 12px; border-radius: 10px; border: none;
        font-size: 17px; font-weight: bold; color: white; cursor: pointer; text-align: left;
    }
    .action-btn .sub { display: block; font-weight: normal; font-size: 12.5px; opacity: 0.9; margin-top: 3px; }
    .action-break-request { background: #1976d2; }
    .action-break-seals { background: #c62828; }
    .action-work-completed { background: #ef6c00; }
    .back-link { display: inline-block; margin-bottom: 12px; color: var(--lp-action-hover, #276629); font-weight: 600; font-size: 14px; cursor: pointer; text-decoration: none; }

    .multiselect-dropdown { position: relative; margin-bottom: 4px; }
    .multiselect-toggle {
        width: 100%; text-align: left; padding: 12px; border: 1px solid var(--neutrals-lightmode-light-mode-Border, #d6d3cb); border-radius: 8px; font-size: 15px;
        background: white; cursor: pointer; box-sizing: border-box; font-family: inherit;
    }
    .multiselect-panel {
        display: none; position: absolute; top: 100%; left: 0; right: 0; margin-top: 4px; background: white;
        border: 1px solid var(--neutrals-lightmode-light-mode-Border, #d6d3cb); border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.15); z-index: 20;
        max-height: 260px; overflow-y: auto; padding: 6px 14px;
    }
    .multiselect-panel.open { display: block; }
    .multiselect-search {
        width: 100%; padding: 8px 10px; margin: 6px 0 8px; border: 1px solid var(--neutrals-lightmode-light-mode-Border, #d6d3cb); border-radius: 6px;
        font-size: 14px; box-sizing: border-box; position: sticky; top: 0; background: white; z-index: 2;
    }
    .multiselect-options { display: flex; flex-direction: column; }
    .seal-check { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--neutrals-lightmode-light-mode-Subtle, #e7e5df); font-size: 15px; }
    .seal-check:last-child { border-bottom: none; }
    .seal-check input { width: 20px; height: 20px; flex-shrink: 0; }
    .new-seal-box { background: #fff3e0; border: 1px dashed #ef6c00; border-radius: 8px; padding: 14px; margin-top: 10px; }
    .new-seal-box p { margin: 0 0 10px; font-size: 13px; color: #e65100; font-weight: 600; }
    .new-seal-box input { margin-bottom: 8px; }
    .new-seal-box button { width: 100%; padding: 10px; background: #ef6c00; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
</style>
`;

const MARKUP = `
<div class="header">
    <h1 id="form-title">Tamper Seal Forms</h1>
    <p id="form-subtitle">Loading...</p>
</div>
<div class="container">
    <div class="ccm-banner">⚠️ Contact the Chain of Custody Manager (CCM) before breaking any seal. Do not break a seal without an approved Break Request on file.</div>
    <div id="app-content" class="loading">Loading...</div>
</div>
`;

export class SealFormView extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._outsideClickHandler = this._handleOutsideClick.bind(this);

        this.PROJECT_ID = '';
        this.PROJECT_KEY = '';
        this.SITE_NAME = '';
        this.sectionFilterStatuses = { 'break-request': null, 'break-seals': null, 'work-completed': null };
        this.allSeals = [];
        this.scriptUrl = '';
        this.newlyCreatedSeals = [];
        this.workflows = [];
        this.globalStatusOrder = [];
    }

    connectedCallback() {
        if (this._mounted) return; // re-entrant connect (e.g. node moved) shouldn't re-init
        this._mounted = true;
        this._resolveParams();
        this.shadowRoot.innerHTML = STYLE + MARKUP;
        this._initSupabase();
        document.addEventListener('click', this._outsideClickHandler);
        this.init();
    }

    disconnectedCallback() {
        document.removeEventListener('click', this._outsideClickHandler);
    }

    _resolveParams() {
        const qp = new URLSearchParams(window.location.search);
        this.PROJECT_ID = this.getAttribute('project-uuid') || qp.get('id') || '';
    }

    _initSupabase() {
        const injected = this.supabaseClient || window.launchpadSupabaseClient;
        this._supabase = injected || window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }

    // Shadow-scoped DOM helpers — replace the old document.getElementById /
    // document.querySelectorAll so lookups can't collide with the shell's
    // own ids or the other three views' shadow trees.
    $(id) { return this.shadowRoot.getElementById(id); }
    $$(sel) { return this.shadowRoot.querySelectorAll(sel); }

    // Called at the start of every submit*() handler and again on its
    // every failure path (never on success — showSuccess() replaces the
    // whole form, button included, so there's nothing left to re-enable)
    // — per request, the form stayed fully editable and the Submit button
    // stayed clickable for the entire multi-second chain of sequential
    // inserts/notifications each handler runs, which could be double-
    // submitted or edited mid-flight with nothing to show it was even
    // working. Locks every field and the submit button itself, swapping
    // the button's own label for "Submitting…" (restored from
    // data-original-label on the way back out) rather than a generic one,
    // so a project's three differently-worded buttons ("Submit Break
    // Request", "Log Seal Break", "Notify Ready for Reseal") still read
    // naturally while busy.
    setFormBusy(busy) {
        const btn = this.$$('.submit-btn')[0];
        if (btn) {
            if (busy) {
                if (!btn.dataset.originalLabel) btn.dataset.originalLabel = btn.textContent;
                btn.textContent = 'Submitting…';
            } else if (btn.dataset.originalLabel) {
                btn.textContent = btn.dataset.originalLabel;
            }
            btn.disabled = busy;
        }
        this.$$('.card input, .card select, .card textarea').forEach(el => { el.disabled = busy; });
    }

    // A document-level click listener sees `event.target` retargeted to
    // this element itself (Shadow DOM retargeting), not the actual element
    // that was clicked inside the shadow tree — composedPath() is the
    // correct way to find the real originating element from outside.
    _handleOutsideClick(e) {
        const insideDropdown = e.composedPath().some(el => el.classList && el.classList.contains('multiselect-dropdown'));
        if (!insideDropdown) {
            this.$$('.multiselect-panel.open').forEach(p => p.classList.remove('open'));
        }
    }

    T(table) { return `${this.PROJECT_KEY}${table}`; }

    getActiveWorkflows() {
        const active = this.workflows.filter(w => w.active);
        return active.length > 0 ? active : (this.workflows[0] ? [this.workflows[0]] : []);
    }

    getActiveStatuses() {
        const seen = new Set();
        const result = [];
        this.getActiveWorkflows().forEach(w => {
            w.statuses.forEach(s => {
                const key = s.name.toLowerCase();
                if (!seen.has(key)) { seen.add(key); result.push(s); }
            });
        });
        if (this.globalStatusOrder.length === 0) return result;
        return result.slice().sort((a, b) => {
            const ai = this.globalStatusOrder.indexOf(a.name.toLowerCase());
            const bi = this.globalStatusOrder.indexOf(b.name.toLowerCase());
            if (ai === -1 && bi === -1) return 0;
            if (ai === -1) return 1;
            if (bi === -1) return -1;
            return ai - bi;
        });
    }

    // Resolves each transition's internal status ids to their actual
    // NAMES — a seal's current status is stored/matched by name, and a
    // status id is only meaningful within the one workflow it belongs to.
    getActiveTransitions() {
        const result = [];
        this.getActiveWorkflows().forEach(w => {
            w.transitions.forEach(t => {
                const toStatus = w.statuses.find(s => s.id === t.to);
                if (!toStatus) return;
                // "from" is normally an array (a trigger can require
                // any of several previous statuses) — this also handles
                // an older save where it was still a single value.
                const fromIds = Array.isArray(t.from) ? t.from : [t.from];
                fromIds.forEach(fromId => {
                    const fromStatus = w.statuses.find(s => s.id === fromId);
                    if (fromStatus) {
                        result.push({ fromName: fromStatus.name, toName: toStatus.name, formTrigger: t.formTrigger || '' });
                    }
                });
            });
        });
        return result;
    }

    // A seal with no status yet is treated as sitting at the workflow's
    // first defined status (its natural starting point).
    effectiveStatusName(seal) {
        const raw = (seal.status || '').trim();
        if (raw) return raw;
        const first = this.getActiveStatuses()[0];
        return first ? first.name : '';
    }

    isEligibleForSection(seal, section) {
        const current = this.effectiveStatusName(seal).toLowerCase();
        const allowList = this.sectionFilterStatuses[section];

        if (allowList === null || allowList === undefined) {
            // Never configured for this section — fall back to the
            // original behavior: a seal shows up only if there's an
            // active trigger away from its current status for this form.
            return this.getActiveTransitions().some(t => t.fromName.toLowerCase() === current && t.formTrigger === section);
        }

        // Configured: the admin's checklist in Setup Config is
        // authoritative for whether a seal appears at all — a status
        // can be checked there even without a matching trigger (that's
        // exactly what the "⚠ No matching trigger" warning next to it
        // is flagging). Someone can still select and submit that seal;
        // applyStatusTransitions() already reports "NOT MOVED — no
        // trigger matches" rather than silently failing or crashing.
        return allowList.includes(current);
    }

    getNextStatus(seal, section) {
        const current = this.effectiveStatusName(seal).toLowerCase();
        const match = this.getActiveTransitions().find(t => t.fromName.toLowerCase() === current && t.formTrigger === section);
        return match ? match.toName : null;
    }

    async init() {
        const content = this.$('app-content');

        if (!this.PROJECT_ID) {
            content.innerHTML = '<div class="card"><div class="error-box">This link is missing required information. Please contact your site admin.</div></div>';
            return;
        }

        this.$('form-subtitle').innerText = 'What would you like to do?';

        try {
            const { data: project } = await this._supabase
                .from('launchpad_projects')
                .select('project_key, google_script_url, client_name')
                .eq('public_uuid', this.PROJECT_ID)
                .maybeSingle();

            if (!project) {
                content.innerHTML = '<div class="card"><div class="error-box">This link isn\'t valid. Please contact your site admin for a current QR code.</div></div>';
                return;
            }

            this.PROJECT_KEY = project.project_key;
            this.scriptUrl = project.google_script_url || '';
            this.SITE_NAME = project.project_key || project.client_name || '';
            // Only the standalone page (scanned via QR, no shell around it)
            // should get to rename the browser tab — inside index.html's
            // preview tab this would clobber the shell's own title.
            if (this.SITE_NAME && !this.hasAttribute('embedded')) document.title = `${this.SITE_NAME} Tamper Seal Forms`;
        } catch (e) {
            console.warn('Could not load project config:', e);
            content.innerHTML = '<div class="card"><div class="error-box">Could not load this project. Please contact your site admin.</div></div>';
            return;
        }

        this.workflows = getDefaultWorkflows();
        try {
            const { data: cfgRow } = await this._supabase
                .from('launchpad_tamperseal_config')
                .select('config')
                .eq('project_key', this.PROJECT_KEY)
                .maybeSingle();
            const data = cfgRow && cfgRow.config;
            if (data) {
                if (Array.isArray(data.workflows) && data.workflows.length > 0) {
                    this.workflows = data.workflows;
                    if (!this.workflows.some(w => w.active)) this.workflows[0].active = true;
                } else if (data.statusFlow && Array.isArray(data.statusFlow.statuses)) {
                    // Migrate an older single-workflow save into the
                    // current structure, same as tamperseal.html does.
                    this.workflows = [{
                        id: 'default', name: 'Default Workflow', active: true,
                        statuses: data.statusFlow.statuses,
                        transitions: data.statusFlow.transitions || []
                    }];
                }
                if (Array.isArray(data.globalStatusOrder)) this.globalStatusOrder = data.globalStatusOrder;
                // null stays null (unconfigured = no restriction) if the
                // saved config doesn't have this key yet or it's not an
                // array — see the matching comment in tamperseal.html's
                // SECTION_FILTER_META for why that default matters here.
                if (Array.isArray(data.breakRequestFilterStatuses)) this.sectionFilterStatuses['break-request'] = data.breakRequestFilterStatuses;
                if (Array.isArray(data.breakSealsFilterStatuses)) this.sectionFilterStatuses['break-seals'] = data.breakSealsFilterStatuses;
                if (Array.isArray(data.workCompletedFilterStatuses)) this.sectionFilterStatuses['work-completed'] = data.workCompletedFilterStatuses;
            }
        } catch (e) { console.warn('Could not load workflow config, using default:', e); }

        const { data: seals, error } = await this._supabase.from(this.T('Assets')).select('*');
        if (error) {
            content.innerHTML = '<div class="card"><div class="error-box">Could not load the seal log for this project. Please contact your site admin.</div></div>';
            return;
        }
        this.allSeals = seals || [];

        this.renderActionSelect();
        this.dispatchEvent(new CustomEvent('view-ready', { bubbles: true, composed: true }));
    }

    renderActionSelect() {
        this.$('form-title').innerText = this.SITE_NAME ? `${this.SITE_NAME} Tamper Seal Forms` : 'Tamper Seal Forms';
        this.$('form-subtitle').innerText = 'What would you like to do?';
        this.$('app-content').innerHTML = `
            <button class="action-btn action-break-request" onclick="this.getRootNode().host.selectSection('break-request')">
                🔒 Break Request
                <span class="sub">Request approval before breaking a seal</span>
            </button>
            <button class="action-btn action-break-seals" onclick="this.getRootNode().host.selectSection('break-seals')">
                ✂️ Break Seals
                <span class="sub">Log a seal you've broken after approval</span>
            </button>
            <button class="action-btn action-work-completed" onclick="this.getRootNode().host.selectSection('work-completed')">
                ✅ Work Completed
                <span class="sub">Mark work done and ready for reseal</span>
            </button>
        `;
    }

    selectSection(section) {
        const cfg = sectionConfig[section];
        this.$('form-subtitle').innerText = `${cfg.title} — ${cfg.subtitle}`;

        const content = this.$('app-content');
        if (section === 'break-request') this.renderBreakRequestForm(content);
        else if (section === 'break-seals') this.renderBreakSealsForm(content);
        else if (section === 'work-completed') this.renderWorkCompletedForm(content);
    }

    backToActionSelect() {
        this.renderActionSelect();
    }

    // ===== Reusable asset -> seal dropdown picker =====
    // Both dropdowns are buttons that reveal a checklist panel underneath
    // when clicked (closed by clicking elsewhere) — multi-select via
    // checkboxes, presented as a compact dropdown rather than an
    // always-expanded list. Picking asset(s) narrows the seal panel to
    // only that section's eligible seals for those asset(s).
    renderAssetSealPickerHtml(section) {
        const uniqueAssetNames = [...new Set(this.allSeals.concat(this.newlyCreatedSeals).map(s => s.asset_name).filter(Boolean))].sort();

        return `
            <label>Asset(s)</label>
            <div class="multiselect-dropdown">
                <button type="button" class="multiselect-toggle" id="${section}-asset-toggle" onclick="this.getRootNode().host.toggleMultiselect(event, '${section}-asset-panel')">Select asset(s)... ▾</button>
                <div class="multiselect-panel" id="${section}-asset-panel">
                    <input type="text" class="multiselect-search" placeholder="Type to filter..." oninput="this.getRootNode().host.filterMultiselectOptions(this)" onclick="event.stopPropagation()">
                    <div class="multiselect-options">
                        ${uniqueAssetNames.length > 0 ? uniqueAssetNames.map(name => `
                            <label class="seal-check">
                                <input type="checkbox" name="${section}-asset" value="${name}" onchange="this.getRootNode().host.updateSealDropdown('${section}')">
                                ${name}
                            </label>
                        `).join('') : '<p class="empty-note">No assets with tamper seals found for this project.</p>'}
                    </div>
                </div>
            </div>

            <label>Seal(s)</label>
            <div class="multiselect-dropdown">
                <button type="button" class="multiselect-toggle" id="${section}-seal-toggle" onclick="this.getRootNode().host.toggleMultiselect(event, '${section}-seal-panel')">Select asset(s) first...</button>
                <div class="multiselect-panel" id="${section}-seal-panel">
                    <p class="empty-note">Select an asset above to see its seals.</p>
                </div>
            </div>
        `;
    }

    // Filters the checkbox labels within the same panel as the search
    // input, by simple case-insensitive substring match against each
    // label's text.
    filterMultiselectOptions(input) {
        const query = input.value.trim().toLowerCase();
        const panel = input.closest('.multiselect-panel');
        const options = panel.querySelectorAll('.multiselect-options .seal-check');
        options.forEach(el => {
            const text = el.textContent.toLowerCase();
            el.style.display = text.includes(query) ? 'flex' : 'none';
        });
    }

    toggleMultiselect(evt, panelId) {
        evt.stopPropagation();
        const panel = this.$(panelId);
        const isOpen = panel.classList.contains('open');
        this.$$('.multiselect-panel.open').forEach(p => p.classList.remove('open'));
        if (!isOpen) panel.classList.add('open');
    }

    updateSealDropdown(section) {
        const checkedAssets = Array.from(this.$$(`input[name="${section}-asset"]:checked`)).map(el => el.value);
        const panel = this.$(`${section}-seal-panel`);
        const assetToggle = this.$(`${section}-asset-toggle`);
        const sealToggle = this.$(`${section}-seal-toggle`);

        assetToggle.innerText = (checkedAssets.length > 0 ? `${checkedAssets.length} asset(s) selected` : 'Select asset(s)...') + ' ▾';

        if (checkedAssets.length === 0) {
            panel.innerHTML = '<p class="empty-note">Select an asset above to see its seals.</p>';
            sealToggle.innerText = 'Select asset(s) first... ▾';
            return;
        }

        const eligible = this.allSeals.concat(this.newlyCreatedSeals).filter(s =>
            checkedAssets.includes(s.asset_name) && this.isEligibleForSection(s, section)
        );

        let optionsHtml = eligible.map(s => `
            <label class="seal-check">
                <input type="checkbox" name="${section}-seal" value="${s.id}" onchange="this.getRootNode().host.updateSealToggleLabel('${section}')">
                ${s.seal_number}${s.sub_area ? ' — ' + s.sub_area : ''} — ${s.asset_name}
            </label>
        `).join('');

        if (eligible.length === 0) {
            optionsHtml = '<p class="empty-note">No eligible seals found for the selected asset(s).</p>';
        }

        panel.innerHTML = `
            <input type="text" class="multiselect-search" placeholder="Type to filter..." oninput="this.getRootNode().host.filterMultiselectOptions(this)" onclick="event.stopPropagation()">
            <div class="multiselect-options">${optionsHtml}</div>
            <div id="${section}-new-seal-box-wrap"></div>
            <a class="back-link" style="margin-top:8px;" onclick="this.getRootNode().host.showNewSealBox('${section}')">+ This seal isn't listed / add a new one</a>
        `;
        sealToggle.innerText = 'Select seal(s)... ▾';
    }

    updateSealToggleLabel(section) {
        const checked = this.$$(`input[name="${section}-seal"]:checked`).length;
        const toggle = this.$(`${section}-seal-toggle`);
        toggle.innerText = (checked > 0 ? `${checked} seal(s) selected` : 'Select seal(s)...') + ' ▾';
    }

    showNewSealBox(section) {
        const wrap = this.$(`${section}-new-seal-box-wrap`);
        wrap.innerHTML = `
            <div class="new-seal-box">
                <p>Add a seal that isn't in the log yet:</p>
                <input type="text" id="${section}-new-seal-number" placeholder="Seal Number">
                <input type="text" id="${section}-new-seal-asset" placeholder="Asset Name">
                <input type="text" id="${section}-new-seal-location" placeholder="Location">
                <input type="text" id="${section}-new-seal-subarea" placeholder="Sub Area (optional)">
                <button type="button" onclick="this.getRootNode().host.createNewSeal('${section}')">Add This Seal</button>
            </div>
        `;
    }

    // A brand-new seal created from Break Seals or Work Completed needs
    // to start at a status that's actually eligible for THAT section's
    // trigger — otherwise it'd be created and then immediately absent
    // from the very list it was just added to. Break Request keeps
    // using the workflow's own starting status, since that's what a
    // genuinely new/never-logged seal should be.
    getStartingStatusForSection(section) {
        if (section !== 'break-request') {
            const match = this.getActiveTransitions().find(t => t.formTrigger === section);
            if (match) return match.fromName;
        }
        const first = this.getActiveStatuses()[0];
        return first ? first.name : 'Intact';
    }

    async createNewSeal(section) {
        const sealNumber = this.$(`${section}-new-seal-number`).value.trim();
        const assetName = this.$(`${section}-new-seal-asset`).value.trim();
        const location = this.$(`${section}-new-seal-location`).value.trim();
        const subArea = this.$(`${section}-new-seal-subarea`).value.trim();

        if (!sealNumber || !assetName) {
            alert('Please enter at least a seal number and an asset name.');
            return;
        }

        try {
            const { data, error } = await this._supabase.from(this.T('Assets')).insert([{
                asset_name: assetName,
                location: location,
                sub_area: subArea,
                seal_number: sealNumber,
                status: this.getStartingStatusForSection(section),
                inspection_date: new Date().toISOString().split('T')[0]
            }]).select();

            if (error || !data || data.length === 0) throw error || new Error('Insert failed');

            this.newlyCreatedSeals.push(data[0]);

            // Re-render the asset panel so the new asset appears, then
            // check it automatically and refresh the seal panel.
            const assetPanel = this.$(`${section}-asset-panel`);
            if (assetPanel && ![...assetPanel.querySelectorAll(`input[name="${section}-asset"]`)].some(el => el.value === assetName)) {
                assetPanel.insertAdjacentHTML('beforeend', `
                    <label class="seal-check">
                        <input type="checkbox" name="${section}-asset" value="${assetName}" checked onchange="this.getRootNode().host.updateSealDropdown('${section}')">
                        ${assetName}
                    </label>
                `);
            } else {
                const existingCheckbox = [...assetPanel.querySelectorAll(`input[name="${section}-asset"]`)].find(el => el.value === assetName);
                if (existingCheckbox) existingCheckbox.checked = true;
            }
            this.updateSealDropdown(section);

            // Check the newly-added seal once the panel re-renders.
            setTimeout(() => {
                const newCheckbox = this.shadowRoot.querySelector(`input[name="${section}-seal"][value="${data[0].id}"]`);
                if (newCheckbox) { newCheckbox.checked = true; this.updateSealToggleLabel(section); }
            }, 0);
        } catch (e) {
            alert('Could not add this seal: ' + e.message);
        }
    }

    // ===== Reusable Trade Partners company dropdown =====
    async fetchTradePartnersForProject() {
        const companies = [];
        let page = 0;
        const pageSize = 1000;
        let hasMore = true;

        while (hasMore) {
            const { data, error } = await this._supabase
                .from(this.T('dropdownoptions'))
                .select('Trade_Partners')
                .range(page * pageSize, (page + 1) * pageSize - 1);

            if (error || !data || data.length === 0) { hasMore = false; break; }

            data.forEach(row => {
                const trade = row.Trade_Partners?.toString().trim();
                if (trade && !companies.includes(trade)) companies.push(trade);
            });

            if (data.length < pageSize) hasMore = false;
            page++;
        }

        return companies.sort();
    }

    async loadCompanyOptions(selectId) {
        const select = this.$(selectId);
        try {
            const companies = await this.fetchTradePartnersForProject();
            select.innerHTML = '<option value="">Select Company...</option>' +
                companies.map(c => `<option value="${c}">${c}</option>`).join('') +
                '<option value="__add_new__">+ Add New Company</option>';
        } catch (e) {
            select.innerHTML = '<option value="">Select Company...</option><option value="__add_new__">+ Add New Company</option>';
        }
    }

    handleCompanySelectChange(selectId, newInputId) {
        const select = this.$(selectId);
        const newInput = this.$(newInputId);
        if (select.value === '__add_new__') {
            newInput.style.display = 'block';
            newInput.focus();
        } else {
            newInput.style.display = 'none';
        }
    }

    getCompanyValue(selectId, newInputId) {
        const select = this.$(selectId);
        return select.value === '__add_new__' ? this.$(newInputId).value.trim() : select.value;
    }

    getCheckedSealIds(section) {
        return Array.from(this.$$(`input[name="${section}-seal"]:checked`)).map(el => Number(el.value));
    }

    // ===== Section 8.1: Break Request =====
    renderBreakRequestForm(content) {
        content.innerHTML = `
            <a class="back-link" onclick="this.getRootNode().host.backToActionSelect()">&larr; Back</a>
            <div class="form-explainer"><strong>Use this when:</strong> you need to break a seal for scheduled testing, an issue repair, a settings change, or any other authorized work — but haven't been approved yet. Submitting this notifies the CCM to review your request.</div>
            <div class="card">
                <p>Select the asset(s) and seal(s) you're requesting to break, and why.</p>
                ${this.renderAssetSealPickerHtml('break-request')}
                <label>Reason for Request</label>
                <textarea id="reason" placeholder="e.g. Scheduled testing, issue repair, settings change..."></textarea>
                <label>Your Name</label>
                <input type="text" id="reqName">
                <label>Your Company</label>
                <select id="reqCompany" onchange="this.getRootNode().host.handleCompanySelectChange('reqCompany', 'reqCompanyNew')"><option value="">Loading companies...</option></select>
                <input type="text" id="reqCompanyNew" placeholder="Enter your company name" style="display:none; margin-top:8px;">
                <label>Your Email</label>
                <input type="email" id="reqEmail">
                <button class="submit-btn" onclick="this.getRootNode().host.submitBreakRequest()">Submit Break Request</button>
                <div id="form-error"></div>
            </div>
        `;
        this.loadCompanyOptions('reqCompany');
    }

    // Different selected seals can legitimately have different current
    // statuses (as long as each one has SOME transition into this
    // section), so their next status has to be computed per-seal, not
    // assumed to be the same for the whole batch. Groups by resulting
    // status to keep this to one update call per distinct outcome.
    async applyStatusTransitions(checkedSealIds, section, extraFields) {
        const allKnown = this.allSeals.concat(this.newlyCreatedSeals);
        const groups = {};
        const skipped = [];
        const blocked = [];
        const moved = [];

        checkedSealIds.forEach(id => {
            const seal = allKnown.find(s => s.id === id);
            if (!seal) return;
            const nextStatus = this.getNextStatus(seal, section);
            if (!nextStatus) { skipped.push(seal.seal_number); return; }
            if (!groups[nextStatus]) groups[nextStatus] = [];
            groups[nextStatus].push({ id, sealNumber: seal.seal_number, fromStatus: this.effectiveStatusName(seal) });
        });

        let updatedCount = 0;
        for (const [status, entries] of Object.entries(groups)) {
            const ids = entries.map(e => e.id);
            // Chaining .select() is what makes this verifiable — a
            // plain .update() call doesn't error when RLS silently
            // filters it down to zero affected rows, it just "succeeds"
            // having changed nothing. Checking the returned rows is the
            // only way to tell the difference between an actual write
            // and a write RLS quietly blocked.
            const { data: updatedRows, error } = await this._supabase.from(this.T('Assets'))
                .update({ status, ...extraFields })
                .in('id', ids)
                .select();

            if (error) {
                console.error('Status update failed for seal(s):', entries.map(e => e.sealNumber).join(', '), error);
                blocked.push(...entries.map(e => `${e.sealNumber} (${error.message || error.code || 'unknown database error'})`));
            } else if (!updatedRows || updatedRows.length === 0) {
                console.error('Status update affected zero rows (no error returned — likely an RLS policy issue) for seal(s):', entries.map(e => e.sealNumber).join(', '));
                blocked.push(...entries.map(e => `${e.sealNumber} (write silently blocked, no rows changed)`));
            } else {
                updatedCount += updatedRows.length;
                entries.forEach(e => moved.push(`Seal #${e.sealNumber}: "${e.fromStatus}" → "${status}"`));
            }
        }

        if (skipped.length > 0) {
            console.warn('No matching transition found for seal(s), status left unchanged:', skipped.join(', '));
        }
        if (moved.length > 0) {
            console.log('Status transition(s) applied:', moved.join(' | '));
        }
        // No blocking alert here on purpose — the field user submitting
        // this form doesn't need a raw dump of LaunchPad's internal
        // status bookkeeping ("Seal #123: 'Intact' → 'Broken'") before
        // they can move on. The screen shown right after submitting
        // (via buildResultMessage()/showSuccess() in each of the three
        // submit*() methods below) already tells them plainly whether
        // it went through, using these same skipped/blocked results.

        return { anyUpdated: updatedCount > 0, updatedCount, skipped, blocked };
    }

    async submitBreakRequest() {
        const checkedSealIds = this.getCheckedSealIds('break-request');
        const reason = this.$('reason').value.trim();
        const name = this.$('reqName').value.trim();
        const company = this.getCompanyValue('reqCompany', 'reqCompanyNew');
        const email = this.$('reqEmail').value.trim();
        const errorEl = this.$('form-error');
        errorEl.innerHTML = '';

        if (checkedSealIds.length === 0 || !reason || !name || !company || !email) {
            errorEl.innerHTML = '<div class="error-box">Please select at least one seal and fill in all fields.</div>';
            return;
        }

        this.setFormBusy(true);
        try {
            const allKnown = this.allSeals.concat(this.newlyCreatedSeals);
            const selectedSeals = checkedSealIds.map(id => allKnown.find(s => s.id === id)).filter(Boolean);
            const sealNumbers = selectedSeals.map(s => s.seal_number).join(', ');
            const assetName = selectedSeals[0] ? selectedSeals[0].asset_name : '';
            const location = selectedSeals[0] ? selectedSeals[0].location : '';

            const transitionResult = await this.applyStatusTransitions(checkedSealIds, 'break-request', {});

            if (!transitionResult.anyUpdated) {
                const { message } = buildResultMessage(transitionResult, '');
                errorEl.innerHTML = `<div class="error-box">${message}</div>`;
                this.setFormBusy(false);
                return;
            }

            try {
                await this._supabase.from(this.T('BreakRequests')).insert([{
                    asset_name: assetName, location: location,
                    requested_seal_numbers: sealNumbers,
                    reason, requestor_name: name, requestor_company: company, requestor_email: email,
                    ccm_decision: 'Pending'
                }]);
            } catch (e) { console.warn('BreakRequests audit insert failed (request itself was still saved):', e); }

            // One row per seal, with every field this form collects.
            // Best-effort — this table may not exist for every project.
            try {
                await this._supabase.from(this.T('RequestedSeals')).insert(
                    selectedSeals.map(s => ({
                        seal_number: s.seal_number,
                        asset_name: s.asset_name,
                        location: s.location,
                        reason,
                        requestor_name: name,
                        requestor_company: company,
                        requestor_email: email,
                        request_date: new Date().toISOString().split('T')[0]
                    }))
                );
            } catch (e) { console.warn('RequestedSeals log insert failed (request itself was still saved):', e); }

            if (this.scriptUrl) {
                try {
                    await fetch(`${this.scriptUrl}?action=notifyCCM&project=${encodeURIComponent(this.PROJECT_KEY)}&asset=${encodeURIComponent(assetName)}&seals=${encodeURIComponent(sealNumbers)}&requestor=${encodeURIComponent(name)}&requestorEmail=${encodeURIComponent(email)}`);
                } catch (e) { console.warn('CCM notification failed:', e); }
            }

            const result = buildResultMessage(transitionResult, 'The Chain of Custody Manager has been notified and will review your request. You\'ll be notified by email once a decision has been made.');
            this.showSuccess((transitionResult.skipped.length + transitionResult.blocked.length) === 0 ? 'Break Request Submitted' : result.title, result.message);
        } catch (e) {
            errorEl.innerHTML = `<div class="error-box">Something went wrong: ${e.message}</div>`;
            this.setFormBusy(false);
        }
    }

    // ===== Section 8.2: Break Seals =====
    renderBreakSealsForm(content) {
        content.innerHTML = `
            <a class="back-link" onclick="this.getRootNode().host.backToActionSelect()">&larr; Back</a>
            <div class="form-explainer"><strong>Use this when:</strong> the CCM has already approved your Break Request and you're now physically removing the seal. This logs who broke it, when, and why.</div>
            <div class="card">
                <p><strong>Only break seals the CCM has approved.</strong> Breaking a seal without an approval on file is treated as an unauthorized breach and triggers mandatory LOTO and re-inspection.</p>
                ${this.renderAssetSealPickerHtml('break-seals')}
                <label>Email of Person Removing the Seal</label>
                <input type="email" id="removerEmail">
                <label>Company</label>
                <select id="removerCompany" onchange="this.getRootNode().host.handleCompanySelectChange('removerCompany', 'removerCompanyNew')"><option value="">Loading companies...</option></select>
                <input type="text" id="removerCompanyNew" placeholder="Enter your company name" style="display:none; margin-top:8px;">
                <label>Detailed Break Reason</label>
                <textarea id="breakReason"></textarea>
                <button class="submit-btn" onclick="this.getRootNode().host.submitBreakSeals()">Log Seal Break</button>
                <div id="form-error"></div>
            </div>
        `;
        this.loadCompanyOptions('removerCompany');
    }

    async submitBreakSeals() {
        const checkedSealIds = this.getCheckedSealIds('break-seals');
        const removerEmail = this.$('removerEmail').value.trim();
        const removerCompany = this.getCompanyValue('removerCompany', 'removerCompanyNew');
        const breakReason = this.$('breakReason').value.trim();
        const errorEl = this.$('form-error');
        errorEl.innerHTML = '';

        if (checkedSealIds.length === 0 || !removerEmail || !removerCompany || !breakReason) {
            errorEl.innerHTML = '<div class="error-box">Please select at least one seal and fill in all fields.</div>';
            return;
        }

        this.setFormBusy(true);
        try {
            const allKnown = this.allSeals.concat(this.newlyCreatedSeals);
            const selectedSeals = checkedSealIds.map(id => allKnown.find(s => s.id === id)).filter(Boolean);
            const breakDate = new Date().toISOString().split('T')[0];

            const transitionResult = await this.applyStatusTransitions(checkedSealIds, 'break-seals', {
                break_date: breakDate,
                responsible_party: `${removerEmail} (${removerCompany})`,
                break_reason: breakReason
            });

            if (!transitionResult.anyUpdated) {
                const { message } = buildResultMessage(transitionResult, '');
                errorEl.innerHTML = `<div class="error-box">${message}</div>`;
                this.setFormBusy(false);
                return;
            }

            try {
                await this._supabase.from(this.T('BrokenSeals')).insert(
                    selectedSeals.map(s => ({
                        seal_number: s.seal_number,
                        asset_name: s.asset_name,
                        location: s.location,
                        break_date: breakDate,
                        remover_email: removerEmail,
                        remover_company: removerCompany,
                        break_reason: breakReason
                    }))
                );
            } catch (e) { console.warn('BrokenSeals log insert failed (break itself was still saved):', e); }

            const result = buildResultMessage(transitionResult, 'The log has been updated. Use the Work Completed form once your work behind the seal is finished.');
            this.showSuccess((transitionResult.skipped.length + transitionResult.blocked.length) === 0 ? 'Seal Break Logged' : result.title, result.message);
        } catch (e) {
            errorEl.innerHTML = `<div class="error-box">Something went wrong: ${e.message}</div>`;
            this.setFormBusy(false);
        }
    }

    // ===== Section 8.3: Work Completed – Ready for Reseal =====
    renderWorkCompletedForm(content) {
        content.innerHTML = `
            <a class="back-link" onclick="this.getRootNode().host.backToActionSelect()">&larr; Back</a>
            <div class="form-explainer"><strong>Use this when:</strong> your work behind a broken seal is finished and the asset is ready to be re-sealed. This alerts the CxA/CCM to coordinate re-sealing with the GC.</div>
            <div class="card">
                <p>Let the CxA/CCM know these seals are ready to be replaced.</p>
                ${this.renderAssetSealPickerHtml('work-completed')}
                <button class="submit-btn" onclick="this.getRootNode().host.submitWorkCompleted()">Notify Ready for Reseal</button>
                <div id="form-error"></div>
            </div>
        `;
    }

    async submitWorkCompleted() {
        const checkedSealIds = this.getCheckedSealIds('work-completed');
        const errorEl = this.$('form-error');
        errorEl.innerHTML = '';

        if (checkedSealIds.length === 0) {
            errorEl.innerHTML = '<div class="error-box">Please select at least one seal.</div>';
            return;
        }

        this.setFormBusy(true);
        try {
            const allKnown = this.allSeals.concat(this.newlyCreatedSeals);
            const selectedSeals = checkedSealIds.map(id => allKnown.find(s => s.id === id)).filter(Boolean);
            const assetName = selectedSeals[0] ? selectedSeals[0].asset_name : '';

            const transitionResult = await this.applyStatusTransitions(checkedSealIds, 'work-completed', {});

            if (!transitionResult.anyUpdated) {
                const { message } = buildResultMessage(transitionResult, '');
                errorEl.innerHTML = `<div class="error-box">${message}</div>`;
                this.setFormBusy(false);
                return;
            }

            if (this.scriptUrl) {
                try {
                    await fetch(`${this.scriptUrl}?action=notifyCCM&project=${encodeURIComponent(this.PROJECT_KEY)}&asset=${encodeURIComponent(assetName)}&event=ready_for_reseal`);
                } catch (e) { console.warn('Notification failed:', e); }
            }

            const result = buildResultMessage(transitionResult, 'The CxA will coordinate re-sealing with the GC.');
            this.showSuccess((transitionResult.skipped.length + transitionResult.blocked.length) === 0 ? 'Marked Ready for Reseal' : result.title, result.message);
        } catch (e) {
            errorEl.innerHTML = `<div class="error-box">Something went wrong: ${e.message}</div>`;
            this.setFormBusy(false);
        }
    }

    showSuccess(title, message) {
        this.$('app-content').innerHTML = `
            <div class="card success">
                <div class="icon">✅</div>
                <h2 style="margin:10px 0 6px;">${title}</h2>
                <p>${message}</p>
            </div>
            <a class="back-link" onclick="this.getRootNode().host.renderActionSelect()">&larr; Start another request</a>
        `;
    }
}

customElements.define('seal-form-view', SealFormView);
