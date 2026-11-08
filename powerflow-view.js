// <powerflow-view>: the Power Flow Diagram module (ARC-237, phase 1).
//
// Mounted by index.html's ensureViewMounted('powerflow') like the other
// custom-element views, with project / role / email / script-url attributes
// and the shell's authenticated Supabase client. Hidden on every project
// until an admin ticks it in Settings > Navigation Menu.
//
// What it shows
//   Asset diagram  the drawing's assets grouped by section, each wrapped in
//                  its commissioning status colour, with fed-from links, a
//                  tamper seal icon and a calendar icon. Hovering an asset
//                  shows CHK/ISS per phase; hovering the calendar shows its
//                  current and past activities; the seal icon shows its seals.
//   Match-up       ties each drawing tag to the LaunchPad asset list. Exact
//                  tags are accepted automatically; edge cases follow the
//                  project's rules or wait for an admin decision. Every
//                  import, decision and rule change is in the setup log.
//   Single lines   phase 2 (sheet images with outlines); a placeholder now.
//
// Where the data comes from (nothing is copied or owned here)
//   Drawing data       launchpad_powerflow_imports (newest import wins)
//   Decisions, rules   launchpad_powerflow_log (newest row per subject wins)
//   Asset list, CHK/ISS  launchpad_equipment_tracker_data (+ its config)
//   LP Status          the project's Apps Script ?action=getLpStatus (LP_Data)
//   Tamper seals       {project}Assets + launchpad_tamperseal_config workflows
//   Schedule           {prefix}BackEndData, matched on the asset name
// Both power-flow tables are insert-only (sync/power_flow.sql); undo is a
// new log row.

const NO_SEAL = '(No seal on record)';

const LEVELS = {
    designed: { label: 'Designed', chip: 'DES' },
    l2: { label: 'Level 2 ready', chip: 'L2' },
    l3: { label: 'Energization / Level 3 ready', chip: 'L3' },
    l4: { label: 'Level 4 ready', chip: 'L4' },
    qcx: { label: 'QCx complete', chip: 'QCx' },
    track: { label: 'Track only, no Cx', chip: 'TRK' },
    pending: { label: 'Not matched yet', chip: '?' }
};
const LEVEL_ORDER = ['designed', 'l2', 'l3', 'l4', 'qcx'];

// Edge cases LaunchPad recognises when it reads an import, in the order it
// checks them. `actions` are what the admin can pick as the rule.
const EDGE_RULES = [
    { key: 'unreadable', name: 'Unreadable tag', example: 'Tag contains a ?', def: 'review', actions: ['review', 'ignore'] },
    { key: 'spare', name: 'Spare / space', example: 'SPARE or SPACE in the tag, type or description', def: 'ignore', actions: ['ignore', 'review', 'track'] },
    { key: 'others', name: 'By others', example: 'Scope says "by others" or NIC', def: 'track', actions: ['track', 'review', 'ignore'] },
    { key: 'ofe', name: 'Owner furnished (OFE)', example: 'Scope says OFE', def: 'review', actions: ['review', 'accept', 'track', 'ignore'] },
    { key: 'sub', name: 'Part of a larger asset', example: 'Not in the list, but its parent_tag is', def: 'attach', actions: ['attach', 'review', 'ignore'] },
    { key: 'fuzzy', name: 'Tag close to a known asset', example: 'GEN-1A vs GEN1A, l vs 1, O vs 0', def: 'review', actions: ['review', 'accept'] },
    { key: 'notInList', name: 'On drawing, not in asset list', example: 'No asset with this tag', def: 'review', actions: ['review', 'keep', 'track', 'ignore'] },
    { key: 'notOnDrawing', name: 'In asset list, not on any drawing', example: 'Listed in LaunchPad, not in the import', def: 'review', actions: ['review', 'offpath'] }
];
const RULE_ACTION_LABELS = {
    review: 'Send to review', accept: 'Auto-accept suggestion', attach: 'Attach to parent asset',
    track: 'Track only, no Cx', ignore: 'Ignore', keep: 'Keep as drawing-only asset', offpath: 'Mark off power path'
};
const CUSTOM_RULE_ACTIONS = ['review', 'track', 'ignore', 'keep'];

const DECISION_BADGES = {
    pending: ['Needs decision', 'b-progress'], matched: ['Matched', 'b-success'], attached: ['Attached', 'b-success'],
    track: ['Track only', 'b-draft'], ignored: ['Ignored', 'b-closed'], drawingOnly: ['Drawing only', 'b-partial'],
    offpath: ['Off power path', 'b-closed']
};

const DEFAULT_STATUS_MAP = {
    qcx: { level: 'L4', words: 'qcx complete, cx complete' },
    l4: { level: 'L4', words: 'ready' },
    l3: { level: 'L3', words: 'ready, energiz' },
    l2: { level: 'L2', words: 'ready' }
};

const TEMPLATE_COLUMNS = ['asset_tag', 'fed_from_tag', 'source', 'spa_scope', 'section', 'type', 'sheet', 'parent_tag', 'description'];
const TEMPLATE_CSV = TEMPLATE_COLUMNS.join(',') + '\n' + [
    'UTIL-XFMR-1,,A,By others,Utility yard,Transformer,E-501,,Utility transformer',
    'SWGR-MV-1,UTIL-XFMR-1,A,,MV building,Switchgear,E-501,,15 kV switchgear lineup',
    'SWGR-MV-1-52F1,SWGR-MV-1,A,,MV building,Breaker,E-501,SWGR-MV-1,Feeder breaker',
    'SWGR-MV-1-52F2,SWGR-MV-1,A,,MV building,Breaker,E-501,SWGR-MV-1,SPARE',
    'XFMR-1,SWGR-MV-1-52F1,A,,Electrical room 1,Transformer,E-502,,Unit substation transformer',
    'BUS-1,XFMR-1,A,OFE,Data hall 1,Busway,E-502,,Row 1 busway'
].join('\n') + '\n';

const AI_PROMPT = `You are reading electrical single-line diagram sheets (attached PDF). Build a power-flow table.

Output ONLY CSV (no commentary) with exactly these columns, in this order:
${TEMPLATE_COLUMNS.join(',')}

One row per piece of electrical equipment shown (utility gear, switchgear, breakers you can identify, transformers, unit substations, switchboards, panels, UPS, generators, ATS, busways, PDUs).
- asset_tag: the equipment tag exactly as printed. If part of a tag is unreadable, keep what you can read and put ? where characters are unclear.
- fed_from_tag: the asset_tag of the equipment directly upstream that feeds it. Blank for the source of power.
- source: the source path letter (A, B, C, D) for multi-source systems; blank if not shown.
- spa_scope: scope notes printed near the equipment, e.g. "By others", "NIC", "OFE". Blank if none.
- section: the building section, zone, room or area the sheet groups it under.
- type: the kind of equipment, e.g. Switchgear, Breaker, Transformer, Unit substation, Busway.
- sheet: the sheet number the equipment appears on. If it appears on several sheets, add one row per sheet.
- parent_tag: for a breaker or component inside a lineup or skid, the tag of the larger asset it belongs to. Blank otherwise.
- description: rating or short note, e.g. "15 kV, 3000 A". Write SPARE or SPACE for spare/space positions.

Do not invent tags. Quote any value that contains a comma.`;

