// dashboard.js

export class CriticalArcDashboard {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) throw new Error(`Container #${containerId} not found.`);
    
    // Core State 
    this.STATE = { project: null, data: null, filters: { discipline: [], contractor: [], status: [], phase: [] }, eqPhase: new Map(), openIssues: [] };
    this.EQ_FILTER = { bldg: 'All', floor: 'All' };
    this.EQ_SEARCH = { q: '', incompleteOnly: true };
    this.ISS_THRESH = 30;
    this.REFRESH_ENDPOINT = null;

    // ─── Vocabulary ───────────────────────────────────────────────────────
    // COMPLETE_STATUSES used to be ['Finished']. That string occurs in
    // NEITHER SAN project -- their verified statuses are 'Verified',
    // 'Checklist Complete' and 'Verified - Not Included in Sampling', so the
    // comparison returned false for every row and the tab read 0%.
    // `is_verified` came from the cx_* tables, which the dashboard no longer
    // reads -- the Apps Script payload in launchpad_dashboard_data does not
    // carry it (SAN's donut showed no verified slices). It is still honoured
    // if a payload ever includes it; otherwise completion falls back to the
    // status names below.
    this.COMPLETE_STATUSES = ['Finished', 'Checklist Complete', 'Verified',
                              'Verified - Not Included in Sampling'];
    this.isComplete = (c) => c.is_verified === true ||
                             this.COMPLETE_STATUSES.includes(c.status);
    // Verified = the Cx agent has approved it, i.e. fully done. The rest of
    // COMPLETE_STATUSES ('Checklist Complete') means the contractor finished
    // but Cx has not verified yet; charts that split the two use these.
    this.VERIFIED_STATUSES = ['Finished', 'Verified', 'Verified - Not Included in Sampling'];
    this.isVerified = (c) => c.is_verified === true ||
                             this.VERIFIED_STATUSES.includes(c.status);

    // Tests are the ONE vocabulary still unresolved (GOLD-DESIGN Q5): whether
    // 'Partially Passed (Test to be Repeated)' counts as a pass, and whether
    // 'Voided' / 'Deferred to 1B' leave the denominator, is the commissioning
    // engineer's call and not the pipeline's. Until it is answered these stay
    // as observed: 'Passed' is real and correct for 18604; 'Failed' occurs in
    // no SAN project at all. SAN-NT1B (49639) will legitimately read zero
    // passed, because it has zero passes.
    this.TEST_PASS_STATUSES = ['Passed'];
    this.TEST_FAIL_STATUSES = ['Failed'];

    // Issue statuses ARE the one list that already matched the data -- kept
    // only to ORDER the filter, which falls back to whatever the data holds.
    this.ISSUE_STATUS_ORDER = ['Open', 'In Progress', 'Pending Review', 'Closed'];
    this.ISSUE_OPEN_STATUSES = ['Open', 'In Progress', 'Pending Review'];
    
    // Theme Constants
    this.FONT = 'Barlow, sans-serif';
    this.COND = 'Barlow Condensed, sans-serif';
    // green/red/yellow/blue are semantic status colors (Open/Closed,
    // Passed/Failed, discipline coding, etc.) — deliberately the SAME in
    // both themes, matching how index.html/bridge-view.js/tamperseal-view.js
    // all treat their own status colors. text/muted/border/panel are
    // structural chrome instead, and get overwritten by applyTheme() below
    // whenever the theme changes — every chart already reads gridline/tick
    // colors from this.C.border/this.C.muted (see baseLayout()), so
    // updating these two values is what re-themes every chart's axes too.
    this.C = { text:'#F0F0F0', muted:'#8A8F98', border:'#3E4248', panel:'#2D3035', green:'#39B54A', red:'#E04040', yellow:'#F4B942', blue:'#4A90D9' };
    // This dashboard was built dark-only (no light theme existed at all)
    // until this. Shares the exact same localStorage key every other
    // module's dark-mode toggle already reads/writes.
    this.darkMode = localStorage.getItem('launchpad_dark_mode') === 'enabled';
    this.THEMES = {
      dark:  { bg:'#23262B', panel:'#2D3035', border:'#3E4248', line:'#34383E', text:'#F0F0F0', muted:'#8A8F98', inputBg:'#23262B', metaText:'#5A5F68', tdText:'#D8DCE1', tdBorder:'#2A2D32', hoverRow:'#282B30' },
      light: { bg:'#F4F5F7', panel:'#FFFFFF', border:'#DADDE1', line:'#EBEDF0', text:'#1A1D21', muted:'#5F6672', inputBg:'#FFFFFF', metaText:'#7A8088', tdText:'#2B2F33', tdBorder:'#E4E6E9', hoverRow:'#EFF1F3' }
    };
    this.CFG = { displayModeBar: false, responsive: true };
  }

  async mount() {
    this.injectCSS();
    this.injectHTML();
    this.applyTheme();
    this.bindEvents();
    await this.init();
  }

  // Called on mount (using whatever localStorage already said) and again
  // whenever index.html's toggleDarkMode() calls setDarkMode() below.
  // Updates this.C's structural colors (so any chart re-rendered after this
  // point picks up the new gridline/tick colors) and the CSS custom
  // properties on .ca-wrapper (so every var(--bg)/var(--panel)/etc. rule in
  // injectCSS()'s stylesheet repaints immediately, with no need to
  // duplicate or regenerate that stylesheet per theme).
  applyTheme() {
    const t = this.darkMode ? this.THEMES.dark : this.THEMES.light;
    Object.assign(this.C, { text: t.text, muted: t.muted, border: t.border, panel: t.panel });
    const wrapper = this.container.querySelector('.ca-wrapper');
    if (!wrapper) return;
    wrapper.style.setProperty('--bg', t.bg);
    wrapper.style.setProperty('--panel', t.panel);
    wrapper.style.setProperty('--border', t.border);
    wrapper.style.setProperty('--line', t.line);
    wrapper.style.setProperty('--text', t.text);
    wrapper.style.setProperty('--muted', t.muted);
    wrapper.style.setProperty('--input-bg', t.inputBg);
    wrapper.style.setProperty('--meta-text', t.metaText);
    wrapper.style.setProperty('--td-text', t.tdText);
    wrapper.style.setProperty('--td-border', t.tdBorder);
    wrapper.style.setProperty('--hover-row', t.hoverRow);
  }

  // index.html's toggleDarkMode() calls this directly, same pattern as the
  // other three views' own setDarkMode() methods. Charts bake their axis
  // colors into the layout object at render time (Plotly doesn't re-read
  // JS variables live), so re-running renderAll() is what actually
  // repaints already-drawn charts instead of just the surrounding chrome.
  setDarkMode(isDark) {
    this.darkMode = !!isDark;
    this.applyTheme();
    if (this.STATE.data) this.renderAll();
  }

  // DOM Query Helper to restrict lookups to this specific dashboard container
  q(id) { return this.container.querySelector('#' + id); }
  qa(sel) { return this.container.querySelectorAll(sel); }

  // ─── 1. CORE STRUCTURE & STYLES ─────────────────────────────────────────────
  
  injectCSS() {
    if (document.getElementById('ca-dashboard-styles')) return;
    const style = document.createElement('style');
    style.id = 'ca-dashboard-styles';
    style.innerHTML = `
      
      .ca-wrapper { --bg: #23262B; --panel: #2D3035; --border: #3E4248; --line: #34383E; --text: #F0F0F0; --muted: #8A8F98; --green: #39B54A; --red: #E04040; --yellow: #F4B942; --blue: #4A90D9; --input-bg: #23262B; --meta-text: #5A5F68; --td-text: #D8DCE1; --td-border: #2A2D32; --hover-row: #282B30; }
      .ca-wrapper { background: var(--bg); color: var(--text); font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; box-sizing: border-box; height: 100%; }
      .ca-wrapper * { box-sizing: border-box; }
      .ca-wrapper a { color: inherit; }

      .ca-app { display: flex; height: 100%; width: 100%; }

      /* Sidebar */
      .ca-sidebar { width: clamp(220px, 20vw, 300px); flex: 0 0 clamp(220px, 20vw, 300px); background: var(--panel); border-right: 1px solid var(--border); padding: 20px; overflow-y: auto; height: 100%; }
      .ca-brand { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 20px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; border-bottom: 2px solid var(--green); padding-bottom: 12px; margin-bottom: 20px; }
      .ca-brand-sub { font-size: 11px; color: var(--muted); letter-spacing: 1px; margin-top: 2px; }
      .ca-side-label { font-size: 11px; letter-spacing: 1px; color: var(--muted); text-transform: uppercase; margin: 16px 0 6px; }
      
      .ca-wrapper select, .ca-wrapper input[type="text"] { width: 100%; background: var(--input-bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 13px; }
      .ca-connected-project { width: 100%; background: var(--input-bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 13px; font-weight: 600; }
      .ca-wrapper select:focus, .ca-wrapper input[type="text"]:focus { outline: none; border-color: var(--muted); }
      .ca-pace-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 14px; color: var(--muted); font-size: 13px; }
      .ca-pace-controls input[type="date"] { background: var(--input-bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; font-family: inherit; font-size: 13px; color-scheme: light dark; }

      .ca-checkgroup { display: flex; flex-direction: column; gap: 5px; max-height: 190px; overflow-y: auto; background: var(--input-bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; }
      .ca-checkgroup label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); cursor: pointer; }
      .ca-checkgroup label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ca-checkgroup input[type="checkbox"] { accent-color: var(--green); width: 15px; height: 15px; flex: 0 0 auto; cursor: pointer; }
      .ca-filter-hint { font-size: 11px; color: var(--muted); margin: 2px 0 8px; font-style: italic; }
      
      .ca-hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
      .ca-wrapper input[type="range"] { width: 100%; accent-color: var(--green); margin: 8px 0 4px; cursor: pointer; }
      .ca-slider-wrap { color: var(--muted); font-size: 13px; margin: 4px 0 14px; }
      .ca-slider-wrap b, .ca-slider-wrap span { color: var(--green); font-weight: 600; }
      
      .ca-eq-search-wrap { display: flex; gap: 12px; align-items: center; margin: 4px 0 12px; flex-wrap: wrap; }
      .ca-eq-search-wrap label { color: var(--muted); font-size: 13px; white-space: nowrap; cursor: pointer; display: flex; align-items: center; gap: 6px; }
      .ca-eq-search-wrap input[type="checkbox"] { accent-color: var(--green); width: 15px; height: 15px; cursor: pointer; }
      
      .ca-refreshed { font-size: 11px; color: var(--muted); margin-top: 4px; }
      .ca-btn-refresh { margin-top: 12px; width: 100%; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; background: transparent; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 9px; cursor: pointer; transition: background .15s, border-color .15s; }
      .ca-btn-refresh:hover { background: var(--line); border-color: var(--muted); }
      .ca-btn-refresh:disabled { opacity: .5; cursor: default; }

      /* Main Content */
      .ca-main { flex: 1; padding: clamp(16px, 2vw, 28px) clamp(16px, 2.5vw, 36px); min-width: 0; background: var(--bg); overflow-y: auto; height: 100%; }
      .ca-page-title { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: clamp(28px, 4vw, 42px); font-weight: 700; letter-spacing: 1px; text-transform: uppercase; line-height: 1.1; color: var(--text); }
      .ca-page-sub { font-size: 14px; color: var(--muted); margin-top: 4px; letter-spacing: .5px; }
      .ca-page-meta { font-size: 12px; color: var(--meta-text); margin-top: 6px; letter-spacing: .5px; }
      .ca-title-hr { border: none; border-top: 1px solid var(--border); margin: 16px 0 8px; }

      /* Tabs (Using Display: Block/None natively now, avoiding Plotly sizing bugs) */
      .ca-tabs { display: flex; gap: 4px; background: var(--panel); padding: 4px; border-radius: 10px; border: 1px solid var(--border); margin: 16px 0 20px; width: fit-content; }
      .ca-tab { background: transparent; border: none; border-radius: 6px; color: var(--muted); font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-weight: 600; font-size: 13px; letter-spacing: .5px; padding: 8px 16px; cursor: pointer; }
      .ca-tab.active { background: var(--line); color: var(--green); }
      .ca-tabpage { display: none; } 
      .ca-tabpage.active { display: block; }

      .ca-section-header { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: var(--green); margin: 24px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }

      /* KPI cards */
      .ca-kpi-row { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
      .ca-kpi-card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 20px 24px; text-align: center; transition: border-color .2s; }
      .ca-kpi-card:hover { border-color: var(--muted); }
      .ca-kpi-label { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
      .ca-kpi-value { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 32px; font-weight: 500; line-height: 1; margin-bottom: 4px; }
      .ca-kpi-sub { font-size: 12px; color: var(--muted); }
      .kpi-red { color: var(--red); } .kpi-yellow { color: var(--yellow); } .kpi-green { color: var(--green); } .kpi-blue { color: var(--blue); } .kpi-white { color: var(--text); }

      .ca-grid2 { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 16px; }
      @media (max-width: 900px) { .ca-grid2 { grid-template-columns: minmax(0,1fr); } }
      .ca-kpi-row > *, .ca-grid2 > * { min-width: 0; }

      .ca-chart { width: 100%; min-width: 0; }
      .ca-eq-filters { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 8px; }
      .ca-caption { font-size: 12px; color: var(--muted); margin: 4px 0 12px; }

      /* Tables */
      .ca-wrapper table.dt { width: 100%; border-collapse: collapse; font-size: 12.5px; margin: 6px 0; }
      .ca-wrapper table.dt th { text-align: left; color: var(--muted); font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-weight: 600; letter-spacing: .5px; text-transform: uppercase; font-size: 11px; border-bottom: 1px solid var(--border); padding: 8px 10px; position: sticky; top: 0; background: var(--panel); }
      .ca-wrapper table.dt td { padding: 7px 10px; border-bottom: 1px solid var(--td-border); color: var(--td-text); }
      .ca-wrapper table.dt tr:hover td { background: var(--hover-row); }
      .ca-table-wrap { max-height: 460px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
      
      .ca-wrapper details { margin: 12px 0; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
      .ca-wrapper details > summary { cursor: pointer; padding: 12px 16px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-weight: 600; letter-spacing: .5px; color: var(--muted); }
      .ca-wrapper details[open] > summary { border-bottom: 1px solid var(--border); color: var(--text); }
      .ca-wrapper details .ca-table-wrap { border: none; border-radius: 0; }
      
      .ca-empty { color: var(--muted); background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin: 10px 0; }
      .ca-ok { color: var(--green); background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin: 10px 0; }
      
      #ca-loading { padding: 40px; color: var(--muted); }

      /* Responsive */
      @media (max-width: 860px) {
        .ca-app { flex-direction: column; }
        .ca-sidebar { width: 100%; flex: 0 0 auto; height: auto; position: static; border-right: none; border-bottom: 1px solid var(--border); }
        .ca-main { padding: 16px; }
        .ca-tabs { width: 100%; overflow-x: auto; }
        .ca-eq-filters { grid-template-columns: 1fr; }
      }
    `;
    document.head.appendChild(style);
  }

  injectHTML() {
    this.container.innerHTML = `
      <div class="ca-wrapper">
        <div class="ca-app">
          <aside class="ca-sidebar">
            <div class="ca-brand">CriticalArc<div class="ca-brand-sub">Project Dashboard Platform</div></div>
            <div class="ca-side-label">Connected Project</div>
            <div class="ca-connected-project" id="ca-connectedProject">—</div>
            <hr class="ca-hr" />
            <div style="font-weight:600; letter-spacing:.5px;">Filters</div>
            <div class="ca-filter-hint">Check any to filter — none checked = all.</div>
            <div class="ca-side-label">Division / Discipline</div>
            <div class="ca-checkgroup" id="ca-fDiscipline"></div>
            <div class="ca-side-label">Contractor / Assigned To</div>
            <div class="ca-checkgroup" id="ca-fContractor"></div>
            <div class="ca-side-label">Status</div>
            <div class="ca-checkgroup" id="ca-fStatus"></div>
            <div class="ca-side-label">Building Phase</div>
            <div class="ca-checkgroup" id="ca-fPhase"></div>
            <hr class="ca-hr" />
            <div class="ca-refreshed" id="ca-refreshed"></div>
            <button class="ca-btn-refresh" id="ca-refreshBtn">🔄 Refresh Data</button>
          </aside>

          <main class="ca-main">
            <div id="ca-loading">Loading data…</div>
            <div id="ca-dash" style="display: none;">
              <div class="ca-page-title" id="ca-pageTitle"></div>
              <div class="ca-page-sub">Commissioning Progress Dashboard</div>
              <div class="ca-page-meta" id="ca-pageMeta"></div>
              <hr class="ca-title-hr" />

              <div class="ca-tabs">
                <button class="ca-tab active" data-tab="issues">📋 Issue Tracking</button>
                <button class="ca-tab" data-tab="checklists">✅ Checklists</button>
                <button class="ca-tab" data-tab="tests">🧪 Functional Tests</button>
                <button class="ca-tab" data-tab="equipment">🔧 Equipment</button>
              </div>

              <div class="ca-tabpage active" id="ca-tab-issues"></div>
              <div class="ca-tabpage" id="ca-tab-checklists"></div>
              <div class="ca-tabpage" id="ca-tab-tests"></div>
              <div class="ca-tabpage" id="ca-tab-equipment"></div>
            </div>
          </main>
        </div>
      </div>
    `;
  }

  // ─── 2. UTILITY & HELPER METHODS ────────────────────────────────────────────

  uniq(arr) { return [...new Set(arr)]; }
  
  isBad(v) { 
    return v === null || v === undefined || ['', 'nan', 'none', '0'].includes(String(v).trim().toLowerCase()); 
  }
  
  valueCounts(rows, key) {
    const m = new Map();
    for (const r of rows) { 
      const v = r[key]; 
      if (v === null || v === undefined) continue;
      m.set(v, (m.get(v) || 0) + 1); 
    }
    return m;
  }
  
  groupSize(rows, key) {
    const m = this.valueCounts(rows, key);
    return [...m.entries()].map(([k, v]) => ({ key: k, count: v }));
  }
  
  sumBy(rows, key) { 
    let s = 0; 
    for (const r of rows) s += (+r[key] || 0); 
    return s; 
  }

  section(t) { return `<div class="ca-section-header">${t}</div>`; }
  
  kpi(label, value, cls, sub) {
    return `<div class="ca-kpi-card"><div class="ca-kpi-label">${label}</div>
      <div class="ca-kpi-value ${cls||'kpi-white'}">${value}</div>
      ${sub ? `<div class="ca-kpi-sub">${sub}</div>` : ''}</div>`;
  }
  
  chartBox(id, h) { return `<div class="ca-chart" id="${id}" style="height:${h||360}px"></div>`; }
  
  table(cols, rows) {
    const head = cols.map(c => `<th>${c.label}</th>`).join('');
    const body = rows.map(r => '<tr>' + cols.map(c =>
      `<td>${r[c.k] === null || r[c.k] === undefined ? '' : r[c.k]}</td>`).join('') + '</tr>').join('');
    return `<div class="ca-table-wrap"><table class="dt"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  phaseOf(r) {
    if (r.building_phase) return r.building_phase;
    return (this.STATE.eqPhase && this.STATE.eqPhase.get(String(r.asset_key))) || 'Unknown';
  }

  fmtAssigned(r) {
    const n = String(r.assigned_name || '').trim(), c = String(r.assigned_company || '').trim();
    if (n && c && n !== c) return `${n} (${c})`; return c || n;
  }
  
  fmtDate(v) { 
    if (!v) return ''; const d = new Date(v); return isNaN(d) ? '' :
    `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`; 
  }

  weekKey(dateStr) {
    const d = new Date(dateStr); if (isNaN(d)) return null;
    const m = new Date(d); m.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return m.toISOString().slice(0, 10);
  }

  applyFilters(rows) {
    const f = this.STATE.filters;
    return rows.filter(r => {
      if (f.discipline.length && !f.discipline.includes(r.discipline)) return false;
      if (f.contractor.length && !f.contractor.includes(r.assigned_company)) return false;
      if (f.status.length && !f.status.includes(r.status)) return false;
      if (f.phase.length && !f.phase.includes(this.phaseOf(r))) return false;
      return true;
    });
  }

  // ─── 3. PLOTLY CHART CONFIG ─────────────────────────────────────────────────

  baseLayout(extra = {}) {
    const out = Object.assign({
      plot_bgcolor: 'rgba(0,0,0,0)', paper_bgcolor: 'rgba(0,0,0,0)',
      font: { family: this.FONT, size: 11, color: this.C.muted },
      margin: { t: 30, b: 30, l: 10, r: 10 },
      legend: { bgcolor: 'rgba(0,0,0,0)', font: { color: this.C.muted, size: 11 } },
    }, extra);
    out.xaxis = Object.assign({ gridcolor: this.C.border, tickfont: { color: this.C.muted }, automargin: true }, extra.xaxis || {});
    out.yaxis = Object.assign({ gridcolor: this.C.border, tickfont: { color: this.C.muted }, automargin: true }, extra.yaxis || {});
    return out;
  }

  plot(id, traces, layout) {
    const el = this.q(id);
    if(el) Plotly.react(el, traces, this.baseLayout(layout), this.CFG);
  }

  // ─── 4. EVENTS & DATA LOADING ───────────────────────────────────────────────

  bindEvents() {
    // Native Tab Switching + Plotly Redraw
    const tabs = this.qa('.ca-tab');
    tabs.forEach(btn => {
      btn.onclick = () => {
        tabs.forEach(b => b.classList.remove('active'));
        this.qa('.ca-tabpage').forEach(p => p.classList.remove('active'));
        
        btn.classList.add('active');
        const targetPage = this.q('ca-tab-' + btn.dataset.tab);
        targetPage.classList.add('active');
        
        // Trigger window resize so Plotly natively recalculates SVGs inside the visible container
        window.dispatchEvent(new Event('resize'));
      };
    });

    ['ca-fDiscipline','ca-fContractor','ca-fStatus','ca-fPhase'].forEach(id => {
      this.q(id).addEventListener('change', () => {
        this.STATE.filters = {
          discipline: this.readCheckGroup('ca-fDiscipline'),
          contractor: this.readCheckGroup('ca-fContractor'),
          status: this.readCheckGroup('ca-fStatus'),
          phase: this.readCheckGroup('ca-fPhase'),
        };
        this.renderAll();
      });
    });

    this.q('ca-refreshBtn').onclick = async () => {
      const btn = this.q('ca-refreshBtn');
      btn.disabled = true; btn.textContent = '⏳ Refreshing…';
      try {
        if (this.REFRESH_ENDPOINT) { await fetch(this.REFRESH_ENDPOINT, { method: 'POST' }); }
        await this.loadProject();
      } finally { btn.disabled = false; btn.textContent = '🔄 Refresh Data'; }
    };
  }

  buildCheckGroup(id, values) {
    const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
    this.q(id).innerHTML = values.map(v =>
      `<label><input type="checkbox" value="${esc(v)}" /><span title="${esc(v)}">${esc(v)}</span></label>`
    ).join('');
  }

  readCheckGroup(id) {
    return [...this.container.querySelectorAll(`#${id} input[type="checkbox"]:checked`)].map(i => i.value);
  }

  rebuildFilterOptions() {
    const d = this.STATE.data;
    const disciplines = this.uniq(d.equipment.map(e => e.discipline)).filter(x => !this.isBad(x)).sort();
    const contractors = this.uniq(d.companies.map(c => c.name)).filter(x => !this.isBad(x)).sort();
    const phases = [...this.uniq(d.equipment.map(e => e.building_phase)).filter(x => x && x !== 'Unknown').sort(), 'Unknown'];
    
    this.buildCheckGroup('ca-fDiscipline', disciplines);
    this.buildCheckGroup('ca-fContractor', contractors);
    this.buildCheckGroup('ca-fStatus', this.orderVals(d.issues.map(i => i.status), this.ISSUE_STATUS_ORDER));
    this.buildCheckGroup('ca-fPhase', phases);
  }

  // Distinct values from the data, with any known ones first in a sensible
  // order and anything unrecognised appended alphabetically. Every list on
  // this page is built this way now: a hardcoded vocabulary that misses shows
  // an empty chart rather than an error, and every hardcoded list in this
  // file except the issue statuses turned out to be wrong for SAN.
  orderVals(values, preferred) {
    const present = this.uniq(values).filter(v => !this.isBad(v));
    const known = (preferred || []).filter(v => present.includes(v));
    const rest = present.filter(v => !known.includes(v)).sort();
    return [...known, ...rest];
  }

  // Deterministic colour for a value the theme has no opinion about, so a
  // level or status keeps the same colour between renders.
  autoColor(key, i) {
    const palette = ['#7F77DD','#1D9E75','#5DCAA5','#85B7EB','#E0894A','#C77DBB','#4A90D9','#9AA43C'];
    if (typeof i === 'number') return palette[i % palette.length];
    let h = 0;
    for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return palette[h % palette.length];
  }

  // ─── 1b. DATA ACCESS ────────────────────────────────────────────────────

  // Says WHY there is nothing to draw. An empty dashboard and a
  // misconfigured one look identical otherwise -- an unauthorised PostgREST
  // read returns zero rows, not an error -- so every path that ends without
  // data comes through here and names its own cause.
  status(html) {
    const el = this.q('ca-loading');
    el.style.display = 'block';
    el.innerHTML = html;
    this.q('ca-dash').style.display = 'none';
  }

  // Waits briefly for window.LP_CONFIG to be populated (it's loaded by the
  // host app's project-selection flow, which should already have finished
  // by the time someone opens this tab, but this guards against any race).
  async waitForProjectConfig_(timeoutMs = 5000) {
    const start = Date.now();
    while (!(window.LP_CONFIG && window.LP_CONFIG.projectKey)) {
      if (Date.now() - start > timeoutMs) return null;
      await new Promise(r => setTimeout(r, 150));
    }
    return window.LP_CONFIG;
  }

  async init() {
    try {
      const cfg = await this.waitForProjectConfig_();
      if (!cfg) throw new Error('No project is loaded yet (window.LP_CONFIG.projectKey is missing).');
      const label = this.q('ca-connectedProject');
      if (label) label.textContent = cfg.clientName || cfg.projectKey || 'Connected project';
      await this.loadProject();
    } catch (e) {
      this.status('Error: ' + e.message);
      console.error(e);
    }
  }

  async loadProject() {
    this.q('ca-loading').style.display = 'block';
    this.q('ca-loading').textContent = 'Loading…';
    this.q('ca-dash').style.display = 'none';

    try {
      const cfg = window.LP_CONFIG;
      const projectKey = cfg && cfg.projectKey;
      if (!projectKey) {
        throw new Error('No project is loaded yet (window.LP_CONFIG.projectKey is missing).');
      }
      // Reads a periodically-synced snapshot from Supabase instead of
      // calling the Google Apps Script endpoint live on every load — the
      // Sheets-backed dashboard data is pushed into launchpad_dashboard_data
      // on a timer (see .github/workflows/sync-equipment-tracker-data.yml
      // and sync/sync-equipment-data.mjs), so this read is as fast as
      // everything else in the app instead of waiting on Apps Script's
      // cold-start + Sheets-read latency on every visit.
      const supa = window.launchpadSupabaseClient;
      if (!supa) throw new Error('No Supabase client available yet.');
      const { data: row, error } = await supa.from('launchpad_dashboard_data')
        .select('data, synced_at')
        .eq('project_key', projectKey)
        .maybeSingle();
      if (error) throw error;
      const data = (row && row.data) || {};
      if (data && data.error) throw new Error(data.error);

      // Defensive: the Apps Script endpoint (buildDashboardJson_) always
      // returns these five as arrays, even when empty — but if the
      // getDashboardData action isn't wired into doGet yet (or the
      // deployment wasn't redeployed as a new version after adding it), a
      // request here can silently fall through to a DIFFERENT action's
      // response shape instead of failing outright, missing one or more of
      // these keys entirely. Normalizing them here means a wiring problem
      // shows up as an empty dashboard instead of a hard crash on the first
      // .map() call — see the console warning below for which key(s) were
      // actually missing, which is the real thing to go fix.
      const missingKeys = ['equipment', 'companies', 'issues', 'checklists', 'tests']
        .filter(key => !Array.isArray(data[key]));
      if (missingKeys.length) {
        console.warn(
          `Dashboard response is missing expected array field(s): ${missingKeys.join(', ')}. ` +
          `This usually means the getDashboardData action isn't reaching buildDashboardJson_ yet — ` +
          `double-check it's wired into doGet and that the Apps Script was redeployed as a NEW ` +
          `version (not just saved) after adding it. Actual response keys: ${Object.keys(data || {}).join(', ') || '(none)'}`
        );
        missingKeys.forEach(key => { data[key] = []; });
      }

      this.STATE.data = data;
      this.STATE.snapshots = await this.loadSnapshots(supa, projectKey);
      this.STATE.eqPhase = new Map(this.STATE.data.equipment.map(e => [String(e.equipment_id), e.building_phase]));
      this.STATE.filters = { discipline: [], contractor: [], status: [], phase: [] };
      this.EQ_FILTER = { bldg: 'All', floor: 'All' };

      this.rebuildFilterOptions();
      this.renderAll();

      this.q('ca-loading').style.display = 'none';
      this.q('ca-dash').style.display = 'block';
      window.dispatchEvent(new Event('resize'));
    } catch (e) {
      this.status('Error loading data: ' + e.message);
      console.error(e);
    }
  }

  // Friday snapshots of checklist counts (see dashboard-snapshots.sql). Paged
  // because Supabase caps a request at 1,000 rows. A missing table or a
  // failed read only costs the chart its history, so it never throws.
  async loadSnapshots(supa, projectKey) {
    const out = [], PAGE = 1000;
    try {
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supa.from('launchpad_checklist_snapshots')
          .select('snapshot_date, type_name, discipline, assigned_company, status, checklist_count')
          .eq('project_key', projectKey).order('snapshot_date')
          .range(from, from + PAGE - 1);
        if (error) throw error;
        out.push(...data);
        if (data.length < PAGE) break;
      }
    } catch (e) {
      console.warn('Checklist snapshots unavailable; Path to Completion will show no history.', e);
    }
    return out;
  }

  renderAll() {
    const d = this.STATE.data;
    const issues = this.applyFilters(d.issues);
    const checklists = this.applyFilters(d.checklists);
    const tests = this.applyFilters(d.tests);
    const equipment = this.applyFilters(d.equipment);
    
    this.renderIssues(issues);
    this.renderChecklists(checklists);
    this.renderTests(tests, issues);
    this.renderEquipment(equipment, checklists, tests, issues);
    
    // An admin can override the synced project_name with a cleaner display
    // name via Dashboard Settings (saved to launchpad_projects.dashboard_
    // display_name) — prefer that when set.
    const titleOverride = window.LP_CONFIG && window.LP_CONFIG.dashboardDisplayName;
    this.q('ca-pageTitle').textContent = titleOverride || d.project_name || 'Project Dashboard';
    const synced = d.data_synced_at ? new Date(d.data_synced_at) : null;
    const isData = !!(synced && !isNaN(synced));
    const stamp = isData ? synced : new Date();
    const prefix = isData ? 'Data as of: ' : 'Loaded: ';
    
    this.q('ca-pageMeta').textContent = prefix + stamp.toLocaleString('en-US', { month:'long', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });
    this.q('ca-refreshed').textContent = prefix + stamp.toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  }

  // ─── TAB 1: ISSUES ──────────────────────────────────────────────────────────

  renderIssues(issues) {
    const root = this.q('ca-tab-issues');
    if (!issues.length) { root.innerHTML = `<div class="ca-empty">No issue data available.</div>`; return; }

    const open = issues.filter(i => i.status !== 'Closed');
    this.STATE.openIssues = open;
    const dopen = (i) => +i.days_open || 0;
    const esc90 = open.filter(i => dopen(i) > 90);
    const esc60 = open.filter(i => dopen(i) > 60 && dopen(i) <= 90);
    const esc30 = open.filter(i => dopen(i) > 30 && dopen(i) <= 60);
    const highPri = open.filter(i => (i.priority || '').includes('High'));

    let html = this.section('Key Metrics') + '<div class="ca-kpi-row">' +
      this.kpi('Total Open Issues', open.length, open.length > 10 ? 'kpi-red' : 'kpi-yellow', 'non-closed') +
      this.kpi('Critical · &gt;90 Days', esc90.length, 'kpi-red', 'escalate now') +
      this.kpi('Escalate · 60–90 Days', esc60.length, 'kpi-yellow', 'past due') +
      this.kpi('Watch · 30–60 Days', esc30.length, 'kpi-blue', 'aging') +
      this.kpi('High Priority', highPri.length, 'kpi-red', 'open &amp; high') + '</div>';

    html += this.section('Issue Burn-Down &amp; Projection') + this.chartBox('ca-iss-burndown', 420) +
      '<div class="ca-caption" id="ca-iss-burncap"></div>';

    html += this.section('Issue Breakdown') +
      `<div class="ca-grid2">${this.chartBox('ca-iss-priority', 400)}${this.chartBox('ca-iss-status', 380)}</div>`;
    html += this.section('Issues by Contractor') + this.chartBox('ca-iss-contractor', 400);

    html += this.section('Escalation by Contractor') +
      `<div class="ca-slider-wrap">Show open issues aging more than
         <span id="ca-iss-thval">${this.ISS_THRESH}</span> days
         <input type="range" id="ca-iss-thresh" min="0" max="180" step="5" value="${this.ISS_THRESH}" /></div>
       <div id="ca-iss-escalation"></div>`;

    html += this.section('Open Issues Detail');
    const openDetail = issues.filter(i => i.status !== 'Closed');
    if (openDetail.length) {
      const rows = openDetail.map(i => ({
        'Issue #': i.name,
        Aging: i.aging_category === '>60 Days' ? '🔴 >60 Days'
          : i.aging_category === '45-60 Days' ? '🟡 45-60 Days' : '🟢 Under 45 Days',
        'Days Open': i.days_open, Priority: i.priority, Division: i.discipline,
        'Assigned To': this.fmtAssigned(i), Status: i.status, Description: i.description,
      }));
      html += this.table(['Issue #','Aging','Days Open','Priority','Division','Assigned To','Status','Description'].map(k => ({ k, label: k })), rows);
    } else { html += `<div class="ca-ok">✅ No open issues with current filters.</div>`; }

    const allRows = issues.map(i => ({
      'Issue #': i.name, Priority: i.priority, Status: i.status, Division: i.discipline,
      'Assigned To': this.fmtAssigned(i), 'Date Created': this.fmtDate(i.date_created),
      'In Progress Date': this.fmtDate(i.in_progress_date), 'Date Closed': this.fmtDate(i.date_closed),
      'Days Open': i.days_open, Description: i.description,
    }));
    html += `<details><summary>📄 View All Issues (${issues.length})</summary>` +
      this.table(['Issue #','Priority','Status','Division','Assigned To','Date Created',
        'In Progress Date','Date Closed','Days Open','Description'].map(k => ({ k, label: k })), allRows) +
      `</details>`;
    root.innerHTML = html;

    this.renderBurndown(issues);
    this.renderEscalation();
    const th = this.q('ca-iss-thresh');
    if (th) th.addEventListener('input', () => {
      this.ISS_THRESH = +th.value;
      this.q('ca-iss-thval').textContent = this.ISS_THRESH;
      this.renderEscalation();
    });

    const pri = this.groupSize(issues, 'priority').filter(d => !this.isBad(d.key));
    const sev = (p) => { p = p.toLowerCase();
      if (['critical','p0','high'].some(x => p.includes(x))) return 0;
      if (['moderate','p1','medium'].some(x => p.includes(x))) return 1;
      if (['low','p2','minor'].some(x => p.includes(x))) return 2; return 3; };
    pri.sort((a, b) => sev(a.key) - sev(b.key));
    const priScale = ['#E04040','#F4B942','#39B54A','#4A90D9','#8A8F98'];
    this.plot('ca-iss-priority', [{
      type: 'pie', hole: 0.65, labels: pri.map(d => d.key), values: pri.map(d => d.count),
      marker: { colors: pri.map((_, i) => priScale[i % priScale.length]), line: { color: this.C.panel, width: 2 } },
      textinfo: 'none', hovertemplate: '<b>%{label}</b><br>%{value} (%{percent})<extra></extra>',
    }], {
      title: { text: 'All Issues by Priority', font: { color: this.C.muted, family: this.COND, size: 12 } },
      showlegend: true,
      legend: { orientation: 'v', y: -0.1, yanchor: 'top', x: 0, xanchor: 'left' },
      margin: { t: 40, b: 120, l: 10, r: 10 }
    });

    const statusColors = { Open:'#E04040','In Progress':'#4A90D9','Pending Review':'#F4B942','Pending Verification':'#F4B942', Closed:'#39B54A', Void:'#8A8F98' };
    const st = this.groupSize(issues, 'status');
    this.plot('ca-iss-status', [{ type: 'bar', x: st.map(d => d.key), y: st.map(d => d.count), marker: { color: st.map(d => statusColors[d.key] || this.C.muted) } }],
      { title: { text: 'All Issues by Status', font: { color: this.C.muted, family: this.COND, size: 12 } }, margin: { t: 40, b: 40, l: 10, r: 10 } });

    const con = this.groupSize(issues, 'assigned_company').sort((a, b) => b.count - a.count).slice(0, 15);
    this.plot('ca-iss-contractor', [{ type: 'bar', x: con.map(d => d.key), y: con.map(d => d.count), marker: { color: con.map(d => d.count), colorscale: 'Blues' } }],
      { title: { text: 'All Issues per Contractor', font: { color: this.C.muted, family: this.COND, size: 12 } }, xaxis: { tickangle: -35, tickfont: { color: this.C.muted } }, margin: { t: 40, b: 90, l: 10, r: 10 } });
  }

  renderBurndown(issues) {
    const box = this.q('ca-iss-burndown');
    const cap = this.q('ca-iss-burncap');
    const cMap = new Map(), xMap = new Map();
    for (const i of issues) {
      if (i.date_created) { const w = this.weekKey(i.date_created); if (w) cMap.set(w, (cMap.get(w) || 0) + 1); }
      if (i.date_closed)  { const w = this.weekKey(i.date_closed);  if (w) xMap.set(w, (xMap.get(w) || 0) + 1); }
    }
    if (!cMap.size) { box.innerHTML = '<div class="ca-empty">No dated issues to chart.</div>'; cap.textContent = ''; return; }
    const first = [...cMap.keys(), ...xMap.keys()].sort()[0];
    const weeks = [];
    for (let d = new Date(first); d <= new Date(); d.setDate(d.getDate() + 7)) weeks.push(d.toISOString().slice(0, 10));
    let cumC = 0, cumX = 0;
    const openY = [], weeklyClosed = [], weeklyCreated = [];
    for (const w of weeks) {
      cumC += cMap.get(w) || 0; cumX += xMap.get(w) || 0;
      openY.push(cumC - cumX); weeklyClosed.push(xMap.get(w) || 0); weeklyCreated.push(cMap.get(w) || 0);
    }
    this.plot('ca-iss-burndown', [
      { type: 'bar', name: 'Opened', x: weeks, y: weeklyCreated, marker: { color: this.C.border } },
      { type: 'bar', name: 'Closed', x: weeks, y: weeklyClosed, marker: { color: this.C.green } },
      { type: 'scatter', mode: 'lines+markers', name: 'Open backlog', x: weeks, y: openY, line: { color: this.C.red, width: 2 }, marker: { size: 5 } },
    ], {
      barmode: 'group', legend: { orientation: 'v', y: -0.15, yanchor: 'top', x: 0, xanchor: 'left' },
      xaxis: { gridcolor: this.C.border, tickfont: { color: this.C.muted } }, yaxis: { title: 'Issues', gridcolor: this.C.border, tickfont: { color: this.C.muted } },
      margin: { t: 40, b: 100, l: 40, r: 10 }
    });

    const last3 = weeklyClosed.slice(-3);
    const avg = last3.length ? last3.reduce((a, b) => a + b, 0) / last3.length : 0;
    const backlog = openY[openY.length - 1] || 0;
    if (avg > 0) {
      const wks = Math.ceil(backlog / avg);
      const proj = new Date(Date.now() + wks * 7 * 864e5);
      cap.innerHTML = `Trailing 3-week close rate: <b>${avg.toFixed(1)}</b>/wk · Open backlog: <b>${backlog}</b> · ` +
        `At this pace, cleared in ~<b>${wks}</b> weeks (${proj.toLocaleDateString('en-US')}). <span style="color:var(--muted)">Indicative — issue closures only.</span>`;
    } else {
      cap.innerHTML = `Open backlog: <b>${backlog}</b> · No closures in the last 3 weeks — projection unavailable.`;
    }
  }

  renderEscalation() {
    const root = this.q('ca-iss-escalation');
    if (!root) return;
    const open = this.STATE.openIssues || [];
    const th = this.ISS_THRESH;
    const aged = open.filter(i => (+i.days_open || 0) > th);
    if (!aged.length) { root.innerHTML = `<div class="ca-ok">✅ No open issues aging more than ${th} days.</div>`; return; }
    const cos = this.uniq(aged.map(i => i.assigned_company || 'Unassigned'));
    const rows = cos.map(co => {
      const r = aged.filter(i => (i.assigned_company || 'Unassigned') === co);
      const inBand = (lo, hi) => r.filter(i => { const d = +i.days_open || 0; return d > lo && (hi == null || d <= hi); }).length;
      return { Contractor: co, 'Aged Issues': r.length, '🔴 &gt;90d': inBand(90, null),
        '🟡 60–90d': inBand(60, 90), '🔵 30–60d': inBand(30, 60), 'Oldest (days)': Math.max(...r.map(i => +i.days_open || 0)) };
    }).sort((a, b) => b['Aged Issues'] - a['Aged Issues']);
    root.innerHTML = `<div class="ca-caption">${aged.length} open issue(s) aging more than ${th} days, across ${cos.length} contractor(s).</div>` +
      this.table(['Contractor','Aged Issues','🔴 &gt;90d','🟡 60–90d','🔵 30–60d','Oldest (days)'].map(k => ({ k, label: k })), rows);
  }

  // ─── TAB 2: CHECKLISTS ──────────────────────────────────────────────────────

  renderChecklists(cl) {
    const root = this.q('ca-tab-checklists');
    if (!cl.length) { root.innerHTML = `<div class="ca-empty">No checklist data available.</div>`; return; }

    // SAN's Apps Script stamps every checklist level 'L1' and carries the
    // real CxAlloy checklist type in type_name. When level has only one value
    // across the whole project it says nothing, so group by type_name instead
    // (null -> 'Untyped'). Decided on the unfiltered data so a filter can't
    // flip the grouping; projects with real levels (STY4's L2-FAT) keep them.
    const all = this.STATE.data.checklists;
    const levelIsFlat = this.uniq(all.map(c => c.level)).length <= 1 &&
                        all.some(c => c.type_name);
    if (levelIsFlat) cl = cl.map(c => ({ ...c, level: c.type_name || 'Untyped' }));

    // Levels come from the data. The old hardcoded ['L2','L3','L4','FAT']
    // matches NOTHING in either SAN project -- theirs read Pre-Functional,
    // Closeout, Documentation Review and Other -- so `active` came back empty
    // and this whole tab rendered as four missing donuts. Known names are
    // ordered first purely for display; anything else is appended.
    const active = this.orderVals(cl.map(c => c.level),
      ['L2','L3','L4','FAT','Pre-Functional','Functional','Documentation Review','Closeout']);

    // Path to Completion tracks Pre-Functional only (the old PHXA7 chart's
    // scope); a project without that type falls back to every checklist.
    const preFunc = cl.filter(c => c.type_name === 'Pre-Functional');
    const paceRows = preFunc.length ? preFunc : cl;
    const paceScope = preFunc.length ? 'Pre-Functional' : null;
    let html = this.section(`${preFunc.length ? 'Pre-Functional Checklists' : 'Checklists'} &mdash; Path to Completion`) +
      `<div class="ca-pace-controls"><label for="ca-pace-date">Est. completion date</label><input type="date" id="ca-pace-date" /></div>` +
      '<div class="ca-kpi-row" id="ca-pace-kpis"></div>' + this.chartBox('ca-pace-chart', 380) +
      '<div class="ca-caption" id="ca-pace-caption"></div>';
    html += this.section('Checklist Status by Level') +
      `<div class="ca-kpi-row" style="grid-template-columns:repeat(${active.length},minmax(0,1fr))">` +
      active.map((lv, i) => this.chartBox(`ca-cl-donut-${i}`, 420)).join('') + '</div>';
    html += this.section('Completion by Discipline') + this.chartBox('ca-cl-disc', 400);
    html += this.section('Checklists by Level &amp; Discipline') + this.chartBox('ca-cl-leveldisc', 420);
    html += this.section('Open Checklists by Company &amp; Level') + this.chartBox('ca-cl-company', 460);
    html += this.section('Completion by Contractor') + '<div id="ca-cl-contractor-table"></div>';
    html += '<div id="ca-cl-pending"></div>';
    root.innerHTML = html;

    // The date is remembered per project in this browser only. There is no
    // project-level column for it yet; moving it to launchpad_projects would
    // share it between viewers.
    const dateInput = this.q('ca-pace-date');
    try { dateInput.value = localStorage.getItem(this.paceKey()) || ''; } catch (e) {}
    dateInput.addEventListener('change', () => {
      try { localStorage.setItem(this.paceKey(), dateInput.value); } catch (e) {}
      this.renderPace(paceRows, paceScope);
    });
    this.renderPace(paceRows, paceScope);

    // Both maps were keyed on vocabularies that do not occur in SAN, so every
    // slice fell through to the border grey. The donut now colours by whether
    // a status is VERIFIED rather than by its spelling -- green for verified
    // whatever it is called, a stable colour otherwise -- which is the only
    // version that works for a client whose statuses nobody has seen yet.
    const verifiedStatuses = new Set(cl.filter(c => this.isComplete(c)).map(c => c.status));
    // Completed statuses get distinct shades of green so contractor-complete
    // and Cx-verified stay distinguishable in the same donut.
    const dcStatusColors = { 'Not Started':'#8A8F98','In Progress':'#F5A623','GC to Verify':'#4A90D9','Finished':'#39B54A',
                             'Checklist Complete':'#8BD17C','Verified':'#39B54A','Verified - Not Included in Sampling':'#1E7A34' };
    const statusColor = (s) => dcStatusColors[s] || (verifiedStatuses.has(s) ? this.C.green : this.autoColor(s));

    const levelColors = { L2:'#7F77DD', L3:'#1D9E75', L4:'#5DCAA5', FAT:'#85B7EB' };
    active.forEach((lv, i) => { if (!levelColors[lv]) levelColors[lv] = this.autoColor(lv, i); });

    active.forEach((lv, i) => {
      const sub = cl.filter(c => c.level === lv);
      const sc = this.groupSize(sub, 'status');
      this.plot(`ca-cl-donut-${i}`, [{
        type: 'pie', hole: 0.65, labels: sc.map(d => d.key), values: sc.map(d => d.count),
        marker: { colors: sc.map(d => statusColor(d.key)) },
        textinfo: 'percent', textfont: { size: 10, color: '#23262B', family: this.FONT }, hovertemplate: '%{label}: %{value}<extra></extra>',
      }], {
        title: { text: lv, font: { size: 16, color: levelColors[lv] || this.C.text, family: this.COND }, x: 0.5, xanchor: 'center' },
        annotations: [{ text: `<b>${sub.length.toLocaleString()}</b>`, x: 0.5, y: 0.5, showarrow: false, font: { size: 20, color: this.C.text, family: this.COND } }],
        showlegend: true, legend: { orientation: 'v', y: -0.1, yanchor: 'top', x: 0, xanchor: 'left' }, margin: { t: 30, b: 140, l: 5, r: 5 }
      });
    });

    const discs = this.uniq(cl.map(c => c.discipline)).filter(d => !this.isBad(d));
    const dc = discs.map(d => {
      const rows = cl.filter(c => c.discipline === d);
      const done = rows.filter(c => this.isComplete(c)).length;
      const verified = rows.filter(c => this.isVerified(c)).length;
      const pctOf = (n) => rows.length ? +(n / rows.length * 100).toFixed(1) : 0;
      return { discipline: d, total: rows.length, done, verified, contractorDone: done - verified,
               remaining: rows.length - done, pct: pctOf(done), verifiedPct: pctOf(verified), contractorPct: pctOf(done - verified) };
    }).sort((a, b) => a.total - b.total);

    // Verified (Cx approved) and contractor-complete are stacked separately,
    // matching the donut's greens. Counts live in the hover: the green
    // segments are usually too thin to hold a label.
    const discHover = (label) => `%{y}<br>${label}: %{x} (%{customdata}%)<extra></extra>`;
    this.plot('ca-cl-disc', [
      { type: 'bar', orientation: 'h', y: dc.map(d => d.discipline), x: dc.map(d => d.verified), name: 'Verified (Cx)', marker: { color: '#39B54A' }, customdata: dc.map(d => d.verifiedPct), hovertemplate: discHover('Verified (Cx)') },
      { type: 'bar', orientation: 'h', y: dc.map(d => d.discipline), x: dc.map(d => d.contractorDone), name: 'Checklist Complete (contractor)', marker: { color: '#8BD17C' }, customdata: dc.map(d => d.contractorPct), hovertemplate: discHover('Checklist Complete') },
      { type: 'bar', orientation: 'h', y: dc.map(d => d.discipline), x: dc.map(d => d.remaining), name: 'Remaining', marker: { color: this.C.border }, text: dc.map(d => String(d.total)), textposition: 'outside', textfont: { color: this.C.muted, family: this.FONT }, hovertemplate: '%{y}<br>Remaining: %{x}<extra></extra>' },
    ], { barmode: 'stack', legend: { orientation: 'v', y: -0.2, yanchor: 'top', x: 0, xanchor: 'left' }, yaxis: { tickfont: { color: this.C.muted, size: 10 }, automargin: true }, margin: { t: 10, b: 100, l: 10, r: 40 } });

    const discColors = { Mechanical:'#E74C3C', Electrical:'#F5A623', 'Electrical Power Monitoring System':'#4A90D9', 'Fire Protection':'#39B54A' };
    const discAbbr = { 'Electrical Power Monitoring System':'EPMS' };
    // discColors only knows the old bare names; SAN's read 'Div. 23 -
    // HVAC/Mechanical' etc., so every bar fell back to grey. Unknown
    // disciplines get a palette colour by alphabetical position, so a
    // discipline keeps its colour between loads.
    const discOrder = [...discs].sort();
    const discColor = (d) => discColors[d] || this.autoColor(d, discOrder.indexOf(d));
    const levelTotals = active.map(lv => cl.filter(c => c.level === lv).length);
    const ldTraces = discs.map(d => {
      const perLevel = active.map(lv => cl.filter(c => c.level === lv && c.discipline === d).length);
      // Segments under 3% of their bar are too thin to hold a label; the
      // count is still in the hover.
      return { type: 'bar', orientation: 'h', name: discAbbr[d] || d, y: active, x: perLevel, marker: { color: discColor(d) }, text: perLevel.map((v, i) => v && v / levelTotals[i] >= 0.03 ? v : ''), textposition: 'inside', textfont: { color: '#23262B', family: this.FONT }, hovertemplate: `${d}: %{x}<extra></extra>` };
    });
    this.plot('ca-cl-leveldisc', ldTraces, { barmode: 'stack', yaxis: { categoryorder: 'array', categoryarray: [...active].reverse(), tickfont: { color: this.C.text, size: 13 }, automargin: true }, legend: { orientation: 'v', y: -0.2, yanchor: 'top', x: 0, xanchor: 'left' }, margin: { t: 40, b: 120, l: 10, r: 20 } });

    const openCl = cl.filter(c => !this.isComplete(c) && active.includes(c.level));
    const coTotals = this.groupSize(openCl, 'assigned_company').sort((a, b) => b.count - a.count).slice(0, 10);
    const topCos = coTotals.map(d => d.key);
    const coTraces = active.map(lv => ({
      type: 'bar', name: lv, x: topCos, y: topCos.map(co => openCl.filter(c => c.assigned_company === co && c.level === lv).length), marker: { color: levelColors[lv] || this.C.muted },
    }));
    this.plot('ca-cl-company', coTraces, { barmode: 'group', xaxis: { tickangle: -35, tickfont: { color: this.C.muted }, automargin: true }, yaxis: { gridcolor: this.C.border, tickfont: { color: this.C.muted }, automargin: true }, legend: { orientation: 'v', y: -0.3, yanchor: 'top', x: 0, xanchor: 'left' }, margin: { t: 40, b: 160, l: 10, r: 10 } });

    const unassigned = ['not assigned yet','not assigned','','nan','none'];
    const classify = (c) => {
      const name = String(c.assigned_company || '').trim().toLowerCase();
      const atype = String(c.assigned_type || '').trim().toLowerCase();
      if (unassigned.includes(name)) return 'unassigned';
      if (atype === 'role') return 'role'; return 'contractor';
    };
    const contractorCl = cl.filter(c => classify(c) === 'contractor');
    const coSummary = this.uniq(contractorCl.map(c => c.assigned_company)).map(co => {
      const rows = contractorCl.filter(c => c.assigned_company === co);
      const done = rows.filter(c => this.isComplete(c)).length;
      return { Contractor: co, Total: rows.length, Completed: done, 'Completion %': rows.length ? +(done / rows.length * 100).toFixed(1) : 0 };
    }).sort((a, b) => b.Total - a.Total);
    this.q('ca-cl-contractor-table').innerHTML = this.table(['Contractor','Total','Completed','Completion %'].map(k => ({ k, label: k })), coSummary);

    const pending = cl.filter(c => ['role','unassigned'].includes(classify(c)));
    if (pending.length) {
      const ps = this.groupSize(pending, 'assigned_company').map(d => ({ 'Role / Status': unassigned.includes(String(d.key).trim().toLowerCase()) ? '⚠️ No Contractor Assigned' : d.key, Count: d.count })).sort((a, b) => b.Count - a.Count);
      this.q('ca-cl-pending').innerHTML = this.section('Pending Assignment') + this.table(['Role / Status','Count'].map(k => ({ k, label: k })), ps);
    }
  }

  paceKey() { return 'ca_pace_target_' + ((window.LP_CONFIG && window.LP_CONFIG.projectKey) || ''); }

  // Green: the Friday snapshots (dashboard-snapshots.sql), each the verified
  // total on that date -- the old PHXA7 chart's method. The step between two
  // Fridays is what got verified that week. A hollow marker shows today's
  // live count, so the current week is visible before its Friday.
  // Red: the pace required from today's count to reach 100% on the
  // estimated completion date, i.e. remaining / weeks left. It treats every
  // checklist as interchangeable -- sequencing is not modelled.
  renderPace(rows, scopeType) {
    const DAY = 86400000, WEEK = 7 * DAY;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const input = this.q('ca-pace-date');
    const target = input.value ? new Date(input.value + 'T00:00:00') : null;

    const total = rows.length;
    const done = rows.filter(c => this.isVerified(c)).length, remaining = total - done;
    const pct = total ? (done / total * 100).toFixed(1) : '0.0';

    // Snapshots are filtered like the live rows so the line agrees with the
    // cards. The phase filter cannot apply: snapshots carry no asset.
    const f = this.STATE.filters;
    const perDate = new Map();
    (this.STATE.snapshots || []).forEach(s => {
      if (scopeType && s.type_name !== scopeType) return;
      if (f.discipline.length && !f.discipline.includes(s.discipline)) return;
      if (f.contractor.length && !f.contractor.includes(s.assigned_company)) return;
      if (f.status.length && !f.status.includes(s.status)) return;
      perDate.set(s.snapshot_date, (perDate.get(s.snapshot_date) || 0) +
        (this.isVerified({ status: s.status }) ? s.checklist_count : 0));
    });
    const dates = [...perDate.keys()].sort();
    const greenX = dates.map(d => new Date(d + 'T00:00:00')), greenY = dates.map(d => perDate.get(d));

    // Current pace: average weekly gain across the last four snapshots.
    let pace = null;
    if (dates.length >= 2) {
      const back = Math.min(4, dates.length - 1);
      const weeks = (greenX.at(-1) - greenX.at(-1 - back)) / WEEK;
      if (weeks > 0) pace = (greenY.at(-1) - greenY.at(-1 - back)) / weeks;
    }

    const weeksLeft = target ? (target - today) / WEEK : null;
    const redX = [], redY = [];
    let required = null;
    if (target && weeksLeft > 0 && remaining > 0) {
      required = remaining / weeksLeft;
      for (let i = 0; today.getTime() + i * WEEK < target; i++) {
        redX.push(new Date(today.getTime() + i * WEEK));
        redY.push(Math.min(total, Math.round(done + required * i)));
      }
      redX.push(target); redY.push(total);
    }

    const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    let requiredVal = '—', requiredSub = 'Set a completion date', requiredCls = 'kpi-white';
    if (remaining === 0) { requiredVal = '0'; requiredSub = 'All verified'; requiredCls = 'kpi-green'; }
    else if (target && weeksLeft <= 0) { requiredVal = '—'; requiredSub = 'Completion date has passed'; requiredCls = 'kpi-red'; }
    else if (required !== null) {
      requiredVal = required.toFixed(1);
      requiredSub = 'checklists / week';
      requiredCls = pace === null ? 'kpi-yellow' : (pace >= required ? 'kpi-green' : 'kpi-red');
    }
    const paceVal = pace === null ? '—' : pace.toFixed(1);
    const paceSub = pace === null ? 'Needs 2 Friday snapshots' :
      (pace > 0 && remaining ? `Projected finish ${fmt(new Date(today.getTime() + remaining / pace * WEEK))}` : 'per week, last 4 weeks');

    this.q('ca-pace-kpis').innerHTML =
      this.kpi('Verified', done.toLocaleString(), 'kpi-green', `of ${total.toLocaleString()} (${pct}%)`) +
      this.kpi('Remaining', remaining.toLocaleString(), 'kpi-white') +
      this.kpi('Weeks Left', weeksLeft === null ? '—' : Math.max(0, weeksLeft).toFixed(1), 'kpi-white', target ? `to ${fmt(target)}` : 'Set a completion date') +
      this.kpi('Required Pace', requiredVal, requiredCls, requiredSub) +
      this.kpi('Current Pace', paceVal, 'kpi-white', paceSub);

    const hover = (label) => `${label}<br>%{x|%b %d, %Y}: %{y:,}<extra></extra>`;
    const traces = [];
    if (greenX.length) traces.push({
      type: 'scatter', mode: 'lines+markers', name: 'Verified (Friday snapshot)',
      x: greenX, y: greenY, line: { color: this.C.green, shape: 'hv', width: 2 }, marker: { color: this.C.green, size: 6 },
      fill: 'tozeroy', fillcolor: 'rgba(57,181,74,0.25)', hovertemplate: hover('Verified'),
    });
    traces.push({
      type: 'scatter', mode: 'markers', name: 'Verified today (live)', x: [today], y: [done],
      marker: { color: 'rgba(0,0,0,0)', size: 11, line: { color: this.C.green, width: 2 } }, hovertemplate: hover('Verified today'),
    });
    if (redX.length) traces.push({
      type: 'scatter', mode: 'lines', name: 'Required to meet completion date',
      x: redX, y: redY, line: { color: this.C.red, shape: 'hv', width: 2 }, hovertemplate: hover('Required'),
    });
    this.plot('ca-pace-chart', traces, {
      xaxis: { type: 'date', tickformat: '%m/%d/%y', gridcolor: this.C.border, tickfont: { color: this.C.muted }, automargin: true },
      yaxis: { range: [0, total * 1.05], gridcolor: this.C.border, tickfont: { color: this.C.muted }, automargin: true },
      shapes: [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: total, y1: total, line: { color: this.C.muted, dash: 'dot', width: 1 } }],
      legend: { orientation: 'h', y: 1.08, x: 0 }, margin: { t: 40, b: 40, l: 10, r: 10 },
    });

    const notes = [];
    if (!dates.length) notes.push('Verified history is saved every Friday evening; the first point appears after the next snapshot.');
    if (f.phase.length && dates.length) notes.push('The Building Phase filter applies to today\'s count but not to the Friday history.');
    this.q('ca-pace-caption').textContent = notes.join(' ');
  }

  // ─── TAB 3: TESTS ───────────────────────────────────────────────────────────

  renderTests(tests, issues) {
    const root = this.q('ca-tab-tests');
    if (!tests.length) { root.innerHTML = `<div class="ca-empty">No functional test data available.</div>`; return; }
    issues = issues || [];

    const total = tests.length;
    const passed = tests.filter(t => this.TEST_PASS_STATUSES.includes(t.status)).length;
    const failed = tests.filter(t => this.TEST_FAIL_STATUSES.includes(t.status)).length;
    // Was a count of status === 'Not Started', which occurs in no SAN project
    // and so read a permanent 0 while hundreds of tests sat in 'Script In
    // Development' and 'Assigned'. Everything that is neither a pass nor a
    // fail is counted instead, so the three KPIs always sum to the total
    // whatever a client calls its statuses.
    const outstanding = total - passed - failed;
    const passRate = total ? (passed / total * 100) : 0;

    let html = this.section('Functional Test Summary') + '<div class="ca-kpi-row">' +
      this.kpi('Total Tests', total, 'kpi-white') + this.kpi('Passed', passed, 'kpi-green') +
      this.kpi('Failed', failed, 'kpi-red') + this.kpi('Outstanding', outstanding, 'kpi-white') + '</div>';
    html += `<div class="ca-grid2" style="margin-top:16px">
      <div>${this.section('Tests by Status')}${this.chartBox('ca-ts-status', 400)}</div>
      <div>${this.section('Pass Rate')}${this.chartBox('ca-ts-gauge', 360)}</div></div>`;
    html += this.section('Results by Equipment Unit') + this.chartBox('ca-ts-unit', 420);
    html += this.section('Results by Contractor') + this.chartBox('ca-ts-contractor', 420);
    html += this.section('Test Attempt Concentration') + `<div class="ca-caption">More attempts = more re-testing effort (and burn). Darker cells are being run repeatedly.</div>` + this.chartBox('ca-ts-heat', 340);
    html += this.section('Open Issues by Test Attempt Count') + `<div class="ca-caption">How many open issues sit on equipment at each attempt level.</div>` + this.chartBox('ca-ts-issattempt', 280);
    
    const allRows = tests.map(t => ({ Name: t.name, Status: t.status, 'Assigned To': t.assigned_name, Discipline: t.discipline, Attempts: t.attempt_count, Asset: t.asset_name }));
    html += `<details><summary>View All Tests (${tests.length})</summary>` + this.table(['Name','Status','Assigned To','Discipline','Attempts','Asset'].map(k => ({ k, label: k })), allRows) + `</details>`;
    root.innerHTML = html;

    const tsColors = { Passed:'#39B54A', Failed:'#E04040', 'Not Started':'#3E4248', 'In Progress':'#4A90D9' };
    const sc = this.groupSize(tests, 'status');
    this.plot('ca-ts-status', [{ type: 'pie', hole: 0.65, labels: sc.map(d => d.key), values: sc.map(d => d.count), marker: { colors: sc.map(d => tsColors[d.key] || this.C.muted) }, textinfo: 'percent', textfont: { size: 11, color: this.C.text, family: this.FONT }, hovertemplate: '%{label}: %{value}<extra></extra>' }],
      { annotations: [{ text: `<b>${total}</b>`, x: 0.5, y: 0.5, showarrow: false, font: { size: 22, color: this.C.text, family: this.COND } }], showlegend: true, legend: { orientation: 'v', y: -0.1, yanchor: 'top', x: 0, xanchor: 'left' }, margin: { t: 10, b: 120, l: 10, r: 10 } });

    this.plot('ca-ts-gauge', [{ type: 'indicator', mode: 'gauge+number', value: +passRate.toFixed(1), number: { suffix: '%', font: { size: 36, color: this.C.text, family: this.COND } }, gauge: { axis: { range: [0, 100], tickfont: { color: this.C.muted } }, bar: { color: this.C.green }, bgcolor: this.C.border, borderwidth: 0, threshold: { line: { color: this.C.text, width: 2 }, thickness: 0.75, value: passRate } } }],
      { margin: { t: 40, b: 10, l: 30, r: 30 } });

    const unitOf = (a) => { const m = String(a || '').match(/^([A-Za-z]+\d+)/); return m ? m[1] : null; };
    const units = this.uniq(tests.map(t => unitOf(t.asset_name)).filter(Boolean)).sort();
    // One trace per status ACTUALLY present, rather than three fixed traces
    // for statuses SAN does not use -- which drew three empty bars per unit.
    const byUnit = (st) => units.map(u => tests.filter(t => unitOf(t.asset_name) === u && t.status === st).length);
    const unitStatuses = this.orderVals(tests.map(t => t.status),
      [...this.TEST_PASS_STATUSES, ...this.TEST_FAIL_STATUSES]);
    this.plot('ca-ts-unit', unitStatuses.map((st, i) => ({
      type: 'bar', name: st, x: units, y: byUnit(st),
      marker: { color: tsColors[st] || this.autoColor(st, i) },
    })), { barmode: 'stack', legend: { orientation: 'v', y: -0.2, yanchor: 'top', x: 0, xanchor: 'left' }, margin: { t: 40, b: 120, l: 10, r: 10 } });

    const cos = this.uniq(tests.map(t => t.assigned_company)).map(co => {
      const rows = tests.filter(t => t.assigned_company === co);
      const p = rows.filter(t => this.TEST_PASS_STATUSES.includes(t.status)).length, f = rows.filter(t => this.TEST_FAIL_STATUSES.includes(t.status)).length;
      return { co, total: rows.length, passed: p, failed: f, other: rows.length - p - f };
    }).sort((a, b) => a.total - b.total);
    this.plot('ca-ts-contractor', [
      { type: 'bar', orientation: 'h', name: 'Passed', y: cos.map(d => d.co), x: cos.map(d => d.passed), marker: { color: this.C.green } },
      { type: 'bar', orientation: 'h', name: 'Failed', y: cos.map(d => d.co), x: cos.map(d => d.failed), marker: { color: this.C.red } },
      { type: 'bar', orientation: 'h', name: 'Not Started / In Progress', y: cos.map(d => d.co), x: cos.map(d => d.other), marker: { color: this.C.border } },
    ], { barmode: 'stack', legend: { orientation: 'v', y: -0.2, yanchor: 'top', x: 0, xanchor: 'left' }, yaxis: { tickfont: { color: this.C.text, size: 11 } }, margin: { t: 40, b: 120, l: 10, r: 40 }, height: Math.max(380, cos.length * 60) });

    const atts = this.uniq(tests.map(t => +t.attempt_count || 0).filter(n => n > 0)).sort((a, b) => a - b);
    const heatUnits = this.uniq(tests.map(t => unitOf(t.asset_name)).filter(Boolean)).sort();
    if (atts.length && heatUnits.length) {
      const z = heatUnits.map(u => atts.map(a => tests.filter(t => unitOf(t.asset_name) === u && (+t.attempt_count || 0) === a).length));
      this.plot('ca-ts-heat', [{ type: 'heatmap', x: atts.map(a => a + (a === 1 ? ' attempt' : ' attempts')), y: heatUnits, z, colorscale: [[0, this.C.panel], [0.01, this.C.border], [0.5, this.C.yellow], [1, this.C.red]], showscale: true, xgap: 2, ygap: 2, hovertemplate: 'Unit %{y} · %{x} · %{z} test(s)<extra></extra>' }],
        { xaxis: { tickfont: { color: this.C.muted } }, yaxis: { tickfont: { color: this.C.text, size: 10 }, automargin: true }, margin: { t: 10, b: 30, l: 10, r: 10 } });
    } else { this.q('ca-ts-heat').innerHTML = '<div class="ca-empty">No attempt data to chart.</div>'; }

    const assetAttempt = new Map();
    for (const t of tests) { const k = String(t.asset_key); const a = +t.attempt_count || 0; assetAttempt.set(k, Math.max(assetAttempt.get(k) || 0, a)); }
    const issAttempt = atts.map(a => {
      const assets = new Set([...assetAttempt.entries()].filter(([, v]) => v === a).map(([k]) => k));
      return { a, n: issues.filter(i => i.status !== 'Closed' && assets.has(String(i.asset_key))).length };
    });
    if (issAttempt.some(d => d.n > 0)) {
      this.plot('ca-ts-issattempt', [{ type: 'bar', x: issAttempt.map(d => '#' + d.a), y: issAttempt.map(d => d.n), marker: { color: this.C.red }, text: issAttempt.map(d => d.n || ''), textposition: 'outside', textfont: { color: this.C.muted, family: this.FONT } }],
        { xaxis: { title: 'Attempt count', tickfont: { color: this.C.muted } }, yaxis: { title: 'Open issues', gridcolor: this.C.border, tickfont: { color: this.C.muted } }, margin: { t: 10, b: 40, l: 40, r: 10 } });
    } else { this.q('ca-ts-issattempt').innerHTML = '<div class="ca-empty">No open issues linked to tested equipment.</div>'; }
  }

  // ─── TAB 4: EQUIPMENT ───────────────────────────────────────────────────────

  renderEquipment(equipment, checklists, tests, issues) {
    const root = this.q('ca-tab-equipment');
    if (!equipment.length) { root.innerHTML = `<div class="ca-empty">No equipment data available.</div>`; return; }

    const clAgg = new Map(), tsAgg = new Map(), issAgg = new Map();
    for (const c of checklists) { const k = String(c.asset_key); const a = clAgg.get(k) || { total: 0, done: 0 }; a.total++; if (this.isComplete(c)) a.done++; clAgg.set(k, a); }
    for (const t of tests) { const k = String(t.asset_key); const a = tsAgg.get(k) || { total: 0, passed: 0, failed: 0 }; a.total++; if (this.TEST_PASS_STATUSES.includes(t.status)) a.passed++; if (this.TEST_FAIL_STATUSES.includes(t.status)) a.failed++; tsAgg.set(k, a); }
    for (const i of issues) { const k = String(i.asset_key); const a = issAgg.get(k) || { total: 0, open: 0 }; a.total++; if (this.ISSUE_OPEN_STATUSES.includes(i.status)) a.open++; issAgg.set(k, a); }

    const eq = equipment.map(e => {
      const k = String(e.equipment_id);
      const cl = clAgg.get(k) || { total: 0, done: 0 };
      const ts = tsAgg.get(k) || { total: 0, passed: 0, failed: 0 };
      const is = issAgg.get(k) || { total: 0, open: 0 };
      return { ...e, cl_total: cl.total, cl_done: cl.done, ts_total: ts.total, ts_passed: ts.passed, ts_failed: ts.failed, iss_total: is.total, iss_open: is.open };
    });

    const total = eq.length;
    const delivered = eq.filter(e => e.status === 'Delivered').length;
    const installing = eq.filter(e => e.status === 'Installation in Progress').length;
    const released = eq.filter(e => e.status === 'Released').length;

    const bldgs = ['All', ...this.uniq(eq.map(e => e.building_phase)).filter(b => b && b !== 'Unknown').sort()];
    const floors = ['All', ...this.uniq(eq.map(e => e.floor_parsed)).filter(f => f && f !== 'Unknown').sort()];

    let html = this.section('Equipment Overview') + '<div class="ca-kpi-row">' +
      this.kpi('Total Equipment', total, 'kpi-white') + this.kpi('Released', released, 'kpi-white') +
      this.kpi('Delivered', delivered, 'kpi-blue') + this.kpi('Installing', installing, 'kpi-green') + '</div>';
    html += `<div class="ca-eq-filters" style="margin-top:16px">
      <div><div class="ca-side-label">Building Phase</div>
        <select id="ca-eqBldg">${bldgs.map(b => `<option ${b===this.EQ_FILTER.bldg?'selected':''}>${b}</option>`).join('')}</select></div>
      <div><div class="ca-side-label">Floor</div>
        <select id="ca-eqFloor">${floors.map(f => `<option ${f===this.EQ_FILTER.floor?'selected':''}>${f}</option>`).join('')}</select></div>
    </div>`;
    html += `<div id="ca-eq-body"></div>`;
    root.innerHTML = html;

    this.q('ca-eqBldg').onchange = (e) => { this.EQ_FILTER.bldg = e.target.value; this.renderEqBody(eq, total); };
    this.q('ca-eqFloor').onchange = (e) => { this.EQ_FILTER.floor = e.target.value; this.renderEqBody(eq, total); };
    this.renderEqBody(eq, total);
  }

  renderEqBody(eq, total) {
    let f = eq;
    if (this.EQ_FILTER.bldg !== 'All') f = f.filter(e => e.building_phase === this.EQ_FILTER.bldg);
    if (this.EQ_FILTER.floor !== 'All') f = f.filter(e => e.floor_parsed === this.EQ_FILTER.floor);
    const body = this.q('ca-eq-body');
    if (!f.length) { body.innerHTML = `<div class="ca-empty">No equipment matches these filters.</div>`; return; }

    let html = `<div class="ca-caption">Showing ${f.length} of ${total} equipment</div>`;
    html += this.section('Equipment by Type') + this.chartBox('ca-eq-type', 360);
    html += this.section('Checklist Completion by Equipment') +
      `<div class="ca-caption">Sorted by lowest completion — the holdbacks rise to the top.</div>
       <div class="ca-eq-search-wrap">
         <input type="text" id="ca-eqSearch" placeholder="Search equipment name or type…" value="${this.EQ_SEARCH.q}" />
         <label><input type="checkbox" id="ca-eqIncomplete" ${this.EQ_SEARCH.incompleteOnly ? 'checked' : ''}/> Incomplete only</label>
       </div>
       <div id="ca-eq-cl-table"></div>`;
    
    const rows = f.map(e => ({ Name: e.name, Type: e.type, Discipline: e.discipline, Status: e.status, Space: e.space, Building: e.building_phase, Floor: e.floor_parsed, Checklists: e.cl_total, 'CL Done': e.cl_done, Tests: e.ts_total, 'Tests Passed': e.ts_passed, Issues: e.iss_total, 'Issues Open': e.iss_open }));
    html += `<details><summary>View All Equipment (${f.length})</summary>` + this.table(['Name','Type','Discipline','Status','Space','Building','Floor','Checklists','CL Done','Tests','Tests Passed','Issues','Issues Open'].map(k => ({ k, label: k })), rows) + `</details>`;
    body.innerHTML = html;

    const byType = (rows, agg) => {
      const types = this.uniq(rows.map(e => e.type));
      return types.map(t => { const r = rows.filter(e => e.type === t); return agg(t, r); });
    };

    let tsum = byType(f, (t, r) => ({ type: t, count: r.length })).sort((a, b) => a.count - b.count);
    this.plot('ca-eq-type', [{ type: 'bar', orientation: 'h', y: tsum.map(d => d.type), x: tsum.map(d => d.count), marker: { color: this.C.blue }, text: tsum.map(d => d.count), textposition: 'outside', textfont: { color: this.C.muted, family: this.FONT } }],
      { yaxis: { tickfont: { color: this.C.text, size: 11 } }, margin: { t: 10, b: 20, l: 10, r: 40 }, height: Math.max(300, tsum.length * 26) });

    this.renderEqTable(f);
    const sInput = this.q('ca-eqSearch'), sChk = this.q('ca-eqIncomplete');
    if (sInput) sInput.addEventListener('input', () => {
      this.EQ_SEARCH.q = sInput.value;
      // PERF FIX: debounce — without this every keystroke re-renders the table.
      clearTimeout(this._eqSearchDebounceTimer);
      this._eqSearchDebounceTimer = setTimeout(() => this.renderEqTable(f), 220);
    });
    if (sChk) sChk.addEventListener('change', () => { this.EQ_SEARCH.incompleteOnly = sChk.checked; this.renderEqTable(f); });
  }

  renderEqTable(eqRows) {
    const cont = this.q('ca-eq-cl-table');
    if (!cont) return;
    let r = eqRows.filter(e => e.cl_total > 0);
    if (this.EQ_SEARCH.incompleteOnly) r = r.filter(e => e.cl_done < e.cl_total);
    const q = this.EQ_SEARCH.q.trim().toLowerCase();
    if (q) r = r.filter(e => String(e.name || '').toLowerCase().includes(q) || String(e.type || '').toLowerCase().includes(q));
    r = r.map(e => ({ e, pct: Math.round(e.cl_done / e.cl_total * 100) })).sort((a, b) => a.pct - b.pct || (b.e.iss_open || 0) - (a.e.iss_open || 0));
    
    const rows = r.map(({ e, pct }) => ({
      Equipment: e.name, Type: e.type, Phase: e.building_phase, Floor: e.floor_parsed,
      'CL %': pct + '%', 'CL Done': `${e.cl_done}/${e.cl_total}`, 'Open Issues': e.iss_open || 0, Tests: `${e.ts_passed}/${e.ts_total}`, Status: e.status,
    }));
    cont.innerHTML = `<div class="ca-caption">${rows.length} equipment${this.EQ_SEARCH.incompleteOnly ? ' with incomplete checklists' : ''}${q ? ` matching “${q}”` : ''}.</div>` +
      (rows.length ? this.table(['Equipment','Type','Phase','Floor','CL %','CL Done','Open Issues','Tests','Status'].map(k => ({ k, label: k })), rows) : '<div class="ca-ok">✅ No matching equipment.</div>');
  }
}