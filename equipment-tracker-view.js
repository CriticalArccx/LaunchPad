// <equipment-tracker-view> — the Equipment Status Tracker grid.
//
// Used two ways, same as seal-form-view.js:
//   1. Standalone: equipment-tracker.html loads this module directly and
//      the element reads ?project=&scriptUrl= from the page URL itself
//      (dev/bookmark use — falls back to the STY4 project + hardcoded
//      Apps Script URL this file was originally built for).
//   2. Embedded: index.html dynamically imports this module and mounts
//      <equipment-tracker-view project="..." script-url="..."> directly
//      into the shell, passing its own already-authenticated Supabase
//      client instead of letting this element create a second one.
//
// Two real layout differences from the old iframe version had to be fixed
// here, not just mechanically converted — an iframe has its OWN viewport,
// so `100vh`/`position:fixed` inside it already meant "fill the iframe's
// box". A custom element shares the outer page's viewport, so the same
// rules would instead cover the whole browser window (including the
// LaunchPad shell's own header/sidebar). The loading overlay, the modal
// overlays, and the host's own sizing below use `height:100%` /
// `position:absolute` + `inset:0` instead, so they stay scoped to this
// component's own box exactly like the iframe used to be.

const SUPABASE_URL = 'https://rcnxetcomdrlxvlarqoc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjbnhldGNvbWRybHh2bGFycW9jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0NDIyMjksImV4cCI6MjA5MjAxODIyOX0.gP37sT5OrCOVRZXekMrBZHm5mtfnr6JrC2YGflWsDQU';

const PDF_OPTIONS = [
    { id: 'asset', label: 'Assets', type: 'asset' },
    { id: 'area', label: 'Area', type: 'area' },
    { id: 'l2-gate', label: 'L2 Gate CL', type: 'gate', level: 'l2' },
    { id: 'l2-status', label: 'L2 Overall Status', type: 'status', level: 'l2' },
    { id: 'l2-open', label: 'Open L2 CHK', type: 'supp-open', level: 'l2' },
    { id: 'l2-closed', label: 'Completed L2 CHK', type: 'supp-closed', level: 'l2' },
    { id: 'l3-gate', label: 'L3 Gate CL', type: 'gate', level: 'l2' },
    { id: 'l3-status', label: 'L3 Overall Status', type: 'status', level: 'l3' },
    { id: 'l3-open', label: 'Open L3 CHK', type: 'supp-open', level: 'l3' },
    { id: 'l3-closed', label: 'Completed L3 CHK', type: 'supp-closed', level: 'l3' },
    { id: 'l4-gate', label: 'L4 Gate CL', type: 'gate', level: 'l4' },
    { id: 'l4-status', label: 'L4 Overall Status', type: 'status', level: 'l4' },
    { id: 'l4-open', label: 'Open L4 Tests', type: 'supp-open', level: 'l4' },
    { id: 'l4-closed', label: 'Completed L4 Tests', type: 'supp-closed', level: 'l4' },
    { id: 'iss-open-gate', label: 'Open Gating Issues', type: 'iss-group', group: 'open-gate' },
    { id: 'iss-open-non', label: 'Open Non-Gating Issues', type: 'iss-group', group: 'open-non' },
    { id: 'iss-closed-gate', label: 'Closed Gating Issues', type: 'iss-group', group: 'closed-gate' },
    { id: 'iss-closed-non', label: 'Closed Non-Gating Issues', type: 'iss-group', group: 'closed-non' }
];

// ===== Pure helpers with no instance-state dependency (module-scoped, no
// collision risk with the other three views even though names repeat) =====

function getContrastYIQ(hexcolor) {
    if (!hexcolor) return '#000000';
    hexcolor = String(hexcolor).replace("#", "");
    if (hexcolor.length === 3) hexcolor = hexcolor.split('').map(c => c + c).join('');
    var r = parseInt(hexcolor.substr(0, 2), 16);
    var g = parseInt(hexcolor.substr(2, 2), 16);
    var b = parseInt(hexcolor.substr(4, 2), 16);
    var yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (yiq >= 128) ? '#000000' : '#ffffff';
}

function isStatusMatch(statusString, statusArray) {
    if (!statusString || !statusArray || !Array.isArray(statusArray)) return false;
    const s = String(statusString).toLowerCase().trim();
    if (statusArray.some(item => item.name && s === String(item.name).toLowerCase().trim())) return true;
    return statusArray.some(item => item.name && s.includes(String(item.name).toLowerCase().trim()));
}

const getGateVal = (val) => {
    if (val && val !== 'N/A' && val !== 'Clear' && val !== '-') return String(val).trim();
    return "";
};

function generateGateHeaderHTML(level, maxCount, baseTitle, filterColIndex) {
    let html = '';
    for (let i = 1; i <= maxCount; i++) {
        let title = maxCount > 1 ? `${baseTitle} ${i}` : baseTitle;
        // Only attach the filter dropdown to the first Gate column to preserve filter logic
        let filterHtml = (i === 1) ? `<span class="filter-icon" data-col="${filterColIndex}" onclick="this.getRootNode().host.toggleFilter(event, ${filterColIndex})">▼</span>` : '';
        html += `<div class="header-cell gate-cell ${level.toLowerCase()}-gate-col dynamic-gate-header"><div class="title-wrap"><span class="col-title" data-original="${title}">${title}</span>${filterHtml}</div></div>`;
    }
    return html;
}

// supportTypes: [{label, maxCols, legacy}] — legacy (no Apps Script
// checklistTypesByPhase for this project, the vast majority) is always
// exactly one entry {label:'Support', legacy:true}, producing the exact
// same "Supp 1, Supp 2, ..." headers this always has. A project whose
// Apps Script DOES provide checklistTypesByPhase (currently only MSA3A)
// gets one named header group per real checklist type instead.
function generateHeaderHTML(level, supportTypes) {
    let html = '';
    supportTypes.forEach((t, tIdx) => {
        for (let i = 1; i <= t.maxCols; i++) {
            let isVeryLast = (tIdx === supportTypes.length - 1 && i === t.maxCols) ? 'divider-right' : '';
            let title = t.legacy ? `Supp ${i}` : (t.maxCols > 1 ? `${t.label} ${i}` : t.label);
            html += `<div class="header-cell col-details ${level.toLowerCase()}-supp-details cl-cell dynamic-header ${isVeryLast}">${title}</div>`;
        }
    });
    return html;
}

function generateIssHeaderHTML(max) {
    let html = '';
    for (let i = 1; i <= max; i++) {
        let isLast = (i === max) ? 'divider-right' : '';
        html += `<div class="header-cell col-details global-iss-details iss-cell dynamic-header ${isLast}">Iss ${i}</div>`;
    }
    return html;
}

// The filter dropdown is deliberately appended to the real document.body
// (not this.shadowRoot) — see toggleFilter()/closeFilterMenu() below — so
// it can escape .tracker-container's `overflow:auto` clipping exactly like
// it did as a top-level element in the old standalone document. Shadow DOM
// style encapsulation means the shadow root's own <style> can't reach an
// element living outside it, so the handful of classes that dropdown
// actually needs are injected once into a real <head> stylesheet instead.
const FILTER_DROPDOWN_GLOBAL_STYLE_ID = 'equipment-tracker-view-filter-dropdown-styles';
const FILTER_DROPDOWN_STYLE = `
.filter-dropdown { position: absolute; background: white; border: 1px solid #ccc; box-shadow: 0 4px 12px rgba(0,0,0,0.15); padding: 10px; z-index: 2000; border-radius: 4px; color: #333; font-size: 13px; min-width: 180px; max-height: 350px; display: flex; flex-direction: column; }
.filter-search-input { width: 100%; padding: 6px; margin-bottom: 8px; border: 1px solid #ccc; border-radius: 3px; font-size: 13px; }
.filter-actions { margin-top: 10px; display: flex; justify-content: space-between; border-top: 1px solid #eee; padding-top: 10px; }
.filter-btn { background: #2e7d32; color: white; border: none; padding: 6px 10px; cursor: pointer; border-radius: 4px; font-weight: bold; flex: 1; margin-left: 5px;}
.filter-btn.clear { background: #f5f5f5; color: #333; border: 1px solid #ccc; margin-left: 0; margin-right: 5px;}
`;

