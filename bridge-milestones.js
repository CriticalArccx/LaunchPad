// Bridge → Milestones (ARC-348, ARC-349, ARC-350).
//
// A second view inside Bridge, next to the Gantt ("Schedule"). Off on every
// project until an admin turns on Milestones in Settings → The Bridge;
// index.html then mounts <bridge-view milestones="on">.
//
// - A milestone (key date) has a name and a due date, e.g. "FR1" on 4/22.
//   They live in launchpad_milestones (sync/milestones.sql), which is
//   insert-only: editing or removing a milestone adds a new version.
// - Its due date is either picked, or based on another milestone ("2 weeks
//   before FR1"). A based milestone moves when the one it's based on moves.
// - Pick one milestone as the end of the axis. The timeline counts back from
//   it in weeks (FR1-0, FR1-1, ...), with 1–4 weeks per column.
// - The lines a milestone needs are either automatic (every Bridge line due
//   on or before it) or chosen: whole zones and/or single lines, matched by
//   asset + activity so they survive a line moving days. Either way, the
//   chosen lines' predecessors are included. A line's zone is its asset's
//   Zone in the dropdown options, else the line's Area.
// - Line status: Done when the line's Schedule result reads Pass or
//   Complete; Late when it isn't done and its last day has passed; At risk
//   when a predecessor is late or at risk; otherwise Planned.
//
// Everything renders into #milestonesView inside Bridge's shadow root. The
// host (<bridge-view>) owns the data; this class only reads it, except for
// adding milestone versions.

const DAY = 86400000;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_COLS = 26; // older weeks fold into one "Earlier" column
const ST_TEXT = { done: 'Done', late: 'Late', risk: 'At risk', planned: 'Planned' };