const STYLE = `
<style>
:host { display: block; height: 100%; overflow: auto; box-sizing: border-box; font-family: var(--font-roboto, 'Roboto', sans-serif); font-size: 14px; line-height: 1.5;
  --pf-page: var(--neutrals-lightmode-light-mode-Page, #f3f2ee); --pf-surface: var(--neutrals-lightmode-light-mode-Surface, #ffffff);
  --pf-subtle: var(--neutrals-lightmode-light-mode-Subtle, #e7e5df); --pf-border: var(--neutrals-lightmode-light-mode-Border, #d6d3cb);
  --pf-border-strong: var(--neutrals-lightmode-light-mode-Borderstrong, #b2aea4); --pf-text: var(--neutrals-lightmode-light-mode-Textprimary, #141718);
  --pf-text2: var(--neutrals-lightmode-light-mode-Textsecondary, #6a675f); --pf-petrol: var(--Petrol, #0f5a60); --pf-petrol-tint: var(--Petrol-tint, #e3efef);
  --pf-green: var(--Arc-Green, #4ebd4f); --pf-green-tint: var(--Arc-Green-tint, #eaf6ea); --pf-shadow: var(--shadow-elevated, 0 1px 3px rgba(20,23,24,.12));
  background: var(--pf-page); color: var(--pf-text); }
:host(.dark-mode) { --pf-page: #121212; --pf-surface: #1e1e1e; --pf-subtle: #2c2c2c; --pf-border: #3a3a3a; --pf-border-strong: #555; --pf-text: #e8e6e1; --pf-text2: #b0ada6; --pf-petrol-tint: #16383b; --pf-petrol: #7cc4c9; --pf-green-tint: #1f3320; }
* { box-sizing: border-box; }
.wrap { padding: 20px 24px 48px; display: flex; flex-direction: column; gap: 16px; min-height: 100%; }
.eyebrow { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--pf-text2); }
h1 { margin: 0; font-size: 28px; font-weight: 600; line-height: 1.3; }
h2 { margin: 0; font-size: 18px; font-weight: 600; }
h3 { margin: 0; font-size: 15px; font-weight: 600; }
p { margin: 0; }
.muted { color: var(--pf-text2); }
.small { font-size: 12px; }
.head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.btn { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 14px; border-radius: 6px; border: 1px solid var(--pf-border-strong); background: var(--pf-surface); color: var(--pf-text); font: inherit; font-weight: 600; cursor: pointer; }
.btn:hover { border-color: var(--pf-petrol); }
.btn.primary { background: var(--pf-petrol); border-color: var(--pf-petrol); color: #fff; }
:host(.dark-mode) .btn.primary { color: #0b1d1f; }
.btn.sm { min-height: 32px; padding: 0 10px; font-size: 13px; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.linkbtn { border: 0; background: none; padding: 0 4px; min-height: 28px; font: inherit; font-size: 12px; font-weight: 600; color: var(--pf-petrol); text-decoration: underline; cursor: pointer; }
button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 3px solid var(--pf-green); outline-offset: 2px; }
.tabs { display: flex; flex-wrap: wrap; gap: 24px; border-bottom: 1px solid var(--pf-border); }
.tab { padding: 10px 0; border: 0; border-bottom: 3px solid transparent; background: none; font: inherit; font-weight: 600; color: var(--pf-text2); cursor: pointer; }
.tab[aria-selected="true"] { color: var(--pf-text); border-bottom-color: var(--pf-green); }
.card { background: var(--pf-surface); border-radius: 12px; box-shadow: var(--pf-shadow); padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.card.dashed { box-shadow: none; border: 1.5px dashed var(--pf-border-strong); }
.note { padding: 10px 14px; border-radius: 8px; background: var(--pf-petrol-tint); color: var(--pf-petrol); font-size: 13px; }
.note.warn { background: #fdf0cc; color: #7a5600; }
.note.err { background: #fce4e4; color: #a32a2a; }
.seg { display: inline-flex; flex-wrap: wrap; padding: 4px; gap: 4px; background: var(--pf-subtle); border-radius: 8px; }
.seg button { min-height: 34px; padding: 0 12px; border: 0; border-radius: 6px; background: transparent; font: inherit; color: var(--pf-text2); cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--pf-surface); color: var(--pf-text); font-weight: 600; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; font-size: 12px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.sw { width: 16px; height: 12px; border-radius: 3px; border: 3px solid; display: inline-block; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr)); gap: 16px; align-items: start; }
.sec-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.asset { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px; border: 3px solid; min-height: 52px; }
.asset .main { flex: 1 1 auto; min-width: 0; border: 0; background: none; padding: 0; font: inherit; color: inherit; text-align: left; cursor: help; }
.asset .tag { font-weight: 700; overflow-wrap: anywhere; }
.asset .st { font-size: 12px; font-weight: 600; }
.asset .fed { font-size: 11px; opacity: .85; overflow-wrap: anywhere; }
.kids { display: flex; flex-direction: column; gap: 6px; margin-left: 18px; }
.ico { flex: 0 0 auto; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border-radius: 9999px; border: 2px solid #fff; padding: 0; cursor: pointer; box-shadow: 0 1px 3px rgba(20,23,24,.3); }
.ico.seal { background: #a32a2a; color: #fff; }
.ico.seal.ok { background: var(--pf-surface); color: var(--pf-text2); border-color: var(--pf-border-strong); box-shadow: none; }
.ico.cal { background: #0f5a60; color: #fff; }
.s-designed { border-color: #ee8080; background: rgba(238,128,128,.22); }
.s-l2 { border-color: #f2c94c; background: rgba(242,201,76,.22); }
.s-l3 { border-color: #7fa9e8; background: rgba(127,169,232,.22); }
.s-l4 { border-color: #74c690; background: rgba(116,198,144,.22); }
.s-qcx { border-color: #22663b; background: #22663b; color: #fff; }
.s-track { border-color: var(--pf-border-strong); border-style: dashed; background: var(--pf-page); }
.s-pending { border-color: #6a675f; border-style: dashed; background: var(--pf-surface); }
.st-designed { color: #a32a2a; } .st-l2 { color: #7a5600; } .st-l3 { color: #2a4f8f; } .st-l4 { color: #22663b; } .st-qcx { color: #fff; } .st-track, .st-pending { color: var(--pf-text2); }
:host(.dark-mode) .st-designed { color: #ff9c9c; } :host(.dark-mode) .st-l2 { color: #f2c94c; } :host(.dark-mode) .st-l3 { color: #9fc0f2; } :host(.dark-mode) .st-l4 { color: #8fd8a6; }
.pill { display: inline-flex; padding: 2px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
.p-designed { background: #fce4e4; color: #a32a2a; } .p-l2 { background: #fdf0cc; color: #7a5600; } .p-l3 { background: #e1eafb; color: #2a4f8f; }
.p-l4 { background: #e2f3e8; color: #22663b; } .p-qcx { background: #22663b; color: #fff; } .p-track, .p-pending { background: var(--pf-subtle); color: var(--pf-text2); }
.badge { display: inline-flex; padding: 1px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.b-success { background: var(--workflow-success-badgebg, #e2f3e8); color: var(--workflow-success-badgetext, #22663b); }
.b-progress { background: var(--workflow-inprogress-badgebg, #fdf0cc); color: var(--workflow-inprogress-badgetext, #7a5600); }
.b-draft { background: var(--workflow-draft-badgebg, #e7e5df); color: var(--workflow-draft-badgetext, #4e4c46); }
.b-closed { background: var(--workflow-closed-badgebg, #fce4e4); color: var(--workflow-closed-badgetext, #a32a2a); }
.b-partial { background: var(--workflow-partialfill-badgebg, #e1eafb); color: var(--workflow-partial-badgetext, #2a4f8f); }
.b-notstarted { background: var(--workflow-notstarted-badgebg, #e7e5df); color: var(--workflow-notstarted-badgetext, #4e4c46); }
.scroll-x { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 980px; }
th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--pf-text2); background: var(--pf-subtle); padding: 8px 10px; }
td { padding: 10px; border-bottom: 1px solid var(--pf-border); vertical-align: top; font-size: 13px; }
tr.done td { background: var(--pf-page); }
td .acts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px; }
select, input[type="text"], input[type="search"] { min-height: 34px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--pf-border-strong); background: var(--pf-surface); color: var(--pf-text); font: inherit; font-size: 13px; }
label.field { display: flex; flex-direction: column; gap: 2px; font-size: 11px; font-weight: 600; color: var(--pf-text2); }
.two { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.two > * { flex: 1 1 420px; }
.rules-row { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1.1fr) minmax(0, 1fr); gap: 8px 12px; align-items: center; padding: 8px 0; border-top: 1px solid var(--pf-border); }
.checks { display: flex; flex-direction: column; gap: 4px; }
.checks label { display: flex; align-items: center; gap: 8px; min-height: 30px; cursor: pointer; }
.checks input { width: 18px; height: 18px; accent-color: #4ebd4f; }
ol.log { margin: 0; padding: 0; list-style: none; max-height: 560px; overflow-y: auto; }
ol.log li { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; border-top: 1px solid var(--pf-border); }
#pop { position: fixed; z-index: 50; width: 340px; max-width: calc(100vw - 16px); max-height: 70vh; overflow-y: auto; display: none; padding: 14px 16px; flex-direction: column; gap: 8px;
  background: var(--pf-surface); border: 1px solid var(--pf-border); border-radius: 8px; box-shadow: 0 8px 24px rgba(20,23,24,.18); font-size: 13px; }
#pop.open { display: flex; }
.pop-head { display: flex; gap: 8px; align-items: flex-start; }
.pop-head > div { flex: 1 1 auto; min-width: 0; }
.pop-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, .8fr) minmax(0, .9fr); gap: 4px 8px; align-items: center; padding-top: 6px; border-top: 1px solid var(--pf-border); }
.pop-item { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0; border-top: 1px solid var(--pf-border); }
.x { width: 32px; height: 32px; flex: 0 0 auto; border: 0; border-radius: 6px; background: transparent; color: var(--pf-text2); cursor: pointer; font-size: 18px; line-height: 1; }
dialog { border: 0; border-radius: 12px; padding: 20px; width: min(720px, calc(100vw - 32px)); background: var(--pf-surface); color: var(--pf-text); box-shadow: 0 12px 40px rgba(0,0,0,.25); }
dialog::backdrop { background: rgba(20,23,24,.45); }
textarea { width: 100%; min-height: 220px; font: 12px/1.45 ui-monospace, Consolas, monospace; padding: 10px; border-radius: 6px; border: 1px solid var(--pf-border-strong); background: var(--pf-page); color: var(--pf-text); }
.empty { padding: 28px; text-align: center; }
.guide summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; min-height: 32px; }
.guide summary::-webkit-details-marker { display: none; }
.guide summary::before { content: ''; width: 8px; height: 8px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(-45deg); transition: transform .15s; flex: 0 0 auto; }
.guide[open] summary::before { transform: rotate(45deg); }
ol.steps { margin: 4px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.step { display: flex; gap: 12px; padding: 12px 0; border-top: 1px solid var(--pf-border); }
.step .num { flex: 0 0 auto; width: 28px; height: 28px; border-radius: 9999px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; background: var(--pf-subtle); color: var(--pf-text2); }
.step.next .num { background: var(--pf-petrol); color: #fff; }
.step.done .num { background: var(--pf-green-tint); color: #22663b; }
.step.done .step-body > *:not(h3) { color: var(--pf-text2); }
.step-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.step-body h3 { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.step-body ol { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 3px; }
@media (max-width: 768px) { .wrap { padding: 14px 12px 32px; } h1 { font-size: 22px; } .rules-row { grid-template-columns: 1fr; } }
</style>`;

const SEAL_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="9" r="6"></circle><path d="M8.5 13.5 7 21l5-3 5 3-1.5-7.5"></path></svg>';
const CAL_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M3 10h18M8 3v4M16 3v4"></path></svg>';

function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function key(v) { return String(v == null ? '' : v).trim().toUpperCase(); }
function stripHtml(v) { const d = document.createElement('div'); d.innerHTML = String(v || ''); return (d.textContent || '').trim(); }
function statusIn(status, list) {
    if (!status || !Array.isArray(list)) return false;
    const s = String(status).toLowerCase().trim();
    return list.some(i => i && i.name && (s === String(i.name).toLowerCase().trim() || s.includes(String(i.name).toLowerCase().trim())));
}
function normTag(t) { return key(t).replace(/[^A-Z0-9]/g, '').replace(/L/g, '1').replace(/I/g, '1').replace(/O/g, '0'); }
function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
        m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
}
function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtDay(day) {
    if (!day) return '';
    const d = new Date(String(day).slice(0, 10) + 'T00:00:00');
    return isNaN(d) ? String(day) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

// Small CSV parser: quoted fields, escaped quotes, CRLF.
function parseCsv(text) {
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') q = false;
            else field += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); rows.push(row); row = []; field = '';
        } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(v => String(v).trim() !== ''));
}
function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