const STYLE = `
<style>
    :host {
        /* --- EASY SIZING CONFIGURATION --- */
        --asset-col-width: 150px;
        --area-col-width: 70px; /* <--- Easily adjust Area column width here */
        --frozen-total-width: calc(var(--asset-col-width) + var(--area-col-width));
    }

    @media (max-width: 1024px) {
        :host {
            /* --- iPad / Mobile Stacked Total Width --- */
            --frozen-total-width: 160px;
        }
    }

    /* --- BASE STYLES ---
       display:block + position:relative + height:100% (not 100vh) so this
       component fills whatever container it's placed in, the same way the
       old iframe naturally filled its own box — see the file-header
       comment for why 100vh/position:fixed can't be used here. */
    :host { display: block; position: relative; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8f9fa; overflow: hidden; height: 100%; }
    * { box-sizing: border-box; }
    .header { height: 90px; background-color: #ffffff; border-bottom: 1px solid #dcdcdc; display: flex; align-items: center; justify-content: space-between; padding: 0 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
    .header-left { display: flex; align-items: center; }
    .header-right { display: flex; align-items: center; }

    .app-logo { height: 70px; object-fit: contain; }
    .app-logo2 { height: 100px; object-fit: contain; }

    .setup-btn { background: #f1f3f4; border: 1px solid #dcdcdc; padding: 8px 15px; border-radius: 6px; cursor: pointer; font-weight: bold; color: #555; display: flex; align-items: center; gap: 8px; transition: all 0.2s; }
    .setup-btn:hover { background: #e0e0e0; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }

    #app-body { display: flex; flex-direction: column; height: 100%; width: 100%; background: #f8f9fa;}

    /* RESPONSIVE SUBHEADER */
    .subheader { flex: 0 0 auto; min-height: 50px; background-color: #f1f3f4; display: flex; align-items: center; padding: 10px 30px; border-bottom: 1px solid #dcdcdc; justify-content: space-between; z-index: 1000; flex-wrap: wrap; gap: 10px; }
    .subheader-left { display: flex; align-items: center; gap: 15px; flex-wrap: wrap; }
    .subheader-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

    /* --- FULL SCREEN LOADING OVERLAY ---
       position:absolute + inset:0 (not fixed + 100vw/100vh) so this covers
       just this component's own box, matching the old iframe's behavior. */
    #loading-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background-color: #eef2f5; z-index: 9999; display: flex; flex-direction: column; align-items: center; justify-content: center; transition: opacity 0.5s ease, visibility 0.5s ease; }
    .gears-wrapper { display: flex; align-items: center; justify-content: center; position: relative; width: 120px; height: 100px; margin-bottom: 15px; }
    .gear-big { font-size: 70px; position: absolute; left: 0; animation: spin 4s linear infinite; line-height: 1; filter: drop-shadow(0px 4px 4px rgba(0,0,0,0.1)); }
    .gear-small { font-size: 45px; position: absolute; right: 0; top: 32px; animation: spin-reverse 4s linear infinite; line-height: 1; filter: drop-shadow(0px 4px 4px rgba(0,0,0,0.1)); }
    .loading-status { font-size: 22px; font-weight: bold; color: #2e7d32; letter-spacing: 0.5px; }
    .loading-subtext { margin-top: 8px; font-size: 14px; color: #777; font-weight: 500; }
    @keyframes spin { 100% { transform: rotate(360deg); } }
    @keyframes spin-reverse { 100% { transform: rotate(-360deg); } }

    /* --- SEARCH BAR STYLES --- */
    .global-search-wrapper { display: flex; align-items: center; background: white; border: 1px solid #ccc; border-radius: 4px; overflow: hidden; height: 30px; box-shadow: inset 0 1px 3px rgba(0,0,0,0.05); }
    .global-search-wrapper input { border: none; outline: none; padding: 0 10px; font-size: 13px; width: 160px; }
    #search-counter { font-size: 11px; color: #777; padding: 0 8px; background: #fff; display: flex; align-items: center; border-left: 1px solid #eee; height: 100%; font-weight: bold; }
    .search-nav-btn { background: #f1f3f4; border: none; border-left: 1px solid #ccc; padding: 0 10px; cursor: pointer; color: #555; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 11px; }
    .search-nav-btn:hover { background: #e0e0e0; }

    .cell-row.highlight-search { background-color: #fffde7 !important; outline: 2px solid #fbc02d; outline-offset: -2px; z-index: 9; position: relative; }
    .cell-row.highlight-search .frozen-combined { background-color: #fff9c4 !important; }
    .highlight-cell { box-shadow: inset 0 0 0 4px #d32f2f, inset 0 0 15px rgba(211,47,47,0.2) !important; z-index: 50 !important; position: relative; }

    /* Was referenced only in the dark-mode override below, never actually
       defined for light mode — Refresh Data (the only .tool-btn in this
       file) was falling back to bare, unstyled button chrome instead of
       matching its pill-button siblings (.pdf-btn/.clear-filters-btn). */
    .tool-btn { background: #ffffff; color: #2e7d32; border: 1px solid #2e7d32; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: bold; display: flex; align-items: center; gap: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); transition: all 0.2s; }
    .tool-btn:hover { background: #e8f5e9; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }

    .pdf-btn { background: #2e7d32; color: white; border: 1px solid #1b5e20; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: bold; display: flex; align-items: center; gap: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); transition: all 0.2s; }
    .pdf-btn:hover { background: #1b5e20; box-shadow: 0 4px 8px rgba(0,0,0,0.2); }

    .clear-filters-btn { background: #ffffff; color: #555; border: 1px solid #ccc; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: bold; display: flex; align-items: center; gap: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); transition: all 0.2s; }
    .clear-filters-btn:hover { background: #f1f3f4; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }

    /* --- HYPERLINK STYLES --- */
    .asset-link { color: #1b5e20; text-decoration: none; border-bottom: 1px dotted #1b5e20; }
    .asset-link:hover { color: #0d3b10; text-decoration: underline; border-bottom: none; }
    .chk-link { color: inherit; text-decoration: underline; font-weight: bold; padding-bottom: 1px; pointer-events: auto; cursor: pointer;}
    .chk-link:hover { opacity: 0.7; }

    /* --- EQUIPMENT TRACKER GRID --- */
    .tracker-container { flex: 1; margin: 0; width: 100%; border: none; border-top: 1px solid #dcdcdc; background: #ffffff; overflow: auto; min-height: 0; }

    .tracker-header-wrapper { position: sticky; top: 0; z-index: 999; box-shadow: 0 2px 4px rgba(0,0,0,0.1); min-width: 100%; width: max-content; background: #ffffff;}
    .rows-container { min-width: 100%; width: max-content; padding-top: 0; padding-bottom: 50px; }

    .frozen-group-bar { background-color: #2e7d32; color: white; height: 30px; display: flex; align-items: stretch; border-bottom: 1px solid #0d3b10; width: max-content; }
    .frozen-col-bar { background-color: #2e7d32; color: white; height: 38px; display: flex; align-items: stretch; border-bottom: 2px solid #1b5e20; width: max-content; }
    .cell-row { display: flex; align-items: stretch; border-bottom: 1px solid #ccc; gap: 0; width: max-content; }
    .cell-row:hover { background-color: rgba(0,0,0,0.02); }

    /* --- FLAWLESS COLUMN ALIGNMENT SYSTEM --- */
    .gate-cell, .cl-cell, .iss-cell, .stacked-cell {
        flex: 0 0 100px !important;
        width: 100px !important;
        min-width: 100px !important;
        max-width: 100px !important;
        border-right: 2px solid #000000 !important;
        overflow: hidden;
        padding: 0;
    }

    .summary-cell {
        flex: 0 0 190px !important;
        width: 190px !important;
        min-width: 190px !important;
        max-width: 190px !important;
        border-right: 2px solid #000000 !important;
        overflow: hidden;
        padding: 0;
    }

    /* GLOBALLY CENTERS ALL SUBHEADERS */
    .header-cell, .asset-part-header, .area-part-header {
        border-right: 2px solid #000000 !important;
        display: flex; justify-content: center; align-items: center; text-align: center; font-size: 11px; font-weight: bold; text-transform: uppercase; padding: 0 6px;
    }

    .group-header, .group-issues {
        display: flex; align-items: center; justify-content: center;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        transition: all 0.2s ease;
    }

    /* --- DYNAMIC ASSET / AREA FROZEN COLUMN --- */
    .frozen-combined {
        display: flex;
        flex: 0 0 var(--frozen-total-width) !important;
        width: var(--frozen-total-width) !important;
        min-width: var(--frozen-total-width) !important;
        max-width: var(--frozen-total-width) !important;
        position: sticky;
        left: 0;
        z-index: 12;
    }

    /* Default Desktop: Side-by-Side */
    .frozen-combined {
        flex-direction: row;
        padding: 0 !important;
        border-right: none !important;
    }

    .asset-part, .asset-part-header {
        width: var(--asset-col-width);
        min-width: var(--asset-col-width);
        max-width: var(--asset-col-width);
        display: flex;
        align-items: center;
        padding: 0 6px;
        border-right: 2px solid #000000;
        overflow: hidden;
    }

    .area-part, .area-part-header {
        width: var(--area-col-width);
        min-width: var(--area-col-width);
        max-width: var(--area-col-width);
        display: flex;
        align-items: center;
        padding: 0 6px;
        border-right: 2px solid #000000;
        overflow: hidden;
    }

    /* DEFAULT AREA TEXT COLOR (REPLACES INLINE STYLE) */
    .area-part-header .title-wrap {
        color: #70af73;
    }

    /* CENTERS THE ASSET AND AREA SUBHEADERS */
    .asset-part-header, .area-part-header {
        justify-content: center !important;
        gap: 6px;
        font-size: 11px;
        font-weight: bold;
        text-transform: uppercase;
        text-align: center;
    }

    .cell-row .asset-part { justify-content: center; text-align: center; font-weight: bold; font-size: 13px; color: #333; }
    .cell-row .area-part { justify-content: center; text-align: center; font-size: 12px; color: #555; font-weight: bold; }

    .frozen-group-bar .frozen-combined, .frozen-group-bar .group-header, .frozen-group-bar .group-issues { background-color: #2e7d32; border-right: 1px solid #0d3b10 !important; justify-content: center; align-items: center;}
    .frozen-col-bar .frozen-combined { background-color: #2e7d32; border-right: none !important; }
    .cell-row .frozen-combined { background-color: #e8eaed !important; border-right: none !important; }

    /* GLOBALLY CENTERS ALL WRAPPERS */
    .title-wrap { display: flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; width: 100%; justify-content: center; text-align: center; }

    .phase-gap {
        flex: 0 0 24px !important;
        width: 24px !important;
        min-width: 24px !important;
        max-width: 24px !important;
        background-color: #ffffff !important;
        border: none !important;
        position: relative;
        z-index: 5;
        margin-left: -2px;
    }

    div.col-details { display: none !important; }
    div.col-details.expanded { display: flex !important; }
    div.stacked-cell.col-details.expanded { flex-direction: column !important; }
    div.header-cell.col-details.expanded { flex-direction: row !important; }

    .summary-cell { display: flex; align-items: center; justify-content: center; text-align: center; font-size: 13px; font-weight: 600; line-height: 1.3; padding: 4px 6px; white-space: normal; word-break: break-word; }

    .stacked-cell { display: flex; flex-direction: column; background: #fff;}
    .checklist-header { flex: 1; background-color: #f1f3f4; color: #333; font-weight: bold; font-size: 11px; display: flex; align-items: center; justify-content: center; padding: 4px; border-bottom: none !important; text-align: center;}
    .checklist-status { flex: 1; font-size: 10px; font-weight: bold; text-transform: uppercase; display: flex; align-items: center; justify-content: center; padding: 4px; text-align: center; white-space: normal; word-break: break-word; line-height: 1.1; }

    .header-cell.iss-cell { font-size: 10px !important; justify-content: center; }

    .expand-btn {
        cursor: pointer; color: white; background: #4caf50;
        border: 1px solid #1b5e20; border-radius: 3px;
        padding: 1px 4px; font-weight: bold; font-size: 11px;
        margin-left: 4px; user-select: none;
        display: flex; align-items: center; justify-content: center;
        position: relative; z-index: 20; pointer-events: auto;
        min-width: 20px;
    }
    .expand-btn:hover { background: #1b5e20; }

    .divider-right { border-right: 3px solid #000000 !important; }
    .frozen-group-bar .divider-right, .frozen-col-bar .divider-right { border-right: 3px solid #4caf50 !important; }

    /* --- CONFIG TOGGLES --- */
    :host(.hide-l2-gate) .l2-gate-col { display: none !important; }
    :host(.hide-l3-gate) .l3-gate-col { display: none !important; }
    :host(.hide-l4-gate) .l4-gate-col { display: none !important; }

    /* When both Gate AND Support are off, hide the whole phase group —
       status column, group header, and both flanking dividers — not
       just the Gate sub-column. */
    :host(.hide-l2-all) #group-l2, :host(.hide-l2-all) #l2-supp-header, :host(.hide-l2-all) .l2-supp-summary,
    :host(.hide-l2-all) .phase-gap:has(+ #group-l2), :host(.hide-l2-all) .phase-gap:has(+ .l2-gate-col) { display: none !important; }
    :host(.hide-l3-all) #group-l3, :host(.hide-l3-all) #l3-supp-header, :host(.hide-l3-all) .l3-supp-summary,
    :host(.hide-l3-all) .phase-gap:has(+ #group-l3), :host(.hide-l3-all) .phase-gap:has(+ .l3-gate-col) { display: none !important; }
    :host(.hide-l4-all) #group-l4, :host(.hide-l4-all) #l4-supp-header, :host(.hide-l4-all) .l4-supp-summary,
    :host(.hide-l4-all) .phase-gap:has(+ #group-l4), :host(.hide-l4-all) .phase-gap:has(+ .l4-gate-col) { display: none !important; }

    /* --- MODALS ---
       position:absolute + inset:0 (not fixed) for the same reason as
       #loading-overlay above — stays scoped to this component's box. */
    .modal-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 3000; display: none; align-items: center; justify-content: center; }
    .modal-overlay.active { display: flex; }
    .modal-box { background: white; border-radius: 8px; width: 1350px; max-width: 98%; max-height: 90%; display: flex; flex-direction: column; box-shadow: 0 4px 20px rgba(0,0,0,0.2); }
    .modal-header { padding: 20px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
    .modal-header h2 { margin: 0; color: #2e7d32; }
    .close-btn { cursor: pointer; font-size: 20px; color: #999; border: none; background: none; }
    .modal-body { padding: 20px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 20px; }

    .global-config-wrap { padding: 15px; background: #e8f5e9; border-radius: 6px; border: 1px solid #c8e6c9; display: flex; align-items: flex-start; gap: 15px; flex-wrap: wrap; }
    .global-config-wrap h3 { margin: 0; color: #1b5e20; font-size: 16px; }

    .status-config-wrap { display: flex; gap: 20px; }
    .settings-col { flex: 1; background: #f9f9f9; padding: 15px; border-radius: 6px; border: 1px solid #eee;}
    .settings-col h3 { margin-top: 0; margin-bottom: 15px; border-bottom: 2px solid #2e7d32; padding-bottom: 5px; color: #333; text-align: center; }
    .status-group { margin-bottom: 25px; }
    .status-group h4 { margin: 0 0 10px 0; font-size: 14px; color: #555; }
    .status-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .status-row input[type="text"] { flex: 1; padding: 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 12px; }
    .status-row input[type="color"] { width: 35px; height: 28px; padding: 0; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; }
    .btn-del { background: #ffcdd2; color: #b71c1c; padding: 6px 10px; border-radius: 4px; font-weight: bold; border: none; cursor: pointer;}
    .btn-add { background: #e3f2fd; color: #0277bd; margin-top: 5px; width: 100%; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-weight: bold;}

    .checkbox-row { display: flex; align-items: center; margin-bottom: 6px; font-size: 13px; color: #333; cursor: pointer; font-weight: bold;}
    .checkbox-row input { margin: 0 8px 0 0; cursor: pointer; width: 16px; height: 16px;}

    .rules-section { border-top: 2px solid #eee; padding-top: 20px; }
    .rules-section h3 { margin-top: 0; color: #2e7d32; }
    .table-responsive { width: 100%; overflow-x: auto; margin-bottom: 10px; }
    #phase-rules-table { width: 100%; border-collapse: collapse; min-width: 900px; }
    #phase-rules-table th { background: #f1f3f4; padding: 8px; text-align: left; font-size: 11px; color: #555; }
    #phase-rules-table td { padding: 6px; border-bottom: 1px solid #eee; }
    #phase-rules-table input[type="text"], #phase-rules-table select { width: 100%; padding: 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 12px; }
    #phase-rules-table input[type="color"] { width: 35px; height: 28px; padding: 0; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; }

    .modal-footer { padding: 15px 20px; border-top: 1px solid #eee; display: flex; justify-content: flex-end; gap: 10px; background: #f1f3f4; border-radius: 0 0 8px 8px;}
    .btn { padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; border: none; }
    .btn-save { background: #2e7d32; color: white; }
    .btn-cancel { background: #ccc; color: #333; }

    /* --- SEARCH FILTER ARCHITECTURE --- */
    .filter-icon { cursor: pointer; font-size: 10px; color: #a5d6a7; padding: 2px; }
    .filter-icon.active { color: #ffeb3b; }

    /* INDEPENDENT FILTER HIGHLIGHTING */
    .header-cell.is-filtered,
    .asset-part-header.is-filtered,
    .area-part-header.is-filtered {
        background-color: #fff9c4 !important;
        color: #f57f17 !important;
    }

    .header-cell.is-filtered .filter-icon,
    .asset-part-header.is-filtered .filter-icon,
    .area-part-header.is-filtered .filter-icon {
        color: #f57f17 !important;
    }

    /* OVERRIDES DEFAULT AREA COLOR WHEN FILTERED */
    .area-part-header.is-filtered .title-wrap {
        color: #f57f17 !important;
    }

    /* --- MEDIA QUERIES FOR IPAD / TABLET DYNAMIC RESPONSIVENESS --- */
    @media (max-width: 1024px) {
        .subheader { padding: 10px 15px; flex-wrap: wrap; height: auto; min-height: 50px;}
        .global-search-wrapper { margin-left: 0; margin-top: 5px; width: 100%; }
        .global-search-wrapper input { flex: 1; }
        .btn, .pdf-btn, .clear-filters-btn, .setup-btn { padding: 6px 10px; font-size: 12px; }

        /* Dynamically Stack the Asset and Area columns on iPad */
        .frozen-combined {
            flex-direction: column !important;
            justify-content: center !important;
            padding: 4px 8px !important;
            gap: 4px;
        }
        .asset-part, .asset-part-header, .area-part, .area-part-header {
            width: 100% !important;
            min-width: 100% !important;
            max-width: 100% !important;
            border-right: none !important;
            padding: 0 !important;
            height: auto !important;
        }
        .cell-row .asset-part { justify-content: flex-start; text-align: left; }
        .cell-row .area-part { justify-content: flex-start; text-align: left; font-size: 10px; }
        .frozen-col-bar .area-part-header { margin-top: 2px; font-size: 10px; }
    }
    /* --- DARK MODE OVERRIDES --- */
    :host(.dark-mode) {
        background-color: #121212 !important;
        color: #e0e0e0 !important;
    }

    /* Base structural elements */
    :host(.dark-mode) .header,
    :host(.dark-mode) #sidebar,
    :host(.dark-mode) #filter-sidebar,
    :host(.dark-mode) #filter-collapsed,
    :host(.dark-mode) .subheader,
    :host(.dark-mode) #app-body,
    :host(.dark-mode) .rows-container,
    :host(.dark-mode) .week-content,
    :host(.dark-mode) .week-container,
    :host(.dark-mode) .frozen-bar,
    :host(.dark-mode) .date-header,
    :host(.dark-mode) .tracker-container,
    :host(.dark-mode) .modal-box,
    :host(.dark-mode) #auth-prompt,
    :host(.dark-mode) #admin-panel,
    :host(.dark-mode) #ready-activities-panel,
    :host(.dark-mode) #history-menu {
        background-color: #1e1e1e !important;
        border-color: #333 !important;
        color: #e0e0e0 !important;
    }

    /* Inputs and interactive elements */
    :host(.dark-mode) input,
    :host(.dark-mode) select,
    :host(.dark-mode) textarea {
        background-color: #2c2c2c !important;
        color: #e0e0e0 !important;
        border-color: #444 !important;
    }

    :host(.dark-mode) input:focus,
    :host(.dark-mode) select:focus,
    :host(.dark-mode) textarea:focus {
        background-color: #383838 !important;
        border-color: #4caf50 !important; /* Green highlight to match theme */
    }

    /* Text overrides */
    :host(.dark-mode) .header-center span,
    :host(.dark-mode) .date-header,
    :host(.dark-mode) h2,
    :host(.dark-mode) h3 {
        color: #81c784 !important; /* Lighter green for readability on dark */
    }

    :host(.dark-mode) .nav-text,
    :host(.dark-mode) .view-btn,
    :host(.dark-mode) .filter-header-item {
        color: #aaa !important;
    }

    :host(.dark-mode) .nav-item:hover,
    :host(.dark-mode) .nav-item.active {
        background-color: #2c2c2c !important;
        color: #81c784 !important;
        border-left-color: #81c784 !important;
    }

    :host(.dark-mode) .view-btn.active {
        color: #81c784 !important;
        border-bottom-color: #81c784 !important;
    }

    /* Grid and cell rows */
    :host(.dark-mode) .cell-row {
        border-bottom: 2px solid #333 !important;
        background-color: #1e1e1e !important;
    }

    :host(.dark-mode) .cell-row:hover {
        background-color: #2a2a2a !important;
    }

    /* Tools and Buttons */
    :host(.dark-mode) .tool-btn {
        background-color: #2c2c2c !important;
        color: #e0e0e0 !important;
        border-color: #555 !important;
    }

    :host(.dark-mode) .tool-btn:hover {
        background-color: #383838 !important;
    }
    /* --- MUTED STATUS COLORS (Using CSS Filters) --- */
    /* This automatically dims and desaturates any cell that has a background color applied by JS */
    :host(.dark-mode) .status-cell,
    :host(.dark-mode) .dynamic-cell,
    :host(.dark-mode) .colored-cell,
    :host(.dark-mode) [style*="background-color: rgb"],
    :host(.dark-mode) [style*="background-color: #"] {
        /* Dim the brightness and lower the saturation so it isn't jarring on dark backgrounds */
        filter: brightness(0.65) saturate(0.7) contrast(1.2) !important;
        color: #ffffff !important; /* Ensure text inside stays readable */
    }

    /* --- ATTRIBUTES PAGE & TABLES OVERRIDES --- */
    :host(.dark-mode) #attributes-view,
    :host(.dark-mode) .attributes-container,
    :host(.dark-mode) .data-table-container,
    :host(.dark-mode) table {
        background-color: #1e1e1e !important;
        color: #e0e0e0 !important;
    }

    /* Table Headers & Borders */
    :host(.dark-mode) th {
        background-color: #2c2c2c !important;
        color: #81c784 !important; /* Muted Green for headers */
        border-bottom: 2px solid #4caf50 !important;
    }

    :host(.dark-mode) td,
    :host(.dark-mode) tr {
        border-color: #333 !important;
        background-color: transparent !important;
    }

    /* Alternate row striping for tables */
    :host(.dark-mode) tr:nth-child(even) td {
        background-color: #252525 !important;
    }
    :host(.dark-mode) tr:hover td {
        background-color: #333 !important;
    }

    /* --- EQUIPMENT TRACKER PHASES --- */
    /* Targets the dividers and headers between phases */
    :host(.dark-mode) .phase-header,
    :host(.dark-mode) .phase-divider,
    :host(.dark-mode) .group-header,
    :host(.dark-mode) .section-title {
        background-color: #252525 !important;
        color: #81c784 !important;
        border-top: 2px solid #444 !important;
        border-bottom: 2px solid #444 !important;
        text-shadow: 1px 1px 2px #000 !important;
    }

    /* Mute the specific phase row if it's a solid block */
    :host(.dark-mode) .phase-row {
        background: linear-gradient(90deg, #1e1e1e, #2c2c2c) !important;
        border-left: 4px solid #4caf50 !important;
    }

    /* --- REMOVE LEFTOVER WHITE SPACE IN THE TRACKER GRID --- */
    /* The gap strip drawn between each phase group (previously hardcoded white) */
    :host(.dark-mode) .phase-gap {
        background-color: #121212 !important;
    }

    /* The frozen ASSET/PHASE columns (previously a light grey #e8eaed) */
    :host(.dark-mode) .cell-row .frozen-combined {
        background-color: #1e1e1e !important;
    }

    /* The wrapper behind each QA sub-cell (previously white) */
    :host(.dark-mode) .stacked-cell {
        background-color: #1e1e1e !important;
    }

    /* The small "QA 1 / QA 2" sub-labels (previously light grey #f1f3f4) */
    :host(.dark-mode) .checklist-header {
        background-color: #252525 !important;
        color: #aaa !important;
    }

    /* Default/empty status cells (dashes, "no rule matched", etc. previously light grey #f5f5f5) */
    :host(.dark-mode) [style*="background-color:#f5f5f5"] {
        background-color: #2c2c2c !important;
        color: #999999 !important;
    }

    /* Zero/empty numeric cells (e.g. Open Gating Issues "-", previously light blue #e1f5fe) */
    :host(.dark-mode) [style*="background-color:#e1f5fe"] {
        background-color: #2c2c2c !important;
        color: #999999 !important;
    }

    /* The header row's background strip beyond the last column (previously white) */
    :host(.dark-mode) .tracker-header-wrapper {
        background-color: #1e1e1e !important;
    }

    /* Keep the "Asset Details" and "Asset Issues" end-caps the same green as the L2/L3/L4 group headers */
    :host(.dark-mode) .frozen-group-bar .group-header,
    :host(.dark-mode) .frozen-group-bar .group-issues,
    :host(.dark-mode) .frozen-group-bar .frozen-combined {
        background-color: #2e7d32 !important;
    }
</style>
`;

