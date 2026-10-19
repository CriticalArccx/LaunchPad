// <tamperseal-view> -- the Asset Tamper Seal Log grid/admin tool.
//
// Used two ways, same as equipment-tracker-view.js / seal-form-view.js:
//   1. Standalone: tamperseal.html loads this module directly and the
//      element reads ?project=&role=&email=&scriptUrl= from the page URL
//      itself (dev/bookmark use -- falls back to the STY4 project and an
//      editor/no-email role this file was originally built for).
//   2. Embedded: index.html dynamically imports this module and mounts
//      <tamperseal-view project="..." role="..." email="..." script-url="...">
//      directly into the shell, passing its own already-authenticated
//      Supabase client instead of letting this element create a second one.
//
// Two real layout differences from the old iframe version had to be fixed
// here, not just mechanically converted -- an iframe has its OWN viewport,
// so `vh`/`position:fixed` inside it already meant "fill the iframe's own
// box". A custom element shares the outer page's viewport, so the same
// rules would instead cover the whole browser window (including the
// LaunchPad shell's own header/sidebar). The export/settings modal overlays
// below use `height:100%`/`position:absolute`+`inset`-equivalent instead,
// so they stay scoped to this component's own box exactly like the iframe
// used to be.

// Now points at the SAME shared Supabase project index.html/bridge.html use.
// The Assets data has been migrated in and its old separate AssetRegistry
// table is no longer used — asset/location suggestions now come from the
// shared dropdownoptions table instead (see fetchLookupData()).
const SUPABASE_URL = 'https://rcnxetcomdrlxvlarqoc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjbnhldGNvbWRybHh2bGFycW9jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0NDIyMjksImV4cCI6MjA5MjAxODIyOX0.gP37sT5OrCOVRZXekMrBZHm5mtfnr6JrC2YGflWsDQU';

// Lazy-load jsPDF + autotable only when the PDF export is actually used.
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
let _jsPdfReady = null;
function ensureJsPdf() {
    if (!_jsPdfReady) {
        _jsPdfReady = loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
            .then(() => loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.25/jspdf.plugin.autotable.min.js'));
    }
    return _jsPdfReady;
}

const defaultColumnConfig = [
    { id: 'checkbox', name: '(checkbox)', visible: true, locked: true },
    { id: 'assetName', name: 'Asset Name', visible: true },
    { id: 'location', name: 'Location', visible: true },
    { id: 'subArea', name: 'Sub Area', visible: true },
    { id: 'sealNumber', name: 'Seal #', visible: true },
    { id: 'inspectionDate', name: 'Inspection Date', visible: true },
    { id: 'signoff', name: 'Signoff', visible: true },
    { id: 'inspectionNotes', name: 'Inspection Notes', visible: true },
    { id: 'status', name: 'Status', visible: true },
    { id: 'breakDate', name: 'Break Date', visible: true },
    { id: 'responsibleParty', name: 'Responsible Party', visible: true },
    { id: 'breakReason', name: 'Break Reason', visible: true }
];

// The seal status progression(s) — a simple sensible default (Intact ->
// Broken -> Removed) that admins can rename, extend, and branch via
// Settings. Multiple workflows can be defined; exactly one is "active" at
// a time, and its statuses are what actually populate every row's status
// dropdown across the whole log.
function makeDefaultWorkflow() {
    return {
        id: 'default',
        name: 'SOP Standard Workflow',
        active: true,
        // Matches the Tamper Seal Log SOP, Section 9 exactly — both the
        // Approved Break path and the Non-Approved Breach path branch off
        // the same starting status.
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
            { id: 't2', from: ['break_requested'], to: 'break_approved', formTrigger: '' },
            { id: 't3', from: ['break_approved'], to: 'broken_approved', formTrigger: 'break-seals' },
            { id: 't4', from: ['broken_approved'], to: 'ready_for_reseal', formTrigger: 'work-completed' },
            { id: 't5', from: ['ready_for_reseal'], to: 'replaced_approved', formTrigger: '' },
            { id: 't6', from: ['intact'], to: 'non_approved_break', formTrigger: '' },
            { id: 't7', from: ['non_approved_break'], to: 'replaced_non_approved', formTrigger: 'reinspection' }
        ]
    };
}