export class PowerFlowView extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.ui = { tab: 'diagram', section: '__all', note: '', listFilter: '' };
        this._popTimer = null;
        this._onKey = e => { if (e.key === 'Escape') this.hidePop(true); };
        this._onScroll = () => this.hidePop(true);
    }

    connectedCallback() {
        if (this._mounted) return;
        this._mounted = true;
        this.PROJECT_KEY = this.getAttribute('project') || '';
        this.USER_ROLE = this.getAttribute('role') || 'viewer';
        this.USER_EMAIL = (this.getAttribute('email') || '').toLowerCase();
        this.SCRIPT_URL = this.getAttribute('script-url') || '';
        this.PREFIX = (window.LP_CONFIG && window.LP_CONFIG.tablePrefix) || this.PROJECT_KEY;
        this.canSetup = this.USER_ROLE === 'admin';
        this._supabase = this.supabaseClient || window.launchpadSupabaseClient;
        if (localStorage.getItem('launchpad_dark_mode') === 'enabled') this.classList.add('dark-mode');
        this.shadowRoot.innerHTML = STYLE + '<div class="wrap" id="root"><div class="empty muted">Loading power flow…</div></div><div id="pop" role="dialog" aria-live="polite"></div><dialog id="dlg"></dialog><input type="file" id="file" accept=".csv,.json,text/csv,application/json" hidden>';
        this._wire();
        document.addEventListener('keydown', this._onKey);
        this.addEventListener('scroll', this._onScroll, { passive: true });
        this.load();
    }

    disconnectedCallback() {
        document.removeEventListener('keydown', this._onKey);
        this.removeEventListener('scroll', this._onScroll);
        clearTimeout(this._popTimer);
    }

    setDarkMode(isDark) { this.classList.toggle('dark-mode', !!isDark); }

    // The shell's Settings gear: jump to the rules on Match-up.
    // The admin settings live on Match-up: the setup guide first, then the
    // rules.
    openSettings() {
        this.ui.tab = 'matchup';
        this.render();
        this.scrollToId(this.canSetup ? 'guide' : 'rules');
    }
    scrollToId(id) {
        const el = this.$(id);
        if (!el) return;
        if (el.tagName === 'DETAILS') el.open = true;
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    $(id) { return this.shadowRoot.getElementById(id); }
    T(name) { return `${this.PREFIX}${name}`; }

    // ---------- Loading ----------

    async load() {
        const sb = this._supabase;
        this.err = null;
        if (!sb) { this.err = 'LaunchPad is not signed in.'; this.render(); return; }
        const [imp, log, trk, trkCfg, sealCfg, lp] = await Promise.allSettled([
            sb.from('launchpad_powerflow_imports').select('id, file_name, row_count, rows, imported_by, created_at').eq('project_key', this.PROJECT_KEY).order('created_at', { ascending: false }).limit(1),
            sb.from('launchpad_powerflow_log').select('id, kind, subject, value, detail, reason, created_by, created_at').eq('project_key', this.PROJECT_KEY).order('created_at', { ascending: false }).limit(5000),
            sb.from('launchpad_equipment_tracker_data').select('data').eq('project_key', this.PROJECT_KEY).maybeSingle(),
            sb.from('launchpad_equipment_tracker_config').select('config').eq('project_key', this.PROJECT_KEY).maybeSingle(),
            sb.from('launchpad_tamperseal_config').select('config').eq('project_key', this.PROJECT_KEY).maybeSingle(),
            this.fetchLpStatus()
        ]);

        const val = r => (r.status === 'fulfilled' ? r.value : { error: r.reason });
        const impR = val(imp), logR = val(log);
        if ((impR.error && /does not exist|42P01|schema cache/i.test(JSON.stringify(impR.error))) || (logR.error && /does not exist|42P01|schema cache/i.test(JSON.stringify(logR.error)))) {
            this.needsSql = true;
        } else if (impR.error || logR.error) {
            console.error('Power flow load failed', impR.error || logR.error);
            this.err = 'Could not load the power flow data. Try Refresh.';
        }
        this.imp = (impR.data && impR.data[0]) || null;
        this.log = logR.data || [];

        // Asset list + CHK/ISS rows from the Equipment Tracker sync.
        const trkR = val(trk);
        const rows = (trkR.data && Array.isArray(trkR.data.data)) ? trkR.data.data : [];
        this.assets = new Map();
        rows.forEach(r => { const name = String(r.Asset || r['Asset Name'] || '').trim(); if (name) this.assets.set(key(name), { name, area: r.Area || '', row: r }); });
        if (!this.assets.size) await this.loadDropdownAssets();
        const cfg = (val(trkCfg).data && val(trkCfg).data.config) || {};
        this.trkCfg = {
            closed: cfg.closedStatuses || [], cxComplete: cfg.cxCompleteStatuses || [],
            testClosed: cfg.testClosedStatuses || [], issueClosed: cfg.issueClosedStatuses || []
        };

        // Seal workflow statuses (all workflows, de-duplicated).
        const sc = (val(sealCfg).data && val(sealCfg).data.config) || {};
        const names = [];
        (Array.isArray(sc.workflows) ? sc.workflows : []).forEach(w => (w.statuses || []).forEach(s => { if (s && s.name && !names.includes(s.name)) names.push(s.name); }));
        this.sealStatuses = names.length ? names : ['Intact', 'Break Requested (Pending Approval)', 'Break Approved by CCM', 'Broken - CCM Approved', 'Ready for Reseal', 'Replaced (Approved)', 'Non-Approved Break', 'Replaced (Non-Approved)'];

        const lpR = val(lp);
        this.lp = lpR.map || new Map();
        this.lpState = lpR.state || 'error';

        this.buildModel();
        await this.loadLiveData();
        this.loaded = true;
        this.render();
    }

    async loadDropdownAssets() {
        try {
            const { data } = await this._supabase.from(this.T('dropdownoptions')).select('Assets, Places');
            (data || []).forEach(r => { const name = String(r.Assets || '').trim(); if (name && !this.assets.has(key(name))) this.assets.set(key(name), { name, area: r.Places || '', row: null }); });
        } catch (e) { /* no fallback list */ }
    }

    async fetchLpStatus() {
        if (!this.SCRIPT_URL) return { state: 'noscript', map: new Map() };
        try {
            const res = await fetch(`${this.SCRIPT_URL}?action=getLpStatus`);
            const json = await res.json();
            if (!json || !Array.isArray(json.rows)) return { state: 'missing', map: new Map() };
            const map = new Map();
            json.rows.forEach(r => {
                const m = /([234])/.exec(String(r.phase || ''));
                if (!m) return;
                const k = key(r.asset);
                if (!map.has(k)) map.set(k, {});
                map.get(k)['L' + m[1]] = String(r.status || '');
            });
            return { state: 'ok', map };
        } catch (e) {
            console.warn('getLpStatus is not available on this project\'s Apps Script yet.', e);
            return { state: 'missing', map: new Map() };
        }
    }

    // Seals and schedule for the matched assets only.
    async loadLiveData() {
        this.seals = new Map(); this.sched = new Map();
        const names = [...new Set(this.nodes.filter(n => n.assetName).map(n => n.assetName))];
        if (!names.length) return;
        const chunks = [];
        for (let i = 0; i < names.length; i += 100) chunks.push(names.slice(i, i + 100));
        const sb = this._supabase;
        await Promise.all(chunks.map(async c => {
            try {
                const { data, error } = await sb.from(`${this.PROJECT_KEY}Assets`).select('id, asset_name, seal_number, status, inspection_date, signoff, inspection_notes, break_date, break_reason, responsible_party').in('asset_name', c);
                if (error) throw error;
                (data || []).forEach(s => { const k = key(s.asset_name); if (!this.seals.has(k)) this.seals.set(k, []); this.seals.get(k).push(s); });
            } catch (e) { this.sealErr = true; }
            try {
                const { data, error } = await sb.from(this.T('BackEndData')).select('*').in('asset', c);
                if (error) throw error;
                (data || []).forEach(r => {
                    if (r.draft_deleted || r.superseded_by) return;
                    const k = key(r.asset);
                    if (!this.sched.has(k)) this.sched.set(k, []);
                    this.sched.get(k).push(r);
                });
            } catch (e) { this.schedErr = true; }
        }));
        this.sched.forEach(list => list.sort((a, b) => String(a.day_label).localeCompare(String(b.day_label)) || String(a.time || '').localeCompare(String(b.time || ''))));
    }

    // ---------- Rules and decisions (newest log row wins) ----------

    latest(kind, subject) {
        if (!this._idx || this._idxFor !== this.log) {
            this._idx = new Map();
            this.log.forEach(l => { const k = l.kind + '|' + l.subject; if (!this._idx.has(k)) this._idx.set(k, l); }); // log is newest first
            this._idxFor = this.log;
        }
        return this._idx.get(kind + '|' + subject) || null;
    }
    edgeRules() {
        const saved = (this.latest('rule', 'edgeRules') || {}).value || {};
        const out = {};
        EDGE_RULES.forEach(r => { out[r.key] = r.actions.includes(saved[r.key]) ? saved[r.key] : r.def; });
        out.custom = Array.isArray(saved.custom) ? saved.custom : [];
        return out;
    }
    sealRule() {
        const saved = (this.latest('rule', 'sealRule') || {}).value;
        if (saved && Array.isArray(saved.statuses) && Array.isArray(saved.levels)) return saved;
        return {
            statuses: [NO_SEAL, ...this.sealStatuses.filter(s => !/intact|replaced/i.test(s))],
            levels: ['l3', 'l4', 'qcx']
        };
    }
    statusMap() {
        const saved = (this.latest('rule', 'statusMap') || {}).value || {};
        const out = {};
        Object.keys(DEFAULT_STATUS_MAP).forEach(k => { out[k] = Object.assign({}, DEFAULT_STATUS_MAP[k], saved[k] || {}); });
        return out;
    }

    // Reads the newest import and works out every tag's edge case and
    // current decision.
    buildModel() {
        const rules = this.edgeRules();
        const rows = (this.imp && Array.isArray(this.imp.rows)) ? this.imp.rows : [];
        const byTag = new Map();
        rows.forEach(r => {
            const k = key(r.asset_tag);
            if (!k) return;
            if (!byTag.has(k)) byTag.set(k, Object.assign({}, r, { sheets: [] }));
            const t = byTag.get(k);
            if (r.sheet && !t.sheets.includes(r.sheet)) t.sheets.push(r.sheet);
            TEMPLATE_COLUMNS.forEach(c => { if (!t[c] && r[c]) t[c] = r[c]; });
        });
        const normIndex = new Map();
        this.assets.forEach((a, k) => { const n = normTag(k); if (n && !normIndex.has(n)) normIndex.set(n, a.name); });

        const tags = [];
        byTag.forEach((r, k) => {
            const text = [r.asset_tag, r.type, r.description].join(' ');
            const exact = this.assets.get(k);
            let edge = null, suggest = '', hint = '';
            const custom = rules.custom.find(c => c.pattern && text.toUpperCase().includes(String(c.pattern).toUpperCase()));
            if (custom) { edge = 'custom'; hint = `Custom rule: ${custom.name || custom.pattern}`; }
            else if (k.includes('?')) { edge = 'unreadable'; hint = 'Part of the tag could not be read'; }
            else if (/\b(SPARE|SPACE)\b/i.test(text)) { edge = 'spare'; hint = 'Marked spare or space'; }
            else if (/by others|\bNIC\b/i.test(r.spa_scope || '') || /by others/i.test(r.description || '')) { edge = 'others'; hint = 'Scope: ' + (r.spa_scope || 'by others'); suggest = exact ? exact.name : ''; }
            else if (/\bOFE\b|owner furnished/i.test(r.spa_scope || '')) { edge = 'ofe'; hint = 'Marked owner furnished'; suggest = exact ? exact.name : ''; }
            else if (exact) { edge = 'exact'; suggest = exact.name; }
            else if (r.parent_tag && (this.assets.has(key(r.parent_tag)) || byTag.has(key(r.parent_tag)))) {
                edge = 'sub'; suggest = (this.assets.get(key(r.parent_tag)) || {}).name || r.parent_tag; hint = 'Component inside ' + r.parent_tag;
            } else {
                const n = normTag(k);
                let best = normIndex.get(n) || '';
                if (!best && k.length >= 4) {
                    let bestD = 3;
                    this.assets.forEach((a, ak) => {
                        if (ak[0] !== k[0] || Math.abs(ak.length - k.length) > 2) return;
                        const d = lev(k, ak); if (d < bestD) { bestD = d; best = a.name; }
                    });
                }
                if (best) { edge = 'fuzzy'; suggest = best; hint = 'Close to ' + best; }
                else { edge = 'notInList'; hint = 'No asset with this tag'; }
            }
            const ruleAction = edge === 'custom' ? custom.action : (edge === 'exact' ? 'accept' : rules[edge]);
            tags.push({ k, row: r, edge, suggest, hint, ruleAction, decision: this.decide(k, edge, ruleAction, suggest, r) });
        });
        this.tags = tags;

        // Assets in the list but on no drawing.
        const used = new Set();
        // An asset that's only suggested for a tag still waiting on a
        // decision isn't "not on any drawing" either.
        tags.forEach(t => {
            if (t.decision.asset) used.add(key(t.decision.asset));
            if (t.decision.kind === 'pending' && t.suggest) used.add(key(t.suggest));
        });
        this.offDrawing = [];
        if (this.imp) {
            this.assets.forEach((a, k) => {
                if (used.has(k)) return;
                const subj = 'list:' + k;
                const d = this.latest('decision', subj);
                const kind = (d && d.value && d.value.kind && d.value.kind !== 'reset') ? d.value.kind : (rules.notOnDrawing === 'offpath' ? 'offpath' : 'pending');
                this.offDrawing.push({ k, subj, name: a.name, area: a.area, kind, auto: !(d && d.value && d.value.kind !== 'reset'), logged: d });
            });
            this.offDrawing.sort((a, b) => a.name.localeCompare(b.name));
        }

        // Diagram nodes.
        const lookupTag = new Map(tags.map(t => [t.k, t]));
        this.nodes = tags.filter(t => ['matched', 'attached', 'track', 'drawingOnly', 'pending'].includes(t.decision.kind)).map(t => {
            let assetName = t.decision.kind === 'matched' || t.decision.kind === 'track' ? t.decision.asset : '';
            let parentKey = '';
            if (t.decision.kind === 'attached') {
                parentKey = key(t.decision.asset);
                const pt = lookupTag.get(parentKey);
                assetName = pt && pt.decision.asset ? pt.decision.asset : ((this.assets.get(parentKey) || {}).name || '');
            }
            return { t, tag: t.row.asset_tag, k: t.k, section: String(t.row.section || '').trim() || 'No section', fed: t.row.fed_from_tag || '', type: t.row.type || '', description: t.row.description || '', spa: t.row.spa_scope || '', assetName, parentKey, kind: t.decision.kind };
        });
    }

    decide(k, edge, ruleAction, suggest, row) {
        const d = this.latest('decision', 'tag:' + k);
        if (d && d.value && d.value.kind && d.value.kind !== 'reset') return Object.assign({ auto: false, logged: d }, d.value);
        const auto = { auto: true };
        switch (ruleAction) {
            case 'accept': return suggest ? Object.assign(auto, { kind: 'matched', asset: suggest }) : Object.assign(auto, { kind: 'pending' });
            case 'attach': return Object.assign(auto, { kind: 'attached', asset: row.parent_tag });
            case 'track': return Object.assign(auto, { kind: 'track', asset: suggest || '' });
            case 'ignore': return Object.assign(auto, { kind: 'ignored' });
            case 'keep': return Object.assign(auto, { kind: 'drawingOnly' });
            default: return Object.assign(auto, { kind: 'pending' });
        }
    }

    // ---------- Live status for one asset ----------

    levelOf(node) {
        if (node.kind === 'pending') return 'pending';
        if (node.kind === 'track') return 'track';
        if (!node.assetName) return 'designed';
        const lp = this.lp.get(key(node.assetName)) || {};
        const map = this.statusMap();
        for (const lvl of ['qcx', 'l4', 'l3', 'l2']) {
            const rule = map[lvl];
            const s = String(lp[rule.level] || '').toLowerCase();
            if (!s || /\bnot\b/.test(s)) continue;
            const words = String(rule.words || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
            if (words.some(w => s.includes(w))) return lvl;
        }
        return 'designed';
    }
    // A component attached to a parent shares the parent's asset, so its
    // seals and schedule show on the parent only.
    sealsOf(node) { return node.assetName && node.kind !== 'attached' ? (this.seals.get(key(node.assetName)) || []) : []; }
    sealRequired(node, level) {
        if (!node.assetName || node.kind === 'track' || node.kind === 'attached') return false;
        const rule = this.sealRule();
        if (!rule.levels.includes(level)) return false;
        const seals = this.sealsOf(node);
        if (!seals.length) return rule.statuses.includes(NO_SEAL);
        return seals.some(s => rule.statuses.includes(s.status));
    }
    schedOf(node) { return node.assetName && node.kind !== 'attached' ? (this.sched.get(key(node.assetName)) || []) : []; }
    cxRows(node) {
        const a = node.assetName ? this.assets.get(key(node.assetName)) : null;
        const row = a && a.row;
        const lp = node.assetName ? (this.lp.get(key(node.assetName)) || {}) : {};
        const out = [];
        ['L2', 'L3', 'L4'].forEach(L => {
            let tot = 0, done = 0;
            if (row) Object.keys(row).forEach(c => {
                if (!c.startsWith(L + ' ') || !/ CL \d+$/.test(c)) return;
                const v = String(row[c] == null ? '' : row[c]).trim();
                if (!v || /^(n\/a|clear|-|no cl|unknown)$/i.test(v)) return;
                tot++;
                const m = /\((.+)\)\s*$/.exec(v);
                const st = m ? m[1] : '';
                const closed = L === 'L4' ? (statusIn(st, this.trkCfg.testClosed) || statusIn(st, this.trkCfg.closed)) : (statusIn(st, this.trkCfg.closed) || statusIn(st, this.trkCfg.cxComplete));
                if (closed || (!this.trkCfg.closed.length && /closed|complete/i.test(st))) done++;
            });
            out.push({ level: L, lp: lp[L] || '', chk: tot ? `${done}/${tot}` : '—', state: !tot ? 'none' : (done === tot ? 'done' : (done ? 'active' : 'todo')) });
        });
        let iTot = 0, iOpen = 0;
        if (row) Object.keys(row).forEach(c => {
            if (!/^Issue \d+$/.test(c)) return;
            const v = String(row[c] == null ? '' : row[c]).trim();
            if (!v || /^(n\/a|clear|-)$/i.test(v)) return;
            iTot++;
            const m = /\((.+)\)\s*$/.exec(v);
            const closed = m && (statusIn(m[1], this.trkCfg.issueClosed) || (!this.trkCfg.issueClosed.length && /closed|complete/i.test(m[1])));
            if (!closed) iOpen++;
        });
        return { rows: out, iss: iTot ? `${iOpen} open of ${iTot}` : 'None', hasTracker: !!row };
    }

    // ---------- Rendering ----------

    render() {
        const root = this.$('root');
        if (!root) return;
        this.hidePop(true);
        if (this.needsSql) {
            root.innerHTML = `${this.headerHtml(false)}<div class="card"><h2>One-time setup needed</h2><p>Run <b>sync/power_flow.sql</b> in Supabase to create the power flow tables, then press Refresh.</p></div>${this.canSetup ? this.guideHtml() : ''}`;
            return;
        }
        if (this.err) { root.innerHTML = `${this.headerHtml(false)}<div class="note err">${esc(this.err)}</div>`; return; }
        if (!this.loaded) return;
        const tabs = [['diagram', 'Asset diagram'], ['matchup', 'Match-up'], ['sheets', 'Single lines']];
        let body = '';
        if (this.ui.tab === 'diagram') body = this.diagramHtml();
        else if (this.ui.tab === 'matchup') body = this.matchupHtml();
        else body = `<div class="card empty"><h2>Single-line sheets are coming next</h2><p class="muted">Phase 2 adds each single-line sheet with its assets outlined in their status colours. For now, the Asset diagram shows the same assets, grouped by section.</p></div>`;
        root.innerHTML = `${this.headerHtml(true)}
<div class="tabs" role="tablist" aria-label="Power flow views">${tabs.map(([id, label]) => `<button type="button" class="tab" role="tab" aria-selected="${this.ui.tab === id}" data-act="tab" data-v="${id}">${label}</button>`).join('')}</div>
${this.bannersHtml()}
${body}`;
    }

    headerHtml(full) {
        const imp = this.imp;
        return `<div class="head"><div><div class="eyebrow">${esc(this.PROJECT_KEY)} · ${imp ? 'Imported ' + esc(fmtDate(imp.created_at)) + ' · ' + esc(imp.file_name || 'power-flow file') : 'No power-flow file yet'}</div><h1>Power flow diagram</h1></div>
<div class="row">
<button type="button" class="btn" data-act="refresh">Refresh</button>
${full && this.canSetup ? `<button type="button" class="btn" data-act="openGuide">Setup guide</button>` : ''}
${full ? `<button type="button" class="btn" data-act="template">Template &amp; AI prompt</button>` : ''}
${full && this.canSetup ? `<button type="button" class="btn primary" data-act="import">Import power-flow file</button>` : ''}
</div></div>`;
    }

    bannersHtml() {
        const out = [];
        if (this.lpState === 'missing' || this.lpState === 'noscript') out.push(`<div class="note warn">LP Status isn't available yet, so every matched asset shows as Designed. Deploy the latest Apps Script (it adds <b>getLpStatus</b>) to this project's Sheet.</div>`);
        if (this.sealErr) out.push('<div class="note warn">Tamper seals could not be loaded.</div>');
        if (this.schedErr) out.push('<div class="note warn">Scheduled activities could not be loaded.</div>');
        return out.join('');
    }

    diagramHtml() {
        if (!this.imp) {
            return `<div class="card empty"><h2>No power-flow file imported yet</h2><p class="muted">Turn the single-line drawings into a power-flow file with the template and AI prompt, then ${this.canSetup ? 'import it here' : 'ask a project admin to import it'}. The diagram fills in from LaunchPad's live status, seals and schedule.</p></div>`;
        }
        const sections = [...new Set(this.nodes.map(n => n.section))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (this.ui.section !== '__all' && !sections.includes(this.ui.section)) this.ui.section = '__all';
        const shown = this.nodes.filter(n => this.ui.section === '__all' || n.section === this.ui.section);
        const counts = { designed: 0, l2: 0, l3: 0, l4: 0, qcx: 0, seal: 0 };
        const levelBy = new Map();
        shown.forEach(n => { const l = this.levelOf(n); levelBy.set(n, l); if (counts[l] !== undefined) counts[l]++; if (this.sealRequired(n, l)) counts.seal++; });
        const pending = this.tags.filter(t => t.decision.kind === 'pending').length;
        const tagSet = new Set(shown.map(n => n.k));
        const childrenOf = new Map();
        shown.forEach(n => { if (n.parentKey && tagSet.has(n.parentKey)) { if (!childrenOf.has(n.parentKey)) childrenOf.set(n.parentKey, []); childrenOf.get(n.parentKey).push(n); } });

        const nodeHtml = n => {
            const l = levelBy.get(n) || this.levelOf(n);
            const seals = this.sealsOf(n);
            const req = this.sealRequired(n, l);
            const sched = this.schedOf(n);
            const kids = childrenOf.get(n.k) || [];
            const sub = n.kind === 'drawingOnly' ? 'Drawing only · not in asset list' : (n.kind === 'pending' ? 'Not matched yet' : LEVELS[l].label);
            const named = n.assetName && key(n.assetName) !== n.k ? ` · ${esc(n.assetName)}` : '';
            return `<div><div class="asset s-${l}">
<button type="button" class="main" data-pop="comm" data-k="${esc(n.k)}" aria-label="${esc(n.tag)}, ${esc(sub)}. Show commissioning status"><span class="tag">${esc(n.tag)}</span>${named}<br><span class="st st-${l}">${esc(sub)}</span>${n.fed ? `<br><span class="fed">Fed from ${esc(n.fed)}</span>` : ''}</button>
${req || seals.length ? `<button type="button" class="ico seal${req ? '' : ' ok'}" data-pop="seal" data-k="${esc(n.k)}" aria-label="${req ? 'Tamper seal required. ' : ''}Tamper seal log for ${esc(n.tag)}">${SEAL_SVG}</button>` : ''}
${sched.length ? `<button type="button" class="ico cal" data-pop="cal" data-k="${esc(n.k)}" aria-label="Scheduled activities for ${esc(n.tag)}">${CAL_SVG}</button>` : ''}
</div>${kids.length ? `<div class="kids">${kids.map(nodeHtml).join('')}</div>` : ''}</div>`;
        };

        const cards = sections.filter(s => this.ui.section === '__all' || s === this.ui.section).map(s => {
            const list = shown.filter(n => n.section === s && !(n.parentKey && tagSet.has(n.parentKey)));
            const total = shown.filter(n => n.section === s).length;
            return `<section class="card" aria-label="${esc(s)}"><div class="sec-head"><h2>${esc(s)}</h2><span class="small muted">${total} asset${total === 1 ? '' : 's'}</span></div>${list.map(nodeHtml).join('')}</section>`;
        }).join('');

        const offList = this.offDrawing.filter(o => o.kind === 'pending');
        const offCard = offList.length ? `<section class="card dashed"><div class="sec-head"><h2>Not on any drawing</h2><span class="small muted">${offList.length} asset${offList.length === 1 ? '' : 's'}</span></div>
<p class="muted small">In the LaunchPad asset list but not in the power-flow file. Match them or mark them off the power path in Match-up.</p>
${offList.slice(0, 12).map(o => `<div class="pop-item"><span><b>${esc(o.name)}</b>${o.area ? ' · ' + esc(o.area) : ''}</span><span class="badge b-draft">Unmatched</span></div>`).join('')}
${offList.length > 12 ? `<p class="small muted">and ${offList.length - 12} more</p>` : ''}
<button type="button" class="linkbtn" data-act="tab" data-v="matchup">Go to Match-up</button></section>` : '';

        return `<div class="row" style="justify-content: space-between">
<div class="seg" role="group" aria-label="Section"><button type="button" aria-pressed="${this.ui.section === '__all'}" data-act="section" data-v="__all">Whole site</button>${sections.map(s => `<button type="button" aria-pressed="${this.ui.section === s}" data-act="section" data-v="${esc(s)}">${esc(s)}</button>`).join('')}</div>
${pending ? `<button type="button" class="linkbtn" data-act="tab" data-v="matchup">${pending} tag${pending === 1 ? '' : 's'} still need a decision</button>` : ''}
</div>
<div class="legend" aria-label="Legend">
<span><i class="sw s-designed"></i>Designed · ${counts.designed}</span><span><i class="sw s-l2"></i>Level 2 ready · ${counts.l2}</span><span><i class="sw s-l3"></i>Energization / Level 3 ready · ${counts.l3}</span><span><i class="sw s-l4"></i>Level 4 ready · ${counts.l4}</span><span><i class="sw s-qcx"></i>QCx complete · ${counts.qcx}</span>
<span style="color:#a32a2a;font-weight:600">${SEAL_SVG}Tamper seal required · ${counts.seal}</span>
</div>
<p class="small muted">Hover or focus an asset for its commissioning status, the calendar for its scheduled activities, and the seal for its tamper seal log. Location groups come from the power-flow file's section column.</p>
<div class="grid">${cards}${offCard}</div>`;
    }

    matchupHtml() {
        if (!this.imp) {
            return `${this.canSetup ? this.guideHtml() : ''}<div class="card empty"><h2>Nothing to match yet</h2><p class="muted">Import a power-flow file first. Exact tag matches are accepted automatically; everything else shows up here for a decision.</p></div>${this.canSetup ? this.rulesHtml() : ''}${this.logHtml()}`;
        }
        const tags = this.tags;
        const review = tags.filter(t => t.edge !== 'exact' || !t.decision.auto);
        const matched = tags.filter(t => ['matched', 'attached'].includes(t.decision.kind)).length;
        const pending = tags.filter(t => t.decision.kind === 'pending').length;
        const excluded = tags.filter(t => ['ignored', 'track'].includes(t.decision.kind)).length;
        const exactAuto = tags.filter(t => t.edge === 'exact' && t.decision.auto).length;
        const canAct = this.canSetup;
        const opts = [...this.assets.values()].map(a => a.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        const optHtml = `<option value="">Choose asset…</option>` + opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
        const ruleName = e => e === 'custom' ? 'Custom rule' : (EDGE_RULES.find(r => r.key === e) || {}).name || 'Exact tag';

        const rowHtml = t => {
            const d = t.decision;
            const [blabel, bcls] = DECISION_BADGES[d.kind] || DECISION_BADGES.pending;
            const acts = [];
            if (canAct) {
                if (t.suggest && d.kind !== 'matched') acts.push(['matched', 'Accept ' + t.suggest, t.suggest, true]);
                if (t.row.parent_tag && d.kind !== 'attached') acts.push(['attached', 'Attach to ' + t.row.parent_tag, t.row.parent_tag, !t.suggest]);
                if (!t.suggest && d.kind !== 'drawingOnly') acts.push(['drawingOnly', 'Keep as drawing-only', '', false]);
                if (d.kind !== 'track') acts.push(['track', 'Track only, no Cx', t.suggest || '', false]);
                if (d.kind !== 'ignored') acts.push(['ignored', 'Ignore', '', false]);
            }
            return `<tr class="${d.kind === 'pending' ? '' : 'done'}">
<td><b>${esc(t.row.asset_tag)}</b><br><span class="small muted">${t.row.sheets && t.row.sheets.length ? 'Sheet ' + esc(t.row.sheets.join(', ')) : ''}${t.row.section ? ' · ' + esc(t.row.section) : ''}</span></td>
<td>${esc(t.row.type || '')}${t.row.description ? `<br><span class="small muted">${esc(t.row.description)}</span>` : ''}</td>
<td><b>${esc(ruleName(t.edge))}</b><br><span class="small muted">${esc(t.hint)}</span></td>
<td>${t.suggest ? `<span class="small">Suggested: <b>${esc(t.suggest)}</b></span>` : ''}
${canAct ? `<div class="acts">${acts.map(([kind, label, asset, primary]) => `<button type="button" class="btn sm${primary ? ' primary' : ''}" data-act="decide" data-k="${esc(t.k)}" data-kind="${kind}" data-asset="${esc(asset)}">${esc(label)}</button>`).join('')}
<label class="small muted" style="display:inline-flex;gap:6px;align-items:center;font-weight:600">or match to <select data-act="pick" data-k="${esc(t.k)}" aria-label="Match ${esc(t.row.asset_tag)} to an asset">${optHtml}</select></label></div>` : ''}</td>
<td><span class="badge ${bcls}">${esc(blabel)}</span>${d.asset ? `<br><span class="small muted">→ ${esc(d.asset)}</span>` : ''}<br><span class="small muted">${d.auto ? 'By rule' : 'By ' + esc((d.logged && d.logged.created_by) || '')}</span>
${canAct && !d.auto ? `<br><button type="button" class="linkbtn" data-act="undo" data-subj="tag:${esc(t.k)}" data-label="${esc(t.row.asset_tag)}">Undo</button>` : ''}</td></tr>`;
        };

        const offPending = this.offDrawing.filter(o => o.kind === 'pending');
        const f = this.ui.listFilter.toLowerCase();
        const offShown = this.offDrawing.filter(o => !f || o.name.toLowerCase().includes(f) || String(o.area).toLowerCase().includes(f));
        return `${this.canSetup ? this.guideHtml() : ''}<div class="row" style="justify-content: space-between">
<div class="row"><span class="badge b-success">${matched} matched</span><span class="badge b-progress">${pending} need a decision</span><span class="badge b-closed">${excluded} ignored or track only</span></div>
<span class="small muted">${exactAuto} exact tag match${exactAuto === 1 ? ' was' : 'es were'} accepted automatically.</span></div>
${canAct ? `<label class="field">Reason for your next change (saved to the log)<input type="text" id="note" value="${esc(this.ui.note)}" placeholder="e.g. per RFI-112, confirmed with EOR"></label>` : '<p class="small muted">Only project admins can make Match-up decisions.</p>'}
<section class="card" id="tags"><div class="sec-head"><h2>Drawing tags</h2><span class="small muted">Edge cases and anything decided by hand. Exact matches are in the log.</span></div>
${review.length ? `<div class="scroll-x"><table><thead><tr><th style="width:170px">Drawing tag</th><th style="width:170px">What it is</th><th style="width:200px">Edge case</th><th>Match or action</th><th style="width:150px">Decision</th></tr></thead><tbody>${review.map(rowHtml).join('')}</tbody></table></div>` : '<p class="muted">Every tag matched the asset list exactly.</p>'}
</section>
<section class="card" id="offlist"><div class="sec-head"><h2>In the asset list, not on any drawing</h2><span class="small muted">${offPending.length} of ${this.offDrawing.length} need a decision</span></div>
<div class="row"><input type="search" id="listFilter" placeholder="Filter by asset or area" value="${esc(this.ui.listFilter)}" aria-label="Filter assets not on any drawing">
${canAct && offPending.length ? `<button type="button" class="btn sm" data-act="offall">Mark ${offShown.filter(o => o.kind === 'pending').length} shown as off power path</button>` : ''}</div>
<div class="scroll-x" style="max-height:420px;overflow-y:auto"><table style="min-width:560px"><tbody>${offShown.slice(0, 400).map(o => `<tr class="${o.kind === 'pending' ? '' : 'done'}"><td><b>${esc(o.name)}</b>${o.area ? `<br><span class="small muted">${esc(o.area)}</span>` : ''}</td>
<td><span class="badge ${(DECISION_BADGES[o.kind] || DECISION_BADGES.pending)[1]}">${esc((DECISION_BADGES[o.kind] || DECISION_BADGES.pending)[0])}</span></td>
<td>${canAct ? (o.kind === 'pending' ? `<button type="button" class="btn sm" data-act="offpath" data-subj="${esc(o.subj)}" data-label="${esc(o.name)}">Off power path</button>` : (!o.auto ? `<button type="button" class="linkbtn" data-act="undo" data-subj="${esc(o.subj)}" data-label="${esc(o.name)}">Undo</button>` : '')) : ''}</td></tr>`).join('')}</tbody></table></div>
${offShown.length > 400 ? `<p class="small muted">Showing 400 of ${offShown.length}. Use the filter to narrow it down.</p>` : ''}
</section>
<div class="two">${this.canSetup ? this.rulesHtml() : ''}${this.logHtml()}</div>`;
    }

    // Step-by-step setup for admins. Each step ticks itself off from the
    // module's real state, so it doubles as a checklist.
    guideHtml() {
        const tablesOk = !this.needsSql;
        const lpOk = this.lpState === 'ok';
        const hasImport = !!this.imp;
        const pendingTags = hasImport ? (this.tags || []).filter(t => t.decision.kind === 'pending').length : 0;
        const pendingOff = hasImport ? (this.offDrawing || []).filter(o => o.kind === 'pending').length : 0;
        const rulesSet = this.log.some(l => l.kind === 'rule');
        const btn = (act, label, extra) => `<button type="button" class="btn sm" data-act="${act}"${extra || ''}>${label}</button>`;
        const steps = [
            { done: tablesOk, title: 'Create the Power Flow tables (once for all projects)', body: `
<ol><li>Open the Supabase project's <b>SQL editor</b>.</li>
<li>Paste the contents of <b>sync/power_flow.sql</b> from the LaunchPad repo and run it. It's safe to run again.</li>
<li>The last result should list a read and an insert rule for each of the two power flow tables, and no update or delete rules.</li>
<li>Come back here and press <b>Refresh</b>.</li></ol>` },
            { done: lpOk, title: 'Connect LP Status from the project\'s Google Sheet', body: `
<ol><li>Open this project's Google Sheet, then <b>Extensions → Apps Script</b>.</li>
<li>Replace the script with the latest <b>MSA3A_Code_updated.gs</b> from the LaunchPad repo (it adds the <b>getLpStatus</b> action).</li>
<li><b>Deploy → Manage deployments</b>, edit the existing web app deployment, choose <b>New version</b> and <b>Deploy</b>. Keep the same deployment so the URL doesn't change.</li>
<li>Press <b>Refresh</b> here. Until this is done, every matched asset shows as Designed.</li></ol>` },
            { done: true, title: 'Turn the module on for this project', body: `
<p>Already on, since you can see it. For reference: open <b>Settings</b> (the gear in the sidebar) on the Schedule, tick <b>Navigation Menu → Power Flow</b> and save. Other people see it the next time they load LaunchPad. Untick it to hide it again; nothing is deleted.</p>` },
            { done: hasImport, title: 'Make the power-flow file from the single-line drawings', body: `
<ol><li>Get the single-line sheets as PDFs. Vector PDFs (exported from CAD, not scans) read far more accurately.</li>
<li>Download the CSV template, then open <b>See the AI prompt</b> and copy it (both buttons are below).</li>
<li>In Gemini or Claude, attach the PDFs and paste the prompt. Do a few sheets at a time for a large set.</li>
<li>Save the answer as a <b>.csv</b> file. If you did several batches, paste them into one file under a single header row.</li>
<li>Spot-check it against the drawings: tags spelled exactly as printed, <b>fed_from_tag</b> pointing at the right upstream gear, and <b>section</b> names your team recognises (they become the diagram's groups).</li></ol>
<div class="row">${btn('downloadTemplate', 'Download CSV template')}${btn('template', 'See the AI prompt')}</div>` },
            { done: hasImport, title: 'Import the file', body: `
<ol><li>Press <b>Import power-flow file</b> and choose the CSV (JSON also works).</li>
<li>Check the preview: row count, sections, and how many tags match the LaunchPad asset list exactly. Rows without an asset_tag are skipped and listed.</li>
<li>Confirm. The reason box on Match-up is saved with the import if you fill it in first.</li></ol>
${hasImport ? `<p class="small muted">Current file: ${esc(this.imp.file_name || 'power-flow file')}, imported ${esc(fmtDate(this.imp.created_at))}.</p>` : ''}
<div class="row">${btn('import', hasImport ? 'Import a newer file' : 'Import power-flow file')}</div>` },
            { done: hasImport && pendingTags === 0, title: 'Decide the drawing tags that need it', body: `
<p>Exact tag matches are accepted automatically. Everything else follows the edge case rules, or waits for you under <b>Drawing tags</b>.</p>
<ol><li>Type a reason first if there is one (e.g. an RFI number); it's saved with your next decision.</li>
<li><b>Accept</b> a suggested match, <b>Attach</b> a breaker or component to its parent, or pick the right asset from the list.</li>
<li>Use <b>Keep as drawing-only</b> for gear that isn't in the asset list, <b>Track only</b> for gear that's shown but not commissioned (by others), and <b>Ignore</b> for spares.</li>
<li>Every decision is logged and can be undone.</li></ol>
${hasImport ? `<p class="small"><b>${pendingTags}</b> tag${pendingTags === 1 ? '' : 's'} still need a decision.</p>` : ''}
<div class="row">${hasImport ? btn('scrollTo', 'Go to drawing tags', ' data-v="tags"') : ''}</div>` },
            { done: hasImport && pendingOff === 0, title: 'Review assets that aren\'t on any drawing', body: `
<p>These are in the LaunchPad asset list but not in the file. Either the drawing data is missing them (fix the file and re-import), or they aren't on the power path (mechanical equipment, for example): mark those <b>Off power path</b>. Filter by area and mark a whole group at once if it helps.</p>
${hasImport ? `<p class="small"><b>${pendingOff}</b> asset${pendingOff === 1 ? '' : 's'} still need a decision.</p>` : ''}
<div class="row">${hasImport ? btn('scrollTo', 'Go to the list', ' data-v="offlist"') : ''}</div>` },
            { done: rulesSet, optional: true, title: 'Check the rules (optional)', body: `
<ol><li><b>Edge cases:</b> choose what LaunchPad does on its own with spares, by-others gear, OFE, close tags and the rest.</li>
<li><b>Tamper seal required:</b> tick the seal statuses (from this project's Tamper Seal workflow) and the commissioning levels that should raise the red seal flag. The default flags anything at Level 3 or later without an intact or replaced seal.</li>
<li><b>Status colours:</b> make sure the words match how this project's LP_Data statuses are written (for example "Ready" or "QCx Complete").</li></ol>
<div class="row">${btn('scrollTo', 'Go to the rules', ' data-v="rules"')}</div>` },
            { info: true, title: 'Check the diagram, and keep it current', body: `
<ol><li>Open <b>Asset diagram</b>, pick a section and hover a few assets: the colours, CHK/ISS, schedule and seals should match the Equipment Tracker, Schedule and Tamper Seals.</li>
<li>When a drawing revision arrives, make a new file and import it. Decisions are kept for tags that are still there; new or changed tags come back here for review.</li>
<li>Status, checklists, seals and schedule always come live from LaunchPad, so they never need re-importing.</li></ol>
<div class="row">${btn('tab', 'Open the Asset diagram', ' data-v="diagram"')}</div>` }
        ];
        const countable = steps.filter(s => !s.info && !s.optional);
        const doneCount = countable.filter(s => s.done).length;
        const allDone = doneCount === countable.length;
        const firstOpen = steps.findIndex(s => !s.info && !s.optional && !s.done);
        return `<details class="card guide" id="guide"${allDone ? '' : ' open'}>
<summary><span><h2 style="display:inline">Setup guide</h2> <span class="small muted">· ${doneCount} of ${countable.length} steps done${allDone ? ' · all set' : ''}</span></span></summary>
<p class="small muted">Admin only. Follow these in order to set up Power Flow for this project. Steps tick themselves off as LaunchPad sees them done.</p>
<ol class="steps">${steps.map((s, i) => `<li class="step${s.done && !s.info ? ' done' : ''}${i === firstOpen ? ' next' : ''}">
<span class="num" aria-hidden="true">${s.done && !s.info ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"></path></svg>' : i + 1}</span>
<div class="step-body"><h3>${esc(s.title)} ${s.info ? '' : s.done ? '<span class="badge b-success">Done</span>' : s.optional ? '<span class="badge b-draft">Optional</span>' : (i === firstOpen ? '<span class="badge b-progress">Next</span>' : '<span class="badge b-notstarted">To do</span>')}</h3>${s.body}</div></li>`).join('')}</ol>
</details>`;
    }

    rulesHtml() {
        const rules = this.edgeRules();
        const seal = this.sealRule();
        const smap = this.statusMap();
        const sealOpts = [NO_SEAL, ...this.sealStatuses];
        return `<section class="card" id="rules"><h2>Rules</h2>
<p class="small muted">Project rules, admin only. Changes apply to every drawing tag that hasn't been decided by hand, and each change is logged.</p>
<h3>Edge cases</h3>
${EDGE_RULES.map(r => `<div class="rules-row"><span><b>${esc(r.name)}</b><br><span class="small muted">e.g. ${esc(r.example)}</span></span><span></span>
<label class="field">Then<select data-act="edgeRule" data-v="${r.key}">${r.actions.map(a => `<option value="${a}"${rules[r.key] === a ? ' selected' : ''}>${esc(RULE_ACTION_LABELS[a])}</option>`).join('')}</select></label></div>`).join('')}
${rules.custom.map((c, i) => `<div class="rules-row"><label class="field">Edge case name<input type="text" data-act="customName" data-i="${i}" value="${esc(c.name || '')}"></label>
<label class="field">When tag, type or description contains<input type="text" data-act="customPattern" data-i="${i}" value="${esc(c.pattern || '')}" placeholder="e.g. TEMP, FUTURE"></label>
<label class="field">Then<select data-act="customAction" data-i="${i}">${CUSTOM_RULE_ACTIONS.map(a => `<option value="${a}"${c.action === a ? ' selected' : ''}>${esc(RULE_ACTION_LABELS[a])}</option>`).join('')}</select></label></div>`).join('')}
<div><button type="button" class="btn sm" data-act="addRule">+ Add edge case</button></div>
<h3 style="margin-top:8px">Flag "Tamper seal required" when…</h3>
<div class="two"><fieldset class="checks" style="border:0;margin:0;padding:0"><legend class="small" style="font-weight:600;padding:0 0 4px">1. A seal on the asset is</legend>
${sealOpts.map(s => `<label><input type="checkbox" data-act="sealStatus" value="${esc(s)}"${seal.statuses.includes(s) ? ' checked' : ''}><span>${esc(s)}</span></label>`).join('')}</fieldset>
<fieldset class="checks" style="border:0;margin:0;padding:0"><legend class="small" style="font-weight:600;padding:0 0 4px">2. And the asset is at</legend>
${LEVEL_ORDER.map(l => `<label><input type="checkbox" data-act="sealLevel" value="${l}"${seal.levels.includes(l) ? ' checked' : ''}><i class="sw s-${l}"></i><span>${esc(LEVELS[l].label)}</span></label>`).join('')}</fieldset></div>
<h3 style="margin-top:8px">Status colours from LP Status</h3>
<p class="small muted">An asset takes the highest colour whose LP_Data status (for that level) contains one of the words. Statuses containing "not" never count.</p>
${['qcx', 'l4', 'l3', 'l2'].map(l => `<div class="rules-row"><span><i class="sw s-${l}"></i> <b>${esc(LEVELS[l].label)}</b></span>
<label class="field">Level<select data-act="mapLevel" data-v="${l}">${['L2', 'L3', 'L4'].map(L => `<option${smap[l].level === L ? ' selected' : ''}>${L}</option>`).join('')}</select></label>
<label class="field">Status contains (comma-separated)<input type="text" data-act="mapWords" data-v="${l}" value="${esc(smap[l].words)}"></label></div>`).join('')}
</section>`;
    }

    logHtml() {
        return `<section class="card"><div class="sec-head"><h2>Setup log</h2><button type="button" class="btn sm" data-act="exportLog"${this.log.length ? '' : ' disabled'}>Export log (CSV)</button></div>
<p class="small muted">Every import, match, edge-case decision and rule change, with who, when and why. Newest first. Undo adds an entry; nothing is deleted.</p>
<ol class="log">${this.log.slice(0, 300).map(l => `<li><span class="row" style="justify-content:space-between"><b>${esc(this.logTitle(l))}</b><span class="small muted">${esc(fmtDate(l.created_at))}</span></span>
<span>${esc(l.detail || '')}</span><span class="small muted">${esc(l.created_by || '')}${l.reason ? ' · Reason: ' + esc(l.reason) : ''}</span></li>`).join('') || '<li class="muted">Nothing logged yet.</li>'}</ol></section>`;
    }

    logTitle(l) {
        if (l.kind === 'import') return 'Power-flow file imported';
        if (l.kind === 'rule') return 'Rule changed';
        const k = l.value && l.value.kind;
        return k === 'reset' ? 'Undone' : ({ matched: 'Matched', attached: 'Attached to parent', track: 'Track only', ignored: 'Ignored', drawingOnly: 'Kept as drawing-only', offpath: 'Marked off power path' }[k] || 'Decision');
    }

    // ---------- Popovers ----------

    popHtml(kind, node) {
        const l = this.levelOf(node);
        const head = (label) => `<div class="pop-head"><div><div class="eyebrow">${label}</div><div style="font-size:16px;font-weight:600;overflow-wrap:anywhere">${esc(node.tag)}</div>
<div class="muted small">${esc([node.assetName && key(node.assetName) !== node.k ? node.assetName : '', node.type, node.spa].filter(Boolean).join(' · '))}</div></div>
<button type="button" class="x" data-act="closePop" aria-label="Close">×</button></div>`;
        const req = this.sealRequired(node, l);
        const seals = this.sealsOf(node);
        const sealLine = `<div class="pop-item" style="border:0;padding:6px 8px;border-radius:6px;${req ? 'background:#fce4e4;color:#a32a2a' : 'background:var(--pf-subtle)'}"><span>Seals: <b>${seals.length ? esc([...new Set(seals.map(s => s.status || 'No status'))].join(', ')) : 'none on record'}</b> · ${req ? 'Tamper seal required' : 'No flag'}</span>${kind !== 'seal' && (seals.length || req) ? `<button type="button" class="linkbtn" data-pop-switch="seal" data-k="${esc(node.k)}">Seal log</button>` : ''}</div>`;
        if (kind === 'comm') {
            const cx = this.cxRows(node);
            const badge = s => s === 'done' ? '<span class="badge b-success">Done</span>' : s === 'active' ? '<span class="badge b-progress">In progress</span>' : s === 'todo' ? '<span class="badge b-notstarted">Not started</span>' : '<span class="badge b-draft">No checklists</span>';
            return `${head('Commissioning status')}<span class="pill p-${l}" style="align-self:flex-start">${esc(LEVELS[l].label)}</span>
${node.kind === 'attached' ? `<div class="small muted">Part of ${esc(node.parentKey)}; shows its parent's status.</div>` : ''}
${sealLine}
${cx.hasTracker ? cx.rows.map(r => `<div class="pop-row"><div><span>${r.level}${r.lp ? ' · ' + esc(r.lp) : ''}</span><br>${badge(r.state)}</div><div style="font-weight:600">CHK ${esc(r.chk)}</div><div></div></div>`).join('') + `<div class="pop-row"><div>Issues (all levels)</div><div></div><div style="font-weight:600">ISS ${esc(cx.iss)}</div></div>`
        : `<div class="small muted">${node.assetName ? 'No Equipment Tracker row for this asset yet.' : 'Not linked to a LaunchPad asset, so there is no commissioning data.'}</div>`}`;
        }
        if (kind === 'cal') {
            const list = this.schedOf(node);
            const today = todayStr();
            const cur = list.filter(r => String(r.day_label).slice(0, 10) >= today);
            const past = list.filter(r => String(r.day_label).slice(0, 10) < today).reverse();
            const item = (r, isPast) => `<div class="pop-item"><span><b>${esc(r.activity || 'Activity')}</b><br><span class="muted small">${esc(fmtDay(r.day_label))}${r.time ? ' · ' + esc(r.time) : ''}${stripHtml(r.status) ? ' · ' + esc(stripHtml(r.status)) : ''}</span></span><span class="badge ${isPast ? 'b-draft' : 'b-progress'}">${esc(r.result || (isPast ? 'Past' : 'Scheduled'))}</span></div>`;
            return `${head('Scheduled activities')}<div class="small" style="font-weight:600">Current and upcoming · ${cur.length}</div>${cur.map(r => item(r, false)).join('') || '<div class="muted small">Nothing scheduled.</div>'}
<div class="small" style="font-weight:600;margin-top:4px">Past · ${past.length}</div>${past.slice(0, 15).map(r => item(r, true)).join('') || '<div class="muted small">No past activities.</div>'}`;
        }
        return `${head('Tamper seal log')}${sealLine}${seals.map(s => `<div class="pop-item" style="flex-direction:column;gap:2px"><span class="row" style="justify-content:space-between"><b>${esc(s.seal_number || 'No seal number')} · ${esc(s.status || 'No status')}</b><span class="muted small">${esc(fmtDay(s.inspection_date))}</span></span>
${s.break_date || s.break_reason ? `<span class="small">Broken ${esc(fmtDay(s.break_date))}${s.break_reason ? ' — ' + esc(s.break_reason) : ''}${s.responsible_party ? ' · ' + esc(s.responsible_party) : ''}</span>` : ''}
${s.inspection_notes ? `<span class="small muted">${esc(s.inspection_notes)}</span>` : ''}${s.signoff ? `<span class="small muted">Signed off: ${esc(s.signoff)}</span>` : ''}</div>`).join('') || '<div class="muted small">No seals on record for this asset.</div>'}
<div class="small muted">Open Tamper Seals in the sidebar for the full log.</div>`;
    }

    showPop(kind, k, target, pin) {
        const node = this.nodes.find(n => n.k === k);
        const pop = this.$('pop');
        if (!node || !pop) return;
        clearTimeout(this._popTimer);
        this._popPinned = !!pin;
        if (target !== pop) this._popTarget = target;
        pop.innerHTML = this.popHtml(kind, node);
        pop.setAttribute('aria-label', kind === 'comm' ? 'Commissioning status' : kind === 'cal' ? 'Scheduled activities' : 'Tamper seal log');
        pop.classList.add('open');
        // Sit beside the whole asset row, not just the icon, so the popover
        // never covers that row's other icons.
        const r = ((target.closest && target.closest('.asset')) || target).getBoundingClientRect();
        const w = pop.offsetWidth, h = pop.offsetHeight;
        let left = r.right + 10;
        if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w - 10);
        let top = Math.min(r.top, window.innerHeight - h - 8);
        pop.style.left = Math.round(left) + 'px';
        pop.style.top = Math.round(Math.max(8, top)) + 'px';
    }
    hidePop(force) {
        const pop = this.$('pop');
        if (!pop) return;
        if (force) { this._popPinned = false; pop.classList.remove('open'); return; }
        if (this._popPinned) return;
        clearTimeout(this._popTimer);
        this._popTimer = setTimeout(() => { if (!this._popPinned && !pop.matches(':hover')) pop.classList.remove('open'); }, 220);
    }

    // ---------- Events ----------

    _wire() {
        const sr = this.shadowRoot;
        sr.addEventListener('click', e => {
            const sw = e.target.closest('[data-pop-switch]');
            if (sw) { this.showPop(sw.dataset.popSwitch, sw.dataset.k, this._popTarget || this.$('pop'), true); return; }
            const p = e.target.closest('[data-pop]');
            if (p) { this.showPop(p.dataset.pop, p.dataset.k, p, true); return; }
            const a = e.target.closest('[data-act]');
            if (!a || a.tagName === 'SELECT' || a.tagName === 'INPUT') {
                if (!e.target.closest('#pop')) this.hidePop(true);
                return;
            }
            this.onAction(a.dataset.act, a);
        });
        sr.addEventListener('mouseover', e => {
            const p = e.target.closest('[data-pop]');
            if (p && !this._popPinned) { clearTimeout(this._popTimer); this._popTimer = setTimeout(() => this.showPop(p.dataset.pop, p.dataset.k, p, false), 120); }
        });
        sr.addEventListener('mouseout', e => {
            const p = e.target.closest('[data-pop], #pop');
            if (p && !(e.relatedTarget && p.contains(e.relatedTarget))) this.hidePop(false);
        });
        sr.addEventListener('focusin', e => {
            const p = e.target.closest('[data-pop]');
            if (p && !this._popPinned) this.showPop(p.dataset.pop, p.dataset.k, p, false);
        });
        sr.addEventListener('change', e => {
            const a = e.target.closest('[data-act]');
            if (a) this.onChange(a.dataset.act, a);
        });
        sr.addEventListener('input', e => {
            if (e.target.id === 'note') this.ui.note = e.target.value;
            if (e.target.id === 'listFilter') {
                this.ui.listFilter = e.target.value;
                clearTimeout(this._filterTimer);
                this._filterTimer = setTimeout(() => { const pos = e.target.selectionStart; this.render(); const el = this.$('listFilter'); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }, 250);
            }
        });
        this.$('file').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) this.readImport(f); });
    }

    onAction(act, el) {
        switch (act) {
            case 'tab': this.ui.tab = el.dataset.v; this.render(); break;
            case 'section': this.ui.section = el.dataset.v; this.render(); break;
            case 'refresh': this.loaded = false; this.needsSql = false; this.$('root').innerHTML = '<div class="empty muted">Loading power flow…</div>'; this.load(); break;
            case 'closePop': this.hidePop(true); break;
            case 'openGuide': this.openSettings(); break;
            case 'scrollTo': this.scrollToId(el.dataset.v); break;
            case 'import': this.$('file').click(); break;
            case 'template': this.showTemplate(); break;
            case 'dlgClose': this.$('dlg').close(); break;
            case 'downloadTemplate': this.download('power-flow-template.csv', TEMPLATE_CSV, 'text/csv'); break;
            case 'copyPrompt': navigator.clipboard.writeText(AI_PROMPT).then(() => { el.textContent = 'Copied'; }).catch(() => { const t = this.$('promptText'); if (t) { t.select(); } }); break;
            case 'confirmImport': this.saveImport(el); break;
            case 'decide': {
                const t = this.tags.find(x => x.k === el.dataset.k);
                if (!t) return;
                this.logDecision('tag:' + t.k, { kind: el.dataset.kind, asset: el.dataset.asset || '' }, `${t.row.asset_tag}${el.dataset.asset ? ' → ' + el.dataset.asset : ''} (${(EDGE_RULES.find(r => r.key === t.edge) || { name: t.edge === 'exact' ? 'exact tag' : 'custom rule' }).name.toLowerCase()})`);
                break;
            }
            case 'undo': this.logDecision(el.dataset.subj, { kind: 'reset' }, `${el.dataset.label} back to its rule`); break;
            case 'offpath': this.logDecision(el.dataset.subj, { kind: 'offpath' }, `${el.dataset.label}: in the asset list, not on any drawing`); break;
            case 'offall': {
                const f = this.ui.listFilter.toLowerCase();
                const list = this.offDrawing.filter(o => o.kind === 'pending' && (!f || o.name.toLowerCase().includes(f) || String(o.area).toLowerCase().includes(f)));
                if (!list.length || !confirm(`Mark ${list.length} asset${list.length === 1 ? '' : 's'} as off the power path? Each one is logged and can be undone.`)) return;
                this.insertLog(list.map(o => ({ kind: 'decision', subject: o.subj, value: { kind: 'offpath' }, detail: `${o.name}: in the asset list, not on any drawing` })));
                break;
            }
            case 'addRule': {
                const r = this.edgeRules();
                const custom = r.custom.concat([{ name: 'New edge case', pattern: '', action: 'review' }]);
                this.saveEdgeRules(Object.assign({}, r, { custom }), 'Custom edge case added, set to "Send to review"');
                break;
            }
            case 'exportLog': {
                const head = ['when', 'what', 'detail', 'who', 'reason'];
                const csv = [head.join(',')].concat(this.log.map(l => [l.created_at, this.logTitle(l), l.detail, l.created_by, l.reason].map(csvCell).join(','))).join('\n');
                this.download(`power-flow-log-${this.PROJECT_KEY}.csv`, csv, 'text/csv');
                break;
            }
        }
    }

    onChange(act, el) {
        if (act === 'pick') {
            const t = this.tags.find(x => x.k === el.dataset.k);
            if (t && el.value) this.logDecision('tag:' + t.k, { kind: 'matched', asset: el.value }, `${t.row.asset_tag} → ${el.value} (picked by hand)`);
            return;
        }
        if (act === 'edgeRule') {
            const r = this.edgeRules();
            const def = EDGE_RULES.find(x => x.key === el.dataset.v);
            const before = r[def.key];
            r[def.key] = el.value;
            this.saveEdgeRules(r, `${def.name}: ${RULE_ACTION_LABELS[before]} → ${RULE_ACTION_LABELS[el.value]}`);
            return;
        }
        if (act === 'customName' || act === 'customPattern' || act === 'customAction') {
            const r = this.edgeRules();
            const i = Number(el.dataset.i);
            const c = Object.assign({}, r.custom[i]);
            if (act === 'customName') c.name = el.value.trim();
            if (act === 'customPattern') c.pattern = el.value.trim();
            if (act === 'customAction') c.action = el.value;
            r.custom = r.custom.slice(); r.custom[i] = c;
            this.saveEdgeRules(r, `${c.name || 'Custom edge case'}${c.pattern ? ` (contains "${c.pattern}")` : ''} → ${RULE_ACTION_LABELS[c.action]}`);
            return;
        }
        if (act === 'sealStatus' || act === 'sealLevel') {
            const rule = this.sealRule();
            const listKey = act === 'sealStatus' ? 'statuses' : 'levels';
            const set = new Set(rule[listKey]);
            if (el.checked) set.add(el.value); else set.delete(el.value);
            const next = Object.assign({}, rule, { [listKey]: [...set] });
            const label = act === 'sealLevel' ? LEVELS[el.value].label : el.value;
            this.insertLog([{ kind: 'rule', subject: 'sealRule', value: next, detail: `Tamper seal required: ${el.checked ? 'added' : 'removed'} "${label}"` }]);
            return;
        }
        if (act === 'mapLevel' || act === 'mapWords') {
            const map = this.statusMap();
            const l = el.dataset.v;
            if (act === 'mapLevel') map[l].level = el.value; else map[l].words = el.value;
            this.insertLog([{ kind: 'rule', subject: 'statusMap', value: map, detail: `${LEVELS[l].label} colour: ${map[l].level} status contains "${map[l].words}"` }]);
        }
    }

    saveEdgeRules(r, detail) {
        const value = {};
        EDGE_RULES.forEach(x => { value[x.key] = r[x.key]; });
        value.custom = r.custom;
        this.insertLog([{ kind: 'rule', subject: 'edgeRules', value, detail }]);
    }

    logDecision(subject, value, detail) {
        this.insertLog([{ kind: 'decision', subject, value, detail }]);
    }

    async insertLog(entries) {
        if (!this.canSetup) return;
        const reason = (this.ui.note || '').trim() || null;
        const rows = entries.map(e => ({ project_key: this.PROJECT_KEY, kind: e.kind, subject: e.subject, value: e.value || {}, detail: e.detail || null, reason }));
        const { data, error } = await this._supabase.from('launchpad_powerflow_log').insert(rows).select('id, kind, subject, value, detail, reason, created_by, created_at');
        if (error) { console.error('Power flow log insert failed', error); alert('Could not save that change: ' + (error.message || 'unknown error')); return; }
        this.ui.note = '';
        this.log = (data || []).slice().reverse().concat(this.log);
        this.buildModel();
        await this.loadLiveData();
        this.render();
    }

    // ---------- Import ----------

    async readImport(file) {
        let rows = [], problems = [];
        try {
            const text = await file.text();
            let raw;
            if (/\.json$/i.test(file.name) || /^\s*[\[{]/.test(text)) {
                const json = JSON.parse(text);
                raw = Array.isArray(json) ? json : (Array.isArray(json.rows) ? json.rows : []);
            } else {
                const grid = parseCsv(text);
                const head = (grid.shift() || []).map(h => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
                raw = grid.map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i]; }); return o; });
            }
            const alias = { tag: 'asset_tag', asset: 'asset_tag', fed_from: 'fed_from_tag', parent: 'parent_tag', scope: 'spa_scope' };
            raw.forEach((r, i) => {
                const o = {};
                Object.keys(r || {}).forEach(k => {
                    const nk = String(k).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
                    const col = alias[nk] || nk;
                    if (TEMPLATE_COLUMNS.includes(col)) o[col] = String(r[k] == null ? '' : r[k]).trim().slice(0, 300);
                });
                if (!o.asset_tag) { problems.push(`Row ${i + 2}: no asset_tag, skipped`); return; }
                rows.push(o);
            });
        } catch (e) {
            problems.push('Could not read the file: ' + e.message);
        }
        this._pendingImport = { name: file.name, rows };
        const unique = new Set(rows.map(r => key(r.asset_tag))).size;
        const exact = [...new Set(rows.map(r => key(r.asset_tag)))].filter(k => this.assets.has(k)).length;
        const sections = new Set(rows.map(r => r.section).filter(Boolean)).size;
        const dlg = this.$('dlg');
        dlg.innerHTML = `<h2>Import ${esc(file.name)}</h2>
<p>${rows.length} row${rows.length === 1 ? '' : 's'} · ${unique} unique tag${unique === 1 ? '' : 's'} · ${sections} section${sections === 1 ? '' : 's'} · <b>${exact}</b> exact match${exact === 1 ? '' : 'es'} with the LaunchPad asset list.</p>
${this.imp ? '<p class="small muted">This becomes the current drawing data. Decisions already made keep applying to tags that are still in the file; the previous import stays in history.</p>' : ''}
${problems.length ? `<div class="note warn" style="max-height:140px;overflow:auto">${problems.slice(0, 50).map(esc).join('<br>')}${problems.length > 50 ? '<br>…' : ''}</div>` : ''}
${rows.length ? `<div class="scroll-x" style="max-height:240px;overflow:auto;margin-top:8px"><table style="min-width:640px"><thead><tr>${TEMPLATE_COLUMNS.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, 8).map(r => `<tr>${TEMPLATE_COLUMNS.map(c => `<td>${esc(r[c] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}
<div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn" data-act="dlgClose">Cancel</button><button type="button" class="btn primary" data-act="confirmImport"${rows.length ? '' : ' disabled'}>Import ${rows.length} rows</button></div>`;
        dlg.showModal();
    }

    async saveImport(btn) {
        const p = this._pendingImport;
        if (!p || !p.rows.length || !this.canSetup) return;
        btn.disabled = true; btn.textContent = 'Importing…';
        const { error } = await this._supabase.from('launchpad_powerflow_imports').insert({ project_key: this.PROJECT_KEY, file_name: p.name, row_count: p.rows.length, rows: p.rows });
        if (error) { btn.disabled = false; btn.textContent = 'Import'; alert('Import failed: ' + (error.message || 'unknown error')); return; }
        const unique = [...new Set(p.rows.map(r => key(r.asset_tag)))];
        const exact = unique.filter(k => this.assets.has(k)).length;
        await this._supabase.from('launchpad_powerflow_log').insert({ project_key: this.PROJECT_KEY, kind: 'import', subject: p.name, value: { rows: p.rows.length, tags: unique.length, exact }, detail: `${p.name}: ${unique.length} tags read, ${exact} exact matches accepted automatically`, reason: (this.ui.note || '').trim() || null });
        this._pendingImport = null;
        this.ui.note = '';
        this.$('dlg').close();
        this.ui.tab = 'matchup';
        this.loaded = false;
        await this.load();
    }

    showTemplate() {
        const dlg = this.$('dlg');
        dlg.innerHTML = `<h2>Power-flow template &amp; AI prompt</h2>
<p class="small muted">Give Gemini or Claude the single-line PDFs (vector PDFs read best) together with this prompt, then save its answer as a .csv file and import it here. Check the output against the drawings before importing.</p>
<p class="small"><b>Columns:</b> ${TEMPLATE_COLUMNS.join(', ')}</p>
<textarea id="promptText" readonly aria-label="AI prompt">${esc(AI_PROMPT)}</textarea>
<div class="row" style="justify-content:space-between;margin-top:12px"><button type="button" class="btn" data-act="downloadTemplate">Download CSV template</button>
<span class="row"><button type="button" class="btn primary" data-act="copyPrompt">Copy prompt</button><button type="button" class="btn" data-act="dlgClose">Close</button></span></div>`;
        dlg.showModal();
    }

    download(name, text, type) {
        const url = URL.createObjectURL(new Blob([text], { type }));
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

customElements.define('powerflow-view', PowerFlowView);