const MARKUP = `
<div id="loading-overlay">
    <div class="gears-wrapper">
        <div class="gear-big">⚙️</div>
        <div class="gear-small">⚙️</div>
    </div>
    <div class="loading-status" id="loading-status-text">Fetching Equipment Data...</div>
    <div class="loading-subtext">Connecting to Database</div>
</div>

<div id="app-body">
    <div class="subheader">
        <div class="subheader-left">
            <div style="font-weight: bold; color: #555; white-space: nowrap;"><span id="zone-title-display">Site</span> • Equipment Status Tracker</div>
            <div class="global-search-wrapper">
                <span style="padding-left: 8px; color: #999;">🔍</span>
                <input type="text" id="global-search-input" placeholder="Find instance..." oninput="this.getRootNode().host.debouncedGlobalSearch()">
                <div id="search-counter">0/0</div>
                <button class="search-nav-btn" onclick="this.getRootNode().host.navigateSearch(-1)">▲</button>
                <button class="search-nav-btn" onclick="this.getRootNode().host.navigateSearch(1)">▼</button>
            </div>
        </div>

        <div class="subheader-right">
            <div style="font-size: 13px; color: #2e7d32; font-weight: bold; margin-right: 5px; white-space: nowrap;" id="sync-status">Connecting Backend...</div>
            <button onclick="this.getRootNode().host.fetchTrackerData(false)" class="tool-btn" title="Reload the latest data from the backend">🔄 Refresh Data</button>
            <button id="setup-config-btn" class="setup-btn" style="display: none;" onclick="this.getRootNode().host.openSettingsModal()">⚙️ Setup Config</button>
            <button onclick="this.getRootNode().host.clearAllFilters()" class="clear-filters-btn">
                <span style="font-size: 14px;">🧹</span> Remove Filters
            </button>
            <button onclick="this.getRootNode().host.openPdfModal()" class="pdf-btn">
                <span style="font-size: 14px;">📄</span> Export PDF
            </button>
        </div>
    </div>

    <div class="tracker-container">
        <div class="tracker-header-wrapper">
            <div class="frozen-group-bar">
                <div class="header-cell frozen-combined">Asset Details</div>
                <div class="phase-gap"></div>
                <div class="header-cell group-header" id="group-l2">L2 Verification</div>
                <div class="phase-gap"></div>
                <div class="header-cell group-header" id="group-l3">L3 Functional</div>
                <div class="phase-gap"></div>
                <div class="header-cell group-header" id="group-l4">L4 Integrated</div>
                <div class="phase-gap"></div>
                <div class="header-cell group-issues" id="group-iss">Asset Issues</div>
            </div>

            <div class="frozen-col-bar" id="main-column-headers">

                <div class="header-cell frozen-combined">
                    <div class="asset-part-header">
                        <div class="title-wrap">
                            <span class="col-title" data-original="Asset">Asset</span>
                            <span class="filter-icon" data-col="0" onclick="this.getRootNode().host.toggleFilter(event, 0)">▼</span>
                        </div>
                    </div>
                    <div class="area-part-header">
                        <div class="title-wrap" style="color: #22c922;">
                            <span class="col-title" id="area-title" data-original="Area">Area</span>
                            <span class="filter-icon" data-col="1" onclick="this.getRootNode().host.toggleFilter(event, 1)">▼</span>
                        </div>
                    </div>
                </div>

                <div class="phase-gap"></div>

                <div class="header-cell gate-cell l2-gate-col"><div class="title-wrap"><span class="col-title" id="l2-gate-title" data-original="Gate CL">Gate CL</span><span class="filter-icon" data-col="2" onclick="this.getRootNode().host.toggleFilter(event, 2)">▼</span></div></div>
                <div class="header-cell summary-cell" id="l2-supp-header">
                    <div class="title-wrap"><span class="col-title" id="l2-status-title" data-original="Status">Status</span><span class="filter-icon" data-col="3" onclick="this.getRootNode().host.toggleFilter(event, 3)">▼</span></div>
                    <div class="expand-btn" data-target="l2-supp" onclick="this.getRootNode().host.toggleExpansion('l2')">+</div>
                </div>

                <div class="phase-gap"></div>

                <div class="header-cell gate-cell l3-gate-col"><div class="title-wrap"><span class="col-title" id="l3-gate-title" data-original="Gate CL">Gate CL</span><span class="filter-icon" data-col="4" onclick="this.getRootNode().host.toggleFilter(event, 4)">▼</span></div></div>
                <div class="header-cell summary-cell" id="l3-supp-header">
                    <div class="title-wrap"><span class="col-title" id="l3-status-title" data-original="Status">Status</span><span class="filter-icon" data-col="5" onclick="this.getRootNode().host.toggleFilter(event, 5)">▼</span></div>
                    <div class="expand-btn" data-target="l3-supp" onclick="this.getRootNode().host.toggleExpansion('l3')">+</div>
                </div>

                <div class="phase-gap"></div>

                <div class="header-cell gate-cell l4-gate-col"><div class="title-wrap"><span class="col-title" id="l4-gate-title" data-original="Gate CL">Gate CL</span><span class="filter-icon" data-col="6" onclick="this.getRootNode().host.toggleFilter(event, 6)">▼</span></div></div>
                <div class="header-cell summary-cell" id="l4-supp-header">
                    <div class="title-wrap"><span class="col-title" id="l4-status-title" data-original="Status">Status</span><span class="filter-icon" data-col="7" onclick="this.getRootNode().host.toggleFilter(event, 7)">▼</span></div>
                    <div class="expand-btn" data-target="l4-supp" onclick="this.getRootNode().host.toggleExpansion('l4')">+</div>
                </div>

                <div class="phase-gap"></div>

                <div class="header-cell summary-cell" id="global-iss-header">
                    <div class="title-wrap"><span class="col-title" id="iss-status-title" data-original="Open Issues">Open Issues</span><span class="filter-icon" data-col="8" onclick="this.getRootNode().host.toggleFilter(event, 8)">▼</span></div>
                    <div class="expand-btn" data-target="global-iss" onclick="this.getRootNode().host.toggleGlobalIssues()">+</div>
                </div>

            </div>
        </div>
        <div class="rows-container" id="tracker-rows"></div>
    </div>
</div>

<div class="modal-overlay" id="pdf-modal">
    <div class="modal-box" style="width: 450px;">
        <div class="modal-header">
            <h2>Export to PDF</h2>
            <button class="close-btn" onclick="this.getRootNode().host.closePdfModal()">×</button>
        </div>
        <div class="modal-body">
            <h3 style="margin-top: 0; color: #555; font-size: 14px; border-bottom: 2px solid #eee; padding-bottom: 8px;">Select columns to include in PDF:</h3>
            <div id="pdf-column-list" style="display: flex; flex-direction: column; gap: 8px;">
                </div>
        </div>
        <div class="modal-footer">
            <button class="btn btn-cancel" onclick="this.getRootNode().host.closePdfModal()">Cancel</button>
            <button class="btn btn-save" onclick="this.getRootNode().host.generatePDF()">Generate & Print PDF</button>
        </div>
    </div>
</div>

<div class="modal-overlay" id="settings-modal">
    <div class="modal-box">
        <div class="modal-header">
            <h2>System Config</h2>
            <button class="close-btn" onclick="this.getRootNode().host.closeSettingsModal()">×</button>
        </div>
        <div class="modal-body">

            <div class="global-config-wrap">
                <div style="flex: 1 1 20%; display: flex; flex-direction: column; gap: 8px;">
                    <h3 style="margin: 0;">Fallback Color</h3>
                    <input type="color" id="fallback-color-picker" value="#f5f5f5" style="width: 40px; height: 30px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px;">
                </div>
                <div style="flex: 1 1 30%; border-left: 2px solid #c8e6c9; padding-left: 15px; display: flex; flex-direction: column; gap: 8px;">
                    <h3 style="margin: 0;">Site</h3>
                    <input type="text" id="cust-zone-title" disabled title="Site name now comes from the project record and can't be edited here." style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; width: 90%; background: #eee; color: #777;">
                </div>
                <div style="flex: 1 1 30%; border-left: 2px solid #c8e6c9; padding-left: 15px; display: flex; flex-direction: column; gap: 8px;">
                    <h3 style="margin: 0;">Area Header Prefix</h3>
                    <input type="text" id="cust-area-prefix" placeholder="e.g. Area" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; width: 90%;">
                </div>
            </div>

            <div class="rules-section">
                <h3>Phase Setup & Toggles</h3>
                <div class="status-config-wrap">
                    <div class="settings-col">
                        <h4>Phase 1 (L2)</h4>
                        <div class="status-row"><input type="text" id="cust-l2-phase" placeholder="Phase Name (e.g. L2 Verification)"></div>
                        <div class="status-row"><input type="text" id="cust-l2-gate" placeholder="Gate Header (e.g. Gate CL)"></div>
                        <div class="status-row"><input type="text" id="cust-l2-status" placeholder="Status Header (e.g. Status)"></div>
                        <div style="margin-top: 15px;">
                            <label class="checkbox-row"><input type="checkbox" id="show-l2-gate"> Show Gate Column</label>
                            <label class="checkbox-row"><input type="checkbox" id="show-l2-supp"> Enable Support CLs</label>
                        </div>
                    </div>
                    <div class="settings-col">
                        <h4>Phase 2 (L3)</h4>
                        <div class="status-row"><input type="text" id="cust-l3-phase" placeholder="Phase Name (e.g. L3 Functional)"></div>
                        <div class="status-row"><input type="text" id="cust-l3-gate" placeholder="Gate Header (e.g. Gate CL)"></div>
                        <div class="status-row"><input type="text" id="cust-l3-status" placeholder="Status Header (e.g. Status)"></div>
                        <div style="margin-top: 15px;">
                            <label class="checkbox-row"><input type="checkbox" id="show-l3-gate"> Show Gate Column</label>
                            <label class="checkbox-row"><input type="checkbox" id="show-l3-supp"> Enable Support CLs</label>
                        </div>
                    </div>
                    <div class="settings-col">
                        <h4>Phase 3 (L4)</h4>
                        <div class="status-row"><input type="text" id="cust-l4-phase" placeholder="Phase Name (e.g. L4 Integrated)"></div>
                        <div class="status-row"><input type="text" id="cust-l4-gate" placeholder="Gate Header (e.g. Gate CL)"></div>
                        <div class="status-row"><input type="text" id="cust-l4-status" placeholder="Status Header (e.g. Status)"></div>
                        <div style="margin-top: 15px;">
                            <label class="checkbox-row"><input type="checkbox" id="show-l4-gate"> Show Gate Column</label>
                            <label class="checkbox-row"><input type="checkbox" id="show-l4-supp"> Enable Support CLs</label>
                        </div>
                    </div>
                    <div class="settings-col">
                        <h4>Global Issues</h4>
                        <div class="status-row"><input type="text" id="cust-iss-phase" placeholder="Phase Name (e.g. Asset Issues)"></div>
                        <div class="status-row" style="visibility:hidden;"><input type="text"></div>
                        <div class="status-row"><input type="text" id="cust-iss-status" placeholder="Status Header (e.g. Open Issues)"></div>
                    </div>
                </div>
            </div>

            <div class="status-config-wrap">
                <div class="settings-col">
                    <h3>Checklists (L2 & L3)</h3>
                    <div class="status-group">
                        <h4>Active / Open</h4>
                        <div id="cl-open-list"></div>
                        <button class="btn btn-add" onclick="this.getRootNode().host.addStatusRow('cl-open-list', '#fff9c4')">+ Add Status</button>
                    </div>
                    <div class="status-group">
                        <h4>Completed / Closed</h4>
                        <div id="cl-closed-list"></div>
                        <button class="btn btn-add" onclick="this.getRootNode().host.addStatusRow('cl-closed-list', '#c8e6c9')">+ Add Status</button>
                    </div>
                    <div class="status-group" id="cl-cxcomplete-group">
                        <h4>Cx Complete</h4>
                        <div id="cl-cxcomplete-list"></div>
                        <button class="btn btn-add" onclick="this.getRootNode().host.addStatusRow('cl-cxcomplete-list', '#81c784')">+ Add Status</button>
                    </div>
                </div>

                <div class="settings-col">
                    <h3>Tests (L4)</h3>
                    <div class="status-group">
                        <h4>Active / Open</h4>
                        <div id="test-open-list"></div>
                        <button class="btn btn-add" onclick="this.getRootNode().host.addStatusRow('test-open-list', '#fff9c4')">+ Add Status</button>
                    </div>
                    <div class="status-group">
                        <h4>Completed / Closed</h4>
                        <div id="test-closed-list"></div>
                        <button class="btn btn-add" onclick="this.getRootNode().host.addStatusRow('test-closed-list', '#c8e6c9')">+ Add Status</button>
                    </div>
                </div>

                <div class="settings-col">
                    <h3>Global Issues</h3>
                    <div class="status-group">
                        <h4>Active / Open</h4>
                        <div id="iss-open-list"></div>
                        <button class="btn btn-add" onclick="this.getRootNode().host.addStatusRow('iss-open-list', '#ffcdd2')">+ Add Status</button>
                    </div>
                    <div class="status-group">
                        <h4>Completed / Closed</h4>
                        <div id="iss-closed-list"></div>
                        <button class="btn btn-add" onclick="this.getRootNode().host.addStatusRow('iss-closed-list', '#c8e6c9')">+ Add Status</button>
                    </div>
                </div>

                <div class="settings-col">
                    <h3>Issue Severities</h3>
                    <div class="status-group">
                        <h4>Gating Issues</h4>
                        <div id="iss-gating-list"></div>
                        <button class="btn btn-add" onclick="this.getRootNode().host.addStatusRow('iss-gating-list', '#ffcdd2')">+ Add Status</button>
                    </div>
                    <div class="status-group">
                        <h4>Non-Gating Issues</h4>
                        <div id="iss-nongating-list"></div>
                        <button class="btn btn-add" onclick="this.getRootNode().host.addStatusRow('iss-nongating-list', '#fff9c4')">+ Add Status</button>
                    </div>
                </div>

            </div>

            <div class="rules-section">
                <h3>Phase Rules Engine</h3>
                <div class="table-responsive">
                    <table id="phase-rules-table">
                        <thead>
                            <tr>
                                <th>Active?</th>
                                <th>Phase</th>
                                <th>Req. Prev Status</th>
                                <th title="Max Gate CL Open">Max Gate</th>
                                <th title="Max Support CL Open">Max Supp</th>
                                <th title="Max Support CL Closed but NOT Cx Complete">Max Supp Pend. Cx</th>
                                <th title="Max Gating Issues Open">Max Gate Iss.</th>
                                <th title="Max Non-Gating Issues Open">Max Non-Gate Iss.</th>
                                <th>Result Status</th>
                                <th title="Include Open CHKs Per Phase" style="text-align:center;">Inc. Open CHKs</th>
                                <th title="Include Open Gating Issues" style="text-align:center;">Inc. Gate Iss.</th>
                                <th>Color</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody id="phase-rules-list">
                        </tbody>
                    </table>
                </div>
                <button class="btn btn-add" style="width:auto; padding: 6px 15px;" onclick="this.getRootNode().host.addPhaseRuleRow()">+ Add Rule</button>
            </div>

        </div>
        <div class="modal-footer">
            <button class="btn btn-cancel" onclick="this.getRootNode().host.closeSettingsModal()">Cancel</button>
            <button class="btn btn-save" onclick="this.getRootNode().host.saveSettings()">Save & Sync to Sheet</button>
        </div>
    </div>
</div>
`;