// Triggers live inside a specific workflow, and their from/to fields are
// status IDs that only resolve within THAT workflow's own statuses array
// (see getActiveTransitions() in seal-form.html) — so the Triggers editor
// showing every status from every workflow (not just the one currently
// being edited) needs a status picked from elsewhere to actually become
// real, locally-resolvable status in this workflow the moment it's used
// in a trigger, not just a display-only option. Matches by name
// (case-insensitive); returns the existing local status if there's
// already one with that name, otherwise creates and returns a new one.
function ensureStatusInWorkflow(wf, statusName, statusColor) {
    const existing = wf.statuses.find(s => s.name.toLowerCase() === statusName.toLowerCase());
    if (existing) return existing;
    const newStatus = { id: 'status_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), name: statusName, color: statusColor || '#e0e0e0' };
    wf.statuses.push(newStatus);
    return newStatus;
}

// Splits a seal number into a leading non-digit prefix, a numeric core,
// and a trailing non-digit suffix — e.g. "A-1001-B" -> prefix "A-", num
// "1001", suffix "-B". Returns null if there's no numeric core at all
// (a range needs something to increment).
function parseSealNumberParts(value) {
    const match = String(value).trim().match(/^(\D*)(\d+)(\D*)$/);
    if (!match) return null;
    return { prefix: match[1], num: match[2], suffix: match[3] };
}

const STYLE = `
<style>
        /* MATCHING LAUNCHPAD STYLING */
        :host {
    /* A custom element defaults to display:inline (unlike the real <body>
       this rule used to target), which would break every block/flex/sticky
       layout assumption below -- explicit display:block restores that. */
    display: flex;
    flex-direction: column;
    /* The shell (index.html) sets html/body to overflow:hidden and expects
       every embedded view to scroll internally (see equipment-tracker-view.js's
       .tracker-container) -- this view originally relied on the real
       window scrolling instead (a leftover from when it was a standalone
       iframe, which had its own independent scroll context). Bounding the
       host's height and letting #main-content-area (below) be the one
       scrollable region restores an actual scroll path now that it's
       embedded directly in the shell instead. */
    height: 100%;
    overflow: hidden;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    min-width: 1300px;
    margin: 0;
    padding: 0;
    background-color: #f8f9fa; /* Restores a light background color */
}
/* The subheader/header stay fixed size (normal flex children); this is
   the one flex child allowed to grow and scroll. min-height:0 overrides
   flexbox's default "never shrink below content size," which would
   otherwise silently defeat overflow-y:auto here. */
#main-content-area {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
}
        /* Styling for all cells except the Status column */
.cell-row textarea {
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; /* You can change the typeface here */
    font-size: 14px;      /* Adjust the size as needed */
    font-weight: 500;      /* Options: 400 (Normal), 600 (Semi-bold), 700 (Bold) */
    color: #333333;       /* Standard text color */
}

/* Ensure centering is preserved while changing fonts */
.cell-row textarea {
    text-align: center;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1.5;     /* Helps keep text vertically balanced */
}

        .header {
            min-height: 48px; padding: 8px 30px; background-color: #ffffff; border-bottom: 1px solid #dcdcdc;
            display: flex; align-items: center; box-shadow: 0 2px 10px rgba(0,0,0,0.08);
        }
        .header-center { flex: 1; text-align: center; }
        .header-center span { color: #d32f2f; font-weight: 800; font-size: 30px; letter-spacing: -1px; }

       .subheader {
    position: sticky;
    top: 0;
    z-index: 1000;
    background-color: #f1f3f4; /* Standard Grey */
    height: 50px;
    display: flex;
    align-items: center;
    padding: 0 30px;
    border-bottom: 1px solid #dcdcdc;
    justify-content: space-between;
    width: 100%; /* Changed from 1300px to 100% */
    min-width: 1300px; /* Ensures buttons don't move closer on iPad */
    box-sizing: border-box;
}

        .tool-btn {
            padding: 6px 12px; font-size: 13px; border: 1px solid #d32f2f;
            background: white; color: #d32f2f; cursor: pointer; border-radius: 4px; font-weight: bold;
        }

.frozen-bar {
    position: sticky;
    top: 50px;
    z-index: 999;
    background-color: #de4343; /* Bright Red */
    color: white;
}

        .frozen-grid {
    display: flex;
    width: 95%;
    margin: 0 auto;
    align-items: center;
    gap: 4px;
    padding: 0 20px;
    box-sizing: border-box;
}
        .header-cell { flex: 1; text-align: center; font-size: 11px; font-weight: bold; text-transform: uppercase; border-right: 1px solid rgba(255,255,255,0.5); padding: 4px 0; box-sizing: border-box; }
        .header-cell:last-of-type { border-right: none; }

        /* Forces the header row and every data row to agree on the exact
           same box model — same technique the Schedule (index.html) uses
           for its own column resizing, added here after the earlier
           percentage/pixel-based attempts still wouldn't line up. Without
           this, .frozen-grid and .cell-row can each resolve gap/margin
           slightly differently even when their CSS looks like it should
           match, which is enough to throw off exact column alignment. */
        .frozen-grid, .cell-row {
            box-sizing: border-box !important;
            margin: 0 !important;
            gap: 4px !important;
            flex-wrap: nowrap !important;
        }

        /* Column layout resizing — handles only show up in edit mode, so
           the header row looks completely normal otherwise. Positioned
           via JS (left, set in repositionTsColumnResizers()) relative to
           .frozen-grid itself, not nested inside the column they resize —
           see the comment on initTsColumnResizers() for why. */
        .ts-col-resizer {
            display: none;
            position: absolute;
            top: 0;
            width: 10px; height: 100%;
            cursor: col-resize;
            z-index: 20;
        }
        :host(.ts-layout-edit-mode) .ts-col-resizer {
            display: block;
        }
        :host(.ts-layout-edit-mode) .ts-col-resizer:hover,
        :host(.ts-layout-edit-mode) .ts-col-resizer.ts-active-drag {
            background: rgba(46, 125, 50, 0.35);
        }
        :host(.ts-layout-edit-mode) .header-cell,
        :host(.ts-layout-edit-mode) .edit-only-header {
            outline: 1px dashed rgba(255,255,255,0.6);
            outline-offset: -2px;
        }
        #ts-layout-edit-toolbar { display: none; align-items: center; gap: 8px; }
        :host(.ts-layout-edit-mode) #ts-layout-edit-toolbar { display: flex; }
        :host(.ts-layout-edit-mode) #ts-normal-toolbar-buttons { display: none; }

        /* ASSET ACCORDION STYLES — matches the Schedule's day-row style
           (.section-container/.date-header in index.html) exactly: no
           width%, no margin, no colored border/radius of its own. The
           Schedule's day boxes stay perfectly aligned with their header
           precisely because they add NO width layer of their own — they
           just inherit 100% of whatever width the one outer container
           (.week-container there, .area-container here) already
           established. Every earlier alignment issue in this file came
           from asset-container adding its own extra width/margin/border
           on top of area-container's — removing that layer here instead
           of trying to match its numbers more precisely. */
        .asset-container { margin-bottom: 10px; border-bottom: 1px solid #ddd; }
        .asset-header {
            background-color: #f1f3f4; color: #2e7d32; padding: 10px 30px;
            cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-weight: bold;
            border-top: 1px solid #ddd;
        }
        .asset-header:hover { background-color: #e8eaed; }

        .rows-container { padding: 10px 20px; display: block; }
        .rows-container.hidden { display: none; }

        /* Consolidated Cell Input Styles */
.cell-row select,
.cell-row textarea,
.status-cell {
    flex: 1;
    border: none !important;
    border-right: 1px solid #ccc !important;
    background-color: #f9f9f9;
    padding: 12px 8px;    /* Increased vertical padding to assist vertical centering */
    font-size: 13px;
    min-height: 40px;
    resize: none;
    text-align: center;   /* Horizontally centers text */
    display: flex;        /* Enables flex centering for select and status-cell */
    align-items: center;  /* Vertically centers text in select/status-cell */
    justify-content: center;
    line-height: 1.4;     /* Centers text line in textareas */
}

/* Ensure the delete button stays aligned */
.delete-btn {
    flex: 0 0 30px;
    display: flex;
    align-items: center;
    justify-content: center;
}

/* Fix for standard select centering */
.cell-row select {
    text-align-last: center;
    appearance: none; /* Removes default arrows for a cleaner centered look */
}

        /* GRID ROW STYLES */
        /* Updated Row Styles */
.cell-row {
    display: flex;
    align-items: center; /* Centers elements vertically relative to each other in the row */
    border-bottom: 2px solid #b0bec5;
    gap: 4px;
    background-color: #fff;
    min-height: 50px;    /* Ensuring a comfortable row height */
}

        /* COLOR LOGIC */
        .bg-green { background-color: #c8e6c9 !important; color: #1b5e20 !important; }
        .bg-red { background-color: #ffcdd2 !important; color: #b71c1c !important; }
        .bg-yellow { background-color: #fff9c4 !important; color: #f57f17 !important; }

        #saveIndicator { font-size: 13px; font-weight: bold; color: #1b5e20; margin-right: 15px; }

        /* Updated Header Layout */
.header-left {
    flex: 1; /* Takes up available space on the left */
    display: flex;
    align-items: center;
}

/* Red Rectangle Title Style */
.seal-log-header {
    border: 3px solid #d32f2f; /* Red rectangle */
    background-color: #d6445a;     /* Light red fill color */
    border-radius: 10px;        /* Smooth/rounded edges */
    padding: 5px 20px;
    color: #000000;             /* Black letters */
    font-weight: 800;
    font-size: 34px;
    letter-spacing: -1px;
    display: inline-block;
    text-transform: uppercase;
}

/* Remove or hide header-center as it's no longer used */
.header-center {
    display: none;
}
/* Styling for the Asset name text in the header bar */
.asset-header span:first-child {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-right: 15px;
    flex: 1;
}
/* Row Color Logic */
.row-intact {
    background-color: #c8e6c9 !important; /* Green */
}
.row-intact textarea, .row-intact select {
    background-color: #c8e6c9 !important;
    color: #000000 !important;
}

.row-broken {
    background-color: #ffcdd2 !important; /* Red */
}
.row-broken textarea, .row-broken select {
    background-color: #ffcdd2 !important;
    color: #000000 !important;
}

.row-removed {
    background-color: #f5f5f5 !important; /* Grey */
    text-decoration: line-through;
    color: #757575 !important;
}
.row-removed textarea, .row-removed select {
    background-color: #f5f5f5 !important;
    color: #000000 !important;
    text-decoration: line-through;
}
.row-custom-status {
    background-color: var(--row-status-color) !important;
}
.row-custom-status textarea, .row-custom-status select {
    background-color: var(--row-status-color) !important;
    color: #000000 !important;
}
.status-dropdown {
    font-size: 13px !important;    /* Increase font size */
    font-weight:  bold !important;   /* Make the text extra bold */
    text-align: center;
    text-align-last: center; /* Required for centering text in select boxes */
    padding: 10px 0;         /* Adjust padding to help with vertical balance */
    height: 100%;            /* Ensure it fills the centered row */
}

/* Update main containers from 95% to a fixed 1240px (centered).
   .asset-container deliberately removed from this list — it no longer
   has its own width at all now (see the ASSET ACCORDION STYLES comment
   above), and this rule's !important would have silently overridden that
   right back to a 95%-width box. */
.frozen-bar,
.area-container {
    width: 95% !important; /* Restores the full-screen desktop look */
    min-width: 1240px !important; /* Prevents squishing on iPad */
    margin: 20px auto;
    box-sizing: border-box;
}

/* AREA ACCORDION STYLES */
.area-container {
    margin: 20px auto;
    width: 95%;
    border: 2px solid #333;
    border-radius: 8px;
    background: #f1f3f4;
    overflow: hidden;
}

.area-header {
    background-color: #333;
    color: white;
    padding: 15px 25px;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    font-weight: bold;
    font-size: 24px;
}

.area-content {
    padding: 0; /* was 10px — the Schedule's equivalent (.week-content) has
        no padding of its own either; .rows-container's own 10px 20px
        padding (already an exact match to the Schedule's) is what
        provides the visual indent, so this was adding a second, extra
        inset on top of that. */
}

.area-content.hidden {
    display: none;
}

/* Asset container/header styling now lives in one place, near the top of
   this stylesheet, matching the Schedule's day-row pattern — see the
   comment there. This block used to re-override width/margin/border/
   font-size here, which is exactly the kind of duplicate, drifting
   definition that caused the alignment problems in the first place. */

/* The two filter groups (Locations, Statuses) now fill the header
   horizontally instead of stacking on the right — there's no logo/title
   competing for space anymore, so the header can be much shorter. */
.header-right {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;        /* wrap onto a second line on narrow screens instead of overflowing */
    gap: 24px;               /* breathing room between the Locations and Statuses groups */
    align-items: center;
    justify-content: flex-start;
    height: auto;
    width: 100%;             /* fill the header's full width now that the logo/title are gone */
}

.filter-group {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
}

.filter-label {
    font-size: 10px;
    font-weight: bold;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

/* Compact pill buttons — sized to sit comfortably in the shorter, single-row header */
.filter-btn {
    padding: 3px 10px;
    font-size: 11px;
    border: 1px solid #ccc;
    background: white;
    border-radius: 12px;
    cursor: pointer;
    transition: all 0.2s ease;
    white-space: nowrap;
}

.filter-btn:hover {
    background: #f5f5f5;
}

.filter-btn.active {
    background: #d32f2f;
    color: white;
    border-color: #d32f2f;
    font-weight: bold;
}

/* Location-specific active color */
.filter-btn.active.loc-filter {
    background: #333;
    border-color: #333;
}

/* Export Modal Styles */
.modal-overlay {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center;
    z-index: 2000;
}
.modal-content {
    background: white; padding: 25px; border-radius: 8px; text-align: center;
    box-shadow: 0 4px 15px rgba(0,0,0,0.2); width: 320px;
    max-height: 90%;
    overflow-y: auto;
    box-sizing: border-box;
}
.modal-content h3 { margin-top: 0; color: #333; font-size: 20px; }
.modal-btns { display: flex; gap: 10px; justify-content: center; margin-top: 20px; }

/* Search Bar Styling */
.search-container {
    flex-shrink: 0;
    width: 320px !important;
    background: white;
}

.search-container input {
    border: none;
    outline: none;
    padding: 6px;
    font-size: 13px;
    width: 100%;
}

.search-container i {
    color: #888;
    font-size: 14px;
}
/* Search Bar & Navigation Layout */
.subheader div:first-child {
    display: flex;
    align-items: center;
    gap: 10px; /* Space between buttons and search bar */
}

.search-container {
    display: flex;
    align-items: center;
    background: white;
    border: 1px solid #ccc;
    border-radius: 4px;
    padding: 0 8px;
    width: 320px; /* Increased for buttons */
}

.search-nav-btns {
    display: flex;
    gap: 2px;
    border-left: 1px solid #eee;
    padding-left: 5px;
    margin-left: 5px;
}

.search-nav-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 14px;
    color: #d32f2f;
    padding: 4px;
    display: flex;
    align-items: center;
}

.search-nav-btn:disabled {
    color: #ccc;
}

.match-counter {
    font-size: 11px;
    color: #666;
    margin-right: 5px;
    white-space: nowrap;
}

/* Instance Highlighting */
.highlight-match {
    outline: 3px solid #ffeb3b !important;
    background-color: #fffde7 !important;
    scroll-margin-top: 150px; /* Ensures row isn't hidden under header when scrolling */
}

/* --- CONSOLIDATED EDIT MODE SELECTORS --- */

/* 1. Force Checkboxes and Header Spacers to show (40px wide) */
.edit-checkbox-cell,
.edit-header-cell {
    flex: 0 0 40px !important;
    display: none !important; /* Hidden by default */
    justify-content: center;
    align-items: center;
    border-right: 1px solid #ccc;
    box-sizing: border-box;
}

/* When the host has the 'is-editing' class, show these elements */
:host(.is-editing) .edit-checkbox-cell {
    display: flex !important;
}

:host(.is-editing) .edit-header-cell {
    display: block !important;
}

/* 2. Asset & Location Columns (Show only during Edit or Preview) */
.edit-only-cell,
.edit-only-header {
    display: none !important;
}

:host(.is-editing) .edit-only-cell,
:host(.is-editing) .edit-only-header {
    display: flex !important;
    flex: 1;
    border-right: 1px solid rgba(255,255,255,0.5);
    box-sizing: border-box;
}

/* 3. Visual feedback for fields you are currently editing */
:host(.is-editing) .cell-row textarea,
:host(.is-editing) .cell-row select {
    background-color: #ffffff !important;
    border: 1px solid #d32f2f !important;
    cursor: text;
}

/* Cleaned & Consolidated Bulk Add Styling */
#addModal .modal-content {
    width: 1000px !important;
    margin: auto; /* Centers in the fixed viewport */
    background-color: white;
    border: 3px solid #d32f2f;
    border-radius: 12px;
}

/* Only apply 'appearance: none' to text inputs and selects, NOT checkboxes */
input:not([type="checkbox"]), textarea, select {
    -webkit-appearance: none;
    border-radius: 4px;
    font-size: 14px;
}

/* Ensure the checkbox itself is sized correctly */
.row-selector {
    width: 18px;
    height: 18px;
    cursor: pointer;
    -webkit-appearance: checkbox !important; /* Forces checkbox style back */
}

#addModal h3 {
    margin: 0;
    padding: 25px 50px;
    border-bottom: 1px solid #dcdcdc;
    font-size: 24px;
    color: #d32f2f;
    text-align: left;
}

.bulk-add-grid {
    display: grid;
    grid-template-columns: 1fr 1.5fr;
    gap: 25px;
    padding: 30px 50px;
}

.bulk-add-grid div {
    display: flex;
    flex-direction: column;
    align-items: flex-start; /* Standardizes left alignment for all labels/inputs */
    width: 100%;
}

.bulk-add-grid label {
    font-size: 12px;
    font-weight: bold;
    color: #dc1313;
    display: block;
    margin-bottom: 8px; /* Consistent gap for EVERY entry */
    text-transform: uppercase;
    text-align: left; /* Explicitly prevents centering */
}

.bulk-add-grid input {
    width: 100%;
    height: 55px;
    padding: 15px;
    font-size: 15px;
    border: 2px solid #ccc;
    border-radius: 6px;
    box-sizing: border-box;
}

#addModal .modal-btns {
    padding: 20px 50px;
    border-top: 1px solid #dcdcdc;
    display: flex;
    flex-direction: row;
    gap: 10px;
    align-items: flex-end;
}

#addModal .modal-btns .tool-btn {
    width: 200px;
    text-align: center;
}
/* Update your existing .bulk-add-grid input selector or add this */
.bulk-add-grid input[type="file"] {
    height: auto;
    border: 2px dashed #ccc; /* Visual cue for upload area */
    background: #fafafa;
    cursor: pointer;
}
/* Updated Header Left to include a gap between the image and the title */
.header-left {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 20px; /* Adds space between the logo and the red title box */
}

/* New style to ensure the logo fits nicely inside the header */
.header-logo {
    max-height: 80px; /* Keeps the image from stretching the 80px header */
    width: auto;      /* Maintains the image's aspect ratio */
    object-fit: contain;
}

/* ===== DARK MODE OVERRIDES =====
   Had no dark-mode support at all before this. Same palette as
   bridge-view.js/equipment-tracker-view.js's own :host(.dark-mode) blocks,
   for one consistent theme across the app. */
:host(.dark-mode){
    background-color: #121212 !important;
    color: #e0e0e0 !important;
}

:host(.dark-mode) .cell-row,
:host(.dark-mode) .rows-container,
:host(.dark-mode) .area-container,
:host(.dark-mode) .asset-header,
:host(.dark-mode) .modal-content{
    background-color: #1e1e1e !important;
    color: #e0e0e0 !important;
    border-color: #333 !important;
}
:host(.dark-mode) .cell-row{ border-bottom-color: #333 !important; }
:host(.dark-mode) .asset-header:hover{ background-color: #2a2a2a !important; }
:host(.dark-mode) .asset-container{ border-color: #333 !important; }

:host(.dark-mode) .cell-row select,
:host(.dark-mode) .cell-row textarea,
:host(.dark-mode) .status-cell{
    background-color: #2c2c2c !important;
    color: #e0e0e0 !important;
    border-right-color: #444 !important;
}

/* Status colors (row-intact/broken/removed/custom, and the .bg-* cell
   classes below) are deliberately left exactly as they were — matches
   index.html's own dark-mode treatment of these same colors: they're
   semantic status indicators, not neutral chrome, and should read the same
   in either theme. Re-asserted here (verbatim, same values) only because
   these need to win the specificity/source-order tie against the more
   general .cell-row/select/textarea dark rules above, which would
   otherwise paint over them. */
:host(.dark-mode) .row-intact{ background-color: #c8e6c9 !important; }
:host(.dark-mode) .row-intact textarea, :host(.dark-mode) .row-intact select{ background-color: #c8e6c9 !important; color: #000000 !important; }
:host(.dark-mode) .row-broken{ background-color: #ffcdd2 !important; }
:host(.dark-mode) .row-broken textarea, :host(.dark-mode) .row-broken select{ background-color: #ffcdd2 !important; color: #000000 !important; }
:host(.dark-mode) .row-removed{ background-color: #f5f5f5 !important; color: #757575 !important; }
:host(.dark-mode) .row-removed textarea, :host(.dark-mode) .row-removed select{ background-color: #f5f5f5 !important; color: #000000 !important; }
:host(.dark-mode) .row-custom-status{ background-color: var(--row-status-color) !important; }
:host(.dark-mode) .row-custom-status textarea, :host(.dark-mode) .row-custom-status select{ background-color: var(--row-status-color) !important; color: #000000 !important; }
:host(.dark-mode) .bg-green{ background-color: #c8e6c9 !important; color: #1b5e20 !important; }
:host(.dark-mode) .bg-red{ background-color: #ffcdd2 !important; color: #b71c1c !important; }
:host(.dark-mode) .bg-yellow{ background-color: #fff9c4 !important; color: #f57f17 !important; }

:host(.dark-mode) input,
:host(.dark-mode) select,
:host(.dark-mode) textarea{
    background-color: #2c2c2c !important;
    color: #e0e0e0 !important;
    border-color: #444 !important;
}

:host(.dark-mode) .filter-btn{ background: #2c2c2c !important; color: #e0e0e0 !important; border-color: #555 !important; }
:host(.dark-mode) .filter-btn:hover{ background: #383838 !important; }
:host(.dark-mode) .filter-label{ color: #aaa !important; }

:host(.dark-mode) .modal-overlay{ background: rgba(0,0,0,0.7) !important; }
:host(.dark-mode) .modal-content h3{ color: #e0e0e0 !important; }

:host(.dark-mode) #saveIndicator{ color: #81c784 !important; }
:host(.dark-mode) ::-webkit-scrollbar-thumb{ background: #555 !important; }
</style>
`;

const MARKUP = `
    <datalist id="asset-list"></datalist>
<datalist id="location-list"></datalist>

<div class="subheader">
    <div style="display: flex; align-items: center;">
        <button class="tool-btn" onclick="this.getRootNode().host.expandAllZones()">Expand All Zones</button>
        <button class="tool-btn" onclick="this.getRootNode().host.expandAll()">Expand All Assets</button>
        <button class="tool-btn" style="border-color:#1b5e20; color:#1b5e20;" onclick="this.getRootNode().host.collapseAll()">Collapse All</button>

        <div class="search-container">
            <input type="text" id="searchInput" placeholder="Search entries..." oninput="this.getRootNode().host.handleSearch(this.value)">
            <span id="matchCounter" class="match-counter">0/0</span>
            <div class="search-nav-btns">
                <button class="search-nav-btn" onclick="this.getRootNode().host.prevMatch()" title="Previous Instance">▲</button>
                <button class="search-nav-btn" onclick="this.getRootNode().host.nextMatch()" title="Next Instance">▼</button>
            </div>
        </div>
    </div>

    <div>
    <div id="ts-normal-toolbar-buttons" style="display:inline;">
    <button class="tool-btn" style="background-color: #ffffff; color: rgb(0, 0, 0); border-color: #1b5e20; margin-right: 10px;" onclick="this.getRootNode().host.fetchHierarchyData(true)">Refresh</button>
    <button id="duplicateBtn" class="tool-btn" style="background-color: #ffffff; color: #d32f2f; border-color: #d32f2f; margin-right: 10px;" onclick="this.getRootNode().host.findDuplicates()">Find Duplicates</button>
    <button id="addBtn" class="tool-btn" style="background-color: #1b5e20; color: white; border-color: #1b5e20; margin-right: 10px;" onclick="this.getRootNode().host.showAddModal()">+ Add Seals</button>
    <button id="editBtn" class="tool-btn" onclick="this.getRootNode().host.toggleEditMode()" style="margin-right: 10px;">Edit</button>

    <button id="cancelBtn" class="tool-btn" style="display:none; border-color:#757575; color:#757575; margin-right: 10px;" onclick="this.getRootNode().host.cancelEditMode()">Cancel Changes</button>

    <button id="deleteBtn" class="tool-btn" style="display:none; border-color:#d32f2f; color:#d32f2f; margin-right:10px;" onclick="this.getRootNode().host.deleteSelected()">Delete Selected</button>
    <button id="exportBtn" class="tool-btn" onclick="this.getRootNode().host.showExportOptions()">Export</button>
    </div>
    <div id="ts-layout-edit-toolbar">
        <span style="font-size:13px; color:#555; margin-right:6px;">Drag the edges of a column header to resize it.</span>
        <button class="tool-btn" style="background:#1565c0; color:white; border-color:#1565c0;" onclick="this.getRootNode().host.saveTamperSealLayout()">💾 Save Layout</button>
        <button class="tool-btn" style="border-color:#757575; color:#757575;" onclick="this.getRootNode().host.cancelTsLayoutEditMode()">Cancel</button>
    </div>
    <span id="saveIndicator">Synced</span>
</div>
</div>

<div class="header">
    <div class="header-right" id="filter-container"></div>
</div>

<div id="addModal" class="modal-overlay">
    <div class="modal-content" style="max-width: 800px;">
        <h3 id="modalTitle">Add Tamper Seals</h3>

        <div id="step-choice" style="padding: 40px; text-align: center;">
            <p style="font-size: 18px; margin-bottom: 30px;">Is this a Reinspection of broken seals?</p>
            <div style="display: flex; gap: 20px; justify-content: center;">
                <button class="tool-btn" style="padding: 15px 40px; font-size: 16px; background: #d24d4d; color: white;" onclick="this.getRootNode().host.goToStep('reinspection')">Yes (Reinspection)</button>
                <button class="tool-btn" style="padding: 15px 40px; font-size: 16px; background: #56cb35; color: white;" onclick="this.getRootNode().host.goToStep('standard')">No (New Batch)</button>
                <button class="tool-btn" style="padding: 15px 40px; font-size: 16px; border-color:#757575; color:#757575;" onclick="this.getRootNode().host.closeAddModal()">Cancel</button>
            </div>
        </div>

        <div id="step-standard" style="display: none;">
            <div class="bulk-add-grid">
                <div><label>First Seal #</label><input type="text" id="startSeal" placeholder="e.g. 1001 or A-1001"></div>
                <div><label>Last Seal #</label><input type="text" id="endSeal" placeholder="e.g. 1010 or A-1010"></div>
                <div><label>Omitted Numbers</label><input type="text" id="omittedSeals" placeholder="e.g. 1003, A-1007"></div>
                <div><label>Location / Area</label><input type="text" id="newLocation" list="location-list"></div>
                <div><label>Asset Name</label><input type="text" id="newAsset" list="asset-list"></div>
                <div><label>Sub Area</label><input type="text" id="newSubArea"></div>
                <div><label>Inspection Date</label><input type="date" id="newDate"></div>
                <div><label>Signoff (Email)</label><input type="text" id="newSignoff"></div>
                <div style="grid-column: span 2;"><label>Inspection Notes</label><input type="text" id="newNotes"></div>
            </div>
            <div class="modal-btns">
                <button class="tool-btn" style="background: #1b5e20; color: white;" onclick="this.getRootNode().host.generatePreview()">Generate Preview</button>
                <button class="tool-btn" onclick="this.getRootNode().host.showAddModal()">Back</button>
            </div>
        </div>

        <div id="step-reinspection" style="display: none; padding: 20px 50px;">
    <div style="margin-bottom: 20px;">
        <label style="color:#d32f2f; font-weight:bold; font-size:12px; text-transform:uppercase;">Select Asset with Broken Seals</label>
        <select id="brokenAssetSelect" style="width:100%; height:45px; margin-top:5px;" onchange="this.getRootNode().host.loadBrokenSealsForAsset(this.value)">
            <option value="">Loading assets...</option>
        </select>
    </div>
    <div id="brokenSealsContainer" style="margin-bottom: 20px; max-height: 200px; overflow-y: auto; border: 1px solid #ccc; padding: 10px; display:none;">
        <label style="font-weight:bold; margin-bottom:10px; display:block;">Select Seals to Replace:</label>
        <div id="sealCheckboxList"></div>
    </div>

    <div class="modal-btns" style="padding: 20px 0;">
        <button id="reinspectNextBtn" class="tool-btn" style="background: #1b5e20; color: white; display:none;" onclick="this.getRootNode().host.proceedToStandardForm()">Next</button>
        <button class="tool-btn" onclick="this.getRootNode().host.showAddModal()">Back</button>
    </div>
</div>
    </div>
</div>

<div id="exportModal" class="modal-overlay">
    <div class="modal-content">
        <h3>Export Log</h3>
        <p>Select your preferred format:</p>
        <div class="modal-btns">
            <button class="tool-btn" onclick="this.getRootNode().host.runExport('csv')">CSV (Excel)</button>
            <button class="tool-btn" style="border-color:#1976d2; color:#1976d2;" onclick="this.getRootNode().host.runExport('pdf')">PDF Report</button>
            <button class="tool-btn" style="border-color:#757575; color:#757575;" onclick="this.getRootNode().host.closeExportModal()">Cancel</button>
        </div>
    </div>
</div>

<div id="colSettingsModal" class="modal-overlay">
    <div class="modal-content" style="max-width: 960px; width: 92%;">
        <h3>Tamper Seal Settings</h3>
        <div style="display: flex; border-bottom: 1px solid #eee; margin-bottom: 16px;">
            <button id="ts-tab-columns" onclick="this.getRootNode().host.switchTsSettingsTab('columns')" style="flex:1; padding:10px; border:none; background:#f5f5f5; cursor:pointer; font-weight:600; font-size:13px; color:#2e7d32; border-bottom:3px solid #2e7d32;">Columns</button>
            <button id="ts-tab-statusflow" onclick="this.getRootNode().host.switchTsSettingsTab('statusflow')" style="flex:1; padding:10px; border:none; background:#fafafa; cursor:pointer; font-weight:600; font-size:13px; color:#888; border-bottom:3px solid transparent;">Status Flow</button>
            <button id="ts-tab-statusorder" onclick="this.getRootNode().host.switchTsSettingsTab('statusorder')" style="flex:1; padding:10px; border:none; background:#fafafa; cursor:pointer; font-weight:600; font-size:13px; color:#888; border-bottom:3px solid transparent;">Status Order</button>
        </div>

        <div id="ts-panel-columns">
            <p style="color:#666; font-size:13px; margin-top:-8px;">Drag to reorder, uncheck to hide. Saved for everyone on this project.</p>
            <div id="col-settings-list" style="display:flex; flex-direction:column; gap:8px; max-height:360px; overflow-y:auto; margin-bottom:16px;"></div>
            <div style="border-top:1px dashed #ccc; padding-top:14px;">
                <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:#999; margin-bottom:4px;">Column Widths</div>
                <p style="color:#888; font-size:12px; margin:0 0 8px;">Closes this window and lets you drag the edges of a column header on the live log to resize it.</p>
                <button class="btn btn-add" onclick="this.getRootNode().host.startColumnWidthEditing()">📐 Edit Column Widths</button>
            </div>
        </div>

        <div id="ts-panel-statusflow" style="display:none;">
            <p style="color:#666; font-size:13px; margin-top:-8px;">Define the seal statuses, then build the triggers that move a seal between them — each trigger can require any of several previous statuses and optionally fire automatically when a specific form is submitted.</p>
            <div id="workflow-selector-wrap" style="display:flex; gap:8px; margin-bottom:14px;"></div>
            <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:#999; margin-bottom:8px;">Statuses</div>
            <div id="status-flow-editor" style="max-height:220px; overflow-y:auto; margin-bottom:12px; display:flex; flex-direction:column; gap:10px;"></div>
            <div style="position:relative; display:inline-block; margin-bottom:16px;">
                <button id="add-status-menu-btn" class="btn btn-add" onclick="this.getRootNode().host.toggleAddStatusMenu()">+ Add Status ▾</button>
                <div id="add-status-menu" style="display:none; position:absolute; top:100%; left:0; margin-top:4px; background:white; border:1px solid #ddd; border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,0.15); z-index:50; min-width:240px; max-height:260px; overflow-y:auto;"></div>
            </div>

            <div style="border-top:1px dashed #ccc; padding-top:14px;">
                <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:#999; margin-bottom:8px;">Triggers</div>
                <div id="triggers-list" style="max-height:280px; overflow-y:auto; margin-bottom:12px;"></div>
                <button class="btn btn-add" onclick="this.getRootNode().host.addTrigger()">+ Add Trigger</button>
            </div>

            <div style="margin-top:16px; border-top:1px dashed #ccc; padding-top:14px;">
                <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:#999; margin-bottom:4px;">Reinspection Eligibility</div>
                <p style="color:#888; font-size:12px; margin:0 0 8px;">Which statuses should make a seal show up on the field Reinspection form. This is separate from Triggers — it only controls which seals appear, not what they transition to.</p>
                <div id="reinspection-filter-list" style="max-height:200px; overflow-y:auto;"></div>
            </div>

            <div style="margin-top:16px; border-top:1px dashed #ccc; padding-top:14px;">
                <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:#999; margin-bottom:4px;">Break Request Eligibility</div>
                <p style="color:#888; font-size:12px; margin:0 0 8px;">Which statuses should show up when filtering seals on the field Break Request form. Checking a status here shows it even without a matching Trigger below (flagged with a warning) — submitting will just report that seal as not moved. Until you check/uncheck anything here, every status is shown, matching current behavior.</p>
                <div id="break-request-filter-list" style="max-height:200px; overflow-y:auto;"></div>
            </div>

            <div style="margin-top:16px; border-top:1px dashed #ccc; padding-top:14px;">
                <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:#999; margin-bottom:4px;">Break Seals Eligibility</div>
                <p style="color:#888; font-size:12px; margin:0 0 8px;">Which statuses should show up when filtering seals on the field Break Seals form.</p>
                <div id="break-seals-filter-list" style="max-height:200px; overflow-y:auto;"></div>
            </div>

            <div style="margin-top:16px; border-top:1px dashed #ccc; padding-top:14px;">
                <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:#999; margin-bottom:4px;">Work Completed Eligibility</div>
                <p style="color:#888; font-size:12px; margin:0 0 8px;">Which statuses should show up when filtering seals on the field Work Completed form.</p>
                <div id="work-completed-filter-list" style="max-height:200px; overflow-y:auto;"></div>
            </div>

            <div style="margin-top:16px; border-top:1px dashed #ccc; padding-top:14px;">
                <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:#999; margin-bottom:8px;">Preview</div>
                <div id="status-flow-preview" style="position:relative; background:#fafafa; border:1px solid #eee; border-radius:8px; padding:24px; min-height:100px; overflow:visible;"></div>
            </div>
        </div>

        <div id="ts-panel-statusorder" style="display:none;">
            <p style="color:#666; font-size:13px; margin-top:-8px;">Drag to reorder — this controls the order statuses appear everywhere: the status filter bar, dropdown menus, and trigger checklists.</p>
            <div id="status-order-list" style="display:flex; flex-direction:column; gap:8px; max-height:400px; overflow-y:auto;"></div>
        </div>

        <div class="modal-btns">
            <button class="tool-btn" style="background-color:#1b5e20; color:white; border-color:#1b5e20;" onclick="this.getRootNode().host.saveTsSettings()">Save</button>
            <button class="tool-btn" style="border-color:#757575; color:#757575;" onclick="this.getRootNode().host.closeColumnSettingsModal()">Cancel</button>
        </div>
    </div>
</div>

<div class="frozen-bar">
    <div class="frozen-grid">
        <div class="edit-header-cell" data-col="checkbox"></div>
        <div class="edit-only-header" data-col="assetName">Asset Name</div>
        <div class="edit-only-header" data-col="location">Location</div>
        <div class="header-cell" data-col="subArea">Sub Area</div>
        <div class="header-cell" data-col="sealNumber">Seal #</div>
        <div class="header-cell" data-col="inspectionDate">Inspection Date</div>
        <div class="header-cell" data-col="signoff">Signoff</div>
        <div class="header-cell" data-col="inspectionNotes">Inspection Notes</div>
        <div class="header-cell" data-col="status">Status</div>
        <div class="header-cell" data-col="breakDate">Break Date</div>
        <div class="header-cell" data-col="responsibleParty">Responsible Party</div>
        <div class="header-cell" data-col="breakReason">Break Reason</div>
    </div>
</div>

<div id="main-content-area">
    </div>

`;

export class TamperSealView extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });

        this.PROJECT_KEY = '';
        this.USER_ROLE = 'editor';
        this.USER_EMAIL = '';
        this.TS_SCRIPT_URL = '';
        this.canEditTamperSeals = false;
        this.canManageColumns = false;

        this.columnConfig = defaultColumnConfig.map(c => ({ ...c }));

        // The seal status progression(s) -- see makeDefaultWorkflow() above.
        // Multiple workflows can be defined; exactly one is "active" at a
        // time, and its statuses are what actually populate every row's
        // status dropdown across the whole log.
        this.workflows = [makeDefaultWorkflow()];
        this.currentEditingWorkflowId = this.workflows[0].id;
        // Display order for statuses, spanning ALL workflows (not just the
        // one currently being edited) -- controls order in the status
        // filter bar, dropdowns, and trigger checklists. Stored as
        // lowercased names since a status is identified by name once
        // aggregated across workflows.
        this.globalStatusOrder = [];
        // Explicit admin-curated list of which statuses make a seal
        // eligible for the Reinspection form -- independent of any
        // configured trigger, so it's not tied to fuzzy substring-matching
        // against trigger "from" names.
        this.reinspectionFilterStatuses = [];
        // Same idea as reinspectionFilterStatuses, but for the three main
        // seal-form.html sections. null (not []) means "never configured"
        // -- treated as "no restriction, every status that already passes
        // the trigger check is shown" so this feature can't silently break
        // every live form the moment it ships, before anyone's had a
        // chance to visit Setup Config and actually opt into restricting
        // anything. Once an admin touches a checkbox for a section, it
        // becomes a real array (which can legitimately end up empty if
        // they uncheck everything).
        this.breakRequestFilterStatuses = null;
        this.breakSealsFilterStatuses = null;
        this.workCompletedFilterStatuses = null;
        // Closures capture `this` (the element instance) instead of module-
        // scoped variables the way tamperseal.html's original top-level
        // SECTION_FILTER_META did, since each of these is now per-instance
        // state rather than a single shared module global.
        this.SECTION_FILTER_META = {
            'break-request': { get: () => this.breakRequestFilterStatuses, set: (v) => this.breakRequestFilterStatuses = v, containerId: 'break-request-filter-list', label: 'Break Request' },
            'break-seals': { get: () => this.breakSealsFilterStatuses, set: (v) => this.breakSealsFilterStatuses = v, containerId: 'break-seals-filter-list', label: 'Break Seals' },
            'work-completed': { get: () => this.workCompletedFilterStatuses, set: (v) => this.workCompletedFilterStatuses = v, containerId: 'work-completed-filter-list', label: 'Work Completed' }
        };

        this.allHierarchyRecords = [];
        this.localEdits = {}; // unsaved changes, keyed by row id
        this.lookupData = { assets: [], locations: [] };
        this.activeFilters = {
            locations: new Set(['All']),
            statuses: new Set(['All']),
            search: ''
        };

        this.isPreviewMode = false;
        this.isEditMode = false;
        this.isReinspectionMode = false;
        this.selectedBrokenSeals = [];
        this.selectedBrokenSealIds = []; // database IDs of seals being replaced via Reinspection
        this.duplicateSealList = null;
        this.matchElements = [];
        this.currentMatchIndex = -1;
        this.tsLayoutConfigSnapshot = null;

        this._realtimeChannel = null;
        this.__syncHeaderWidthResizeTimer = null;
        // Percentage-based widths shift on resize -- keep the header locked
        // to the actual asset rows' width as the window changes, not just
        // at load time. Bound once here so connectedCallback/
        // disconnectedCallback can add/remove the exact same reference.
        this._onResize = () => {
            clearTimeout(this.__syncHeaderWidthResizeTimer);
            this.__syncHeaderWidthResizeTimer = setTimeout(() => this.syncHeaderWidthToAssetRows(), 100);
        };
    }

    connectedCallback() {
        if (this._mounted) return; // re-entrant connect (e.g. node moved) shouldn't re-init
        this._mounted = true;
        this._resolveParams();
        this.shadowRoot.innerHTML = STYLE + MARKUP;
        this._initSupabase();
        // Previously had no dark-mode support at all — index.html's
        // toggleDarkMode() only ever reached this view via postMessage to an
        // <iframe>, which stopped existing once this became a custom
        // element. Read the same shared preference the other views do, so a
        // fresh mount starts in the right theme.
        if (localStorage.getItem('launchpad_dark_mode') === 'enabled') this.classList.add('dark-mode');
        window.addEventListener('resize', this._onResize);
        this.init();
    }

    disconnectedCallback() {
        window.removeEventListener('resize', this._onResize);
        clearTimeout(this.__syncHeaderWidthResizeTimer);
        // Otherwise remounting this element (switching tabs and back in the
        // shell) would pile up duplicate Realtime subscriptions -- exactly
        // the kind of per-mount overhead this whole migration exists to cut.
        if (this._realtimeChannel) {
            this._supabase.removeChannel(this._realtimeChannel);
            this._realtimeChannel = null;
        }
    }

    _resolveParams() {
        const qp = new URLSearchParams(window.location.search);
        // The project prefix, passed in via ?project=XXX by the LaunchPad
        // shell (index.html). Falls back to the prefix this file was
        // originally built for, so it still works if opened directly
        // without a project param.
        this.PROJECT_KEY = this.getAttribute('project') || qp.get('project') || 'STY4';
        // The current user's role/email, passed in by the LaunchPad shell.
        // Defaults to editor/no-email so this still behaves reasonably if
        // opened directly during local development.
        this.USER_ROLE = this.getAttribute('role') || qp.get('role') || 'editor';
        this.USER_EMAIL = (this.getAttribute('email') || qp.get('email') || '').toLowerCase();
        // The project's own Apps Script URL, passed in by the LaunchPad
        // shell. No longer used for this file's own settings (those moved
        // to Supabase -- see loadColumnConfig()/saveTsSettings() below)
        // but kept here in case a future feature needs the Apps Script
        // backend directly.
        this.TS_SCRIPT_URL = this.getAttribute('script-url') || qp.get('scriptUrl') || '';

        // Tamper Seal editing is intentionally stricter than the general
        // per-project role system: it doesn't matter if someone is an
        // "editor" on the project overall -- actually logging/editing
        // seals is CriticalArc-staff-only.
        this.canEditTamperSeals = (this.USER_ROLE === 'editor' || this.USER_ROLE === 'admin') && this.USER_EMAIL.endsWith('@criticalarccx.com');
        // Column layout is a shared, project-wide setting (like Equipment
        // Tracker's Setup Config) -- not a personal per-browser preference
        // -- so only admins can change it, but everyone sees the result.
        this.canManageColumns = this.USER_ROLE === 'admin';
    }

    _initSupabase() {
        const injected = this.supabaseClient || window.launchpadSupabaseClient;
        this._supabase = injected || window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }

    // Shadow-scoped DOM helpers -- replace the old document.getElementById /
    // document.querySelectorAll so lookups can't collide with the shell's
    // own ids or the other views' shadow trees.
    $(id) { return this.shadowRoot.getElementById(id); }
    $$(sel) { return this.shadowRoot.querySelectorAll(sel); }

    T(tableName) { return `${this.PROJECT_KEY}${tableName}`; }

    // Public alias matching the other views' openSettings() API -- the
    // shell calls this instead of posting an OPEN_SETTINGS message now.
    // Preserves the original canManageColumns gate that used to live
    // inside the postMessage handler.
    openSettings() {
        if (this.canManageColumns) this.openColumnSettingsModal();
    }

    // index.html's toggleDarkMode() calls this directly (same pattern as
    // equipment-tracker-view.js's/bridge-view.js's own setDarkMode()) since
    // a custom element isn't reachable via the iframe postMessage broadcast
    // it also sends.
    setDarkMode(isDark) {
        this.classList.toggle('dark-mode', !!isDark);
    }


    getActiveWorkflows() {
        const active = this.workflows.filter(w => w.active);
        return active.length > 0 ? active : [this.workflows[0]];
    }
    // Looks up what a seal currently in `currentStatusName` should become when
    // the Reinspection modal's replacement is confirmed — based on whatever
    // trigger(s) are configured with "Triggered By: Reinspection". Only
    // active workflows count, matching exactly what seal-form.html's own
    // transition lookup considers.
    getReinspectionNextStatus(currentStatusName) {
        const current = (currentStatusName || '').toLowerCase().trim();
        for (const w of this.getActiveWorkflows()) {
            for (const t of w.transitions) {
                if (t.formTrigger !== 'reinspection') continue;
                const matches = t.from.some(fromId => {
                    const s = w.statuses.find(x => x.id === fromId);
                    return s && s.name.toLowerCase() === current;
                });
                if (matches) {
                    const toStatus = w.statuses.find(x => x.id === t.to);
                    if (toStatus) return toStatus.name;
                }
            }
        }
        return null;
    }
    // Aggregated, deduplicated-by-name statuses across every active workflow —
    // this is what actually drives the real per-row status dropdown and the
    // status filter bar, now that more than one workflow can be active at once.
    // Sorted by globalStatusOrder when available; anything not yet placed in
    // that order (e.g. freshly-added statuses) falls in after everything that
    // is, in whatever order it was otherwise encountered.
    getActiveStatuses() {
        const seen = new Set();
        const result = [];
        this.getActiveWorkflows().forEach(w => {
            w.statuses.forEach(s => {
                const key = s.name.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    result.push(s);
                }
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
    // Same aggregation as getActiveStatuses(), but across ALL workflows
    // (active or not) — used by the Status Order settings tab, since an admin
    // should be able to arrange a workflow's status order even before
    // activating it.
    getAllUniqueStatusesAcrossWorkflows() {
        const seen = new Set();
        const result = [];
        this.workflows.forEach(w => {
            w.statuses.forEach(s => {
                const key = s.name.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    result.push(s);
                }
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


    // Singular — used only for UI defaulting (which workflow the Settings
    // editor opens to first), not for anything that determines real behavior.
    getActiveWorkflow() {
        return this.getActiveWorkflows()[0];
    }
    getEditingWorkflow() {
        return this.workflows.find(w => w.id === this.currentEditingWorkflowId) || this.workflows[0];
    }


    // ===== COLUMN SETTINGS (show/hide, reorder, and now width — saved to
    // Supabase, same as the rest of this file's settings) =====
    // Both order and visibility are applied via one dynamically-generated
    // stylesheet keyed off each cell's data-col attribute, rather than
    // reordering the actual DOM — the table is already display:flex for both
    // the header and every row, so CSS `order` reorders columns uniformly
    // across all of them at once without touching the row-rendering logic.
    // ===== QR CODE GENERATION =====
    // Builds the single field-facing form link for this project (the form
    // itself now handles picking an action and searching for seals, so one
    // QR code per site is all that's needed — no per-asset or per-section
    // codes). Rendered via a free QR image API, no client-side library needed.
    // The base URL is editable and remembered per-browser, since seal-form.html's
    // actual hosted location isn't something this file can know on its own.
    // ===== QR CODE GENERATION =====
    // Now lives in the main LaunchPad app's "Seal Form" tab instead of here —
    // keeps the field-facing form's own generation logic in one place, next
    // to the in-app preview of that same form.

    async loadColumnConfig() {
        try {
            const { data: row, error } = await this._supabase
                .from('launchpad_tamperseal_config')
                .select('config')
                .eq('project_key', this.PROJECT_KEY)
                .maybeSingle();
            if (error) throw error;
            const data = row && row.config;
            if (data && Array.isArray(data.columnConfig) && data.columnConfig.length > 0) {
                // Merge with defaults so a column added to the app later (or
                // one missing from an older save) doesn't just disappear.
                const savedIds = data.columnConfig.map(c => c.id);
                const merged = data.columnConfig.map(saved => {
                    const def = defaultColumnConfig.find(d => d.id === saved.id);
                    return { ...(def || {}), ...saved };
                });
                defaultColumnConfig.forEach(def => {
                    if (!savedIds.includes(def.id)) merged.push({ ...def });
                });
                this.columnConfig = merged;
            }
            if (data && Array.isArray(data.workflows) && data.workflows.length > 0) {
                // Current format — an array of named workflows.
                this.workflows = data.workflows;
                if (!this.workflows.some(w => w.active)) this.workflows[0].active = true;
            } else if (data && data.statusFlow && Array.isArray(data.statusFlow.statuses)) {
                // Migrate an older save (a single flat statusFlow, before
                // multiple workflows existed) into the new structure.
                this.workflows = [{
                    id: 'default',
                    name: 'Default Workflow',
                    active: true,
                    statuses: data.statusFlow.statuses,
                    transitions: data.statusFlow.transitions || []
                }];
            }
            // Normalize every transition to the current shape — needed for any
            // save made before triggers supported multiple previous statuses,
            // where "from" was a single id instead of an array, and before
            // transitions had their own id at all.
            this.workflows.forEach(w => {
                w.transitions = (w.transitions || []).map((t, i) => ({
                    id: t.id || ('trigger_' + w.id + '_' + i),
                    from: Array.isArray(t.from) ? t.from : [t.from],
                    to: t.to,
                    formTrigger: t.formTrigger || ''
                }));
            });
            if (Array.isArray(data.globalStatusOrder)) this.globalStatusOrder = data.globalStatusOrder;
            if (Array.isArray(data.reinspectionFilterStatuses)) this.reinspectionFilterStatuses = data.reinspectionFilterStatuses;
            if (Array.isArray(data.breakRequestFilterStatuses)) this.breakRequestFilterStatuses = data.breakRequestFilterStatuses;
            if (Array.isArray(data.breakSealsFilterStatuses)) this.breakSealsFilterStatuses = data.breakSealsFilterStatuses;
            if (Array.isArray(data.workCompletedFilterStatuses)) this.workCompletedFilterStatuses = data.workCompletedFilterStatuses;
            this.currentEditingWorkflowId = this.getActiveWorkflow().id;
        } catch (e) {
            console.warn('Could not load column settings, using defaults:', e);
        }
        this.applyColumnConfig();
    }

    applyColumnConfig() {
        let styleEl = this.$('column-config-style');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'column-config-style';
            this.shadowRoot.appendChild(styleEl);
        }
        let css = '';
        this.columnConfig.forEach((col, index) => {
            css += `[data-col="${col.id}"] { order: ${index}; }\n`;
            if (!col.visible) css += `[data-col="${col.id}"] { display: none !important; }\n`;
            // Only columns that have actually been resized get an explicit
            // width — everything else keeps behaving exactly as it always has
            // (equal flex:1 sizing) until someone drags it via Edit Layout.
            // `flex: weight 1 0%` — a proportional GROWTH WEIGHT with
            // flex-basis:0%, exactly like the Schedule's own column resizing
            // in index.html — not a fixed percentage or pixel width. With
            // flex-basis:0%, each container (the header vs. any given data
            // row) independently distributes 100% of ITS OWN available space
            // according to these weight ratios, so it doesn't matter if
            // .frozen-grid and .cell-row ever end up a few pixels different
            // in actual rendered width — the two earlier approaches (percent-
            // of-container, then fixed pixels) both assumed they were exactly
            // equal, which is what kept drifting.
            if (col.width) css += `[data-col="${col.id}"] { flex: ${col.width} 1 0% !important; width: auto !important; max-width: none !important; min-width: 40px !important; }\n`;
        });
        styleEl.innerHTML = css;
    }

    // ===== COLUMN LAYOUT RESIZING (widths saved to Supabase, same as the
    // Schedule's Edit Layout feature in index.html) =====

    // Entry point lives in Setup Config > Columns (not the main toolbar) —
    // resizing happens by dragging directly on the live log though, so this
    // closes the settings modal out of the way first.
    startColumnWidthEditing() {
        this.closeColumnSettingsModal();
        this.enterTsLayoutEditMode();
    }

    enterTsLayoutEditMode() {
        // Snapshot so Cancel can restore exactly what was on screen before —
        // deep copy since columnConfig objects get mutated in place while dragging.
        this.tsLayoutConfigSnapshot = JSON.parse(JSON.stringify(this.columnConfig));
        this.classList.add('ts-layout-edit-mode');
        this.initTsColumnResizers();
        // The toolbar swaps to Save/Cancel here, which can shift the overall
        // page width slightly (e.g. a scrollbar appearing/disappearing) —
        // resync after the browser's had a moment to actually reflow.
        setTimeout(syncHeaderWidthToAssetRows, 50);
    }

    cancelTsLayoutEditMode() {
        if (this.tsLayoutConfigSnapshot) {
            this.columnConfig = this.tsLayoutConfigSnapshot;
            this.applyColumnConfig();
        }
        this.classList.remove('ts-layout-edit-mode');
    }

    async saveTamperSealLayout() {
        const btn = this.shadowRoot.querySelector('#ts-layout-edit-toolbar button:nth-child(2)');
        if (btn) { btn.innerText = 'Saving...'; btn.disabled = true; }
        try {
            const { error } = await this._supabase.from('launchpad_tamperseal_config').upsert({
                project_key: this.PROJECT_KEY,
                config: {
                    columnConfig: this.columnConfig,
                    workflows: this.workflows,
                    globalStatusOrder: this.globalStatusOrder,
                    reinspectionFilterStatuses: this.reinspectionFilterStatuses,
                    breakRequestFilterStatuses: this.breakRequestFilterStatuses,
                    breakSealsFilterStatuses: this.breakSealsFilterStatuses,
                    workCompletedFilterStatuses: this.workCompletedFilterStatuses
                },
                updated_by: this.USER_EMAIL || null
            }, { onConflict: 'project_key' });
            if (error) throw error;
            this.classList.remove('ts-layout-edit-mode');
        } catch (e) {
            alert('There was an issue saving the layout: ' + e.message);
            if (btn) { btn.innerText = '💾 Save Layout'; btn.disabled = false; }
        }
    }

    // Sets up one resize handle per (non-checkbox) header cell, appended as a
    // child positioned at that cell's right edge. Idempotent — safe to call
    // every time edit mode is entered, since the header row is static HTML
    // that never gets rebuilt (unlike the schedule's rows, this doesn't need
    // re-running after every render).
    // Handles are attached to .frozen-grid itself, positioned by computed
    // pixel coordinates — NOT nested inside the header cell they control.
    // The earlier version put each handle inside its own column, which meant
    // a column that had shrunk very small dragged its own handle down to an
    // equally tiny, barely-clickable sliver along with it. A handle anchored
    // to the grid is always a full, fixed-size, independently-clickable
    // target no matter how narrow either neighboring column gets — and since
    // positions are recalculated after every drag movement (repositionTsColumnResizers),
    // they stay lined up with the current column boundaries as things resize.
    initTsColumnResizers() {
        const grid = this.shadowRoot.querySelector('.frozen-grid');
        if (!grid) return;
        grid.style.position = 'relative';
        grid.querySelectorAll('.ts-col-resizer').forEach(h => h.remove());

        // Only currently-visible columns get a handle at all — Asset Name/
        // Location are display:none outside row-edit mode, and a handle
        // created for a hidden column has no reliable reason to stay out of
        // the way of the genuinely visible columns around it. This is also
        // exactly why the leftmost VISIBLE column (normally "Sub Area") could
        // fail to resize — a handle for the hidden "Location" column right
        // before it existed in the DOM even though nobody could see or click
        // it directly, and was only hidden reactively (by repositionTsColumnResizers,
        // after the fact) rather than never created in the first place.
        const headerCells = Array.from(grid.querySelectorAll('[data-col]'))
            .filter(el => el.dataset.col !== 'checkbox' && el.offsetParent !== null);

        headerCells.forEach((cell, i) => {
            if (i === headerCells.length - 1) return; // last column has nothing to its right
            const handle = document.createElement('div');
            handle.className = 'ts-col-resizer';
            handle.dataset.col = cell.dataset.col;
            grid.appendChild(handle);

            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const colId = cell.dataset.col;

                // Which column is actually next to this one, by CURRENT visual
                // order (CSS `order`, set by applyColumnConfig()) — not static
                // HTML position, since columns can be reordered independently
                // via the Column Settings drag-and-drop list. Only columns
                // actually rendered right now (offsetParent !== null excludes
                // anything display:none, like Asset Name/Location outside row
                // edit mode) count as a real neighbor to resize against.
                const visibleCells = headerCells.filter(c => c.offsetParent !== null);
                const visibleIds = visibleCells.map(c => c.dataset.col);
                const myIndex = visibleIds.indexOf(colId);
                const nextId = visibleIds[myIndex + 1];
                if (!nextId) return; // last visible column has nothing to its right

                const col1 = this.columnConfig.find(c => c.id === colId);
                const col2 = this.columnConfig.find(c => c.id === nextId);

                // First-ever resize: neither column has an explicit weight yet
                // (both still just flex:1) — seed both from the HEADER's
                // actual current rendered pixel width, so the drag adjusts
                // from what's already on screen instead of jumping to some
                // arbitrary default. These become flex-grow WEIGHTS going
                // forward (see applyColumnConfig()), not literal pixel sizes —
                // starting them at their current pixel width just gives a
                // sensible, correctly-proportioned starting scale; nothing
                // about their absolute value matters afterward, only their
                // ratio to each other.
                if (!col1.width || !col2.width) {
                    const nextCell = grid.querySelector(`[data-col="${nextId}"]`);
                    col1.width = cell.getBoundingClientRect().width;
                    col2.width = nextCell.getBoundingClientRect().width;
                }

                const startX = e.clientX;
                const origWidth1 = col1.width;
                const origWidth2 = col2.width;
                handle.classList.add('ts-active-drag');

                const onMouseMove = (e2) => {
                    // Adjusting the weight by the raw pixel delta (rather than
                    // converting to a percentage first) is intentional — since
                    // both weights were seeded from real pixel widths above,
                    // this keeps drag sensitivity feeling 1:1 with the mouse
                    // without needing to know the grid's total flexible width.
                    const deltaPx = e2.clientX - startX;
                    const minWeight = 40; // matches the min-width floor in this.applyColumnConfig()
                    let newWidth1 = origWidth1 + deltaPx;
                    let newWidth2 = origWidth2 - deltaPx;
                    if (newWidth1 < minWeight) { newWidth2 -= (minWeight - newWidth1); newWidth1 = minWeight; }
                    if (newWidth2 < minWeight) { newWidth1 -= (minWeight - newWidth2); newWidth2 = minWeight; }
                    col1.width = newWidth1;
                    col2.width = newWidth2;
                    this.applyColumnConfig();
                    this.repositionTsColumnResizers();
                };

                const onMouseUp = () => {
                    handle.classList.remove('ts-active-drag');
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                };

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        });

        this.repositionTsColumnResizers();
    }

    // Moves every handle to sit at the right edge of the header cell it
    // controls, based on current actual rendered positions — called once at
    // setup and again after every drag movement, since resizing shifts every
    // column to its right.
    repositionTsColumnResizers() {
        const grid = this.shadowRoot.querySelector('.frozen-grid');
        if (!grid) return;
        const gridRect = grid.getBoundingClientRect();

        grid.querySelectorAll('.ts-col-resizer').forEach(handle => {
            const cell = grid.querySelector(`[data-col="${handle.dataset.col}"]`);
            if (!cell || cell.offsetParent === null) { handle.style.display = 'none'; return; }
            handle.style.display = '';
            const cellRect = cell.getBoundingClientRect();
            handle.style.left = (cellRect.right - gridRect.left - 5) + 'px';
        });
    }

    openColumnSettingsModal() {
        this.renderColumnSettingsList();
        this.currentEditingWorkflowId = this.getActiveWorkflow().id;
        this.renderWorkflowSelector();
        this.renderStatusFlowEditor();
        this.switchTsSettingsTab('columns');
        this.$('colSettingsModal').style.display = 'flex';
    }

    switchTsSettingsTab(tab) {
        const colTab = this.$('ts-tab-columns');
        const flowTab = this.$('ts-tab-statusflow');
        const orderTab = this.$('ts-tab-statusorder');
        const colPanel = this.$('ts-panel-columns');
        const flowPanel = this.$('ts-panel-statusflow');
        const orderPanel = this.$('ts-panel-statusorder');
        const active = 'flex:1; padding:10px; border:none; background:#f5f5f5; cursor:pointer; font-weight:600; font-size:13px; color:#2e7d32; border-bottom:3px solid #2e7d32;';
        const inactive = 'flex:1; padding:10px; border:none; background:#fafafa; cursor:pointer; font-weight:600; font-size:13px; color:#888; border-bottom:3px solid transparent;';

        [colTab, flowTab, orderTab].forEach(t => t.style.cssText = inactive);
        [colPanel, flowPanel, orderPanel].forEach(p => p.style.display = 'none');

        if (tab === 'columns') {
            colTab.style.cssText = active;
            colPanel.style.display = 'block';
        } else if (tab === 'statusorder') {
            orderTab.style.cssText = active;
            orderPanel.style.display = 'block';
            this.renderStatusOrderList();
        } else {
            flowTab.style.cssText = active;
            flowPanel.style.display = 'block';
            this.renderStatusFlowPreview();
        }
    }

    // Same drag-and-drop reorder pattern as the Columns tab, applied to every
    // status across every workflow combined — not just the one currently
    // being edited, since the display order (filter bar, dropdowns, trigger
    // checklists) is shared across all of them.
    renderStatusOrderList() {
        // Seed globalStatusOrder from whatever order things are already in,
        // the first time this is opened (or if nothing's been saved yet) —
        // gives drag-and-drop a concrete starting order to manipulate.
        if (this.globalStatusOrder.length === 0) {
            this.globalStatusOrder = this.getAllUniqueStatusesAcrossWorkflows().map(s => s.name.toLowerCase());
        }

        const allStatuses = this.getAllUniqueStatusesAcrossWorkflows();
        const list = this.$('status-order-list');
        list.innerHTML = '';
        allStatuses.forEach((s) => {
            const key = s.name.toLowerCase();
            const isFirst = allStatuses.indexOf(s) === 0;
            const isLast = allStatuses.indexOf(s) === allStatuses.length - 1;

            const item = document.createElement('div');
            item.style.cssText = "display:flex; align-items:center; width:100%; padding:10px 12px; background:#f8f9fa; border:1px solid #ddd; border-radius:6px; cursor:grab; user-select:none; box-sizing:border-box;";
            item.draggable = true;
            item.dataset.statusKey = key;

            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', key);
                item.style.opacity = '0.5';
            });
            item.addEventListener('dragend', () => {
                item.style.opacity = '1';
                this.$$('#status-order-list > div').forEach(el => el.style.border = '1px solid #ddd');
            });
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                item.style.border = '2px dashed #2e7d32';
            });
            item.addEventListener('dragleave', () => {
                item.style.border = '1px solid #ddd';
            });
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                const draggedKey = e.dataTransfer.getData('text/plain');
                const draggedIndex = this.globalStatusOrder.indexOf(draggedKey);
                const targetIndex = this.globalStatusOrder.indexOf(key);
                if (draggedIndex === -1 || targetIndex === -1 || draggedIndex === targetIndex) return;
                const draggedItem = this.globalStatusOrder.splice(draggedIndex, 1)[0];
                this.globalStatusOrder.splice(targetIndex, 0, draggedItem);
                this.renderStatusOrderList();
            });

            item.innerHTML = `
                <span style="margin-right:10px; cursor:grab; color:#999; font-size:16px;" title="Drag to reorder">⣿</span>
                <div style="display:flex; flex-direction:column; margin-right:10px;">
                    <button onclick="this.getRootNode().host.moveGlobalStatusOrder('${key}', -1)" ${isFirst ? 'disabled' : ''} title="Move up" style="background:none; border:none; cursor:${isFirst ? 'default' : 'pointer'}; color:${isFirst ? '#ccc' : '#555'}; font-size:12px; line-height:1; padding:2px;">▲</button>
                    <button onclick="this.getRootNode().host.moveGlobalStatusOrder('${key}', 1)" ${isLast ? 'disabled' : ''} title="Move down" style="background:none; border:none; cursor:${isLast ? 'default' : 'pointer'}; color:${isLast ? '#ccc' : '#555'}; font-size:12px; line-height:1; padding:2px;">▼</button>
                </div>
                <span style="width:16px; height:16px; border-radius:3px; background:${s.color}; border:1px solid rgba(0,0,0,0.15); margin-right:10px; flex-shrink:0;"></span>
                <span style="font-weight:600; color:#333; font-size:14px;">${s.name}</span>
            `;
            list.appendChild(item);
        });
    }

    moveGlobalStatusOrder(key, direction) {
        const index = this.globalStatusOrder.indexOf(key);
        const newIndex = index + direction;
        if (newIndex < 0 || newIndex >= this.globalStatusOrder.length) return;
        [this.globalStatusOrder[index], this.globalStatusOrder[newIndex]] = [this.globalStatusOrder[newIndex], this.globalStatusOrder[index]];
        this.renderStatusOrderList();
    }

    renderColumnSettingsList() {
        const list = this.$('col-settings-list');
        list.innerHTML = '';
        const visibleCols = this.columnConfig.filter(c => !c.locked);
        visibleCols.forEach((col) => {
            const isFirst = visibleCols.indexOf(col) === 0;
            const isLast = visibleCols.indexOf(col) === visibleCols.length - 1;

            const item = document.createElement('div');
            item.style.cssText = "display:flex; align-items:center; width:100%; padding:10px 12px; background:#f8f9fa; border:1px solid #ddd; border-radius:6px; cursor:grab; user-select:none; box-sizing:border-box;";
            item.draggable = true;
            item.dataset.colId = col.id;

            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', col.id);
                item.style.opacity = '0.5';
            });
            item.addEventListener('dragend', () => {
                item.style.opacity = '1';
                this.$$('#col-settings-list > div').forEach(el => el.style.border = '1px solid #ddd');
            });
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                item.style.border = '2px dashed #2e7d32';
            });
            item.addEventListener('dragleave', () => {
                item.style.border = '1px solid #ddd';
            });
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                const draggedId = e.dataTransfer.getData('text/plain');
                const draggedIndex = this.columnConfig.findIndex(c => c.id === draggedId);
                const targetIndex = this.columnConfig.findIndex(c => c.id === col.id);
                if (draggedIndex === -1 || targetIndex === -1 || draggedIndex === targetIndex) return;
                const draggedItem = this.columnConfig.splice(draggedIndex, 1)[0];
                this.columnConfig.splice(targetIndex, 0, draggedItem);
                this.renderColumnSettingsList();
            });

            item.innerHTML = `
                <span style="margin-right:10px; cursor:grab; color:#999; font-size:16px;" title="Drag to reorder">⣿</span>
                <div style="display:flex; flex-direction:column; margin-right:10px;">
                    <button onclick="this.getRootNode().host.moveColumnConfig('${col.id}', -1)" ${isFirst ? 'disabled' : ''} title="Move up" style="background:none; border:none; cursor:${isFirst ? 'default' : 'pointer'}; color:${isFirst ? '#ccc' : '#555'}; font-size:12px; line-height:1; padding:2px;">▲</button>
                    <button onclick="this.getRootNode().host.moveColumnConfig('${col.id}', 1)" ${isLast ? 'disabled' : ''} title="Move down" style="background:none; border:none; cursor:${isLast ? 'default' : 'pointer'}; color:${isLast ? '#ccc' : '#555'}; font-size:12px; line-height:1; padding:2px;">▼</button>
                </div>
                <input type="checkbox" id="colcfg-${col.id}" ${col.visible ? 'checked' : ''} style="margin-right:12px; cursor:pointer; transform:scale(1.2);" onchange="this.getRootNode().host.columnConfig.find(c => c.id === '${col.id}').visible = this.checked;">
                <span style="font-weight:600; color:#333; font-size:14px;">${col.name}</span>
            `;
            list.appendChild(item);
        });
    }

    moveColumnConfig(id, direction) {
        const index = this.columnConfig.findIndex(c => c.id === id);
        const newIndex = index + direction;
        if (newIndex < 0 || newIndex >= this.columnConfig.length) return;
        if (this.columnConfig[newIndex].locked) return;
        [this.columnConfig[index], this.columnConfig[newIndex]] = [this.columnConfig[newIndex], this.columnConfig[index]];
        this.renderColumnSettingsList();
    }

    // ===== STATUS FLOW (definitions + branching progression, visualized top to
    // bottom with arrows) =====
    renderWorkflowSelector() {
        const wrap = this.$('workflow-selector-wrap');
        const wf = this.getEditingWorkflow();
        wrap.innerHTML = `
            <select id="workflow-select" onchange="this.getRootNode().host.currentEditingWorkflowId = this.value; this.getRootNode().host.renderStatusFlowEditor(); this.getRootNode().host.renderStatusFlowPreview();" style="padding:8px 10px; border:1px solid #ddd; border-radius:6px; font-weight:600; font-size:14px; flex:1;">
                ${this.workflows.map(w => `<option value="${w.id}" ${w.id === wf.id ? 'selected' : ''}>${w.name}${w.active ? ' ✓ Active' : ''}</option>`).join('')}
            </select>
            <button class="tool-btn" style="padding:8px 12px; font-size:13px;" onclick="this.getRootNode().host.addWorkflow()">+ New</button>
            <button class="tool-btn" style="padding:8px 12px; font-size:13px;" onclick="this.getRootNode().host.renameWorkflow()">Rename</button>
            <button class="tool-btn" style="padding:8px 12px; font-size:13px; ${wf.active ? 'background-color:#1b5e20; color:white; border-color:#1b5e20;' : 'border-color:#1b5e20; color:#1b5e20;'}" onclick="this.getRootNode().host.setActiveWorkflow()">${wf.active ? '✓ Active' : 'Set Active'}</button>
            <button class="tool-btn" style="padding:8px 12px; font-size:13px; border-color:#d32f2f; color:#d32f2f; ${this.workflows.length <= 1 ? 'opacity:0.5; cursor:default;' : ''}" ${this.workflows.length <= 1 ? 'disabled' : ''} onclick="this.getRootNode().host.deleteWorkflow()">Delete</button>
        `;
    }

    addWorkflow() {
        const name = prompt('Name this workflow:', 'New Workflow');
        if (!name) return;
        const wf = { id: 'wf_' + Date.now(), name: name.trim(), active: false, statuses: [], transitions: [] };
        this.workflows.push(wf);
        this.currentEditingWorkflowId = wf.id;
        this.renderWorkflowSelector();
        this.renderStatusFlowEditor();
        this.renderStatusFlowPreview();
    }

    renameWorkflow() {
        const wf = this.getEditingWorkflow();
        const name = prompt('Rename this workflow:', wf.name);
        if (!name) return;
        wf.name = name.trim() || wf.name;
        this.renderWorkflowSelector();
    }

    setActiveWorkflow() {
        const wf = this.getEditingWorkflow();
        const activeCount = this.workflows.filter(w => w.active).length;
        if (wf.active && activeCount <= 1) {
            alert('At least one workflow must stay active — activate another one first if you want to turn this one off.');
            return;
        }
        wf.active = !wf.active;
        this.renderWorkflowSelector();
    }

    deleteWorkflow() {
        if (this.workflows.length <= 1) return;
        const wf = this.getEditingWorkflow();
        if (!confirm(`Delete "${wf.name}"? This can't be undone.`)) return;
        const wasActive = wf.active;
        this.workflows = this.workflows.filter(w => w.id !== wf.id);
        if (wasActive) this.workflows[0].active = true;
        this.currentEditingWorkflowId = this.workflows[0].id;
        this.renderWorkflowSelector();
        this.renderStatusFlowEditor();
        this.renderStatusFlowPreview();
    }

    renderStatusFlowEditor() {
        const wf = this.getEditingWorkflow();
        const container = this.$('status-flow-editor');
        container.innerHTML = wf.statuses.map((s, i) => `
            <div style="border:1px solid #ddd; border-radius:8px; padding:10px 12px; background:#f8f9fa;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <div style="display:flex; flex-direction:column;">
                        <button onclick="this.getRootNode().host.moveFlowStatus('${s.id}', -1)" ${i === 0 ? 'disabled' : ''} title="Move up" style="background:none; border:none; cursor:${i === 0 ? 'default' : 'pointer'}; color:${i === 0 ? '#ccc' : '#555'}; font-size:12px; line-height:1; padding:2px;">▲</button>
                        <button onclick="this.getRootNode().host.moveFlowStatus('${s.id}', 1)" ${i === wf.statuses.length - 1 ? 'disabled' : ''} title="Move down" style="background:none; border:none; cursor:${i === wf.statuses.length - 1 ? 'default' : 'pointer'}; color:${i === wf.statuses.length - 1 ? '#ccc' : '#555'}; font-size:12px; line-height:1; padding:2px;">▼</button>
                    </div>
                    <input type="color" value="${s.color}" onchange="this.getRootNode().host.updateFlowStatusColor('${s.id}', this.value)" style="width:32px; height:32px; border:none; padding:0; cursor:pointer; flex-shrink:0;">
                    <input type="text" value="${s.name}" onchange="this.getRootNode().host.updateFlowStatusName('${s.id}', this.value)" style="flex:1; font-weight:600; padding:8px; border:1px solid #ddd; border-radius:4px; font-size:14px;">
                    <button onclick="this.getRootNode().host.removeFlowStatus('${s.id}')" title="Delete status" style="background:none; border:none; color:#d32f2f; cursor:pointer; font-size:18px; padding:0 4px; flex-shrink:0;">&times;</button>
                </div>
            </div>
        `).join('');

        this.renderTriggersList();
        this.renderReinspectionFilterList();
        this.renderSectionFilterList('break-request');
        this.renderSectionFilterList('break-seals');
        this.renderSectionFilterList('work-completed');
    }

    renderReinspectionFilterList() {
        const container = this.$('reinspection-filter-list');
        if (!container) return;
        const allStatuses = this.getAllUniqueStatusesAcrossWorkflows();

        // A status checked here but with no reinspection trigger whose
        // "Previous Status(es)" includes it will show up as selectable on the
        // field form, but submitting will find no matching transition and
        // silently skip it — this cross-checks for that exact gap. Only
        // ACTIVE workflows count here, matching exactly what seal-form.html's
        // getActiveTransitions() actually considers at runtime — a trigger
        // sitting in an inactive workflow would otherwise show as "fine" here
        // while never actually working when someone submits the form.
        const statusesWithReinspectionTrigger = new Set();
        this.getActiveWorkflows().forEach(w => {
            w.transitions.forEach(t => {
                if (t.formTrigger === 'reinspection') {
                    t.from.forEach(fromId => {
                        const s = w.statuses.find(x => x.id === fromId);
                        if (s) statusesWithReinspectionTrigger.add(s.name.toLowerCase());
                    });
                }
            });
        });

        container.innerHTML = allStatuses.length > 0 ? allStatuses.map(s => {
            const key = s.name.toLowerCase();
            const isChecked = this.reinspectionFilterStatuses.includes(key);
            const hasTrigger = statusesWithReinspectionTrigger.has(key);
            const warning = (isChecked && !hasTrigger)
                ? `<span style="color:#e65100; font-size:11px; font-weight:600;" title="This status has no Reinspection trigger configured — seals will be selectable here but submitting won't change their status.">⚠ No matching trigger</span>`
                : '';
            return `
            <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer; padding:4px 0;">
                <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="this.getRootNode().host.toggleReinspectionFilterStatus('${key}', this.checked)">
                ${s.name} ${warning}
            </label>
        `; }).join('') : '<p style="color:#bbb; font-size:12px;">Add statuses above first.</p>';
    }

    toggleReinspectionFilterStatus(key, checked) {
        if (checked && !this.reinspectionFilterStatuses.includes(key)) this.reinspectionFilterStatuses.push(key);
        else if (!checked) this.reinspectionFilterStatuses = this.reinspectionFilterStatuses.filter(k => k !== key);
    }

    // Same pattern as renderReinspectionFilterList()/toggleReinspectionFilterStatus()
    // above, generalized across the three seal-form.html sections so they
    // don't need three near-identical copies of this logic.
    renderSectionFilterList(section) {
        const meta = this.SECTION_FILTER_META[section];
        const container = this.$(meta.containerId);
        if (!container) return;
        const allStatuses = this.getAllUniqueStatusesAcrossWorkflows();
        const currentList = meta.get(); // null = unconfigured, treat every status as allowed

        const statusesWithTrigger = new Set();
        this.getActiveWorkflows().forEach(w => {
            w.transitions.forEach(t => {
                if (t.formTrigger === section) {
                    t.from.forEach(fromId => {
                        const s = w.statuses.find(x => x.id === fromId);
                        if (s) statusesWithTrigger.add(s.name.toLowerCase());
                    });
                }
            });
        });

        container.innerHTML = allStatuses.length > 0 ? allStatuses.map(s => {
            const key = s.name.toLowerCase();
            const isChecked = currentList === null ? true : currentList.includes(key);
            const hasTrigger = statusesWithTrigger.has(key);
            const warning = (isChecked && !hasTrigger)
                ? `<span style="color:#e65100; font-size:11px; font-weight:600;" title="This status has no ${meta.label} trigger configured — seals will be selectable here but submitting won't change their status.">⚠ No matching trigger</span>`
                : '';
            return `
            <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer; padding:4px 0;">
                <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="this.getRootNode().host.toggleSectionFilterStatus('${section}', '${key}', this.checked)">
                ${s.name} ${warning}
            </label>
        `; }).join('') : '<p style="color:#bbb; font-size:12px;">Add statuses above first.</p>';
    }

    toggleSectionFilterStatus(section, key, checked) {
        const meta = this.SECTION_FILTER_META[section];
        let list = meta.get();
        // First time this section's filter has ever been touched — start from
        // "everything currently allowed" (matching how it behaves while
        // unconfigured) instead of an empty list, so unchecking one status
        // doesn't silently forbid every other one too.
        list = list === null ? this.getAllUniqueStatusesAcrossWorkflows().map(s => s.name.toLowerCase()) : [...list];
        if (checked && !list.includes(key)) list.push(key);
        else if (!checked) list = list.filter(k => k !== key);
        meta.set(list);
    }

    // A trigger defines: given the seal is CURRENTLY in any one of several
    // possible previous statuses, submitting a given form (or nothing, for a
    // manual-only change) moves it to one resulting status. Supporting
    // multiple previous statuses per trigger means "Intact OR Removed, via
    // Break Request, → Break Requested" is one rule instead of needing a
    // separate one per previous status.
    renderTriggersList() {
        const wf = this.getEditingWorkflow();
        const container = this.$('triggers-list');
        if (!container) return;

        const allStatuses = this.getAllUniqueStatusesAcrossWorkflows();
        if (allStatuses.length < 2) {
            container.innerHTML = '<p style="color:#bbb; font-size:12px; padding:8px 0;">Add at least two statuses above first.</p>';
            return;
        }

        // Picking a status here that only exists in some OTHER workflow adds
        // it into this workflow's own status list the moment it's actually
        // used (see ensureStatusInWorkflow) — until then, it just shows as an
        // available, unchecked option so every workflow's triggers can be
        // built from the same full set of statuses instead of only the ones
        // already added to whichever workflow you happen to be editing.
        container.innerHTML = wf.transitions.map(t => `
            <div style="border:1px solid #ddd; border-radius:8px; padding:12px; background:#fafafa; margin-bottom:10px;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
                    <div style="flex:1;">
                        <div style="font-size:11px; font-weight:700; text-transform:uppercase; color:#999; margin-bottom:6px;">Previous Status(es)</div>
                        <div style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:10px;">
                            ${allStatuses.map(s => {
                                const local = wf.statuses.find(ls => ls.name.toLowerCase() === s.name.toLowerCase());
                                const isChecked = local ? t.from.includes(local.id) : false;
                                return `
                                <label style="display:flex; align-items:center; gap:5px; font-size:13px; cursor:pointer;">
                                    <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="this.getRootNode().host.toggleTriggerFromStatus('${t.id}', '${s.id}', this.checked)">
                                    ${s.name}
                                </label>
                            `; }).join('')}
                        </div>

                        <div style="display:flex; gap:16px; flex-wrap:wrap; align-items:center;">
                            <div>
                                <label style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; color:#999; margin-bottom:4px;">Resulting Status</label>
                                <select onchange="this.getRootNode().host.setTriggerTo('${t.id}', this.value)" style="font-size:13px; padding:6px 8px; border:1px solid #ddd; border-radius:4px;">
                                    <option value="">Select...</option>
                                    ${allStatuses.map(s => {
                                        const local = wf.statuses.find(ls => ls.name.toLowerCase() === s.name.toLowerCase());
                                        const isSelected = local ? t.to === local.id : false;
                                        return `<option value="${s.id}" ${isSelected ? 'selected' : ''}>${s.name}</option>`;
                                    }).join('')}
                                </select>
                            </div>
                            <div>
                                <label style="display:block; font-size:11px; font-weight:700; text-transform:uppercase; color:#999; margin-bottom:4px;">Triggered By</label>
                                <select onchange="this.getRootNode().host.setTriggerFormTrigger('${t.id}', this.value)" style="font-size:13px; padding:6px 8px; border:1px solid #ddd; border-radius:4px;">
                                    <option value="" ${!t.formTrigger ? 'selected' : ''}>Manual only (no form)</option>
                                    <option value="break-request" ${t.formTrigger === 'break-request' ? 'selected' : ''}>Break Request</option>
                                    <option value="break-seals" ${t.formTrigger === 'break-seals' ? 'selected' : ''}>Break Seals</option>
                                    <option value="work-completed" ${t.formTrigger === 'work-completed' ? 'selected' : ''}>Work Completed</option>
                                    <option value="reinspection" ${t.formTrigger === 'reinspection' ? 'selected' : ''}>Reinspection</option>
                                </select>
                            </div>
                        </div>
                    </div>
                    <button onclick="this.getRootNode().host.removeTrigger('${t.id}')" title="Delete trigger" style="background:none; border:none; color:#d32f2f; cursor:pointer; font-size:18px; padding:0 4px; flex-shrink:0;">&times;</button>
                </div>
            </div>
        `).join('') + (wf.transitions.length === 0 ? '<p style="color:#bbb; font-size:12px; padding:8px 0;">No triggers defined yet.</p>' : '');
    }

    addTrigger() {
        const wf = this.getEditingWorkflow();
        wf.transitions.push({ id: 'trigger_' + Date.now(), from: [], to: '', formTrigger: '' });
        this.renderTriggersList();
        this.renderReinspectionFilterList();
        this.renderSectionFilterList('break-request');
        this.renderSectionFilterList('break-seals');
        this.renderSectionFilterList('work-completed');
    }

    removeTrigger(id) {
        const wf = this.getEditingWorkflow();
        wf.transitions = wf.transitions.filter(t => t.id !== id);
        this.renderTriggersList();
        this.renderReinspectionFilterList();
        this.renderSectionFilterList('break-request');
        this.renderSectionFilterList('break-seals');
        this.renderSectionFilterList('work-completed');
    }

    toggleTriggerFromStatus(triggerId, globalStatusId, checked) {
        const wf = this.getEditingWorkflow();
        const t = wf.transitions.find(t => t.id === triggerId);
        if (!t) return;
        const globalStatus = this.getAllUniqueStatusesAcrossWorkflows().find(s => s.id === globalStatusId);
        if (!globalStatus) return;
        const localStatus = ensureStatusInWorkflow(wf, globalStatus.name, globalStatus.color);
        if (checked && !t.from.includes(localStatus.id)) t.from.push(localStatus.id);
        else if (!checked) t.from = t.from.filter(id => id !== localStatus.id);
        // Re-render the whole panel, not just the triggers list — picking a
        // status from another workflow may have just added a brand new status
        // to this one, which the Statuses editor above and the Preview diagram
        // both need to pick up too.
        this.renderStatusFlowEditor();
    }

    setTriggerTo(triggerId, globalStatusId) {
        const wf = this.getEditingWorkflow();
        const t = wf.transitions.find(t => t.id === triggerId);
        if (!t) return;
        if (!globalStatusId) { t.to = ''; this.renderStatusFlowEditor(); return; }
        const globalStatus = this.getAllUniqueStatusesAcrossWorkflows().find(s => s.id === globalStatusId);
        if (!globalStatus) return;
        const localStatus = ensureStatusInWorkflow(wf, globalStatus.name, globalStatus.color);
        t.to = localStatus.id;
        this.renderStatusFlowEditor();
    }

    setTriggerFormTrigger(triggerId, formTrigger) {
        const wf = this.getEditingWorkflow();
        const t = wf.transitions.find(t => t.id === triggerId);
        if (t) t.formTrigger = formTrigger;
        this.renderReinspectionFilterList();
    }

    moveFlowStatus(id, direction) {
        const wf = this.getEditingWorkflow();
        const index = wf.statuses.findIndex(s => s.id === id);
        const newIndex = index + direction;
        if (newIndex < 0 || newIndex >= wf.statuses.length) return;
        [wf.statuses[index], wf.statuses[newIndex]] = [wf.statuses[newIndex], wf.statuses[index]];
        this.renderStatusFlowEditor();
    }

    toggleAddStatusMenu() {
        const menu = this.$('add-status-menu');
        if (menu.style.display === 'block') { menu.style.display = 'none'; return; }
        this.renderAddStatusMenu();
        menu.style.display = 'block';

        setTimeout(() => {
            const closeMenu = (e) => {
                const path = e.composedPath();
                const insideMenu = path.includes(menu);
                const onToggleBtn = path.some(el => el.id === 'add-status-menu-btn');
                if (!insideMenu && !onToggleBtn) {
                    menu.style.display = 'none';
                    document.removeEventListener('click', closeMenu);
                }
            };
            document.addEventListener('click', closeMenu);
        }, 0);
    }

    renderAddStatusMenu() {
        const menu = this.$('add-status-menu');
        const editingWf = this.getEditingWorkflow();

        // Every status from every OTHER workflow, deduplicated by name, minus
        // any name already present in the workflow currently being edited.
        const existingNames = new Set(editingWf.statuses.map(s => s.name.toLowerCase()));
        const seenNames = new Set();
        const reusable = [];
        this.workflows.forEach(w => {
            if (w.id === editingWf.id) return;
            w.statuses.forEach(s => {
                const key = s.name.toLowerCase();
                if (existingNames.has(key) || seenNames.has(key)) return;
                seenNames.add(key);
                reusable.push(s);
            });
        });

        let html = `<div onclick="this.getRootNode().host.addFlowStatus(); this.getRootNode().host.toggleAddStatusMenu();" style="padding:10px 14px; cursor:pointer; font-weight:600; font-size:13px; color:#2e7d32; border-bottom:1px solid #eee;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='transparent'">+ Blank Status</div>`;

        if (reusable.length > 0) {
            html += `<div style="padding:8px 14px 4px; font-size:11px; font-weight:700; text-transform:uppercase; color:#999;">From other workflows</div>`;
            reusable.forEach(s => {
                const safeName = s.name.replace(/'/g, "\\'");
                html += `
                    <div onclick="this.getRootNode().host.copyStatusIntoWorkflow('${safeName}', '${s.color}'); this.getRootNode().host.toggleAddStatusMenu();" style="display:flex; align-items:center; gap:8px; padding:8px 14px; cursor:pointer; font-size:13px;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='transparent'">
                        <span style="width:16px; height:16px; border-radius:3px; background:${s.color}; border:1px solid rgba(0,0,0,0.15); flex-shrink:0;"></span>
                        ${s.name}
                    </div>
                `;
            });
        } else {
            html += `<div style="padding:10px 14px; font-size:12px; color:#bbb;">No other statuses to reuse yet</div>`;
        }

        menu.innerHTML = html;
    }

    copyStatusIntoWorkflow(name, color) {
        const wf = this.getEditingWorkflow();
        const id = 'status_' + Date.now();
        wf.statuses.push({ id, name, color });
        this.renderStatusFlowEditor();
    }

    addFlowStatus() {
        const wf = this.getEditingWorkflow();
        const id = 'status_' + Date.now();
        wf.statuses.push({ id, name: 'New Status', color: '#e0e0e0' });
        this.renderStatusFlowEditor();
    }

    removeFlowStatus(id) {
        if (!confirm('Delete this status? Any triggers using it will also be updated or removed.')) return;
        const wf = this.getEditingWorkflow();
        wf.statuses = wf.statuses.filter(s => s.id !== id);
        wf.transitions = wf.transitions
            .map(t => ({ ...t, from: t.from.filter(fromId => fromId !== id) }))
            .filter(t => t.to !== id && t.from.length > 0);
        this.renderStatusFlowEditor();
    }

    updateFlowStatusName(id, name) {
        const s = this.getEditingWorkflow().statuses.find(s => s.id === id);
        if (s) s.name = name.trim() || s.name;
    }

    updateFlowStatusColor(id, color) {
        const s = this.getEditingWorkflow().statuses.find(s => s.id === id);
        if (s) s.color = color;
    }

    // Renders each status as a stacked box (top to bottom, in list order) with
    // an SVG overlay drawing an arrow for every defined transition — a status
    // with more than one outgoing transition naturally branches into multiple
    // visible paths, since each is just its own arrow to a different box.
    renderStatusFlowPreview() {
        const wf = this.getEditingWorkflow();
        const preview = this.$('status-flow-preview');
        const boxWidth = 160, boxHeight = 44, vGap = 50, hGap = 40;
        const perRow = Math.max(1, Math.floor((preview.clientWidth - 40) / (boxWidth + hGap)) || 3);

        let boxesHtml = '';
        const positions = {};
        wf.statuses.forEach((s, i) => {
            const col = i % perRow;
            const row = Math.floor(i / perRow);
            const x = col * (boxWidth + hGap);
            const y = row * (boxHeight + vGap);
            positions[s.id] = { x: x + boxWidth / 2, y: y + boxHeight / 2, top: y, bottom: y + boxHeight, left: x, right: x + boxWidth };
            boxesHtml += `<div style="position:absolute; left:${x}px; top:${y}px; width:${boxWidth}px; height:${boxHeight}px; background:${s.color}; border:1px solid rgba(0,0,0,0.15); border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:600; text-align:center; padding:4px; box-sizing:border-box; z-index:2;">${s.name}</div>`;
        });

        const rows = Math.ceil(wf.statuses.length / perRow) || 1;
        const totalWidth = Math.min(perRow, wf.statuses.length || 1) * (boxWidth + hGap) - hGap;
        const totalHeight = rows * (boxHeight + vGap) - vGap;

        let arrowsHtml = '';
        let labelsHtml = '';
        const formLabels = { 'break-request': 'Break Request', 'break-seals': 'Break Seals', 'work-completed': 'Work Completed', 'reinspection': 'Reinspection' };
        wf.transitions.forEach(t => {
            const to = positions[t.to];
            if (!to) return;
            t.from.forEach(fromId => {
                const from = positions[fromId];
                if (!from) return;
                // Straight line from the center of one box to the center of
                // the other; the boxes themselves (z-index above the line)
                // visually clip the line to look like it starts/ends at each edge.
                arrowsHtml += `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="#2e7d32" stroke-width="2" marker-end="url(#ts-arrowhead)" />`;

                const midX = (from.x + to.x) / 2;
                const midY = (from.y + to.y) / 2;
                const label = t.formTrigger ? formLabels[t.formTrigger] : 'Manual';
                labelsHtml += `<div style="position:absolute; left:${midX}px; top:${midY}px; transform:translate(-50%,-50%); background:white; border:1px solid #ddd; border-radius:4px; padding:1px 6px; font-size:10px; color:${t.formTrigger ? '#1565c0' : '#999'}; font-weight:600; white-space:nowrap; z-index:3;">${label}</div>`;
            });
        });

        preview.innerHTML = `
            <div style="position:relative; width:${totalWidth}px; height:${totalHeight}px; margin:0 auto;">
                <svg width="${totalWidth}" height="${totalHeight}" style="position:absolute; top:0; left:0; z-index:1; overflow:visible;">
                    <defs>
                        <marker id="ts-arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                            <path d="M0,0 L8,4 L0,8 Z" fill="#2e7d32" />
                        </marker>
                    </defs>
                    ${arrowsHtml}
                </svg>
                ${boxesHtml}
                ${labelsHtml}
            </div>
            ${wf.statuses.length === 0 ? '<p style="color:#999; text-align:center; font-size:13px;">Add a status above to see it here.</p>' : ''}
        `;
    }

    closeColumnSettingsModal() {
        this.$('colSettingsModal').style.display = 'none';
    }

    async saveTsSettings() {
        this.applyColumnConfig();
        this.refreshAllStatusDropdowns();
        this.closeColumnSettingsModal();

        try {
            const { error } = await this._supabase.from('launchpad_tamperseal_config').upsert({
                project_key: this.PROJECT_KEY,
                config: {
                    columnConfig: this.columnConfig,
                    workflows: this.workflows,
                    globalStatusOrder: this.globalStatusOrder,
                    reinspectionFilterStatuses: this.reinspectionFilterStatuses,
                    breakRequestFilterStatuses: this.breakRequestFilterStatuses,
                    breakSealsFilterStatuses: this.breakSealsFilterStatuses,
                    workCompletedFilterStatuses: this.workCompletedFilterStatuses
                },
                updated_by: this.USER_EMAIL || null
            }, { onConflict: 'project_key' });
            if (error) throw error;
        } catch (e) {
            alert('Settings applied, but saving them to the backend failed: ' + e.message);
        }
    }

    // Without this, a status renamed/added/removed in Settings wouldn't show up
    // in any row that was already on screen — its dropdown's <option> list was
    // only ever built once, at the moment that row was originally rendered.
    refreshAllStatusDropdowns() {
        const activeStatuses = this.getActiveStatuses();
        this.$$('.status-dropdown').forEach(select => {
            const currentValue = select.value;
            const stillDefined = activeStatuses.some(s => s.name === currentValue);
            select.innerHTML = `
                ${!stillDefined && currentValue ? `<option value="${currentValue}">${currentValue}</option>` : ''}
                ${activeStatuses.map(s => `<option value="${s.name}" ${s.name === currentValue ? 'selected' : ''}>${s.name}</option>`).join('')}
            `;
            this.applyStatusColor(select);
        });
    }

    async init() {
        // Tamper Seal editing is CriticalArc-staff-only (editor/admin role AND
        // @criticalarccx.com email) — hide the mutating controls entirely for
        // everyone else rather than letting them click in and fail later.
        if (!this.canEditTamperSeals) {
            ['addBtn', 'editBtn', 'deleteBtn'].forEach(id => {
                const el = this.$(id);
                if (el) el.style.display = 'none';
            });
            const banner = document.createElement('div');
            banner.style.cssText = 'background:#fff3e0; color:#e65100; font-size:12.5px; font-weight:600; text-align:center; padding:6px; border-bottom:1px solid #ffe0b2;';
            banner.innerText = 'View-only — editing Tamper Seals is restricted to CriticalArc staff.';
            this.shadowRoot.insertBefore(banner, this.shadowRoot.firstChild);
        }

        await this.loadColumnConfig();

        await this.fetchLookupData();

        // Check if there is a saved preview to restore
        const savedPreview = localStorage.getItem('pendingPreview');
        if (savedPreview) {
            this.isPreviewMode = true;
            const entries = JSON.parse(savedPreview);
            this.renderPreviewGrid(entries);
        } else {
            await this.fetchHierarchyData();
        }

        // Live-updates any other viewer's edits into this log without a
        // manual refresh. Captured on the instance so disconnectedCallback can
        // unsubscribe it -- otherwise remounting this element would pile up
        // duplicate subscriptions.
        this._realtimeChannel = this._supabase
        .channel('schema-db-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: this.T('Assets') }, (payload) => {
            if (this.isEditMode || this.isPreviewMode) return;

            if (payload.eventType === 'INSERT') {
                this.allHierarchyRecords.push(payload.new);
            } else if (payload.eventType === 'UPDATE') {
                this.allHierarchyRecords = this.allHierarchyRecords.map(r => r.id === payload.new.id ? payload.new : r);
            } else if (payload.eventType === 'DELETE') {
                this.allHierarchyRecords = this.allHierarchyRecords.filter(r => r.id !== payload.old.id);
            }

            // Re-render the visual layout locally WITHOUT calling the database again
            this.renderFilteredLog();
        })
        .subscribe();
    }

    async goToStep(step) {
        this.$('step-choice').style.display = 'none';
        if (step === 'standard') {
            this.$('step-standard').style.display = 'block';
        } else {
            this.$('step-reinspection').style.display = 'block';
            this.$('modalTitle').innerText = "Reinspection: Replace Broken Seals";
            await this.loadBrokenAssets();
        }
    }

    /**
     * Identifies seal numbers appearing in more than one record,
     * then filters and expands the UI to show only those duplicates.
     */
    async findDuplicates() {
        const btn = this.$('duplicateBtn');
        const indicator = this.$('saveIndicator');

        // Toggle off if already active
        if (this.duplicateSealList) {
            this.duplicateSealList = null;
            btn.innerText = "Find Duplicates";
            btn.style.backgroundColor = "white";
            btn.style.color = "#d32f2f";
            await this.fetchHierarchyData(true);
            return;
        }

        indicator.innerText = "Scanning for duplicates...";

        // 1. Group records by seal number
        const counts = {};
        this.allHierarchyRecords.forEach(r => {
            const num = (r.seal_number || "").toString().trim();
            if (num) {
                counts[num] = (counts[num] || 0) + 1;
            }
        });

        // 2. Identify numbers with more than 1 instance
        this.duplicateSealList = Object.keys(counts).filter(num => counts[num] > 1);

        if (this.duplicateSealList.length === 0) {
            alert("No duplicate seal numbers found.");
            this.duplicateSealList = null;
            indicator.innerText = "Synced";
            return;
        }

        // 3. Update UI state
        btn.innerText = "Clear Duplicate View";
        btn.style.backgroundColor = "#d32f2f";
        btn.style.color = "white";

        // 4. Re-render the log and auto-expand everything found
        await this.renderFilteredLog();
        await this.expandAll();

        indicator.innerText = `Found ${this.duplicateSealList.length} duplicates`;
    }

    /**
     * Part 2 (Step A): Pull assets that currently have broken seals
     */
    async loadBrokenAssets() {
        const select = this.$('brokenAssetSelect');
        const { data, error } = await this._supabase
            .from(this.T('Assets'))
            .select('asset_name, status');

        if (error) return;

        const eligible = data.filter(d => this.reinspectionFilterStatuses.includes((d.status || '').toLowerCase().trim()));
        const uniqueAssets = [...new Set(eligible.map(d => d.asset_name))].sort();
        select.innerHTML = '<option value="">-- Select Asset --</option>' +
            uniqueAssets.map(a => `<option value="${a}">${a}</option>`).join('');
    }

    /**
     * Part 2 (Step B): Show seals that are broken for the chosen asset
     */
    async loadBrokenSealsForAsset(assetName) {
        if (!assetName) return;
        const container = this.$('brokenSealsContainer');
        const list = this.$('sealCheckboxList');

        const { data: allData, error } = await this._supabase
            .from(this.T('Assets'))
            .select('id, seal_number, location, sub_area, status')
            .eq('asset_name', assetName);

        const data = (allData || []).filter(s => this.reinspectionFilterStatuses.includes((s.status || '').toLowerCase().trim()));

        if (error || data.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        this.$('newSealInputs').style.display = 'block';
        this.$('reinspectPreviewBtn').style.display = 'inline-block';

        // Store metadata on the select to use later
        this.$('brokenAssetSelect').dataset.location = data[0].location || '';
        this.$('brokenAssetSelect').dataset.subarea = data[0].sub_area || '';

        list.innerHTML = data.map(s => `
            <div style="margin-bottom:5px;">
                <input type="checkbox" class="reinspect-seal-check" value="${s.id}" data-old-seal="${s.seal_number}">
                <label>Seal #${s.seal_number}</label>
            </div>
        `).join('');
    }

    /**
     * Part 2 (Step C): Generate preview for the replacement seals
     */
    generateReinspectionPreview() {
        const assetName = this.$('brokenAssetSelect').value;
        const loc = this.$('brokenAssetSelect').dataset.location;
        const sub = this.$('brokenAssetSelect').dataset.subarea;
        const checked = this.$$('.reinspect-seal-check:checked');
        const startNum = parseInt(this.$('reinspectStartSeal').value);

        if (checked.length === 0 || isNaN(startNum)) {
            alert("Select at least one broken seal and enter a starting new seal number.");
            return;
        }

        const previewEntries = Array.from(checked).map((cb, index) => ({
            asset_name: assetName,
            location: loc,
            sub_area: sub,
            seal_number: (startNum + index).toString(),
            inspection_date: this.$('reinspectDate').value,
            signoff: this.$('reinspectSignoff').value,
            status: 'Intact',
            inspection_notes: `Reinspection replacement for Seal #${cb.dataset.oldSeal}`
        }));

        this.closeAddModal();
        this.renderPreviewGrid(previewEntries);
    }

    async fetchLookupData() {
        // Assets and their locations now come from the same dropdownoptions
        // table the rest of the app already uses (Assets/Places columns) —
        // no separate AssetRegistry table needed.
        const { data, error } = await this._supabase.from(this.T('dropdownoptions')).select('Assets, Places');

        if (error) {
            console.error("Error fetching lookups:", error);
            return;
        }

        // Filter unique, non-empty values
        this.lookupData.assets = [...new Set(data.map(item => item.Assets).filter(Boolean))].sort();
        this.lookupData.locations = [...new Set(data.map(item => item.Places).filter(Boolean))].sort();

        // Populate HTML Datalists
        this.$('asset-list').innerHTML = this.lookupData.assets.map(a => `<option value="${a}">`).join('');
        this.$('location-list').innerHTML = this.lookupData.locations.map(l => `<option value="${l}">`).join('');
    }

    async toggleEditMode() {
        if (!this.canEditTamperSeals) { alert('Editing Tamper Seals is restricted to CriticalArc staff.'); return; }
        const editBtn = this.$('editBtn');
        const deleteBtn = this.$('deleteBtn');
        const addBtn = this.$('addBtn');
        const exportBtn = this.$('exportBtn');
        const cancelBtn = this.$('cancelBtn');
        const indicator = this.$('saveIndicator');

        if (!this.isEditMode) {
            // ENTER EDIT MODE
            this.isEditMode = true;
            this.classList.add('is-editing');
            editBtn.innerText = "Save Changes";
            editBtn.style.backgroundColor = "#d32f2f";
            editBtn.style.color = "white";

            // UI Visibility
            deleteBtn.style.display = "inline-block";
            cancelBtn.style.display = "inline-block";
            addBtn.style.display = "none";
            exportBtn.style.display = "none";

            indicator.innerText = "Editing...";
            this.$$('.cell-row input').forEach(i => i.readOnly = false);
            this.$$('.cell-row textarea').forEach(t => t.readOnly = false);
            this.$$('.cell-row select').forEach(s => s.disabled = false);
        } else {
            // SAVE AND EXIT
            indicator.innerText = "Saving...";
            await this.saveAllChanges();
            this.exitEditUI();
        }
    }

    async cancelEditMode() {
        if (!confirm("Discard all unsaved changes?")) return;

        // Set isEditMode to false immediately so the refresh renders in read-only mode
        this.isEditMode = false;
        this.$('saveIndicator').innerText = "Reverting...";

        // Refresh with the silent flag to keep your current view
        await this.fetchHierarchyData(true);

        this.exitEditUI();
    }

    exitEditUI() {
        this.isEditMode = false;
        this.localEdits = {}; // NEW: Clear cache
        this.classList.remove('is-editing');

        const editBtn = this.$('editBtn');
        const deleteBtn = this.$('deleteBtn');
        const addBtn = this.$('addBtn');
        const exportBtn = this.$('exportBtn');
        const cancelBtn = this.$('cancelBtn');
        const indicator = this.$('saveIndicator');

        editBtn.innerText = "Edit";
        editBtn.style.backgroundColor = "white";
        editBtn.style.color = "#d32f2f";

        // Restore standard button visibility
        deleteBtn.style.display = "none";
        cancelBtn.style.display = "none";
        addBtn.style.display = "inline-block";
        exportBtn.style.display = "inline-block";

        // Relock inputs and update status
        this.$$('.cell-row input').forEach(i => i.readOnly = true);
        this.$$('.cell-row textarea').forEach(t => t.readOnly = true);
        this.$$('.cell-row select').forEach(s => s.disabled = true);
        indicator.innerText = "Synced";
    }

    async fetchHierarchyData(isSilent = false) {
        const container = this.$('main-content-area');

        // 1. Capture State and Scroll Position to prevent UI jumps
        const openAreas = new Set();
        const openAssets = new Set();
        // #main-content-area is now the actual scrolling element (see its
        // :host/overflow-y:auto rule) rather than the browser window.
        const scrollPos = container.scrollTop;

        if (isSilent) {
            this.$$('.area-container').forEach(areaDiv => {
                const content = areaDiv.querySelector('.area-content');
                if (content && !content.classList.contains('hidden')) {
                    const name = areaDiv.querySelector('.area-header span').innerText.replace('Area: ', '').trim();
                    openAreas.add(name);
                }
            });
            this.$$('.rows-container').forEach(rowsDiv => {
                if (!rowsDiv.classList.contains('hidden')) {
                    openAssets.add(rowsDiv.getAttribute('data-asset-name'));
                }
            });
        } else {
            container.innerHTML = '<p style="text-align:center; padding:20px;">Scanning entries for Areas and Assets...</p>';
        }

        let allRecords = [];
        let from = 0, to = 999, fetchMore = true;

        // 2. RESTORED SAFE FETCH: Uses select('*') to ensure client-side filters have access to all data
        while (fetchMore && allRecords.length < 10000) {
            const { data, error } = await this._supabase.from(this.T('Assets')).select('*').range(from, to);
            if (error) {
                container.innerHTML = '<p style="text-align:center; color:red;">Error loading log hierarchy.</p>';
                return;
            }
            allRecords = allRecords.concat(data);
            if (data.length < 1000) fetchMore = false;
            else { from += 1000; to += 1000; }
        }

        this.allHierarchyRecords = allRecords;
        this.createFilterButtons();

        // Render the visual layout locally using the complete cache
        await this.renderFilteredLog(openAreas, openAssets, scrollPos);
    }

    toggleFilter(type, value) {
        const filterSet = this.activeFilters[type];

        if (value === 'All') {
            filterSet.clear();
            filterSet.add('All');
        } else {
            filterSet.delete('All');
            if (filterSet.has(value)) {
                filterSet.delete(value);
            } else {
                filterSet.add(value);
            }
            // If nothing is selected, default back to All
            if (filterSet.size === 0) filterSet.add('All');
        }

        this.createFilterButtons();
        this.renderFilteredLog();
    }

    /**
     * UI Controls for the Export Prompt
     */
    showExportOptions() {
        this.$('exportModal').style.display = 'flex';
    }

    closeExportModal() {
        this.$('exportModal').style.display = 'none';
    }

    runExport(type) {
        this.closeExportModal();
        if (type === 'csv') this.exportToCSV();
        if (type === 'pdf') this.exportToPDF();
    }

    /**
     * Generates a PDF report using jsPDF and AutoTable
     */
    async exportToPDF() {
        await ensureJsPdf();
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('l', 'pt', 'a4');

        const targetLocs = this.activeFilters.locations;
        const targetStats = [...this.activeFilters.statuses].map(s => s.toLowerCase());

        const filteredData = this.allHierarchyRecords.filter(r => {
            const loc = (r.Location || r.location || 'Unassigned').trim();
            const matchesLoc = targetLocs.has('All') || targetLocs.has(loc);
            const stat = (r.status || '').toLowerCase();
            const matchesStat = this.activeFilters.statuses.has('All') ||
                                targetStats.some(filter => stat.includes(filter));
            return matchesLoc && matchesStat;
        });

        // 1. Updated Table Headers
        const headers = [[
            "Area", "Asset", "Sub Area", "Seal #", "Date", "Signoff",
            "Notes", "Status", "Break Date", "Responsible Party", "Reason"
        ]];

        // 2. Updated Table Body
        const body = filteredData.map(r => [
            (r.Location || r.location || 'Unassigned').trim(),
            r.asset_name || '',
            r.sub_area || '',
            r.seal_number || '',
            r.inspection_date || '',
            r.signoff || '',
            r.inspection_notes || '',
            r.status || '',
            r.break_date || '',
            r.responsible_party || '', // Added
            r.break_reason || ''      // Added
        ]);

        doc.setFontSize(18);
        doc.text("Tamper Seal Inspection Log", 40, 40);
        doc.setFontSize(10);
        doc.text(`Generated on: ${new Date().toLocaleString()}`, 40, 55);

        doc.autoTable({
            head: headers,
            body: body,
            startY: 70,
            theme: 'striped',
            headStyles: { fillColor: [211, 47, 47] },
            styles: { fontSize: 7, cellPadding: 2 }, // Reduced size for 11-column fit
            columnStyles: {
                6: { cellWidth: 100 }, // Give 'Notes' more space
                10: { cellWidth: 100 } // Give 'Reason' more space
            }
        });

        doc.save(`Tamper_Seal_Log_${new Date().toISOString().split('T')[0]}.pdf`);
    }

    /**
     * Existing CSV Logic (Ensure this is in your script)
     */
    exportToCSV() {
        const targetLocs = this.activeFilters.locations;
        const targetStats = [...this.activeFilters.statuses].map(s => s.toLowerCase());

        const filteredData = this.allHierarchyRecords.filter(r => {
            const loc = (r.Location || r.location || 'Unassigned').trim();
            const matchesLoc = targetLocs.has('All') || targetLocs.has(loc);
            const stat = (r.status || '').toLowerCase();
            const matchesStat = this.activeFilters.statuses.has('All') ||
                                targetStats.some(filter => stat.includes(filter));
            return matchesLoc && matchesStat;
        });

        // 1. Updated Headers (11 columns)
        const headers = [
            "Area", "Asset", "Sub Area", "Seal #", "Inspection Date",
            "Signoff", "Inspection Notes", "Status", "Break Date",
            "Responsible Party", "Break Reason"
        ];

        // 2. Updated Data Mapping (including the last two fields)
        const csvContent = [
            headers.join(','),
            ...filteredData.map(r => [
                `"${(r.Location || r.location || 'Unassigned').trim()}"`,
                `"${r.asset_name || ''}"`,
                `"${r.sub_area || ''}"`,
                `"${r.seal_number || ''}"`,
                `"${r.inspection_date || ''}"`,
                `"${r.signoff || ''}"`,
                `"${r.inspection_notes || ''}"`,
                `"${r.status || ''}"`,
                `"${r.break_date || ''}"`,
                `"${r.responsible_party || ''}"`, // Added
                `"${r.break_reason || ''}"`       // Added
            ].join(','))
        ].join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Tamper_Seal_Log_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
    }

    toggleArea(header) {
        const content = header.nextElementSibling;
        const isHidden = content.classList.toggle('hidden');
        header.querySelector('.area-arrow').innerText = isHidden ? '▶' : '▼';
    }

    createFilterButtons() {
        const container = this.$('filter-container');
        container.innerHTML = '';

        // 1. Location Filters
        const locations = ['All', ...new Set(this.allHierarchyRecords.map(r => (r.Location || r.location || 'Unassigned').trim()))].sort();
        const locGroup = document.createElement('div');
        locGroup.className = 'filter-group';
        locGroup.innerHTML = '<span class="filter-label">Locations:</span>';

        locations.forEach(loc => {
            const btn = document.createElement('button');
            btn.className = `filter-btn loc-filter ${this.activeFilters.locations.has(loc) ? 'active' : ''}`;
            btn.innerText = loc;
            btn.onclick = () => this.toggleFilter('locations', loc);
            locGroup.appendChild(btn);
        });

        // 2. Status Filters
        const statuses = ['All', ...this.getActiveStatuses().map(s => s.name)];
        const statGroup = document.createElement('div');
        statGroup.className = 'filter-group';
        statGroup.innerHTML = '<span class="filter-label">Statuses:</span>';

        statuses.forEach(stat => {
            const btn = document.createElement('button');
            btn.className = `filter-btn ${this.activeFilters.statuses.has(stat) ? 'active' : ''}`;
            btn.innerText = stat;
            btn.onclick = () => this.toggleFilter('statuses', stat);
            statGroup.appendChild(btn);
        });

        container.appendChild(locGroup);
        container.appendChild(statGroup);
    }


    /**
     * Enhanced Search Handler
     */
    async handleSearch(query) {
        this.activeFilters.search = query.toLowerCase().trim();

        // 1. Re-render the UI based on filter
        await this.renderFilteredLog();

        // 2. Identify all visible instances (rows)
        this.updateMatchList();
    }

    /**
     * Scans the visible UI for matching rows to populate navigation
     */
    updateMatchList() {
        const query = this.activeFilters.search;
        const counter = this.$('matchCounter');

        if (!query) {
            this.matchElements = [];
            this.currentMatchIndex = -1;
            counter.innerText = "0/0";
            return;
        }

        // Collect all visible cell-rows as they represent the "instances"
        this.matchElements = Array.from(this.$$('.cell-row'));
        this.currentMatchIndex = this.matchElements.length > 0 ? 0 : -1;

        this.updateMatchUI();
    }

    updateMatchUI() {
        const counter = this.$('matchCounter');

        // Remove previous highlights
        this.$$('.highlight-match').forEach(el => el.classList.remove('highlight-match'));

        if (this.matchElements.length > 0 && this.currentMatchIndex !== -1) {
            counter.innerText = `${this.currentMatchIndex + 1}/${this.matchElements.length}`;
            const target = this.matchElements[this.currentMatchIndex];
            target.classList.add('highlight-match');
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            counter.innerText = "0/0";
        }
    }

    nextMatch() {
        if (this.matchElements.length === 0) return;
        this.currentMatchIndex = (this.currentMatchIndex + 1) % this.matchElements.length;
        this.updateMatchUI();
    }

    prevMatch() {
        if (this.matchElements.length === 0) return;
        this.currentMatchIndex = (this.currentMatchIndex - 1 + this.matchElements.length) % this.matchElements.length;
        this.updateMatchUI();
    }

    /**
     * Updated renderFilteredLog to be async so we can wait for search-triggered data loads
     */
    async renderFilteredLog(openAreas = new Set(), openAssets = new Set(), scrollPos = 0) {
        const container = this.$('main-content-area');
        container.innerHTML = '';

        const targetLocs = this.activeFilters.locations;
        const targetStats = [...this.activeFilters.statuses].map(s => s.toLowerCase());
        const query = this.activeFilters.search;

        const uniqueAreas = [...new Set(this.allHierarchyRecords.map(r => (r.Location || r.location || 'Unassigned').trim()))].sort();
        const loadPromises = [];

        uniqueAreas.forEach(areaName => {
            if (!targetLocs.has('All') && !targetLocs.has(areaName)) return;

            const areaRecords = this.allHierarchyRecords.filter(r => (r.Location || r.location || 'Unassigned').trim() === areaName);
            const uniqueAssetNames = [...new Set(areaRecords.map(r => r.asset_name))].sort();

            let visibleAssetsInArea = 0;
            const areaContent = document.createElement('div');

            // REFRESH LOGIC: Keep area open if it was open before or if searching
            const isAreaOpen = query !== '' || openAreas.has(areaName);
            const isAreaHidden = isAreaOpen ? '' : 'hidden';
            areaContent.className = `area-content ${isAreaHidden}`;

            uniqueAssetNames.forEach(assetName => {
                let assetRecords = areaRecords.filter(r => r.asset_name === assetName);
                if (!this.activeFilters.statuses.has('All')) {
                    assetRecords = assetRecords.filter(r => targetStats.some(f => (r.status || '').toLowerCase().includes(f)));
                }
                if (query !== '') {
                    assetRecords = assetRecords.filter(r => {
                        const searchStr = `${r.asset_name} ${r.Location || r.location} ${r.seal_number} ${r.sub_area} ${r.inspection_notes} ${r.signoff}`.toLowerCase();
                        return searchStr.includes(query);
                    });
                }
                if (this.duplicateSealList) {
            assetRecords = assetRecords.filter(r =>
                this.duplicateSealList.includes((r.seal_number || "").toString().trim())
            );
        }
                if (assetRecords.length === 0) return;

                visibleAssetsInArea++;
                const assetDiv = document.createElement('div');
                assetDiv.className = 'asset-container';

                // REFRESH LOGIC: Keep asset open if it was open before or if searching
                const isAssetOpen = query !== '' || openAssets.has(assetName);
                const isRowsHidden = isAssetOpen ? '' : 'hidden';
                const arrow = isAssetOpen ? '▼' : '▶';

                assetDiv.innerHTML = `
                    <div class="asset-header" onclick="this.getRootNode().host.toggleAsset(this, '${assetName}')">
                        <span>Asset: ${assetName}</span><span class="arrow">${arrow}</span>
                    </div>
                    <div class="rows-container ${isRowsHidden}" data-loaded="false" data-asset-name="${assetName}"></div>`;

                areaContent.appendChild(assetDiv);

                // Re-fetch data for assets that are open
                if (isAssetOpen) {
                    const rowsDiv = assetDiv.querySelector('.rows-container');
                    loadPromises.push(this.fetchAndRender(rowsDiv, assetName));
                }
            });

            if (visibleAssetsInArea > 0) {
                const areaDiv = document.createElement('div');
                areaDiv.className = 'area-container';
                const areaArrow = (query !== '' || openAreas.has(areaName)) ? '▼' : '▶';
                areaDiv.innerHTML = `<div class="area-header" onclick="this.getRootNode().host.toggleArea(this)"><span>Area: ${areaName}</span><span class="area-arrow">${areaArrow}</span></div>`;
                areaDiv.appendChild(areaContent);
                container.appendChild(areaDiv);
            }
        });

        if (loadPromises.length > 0) await Promise.all(loadPromises);
        if (scrollPos > 0) {
            container.scrollTop = scrollPos;
        }
        this.syncHeaderWidthToAssetRows();
    }

    // The header (.frozen-grid, inside .frozen-bar) and the actual asset rows
    // (.area-container, inside #main-content-area) are two independently-
    // calculated 95%-width boxes under different parent elements — in theory
    // that should produce identical pixel widths, but in practice kept
    // leaving a small, hard-to-pin-down gap no amount of CSS percentage/
    // box-model tuning fully closed. Rather than keep guessing at why two
    // separate calculations don't quite agree, this just reads the real,
    // already-rendered width and position of an actual asset row and forces
    // the header to match it exactly, pixel for pixel — sidestepping the
    // question of why they'd ever differ in the first place.
    syncHeaderWidthToAssetRows() {
        const grid = this.shadowRoot.querySelector('.frozen-grid');
        const bar = this.shadowRoot.querySelector('.frozen-bar');
        const reference = this.shadowRoot.querySelector('.area-container');
        if (!grid || !bar) return;

        if (!reference) {
            // Nothing loaded yet (empty log, or filtered down to nothing) —
            // release any previous override so the header falls back to its
            // own default CSS width instead of freezing at a stale value.
            grid.style.width = '';
            grid.style.marginLeft = '';
            grid.style.marginRight = '';
            return;
        }

        const refRect = reference.getBoundingClientRect();
        const barRect = bar.getBoundingClientRect();
        grid.style.width = refRect.width + 'px';
        grid.style.marginLeft = (refRect.left - barRect.left) + 'px';
        grid.style.marginRight = 'auto';
    }

    async toggleAsset(header, assetName) {
        const rowsDiv = header.nextElementSibling;
        const isHidden = rowsDiv.classList.toggle('hidden');
        header.querySelector('.arrow').innerText = isHidden ? '▶' : '▼';
        if (!isHidden && rowsDiv.getAttribute('data-loaded') === 'false') {
            await this.fetchAndRender(rowsDiv, assetName);
        }
    }

    async fetchAndRender(container, assetName) {
        // 1. Grab data instantly from the local cache instead of re-downloading it
        // 2. FILTER by the specific assetName so it only shows the correct seals
        let entries = this.allHierarchyRecords.filter(r => r.asset_name === assetName);

        let filteredData = entries;

        // Apply Duplicate Filter
        if (this.duplicateSealList) {
            filteredData = filteredData.filter(r =>
                this.duplicateSealList.includes((r.seal_number || "").toString().trim())
            );
        }

        // Apply multi-status filtering
        if (!this.activeFilters.statuses.has('All')) {
            const targetStats = [...this.activeFilters.statuses].map(s => s.toLowerCase());
            filteredData = filteredData.filter(r => {
                const s = (r.status || '').toLowerCase();
                return targetStats.some(filter => s.includes(filter));
            });
        }

        // Apply search filtering to individual rows
        const query = this.activeFilters.search;
        if (query !== '') {
            filteredData = filteredData.filter(r => {
                const searchStr = `${r.asset_name} ${r.Location || r.location} ${r.seal_number} ${r.sub_area} ${r.inspection_notes} ${r.signoff}`.toLowerCase();
                return searchStr.includes(query);
            });
        }

        // Sort rows by the admin's configured status order (Settings → Status
        // Order) — not a hardcoded "broken first" rule that only recognized
        // two specific status names and broke entirely for any custom or
        // renamed status (like "Non-Authorized Break", which doesn't contain
        // the substring "broken" at all).
        filteredData.sort((a, b) => {
            const orderOf = (status) => {
                const idx = this.globalStatusOrder.indexOf((status || '').toLowerCase().trim());
                return idx === -1 ? this.globalStatusOrder.length : idx;
            };
            return orderOf(a.status) - orderOf(b.status);
        });

        container.innerHTML = '';
        this.renderEntries(container, filteredData);
        container.setAttribute('data-loaded', 'true');
    }

    async deleteSelected() {
        if (!this.canEditTamperSeals) { alert('Editing Tamper Seals is restricted to CriticalArc staff.'); return; }
        const checkedRows = this.$$('.row-selector:checked');
        if (checkedRows.length === 0) {
            alert("Please select at least one item to delete.");
            return;
        }

        if (!confirm(`Warning: This will permanently delete ${checkedRows.length} records. Continue?`)) return;

        const indicator = this.$('saveIndicator');
        indicator.innerText = "Deleting...";

        // 1. Gather IDs and convert to Number to match Supabase int8 types
        const idsToDelete = Array.from(checkedRows).map(cb => {
            const id = cb.closest('.cell-row').dataset.id;
            return isNaN(id) ? id : Number(id);
        });

        // 2. Perform the deletion in the database
        const { error } = await this._supabase
            .from(this.T('Assets'))
            .delete()
            .in('id', idsToDelete); // Ensure your primary key column is lowercase 'id'

        if (error) {
            console.error("Supabase Delete Error:", error);
            alert(`Delete failed: ${error.message}. Make sure RLS allows Deletes for your table.`);
            indicator.innerText = "Error";
        } else {
            // 3. Remove from UI immediately
            checkedRows.forEach(cb => cb.closest('.cell-row').remove());

            // 4. Update local cache so re-renders don't bring them back
            this.allHierarchyRecords = this.allHierarchyRecords.filter(r => !idsToDelete.includes(Number(r.id)));

            indicator.innerText = "Deleted Successfully";
            setTimeout(() => indicator.innerText = "Synced", 2000);
        }
    }

    async saveAllChanges() {
        const updatePromises = [];
        const indicator = this.$('saveIndicator');

        for (const id in this.localEdits) {
            const changes = this.localEdits[id];
            if (Object.keys(changes).length === 0) continue;

            // We use 'location' (lowercase) to match the keys in syncEdit
            // and the previous successful payloads.
            updatePromises.push(
                this._supabase.from(this.T('Assets')).update(changes).eq('id', Number(id))
            );
        }

        if (updatePromises.length === 0) {
            return;
        }

        const results = await Promise.all(updatePromises);
        const errors = results.filter(r => r.error);

        if (errors.length > 0) {
            console.error("Save Errors:", errors);
            alert("Failed to save some rows. Check console for details.");
        } else {
            this.localEdits = {};
            await this.fetchLookupData();
            await this.fetchHierarchyData(true);
        }
    }

    /**
     * Captures edits in real-time to prevent data loss during search/navigation
     */
    syncEdit(id, field, value) {
        if (!id || id === "undefined") return; // Skip for preview mode
        if (!this.localEdits[id]) this.localEdits[id] = {};
        this.localEdits[id][field] = value;
    }

    renderEntries(container, entries) {
        if (entries.length === 0) {
            container.innerHTML = '<p style="padding: 10px;">No matching records found.</p>';
            return;
        }
    entries.forEach(entry => {
        const id = entry.id;
        const row = document.createElement('div');
        row.className = 'cell-row';
        row.dataset.id = id;

        // Helper to check for existing local edits before using database values
        const getVal = (field, dbVal) => (this.localEdits[id] && this.localEdits[id][field] !== undefined) ? this.localEdits[id][field] : (dbVal || '');

        row.innerHTML = `
            <div class="edit-checkbox-cell" data-col="checkbox">
                <input type="checkbox" class="row-selector">
            </div>

            <input class="edit-only-cell" data-col="assetName" list="asset-list"
                   oninput="this.getRootNode().host.syncEdit('${id}', 'asset_name', this.value)"
                   value="${getVal('asset_name', entry.asset_name)}" ${!this.isEditMode ? 'readonly' : ''}>

            <input class="edit-only-cell" data-col="location" list="location-list"
                   oninput="this.getRootNode().host.syncEdit('${id}', 'location', this.value)"
                   value="${getVal('location', entry.Location || entry.location)}" ${!this.isEditMode ? 'readonly' : ''}>

            <textarea data-col="subArea" oninput="this.getRootNode().host.syncEdit('${id}', 'sub_area', this.value)" ${!this.isEditMode ? 'readonly' : ''}>${getVal('sub_area', entry.sub_area)}</textarea>
            <textarea data-col="sealNumber" oninput="this.getRootNode().host.syncEdit('${id}', 'seal_number', this.value)" ${!this.isEditMode ? 'readonly' : ''}>${getVal('seal_number', entry.seal_number)}</textarea>
            <textarea data-col="inspectionDate" oninput="this.getRootNode().host.syncEdit('${id}', 'inspection_date', this.value)" ${!this.isEditMode ? 'readonly' : ''}>${getVal('inspection_date', entry.inspection_date)}</textarea>
            <textarea data-col="signoff" oninput="this.getRootNode().host.syncEdit('${id}', 'signoff', this.value)" ${!this.isEditMode ? 'readonly' : ''}>${getVal('signoff', entry.signoff)}</textarea>
            <textarea data-col="inspectionNotes" oninput="this.getRootNode().host.syncEdit('${id}', 'inspection_notes', this.value)" ${!this.isEditMode ? 'readonly' : ''}>${getVal('inspection_notes', entry.inspection_notes)}</textarea>

            <select class="status-dropdown" data-col="status" onchange="this.getRootNode().host.syncEdit('${id}', 'status', this.value); this.getRootNode().host.applyStatusColor(this)" ${!this.isEditMode ? 'disabled' : ''}>
                <option value="${getVal('status', entry.status)}">${getVal('status', entry.status) || 'Select...'}</option>
                ${this.getActiveStatuses().map(s => `<option value="${s.name}">${s.name}</option>`).join('')}
            </select>

            <textarea data-col="breakDate" oninput="this.getRootNode().host.syncEdit('${id}', 'break_date', this.value)" ${!this.isEditMode ? 'readonly' : ''}>${getVal('break_date', entry.break_date)}</textarea>
            <textarea data-col="responsibleParty" oninput="this.getRootNode().host.syncEdit('${id}', 'responsible_party', this.value)" ${!this.isEditMode ? 'readonly' : ''}>${getVal('responsible_party', entry.responsible_party)}</textarea>
            <textarea data-col="breakReason" oninput="this.getRootNode().host.syncEdit('${id}', 'break_reason', this.value)" ${!this.isEditMode ? 'readonly' : ''}>${getVal('break_reason', entry.break_reason)}</textarea>
        `;
        this.applyStatusColor(row.querySelector('.status-dropdown'));
        container.appendChild(row);
    });
    }

    applyStatusColor(el) {
        const row = el.closest('.cell-row');
        if (!row) return;
        row.classList.remove('row-intact', 'row-broken', 'row-removed');
        row.style.removeProperty('--row-status-color');

        const rawVal = el.value || '';
        const defined = this.getActiveStatuses().find(s => s.name.toLowerCase() === rawVal.toLowerCase().trim());
        if (defined) {
            row.style.setProperty('--row-status-color', defined.color);
            row.classList.add('row-custom-status');
            return;
        }

        // Fall back to the original keyword matching for values that don't
        // exactly match a currently-defined status (e.g. old data entered
        // before a status was renamed).
        const val = rawVal.toLowerCase();
        if (val.includes("intact") || val.includes("pass")) row.classList.add('row-intact');
        else if (val.includes("broken") || val.includes("fail")) row.classList.add('row-broken');
        else if (val.includes("removed") || val.includes("replaced") || val.includes("void")) row.classList.add('row-removed');
    }

    /**
     * Expands only the top-level Area/Zone containers.
     */
    expandAllZones() {
        this.$$('.area-content').forEach(c => c.classList.remove('hidden'));
        this.$$('.area-arrow').forEach(a => a.innerText = '▼');
    }

    /**
     * Expands all Areas and Assets, then triggers a data fetch for any
     * asset that hasn't been loaded yet.
     */
    async expandAll() {
        // 1. Visually expand everything first
        this.$$('.area-content, .rows-container').forEach(c => c.classList.remove('hidden'));
        this.$$('.area-arrow, .arrow').forEach(a => a.innerText = '▼');

        // 2. Identify all asset containers that haven't loaded data
        const containers = this.$$('.rows-container');
        const loadPromises = [];

        containers.forEach(container => {
            if (container.getAttribute('data-loaded') === 'false') {
                const assetName = container.getAttribute('data-asset-name');
                if (assetName) {
                    // Trigger the fetch and render process
                    loadPromises.push(this.fetchAndRender(container, assetName));
                }
            }
        });

        // 3. Execute all loads in parallel for efficiency
        if (loadPromises.length > 0) {
            await Promise.all(loadPromises);
        }
    }

    /**
     * Collapses all levels back to the default state.
     */
    collapseAll() {
        this.$$('.area-content, .rows-container').forEach(c => c.classList.add('hidden'));
        this.$$('.area-arrow, .arrow').forEach(a => a.innerText = '▶');
    }

    /**
     * Updated: Reveal the "Next" button instead of the preview button
     */
    async loadBrokenSealsForAsset(assetName) {
        if (!assetName) return;
        const container = this.$('brokenSealsContainer');
        const list = this.$('sealCheckboxList');

        const { data: allData, error } = await this._supabase
            .from(this.T('Assets'))
            .select('id, seal_number, location, sub_area, status')
            .eq('asset_name', assetName);

        const data = (allData || []).filter(s => this.reinspectionFilterStatuses.includes((s.status || '').toLowerCase().trim()));

        if (error || data.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        // Show the Next button
        this.$('reinspectNextBtn').style.display = 'inline-block';

        this.$('brokenAssetSelect').dataset.location = data[0].location || '';
        this.$('brokenAssetSelect').dataset.subarea = data[0].sub_area || '';

        list.innerHTML = data.map(s => `
            <div style="margin-bottom:5px;">
                <input type="checkbox" class="reinspect-seal-check" value="${s.id}" data-old-seal="${s.seal_number}">
                <label>Seal #${s.seal_number}</label>
            </div>
        `).join('');
    }

    /**
     * New Function: Pre-fills the standard form and moves the user there
     */
    proceedToStandardForm() {
        const checked = this.$$('.reinspect-seal-check:checked');
        if (checked.length === 0) {
            alert("Please select at least one broken seal to replace.");
            return;
        }

        this.isReinspectionMode = true;
        // Capture Seal Numbers for the note
        this.selectedBrokenSeals = Array.from(checked).map(cb => cb.dataset.oldSeal);
        // NEW: Capture Database IDs for the status update
        this.selectedBrokenSealIds = Array.from(checked).map(cb => cb.value);

        // Pre-fill the standard form fields
        this.$('newAsset').value = this.$('brokenAssetSelect').value;
        this.$('newLocation').value = this.$('brokenAssetSelect').dataset.location;
        this.$('newSubArea').value = this.$('brokenAssetSelect').dataset.subarea;

        // Auto-generate a note about the replacement
        this.$('newNotes').value = `Reinspection replacement for Seal(s): ${this.selectedBrokenSeals.join(', ')}`;

        // Transition to Step 2 (Standard Form)
        this.$('step-reinspection').style.display = 'none';
        this.$('step-standard').style.display = 'block';
        this.$('modalTitle').innerText = "Add Replacement Seals";
    }

    showAddModal() {
        if (!this.canEditTamperSeals) { alert('Editing Tamper Seals is restricted to CriticalArc staff.'); return; }
        this.isReinspectionMode = false;
        this.selectedBrokenSeals = [];

        // Open the modal and show Step 1 (The Choice screen)
        this.$('addModal').style.display = 'flex';
        this.$('step-choice').style.display = 'block';
        this.$('step-standard').style.display = 'none';
        this.$('step-reinspection').style.display = 'none';
        this.$('modalTitle').innerText = "Add Tamper Seals";

        // 1. SET DATE TO TODAY
        // This ensures the date is fresh every time the form is opened
        this.$('newDate').value = new Date().toISOString().split('T')[0];

        // 2. CLEAR OTHER INPUTS (Prevent data from the last session from showing)
        this.$('newNotes').value = "";
        this.$('startSeal').value = "";
        this.$('endSeal').value = "";
        this.$('omittedSeals').value = "";
        this.$('newLocation').value = "";
        this.$('newAsset').value = "";
        this.$('newSubArea').value = "";
        this.$('newSignoff').value = this.USER_EMAIL || "";

        // Reset the broken asset dropdown if it exists
        const brokenSelect = this.$('brokenAssetSelect');
        if (brokenSelect) brokenSelect.selectedIndex = 0;
    }

    closeAddModal() {
        this.$('addModal').style.display = 'none';
    }

    /**
     * Step 1: Generate the editable preview list
     */

    generatePreview() {
        const startRaw = this.$('startSeal').value;
        const endRaw = this.$('endSeal').value;
        const omittedStr = this.$('omittedSeals').value;

        const commonData = {
            location: this.$('newLocation').value,
            asset_name: this.$('newAsset').value,
            sub_area: this.$('newSubArea').value,
            inspection_date: this.$('newDate').value,
            inspection_notes: this.$('newNotes').value,
            signoff: this.$('newSignoff').value,
            status: 'Intact'
        };

        const startParts = parseSealNumberParts(startRaw);
        const endParts = parseSealNumberParts(endRaw);

        if (!startParts || !endParts) {
            alert('Please enter valid seal numbers — each needs a numeric part (letters/dashes around it are fine, e.g. "A-1001").');
            return;
        }
        if (startParts.prefix !== endParts.prefix || startParts.suffix !== endParts.suffix) {
            alert('The first and last seal numbers need matching letters/prefix and suffix — only the numeric part should differ, e.g. "A-1001" to "A-1010".');
            return;
        }

        const start = parseInt(startParts.num, 10);
        const end = parseInt(endParts.num, 10);
        const padWidth = startParts.num.length; // preserves leading-zero width, e.g. "001" -> "010" not "10"

        if (isNaN(start) || isNaN(end) || start > end) {
            alert("Please enter a valid seal range.");
            return;
        }

        // Omitted seals now match against the FULL seal number (case-
        // insensitive), not just a bare number, since the range itself can
        // include letters now too.
        const omitted = omittedStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

        const previewEntries = [];
        for (let i = start; i <= end; i++) {
            const sealNumber = `${startParts.prefix}${String(i).padStart(padWidth, '0')}${startParts.suffix}`;
            if (omitted.includes(sealNumber.toLowerCase())) continue;
            previewEntries.push({ ...commonData, seal_number: sealNumber });
        }

        this.closeAddModal();
        this.renderPreviewGrid(previewEntries);
    }

    /**
     * Step 2: Show generated rows in the main area for final editing
     */
    renderPreviewGrid(entries) {
        this.isPreviewMode = true; // Set flag
        localStorage.setItem('pendingPreview', JSON.stringify(entries)); // Save for reload

        const container = this.$('main-content-area');
        container.innerHTML = `
            <div class="preview-banner">
                <h2>Review New Entries (${entries.length} rows)</h2>
                <p>You can edit any cell below before saving. These items have not been added to the database yet.</p>
                <button class="tool-btn" style="background-color: #1b5e20; color: white; padding: 10px 20px;" onclick="this.getRootNode().host.saveNewEntries()">Confirm & Save to Database</button>
                <button class="tool-btn" style="margin-left:10px;" onclick="this.getRootNode().host.discardPreview()">Cancel & Discard</button>
            </div>
            <div id="preview-rows-container"></div>
        `;

        const rowsContainer = this.$('preview-rows-container');
        const originalMode = this.isEditMode;
        this.isEditMode = true;
        this.renderEntries(rowsContainer, entries);
        this.isEditMode = originalMode;

        this.$$('#preview-rows-container .edit-checkbox-cell').forEach(el => el.remove());
        this.$$('#preview-rows-container .edit-only-cell').forEach(el => el.style.display = 'flex');
    }

    discardPreview() {
        if (!confirm("Discard this preview?")) return;
        localStorage.removeItem('pendingPreview');
        this.isPreviewMode = false;
        this.fetchHierarchyData();
    }

    async saveNewEntries() {
        const rows = this.$$('#preview-rows-container .cell-row');
        const indicator = this.$('saveIndicator');

        indicator.innerText = "Saving to Database...";

        try {
            const newRecords = Array.from(rows).map(row => {
                // UPDATED SELECTOR: Includes 'input' so Asset and Location are captured
                const inputs = row.querySelectorAll('input:not([type="checkbox"]), textarea, select');
                return {
                    asset_name: inputs[0].value,
                    location: inputs[1].value,
                    sub_area: inputs[2].value,
                    seal_number: inputs[3].value,
                    inspection_date: inputs[4].value,
                    signoff: inputs[5].value,
                    inspection_notes: inputs[6].value,
                    status: inputs[7].value,
                    break_date: inputs[8].value,
                    responsible_party: inputs[9].value,
                    break_reason: inputs[10].value
                };
            });

            const { error } = await this._supabase.from(this.T('Assets')).insert(newRecords);
            if (error) throw error;

            // The new replacement seals are saved — now handle the OLD (broken)
            // seals' status. This was previously never wired up at all:
            // selectedBrokenSealIds was captured but never used anywhere.
            let reinspectionSummary = '';
            if (this.isReinspectionMode && this.selectedBrokenSealIds.length > 0) {
                const groups = {};
                const skipped = [];

                this.selectedBrokenSealIds.forEach(id => {
                    const seal = this.allHierarchyRecords.find(r => String(r.id) === String(id));
                    const currentStatus = seal ? seal.status : null;
                    const nextStatus = this.getReinspectionNextStatus(currentStatus);
                    if (!nextStatus) {
                        skipped.push(seal ? `#${seal.seal_number} (currently "${currentStatus || 'unknown'}")` : `id ${id}`);
                        return;
                    }
                    if (!groups[nextStatus]) groups[nextStatus] = [];
                    groups[nextStatus].push(id);
                });

                let updatedCount = 0;
                const blocked = [];
                for (const [status, ids] of Object.entries(groups)) {
                    // Chaining .select() verifies the write actually happened —
                    // a plain .update() doesn't error when RLS silently filters
                    // it down to zero affected rows, it just "succeeds" having
                    // changed nothing.
                    const { data: updatedRows, error: updateErr } = await this._supabase
                        .from(this.T('Assets'))
                        .update({ status })
                        .in('id', ids)
                        .select();

                    if (updateErr) {
                        blocked.push(...ids.map(id => `id ${id} (${updateErr.message || 'database error'})`));
                    } else if (!updatedRows || updatedRows.length === 0) {
                        blocked.push(...ids.map(id => `id ${id} (write blocked, likely a permissions/RLS issue)`));
                    } else {
                        updatedCount += updatedRows.length;
                    }
                }

                const problems = [...skipped, ...blocked];
                if (updatedCount === 0 && problems.length > 0) {
                    reinspectionSummary = `ERROR: none of the original seals' statuses were updated.\n${problems.join('\n')}`;
                } else if (problems.length > 0) {
                    reinspectionSummary = `${updatedCount} original seal(s) updated, but ${problems.length} had a problem:\n${problems.join('\n')}`;
                }
            }

            // Success Cleanup
            localStorage.removeItem('pendingPreview');
            this.isPreviewMode = false;
            this.isReinspectionMode = false;
            this.selectedBrokenSealIds = [];

            indicator.innerText = "Created Successfully";
            await this.fetchLookupData();
            await this.fetchHierarchyData();

            // Only speak up if something actually needs attention — a full,
            // clean success doesn't need a popup confirming it worked.
            if (reinspectionSummary) alert(reinspectionSummary);
        } catch (err) {
            console.error(err);
            alert("Operation failed. Check console for details.");
            indicator.innerText = "Error";
        }
    }

}

customElements.define('tamperseal-view', TamperSealView);
