// <bridge-view> — the Pull Plan Scheduler ("Bridge") drag/resize Gantt
// tool, with dependency links, critical-path analysis, bulk add, baseline
// PDF import, LaunchPad two-way sync, Google Sheets export, and PDF/XLSX
// reports.
//
// Used two ways, same as the other three views:
//   1. Standalone: bridge.html loads this module directly and the element
//      reads ?project=&role=&email= from the page URL itself (dev/bookmark
//      use — falls back to the STY4 project + 'editor' role this file was
//      originally built for).
//   2. Embedded: index.html dynamically imports this module and mounts
//      <bridge-view project="..." role="..." email="..."> directly into
//      the shell, passing its own already-authenticated Supabase client
//      instead of letting this element create a second one.
//
// Two real layout differences from the old iframe version had to be fixed
// here (not just mechanically converted) — an iframe has its OWN viewport,
// so 100vh/position:fixed inside it already meant "fill the iframe's box".
// A custom element shares the outer page's viewport, so the same rules
// would instead cover the whole LaunchPad shell (header/sidebar included).
// The modal overlays, the detail side panel, the toast, and the bottom
// timeline-range bar all use position:absolute (not fixed) now, scoped to
// this component's own box — see STYLE below, same reasoning as
// equipment-tracker-view.js's modal/loading-overlay fix.
//
// This file also replaces a module-eval-time postMessage handshake
// ('BRIDGE_VIEW_SHOWN', sent by the old iframe host once it un-hid the
// iframe) with a plain public method, notifyVisible(), that the shell now
// calls directly once it shows this tab — see the file-header comment on
// notifyVisible() below for why a fresh render is needed at that point.
//
// One-time setup: run sync/move_schedule_row.sql in the Supabase SQL
// editor. It backs the LaunchPad push (_syncItemToLaunchPadCore() below)
// for the case where an activity's date changes, moving it to a new
// day-encoded row and removing the old one as a single atomic database
// operation instead of two separate network round-trips. Without it, that
// still works via an older two-step fallback, just without the same
// guarantee against a dropped connection leaving a stale duplicate behind.

const SUPABASE_URL = "https://rcnxetcomdrlxvlarqoc.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjbnhldGNvbWRybHh2bGFycW9jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0NDIyMjksImV4cCI6MjA5MjAxODIyOX0.gP37sT5OrCOVRZXekMrBZHm5mtfnr6JrC2YGflWsDQU";
const SUPABASE_CONFIGURED = !SUPABASE_URL.includes("YOUR-PROJECT-REF") && !SUPABASE_ANON_KEY.includes("YOUR-ANON-PUBLIC-KEY");

// Table names. {PROJECT_KEY}schedule_items is the one table this app writes
// the actual pull-plan data to. Everything else — the option lists that
// populate dropdowns/checklists — is read from your existing
// "{PROJECT_KEY}dropdownoptions" table, which uses one COLUMN per list
// instead of one row-category per list: every non-null cell in a given
// column is one option for that list. See README.md for the full
// walkthrough and how to adjust this mapping. (TABLES/LAUNCHPAD_TABLE
// themselves are built per-instance in _resolveParams(), once this.PROJECT_KEY
// is known — they used to be module-level consts computed from a
// module-level PROJECT_KEY read once at script-load time.)
// Which column in {PROJECT_KEY}dropdownoptions backs each list. "types" (the
// Mech/Elec/... legend + its colors) has no matching column in that table,
// so it's kept as a small local list instead (see this.DB.fetchAll/insert/etc.
// below) — edit DEFAULT_TYPE_COLORS further down to change the starting
// set, or add a column to {PROJECT_KEY}dropdownoptions yourself and map it here.
const DROPDOWN_COLUMN = {
    assets: "Assets",
    activities: "Activities",
    contractors: "Trade_Partners",
    zones: "Zone",
    areas: "Places"
    // "Times" and "Results" exist in the table but aren't used by the app
    // yet — repurpose them by adding e.g. `shift: "Times"` here and wiring
    // up a matching field, if you want them surfaced later.
};

const LOCAL_KEY = "pullplan_demo_v1";

// Duration is entered/displayed in DAYS throughout the UI, but stored as
// duration_hours internally (schema, CPM math, gantt pixel math all stay
// hour-based — only the input/display layer converts). Change this if a
// "day" should mean an 8-hour shift instead of a full 24-hour day.
const HOURS_PER_DAY = 24;
const TYPES_LOCAL_KEY = "pullplan_type_colors_v1";   // Types & Colors (no Supabase column — always local)
const ZONE_ENDDATE_KEY = "pullplan_zone_enddates_v1"; // Zone target end dates (no Supabase column — always local)

// ---- Google Sheets sync (optional) ----
// 1. Create/select a project in Google Cloud Console, enable the "Google Sheets API"
//    and "Google Drive API".
// 2. Create an OAuth 2.0 Client ID (type: Web application) and add this page's
//    origin under "Authorized JavaScript origins".
// 3. Paste the client ID below. Leave GOOGLE_DRIVE_FOLDER_ID blank to save the
//    sheet in the signed-in user's My Drive root, or paste a Drive folder ID
//    (from its URL) to save it into a specific shared folder.
const GOOGLE_CLIENT_ID = "YOUR-GOOGLE-OAUTH-CLIENT-ID.apps.googleusercontent.com";
const GOOGLE_DRIVE_FOLDER_ID = ""; // optional
const GOOGLE_CONFIGURED = !GOOGLE_CLIENT_ID.includes("YOUR-GOOGLE-OAUTH");

// ---- Google Sheets sync + lazy-loaded feature libraries ----
// Each of pdf.js / tesseract.js / jsPDF+autotable / xlsx is only fetched the
// first time the feature that needs it is actually used, and cached so
// repeat uses don't re-fetch. These stay plain module-scope functions (no
// instance-state dependency) — call them as bare ensurePdfJs() etc. from
// within instance methods, same pattern as equipment-tracker-view.js's
// getContrastYIQ().
function loadScriptOnce(src) {
    window.__loadedScripts = window.__loadedScripts || {};
    if (!window.__loadedScripts[src]) {
        window.__loadedScripts[src] = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('Failed to load ' + src));
            document.head.appendChild(s);
        });
    }
    return window.__loadedScripts[src];
}

let _pdfjsReady = null;
function ensurePdfJs() {
    if (!_pdfjsReady) {
        _pdfjsReady = loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js').then(() => {
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        });
    }
    return _pdfjsReady;
}

let _tesseractReady = null;
function ensureTesseract() {
    if (!_tesseractReady) _tesseractReady = loadScriptOnce('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
    return _tesseractReady;
}

let _jsPdfReady = null;
function ensureJsPdf() {
    if (!_jsPdfReady) {
        _jsPdfReady = loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
            .then(() => loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'));
    }
    return _jsPdfReady;
}

let _xlsxReady = null;
function ensureXlsx() {
    if (!_xlsxReady) _xlsxReady = loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    return _xlsxReady;
}

function hoursToDays(h) { return Math.round((h / HOURS_PER_DAY) * 100) / 100; }
function daysToHours(d) { return Math.round(d * HOURS_PER_DAY * 100) / 100; }

// Every other date input in this file is a native <input type="date">,
// which always comes back as YYYY-MM-DD — safe to hand straight to
// `new Date(str + 'T07:00')`. Pasted WBS schedule data instead carries
// whatever format the source spreadsheet used, most commonly US-style
// M/D/YYYY (e.g. "10/26/2026"), which that same concatenation trick would
// silently turn into an Invalid Date. This normalizes either shape before
// applying the same default 7am local start time.
function parseFlexibleDate(str) {
    if (!str) return null;
    str = str.trim();
    if (!str) return null;
    const us = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (us) {
        const [, m, d, y] = us;
        return new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T07:00`);
    }
    return new Date(str.includes('T') ? str : str + 'T07:00');
}

function uid() {
    return 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const DEFAULT_TYPE_COLORS = [
    { id: uid(), name: 'Mech' },
    { id: uid(), name: 'Elec' },
    { id: uid(), name: 'Plumb' },
    { id: uid(), name: 'Civil' },
    { id: uid(), name: 'Fire' },
    { id: uid(), name: 'Finish' },
    { id: uid(), name: 'Controls' },
    { id: uid(), name: 'Other' }
];

// ---- Activity colors ----
// Gantt bars are colored by ACTIVITY (e.g. "Set Equipment", "Pull Wire"),
// not by Type/trade — Type stays a plain filterable attribute with no
// color of its own. Every activity gets an automatically assigned color
// the first time it's used (cycling through this palette), stored locally
// so it's consistent across reloads; override any of them under Manage
// Lists -> Activity Colors.
const ACTIVITY_COLOR_PALETTE = [
    '#90CAF9', '#FFE082', '#A5D6A7', '#BCAAA4', '#EF9A9A', '#CE93D8',
    '#B0BEC5', '#9FA8DA', '#80DEEA', '#C5E1A5', '#FFCC80', '#F48FB1',
    '#B39DDB', '#80CBC4', '#E6EE9C', '#FFAB91'
];
const ACTIVITY_COLORS_KEY = 'pullplan_activity_colors_v1';

function escHtml(s) { return (s ?? '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escAttr(s) { return escHtml(s); }

const ITEM_GAP = 8, ROW_PAD_TOP = 10, ROW_PAD_BOTTOM = 10, ROW_MIN_H = 56;

const LAUNCHPAD_SYNC_KEY = 'pullplan_launchpad_sync_enabled_v1';
// Same Google Apps Script endpoint LaunchPad's own col5 (Status) lookup
// uses — reused here read-only so items can show the same status without
// duplicating whatever spreadsheet/logic backs it.
const LAUNCHPAD_STATUS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxkJfxdnt3j9l_8EH0ZUmAc48PSVP2W53t1ps-9LH_RlGGwO41Uq6jbnt78JMinDIDN/exec';

const FILTER_DEFS = [
    { key: 'asset', label: 'Asset', field: 'asset_name' },
    { key: 'activity', label: 'Activity', field: 'activity_name' },
    { key: 'area', label: 'Area', field: 'area' },
    // contractor_name holds '|'-delimited multiple assignees (see
    // renderContractorCheckboxList()'s own split/join elsewhere) — a plain
    // exact-match field like the three above would never match an item
    // with more than one contractor, so this one is special-cased in
    // itemMatchesFilters()/renderDropdownContent() below instead of going
    // through the generic single-value path.
    { key: 'contractor', label: 'Contractor', field: 'contractor_name' }
];

const STYLE = `
<style>
:host{
    /* was :root's custom properties + body's own rules — merged since this
       element's own box now plays the role the real <body> used to play
       (an iframe had its own top-level document; a shadow-DOM custom
       element does not). position:relative + height:100% (not 100vh) so
       descendants positioned absolute/fixed-turned-absolute below resolve
       against this component's own box instead of the whole browser
       window — same reasoning as equipment-tracker-view.js's :host. */
    display:flex; flex-direction:column; position:relative; height:100%; overflow:hidden;
    margin:0;
    font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    color:var(--text-dark);
    background:#fafafa;
    padding-bottom:52px; /* reserved for the timeline-range-bar, now position:absolute below */
    --green:#2e7d32;
    --green-dark:#1b5e20;
    --green-light:#e8f5e9;
    --grey-bg:#f1f3f4;
    --grey-border:#dcdcdc;
    --grey-border2:#ddd;
    --text-dark:#2c2c2c;
    --text-muted:#5f6368;
    --red:#d32f2f;
}
*{box-sizing:border-box;}
button{font-family:inherit;}
input,select,textarea{font-family:inherit;}

/* ===== HEADER ===== */
.header{
    height:72px;
    background:#ffffff;
    border-bottom:1px solid var(--grey-border);
    display:flex;
    align-items:center;
    padding:0 24px;
    box-shadow:0 2px 10px rgba(0,0,0,0.08);
    position:sticky; top:0; z-index:500;
    gap:20px;
}
.header-left{display:flex; align-items:center; gap:12px; flex:0 0 auto;}
.header-left .logo-badge{
    width:40px;height:40px;border-radius:8px;background:var(--green);
    display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:18px;
}
.header-title{font-weight:800;font-size:22px;letter-spacing:-0.5px;color:var(--green-dark);white-space:nowrap;}
.header-sub{font-size:11px;color:var(--text-muted);margin-top:-2px;}
.header-mid{flex:1; display:flex; align-items:center; gap:8px;}
.header-right{display:flex; align-items:center; gap:10px; flex:0 0 auto;}
#saveIndicator{font-weight:600;color:var(--green);font-size:13px;white-space:nowrap;}
#saveIndicator.dirty{color:#e8a33d;}
#saveIndicator.error{color:var(--red);}

.tool-btn{
    background:#fff; border:1px solid var(--grey-border); color:var(--text-dark);
    padding:8px 14px; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600;
    display:flex; align-items:center; gap:6px; white-space:nowrap; transition:all .15s;
}
.tool-btn:hover{background:var(--grey-bg); border-color:#bbb;}
.tool-btn.primary{background:var(--green); color:#fff; border-color:var(--green);}
.tool-btn.primary:hover{background:var(--green-dark);}
.tool-btn.small{padding:5px 10px; font-size:12px;}

/* ===== TOOLBAR / FILTER BAR ===== */
.toolbar{
    background:#fff; border-bottom:1px solid var(--grey-border2);
    padding:10px 24px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;
    position:sticky; top:0; z-index:400;
}
.filter-chip{position:relative;}
.filter-chip-btn{
    background:var(--grey-bg); border:1px solid var(--grey-border); padding:7px 12px;
    border-radius:16px; cursor:pointer; font-size:12.5px; font-weight:600; color:var(--text-dark);
    display:flex; align-items:center; gap:6px;
}
.filter-chip-btn.active{background:var(--green-light); border-color:var(--green); color:var(--green-dark);}
.filter-chip-btn .count-badge{background:var(--green); color:#fff; border-radius:10px; padding:1px 6px; font-size:10px;}
.filter-dropdown{
    display:none; position:absolute; top:calc(100% + 6px); left:0; background:#fff;
    border:1px solid var(--grey-border); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,0.15);
    width:230px; max-height:320px; overflow-y:auto; z-index:600; padding:8px;
}
.filter-dropdown.open{display:block;}
.filter-dropdown input.search{width:100%; padding:6px 8px; border:1px solid var(--grey-border2); border-radius:4px; font-size:12px; margin-bottom:6px;}
.filter-option{display:flex; align-items:center; gap:8px; padding:5px 6px; border-radius:4px; font-size:12.5px; cursor:pointer;}
.filter-option:hover{background:var(--grey-bg);}
.filter-option.disabled{opacity:0.35; pointer-events:none;}
.filter-option .swatch{width:10px;height:10px;border-radius:3px;flex:0 0 auto;}
.filter-clear-all{font-size:11.5px; color:var(--text-muted); text-decoration:underline; cursor:pointer; background:none; border:none;}

/* generic consolidated-action dropdown (Add / LaunchPad / Report buttons) */
.menu-btn-wrap{position:relative; display:inline-block;}
.menu-dropdown{
    display:none; position:absolute; top:calc(100% + 6px); left:0; background:#fff;
    border:1px solid var(--grey-border); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,0.15);
    min-width:230px; z-index:600; padding:6px;
}
.menu-dropdown.right{left:auto; right:0;}
.menu-dropdown.open{display:block;}
.menu-item{padding:9px 12px; border-radius:5px; font-size:13px; font-weight:600; cursor:pointer; white-space:nowrap; color:var(--text-dark);}
.menu-item:hover{background:var(--grey-bg);}
.menu-divider{height:1px; background:var(--grey-border2); margin:5px 2px;}
.toolbar-spacer{flex:1;}
.search-box{
    padding:8px 12px; border:1px solid var(--grey-border); border-radius:6px; font-size:13px; width:220px;
}

/* ===== PENDING CHANGES BANNER ===== */
.pending-sync-banner{
    display:flex; align-items:center; justify-content:space-between; gap:14px;
    padding:9px 24px; background:#fff8e1; border-bottom:1px solid #ffe082;
    color:#8a6d00; font-size:13px; font-weight:600;
}
.pending-sync-banner .tool-btn{white-space:nowrap;}

/* ===== LEGEND ===== */
.legend{display:flex; align-items:center; gap:12px; padding:6px 24px; background:#fcfcfc; border-bottom:1px solid var(--grey-border2); flex-wrap:wrap;}
.legend-item{display:flex; align-items:center; gap:5px; font-size:11.5px; color:var(--text-muted); font-weight:600;}
.legend-swatch{width:12px;height:12px;border-radius:3px;}

/* ===== GANTT ===== */
.gantt-wrap{overflow:auto; background:#fff; position:relative; flex:1 1 auto; min-height:0; padding-bottom:12px;}
.gantt-scroll{position:relative;}
.gantt-header{
    display:flex; min-width:100%; position:sticky; top:0; z-index:300; background:#fff; border-bottom:2px solid var(--grey-border);
}
.gantt-rowlabel-col.wide{flex-basis:260px;}
.gantt-rowlabel-col{
    flex:0 0 200px; position:sticky; left:0; z-index:350; background:#f7f8f7;
    border-right:2px solid var(--grey-border); display:flex; align-items:center;
    padding:0 14px; font-weight:800; color:var(--green-dark); font-size:12.5px;
    text-transform:uppercase; letter-spacing:.5px;
}
.gantt-day{
    flex:0 0 var(--daywidth); border-right:1px solid var(--grey-border2); text-align:center;
    padding:8px 4px; font-size:12px; font-weight:700; color:var(--text-dark); cursor:pointer;
}
.gantt-day:hover{background:var(--green-light);}
.gantt-day.weekend{background:#f7f7f7; color:#aaa;}
/* Included Days setting — a stronger, more opaque grey than the plain
   weekend tint above, and no hover highlight (it's not clickable — see
   buildGanttHeaderHtml()) since nothing should ever land here. */
.gantt-day.excluded-day{background:repeating-linear-gradient(45deg, #e0e0e0, #e0e0e0 6px, #ececec 6px, #ececec 12px); color:#999; cursor:default;}
.gantt-day.excluded-day:hover{background:repeating-linear-gradient(45deg, #e0e0e0, #e0e0e0 6px, #ececec 6px, #ececec 12px);}
.gantt-day .dow{font-size:10px; font-weight:600; color:var(--text-muted); text-transform:uppercase;}
.gantt-day.today{background:var(--green-light); color:var(--green-dark);}
/* Overview zoom's month-grouped header cell (see buildGanttHeaderHtml()) —
   one per calendar month instead of one per day. */
.gantt-month{
    border-right:2px solid var(--grey-border2); text-align:center; box-sizing:border-box;
    padding:8px 4px; font-size:12px; font-weight:700; color:var(--text-dark); overflow:hidden;
    white-space:nowrap; text-overflow:ellipsis;
}
.gantt-month.today{background:var(--green-light); color:var(--green-dark);}

.gantt-body{position:relative;}
.gantt-row{display:flex; min-width:100%; border-bottom:3px solid var(--grey-border); position:relative; transition:height .05s;}
.gantt-row:nth-child(even) .gantt-row-bg{background:#fbfbfb;}
.gantt-rowlabel{
    flex:0 0 200px; position:sticky; left:0; z-index:200; background:#fff;
    border-right:2px solid var(--grey-border); padding:10px 30px 10px 14px; font-size:12.5px; font-weight:700;
    color:var(--text-dark); display:flex; align-items:flex-start; min-height:56px; position:sticky;
}
/* Overview zoom's per-item "Asset — Activity" labels run a bit longer than
   a typical group name, so that row gets a little more room. */
/* Overview/Overview Extended's per-item rows can be as short as ~16-24px
   tall (see computeLaneOffsets()'s "thin" branch) — the base rule's fixed
   min-height:56px above made the label box taller than its own row
   regardless, so it visually bled into (and got painted over by) the next
   row's own opaque, sticky-positioned label — "asset — activity cut off
   at the bottom", and the same overflow is what made the row divider
   (.gantt-row's border-bottom, which already spans the full row including
   this label column) look like it wasn't reaching the label side at all. */
.gantt-rowlabel.wide{
    flex-basis:260px; min-height:0; padding-top:3px; padding-bottom:3px; align-items:center;
    /* Explicit divider of its own, rather than relying only on the shared
       .gantt-row border-bottom below — that border is easy to lose behind
       this column's own opaque, sticky, higher-z-index background if there's
       ever even a pixel of height mismatch between a row and its label's
       real content, so this guarantees a visible line under every
       Asset — Activity row regardless. */
    border-bottom:1px solid var(--grey-border2);
}
.row-expand-btn{
    position:absolute; top:6px; right:6px; background:none; border:none; cursor:pointer;
    font-size:15px; color:#bbb; padding:2px 4px; border-radius:4px; line-height:1;
}
.row-expand-btn:hover{color:var(--green); background:var(--green-light);}
.row-resize-handle{
    position:absolute; left:0; right:0; bottom:-3px; height:7px; cursor:ns-resize; z-index:220;
}
.row-resize-handle:hover, .row-resize-handle.active{background:rgba(46,125,50,0.25);}
.gantt-track{position:relative; flex:0 0 auto; min-height:40px; overflow:visible;}
.gantt-gridlines{position:absolute; top:0; left:0; bottom:0; display:flex; pointer-events:none;}
.gantt-gridline{flex:0 0 var(--daywidth); border-right:1px solid #f0f0f0;}
.gantt-gridline.weekend{background:rgba(0,0,0,0.02);}
.gantt-gridline.excluded-day{background:repeating-linear-gradient(45deg, rgba(0,0,0,0.045), rgba(0,0,0,0.045) 6px, rgba(0,0,0,0.02) 6px, rgba(0,0,0,0.02) 12px);}
.gantt-gridline.today{background:rgba(46,125,50,0.06);}
.gantt-gridline.month{border-right:2px solid var(--grey-border2);}

.gantt-item{
    position:absolute; min-height:36px; height:auto; border-radius:6px; color:#fff; font-size:11.5px;
    font-weight:700; padding:4px 8px; overflow:visible; cursor:grab; box-shadow:0 1px 3px rgba(0,0,0,0.18);
    display:flex; flex-direction:column; justify-content:center; line-height:1.2; user-select:none;
    border:1px solid rgba(0,0,0,0.15); z-index:110; text-shadow:0 1px 2px rgba(0,0,0,0.55);
}
.gantt-item:hover{filter:brightness(0.96); z-index:150;}
/* Overview + Overview Extended (one bar per row) — as thin as the label
   content allows, down to a bare color sliver when there's no label at all. */
.gantt-item.thin{min-height:16px; padding:1px 4px; border-radius:3px; box-shadow:none;}
.gantt-item.thin .gi-asset{font-size:9px; line-height:1.15;}
/* The link-handle (drag-to-connect) is opacity:0 until the item is
   hovered elsewhere — fine at normal bar sizes, but a hover-then-hit-a-
   12px-circle sequence is much harder to pull off on these much smaller
   thin bars, especially since half the circle hangs outside a box that
   might only be ~24px wide to begin with. Left always visible here
   instead of hover-gated, so it's actually findable/grabbable. */
.gantt-item.thin .link-handle{opacity:0.8; width:10px; height:10px; right:-5px;}
.gantt-item.thin:hover .link-handle{opacity:1;}
.gantt-item.dragging{opacity:0.75; cursor:grabbing; z-index:250; box-shadow:0 6px 16px rgba(0,0,0,0.35);}
.gantt-item.overdue{box-shadow:0 0 0 2px var(--red), 0 1px 3px rgba(0,0,0,0.25);}
.gantt-item.focused{box-shadow:0 0 0 3px var(--green-dark), 0 2px 8px rgba(0,0,0,0.35); z-index:170;}
.gantt-item.multiselected{outline:3px solid #1565c0; outline-offset:1px; z-index:175;}
.gantt-item.multiselected.critical{outline-color:#1565c0;}
.launchpad-badge{position:absolute; top:2px; right:2px; font-size:10px; line-height:1; opacity:0.85;}
.gantt-item.not-ready{box-shadow:0 0 0 3px #d32f2f, 0 1px 3px rgba(0,0,0,0.25);}
.gantt-item.not-ready.critical{box-shadow:0 0 0 3px #d32f2f, 0 0 0 5px #f57c00;}
.gantt-item.dimmed{opacity:0.28; filter:grayscale(0.85); box-shadow:none; z-index:100;}
/* Rescheduled onto a new date from the Schedule side — the replacement
   activity exists as its own (normal-looking) item elsewhere on the
   timeline; this one stays visible for history but reads as "superseded,
   not live work" at a glance. */
.gantt-item.superseded{filter:grayscale(0.9); opacity:0.5;}
.gantt-item.superseded .gi-asset, .gantt-item.superseded .gi-activity{text-decoration:line-through;}
.gantt-item.critical{border:3px solid #f57c00; box-shadow:0 0 0 1px rgba(245,124,0,0.35), 0 2px 8px rgba(0,0,0,0.3);}
.gantt-item.critical.dimmed{border-color:rgba(245,124,0,0.4);}
.gantt-item.critical.focused{box-shadow:0 0 0 3px var(--green-dark), 0 2px 8px rgba(0,0,0,0.35);}
.gantt-item .gi-asset{font-weight:800; font-size:10.5px; white-space:normal; overflow-wrap:break-word; word-break:break-word; line-height:1.2;}
.gantt-item .gi-activity{font-weight:500; opacity:0.9; white-space:normal; overflow-wrap:break-word; word-break:break-word; font-size:9.5px; line-height:1.2;}
.gantt-item .resize-handle{position:absolute; right:0; top:0; bottom:0; width:8px; cursor:ew-resize;}
.gantt-item .resize-handle.left{left:0; right:auto;}
.gantt-item .resize-handle:hover{background:rgba(0,0,0,0.15);}
.gantt-item .link-handle{
    position:absolute; right:-6px; top:50%; transform:translateY(-50%); width:12px; height:12px;
    border-radius:50%; background:#fff; border:2px solid rgba(0,0,0,0.4); cursor:crosshair;
    opacity:0; transition:opacity .12s; z-index:160;
}
.gantt-item:hover .link-handle{opacity:1;}
.gantt-item .link-handle:hover{background:var(--green); border-color:var(--green-dark); transform:translateY(-50%) scale(1.25);}

/* connection lines overlay */
.connections-svg{position:absolute; top:0; left:0; pointer-events:none; z-index:120;}
.connections-svg path.conn-line{fill:none; stroke:#5f6368; stroke-width:1.6; pointer-events:stroke; cursor:pointer;}
.connections-svg path.conn-line:hover{stroke:var(--red); stroke-width:2.4;}
.connections-svg path.conn-temp{fill:none; stroke:var(--green); stroke-width:2; stroke-dasharray:4 3;}

/* zone end-date deadline marker inside a track */
.zone-end-marker{position:absolute; top:0; bottom:0; width:0; border-left:2px dashed var(--red); z-index:50;}
.zone-end-flag{
    position:absolute; top:-2px; left:4px; background:var(--red); color:#fff; font-size:9.5px; font-weight:700;
    padding:1px 5px; border-radius:3px; white-space:nowrap;
}

/* predecessor chips in item modal */
.pred-chip-list{display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; min-height:20px;}
.pred-chip{
    display:inline-flex; align-items:center; gap:5px; background:var(--grey-bg); border:1px solid var(--grey-border2);
    border-radius:14px; padding:4px 8px 4px 10px; font-size:11.5px;
}
.pred-chip button{background:none; border:none; color:var(--red); cursor:pointer; font-size:12px; padding:0;}

.empty-state{padding:60px 20px; text-align:center; color:var(--text-muted);}
.empty-state .emoji{font-size:40px; margin-bottom:10px;}

/* ===== MODALS ===== */
.modal-overlay{
    display:none; position:absolute; inset:0; background:rgba(0,0,0,0.5); z-index:2000;
    align-items:center; justify-content:center; padding:20px;
}
.modal-overlay.open{display:flex;}
.modal-box{
    background:#fff; border-radius:10px; width:520px; max-width:100%; max-height:92%;
    display:flex; flex-direction:column; box-shadow:0 20px 50px rgba(0,0,0,0.3);
}
.modal-box.wide{width:820px;}
.modal-box.xwide{width:1040px;}
.modal-head{
    display:flex; justify-content:space-between; align-items:center; padding:18px 22px;
    border-bottom:1px solid #eee;
}
.modal-head h2{margin:0; color:var(--green-dark); font-size:18px;}
.modal-close{background:none;border:none;font-size:22px;cursor:pointer;color:#999; line-height:1;}
.modal-body{padding:20px 22px; overflow-y:auto; flex:1;}
.modal-foot{display:flex; justify-content:flex-end; gap:10px; padding:16px 22px; border-top:1px solid #eee;}

.form-row{margin-bottom:14px;}
.form-row label{display:block; font-weight:700; font-size:12.5px; color:#555; margin-bottom:5px;}
.form-row .hint{font-weight:400; color:#999; font-size:11px;}
.form-row input, .form-row select, .form-row textarea{
    width:100%; padding:9px 10px; border:1px solid #ccc; border-radius:5px; font-size:13.5px;
}
.form-row input:focus, .form-row select:focus, .form-row textarea:focus{outline:2px solid var(--green-light); border-color:var(--green);}
.form-grid{display:grid; grid-template-columns:1fr 1fr; gap:14px;}

/* Combobox: text input with add-new-on-the-fly list */
.combo-wrap{position:relative;}
.combo-list{
    display:none; position:absolute; top:calc(100% + 3px); left:0; right:0; background:#fff;
    border:1px solid var(--grey-border); border-radius:6px; max-height:180px; overflow-y:auto; z-index:100;
    box-shadow:0 8px 20px rgba(0,0,0,0.15);
}
.combo-list.open{display:block;}
.combo-list .opt{padding:8px 10px; font-size:13px; cursor:pointer;}
.combo-list .opt:hover{background:var(--grey-bg);}
.combo-list .opt.add-new{color:var(--green-dark); font-weight:700; border-top:1px solid #eee;}

/* Multi-select contractor picker — used in the bulk-add preview table,
   where a cramped native <select multiple> is unusable (needs ctrl/cmd-
   click, which most people don't know). position:fixed (not absolute)
   since the preview table itself scrolls — an absolutely-positioned
   popover would get clipped by that scroll container instead of
   floating over the whole modal the way this needs to. */
.contractor-popover{
    display:none; position:fixed; background:#fff; width:230px; max-height:260px;
    border:1px solid var(--grey-border); border-radius:6px; z-index:2000; padding:8px;
    box-shadow:0 8px 24px rgba(0,0,0,0.2); overflow-y:auto;
}
.contractor-popover.open{display:block;}
.contractor-popover .search{width:100%; margin-bottom:6px; padding:6px 8px; border:1px solid var(--grey-border); border-radius:4px; font-size:12.5px; box-sizing:border-box;}
.bulk-contractor-btn{
    width:120px; text-align:left; background:#fff; border:1px solid var(--grey-border2); border-radius:4px;
    padding:5px 8px; font-size:12px; font-weight:400; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.bulk-contractor-btn:hover{background:var(--grey-bg);}

/* Tabs */
.tabs{display:flex; gap:2px; border-bottom:2px solid var(--grey-border2); margin-bottom:14px;}
.tab-btn{
    background:none; border:none; padding:9px 16px; font-weight:700; font-size:13px; cursor:pointer;
    color:var(--text-muted); border-bottom:2px solid transparent; margin-bottom:-2px;
}
.tab-btn.active{color:var(--green); border-bottom-color:var(--green);}
.tab-panel{display:none;}
.tab-panel.active{display:block;}

/* Simple list manager table */
.list-mgr-row{display:flex; gap:8px; align-items:center; padding:8px 0; border-bottom:1px solid #f0f0f0;}
.list-mgr-row input{flex:1; padding:7px 9px; border:1px solid #ddd; border-radius:4px; font-size:13px;}
.list-mgr-row .swatch-input{flex:0 0 40px; padding:2px; height:32px;}
.list-mgr-row button.del{background:none; border:none; color:var(--red); cursor:pointer; font-size:16px;}
.list-mgr-add{display:flex; gap:8px; margin-top:10px; padding-top:10px; border-top:1px dashed var(--grey-border2);}
.list-mgr-add input{flex:1; padding:8px; border:1px solid var(--green); border-radius:4px; font-size:13px;}

/* Bulk add preview table */
.preview-table{width:100%; border-collapse:collapse; font-size:12.5px;}
.preview-table th{background:var(--grey-bg); text-align:left; padding:7px 8px; position:sticky; top:0;}
.preview-table td{padding:6px 8px; border-bottom:1px solid #eee;}
.preview-table tr:hover td{background:#fafafa;}
.preview-remove{color:var(--red); cursor:pointer; background:none; border:none; font-size:14px;}

.checkbox-scroll-list{border:1px solid var(--grey-border); border-radius:5px; max-height:150px; overflow-y:auto; padding:6px; background:#f9f9f9;}
.checkbox-scroll-list label{display:flex; align-items:center; gap:6px; padding:4px 4px; font-size:12.5px; cursor:pointer;}
.checkbox-scroll-list label:hover{background:#eee;}

/* Baseline import panel */
.baseline-canvas-wrap{border:1px solid var(--grey-border2); border-radius:6px; overflow:auto; max-height:360px; background:#f4f4f4; text-align:center;}
.baseline-canvas-wrap canvas{max-width:100%;}
.token-chip{
    display:inline-flex; align-items:center; gap:6px; background:var(--grey-bg); border:1px solid var(--grey-border2);
    border-radius:14px; padding:4px 10px; font-size:12px; margin:3px; cursor:pointer;
}
.token-chip.selected{background:var(--green-light); border-color:var(--green); color:var(--green-dark); font-weight:700;}

/* Item detail panel (click item) */
.detail-panel{
    display:none; position:absolute; right:0; top:0; bottom:0; width:340px; background:#fff;
    box-shadow:-6px 0 24px rgba(0,0,0,0.15); z-index:1500; padding:20px; overflow-y:auto;
}
.detail-panel.open{display:block;}

/* Toast */
#toast{
    position:absolute; bottom:64px; left:50%; transform:translateX(-50%); background:#323232; color:#fff;
    padding:12px 20px; border-radius:6px; font-size:13px; z-index:3000; display:none; box-shadow:0 6px 20px rgba(0,0,0,0.3);
}

/* Bottom timeline date-range bar */
.timeline-range-bar{
    position:absolute; bottom:0; left:0; right:0; background:#fff; border-top:1px solid var(--grey-border);
    padding:10px 24px; display:flex; gap:20px; align-items:center; z-index:500;
    box-shadow:0 -2px 10px rgba(0,0,0,0.08); font-size:12.5px; font-weight:700; color:#555;
}
.timeline-range-bar label{display:flex; align-items:center; gap:6px;}
.timeline-range-bar input[type="date"]{padding:6px 8px; border:1px solid var(--grey-border); border-radius:5px; font-size:12.5px; font-weight:600; color:var(--text-dark);}
.timeline-range-bar input[type="date"]:disabled{background:var(--grey-bg); color:#999;}

/* Print */
@media print{
    .header, .toolbar, .legend, .filter-dropdown, .tool-btn, .no-print{display:none !important;}
    body{background:#fff;}
    .gantt-wrap{overflow:visible !important;}
    .gantt-rowlabel-col, .gantt-rowlabel{position:static !important;}
}

/* ===== DARK MODE OVERRIDES =====
   Mirrors the exact palette equipment-tracker-view.js's own
   :host(.dark-mode) block already uses, so the whole app reads as one
   consistent dark theme rather than each module inventing its own shade.
   Two layers: redefining the semantic custom properties from :host above
   (--text-dark, --grey-bg, etc.) re-themes everything that already
   references them for free; the explicit per-selector rules below catch
   the surfaces that were hardcoded to a literal color instead (#fff,
   #fcfcfc, #f9f9f9...). */
:host(.dark-mode){
    --green-dark:#81c784;
    --text-dark:#e0e0e0;
    --text-muted:#aaaaaa;
    --grey-border:#3a3a3a;
    --grey-border2:#333333;
    --grey-bg:#2c2c2c;
    background-color:#121212 !important;
    color:#e0e0e0 !important;
}

:host(.dark-mode) .header,
:host(.dark-mode) .toolbar,
:host(.dark-mode) .legend,
:host(.dark-mode) .gantt-wrap,
:host(.dark-mode) .gantt-header,
:host(.dark-mode) .gantt-rowlabel,
:host(.dark-mode) .filter-dropdown,
:host(.dark-mode) .menu-dropdown,
:host(.dark-mode) .combo-list,
:host(.dark-mode) .modal-box,
:host(.dark-mode) .detail-panel,
:host(.dark-mode) .timeline-range-bar,
:host(.dark-mode) .checkbox-scroll-list,
:host(.dark-mode) .baseline-canvas-wrap{
    background-color:#1e1e1e !important;
    color:#e0e0e0 !important;
}

:host(.dark-mode) .gantt-row{border-bottom-color:#333 !important;}
:host(.dark-mode) .gantt-row:nth-child(even) .gantt-row-bg{background:#1a1a1a !important;}
:host(.dark-mode) .gantt-gridline{border-right-color:#2a2a2a !important;}
:host(.dark-mode) .gantt-gridline.weekend{background:rgba(255,255,255,0.03) !important;}
:host(.dark-mode) .gantt-gridline.excluded-day{background:repeating-linear-gradient(45deg, rgba(255,255,255,0.05), rgba(255,255,255,0.05) 6px, rgba(255,255,255,0.02) 6px, rgba(255,255,255,0.02) 12px) !important;}
:host(.dark-mode) .gantt-day.excluded-day{background:repeating-linear-gradient(45deg, #2a2a2a, #2a2a2a 6px, #242424 6px, #242424 12px) !important; color:#777 !important;}
:host(.dark-mode) .gantt-gridline.today{background:rgba(76,175,80,0.12) !important;}

/* Activity colors on gantt bars come from an inline style set by JS
   (activityColor()) — dimming/desaturating rather than trying to enumerate
   every possible color is the same trick equipment-tracker-view.js uses
   for its own status cells. */
:host(.dark-mode) .gantt-item{
    filter:brightness(0.8) saturate(0.85) contrast(1.05);
    border-color:rgba(255,255,255,0.2) !important;
}

:host(.dark-mode) input,
:host(.dark-mode) select,
:host(.dark-mode) textarea{
    background-color:#2c2c2c !important;
    color:#e0e0e0 !important;
    border-color:#444 !important;
}
:host(.dark-mode) input:focus,
:host(.dark-mode) select:focus,
:host(.dark-mode) textarea:focus{
    background-color:#383838 !important;
}

:host(.dark-mode) .tool-btn{background-color:#2c2c2c !important; color:#e0e0e0 !important; border-color:#555 !important;}
:host(.dark-mode) .tool-btn:hover{background-color:#383838 !important;}
:host(.dark-mode) .tool-btn.primary{background-color:var(--green) !important; color:#fff !important; border-color:var(--green) !important;}

:host(.dark-mode) .filter-chip-btn{background-color:#2c2c2c !important; border-color:#444 !important; color:#e0e0e0 !important;}
:host(.dark-mode) .filter-chip-btn.active{background-color:#1b3d1e !important; border-color:var(--green) !important; color:#81c784 !important;}
:host(.dark-mode) .filter-option:hover,
:host(.dark-mode) .menu-item:hover,
:host(.dark-mode) .combo-list .opt:hover{background-color:#2c2c2c !important;}
:host(.dark-mode) .token-chip{background-color:#2c2c2c !important; border-color:#444 !important;}
:host(.dark-mode) .token-chip.selected{background-color:#1b3d1e !important; border-color:var(--green) !important; color:#81c784 !important;}

:host(.dark-mode) .modal-head,
:host(.dark-mode) .modal-foot{border-color:#333 !important;}
:host(.dark-mode) .modal-close{color:#aaa !important;}
:host(.dark-mode) .form-row label{color:#aaa !important;}

:host(.dark-mode) .tabs{border-bottom-color:#333 !important;}
:host(.dark-mode) .tab-btn{color:#aaa !important;}

:host(.dark-mode) .list-mgr-row,
:host(.dark-mode) .preview-table td{border-bottom-color:#333 !important;}
:host(.dark-mode) .preview-table th{background-color:#2c2c2c !important;}
:host(.dark-mode) .preview-table tr:hover td{background-color:#2a2a2a !important;}
:host(.dark-mode) .checkbox-scroll-list label:hover{background-color:#2a2a2a !important;}

:host(.dark-mode) #toast{background-color:#333 !important;}
:host(.dark-mode) ::-webkit-scrollbar-thumb{background:#555 !important;}

::-webkit-scrollbar{height:10px; width:10px;}
::-webkit-scrollbar-thumb{background:#ccc; border-radius:5px;}
::-webkit-scrollbar-thumb:hover{background:#aaa;}

/* ===== VIEWER ROLE LOCKDOWN =====
   Was injected as a real <style> into document.head at module-eval time in
   the original (gated on the module-level isViewerRole const, known before
   any DOM even existed). Now that role is resolved per-instance from an
   attribute/URL param in _resolveParams(), this has to be real CSS gated by
   a class toggled on the host once the role is known — see
   _setupViewerRoleGating(). */
:host(.viewer-role-lockdown) #add-menu-wrap{display:none !important;}
:host(.viewer-role-lockdown) #editModeToggleBtn{display:none !important;} /* viewers are already permanently locked — nothing for this toggle to do */
:host(.viewer-role-lockdown) .gantt-item{cursor:default !important;}
:host(.viewer-role-lockdown) .resize-handle,
:host(.viewer-role-lockdown) .link-handle{display:none !important;}

/* ===== EDIT LOCK =====
   Editors start locked on every fresh load too — see requireEditMode()/
   toggleEditMode(). Items stay clickable (viewing is still allowed; the
   actual drag/resize/connect entry points are gated in JS, not here), but
   look and behave non-interactive: no grab cursor, no resize/connect
   handles to grab in the first place. */
:host(.edit-locked) .gantt-item{cursor:default !important;}
:host(.edit-locked) .resize-handle,
:host(.edit-locked) .link-handle{display:none !important;}
#itemModal.readonly-locked .pred-chip-list button{display:none !important;}
#itemModal.readonly-locked input:disabled,
#itemModal.readonly-locked select:disabled,
#itemModal.readonly-locked textarea:disabled{background:var(--grey-bg); color:#888; cursor:not-allowed;}
</style>
`;

const MARKUP = `
<!-- Title/logo removed per request. projectSubtitle kept (hidden) so initApp() has
     somewhere to write its "Demo mode" / "Connected to Supabase" status without erroring. -->
<span id="projectSubtitle" style="display:none;"></span>

<!-- ===== FILTER TOOLBAR ===== -->
<div class="toolbar" id="filterToolbar">
    <!-- LEFT SIDE: filters + search -->
    <!-- filter chips injected by JS immediately before Clear filters -->
    <button class="filter-clear-all" id="clearAllFiltersBtn" onclick="this.getRootNode().host.clearAllFilters()">Clear filters</button>
    <input type="text" class="search-box" id="globalSearch" placeholder="Search asset, activity, contractor..." oninput="this.getRootNode().host.debouncedRenderGantt()">

    <div class="toolbar-spacer"></div>

    <!-- RIGHT SIDE: everything else -->
    <select class="tool-btn small" id="dayWidthSelect" onchange="this.getRootNode().host.setDayWidth(this.value)" style="font-weight:600;" title="Overview groups its header by month and drops all text in favor of color-coded bars only — a bird's-eye view of the whole project. Overview Extended shows individual days and the asset name on each bar.">
        <option value="14">Zoom: Overview</option>
        <option value="45" selected>Zoom: Overview Extended</option>
    </select>
    <label class="tool-btn small" style="cursor:pointer; gap:6px; border-color:#f57c0033;" title="Show only the zero-float activities from today forward — the chain(s) that directly control how soon everything finishes. Everything else, including past work, is hidden.">
        <input type="checkbox" id="criticalPathToggle" onchange="this.getRootNode().host.toggleCriticalPath(this.checked)" style="margin:0;">
        🔥 Critical Path
    </label>
    <span id="multiSelectIndicator" style="display:none; align-items:center; gap:8px; background:var(--green-light); border:1px solid var(--green); border-radius:16px; padding:6px 12px; font-size:12.5px; font-weight:700; color:var(--green-dark);" title="Ctrl/Cmd+click activities to select more, or Ctrl/Cmd+click a selected one to deselect it. Drag any selected activity to move the whole group together.">
        <span class="count">0</span> selected — drag one to move them together
        <button class="preview-remove" onclick="this.getRootNode().host.clearMultiSelect()" title="Clear selection" style="color:var(--green-dark);">✕</button>
    </span>
    <button class="tool-btn" id="editModeToggleBtn" onclick="this.getRootNode().host.toggleEditMode()" title="Bridge starts locked every time it loads — nothing can be dragged, resized, connected, added, or deleted until this is on.">🔒 Edit</button>
    <div class="menu-btn-wrap" id="add-menu-wrap">
        <button class="tool-btn" onclick="if(this.getRootNode().host.requireEditMode()) this.getRootNode().host.toggleMenu('addMenu', event)">➕ Add ▾</button>
        <div class="menu-dropdown right" id="addMenu">
            <div class="menu-item" id="newItemMenuBtn" onclick="this.getRootNode().host.closeAllMenus(); this.getRootNode().host.openModal('itemModal')">➕ New Item</div>
            <div class="menu-item" onclick="this.getRootNode().host.closeAllMenus(); this.getRootNode().host.openBulkAddModal()">📋 Bulk Add</div>
            <div class="menu-item" onclick="this.getRootNode().host.closeAllMenus(); if(this.getRootNode().host.requireEditMode()) this.getRootNode().host.openModal('baselineModal')">📐 Import Baseline</div>
        </div>
    </div>
    <span id="saveIndicator">Ready</span>
    <div class="menu-btn-wrap">
        <button class="tool-btn small" onclick="this.getRootNode().host.toggleMenu('reportMenu', event)">📊 Report ▾</button>
        <div class="menu-dropdown right" id="reportMenu">
            <div class="menu-item" onclick="this.getRootNode().host.closeAllMenus(); this.getRootNode().host.exportPDF()">📄 PDF</div>
            <div class="menu-item" onclick="this.getRootNode().host.closeAllMenus(); this.getRootNode().host.exportXLSX()">📊 XLSX</div>
            <div class="menu-item" onclick="this.getRootNode().host.closeAllMenus(); this.getRootNode().host.openCompletionPlanModal()">📅 Completion Plan</div>
        </div>
    </div>
</div>

<!-- ===== PENDING CHANGES BANNER =====
     Hidden whenever pendingSyncIds/pendingDeleteLaunchPadIds are both
     empty — see updatePendingSyncUI(). -->
<div class="pending-sync-banner" id="pendingSyncBanner" style="display:none;">
    <span>📝 <span id="pendingSyncCount">0 changes</span> not yet in Schedule</span>
    <span style="display:flex; gap:8px;">
        <button class="tool-btn small" onclick="this.getRootNode().host.discardPendingChanges()" title="Revert Bridge back to whatever Schedule currently shows">✕ Discard</button>
        <button class="tool-btn primary small" onclick="this.getRootNode().host.acceptPendingChanges()">✓ Accept &amp; Publish to Schedule</button>
    </span>
</div>

<!-- ===== TYPE COLOR LEGEND ===== -->
<div class="legend" id="typeLegend"></div>

<!-- ===== GANTT ===== -->
<div class="gantt-wrap" id="ganttWrap">
    <div class="gantt-scroll" id="ganttScroll">
        <div class="gantt-header" id="ganttHeader"></div>
        <div class="gantt-body" id="ganttBody"></div>
    </div>
</div>

<!-- ===== NEW / EDIT ITEM MODAL ===== -->
<div class="modal-overlay" id="itemModal">
    <div class="modal-box">
        <div class="modal-head">
            <h2 id="itemModalTitle">New Schedule Item</h2>
            <button class="modal-close" onclick="this.getRootNode().host.closeModal('itemModal')">×</button>
        </div>
        <div class="modal-body">
            <input type="hidden" id="itemId">
            <div class="form-row combo-wrap">
                <label>Asset *</label>
                <input type="text" id="itemAsset" placeholder="Type to search or add new asset..." autocomplete="off"
                    oninput="this.getRootNode().host.filterCombo('itemAsset','itemAssetList', this.getRootNode().host.DATA.assets)" onfocus="this.getRootNode().host.filterCombo('itemAsset','itemAssetList', this.getRootNode().host.DATA.assets)"
                    onblur="this.getRootNode().host.applyAssetLookup(this.value, 'itemArea')">
                <div class="combo-list" id="itemAssetList"></div>
            </div>
            <div class="form-row combo-wrap">
                <label>Activity *</label>
                <input type="text" id="itemActivity" placeholder="Type to search or add new activity..." autocomplete="off"
                    oninput="this.getRootNode().host.filterCombo('itemActivity','itemActivityList', this.getRootNode().host.DATA.activities)" onfocus="this.getRootNode().host.filterCombo('itemActivity','itemActivityList', this.getRootNode().host.DATA.activities)">
                <div class="combo-list" id="itemActivityList"></div>
            </div>
            <div class="form-grid">
                <div class="form-row">
                    <label>Duration (days) *</label>
                    <input type="number" id="itemDuration" min="0.1" step="0.25" value="1">
                </div>
                <div class="form-row">
                    <label>Start Date/Time *</label>
                    <input type="datetime-local" id="itemStart">
                </div>
            </div>
            <div class="form-row">
                <label>Area <span class="hint">automatic, based on Asset</span></label>
                <input type="text" id="itemArea" readonly disabled style="background:var(--grey-bg); cursor:not-allowed;">
            </div>
            <div class="form-row combo-wrap">
                <label>Contractor(s) <span class="hint">select one or more</span></label>
                <input type="text" class="search" placeholder="Filter contractors..." oninput="this.getRootNode().host.filterCheckList('itemContractorList', this.value)">
                <div class="checkbox-scroll-list" id="itemContractorList"></div>
            </div>
            <div class="form-row combo-wrap">
                <label>Predecessors <span class="hint">this item can't start before these finish</span></label>
                <div class="pred-chip-list" id="itemPredChips"></div>
                <input type="text" id="itemPredSearch" placeholder="Search items to link as a predecessor..." autocomplete="off"
                    oninput="this.getRootNode().host.filterPredCombo(this.value)" onfocus="this.getRootNode().host.filterPredCombo(this.value)">
                <div class="combo-list" id="itemPredList"></div>
            </div>
            <div class="form-row">
                <label>Notes <span class="hint">optional</span></label>
                <textarea id="itemNotes" rows="2"></textarea>
            </div>
        </div>
        <div class="modal-foot">
            <button class="tool-btn" id="itemDeleteBtn" style="border-color:var(--red); color:var(--red); display:none;" onclick="this.getRootNode().host.deleteCurrentItem()">Delete</button>
            <div style="flex:1;"></div>
            <button class="tool-btn" onclick="this.getRootNode().host.closeModal('itemModal')">Cancel</button>
            <button class="tool-btn primary" id="itemSaveBtn" onclick="this.getRootNode().host.saveItemModal()">Save Item</button>
        </div>
    </div>
</div>

<!-- ===== BULK ADD MODAL ===== -->
<div class="modal-overlay" id="bulkModal">
    <div class="modal-box xwide">
        <div class="modal-head">
            <h2>Bulk Add Schedule Items</h2>
            <button class="modal-close" onclick="this.getRootNode().host.closeModal('bulkModal')">×</button>
        </div>
        <div class="modal-body">
            <div id="bulkStep1">
                <p style="color:#666; font-size:13px; margin-top:0;">Select multiple assets and activities to generate combinations, or paste rows from a spreadsheet (Asset, Activity, Duration in days, Start Date, Contractor(s), Notes columns, tab or comma separated). Area is filled in automatically from Asset.</p>
                <div class="tabs">
                    <button class="tab-btn active" onclick="this.getRootNode().host.switchTab('bulkTab','combo',event)">Combination Builder</button>
                    <button class="tab-btn" onclick="this.getRootNode().host.switchTab('bulkTab','paste',event)">Paste / CSV</button>
                    <button class="tab-btn" onclick="this.getRootNode().host.switchTab('bulkTab','wbs',event)">Import Schedule (WBS)</button>
                </div>
                <div class="tab-panel active" id="bulkTab-combo">
                    <div class="form-grid">
                        <div>
                            <label style="font-weight:700; font-size:12.5px; color:#555;">Assets</label>
                            <input type="text" class="search" placeholder="Filter assets..." oninput="this.getRootNode().host.filterCheckList('bulkAssetList', this.value)">
                            <div class="checkbox-scroll-list" id="bulkAssetList"></div>
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12.5px; color:#555;">Activities</label>
                            <input type="text" class="search" placeholder="Filter activities..." oninput="this.getRootNode().host.filterCheckList('bulkActivityList', this.value)">
                            <div class="checkbox-scroll-list" id="bulkActivityList"></div>
                            <label style="display:flex; align-items:center; gap:6px; margin-top:8px; font-size:12px; font-weight:600; color:#555; cursor:pointer;" title="For each asset, chains its activities in the order checked above — activity 2 can't start until activity 1 finishes, and so on.">
                                <input type="checkbox" id="bulkAutoLink" style="margin:0;">
                                🔗 Auto-link each asset's activities in order
                            </label>
                        </div>
                    </div>
                    <div class="form-grid" style="margin-top:14px;">
                        <div>
                            <label style="font-weight:700; font-size:12.5px; color:#555;">Contractor(s) <span class="hint">optional</span></label>
                            <input type="text" class="search" placeholder="Filter contractors..." oninput="this.getRootNode().host.filterCheckList('bulkContractorList', this.value)">
                            <div class="checkbox-scroll-list" id="bulkContractorList"></div>
                        </div>
                        <div class="form-row">
                            <label>Duration (days)</label>
                            <input type="number" id="bulkDuration" min="0.1" step="0.25" value="1">
                        </div>
                        <div class="form-row">
                            <label>Start Date</label>
                            <input type="date" id="bulkStartDate">
                        </div>
                        <div class="form-row" style="grid-column:1 / -1;">
                            <label>Notes <span class="hint">optional, applied to every generated row</span></label>
                            <input type="text" id="bulkNotes" placeholder="Optional notes...">
                        </div>
                    </div>
                    <button class="tool-btn primary" onclick="this.getRootNode().host.generateBulkPreview('combo')">Generate Preview →</button>
                </div>
                <div class="tab-panel" id="bulkTab-paste">
                    <textarea id="bulkPasteArea" rows="10" placeholder="Asset, Activity, Duration (days), Start Date (YYYY-MM-DD), Contractor(s), Notes
Pump-101, Install Piping, 1, 2026-08-03, Apex Mechanical | Acme Electric, Confirm crane access" style="width:100%; font-family:monospace; font-size:12.5px; padding:10px; border:1px solid #ccc; border-radius:5px;"></textarea>
                    <button class="tool-btn primary" style="margin-top:10px;" onclick="this.getRootNode().host.generateBulkPreview('paste')">Generate Preview →</button>
                </div>
                <div class="tab-panel" id="bulkTab-wbs">
                    <p style="color:#666; font-size:13px; margin-top:0;">Paste rows exported from a WBS schedule (e.g. copied straight from Excel) with columns, in this exact order: <strong>Index, WBS, Activity, Activity Type, Asset, Status, Predecessors, Notes, Start Date, Duration, Trade Partners</strong>. Tab-separated (a normal Excel paste) is safest — commas inside Notes won't get misread. <strong>Index</strong> is required on every row (it's how the Predecessors column links rows to each other); <strong>Duration</strong> can be like "0.5d" or "2d" and is always rounded up to whole days; each row's own Start Date is used as-is, not recalculated from its predecessors.</p>
                    <textarea id="bulkWbsPasteArea" rows="10" placeholder="Index	WBS	Activity	Activity Type	Asset	Status	Predecessors	Notes	Start Date	Duration	Trade Partners
3	EYD.Z1.FBAT.04	L2D for Temp power SSS1-A BDC	Temp Power	SSS-1A	Not Started	2		10/26/2026	0.5d	Tune
4	EYD.Z1.FBAT.05	Temp Power to SSS1-A BDC	Temp Power	SSS-1A	Not Started	3		10/26/2026	1d	" style="width:100%; font-family:monospace; font-size:12.5px; padding:10px; border:1px solid #ccc; border-radius:5px;"></textarea>
                    <button class="tool-btn primary" style="margin-top:10px;" onclick="this.getRootNode().host.generateBulkPreview('wbs')">Generate Preview →</button>
                </div>
            </div>
            <div id="bulkStep2" style="display:none;">
                <p style="color:#666; font-size:13px; margin-top:0;"><strong id="bulkPreviewCount"></strong> — review before adding to the schedule. Every field is editable; remove any rows you don't want.</p>
                <div style="max-height:340px; overflow:auto; border:1px solid #eee; border-radius:6px;">
                    <table class="preview-table">
                        <thead id="bulkPreviewHead"><tr><th>Asset</th><th>Activity</th><th>Dur (days)</th><th>Area</th><th>Start</th><th>Contractor(s)</th><th>Notes</th><th>Linked after</th><th></th></tr></thead>
                        <tbody id="bulkPreviewBody"></tbody>
                    </table>
                </div>
                <button class="tool-btn" style="margin-top:12px;" onclick="this.getRootNode().host.backToBulkStep1()">← Back</button>
            </div>
        </div>
        <div class="modal-foot">
            <button class="tool-btn" onclick="this.getRootNode().host.closeModal('bulkModal')">Cancel</button>
            <button class="tool-btn primary" id="bulkCommitBtn" style="display:none;" onclick="this.getRootNode().host.commitBulkAdd()">Add to Schedule</button>
        </div>
    </div>
</div>

<!-- Shared multi-select popover for the bulk-preview table's per-row
     Contractor(s) picker — one instance, repositioned/repopulated for
     whichever row's button was clicked (see openBulkContractorPicker()). -->
<div class="contractor-popover" id="bulkContractorPopover"></div>

<!-- ===== LISTS MANAGER MODAL (Asset / Activity / Contractor) ===== -->
<div class="modal-overlay" id="listsModal">
    <div class="modal-box wide">
        <div class="modal-head">
            <h2>Manage Lists</h2>
            <button class="modal-close" onclick="this.getRootNode().host.closeModal('listsModal')">×</button>
        </div>
        <div class="modal-body">
            <div class="tabs">
                <button class="tab-btn active" onclick="this.getRootNode().host.switchTab('listsTab','assets',event)">Assets</button>
                <button class="tab-btn" onclick="this.getRootNode().host.switchTab('listsTab','activities',event)">Activities</button>
                <button class="tab-btn" onclick="this.getRootNode().host.switchTab('listsTab','contractors',event)">Contractors</button>
                <button class="tab-btn" onclick="this.getRootNode().host.switchTab('listsTab','zones',event)">Zones / Areas</button>
                <button class="tab-btn" onclick="this.getRootNode().host.switchTab('listsTab','types',event)">Types</button>
                <button class="tab-btn" onclick="this.getRootNode().host.switchTab('listsTab','activitycolors',event)">Activity Colors</button>
            </div>
            <div class="tab-panel active" id="listsTab-assets">
                <div id="assetListRows"></div>
                <div class="list-mgr-add">
                    <input type="text" id="newAssetName" placeholder="New asset name">
                    <button class="tool-btn primary small" onclick="this.getRootNode().host.addListItem('assets')">Add</button>
                </div>
                <button class="tool-btn small" style="margin-top:10px; width:100%;" title="Bridge is the source of truth for which activities exist. This first pulls in anything typed directly into the Scheduler that Bridge doesn't know about yet, then clears any Scheduler row still left over with no matching Bridge activity." onclick="this.getRootNode().host.reconcileScheduleWithBridge()">🧹 Reconcile Scheduler with Bridge</button>
            </div>
            <div class="tab-panel" id="listsTab-activities">
                <div id="activityListRows"></div>
                <div class="list-mgr-add">
                    <input type="text" id="newActivityName" placeholder="New activity name">
                    <button class="tool-btn primary small" onclick="this.getRootNode().host.addListItem('activities')">Add</button>
                </div>
                <button class="tool-btn small" style="margin-top:10px; width:100%;" title="Removes any activity option not currently used by a Bridge item or a LaunchPad schedule row — keeps the picker list matching what's actually in use instead of accumulating every name ever typed" onclick="this.getRootNode().host.cleanUpActivitiesList()">🧹 Remove Unused Activities</button>
            </div>
            <div class="tab-panel" id="listsTab-contractors">
                <div id="contractorListRows"></div>
                <div class="list-mgr-add">
                    <input type="text" id="newContractorName" placeholder="New contractor / trade partner name">
                    <button class="tool-btn primary small" onclick="this.getRootNode().host.addListItem('contractors')">Add</button>
                </div>
            </div>
            <div class="tab-panel" id="listsTab-zones">
                <div class="form-grid">
                    <div>
                        <label style="font-weight:700; font-size:12.5px; color:#555;">Zones</label>
                        <p style="font-size:11px; color:#999; margin:2px 0 6px;">End dates are stored in this browser only, keyed by zone name.</p>
                        <div id="zoneListRows"></div>
                        <div class="list-mgr-add">
                            <input type="text" id="newZoneName" placeholder="New zone name">
                            <input type="date" id="newZoneEndDate" title="Target end date (optional)" style="flex:0 0 140px;">
                            <button class="tool-btn primary small" onclick="this.getRootNode().host.addListItem('zones')">Add</button>
                        </div>
                    </div>
                    <div>
                        <label style="font-weight:700; font-size:12.5px; color:#555;">Areas</label>
                        <div id="areaListRows"></div>
                        <div class="list-mgr-add">
                            <input type="text" id="newAreaName" placeholder="New area name">
                            <button class="tool-btn primary small" onclick="this.getRootNode().host.addListItem('areas')">Add</button>
                        </div>
                    </div>
                </div>
            </div>
            <div class="tab-panel" id="listsTab-types">
                <p style="font-size:11.5px; color:#999; margin-top:0;">Types are stored in this browser only (no matching column in the shared Supabase table). This is a plain filterable attribute now — gantt bar colors come from Activity Colors instead.</p>
                <div id="typeListRows"></div>
                <div class="list-mgr-add">
                    <input type="text" id="newTypeName" placeholder="New type name (e.g. Fire Protection)">
                    <button class="tool-btn primary small" onclick="this.getRootNode().host.addListItem('types')">Add</button>
                </div>
            </div>
            <div class="tab-panel" id="listsTab-activitycolors">
                <p style="font-size:11.5px; color:#999; margin-top:0;">Every activity gets an automatically assigned color the first time it's used. Adjust any of them here — stored in this browser only.</p>
                <div id="activityColorRows"></div>
            </div>
        </div>
        <div class="modal-foot">
            <button class="tool-btn primary" onclick="this.getRootNode().host.closeModal('listsModal')">Done</button>
        </div>
    </div>
</div>

<!-- ===== BASELINE PDF IMPORT MODAL ===== -->
<div class="modal-overlay" id="baselineModal">
    <div class="modal-box wide">
        <div class="modal-head">
            <h2>Import Baseline PDF</h2>
            <button class="modal-close" onclick="this.getRootNode().host.closeModal('baselineModal')">×</button>
        </div>
        <div class="modal-body">
            <p style="color:#666; font-size:13px; margin-top:0;">Upload a baseline site plan or schedule PDF. Text (zone/area/asset labels) will be extracted automatically — if the PDF is a scanned image, OCR will run instead. Review the detected labels below and add the ones you want as Zones or Areas.</p>
            <input type="file" id="baselineFileInput" accept="application/pdf" onchange="this.getRootNode().host.handleBaselineFile(this.files[0])">
            <div style="margin-top:14px; display:flex; gap:16px;">
                <div style="flex:1;">
                    <div class="baseline-canvas-wrap" id="baselineCanvasWrap">
                        <div style="padding:40px; color:#999;">No file loaded yet.</div>
                    </div>
                </div>
                <div style="flex:1;">
                    <div id="baselineStatus" style="font-size:12.5px; color:#666; margin-bottom:8px;"></div>
                    <div style="font-weight:700; font-size:12.5px; color:#555; margin-bottom:6px;">Detected labels <span class="hint" style="font-weight:400;">(click to select)</span></div>
                    <div id="baselineTokens" style="max-height:220px; overflow-y:auto; border:1px solid #eee; border-radius:6px; padding:8px;"></div>
                    <div style="margin-top:12px; display:flex; gap:8px;">
                        <button class="tool-btn small" onclick="this.getRootNode().host.commitBaselineTokens('zones')">Add Selected as Zones</button>
                        <button class="tool-btn small" onclick="this.getRootNode().host.commitBaselineTokens('areas')">Add Selected as Areas</button>
                    </div>
                </div>
            </div>
        </div>
        <div class="modal-foot">
            <button class="tool-btn primary" onclick="this.getRootNode().host.closeModal('baselineModal')">Done</button>
        </div>
    </div>
</div>

<!-- ===== ITEM DETAIL SIDE PANEL (click-to-view on gantt bar) ===== -->
<div class="detail-panel" id="detailPanel"></div>


<!-- ===== COMPLETION PLAN EXPORT MODAL ===== -->
<div class="modal-overlay" id="completionPlanModal">
    <div class="modal-box">
        <div class="modal-head">
            <h2>Export Completion Plan</h2>
            <button class="modal-close" onclick="this.getRootNode().host.closeModal('completionPlanModal')">×</button>
        </div>
        <div class="modal-body">
            <p style="color:#666; font-size:13px; margin-top:0;">Pick a date range — the export groups every activity in that window by assignee (contractor), in date order, so each trade partner can see exactly what they owe and when.</p>
            <div class="form-grid">
                <div class="form-row">
                    <label>From</label>
                    <input type="date" id="completionPlanStart">
                </div>
                <div class="form-row">
                    <label>To</label>
                    <input type="date" id="completionPlanEnd">
                </div>
            </div>
            <p style="color:#999; font-size:11.5px; margin-top:10px;">Want an AI-generated plan instead of just grouping what's already scheduled? This file runs entirely in your browser with no server of its own, so it can't safely call an AI API directly (that would mean shipping an API key to everyone who opens it). If you've got a backend or an Apps Script endpoint that can call one, point me at it and I can wire this button up to send it your unscheduled activities and get suggested dates/assignments back.</p>
        </div>
        <div class="modal-foot">
            <button class="tool-btn" onclick="this.getRootNode().host.closeModal('completionPlanModal')">Cancel</button>
            <button class="tool-btn primary" onclick="this.getRootNode().host.exportCompletionPlan('xlsx')">📊 Export XLSX</button>
            <button class="tool-btn primary" onclick="this.getRootNode().host.exportCompletionPlan('pdf')">📄 Export PDF</button>
        </div>
    </div>
</div>

<!-- ===== DAY DETAIL MODAL ===== -->
<div class="modal-overlay" id="dayDetailModal">
    <div class="modal-box wide">
        <div class="modal-head">
            <h2 id="dayDetailTitle">Day</h2>
            <button class="modal-close" onclick="this.getRootNode().host.closeModal('dayDetailModal')">×</button>
        </div>
        <div class="modal-body" id="dayDetailBody"></div>
        <div class="modal-foot">
            <button class="tool-btn primary" onclick="this.getRootNode().host.closeModal('dayDetailModal')">Done</button>
        </div>
    </div>
</div>

<!-- ===== TIMELINE DATE RANGE BAR ===== -->
<div class="timeline-range-bar">
    <label>Start date <input type="date" id="rangeStartInput" onchange="this.getRootNode().host.applyTimelineRange()"></label>
    <label>End date <input type="date" id="rangeEndInput" onchange="this.getRootNode().host.applyTimelineRange()"></label>
    <label style="display:flex; align-items:center; gap:6px; font-weight:600;">
        <input type="checkbox" id="useLastActivityEnd" onchange="this.getRootNode().host.applyTimelineRange()" style="margin:0;">
        Use last activity as end date
    </label>
    <span style="width:1px; align-self:stretch; background:var(--grey-border);"></span>
    <span style="font-weight:600; color:#888;">Quick view:</span>
    <button type="button" class="tool-btn small" onclick="this.getRootNode().host.applyTimelineRangePreset('week')">This Week</button>
    <button type="button" class="tool-btn small" onclick="this.getRootNode().host.applyTimelineRangePreset('month')">This Month</button>
    <button type="button" class="tool-btn small" onclick="this.getRootNode().host.applyTimelineRangePreset('quarter')">3 Months</button>
    <button type="button" class="tool-btn small" onclick="this.getRootNode().host.applyTimelineRangePreset('full')">Full Project</button>
</div>

<div id="toast"></div>
`;

export class BridgeView extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._outsideClickHandler = this._handleOutsideClick.bind(this);
        this._keydownHandler = this._handleKeydown.bind(this);
        // Stable bound references for the drag pointermove/pointerup pair —
        // startDrag()/onDragEnd() add/remove these same two references, so
        // the identity must stay constant across a whole drag gesture (and
        // matching remove requires the exact reference used for add).
        this._onDragMoveBound = this.onDragMove.bind(this);
        this._onDragEndBound = this.onDragEnd.bind(this);

        // ---- 3. GLOBAL STATE (was module-level let/const, now per-instance) ----
        this.ZONE_END_DATES = this.loadZoneEndDates();
        this.DATA_STORE = this.loadLocalStore() || {};
        this.DATA = {
            items: [],
            assets: [],
            activities: [],
            contractors: [],
            zones: [],
            areas: [],
            types: []
        };
        this.FILTERS = {
            type: new Set(),
            zone: new Set(),
            asset_type: new Set(),
            asset: new Set(),
            activity: new Set(),
            area: new Set(),
            contractor: new Set()
        };
        this.DAY_WIDTH = 45;        // matches the "Zoom: Overview Extended" default in #dayWidthSelect
        this.TIMELINE_START = null; // Date, midnight
        this.TIMELINE_DAYS = 42;    // 6-week rolling window
        // Schedule's "Included Days" setting (launchpad_schedule_config.
        // included_days, see index.html's loadScheduleConfig()) — which
        // weekdays (0=Sun..6=Sat) are active schedule days for this
        // project. Defaults to every day until _resolveProjectFlags()
        // fetches the real value, so nothing is greyed out / treated as
        // excluded for a project that's never touched this setting.
        this.includedDays = [0, 1, 2, 3, 4, 5, 6];
        // Blackout Dates setting (launchpad_schedule_config.blackout_dates)
        // — one-off excluded 'YYYY-MM-DD' dates, layered on top of
        // includedDays by isDayIncluded(). Defaults to none until
        // _resolveProjectFlags() fetches the real value.
        this.blackoutDates = [];
        this.dragCtx = null;
        this.bulkPreviewRows = [];
        this.baselineDetectedTokens = [];
        this.ACTIVITY_COLORS = this.loadActivityColors();
        this.ASSET_TO_ZONE_MAP = {};
        this.ASSET_TO_AREA_MAP = {};
        this.__resizeRerenderTimer = null;
        this.connScrollScheduled = false;
        this.rowHeightOverrides = {};  // groupKey -> manually set px height (auto if absent)
        this.LAST_GROUPS = {};
        this.LAST_GROUPBY = 'zone';
        this.expandedView = false;   // true while "Expand All Activities" is active
        this.linkDragCtx = null;
        this.connectionFocusId = null;   // when set, only that item's own connector lines are drawn
        this.multiSelectedIds = new Set(); // Ctrl/Cmd+click selection — dragging any member moves all of them together
        this.focusChainSet = null;       // Set of item ids connected to connectionFocusId (dimmed = everything else)
        this.showCriticalPath = false;   // toggle: highlight the zero-float chain(s)
        this.criticalPathData = null;    // recomputed each render — { floatById, esById, efById, lsById, lfById }
        this.__ganttSearchDebounceTimer = null;
        this.autoScrollRAF = null;
        this.autoScrollState = null;
        this.currentItemPredecessors = [];
        // Always on now that the manual toggle button is gone — LaunchPad
        // push/pull is core functionality, not an opt-in.
        this.LAUNCHPAD_SYNC_ENABLED = true;
        // Moving/editing an item in Bridge (including everything a
        // dependency cascade drags along with it) used to push straight to
        // LaunchPad the instant it happened — one drag could silently
        // rewrite several days' worth of Schedule rows with no chance to
        // review them first. These now just mark an item "pending" instead
        // of pushing; acceptPendingChanges() (wired to the "Accept &
        // Publish to Schedule" banner) is what actually pushes, all at
        // once, only when the user explicitly says so. In-memory only —
        // not persisted across reloads, so a page refresh before accepting
        // just leaves those edits sitting in Bridge, unpushed, exactly as
        // if they hadn't been accepted yet.
        this.pendingSyncIds = new Set();
        this.pendingDeleteLaunchPadIds = new Set();
        // Locked by default on every fresh load (not persisted — a
        // deliberate per-session unlock, not a lasting preference) so a
        // stray click or drag can't move/resize/connect/create/delete
        // anything until someone explicitly turns editing on via the
        // toolbar's 🔒 Edit button. See requireEditMode()/toggleEditMode().
        this.editModeActive = false;
        this.STATUS_CACHE = {}; // "asset|||activity" -> { result, url } | 'pending' | 'error'
        this.RESULT_CACHE = {}; // launchpad_id -> result string | null, cached so repeated lookups (e.g. across several predecessors) don't re-fetch
        this.statusRefreshInFlight = false;
        this.googleTokenClient = null;
        this.googleAccessToken = null;
        this._toastTimer = null; // was a property hung off the module-level toast() function itself

        // Mirrors LaunchPad's own assetToPlaceMap approach exactly: fetch
        // every row of {PROJECT_KEY}dropdownoptions and, wherever an Asset
        // and a Zone/Place appear together on the same row, remember that
        // pairing — so picking an Asset elsewhere in the app can auto-fill
        // its Zone/Area the same way LaunchPad does.
        // (ASSET_TO_ZONE_MAP / ASSET_TO_AREA_MAP declared above.)

        // ---- Data layer (CRUD wrappers for every table) ----
        // Transparently uses Supabase when configured, otherwise falls back
        // to an in-browser localStorage store so the tool is fully usable
        // for evaluation before credentials are wired in. Kept as a
        // self-contained object (own _reportError/fetchAll/insert/update/
        // remove) closing over the outer instance via `self`, same shape
        // as the original module-level DB const.
        const self = this;
        this.DB = {
    // "types" never touches Supabase — there's no column for it in
    // {PROJECT_KEY}dropdownoptions, so it's a small locally-persisted list.
    _reportError(action, real, error) {
        console.error(real, error);
        self.setSaveIndicator('error', action === 'load' ? 'Supabase error' : action === 'delete' ? 'Delete failed' : 'Save failed');
        const isRLS = error && (error.code === '42501' || /row-level security|permission denied/i.test(error.message || ''));
        const verb = action === 'load' ? 'Loading' : action === 'delete' ? 'Deleting' : 'Saving';
        self.toast(
            isRLS
                ? `${verb} from "${real}" was blocked by a Row Level Security policy — see README Troubleshooting.`
                : `${verb} "${real}" failed — see the browser console for details.`,
            5500
        );
    },
    async fetchAll(table) {
        if (table === 'types') {
            return self.loadLocalTypes() || DEFAULT_TYPE_COLORS.map(t => ({ ...t }));
        }
        const column = DROPDOWN_COLUMN[table];
        if (column && self._supabase) {
            // one row per option, all packed into one column of the shared table
            const { data, error } = await self._supabase
                .from(self.TABLES.dropdowns)
                .select(`id, "${column}"`)
                .not(column, 'is', null)
                .order(column, { ascending: true });
            if (error) { this._reportError('load', self.TABLES.dropdowns, error); return []; }
            return (data || []).map(r => ({ id: r.id, name: r[column] }));
        }
        if (!column && self._supabase) {
            // items: query the real table directly. Paginated explicitly —
            // without a .range(), PostgREST silently caps at its default
            // page size (1000 rows), and since this orders by created_at
            // ascending, any row past that cap (i.e. any RECENTLY created
            // row — including a freshly rescheduled activity) would be
            // silently missing from every load instead of erroring.
            const PAGE_SIZE = 1000;
            let allRows = [];
            let offset = 0;
            while (true) {
                const { data, error } = await self._supabase.from(table).select('*').order('created_at', { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
                if (error) { this._reportError('load', table, error); return allRows; }
                allRows = allRows.concat(data || []);
                if (!data || data.length < PAGE_SIZE) break;
                offset += PAGE_SIZE;
            }
            return allRows;
        }
        return (self.DATA_STORE[table] || []).slice();
    },
    async insert(table, row) {
        row.created_at = row.created_at || new Date().toISOString();
        if (table === 'types') {
            row.id = row.id || uid();
            const list = self.loadLocalTypes() || DEFAULT_TYPE_COLORS.map(t => ({ ...t }));
            list.push(row);
            self.saveLocalTypes(list);
            return row;
        }
        const column = DROPDOWN_COLUMN[table];
        if (column && self._supabase) {
            // new option = a new row in the shared table with just this one column set
            const { data, error } = await self._supabase.from(self.TABLES.dropdowns).insert({ [column]: row.name }).select();
            if (error) { this._reportError('save', self.TABLES.dropdowns, error); return null; }
            return { id: data[0].id, name: data[0][column] };
        }
        if (!column && self._supabase) {
            // {PROJECT_KEY}schedule_items.id is a real Postgres uuid column with its own
            // default (gen_random_uuid()) — never send our own client-side
            // id string here, or Postgres rejects it (error 22P02, invalid
            // uuid syntax). Let the database assign it and use what comes back.
            const { id, ...rowWithoutId } = row;
            const { data, error } = await self._supabase.from(table).insert(rowWithoutId).select();
            if (error) { this._reportError('save', table, error); return null; }
            return data[0];
        }
        row.id = row.id || uid();
        self.DATA_STORE[table] = self.DATA_STORE[table] || [];
        self.DATA_STORE[table].push(row);
        self.saveLocalStore();
        return row;
    },
    async update(table, id, patch) {
        patch.updated_at = new Date().toISOString();
        if (table === 'types') {
            const list = self.loadLocalTypes() || DEFAULT_TYPE_COLORS.map(t => ({ ...t }));
            const idx = list.findIndex(r => r.id === id);
            if (idx > -1) { list[idx] = { ...list[idx], ...patch }; self.saveLocalTypes(list); return list[idx]; }
            return null;
        }
        const column = DROPDOWN_COLUMN[table];
        if (column && self._supabase) {
            // renaming an option = updating that one column's value on its row
            const { data, error } = await self._supabase.from(self.TABLES.dropdowns).update({ [column]: patch.name }).eq('id', id).select();
            if (error) { this._reportError('save', self.TABLES.dropdowns, error); return null; }
            return { id: data[0].id, name: data[0][column] };
        }
        if (!column && self._supabase) {
            const { data, error } = await self._supabase.from(table).update(patch).eq('id', id).select();
            if (error) { this._reportError('save', table, error); return null; }
            return data[0];
        }
        const arr = self.DATA_STORE[table] || [];
        const idx = arr.findIndex(r => r.id === id);
        if (idx > -1) { arr[idx] = { ...arr[idx], ...patch }; self.saveLocalStore(); return arr[idx]; }
        return null;
    },
    async remove(table, id) {
        if (table === 'types') {
            const list = (self.loadLocalTypes() || DEFAULT_TYPE_COLORS.map(t => ({ ...t }))).filter(r => r.id !== id);
            self.saveLocalTypes(list);
            return true;
        }
        const column = DROPDOWN_COLUMN[table];
        const real = column ? self.TABLES.dropdowns : table;
        if (self._supabase) {
            // deleting an option removes its whole row — each row in the
            // shared table only ever has the one relevant column populated
            const { error } = await self._supabase.from(real).delete().eq('id', id);
            if (error) { this._reportError('delete', real, error); return false; }
            return true;
        }
        self.DATA_STORE[table] = (self.DATA_STORE[table] || []).filter(r => r.id !== id);
        self.saveLocalStore();
        return true;
    }
};
    }

    connectedCallback() {
        if (this._mounted) return; // re-entrant connect (e.g. node moved) shouldn't re-init
        this._mounted = true;
        this._resolveParams();
        this.shadowRoot.innerHTML = STYLE + MARKUP;
        this._initSupabase();
        // Bridge previously had no dark-mode support at all — index.html's
        // toggleDarkMode() only ever reached it via postMessage to an
        // <iframe>, which stopped existing once this became a custom
        // element. Read the same shared preference equipment-tracker-view.js
        // already does, so a fresh mount starts in the right theme instead
        // of always defaulting to light until the toggle is clicked again.
        if (localStorage.getItem('launchpad_dark_mode') === 'enabled') this.classList.add('dark-mode');

        document.addEventListener('click', this._outsideClickHandler);
        document.addEventListener('keydown', this._keydownHandler);
        this._resizeHandler = () => {
            clearTimeout(this.__resizeRerenderTimer);
            this.__resizeRerenderTimer = setTimeout(() => this.renderGantt(), 150);
        };
        window.addEventListener('resize', this._resizeHandler);

        this._setupViewerRoleGating();

        // Stored (not just fired-and-forgotten) so code outside this
        // component — e.g. the Schedule-side reschedule flow in index.html,
        // which mounts Bridge on demand and needs its data genuinely loaded
        // before calling into it — has something to await instead of
        // guessing how long init (Supabase connect + first full data load)
        // takes.
        this._initPromise = this.init();
    }

    async whenReady() {
        return this._initPromise;
    }

    disconnectedCallback() {
        document.removeEventListener('click', this._outsideClickHandler);
        document.removeEventListener('keydown', this._keydownHandler);
        if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
        this._teardownViewerRoleGating();
        clearTimeout(this.__resizeRerenderTimer);
        clearTimeout(this.__ganttSearchDebounceTimer);
        clearTimeout(this._toastTimer);
        clearTimeout(this._launchpadPullDebounce);
        this.stopAutoScroll();
        // Without this, a remount (index.html tears this element down and
        // creates a fresh one every time the user switches away from and
        // back to the Bridge tab) leaves the old channel subscribed
        // forever — see initLaunchPadRealtimeSync()'s comment for what
        // that broke.
        if (this._realtimeChannel && this._supabase) {
            this._supabase.removeChannel(this._realtimeChannel);
            this._realtimeChannel = null;
        }
    }

    _resolveParams() {
        const qp = new URLSearchParams(window.location.search);
        // Falls back to the prefix/defaults this file was originally built
        // for, so it still works if opened directly without these params.
        this.PROJECT_KEY = this.getAttribute('project') || qp.get('project') || 'STY4';
        this.USER_ROLE = this.getAttribute('role') || qp.get('role') || 'editor';
        this.USER_EMAIL = this.getAttribute('email') || qp.get('email') || '';
        this.isViewerRole = this.USER_ROLE === 'viewer';
        this.TABLES = {
            items: `${this.PROJECT_KEY}schedule_items`,
            dropdowns: `${this.PROJECT_KEY}dropdownoptions`,
            assets: "assets",
            activities: "activities",
            contractors: "contractors",
            zones: "zones",
            areas: "areas",
            types: "types"
        };
        // LaunchPad reads its schedule grid from its own
        // "{PROJECT_KEY}BackEndData" table in this same Supabase project —
        // see the LAUNCHPAD SYNC section below for the full field mapping.
        this.LAUNCHPAD_TABLE = `${this.PROJECT_KEY}BackEndData`;
    }

    // fetchLaunchPadStatus() used to call a single hardcoded Apps Script URL
    // (LAUNCHPAD_STATUS_SCRIPT_URL) regardless of which project was actually
    // loaded — that URL belongs to whichever project this file was
    // originally built against (PROJECT_KEY's own fallback default), so for
    // any OTHER project it was querying an entirely different project's
    // checklist data, which obviously never matches this project's real
    // activities — always "NA", no matter what. Each project has its own
    // Apps Script URL in launchpad_projects.google_script_url (the same
    // place LaunchPad's own sync pipeline reads it from); this fetches that
    // and uses it instead, falling back to the old hardcoded one only if
    // this project has none on file.
    // Resolves this project's `launchpad_projects` row once, before any
    // schedule data loads. Two things come out of it:
    //  - GOOGLE_SCRIPT_URL (unchanged from before — see the "NA status" fix)
    //  - UNIFIED_SCHEDULE: once a project's schedule_items/BackEndData
    //    tables have been merged (see sync/unify_backend_schedule.sql),
    //    Bridge reads/writes BackEndData directly instead of its own
    //    schedule_items table, and the whole push/pull sync layer below
    //    goes dormant for that project. This MUST resolve, and TABLES.items/
    //    ItemsDB must be set, before reloadAllData() runs — otherwise the
    //    very first load would still hit the wrong table.
    async _resolveProjectFlags() {
        this.GOOGLE_SCRIPT_URL = LAUNCHPAD_STATUS_SCRIPT_URL;
        this.UNIFIED_SCHEDULE = false;
        if (this._supabase) {
            try {
                const { data, error } = await this._supabase
                    .from('launchpad_projects')
                    .select('google_script_url, unified_schedule')
                    .eq('project_key', this.PROJECT_KEY)
                    .maybeSingle();
                if (!error && data) {
                    if (data.google_script_url) this.GOOGLE_SCRIPT_URL = data.google_script_url;
                    this.UNIFIED_SCHEDULE = !!data.unified_schedule;
                }
            } catch (e) {
                console.error('Could not resolve this project\'s config (Apps Script URL / unified-schedule flag) — using fallbacks', e);
            }
            // Same "Included Days" setting index.html's Schedule config
            // modal writes (launchpad_schedule_config.included_days) —
            // select('*') rather than naming the column so a project whose
            // Supabase hasn't had sync/included_days.sql run yet still
            // loads everything else here instead of 400ing the whole
            // query. Null/empty/missing all mean "every day", matching
            // index.html's own fallback — this feature is opt-out, not
            // opt-in, for every existing project.
            try {
                const { data, error } = await this._supabase
                    .from('launchpad_schedule_config')
                    .select('*')
                    .eq('project_key', this.PROJECT_KEY)
                    .maybeSingle();
                if (!error && data && Array.isArray(data.included_days) && data.included_days.length) {
                    this.includedDays = data.included_days;
                }
                // Blackout Dates — specific one-off excluded dates (holidays,
                // shutdowns, etc.) layered on top of Included Days' recurring
                // weekday pattern. Same select('*')-tolerant-of-a-missing-
                // column reasoning, and same "null/missing means none" default.
                if (!error && data && Array.isArray(data.blackout_dates)) {
                    this.blackoutDates = data.blackout_dates;
                }
            } catch (e) {
                console.error('Could not resolve this project\'s Included Days/Blackout Dates settings — treating every day as included', e);
            }
        }
        if (this.UNIFIED_SCHEDULE) this.TABLES.items = this.LAUNCHPAD_TABLE;
        this._setupItemsDB();
    }

    // A day is an active schedule day only if its weekday is in
    // includedDays AND it isn't individually blacked out — the one-off
    // Blackout Dates list (holidays, shutdowns) layers on top of the
    // recurring weekly pattern rather than replacing it.
    isDayIncluded(dayIdx) {
        const d = new Date(this.dayIndexToMs(dayIdx));
        if (!this.includedDays.includes(d.getDay())) return false;
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return !(this.blackoutDates || []).includes(iso);
    }

    // Used wherever the dependency cascade (enforceDependencies()/
    // simulateReschedulePreview()) would otherwise land a successor on
    // "the day right after its predecessor finishes" — walks forward from
    // that day until it finds one this project's Included Days setting
    // actually allows, per request ("auto movement should move to the
    // next available day that is selected, not days that are not
    // selected"). Bounded loop: every project includes at least one
    // weekday eventually, but this can't spin forever if includedDays
    // somehow ends up empty.
    nextIncludedDayIndex(dayIdx) {
        let idx = dayIdx;
        for (let i = 0; i < 3650 && !this.isDayIncluded(idx); i++) idx++;
        return idx;
    }

    // Mirror of nextIncludedDayIndex() walking backward — used by
    // computeCriticalPath()'s backward pass, where a late-start/late-finish
    // date landing on an excluded day needs the nearest EARLIER active day
    // instead of a later one.
    prevIncludedDayIndex(dayIdx) {
        let idx = dayIdx;
        for (let i = 0; i < 3650 && !this.isDayIncluded(idx); i++) idx--;
        return idx;
    }

    // Single indirection point for every item CRUD call site, so the rest
    // of the app (rendering, drag/drop, dependency cascade) never has to
    // know or care whether this project has been merged onto BackEndData
    // yet — it just calls this.ItemsDB.fetchAll/insert/update/remove(...)
    // exactly like it used to call this.DB.*(this.TABLES.items, ...).
    _setupItemsDB() {
        if (!this.UNIFIED_SCHEDULE) {
            // Unchanged behavior — just renamed. schedule_items still has
            // its own uuid id, created_at/updated_at columns, etc., so this
            // keeps using the generic DB adapter exactly as before.
            this.ItemsDB = {
                fetchAll: () => this.DB.fetchAll(this.TABLES.items),
                insert: row => this.DB.insert(this.TABLES.items, row),
                update: (id, patch) => this.DB.update(this.TABLES.items, id, patch),
                remove: id => this.DB.remove(this.TABLES.items, id)
            };
            return;
        }
        // Unified mode: BackEndData has no created_at/updated_at columns
        // and its rows are keyed by the day-encoded bigint id scheme (see
        // launchPadNumericId()/findFreeLaunchPadIndex() below), not a
        // Postgres-assigned uuid — this deliberately does NOT delegate to
        // the generic self.DB (which assumes both of those things), it's a
        // small bespoke implementation instead.
        // Every write below stages into `draft` (or, for a brand-new item,
        // stays local-only) instead of touching the live columns Scheduler
        // reads — see sync/add_draft_columns.sql. Only
        // _acceptPendingChangesUnified() ever commits a draft to the live
        // columns; _discardPendingChangesUnified() clears one instead.
        // predecessor_ids is the one exception (see the `update` branch
        // below) since Scheduler never reads it — nothing to stage.
        this.ItemsDB = {
            fetchAll: async () => {
                if (!this._supabase) return [];
                const { data, error } = await this._supabase.from(this.LAUNCHPAD_TABLE).select('*').order('day_label', { ascending: true }).order('id', { ascending: true });
                if (error) { console.error('ItemsDB.fetchAll failed', error); return []; }
                // draft_deleted rows are hidden from Bridge entirely — that
                // IS what "deleted" means here until Accept actually
                // removes the row. Collected separately since the item
                // itself is intentionally absent from the returned list,
                // so reloadAllData() couldn't otherwise tell they're
                // pending.
                this._unifiedDraftDeletedIds = new Set();
                const rows = (data || []).filter(row => {
                    if (row.draft_deleted) { this._unifiedDraftDeletedIds.add(String(row.id)); return false; }
                    // A live row is a real item once it has an activity; a
                    // purely-draft row (staged content on an otherwise-
                    // still-empty Scheduler placeholder slot) is also a
                    // real Bridge item even though its live `activity`
                    // column is blank.
                    return !!row.activity || !!row.draft;
                });
                return rows.map(row => this.backEndRowToItem(row));
            },
            insert: async (item) => {
                // Stays entirely local until Accept — inserting a real row
                // now (even just to reserve its day-slot) would make
                // Scheduler's applyScheduleDataToDom() mark that slot
                // "occupied" the instant the row exists, live columns or
                // not, showing an unexplained blank row before anything
                // should actually be visible there. uid() (already used
                // elsewhere in this file for the same "local placeholder
                // before a real id exists" purpose) can't collide with a
                // real numeric id.
                return { ...item, id: uid(), launchpad_id: null, launchpad_day_label: null, _localOnly: true, _pendingDraft: false };
            },
            update: async (id, patch) => {
                const current = this.DATA.items.find(it => it.id === id);
                if (!current) return null;

                if (current._localOnly) {
                    // Never left this browser yet — there's nothing server-
                    // side to stage a draft onto.
                    Object.assign(current, patch);
                    return current;
                }

                const patchKeys = Object.keys(patch);
                if (patchKeys.length === 1 && patchKeys[0] === 'predecessor_ids') {
                    // predecessor_ids never reaches Scheduler at all (it has
                    // no column for it) — nothing to review, and staging it
                    // would wrongly flag an unrelated item as "pending"
                    // whenever a move/delete elsewhere needs to fix up a
                    // dangling reference to it (see the remap loops in
                    // _acceptPendingChangesUnified()/deleteItemById()).
                    // Always written live.
                    const { error } = await this._supabase.from(this.LAUNCHPAD_TABLE)
                        .update({ predecessor_ids: this.numericPredecessorIds(patch) })
                        .eq('id', Number(id));
                    if (error) { console.error('ItemsDB.update (predecessor_ids) failed', error); return null; }
                    current.predecessor_ids = patch.predecessor_ids;
                    return current;
                }
                if (patchKeys.length === 1 && patchKeys[0] === 'superseded_by') {
                    // Same reasoning as predecessor_ids above: this is a
                    // Bridge-only display flag (see itemBarHtml()'s
                    // superseded styling), not a schedule change Scheduler
                    // needs to show or anyone needs to review — staging it
                    // into `draft` would wrongly mark a rescheduled
                    // activity's original row as "pending" until someone
                    // happens to Accept. Requires sync/schema.sql's
                    // superseded_by column on this project's BackEndData.
                    const { error } = await this._supabase.from(this.LAUNCHPAD_TABLE)
                        .update({ superseded_by: patch.superseded_by })
                        .eq('id', Number(id));
                    if (error) { console.error('ItemsDB.update (superseded_by) failed — has sync/schema.sql been run for this project?', error); return null; }
                    current.superseded_by = patch.superseded_by;
                    return current;
                }

                // Everything else — including a day change — just stages
                // into `draft` on this SAME row. No id churn, no
                // move_unified_schedule_row call: that only happens once,
                // at Accept, for whichever day the draft ends up with by
                // then (see _acceptPendingChangesUnified()).
                const merged = { ...current, ...patch };
                const dayLabel = patch.start_ts ? new Date(patch.start_ts).toISOString().slice(0, 10) : current.launchpad_day_label;
                const draft = this.itemToDraftPayload(merged, dayLabel);
                const { error } = await this._supabase.from(this.LAUNCHPAD_TABLE).update({ draft }).eq('id', Number(id));
                if (error) { console.error('ItemsDB.update (draft) failed — has sync/add_draft_columns.sql been run for this project?', error); return null; }
                Object.assign(current, patch);
                current.launchpad_day_label = dayLabel;
                current._pendingDraft = true;
                return current;
            },
            remove: async (id) => {
                const current = this.DATA.items.find(it => it.id === id);
                if (current && current._localOnly) return true; // never existed server-side to begin with
                const { error } = await this._supabase.from(this.LAUNCHPAD_TABLE).update({ draft_deleted: true }).eq('id', Number(id));
                if (error) { console.error('ItemsDB.remove (draft_deleted) failed', error); return false; }
                return true;
            }
        };
    }

    // Filters out any predecessor id that isn't a real, already-accepted
    // row id (a locally-created, not-yet-accepted item's uid()-style
    // temporary id, most commonly) — Number() on one of those is NaN,
    // which would silently corrupt the predecessor_ids column on write.
    numericPredecessorIds(item) {
        return (item.predecessor_ids || []).map(pid => Number(pid)).filter(n => Number.isFinite(n));
    }

    // Bridge item -> the JSON payload staged into `draft` — exactly
    // itemToBackEndRow()'s own row shape (same column names), minus `id`,
    // so a draft can be read back through the same field names whether
    // it's live or staged (see backEndRowToItem()'s `source` below).
    itemToDraftPayload(item, dayLabel) {
        const row = this.itemToBackEndRow(item, null, dayLabel);
        delete row.id;
        return row;
    }

    // BackEndData row -> Bridge's in-memory item shape. Mirrors the exact
    // field mapping pullFromLaunchPad()'s "import" branch already uses
    // (asset<->asset_name, activity<->activity_name, place<->zone,
    // trade_partners<->contractor_name), plus the 5 Bridge-only columns
    // added by sync/unify_backend_schedule.sql.
    //
    // item.id is deliberately a STRING (String(row.id)), not the raw
    // bigint — every drag/link/select handler in this file compares ids via
    // data-id DOM attributes (always strings) and ===, exactly like it
    // already does for schedule_items' uuid ids. Coercing back to a number
    // happens in exactly one place: right at the Supabase call inside
    // ItemsDB above.
    //
    // launchpad_id/launchpad_day_label are mirrored to the item's own
    // id/day_label rather than left unset — that's what keeps
    // findMatchingUnlinkedLaunchPadRow, the "linked to LaunchPad" badge, and
    // any other launchpad_id-gated logic working correctly without having
    // to special-case every one of those call sites for unified mode: a
    // unified item legitimately IS always "linked" to itself.
    // `source` is the live row itself normally, or row.draft when present
    // — draft is deliberately shaped exactly like a row (see
    // itemToDraftPayload()), so the same field names work either way. This
    // is what makes Bridge display a pending edit/move while Scheduler
    // (which never looks at `draft`) keeps showing the live values
    // underneath, untouched, until Accept.
    backEndRowToItem(row) {
        const hasDraft = !!row.draft;
        const source = hasDraft ? row.draft : row;
        const dayLabel = hasDraft ? (row.draft.day_label || row.day_label) : row.day_label;
        return {
            id: String(row.id),
            asset_name: source.asset || '',
            activity_name: source.activity || '',
            duration_hours: parseFloat(source.duration_hours) || 24,
            start_ts: new Date(dayLabel + 'T07:00').toISOString(),
            type: source.bridge_type || (this.DATA.types[0]?.name || 'Other'),
            area: source.area || '',
            asset_type: source.asset_type || '',
            contractor_name: source.trade_partners || '',
            notes: source.notes || '',
            predecessor_ids: Array.isArray(source.predecessor_ids) ? source.predecessor_ids.map(String)
                : (typeof source.predecessor_ids === 'string' ? (JSON.parse(source.predecessor_ids || '[]')).map(String) : []),
            launchpad_id: String(row.id),
            launchpad_day_label: dayLabel,
            _pendingDraft: hasDraft,
            // Always read off the live row, never `source` — this is
            // written live (see ItemsDB.update()'s special case above),
            // never staged into draft, so there's nothing draft-side to
            // prefer here the way every other field above does.
            superseded_by: row.superseded_by ? String(row.superseded_by) : null
        };
    }

    // Bridge item -> a BackEndData row patch. Only ever includes the
    // columns Bridge actually owns — day/time/place/activity/asset/notes/
    // trade_partners plus the 5 Bridge-only columns — never status/result/
    // loto, which belong to Scheduler alone. Leaving those keys out
    // entirely (not setting them to '') is what keeps Postgres's
    // ON CONFLICT DO UPDATE SET / plain UPDATE from touching them. Used
    // both for a real (accepted) row and, via itemToDraftPayload(), for
    // the `draft` jsonb payload — same shape either way.
    itemToBackEndRow(item, numericId, dayLabel) {
        return {
            id: numericId,
            day_label: dayLabel,
            activity: item.activity_name || '',
            asset: item.asset_name || '',
            // Zone has been retired — place (shared with Schedule's own
            // asset->place auto-fill map) is now fed by Area instead, so a
            // save here doesn't blank out whatever Schedule itself expects
            // to find in that column.
            place: item.area || '',
            trade_partners: item.contractor_name || '',
            notes: item.notes || '',
            duration_hours: item.duration_hours || 24,
            bridge_type: item.type || '',
            area: item.area || '',
            asset_type: item.asset_type || '',
            predecessor_ids: this.numericPredecessorIds(item)
        };
    }

    _initSupabase() {
        const injected = this.supabaseClient || window.launchpadSupabaseClient;
        this._supabase = injected || (SUPABASE_CONFIGURED && window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null);
    }

    // Shadow-scoped DOM helpers — replace the old document.getElementById /
    // document.querySelectorAll so lookups can't collide with the shell's
    // own ids or the other three views' shadow trees.
    $(id) { return this.shadowRoot.getElementById(id); }
    $$(sel) { return this.shadowRoot.querySelectorAll(sel); }

    // A document-level listener sees `event.target` retargeted to this
    // element itself (Shadow DOM retargeting) for anything that happened
    // inside the shadow tree — composedPath() is the correct way to find
    // the real originating element/ancestors from outside.
    _pathMatches(e, selector) {
        return e.composedPath().some(el => el.nodeType === 1 && el.matches && el.matches(selector));
    }

    async init() {
        this._setupGanttScrollListener();
        this._setupNewItemMenuReset();
        // Must be awaited, not fire-and-forgotten — connectedCallback() hands
        // this function's own return value out as _initPromise/whenReady()
        // specifically so callers like index.html's reschedule flow can wait
        // for the real data load (project flags, ItemsDB, first
        // reloadAllData()) to finish before reading this.DATA.items. Without
        // await here, init() was a plain sync function returning undefined,
        // so whenReady() resolved instantly instead of ever actually
        // waiting for initApp() to complete.
        await this.initApp();
    }

    // A document-level click listener sees `event.target` retargeted to this
    // element itself for anything that happened inside the shadow tree —
    // composedPath() (via _pathMatches()/composedPath().includes()) is used
    // throughout instead of e.target.closest()/.contains() for that reason.
    _handleOutsideClick(e) {
        const path = e.composedPath();
        this.$$('.filter-dropdown.open').forEach(dd => {
            if (!path.includes(dd) && !this._pathMatches(e, '.filter-chip-btn')) dd.classList.remove('open');
        });
        this.$$('.combo-list.open').forEach(cl => {
            if (!path.includes(cl) && !path.includes(cl.previousElementSibling)) cl.classList.remove('open');
        });
        this.$$('.menu-dropdown.open').forEach(md => {
            if (!path.includes(md) && !this._pathMatches(e, '.menu-btn-wrap')) md.classList.remove('open');
        });
        const contractorPopover = this.$('bulkContractorPopover');
        if (contractorPopover && contractorPopover.classList.contains('open') &&
            !path.includes(contractorPopover) && !this._pathMatches(e, '.bulk-contractor-btn')) {
            this.closeBulkContractorPicker();
        }
        // clicking empty gantt background (not an item, not the detail panel)
        // clears the connection focus so lines don't stay "stuck" on
        if (this.connectionFocusId && this._pathMatches(e, '#ganttWrap') &&
            !this._pathMatches(e, '.gantt-item') && !this._pathMatches(e, '#detailPanel')) {
            this.closeDetailPanel();
        }
    }

    // Public method the LaunchPad shell calls directly once it shows this tab
    // (replaces the old window.addEventListener('message', ...) listening for
    // a BRIDGE_VIEW_SHOWN postMessage). See the class-level comment for why a
    // fresh render is needed once this element actually becomes visible/sized.
    notifyVisible() {
        requestAnimationFrame(() => this.renderGantt());
    }

    // Defensive: re-measure and redraw connector lines on scroll, throttled to
    // one recompute per animation frame. The SVG overlay is positioned to
    // scroll naturally with its content, but forcing a fresh recompute here
    // guarantees the lines can never visually drift from the boxes they
    // connect, regardless of scroll position.
    _setupGanttScrollListener() {
        const wrap = this.$('ganttWrap');
        if (!wrap) return;
        wrap.addEventListener('scroll', () => {
            if (this.connScrollScheduled) return;
            this.connScrollScheduled = true;
            requestAnimationFrame(() => {
                this.connScrollScheduled = false;
                // a full connections rebuild replaces the SVG's contents
                // wholesale, which would wipe out the in-progress temp preview
                // line of an active link-drag — skip it until the drag ends,
                // since the real (saved) connections haven't changed anyway
                if (!this.linkDragCtx) this.renderConnections();
            });
        }, { passive: true });
    }

    // reset modal to "new item" state whenever opened fresh — was gated behind
    // DOMContentLoaded and found the button via a fragile onclick-attribute-text
    // selector; now runs from init() (elements already exist in the shadow
    // tree by then) and finds the button via its own id (see the markup).
    _setupNewItemMenuReset() {
        const btn = this.$('newItemMenuBtn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            this.$('itemModalTitle').textContent = 'New Schedule Item';
            this.$('itemId').value = '';
            this.$('itemAsset').value = '';
            this.$('itemActivity').value = '';
            this.$('itemDuration').value = 1;
            this.$('itemStart').value = this.toLocalInputValue(new Date());
            this.$('itemArea').value = '';
            this.renderContractorCheckboxList('itemContractorList', []);
            this.$('itemNotes').value = '';
            this.$('itemDeleteBtn').style.display = 'none';
            this.currentItemPredecessors = [];
            this.renderPredChips();
        });
    }

    _handleKeydown(e) {
        if (e.key === 'Escape' && this.multiSelectedIds.size) this.clearMultiSelect();
    }

    // index.html's toggleDarkMode() calls this directly (same pattern as
    // equipment-tracker-view.js's own setDarkMode()) since a custom element
    // isn't reachable via the iframe postMessage broadcast it also sends.
    setDarkMode(isDark) {
        this.classList.toggle('dark-mode', !!isDark);
    }

    _setupViewerRoleGating() {
        // A viewer can look at the schedule but can't drag/resize/edit items or
        // trigger add/bulk-add actions. Capture-phase so it intercepts before
        // the app's own drag/click handlers ever see the event. This used to
        // run at module-eval time (isViewerRole was a module-level const known
        // before any DOM existed) — now that role is resolved per-instance in
        // _resolveParams(), it has to run from connectedCallback() instead.
        if (!this.isViewerRole) return;

        // Hide the Add menu (New Item / Bulk Add / Import Baseline) outright —
        // a viewer shouldn't even see these options, not just be blocked from
        // using them. Also visually mark items as non-interactive. This CSS
        // used to be injected into the real document.head; it now lives in
        // STYLE under :host(.viewer-role-lockdown), toggled by this class.
        this.classList.add('viewer-role-lockdown');

        this._viewerGatingHandlers = ['pointerdown', 'mousedown', 'click', 'dblclick'].map(evt => {
            const handler = (e) => {
                const editSurface = this._pathMatches(e, '.gantt-item, .resize-handle, .link-handle, .menu-btn-wrap .tool-btn, .menu-item');
                // Filters/search/zoom/group-by and the "Clear filters" button stay
                // usable — those are read-only conveniences, not edits.
                const readOnlyOk = this._pathMatches(e, '#groupBySelect, #dayWidthSelect, #expandToggleBtn, #criticalPathToggle, #globalSearch, #clearAllFiltersBtn, .filter-chip');
                if (editSurface && !readOnlyOk) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (evt === 'click') this.showBridgeViewerUpsell();
                }
            };
            document.addEventListener(evt, handler, true);
            return { evt, handler };
        });
    }

    _teardownViewerRoleGating() {
        if (this._viewerGatingHandlers) {
            this._viewerGatingHandlers.forEach(({ evt, handler }) => document.removeEventListener(evt, handler, true));
            this._viewerGatingHandlers = null;
        }
    }

    /* ---------- 1b. EDIT LOCK ----------
       Separate from viewer-role gating above (that's a fixed, permanent
       lockout for the "viewer" role; this is a per-session toggle for
       editors — everyone starts locked on every fresh load, and has to
       deliberately click 🔒 Edit before anything can be dragged, resized,
       connected, added, or deleted). Rather than a parallel document-level
       capture-phase interceptor, this guards the handful of actual mutation
       entry points directly (startDrag(), the connect-drag pointerdown in
       attachLinkHandlers(), saveItemModal(), deleteItemById(),
       commitBulkAdd(), and the Add-menu open) — simpler to reason about
       than trying to keep a separate selector list in sync with every
       editable surface, and it composes cleanly with the existing viewer
       lockdown (a viewer is already blocked upstream by that mechanism, so
       requireEditMode() below defers to it rather than duplicating it). */
    requireEditMode() {
        if (this.isViewerRole) return false; // _setupViewerRoleGating() already intercepted this and showed its own upsell
        if (!this.editModeActive) {
            this.toast('Click 🔒 Edit to turn on editing before making changes.', 3000);
            return false;
        }
        return true;
    }
    toggleEditMode() {
        this.editModeActive = !this.editModeActive;
        this.updateEditModeUI();
        this.toast(this.editModeActive
            ? 'Edit mode on — activities can now be dragged, resized, connected, added, and deleted.'
            : 'Edit mode off — activities are locked from accidental changes.', 3200);
    }
    updateEditModeUI() {
        const btn = this.$('editModeToggleBtn');
        if (btn) {
            btn.classList.toggle('primary', this.editModeActive);
            btn.textContent = this.editModeActive ? '🔓 Editing' : '🔒 Edit';
        }
        this.classList.toggle('edit-locked', !this.isViewerRole && !this.editModeActive);
        // Re-apply to whichever item modal is currently open (if any) so
        // toggling mid-edit immediately enables/disables its fields —
        // harmless no-op if the modal isn't open.
        this.applyItemModalLockState();
    }
    // Called from editItem() every time the modal opens, and from
    // updateEditModeUI() so flipping the toggle while it's already open
    // takes effect immediately. Viewing an item's details while locked is
    // still allowed (that's why editItem() itself isn't gated by
    // requireEditMode() — only the actual mutation actions are); this is
    // what makes that view read-only rather than silently no-op'ing on Save.
    applyItemModalLockState() {
        const modal = this.$('itemModal');
        if (!modal) return;
        const locked = !this.isViewerRole && !this.editModeActive;
        modal.classList.toggle('readonly-locked', locked);
        modal.querySelectorAll('.modal-body input, .modal-body select, .modal-body textarea').forEach(el => { el.disabled = locked; });
        const saveBtn = this.$('itemSaveBtn');
        if (saveBtn) saveBtn.disabled = locked;
        if (locked) {
            const delBtn = this.$('itemDeleteBtn');
            if (delBtn) delBtn.style.display = 'none';
        }
    }


    /* ---------- 2. DATA LAYER ---------- */
    /* Every function below transparently uses Supabase when configured,
       otherwise falls back to an in-browser localStorage store so the tool
       is fully usable for evaluation before credentials are wired in.
       "types" and each zone's end date always use localStorage, Supabase or
       not, since {PROJECT_KEY}dropdownoptions has no columns for them. */

    loadLocalStore() {
        try {
            const raw = localStorage.getItem(LOCAL_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return null;
    }
    saveLocalStore() {
        try { localStorage.setItem(LOCAL_KEY, JSON.stringify(this.DATA)); } catch (e) {}
    }
    loadLocalTypes() {
        try {
            const raw = localStorage.getItem(TYPES_LOCAL_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return null;
    }
    saveLocalTypes(list) {
        try { localStorage.setItem(TYPES_LOCAL_KEY, JSON.stringify(list)); } catch (e) {}
    }
    loadZoneEndDates() {
        try {
            const raw = localStorage.getItem(ZONE_ENDDATE_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return {};
    }
    saveZoneEndDates(map) {
        try { localStorage.setItem(ZONE_ENDDATE_KEY, JSON.stringify(map)); } catch (e) {}
    }
    getZoneEndDate(zoneName) { return this.ZONE_END_DATES[zoneName] || null; }
    setZoneEndDate(zoneName, dateStr) {
        if (dateStr) this.ZONE_END_DATES[zoneName] = dateStr; else delete this.ZONE_END_DATES[zoneName];
        this.saveZoneEndDates(this.ZONE_END_DATES);
    }





    /* ---------- 3. GLOBAL STATE (now instance fields — see constructor) ---------- */
    loadActivityColors() {
        try {
            const raw = localStorage.getItem(ACTIVITY_COLORS_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return {};
    }
    saveActivityColorsMap(map) {
        try { localStorage.setItem(ACTIVITY_COLORS_KEY, JSON.stringify(map)); } catch (e) {}
    }
    activityColor(activityName) {
        if (!activityName) return '#757575';
        if (this.ACTIVITY_COLORS[activityName]) return this.ACTIVITY_COLORS[activityName];
        const usedCount = Object.keys(this.ACTIVITY_COLORS).length;
        const color = ACTIVITY_COLOR_PALETTE[usedCount % ACTIVITY_COLOR_PALETTE.length];
        this.ACTIVITY_COLORS[activityName] = color;
        this.saveActivityColorsMap(this.ACTIVITY_COLORS);
        return color;
    }
    setActivityColor(activityName, color) {
        this.ACTIVITY_COLORS[activityName] = color;
        this.saveActivityColorsMap(this.ACTIVITY_COLORS);
    }

    seedDemoData() {
        if (this.DATA_STORE.zones && this.DATA_STORE.zones.length) return; // already seeded
        const today0 = new Date(); today0.setHours(0, 0, 0, 0);
        const zoneEndDaysOut = [14, 18, 21, 25]; // demo target end dates, days from today
        const zones = ['Zone A', 'Zone B', 'Zone C', 'Zone D'].map(n => ({ id: uid(), name: n, created_at: new Date().toISOString() }));
        zones.forEach((z, i) => {
            const d = new Date(today0); d.setDate(d.getDate() + zoneEndDaysOut[i]);
            this.setZoneEndDate(z.name, d.toISOString().slice(0, 10));
        });
        const areas = ['Level 1', 'Level 2', 'Roof', 'Yard'].map(n => ({ id: uid(), name: n, created_at: new Date().toISOString() }));
        const contractors = ['Apex Mechanical', 'Volt Electric', 'FlowRight Plumbing'].map(n => ({ id: uid(), name: n, created_at: new Date().toISOString() }));
        const assets = ['AHU-101', 'Pump-201', 'Panel-A1', 'Chiller-01', 'Duct Run 3', 'Switchgear-2'].map(n => ({ id: uid(), name: n, created_at: new Date().toISOString() }));
        const activities = ['Set Equipment', 'Rough-In Piping', 'Pull Wire', 'Terminate & Test', 'Insulate', 'Commission'].map(n => ({ id: uid(), name: n, created_at: new Date().toISOString() }));
        const types = DEFAULT_TYPE_COLORS.map(t => ({ ...t, created_at: new Date().toISOString() }));
        this.saveLocalTypes(types);

        const today = new Date(); today.setHours(7, 0, 0, 0);
        const items = [];
        for (let i = 0; i < 10; i++) {
            const start = new Date(today);
            start.setDate(start.getDate() + Math.floor(i / 2));
            start.setHours(7 + (i % 2) * 5, 0, 0, 0);
            const t = types[i % types.length];
            items.push({
                id: uid(),
                asset_id: assets[i % assets.length].id,
                asset_name: assets[i % assets.length].name,
                activity_id: activities[i % activities.length].id,
                activity_name: activities[i % activities.length].name,
                contractor_id: contractors[i % contractors.length].id,
                contractor_name: contractors[i % contractors.length].name,
                type: t.name,
                zone: zones[i % zones.length].name,
                area: areas[i % areas.length].name,
                asset_type: 'Equipment',
                start_ts: start.toISOString(),
                duration_hours: [3, 4, 6, 8][i % 4],
                notes: '',
                predecessor_ids: [],
                created_at: new Date().toISOString()
            });
        }
        // demo dependency chain: item 0 -> item 2 -> item 4, so the sync/flow
        // features have something to show out of the box
        if (items[2]) items[2].predecessor_ids = [items[0].id];
        if (items[4]) items[4].predecessor_ids = [items[2].id];

        this.DATA_STORE = { items, assets, activities, contractors, zones, areas };
        this.saveLocalStore();
    }

    /* ---------- 4. INIT ---------- */
    async initApp() {
        if (!this._supabase) {
            this.seedDemoData();
            this.$('projectSubtitle').textContent = 'Demo mode (local storage) — add Supabase URL/key in the script to go live';
        } else {
            this.$('projectSubtitle').textContent = 'Connected to Supabase';
        }
        // Must resolve UNIFIED_SCHEDULE (and set TABLES.items/ItemsDB
        // accordingly) before reloadAllData() below, or the very first load
        // would hit the wrong table.
        await this._resolveProjectFlags();
        await this.reloadAllData();
        await this.fetchAssetLookupMaps();
        this.loadPendingSyncState();
        this.updatePendingSyncUI();
        this.updateEditModeUI(); // sets the 🔒 Edit button's initial label and applies the locked cursor/handle CSS
        this.initTimelineRangeInputs();
        this.renderFilterBar();
        this.renderLegend();
        this.renderGantt();
        this.initWaterfallSyncedScroll();
        this.updateLaunchPadSyncBtn();
        this.setSaveIndicator('ready', 'Ready');
        if (this._supabase) {
            this.refreshAllStatuses().catch(err => console.error('Background status refresh failed', err));
            this.initLaunchPadRealtimeSync();
            // The whole push/pull reconciliation layer only makes sense
            // while this project still has two separate tables. Once
            // UNIFIED_SCHEDULE is on, ItemsDB already reads/writes
            // BackEndData directly — there's nothing left to pull or repair.
            //
            // pullFromLaunchPad()/repairLaunchPadLinks()/
            // repairPredecessorOrdering()/repairStaleScheduleLinks() were
            // each individually "chained, not parallel, with itself" (see
            // the old comment on the ordering-violation pair below), but
            // ran in parallel WITH EACH OTHER — all fired un-awaited in
            // the same initApp(). Confirmed causing real damage in
            // production on MSA3A: pullFromLaunchPad() pulls Schedule's
            // day_label back into Bridge and resets start_ts if they
            // disagree; repairPredecessorOrdering() pushes a successor
            // forward and publishes that same change to Schedule. Two
            // of these running concurrently on the same items raced —
            // one re-reading Schedule before the other's write had
            // landed, "fixing" what wasn't actually broken, each
            // publish re-triggering the realtime listener below into
            // yet another pull — compounding into real activities
            // drifting weeks to months forward and their Schedule rows
            // being deleted/recreated over a dozen times in minutes.
            // runBackgroundSweep() now serializes every one of these
            // (this call, and the realtime-triggered pulls in
            // initLaunchPadRealtimeSync() below) onto one shared queue
            // so only ever one is touching this project's schedule data
            // at a time.
            if (!this.UNIFIED_SCHEDULE) {
                this.runBackgroundSweep(() => this.pullFromLaunchPad()).catch(err => console.error('Background LaunchPad pull failed', err));
                // Repair Links no longer has a menu button to trigger it
                // manually — running it once on load keeps that self-healing
                // happening automatically instead of only on request.
                this.runBackgroundSweep(() => this.repairLaunchPadLinks()).catch(err => console.error('Background LaunchPad link repair failed', err));
            }
            // Ordering-violation sweep applies either way — it's about the
            // predecessor_ids graph itself, not how it syncs to Schedule.
            this.runBackgroundSweep(() => this.repairPredecessorOrdering())
                .catch(err => { console.error('Background predecessor ordering repair failed', err); return 0; })
                .then(() => this.runBackgroundSweep(() => this.repairStaleScheduleLinks()))
                .catch(err => console.error('Background stale-schedule-link repair failed', err));
        }
    }

    // Without this, the ONLY way Bridge ever found out about an activity
    // being moved/edited directly in the Schedule module was someone
    // manually clicking "Pull from LaunchPad" — an edit made there could
    // sit unreflected in Bridge indefinitely. Subscribes to live changes on
    // the LaunchPad schedule table and runs the same reconciliation pullFromLaunchPad()
    // already does, automatically. Debounced (rather than pulling on every
    // single row event) since a burst of changes — someone dragging several
    // cells, or the sync workflow writing many rows — would otherwise
    // trigger a full reconciliation pass per row instead of one pass after
    // things settle. This also fires from Bridge's own pushes (writing to
    // the table broadcasts back to every subscriber, itself included), but
    // that's a harmless no-op pull since bestRow already matches what was
    // just written.
    // Shared serialization point for every background reconciliation sweep
    // that reads and/or rewrites this project's schedule data —
    // pullFromLaunchPad(), repairLaunchPadLinks(), repairPredecessorOrdering(),
    // repairStaleScheduleLinks(), and the realtime-triggered pull in
    // initLaunchPadRealtimeSync() below. Each call to fn is chained onto
    // whatever's already queued, same pattern as syncItemToLaunchPad()'s
    // own per-item queue, so two of these can never run concurrently and
    // race each other over the same items — see the comment on initApp()'s
    // own calls for the production incident this closes.
    runBackgroundSweep(fn) {
        this._bgSweepQueue = this._bgSweepQueue || Promise.resolve();
        const run = this._bgSweepQueue.then(fn, fn);
        this._bgSweepQueue = run.catch(() => {});
        return run;
    }

    initLaunchPadRealtimeSync() {
        if (!this._supabase || !this.LAUNCHPAD_TABLE) return;
        try {
            // Stored so disconnectedCallback() can actually unsubscribe it —
            // without that, tearing this element down and remounting a
            // fresh one (switchMainView()'s teardownCustomElementView(),
            // which this app calls on every tab switch away from Bridge)
            // leaves this channel orphaned but still subscribed. The next
            // mount's call to this same method then asks Supabase's client
            // to add .on() callbacks to a channel of the same name that
            // never went away, which throws synchronously — and since this
            // runs unguarded partway through initApp(), that throw silently
            // skipped every repair/pull sweep after it for that whole
            // session. Confirmed in production.
            this._realtimeChannel = this._supabase
                .channel(`bridge-schedule-sync-${this.LAUNCHPAD_TABLE}`)
                .on('postgres_changes', { event: '*', schema: 'public', table: this.LAUNCHPAD_TABLE }, () => {
                    clearTimeout(this._launchpadPullDebounce);
                    this._launchpadPullDebounce = setTimeout(() => {
                        // Unified projects: BackEndData IS this.ItemsDB's own
                        // table, so a change there (including one Scheduler
                        // just typed directly) is a change to Bridge's own item
                        // list — just reload it, no reconciliation heuristics
                        // needed since there's exactly one row per activity by
                        // construction. Legacy projects keep the existing
                        // two-table reconciliation pull.
                        // Routed through the same runBackgroundSweep() queue
                        // as initApp()'s own sweeps — a change event firing
                        // while one of those is still mid-cascade must wait
                        // its turn rather than pulling a still-in-progress
                        // snapshot and "fixing" it right out from under them.
                        const reload = this.UNIFIED_SCHEDULE
                            ? this.runBackgroundSweep(() => this.reloadAllData().then(() => { this.renderFilterBar(); this.renderGantt(); }))
                            : this.runBackgroundSweep(() => this.pullFromLaunchPad());
                        reload.catch(err => console.error('Realtime-triggered LaunchPad sync failed', err));
                    }, 1200);
                })
                .subscribe();
        } catch (e) {
            // Must never take the rest of initApp() down with it — see the
            // comment above for exactly what that cost before this guard
            // existed.
            console.error('Realtime sync setup failed (continuing without live updates)', e);
        }
    }

    // Mirrors LaunchPad's own assetToPlaceMap approach exactly: fetch every
    // row of {PROJECT_KEY}dropdownoptions and, wherever an Asset and a Zone/Place
    // appear together on the same row, remember that pairing — so picking an
    // Asset elsewhere in the app can auto-fill its Zone/Area the same way
    // LaunchPad does, instead of asking the user to pick them separately.
    async fetchAssetLookupMaps() {
        if (!this._supabase) { this.ASSET_TO_ZONE_MAP = {}; this.ASSET_TO_AREA_MAP = {}; return; }
        const { data, error } = await this._supabase
            .from(this.TABLES.dropdowns)
            .select('Assets, Zone, Places')
            .range(0, 1000);
        if (error) { console.error('Asset lookup fetch failed', error); return; }
        const zoneMap = {}, areaMap = {};
        (data || []).forEach(row => {
            const asset = row.Assets?.toString().trim();
            const zone = row.Zone?.toString().trim();
            const place = row.Places?.toString().trim();
            if (asset && zone) zoneMap[asset] = zone;
            if (asset && place) areaMap[asset] = place;
        });
        this.ASSET_TO_ZONE_MAP = zoneMap;
        this.ASSET_TO_AREA_MAP = areaMap;
    }

    async reloadAllData() {
        const [items, assets, activities, contractors, zones, areas, types] = await Promise.all([
            this.ItemsDB.fetchAll(), this.DB.fetchAll(this.TABLES.assets), this.DB.fetchAll(this.TABLES.activities),
            this.DB.fetchAll(this.TABLES.contractors), this.DB.fetchAll(this.TABLES.zones), this.DB.fetchAll(this.TABLES.areas), this.DB.fetchAll(this.TABLES.types)
        ]);
        // Supabase/PostgREST often serializes `numeric` columns as strings (to
        // avoid float precision loss), which would silently turn every
        // duration calculation into string concatenation instead of math.
        // Coerce once here so every consumer downstream gets a real number.
        items.forEach(it => {
            it.duration_hours = parseFloat(it.duration_hours) || 4;
            if (typeof it.predecessor_ids === 'string') {
                try { it.predecessor_ids = JSON.parse(it.predecessor_ids); } catch (e) { it.predecessor_ids = []; }
            }
            if (!Array.isArray(it.predecessor_ids)) it.predecessor_ids = [];
        });
        // Local-only pending creations (unified mode, never yet accepted)
        // live purely in this browser's memory — ItemsDB.fetchAll() can't
        // see them (there's no row to fetch), so a fresh load would
        // otherwise silently drop them.
        const localOnlyItems = this.UNIFIED_SCHEDULE ? (this.DATA.items || []).filter(it => it._localOnly) : [];
        this.DATA.items = items.concat(localOnlyItems); this.DATA.assets = assets; this.DATA.activities = activities;
        this.DATA.contractors = contractors; this.DATA.zones = zones; this.DATA.areas = areas;
        this.DATA.types = types.length ? types : DEFAULT_TYPE_COLORS;

        if (this.UNIFIED_SCHEDULE) {
            // Drafts are server-shared state now, not per-browser —
            // rebuilding these from what was actually fetched (plus
            // whatever locally-tracked new items survived above) is what
            // makes another session's pending edits/deletes show up in
            // THIS session's banner too, and keeps a realtime-triggered
            // reload's banner state accurate.
            const draftIds = items.filter(it => it._pendingDraft).map(it => it.id);
            const localOnlyIds = localOnlyItems.map(it => it.id);
            this.pendingSyncIds = new Set([...draftIds, ...localOnlyIds]);
            this.pendingDeleteLaunchPadIds = new Set(this._unifiedDraftDeletedIds || []);
            this.updatePendingSyncUI();
        }
    }

    computeTimelineStart() {
        const base = new Date();
        base.setHours(0, 0, 0, 0);
        return base;
    }

    // Timeline range — set explicitly via the start/end date bar at the
    // bottom of the page instead of scrolling/jumping. "Use last activity"
    // for the end date keeps it pinned to whatever the latest scheduled item
    // currently is, updating automatically as the schedule changes.
    latestActivityDate() {
        let latest = null;
        this.DATA.items.forEach(it => {
            const end = new Date(new Date(it.start_ts).getTime() + it.duration_hours * 3600000);
            if (!latest || end > latest) latest = end;
        });
        return latest;
    }
    applyTimelineRange() {
        const startInput = this.$('rangeStartInput');
        const endInput = this.$('rangeEndInput');
        const useLast = this.$('useLastActivityEnd').checked;
        endInput.disabled = useLast;
        if (useLast) {
            const latest = this.latestActivityDate();
            if (latest) {
                // Pad at least a month past the last scheduled activity,
                // even though nothing's actually planned in that stretch —
                // keeps room visible for rescheduling/dragging activities
                // out further instead of the timeline dead-ending exactly
                // where the last activity happens to sit today.
                const padded = new Date(latest);
                padded.setDate(padded.getDate() + 30);
                endInput.value = padded.toISOString().slice(0, 10);
            }
        }
        const startVal = startInput.value, endVal = endInput.value;
        if (!startVal || !endVal) return;
        const start = new Date(startVal + 'T00:00');
        const end = new Date(endVal + 'T00:00');
        const days = Math.max(1, Math.round((end - start) / 86400000) + 1);
        this.TIMELINE_START = start;
        this.TIMELINE_DAYS = days;
        this.renderGantt();
    }
    // The Start/End inputs above already let someone pick any window, but
    // typing two dates every time you just want "this week" or "everything"
    // is friction most people won't bother with — these are the same
    // mechanism (they just fill in the inputs and call applyTimelineRange()),
    // one click instead of two date entries.
    applyTimelineRangePreset(preset) {
        const start = this.computeTimelineStart();
        const useLastCheckbox = this.$('useLastActivityEnd');
        this.$('rangeStartInput').value = start.toISOString().slice(0, 10);
        if (preset === 'full') {
            useLastCheckbox.checked = true;
        } else {
            const days = { week: 6, month: 29, quarter: 89 }[preset] ?? 6;
            const end = new Date(start.getTime() + days * 86400000);
            useLastCheckbox.checked = false;
            this.$('rangeEndInput').value = end.toISOString().slice(0, 10);
        }
        this.applyTimelineRange();
    }
    initTimelineRangeInputs() {
        const start = this.computeTimelineStart();
        const useLast = this.$('useLastActivityEnd');
        const latest = this.latestActivityDate();
        const end = latest ? new Date(latest) : new Date(start.getTime() + 41 * 86400000);
        this.$('rangeStartInput').value = start.toISOString().slice(0, 10);
        this.$('rangeEndInput').value = end.toISOString().slice(0, 10);
        useLast.checked = !!latest;
        this.$('rangeEndInput').disabled = !!latest;
        this.applyTimelineRange();
    }

    /* ---- small UI helpers ---- */
    setSaveIndicator(state, text) {
        const el = this.$('saveIndicator');
        el.textContent = text;
        el.className = state === 'error' ? 'error' : (state === 'dirty' ? 'dirty' : '');
    }
    toast(msg, ms = 2600) {
        const t = this.$('toast');
        t.textContent = msg;
        t.style.display = 'block';
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => t.style.display = 'none', ms);
    }
    openModal(id) { this.$(id).classList.add('open'); }
    closeModal(id) {
        this.$(id).classList.remove('open');
        if (id === 'bulkModal') this.closeBulkContractorPicker();
    }
    switchTab(group, name, evt) {
        // evt is passed explicitly from each button's onclick below rather
        // than relying on the bare global `event` this used to reference —
        // that only works via the legacy, non-standard window.event
        // (Firefox doesn't support it at all), so on any browser without it
        // this threw a ReferenceError right here and aborted before ever
        // reaching the panel-switching lines below. That's why clicking any
        // tab other than the one already active did nothing.
        this.$$(`#${group === 'bulkTab' ? 'bulkModal' : (group === 'listsTab' ? 'listsModal' : '')} .tab-btn`).forEach(b => b.classList.remove('active'));
        if (evt && evt.target) evt.target.classList.add('active');
        this.$$(`[id^="${group}-"]`).forEach(p => p.classList.remove('active'));
        this.$(`${group}-${name}`).classList.add('active');
        if (group === 'listsTab') this.renderListsManager();
    }
    populateSelect(id, values, allowBlank) {
        const sel = this.$(id);
        if (!sel) return;
        const prev = sel.value;
        sel.innerHTML = (allowBlank ? '<option value="">—</option>' : '') + values.map(v => `<option value="${escAttr(v)}">${escHtml(v)}</option>`).join('');
        if (values.includes(prev)) sel.value = prev;
    }


    toggleMenu(id, ev) {
        ev.stopPropagation();
        const dd = this.$(id);
        const wasOpen = dd.classList.contains('open');
        this.closeAllMenus();
        if (!wasOpen) dd.classList.add('open');
    }
    closeAllMenus() {
        this.$$('.menu-dropdown.open').forEach(d => d.classList.remove('open'));
    }



    /* =========================================================================
       5. FILTER BAR — drill-down faceted filtering
       Selecting a value in one facet narrows the available options in the
       others (classic faceted / drill-down search pattern).
       ========================================================================= */

    itemMatchesFilters(item, exceptKey) {
        for (const def of FILTER_DEFS) {
            if (def.key === exceptKey) continue;
            const set = this.FILTERS[def.key];
            if (set.size === 0) continue;
            if (def.key === 'contractor') {
                const names = (item.contractor_name || '').split('|').map(s => s.trim()).filter(Boolean);
                if (!names.some(n => set.has(n))) return false;
            } else if (!set.has(item[def.field])) return false;
        }
        return true;
    }

    passesGlobalSearch(item) {
        const q = (this.$('globalSearch')?.value || '').trim().toLowerCase();
        if (!q) return true;
        const hay = [item.asset_name, item.activity_name, item.contractor_name, item.area, item.notes].join(' ').toLowerCase();
        return hay.includes(q);
    }

    passesCriticalPathFilter(item) {
        if (!this.showCriticalPath) return true;
        if (!this.criticalPathData) return true; // computation unavailable this render — don't hide everything
        const f = this.criticalPathData.floatById[item.id];
        return f !== null && f !== undefined && f <= 0.01;
    }

    getFilteredItems() {
        return this.DATA.items.filter(it => this.itemMatchesFilters(it, null) && this.passesGlobalSearch(it) && this.passesCriticalPathFilter(it));
    }

    renderFilterBar() {
        const bar = this.$('filterToolbar');
        // remove old chips (keep clear-all button + spacer + search + selects)
        bar.querySelectorAll('.filter-chip').forEach(c => c.remove());
        const clearBtn = this.$('clearAllFiltersBtn');

        FILTER_DEFS.forEach(def => {
            const chip = document.createElement('div');
            chip.className = 'filter-chip';
            const activeCount = this.FILTERS[def.key].size;
            chip.innerHTML = `
                <button class="filter-chip-btn ${activeCount ? 'active' : ''}" onclick="this.getRootNode().host.toggleFilterDropdown('${def.key}', event)">
                    ${def.label} ${activeCount ? `<span class="count-badge">${activeCount}</span>` : '▾'}
                </button>
                <div class="filter-dropdown" id="dd-${def.key}"></div>`;
            bar.insertBefore(chip, clearBtn);
        });
        this.renderAllDropdownContents();
    }

    toggleFilterDropdown(key, ev) {
        ev.stopPropagation();
        const dd = this.$(`dd-${key}`);
        const wasOpen = dd.classList.contains('open');
        this.$$('.filter-dropdown.open').forEach(d => d.classList.remove('open'));
        if (!wasOpen) { this.renderDropdownContent(key); dd.classList.add('open'); }
    }

    renderAllDropdownContents() {
        FILTER_DEFS.forEach(def => this.renderDropdownContent(def.key));
    }

    renderDropdownContent(key) {
        const def = FILTER_DEFS.find(d => d.key === key);
        const dd = this.$(`dd-${key}`);
        if (!dd) return;

        // Drill-down: available option set is derived from items that already
        // match every OTHER active facet (so choosing Area narrows Zone, etc).
        const candidatePool = this.DATA.items.filter(it => this.itemMatchesFilters(it, key));
        const counts = {};
        candidatePool.forEach(it => {
            if (key === 'contractor') {
                (it.contractor_name || '').split('|').map(s => s.trim()).filter(Boolean).forEach(name => {
                    counts[name] = (counts[name] || 0) + 1;
                });
                return;
            }
            const v = it[def.field];
            if (!v) return;
            counts[v] = (counts[v] || 0) + 1;
        });
        // also include values that exist in the master list even if 0 in current pool, greyed out
        let allValues = [];
        if (key === 'type') allValues = this.DATA.types.map(t => t.name);
        else if (key === 'zone') allValues = this.DATA.zones.map(z => z.name);
        else if (key === 'area') allValues = this.DATA.areas.map(a => a.name);
        else if (key === 'activity') allValues = this.DATA.activities.map(a => a.name);
        else if (key === 'asset') allValues = this.DATA.assets.map(a => a.name);
        else if (key === 'asset_type') allValues = [...new Set(this.DATA.items.map(i => i.asset_type).filter(Boolean))];
        else if (key === 'contractor') allValues = this.DATA.contractors.map(c => c.name);
        allValues = [...new Set([...allValues, ...Object.keys(counts)])].sort();

        const searchId = `ddsearch-${key}`;
        dd.innerHTML = `
            <input class="search" placeholder="Search ${def.label.toLowerCase()}..." id="${searchId}" oninput="this.getRootNode().host.filterDropdownOptions('${key}', this.value)">
            <div id="ddopts-${key}"></div>`;
        this.renderDropdownOptions(key, allValues, counts);
    }

    renderDropdownOptions(key, allValues, counts) {
        const holder = this.$(`ddopts-${key}`);
        if (!holder) return;
        holder.innerHTML = allValues.map(v => {
            const c = counts[v] || 0;
            const checked = this.FILTERS[key].has(v);
            const disabled = c === 0 && !checked ? 'disabled' : '';
            const swatch = key === 'activity' ? `<span class="swatch" style="background:${this.activityColor(v)}"></span>` : '';
            return `<label class="filter-option ${disabled}">
                <input type="checkbox" ${checked ? 'checked' : ''} onchange="this.getRootNode().host.toggleFilterValue('${key}','${escAttr(v).replace(/'/g, "\\'")}')">
                ${swatch}<span style="flex:1;">${escHtml(v)}</span><span style="color:#999; font-size:11px;">${c}</span>
            </label>`;
        }).join('') || '<div style="padding:10px; color:#999; font-size:12px;">No options</div>';
    }

    filterDropdownOptions(key, query) {
        const q = query.toLowerCase();
        this.$$(`#ddopts-${key} .filter-option`).forEach(opt => {
            opt.style.display = opt.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
        });
    }

    toggleFilterValue(key, value) {
        if (this.FILTERS[key].has(value)) this.FILTERS[key].delete(value); else this.FILTERS[key].add(value);
        this.renderFilterBar();
        // reopen the dropdown that was just used
        this.$(`dd-${key}`).classList.add('open');
        this.renderGantt();
        this.scrollWaterfallToTop();
    }

    clearAllFilters() {
        FILTER_DEFS.forEach(d => this.FILTERS[d.key].clear());
        this.renderFilterBar();
        this.renderGantt();
        this.scrollWaterfallToTop();
    }

    /* ---- Type legend + type swatch pickers (used in modals) ---- */
    renderLegend() {
        const el = this.$('typeLegend');
        const activityNames = [...new Set(this.DATA.items.map(i => i.activity_name).filter(Boolean))].sort();
        el.innerHTML = activityNames.map(name => `<span class="legend-item"><span class="legend-swatch" style="background:${this.activityColor(name)}"></span>${escHtml(name)}</span>`).join('')
            || '<span style="color:#999; font-size:11.5px;">No activities scheduled yet</span>';
    }

    buildTypePicker(containerId) {
        this.populateSelect(containerId, this.DATA.types.map(t => t.name), false);
    }

    /* =========================================================================
       6. GANTT — horizontal timeline, grouped swim-lanes, draggable/resizable bars
       Overlapping items within a row cascade vertically (stacked lanes) so
       nothing is ever hidden behind another item. Rows can be manually resized
       or expanded to a dedicated fullscreen view. Dependency links (predecessor
       -> successor) are drawn as connector lines and enforced so a successor
       can never sit ahead of its predecessor.
       ========================================================================= */

    setDayWidth(v) {
        this.DAY_WIDTH = parseInt(v, 10);
        this.style.setProperty('--daywidth', this.DAY_WIDTH + 'px');
        this.renderGantt();
    }

    dayIndexForDate(d) {
        const ms = d.setHours ? d - this.TIMELINE_START : new Date(d) - this.TIMELINE_START;
        return ms / 86400000;
    }
    // Below Normal(220)/Wide(360) with plenty of margin — covers Overview
    // (14), Overview Extended (45) and Compact (80) alike, safely
    // identifying all three even if their exact pixel values get tuned
    // later. Every day still gets its own full-width column at every zoom
    // level (no days are cut) — this only controls the activity-name label
    // being hidden in favor of color-coding.
    get isCompactZoom() { return this.DAY_WIDTH <= 90; }
    // True for Overview AND Overview Extended — both render as a
    // long-range, one-row-per-activity waterfall task list (see
    // renderGantt()) instead of the normal grouped/packed rows, and both
    // get the thinnest possible row height (see estimateItemHeight()/
    // computeLaneOffsets()) since there's exactly one bar per row.
    get isWaterfallZoom() { return this.DAY_WIDTH <= 50; }
    // Overview only (not Extended) — narrow enough that even the asset name
    // has no room, so bars fall back to pure color, and the header groups
    // by month instead of showing each individual day (see
    // buildGanttHeaderHtml()). Overview Extended shows real day columns and
    // keeps the asset name, same as Compact does.
    get isOverviewZoom() { return this.DAY_WIDTH <= 16; }
    xForItem(item) {
        return this.dayIndexForDate(new Date(item.start_ts)) * this.DAY_WIDTH;
    }
    widthForItem(item) {
        return Math.max(24, (item.duration_hours / 24) * this.DAY_WIDTH);
    }
    itemEndMs(item) {
        return new Date(item.start_ts).getTime() + item.duration_hours * 3600000;
    }

    /* At every zoom level except "Wide", activities fill the entire width of
       the day they start on — the schedule reads as day-granularity blocks
       rather than precise hour-slivers. The one exception: if an item shares
       its calendar day with a linked predecessor/successor in the same lane,
       the day is split evenly between them instead, so linked same-day work
       still shows as distinct, side-by-side steps. */
    isDayBlockMode() {
        // day-block sizing (full-day-width bars, splitting only for same-day
        // linked activities) now applies at every zoom level — duration is
        // edited in days throughout the app, so there's no more "precise
        // hours" mode to fall back to; "Wide" just means more pixels per day.
        return true;
    }
    displayLeft(item) {
        return this.isDayBlockMode() ? (item._blockLeft ?? this.xForItem(item)) : this.xForItem(item);
    }
    displayWidth(item) {
        return this.isDayBlockMode() ? (item._blockWidth ?? this.widthForItem(item)) : this.widthForItem(item);
    }
    assignDayBlockPositions(items) {
        const groups = {};
        items.forEach(it => {
            const dayIdx = Math.floor(this.dayIndexForDate(new Date(it.start_ts)));
            const key = it._lane + ':' + dayIdx;
            (groups[key] = groups[key] || []).push(it);
        });
        Object.values(groups).forEach(group => {
            group.sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts));
            const dayIdx = Math.floor(this.dayIndexForDate(new Date(group[0].start_ts)));
            if (group.length === 1) {
                // no same-day conflict — size the block to its real duration,
                // spanning as many day-columns as it actually needs instead of
                // always being forced to exactly one day wide
                const it = group[0];
                it._blockLeft = dayIdx * this.DAY_WIDTH;
                it._blockWidth = Math.max(24, (it.duration_hours / 24) * this.DAY_WIDTH);
            } else {
                // multiple activities sharing this one day in this lane split
                // that day's width between them
                const slotWidth = this.DAY_WIDTH / group.length;
                group.forEach((it, idx) => {
                    it._blockLeft = dayIdx * this.DAY_WIDTH + idx * slotWidth;
                    it._blockWidth = Math.max(20, slotWidth - 2);
                });
            }
        });
    }

    groupKeyFor(item, groupBy) {
        if (groupBy === 'overall') return 'All Activities';
        if (groupBy === 'contractor') return item.contractor_name || 'Unassigned';
        return item[groupBy] || 'Unassigned';
    }

    /* Assign each item a vertical "lane" within its row. Items are processed
       left to right by start time (required so the "is this lane free yet"
       check is valid) but an item prefers to continue the lane its predecessor
       used in this same row — so a connected chain reads as one clean
       horizontal path instead of zig-zagging, and only falls back to the next
       free lane when its preferred lane is unavailable or it has no linked
       predecessor here. */
    // Rough per-character pixel widths for our item fonts, used to estimate
    // how many lines an item's asset/activity text will actually wrap to, so
    // lane spacing can be sized to fit real content instead of guessing at
    // one fixed height for every item regardless of name length.
    estimateTextLines(text, widthPx, avgCharPx) {
        const usable = Math.max(20, widthPx - 16); // minus horizontal padding
        const charsPerLine = Math.max(4, Math.floor(usable / avgCharPx));
        return Math.max(1, Math.ceil((text || '').length / charsPerLine));
    }
    // Overview/Overview Extended render one bar per row (see renderGantt())
    // and hide part or all of the text label (see itemBarHtml()). Overview
    // itself shows no text at all, so it's always a small fixed height. But
    // Overview Extended/Compact DO show the asset name — a flat fixed
    // height there (ignoring how many lines a longer name actually wraps
    // to) was the bug behind "asset — activity cut off at the bottom": a
    // longer name needs more room than a short one, and forcing every row
    // to the same height let the overflow spill into (and get visually
    // painted over by) the next row — same fix as .gantt-rowlabel.wide's
    // min-height above, just for the bar's own text instead of the row
    // label's.
    estimateItemHeight(it, widthPx) {
        if (this.isOverviewZoom) return 16;
        if (this.isCompactZoom) {
            const assetLines = this.estimateTextLines(it.asset_name, widthPx, 5.2);
            const lineH = 9 * 1.15;
            return Math.max(16, 4 + assetLines * lineH);
        }
        const assetLines = this.estimateTextLines(it.asset_name, widthPx, 6.0);
        const activityLines = this.estimateTextLines(it.activity_name, widthPx, 5.4);
        const assetLineH = 10.5 * 1.2, activityLineH = 9.5 * 1.2;
        return Math.max(36, 8 + assetLines * assetLineH + activityLines * activityLineH);
    }

    // After _lane (and _blockWidth, if day-block mode) are set on every item,
    // works out each item's actual pixel _top from the tallest real content
    // in each lane band — a lane with a long name gets more room without
    // affecting any other lane's spacing or where connector lines land —
    // and returns the row's total natural height. Overview/Overview
    // Extended use much tighter padding/gaps on top of the shorter bars
    // from estimateItemHeight() above, since every row there holds exactly
    // one activity and the whole point is fitting a long project on screen.
    computeLaneOffsets(sorted, laneCountHint) {
        const thin = this.isWaterfallZoom;
        const padTop = thin ? 2 : ROW_PAD_TOP;
        const padBottom = thin ? 2 : ROW_PAD_BOTTOM;
        const gap = thin ? 1 : ITEM_GAP;
        // Even Overview's bars are a bare color sliver, its row LABEL
        // (Asset — Activity, ~12.5px bold) still needs enough headroom for
        // one full line — 22/24px comfortably fits it without falling back
        // into the old 56px floor this replaced.
        const minRowH = thin ? (this.isOverviewZoom ? 22 : 24) : ROW_MIN_H;
        const defaultLaneH = thin ? 16 : 36;
        const laneMaxH = {};
        sorted.forEach(it => {
            const w = (it._blockWidth !== undefined) ? it._blockWidth : this.widthForItem(it);
            const h = this.estimateItemHeight(it, w);
            laneMaxH[it._lane] = Math.max(laneMaxH[it._lane] || 0, h);
        });
        const laneCount = laneCountHint || (Object.keys(laneMaxH).length ? Math.max(...Object.keys(laneMaxH).map(Number)) + 1 : 1);
        const laneTop = {};
        let cursor = padTop;
        for (let l = 0; l < laneCount; l++) {
            laneTop[l] = cursor;
            cursor += (laneMaxH[l] || defaultLaneH) + gap;
        }
        sorted.forEach(it => { it._top = laneTop[it._lane]; });
        return Math.max(minRowH, cursor - gap + padBottom);
    }

    // Presentation-only reordering: lanes that contain any today-or-future
    // item float to the top of the row, and past-only lanes are pushed below
    // them. The underlying collision-correct lane assignment above is
    // unchanged — this only remaps which visual slot each lane displays in —
    // so current work is never buried under a tall stack of space reserved
    // for older history that's scrolled out of view.
    floatCurrentLanesToTop(sorted) {
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todayMs = todayStart.getTime();
        const laneItems = {};
        sorted.forEach(it => { (laneItems[it._lane] = laneItems[it._lane] || []).push(it); });
        const laneAllPast = {};
        Object.keys(laneItems).forEach(l => {
            laneAllPast[l] = laneItems[l].every(it => new Date(it.start_ts).getTime() < todayMs);
        });
        const usedLanes = [...new Set(sorted.map(it => it._lane))].sort((a, b) => a - b);
        const currentLanes = usedLanes.filter(l => !laneAllPast[l]);
        const pastLanes = usedLanes.filter(l => laneAllPast[l]);
        const remap = {};
        [...currentLanes, ...pastLanes].forEach((oldLane, idx) => { remap[oldLane] = idx; });
        sorted.forEach(it => { it._lane = remap[it._lane]; });
    }

    layoutLanes(items) {
        const sorted = items.slice().sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts));

        if (this.expandedView) {
            // one activity per line, no packing at all — the clearest possible
            // view, at the cost of vertical space. Chronological order already
            // guarantees a predecessor never lands below its successor here.
            sorted.forEach((it, idx) => { it._lane = idx; });
            this.floatCurrentLanesToTop(sorted);
            if (this.isDayBlockMode()) this.assignDayBlockPositions(sorted);
            const totalHeight = this.computeLaneOffsets(sorted, sorted.length);
            return { items: sorted, laneCount: Math.max(1, sorted.length), totalHeight };
        }

        const laneEndTimes = [];
        const laneOfItem = {};
        sorted.forEach(it => {
            const start = new Date(it.start_ts).getTime();
            const end = start + it.duration_hours * 3600000;
            // an item can never sit above (a lower-index lane than) a linked
            // predecessor in this same row — this keeps every chain cascading
            // strictly downward so connector lines never have to double back
            // up through other boxes to reach it.
            let minLane = 0;
            (it.predecessor_ids || []).forEach(pid => {
                const lane = laneOfItem[pid];
                if (lane !== undefined) minLane = Math.max(minLane, lane);
            });
            let lane = minLane;
            while (laneEndTimes[lane] !== undefined && laneEndTimes[lane] > start) lane++;
            laneEndTimes[lane] = end;
            it._lane = lane;
            laneOfItem[it.id] = lane;
        });
        this.floatCurrentLanesToTop(sorted);
        if (this.isDayBlockMode()) this.assignDayBlockPositions(sorted);
        const laneCount = Math.max(1, laneEndTimes.length);
        const totalHeight = this.computeLaneOffsets(sorted, laneCount);
        return { items: sorted, laneCount, totalHeight };
    }

    buildGanttHeaderHtml(groupBy, rowMinWidth) {
        const todayStr = new Date().toDateString();
        // Matches .gantt-rowlabel.wide below, so the header's own label
        // column stays aligned with the wider per-item row labels used by
        // both Overview and Overview Extended's waterfall layout.
        const rowLabelColText = this.isWaterfallZoom ? 'Asset — Activity' : this.labelForGroup(groupBy);
        let headerHtml = `<div class="gantt-rowlabel-col ${this.isWaterfallZoom ? 'wide' : ''}">${rowLabelColText}</div>`;
        if (this.isOverviewZoom) {
            // Long-range view: individual days are too narrow to be legible
            // at this zoom, so the header groups by calendar month instead
            // (like a P6/Smartsheet rolled-up timeline) — each month becomes
            // one wide labeled cell sized to however many of its days fall
            // within the current timeline range.
            let i = 0;
            while (i < this.TIMELINE_DAYS) {
                const d = new Date(this.TIMELINE_START); d.setDate(d.getDate() + i);
                const month = d.getMonth(), year = d.getFullYear();
                let count = 0, containsToday = false;
                while (i + count < this.TIMELINE_DAYS) {
                    const dd = new Date(this.TIMELINE_START); dd.setDate(dd.getDate() + i + count);
                    if (dd.getMonth() !== month || dd.getFullYear() !== year) break;
                    if (dd.toDateString() === todayStr) containsToday = true;
                    count++;
                }
                const width = count * this.DAY_WIDTH;
                headerHtml += `<div class="gantt-month ${containsToday ? 'today' : ''}" style="flex:0 0 ${width}px; width:${width}px;" title="${d.toLocaleDateString(undefined,{month:'long',year:'numeric'})} — click a day at Compact/Normal zoom to see what's scheduled">${d.toLocaleDateString(undefined,{month:'short',year:'numeric'})}</div>`;
                i += count;
            }
            return headerHtml;
        }
        for (let i = 0; i < this.TIMELINE_DAYS; i++) {
            const d = new Date(this.TIMELINE_START); d.setDate(d.getDate() + i);
            const isWeekend = d.getDay() === 0 || d.getDay() === 6;
            // Included Days + Blackout Dates settings (Schedule config
            // modal) — a day this project has excluded gets a stronger
            // grey treatment than the plain cosmetic weekend tint above,
            // and loses its "click to see what's scheduled" affordance
            // since it's not meant to have anything scheduled on it at
            // all. i is already this exact day's own integer day-index
            // (TIMELINE_START + i whole days), so isDayIncluded() doesn't
            // need to re-derive it from d.
            const isExcluded = !this.isDayIncluded(i);
            const isToday = d.toDateString() === todayStr;
            const isoDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            headerHtml += `<div class="gantt-day ${isWeekend ? 'weekend' : ''} ${isExcluded ? 'excluded-day' : ''} ${isToday ? 'today' : ''}" ${isExcluded ? 'title="Not an active schedule day"' : `onclick="this.getRootNode().host.openDayDetail('${isoDate}')" title="Click to see everything scheduled this day"`}>
                <div class="dow">${d.toLocaleDateString(undefined,{weekday:'short'})}</div>${d.getMonth()+1}/${d.getDate()}</div>`;
        }
        return headerHtml;
    }

    zoneEndMarkerHtml(gname, groupBy, height) {
        if (groupBy !== 'zone') return '';
        const endDate = this.getZoneEndDate(gname);
        if (!endDate) return '';
        const left = this.dayIndexForDate(new Date(endDate + 'T00:00')) * this.DAY_WIDTH;
        if (left < 0 || left > this.TIMELINE_DAYS * this.DAY_WIDTH) return '';
        return `<div class="zone-end-marker" style="left:${left}px; height:${height}px;">
            <span class="zone-end-flag">Target ${new Date(endDate + 'T00:00').toLocaleDateString(undefined,{month:'numeric',day:'numeric'})}</span>
        </div>`;
    }

    buildRowHtml(gname, laidOut, totalWidth, groupBy, opts) {
        opts = opts || {};
        const height = opts.forceNatural ? laidOut.totalHeight : (this.rowHeightOverrides[gname] || laidOut.totalHeight);
        const rowMinWidth = opts.rowMinWidth || (totalWidth + 200);
        // In Overview zoom, gname is a per-item id (not a filterable
        // zone/type/etc. name) and displayLabel carries the actual
        // "Asset — Activity" text to show — the row-expand ("show only
        // this row") button doesn't have a matching filter to apply for a
        // single item, so it's left out there.
        const labelHtml = opts.displayLabel
            ? escHtml(opts.displayLabel)
            : `${escHtml(gname)} <span style="color:#aaa; font-weight:500; margin-left:2px;">(${laidOut.items.length})</span>`;
        return `<div class="gantt-row" data-group="${escAttr(gname)}" style="height:${height}px; min-width:${rowMinWidth}px;">
            <div class="gantt-rowlabel ${opts.displayLabel ? 'wide' : ''}" style="height:${height}px;">
                <span>${labelHtml}</span>
                ${!opts.displayLabel ? `<button class="row-expand-btn" title="Show only this row (filters down to it, same as clicking its filter chip)" onclick="this.getRootNode().host.openRowFullscreen('${gname.replace(/'/g, "\\'")}')">⛶</button>` : ''}
                ${!opts.noResize ? `<div class="row-resize-handle" data-group="${escAttr(gname)}" title="Drag to resize"></div>` : ''}
            </div>
            <div class="gantt-track" style="width:${totalWidth}px; height:${height}px;">
                <div class="gantt-gridlines" style="height:${height}px;">${this.gridlinesHtml()}</div>
                ${this.zoneEndMarkerHtml(gname, groupBy, height)}
                ${laidOut.items.map(it => this.itemBarHtml(it)).join('')}
            </div>
        </div>`;
    }

    // PERF FIX: debounce the search-driven re-render — this.renderGantt() rebuilds the
    // header, every group's rows, and re-attaches drag/resize/link handlers, so
    // running it on every keystroke while typing a search term is expensive.
    // Waiting 220ms after typing pauses collapses that into a single render.
    debouncedRenderGantt() {
        clearTimeout(this.__ganttSearchDebounceTimer);
        this.__ganttSearchDebounceTimer = setTimeout(() => {
            this.renderGantt();
            this.scrollWaterfallToTop();
        }, 220);
    }

    // Overview/Overview Extended's rows are sorted chronologically — one
    // row per activity — so whichever row sits at the top of the viewport
    // corresponds to a specific point in the project's timeline. Without
    // this, scrolling down through later and later rows leaves the
    // horizontal (date) scroll wherever it happened to already be, so the
    // actual bars for whatever you've scrolled to are usually off-screen
    // to the right. #ganttWrap is the one element that scrolls both axes
    // (see the CSS), so this listens there once — attached here in
    // initApp(), not inside renderGantt() (which reruns on every render),
    // since #ganttWrap itself is never recreated, only its contents are.
    initWaterfallSyncedScroll() {
        const wrap = this.$('ganttWrap');
        if (!wrap || wrap._syncedScrollBound) return;
        wrap._syncedScrollBound = true;
        let lastScrollTop = wrap.scrollTop;
        let ticking = false;
        wrap.addEventListener('scroll', () => {
            // #ganttWrap scrolls BOTH axes, so a manual horizontal scroll —
            // or this handler's own scrollLeft assignment below — fires
            // this exact same event. Reacting to those too immediately
            // snapped scrollLeft back to the top row's position on every
            // horizontal scroll attempt, which made it impossible to
            // manually look further right/left than wherever the top row
            // happened to be (couldn't scroll to "today + 5 days", couldn't
            // get back to the very top). Only reacting when scrollTOP
            // itself actually moved — genuine vertical scrolling — fixes
            // both: horizontal scrolling is left alone, and this handler's
            // own left-only adjustment never re-triggers itself.
            const scrollTopChanged = wrap.scrollTop !== lastScrollTop;
            lastScrollTop = wrap.scrollTop;
            if (!this.isWaterfallZoom || !scrollTopChanged || ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                this.syncWaterfallHorizontalScroll(wrap);
                ticking = false;
            });
        });
    }
    syncWaterfallHorizontalScroll(wrap) {
        const wrapRect = wrap.getBoundingClientRect();
        const headerH = this.$('ganttHeader')?.getBoundingClientRect().height || 0;
        const rows = wrap.querySelectorAll('.gantt-row');
        let topRow = null;
        for (const row of rows) {
            // first row not (mostly) scrolled up past the sticky header —
            // that's the one currently "at the top of the screen"
            if (row.getBoundingClientRect().bottom > wrapRect.top + headerH + 4) { topRow = row; break; }
        }
        const itemEl = topRow && topRow.querySelector('.gantt-item');
        if (!itemEl) return;
        // itemEl's own `left` is measured from the START of .gantt-track,
        // which itself sits 260px into the row (right after the sticky
        // label column — .gantt-row is a flex row of [.gantt-rowlabel.wide
        // (260px) , .gantt-track]). So the item's on-screen position at
        // scrollLeft=0 is already 260+itemLeft — that 260 must NOT be added
        // again when computing scrollLeft, or the target ends up 260px too
        // large and the view sits that far right of where the item actually
        // is (it previously landed *behind* the sticky label instead of
        // just past it, which is what made the top row's bar unreachable
        // no matter how far left you scrolled). scrollLeft = documentX -
        // desiredViewportX, i.e. (260+itemLeft) - (260+40) = itemLeft - 40.
        const itemLeft = parseFloat(itemEl.style.left) || 0;
        const targetScrollLeft = Math.max(0, itemLeft - 40);
        // Instant, not smooth — a multi-frame smooth-scroll animation
        // fires several more 'scroll' events of its own while it plays,
        // which is exactly the kind of feedback this needs to avoid.
        if (Math.abs(wrap.scrollLeft - targetScrollLeft) > 4) wrap.scrollLeft = targetScrollLeft;
    }
    // Called after any filter/search/critical-path change (see
    // toggleFilterValue, clearAllFilters, toggleCriticalPath, the search
    // box) so the view always lands on whatever's now actually first/
    // relevant, instead of staying wherever it was scrolled — which could
    // easily now be showing a mostly-empty stretch if the change just
    // removed everything that used to be visible there. Must run AFTER
    // renderGantt() has rebuilt the row list, not before.
    scrollWaterfallToTop() {
        if (!this.isWaterfallZoom) return;
        const wrap = this.$('ganttWrap');
        if (!wrap) return;
        wrap.scrollTop = 0;
        this.syncWaterfallHorizontalScroll(wrap);
    }

    renderGantt() {
        this.style.setProperty('--daywidth', this.DAY_WIDTH + 'px');
        // Grouping and "Expand All Activities" no longer have any UI (only
        // Overview/Overview Extended remain, which always render one row
        // per activity — see the isWaterfallZoom branch below) — 'overall'
        // is just the harmless default groupKeyFor()/zoneEndMarkerHtml()
        // etc. fall back on, since that whole code path is unreachable now.
        const groupBy = 'overall';

        try {
            this.criticalPathData = this.computeCriticalPath();
        } catch (err) {
            console.error('computeCriticalPath failed — critical path disabled for this render', err);
            this.criticalPathData = null;
        }

        const items = this.getFilteredItems();
        const totalWidth = this.TIMELINE_DAYS * this.DAY_WIDTH;
        const wrapClientWidth = this.$('ganttWrap').clientWidth || 0;
        const rowMinWidth = Math.max(totalWidth + 200, wrapClientWidth);

        try {
            this.focusChainSet = this.connectionFocusId ? this.getConnectedComponent(this.connectionFocusId) : null;
        } catch (err) {
            console.error('getConnectedComponent failed — focus/dim disabled for this render', err);
            this.focusChainSet = null;
        }

        const headerEl = this.$('ganttHeader');
        headerEl.innerHTML = this.buildGanttHeaderHtml(groupBy);
        headerEl.style.minWidth = rowMinWidth + 'px';
        this.renderLegend();

        const bodyEl = this.$('ganttBody');
        if (items.length === 0) {
            bodyEl.innerHTML = this.showCriticalPath
                ? `<div class="empty-state"><div class="emoji">🔥</div>No activities are on the critical path from today forward.<br>Turn off <strong>Critical Path</strong> to see the full schedule.</div>`
                : `<div class="empty-state"><div class="emoji">🗓️</div>No schedule items match the current filters.<br>Use <strong>New Item</strong> or <strong>Bulk Add</strong> to get started.</div>`;
            this.LAST_GROUPS = {}; this.LAST_GROUPBY = groupBy;
            return;
        }
        const groups = {};
        const displayLabels = {};
        if (this.isWaterfallZoom) {
            // Overview and Overview Extended read like a classic P6/
            // Smartsheet task list — one row per activity (not
            // grouped/packed together with others), labeled by its own
            // asset + activity name, in chronological "waterfall" order
            // down the page rather than grouped by zone/type/etc. Grouping
            // and "Expand All Activities" don't apply at these zoom levels.
            //
            // Anything scheduled to START before the visible range's start
            // is hidden by default — including one that's still ongoing
            // into today, which is why this checks the item's OWN start
            // date, not itemEndMs(): a filter on "hasn't finished yet"
            // still let a row through with nothing but a sliver of its bar
            // (or just the link-handle) peeking in at the left edge, which
            // is exactly the "still showing items from the past day"
            // symptom — a row with no usable visible content is worse than
            // just not showing it. A long project accumulates hundreds of
            // completed activities, and scrolling past all of them to
            // reach what's actually upcoming isn't useful. This isn't a
            // separate on/off switch: it's just honoring whatever window
            // the Timeline Range bar (bottom of the page) is currently set
            // to — that Start date IS the "pick a time window to look at"
            // control; moving it earlier brings past activities back into
            // view (in full, not just a clipped edge).
            const rangeStartMs = this.TIMELINE_START.getTime();
            const visibleItems = items.filter(it => new Date(it.start_ts).getTime() >= rangeStartMs);
            if (!visibleItems.length) {
                bodyEl.innerHTML = `<div class="empty-state"><div class="emoji">🗓️</div>Nothing scheduled on or after ${this.TIMELINE_START.toLocaleDateString()}.<br>Move the Timeline Range's Start date (bottom of the page) earlier to see past activities.</div>`;
                this.LAST_GROUPS = {}; this.LAST_GROUPBY = groupBy;
                return;
            }
            visibleItems.slice().sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts)).forEach(it => {
                groups[it.id] = [it];
                displayLabels[it.id] = `${it.asset_name} — ${it.activity_name}`;
            });
        } else {
            items.forEach(it => {
                const k = this.groupKeyFor(it, groupBy);
                (groups[k] = groups[k] || []).push(it);
            });
        }
        this.LAST_GROUPS = groups; this.LAST_GROUPBY = groupBy;

        // The waterfall modes' per-item keys are already in the
        // chronological order they were inserted above — Object.keys()
        // preserves that, so only the grouped modes need the extra
        // alphabetical sort.
        const groupNames = this.isWaterfallZoom ? Object.keys(groups) : Object.keys(groups).sort();

        try {
            let bodyHtml = '';
            groupNames.forEach(gname => {
                const laidOut = this.layoutLanes(groups[gname]);
                bodyHtml += this.buildRowHtml(gname, laidOut, totalWidth, groupBy, { rowMinWidth, displayLabel: displayLabels[gname] });
            });
            bodyEl.innerHTML = bodyHtml;
        } catch (err) {
            console.error('renderGantt failed while building rows', err);
            bodyEl.innerHTML = `<div class="empty-state"><div class="emoji">⚠️</div>Something went wrong drawing the schedule — see the browser console for details.</div>`;
            return;
        }

        this.attachDragHandlers(bodyEl);
        this.attachRowResizeHandlers(bodyEl);
        this.attachLinkHandlers(bodyEl);
        // wait for the browser to finish laying out this frame (item boxes can
        // now grow taller than the grid assumes to fit wrapped text) before
        // measuring positions for the connector lines, so they never end up
        // drawn against stale/pre-reflow coordinates
        requestAnimationFrame(() => this.renderConnections());
        // renderGantt() runs for lots of reasons that have nothing to do with
        // the user scrolling — a background LaunchPad pull, the periodic
        // status refresh, a filter change, the realtime subscription — and
        // initWaterfallSyncedScroll()'s own sync only reacts to actual
        // scroll events. Any of those other renders can rebuild the DOM
        // with a different item now sitting at the same scrollTop, leaving
        // the horizontal position stale relative to whatever row visually
        // ends up on top — exactly the "top row's real date is scrolled
        // past" bug. Re-syncing after every render (not just every scroll)
        // closes that gap regardless of what triggered it.
        if (this.isWaterfallZoom) {
            requestAnimationFrame(() => {
                const wrap = this.$('ganttWrap');
                if (wrap) this.syncWaterfallHorizontalScroll(wrap);
            });
        }
        // defensive re-measure: clientWidth taken synchronously above can race
        // with flex layout settling (particularly right after load), leaving
        // rows sized to their own content instead of the full viewport — widen
        // them again here once layout has actually committed, if needed
        requestAnimationFrame(() => {
            const freshWrapWidth = this.$('ganttWrap').clientWidth || 0;
            const correctedWidth = Math.max(totalWidth + 200, freshWrapWidth);
            if (correctedWidth > rowMinWidth) {
                headerEl.style.minWidth = correctedWidth + 'px';
                bodyEl.querySelectorAll('.gantt-row').forEach(r => { r.style.minWidth = correctedWidth + 'px'; });
            }
        });
    }

    /* ---- Fullscreen single-row view: always shows the row at its natural
       full height (every item visible, no manual shrink) at a larger scale. ---- */
    openRowFullscreen(gname) {
        // Dead code now that grouping has no UI (only Overview/Overview
        // Extended remain, and their row-expand button is never rendered —
        // see buildRowHtml()'s opts.displayLabel check) — left in place
        // rather than deleted in case grouping ever comes back, guarded so
        // it can't throw if something still manages to call it.
        const groupBySelect = this.$('groupBySelect');
        const groupBy = groupBySelect ? groupBySelect.value : 'overall';
        if (groupBy === 'overall') { this.toast('Already showing everything — switch to another grouping to filter down to one space.'); return; }
        if (this.FILTERS[groupBy]) {
            this.FILTERS[groupBy].clear();
            this.FILTERS[groupBy].add(gname);
        } else {
            // groupings with no dedicated facet (e.g. Contractor) — approximate
            // with the search box instead
            this.$('globalSearch').value = gname;
        }
        this.renderFilterBar();
        this.renderGantt();
        this.toast(`Showing only "${gname}" — click "Clear filters" to see everything again.`, 3500);
    }
    /* ---- Manual row resize (drag the strip at the bottom edge of a row) ---- */
    attachRowResizeHandlers(root) {
        root.querySelectorAll('.row-resize-handle').forEach(handle => {
            handle.addEventListener('pointerdown', (e) => {
                e.preventDefault(); e.stopPropagation();
                const gname = handle.dataset.group;
                const row = handle.closest('.gantt-row');
                const startY = e.clientY;
                const startHeight = row.getBoundingClientRect().height;
                handle.classList.add('active');
                function onMove(ev) {
                    const h = Math.max(40, Math.round(startHeight + (ev.clientY - startY)));
                    row.style.height = h + 'px';
                    row.querySelector('.gantt-rowlabel').style.height = h + 'px';
                    row.querySelector('.gantt-track').style.height = h + 'px';
                    row.querySelector('.gantt-gridlines').style.height = h + 'px';
                    this.renderConnections();
                }
                function onUp(ev) {
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup', onUp);
                    handle.classList.remove('active');
                    const h = Math.max(40, Math.round(startHeight + (ev.clientY - startY)));
                    this.rowHeightOverrides[gname] = h;
                    this.renderConnections();
                }
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
            });
            handle.addEventListener('dblclick', () => {
                delete this.rowHeightOverrides[handle.dataset.group];
                this.renderGantt();
            });
        });
    }

    labelForGroup(g) {
        return { overall: 'All Activities', zone: 'Zone', area: 'Area', asset_type: 'Asset Type', contractor: 'Contractor', type: 'Type' }[g] || 'Group';
    }

    gridlinesHtml() {
        const todayStr = new Date().toDateString();
        let html = '';
        if (this.isOverviewZoom) {
            // Overview's header groups by month (see buildGanttHeaderHtml())
            // — drawing one hairline gridline per individual day underneath
            // that, at a 14px day width, packed ~30 to a month, is what was
            // making the whole thing look like a dense, glitchy hatch
            // pattern ("cells too thin"). One gridline per month instead,
            // matching the header's own granularity.
            let i = 0;
            while (i < this.TIMELINE_DAYS) {
                const d = new Date(this.TIMELINE_START); d.setDate(d.getDate() + i);
                const month = d.getMonth(), year = d.getFullYear();
                let count = 0, containsToday = false;
                while (i + count < this.TIMELINE_DAYS) {
                    const dd = new Date(this.TIMELINE_START); dd.setDate(dd.getDate() + i + count);
                    if (dd.getMonth() !== month || dd.getFullYear() !== year) break;
                    if (dd.toDateString() === todayStr) containsToday = true;
                    count++;
                }
                const width = count * this.DAY_WIDTH;
                html += `<div class="gantt-gridline month ${containsToday ? 'today' : ''}" style="flex:0 0 ${width}px; width:${width}px;"></div>`;
                i += count;
            }
            return html;
        }
        for (let i = 0; i < this.TIMELINE_DAYS; i++) {
            const d = new Date(this.TIMELINE_START); d.setDate(d.getDate() + i);
            const isWeekend = d.getDay() === 0 || d.getDay() === 6;
            const isExcluded = !this.isDayIncluded(i);
            const isToday = d.toDateString() === todayStr;
            html += `<div class="gantt-gridline ${isWeekend ? 'weekend' : ''} ${isExcluded ? 'excluded-day' : ''} ${isToday ? 'today' : ''}"></div>`;
        }
        return html;
    }

    zoneEndDateMs(zoneName) {
        const endDate = this.getZoneEndDate(zoneName);
        if (!endDate) return null;
        const d = new Date(endDate + 'T23:59:59');
        return d.getTime();
    }

    itemBarHtml(it) {
        const left = this.displayLeft(it);
        const width = this.displayWidth(it);
        const top = it._top !== undefined ? it._top : ROW_PAD_TOP;
        const color = this.activityColor(it.activity_name);
        const deadline = this.zoneEndDateMs(it.zone);
        const overdue = deadline !== null && this.itemEndMs(it) > deadline;
        const resizable = !this.isDayBlockMode();
        const focused = this.connectionFocusId === it.id;
        const dimmed = this.focusChainSet && !this.focusChainSet.has(it.id);
        const critical = this.showCriticalPath && this.isCriticalItem(it.id);
        const multiselected = this.multiSelectedIds.has(it.id);
        const floatVal = this.criticalPathData ? this.criticalPathData.floatById[it.id] : null;
        const floatTitle = floatVal !== null && floatVal !== undefined ? ` — float ${hoursToDays(floatVal)}d${floatVal <= 0.01 ? ' (critical path)' : ''}` : '';
        // In unified mode every item trivially "is" its own LaunchPad row —
        // the badge only means something when there are two separate rows
        // to link.
        const launchpadLinked = !this.UNIFIED_SCHEDULE && !!it.launchpad_id;
        const notReady = this.isStatusNotReady(it.asset_name, it.activity_name);
        const superseded = !!it.superseded_by;
        // Compact zoom still shows the asset name (that's the whole point of
        // being able to read the bar), but the activity is color-only there
        // (activityColor already encodes which activity it is) rather than
        // also spelling it out in tiny text. Overview zoom is narrower still
        // (built for seeing a long project's whole span at once) — there's
        // no room for any label there, so it falls all the way back to a
        // plain color-coded bar. Full asset/activity detail is always one
        // hover away via the title tooltip regardless of zoom. The "thin"
        // class (Overview + Overview Extended) drops min-height/padding so
        // each one-per-row bar takes as little vertical space as possible.
        return `<div class="gantt-item ${this.isWaterfallZoom ? 'thin' : ''} ${overdue ? 'overdue' : ''} ${focused ? 'focused' : ''} ${dimmed ? 'dimmed' : ''} ${critical ? 'critical' : ''} ${multiselected ? 'multiselected' : ''} ${notReady ? 'not-ready' : ''} ${superseded ? 'superseded' : ''}" data-id="${it.id}" style="left:${left}px; width:${width}px; top:${top}px; background:${color};" title="${escAttr(it.asset_name)} — ${escAttr(it.activity_name)}${overdue ? ' (past zone target end date)' : ''}${floatTitle}${launchpadLinked ? ' — linked to LaunchPad' : ''}${notReady ? ' — NOT READY (status open/incomplete)' : ''}${superseded ? ' — rescheduled to a new date' : ''}">
            ${resizable ? `<div class="resize-handle left" data-id="${it.id}" data-edge="left"></div>` : ''}
            ${launchpadLinked ? `<span class="launchpad-badge" title="Linked to a LaunchPad row">📡</span>` : ''}
            ${this.isOverviewZoom ? '' : `<span class="gi-asset">${escHtml(it.asset_name)}</span>`}
            ${this.isCompactZoom ? '' : `<span class="gi-activity">${escHtml(it.activity_name)}</span>`}
            ${resizable ? `<div class="resize-handle" data-id="${it.id}" data-edge="right"></div>` : ''}
            <div class="link-handle" data-id="${it.id}" title="Drag to link a successor activity"></div>
        </div>`;
    }

    /* =========================================================================
       6b. DEPENDENCY LINKS — drag-to-connect, rendered connectors, and the
       "can't start before its predecessor finishes" enforcement cascade.
       ========================================================================= */

    /* Auto-scrolls #ganttWrap while a drag (item move/resize, or a
       connector-link drag) holds the pointer near its edge, so dragging an
       item or a link past what's currently visible brings more of the
       timeline into view instead of stopping dead at the viewport edge. */
    updateAutoScroll(clientX, clientY, opts, onTick) {
        opts = opts || {};
        const wrap = this.$('ganttWrap');
        const rect = wrap.getBoundingClientRect();
        const EDGE = 60, SPEED = 16;
        let dx = 0, dy = 0;
        if (opts.horizontal !== false) {
            if (clientX < rect.left + EDGE) dx = -SPEED * (1 - Math.max(0, clientX - rect.left) / EDGE);
            else if (clientX > rect.right - EDGE) dx = SPEED * (1 - Math.max(0, rect.right - clientX) / EDGE);
        }
        if (opts.vertical !== false) {
            if (clientY < rect.top + EDGE) dy = -SPEED * (1 - Math.max(0, clientY - rect.top) / EDGE);
            else if (clientY > rect.bottom - EDGE) dy = SPEED * (1 - Math.max(0, rect.bottom - clientY) / EDGE);
        }
        this.autoScrollState = (dx || dy) ? { dx, dy } : null;
        if (this.autoScrollState && !this.autoScrollRAF) {
            const step = () => {
                if (!this.autoScrollState) { this.autoScrollRAF = null; return; }
                wrap.scrollLeft += this.autoScrollState.dx;
                wrap.scrollTop += this.autoScrollState.dy;
                if (onTick) onTick();
                this.autoScrollRAF = requestAnimationFrame(step);
            };
            this.autoScrollRAF = requestAnimationFrame(step);
        } else if (!this.autoScrollState && this.autoScrollRAF) {
            cancelAnimationFrame(this.autoScrollRAF);
            this.autoScrollRAF = null;
        }
    }
    stopAutoScroll() {
        this.autoScrollState = null;
        if (this.autoScrollRAF) { cancelAnimationFrame(this.autoScrollRAF); this.autoScrollRAF = null; }
    }

    attachLinkHandlers(root) {
        root.querySelectorAll('.link-handle').forEach(handle => {
            handle.addEventListener('pointerdown', (e) => {
                e.preventDefault(); e.stopPropagation();
                if (!this.requireEditMode()) return;
                const sourceId = handle.dataset.id;
                const svg = this.$('connectionsSvg');
                const bodyEl = this.$('ganttBody');
                const bodyRect = bodyEl.getBoundingClientRect();
                const startRect = handle.getBoundingClientRect();
                const x1 = startRect.left + startRect.width / 2 - bodyRect.left;
                const y1 = startRect.top + startRect.height / 2 - bodyRect.top;
                this.linkDragCtx = { sourceId, x1, y1 };

                let tempPath = svg.querySelector('.conn-temp');
                if (!tempPath) {
                    tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    tempPath.setAttribute('class', 'conn-temp');
                    svg.appendChild(tempPath);
                }
                // Arrow functions — not plain `function` declarations — this
                // is what actually broke the connect-drag. As a plain
                // function, `this` inside a window pointermove/pointerup
                // callback resolves to `window`, not this component, so
                // `this.updateAutoScroll(...)` below threw a TypeError on
                // the very first pointermove, before ever reaching the
                // tempPath.setAttribute() line that draws the visible
                // dragging line — it silently never appeared, and onUp
                // threw the same way before ever calling addPredecessorLink.
                const onMove = (ev) => {
                    this.updateAutoScroll(ev.clientX, ev.clientY, { horizontal: true, vertical: true }, () => onMove(ev));
                    // re-measure fresh each time — bodyEl's position relative to
                    // the viewport shifts as #ganttWrap auto-scrolls, so a
                    // cached rect from drag-start would drift out of sync
                    const freshBodyRect = bodyEl.getBoundingClientRect();
                    const x2 = ev.clientX - freshBodyRect.left;
                    const y2 = ev.clientY - freshBodyRect.top;
                    tempPath.setAttribute('d', `M${x1},${y1} L${x2},${y2}`);
                };
                const onUp = (ev) => {
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup', onUp);
                    this.stopAutoScroll();
                    tempPath.remove();
                    // document.elementFromPoint() doesn't pierce shadow
                    // boundaries — from the top-level document it just
                    // returns this component's own host element (or
                    // whatever light-DOM ancestor sits there), never the
                    // actual .gantt-item underneath, so targetItemEl was
                    // always null and the link never attached no matter
                    // where you dropped it. shadowRoot.elementFromPoint()
                    // is the shadow-DOM-aware equivalent.
                    const targetEl = (this.shadowRoot || document).elementFromPoint(ev.clientX, ev.clientY);
                    const targetItemEl = targetEl && targetEl.closest ? targetEl.closest('.gantt-item') : null;
                    if (targetItemEl && targetItemEl.dataset.id !== sourceId) {
                        this.addPredecessorLink(targetItemEl.dataset.id, sourceId);
                    }
                    this.linkDragCtx = null;
                };
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
            });
        });
    }

    /* Two routing styles, matching how a hand-drawn pull-plan flow reads:
       - Same lane (a chain simply continuing): a short direct line from the
         predecessor's right edge into the successor's left edge.
       - Different lane (branching to/from another row of work): a short
         vertical "drop" straight out of the predecessor's own bottom edge
         (always inside that box's own width, so the line is never visually
         disconnected from it), then a horizontal jog over to a shared
         vertical "trunk" column chosen to dodge other boxes, then down/up
         and right into the successor's left edge — the same tree shape a
         hand-drawn logic diagram uses. */
    sameLaneConnectorPath(x1, y1, x2, y2) {
        if (Math.abs(y1 - y2) < 1) return `M${x1},${y1} L${x2},${y2}`;
        const midX = Math.max(x1, Math.min((x1 + x2) / 2, x2));
        return `M${x1},${y1} L${midX},${y1} L${midX},${y2} L${x2},${y2}`;
    }
    branchConnectorPath(predLeftX, predRightX, predBottomY, trunkX, succLeftX, succMidY) {
        // the drop point is always clamped inside the predecessor's own footprint
        const dropX = Math.max(predLeftX + 4, Math.min(predLeftX + 10, predRightX - 4));
        const clearY = predBottomY + 8; // small clearance below the box before jogging sideways
        return `M${dropX},${predBottomY} L${dropX},${clearY} L${trunkX},${clearY} L${trunkX},${succMidY} L${succLeftX},${succMidY}`;
    }

    /* Find a trunk x-position that doesn't cut through any other item box
       between the predecessor and the successor — sweeping right past
       whatever it hits, on both the vertical run and the final horizontal
       run into the successor. This column is independent of where the line
       actually touches the predecessor, so obstacle avoidance never has to
       compromise that attachment point. */
    pickTrunkX(startX, topY, succLeftX, succMidY, obstacles) {
        let x = startX;
        let moved = true, guard = 0;
        while (moved && guard < 40) {
            moved = false; guard++;
            for (const r of obstacles) {
                const crossesVertical = x >= r.left - 1 && x <= r.right + 1 && r.top < succMidY && r.bottom > topY;
                const crossesHorizontal = succMidY >= r.top - 1 && succMidY <= r.bottom + 1 && r.right > Math.min(x, succLeftX) && r.left < Math.max(x, succLeftX);
                if (crossesVertical || crossesHorizontal) {
                    const pushed = r.right + 10;
                    if (pushed > x) { x = pushed; moved = true; }
                }
            }
        }
        return Math.min(x, succLeftX - 4);
    }

    /* All items reachable from a starting item by walking predecessor AND
       successor edges in either direction — i.e. its whole logical chain,
       not just direct neighbors. Used to grey out everything else when an
       item is focused and "Show all connections" is off. */
    getConnectedComponent(itemId) {
        // PERF FIX: build lookup maps once (O(n)) up front instead of doing a
        // this.DATA.items.find()/filter() full-array scan for every node visited in
        // the BFS below — that pattern made this function O(n^2) on large
        // schedules, and it re-runs on every render while a connection focus
        // is active (including every keystroke if the user is also searching).
        const byId = new Map();
        const successorsOf = new Map();
        this.DATA.items.forEach(i => {
            byId.set(i.id, i);
            successorsOf.set(i.id, []);
        });
        this.DATA.items.forEach(i => {
            (i.predecessor_ids || []).forEach(pid => {
                if (successorsOf.has(pid)) successorsOf.get(pid).push(i.id);
            });
        });

        const visited = new Set([itemId]);
        const queue = [itemId];
        while (queue.length) {
            const id = queue.shift();
            const item = byId.get(id);
            (item?.predecessor_ids || []).forEach(pid => { if (!visited.has(pid)) { visited.add(pid); queue.push(pid); } });
            (successorsOf.get(id) || []).forEach(sid => { if (!visited.has(sid)) { visited.add(sid); queue.push(sid); } });
        }
        return visited;
    }

    /* =========================================================================
       CRITICAL PATH (CPM) — standard forward/backward pass over the
       predecessor/successor graph, using each activity's duration. This
       answers "if every chain started as early as its dependencies allow,
       which activities have zero slack (float) before they'd delay the
       chain they belong to?" — computed per independent chain, since
       unrelated chains shouldn't affect each other's float. Items with no
       links at all (not part of any chain) are left out entirely; a lone
       activity isn't meaningfully "critical."
       ========================================================================= */
    computeCriticalPath() {
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todayStartMs = todayStart.getTime();
        // Fully-completed activities are excluded from the analysis
        // entirely (as if they don't exist) — a chain that passes through
        // one just resumes fresh from its first current/future step, using
        // that step's own scheduled start rather than inheriting timing
        // from work that's already done and can't change. "Completed"
        // means its own span has actually finished (itemEndMs <= today),
        // not just that it started before today — an activity that
        // started yesterday but is still running today (or longer) is
        // still a current activity and must stay in the analysis, per
        // request ("taking into account the current day's activities").
        // The old `start_ts >= todayStartMs` check dropped any such
        // in-progress item (and every link to/from it) the moment it
        // crossed midnight, well before it was actually done.
        const items = this.DATA.items.filter(i => this.itemEndMs(i) > todayStartMs);
        const byId = {};
        items.forEach(i => byId[i.id] = i);
        const successorsOf = {};
        items.forEach(i => successorsOf[i.id] = []);
        items.forEach(i => (i.predecessor_ids || []).forEach(pid => { if (successorsOf[pid]) successorsOf[pid].push(i.id); }));

        // weakly-connected components (undirected reachability over the same edges)
        const visited = new Set();
        const components = [];
        items.forEach(i => {
            if (visited.has(i.id)) return;
            const comp = [];
            const queue = [i.id];
            visited.add(i.id);
            while (queue.length) {
                const id = queue.shift();
                comp.push(id);
                const item = byId[id];
                (item.predecessor_ids || []).forEach(pid => { if (byId[pid] && !visited.has(pid)) { visited.add(pid); queue.push(pid); } });
                (successorsOf[id] || []).forEach(sid => { if (!visited.has(sid)) { visited.add(sid); queue.push(sid); } });
            }
            components.push(comp);
        });

        const floatById = {}, esById = {}, efById = {}, lsById = {}, lfById = {};

        // ---- pass 1: forward (earliest start/finish) for every component ----
        // A "beginning" activity (no predecessor in its component) starts on
        // its own real scheduled date — not an arbitrary shared zero — so
        // multiple independent starting points keep their real time
        // relationship intact.
        const compInfos = [];
        components.forEach(comp => {
            if (comp.length < 2) { comp.forEach(id => floatById[id] = null); return; } // isolated item — not part of any chain
            const compSet = new Set(comp);

            const inDegLive = {};
            comp.forEach(id => inDegLive[id] = (byId[id].predecessor_ids || []).filter(p => compSet.has(p)).length);
            const q = comp.filter(id => inDegLive[id] === 0);
            const topoOrder = [];
            while (q.length) {
                const id = q.shift();
                topoOrder.push(id);
                (successorsOf[id] || []).filter(sid => compSet.has(sid)).forEach(sid => {
                    inDegLive[sid]--;
                    if (inDegLive[sid] === 0) q.push(sid);
                });
            }
            if (topoOrder.length < comp.length) { comp.forEach(id => floatById[id] = null); return; } // shouldn't happen (cycles are blocked elsewhere), but bail out safely

            // Standard CPM forward pass: early start is max(predecessor
            // finishes), falling back to the item's own real scheduled
            // start only for a root (no predecessor in this component).
            // A real-date-anchored version of this was tried instead (ES =
            // item's own real start always, ignoring predecessor finish
            // times) — that made a chain's calendar gaps look like "this
            // chain finishes later, so it's more critical" instead of what
            // float actually means: how much a chain COULD slip without
            // pushing the project's real finish date later. Confirmed
            // against live data that it breaks exactly backwards — a chain
            // with a large real gap downstream (AC-F03 -> an activity
            // scheduled 11 days later) still has zero float across its
            // ENTIRE length under this formula, correctly identified as
            // the longest dependency chain end to end, where the real-date
            // version only ever flagged the one or two activities after
            // the gap and left the chain feeding into it looking like it
            // had slack it doesn't actually have.
            topoOrder.forEach(id => {
                const preds = (byId[id].predecessor_ids || []).filter(p => compSet.has(p));
                const durMs = (parseFloat(byId[id].duration_hours) || 0) * 3600000;
                const ownStartMs = new Date(byId[id].start_ts).getTime();
                let es;
                if (preds.length) {
                    // Same day-skip the real dependency cascade
                    // (enforceDependencies()/nextIncludedDayIndex()) would
                    // apply if this successor were actually being pushed —
                    // per request, an excluded weekday or Blackout Date
                    // can't be this item's earliest possible start even in
                    // the analysis, or float would be measured against a
                    // day the schedule could never actually land on. Only
                    // applies to a dependency-DERIVED ES — a root item's
                    // own real scheduled start (the `else` below) is left
                    // exactly as scheduled, even if that date happens to
                    // fall on a day this project has since excluded.
                    const maxPredEf = Math.max(...preds.map(p => efById[p]));
                    const maxPredEfDayIdx = Math.floor(this.dayIndexForDate(new Date(maxPredEf)));
                    es = Math.max(maxPredEf, this.dayIndexToMs(this.nextIncludedDayIndex(maxPredEfDayIdx)));
                } else {
                    es = ownStartMs;
                }
                esById[id] = es;
                efById[id] = es + durMs;
            });
            compInfos.push({ comp, compSet, topoOrder });
        });

        // ---- shared "finish line" across the WHOLE schedule ----
        // Two chains can be logically part of the same overall plan without a
        // direct predecessor link tying them together. Without this, a
        // shorter chain that doesn't happen to feed into anything else would
        // be scored purely against its own tiny finish — a straight,
        // unbranched chain always has zero internal slack by definition —
        // instead of against how much later the SLOWEST chain in the entire
        // schedule actually finishes. Every end (leaf) activity anchors to
        // this one shared date; every beginning (root) activity already
        // anchors to its own real scheduled date from the forward pass above
        // — float is the gap between those two anchors.
        let projectEnd = -Infinity;
        compInfos.forEach(({ comp }) => {
            comp.forEach(id => { if (efById[id] > projectEnd) projectEnd = efById[id]; });
        });

        // ---- pass 2: backward (latest start/finish) anchored to that shared finish ----
        compInfos.forEach(({ comp, compSet, topoOrder }) => {
            [...topoOrder].reverse().forEach(id => {
                const durMs = (parseFloat(byId[id].duration_hours) || 0) * 3600000;
                const succs = (successorsOf[id] || []).filter(sid => compSet.has(sid));
                const lf = succs.length ? Math.min(...succs.map(sid => lsById[sid])) : projectEnd;
                lfById[id] = lf;
                let ls = lf - durMs;
                // Mirrors the forward pass's day-skip in the other
                // direction — the latest this item could start without
                // delaying anything downstream can't land on an excluded
                // day either; if it does, the real latest start is the
                // nearest active day before it.
                const lsDayIdx = Math.floor(this.dayIndexForDate(new Date(ls)));
                if (!this.isDayIncluded(lsDayIdx)) ls = this.dayIndexToMs(this.prevIncludedDayIndex(lsDayIdx));
                lsById[id] = ls;
            });
            // float is a duration (late-start minus early-start), so convert
            // back out of milliseconds into hours for display/storage.
            comp.forEach(id => { floatById[id] = Math.round(((lsById[id] - esById[id]) / 3600000) * 100) / 100; });
        });

        return { floatById, esById, efById, lsById, lfById };
    }
    // Zero float (within rounding) is the actual, complete definition of
    // "on the critical path" under standard CPM — no separate chain
    // walk-back needed on top of it. (One WAS tried: for every zero-float
    // item, follow predecessor_ids back and mark the whole lineage
    // critical too. That over-includes — when an item has two
    // predecessors, the one that ISN'T the binding constraint on its
    // early start can legitimately carry real float of its own even
    // though it directly precedes a zero-float item, and the walk-back
    // had no way to tell the two apart.)
    isCriticalItem(id) {
        return !!(this.criticalPathData && this.criticalPathData.floatById[id] !== null && this.criticalPathData.floatById[id] !== undefined && this.criticalPathData.floatById[id] <= 0.01);
    }
    criticalPathFloatLabel(id) {
        if (!this.criticalPathData) return '—';
        const f = this.criticalPathData.floatById[id];
        if (f === null || f === undefined) {
            const it = this.DATA.items.find(i => i.id === id);
            const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
            // Matches computeCriticalPath()'s own cutoff — "in the past"
            // means fully finished (itemEndMs), not merely started before
            // today. An activity that started yesterday but is still
            // running IS included in the analysis; null here for one of
            // those just means it's isolated (no links), same as any
            // other unlinked current/future item.
            if (it && this.itemEndMs(it) <= todayStart.getTime()) return 'In the past — not included in critical path analysis';
            return 'Not linked to other activities';
        }
        if (f <= 0.01) return '0 days — on the critical path 🔥';
        return `${hoursToDays(f)} days of slack`;
    }
    toggleCriticalPath(checked) {
        this.showCriticalPath = checked;
        this.renderGantt();
        this.scrollWaterfallToTop();
    }

    isAncestor(candidateId, startId, visited) {
        visited = visited || new Set();
        if (startId === candidateId) return true;
        if (visited.has(startId)) return false;
        visited.add(startId);
        const item = this.DATA.items.find(i => i.id === startId);
        if (!item || !item.predecessor_ids) return false;
        return item.predecessor_ids.some(pid => this.isAncestor(candidateId, pid, visited));
    }

    async addPredecessorLink(targetId, sourceId) {
        const target = this.DATA.items.find(i => i.id === targetId);
        const source = this.DATA.items.find(i => i.id === sourceId);
        if (!target || !source) return;
        target.predecessor_ids = target.predecessor_ids || [];
        if (target.predecessor_ids.includes(sourceId)) { this.toast('Already linked.'); return; }
        if (this.isAncestor(targetId, sourceId)) { this.toast("Can't link — that would create a circular dependency."); return; }
        target.predecessor_ids.push(sourceId);
        await this.ItemsDB.update(targetId, { predecessor_ids: target.predecessor_ids });
        this.toast(`Linked: "${source.asset_name}" → "${target.asset_name}"`);
        await this.enforceDependencies(sourceId);
        // immediately focus the chain that was just created, so the grey-out
        // effect is visible right away instead of waiting for a separate click
        this.connectionFocusId = targetId;
        this.renderGantt();
    }

    async removePredecessorLink(targetId, sourceId) {
        const target = this.DATA.items.find(i => i.id === targetId);
        if (!target) return;
        target.predecessor_ids = (target.predecessor_ids || []).filter(id => id !== sourceId);
        await this.ItemsDB.update(targetId, { predecessor_ids: target.predecessor_ids });
        this.renderGantt();
    }

    /* Draw a connector line for every predecessor -> successor pair currently
       visible on screen. Positions are read straight from the rendered DOM so
       they always match whatever lane/row layout is on screen. Pairs that
       don't currently share the same row ("space") — because filtering or the
       active group-by split them apart — are skipped entirely, since a line
       crossing between unrelated swim-lanes reads as noise rather than signal. */
    renderConnections(bodyEl, svgId) {
        bodyEl = bodyEl || this.$('ganttBody');
        svgId = svgId || 'connectionsSvg';
        let svg = this.$(svgId);
        if (!svg) {
            svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.id = svgId;
            svg.setAttribute('class', 'connections-svg');
            svg.innerHTML = `<defs><marker id="arrowHead-${svgId}" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#5f6368"/></marker></defs>`;
            bodyEl.appendChild(svg);
        }
        const w = bodyEl.scrollWidth, h = bodyEl.scrollHeight;
        svg.setAttribute('width', w);
        svg.setAttribute('height', h);
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

        const bodyRect = bodyEl.getBoundingClientRect();
        const itemEls = bodyEl.querySelectorAll('.gantt-item');
        const rectById = {};
        itemEls.forEach(el => {
            const r = el.getBoundingClientRect();
            rectById[el.dataset.id] = {
                left: r.left - bodyRect.left, right: r.right - bodyRect.left,
                top: r.top - bodyRect.top, bottom: r.bottom - bodyRect.top,
                midY: r.top - bodyRect.top + r.height / 2
            };
        });

        let paths = svg.querySelector('defs').outerHTML;
        Object.keys(rectById).forEach(succId => {
            const succItem = this.DATA.items.find(i => i.id === succId);
            if (!succItem || !succItem.predecessor_ids) return;
            succItem.predecessor_ids.forEach(predId => {
                if (this.focusChainSet && !this.focusChainSet.has(predId) && !this.focusChainSet.has(succId)) return;
                const predRect = rectById[predId];
                const succRect = rectById[succId];
                if (!predRect || !succRect) return;
                // Connections used to be skipped outright whenever the
                // predecessor and successor weren't in the exact same row
                // (e.g. different zones when grouped by zone, or — always,
                // by construction — Overview's one-row-per-activity
                // waterfall layout). pickTrunkX()/branchConnectorPath()
                // are plain geometry with no same-row assumption baked in,
                // so routing a connector across rows/groups works the same
                // way as routing between two lanes in one row — just using
                // every other rendered item as a potential obstacle instead
                // of only same-row ones.
                const obstacles = Object.keys(rectById)
                    .filter(id => id !== predId && id !== succId)
                    .map(id => rectById[id]);

                let d;
                if (Math.abs(predRect.midY - succRect.midY) < 1) {
                    // same lane — the chain just continues, draw a short direct line
                    d = this.sameLaneConnectorPath(predRect.right, predRect.midY, succRect.left, succRect.midY);
                } else {
                    // different lane — branch down from the predecessor's bottom
                    // edge through a shared vertical trunk into the successor
                    const dropX = Math.max(predRect.left + 4, Math.min(predRect.left + 10, predRect.right - 4));
                    const trunkX = this.pickTrunkX(dropX, predRect.bottom, succRect.left, succRect.midY, obstacles);
                    d = this.branchConnectorPath(predRect.left, predRect.right, predRect.bottom, trunkX, succRect.left, succRect.midY);
                }
                paths += `<path class="conn-line" d="${d}" marker-end="url(#arrowHead-${svgId})" data-pred="${predId}" data-succ="${succId}" onclick="this.getRootNode().host.handleConnectorClick('${predId}','${succId}')"></path>`;
            });
        });
        svg.innerHTML = paths;
    }
    handleConnectorClick(predId, succId) {
        if (confirm('Remove this dependency link?')) this.removePredecessorLink(succId, predId);
    }

    // The last calendar day-index (within TIMELINE_START's frame) an item is
    // actually active on.
    //
    // Previously computed as floor(dayIndexForDate(itemEndMs(item) - 1ms)) —
    // pulling back 1ms before flooring to land on the end's own day instead
    // of the following one. That only works when every item starts at the
    // exact same anchor hour dayIndexToMs() schedules into (originally
    // assumed to be a fixed hour across the board). Real items don't all
    // start at that hour (confirmed against live data: items recorded at
    // 14:00, not the scheduler's 7am placement hour) — whenever an item's
    // OWN start hour sits past that anchor, a whole-day-duration item's end
    // instant crosses into the next calendar day even after the -1ms pullback,
    // so lastActiveDayIndex silently returned one day too LATE. Every
    // successor then got scheduled a full day later than the "can share the
    // same calendar day as its predecessor" rule intends — compounding at
    // every hop down a chain, which is what was corrupting both predecessor-
    // ordering repairs and critical path's float calculation (two chains
    // accumulating different amounts of pure scheduling padding ahead of
    // identical real work no longer compare correctly against each other).
    //
    // Fixed by deriving this from the item's own START day (always exact,
    // no anchor-hour assumption) plus how many whole calendar days its
    // duration spans — independent of what hour the item actually starts at.
    lastActiveDayIndex(item) {
        const startDayIdx = Math.floor(this.dayIndexForDate(new Date(item.start_ts)));
        const spanDays = Math.max(1, Math.ceil((parseFloat(item.duration_hours) || 24) / 24));
        return startDayIdx + spanDays - 1;
    }
    // 7am on a given day-index, as an absolute timestamp — the same
    // start-of-day convention every item's start_ts already uses.
    dayIndexToMs(dayIdx) {
        const d = new Date(this.TIMELINE_START);
        d.setDate(d.getDate() + dayIdx);
        d.setHours(7, 0, 0, 0);
        return d.getTime();
    }
    // A successor must start on a calendar day strictly after every one of
    // its predecessors' own last active day — never the same day — so the
    // earliest a successor may start is 7am the day AFTER whichever
    // predecessor's own last active day is latest. Returns null with no
    // predecessors.
    minAllowedStartMs(predItems) {
        if (!predItems || !predItems.length) return null;
        return Math.max(...predItems.map(p => this.dayIndexToMs(this.lastActiveDayIndex(p) + 1)));
    }

    /* A successor must start strictly after its predecessor's own last
       active day — sharing the same calendar day is NOT allowed — so this
       force-moves whenever the predecessor's last active day is the same
       as or later than the successor's current day, always to the very
       next day after the predecessor's own last active day (not all the
       way out to the predecessor's exact finish time). The shift cascades
       down the chain. */
    async enforceDependencies(changedId, visited) {
        visited = visited || new Set();
        if (visited.has(changedId)) return;
        visited.add(changedId);
        const changed = this.DATA.items.find(i => i.id === changedId);
        if (!changed) return;
        const predLastDay = this.lastActiveDayIndex(changed);
        const successors = this.DATA.items.filter(i => (i.predecessor_ids || []).includes(changedId));
        for (const succ of successors) {
            const succDay = Math.floor(this.dayIndexForDate(new Date(succ.start_ts)));
            if (predLastDay >= succDay) {
                // nextIncludedDayIndex() rather than a flat predLastDay+1 —
                // the auto-cascade must land on the next day this
                // project's Included Days setting actually allows, not
                // just the next calendar day, per request.
                succ.start_ts = new Date(this.dayIndexToMs(this.nextIncludedDayIndex(predLastDay + 1))).toISOString();
                await this.ItemsDB.update(succ.id, { start_ts: succ.start_ts });
                // this successor's date just changed as a side effect of the
                // cascade, not from being dragged directly — still needs to
                // be part of what gets published to Schedule once the user
                // accepts, same as the item that was actually dragged.
                this.markPendingSync(succ);
                await this.enforceDependencies(succ.id, visited);
            }
        }
    }

    // Read-only dry-run counterpart to enforceDependencies() above — exact
    // same day-math and cascade walk, but against a HYPOTHETICAL item that
    // isn't in this.DATA.items yet (and may never be — this is a preview),
    // and returns what WOULD shift instead of writing anything. Used by the
    // Schedule-side reschedule flow to show impact before the user commits.
    //
    // origItemId is the REAL item being replaced (the cancelled activity).
    // Real successors' predecessor_ids point at THAT id, never at
    // hypotheticalItem's — nothing in the live data can possibly reference
    // an id that doesn't exist yet — so the walk has to start by looking up
    // origItemId's successors, just scored against hypotheticalItem's dates
    // instead of origItemId's own current ones (since that's what they'll
    // actually depend on once the real reschedule redirects those
    // predecessor_ids from origItemId to the new item). Every hop after
    // that first one is a normal walk between real, already-linked items,
    // same as enforceDependencies().
    simulateReschedulePreview(hypotheticalItem, origItemId) {
        const changes = []; // [{ item, oldStartTs, newStartTs }], item = the REAL DATA.items object
        const working = new Map(); // real item id -> proposed new start_ts, for items already shifted earlier in this same walk
        const visited = new Set();

        const currentStartTs = (id) => {
            if (working.has(id)) return working.get(id);
            const it = this.DATA.items.find(i => i.id === id);
            return it ? it.start_ts : null;
        };
        const durationOf = (id) => {
            const it = this.DATA.items.find(i => i.id === id);
            return (it && it.duration_hours) || 24;
        };
        // Same start-day + whole-day-span derivation as lastActiveDayIndex()
        // above — not anchor-hour-fragile like the old end-timestamp
        // approach was (see that function's comment for the full story).
        const lastActiveDayIndexFor = (startTs, durationHours) => {
            if (!startTs) return -Infinity;
            const startDayIdx = Math.floor(this.dayIndexForDate(new Date(startTs)));
            const spanDays = Math.max(1, Math.ceil((parseFloat(durationHours) || 24) / 24));
            return startDayIdx + spanDays - 1;
        };

        const evaluateSuccessors = (predecessorSearchId, predLastDay) => {
            const successors = this.DATA.items.filter(i => (i.predecessor_ids || []).includes(predecessorSearchId));
            for (const succ of successors) {
                const succDay = Math.floor(this.dayIndexForDate(new Date(currentStartTs(succ.id))));
                if (predLastDay >= succDay) {
                    // Mirrors enforceDependencies()'s own nextIncludedDayIndex()
                    // call — this preview must land on the same day the real
                    // cascade actually will, Included Days skip included.
                    const newStartTs = new Date(this.dayIndexToMs(this.nextIncludedDayIndex(predLastDay + 1))).toISOString();
                    working.set(succ.id, newStartTs);
                    changes.push({ item: succ, oldStartTs: succ.start_ts, newStartTs });
                    walk(succ.id);
                }
            }
        };

        const walk = (changedId) => {
            if (visited.has(changedId)) return;
            visited.add(changedId);
            evaluateSuccessors(changedId, lastActiveDayIndexFor(currentStartTs(changedId), durationOf(changedId)));
        };

        // First hop: origItemId's real successors, scored against the
        // hypothetical item's dates rather than origItemId's own.
        visited.add(origItemId);
        evaluateSuccessors(origItemId, lastActiveDayIndexFor(hypotheticalItem.start_ts, hypotheticalItem.duration_hours));

        return changes;
    }

    // Full-schedule sweep for predecessor/successor ordering violations —
    // a predecessor whose own last active day falls AFTER a successor it's
    // linked to. enforceDependencies() only ever runs reactively, starting
    // from one specific item that just changed, so it can't catch a
    // violation introduced some other way (a bulk import, a direct DB
    // edit, a gap from before this enforcement existed). This re-validates
    // every linked pair and fixes any violation found, via the same
    // enforceDependencies() engine — same category of self-healing
    // repairLaunchPadLinks()/clearOrphanedScheduleRows() already do for
    // their own kind of drift. Returns how many root predecessors needed a
    // fix (each may have cascaded further down its own chain).
    async repairPredecessorOrdering() {
        const predecessorIds = new Set();
        this.DATA.items.forEach(it => (it.predecessor_ids || []).forEach(pid => predecessorIds.add(pid)));

        let fixedCount = 0;
        const pendingBefore = new Set(this.pendingSyncIds);
        for (const id of predecessorIds) {
            if (!this.DATA.items.find(it => it.id === id)) continue; // predecessor_ids pointing at a since-deleted item
            const before = this.DATA.items.map(it => it.start_ts).join('|');
            await this.enforceDependencies(id);
            const after = this.DATA.items.map(it => it.start_ts).join('|');
            if (before !== after) fixedCount++;
        }

        if (fixedCount > 0) {
            // This is an automated correctness fix, not a deliberate edit —
            // it shouldn't sit in pendingSyncIds waiting for someone to
            // notice and manually Accept it. Confirmed happening in
            // production: this runs in the background on every load
            // (never awaited by init()), so a user's Accept & Publish click
            // can easily land before this sweep finishes — whatever it
            // fixes afterward was left stranded, correct in Bridge but
            // never reaching Schedule, with nothing visibly showing it was
            // still outstanding. Publishing immediately instead closes that
            // race, same as the Schedule-side reschedule flow already does
            // for its own cascade.
            if (!this.UNIFIED_SCHEDULE) {
                const newlyPending = Array.from(this.pendingSyncIds).filter(id => !pendingBefore.has(id));
                for (const id of newlyPending) {
                    const item = this.DATA.items.find(it => it.id === id);
                    if (!item) continue;
                    const ok = await this.syncItemToLaunchPad(item);
                    if (ok) this.pendingSyncIds.delete(id);
                }
                this.savePendingSyncState();
            }
            this.renderGantt();
            this.updatePendingSyncUI();
        }
        return fixedCount;
    }

    // Catches items already left stranded by the race described above
    // (before this fix existed) — a Bridge item whose own start_ts no
    // longer matches the date its Schedule link (launchpad_day_label)
    // points at. Confirmed directly in production: Bridge showed the
    // correct new date, Accept & Publish had been clicked, but Schedule
    // still had the old row and no new one — this is exactly that
    // signature. Independent of pendingSyncIds (which is per-browser,
    // localStorage-backed, and wouldn't even still reference a change from
    // a previous session) — this instead trusts the data itself.
    async repairStaleScheduleLinks() {
        if (this.UNIFIED_SCHEDULE) return 0; // one shared table either way — nothing to drift out of sync with
        let fixedCount = 0;
        for (const item of this.DATA.items) {
            if (!item.launchpad_id) continue; // never published at all — not this repair's job
            const actualDayLabel = new Date(item.start_ts).toISOString().slice(0, 10);
            if (item.launchpad_day_label === actualDayLabel) continue; // already in sync
            const ok = await this.syncItemToLaunchPad(item);
            if (ok) { fixedCount++; this.pendingSyncIds.delete(item.id); }
        }
        if (fixedCount > 0) {
            this.savePendingSyncState();
            this.updatePendingSyncUI();
        }
        return fixedCount;
    }

    /* =========================================================================
       6c. EXPAND / COLLAPSE — "Expand" gives every activity in every row its
       own line (laneCount == item count, so nothing ever shares a lane and
       there's zero ambiguity about what's overlapping what). "Collapse"
       returns to the normal packed view, which still applies every rule from
       this.layoutLanes() above — predecessor lanes never sit above their
       successor's, and the obstacle-aware connector routing still keeps
       arrows from cutting through other activities.
       ========================================================================= */

    // No button calls this anymore (removed along with Compact/Normal/
    // Wide zoom, which was the only place a packed/grouped view — the
    // thing this toggle affected — could ever be shown). Left in place
    // rather than deleted in case grouped views come back; guarded so it
    // can't throw if something still manages to call it.
    toggleExpandView() {
        this.expandedView = !this.expandedView;
        const btn = this.$('expandToggleBtn');
        if (btn) {
            btn.textContent = this.expandedView ? '⬆ Collapse' : '⬍ Expand All Activities';
            btn.title = this.expandedView
                ? 'Return to the packed view (still keeps linked chains cascading cleanly)'
                : 'Give every activity its own line, or collapse back to the packed view';
        }
        this.renderGantt();
    }

    /* =========================================================================
       MULTI-SELECT — Ctrl/Cmd+click toggles an activity in/out of the
       selection; dragging any selected activity then moves the whole group
       together, each keeping its own duration and relative offset.
       ========================================================================= */
    toggleMultiSelect(id) {
        if (this.multiSelectedIds.has(id)) this.multiSelectedIds.delete(id);
        else this.multiSelectedIds.add(id);
        this.updateMultiSelectIndicator();
        this.renderGantt();
    }
    clearMultiSelect() {
        if (!this.multiSelectedIds.size) return;
        this.multiSelectedIds.clear();
        this.updateMultiSelectIndicator();
        this.renderGantt();
    }
    updateMultiSelectIndicator() {
        const el = this.$('multiSelectIndicator');
        if (this.multiSelectedIds.size > 0) {
            el.style.display = 'inline-flex';
            el.querySelector('.count').textContent = this.multiSelectedIds.size;
        } else {
            el.style.display = 'none';
        }
    }


    /* ---- Drag to move / resize to change duration ---- */
    attachDragHandlers(root) {
        root = root || document;
        root.querySelectorAll('.gantt-item').forEach(el => {
            el.addEventListener('pointerdown', (e) => {
                // Both handled separately by their own listeners (see
                // attachLinkHandlers() below) — those call stopPropagation()
                // too, which should already keep this from also firing, but
                // excluding them here directly means a move-drag can never
                // start racing a connect-drag for the same pointerdown even
                // if that propagation-stopping ever doesn't apply (e.g. a
                // future capture-phase listener added upstream). Two drag
                // systems both listening on window at once is exactly how
                // "the connector line never shows" happens — the move-drag
                // silently wins instead.
                if (e.target.classList.contains('resize-handle') || e.target.closest('.link-handle')) return;
                this.startDrag(e, el, 'move');
            });
            el.addEventListener('click', (e) => {
                if (this.dragCtx && this.dragCtx.moved) return; // suppress click after a real drag
                if (e.ctrlKey || e.metaKey) { this.toggleMultiSelect(el.dataset.id); return; }
                this.openDetailPanel(el.dataset.id);
            });
        });
        root.querySelectorAll('.resize-handle').forEach(h => {
            h.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                this.startDrag(e, h.closest('.gantt-item'), h.dataset.edge === 'left' ? 'resize-left' : 'resize-right');
            });
        });
    }

    startDrag(e, el, mode) {
        e.preventDefault();
        if (!this.requireEditMode()) return;
        const id = el.dataset.id;
        const item = this.DATA.items.find(i => i.id === id);
        if (!item) return;
        // dragging a move-handle on a multi-selected item (with others also
        // selected) moves the whole group together, each keeping its own
        // duration and relative time offset from the others
        const isGroupDrag = mode === 'move' && this.multiSelectedIds.has(id) && this.multiSelectedIds.size > 1;
        const groupSnapshot = isGroupDrag
            ? [...this.multiSelectedIds].map(mid => {
                  const mItem = this.DATA.items.find(i => i.id === mid);
                  const mEl = this.shadowRoot.querySelector(`.gantt-item[data-id="${mid}"]`);
                  return mItem && mEl ? { id: mid, el: mEl, origLeft: this.displayLeft(mItem), origStart: new Date(mItem.start_ts) } : null;
              }).filter(Boolean)
            : null;
        this.dragCtx = {
            id, mode, moved: false,
            startX: e.clientX,
            startScrollLeft: this.$('ganttWrap').scrollLeft,
            origLeft: this.displayLeft(item),
            origWidth: this.displayWidth(item),
            origStart: new Date(item.start_ts),
            origDuration: item.duration_hours,
            el,
            isGroupDrag,
            groupSnapshot
        };
        el.classList.add('dragging');
        window.addEventListener('pointermove', this._onDragMoveBound);
        window.addEventListener('pointerup', this._onDragEndBound);
    }

    snapHours(hoursFloat) {
        // snap to nearest 15 minutes
        return Math.round(hoursFloat * 4) / 4;
    }

    // Effective horizontal drag distance = raw pointer movement + however
    // much #ganttWrap has scrolled since the drag started, so the dragged
    // item keeps tracking correctly even while auto-scroll carries the
    // timeline sideways underneath a pointer that isn't itself moving.
    dragDx(clientX) {
        const wrap = this.$('ganttWrap');
        return (clientX - this.dragCtx.startX) + (wrap.scrollLeft - this.dragCtx.startScrollLeft);
    }

    applyDragPosition(clientX) {
        if (!this.dragCtx) return;
        const dx = this.dragDx(clientX);
        if (Math.abs(dx) > 3) this.dragCtx.moved = true;
        const el = this.dragCtx.el;
        if (this.dragCtx.mode === 'move') {
            if (this.dragCtx.isGroupDrag) {
                this.dragCtx.groupSnapshot.forEach(snap => { snap.el.style.left = (snap.origLeft + dx) + 'px'; });
            } else {
                el.style.left = (this.dragCtx.origLeft + dx) + 'px';
            }
        } else if (this.dragCtx.mode === 'resize-right') {
            el.style.width = Math.max(20, this.dragCtx.origWidth + dx) + 'px';
        } else if (this.dragCtx.mode === 'resize-left') {
            const newLeft = this.dragCtx.origLeft + dx;
            const newWidth = Math.max(20, this.dragCtx.origWidth - dx);
            el.style.left = newLeft + 'px';
            el.style.width = newWidth + 'px';
        }
    }

    onDragMove(e) {
        if (!this.dragCtx) return;
        this.updateAutoScroll(e.clientX, e.clientY, { horizontal: true, vertical: false }, () => this.applyDragPosition(e.clientX));
        this.applyDragPosition(e.clientX);
    }

    async onDragEnd(e) {
        window.removeEventListener('pointermove', this._onDragMoveBound);
        window.removeEventListener('pointerup', this._onDragEndBound);
        this.stopAutoScroll();
        if (!this.dragCtx) return;
        const { id, mode, el, moved, isGroupDrag } = this.dragCtx;
        el.classList.remove('dragging');
        if (!moved) { this.dragCtx = null; return; }

        const dx = this.dragDx(e.clientX);

        if (isGroupDrag) {
            // one shared time-shift applied to every selected item's own
            // original start, so the whole group moves together while each
            // keeps its own duration and relative offset from the others.
            // Snapped to a whole number of days (same reasoning as the
            // single-item move above) — every item's original start_ts was
            // already 7am-anchored, so a clean whole-day shift keeps it
            // that way instead of drifting onto an odd time that pixel/
            // rounding noise could then read as the wrong day.
            const dayDelta = Math.round(dx / this.DAY_WIDTH);
            const shiftMs = dayDelta * 86400000;
            this.setSaveIndicator('dirty', 'Saving...');
            for (const snap of this.dragCtx.groupSnapshot) {
                const item = this.DATA.items.find(i => i.id === snap.id);
                if (!item) continue;
                item.start_ts = new Date(snap.origStart.getTime() + shiftMs).toISOString();
                if (item.predecessor_ids && item.predecessor_ids.length) {
                    const predItems = item.predecessor_ids.map(pid => this.DATA.items.find(i => i.id === pid)).filter(Boolean);
                    const minStart = this.minAllowedStartMs(predItems);
                    if (minStart !== null && new Date(item.start_ts).getTime() < minStart) item.start_ts = new Date(minStart).toISOString();
                }
                await this.ItemsDB.update(item.id, { start_ts: item.start_ts });
            }
            for (const snap of this.dragCtx.groupSnapshot) await this.enforceDependencies(snap.id);
            for (const snap of this.dragCtx.groupSnapshot) this.markPendingSync(this.DATA.items.find(i => i.id === snap.id));
            this.setSaveIndicator('ready', 'Saved');
            this.renderGantt();
            this.dragCtx = null;
            return;
        }

        const item = this.DATA.items.find(i => i.id === id);

        if (mode === 'move') {
            // Snaps to the WHOLE day the mouse is actually over — rounding
            // to the nearest 15 MINUTES of a fractional day position (the
            // old math) let ordinary pixel/rounding noise land a hair
            // either side of a day boundary, which Math.floor()-based day
            // math elsewhere then read as the day before or after wherever
            // it was actually dropped. Every item's start is 7am by
            // convention throughout this app anyway (see dayIndexToMs()),
            // so there's no real precision lost by snapping straight to
            // that instead of preserving whatever odd time the pixel math
            // produced.
            const dayDelta = Math.round((this.dragCtx.origLeft + dx) / this.DAY_WIDTH);
            item.start_ts = new Date(this.dayIndexToMs(dayDelta)).toISOString();
        } else if (mode === 'resize-right') {
            const newWidthPx = Math.max(20, this.dragCtx.origWidth + dx);
            item.duration_hours = Math.max(0.25, this.snapHours((newWidthPx / this.DAY_WIDTH) * 24));
        } else if (mode === 'resize-left') {
            const newLeftPx = this.dragCtx.origLeft + dx;
            const newWidthPx = Math.max(20, this.dragCtx.origWidth - dx);
            const dayDelta = Math.round(newLeftPx / this.DAY_WIDTH);
            item.start_ts = new Date(this.dayIndexToMs(dayDelta)).toISOString();
            item.duration_hours = Math.max(0.25, this.snapHours((newWidthPx / this.DAY_WIDTH) * 24));
        }

        // an item can never sit on or before its own predecessor's last
        // active day — must be strictly after (see minAllowedStartMs()) —
        // clamp forward if needed
        if (item.predecessor_ids && item.predecessor_ids.length) {
            const predItems = item.predecessor_ids.map(pid => this.DATA.items.find(i => i.id === pid)).filter(Boolean);
            const minStart = this.minAllowedStartMs(predItems);
            if (minStart !== null && new Date(item.start_ts).getTime() < minStart) {
                item.start_ts = new Date(minStart).toISOString();
                this.toast("Snapped to the day after its predecessor — can't start any earlier than that.");
            }
        }

        this.setSaveIndicator('dirty', 'Saving...');
        await this.ItemsDB.update(id, { start_ts: item.start_ts, duration_hours: item.duration_hours });
        await this.enforceDependencies(id);
        this.markPendingSync(item);
        this.setSaveIndicator('ready', 'Saved');
        this.renderGantt();
        this.dragCtx = null;
    }

    /* =========================================================================
       7. ITEM DETAIL PANEL / ADD-EDIT MODAL
       ========================================================================= */

    openDetailPanel(id) {
        const it = this.DATA.items.find(i => i.id === id);
        if (!it) return;
        try { this.criticalPathData = this.computeCriticalPath(); } catch (err) { console.error('computeCriticalPath failed', err); }
        const panel = this.$('detailPanel');
        const start = new Date(it.start_ts);
        panel.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                <h3 style="margin:0; color:var(--green-dark);">Item Detail</h3>
                <button class="modal-close" onclick="this.getRootNode().host.closeDetailPanel()">×</button>
            </div>
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:14px;">
                <span class="legend-swatch" style="width:14px;height:14px;background:${this.activityColor(it.activity_name)};"></span>
                <strong>${escHtml(it.activity_name)}</strong>
            </div>
            <div style="font-size:13px; line-height:2;">
                <div><strong>Asset:</strong> ${escHtml(it.asset_name)}</div>
                <div><strong>Activity:</strong> ${escHtml(it.activity_name)}</div>
                <div><strong>Area:</strong> ${escHtml(it.area || '—')}</div>
                <div><strong>Contractor(s):</strong> ${escHtml((it.contractor_name || '').split('|').map(s => s.trim()).filter(Boolean).join(', ') || '—')}</div>
                <div><strong>Start:</strong> ${start.toLocaleString()}</div>
                <div><strong>Duration:</strong> ${hoursToDays(it.duration_hours)} days</div>
                <div><strong>Float:</strong> ${this.criticalPathFloatLabel(it.id)}</div>
                <div><strong>Status (LaunchPad):</strong> <span id="detailStatusValue">Checking...</span></div>
                ${this.isPastOrToday(it) ? `<div><strong>Result (Supabase):</strong> <span id="detailResultValue">Checking...</span></div>` : ''}
                <div><strong>Constraints (predecessors):</strong> <span id="detailPredsValue">${(it.predecessor_ids||[]).length ? 'Checking...' : 'None'}</span></div>
                <div><strong>Successors:</strong> ${this.DATA.items.filter(x=>(x.predecessor_ids||[]).includes(it.id)).map(x=>escHtml(x.asset_name+' — '+x.activity_name)).join(', ') || '—'}</div>
                ${it.notes ? `<div style="margin-top:8px;"><strong>Notes:</strong><br>${escHtml(it.notes)}</div>` : ''}
            </div>
            <div style="margin-top:20px; display:flex; gap:8px;">
                <button class="tool-btn primary small" onclick="this.getRootNode().host.editItem('${it.id}')">Edit</button>
                <button class="tool-btn small" style="border-color:var(--red); color:var(--red);" onclick="this.getRootNode().host.deleteItemById('${it.id}')">Delete</button>
            </div>`;
        panel.classList.add('open');
        this.fetchLaunchPadStatusInto(it.activity_name, it.asset_name, 'detailStatusValue');
        if (this.isPastOrToday(it)) this.fetchSupabaseResultInto(it.launchpad_id, 'detailResultValue');
        if ((it.predecessor_ids || []).length) {
            this.unsatisfiedPredecessorsLabel(it).then(label => {
                const el = this.$('detailPredsValue');
                if (el) el.textContent = label;
            });
        }
        this.connectionFocusId = id;
        this.renderGantt();
        const chainSize = this.focusChainSet ? this.focusChainSet.size : 1;
        this.toast(chainSize > 1 ? `Highlighting this chain (${chainSize} linked activities) — click empty space to clear` : 'This activity has no links yet', 3200);
    }
    closeDetailPanel() {
        this.$('detailPanel').classList.remove('open');
        if (this.connectionFocusId) {
            this.connectionFocusId = null;
            this.renderGantt();
        }
    }

    editItem(id) {
        this.$('detailPanel').classList.remove('open');
        const it = this.DATA.items.find(i => i.id === id);
        if (!it) return;
        this.$('itemModalTitle').textContent = 'Edit Schedule Item';
        this.$('itemId').value = it.id;
        this.$('itemAsset').value = it.asset_name;
        this.$('itemActivity').value = it.activity_name;
        this.$('itemDuration').value = hoursToDays(it.duration_hours);
        this.$('itemStart').value = this.toLocalInputValue(new Date(it.start_ts));
        this.$('itemArea').value = it.area || '';
        this.renderContractorCheckboxList('itemContractorList', (it.contractor_name || '').split('|').map(s => s.trim()).filter(Boolean));
        this.$('itemNotes').value = it.notes || '';
        this.$('itemDeleteBtn').style.display = 'inline-flex';
        this.currentItemPredecessors = (it.predecessor_ids || []).slice();
        this.renderPredChips();
        this.openModal('itemModal');
        // Viewing is always allowed, even locked — this is what makes that
        // read-only instead: disables the fields/Save/Delete rather than
        // blocking the click that got here in the first place.
        this.applyItemModalLockState();
    }

    toLocalInputValue(d) {
        const pad = n => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    async deleteItemById(id) {
        if (!this.requireEditMode()) return;
        if (!confirm('Delete this schedule item?')) return;
        const item = this.DATA.items.find(i => i.id === id);
        await this.ItemsDB.remove(id);
        this.DATA.items = this.DATA.items.filter(i => i.id !== id);
        this.multiSelectedIds.delete(id);
        this.updateMultiSelectIndicator();
        this.pendingSyncIds.delete(id); // no point pushing a move for an item that's about to be deleted
        this.savePendingSyncState();
        if (item && item.launchpad_id && !item._localOnly) {
            // ItemsDB.remove() above already staged this (draft_deleted in
            // unified mode, or left the LaunchPad row untouched in legacy
            // mode) rather than actually removing it from Schedule — the
            // row stays exactly as-is there until this delete is accepted
            // too, same as any other pending change. A _localOnly item
            // never had a real row to begin with, so there's nothing to
            // stage a delete for.
            this.markPendingDelete(item.launchpad_id);
        }
        // drop this item from any successor's predecessor list
        for (const it of this.DATA.items) {
            if (it.predecessor_ids && it.predecessor_ids.includes(id)) {
                it.predecessor_ids = it.predecessor_ids.filter(pid => pid !== id);
                await this.ItemsDB.update(it.id, { predecessor_ids: it.predecessor_ids });
            }
        }
        this.$('detailPanel').classList.remove('open');
        if (this.connectionFocusId === id) this.connectionFocusId = null;
        this.renderGantt();
        this.toast('Item deleted');
    }
    deleteCurrentItem() {
        const id = this.$('itemId').value;
        if (id) this.deleteItemById(id);
        this.closeModal('itemModal');
    }



    /* ---- predecessor chip picker (used inside the New/Edit Item modal) ---- */
    renderPredChips() {
        const holder = this.$('itemPredChips');
        if (!this.currentItemPredecessors.length) {
            holder.innerHTML = '<span style="color:#999; font-size:11.5px;">No predecessors linked yet.</span>';
            return;
        }
        holder.innerHTML = this.currentItemPredecessors.map(pid => {
            const p = this.DATA.items.find(i => i.id === pid);
            const label = p ? `${p.asset_name} — ${p.activity_name}` : 'Unknown item';
            return `<span class="pred-chip">${escHtml(label)}<button onclick="this.getRootNode().host.removePredFromPicker('${pid}')" title="Remove">✕</button></span>`;
        }).join('');
    }
    removePredFromPicker(pid) {
        this.currentItemPredecessors = this.currentItemPredecessors.filter(id => id !== pid);
        this.renderPredChips();
    }
    filterPredCombo(query) {
        const q = query.toLowerCase();
        const currentId = this.$('itemId').value;
        const list = this.$('itemPredList');
        const matches = this.DATA.items
            .filter(i => i.id !== currentId && !this.currentItemPredecessors.includes(i.id))
            .filter(i => `${i.asset_name} ${i.activity_name} ${i.zone}`.toLowerCase().includes(q))
            .slice(0, 30);
        list.innerHTML = matches.map(i =>
            `<div class="opt" onclick="this.getRootNode().host.pickPredFromCombo('${i.id}')">${escHtml(i.asset_name)} — ${escHtml(i.activity_name)} <span style="color:#999;">(${escHtml(i.zone||'')})</span></div>`
        ).join('') || '<div class="opt" style="color:#999;">No matches</div>';
        list.classList.add('open');
    }
    pickPredFromCombo(id) {
        const currentId = this.$('itemId').value;
        if (id === currentId) { this.toast("An item can't be its own predecessor."); return; }
        if (currentId && this.isAncestor(currentId, id)) { this.toast("Can't link — that would create a circular dependency."); return; }
        if (!this.currentItemPredecessors.includes(id)) this.currentItemPredecessors.push(id);
        this.$('itemPredSearch').value = '';
        this.$('itemPredList').classList.remove('open');
        this.renderPredChips();
    }

    async saveItemModal() {
        if (!this.requireEditMode()) return;
        const id = this.$('itemId').value;
        const assetName = this.$('itemAsset').value.trim();
        const activityName = this.$('itemActivity').value.trim();
        const durationDays = parseFloat(this.$('itemDuration').value);
        const duration = daysToHours(durationDays);
        const startVal = this.$('itemStart').value;

        if (!assetName || !activityName || !duration || !startVal) {
            this.toast('Please fill in Asset, Activity, Duration and Start.');
            return;
        }
        await this.ensureListValue('assets', assetName);
        await this.ensureListValue('activities', activityName);
        const contractorNames = this.getCheckedContractors('itemContractorList');
        for (const name of contractorNames) await this.ensureListValue('contractors', name);
        const contractorName = contractorNames.join(' | ');

        // an item can't start before any of its chosen predecessors finish
        let startTs = new Date(startVal).toISOString();
        const predItems = this.currentItemPredecessors.map(pid => this.DATA.items.find(i => i.id === pid)).filter(Boolean);
        if (predItems.length) {
            const minStart = this.minAllowedStartMs(predItems);
            if (minStart !== null && new Date(startTs).getTime() < minStart) {
                startTs = new Date(minStart).toISOString();
                this.toast("Start date adjusted — can't begin until the day after its predecessor.");
            }
        }

        const payload = {
            asset_name: assetName,
            activity_name: activityName,
            duration_hours: duration,
            start_ts: startTs,
            area: this.$('itemArea').value,
            contractor_name: contractorName,
            notes: this.$('itemNotes').value,
            predecessor_ids: this.currentItemPredecessors.slice(),
            // type/zone/asset_type are no longer collected anywhere, but
            // non-unified projects' schedule_items.type has a NOT NULL
            // constraint with no default — omitting it entirely (rather
            // than sending '') made every new item's INSERT fail outright
            // (confirmed live: 23502 "null value in column type violates
            // not-null constraint"). Still blank/never shown, just present
            // so the row can actually be created.
            type: '', zone: '', asset_type: ''
        };

        this.setSaveIndicator('dirty', 'Saving...');
        let savedId = id;
        if (id) {
            await this.ItemsDB.update(id, payload);
            const idx = this.DATA.items.findIndex(i => i.id === id);
            if (idx > -1) this.DATA.items[idx] = { ...this.DATA.items[idx], ...payload };
        } else {
            const saved = await this.ItemsDB.insert(payload);
            savedId = saved ? saved.id : uid();
            this.DATA.items.push(saved ? { ...saved, duration_hours: payload.duration_hours } : { id: savedId, ...payload });
        }
        await this.enforceDependencies(savedId);
        this.markPendingSync(this.DATA.items.find(i => i.id === savedId));
        this.setSaveIndicator('ready', 'Saved');
        this.closeModal('itemModal');
        this.renderFilterBar();
        this.renderGantt();
        this.toast('Schedule item saved');
    }

    /* Add a new value to a master list if it doesn't already exist (used when
       a user types a brand-new asset/activity name directly in the item form) */
    async ensureListValue(table, name) {
        const list = this.DATA[table];
        if (list.some(x => x.name.toLowerCase() === name.toLowerCase())) return;
        const row = await this.DB.insert(this.TABLES[table], { name });
        list.push(row || { id: uid(), name });
    }

    /* ---- combobox behavior for Asset / Activity fields ---- */
    filterCombo(inputId, listId, source) {
        const typed = this.$(inputId).value;
        const q = typed.toLowerCase();
        const list = this.$(listId);
        const matches = source.filter(s => s.name.toLowerCase().includes(q)).slice(0, 40);
        let html = matches.map(s => `<div class="opt" onclick="this.getRootNode().host.pickCombo('${inputId}','${listId}','${s.name.replace(/'/g, "\\'")}')">${escHtml(s.name)}</div>`).join('');
        if (q && !source.some(s => s.name.toLowerCase() === q)) {
            html += `<div class="opt add-new" onclick="this.getRootNode().host.pickCombo('${inputId}','${listId}','${typed.replace(/'/g, "\\'")}')">➕ Add "${escHtml(typed)}"</div>`;
        }
        list.innerHTML = html || '<div class="opt" style="color:#999;">No matches</div>';
        list.classList.add('open');
    }
    pickCombo(inputId, listId, value) {
        this.$(inputId).value = value;
        this.$(listId).classList.remove('open');
        if (inputId === 'itemAsset') this.applyAssetLookup(value, 'itemArea');
    }

    // Mirrors LaunchPad's own asset->place linking: if this asset has a known
    // Area from {PROJECT_KEY}dropdownoptions, fill that field in automatically
    // instead of making the person look it up and pick manually. Area is a
    // plain read-only display now (not a dropdown the user can override),
    // so this is the only thing that ever sets it.
    applyAssetLookup(assetName, areaFieldId) {
        const area = this.ASSET_TO_AREA_MAP[assetName];
        if (areaFieldId) {
            const field = this.$(areaFieldId);
            if (field) field.value = area || '';
        }
    }

    /* =========================================================================
       8. BULK ADD — combination builder + paste/CSV, with preview before commit
       ========================================================================= */

    openBulkAddModal() {
        if (!this.requireEditMode()) return;
        this.$('bulkStep1').style.display = 'block';
        this.$('bulkStep2').style.display = 'none';
        this.$('bulkCommitBtn').style.display = 'none';
        this.$('bulkAssetList').innerHTML = this.DATA.assets.map(a =>
            `<label><input type="checkbox" value="${escAttr(a.name)}"> ${escHtml(a.name)}</label>`).join('');
        this.$('bulkActivityList').innerHTML = this.DATA.activities.map(a =>
            `<label><input type="checkbox" value="${escAttr(a.name)}"> ${escHtml(a.name)}</label>`).join('');
        this.renderContractorCheckboxList('bulkContractorList', []);
        this.$('bulkStartDate').value = new Date().toISOString().slice(0, 10);
        this.$('bulkNotes').value = '';
        this.$('bulkAutoLink').checked = false;
        this.openModal('bulkModal');
    }
    filterCheckList(listId, q) {
        q = q.toLowerCase();
        this.$$(`#${listId} label`).forEach(l => l.style.display = l.textContent.toLowerCase().includes(q) ? 'flex' : 'none');
    }
    // Shared by the single-item modal and the bulk Combination Builder —
    // both let a user pick more than one contractor for an activity now,
    // same checkbox-scroll-list idiom this file already uses for Assets/
    // Activities in the bulk builder.
    renderContractorCheckboxList(listId, selectedNames) {
        const selected = new Set(selectedNames || []);
        const el = this.$(listId);
        if (!el) return;
        el.innerHTML = this.DATA.contractors.map(c =>
            `<label><input type="checkbox" value="${escAttr(c.name)}" ${selected.has(c.name) ? 'checked' : ''}> ${escHtml(c.name)}</label>`).join('');
    }
    getCheckedContractors(listId) {
        return [...this.$$(`#${listId} input:checked`)].map(i => i.value);
    }

    // Multi-select popover for the bulk-preview table's Contractor(s)
    // cell — a native <select multiple> needs ctrl/cmd-click to pick more
    // than one, which isn't discoverable, so this gives it the same
    // checkbox-list interaction the rest of the modal already uses.
    // position:fixed, computed from the trigger button's own
    // getBoundingClientRect(), since the preview table scrolls and an
    // absolutely-positioned popover would get clipped by that instead of
    // floating over it.
    openBulkContractorPicker(i, btn) {
        const panel = this.$('bulkContractorPopover');
        if (!panel) return;
        const r = this.bulkPreviewRows[i];
        const selected = new Set((r.contractor || '').split('|').map(s => s.trim()).filter(Boolean));
        panel.innerHTML = `
            <input type="text" class="search" placeholder="Filter contractors..." oninput="this.getRootNode().host.filterCheckList('bulkContractorPopoverList', this.value)">
            <div class="checkbox-scroll-list" id="bulkContractorPopoverList" style="border:none; background:none; padding:0; max-height:170px;">
                ${this.DATA.contractors.map(c => `<label><input type="checkbox" value="${escAttr(c.name)}" ${selected.has(c.name) ? 'checked' : ''} onchange="this.getRootNode().host.toggleBulkContractorPick(${i}, this.value, this.checked)"> ${escHtml(c.name)}</label>`).join('') || '<div style="color:#999; font-size:12px; padding:4px;">No contractors in this project\'s list yet.</div>'}
            </div>`;
        const rect = btn.getBoundingClientRect();
        panel.style.top = `${rect.bottom + 4}px`;
        panel.style.left = `${Math.min(rect.left, window.innerWidth - 246)}px`;
        panel.classList.add('open');
    }
    toggleBulkContractorPick(i, name, checked) {
        const r = this.bulkPreviewRows[i];
        if (!r) return;
        const selected = new Set((r.contractor || '').split('|').map(s => s.trim()).filter(Boolean));
        if (checked) selected.add(name); else selected.delete(name);
        r.contractor = [...selected].join(' | ');
        // Update just the trigger button's label in place — re-rendering
        // the whole preview table here would wipe out (close) this very
        // popover mid-click.
        const btn = this.$(`bulkContractorBtn-${i}`);
        if (btn) btn.textContent = selected.size ? [...selected].join(', ') : 'Select...';
    }
    closeBulkContractorPicker() {
        const panel = this.$('bulkContractorPopover');
        if (panel) panel.classList.remove('open');
    }

    generateBulkPreview(mode) {
        this.bulkPreviewRows = [];
        this.bulkPreviewMode = mode;
        if (mode === 'combo') {
            const assets = [...this.$$('#bulkAssetList input:checked')].map(i => i.value);
            const activities = [...this.$$('#bulkActivityList input:checked')].map(i => i.value);
            const contractor = this.getCheckedContractors('bulkContractorList').join(' | ');
            const notes = this.$('bulkNotes').value.trim();
            const duration = parseFloat(this.$('bulkDuration').value) || 1;
            const startDate = this.$('bulkStartDate').value;
            if (!assets.length || !activities.length || !startDate) {
                this.toast('Select at least one asset, one activity, and a start date.');
                return;
            }
            const start = new Date(startDate + 'T07:00');
            const autoLink = this.$('bulkAutoLink').checked;
            assets.forEach(asset => {
                // same asset->area linking LaunchPad itself uses — each
                // asset can pull in its own area rather than everything in
                // this batch being forced to share one
                const area = this.ASSET_TO_AREA_MAP[asset] || '';
                let prevRowIndex = null;
                let cursor = new Date(start);
                activities.forEach(activity => {
                    const rowStart = autoLink ? new Date(cursor) : new Date(start);
                    const row = { asset, activity, duration, area, contractor, notes, start: rowStart.toISOString() };
                    if (autoLink && prevRowIndex !== null) row.predLinkIndex = prevRowIndex;
                    this.bulkPreviewRows.push(row);
                    prevRowIndex = this.bulkPreviewRows.length - 1;
                    if (autoLink) cursor = new Date(cursor.getTime() + daysToHours(duration) * 3600000);
                });
            });
        } else if (mode === 'paste') {
            const raw = this.$('bulkPasteArea').value.trim();
            if (!raw) { this.toast('Paste some rows first.'); return; }
            const lines = raw.split('\n').filter(l => l.trim());
            lines.forEach((line, i) => {
                if (i === 0 && /asset/i.test(line) && /activity/i.test(line)) return; // skip header row
                const parts = line.split(/\t|,(?![^"]*")/).map(s => s.trim());
                const [asset, activity, duration, startDate, contractor, notes] = parts;
                if (!asset || !activity) return;
                const start = startDate ? new Date(startDate + 'T07:00') : new Date();
                this.bulkPreviewRows.push({
                    asset, activity,
                    duration: parseFloat(duration) || 1,
                    // Area is always automatic now, same as every other
                    // entry path — no column for it here to override.
                    area: this.ASSET_TO_AREA_MAP[asset] || '',
                    contractor: contractor || '',
                    notes: notes || '',
                    start: start.toISOString()
                });
            });
        } else if (mode === 'wbs') {
            // Index, WBS, Activity, Activity Type, Asset, Status, Predecessors,
            // Notes, Start Date, Duration, Trade Partners — a fixed column
            // order matching a WBS schedule exported from Excel (e.g. a Cx
            // schedule PDF that was itself converted from a spreadsheet).
            const raw = this.$('bulkWbsPasteArea').value.trim();
            if (!raw) { this.toast('Paste the schedule rows first.'); return; }
            const lines = raw.split('\n').filter(l => l.trim());
            const rows = [];
            lines.forEach((line, i) => {
                if (i === 0 && /index/i.test(line) && /predecessors/i.test(line)) return; // skip header row
                // Prefer a literal tab as the delimiter whenever the line has
                // one (a real Excel paste) — free text columns like Notes
                // routinely contain commas ("...yet, 125V will require..."),
                // which would otherwise get misread as extra column breaks.
                const parts = line.includes('\t')
                    ? line.split('\t').map(s => s.trim())
                    : line.split(/,(?![^"]*")/).map(s => s.trim());
                const [idxStr, wbs, activityDesc, actType, asset, , predsRaw, notes, startDate, durationRaw, contractor] = parts;
                const srcIndex = parseInt(idxStr, 10);
                // Index is required — it's the only thing Predecessors on
                // OTHER rows can reference to link back to this one.
                if (!Number.isFinite(srcIndex) || !asset || !actType) return;
                const parsedStart = parseFlexibleDate(startDate);
                const start = (parsedStart && !isNaN(parsedStart)) ? parsedStart : new Date();
                // Duration arrives as "0.5d" / "1d" / "2d" etc. — always
                // round UP to a whole day (per request), and a multi-day
                // duration just spans that many calendar days starting on
                // this row's own Start Date (set below, never recalculated
                // from a predecessor's finish time).
                const durDays = Math.max(1, Math.ceil(parseFloat(durationRaw) || 1));
                rows.push({
                    srcIndex, wbs: wbs || '', asset,
                    // Per request: for this import, the WBS "Activity Type"
                    // column (e.g. "Temp Power", "Energize", "L2D") is used
                    // as Bridge's Activity — the long free-text "Activity"
                    // column becomes descriptive detail instead, folded
                    // into Notes below rather than dropped.
                    activity: actType,
                    duration: durDays,
                    area: this.ASSET_TO_AREA_MAP[asset] || '',
                    contractor: contractor || '',
                    notes: [wbs ? `WBS ${wbs}` : '', activityDesc || '', notes || ''].filter(Boolean).join(' — '),
                    start: start.toISOString(),
                    predSrcIndices: (predsRaw || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite)
                });
            });
            if (!rows.length) { this.toast('No valid rows found — every row needs at least an Index, Asset, and Activity.'); return; }
            // Resolve each row's Predecessors (source Index references) into
            // positions within THIS batch — same idea as predLinkIndex below
            // for the simpler paste format, just supporting more than one
            // predecessor per row since a real WBS row can depend on several.
            const indexToPosition = {};
            rows.forEach((r, i) => { indexToPosition[r.srcIndex] = i; });
            rows.forEach(r => {
                r.predLinkIndices = r.predSrcIndices.map(si => indexToPosition[si]).filter(pos => pos !== undefined);
            });
            this.bulkPreviewRows = rows;
        }
        if (!this.bulkPreviewRows.length) { this.toast('No valid rows to preview.'); return; }
        this.renderBulkPreview();
    }

    /* build a dropdown's option list from a master-list array plus, if the row's
       current value isn't already in that list (e.g. a brand-new name typed
       into the paste box), an extra option so it isn't silently dropped */
    selectOptionsHtml(masterValues, currentValue, allowBlank) {
        let html = allowBlank ? `<option value="">—</option>` : '';
        html += masterValues.map(v => `<option value="${escAttr(v)}" ${v === currentValue ? 'selected' : ''}>${escHtml(v)}</option>`).join('');
        if (currentValue && !masterValues.includes(currentValue)) {
            html += `<option value="${escAttr(currentValue)}" selected>${escHtml(currentValue)} (new)</option>`;
        }
        return html;
    }

    renderBulkPreview() {
        this.$('bulkStep1').style.display = 'none';
        this.$('bulkStep2').style.display = 'block';
        this.$('bulkCommitBtn').style.display = 'inline-flex';
        // Row indices are about to be rebuilt (and can shift if a row was
        // removed) — an open picker's onchange handlers close over the OLD
        // index, so it must close rather than risk editing the wrong row.
        this.closeBulkContractorPicker();
        const unmatchedCount = this.bulkPreviewRows.filter(r => !this.isKnownListValue('assets', r.asset) || !this.isKnownListValue('activities', r.activity)).length;
        this.$('bulkPreviewCount').textContent = unmatchedCount
            ? `${this.bulkPreviewRows.length} item(s) — ${unmatchedCount} need a matching Asset/Activity (highlighted) before they can be added`
            : `${this.bulkPreviewRows.length} item(s) ready`;
        const assetOpts = this.DATA.assets.map(a => a.name);
        const activityOpts = this.DATA.activities.map(a => a.name);
        const isWbs = this.bulkPreviewMode === 'wbs';
        this.$('bulkPreviewHead').innerHTML = isWbs
            ? `<tr><th>Index</th><th>Asset</th><th>Activity</th><th>Dur (days)</th><th>Area</th><th>Start</th><th>Contractor(s)</th><th>Notes</th><th>Predecessors</th><th></th></tr>`
            : `<tr><th>Asset</th><th>Activity</th><th>Dur (days)</th><th>Area</th><th>Start</th><th>Contractor(s)</th><th>Notes</th><th>Linked after</th><th></th></tr>`;
        this.$('bulkPreviewBody').innerHTML = this.bulkPreviewRows.map((r, i) => {
            const dateVal = new Date(r.start).toISOString().slice(0, 10);
            // Red highlight = not in this project's dropdownoptions list —
            // see commitBulkAdd(), which skips rows still in this state
            // instead of silently adding a new list entry for them.
            const assetUnmatched = !this.isKnownListValue('assets', r.asset);
            const activityUnmatched = !this.isKnownListValue('activities', r.activity);
            const unmatchedStyle = 'border:2px solid #d32f2f; background:#fdecea;';
            const assetCell = `<td><select style="width:120px; ${assetUnmatched ? unmatchedStyle : ''}" title="${assetUnmatched ? "Not in this project's Asset list — pick an existing one" : ''}" onchange="this.getRootNode().host.updateBulkPreviewField(${i},'asset',this.value)">${this.selectOptionsHtml(assetOpts, r.asset, false)}</select></td>`;
            const activityCell = `<td>
                    <span class="legend-swatch" style="background:${this.activityColor(r.activity)}; display:inline-block; width:9px;height:9px;border-radius:3px; margin-right:3px;"></span>
                    <select style="width:118px; ${activityUnmatched ? unmatchedStyle : ''}" title="${activityUnmatched ? "Not in this project's Activity list — pick an existing one" : ''}" onchange="this.getRootNode().host.updateBulkPreviewField(${i},'activity',this.value)">${this.selectOptionsHtml(activityOpts, r.activity, false)}</select>
                </td>`;
            const durationCell = `<td><input type="number" min="1" step="1" value="${r.duration}" style="width:56px;" onchange="this.getRootNode().host.updateBulkPreviewField(${i},'duration',this.value)"></td>`;
            // Area is automatic (derived from Asset) everywhere else, but
            // shown read-only here rather than hidden entirely, so what got
            // picked is still visible before committing.
            const areaCell = `<td style="font-size:11.5px; color:#555;">${escHtml(r.area || '—')}</td>`;
            const startCell = `<td><input type="date" value="${dateVal}" style="width:130px;" onchange="this.getRootNode().host.updateBulkPreviewField(${i},'start',this.value)"></td>`;
            const selectedContractors = (r.contractor || '').split('|').map(s => s.trim()).filter(Boolean);
            const contractorCell = `<td><button type="button" class="bulk-contractor-btn" id="bulkContractorBtn-${i}" onclick="this.getRootNode().host.openBulkContractorPicker(${i}, this)">${selectedContractors.length ? escHtml(selectedContractors.join(', ')) : 'Select...'}</button></td>`;
            const notesCell = `<td><input value="${escAttr(r.notes || '')}" placeholder="Notes" style="width:120px;" onchange="this.getRootNode().host.updateBulkPreviewField(${i},'notes',this.value)"></td>`;
            const removeCell = `<td><button class="preview-remove" onclick="this.getRootNode().host.removeBulkRow(${i})" title="Remove row">✕</button></td>`;

            if (isWbs) {
                // Predecessors here were resolved automatically from the
                // pasted Index/Predecessors columns — shown read-only
                // (rather than a re-editable dropdown, since a row can have
                // several) — adjust actual links afterward via the normal
                // item editor if something doesn't look right.
                const predLabels = (r.predLinkIndices || []).map(j => {
                    const other = this.bulkPreviewRows[j];
                    return other ? `#${other.srcIndex} ${escHtml(other.activity)}` : null;
                }).filter(Boolean);
                const predCell = `<td style="font-size:11.5px; color:#555;">${predLabels.length ? predLabels.join('<br>') : '—'}</td>`;
                return `<tr>
                    <td style="text-align:center; color:#888;">${r.srcIndex}</td>
                    ${assetCell}${activityCell}${durationCell}${areaCell}${startCell}${contractorCell}${notesCell}${predCell}${removeCell}
                </tr>`;
            }

            const linkOptions = this.bulkPreviewRows.map((other, j) => {
                if (j === i) return '';
                return `<option value="${j}" ${r.predLinkIndex === j ? 'selected' : ''}>${escHtml(other.asset)} — ${escHtml(other.activity)}</option>`;
            }).join('');
            const linkCell = `<td><select style="width:130px;" title="Predecessor" onchange="this.getRootNode().host.updateBulkPreviewField(${i},'predLinkIndex',this.value)"><option value="">— none —</option>${linkOptions}</select></td>`;
            return `<tr>
                ${assetCell}${activityCell}${durationCell}${areaCell}${startCell}${contractorCell}${notesCell}${linkCell}${removeCell}
            </tr>`;
        }).join('');
    }
    updateBulkPreviewField(i, field, value) {
        const r = this.bulkPreviewRows[i];
        if (!r) return;
        if (field === 'duration') {
            // WBS-imported rows stay whole-day (always rounded up), same
            // rule as the initial import — every other mode keeps allowing
            // fractional days.
            r.duration = this.bulkPreviewMode === 'wbs'
                ? Math.max(1, Math.ceil(parseFloat(value) || 1))
                : Math.max(0.1, parseFloat(value) || 0.1);
        } else if (field === 'start') {
            // preserve existing time-of-day, just change the calendar date
            const prev = new Date(r.start);
            const [y, m, d] = value.split('-').map(Number);
            prev.setFullYear(y, m - 1, d);
            r.start = prev.toISOString();
        } else if (field === 'predLinkIndex') {
            if (value === '') delete r.predLinkIndex;
            else r.predLinkIndex = parseInt(value, 10);
        } else {
            r[field] = value;
            // Area stays automatic even after a row's Asset is changed in
            // the preview table, same as every other entry path.
            if (field === 'asset') r.area = this.ASSET_TO_AREA_MAP[value] || '';
        }
        // re-render swatch/labels that depend on the edited field without losing focus on unrelated inputs
        this.renderBulkPreview();
    }
    removeBulkRow(i) {
        this.bulkPreviewRows.splice(i, 1);
        // fix up any predLinkIndex/predLinkIndices references: drop links
        // that pointed at the removed row, shift every index above it down
        // by one (they're positions within this batch's array, so removing
        // row i invalidates every position that referenced it or anything
        // after it)
        this.bulkPreviewRows.forEach(r => {
            if (r.predLinkIndex !== undefined) {
                if (r.predLinkIndex === i) delete r.predLinkIndex;
                else if (r.predLinkIndex > i) r.predLinkIndex -= 1;
            }
            if (r.predLinkIndices) {
                r.predLinkIndices = r.predLinkIndices
                    .filter(j => j !== i)
                    .map(j => j > i ? j - 1 : j);
            }
        });
        if (!this.bulkPreviewRows.length) { this.backToBulkStep1(); return; }
        this.renderBulkPreview();
    }
    backToBulkStep1() {
        this.$('bulkStep1').style.display = 'block';
        this.$('bulkStep2').style.display = 'none';
        this.$('bulkCommitBtn').style.display = 'none';
        this.closeBulkContractorPicker();
    }

    // name exists (case-insensitively) in this project's dropdownoptions-
    // backed master list for that field — used to keep bulk add from
    // silently creating new Asset/Activity entries for a typo or a one-off
    // paste; see commitBulkAdd()'s per-row check below.
    isKnownListValue(table, name) {
        const n = (name || '').trim().toLowerCase();
        if (!n) return false;
        return (this.DATA[table] || []).some(x => x.name.toLowerCase() === n);
    }

    async commitBulkAdd() {
        if (!this.requireEditMode()) return;
        // Per request: bulk add must line up with what's already in this
        // project's dropdownoptions — Asset and Activity are never
        // auto-created from here the way ensureListValue() used to do.
        // A row whose Asset or Activity isn't an existing list entry is
        // skipped (not silently created with an unlisted name) and left in
        // the preview so it can be fixed and re-submitted; everything that
        // DOES match commits normally. insertedIds keeps a null slot for
        // each skipped row so predecessor-link positions (which reference
        // rows by their original index in this batch) still line up in the
        // second pass below.
        const skipped = [];
        this.setSaveIndicator('dirty', 'Saving...');
        const insertedIds = [];
        for (const r of this.bulkPreviewRows) {
            const assetOk = this.isKnownListValue('assets', r.asset);
            const activityOk = this.isKnownListValue('activities', r.activity);
            if (!assetOk || !activityOk) {
                insertedIds.push(null);
                skipped.push(r);
                continue;
            }
            // r.contractor can now hold several names joined with " | " (a
            // multi-select, or free-typed paste/WBS text) — ensure each one
            // individually, not the joined string as a single new entry.
            // Contractors are still auto-added (only Asset/Activity/Place
            // were asked to stop auto-creating).
            const contractorNames = (r.contractor || '').split('|').map(s => s.trim()).filter(Boolean);
            for (const name of contractorNames) await this.ensureListValue('contractors', name);
            const payload = {
                asset_name: r.asset, activity_name: r.activity, duration_hours: daysToHours(r.duration),
                area: r.area || '', start_ts: r.start,
                contractor_name: contractorNames.join(' | '), notes: r.notes || '',
                // See saveItemModal()'s payload for why these are still
                // sent blank — schedule_items.type is NOT NULL with no
                // default, so omitting it entirely fails the insert.
                type: '', zone: '', asset_type: ''
            };
            const saved = await this.ItemsDB.insert(payload);
            const newItem = saved ? { ...saved, duration_hours: payload.duration_hours } : { id: uid(), ...payload };
            this.DATA.items.push(newItem);
            insertedIds.push(newItem.id);
        }
        // second pass: resolve each row's predLinkIndex/predLinkIndices (a
        // position, or several, within this batch) into the real id(s) that
        // ended up saved at those positions. WBS-imported rows can have more
        // than one predecessor (a real schedule row can depend on several
        // prior activities), where every other mode only ever has one.
        const isWbsImport = this.bulkPreviewMode === 'wbs';
        let linkCount = 0;
        for (let i = 0; i < this.bulkPreviewRows.length; i++) {
            const r = this.bulkPreviewRows[i];
            const linkPositions = r.predLinkIndices !== undefined
                ? r.predLinkIndices
                : (r.predLinkIndex === undefined || r.predLinkIndex === null ? [] : [r.predLinkIndex]);
            if (!linkPositions.length) continue;
            const succId = insertedIds[i];
            const succItem = this.DATA.items.find(x => x.id === succId);
            if (!succItem) continue;
            succItem.predecessor_ids = succItem.predecessor_ids || [];
            for (const pos of linkPositions) {
                const predId = insertedIds[pos];
                if (!predId || succItem.predecessor_ids.includes(predId)) continue;
                succItem.predecessor_ids.push(predId);
                linkCount++;
            }
            await this.ItemsDB.update(succId, { predecessor_ids: succItem.predecessor_ids });
            // A WBS import brings its own Start Date per row — the whole
            // point of "use the start date as the original" is that it's
            // NOT recalculated from a predecessor's finish time, so skip
            // the auto-cascade every other mode relies on here.
            if (!isWbsImport) {
                for (const pos of linkPositions) { if (insertedIds[pos]) await this.enforceDependencies(insertedIds[pos]); }
            }
        }
        for (const id of insertedIds) { if (id) this.markPendingSync(this.DATA.items.find(i => i.id === id)); }
        this.setSaveIndicator('ready', 'Saved');
        const addedCount = insertedIds.filter(Boolean).length;
        if (skipped.length) {
            this.toast(
                `Added ${addedCount} item(s)${linkCount ? `, ${linkCount} linked as predecessor/successor` : ''}. ` +
                `${skipped.length} row(s) skipped — their Asset or Activity isn't in this project's list yet; pick an existing value (highlighted in red) and click Add to Schedule again.`,
                9000
            );
            this.bulkPreviewRows = skipped;
            this.renderBulkPreview();
        } else {
            this.toast(`${addedCount} item(s) added${linkCount ? `, ${linkCount} linked as predecessor/successor` : ''}`);
            this.bulkPreviewRows = [];
            this.closeModal('bulkModal');
        }
        this.renderFilterBar();
        this.renderGantt();
    }

    /* =========================================================================
       9. LISTS MANAGER — Assets / Activities / Contractors / Zones / Areas / Types
       Backed by the same Supabase tables the schedule items reference.
       ========================================================================= */

    renderListsManager() {
        this.$('assetListRows').innerHTML = this.DATA.assets.map(a => `
            <div class="list-mgr-row">
                <input value="${escAttr(a.name)}" onchange="this.getRootNode().host.renameListItem('assets','${a.id}', this.value)">
                <button class="del" onclick="this.getRootNode().host.deleteListItem('assets','${a.id}')">🗑️</button>
            </div>`).join('') || this.emptyRow();

        this.$('activityListRows').innerHTML = this.DATA.activities.map(a => `
            <div class="list-mgr-row">
                <input value="${escAttr(a.name)}" onchange="this.getRootNode().host.renameListItem('activities','${a.id}', this.value)">
                <button class="del" onclick="this.getRootNode().host.deleteListItem('activities','${a.id}')">🗑️</button>
            </div>`).join('') || this.emptyRow();

        this.$('contractorListRows').innerHTML = this.DATA.contractors.map(c => `
            <div class="list-mgr-row">
                <input value="${escAttr(c.name)}" onchange="this.getRootNode().host.renameListItem('contractors','${c.id}', this.value)">
                <button class="del" onclick="this.getRootNode().host.deleteListItem('contractors','${c.id}')">🗑️</button>
            </div>`).join('') || this.emptyRow();

        this.$('zoneListRows').innerHTML = this.DATA.zones.map(z => `
            <div class="list-mgr-row">
                <input value="${escAttr(z.name)}" onchange="this.getRootNode().host.renameListItem('zones','${z.id}', this.value)">
                <input type="date" value="${escAttr(this.getZoneEndDate(z.name)||'')}" title="Target end date (stored locally in this browser)" style="flex:0 0 140px;" onchange="this.getRootNode().host.setZoneEndDate('${z.name.replace(/'/g, "\\'")}', this.value); this.renderGantt();">
                <button class="del" onclick="this.getRootNode().host.deleteListItem('zones','${z.id}')">🗑️</button>
            </div>`).join('') || this.emptyRow();

        this.$('areaListRows').innerHTML = this.DATA.areas.map(a => `
            <div class="list-mgr-row">
                <input value="${escAttr(a.name)}" onchange="this.getRootNode().host.renameListItem('areas','${a.id}', this.value)">
                <button class="del" onclick="this.getRootNode().host.deleteListItem('areas','${a.id}')">🗑️</button>
            </div>`).join('') || this.emptyRow();

        this.$('typeListRows').innerHTML = this.DATA.types.map(t => `
            <div class="list-mgr-row">
                <input value="${escAttr(t.name)}" onchange="this.getRootNode().host.renameListItem('types','${t.id}', this.value)">
                <button class="del" onclick="this.getRootNode().host.deleteListItem('types','${t.id}')">🗑️</button>
            </div>`).join('') || this.emptyRow();

        this.$('activityColorRows').innerHTML = this.DATA.activities.map(a => `
            <div class="list-mgr-row">
                <span style="flex:1; font-size:13px;">${escHtml(a.name)}</span>
                <input type="color" class="swatch-input" value="${this.activityColor(a.name)}" onchange="this.getRootNode().host.setActivityColor('${a.name.replace(/'/g, "\\'")}', this.value); this.afterListChange();">
            </div>`).join('') || this.emptyRow();
    }
    emptyRow() { return `<div style="padding:10px 0; color:#999; font-size:12.5px;">Nothing here yet — add one below.</div>`; }

    async addListItem(table) {
        let row = null;
        if (table === 'assets') {
            const name = this.$('newAssetName').value.trim();
            if (!name) return;
            row = { name };
            this.$('newAssetName').value = '';
        } else if (table === 'activities') {
            const name = this.$('newActivityName').value.trim();
            if (!name) return;
            row = { name }; this.$('newActivityName').value = '';
        } else if (table === 'contractors') {
            const name = this.$('newContractorName').value.trim();
            if (!name) return;
            row = { name };
            this.$('newContractorName').value = '';
        } else if (table === 'zones') {
            const name = this.$('newZoneName').value.trim();
            if (!name) return;
            const endDate = this.$('newZoneEndDate').value;
            row = { name };
            if (endDate) this.setZoneEndDate(name, endDate);
            this.$('newZoneName').value = '';
            this.$('newZoneEndDate').value = '';
        } else if (table === 'areas') {
            const name = this.$('newAreaName').value.trim();
            if (!name) return;
            row = { name }; this.$('newAreaName').value = '';
        } else if (table === 'types') {
            const name = this.$('newTypeName').value.trim();
            if (!name) return;
            row = { name };
            this.$('newTypeName').value = '';
        }
        if (!row) return;
        const saved = await this.DB.insert(this.TABLES[table], row);
        this.DATA[table].push(saved || { id: uid(), ...row });
        this.afterListChange();
    }
    async renameListItem(table, id, newName) {
        if (!newName.trim()) return;
        const trimmed = newName.trim();
        const row = this.DATA[table].find(r => r.id === id);
        const oldName = row ? row.name : null;
        await this.DB.update(this.TABLES[table], id, { name: trimmed });
        if (row) row.name = trimmed;
        if (table === 'zones' && oldName && oldName !== trimmed) {
            const endDate = this.getZoneEndDate(oldName);
            if (endDate) { this.setZoneEndDate(oldName, null); this.setZoneEndDate(trimmed, endDate); }
        }
        if (table === 'activities' && oldName && oldName !== trimmed && this.ACTIVITY_COLORS[oldName]) {
            this.setActivityColor(trimmed, this.ACTIVITY_COLORS[oldName]);
            delete this.ACTIVITY_COLORS[oldName];
            this.saveActivityColorsMap(this.ACTIVITY_COLORS);
        }
        this.afterListChange();
    }
    async updateListItem(table, id, patch) {
        await this.DB.update(this.TABLES[table], id, patch);
        const row = this.DATA[table].find(r => r.id === id);
        if (row) Object.assign(row, patch);
        this.afterListChange();
    }
    async deleteListItem(table, id) {
        if (!confirm('Remove this item from the list? (Existing schedule items keep their values.)')) return;
        const row = this.DATA[table].find(r => r.id === id);
        await this.DB.remove(this.TABLES[table], id);
        this.DATA[table] = this.DATA[table].filter(r => r.id !== id);
        if (table === 'zones' && row) this.setZoneEndDate(row.name, null);
        this.renderListsManager();
        this.afterListChange();
    }
    afterListChange() {
        this.renderListsManager();
        this.renderLegend();
        this.buildTypePicker('itemTypePicker');
        this.buildTypePicker('bulkTypePicker');
        this.renderFilterBar();
        this.renderGantt();
    }

    // The Activities picker (dropdownoptions.Activities) is shared with
    // LaunchPad's own Schedule module, and accumulates every name anyone's
    // ever typed into it — from either side — with no cleanup, which is
    // how it ends up showing far more options than are actually in play at
    // once. This prunes it back down to only what's currently used,
    // checking BOTH Bridge's own items and LaunchPad's schedule rows (not
    // just Bridge's) before calling something "unused", since removing a
    // name Schedule still relies on would be a real loss even though no
    // Bridge item happens to use it right now — removing it from this
    // picker doesn't touch any existing row's own stored value either way,
    // it only stops offering it as a suggestion for NEW entries.
    async cleanUpActivitiesList() {
        if (!this._supabase) { this.toast('Connect to Supabase first — see the header subtitle.'); return; }
        this.setSaveIndicator('dirty', 'Checking activities...');
        const inUse = new Set(this.DATA.items.map(i => (i.activity_name || '').trim().toLowerCase()).filter(Boolean));
        try {
            const { data: rows, error } = await this._supabase.from(this.LAUNCHPAD_TABLE).select('activity');
            if (!error && rows) rows.forEach(r => { if (r.activity) inUse.add(r.activity.trim().toLowerCase()); });
        } catch (e) {
            console.error('LaunchPad activity usage check failed (continuing with Bridge-only data)', e);
        }
        const toRemove = this.DATA.activities.filter(a => !inUse.has((a.name || '').trim().toLowerCase()));
        if (!toRemove.length) {
            this.setSaveIndicator('ready', 'Ready');
            this.toast('Every activity in the list is already in use — nothing to remove.');
            return;
        }
        const preview = toRemove.slice(0, 15).map(a => a.name).join(', ') + (toRemove.length > 15 ? `, +${toRemove.length - 15} more` : '');
        if (!confirm(`Remove ${toRemove.length} unused activity option(s) from the list?\n\n${preview}\n\nActivities still used by any Bridge item or LaunchPad schedule row are kept — this only removes ones that aren't used anywhere right now.`)) {
            this.setSaveIndicator('ready', 'Ready');
            return;
        }
        for (const a of toRemove) {
            await this.DB.remove(this.TABLES.activities, a.id);
        }
        this.DATA.activities = this.DATA.activities.filter(a => inUse.has((a.name || '').trim().toLowerCase()));
        this.afterListChange();
        this.setSaveIndicator('ready', 'Ready');
        this.toast(`Removed ${toRemove.length} unused activity option(s).`, 4000);
    }

    /* =========================================================================
       10. BASELINE PDF IMPORT
       Renders page 1, tries the embedded text layer first (fast, accurate for
       vector/drawn PDFs), and falls back to Tesseract OCR on the rendered
       canvas for scanned/image-only sheets. Detected tokens become candidate
       Zones/Areas the user can add with one click.
       ========================================================================= */

    async handleBaselineFile(file) {
        if (!file) return;
        const statusEl = this.$('baselineStatus');
        const canvasWrap = this.$('baselineCanvasWrap');
        statusEl.textContent = 'Loading PDF reader...';
        canvasWrap.innerHTML = '';
        this.baselineDetectedTokens = [];

        await ensurePdfJs();
        statusEl.textContent = 'Loading PDF...';
        const buf = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.4 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        canvasWrap.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

        statusEl.textContent = 'Extracting text layer...';
        const textContent = await page.getTextContent();
        let tokens = textContent.items.map(t => t.str.trim()).filter(s => s && s.length > 1 && s.length < 30 && !/^\d+$/.test(s));

        if (tokens.length < 3) {
            statusEl.textContent = 'No embedded text found — loading OCR engine...';
            try {
                await ensureTesseract();
                statusEl.textContent = 'Running OCR (this can take a few seconds)...';
                const { data } = await Tesseract.recognize(canvas, 'eng');
                tokens = data.text.split(/\n|,/).map(s => s.trim()).filter(s => s && s.length > 1 && s.length < 30 && !/^\d+$/.test(s));
                statusEl.textContent = `OCR complete — ${tokens.length} candidate label(s) found.`;
            } catch (err) {
                console.error(err);
                statusEl.textContent = 'OCR failed. You can still add labels manually via Manage Lists.';
            }
        } else {
            statusEl.textContent = `${tokens.length} candidate label(s) found in the PDF text layer.`;
        }

        this.baselineDetectedTokens = [...new Set(tokens)].slice(0, 200);
        this.renderBaselineTokens();
    }

    renderBaselineTokens() {
        const el = this.$('baselineTokens');
        if (!this.baselineDetectedTokens.length) {
            el.innerHTML = '<div style="color:#999; font-size:12.5px;">No labels detected yet.</div>';
            return;
        }
        el.innerHTML = this.baselineDetectedTokens.map((t, i) =>
            `<span class="token-chip" data-i="${i}" onclick="this.classList.toggle('selected')">${escHtml(t)}</span>`).join('');
    }

    async commitBaselineTokens(kind) {
        const selected = [...this.$$('#baselineTokens .token-chip.selected')].map(c => c.textContent);
        if (!selected.length) { this.toast('Select at least one label first.'); return; }
        for (const name of selected) {
            await this.ensureListValue(kind, name);
        }
        this.afterListChange();
        this.toast(`Added ${selected.length} ${kind === 'zones' ? 'zone(s)' : 'area(s)'}`);
    }

    /* =========================================================================
       10a. LAUNCHPAD SYNC
       LaunchPad reads its schedule grid from its own "{PROJECT_KEY}BackEndData" table
       in this same Supabase project — one row per (day, row-slot), keyed by a
       deterministic numeric id: YYYYMMDD * 100 + rowIndex (LaunchPad's own
       generateNumericId scheme, reverse-engineered from its source so ids
       never collide with rows LaunchPad itself creates).
       Field mapping mirrors LaunchPad's OWN entry mechanism (addSelectedReadyItems(),
       the function LaunchPad itself uses to inject an external item into an
       empty row) for Activity and Asset, plus Notes, which is synced two-way:
         day_label <- item's start date | activity <- Activity | asset <- Asset | notes <-> Notes
       Every other column (time, place, status, trade_partners, result,
       duration) is left untouched, exactly like LaunchPad's own code leaves
       them for manual entry or its own automation to fill in.

       The link between a pull-plan item and its LaunchPad row lives in the
       pull-plan item itself (launchpad_id / launchpad_day_label columns on
       {PROJECT_KEY}schedule_items, persisted in Supabase) — NOT in browser localStorage.
       That's what actually prevents push/pull from ever double-creating
       entries: the link survives across devices, browsers, and cleared
       storage, and a database unique index guarantees one LaunchPad row can
       never end up linked to two different pull-plan items.
       ========================================================================= */
    loadLaunchPadSyncEnabled() { return localStorage.getItem(LAUNCHPAD_SYNC_KEY) === 'true'; }
    saveLaunchPadSyncEnabled(v) { try { localStorage.setItem(LAUNCHPAD_SYNC_KEY, v ? 'true' : 'false'); } catch (e) {} }

    // LaunchPad's own formula (matches its generateNumericId exactly) —
    // e.g. "2026-04-20" row 5 -> 2026042005. Row index must stay 0-98 or it
    // collides with the next day's block.
    launchPadNumericId(dayLabel, index) {
        const numericDate = parseInt(dayLabel.replace(/-/g, ''), 10);
        return (numericDate * 100) + index;
    }

    async findFreeLaunchPadIndex(dayLabel) {
        const { data, error } = await this._supabase.from(this.LAUNCHPAD_TABLE).select('id').eq('day_label', dayLabel);
        if (error) { console.error('LaunchPad row lookup failed', error); return null; }
        const base = parseInt(dayLabel.replace(/-/g, ''), 10) * 100;
        const used = new Set((data || []).map(r => r.id - base));
        for (let i = 0; i < 99; i++) { if (!used.has(i)) return i; }
        return null; // that day's 0-98 block is completely full
    }

    // Originally mirrored LaunchPad's own addSelectedReadyItems() exactly
    // (Activity/Asset/Notes only, leaving Place/Trade Partners alone for
    // Schedule's own entry) — Place and Trade Partners are included now,
    // per request: Bridge collects both directly (Area auto-derived from
    // Asset, Contractor(s) picked explicitly) and they weren't carrying
    // through to Schedule at all. This does mean every sync from Bridge —
    // not just an item's first creation — now overwrites Schedule's own
    // Place/Trade Partners columns with whatever Bridge currently has for
    // that item, rather than leaving them for Schedule-side editing.
    itemToLaunchPadRow(item, numericId, dayLabel) {
        return {
            id: numericId,
            day_label: dayLabel,
            activity: item.activity_name || '',
            asset: item.asset_name || '',
            notes: item.notes || '',
            place: item.area || '',
            trade_partners: item.contractor_name || ''
        };
    }

    // Pushes one item to its LaunchPad row, reusing the same row if this item
    // was already synced and hasn't changed days; allocates a fresh free slot
    // otherwise. Returns true on success.
    // Finds a LaunchPad row with the same asset+activity that isn't already
    // linked to one of our items — i.e. something entered independently in
    // both systems — so it can be matched up instead of doubled.
    async findMatchingUnlinkedLaunchPadRow(assetName, activityName) {
        const { data, error } = await this._supabase.from(this.LAUNCHPAD_TABLE)
            .select('id, day_label').eq('asset', assetName).eq('activity', activityName);
        if (error || !data || !data.length) return null;
        const linkedIds = new Set(this.DATA.items.filter(i => i.launchpad_id).map(i => i.launchpad_id));
        return data.find(row => !linkedIds.has(row.id)) || null;
    }

    // Two saves for the SAME item can genuinely overlap — a drag-end save
    // racing a dependency cascade's save for the same successor, or a
    // fast group-drag firing several of these before the first lands —
    // and if both read item.launchpad_id/launchpad_day_label before either
    // has written its update, both compute the same "day changed" old id
    // and both try to claim a fresh slot, silently orphaning one of the
    // rows. Chaining every call for a given item onto whatever's already
    // in flight for it makes them run one at a time instead, closing that
    // race entirely.
    async syncItemToLaunchPad(item) {
        if (!item) return false;
        this._launchpadSyncQueue = this._launchpadSyncQueue || new Map();
        const prior = this._launchpadSyncQueue.get(item.id) || Promise.resolve();
        const run = prior.catch(() => {}).then(() => this._syncItemToLaunchPadCore(item));
        this._launchpadSyncQueue.set(item.id, run);
        try {
            return await run;
        } finally {
            if (this._launchpadSyncQueue.get(item.id) === run) this._launchpadSyncQueue.delete(item.id);
        }
    }
    async _syncItemToLaunchPadCore(item) {
        if (!this._supabase) return false;
        const dayLabel = new Date(item.start_ts).toISOString().slice(0, 10);
        let numericId;
        let oldIdToRemove = null;
        if (item.launchpad_id && item.launchpad_day_label === dayLabel) {
            numericId = item.launchpad_id;
        } else if (!item.launchpad_id) {
            const match = await this.findMatchingUnlinkedLaunchPadRow(item.asset_name, item.activity_name);
            if (match) {
                numericId = match.id;
            } else {
                const idx = await this.findFreeLaunchPadIndex(dayLabel);
                if (idx === null) { console.error(`LaunchPad: no free row slot for ${dayLabel}`); return false; }
                numericId = this.launchPadNumericId(dayLabel, idx);
            }
        } else {
            // already linked, but the day changed here — LaunchPad's id scheme
            // is day-encoded, so this needs a new id. Without cleaning up the
            // old row, it stays behind on the original day as an orphan while
            // this new one gets created — the exact "moved but old one is
            // still there" bug. Remember the old id so it can be deleted once
            // the new row is safely written.
            oldIdToRemove = item.launchpad_id;
            const idx = await this.findFreeLaunchPadIndex(dayLabel);
            if (idx === null) { console.error(`LaunchPad: no free row slot for ${dayLabel}`); return false; }
            numericId = this.launchPadNumericId(dayLabel, idx);
        }
        const row = this.itemToLaunchPadRow(item, numericId, dayLabel);
        if (oldIdToRemove !== null) {
            // The write-new-row and delete-old-row used to be two separate
            // round-trips from here — if the browser dropped the connection,
            // the tab closed, or another move overlapped between them, one
            // could land without the other, leaving the exact "moved but
            // the old one is still there" bug behind with no way to recover
            // short of the Repair LaunchPad Links tool. move_schedule_row()
            // (see sync/move_schedule_row.sql) does both writes inside one
            // Postgres function call, so they either both happen or neither
            // does — there's no half-moved state left in the table anymore.
            const { error: moveError } = await this._supabase.rpc('move_schedule_row', {
                p_table: this.LAUNCHPAD_TABLE,
                p_old_id: oldIdToRemove,
                p_new_id: numericId,
                p_day_label: dayLabel,
                p_activity: row.activity,
                p_asset: row.asset,
                p_notes: row.notes,
                p_place: row.place,
                p_trade_partners: row.trade_partners
            });
            if (moveError) {
                // Falls back to the old two-step approach so this still
                // works even before sync/move_schedule_row.sql has been run
                // against this project's Supabase — but that's a degraded
                // path now, not the normal one, so it's worth surfacing.
                console.error('move_schedule_row RPC failed — have you run sync/move_schedule_row.sql yet? Falling back to a two-step move.', moveError);
                const { error: upsertError } = await this._supabase.from(this.LAUNCHPAD_TABLE).upsert([row]);
                if (upsertError) { console.error('LaunchPad sync failed', upsertError); return false; }
                let cleanupError = (await this._supabase.from(this.LAUNCHPAD_TABLE).delete().eq('id', oldIdToRemove)).error;
                if (cleanupError) {
                    cleanupError = (await this._supabase.from(this.LAUNCHPAD_TABLE).delete().eq('id', oldIdToRemove)).error;
                }
                if (cleanupError) {
                    console.error('LaunchPad old-row cleanup failed (new row is correct, but the old one may still be there)', cleanupError);
                    this.toast(`"${item.asset_name} — ${item.activity_name}" moved, but its old LaunchPad row couldn't be removed — check LaunchPad for a leftover duplicate on its previous day.`, 7000);
                }
            }
        } else {
            const { error } = await this._supabase.from(this.LAUNCHPAD_TABLE).upsert([row]);
            if (error) { console.error('LaunchPad sync failed', error); return false; }
        }
        item.launchpad_id = numericId;
        item.launchpad_day_label = dayLabel;
        await this.DB.update(this.TABLES.items, item.id, { launchpad_id: numericId, launchpad_day_label: dayLabel });
        return true;
    }

    async syncAllToLaunchPad() {
        if (!this._supabase) { this.toast('Connect to Supabase first — see the header subtitle.'); return; }
        if (!this.DATA.items.length) { this.toast('No schedule items to push yet.'); return; }
        this.setSaveIndicator('dirty', 'Pushing to LaunchPad...');
        let ok = 0, fail = 0;
        for (const item of this.DATA.items) {
            const success = await this.syncItemToLaunchPad(item);
            if (success) ok++; else fail++;
        }
        this.setSaveIndicator('ready', 'Ready');
        this.toast(`Pushed ${ok} item(s) to LaunchPad${fail ? `, ${fail} failed — see console` : ''}`, 5000);
        this.renderGantt();
    }

    /* One-time repair for links left stale by the old race-condition bug
       (fixed above in syncItemToLaunchPad/maybeSyncToLaunchPad) — before
       that fix, a move could finish having updated item.launchpad_id to a
       row that a *concurrent* sync then immediately deleted (or never
       actually created), leaving Bridge convinced it owns a row that no
       longer exists. Every future sync for that item then keeps quietly
       upserting under that same dead id — which either does nothing
       visible (the row doesn't exist to update) or, worse, resurrects a
       row at the WRONG (old) position, which is exactly "moved, but the
       old one is still there." This only clears a link when the row it
       points at is verifiably gone — it never touches a link whose row
       still exists, even if that row's day looks different (that's a
       legitimate LaunchPad-side edit for Pull from LaunchPad to bring
       back, not something to silently overwrite here). */
    async repairLaunchPadLinks() {
        if (!this._supabase) { this.toast('Connect to Supabase first — see the header subtitle.'); return; }
        if (this.UNIFIED_SCHEDULE) { this.toast('This project reads BackEndData directly — no separate links to repair.'); return; }
        const linkedItems = this.DATA.items.filter(it => it.launchpad_id);
        if (!linkedItems.length) { this.toast('No LaunchPad-linked items to check.'); return; }
        this.setSaveIndicator('dirty', 'Checking LaunchPad links...');
        const { data: rows, error } = await this._supabase.from(this.LAUNCHPAD_TABLE).select('id');
        if (error) {
            console.error('LaunchPad link check failed', error);
            this.setSaveIndicator('error', 'Check failed');
            this.toast('Could not check LaunchPad links — see console.');
            return;
        }
        const liveIds = new Set((rows || []).map(r => String(r.id)));
        let cleared = 0;
        for (const item of linkedItems) {
            if (liveIds.has(String(item.launchpad_id))) continue;
            item.launchpad_id = null;
            item.launchpad_day_label = null;
            await this.DB.update(this.TABLES.items, item.id, { launchpad_id: null, launchpad_day_label: null });
            cleared++;
        }
        if (!cleared) {
            this.setSaveIndicator('ready', 'Ready');
            this.toast('All LaunchPad links check out — nothing stale to repair.');
            return;
        }
        this.toast(`Found ${cleared} broken LaunchPad link(s) — re-pushing to fix ${cleared === 1 ? 'it' : 'them'} now...`, 4500);
        await this.syncAllToLaunchPad();
    }

    toggleLaunchPadSync() {
        this.LAUNCHPAD_SYNC_ENABLED = !this.LAUNCHPAD_SYNC_ENABLED;
        this.saveLaunchPadSyncEnabled(this.LAUNCHPAD_SYNC_ENABLED);
        this.updateLaunchPadSyncBtn();
        this.closeAllMenus();
        if (this.LAUNCHPAD_SYNC_ENABLED) {
            this.toast('Auto-sync to LaunchPad is on — every save now also pushes there.', 4000);
            this.syncAllToLaunchPad();
        } else {
            this.toast('Auto-sync to LaunchPad is off.');
        }
    }
    updateLaunchPadSyncBtn() {
        const menuItem = this.$('launchpadSyncMenuItem');
        const btn = this.$('launchpadMenuBtn');
        if (menuItem) menuItem.textContent = this.LAUNCHPAD_SYNC_ENABLED ? '📡 Sync to LaunchPad: On' : '📡 Sync to LaunchPad: Off';
        if (btn) btn.classList.toggle('primary', this.LAUNCHPAD_SYNC_ENABLED);
    }
    statusCacheKey(asset, activity) { return `${asset}|||${activity}`; }

    async fetchLaunchPadStatus(activity, asset) {
        const key = this.statusCacheKey(asset, activity);
        if (this.STATUS_CACHE[key] && this.STATUS_CACHE[key] !== 'error') return this.STATUS_CACHE[key];
        this.STATUS_CACHE[key] = 'pending';
        try {
            const url = `${this.GOOGLE_SCRIPT_URL || LAUNCHPAD_STATUS_SCRIPT_URL}?action=lookup&col3=${encodeURIComponent(activity)}&col4=${encodeURIComponent(asset)}`;
            const res = await fetch(url);
            const data = await res.json();
            this.STATUS_CACHE[key] = (data && data.result) ? { result: data.result, url: data.url || null } : { result: 'NA', url: null };
        } catch (err) {
            console.error('LaunchPad status lookup failed', err);
            this.STATUS_CACHE[key] = 'error';
        }
        return this.STATUS_CACHE[key];
    }

    isStatusNotReady(asset, activity) {
        const cached = this.STATUS_CACHE[this.statusCacheKey(asset, activity)];
        if (!cached || cached === 'pending' || cached === 'error') return false;
        return /open|incomplete/i.test(cached.result || '');
    }

    async fetchLaunchPadStatusInto(activity, asset, elementId) {
        const status = await this.fetchLaunchPadStatus(activity, asset);
        const target = this.$(elementId);
        if (!target) return; // panel closed before this resolved
        if (status === 'error') { target.textContent = 'Unavailable'; return; }
        target.innerHTML = status.url
            ? `<a href="${status.url}" target="_blank" rel="noopener noreferrer">${escHtml(status.result)}</a>`
            : escHtml(status.result);
    }

    isPastOrToday(item) {
        const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
        return new Date(item.start_ts).getTime() <= endOfToday.getTime();
    }

    // The "result" column lives directly on {PROJECT_KEY}BackEndData now, so past and
    // current-day items can read it straight from Supabase via their own
    // launchpad_id — no round trip through the Apps Script lookup needed.
    async fetchSupabaseResult(launchpadId) {
        if (!launchpadId) return null;
        if (Object.prototype.hasOwnProperty.call(this.RESULT_CACHE, launchpadId)) return this.RESULT_CACHE[launchpadId];
        if (!this._supabase) return null;
        const { data, error } = await this._supabase.from(this.LAUNCHPAD_TABLE).select('result').eq('id', launchpadId).maybeSingle();
        if (error) { console.error('Supabase result lookup failed', error); return null; }
        this.RESULT_CACHE[launchpadId] = (data && data.result) ? data.result : null;
        return this.RESULT_CACHE[launchpadId];
    }
    async fetchSupabaseResultInto(launchpadId, elementId) {
        const target = this.$(elementId);
        if (!target) return;
        if (!this._supabase || !launchpadId) { target.textContent = '—'; return; }
        const result = await this.fetchSupabaseResult(launchpadId);
        const t2 = this.$(elementId);
        if (!t2) return; // panel closed before this resolved
        t2.textContent = result || '—';
    }

    // A predecessor's constraint is considered satisfied — and stops blocking
    // its successor in the UI — once LaunchPad's own result for it reads Pass
    // or Complete. Anything else (incomplete, failed, rescheduled, in
    // progress, or simply no result yet) keeps the constraint showing.
    async isPredecessorSatisfied(predItem) {
        if (!predItem.launchpad_id) return false;
        const result = await this.fetchSupabaseResult(predItem.launchpad_id);
        return !!(result && /pass|complete/i.test(result));
    }

    // Builds the "Constraints (predecessors)" text for an item, filtering out
    // any predecessor whose LaunchPad result already reads Pass/Complete.
    async unsatisfiedPredecessorsLabel(it) {
        const preds = (it.predecessor_ids || []).map(pid => this.DATA.items.find(i => i.id === pid)).filter(Boolean);
        if (!preds.length) return 'None';
        const flags = await Promise.all(preds.map(p => this.isPredecessorSatisfied(p)));
        const remaining = preds.filter((p, i) => !flags[i]).map(p => `${p.asset_name} — ${p.activity_name}`);
        if (!remaining.length) return preds.length ? 'None (all predecessors complete)' : 'None';
        return remaining.join(', ');
    }

    // Fetches status for every distinct (asset, activity) pair currently on
    // the schedule, sequentially (LaunchPad's Apps Script endpoint isn't
    // built for bursts of concurrent calls), then re-renders so any
    // newly-detected "not ready" items get their orange frame.
    async refreshAllStatuses() {
        if (this.statusRefreshInFlight) return;
        this.statusRefreshInFlight = true;
        const pairs = new Set();
        this.DATA.items.forEach(it => pairs.add(this.statusCacheKey(it.asset_name, it.activity_name)));
        let done = 0;
        for (const key of pairs) {
            const [asset, activity] = key.split('|||');
            await this.fetchLaunchPadStatus(activity, asset);
            done++;
        }
        this.statusRefreshInFlight = false;
        this.setSaveIndicator('ready', 'Ready');
        this.renderGantt();
        this.toast(`Status refreshed for ${pairs.size} activity/asset combination(s).`);
    }

    openDayDetail(isoDate) {
        const dayItems = this.getFilteredItems().filter(it => {
            const d = new Date(it.start_ts);
            const itIso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            return itIso === isoDate;
        });
        const dateObj = new Date(isoDate + 'T00:00');
        this.$('dayDetailTitle').textContent = dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

        if (!dayItems.length) {
            this.$('dayDetailBody').innerHTML = `<div class="empty-state"><div class="emoji">🗓️</div>Nothing scheduled this day.</div>`;
            this.openModal('dayDetailModal');
            return;
        }

        // ready critical-path items first (most actionable — do these now),
        // then critical-but-blocked, then everything else, not-ready ahead of
        // ready within each tier so blockers still surface early
        dayItems.sort((a, b) => {
            const aCrit = this.isCriticalItem(a.id) ? 0 : 1;
            const bCrit = this.isCriticalItem(b.id) ? 0 : 1;
            if (aCrit !== bCrit) return aCrit - bCrit;
            const aNotReady = this.isStatusNotReady(a.asset_name, a.activity_name) ? 1 : 0;
            const bNotReady = this.isStatusNotReady(b.asset_name, b.activity_name) ? 1 : 0;
            if (aNotReady !== bNotReady) return aNotReady - bNotReady;
            return new Date(a.start_ts) - new Date(b.start_ts);
        });

        this.$('dayDetailBody').innerHTML = dayItems.map(it => {
            const succs = this.DATA.items.filter(x => (x.predecessor_ids || []).includes(it.id)).map(x => `${x.asset_name} — ${x.activity_name}`);
            const critical = this.isCriticalItem(it.id);
            const notReady = this.isStatusNotReady(it.asset_name, it.activity_name);
            const borderColor = notReady ? '#d32f2f' : (critical ? '#f57c00' : '#eee');
            const statusElId = `dayStatus-${it.id}`;
            const resultElId = `dayResult-${it.id}`;
            const predsElId = `dayPreds-${it.id}`;
            return `<div style="border:1px solid ${borderColor}; border-left:5px solid ${this.activityColor(it.activity_name)}; border-radius:6px; padding:12px 14px; margin-bottom:10px; ${notReady ? 'background:#fff5f5;' : (critical ? 'background:#fff8f0;' : '')}">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <strong style="font-size:14px;">${escHtml(it.asset_name)} — ${escHtml(it.activity_name)}</strong>
                    <span>
                        ${notReady ? '<span style="color:#d32f2f; font-weight:700; font-size:12px;">⛔ Not Ready</span>' : ''}
                        ${critical ? '<span style="color:#f57c00; font-weight:700; font-size:12px; margin-left:8px;">🔥 Critical Path</span>' : ''}
                    </span>
                </div>
                <div style="font-size:12.5px; color:#666; margin-top:6px; line-height:1.8;">
                    <strong>Area:</strong> ${escHtml(it.area || '—')} &nbsp;•&nbsp;
                    <strong>Duration:</strong> ${hoursToDays(it.duration_hours)} day(s) &nbsp;•&nbsp;
                    <strong>Contractor(s):</strong> ${escHtml((it.contractor_name || '').split('|').map(s => s.trim()).filter(Boolean).join(', ') || '—')}<br>
                    <strong>Status (LaunchPad):</strong> <span id="${statusElId}">Checking...</span>
                    ${this.isPastOrToday(it) ? ` &nbsp;•&nbsp; <strong>Result (Supabase):</strong> <span id="${resultElId}">Checking...</span>` : ''}<br>
                    <strong>Constraints (predecessors):</strong> <span id="${predsElId}">${(it.predecessor_ids||[]).length ? 'Checking...' : 'None'}</span><br>
                    <strong>Blocks (successors):</strong> ${succs.length ? escHtml(succs.join(', ')) : 'None'}
                </div>
                <button class="tool-btn small" style="margin-top:8px;" onclick="this.getRootNode().host.closeModal('dayDetailModal'); this.getRootNode().host.openDetailPanel('${it.id}')">Open item</button>
            </div>`;
        }).join('');
        dayItems.forEach(it => {
            this.fetchLaunchPadStatusInto(it.activity_name, it.asset_name, `dayStatus-${it.id}`).then(() => {
                // a fetch can flip an item's not-ready state after the list was
                // already sorted/painted — resort next time the modal opens
            });
            if (this.isPastOrToday(it)) this.fetchSupabaseResultInto(it.launchpad_id, `dayResult-${it.id}`);
            if ((it.predecessor_ids || []).length) {
                this.unsatisfiedPredecessorsLabel(it).then(label => {
                    const el = this.$(`dayPreds-${it.id}`);
                    if (el) el.textContent = label;
                });
            }
        });
        this.openModal('dayDetailModal');
    }

    // The gate every Bridge mutation now goes through instead of pushing to
    // LaunchPad directly (see maybeSyncToLaunchPad() below, which
    // acceptPendingChanges() calls once the user actually accepts). Unified
    // projects have nothing to gate — ItemsDB already wrote straight to
    // BackEndData, there's no separate "propagate" step left to defer.
    markPendingSync(item) {
        // Unified projects: ItemsDB.update()/insert() above already staged
        // this as a draft (or kept it local-only) rather than writing live
        // — this just tracks it for the banner, same as legacy mode.
        if (!item) return;
        this.pendingSyncIds.add(item.id);
        this.savePendingSyncState();
        this.updatePendingSyncUI();
    }

    // deleteItemById() calls this for an item that WAS already pushed to
    // LaunchPad (has a launchpad_id) — the Bridge item itself is gone
    // immediately (that's local, not gated), but its LaunchPad row stays
    // untouched in Schedule until the delete is accepted too, same as any
    // other pending change.
    markPendingDelete(launchpadId) {
        if (launchpadId == null) return;
        this.pendingDeleteLaunchPadIds.add(launchpadId);
        this.savePendingSyncState();
        this.updatePendingSyncUI();
    }

    // Pending state is per-browser, not shared across users — it lives in
    // this tab's memory, backed by localStorage only so an accidental
    // reload doesn't silently lose track of what's still unpublished. It is
    // NOT visible to anyone else with Bridge open: another user's tab keeps
    // its own separate pending set (starting empty), so it can already see
    // this browser's un-accepted moves in Bridge itself (that write already
    // landed) with no indication they haven't reached Schedule yet. Fine
    // for the "one person reviews their own batch of moves, then accepts"
    // workflow this was built for; worth knowing if this ever needs to
    // become a shared, cross-user review queue instead.
    pendingSyncStorageKey() { return `bridge_pending_sync_${this.PROJECT_KEY}`; }
    savePendingSyncState() {
        try {
            localStorage.setItem(this.pendingSyncStorageKey(), JSON.stringify({
                syncIds: Array.from(this.pendingSyncIds),
                deleteIds: Array.from(this.pendingDeleteLaunchPadIds)
            }));
        } catch (e) { /* storage unavailable/full — pending state just won't survive a reload */ }
    }
    loadPendingSyncState() {
        try {
            const raw = localStorage.getItem(this.pendingSyncStorageKey());
            if (!raw) return;
            const parsed = JSON.parse(raw);
            (parsed.syncIds || []).forEach(id => this.pendingSyncIds.add(id));
            (parsed.deleteIds || []).forEach(id => this.pendingDeleteLaunchPadIds.add(id));
        } catch (e) { /* ignore corrupt/unreadable state */ }
    }

    updatePendingSyncUI() {
        const count = this.pendingSyncIds.size + this.pendingDeleteLaunchPadIds.size;
        const banner = this.$('pendingSyncBanner');
        if (!banner) return;
        banner.style.display = count ? 'flex' : 'none';
        const countEl = this.$('pendingSyncCount');
        if (countEl) countEl.textContent = count === 1 ? '1 change' : `${count} changes`;
    }

    // Pushes every pending move/edit/create (and any deferred deletes) to
    // LaunchPad in one batch — this is the only place Bridge → Schedule
    // pushes actually happen now. Sequential, not parallel: several pending
    // items can easily need a fresh slot on the same day at once, which is
    // exactly the race syncItemToLaunchPad()'s own per-item queue and
    // move_schedule_row's atomicity exist to prevent, but only if these
    // don't all fire at the same instant to begin with.
    async acceptPendingChanges() {
        if (!this._supabase) { this.toast('Connect to Supabase first.'); return; }
        if (this.UNIFIED_SCHEDULE) return this._acceptPendingChangesUnified();
        const total = this.pendingSyncIds.size + this.pendingDeleteLaunchPadIds.size;
        if (!total) return;
        this.setSaveIndicator('dirty', 'Publishing to Schedule...');
        let ok = 0, fail = 0;

        for (const id of Array.from(this.pendingSyncIds)) {
            const item = this.DATA.items.find(it => it.id === id);
            if (!item) { this.pendingSyncIds.delete(id); continue; } // deleted locally before being accepted
            const success = await this.syncItemToLaunchPad(item);
            if (success) { ok++; this.pendingSyncIds.delete(id); } else fail++;
        }
        for (const launchpadId of Array.from(this.pendingDeleteLaunchPadIds)) {
            const { error } = await this._supabase.from(this.LAUNCHPAD_TABLE).delete().eq('id', launchpadId);
            if (!error) { ok++; this.pendingDeleteLaunchPadIds.delete(launchpadId); }
            else { fail++; console.error('Accept: pending LaunchPad delete failed', launchpadId, error); }
        }

        // "The scheduler should be resynced to match the bridge" — pushing
        // the tracked deltas above is the common case, but this final sweep
        // is the actual guarantee: anything still sitting in Schedule with
        // no matching Bridge item gets cleared too, not just the ones this
        // session happened to track through pendingDeleteLaunchPadIds.
        // Silent — Accept itself was already the user's confirmation.
        const extraCleared = await this.clearOrphanedScheduleRows({ silent: true });

        this.savePendingSyncState();
        this.updatePendingSyncUI();
        this.setSaveIndicator('ready', 'Ready');
        this.toast(
            `Published ${ok} change${ok === 1 ? '' : 's'} to Schedule` +
            (extraCleared ? `, cleared ${extraCleared} stale row${extraCleared === 1 ? '' : 's'}` : '') +
            ` — Schedule now matches Bridge${fail ? `. ${fail} failed, still pending, see console` : '.'}`,
            7000
        );
    }

    // Reverts every unaccepted local change back to whatever Schedule
    // currently shows — the undo counterpart to acceptPendingChanges().
    // Schedule (not Bridge's own history) is the source of truth to revert
    // TO, since a pending change is by definition something Schedule
    // doesn't know about yet.
    async discardPendingChanges() {
        const total = this.pendingSyncIds.size + this.pendingDeleteLaunchPadIds.size;
        if (!total) return;
        if (!this._supabase) { this.toast('Connect to Supabase first.'); return; }
        if (this.UNIFIED_SCHEDULE) return this._discardPendingChangesUnified(total);
        if (!confirm(`Discard ${total} unaccepted change${total === 1 ? '' : 's'}? Bridge will revert back to whatever Schedule currently shows. This cannot be undone.`)) return;

        this.setSaveIndicator('dirty', 'Discarding...');

        for (const id of Array.from(this.pendingSyncIds)) {
            const item = this.DATA.items.find(it => it.id === id);
            if (!item) { this.pendingSyncIds.delete(id); continue; }
            if (!item.launchpad_id) {
                // Never accepted in the first place — there's nothing in
                // Schedule to revert to, so discarding this one means
                // undoing the creation itself.
                await this.ItemsDB.remove(id);
                this.DATA.items = this.DATA.items.filter(it => it.id !== id);
            } else {
                // Fetched by id directly, not by asset/activity matching —
                // pullFromLaunchPad()'s own fuzzy matching can't reliably
                // tell a genuine pending move apart from "nothing changed"
                // here, since launchpad_day_label only gets updated once a
                // move is actually accepted, not while it's still pending.
                const { data, error } = await this._supabase.from(this.LAUNCHPAD_TABLE).select('*').eq('id', item.launchpad_id).maybeSingle();
                if (!error && data) {
                    item.start_ts = new Date(data.day_label + 'T07:00').toISOString();
                    item.activity_name = data.activity || item.activity_name;
                    item.asset_name = data.asset || item.asset_name;
                    item.notes = data.notes || '';
                    item.contractor_name = data.trade_partners || '';
                    item.area = data.place || item.area;
                    item.launchpad_day_label = data.day_label;
                    await this.ItemsDB.update(id, {
                        start_ts: item.start_ts, activity_name: item.activity_name, asset_name: item.asset_name,
                        notes: item.notes, contractor_name: item.contractor_name, area: item.area,
                        launchpad_day_label: item.launchpad_day_label
                    });
                }
                // Row's gone entirely (shouldn't normally happen — its
                // delete would itself be pending, not already applied) —
                // nothing to revert to, so the local edit is left as-is.
            }
            this.pendingSyncIds.delete(id);
        }

        if (this.pendingDeleteLaunchPadIds.size) {
            // The Bridge item is already gone locally, but its Schedule row
            // was never actually removed (that delete was deferred too) —
            // it's still there to restore from. Reuses pullFromLaunchPad()'s
            // existing "no local match found → import as a new item"
            // branch, which is exactly a restore in this situation.
            this.pendingDeleteLaunchPadIds.clear();
            await this.runBackgroundSweep(() => this.pullFromLaunchPad());
        }

        this.savePendingSyncState();
        this.updatePendingSyncUI();
        this.setSaveIndicator('ready', 'Ready');
        this.renderFilterBar();
        this.renderGantt();
        this.toast('Discarded — Bridge now matches what Schedule currently shows.', 5000);
    }

    // Unified-project counterpart to acceptPendingChanges() above — commits
    // every pending draft/delete straight onto BackEndData's live columns
    // (there's no separate LaunchPad table to push to). Fetches each
    // pending row FRESH here rather than trusting the already draft-merged
    // in-memory item — the day-changed check below needs the row's true
    // LIVE day_label, which this.DATA.items no longer carries once a draft
    // is showing (see backEndRowToItem()).
    async _acceptPendingChangesUnified() {
        const localOnlyIds = Array.from(this.pendingSyncIds).filter(id => {
            const it = this.DATA.items.find(x => x.id === id);
            return it && it._localOnly;
        });
        const draftIds = Array.from(this.pendingSyncIds).filter(id => !localOnlyIds.includes(id));
        const deleteIds = Array.from(this.pendingDeleteLaunchPadIds);
        if (!localOnlyIds.length && !draftIds.length && !deleteIds.length) return;

        this.setSaveIndicator('dirty', 'Publishing to Schedule...');
        let ok = 0, fail = 0;

        // 1. Pending deletes — commit the real delete now.
        for (const launchpadId of deleteIds) {
            const { error } = await this._supabase.from(this.LAUNCHPAD_TABLE).delete().eq('id', Number(launchpadId));
            if (!error) { ok++; this.pendingDeleteLaunchPadIds.delete(launchpadId); }
            else { fail++; console.error('Accept: delete failed', launchpadId, error); }
        }

        // 2. Pending edits/moves on rows that already exist live.
        for (const id of draftIds) {
            const item = this.DATA.items.find(it => it.id === id);
            if (!item) { this.pendingSyncIds.delete(id); continue; }
            const { data: rows, error: fetchErr } = await this._supabase.from(this.LAUNCHPAD_TABLE).select('*').eq('id', Number(id)).limit(1);
            const row = rows && rows[0];
            if (fetchErr || !row) { fail++; console.error('Accept: could not fetch row to commit', id, fetchErr); continue; }
            if (!row.draft) { this.pendingSyncIds.delete(id); continue; } // already committed/cleared elsewhere in the meantime

            const draft = row.draft;
            if (draft.day_label && draft.day_label !== row.day_label) {
                // Day actually changed — this is the one place
                // move_unified_schedule_row still runs, now that the
                // change is being committed rather than just staged.
                const idx = await this.findFreeLaunchPadIndex(draft.day_label);
                if (idx === null) { fail++; console.error(`Accept: no free row slot for ${draft.day_label}`); continue; }
                const newId = this.launchPadNumericId(draft.day_label, idx);
                const { error } = await this._supabase.rpc('move_unified_schedule_row', {
                    p_table: this.LAUNCHPAD_TABLE, p_old_id: Number(id), p_new_id: newId, p_day_label: draft.day_label,
                    p_activity: draft.activity || '', p_asset: draft.asset || '', p_notes: draft.notes || '',
                    p_place: draft.place || '', p_trade_partners: draft.trade_partners || '',
                    p_duration_hours: draft.duration_hours || 24, p_bridge_type: draft.bridge_type || '',
                    p_area: draft.area || '', p_asset_type: draft.asset_type || '',
                    p_predecessor_ids: JSON.stringify(draft.predecessor_ids || [])
                });
                if (error) { fail++; console.error('Accept (move) failed', id, error); continue; }
                const oldIdStr = String(id);
                item.id = String(newId);
                item.launchpad_id = String(newId);
                item.launchpad_day_label = draft.day_label;
                item._pendingDraft = false;
                // Unlike a pending edit (same row, stable id throughout),
                // committing a move DOES churn the id — any other item's
                // predecessor_ids pointing at the old one needs to follow.
                for (const it of this.DATA.items) {
                    if (it.id !== item.id && Array.isArray(it.predecessor_ids) && it.predecessor_ids.includes(oldIdStr)) {
                        it.predecessor_ids = it.predecessor_ids.map(pid => pid === oldIdStr ? item.id : pid);
                        await this.ItemsDB.update(it.id, { predecessor_ids: it.predecessor_ids });
                    }
                }
            } else {
                const { error } = await this._supabase.from(this.LAUNCHPAD_TABLE).update({
                    activity: draft.activity || '', asset: draft.asset || '', notes: draft.notes || '',
                    place: draft.place || '', trade_partners: draft.trade_partners || '',
                    duration_hours: draft.duration_hours || 24, bridge_type: draft.bridge_type || '',
                    area: draft.area || '', asset_type: draft.asset_type || '',
                    predecessor_ids: draft.predecessor_ids || [], draft: null
                }).eq('id', Number(id));
                if (error) { fail++; console.error('Accept (same-day) failed', id, error); continue; }
                item._pendingDraft = false;
            }
            ok++;
            this.pendingSyncIds.delete(id);
        }

        // 3. Brand-new local-only items — the real insert finally happens.
        for (const id of localOnlyIds) {
            const item = this.DATA.items.find(it => it.id === id);
            if (!item) { this.pendingSyncIds.delete(id); continue; }
            const oldTempId = item.id;
            const dayLabel = new Date(item.start_ts).toISOString().slice(0, 10);
            const idx = await this.findFreeLaunchPadIndex(dayLabel);
            if (idx === null) { fail++; console.error(`Accept: no free row slot for ${dayLabel}`); continue; }
            const numericId = this.launchPadNumericId(dayLabel, idx);
            const row = this.itemToBackEndRow(item, numericId, dayLabel);
            const { data, error } = await this._supabase.from(this.LAUNCHPAD_TABLE).insert([row]).select();
            if (error) { fail++; console.error('Accept (new item) failed', id, error); continue; }
            Object.assign(item, this.backEndRowToItem(data[0]));
            item._localOnly = false;
            // Symmetric to the move-remap above — if any OTHER item linked
            // to this one as a predecessor while it was still local-only
            // (referencing its temporary uid()), point it at the new real
            // id now that one exists.
            for (const it of this.DATA.items) {
                if (it.id !== item.id && Array.isArray(it.predecessor_ids) && it.predecessor_ids.includes(oldTempId)) {
                    it.predecessor_ids = it.predecessor_ids.map(pid => pid === oldTempId ? item.id : pid);
                    await this.ItemsDB.update(it.id, { predecessor_ids: it.predecessor_ids });
                }
            }
            ok++;
            this.pendingSyncIds.delete(id);
        }

        this.savePendingSyncState();
        this.updatePendingSyncUI();
        this.setSaveIndicator('ready', 'Ready');
        this.renderFilterBar();
        this.renderGantt();
        this.toast(`Published ${ok} change${ok === 1 ? '' : 's'} to Schedule${fail ? ` — ${fail} failed, still pending, see console` : '.'}`, 7000);
    }

    // Unified-project counterpart to discardPendingChanges() above.
    async _discardPendingChangesUnified(total) {
        if (!confirm(`Discard ${total} unaccepted change${total === 1 ? '' : 's'}? Bridge will revert back to whatever Schedule currently shows. This cannot be undone.`)) return;
        this.setSaveIndicator('dirty', 'Discarding...');

        for (const id of Array.from(this.pendingSyncIds)) {
            const item = this.DATA.items.find(it => it.id === id);
            if (!item) { this.pendingSyncIds.delete(id); continue; }
            if (item._localOnly) {
                // Never left this browser — discarding it just means not
                // creating it.
                this.DATA.items = this.DATA.items.filter(it => it.id !== id);
            } else {
                const { error } = await this._supabase.from(this.LAUNCHPAD_TABLE).update({ draft: null }).eq('id', Number(id));
                if (!error) {
                    const { data } = await this._supabase.from(this.LAUNCHPAD_TABLE).select('*').eq('id', Number(id)).maybeSingle();
                    if (data) Object.assign(item, this.backEndRowToItem(data));
                } else {
                    console.error('Discard: failed to clear draft', id, error);
                }
            }
            this.pendingSyncIds.delete(id);
        }

        for (const launchpadId of Array.from(this.pendingDeleteLaunchPadIds)) {
            const { error } = await this._supabase.from(this.LAUNCHPAD_TABLE).update({ draft_deleted: false }).eq('id', Number(launchpadId));
            if (!error) {
                const { data } = await this._supabase.from(this.LAUNCHPAD_TABLE).select('*').eq('id', Number(launchpadId)).maybeSingle();
                if (data && !this.DATA.items.some(it => it.id === String(launchpadId))) {
                    this.DATA.items.push(this.backEndRowToItem(data));
                }
                this.pendingDeleteLaunchPadIds.delete(launchpadId);
            } else {
                console.error('Discard: failed to restore', launchpadId, error);
            }
        }

        this.savePendingSyncState();
        this.updatePendingSyncUI();
        this.setSaveIndicator('ready', 'Ready');
        this.renderFilterBar();
        this.renderGantt();
        this.toast('Discarded — Bridge now matches what Schedule currently shows.', 5000);
    }

    // async and awaitable now (not just fire-and-forget) so a caller that
    // needs to sync several items in sequence — instead of letting them
    // race each other, see syncItemToLaunchPad()'s comment — can await
    // each one before starting the next. Callers that don't await it still
    // work exactly as before; the error is always caught here either way.
    async maybeSyncToLaunchPad(item) {
        // Unified projects write BackEndData directly via ItemsDB — there's
        // no separate LaunchPad row left to push to.
        if (this.UNIFIED_SCHEDULE || !this.LAUNCHPAD_SYNC_ENABLED || !item) return;
        try {
            await this.syncItemToLaunchPad(item);
        } catch (err) {
            console.error('LaunchPad auto-sync failed', err);
        }
    }

    // Pulls the current state of {PROJECT_KEY}BackEndData and reconciles it with the
    // local schedule so there is only ever ONE pull-plan item per real-world
    // activity, no matter how messy the data on either side has gotten:
    //   0. First, consolidate any pre-existing duplicates already sitting in
    //      Pull Planner itself (same asset+activity) — keeps the linked one
    //      if there is one, else the most recently-starting one, and removes
    //      the rest (re-pointing any dependency links onto the survivor).
    //   1. Group every fetched LaunchPad row by (asset, activity) — this is
    //      the key change: reconciliation is no longer "does this exact row
    //      id match," it's "how many rows exist for this activity, and which
    //      one is the real one." A row already linked to one of our items
    //      always wins that choice (ID comes first, as it should); if none
    //      of the group's rows are linked yet, the most recently-dated row is
    //      treated as current. Every other row in the group is just noise
    //      from however LaunchPad got into this state (e.g. its own move
    //      operation leaving an old row behind) and is ignored rather than
    //      spawning a second item here.
    //   2. That single chosen row either updates an existing linked/matched
    //      item (move + notes) or, if nothing matches at all, becomes one new
    //      imported item.
    async pullFromLaunchPad() {
        if (!this._supabase) { this.toast('Connect to Supabase first.'); return; }
        if (this.UNIFIED_SCHEDULE) { this.toast('This project reads BackEndData directly — nothing separate to pull.'); return; }
        this.setSaveIndicator('dirty', 'Pulling from LaunchPad...');
        const { data, error } = await this._supabase.from(this.LAUNCHPAD_TABLE).select('*');
        if (error) { console.error('LaunchPad pull failed', error); this.setSaveIndicator('error', 'Pull failed'); this.toast('Pull from LaunchPad failed — see console.'); return; }

        let moved = 0, imported = 0, matched = 0, deduped = 0;
        const normKey = (asset, activity) => `${(asset || '').trim().toLowerCase()}|||${(activity || '').trim().toLowerCase()}`;

        // ---- Step 0: consolidate our own pre-existing duplicates ----
        const ourGroups = {};
        this.DATA.items.forEach(it => {
            (ourGroups[normKey(it.asset_name, it.activity_name)] = ourGroups[normKey(it.asset_name, it.activity_name)] || []).push(it);
        });
        for (const key of Object.keys(ourGroups)) {
            const group = ourGroups[key];
            if (group.length < 2) continue;
            // A rescheduled activity deliberately creates a NEW item with
            // the exact same asset+activity as the one it superseded (see
            // index.html's linkRescheduledItemInBridge()) — that's not an
            // accidental duplicate, it's the whole point of the feature.
            // Confirmed causing real data loss in production: this step
            // was blind to superseded_by and merged a reschedule's
            // original/replacement pair like any other same-name
            // "duplicate," deleting one of them (and its predecessor/
            // successor links) on the very next pull. Skip the entire
            // group whenever a superseded_by relationship links two of its
            // own members — genuine accidental duplicates (no such
            // relationship) are still consolidated exactly as before.
            const groupIds = new Set(group.map(it => it.id));
            if (group.some(it => it.superseded_by && groupIds.has(it.superseded_by))) continue;
            group.sort((a, b) => {
                const aLinked = a.launchpad_id ? 1 : 0, bLinked = b.launchpad_id ? 1 : 0;
                if (aLinked !== bLinked) return bLinked - aLinked; // linked item wins first
                return new Date(b.start_ts) - new Date(a.start_ts); // else, most recent start wins
            });
            const survivor = group[0];
            for (let i = 1; i < group.length; i++) {
                const dup = group[i];
                await this.DB.remove(this.TABLES.items, dup.id);
                this.DATA.items = this.DATA.items.filter(x => x.id !== dup.id);
                this.DATA.items.forEach(x => {
                    if (x.predecessor_ids && x.predecessor_ids.includes(dup.id)) {
                        x.predecessor_ids = x.predecessor_ids.filter(id => id !== dup.id);
                        if (!x.predecessor_ids.includes(survivor.id)) x.predecessor_ids.push(survivor.id);
                    }
                });
                deduped++;
            }
        }

        // ---- Step 1: group every LaunchPad row by (asset, activity) ----
        const reverseMap = {};
        this.DATA.items.forEach(it => { if (it.launchpad_id) reverseMap[it.launchpad_id] = it; });

        const rowGroups = {};
        (data || []).forEach(row => {
            if (!row.activity || !row.asset || !row.day_label) return;
            (rowGroups[normKey(row.asset, row.activity)] = rowGroups[normKey(row.asset, row.activity)] || []).push(row);
        });

        for (const key of Object.keys(rowGroups)) {
            const rows = rowGroups[key];
            // an id already linked to one of our items always wins; among
            // ties (or when nothing is linked yet), the latest day_label wins
            rows.sort((a, b) => {
                const aLinked = reverseMap[a.id] ? 1 : 0, bLinked = reverseMap[b.id] ? 1 : 0;
                if (aLinked !== bLinked) return bLinked - aLinked;
                return (b.day_label || '').localeCompare(a.day_label || '');
            });
            const bestRow = rows[0];

            // ---- Step 2: resolve to a single item ----
            let item = reverseMap[bestRow.id];
            if (!item) {
                for (const r of rows) { if (reverseMap[r.id]) { item = reverseMap[r.id]; break; } }
            }
            if (!item) {
                // asset+activity identity takes precedence over trusting
                // whatever this item's launchpad_id currently says — LaunchPad
                // doesn't reliably preserve row ids or clean up the old row
                // when an activity moves, so a stale link must not block a
                // legitimate re-match here (that's exactly how the "moved in
                // LaunchPad but created a duplicate" bug happened)
                item = this.DATA.items.find(it =>
                    it.asset_name.trim().toLowerCase() === bestRow.asset.trim().toLowerCase() &&
                    it.activity_name.trim().toLowerCase() === bestRow.activity.trim().toLowerCase());
                if (item && !item.launchpad_id) matched++;
            }

            if (item) {
                let dayChanged = false;
                const patch = {};
                if (bestRow.day_label !== item.launchpad_day_label) {
                    const oldStart = new Date(item.start_ts);
                    const [y, m, d] = bestRow.day_label.split('-').map(Number);
                    const newStart = new Date(oldStart);
                    newStart.setFullYear(y, m - 1, d);
                    item.start_ts = newStart.toISOString();
                    patch.start_ts = item.start_ts;
                    dayChanged = true;
                }
                if (item.launchpad_id !== bestRow.id) patch.launchpad_id = bestRow.id;
                item.launchpad_id = bestRow.id;
                item.launchpad_day_label = bestRow.day_label;
                patch.launchpad_day_label = bestRow.day_label;
                if ((bestRow.notes || '') !== (item.notes || '')) {
                    item.notes = bestRow.notes || '';
                    patch.notes = item.notes;
                }
                await this.DB.update(this.TABLES.items, item.id, patch);
                if (dayChanged) { await this.enforceDependencies(item.id); moved++; }
            } else {
                const startDate = new Date(bestRow.day_label + 'T07:00');
                await this.ensureListValue('assets', bestRow.asset);
                await this.ensureListValue('activities', bestRow.activity);
                const payload = {
                    asset_name: bestRow.asset,
                    activity_name: bestRow.activity,
                    duration_hours: daysToHours(1),
                    area: bestRow.place || '',
                    contractor_name: bestRow.trade_partners || '',
                    notes: bestRow.notes || 'Imported from LaunchPad',
                    start_ts: startDate.toISOString(),
                    predecessor_ids: [],
                    launchpad_id: bestRow.id,
                    launchpad_day_label: bestRow.day_label
                };
                const saved = await this.DB.insert(this.TABLES.items, payload);
                const newItem = saved ? { ...saved, duration_hours: payload.duration_hours } : { id: uid(), ...payload };
                this.DATA.items.push(newItem);
                imported++;
            }
        }
        this.setSaveIndicator('ready', 'Ready');
        if (moved || imported || matched || deduped) {
            this.toast(`Pulled from LaunchPad: ${imported} imported, ${matched} matched up, ${moved} moved, ${deduped} duplicate(s) cleaned up.`, 6500);
            this.renderFilterBar();
            this.renderGantt();
        } else {
            this.toast('Nothing new from LaunchPad — everything already matches.');
        }
    }

    // Bridge is meant to be the source of truth for which activities exist —
    // but pullFromLaunchPad() above is one-directional in the sense that it
    // only ever ADDS or matches rows, it never removes one. A Scheduler row
    // that no longer corresponds to anything in Bridge (its Bridge item was
    // deleted, or the row is leftover cruft from before this sync pipeline
    // existed) just sits there forever, which is exactly how "Scheduler
    // shows more items than Bridge" drifts in over time. This runs the same
    // pull first — so anything genuinely new typed directly into the
    // Scheduler gets absorbed into Bridge, never wiped by mistake — and
    // only THEN clears whatever's still left over with no matching Bridge
    // item. Deleting rows is destructive/hard to undo, so unlike the
    // fully-automatic pull/repair above, this stays a manually-triggered
    // tool (see the "Reconcile Scheduler with Bridge" button in Manage
    // Lists) with a confirmation preview, same pattern as deleteItemById().
    //
    // Piloting on the CASB project only for now, per request — the
    // clearing half is a no-op for every other project until this has been
    // proven out there; the additive pull above still runs for everyone.
    async reconcileScheduleWithBridge() {
        if (!this._supabase) { this.toast('Connect to Supabase first.'); return; }
        if (this.UNIFIED_SCHEDULE) { this.toast('This project already reads/writes BackEndData directly — nothing to reconcile.'); return; }
        this.setSaveIndicator('dirty', 'Reconciling with Bridge...');
        await this.runBackgroundSweep(() => this.pullFromLaunchPad());
        await this.clearOrphanedScheduleRows();
        this.setSaveIndicator('ready', 'Ready');
    }

    // Deletes every Scheduler row that has no matching Bridge item — the
    // other half of "tightening the pipeline": a Bridge delete should mean
    // the row disappears from Schedule too, not just stop being linked.
    // Called two ways: manually via the Manage Lists button above (with a
    // confirm preview, since it's a standalone maintenance sweep someone
    // might run at any time), and automatically at the end of
    // acceptPendingChanges() (silent — the user already confirmed intent by
    // clicking Accept, and by that point every legitimate deletion has
    // already gone through pendingDeleteLaunchPadIds; this is the final
    // consistency guarantee that nothing else got left behind).
    async clearOrphanedScheduleRows(opts) {
        const silent = opts && opts.silent;
        if (!this._supabase || this.UNIFIED_SCHEDULE) return 0;

        const { data, error } = await this._supabase.from(this.LAUNCHPAD_TABLE).select('*');
        if (error) {
            console.error('Reconcile: LaunchPad fetch failed', error);
            if (!silent) this.toast('Reconcile failed — see console.');
            return 0;
        }

        // linkedIds MUST come from a fresh query, not this.DATA.items —
        // confirmed causing real data loss in production: this runs
        // automatically after every Accept & Publish, and this.DATA.items
        // is whatever Bridge last loaded, possibly hours stale in a tab
        // left open. Any BackEndData row created directly in Schedule since
        // then (never pulled into this session), or created moments ago by
        // a DIFFERENT concurrent Bridge session, looked "orphaned" against
        // that stale in-memory list and got permanently deleted with no
        // confirmation (silent mode). Querying schedule_items directly here
        // instead reflects every link that exists right now, regardless of
        // what this particular browser tab happens to have loaded.
        const { data: linkedRows, error: linkedErr } = await this._supabase
            .from(this.TABLES.items).select('launchpad_id').not('launchpad_id', 'is', null);
        if (linkedErr) {
            console.error('Reconcile: fresh linked-id fetch failed — aborting rather than risk deleting against a stale list', linkedErr);
            if (!silent) this.toast('Reconcile failed — see console.');
            return 0;
        }
        const linkedIds = new Set((linkedRows || []).map(r => String(r.launchpad_id)));
        const isOccupied = row => !!(row.activity || row.asset || row.notes || row.status || row.trade_partners || row.time || row.place || row.result || row.loto);
        const orphans = (data || []).filter(row => isOccupied(row) && !linkedIds.has(String(row.id)));

        if (!orphans.length) {
            if (!silent) this.toast('Reconcile: Scheduler already matches Bridge — nothing to clear.');
            return 0;
        }

        if (!silent) {
            const preview = orphans.slice(0, 12)
                .map(r => `${r.day_label}: ${r.asset || '(no asset)'} — ${r.activity || '(no activity)'}`)
                .join('\n') + (orphans.length > 12 ? `\n...and ${orphans.length - 12} more` : '');
            const ok = confirm(`Bridge has no matching activity for ${orphans.length} row(s) currently shown in the Scheduler:\n\n${preview}\n\nClear them from the Scheduler so it matches Bridge? This cannot be undone.`);
            if (!ok) return 0;
        }

        let cleared = 0;
        for (const row of orphans) {
            const { error: delErr } = await this._supabase.from(this.LAUNCHPAD_TABLE).delete().eq('id', row.id);
            if (delErr) console.error('Reconcile: failed to clear orphaned row', row.id, delErr);
            else cleared++;
        }
        if (!silent) this.toast(`Reconcile: cleared ${cleared} Scheduler row(s) with no matching Bridge activity${cleared < orphans.length ? ` (${orphans.length - cleared} failed — see console)` : ''}.`, 7000);
        return cleared;
    }

    /* =========================================================================
       10b. GOOGLE SHEETS SYNC
       Pushes the current schedule (respecting active filters) into a Google
       Sheet stored in Google Drive, using an OAuth token obtained client-side
       via Google Identity Services. The spreadsheet is created once (inside
       GOOGLE_DRIVE_FOLDER_ID if set) and reused on every subsequent sync.
       ========================================================================= */

    ensureGoogleTokenClient() {
        if (!window.google || !google.accounts || !google.accounts.oauth2) return null;
        if (!this.googleTokenClient) {
            this.googleTokenClient = google.accounts.oauth2.initTokenClient({
                client_id: GOOGLE_CLIENT_ID,
                scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
                callback: () => {}
            });
        }
        return this.googleTokenClient;
    }
    requestGoogleToken(forceConsent) {
        return new Promise((resolve, reject) => {
            const client = this.ensureGoogleTokenClient();
            if (!client) { reject(new Error('Google Identity Services not loaded')); return; }
            client.callback = (resp) => {
                if (resp.error) { reject(resp); return; }
                this.googleAccessToken = resp.access_token;
                resolve(this.googleAccessToken);
            };
            client.requestAccessToken({ prompt: forceConsent ? 'consent' : '' });
        });
    }

    async createSheetInDrive(token) {
        const metadata = {
            name: 'Pull Plan Schedule',
            mimeType: 'application/vnd.google-apps.spreadsheet'
        };
        if (GOOGLE_DRIVE_FOLDER_ID) metadata.parents = [GOOGLE_DRIVE_FOLDER_ID];
        const res = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(metadata)
        });
        if (!res.ok) throw new Error('Drive create failed: ' + (await res.text()));
        const data = await res.json();
        return data.id;
    }

    async writeScheduleToSheet(token, sheetId) {
        const rows = this.exportRowsForReport();
        const header = rows.length ? Object.keys(rows[0]) : ['Date','Time','Asset','Activity','Duration (days)','Area','Contractor(s)','Notes'];
        const values = [header, ...rows.map(r => header.map(h => r[h] ?? ''))];
        const range = 'A1';
        const res = await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=RAW`,
            {
                method: 'PUT',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ range, majorDimension: 'ROWS', values })
            }
        );
        if (!res.ok) throw new Error('Sheets write failed: ' + (await res.text()));
    }

    async syncToGoogleSheet() {
        if (!GOOGLE_CONFIGURED) {
            this.toast('Add your Google OAuth Client ID in the script config first (see README).');
            return;
        }
        this.setSaveIndicator('dirty', 'Connecting to Google...');
        try {
            const token = await this.requestGoogleToken(!this.googleAccessToken);
            let sheetId = localStorage.getItem('pullplan_gsheet_id');
            if (!sheetId) {
                this.setSaveIndicator('dirty', 'Creating sheet in Drive...');
                sheetId = await this.createSheetInDrive(token);
                localStorage.setItem('pullplan_gsheet_id', sheetId);
            }
            this.setSaveIndicator('dirty', 'Pushing schedule...');
            await this.writeScheduleToSheet(token, sheetId);
            this.setSaveIndicator('ready', 'Synced to Google Sheets');
            const link = this.$('openSheetLink'); // no button calls this function anymore (removed along with "Sync to Sheets") — guarded in case that changes
            if (link) { link.href = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`; link.style.display = 'inline'; }
            this.toast('Schedule pushed to Google Sheets');
        } catch (err) {
            console.error(err);
            this.setSaveIndicator('error', 'Google sync failed');
            this.toast('Google Sheets sync failed — see browser console for details');
        }
    }

    /* =========================================================================
       11. EXPORTS — Print (native), PDF report (jsPDF+autotable), XLSX (SheetJS)
       All three respect the currently active filters.
       ========================================================================= */

    exportRowsForReport() {
        return this.getFilteredItems()
            .slice()
            .sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts))
            .map(it => ({
                Date: new Date(it.start_ts).toLocaleDateString(),
                Time: new Date(it.start_ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                Asset: it.asset_name,
                Activity: it.activity_name,
                'Duration (days)': hoursToDays(it.duration_hours),
                Area: it.area || '',
                'Contractor(s)': it.contractor_name || '',
                Notes: it.notes || ''
            }));
    }

    async exportPDF() {
        const rows = this.exportRowsForReport();
        if (!rows.length) { this.toast('No items to export with the current filters.'); return; }
        await ensureJsPdf();
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'landscape' });
        doc.setFontSize(16);
        doc.setTextColor(46, 125, 50);
        doc.text('Pull Plan Schedule', 14, 16);
        doc.setFontSize(9);
        doc.setTextColor(100);
        doc.text(`Generated ${new Date().toLocaleString()}  •  ${rows.length} item(s)`, 14, 22);

        doc.autoTable({
            startY: 27,
            head: [Object.keys(rows[0])],
            body: rows.map(r => Object.values(r)),
            styles: { fontSize: 8, cellPadding: 2.5 },
            headStyles: { fillColor: [46, 125, 50], textColor: 255 },
            alternateRowStyles: { fillColor: [245, 247, 245] }
        });
        doc.save(`pull-plan-schedule-${new Date().toISOString().slice(0,10)}.pdf`);
        this.toast('PDF exported');
    }

    async exportXLSX() {
        const rows = this.exportRowsForReport();
        if (!rows.length) { this.toast('No items to export with the current filters.'); return; }
        await ensureXlsx();
        const ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = Object.keys(rows[0]).map(k => ({ wch: Math.max(10, k.length + 2) }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Pull Plan Schedule');
        XLSX.writeFile(wb, `pull-plan-schedule-${new Date().toISOString().slice(0,10)}.xlsx`);
        this.toast('XLSX exported');
    }

    /* =========================================================================
       12. COMPLETION PLAN — a date-range report grouped by assignee
       (contractor), so each trade partner can see exactly what they owe and
       when within the window, in date order.
       ========================================================================= */
    openCompletionPlanModal() {
        const today = new Date().toISOString().slice(0, 10);
        const twoWeeks = new Date(); twoWeeks.setDate(twoWeeks.getDate() + 14);
        this.$('completionPlanStart').value = today;
        this.$('completionPlanEnd').value = twoWeeks.toISOString().slice(0, 10);
        this.openModal('completionPlanModal');
    }

    buildCompletionPlanGroups() {
        const startVal = this.$('completionPlanStart').value;
        const endVal = this.$('completionPlanEnd').value;
        if (!startVal || !endVal) { this.toast('Pick both a start and end date.'); return null; }
        const rangeStart = new Date(startVal + 'T00:00').getTime();
        const rangeEnd = new Date(endVal + 'T23:59:59').getTime();
        const items = this.DATA.items
            .filter(it => { const t = new Date(it.start_ts).getTime(); return t >= rangeStart && t <= rangeEnd; })
            .sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts));
        if (!items.length) { this.toast('No activities fall in that date range.'); return null; }

        const groups = {};
        items.forEach(it => {
            // An item can now have more than one contractor — it belongs in
            // EACH of their groups, not lumped under one combined
            // "A | B" group of its own.
            const assignees = (it.contractor_name || '').split('|').map(s => s.trim()).filter(Boolean);
            if (!assignees.length) assignees.push('Unassigned');
            assignees.forEach(assignee => { (groups[assignee] = groups[assignee] || []).push(it); });
        });
        return { groups, rangeStart, rangeEnd, startVal, endVal };
    }

    async exportCompletionPlan(format) {
        const built = this.buildCompletionPlanGroups();
        if (!built) return;
        const { groups, startVal, endVal } = built;
        const assignees = Object.keys(groups).sort();

        // make sure status is fetched (and cached) for everything in this
        // export first, so the Status column reflects LaunchPad's actual
        // current values instead of "Checking..." placeholders
        this.setSaveIndicator('dirty', 'Checking status...');
        const allItems = assignees.flatMap(a => groups[a]);
        for (const it of allItems) { await this.fetchLaunchPadStatus(it.activity_name, it.asset_name); }
        this.setSaveIndicator('ready', 'Ready');

        const statusFor = (it) => {
            const cached = this.STATUS_CACHE[this.statusCacheKey(it.asset_name, it.activity_name)];
            if (!cached || cached === 'pending' || cached === 'error') return { text: 'Unavailable', url: null };
            return { text: cached.result || 'NA', url: cached.url || null };
        };

        if (format === 'xlsx') {
            await ensureXlsx();
            const rows = [];
            const statusUrls = [];
            assignees.forEach(assignee => {
                groups[assignee].forEach(it => {
                    const status = statusFor(it);
                    rows.push({
                        Assignee: assignee,
                        Date: new Date(it.start_ts).toLocaleDateString(),
                        Asset: it.asset_name,
                        Activity: it.activity_name,
                        Area: it.area,
                        'Duration (days)': hoursToDays(it.duration_hours),
                        'Critical Path': this.isCriticalItem(it.id) ? 'Y' : 'N',
                        'Not Ready': this.isStatusNotReady(it.asset_name, it.activity_name) ? 'Y' : 'N',
                        Status: status.text
                    });
                    statusUrls.push(status.url);
                });
            });
            const ws = XLSX.utils.json_to_sheet(rows);
            ws['!cols'] = Object.keys(rows[0]).map(k => ({ wch: Math.max(10, k.length + 2) }));
            const statusColIdx = Object.keys(rows[0]).indexOf('Status');
            statusUrls.forEach((url, i) => {
                if (!url) return;
                const cellRef = XLSX.utils.encode_cell({ r: i + 1, c: statusColIdx }); // +1 skips the header row
                if (ws[cellRef]) ws[cellRef].l = { Target: url };
            });
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Completion Plan');
            XLSX.writeFile(wb, `completion-plan-${startVal}-to-${endVal}.xlsx`);
        } else {
            await ensureJsPdf();
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF({ orientation: 'landscape' });
            doc.setFontSize(16); doc.setTextColor(46, 125, 50);
            doc.text('Completion Plan', 14, 16);
            doc.setFontSize(9); doc.setTextColor(100);
            doc.text(`${startVal} to ${endVal}  •  Generated ${new Date().toLocaleString()}`, 14, 22);
            let y = 27;
            assignees.forEach(assignee => {
                const statusUrls = [];
                const rows = groups[assignee].map(it => {
                    const status = statusFor(it);
                    statusUrls.push(status.url);
                    return [
                        new Date(it.start_ts).toLocaleDateString(), it.asset_name, it.activity_name, it.area,
                        `${hoursToDays(it.duration_hours)}d`, this.isCriticalItem(it.id) ? 'Y' : 'N',
                        this.isStatusNotReady(it.asset_name, it.activity_name) ? 'Y' : 'N', status.text
                    ];
                });
                doc.setFontSize(11); doc.setTextColor(46, 125, 50);
                doc.text(assignee, 14, y + 5);
                doc.autoTable({
                    startY: y + 8,
                    head: [['Date', 'Asset', 'Activity', 'Area', 'Duration', 'Critical', 'Not Ready', 'Status']],
                    body: rows,
                    styles: { fontSize: 8, cellPadding: 2.5 },
                    headStyles: { fillColor: [46, 125, 46], textColor: 255 },
                    alternateRowStyles: { fillColor: [245, 247, 245] },
                    didParseCell: (data) => {
                        if (data.section === 'body' && data.column.index === 7 && statusUrls[data.row.index]) {
                            data.cell.styles.textColor = [21, 101, 192];
                        }
                    },
                    didDrawCell: (data) => {
                        if (data.section === 'body' && data.column.index === 7) {
                            const url = statusUrls[data.row.index];
                            if (url) doc.link(data.cell.x, data.cell.y, data.cell.width, data.cell.height, { url });
                        }
                    }
                });
                y = doc.lastAutoTable.finalY + 12;
                if (y > 180) { doc.addPage(); y = 20; }
            });
            doc.save(`completion-plan-${startVal}-to-${endVal}.pdf`);
        }
        this.toast('Completion plan exported');
        this.closeModal('completionPlanModal');
    }

    showBridgeViewerUpsell() {
        if (this.$('bridge-viewer-upsell')) return;
        const modal = document.createElement('div');
        modal.id = 'bridge-viewer-upsell';
        modal.style.cssText = 'position:absolute; inset:0; background:rgba(0,0,0,0.4); z-index:5000; display:flex; align-items:center; justify-content:center;';
        modal.innerHTML = `
            <div style="background:white; border-radius:10px; padding:28px; max-width:360px; text-align:center; box-shadow:0 10px 40px rgba(0,0,0,0.25); font-family: inherit;">
                <div style="font-size:36px; margin-bottom:10px;">🔒</div>
                <h3 style="margin:0 0 8px; color:#333;">View-Only Access</h3>
                <p style="color:#666; font-size:14px; margin-bottom:20px;">You have viewer access to this project and can't make changes here. Want to request editor access?</p>
                <button onclick="this.getRootNode().host.requestBridgeHigherAccess()" style="background:#2e7d32; color:white; border:none; padding:12px 20px; border-radius:6px; cursor:pointer; font-weight:bold; width:100%; margin-bottom:8px;">Request Editor Access</button>
                <button onclick="this.getRootNode().host.closeBridgeViewerUpsell()" style="background:none; border:none; color:#999; cursor:pointer; font-size:13px;">Cancel</button>
            </div>
        `;
        // Appended to this component's own shadow root (not document.body) —
        // unlike equipment-tracker-view's filter-dropdown, there's no overflow
        // clipping this needs to escape; it's just an upsell dialog.
        this.shadowRoot.appendChild(modal);
    }

    closeBridgeViewerUpsell() {
        const modal = this.$('bridge-viewer-upsell');
        if (modal) modal.remove();
    }

    async requestBridgeHigherAccess() {
        const modal = this.$('bridge-viewer-upsell');
        if (modal) modal.innerHTML = '<div style="background:white; border-radius:10px; padding:28px; text-align:center; font-size:14px; color:#666;">Sending request...</div>';

        try {
            if (!this.USER_EMAIL) throw new Error('No email was passed in from LaunchPad — please request access from there instead.');

            // Look up this project's own Apps Script URL / admin email directly
            // rather than assuming a scriptUrl param was passed in, so this
            // stays correct regardless of how this file was opened.
            const { data: project, error: projectErr } = await this._supabase
                .from('launchpad_projects')
                .select('google_script_url, admin_email')
                .eq('project_key', this.PROJECT_KEY)
                .maybeSingle();

            if (projectErr || !project) throw new Error("Could not find this project's configuration.");

            const accessRequestsTable = `${this.PROJECT_KEY}access_requests`;

            // Avoid spamming duplicate upgrade requests if one's already pending.
            const { data: existing } = await this._supabase
                .from(accessRequestsTable)
                .select('email')
                .ilike('email', this.USER_EMAIL)
                .maybeSingle();

            if (!existing) {
                const { error: insertErr } = await this._supabase
                    .from(accessRequestsTable)
                    .insert([{ email: this.USER_EMAIL, company: '', requested_role: 'editor' }]);
                if (insertErr) throw insertErr;
            }

            const url = `${project.google_script_url}?action=requestAccess&email=${encodeURIComponent(this.USER_EMAIL)}&company=${encodeURIComponent('')}&admin=${encodeURIComponent(project.admin_email || '')}`;
            await fetch(url);

            if (modal) modal.remove();
            alert('Your request for editor access has been sent to the admin.');
        } catch (e) {
            if (modal) modal.remove();
            alert('Could not send the request: ' + e.message);
        }
    }
}

customElements.define('bridge-view', BridgeView);