export class EquipmentTrackerView extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._outsideFilterClickHandler = this._handleOutsideFilterClick.bind(this);

        // --- PERFORMANCE OPTIMIZATION CACHE ---
        this.rowFilterData = [];
        this.rowNodes = [];
        this.__lastTrackerFingerprint = null;

        this.globalConfig = {
            showL2Gate: true, showL3Gate: true, showL4Gate: true,
            showL2Supp: true, showL3Supp: true, showL4Supp: true,
            openStatuses: [], closedStatuses: [], cxCompleteStatuses: [],
            testOpenStatuses: [], testClosedStatuses: [],
            issueOpenStatuses: [], issueClosedStatuses: [],
            gatingIssues: [], nonGatingIssues: [],
            phaseRules: [], fallbackColor: '#f5f5f5',
            customHeaders: { zoneTitle: 'Zone 1' },
            maxCols: { l2: 0, l3: 0, l4: 0, iss: 0 }
        };

        this.expandedStates = { l2: false, l3: false, l4: false, iss: false };

        // --- GLOBAL SEARCH ENGINE ---
        this.searchMatches = [];
        this.currentSearchIndex = -1;
        this.__searchDebounceTimer = null;

        this.activeFilters = {};
        this.currentDropdown = null;
    }

    connectedCallback() {
        if (this._mounted) return;
        this._mounted = true;
        this._resolveParams();
        this.shadowRoot.innerHTML = STYLE + MARKUP;
        this._initSupabase();
        this._injectGlobalFilterDropdownStyles();
        document.addEventListener('click', this._outsideFilterClickHandler);

        if (localStorage.getItem('launchpad_dark_mode') === 'enabled') {
            this.classList.add('dark-mode');
        }

        this.init();
    }

    disconnectedCallback() {
        document.removeEventListener('click', this._outsideFilterClickHandler);
        if (this.currentDropdown) { document.body.removeChild(this.currentDropdown); this.currentDropdown = null; }
        clearTimeout(this.__searchDebounceTimer);
    }

    _resolveParams() {
        const qp = new URLSearchParams(window.location.search);
        // Falls back to the prefix this file was originally built for, so
        // it still works if opened directly without a project param.
        this.PROJECT_KEY = this.getAttribute('project') || qp.get('project') || 'STY4';
        // Each project has its own separately-deployed Apps Script (they're
        // container-bound to one spreadsheet each — there's no shared/
        // routable version of this backend). This hardcoded value is only
        // the fallback for opening this file directly during dev.
        this.API_URL = this.getAttribute('script-url') || qp.get('scriptUrl')
            || 'https://script.google.com/macros/s/AKfycbxkJfxdnt3j9l_8EH0ZUmAc48PSVP2W53t1ps-9LH_RlGGwO41Uq6jbnt78JMinDIDN/exec';
    }

    _initSupabase() {
        const injected = this.supabaseClient || window.launchpadSupabaseClient;
        this._supabase = injected || window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }

    // The filter dropdown escapes to document.body (see toggleFilter below)
    // so its CSS has to live in a real stylesheet too, injected once.
    _injectGlobalFilterDropdownStyles() {
        if (document.getElementById(FILTER_DROPDOWN_GLOBAL_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = FILTER_DROPDOWN_GLOBAL_STYLE_ID;
        style.textContent = FILTER_DROPDOWN_STYLE;
        document.head.appendChild(style);
    }

    // Shadow-scoped DOM helpers.
    $(id) { return this.shadowRoot.getElementById(id); }
    $$(sel) { return this.shadowRoot.querySelectorAll(sel); }

    // A document-level click listener sees `event.target` retargeted to
    // this element itself for anything that happened inside the shadow
    // tree — composedPath() finds the real originating element, needed
    // here to correctly detect a click on a `.filter-icon` (shadow-
    // internal) vs. on the escaped dropdown itself (real light DOM, not
    // retargeted).
    _handleOutsideFilterClick(e) {
        if (!this.currentDropdown) return;
        const clickedFilterIcon = e.composedPath().some(el => el.classList && el.classList.contains('filter-icon'));
        if (!this.currentDropdown.contains(e.target) && !clickedFilterIcon) this.closeFilterMenu();
    }

    setDarkMode(isDark) {
        if (isDark) this.classList.add('dark-mode');
        else this.classList.remove('dark-mode');
    }

    // Public alias matching the other views' openSettings() API — the
    // shell calls this instead of posting an OPEN_SETTINGS message now.
    openSettings() { this.openSettingsModal(); }

    async loadSiteName() {
        try {
            const { data, error } = await this._supabase
                .from('launchpad_projects')
                .select('project_key, client_name')
                .eq('project_key', this.PROJECT_KEY)
                .maybeSingle();
            if (error) throw error;
            const siteName = (data && (data.project_key || data.client_name)) || this.PROJECT_KEY;
            this.SITE_NAME = siteName;
            const el = this.$('zone-title-display');
            if (el) el.innerText = siteName;
        } catch (e) {
            console.error('Failed to load site name from launchpad_projects:', e);
        }
    }

    async fetchTrackerConfig() {
        try {
            const { data, error } = await this._supabase
                .from('launchpad_equipment_tracker_config')
                .select('config')
                .eq('project_key', this.PROJECT_KEY)
                .maybeSingle();
            if (error) throw error;
            return (data && data.config) || null;
        } catch (e) {
            console.error('Failed to load Equipment Tracker config from Supabase:', e);
            return null;
        }
    }

    getDynamicStyle(value, type = 'checklist', isOverallStatus = false) {
        const globalConfig = this.globalConfig;
        let fbColor = isOverallStatus ? (globalConfig.fallbackColor || '#f5f5f5') : '#f5f5f5';
        let fbStyle = `background-color:${fbColor}; color:${getContrastYIQ(fbColor)};`;
        let emptyStyle = `background-color:#f5f5f5; color:#616161;`;

        if (value === undefined || value === null || value === "N/A" || value === "Clear" || value === "" || value === "-") {
            return emptyStyle;
        }

        let lowerVal = String(value).toLowerCase().trim();

        if (globalConfig.phaseRules && Array.isArray(globalConfig.phaseRules) && globalConfig.phaseRules.length > 0) {
            let ruleMatch = globalConfig.phaseRules.find(r => r.resultingStatus && lowerVal === String(r.resultingStatus).toLowerCase().trim());
            if (!ruleMatch) ruleMatch = globalConfig.phaseRules.find(r => r.resultingStatus && lowerVal.includes(String(r.resultingStatus).toLowerCase().trim()));

            if (ruleMatch && ruleMatch.color) {
                return `background-color:${ruleMatch.color}; color:${getContrastYIQ(ruleMatch.color)};`;
            }
        }

        let openArr = globalConfig.openStatuses || [];
        let closedArr = globalConfig.closedStatuses || [];
        let cxCompleteArr = globalConfig.cxCompleteStatuses || [];

        if (type === 'test') {
            openArr = globalConfig.testOpenStatuses || [];
            closedArr = globalConfig.testClosedStatuses || [];
            cxCompleteArr = [];
        } else if (type === 'issue') {
            openArr = globalConfig.issueOpenStatuses || [];
            closedArr = globalConfig.issueClosedStatuses || [];

            if (isNaN(lowerVal)) {
                let priColor = null;
                let statColor = null;

                let priMatch = globalConfig.gatingIssues.find(s => s.name && lowerVal.includes(String(s.name).toLowerCase().trim())) ||
                               globalConfig.nonGatingIssues.find(s => s.name && lowerVal.includes(String(s.name).toLowerCase().trim()));
                if (priMatch) priColor = priMatch.color;

                let statMatch = openArr.find(s => s.name && lowerVal.includes(String(s.name).toLowerCase().trim())) ||
                                closedArr.find(s => s.name && lowerVal.includes(String(s.name).toLowerCase().trim()));
                if (statMatch) statColor = statMatch.color;

                if (priColor && statColor) {
                    return `background: linear-gradient(135deg, ${priColor} 50%, ${statColor} 50%); color: #111; text-shadow: -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff;`;
                } else if (priColor) {
                    return `background-color:${priColor}; color:${getContrastYIQ(priColor)};`;
                } else if (statColor) {
                    return `background-color:${statColor}; color:${getContrastYIQ(statColor)};`;
                }
            }
        }

        let exactCx = cxCompleteArr.find(s => s.name && lowerVal === String(s.name).toLowerCase().trim());
        if (exactCx) return `background-color:${exactCx.color}; color:${getContrastYIQ(exactCx.color)};`;

        let exactClosed = closedArr.find(s => s.name && lowerVal === String(s.name).toLowerCase().trim());
        if (exactClosed) return `background-color:${exactClosed.color}; color:${getContrastYIQ(exactClosed.color)};`;
        let exactOpen = openArr.find(s => s.name && lowerVal === String(s.name).toLowerCase().trim());
        if (exactOpen) return `background-color:${exactOpen.color}; color:${getContrastYIQ(exactOpen.color)};`;

        if (type === 'issue') {
            let gateMatch = globalConfig.gatingIssues.find(s => s.name && lowerVal.includes(String(s.name).toLowerCase().trim()));
            if (gateMatch) return `background-color:${gateMatch.color}; color:${getContrastYIQ(gateMatch.color)};`;
            let nonGateMatch = globalConfig.nonGatingIssues.find(s => s.name && lowerVal.includes(String(s.name).toLowerCase().trim()));
            if (nonGateMatch) return `background-color:${nonGateMatch.color}; color:${getContrastYIQ(nonGateMatch.color)};`;
        }

        let matchCx = cxCompleteArr.find(s => s.name && lowerVal.includes(String(s.name).toLowerCase().trim()));
        if (matchCx) return `background-color:${matchCx.color}; color:${getContrastYIQ(matchCx.color)};`;

        let matchClosed = closedArr.find(s => s.name && lowerVal.includes(String(s.name).toLowerCase().trim()));
        if (matchClosed) return `background-color:${matchClosed.color}; color:${getContrastYIQ(matchClosed.color)};`;
        let matchOpen = openArr.find(s => s.name && lowerVal.includes(String(s.name).toLowerCase().trim()));
        if (matchOpen) return `background-color:${matchOpen.color}; color:${getContrastYIQ(matchOpen.color)};`;

        if (lowerVal.includes('no cl') || lowerVal.includes('no l4') || lowerVal.includes('no l3')) return emptyStyle;

        if (!isNaN(lowerVal) && lowerVal !== '') {
            let num = parseFloat(lowerVal);
            if (num === 0) return 'background-color:#e1f5fe; color:#01579b;';
            if (num > 0) {
                if (openArr.length > 0 && openArr[0].color) return `background-color:${openArr[0].color}; color:${getContrastYIQ(openArr[0].color)};`;
                return 'background-color:#ffcdd2; color:#b71c1c;';
            }
        }
        return isOverallStatus ? fbStyle : emptyStyle;
    }

    generateGateHeaderHTML(level, maxCount, baseTitle, filterColIndex) { return generateGateHeaderHTML(level, maxCount, baseTitle, filterColIndex); }

    renderGateCells(row, level, maxCount, gateLabel) {
        // gateLabel defaults to the literal 'Gate' — every project except
        // MSA3A has no Apps Script checklistTypesByPhase, so this stays
        // identical to the original behavior.
        gateLabel = gateLabel || 'Gate';
        let html = '';
        let type = (level === 'L4') ? 'test' : 'checklist';
        for (let i = 1; i <= maxCount; i++) {
            // Search the row object for whatever exact column name the backend used
            let gateKeyRegex = new RegExp(`^${level}\\s*${gateLabel}.*?${i}$`, 'i');
            let gateKey = Object.keys(row).find(k => gateKeyRegex.test(k)) || `${level} ${gateLabel} CL ${i}`;

            let val = row[gateKey] || '';
            let link = row[`${gateKey}_Link`] || row[`${gateKey} Link`] || '';

            html += this.renderStackedCell(val, `gate-cell ${level.toLowerCase()}-gate-col`, type, link);
        }
        return html;
    }

    renderStackedCell(val, extraClasses = '', type = 'checklist', link = '') {
        let id = '', status = '', styleStr = '', rawVal = '';
        if (val && val !== 'N/A' && val !== 'Clear' && val !== '-') {
            rawVal = String(val).trim();
            const match = rawVal.match(/(.+?)\s*\((.+)\)/);
            if (match) {
                id = match[1].trim(); status = match[2].trim();
                styleStr = this.getDynamicStyle(status, type, false);
            } else {
                id = rawVal; status = 'Unknown';
                styleStr = this.getDynamicStyle('Unknown', type, false);
            }
        }

        let idDisplay = id;
        let safeLink = String(link || '').trim();
        if (id !== '' && safeLink && safeLink !== 'undefined' && safeLink !== 'null' && safeLink !== '') {
            idDisplay = `<a href="${safeLink}" target="_blank" class="chk-link">${id}</a>`;
        }

        if (id === '') {
            return `<div class="filter-target stacked-cell ${extraClasses}" data-val="" data-link="">
                        <div class="checklist-header">-</div>
                        <div class="checklist-status" style="background-color:#f5f5f5; color:#616161;">-</div>
                    </div>`;
        } else {
            return `<div class="filter-target stacked-cell ${extraClasses}" data-val="${rawVal}" data-link="${safeLink}">
                        <div class="checklist-header">${idDisplay}</div>
                        <div class="checklist-status" style="${styleStr}">${status}</div>
                    </div>`;
        }
    }

    // supportTypes: [{label, maxCols, legacy}] — see generateHeaderHTML()'s
    // comment for the legacy-vs-named-type split.
    renderSupportCells(row, level, supportTypes) {
        let html = '';
        let type = (level === 'L4') ? 'test' : 'checklist';
        supportTypes.forEach((t, tIdx) => {
            const prefix = t.legacy ? `${level} Support` : `${level} ${t.label}`;
            for (let i = 1; i <= t.maxCols; i++) {
                const isVeryLast = (tIdx === supportTypes.length - 1 && i === t.maxCols) ? 'divider-right' : '';
                let cellVal = row[`${prefix} CL ${i}`];
                let cellLink = row[`${prefix} CL ${i}_Link`] || row[`${prefix} CL ${i} Link`];
                html += this.renderStackedCell(cellVal, `cell-row-detail col-details ${level.toLowerCase()}-supp-details cl-cell ${isVeryLast}`, type, cellLink).replace('filter-target', '');
            }
        });
        return html;
    }

    renderIssuesBlock(row, maxCount) {
        let gatingOpen = [], nonGatingOpen = [], gatingClosed = [], nonGatingClosed = [], emptyOrOther = [];
        let issueOpenArr = this.globalConfig.issueOpenStatuses || [];
        let issueClosedArr = this.globalConfig.issueClosedStatuses || [];
        let gatingArr = this.globalConfig.gatingIssues || [];

        for (let i = 1; i <= maxCount; i++) {
            let val = row[`Issue ${i}`];
            let link = row[`Issue ${i}_Link`] || row[`Issue ${i} Link`];
            let item = { val: val, link: link };

            if (val && val !== 'N/A' && val !== 'Clear' && val !== '-') {
                let rawVal = String(val).trim();
                const match = rawVal.match(/(.+?)\s*\((.+)\)/);
                if (match) {
                    let status = match[2];
                    let isOpen = isStatusMatch(status, issueOpenArr) || !isStatusMatch(status, issueClosedArr);
                    let isClosed = isStatusMatch(status, issueClosedArr);
                    let isGating = isStatusMatch(status, gatingArr);

                    if (isOpen) {
                        if (isGating) gatingOpen.push(item);
                        else nonGatingOpen.push(item);
                    } else if (isClosed) {
                        if (isGating) gatingClosed.push(item);
                        else nonGatingClosed.push(item);
                    } else {
                        emptyOrOther.push(item);
                    }
                } else {
                    emptyOrOther.push(item);
                }
            } else {
                emptyOrOther.push(item);
            }
        }

        let sortedIssues = [...gatingOpen, ...nonGatingOpen, ...gatingClosed, ...nonGatingClosed, ...emptyOrOther];
        let html = '';

        for (let i = 0; i < sortedIssues.length; i++) {
            const isLast = (i === maxCount - 1) ? 'divider-right' : '';
            html += this.renderStackedCell(sortedIssues[i].val, `cell-row-detail col-details global-iss-details iss-cell ${isLast}`, 'issue', sortedIssues[i].link).replace('filter-target', '');
        }
        return html;
    }

    // --- FIX FOR FILTER BUG: Now returns rawText properly for parsing ---
    // supportTypes: [{label, maxCols, legacy}] — see generateHeaderHTML()'s
    // comment for the legacy-vs-named-type split.
    combineOpenSupportCLs(row, level, supportTypes) {
        let openIds = [];
        let rawIds = [];
        let closedArr = (level === 'L4') ? (this.globalConfig.testClosedStatuses || []) : (this.globalConfig.closedStatuses || []);
        // Cx Complete only applies to L2/L3 Support CLs — when that phase has
        // no Gate checklist to lean on, a Support CL marked Cx Complete
        // should stop counting as "open" too, not just ones marked plain Closed.
        let cxCompleteArr = (level === 'L4') ? [] : (this.globalConfig.cxCompleteStatuses || []);
        supportTypes.forEach(t => {
            const prefix = t.legacy ? `${level} Support` : `${level} ${t.label}`;
            for (let i = 1; i <= t.maxCols; i++) {
                const val = row[`${prefix} CL ${i}`];
                const link = row[`${prefix} CL ${i}_Link`] || row[`${prefix} CL ${i} Link`];
                if (val && val !== 'N/A' && val !== 'Clear' && String(val).trim() !== '') {
                    const match = String(val).match(/(.+?)\s*\((.+)\)/);
                    let id = ""; let include = false;
                    if (match) {
                        if (!isStatusMatch(match[2], closedArr) && !isStatusMatch(match[2], cxCompleteArr) && !String(match[2]).toLowerCase().includes('no cl')) {
                            id = match[1].trim(); include = true;
                        }
                    } else if (String(val).toLowerCase() !== 'no cl' && String(val).toLowerCase() !== 'unknown') {
                        id = String(val).trim(); include = true;
                    }
                    if (include) {
                        let safeLink = String(link || '').trim();
                        let idDisplay = (safeLink && safeLink !== 'undefined' && safeLink !== 'null' && safeLink !== '') ? `<a href="${safeLink}" target="_blank" class="chk-link">${id}</a>` : id;
                        openIds.push(idDisplay);
                        rawIds.push(id);
                    }
                }
            }
        });
        if (openIds.length === 0) return { display: "-", rawText: "-", count: 0 };
        return { display: openIds.join(', '), rawText: rawIds.join(', '), count: openIds.length };
    }

    combineOpenIssues(row, maxCount) {
        let openIds = [];
        let rawIds = [];
        let issueClosedArr = this.globalConfig.issueClosedStatuses || [];
        let gatingArr = this.globalConfig.gatingIssues || [];
        for (let i = 1; i <= maxCount; i++) {
            const val = row[`Issue ${i}`];
            const link = row[`Issue ${i} Link`] || row[`Issue ${i} Link`];
            if (val && val !== 'N/A' && val !== 'Clear' && String(val).trim() !== '') {
                const match = String(val).match(/(.+?)\s*\((.+)\)/);
                if (match) {
                    let status = match[2];
                    if (!isStatusMatch(status, issueClosedArr) && isStatusMatch(status, gatingArr)) {
                        let id = match[1].trim();
                        let safeLink = String(link || '').trim();
                        let idDisplay = (safeLink && safeLink !== 'undefined' && safeLink !== 'null' && safeLink !== '') ? `<a href="${safeLink}" target="_blank" class="chk-link">${id}</a>` : id;
                        openIds.push(idDisplay);
                        rawIds.push(id);
                    }
                }
            }
        }
        if (openIds.length === 0) return { display: "-", rawText: "-", count: 0 };
        return { display: openIds.join(', '), rawText: rawIds.join(', '), count: openIds.length };
    }

    updateHeaderElement(id, text, isSpan = false) {
        let el = this.$(id);
        if (el) {
            el.innerText = text;
            if (isSpan) el.setAttribute('data-original', text);
        }
    }

    async fetchTrackerData(isSilent = false) {
        try {
            // ONLY show the full-screen loading animation if it's the initial load
            if (!isSilent) {
                const overlay = this.$('loading-overlay');
                overlay.style.visibility = 'visible';
                overlay.style.opacity = '1';
                this.$('sync-status').innerText = 'Syncing...';
            }

            // Reads a periodically-synced snapshot from Supabase instead of
            // calling the Google Apps Script endpoint live on every load.
            // The Sheets-backed source data + Phase Rules (still Sheet-
            // maintained, per the comment below) are pushed into
            // launchpad_equipment_tracker_data on a timer — see
            // .github/workflows/sync-equipment-tracker-data.yml and
            // sync/sync-equipment-data.mjs — so this read is as fast as
            // everything else in the app instead of waiting on Apps
            // Script's cold-start + Sheets-read latency on every visit.
            const [{ data: syncedRow, error: syncedError }, supabaseConfig] = await Promise.all([
                this._supabase.from('launchpad_equipment_tracker_data')
                    .select('data, phase_rules, checklist_types_by_phase, synced_at')
                    .eq('project_key', this.PROJECT_KEY)
                    .maybeSingle(),
                this.fetchTrackerConfig()
            ]);
            if (syncedError) throw syncedError;
            const payload = {
                data: (syncedRow && syncedRow.data) || [],
                config: {
                    phaseRules: (syncedRow && syncedRow.phase_rules) || [],
                    checklistTypesByPhase: (syncedRow && syncedRow.checklist_types_by_phase) || {}
                }
            };

            const rows = payload.data || [];
            // Phase Rules and checklistTypesByPhase stay Apps-Script/Sheets-
            // backed by request — everything else (toggles, custom headers,
            // status lists) comes from the user-saved Supabase config. Both
            // sync-owned fields always win here even if an older Supabase
            // config row still has a leftover key of the same name, since
            // neither one is ever set through the Settings UI that writes
            // that row.
            const sheetPhaseRules = (payload.config && payload.config.phaseRules) || [];
            const sheetChecklistTypesByPhase = (payload.config && payload.config.checklistTypesByPhase) || {};
            if (supabaseConfig) this.globalConfig = { ...this.globalConfig, ...supabaseConfig };
            this.globalConfig.phaseRules = sheetPhaseRules;
            this.globalConfig.checklistTypesByPhase = sheetChecklistTypesByPhase;

            // --- PERF FIX: skip the (expensive) full grid rebuild if nothing has
            // actually changed since the last successful fetch. This matters most
            // for the silent 60s background poll, which would otherwise tear down
            // and rebuild every row's DOM every single minute even when the
            // underlying data is identical — resetting scroll position and any
            // open dropdown along the way.
            const fingerprint = JSON.stringify({ rows, config: supabaseConfig || null, phaseRules: sheetPhaseRules, checklistTypesByPhase: sheetChecklistTypesByPhase });
            if (isSilent && this.__lastTrackerFingerprint === fingerprint) {
                if (this.$('global-search-input').value.trim() === '') {
                    this.$('sync-status').innerText = 'Up to date ✓';
                }
                return;
            }
            this.__lastTrackerFingerprint = fingerprint;

            if (this.globalConfig.customHeaders) {
                // Site name is now owned by loadSiteName() (from launchpad_projects),
                // not the old customHeaders.zoneTitle setting — intentionally not
                // set here so it can't get clobbered back to a stale sheet value
                // on every refresh.
                this.updateHeaderElement('area-title', this.globalConfig.customHeaders.areaPrefix, true);
                this.updateHeaderElement('group-l2', this.globalConfig.customHeaders.l2Phase);
                this.updateHeaderElement('l2-gate-title', this.globalConfig.customHeaders.l2Gate, true);
                this.updateHeaderElement('l2-status-title', this.globalConfig.customHeaders.l2Status, true);
                this.updateHeaderElement('group-l3', this.globalConfig.customHeaders.l3Phase);
                this.updateHeaderElement('l3-gate-title', this.globalConfig.customHeaders.l3Gate, true);
                this.updateHeaderElement('l3-status-title', this.globalConfig.customHeaders.l3Status, true);
                this.updateHeaderElement('group-l4', this.globalConfig.customHeaders.l4Phase);
                this.updateHeaderElement('l4-gate-title', this.globalConfig.customHeaders.l4Gate, true);
                this.updateHeaderElement('l4-status-title', this.globalConfig.customHeaders.l4Status, true);
                this.updateHeaderElement('group-iss', this.globalConfig.customHeaders.issPhase);
                this.updateHeaderElement('iss-status-title', this.globalConfig.customHeaders.issStatus, true);
            }

            // Which checklist type plays "Gate" (singular, always-visible)
            // and which types play "Support" (collapsible, possibly many)
            // per phase — driven entirely by config.checklistTypesByPhase,
            // which only MSA3A's Apps Script currently produces. Every
            // other project falls through to the literal 'Gate'/'Support'
            // labels this always used, so nothing changes for them.
            const typesByPhase = this.globalConfig.checklistTypesByPhase;
            const gateLabelByPhase = {};
            const supportLabelListByPhase = {};
            ['L2', 'L3', 'L4'].forEach(level => {
                const types = (typesByPhase && typesByPhase[level] && typesByPhase[level].length) ? typesByPhase[level] : null;
                if (types) {
                    const tagLabel = types.find(l => l.toLowerCase() === 'tag');
                    gateLabelByPhase[level] = tagLabel || 'Gate';
                    supportLabelListByPhase[level] = tagLabel ? types.filter(l => l !== tagLabel) : types.slice();
                } else {
                    gateLabelByPhase[level] = 'Gate';
                    supportLabelListByPhase[level] = ['Support'];
                }
            });
            this.globalConfig.gateLabelByPhase = gateLabelByPhase;

            let actualMaxCols = { l2: 0, l3: 0, l4: 0, iss: 0, l2Gate: 1, l3Gate: 1, l4Gate: 1, byType: { L2: {}, L3: {}, L4: {} } };

            rows.forEach(row => {
                ['L2', 'L3', 'L4'].forEach(level => {
                    let key = level.toLowerCase();
                    let gateKey = key + 'Gate';
                    const gateLabel = gateLabelByPhase[level];
                    const byType = actualMaxCols.byType[level];

                    supportLabelListByPhase[level].forEach(label => {
                        for (let i = 1; i <= 100; i++) {
                            let val = row[`${level} ${label} CL ${i}`];
                            if (val !== undefined && val !== null) {
                                let clean = String(val).replace(/\(Unknown\)/ig, '').trim();
                                if (clean !== '' && clean !== 'N/A' && clean !== 'Clear' && clean !== '-') {
                                    byType[label] = Math.max(byType[label] || 0, i);
                                }
                            }
                        }
                    });

                    for (let i = 1; i <= 20; i++) {
                        let val = row[`${level} ${gateLabel} CL ${i}`] || row[`${level} ${gateLabel} ${i}`] || row[`${level} ${gateLabel} CL${i}`];
                        if (val !== undefined && val !== null) {
                            let clean = String(val).replace(/\(Unknown\)/ig, '').trim();
                            if (clean !== '' && clean !== 'N/A' && clean !== 'Clear' && clean !== '-') {
                                actualMaxCols[gateKey] = Math.max(actualMaxCols[gateKey], i);
                            }
                        }
                    }
                });
                for (let i = 1; i <= 200; i++) {
                    let val = row[`Issue ${i}`];
                    if (val !== undefined && val !== null) {
                        let clean = String(val).replace(/\(Unknown\)/ig, '').trim();
                        if (clean !== '' && clean !== 'N/A' && clean !== 'Clear' && clean !== '-') {
                            actualMaxCols.iss = Math.max(actualMaxCols.iss, i);
                        }
                    }
                }
            });

            // Roll up each phase's total Support column count (width calc
            // and "is there anything to show" checks already key off this
            // single number, unchanged) and build the per-type lists the
            // new render/header functions need.
            const supportTypesByPhase = {};
            ['L2', 'L3', 'L4'].forEach(level => {
                const legacy = supportLabelListByPhase[level].length === 1 && supportLabelListByPhase[level][0] === 'Support' && !(typesByPhase && typesByPhase[level] && typesByPhase[level].length);
                const list = supportLabelListByPhase[level]
                    .map(label => ({ label, maxCols: actualMaxCols.byType[level][label] || 0, legacy }))
                    .filter(t => t.maxCols > 0);
                supportTypesByPhase[level] = list;
                actualMaxCols[level.toLowerCase()] = list.reduce((sum, t) => sum + t.maxCols, 0);
            });
            this.globalConfig.supportTypesByPhase = supportTypesByPhase;
            this.globalConfig.maxCols = actualMaxCols;

            this.classList.toggle('hide-l2-gate', this.globalConfig.showL2Gate === false);
            this.classList.toggle('hide-l3-gate', this.globalConfig.showL3Gate === false);
            this.classList.toggle('hide-l4-gate', this.globalConfig.showL4Gate === false);

            // When BOTH Gate and Support are off for a phase, hide the
            // whole phase group — including its Status column and group
            // header — not just the Gate sub-column.
            this.classList.toggle('hide-l2-all', this.globalConfig.showL2Gate === false && this.globalConfig.showL2Supp === false);
            this.classList.toggle('hide-l3-all', this.globalConfig.showL3Gate === false && this.globalConfig.showL3Supp === false);
            this.classList.toggle('hide-l4-all', this.globalConfig.showL4Gate === false && this.globalConfig.showL4Supp === false);

            this.$$('.dynamic-header').forEach(el => el.remove());
            this.$$('.dynamic-gate-header').forEach(el => el.remove());

            let l2GateCol = this.shadowRoot.querySelector('.l2-gate-col:not(.dynamic-gate-header)');
            if (l2GateCol) l2GateCol.style.display = 'none';
            let l3GateCol = this.shadowRoot.querySelector('.l3-gate-col:not(.dynamic-gate-header)');
            if (l3GateCol) l3GateCol.style.display = 'none';
            let l4GateCol = this.shadowRoot.querySelector('.l4-gate-col:not(.dynamic-gate-header)');
            if (l4GateCol) l4GateCol.style.display = 'none';

            if (this.globalConfig.maxCols.l2 > 0) this.$('l2-supp-header').insertAdjacentHTML('afterend', generateHeaderHTML('L2', this.globalConfig.supportTypesByPhase.L2));
            if (this.globalConfig.maxCols.l3 > 0) this.$('l3-supp-header').insertAdjacentHTML('afterend', generateHeaderHTML('L3', this.globalConfig.supportTypesByPhase.L3));
            if (this.globalConfig.maxCols.l4 > 0) this.$('l4-supp-header').insertAdjacentHTML('afterend', generateHeaderHTML('L4', this.globalConfig.supportTypesByPhase.L4));
            if (this.globalConfig.maxCols.iss > 0) this.$('global-iss-header').insertAdjacentHTML('afterend', generateIssHeaderHTML(this.globalConfig.maxCols.iss));

            const l2Title = this.globalConfig.customHeaders?.l2Gate || 'Gate CL';
            const l3Title = this.globalConfig.customHeaders?.l3Gate || 'Gate CL';
            const l4Title = this.globalConfig.customHeaders?.l4Gate || 'Gate CL';

            this.$('l2-supp-header').insertAdjacentHTML('beforebegin', generateGateHeaderHTML('L2', this.globalConfig.maxCols.l2Gate, l2Title, 2));
            this.$('l3-supp-header').insertAdjacentHTML('beforebegin', generateGateHeaderHTML('L3', this.globalConfig.maxCols.l3Gate, l3Title, 4));
            this.$('l4-supp-header').insertAdjacentHTML('beforebegin', generateGateHeaderHTML('L4', this.globalConfig.maxCols.l4Gate, l4Title, 6));

            ['l2', 'l3', 'l4'].forEach(lvl => {
                let btn = this.shadowRoot.querySelector(`.expand-btn[data-target="${lvl}-supp"]`);
                if (btn) btn.style.display = (this.globalConfig.maxCols[lvl] > 0 && this.globalConfig[`show${lvl.toUpperCase()}Supp`] !== false) ? 'flex' : 'none';
            });
            let issBtn = this.shadowRoot.querySelector(`.expand-btn[data-target="global-iss"]`);
            if (issBtn) issBtn.style.display = this.globalConfig.maxCols.iss > 0 ? 'flex' : 'none';

            let gateL2 = this.globalConfig.showL2Gate !== false ? (this.globalConfig.maxCols.l2Gate * 100) : 0;
            let gateL3 = this.globalConfig.showL3Gate !== false ? (this.globalConfig.maxCols.l3Gate * 100) : 0;
            let gateL4 = this.globalConfig.showL4Gate !== false ? (this.globalConfig.maxCols.l4Gate * 100) : 0;
            let summaryW = 190;

            this.$('group-l2').style.flex = `0 0 ${gateL2 + summaryW}px`;
            this.$('group-l3').style.flex = `0 0 ${gateL3 + summaryW}px`;
            this.$('group-l4').style.flex = `0 0 ${gateL4 + summaryW}px`;
            this.$('group-iss').style.flex = `0 0 ${summaryW}px`;

            this.$('group-l2').style.width = (gateL2 + summaryW) + 'px';
            this.$('group-l3').style.width = (gateL3 + summaryW) + 'px';
            this.$('group-l4').style.width = (gateL4 + summaryW) + 'px';
            this.$('group-iss').style.width = summaryW + 'px';

            const container = this.$('tracker-rows');
            let htmlChunks = [];

            this.rowFilterData = [];

            rows.forEach(row => {
                const assetId = row['Asset'] || 'N/A';
                const assetLink = row['Asset_Link'];

                const assetDisplay = assetLink ? `<a href="${assetLink}" target="_blank" class="asset-link">${assetId}</a>` : assetId;
                const areaVal = row['Area'] || 'N/A';

                const l2Open = this.combineOpenSupportCLs(row, 'L2', this.globalConfig.supportTypesByPhase.L2);
                const l3Open = this.combineOpenSupportCLs(row, 'L3', this.globalConfig.supportTypesByPhase.L3);
                const l4Open = this.combineOpenSupportCLs(row, 'L4', this.globalConfig.supportTypesByPhase.L4);
                const issuesOpen = this.combineOpenIssues(row, this.globalConfig.maxCols.iss);

                const gateLabelByPhase = this.globalConfig.gateLabelByPhase || { L2: 'Gate', L3: 'Gate', L4: 'Gate' };
                let fVal0 = String(assetId).trim();
                let fVal1 = String(areaVal).trim();
                let fVal2 = getGateVal(row[`L2 ${gateLabelByPhase.L2} CL 1`]);
                let fVal3 = String(row['L2 Overall Status'] || 'N/A').trim();
                let fVal4 = getGateVal(row[`L3 ${gateLabelByPhase.L3} CL 1`]);
                let fVal5 = String(row['L3 Overall Status'] || 'N/A').trim();
                let fVal6 = getGateVal(row[`L4 ${gateLabelByPhase.L4} CL 1`]);
                let fVal7 = String(row['L4 Overall Status'] || 'N/A').trim();
                let fVal8 = String(issuesOpen.rawText).trim();

                this.rowFilterData.push({ 0: fVal0, 1: fVal1, 2: fVal2, 3: fVal3, 4: fVal4, 5: fVal5, 6: fVal6, 7: fVal7, 8: fVal8 });

                const rowHTML = `
                <div class="cell-row">
                    <div class="frozen-combined group-asset-details">
                        <div class="filter-target asset-part" data-col="0" data-val="${assetId}" title="${assetId}">${assetDisplay}</div>
                        <div class="filter-target area-part" data-col="1" data-val="${areaVal}" title="${areaVal}">${areaVal}</div>
                    </div>
                    <div class="phase-gap"></div>

                    ${this.renderGateCells(row, 'L2', this.globalConfig.maxCols.l2Gate, gateLabelByPhase.L2)}
                    <div class="filter-target summary-cell l2-supp-summary divider-right" style="${this.getDynamicStyle(row['L2 Overall Status'], 'checklist', true)}" data-val="${row['L2 Overall Status'] || 'N/A'}">${row['L2 Overall Status'] || 'N/A'}</div>
                    ${this.renderSupportCells(row, 'L2', this.globalConfig.supportTypesByPhase.L2)}
                    <div class="phase-gap"></div>

                    ${this.renderGateCells(row, 'L3', this.globalConfig.maxCols.l3Gate, gateLabelByPhase.L3)}
                    <div class="filter-target summary-cell l3-supp-summary divider-right" style="${this.getDynamicStyle(row['L3 Overall Status'], 'checklist', true)}" data-val="${row['L3 Overall Status'] || 'N/A'}">${row['L3 Overall Status'] || 'N/A'}</div>
                    ${this.renderSupportCells(row, 'L3', this.globalConfig.supportTypesByPhase.L3)}
                    <div class="phase-gap"></div>

                    ${this.renderGateCells(row, 'L4', this.globalConfig.maxCols.l4Gate, gateLabelByPhase.L4)}
                    <div class="filter-target summary-cell l4-supp-summary divider-right" style="${this.getDynamicStyle(row['L4 Overall Status'], 'test', true)}" data-val="${row['L4 Overall Status'] || 'N/A'}">${row['L4 Overall Status'] || 'N/A'}</div>
                    ${this.renderSupportCells(row, 'L4', this.globalConfig.supportTypesByPhase.L4)}
                    <div class="phase-gap"></div>

                    <div class="filter-target summary-cell global-iss-summary divider-right" style="${this.getDynamicStyle(issuesOpen.count, 'issue', false)}" data-val="${fVal8}">${issuesOpen.display}</div>
                    ${this.renderIssuesBlock(row, this.globalConfig.maxCols.iss)}
                </div>`;
                htmlChunks.push(rowHTML);
            });

            container.innerHTML = htmlChunks.join('');
            this.rowNodes = Array.from(this.$$('.cell-row'));

            // Only update this label if the user hasn't typed in the search bar
            if (this.$('global-search-input').value.trim() === '') {
                this.$('sync-status').innerText = 'Up to date ✓';
            }

            if (!isSilent) {
                const overlay = this.$('loading-overlay');
                overlay.style.opacity = '0';
                setTimeout(() => {
                    overlay.style.visibility = 'hidden';
                }, 400);
            }
            // Re-apply any active column filters (and the global search)
            // against the freshly-rendered rows — previously this only ran
            // on a silent background refresh, so clicking "Refresh Data"
            // manually silently dropped whatever filters were active.
            this.executeFilters();

        } catch (error) {
            console.error("Fetch Exception: ", error);
            this.$('sync-status').innerText = 'Sync Failed 🔴 (Check Console)';
        }
    }

    init() {
        // 1. Boot up the tracker data grid normally
        this.fetchTrackerData(false);
        this.loadSiteName();
        // Automatic background polling removed — data now refreshes only
        // on initial load or when the user clicks "Refresh Data" above.
        // (The old REQUEST_AUTH_STATUS handshake with the parent window
        // that used to run here is gone too — isAdmin was never actually
        // used anywhere in this file once received.)
    }

    openSettingsModal() {
        this.$('settings-modal').classList.add('active');
        this.$('fallback-color-picker').value = this.globalConfig.fallbackColor || '#f5f5f5';
        if (this.globalConfig.customHeaders) {
            this.$('cust-zone-title').value = this.$('zone-title-display').innerText || this.PROJECT_KEY;
            this.$('cust-area-prefix').value = this.globalConfig.customHeaders.areaPrefix || 'Area';
            this.$('cust-l2-phase').value = this.globalConfig.customHeaders.l2Phase;
            this.$('cust-l2-gate').value = this.globalConfig.customHeaders.l2Gate;
            this.$('cust-l2-status').value = this.globalConfig.customHeaders.l2Status;
            this.$('cust-l3-phase').value = this.globalConfig.customHeaders.l3Phase;
            this.$('cust-l3-gate').value = this.globalConfig.customHeaders.l3Gate;
            this.$('cust-l3-status').value = this.globalConfig.customHeaders.l3Status;
            this.$('cust-l4-phase').value = this.globalConfig.customHeaders.l4Phase;
            this.$('cust-l4-gate').value = this.globalConfig.customHeaders.l4Gate;
            this.$('cust-l4-status').value = this.globalConfig.customHeaders.l4Status;
            this.$('cust-iss-phase').value = this.globalConfig.customHeaders.issPhase;
            this.$('cust-iss-status').value = this.globalConfig.customHeaders.issStatus;
        }
        this.$('show-l2-gate').checked = this.globalConfig.showL2Gate !== false;

        this.$('show-l3-gate').checked = this.globalConfig.showL3Gate !== false;
        this.$('show-l4-gate').checked = this.globalConfig.showL4Gate !== false;
        this.$('show-l2-supp').checked = this.globalConfig.showL2Supp !== false;
        this.$('show-l3-supp').checked = this.globalConfig.showL3Supp !== false;
        this.$('show-l4-supp').checked = this.globalConfig.showL4Supp !== false;

        const map = {
            'cl-open-list': this.globalConfig.openStatuses, 'cl-closed-list': this.globalConfig.closedStatuses,
            'cl-cxcomplete-list': this.globalConfig.cxCompleteStatuses,
            'test-open-list': this.globalConfig.testOpenStatuses, 'test-closed-list': this.globalConfig.testClosedStatuses,
            'iss-open-list': this.globalConfig.issueOpenStatuses, 'iss-closed-list': this.globalConfig.issueClosedStatuses,
            'iss-gating-list': this.globalConfig.gatingIssues, 'iss-nongating-list': this.globalConfig.nonGatingIssues
        };
        for (let id in map) {
            let container = this.$(id);
            container.innerHTML = '';
            if (map[id]) { map[id].forEach(s => container.appendChild(this.createRowHTML(s.name, s.color))); }
        }

        const prList = this.$('phase-rules-list');
        prList.innerHTML = '';
        if (this.globalConfig.phaseRules) {
            this.globalConfig.phaseRules.forEach(rule => this.addPhaseRuleRow(rule));
        }
    }

    closeSettingsModal() { this.$('settings-modal').classList.remove('active'); }

    createRowHTML(name, color) {
        const div = document.createElement('div'); div.className = 'status-row';
        div.innerHTML = `<input type="text" class="s-name" value="${name}" placeholder="Status text..."><input type="color" class="s-color" value="${color}"><button class="btn btn-del" onclick="this.parentElement.remove()">🗑</button>`;
        return div;
    }

    addStatusRow(listId, defaultColor) { this.$(listId).appendChild(this.createRowHTML('', defaultColor)); }

    addPhaseRuleRow(r = {}) {
        const tbody = this.$('phase-rules-list');
        const tr = document.createElement('tr');
        tr.className = 'rule-row';
        tr.innerHTML = `
            <td><input type="checkbox" class="r-active" ${r.active !== false && r.active !== 'false' && r.active !== 'FALSE' ? 'checked' : ''}></td>
            <td><select class="r-phase"><option value="L2" ${r.phase == 'L2' ? 'selected' : ''}>L2</option><option value="L3" ${r.phase == 'L3' ? 'selected' : ''}>L3</option><option value="L4" ${r.phase == 'L4' ? 'selected' : ''}>L4</option></select></td>
            <td><input type="text" class="r-prev" value="${r.prevStatus || ''}" placeholder="e.g. Complete"></td>
            <td><input type="text" class="r-mg" value="${r.maxGate !== undefined ? r.maxGate : ''}" placeholder="e.g. <=0"></td>
            <td><input type="text" class="r-ms" value="${r.maxSupport !== undefined ? r.maxSupport : ''}" placeholder="e.g. >0"></td>
            <td><input type="text" class="r-mspcx" value="${r.maxSupportPendingCx !== undefined ? r.maxSupportPendingCx : ''}" placeholder="e.g. =0" title="Max closed checklists waiting for Cx Approval"></td>
            <td><input type="text" class="r-mgi" value="${r.maxGatingIssues !== undefined ? r.maxGatingIssues : ''}" placeholder="=0"></td>
            <td><input type="text" class="r-mngi" value="${r.maxNonGatingIssues !== undefined ? r.maxNonGatingIssues : ''}" placeholder="<=5"></td>
            <td><input type="text" class="r-res" value="${r.resultingStatus || ''}" placeholder="Result"></td>
            <td style="text-align:center;"><input type="checkbox" class="r-inc-chk" ${r.includeOpenCHKs === true || String(r.includeOpenCHKs).toLowerCase() === 'true' ? 'checked' : ''}></td>
            <td style="text-align:center;"><input type="checkbox" class="r-inc-gate-iss" ${r.includeOpenGatingIssues === true || String(r.includeOpenGatingIssues).toLowerCase() === 'true' ? 'checked' : ''}></td>
            <td><input type="color" class="r-color" value="${r.color || '#e0e0e0'}"></td>
            <td><button class="btn btn-del" style="padding:4px 8px;" onclick="this.closest('tr').remove()">🗑</button></td>
        `;
        tbody.appendChild(tr);
    }

    getListValues(listId) {
        return Array.from(this.$$(`#${listId} .status-row`)).map(row => ({
            name: row.querySelector('.s-name').value.trim(), color: row.querySelector('.s-color').value
        })).filter(s => s.name !== '');
    }

    async saveSettings() {
        const btn = this.shadowRoot.querySelector('.btn-save');
        btn.innerText = 'Saving...'; btn.disabled = true;

        const prRows = this.$$('.rule-row');
        const newPhaseRules = Array.from(prRows).map(row => ({
            active: row.querySelector('.r-active').checked,
            phase: row.querySelector('.r-phase').value,
            prevStatus: row.querySelector('.r-prev').value.trim(),
            maxGate: row.querySelector('.r-mg').value.trim(),
            maxSupport: row.querySelector('.r-ms').value.trim(),
            maxSupportPendingCx: row.querySelector('.r-mspcx').value.trim(),
            maxGatingIssues: row.querySelector('.r-mgi').value.trim(),
            maxNonGatingIssues: row.querySelector('.r-mngi').value.trim(),
            resultingStatus: row.querySelector('.r-res').value.trim(),
            includeOpenCHKs: row.querySelector('.r-inc-chk').checked,
            includeOpenGatingIssues: row.querySelector('.r-inc-gate-iss').checked,
            color: row.querySelector('.r-color').value
        }));

        let newCustomHeaders = {
            zoneTitle: this.$('cust-zone-title').value.trim(),
            areaPrefix: this.$('cust-area-prefix').value.trim(),
            l2Phase: this.$('cust-l2-phase').value.trim(), l2Gate: this.$('cust-l2-gate').value.trim(), l2Status: this.$('cust-l2-status').value.trim(),
            l3Phase: this.$('cust-l3-phase').value.trim(), l3Gate: this.$('cust-l3-gate').value.trim(), l3Status: this.$('cust-l3-status').value.trim(),
            l4Phase: this.$('cust-l4-phase').value.trim(), l4Gate: this.$('cust-l4-gate').value.trim(), l4Status: this.$('cust-l4-status').value.trim(),
            issPhase: this.$('cust-iss-phase').value.trim(), issStatus: this.$('cust-iss-status').value.trim()
        };

        const payload = {
            openStatuses: this.getListValues('cl-open-list'), closedStatuses: this.getListValues('cl-closed-list'),
            cxCompleteStatuses: this.getListValues('cl-cxcomplete-list'),
            testOpenStatuses: this.getListValues('test-open-list'), testClosedStatuses: this.getListValues('test-closed-list'),
            issueOpenStatuses: this.getListValues('iss-open-list'), issueClosedStatuses: this.getListValues('iss-closed-list'),
            gatingIssues: this.getListValues('iss-gating-list'), nonGatingIssues: this.getListValues('iss-nongating-list'),
            fallbackColor: this.$('fallback-color-picker').value,
            customHeaders: newCustomHeaders,
            showL2Gate: this.$('show-l2-gate').checked,
            showL3Gate: this.$('show-l3-gate').checked,
            showL4Gate: this.$('show-l4-gate').checked,
            showL2Supp: this.$('show-l2-supp').checked,
            showL3Supp: this.$('show-l3-supp').checked,
            showL4Supp: this.$('show-l4-supp').checked,
            // Phase Rules stay Google-Sheets-backed by request. They ride
            // along in this SAME request (as payload.phaseRules, an array
            // of objects) rather than a separate 'setPhaseRulesOnly' call —
            // Apps Script's doPost has no action by that name; it only
            // recognizes an untagged request and reads payload.phaseRules
            // straight off it, alongside every other setting below.
            phaseRules: newPhaseRules
        };

        try {
            const [sheetResp, supabaseResult] = await Promise.all([
                fetch(this.API_URL, {
                    method: 'POST',
                    body: JSON.stringify(payload)
                }),
                // Supabase gets everything except phaseRules (that field is
                // harmless if present, but fetchTrackerConfig() never reads
                // it — the Sheet stays the source of truth for rules).
                this._supabase.from('launchpad_equipment_tracker_config').upsert({
                    project_key: this.PROJECT_KEY,
                    config: payload,
                    // This view isn't currently passed the logged-in user's
                    // email (unlike bridge.html's ?email= param) — wire that up
                    // via index.html's mount attributes if you want real attribution here.
                    updated_by: null
                }, { onConflict: 'project_key' })
            ]);
            if (supabaseResult.error) throw supabaseResult.error;
            let sheetJson = null;
            try { sheetJson = await sheetResp.json(); } catch (e) { /* non-JSON/opaque response, ignore */ }
            if (sheetJson && sheetJson.success === false) throw new Error(sheetJson.error || 'Settings save failed');
            window.location.reload();
        } catch (e) {
            console.error("Save failed", e); alert("Failed to save settings.");
            btn.innerText = 'Save & Sync to Sheet'; btn.disabled = false;
        }
    }

    toggleExpansion(level) {
        try {
            let lvl = level.toLowerCase();
            const state = !this.expandedStates[lvl];
            this.expandedStates[lvl] = state;

            this.$$(`.${lvl}-supp-details`).forEach(el => {
                if (state) el.classList.add('expanded');
                else el.classList.remove('expanded');
            });

            const btn = this.shadowRoot.querySelector(`.expand-btn[data-target="${lvl}-supp"]`);
            if (btn) {
                btn.textContent = state ? "-" : "+";
                btn.style.background = state ? "#b71c1c" : "#4caf50";
            }

            let maxCols = this.globalConfig.maxCols[lvl] || 0;
            let maxGateCols = this.globalConfig.maxCols[lvl + 'Gate'] || 1;
            let isGateShown = this.globalConfig[`show${level.toUpperCase()}Gate`] !== false;
            let isSuppShown = this.globalConfig[`show${level.toUpperCase()}Supp`] !== false;

            let gateWidth = isGateShown ? (maxGateCols * 100) : 0;
            let summaryWidth = 190;
            let baseWidth = gateWidth + summaryWidth;
            let exactWidth = (state && isSuppShown) ? (baseWidth + (maxCols * 100)) : baseWidth;

            let headerGroup = this.$(`group-${lvl}`);
            if (headerGroup) {
                headerGroup.style.flex = `0 0 ${exactWidth}px`;
                headerGroup.style.width = `${exactWidth}px`;
                headerGroup.style.minWidth = `${exactWidth}px`;
                headerGroup.style.maxWidth = `${exactWidth}px`;
            }
        } catch (e) { console.error("Expansion Error: ", e); }
    }

    toggleGlobalIssues() {
        try {
            const state = !this.expandedStates.iss;
            this.expandedStates.iss = state;

            this.$$(`.global-iss-details`).forEach(el => {
                if (state) el.classList.add('expanded');
                else el.classList.remove('expanded');
            });

            const btn = this.shadowRoot.querySelector(`.expand-btn[data-target="global-iss"]`);
            if (btn) {
                btn.textContent = state ? "-" : "+";
                btn.style.background = state ? "#b71c1c" : "#4caf50";
            }

            let summaryWidth = 190;
            let maxIss = this.globalConfig.maxCols.iss || 0;
            let exactIssWidth = state ? (summaryWidth + (maxIss * 100)) : summaryWidth;

            let issGroup = this.$(`group-iss`);
            if (issGroup) {
                issGroup.style.flex = `0 0 ${exactIssWidth}px`;
                issGroup.style.width = `${exactIssWidth}px`;
                issGroup.style.minWidth = `${exactIssWidth}px`;
                issGroup.style.maxWidth = `${exactIssWidth}px`;
            }
        } catch (e) { console.error("Issue Expansion Error: ", e); }
    }

    // Cascading filters: the values offered for one column should narrow
    // down to whatever's actually still reachable given every OTHER
    // active filter, not the full, static set of values across all rows
    // (this.filterCache) regardless of what else is already filtered.
    // Recomputed fresh each time a dropdown opens — rowFilterData is a
    // flat array of plain values, so this stays cheap even for thousands
    // of rows.
    getAvailableValuesForColumn(colIndex) {
        const values = new Set();
        for (const rData of this.rowFilterData) {
            let passesOtherFilters = true;
            for (const col in this.activeFilters) {
                if (Number(col) === colIndex) continue; // don't filter a column by itself
                if (!this.activeFilters[col].has(rData[col])) { passesOtherFilters = false; break; }
            }
            if (passesOtherFilters) values.add(rData[colIndex]);
        }
        return values;
    }

    // The filter dropdown itself is deliberately appended to the real
    // document.body (not this.shadowRoot) so it can escape
    // .tracker-container's overflow:auto clipping — see the
    // FILTER_DROPDOWN_STYLE comment above.
    toggleFilter(event, colIndex) {
        event.stopPropagation();
        if (this.currentDropdown) { let wasSame = (this.currentDropdown.dataset.col == colIndex); this.closeFilterMenu(); if (wasSame) return; }

        // Values available given every OTHER active filter — see
        // getAvailableValuesForColumn() above for why this isn't just the
        // static this.filterCache[colIndex] anymore.
        const uniqueValues = this.getAvailableValuesForColumn(colIndex);

        const dropdown = document.createElement('div'); dropdown.className = 'filter-dropdown'; dropdown.dataset.col = colIndex;

        const rect = event.target.getBoundingClientRect();
        let dropTop = rect.bottom + 5;
        let dropLeft = rect.left - 120;
        if (dropLeft < 10) dropLeft = 10;
        if (dropLeft + 200 > window.innerWidth) dropLeft = window.innerWidth - 200;

        dropdown.style.top = dropTop + 'px'; dropdown.style.left = dropLeft + 'px';

        dropdown.innerHTML = `
            <input type="text" id="filter-search" class="filter-search-input" placeholder="Search values..." autocomplete="off">
            <label style="font-weight:bold; border-bottom:1px solid #ddd; padding-bottom:8px; margin-bottom:8px; cursor:pointer; display:block;">
                <input type="checkbox" id="filter-select-all" checked style="margin-right:8px; cursor:pointer;"> (Select All)
            </label>
            <div id="filter-loading" style="padding: 10px; font-size: 12px; color: #777; text-align: center;">Loading...</div>
            <div id="val-container" style="overflow-y: auto; flex: 1; display: none;"></div>
            <div class="filter-actions" style="margin-top: 10px; display: flex; justify-content: space-between; border-top: 1px solid #eee; padding-top: 10px;">
                <button class="filter-btn clear" id="filter-clear-btn">Clear</button>
                <button class="filter-btn" id="filter-ok-btn">OK</button>
            </div>
        `;
        document.body.appendChild(dropdown);
        this.currentDropdown = dropdown;

        // This dropdown lives in the real document.body, not this element's
        // shadow root (see the class comment above toggleFilter), so
        // onclick="this.getRootNode().host.foo()" won't work here — getRootNode()
        // on a light-DOM element returns the plain Document, which has no
        // .host. Real addEventListener callbacks close over `this` correctly
        // instead, same as the search/select-all/checkbox listeners below.
        dropdown.querySelector('#filter-clear-btn').addEventListener('click', () => this.clearFilter(colIndex));
        dropdown.querySelector('#filter-ok-btn').addEventListener('click', () => this.applyFilter(colIndex));

        // --- ASYNCHRONOUS RENDERING (Unfreezes the mouse) ---
        setTimeout(() => {
            const valContainer = dropdown.querySelector('#val-container');

            let valHTML = [];
            Array.from(uniqueValues).sort().forEach(val => {
                const isChecked = this.activeFilters[colIndex] ? this.activeFilters[colIndex].has(val) : true;
                const safeVal = val.replace(/"/g, '&quot;');
                valHTML.push(`<label class="filter-val-label" style="display:block; margin-bottom: 6px; cursor: pointer;"><input type="checkbox" value="${safeVal}" style="margin-right:8px; cursor:pointer;" ${isChecked ? 'checked' : ''}><span class="val-text">${val || '(Blank)'}</span></label>`);
            });
            valContainer.innerHTML = valHTML.join('');

            dropdown.querySelector('#filter-loading').style.display = 'none';
            valContainer.style.display = 'block';

            const searchInput = dropdown.querySelector('#filter-search');
            const selectAllCb = dropdown.querySelector('#filter-select-all');

            if (this.activeFilters[colIndex] && this.activeFilters[colIndex].size < uniqueValues.size) selectAllCb.checked = false;

            // --- EVENT DELEGATION ---
            searchInput.addEventListener('input', (e) => {
                const term = e.target.value.toLowerCase();
                let vis = 0, chkVis = 0;
                valContainer.style.display = 'none';
                const labels = valContainer.children;
                for (let i = 0; i < labels.length; i++) {
                    let lbl = labels[i];
                    if (lbl.textContent.toLowerCase().includes(term)) {
                        lbl.style.display = 'block';
                        vis++;
                        if (lbl.querySelector('input').checked) chkVis++;
                    } else {
                        lbl.style.display = 'none';
                    }
                }
                valContainer.style.display = 'block';
                selectAllCb.checked = (vis > 0 && vis === chkVis);
            });

            selectAllCb.addEventListener('change', (e) => {
                const isChecked = e.target.checked;
                const labels = valContainer.children;
                for (let i = 0; i < labels.length; i++) {
                    let lbl = labels[i];
                    if (lbl.style.display !== 'none') {
                        lbl.querySelector('input').checked = isChecked;
                    }
                }
            });

            valContainer.addEventListener('change', (e) => {
                if (e.target.tagName === 'INPUT') {
                    let allVisChk = true;
                    const labels = valContainer.children;
                    for (let i = 0; i < labels.length; i++) {
                        let lbl = labels[i];
                        if (lbl.style.display !== 'none' && !lbl.querySelector('input').checked) {
                            allVisChk = false;
                            break;
                        }
                    }
                    selectAllCb.checked = allVisChk;
                }
            });

            searchInput.focus();
        }, 50);
    }

    applyFilter(colIndex) {
        if (!this.currentDropdown) return;

        const valCbs = this.currentDropdown.querySelectorAll('#val-container input[type="checkbox"]');
        const selected = new Set();
        valCbs.forEach(cb => { if (cb.checked) selected.add(cb.value); });

        const icon = this.shadowRoot.querySelector(`.filter-icon[data-col="${colIndex}"]`);
        const titleSpan = icon.closest('.header-cell').querySelector('.col-title');

        if (selected.size === valCbs.length) {
            delete this.activeFilters[colIndex];
            icon.classList.remove('active');
            icon.closest('.header-cell').classList.remove('is-filtered');
            titleSpan.textContent = titleSpan.dataset.original;
        } else {
            this.activeFilters[colIndex] = selected;
            icon.classList.add('active');
            icon.closest('.header-cell').classList.add('is-filtered');
            titleSpan.textContent = titleSpan.dataset.original;
        }

        this.closeFilterMenu();
        // INSTANT DOM REFLOW BYPASS
        setTimeout(() => this.executeFilters(), 10);
    }

    clearFilter(colIndex) {
        delete this.activeFilters[colIndex];
        const icon = this.shadowRoot.querySelector(`.filter-icon[data-col="${colIndex}"]`);
        icon.classList.remove('active');
        icon.closest('.header-cell').classList.remove('is-filtered');
        const titleSpan = icon.closest('.header-cell').querySelector('.col-title');
        titleSpan.textContent = titleSpan.dataset.original;
        this.closeFilterMenu();
        setTimeout(() => this.executeFilters(), 10);
    }

    clearAllFilters() {
        this.activeFilters = {};
        this.$$('.header-cell.is-filtered').forEach(cell => {
            cell.classList.remove('is-filtered');
            let icon = cell.querySelector('.filter-icon');
            if (icon) icon.classList.remove('active');
            let titleSpan = cell.querySelector('.col-title');
            if (titleSpan) titleSpan.textContent = titleSpan.dataset.original;
        });
        setTimeout(() => this.executeFilters(), 10);
    }

    executeFilters() {
        if (!this.rowNodes || this.rowNodes.length === 0) return;

        const container = this.$('tracker-rows');
        container.style.display = 'none'; // DETACH TO PREVENT LAG

        for (let i = 0; i < this.rowFilterData.length; i++) {
            let rData = this.rowFilterData[i];
            let isVisible = true;
            for (let col in this.activeFilters) {
                if (!this.activeFilters[col].has(rData[col])) {
                    isVisible = false; break;
                }
            }
            this.rowNodes[i].style.display = isVisible ? 'flex' : 'none';
        }

        container.style.display = 'block'; // REATTACH

        this.performGlobalSearch();
    }

    closeFilterMenu() { if (this.currentDropdown) { document.body.removeChild(this.currentDropdown); this.currentDropdown = null; } }

    // --- PDF EXPORT LOGIC WITH CLICKABLE HYPERLINKS ---
    openPdfModal() {
        const listContainer = this.$('pdf-column-list');
        listContainer.innerHTML = '<label class="checkbox-row" style="border-bottom: 1px solid #ccc; padding-bottom: 8px; margin-bottom: 8px;"><input type="checkbox" id="pdf-select-all" checked onchange="this.getRootNode().host.toggleAllPdfCols(this)"> Select All</label>';

        let html = '<div style="display: flex; flex-direction: column; gap: 8px;">';
        PDF_OPTIONS.forEach((opt, index) => {
            if (opt.id === 'l2-gate' && this.globalConfig.showL2Gate === false) return;
            if (opt.id === 'l3-gate' && this.globalConfig.showL3Gate === false) return;
            if (opt.id === 'l4-gate' && this.globalConfig.showL4Gate === false) return;
            if ((opt.id === 'l2-open' || opt.id === 'l2-closed') && this.globalConfig.showL2Supp === false) return;
            if ((opt.id === 'l3-open' || opt.id === 'l3-closed') && this.globalConfig.showL3Supp === false) return;
            if ((opt.id === 'l4-open' || opt.id === 'l4-closed') && this.globalConfig.showL4Supp === false) return;

            let displayLabel = opt.label;
            if (opt.id === 'asset') displayLabel = 'Assets';
            if (opt.id === 'area') displayLabel = this.globalConfig.customHeaders.areaPrefix || 'Area';
            if (opt.id === 'l2-gate') displayLabel = '' + this.globalConfig.customHeaders.l2Gate;
            if (opt.id === 'l2-status') displayLabel = '' + this.globalConfig.customHeaders.l2Status;
            if (opt.id === 'l3-gate') displayLabel = '' + this.globalConfig.customHeaders.l3Gate;
            if (opt.id === 'l3-status') displayLabel = '' + this.globalConfig.customHeaders.l3Status;
            if (opt.id === 'l4-gate') displayLabel = '' + this.globalConfig.customHeaders.l4Gate;
            if (opt.id === 'l4-status') displayLabel = '' + this.globalConfig.customHeaders.l4Status;
            if (opt.id === 'iss-status') displayLabel = this.globalConfig.customHeaders.issStatus;

            html += `<label class="checkbox-row"><input type="checkbox" class="pdf-col-cb" value="${index}" checked> ${displayLabel}</label>`;
        });
        html += '</div>';
        listContainer.innerHTML += html;
        this.$('pdf-modal').classList.add('active');
    }

    closePdfModal() {
        this.$('pdf-modal').classList.remove('active');
    }

    toggleAllPdfCols(source) {
        this.$$('.pdf-col-cb').forEach(cb => cb.checked = source.checked);
    }

    getGroupedSuppPdf(row, level, state) {
        let cells = row.querySelectorAll(`.${level}-supp-details`);
        let items = [];
        let openArr = (level === 'l4') ? (this.globalConfig.testOpenStatuses || []) : (this.globalConfig.openStatuses || []);
        let closedArr = (level === 'l4') ? (this.globalConfig.testClosedStatuses || []) : (this.globalConfig.closedStatuses || []);

        cells.forEach(cell => {
            let val = cell.dataset.val;
            let link = cell.dataset.link;
            if (val && val !== 'N/A' && val !== 'Clear' && val !== '-') {
                const match = val.match(/(.+?)\s*\((.+)\)/);
                if (match) {
                    let id = match[1].trim();
                    let status = match[2].trim();
                    let isOpen = isStatusMatch(status, openArr) || (!isStatusMatch(status, closedArr) && !status.toLowerCase().includes('no cl'));
                    let isClosed = isStatusMatch(status, closedArr);

                    let safeLink = String(link || '').trim();
                    let idDisplay = (safeLink && safeLink !== 'undefined' && safeLink !== 'null' && safeLink !== '') ? `<a href="${safeLink}" target="_blank">${id}</a>` : id;

                    if (state === 'open' && isOpen) items.push(idDisplay);
                    if (state === 'closed' && isClosed) items.push(idDisplay);
                }
            }
        });
        return items.length > 0 ? items.join(', ') : '-';
    }

    getGroupedIssPdf(row, type) {
        let cells = row.querySelectorAll(`.global-iss-details`);
        let items = [];
        let issueOpenArr = this.globalConfig.issueOpenStatuses || [];
        let issueClosedArr = this.globalConfig.issueClosedStatuses || [];
        let gatingArr = this.globalConfig.gatingIssues || [];

        cells.forEach(cell => {
            let val = cell.dataset.val;
            let link = cell.dataset.link;
            if (val && val !== 'N/A' && val !== 'Clear' && val !== '-') {
                const match = val.match(/(.+?)\s*\((.+)\)/);
                if (match) {
                    let id = match[1].trim();
                    let status = match[2].trim();

                    let isOpen = isStatusMatch(status, issueOpenArr) || (!isStatusMatch(status, issueClosedArr));
                    let isClosed = isStatusMatch(status, issueClosedArr);
                    let isGating = isStatusMatch(status, gatingArr);

                    let safeLink = String(link || '').trim();
                    let idDisplay = (safeLink && safeLink !== 'undefined' && safeLink !== 'null' && safeLink !== '') ? `<a href="${safeLink}" target="_blank">${id}</a>` : id;

                    if (type === 'open-gate' && isOpen && isGating) items.push(idDisplay);
                    if (type === 'open-non' && isOpen && !isGating) items.push(idDisplay);
                    if (type === 'closed-gate' && isClosed && isGating) items.push(idDisplay);
                    if (type === 'closed-non' && isClosed && !isGating) items.push(idDisplay);
                }
            }
        });
        return items.length > 0 ? items.join(', ') : '-';
    }

    // Opens a genuinely separate browser window/document for printing —
    // completely independent of this component's shadow DOM, so its own
    // <style>/<base> below are untouched by the shadow-DOM conversion.
    generatePDF() {
        const selectedIndices = Array.from(this.$$('.pdf-col-cb:checked')).map(cb => parseInt(cb.value));
        if (selectedIndices.length === 0) { alert('Please select at least one column.'); return; }

        const selectedOptions = selectedIndices.map(i => PDF_OPTIONS[i]);

        let logo1El = this.$('app-logo-1');
        let logo2El = this.$('app-logo-2');
        let logo1 = logo1El ? logo1El.src : '';
        let logo2 = logo2El ? logo2El.src : '';
        // The actual resolved site name (matches what's shown next to
        // "Equipment Status Tracker" in the header), not the legacy
        // Sheet-configurable customHeaders.zoneTitle field, which almost
        // always just sits at its 'Zone 1' default.
        let zTitle = this.SITE_NAME || (this.$('zone-title-display') && this.$('zone-title-display').innerText) || this.PROJECT_KEY;
        // Same logo shown top-right of the LaunchPad shell's own header —
        // repeated on every printed/exported page via position:fixed
        // (Chrome's print/PDF engine renders a fixed-position element on
        // each page, not just the first).
        const CRITICALARC_LOGO_URL = 'https://lh3.googleusercontent.com/u/0/d/1Wy_ftXtce-UG5jV-5vwS80lV1yt7QTbG';

        let printWin = window.open('', '_blank');
        let html = `<html><head><title>Equipment Status Tracker - PDF Export</title>
        <base target="_blank">
        <style>
            @page { size: landscape; margin: 10mm; }
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; font-size: 10px; }
            .page-logo { position: fixed; top: 0; right: 0; height: 34px; object-fit: contain; }
            .header-container { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 2px solid #2e7d32; padding-bottom: 10px; }
            h2 { color: #2e7d32; margin: 0; font-size: 18px; text-transform: uppercase; text-align: center; }
            img.logo { height: 70px; object-fit: contain; }
            table { width: 100%; border-collapse: collapse; table-layout: fixed; }
            th, td { border: 1px solid #aeb6ba; padding: 6px 4px; text-align: center; vertical-align: middle; word-wrap: break-word; overflow: hidden; }
            th { background-color: #2e7d32 !important; color: white !important; font-size: 10px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            .bg-gray { background-color: #f5f5f5 !important; color: #616161 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact;}

            /* PDF Hyperlink Styling - Crucial for PDF readers to recognize them */
            a { color: #0563c1 !important; text-decoration: underline !important; cursor: pointer; }
            .uncolored-cell { background-color: #ffffff !important; color: #222 !important; font-size: 10px !important; font-weight: bold; -webkit-print-color-adjust: exact; print-color-adjust: exact;}
            .shrink-list { font-size: 10px; line-height: 1.2; color: #222; text-align: left; background-color: #ffffff !important;}

            * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        </style></head><body>

        <img class="page-logo" src="${CRITICALARC_LOGO_URL}" alt="CriticalArc">

        <div class="header-container">
            <div style="flex: 1; text-align: left;">
                ${logo1 && !logo1.includes('empty') ? `<img class="logo" src="${logo1}" alt="Logo 1" />` : ''}
            </div>
            <div style="flex: 2;">
                <h2>${zTitle} • Equipment Status Tracker Export</h2>
            </div>
            <div style="flex: 1; text-align: right;">
                ${logo2 && !logo2.includes('empty') ? `<img class="logo" src="${logo2}" alt="Logo 2" />` : ''}
            </div>
        </div>

        <table>`;

        html += '<thead><tr>';
        selectedOptions.forEach(opt => {
            let displayLabel = opt.label;
            if (opt.id === 'asset') displayLabel = 'Asset';
            if (opt.id === 'area') displayLabel = this.globalConfig.customHeaders.areaPrefix || 'Area';
            if (opt.id === 'l2-gate') displayLabel = '' + this.globalConfig.customHeaders.l2Gate;
            if (opt.id === 'l2-status') displayLabel = '' + this.globalConfig.customHeaders.l2Status;
            if (opt.id === 'l3-gate') displayLabel = '' + this.globalConfig.customHeaders.l3Gate;
            if (opt.id === 'l3-status') displayLabel = '' + this.globalConfig.customHeaders.l3Status;
            if (opt.id === 'l4-gate') displayLabel = '' + this.globalConfig.customHeaders.l4Gate;
            if (opt.id === 'l4-status') displayLabel = '' + this.globalConfig.customHeaders.l4Status;
            if (opt.id === 'iss-status') displayLabel = this.globalConfig.customHeaders.issStatus;
            html += `<th>${displayLabel}</th>`;
        });
        html += '</tr></thead><tbody>';

        const rows = this.$$('.cell-row');
        rows.forEach(row => {
            if (window.getComputedStyle(row).display !== 'none') {
                html += '<tr>';

                selectedOptions.forEach(opt => {
                    let cellHtml = '<td>-</td>';

                    if (opt.type === 'asset') {
                        let assetNode = row.querySelector('.asset-part');
                        let aTag = assetNode ? assetNode.querySelector('a') : null;
                        let text = assetNode ? assetNode.innerText.trim() : '';
                        let display = aTag ? `<a href="${aTag.href}" target="_blank">${text}</a>` : text;
                        cellHtml = `<td class="uncolored-cell">${display}</td>`;
                    } else if (opt.type === 'area') {
                        let areaNode = row.querySelector('.area-part');
                        let val = areaNode ? areaNode.innerText : '';
                        cellHtml = `<td class="shrink-list">${val}</td>`;
                    } else if (opt.type === 'gate') {
                        let cells = row.querySelectorAll(`.${opt.level}-gate-col`);
                        let combinedText = [];
                        cells.forEach(cell => {
                            let hdrNode = cell.querySelector('.checklist-header');
                            if (hdrNode && hdrNode.innerText.trim() !== '-') {
                                let aTag = hdrNode.querySelector('a');
                                let text = hdrNode.innerText.trim();
                                combinedText.push(aTag ? `<a href="${aTag.href}" target="_blank">${text}</a>` : text);
                            }
                        });
                        let display = combinedText.length > 0 ? combinedText.join(', ') : '-';
                        cellHtml = `<td class="uncolored-cell">${display}</td>`;
                    } else if (opt.type === 'status') {
                        let cell = row.querySelector(`.${opt.level}-supp-summary`);
                        let val = cell ? cell.innerHTML : '-';
                        cellHtml = `<td class="shrink-list">${val}</td>`;
                    } else if (opt.type === 'iss-count') {
                        let cell = row.querySelector(`.global-iss-summary`);
                        let val = cell ? cell.innerHTML : '-';
                        cellHtml = `<td class="shrink-list">${val}</td>`;
                    } else if (opt.type === 'supp-open') {
                        let val = this.getGroupedSuppPdf(row, opt.level, 'open');
                        cellHtml = `<td class="shrink-list">${val}</td>`;
                    } else if (opt.type === 'supp-closed') {
                        let val = this.getGroupedSuppPdf(row, opt.level, 'closed');
                        cellHtml = `<td class="shrink-list">${val}</td>`;
                    } else if (opt.type === 'iss-group') {
                        let val = this.getGroupedIssPdf(row, opt.group);
                        cellHtml = `<td class="shrink-list">${val}</td>`;
                    }

                    html += cellHtml;
                });

                html += '</tr>';
            }
        });

        html += '</tbody></table></body></html>';
        printWin.document.write(html);
        printWin.document.close();
        printWin.focus();

        setTimeout(() => {
            printWin.onafterprint = function () { printWin.close(); };
            printWin.print();
        }, 500);

        this.closePdfModal();
    }

    extractStackedCellForPdf(cell) {
        if (!cell) return '<td>-</td>';
        let hdrNode = cell.querySelector('.checklist-header');
        if (!hdrNode) return `<td>-</td>`;

        let aTag = hdrNode.querySelector('a');
        let text = hdrNode.innerText.trim();

        if (text === '-') {
            return `<td>-</td>`;
        } else {
            let display = aTag ? `<a href="${aTag.href}" target="_blank">${text}</a>` : text;
            return `<td class="uncolored-cell">${display}</td>`;
        }
    }

    // PERF FIX: debounce the search box — without this, every single keystroke
    // re-scans every row/cell in the grid. Waiting 220ms after the user pauses
    // typing means one scan for a typed word instead of one per character.
    debouncedGlobalSearch() {
        clearTimeout(this.__searchDebounceTimer);
        this.__searchDebounceTimer = setTimeout(() => this.performGlobalSearch(), 220);
    }

    performGlobalSearch() {
        const query = this.$('global-search-input').value.toLowerCase().trim();
        const counter = this.$('search-counter');

        this.$$('.cell-row.highlight-search').forEach(el => el.classList.remove('highlight-search'));
        this.$$('.highlight-cell').forEach(el => el.classList.remove('highlight-cell'));

        this.searchMatches = [];
        this.currentSearchIndex = -1;

        if (query === '') {
            counter.innerText = '0/0';
            return;
        }

        let columnsToExpand = new Set();

        const container = this.$('tracker-rows');
        container.style.display = 'none'; // DETACH FOR INSTANT REFLOW

        this.rowNodes.forEach(row => {
            if (row.style.display !== 'none') {
                let matchFound = false;
                let matchedCells = [];

                // Deep scan using [data-val] so we grab EVERY cell, including the dynamically hidden ones.
                row.querySelectorAll('[data-val]').forEach(cell => {
                    let cellVal = cell.dataset.val ? String(cell.dataset.val).toLowerCase() : '';
                    let cellText = cell.textContent ? String(cell.textContent).toLowerCase() : '';

                    if ((cellVal !== '' && cellVal.includes(query)) || (cellText !== '' && cellText.includes(query))) {
                        matchFound = true;
                        matchedCells.push(cell);

                        if (cell.classList.contains('l2-supp-details')) columnsToExpand.add('l2');
                        if (cell.classList.contains('l3-supp-details')) columnsToExpand.add('l3');
                        if (cell.classList.contains('l4-supp-details')) columnsToExpand.add('l4');
                        if (cell.classList.contains('global-iss-details')) columnsToExpand.add('iss');
                    }
                });

                if (matchFound) {
                    this.searchMatches.push({ row: row, cells: matchedCells });
                }
            }
        });

        container.style.display = 'block'; // REATTACH

        columnsToExpand.forEach(col => {
            if (col === 'iss') {
                if (!this.expandedStates.iss) this.toggleGlobalIssues();
            } else {
                if (!this.expandedStates[col]) this.toggleExpansion(col);
            }
        });

        if (this.searchMatches.length > 0) {
            this.currentSearchIndex = 0;
            setTimeout(() => this.updateSearchUI(), 100);
        } else {
            counter.innerText = '0/0';
        }
    }

    navigateSearch(direction) {
        if (this.searchMatches.length === 0) return;
        this.currentSearchIndex += direction;
        if (this.currentSearchIndex < 0) this.currentSearchIndex = this.searchMatches.length - 1;
        if (this.currentSearchIndex >= this.searchMatches.length) this.currentSearchIndex = 0;
        this.updateSearchUI();
    }

    updateSearchUI() {
        this.$$('.cell-row.highlight-search').forEach(el => el.classList.remove('highlight-search'));
        this.$$('.highlight-cell').forEach(el => el.classList.remove('highlight-cell'));

        if (this.searchMatches.length > 0 && this.currentSearchIndex > -1) {
            const matchObj = this.searchMatches[this.currentSearchIndex];
            const row = matchObj.row;
            row.classList.add('highlight-search');

            matchObj.cells.forEach(c => c.classList.add('highlight-cell'));

            setTimeout(() => {
                let firstCell = matchObj.cells[0];
                if (firstCell) {
                    firstCell.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
                } else {
                    row.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
                }
            }, 50);

            this.$('search-counter').innerText = `${this.currentSearchIndex + 1}/${this.searchMatches.length}`;
        }
    }
}

customElements.define('equipment-tracker-view', EquipmentTrackerView);