function esc(s) { return (s ?? '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function dayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function parseIsoDay(s) { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
function isoDay(ms) { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function daysBetween(a, b) { return Math.round((a - b) / DAY); } // DST-safe for local midnights
function short(ms) { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; }
function dayShort(ms) { return `${WD[new Date(ms).getDay()]} ${short(ms)}`; }
function longD(ms) { const d = new Date(ms); return `${WD[d.getDay()]}, ${MO[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; }
// { zones: [...], lines: ['asset|||activity', ...] }, or null for automatic.
function normScope(s) {
    if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { s = null; } }
    if (!s || typeof s !== 'object') return null;
    const arr = v => (Array.isArray(v) ? v : []).map(String);
    const out = { zones: arr(s.zones), lines: arr(s.lines) };
    return out.zones.length || out.lines.length ? out : null;
}
// A based milestone's date is its base's date plus its offset, all the way
// up the chain. Falls back to its own saved date if the base is gone or the
// chain loops.
function resolveDates(list) {
    const by = new Map(list.map(m => [m.key, m]));
    const dateOf = (m, seen) => {
        const base = m.basedOn && by.get(m.basedOn);
        if (!base || seen.has(m.key)) return m.due;
        seen.add(m.key);
        return dayStart(dateOf(base, seen) + m.offsetDays * DAY + DAY / 2);
    };
    list.forEach(m => { m.t = dateOf(m, new Set()); m.base = (m.basedOn && by.get(m.basedOn)) || null; });
    return list;
}
function offsetText(days) {
    if (!days) return 'same day as';
    const w = Math.abs(days) / 7;
    const amount = Number.isInteger(w) ? `${w} wk` : `${Math.abs(days)} d`;
    return `${amount} ${days < 0 ? 'before' : 'after'}`;
}
const lineKeyOf = (asset, act) => `${asset}|||${act}`;

function newKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'ms-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export const MILESTONES_STYLE = `
<style>
/* ===== VIEW SWITCH (Schedule | Milestones) ===== */
.view-switch{display:none; gap:4px; padding:3px; background:var(--grey-bg); border-radius:999px; margin-right:6px;}
:host(.ms-enabled) .view-switch{display:flex;}
.view-switch button{border:0; background:transparent; padding:6px 14px; border-radius:999px; font-size:13px; font-weight:500; color:var(--text-muted); cursor:pointer; min-height:32px;}
.view-switch button[aria-pressed="true"]{background:#fff; color:var(--green); font-weight:700; box-shadow:0 1px 2px rgba(0,0,0,0.12);}
:host(.dark-mode) .view-switch button[aria-pressed="true"]{background:#383838; color:#81c784;}

/* Gantt-only controls step aside while Milestones shows. */
:host(.ms-mode) #dayWidthSelect,
:host(.ms-mode) #criticalPathLabel,
:host(.ms-mode) #multiSelectIndicator,
:host(.ms-mode) #editModeToggleBtn,
:host(.ms-mode) #add-menu-wrap,
:host(.ms-mode) #optimizeBtn,
:host(.ms-mode) #report-menu-wrap,
:host(.ms-mode) #typeLegend,
:host(.ms-mode) #ganttWrap,
:host(.ms-mode) .timeline-range-bar{display:none !important;}
:host(.ms-mode){padding-bottom:0;}

/* ===== MILESTONES VIEW ===== */
#milestonesView{display:none; flex:1; min-height:0; overflow:auto; background:#fff;}
:host(.ms-mode) #milestonesView{display:block;}
.ms{--ms-ink:var(--text-dark); --ms-muted:var(--text-muted); --ms-line:#e3e6e8; --ms-soft:#fafbfa; --ms-card:#fff;
    --kd-bg:#cdeef3; --kd-line:#3e9aab; --kd-ink:#12454f;
    --st-done:#1e6b2a; --st-late:#a1231b; --st-risk:#8a4b00; --st-planned:#4a5056;
    color:var(--ms-ink); font-size:14px;}
:host(.dark-mode) .ms{--ms-line:#333; --ms-soft:#1a1a1a; --ms-card:#1e1e1e; --kd-bg:#173f46; --kd-line:#4fb3c4; --kd-ink:#bfeaf1;
    --st-done:#81c784; --st-late:#ef9a9a; --st-risk:#ffb74d; --st-planned:#b0b0b0;}
:host(.dark-mode) #milestonesView{background:#121212;}
.ms-controls{display:flex; flex-wrap:wrap; align-items:flex-end; gap:20px; padding:12px 24px; border-bottom:1px solid var(--ms-line); background:var(--ms-soft);}
.ms-lbl{display:flex; flex-direction:column; gap:6px; font-size:11.5px; font-weight:700; letter-spacing:.05em; color:var(--green); text-transform:uppercase;}
:host(.dark-mode) .ms-lbl, :host(.dark-mode) .ms-h2{color:#81c784;}
.ms-lbl select{min-height:40px; min-width:260px; padding:0 10px; border:1px solid var(--grey-border); border-radius:8px; background:#fff; font-size:14px; font-weight:500; color:var(--ms-ink); letter-spacing:0; text-transform:none;}
.ms-seg{display:flex; gap:4px; padding:3px; background:var(--grey-bg); border-radius:10px;}
.ms-seg button{border:0; min-height:34px; padding:0 12px; border-radius:7px; font-size:13px; cursor:pointer; background:transparent; color:var(--ms-muted); font-weight:500;}
.ms-seg button[aria-pressed="true"]{background:#fff; color:var(--green); font-weight:700; box-shadow:0 1px 2px rgba(0,0,0,0.12);}
:host(.dark-mode) .ms-seg button[aria-pressed="true"]{background:#383838; color:#81c784;}
.ms-legend{display:flex; flex-wrap:wrap; gap:6px; list-style:none; margin:0; padding:0; align-items:center;}
.ms-legend button{display:flex; align-items:center; gap:6px; min-height:32px; padding:0 10px; border-radius:999px; cursor:pointer; font-size:13px; font-weight:500; color:var(--ms-ink); background:var(--ms-card); border:1px solid var(--grey-border);}
.ms-legend button[aria-pressed="false"]{color:var(--ms-muted); background:var(--grey-bg); text-decoration:line-through;}
.ms-sw{display:inline-block; width:13px; height:13px; border-radius:3px; flex:none; border:1px solid rgba(0,0,0,0.25);}
.ms-sw.kd{background:var(--kd-bg); border-color:var(--kd-line);}
.ms-datadate{font-size:13px; font-weight:700; color:var(--green); margin-left:auto; align-self:center;}
:host(.dark-mode) .ms-datadate{color:#81c784;}

.ms-body{display:flex; flex-wrap:wrap; align-items:stretch;}
.ms-side{flex:1 1 280px; max-width:360px; min-width:0; padding:18px; border-right:1px solid var(--ms-line); display:flex; flex-direction:column; gap:22px;}
.ms-main{flex:999 1 620px; min-width:0; padding:18px 24px 40px; display:flex; flex-direction:column; gap:20px;}
.ms-h2{margin:0; font-size:12.5px; font-weight:700; letter-spacing:.06em; color:var(--green); text-transform:uppercase;}
.ms-note{margin:4px 0 0; font-size:12.5px; color:var(--ms-muted); line-height:1.4;}
.ms-kdlist{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px;}
.ms-kd{display:flex; flex-direction:column; gap:6px; width:100%; text-align:left; padding:11px; border-radius:10px; cursor:pointer; font:inherit; color:var(--ms-ink); background:var(--ms-card); border:1px solid var(--grey-border);}
.ms-kd[aria-pressed="true"]{border:2px solid var(--green); background:var(--green-light);}
:host(.dark-mode) .ms-kd[aria-pressed="true"]{background:#1b3d1e;}
.ms-kd-top{display:flex; align-items:center; justify-content:space-between; gap:8px;}
.ms-code{font-size:12px; font-weight:700; padding:2px 7px; border-radius:4px; background:var(--kd-bg); border:1px solid var(--kd-line); color:var(--kd-ink); white-space:nowrap;}
.ms-small{font-size:12px; color:var(--ms-muted);}
.ms-rel{font-size:12px; font-weight:700; color:var(--green);}
:host(.dark-mode) .ms-rel{color:#81c784;}
.ms-bar{display:block; height:6px; border-radius:3px; background:var(--grey-bg); overflow:hidden;}
.ms-bar > span{display:block; height:100%; background:#2f7d32;}
.ms-kd-actions{display:flex; gap:12px;}
.ms-link{border:0; background:transparent; padding:4px 0; font-size:12.5px; font-weight:600; color:var(--green); cursor:pointer; text-decoration:underline; text-underline-offset:2px;}
:host(.dark-mode) .ms-link{color:#81c784;}
.ms-link.danger{color:var(--st-late);}

.ms-sel{display:flex; flex-direction:column; gap:10px; padding:14px; border:1px solid var(--grey-border); border-radius:10px;}
.ms-sel dl{display:grid; grid-template-columns:80px minmax(0,1fr); gap:6px 10px; margin:0; font-size:13px;}
.ms-sel dt{color:var(--ms-muted);} .ms-sel dd{margin:0;}
.ms-rel-btn{display:flex; justify-content:space-between; gap:8px; width:100%; text-align:left; min-height:34px; padding:6px 8px; border:1px solid var(--ms-line); border-radius:6px; background:var(--ms-card); font:inherit; font-size:13px; color:var(--ms-ink); cursor:pointer; margin-top:4px;}
.ms-x{border:0; background:transparent; width:36px; height:36px; margin:-8px -8px 0 0; cursor:pointer; color:var(--ms-muted); font-size:18px;}

.st{display:inline-flex; align-items:center; gap:3px; font-weight:500; white-space:nowrap;}
.st-done{color:var(--st-done);} .st-planned{color:var(--st-planned);}
.st-late{color:var(--st-late); font-weight:700;} .st-risk{color:var(--st-risk); font-weight:700;}

.ms-ready{display:flex; flex-wrap:wrap; gap:24px; align-items:center; padding:16px 20px; border:1px solid var(--ms-line); border-radius:12px; background:var(--ms-card);}
.ms-ready h1{margin:0; font-size:26px; font-weight:700;}
.ms-ready p{margin:0; font-size:14px;}
.ms-stats{display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px;}
.ms-stat{display:flex; flex-direction:column; gap:2px;}
.ms-stat b{font-size:24px;}
.ms-stack{display:flex; height:12px; border-radius:6px; overflow:hidden; background:var(--grey-bg); gap:2px;}
.ms-empty{padding:28px; border:1px dashed var(--grey-border); border-radius:12px; text-align:center; color:var(--ms-muted); line-height:1.5;}

.ms-tl{border:1px solid var(--ms-line); border-radius:10px; overflow-x:auto; background:var(--ms-card);}
.ms-grid{display:grid; border-bottom:1px solid var(--ms-line);}
.ms-grid.head{border-bottom-width:2px;}
.ms-lane{position:sticky; left:0; z-index:1; background:var(--ms-card); padding:10px 12px; border-right:1px solid var(--ms-line); display:flex; flex-direction:column; gap:3px;}
.ms-lane b{display:flex; align-items:center; gap:8px; font-size:14px;}
.ms-colh{padding:9px; border-left:1px solid var(--ms-line); display:flex; flex-direction:column; gap:3px; min-height:64px;}
.ms-colh .l{font-size:14px; font-weight:700;} .ms-colh .r{font-size:11.5px; color:var(--ms-muted);}
.ms-colh.end{background:var(--green); } .ms-colh.end .l{color:#fff;} .ms-colh.end .r{color:#e3f1df;}
.ms-colh.today{background:var(--green-light);} .ms-colh.mark{background:#fdeceA;}
:host(.dark-mode) .ms-colh.today{background:#1b3d1e;} :host(.dark-mode) .ms-colh.mark{background:#3a2422;}
.ms-colh.extra{background:var(--grey-bg); border-left:2px solid var(--grey-border);}
.ms-tag{font-size:10.5px; font-weight:700; padding:1px 6px; border-radius:4px; align-self:flex-start;}
.ms-tag.today{background:#2f7d32; color:#fff;}
.ms-cell{padding:7px; border-left:1px solid var(--ms-line); display:flex; flex-direction:column; gap:6px; min-height:64px;}
.ms-cell.end{background:#f3f8f2;} .ms-cell.today{background:#f6fbf2;} .ms-cell.extra{background:var(--ms-soft); border-left:2px solid var(--grey-border);}
:host(.dark-mode) .ms-cell.end, :host(.dark-mode) .ms-cell.today{background:#16251a;}
.ms-card{display:flex; flex-direction:column; gap:3px; text-align:left; width:100%; padding:6px 7px; border-radius:6px; cursor:pointer; font:inherit; color:var(--ms-ink); border:1px solid; background:var(--ms-card);}
.ms-card .top{display:flex; justify-content:space-between; gap:6px; font-size:11px;}
.ms-card .a{font-size:12.5px; font-weight:700; line-height:1.25; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;}
.ms-card .act{font-size:11px; line-height:1.3; color:var(--ms-muted);}
.ms-card.kd{background:var(--kd-bg); border-color:var(--kd-line);}
.ms-card.dim{opacity:.3;} .ms-card.out{opacity:.6; border-style:dashed;}
.ms-card.sel{box-shadow:0 0 0 3px var(--ms-ink);}
.ms-card.anchor{box-shadow:0 0 0 3px var(--green);}
.ms-card.warn{border-width:2px;}

.ms-table{width:100%; min-width:760px; border-collapse:collapse; font-size:13.5px;}
.ms-table th{padding:9px 12px; font-size:11.5px; letter-spacing:.05em; color:var(--green); text-align:left; background:var(--ms-soft); text-transform:uppercase;}
:host(.dark-mode) .ms-table th{color:#81c784;}
.ms-table td{padding:7px 12px; border-top:1px solid var(--ms-line); vertical-align:top;}
.ms-table tr.late td{background:#fdf3f2;} .ms-table tr.sel td{background:var(--green-light);}
:host(.dark-mode) .ms-table tr.late td{background:#2a1a19;} :host(.dark-mode) .ms-table tr.sel td{background:#1b3d1e;}
.ms-table button{border:0; background:transparent; padding:2px 0; text-align:left; font:inherit; color:var(--ms-ink); cursor:pointer; text-decoration:underline; text-decoration-color:var(--grey-border); text-underline-offset:3px;}
.ms-kd-meta{font-size:12px; color:var(--ms-muted); line-height:1.35;}
.ms-add{width:100%; justify-content:center; min-height:40px;}

/* Add / edit milestone dialog (uses Bridge's .modal-overlay/.modal-box) */
#msModal .modal-box{width:720px;}
.ms-fieldset{border:0; margin:0 0 18px; padding:0; min-width:0;}
.ms-fieldset legend{font-weight:700; font-size:12.5px; color:var(--text-muted); margin-bottom:4px; padding:0;}
.ms-radio{display:flex; align-items:center; gap:8px; font-size:13.5px; margin:8px 0 4px; cursor:pointer;}
.ms-radio input, .ms-pick input[type="checkbox"]{width:auto; margin:0; accent-color:var(--green);}
.ms-sub{margin:4px 0 4px 24px; display:flex; flex-wrap:wrap; align-items:center; gap:8px; font-size:13.5px;}
.ms-sub input, .ms-sub select, .ms-searchrow input{padding:7px 9px; border:1px solid var(--grey-border); border-radius:5px; font-size:13.5px; background:#fff; color:var(--text-dark);}
.ms-sub[hidden], .ms-picksec[hidden]{display:none;}
.ms-picksec{margin:6px 0 0 24px;}
.ms-searchrow{display:flex; gap:8px; align-items:center; margin:4px 0 8px;}
.ms-searchrow input{flex:1; min-width:0;}
.ms-pick{border:1px solid var(--grey-border); border-radius:8px; max-height:320px; overflow:auto;}
.ms-zone + .ms-zone{border-top:1px solid var(--grey-border);}
.ms-zone summary{display:flex; align-items:center; gap:10px; padding:9px 12px; cursor:pointer; background:var(--grey-bg); font-weight:600; font-size:13px;}
.ms-zone summary .cnt{margin-left:auto; font-weight:500; color:var(--text-muted); font-size:12px;}
.ms-line{display:flex; align-items:center; gap:8px; padding:6px 12px 6px 28px; font-size:13px; cursor:pointer;}
.ms-line.all{padding-left:12px; border-bottom:1px dashed var(--grey-border);}
.ms-line .d{margin-left:auto; color:var(--text-muted); font-size:12px; white-space:nowrap;}
.ms-line[hidden], .ms-zone[hidden]{display:none;}
.ms-ferr{color:var(--red); font-size:13px; font-weight:600; margin:4px 0 0; min-height:1em;}
:host(.dark-mode) .ms-sub input, :host(.dark-mode) .ms-sub select, :host(.dark-mode) .ms-searchrow input{background:#2c2c2c; color:#e0e0e0; border-color:#444;}
:host(.dark-mode) .ms-zone summary{background:#2a2a2a;}
@media (max-width:700px){.ms-side{max-width:none; border-right:0; border-bottom:1px solid var(--ms-line);} .ms-main{padding:16px;} .ms-controls{padding:12px 16px;} .ms-picksec, .ms-sub{margin-left:0;}}
</style>
`;

export class BridgeMilestones {
    constructor(host, root) {
        this.host = host;   // <bridge-view>
        this.root = root;   // #milestonesView
        this.state = { anchorKey: null, bucket: 1, scope: 'req', sel: null, hidden: new Set() };
        this.milestones = [];
        this.results = {};
        this.loaded = false;
        this.loadError = '';
        this.form = null; // the open add/edit dialog's state
        root.addEventListener('click', e => this._onClick(e));
        root.addEventListener('change', e => this._onChange(e));
        // The add/edit dialog sits over the whole Bridge, like its other modals.
        this.modal = document.createElement('div');
        this.modal.className = 'modal-overlay';
        this.modal.id = 'msModal';
        host.shadowRoot.appendChild(this.modal);
        this.modal.addEventListener('click', e => this._onFormClick(e));
        this.modal.addEventListener('change', e => this._onFormChange(e));
        this.modal.addEventListener('input', e => this._onFormInput(e));
        this.modal.addEventListener('keydown', e => { if (e.key === 'Escape') this._closeForm(); });
    }

    get canEdit() { return !this.host.isViewerRole && !!this.host._supabase; }

    // Milestones plus each line's Schedule result. Called when the view
    // opens; cheap enough to repeat.
    async load() {
        await Promise.all([this._loadMilestones(), this._loadResults()]);
        this.loaded = true;
        this.render();
    }

    async _loadMilestones() {
        const sb = this.host._supabase;
        this.loadError = '';
        if (!sb) { this.milestones = []; return; }
        // '*' so a database that hasn't had the newer columns added still loads.
        const { data, error } = await sb.from('launchpad_milestones')
            .select('*')
            .eq('project_key', this.host.PROJECT_KEY)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true });
        if (error) {
            console.error('Loading milestones failed — has sync/milestones.sql been run?', error);
            this.loadError = 'Milestones could not be loaded. If this is the first time, sync/milestones.sql needs to be run in Supabase.';
            this.milestones = [];
            return;
        }
        // Newest version of each milestone wins; archived ones drop out.
        const latest = new Map();
        (data || []).forEach(r => latest.set(r.milestone_key, r));
        const list = [...latest.values()].filter(r => !r.archived).map(r => ({
            key: r.milestone_key, name: r.name, due: parseIsoDay(r.due_date),
            basedOn: r.based_on || null, offsetDays: Number(r.offset_days) || 0, scope: normScope(r.scope)
        }));
        this.milestones = resolveDates(list).sort((a, b) => a.t - b.t || a.name.localeCompare(b.name));
    }

    async _loadResults() {
        const sb = this.host._supabase;
        if (!sb) return;
        const ids = [...new Set(this.host.DATA.items.map(it => Number(it.launchpad_id)).filter(Number.isFinite))];
        const results = {};
        for (let i = 0; i < ids.length; i += 300) {
            const { data, error } = await sb.from(this.host.LAUNCHPAD_TABLE).select('id, result').in('id', ids.slice(i, i + 300));
            if (error) { console.error('Loading Schedule results for Milestones failed', error); break; }
            (data || []).forEach(r => { results[String(r.id)] = r.result || ''; });
        }
        this.results = results;
    }

    // ---- model ---------------------------------------------------------

    _zoneOf(it) {
        return ((this.host.ASSET_TO_ZONE_MAP || {})[it.asset_name] || it.area || '').trim();
    }

    _items() {
        const h = this.host;
        return h.DATA.items.filter(it => !it.superseded_by && it.start_ts).map(it => {
            const start = dayStart(new Date(it.start_ts).getTime());
            const span = Math.max(1, Math.ceil((parseFloat(it.duration_hours) || 24) / 24));
            const due = dayStart(start + (span - 1) * DAY + DAY / 2);
            return {
                it, id: it.id, start, t: due, span, asset: it.asset_name || '(no asset)', act: it.activity_name || '(no activity)',
                zone: this._zoneOf(it), lineKey: lineKeyOf(it.asset_name || '', it.activity_name || ''),
                preds: (it.predecessor_ids || []).map(String)
            };
        });
    }

    _model() {
        const today = dayStart(Date.now());
        const items = this._items();
        const byId = new Map(items.map(x => [x.id, x]));
        items.forEach(x => { x.preds = x.preds.filter(p => byId.has(p)); });
        const succ = new Map();
        items.forEach(x => x.preds.forEach(p => { if (!succ.has(p)) succ.set(p, []); succ.get(p).push(x.id); }));

        const status = new Map();
        const visiting = new Set();
        const statusOf = id => {
            if (status.has(id)) return status.get(id);
            if (visiting.has(id)) return 'planned'; // a loop in predecessors: don't recurse forever
            visiting.add(id);
            const x = byId.get(id);
            const res = this.results[String(x.it.launchpad_id)] || '';
            let st;
            if (/pass|complete/i.test(res)) st = 'done';
            else if (x.t < today) st = 'late';
            else if (x.preds.some(p => { const s = statusOf(p); return s === 'late' || s === 'risk'; })) st = 'risk';
            else st = 'planned';
            visiting.delete(id);
            status.set(id, st);
            return st;
        };
        items.forEach(x => statusOf(x.id));

        const closure = ids => {
            const out = new Set(), stack = [...ids];
            while (stack.length) {
                const id = stack.pop();
                if (out.has(id) || !byId.has(id)) continue;
                out.add(id);
                byId.get(id).preds.forEach(p => stack.push(p));
            }
            return out;
        };
        const reqOf = m => {
            if (!m.scope) return closure(items.filter(x => x.t <= m.t).map(x => x.id));
            const zones = new Set(m.scope.zones), lines = new Set(m.scope.lines);
            return closure(items.filter(x => zones.has(x.zone) || lines.has(x.lineKey)).map(x => x.id));
        };
        const statsOf = set => {
            const c = { total: 0, done: 0, late: 0, risk: 0, planned: 0 };
            set.forEach(id => { c.total++; c[status.get(id)]++; });
            c.pct = c.total ? Math.round(100 * c.done / c.total) : 0;
            return c;
        };
        return { today, items, byId, succ, status, closure, reqOf, statsOf };
    }

    // ---- rendering -----------------------------------------------------

    render() {
        if (!this.root.isConnected) return;
        if (!this.loaded) { this.root.innerHTML = '<div class="ms"><div class="ms-main"><div class="ms-empty">Loading milestones…</div></div></div>'; return; }
        const s = this.state;
        const M = this._model();
        const kds = this.milestones;
        const A = kds.find(k => k.key === s.anchorKey) || kds[kds.length - 1] || null;
        if (A) s.anchorKey = A.key;
        const REQ = new Map(kds.map(k => [k.key, M.reqOf(k)]));
        const lanesAll = [...new Set(M.items.map(x => x.act))].sort((a, b) => a.localeCompare(b));
        const h = this.host;
        const passes = x => h.itemMatchesFilters(x.it, null) && h.passesGlobalSearch(x.it) && !s.hidden.has(x.act);

        const controls = `
<div class="ms-controls">
  <label class="ms-lbl">End milestone (axis = 0)
    <select data-ms="anchor" ${kds.length ? '' : 'disabled'}>
      ${kds.length ? kds.map(k => `<option value="${esc(k.key)}" ${A && k.key === A.key ? 'selected' : ''}>${esc(k.name)} (${short(k.t)}/${String(new Date(k.t).getFullYear()).slice(2)})</option>`).join('') : '<option>No milestones yet</option>'}
    </select>
  </label>
  <div class="ms-lbl">Weeks per column
    <div class="ms-seg" role="group" aria-label="Weeks per column">
      ${[1, 2, 3, 4].map(b => `<button type="button" data-act="bucket" data-v="${b}" aria-pressed="${b === s.bucket}">${b} wk</button>`).join('')}
    </div>
  </div>
  <div class="ms-lbl">Show
    <div class="ms-seg" role="group" aria-label="Lines shown">
      <button type="button" data-act="scope" data-v="req" aria-pressed="${s.scope === 'req'}">${A ? 'Required for ' + esc(A.name) : 'Required'}</button>
      <button type="button" data-act="scope" data-v="all" aria-pressed="${s.scope === 'all'}">All lines</button>
    </div>
  </div>
  <span class="ms-datadate">Data date · ${dayShort(M.today)}</span>
  ${lanesAll.length ? `<ul class="ms-legend" aria-label="Activities, click to show or hide" style="flex-basis:100%;">
    <li style="display:flex;align-items:center;gap:6px;font-size:13px;"><span class="ms-sw kd"></span>Milestone</li>
    ${lanesAll.map(a => `<li><button type="button" data-act="lane" data-v="${esc(a)}" aria-pressed="${!s.hidden.has(a)}"><span class="ms-sw" style="background:${esc(h.activityColor(a))}"></span>${esc(a)}</button></li>`).join('')}
  </ul>` : ''}
</div>`;

        const side = this._sideHtml(M, kds, A, REQ);
        let main;
        if (this.loadError) main = `<div class="ms-empty" role="alert">${esc(this.loadError)}</div>`;
        else if (!A) main = `<div class="ms-empty">No milestones yet.<br>${this.canEdit ? 'Use <b>+ Add milestone</b> on the left, such as <b>FR1</b> with its due date. The timeline then counts back from it week by week.' : 'An editor can add one, such as FR1 with its due date.'}</div>`;
        else main = this._mainHtml(M, kds, A, REQ, passes);

        this.root.innerHTML = `<div class="ms">${controls}<div class="ms-body"><aside class="ms-side">${side}</aside><div class="ms-main">${main}</div></div></div>`;
    }

    // "2 wk before FR1 · Zone A, Zone B + 3 lines" under each milestone.
    _metaText(k) {
        const parts = [];
        if (k.base) parts.push(`${offsetText(k.offsetDays)} ${k.base.name}`);
        if (!k.scope) parts.push('Lines: everything due by its date');
        else {
            const z = k.scope.zones.map(n => n || 'No zone');
            const zs = z.length > 3 ? `${z.slice(0, 3).join(', ')} +${z.length - 3} zones` : z.join(', ');
            const ls = k.scope.lines.length ? `${k.scope.lines.length} line${k.scope.lines.length === 1 ? '' : 's'}` : '';
            parts.push('Lines: ' + [zs, ls].filter(Boolean).join(' + '));
        }
        return parts.join(' · ');
    }

    _relLabel(A, t) {
        const diff = daysBetween(A.t, t);
        return diff >= 0 ? `${A.name}-${Math.floor(diff / 7)}` : `${A.name}+${Math.ceil(-diff / 7)}`;
    }

    _sideHtml(M, kds, A, REQ) {
        const s = this.state;
        const list = kds.map(k => {
            const st = M.statsOf(REQ.get(k.key));
            const isA = A && k.key === A.key;
            const flags = [st.late && `${st.late} late`, st.risk && `${st.risk} at risk`].filter(Boolean);
            return `<li>
  <button type="button" class="ms-kd" data-act="anchor" data-v="${esc(k.key)}" aria-pressed="${!!isA}">
    <span class="ms-kd-top"><span style="display:flex;align-items:center;gap:8px;"><span class="ms-code">${esc(k.name)}</span><span class="ms-small">${dayShort(k.t)}/${String(new Date(k.t).getFullYear()).slice(2)}</span></span>
    <span class="ms-rel">${isA ? 'Axis end' : esc(this._relLabel(A, k.t))}</span></span>
    <span class="ms-bar"><span style="width:${st.pct}%"></span></span>
    <span class="ms-small" style="color:inherit;">${st.done}/${st.total} done${flags.length ? ' · ' + flags.join(' · ') : ''}</span>
    <span class="ms-kd-meta">${esc(this._metaText(k))}</span>
  </button>
  ${this.canEdit ? `<span class="ms-kd-actions"><button type="button" class="ms-link" data-act="edit" data-v="${esc(k.key)}">Edit</button><button type="button" class="ms-link danger" data-act="remove" data-v="${esc(k.key)}">Remove</button></span>` : ''}
</li>`;
        }).join('');

        const form = this.canEdit ? '<button type="button" class="tool-btn primary ms-add" data-act="add">+ Add milestone</button>' : '';

        return `<section style="display:flex;flex-direction:column;gap:10px;">
  <div><h2 class="ms-h2">Milestones</h2><p class="ms-note">Pick the date the timeline counts back from.</p></div>
  ${kds.length ? `<ul class="ms-kdlist">${list}</ul>` : '<p class="ms-note" style="margin:0;">None yet.</p>'}
</section>${form}${this._selHtml(M, kds, A, REQ)}`;
    }

    _selHtml(M, kds, A, REQ) {
        const x = this.state.sel && M.byId.get(this.state.sel);
        if (!x) return '';
        const st = M.status.get(x.id);
        const rel = y => { const ys = M.status.get(y.id); return `<button type="button" class="ms-rel-btn" data-act="sel" data-v="${esc(y.id)}"><span>${esc(y.asset)} — ${esc(y.act)}</span><span class="st st-${ys}">${ST_TEXT[ys]}</span></button>`; };
        const preds = x.preds.map(p => M.byId.get(p));
        const succs = (M.succ.get(x.id) || []).map(id => M.byId.get(id));
        const feeds = kds.filter(k => REQ.get(k.key).has(x.id)).map(k => k.name);
        return `<section class="ms-sel" aria-label="Selected line">
  <div style="display:flex;justify-content:space-between;gap:8px;"><h2 class="ms-h2">Selected line</h2><button type="button" class="ms-x" data-act="sel" data-v="" aria-label="Clear selection">×</button></div>
  <div><div style="font-size:16px;font-weight:700;">${esc(x.asset)}</div><div class="ms-small">${esc(x.it.area || '')}</div></div>
  <dl>
    <dt>Activity</dt><dd>${esc(x.act)}</dd>
    <dt>Due</dt><dd>${longD(x.t)}${A ? ' · ' + esc(this._relLabel(A, x.t)) : ''}</dd>
    <dt>Status</dt><dd class="st st-${st}">${ST_TEXT[st]}</dd>
    <dt>Feeds</dt><dd>${feeds.length ? esc(feeds.join(', ')) : 'No milestone'}</dd>
  </dl>
  <div><div class="ms-small" style="font-weight:700;">WAITING ON (${preds.length})</div>${preds.map(rel).join('')}</div>
  <div><div class="ms-small" style="font-weight:700;">UNLOCKS (${succs.length})</div>${succs.map(rel).join('')}</div>
</section>`;
    }

    _mainHtml(M, kds, A, REQ, passes) {
        const s = this.state, n = s.bucket, h = this.host;
        const req = REQ.get(A.key);
        const view = M.items.filter(x => (s.scope === 'all' || req.has(x.id)) && passes(x));
        const colOf = t => { const diff = daysBetween(A.t, t); return diff < 0 ? 'after' : Math.floor(diff / (7 * n)); };
        const maxCols = Math.max(1, Math.floor(MAX_COLS / n));

        // Columns run from a week before today up to the milestone. Anything
        // older (done work, long-late lines) folds into one "earlier" column,
        // so a single old line can't stretch the axis across months.
        const todayK = colOf(M.today);
        const oldestK = typeof todayK === 'number' ? todayK + 1 : Infinity;
        let maxK = Math.min(3, maxCols - 1);
        if (typeof todayK === 'number' && todayK > maxK) maxK = todayK;
        view.forEach(x => { const c = colOf(x.t); if (typeof c === 'number' && c > maxK) maxK = c; });
        let hasEarlier = false;
        const limit = Math.min(maxCols - 1, Math.max(3, oldestK));
        if (maxK > limit) { maxK = limit; hasEarlier = true; }
        const place = t => { const c = colOf(t); return typeof c === 'number' && c > maxK ? 'earlier' : c; };
        const hasAfter = view.some(x => colOf(x.t) === 'after') || kds.some(k => colOf(k.t) === 'after');

        const cols = [];
        if (hasEarlier) cols.push({ key: 'earlier', label: `${A.name}-${(maxK + 1) * n} and earlier`, range: `Up to ${short(dayStart(A.t - ((maxK + 1) * 7 * n) * DAY + DAY / 2))}`, cls: 'extra', markers: [], isToday: typeof todayK === 'number' && todayK > maxK });
        for (let k = maxK; k >= 0; k--) {
            const lo = k * n, hi = k * n + n - 1;
            const end = A.t - k * 7 * n * DAY, start = end - (7 * n - 1) * DAY;
            const markers = kds.filter(kd => kd.key !== A.key && place(kd.t) === k).map(kd => kd.name);
            const isToday = todayK === k;
            cols.push({
                key: k, isToday, markers,
                label: n === 1 ? `${A.name}-${lo}` : `${A.name}-${hi} ~ ${A.name}-${lo}`,
                range: `${short(dayStart(start + DAY / 2))} – ${short(end)}`,
                cls: k === 0 ? 'end' : isToday ? 'today' : markers.length ? 'mark' : ''
            });
        }
        if (hasAfter) cols.push({ key: 'after', label: `After ${A.name}`, range: 'Past the end date', cls: 'extra', markers: [] });
        const gridCols = `200px repeat(${cols.length}, minmax(136px, 1fr))`;
        const minW = 200 + 136 * cols.length;

        const related = s.sel && M.byId.has(s.sel) ? (() => {
            const set = M.closure([s.sel]);
            const stack = [s.sel];
            while (stack.length) { const id = stack.pop(); (M.succ.get(id) || []).forEach(c => { if (!set.has(c)) { set.add(c); stack.push(c); } }); }
            return set;
        })() : null;

        const card = x => {
            const st = M.status.get(x.id);
            const color = h.activityColor(x.act);
            const inReq = req.has(x.id);
            const cls = ['ms-card', related ? (related.has(x.id) ? '' : 'dim') : (inReq ? '' : 'out'), s.sel === x.id ? 'sel' : '', st === 'late' || st === 'risk' ? 'warn' : ''].join(' ');
            const border = st === 'late' ? 'var(--st-late)' : color;
            const when = x.span > 1 ? `${short(x.start)}–${short(x.t)}` : dayShort(x.t);
            return `<button type="button" class="${cls}" data-act="sel" data-v="${esc(x.id)}" style="border-color:${esc(border)};background:${esc(color)}33" aria-label="${esc(`${x.asset}, ${x.act}, ${when}, ${ST_TEXT[st]}`)}">
  <span class="top"><span>${when}</span><span class="st st-${st}">${st === 'done' ? '✓ ' : st === 'late' || st === 'risk' ? '⚠ ' : ''}${ST_TEXT[st]}</span></span>
  <span class="a">${esc(x.asset)}</span><span class="act">${esc(x.act)}</span>
</button>`;
        };
        const kdCard = kd => {
            const st = M.statsOf(REQ.get(kd.key));
            return `<button type="button" class="ms-card kd ${kd.key === A.key ? 'anchor' : ''} ${related ? 'dim' : ''}" data-act="anchor" data-v="${esc(kd.key)}" aria-label="${esc(`Milestone ${kd.name}, ${longD(kd.t)}. Set as end of axis.`)}">
  <span class="top"><span>${dayShort(kd.t)}</span><span style="font-weight:700;color:var(--kd-ink);">⚑ ${esc(kd.name)}</span></span>
  <span class="act" style="color:var(--kd-ink);">${st.pct}% ready</span>
</button>`;
        };
        const cells = (entries, lane) => cols.map(c => {
            const inCol = entries.filter(e => e.col === c.key).sort((a, b) => a.t - b.t).map(e => e.html).join('');
            const cls = c.cls === 'end' || c.cls === 'today' || c.cls === 'extra' ? c.cls : '';
            return `<div class="ms-cell ${cls}" role="cell">${inCol}</div>`;
        }).join('');

        const kdVis = kds.filter(kd => { const c = place(kd.t); return c === 'after' ? hasAfter : true; });
        let lanesHtml = `<div class="ms-grid" role="row" style="grid-template-columns:${gridCols}"><div class="ms-lane" role="rowheader"><b><span class="ms-sw kd"></span>Milestones</b><span class="ms-small">${kdVis.length} shown</span></div>${cells(kdVis.map(kd => ({ col: place(kd.t), t: kd.t, html: kdCard(kd) })))}</div>`;
        const lanes = [...new Set(view.map(x => x.act))].sort((a, b) => a.localeCompare(b));
        lanes.forEach(act => {
            const its = view.filter(x => x.act === act);
            const dn = its.filter(x => M.status.get(x.id) === 'done').length;
            lanesHtml += `<div class="ms-grid" role="row" style="grid-template-columns:${gridCols}"><div class="ms-lane" role="rowheader"><b><span class="ms-sw" style="background:${esc(h.activityColor(act))}"></span>${esc(act)}</b><span class="ms-small">${dn} of ${its.length} done</span></div>${cells(its.map(x => ({ col: place(x.t), t: x.t, html: card(x) })))}</div>`;
        });
        const head = `<div class="ms-grid head" role="row" style="grid-template-columns:${gridCols}"><div class="ms-lane" role="columnheader" style="justify-content:flex-end;"><span class="ms-h2">Activity</span></div>${cols.map(c => `<div class="ms-colh ${c.cls}" role="columnheader"><span class="l">${esc(c.label)}</span><span class="r">${esc(c.range)}</span>${c.isToday ? '<span class="ms-tag today">TODAY</span>' : ''}${c.markers.map(m => `<span class="ms-code" style="font-size:10.5px;align-self:flex-start;">${esc(m)}</span>`).join('')}</div>`).join('')}</div>`;

        // readiness
        const st = M.statsOf(req);
        const left = daysBetween(A.t, M.today);
        const todayText = left >= 0 ? `Today falls in ${A.name}-${Math.floor(left / 7)} · ${left} day${left === 1 ? '' : 's'} to go` : `This date passed ${-left} day${left === -1 ? '' : 's'} ago`;
        const next = M.items.filter(x => req.has(x.id) && M.status.get(x.id) !== 'done' && x.t >= M.today).sort((a, b) => a.t - b.t)[0];
        const seg = (v, c) => v ? `<span style="flex:${v} 0 0;background:${c};"></span>` : '';
        const ready = `<section class="ms-ready" aria-label="Milestone readiness">
  <div style="display:flex;flex-direction:column;gap:6px;flex:1 1 300px;min-width:0;">
    <div style="display:flex;align-items:center;gap:10px;"><span class="ms-code">⚑ ${esc(A.name)}-0</span><span class="ms-small">${longD(A.t)}</span></div>
    <h1>${esc(A.name)}</h1>
    <p class="ms-small" style="font-size:14px;">${todayText}</p>
    <p><b>Next due:</b> ${next ? `${esc(next.asset)} — ${esc(next.act)} · ${dayShort(next.t)} (${esc(this._relLabel(A, next.t))})` : 'Nothing open'}</p>
  </div>
  <div style="display:flex;flex-direction:column;gap:10px;flex:1 1 380px;min-width:0;">
    <div class="ms-stats">
      <div class="ms-stat"><b>${st.pct}%</b><span class="ms-small">Ready (${st.done}/${st.total})</span></div>
      <div class="ms-stat"><b>${st.planned}</b><span class="ms-small">Planned</span></div>
      <div class="ms-stat"><b class="st-risk">${st.risk}</b><span class="ms-small">At risk</span></div>
      <div class="ms-stat"><b class="st-late">${st.late}</b><span class="ms-small">Late</span></div>
    </div>
    <div class="ms-stack" role="img" aria-label="${st.done} done, ${st.planned} planned, ${st.risk} at risk, ${st.late} late">${seg(st.done, '#2f7d32')}${seg(st.planned, '#a9b3bc')}${seg(st.risk, '#d98a1c')}${seg(st.late, '#a1231b')}</div>
  </div>
</section>`;

        const rows = M.items.filter(x => req.has(x.id) && passes(x)).sort((a, b) => a.t - b.t).map(x => {
            const stt = M.status.get(x.id);
            const waiting = x.preds.filter(p => M.status.get(p) !== 'done').map(p => { const y = M.byId.get(p); return `${y.asset} — ${y.act}`; });
            return `<tr class="${s.sel === x.id ? 'sel' : stt === 'late' ? 'late' : ''}">
  <td style="font-weight:700;white-space:nowrap;">${esc(this._relLabel(A, x.t))}</td>
  <td style="white-space:nowrap;">${dayShort(x.t)}</td>
  <td><button type="button" data-act="sel" data-v="${esc(x.id)}">${esc(x.asset)}</button></td>
  <td><span style="display:inline-flex;align-items:center;gap:6px;"><span class="ms-sw" style="background:${esc(h.activityColor(x.act))}"></span>${esc(x.act)}</span></td>
  <td><span class="st st-${stt}">${ST_TEXT[stt]}</span></td>
  <td class="ms-small" style="color:inherit;">${waiting.length ? esc(waiting.join(', ')) : '—'}</td>
</tr>`;
        }).join('');

        return `${ready}
<section aria-label="Milestone timeline" style="display:flex;flex-direction:column;gap:10px;">
  <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;"><h2 class="ms-h2">Timeline · counting back from ${esc(A.name)}-0</h2><span class="ms-small">${view.length} lines · click a line to trace what it waits on and unlocks</span></div>
  <div class="ms-tl" role="table" aria-label="Milestone timeline"><div style="min-width:${minW}px;">${head}${lanesHtml}</div></div>
</section>
<section aria-label="Required lines" style="display:flex;flex-direction:column;gap:10px;">
  <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;"><h2 class="ms-h2">Required for ${esc(A.name)}</h2><span class="ms-small">${A.scope ? 'Chosen zones and lines' : 'Everything due by its date'}, plus every predecessor in the chain</span></div>
  <div class="ms-tl"><table class="ms-table"><thead><tr><th scope="col">Week</th><th scope="col">Due</th><th scope="col">Asset</th><th scope="col">Activity</th><th scope="col">Status</th><th scope="col">Waiting on</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="6" class="ms-small">${A.scope ? 'None of the chosen lines are on the schedule.' : 'No lines are due on or before this milestone.'}</td></tr>`}</tbody></table></div>
</section>`;
    }

    // ---- events ----------------------------------------------------------

    _onClick(e) {
        const btn = e.target.closest('[data-act]');
        if (!btn || !this.root.contains(btn)) return;
        const v = btn.getAttribute('data-v');
        const s = this.state;
        switch (btn.getAttribute('data-act')) {
            case 'anchor': s.anchorKey = v; break;
            case 'bucket': s.bucket = Number(v) || 1; break;
            case 'scope': s.scope = v === 'all' ? 'all' : 'req'; break;
            case 'lane': if (s.hidden.has(v)) s.hidden.delete(v); else s.hidden.add(v); break;
            case 'sel': s.sel = v && s.sel !== v ? v : null; break;
            case 'add': this._openForm(null); return;
            case 'edit': this._openForm(v); return;
            case 'remove': this._remove(v); return;
            default: return;
        }
        this.render();
    }

    _onChange(e) {
        if (e.target.matches('[data-ms="anchor"]')) { this.state.anchorKey = e.target.value; this.render(); }
    }

    // ---- add / edit dialog ----------------------------------------------
    // Rendered once when it opens; ticking boxes and typing only touch the
    // DOM in place, so open zones and the scroll position stay put.

    _openForm(key) {
        if (!this.canEdit) return;
        const m = key ? this.milestones.find(x => x.key === key) : null;
        if (key && !m) return;
        this.form = {
            key: m ? m.key : null,
            zones: new Set(m && m.scope ? m.scope.zones : []),
            lines: new Set(m && m.scope ? m.scope.lines : []),
            saving: false
        };
        const f = this.form;
        const others = this.milestones.filter(x => !m || (x.key !== m.key && !this._dependsOn(x, m.key)));
        const based = !!(m && m.base);
        const weeks = m ? Math.round(Math.abs(m.offsetDays) / 7) : 2;
        const dir = m && m.offsetDays > 0 ? 1 : -1;

        // Lines grouped by zone, one row per asset + activity.
        const zones = new Map();
        this._items().forEach(x => {
            if (!zones.has(x.zone)) zones.set(x.zone, new Map());
            const g = zones.get(x.zone);
            const l = g.get(x.lineKey) || { key: x.lineKey, asset: x.asset, act: x.act, first: x.t, last: x.t };
            l.first = Math.min(l.first, x.t); l.last = Math.max(l.last, x.t);
            g.set(x.lineKey, l);
        });
        // Zones/lines a saved milestone names that aren't on the schedule now
        // still show, so they can be seen and unticked.
        f.zones.forEach(z => { if (!zones.has(z)) zones.set(z, new Map()); });
        const known = new Set([].concat(...[...zones.values()].map(g => [...g.keys()])));
        f.lines.forEach(k => {
            if (known.has(k)) return;
            const [asset, act] = k.split('|||');
            if (!zones.has('')) zones.set('', new Map());
            zones.get('').set(k, { key: k, asset: asset || '(no asset)', act: act || '(no activity)', first: null, last: null });
        });
        const zoneNames = [...zones.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
        const fewZones = zoneNames.length <= 3;
        const zoneHtml = zoneNames.map(z => {
            const lines = [...zones.get(z).values()].sort((a, b) => (a.first ?? Infinity) - (b.first ?? Infinity) || a.asset.localeCompare(b.asset));
            const allOn = f.zones.has(z);
            const picked = lines.filter(l => f.lines.has(l.key)).length;
            const label = z || 'No zone';
            return `<details class="ms-zone" data-zone="${esc(z)}" ${fewZones || allOn || picked ? 'open' : ''}>
  <summary><span>${esc(label)}</span><span class="cnt" data-zcnt>${this._zoneCount(lines.length, allOn, picked)}</span></summary>
  <label class="ms-line all"><input type="checkbox" data-mf-zone="${esc(z)}" ${allOn ? 'checked' : ''}><b>All lines in ${esc(label)}</b><span class="d">includes lines added later</span></label>
  ${lines.map(l => `<label class="ms-line" data-find="${esc((l.asset + ' ' + l.act + ' ' + label).toLowerCase())}"><input type="checkbox" data-mf-line="${esc(l.key)}" ${allOn || f.lines.has(l.key) ? 'checked' : ''} ${allOn ? 'disabled' : ''}>${esc(l.asset)} — ${esc(l.act)}<span class="d">${l.first == null ? 'not on the schedule' : l.first === l.last ? dayShort(l.first) : `${short(l.first)}–${short(l.last)}`}</span></label>`).join('')}
</details>`;
        }).join('') || '<p class="ms-small" style="padding:12px;margin:0;">There are no lines in Bridge yet.</p>';

        this.modal.innerHTML = `
<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="msfTitle">
  <div class="modal-head"><h2 id="msfTitle">${m ? 'Edit ' + esc(m.name) : 'Add milestone'}</h2><button type="button" class="modal-close" data-mf="close" aria-label="Close">×</button></div>
  <div class="modal-body">
    <div class="form-row"><label for="msfName">Name</label><input type="text" id="msfName" maxlength="60" placeholder="e.g. FR1" value="${esc(m ? m.name : '')}"></div>

    <fieldset class="ms-fieldset"><legend>Due date</legend>
      <label class="ms-radio"><input type="radio" name="msfDateMode" value="date" ${based ? '' : 'checked'}>Pick a date</label>
      <div class="ms-sub" data-mf-sec="date" ${based ? 'hidden' : ''}><input type="date" id="msfDate" aria-label="Due date" value="${m ? isoDay(m.t) : ''}"></div>
      <label class="ms-radio"><input type="radio" name="msfDateMode" value="based" ${based ? 'checked' : ''} ${others.length ? '' : 'disabled'}>Base it on another milestone${others.length ? '' : ' <span class="ms-small">(add one first)</span>'}</label>
      <div class="ms-sub" data-mf-sec="based" ${based ? '' : 'hidden'}>
        <input type="number" id="msfWeeks" min="0" max="260" step="1" value="${weeks}" style="width:72px" aria-label="Weeks">
        <span>weeks</span>
        <select id="msfDir" aria-label="Before or after"><option value="-1" ${dir < 0 ? 'selected' : ''}>before</option><option value="1" ${dir > 0 ? 'selected' : ''}>after</option></select>
        <select id="msfBase" aria-label="Milestone it is based on">${others.map(o => `<option value="${esc(o.key)}" ${m && m.basedOn === o.key ? 'selected' : ''}>${esc(o.name)} (${short(o.t)}/${String(new Date(o.t).getFullYear()).slice(2)})</option>`).join('')}</select>
        <b id="msfPreview"></b>
      </div>
      <p class="ms-note" data-mf-sec="based" ${based ? '' : 'hidden'}>Moves automatically when the milestone it's based on moves.</p>
    </fieldset>

    <fieldset class="ms-fieldset"><legend>Lines it needs</legend>
      <label class="ms-radio"><input type="radio" name="msfScope" value="auto" ${m && m.scope ? '' : 'checked'}>Everything due on or before its date</label>
      <label class="ms-radio"><input type="radio" name="msfScope" value="pick" ${m && m.scope ? 'checked' : ''}>Choose zones and lines</label>
      <div class="ms-picksec" data-mf-sec="pick" ${m && m.scope ? '' : 'hidden'}>
        <div class="ms-searchrow"><input type="search" id="msfSearch" placeholder="Search asset, activity or zone" aria-label="Search lines"><span class="ms-small" id="msfCount"></span></div>
        <div class="ms-pick">${zoneHtml}</div>
      </div>
      <p class="ms-note">Every predecessor of the chosen lines is included too.</p>
    </fieldset>
    <p class="ms-ferr" id="msfErr" role="alert"></p>
  </div>
  <div class="modal-foot"><button type="button" class="tool-btn" data-mf="close">Cancel</button><button type="button" class="tool-btn primary" data-mf="save">${m ? 'Save' : 'Add and set as end'}</button></div>
</div>`;
        this.modal.classList.add('open');
        this._formRefresh();
        const name = this.modal.querySelector('#msfName');
        if (name) name.focus();
    }

    _closeForm() {
        this.form = null;
        this.modal.classList.remove('open');
        this.modal.innerHTML = '';
    }

    _zoneCount(total, allOn, picked) {
        if (allOn) return `all ${total} line${total === 1 ? '' : 's'}`;
        return picked ? `${picked} of ${total} chosen` : `${total} line${total === 1 ? '' : 's'}`;
    }

    // True when milestone x is (directly or further up the chain) based on key.
    _dependsOn(x, key) {
        const by = new Map(this.milestones.map(m => [m.key, m]));
        const seen = new Set();
        let cur = x;
        while (cur && cur.basedOn && !seen.has(cur.key)) {
            if (cur.basedOn === key) return true;
            seen.add(cur.key);
            cur = by.get(cur.basedOn);
        }
        return false;
    }

    _q(sel) { return this.modal.querySelector(sel); }

    _formValues() {
        const q = s => this._q(s);
        const dateMode = (q('input[name="msfDateMode"]:checked') || {}).value || 'date';
        const scopeMode = (q('input[name="msfScope"]:checked') || {}).value || 'auto';
        const weeks = Number(q('#msfWeeks')?.value);
        const dir = Number(q('#msfDir')?.value) || -1;
        const baseKey = q('#msfBase')?.value || '';
        const base = this.milestones.find(m => m.key === baseKey) || null;
        let t = null;
        if (dateMode === 'date') { const v = q('#msfDate')?.value || ''; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) t = parseIsoDay(v); }
        else if (base && Number.isInteger(weeks) && weeks >= 0) t = dayStart(base.t + dir * weeks * 7 * DAY + DAY / 2);
        return { name: (q('#msfName')?.value || '').trim().replace(/\s+/g, ' '), dateMode, scopeMode, weeks, dir, base, t };
    }

    // Show/hide the sections for the chosen options, the based-on date and the count.
    _formRefresh() {
        const f = this.form;
        if (!f) return;
        const v = this._formValues();
        this.modal.querySelectorAll('[data-mf-sec]').forEach(el => {
            const sec = el.getAttribute('data-mf-sec');
            el.hidden = sec === 'pick' ? v.scopeMode !== 'pick' : sec !== v.dateMode;
        });
        const prev = this._q('#msfPreview');
        if (prev) prev.textContent = v.dateMode === 'based' && v.t != null ? `= ${longD(v.t)}` : '';
        const cnt = this._q('#msfCount');
        if (cnt) {
            const z = f.zones.size, l = [...f.lines].filter(k => !this._lineInChosenZone(k)).length;
            cnt.textContent = z || l ? `${z} zone${z === 1 ? '' : 's'}, ${l} line${l === 1 ? '' : 's'} chosen` : 'Nothing chosen yet';
        }
    }

    _lineInChosenZone(key) {
        const box = [...this.modal.querySelectorAll('[data-mf-line]')].find(b => b.getAttribute('data-mf-line') === key);
        const zone = box && box.closest('.ms-zone').getAttribute('data-zone');
        return zone != null && this.form.zones.has(zone);
    }

    _refreshZoneCount(details) {
        const z = details.getAttribute('data-zone');
        const boxes = [...details.querySelectorAll('[data-mf-line]')];
        const picked = boxes.filter(b => this.form.lines.has(b.getAttribute('data-mf-line'))).length;
        details.querySelector('[data-zcnt]').textContent = this._zoneCount(boxes.length, this.form.zones.has(z), picked);
    }

    _onFormClick(e) {
        if (e.target === this.modal) { this._closeForm(); return; } // click on the dimmed backdrop
        const b = e.target.closest('[data-mf]');
        if (!b) return;
        if (b.getAttribute('data-mf') === 'close') this._closeForm();
        else if (b.getAttribute('data-mf') === 'save') this._save();
    }

    _onFormChange(e) {
        const f = this.form;
        if (!f) return;
        const t = e.target;
        if (t.hasAttribute('data-mf-zone')) {
            const z = t.getAttribute('data-mf-zone');
            if (t.checked) f.zones.add(z); else f.zones.delete(z);
            const details = t.closest('.ms-zone');
            details.querySelectorAll('[data-mf-line]').forEach(b => {
                b.disabled = t.checked;
                b.checked = t.checked || f.lines.has(b.getAttribute('data-mf-line'));
            });
            this._refreshZoneCount(details);
        } else if (t.hasAttribute('data-mf-line')) {
            const k = t.getAttribute('data-mf-line');
            if (t.checked) f.lines.add(k); else f.lines.delete(k);
            this._refreshZoneCount(t.closest('.ms-zone'));
        }
        this._formRefresh();
    }

    _onFormInput(e) {
        if (e.target.id === 'msfSearch') {
            const q = e.target.value.trim().toLowerCase();
            this.modal.querySelectorAll('.ms-zone').forEach(d => {
                let any = false;
                d.querySelectorAll('.ms-line[data-find]').forEach(row => {
                    const hit = !q || row.getAttribute('data-find').includes(q);
                    row.hidden = !hit; any = any || hit;
                });
                d.hidden = !!q && !any;
                if (q && any) d.open = true;
            });
            return;
        }
        this._formRefresh();
    }

    // Every version is a full row, so build it from the milestone as it is
    // now plus the changes.
    _rowOf(m, changes) {
        const r = {
            milestone_key: m.key, name: m.name, due_date: isoDay(m.t),
            based_on: m.basedOn || null, offset_days: m.offsetDays || 0, scope: m.scope || null, archived: false
        };
        return { ...r, ...changes };
    }

    async _insert(rows) {
        const list = (Array.isArray(rows) ? rows : [rows]).map(r => ({ project_key: this.host.PROJECT_KEY, ...r }));
        const { error } = await this.host._supabase.from('launchpad_milestones').insert(list);
        if (error) {
            console.error('Saving milestone failed', error);
            const rls = error.code === '42501' || /row-level security|permission denied/i.test(error.message || '');
            const oldDb = error.code === '42703' || error.code === 'PGRST204' || /column/i.test(error.message || '');
            throw new Error(rls ? 'Only project admins and editors can change milestones.'
                : oldDb ? 'The database needs the latest sync/milestones.sql. Run it again in Supabase, then save.'
                : 'Saving failed. See the browser console for details.');
        }
    }

    async _save() {
        const f = this.form;
        if (!f || f.saving || !this.canEdit) return;
        const err = this._q('#msfErr');
        const fail = msg => { err.textContent = msg; };
        const v = this._formValues();
        if (!v.name) return fail('Give the milestone a name, like FR1.');
        if (v.name.length > 60) return fail('Keep the name to 60 characters or fewer.');
        if (this.milestones.some(m => m.key !== f.key && m.name.toLowerCase() === v.name.toLowerCase())) return fail(`${v.name} already exists.`);
        if (v.dateMode === 'date' && v.t == null) return fail('Pick a due date.');
        if (v.dateMode === 'based') {
            if (!v.base) return fail('Pick the milestone it is based on.');
            if (!Number.isInteger(v.weeks) || v.weeks < 0 || v.weeks > 260) return fail('Weeks must be a whole number from 0 to 260.');
        }
        let scope = null;
        if (v.scopeMode === 'pick') {
            const lines = [...f.lines].filter(k => !this._lineInChosenZone(k));
            if (!f.zones.size && !lines.length) return fail('Choose at least one zone or line, or use "Everything due on or before its date".');
            scope = { zones: [...f.zones].sort(), lines: lines.sort() };
        }
        const key = f.key || newKey();
        const row = {
            milestone_key: key, name: v.name, due_date: isoDay(v.t),
            based_on: v.dateMode === 'based' ? v.base.key : null,
            offset_days: v.dateMode === 'based' ? v.dir * v.weeks * 7 : 0,
            scope, archived: false
        };
        f.saving = true; err.textContent = '';
        const saveBtn = this._q('[data-mf="save"]');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
        try {
            await this._insert(row);
            this._closeForm();
            this.state.anchorKey = key;
            this.host.toast(`Milestone ${v.name} saved.`);
            await this._loadMilestones();
            this.render();
        } catch (e) {
            f.saving = false;
            fail(e.message);
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = f.key ? 'Save' : 'Add and set as end'; }
        }
    }

    async _remove(key) {
        const k = this.milestones.find(m => m.key === key);
        if (!k || !this.canEdit) return;
        // Milestones based on this one keep the date they have now.
        const deps = this.milestones.filter(m => m.basedOn === key);
        const note = deps.length ? `\n\n${deps.map(d => d.name).join(', ')} ${deps.length === 1 ? 'is' : 'are'} based on it and will keep ${deps.length === 1 ? 'its' : 'their'} current date.` : '';
        if (!confirm(`Remove milestone ${k.name} (${longD(k.t)})? Its history is kept.${note}`)) return;
        try {
            await this._insert([
                ...deps.map(d => this._rowOf(d, { based_on: null, offset_days: 0 })),
                this._rowOf(k, { archived: true })
            ]);
            if (this.state.anchorKey === key) this.state.anchorKey = null;
            this.host.toast(`Milestone ${k.name} removed.`);
            await this._loadMilestones();
        } catch (err) {
            this.host.toast(err.message, 5500);
        }
        this.render();
    }
}
