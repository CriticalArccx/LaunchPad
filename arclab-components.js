/* ArcLab Design System components: copied unchanged from the shared "Design System"
 * artifact (project/components/bundle.js, version 1795034104-ab1c). Update by
 * re-copying, never by hand-editing. createStatusBadge() needs no React; the
 * React components are not used by LaunchPad yet. */
/* @ds-bundle: {"format":4,"namespace":"ArcLab","components":[{"name":"StatusBadge"},{"name":"DataTable"},{"name":"GroupedTable"},{"name":"EditableGrid"},{"name":"Card"},{"name":"StatCard"}]} */
(function () {
  var NS = "http://www.w3.org/2000/svg";

  // One entry per workflow status. `icon` is a list of SVG primitives on a 16x16 grid.
  var STATUSES = {
    draft:      { label: "Draft",       icon: [["circle", { cx: 8, cy: 8, r: 5.5, fill: "none", stroke: "currentColor", "stroke-width": 1.75, "stroke-dasharray": "2.2 2" }]] },
    notStarted: { label: "Not started", icon: [["circle", { cx: 8, cy: 8, r: 5.5, fill: "none", stroke: "currentColor", "stroke-width": 1.75 }]] },
    inProgress: { label: "In progress", icon: [["circle", { cx: 8, cy: 8, r: 5.5, fill: "none", stroke: "currentColor", "stroke-width": 1.75 }], ["path", { d: "M8 2.5a5.5 5.5 0 0 0 0 11z", fill: "currentColor" }]] },
    partial:    { label: "Partial",     icon: [["circle", { cx: 8, cy: 8, r: 5.5, fill: "none", stroke: "currentColor", "stroke-width": 1.75 }], ["path", { d: "M8 2.5a5.5 5.5 0 0 1 0 11z", fill: "currentColor" }]] },
    success:    { label: "Success",     icon: [["path", { d: "M3 8.5l3.2 3.2L13 4.8", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }]] },
    failure:    { label: "Failure",     icon: [["path", { d: "M4 4l8 8M12 4l-8 8", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" }]] },
    closed:     { label: "Closed",      icon: [["rect", { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.25, fill: "currentColor" }], ["path", { d: "M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7", fill: "none", stroke: "currentColor", "stroke-width": 1.75 }]] },
    removed:    { label: "Removed",     icon: [["path", { d: "M3.5 8h9", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" }]] }
  };
  var SIZES = { compact: 1, default: 1, touch: 1 };

  function resolve(status, size) {
    var s = STATUSES[status] ? status : "notStarted";
    var z = SIZES[size] ? size : "default";
    return { status: s, size: z, def: STATUSES[s] };
  }
  function classes(r, extra) {
    return ["al-status", "al-status--" + r.status, "al-status--" + r.size, extra].filter(Boolean).join(" ");
  }

  // React component (needs window.React at render time).
  function StatusBadge(props) {
    var React = window.React, h = React.createElement;
    var r = resolve(props.status, props.size);
    var label = props.children != null ? props.children : (props.label != null ? props.label : r.def.label);
    var icon = h("svg", { className: "al-status__icon", viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
      r.def.icon.map(function (p, i) { return h(p[0], Object.assign({ key: i }, toReactAttrs(p[1]))); }));
    var rest = {};
    for (var k in props) if (!/^(status|size|label|children|className|iconOnly)$/.test(k)) rest[k] = props[k];
    if (props.iconOnly) { rest["aria-label"] = rest["aria-label"] || (typeof label === "string" ? label : r.def.label); rest.title = rest.title || rest["aria-label"]; }
    return h("span", Object.assign({ className: classes(r, (props.iconOnly ? "al-status--icon-only " : "") + (props.className || "")), "data-status": r.status }, rest),
      icon, props.iconOnly ? null : h("span", { className: "al-status__label" }, label));
  }
  function toReactAttrs(a) {
    var o = {};
    for (var k in a) o[k.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] = a[k];
    return o;
  }

  // Framework-free helper: returns an HTMLElement for plain-DOM tools.
  function createStatusBadge(status, opts) {
    opts = opts || {};
    var r = resolve(status, opts.size);
    var el = document.createElement("span");
    el.className = classes(r, opts.iconOnly ? "al-status--icon-only" : "");
    el.setAttribute("data-status", r.status);
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "al-status__icon"); svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true");
    r.def.icon.forEach(function (p) { var n = document.createElementNS(NS, p[0]); for (var k in p[1]) n.setAttribute(k, p[1][k]); svg.appendChild(n); });
    el.appendChild(svg);
    var text = opts.label != null ? String(opts.label) : r.def.label;
    if (opts.iconOnly) { el.setAttribute("aria-label", text); el.title = text; }
    else { var s = document.createElement("span"); s.className = "al-status__label"; s.textContent = text; el.appendChild(s); }
    return el;
  }

  var api = { StatusBadge: StatusBadge, createStatusBadge: createStatusBadge, STATUS_LABELS: {} };
  for (var k in STATUSES) api.STATUS_LABELS[k] = STATUSES[k].label;
  window.ArcLab = Object.assign(window.ArcLab || {}, api);
})();

/* ---------- Tables and cards ---------- */
(function () {
  function R() { return window.React; }
  function h() { return R().createElement.apply(null, arguments); }
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(" "); }
  function cmp(a, b) {
    if (a == null) return 1; if (b == null) return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  // Render one cell from a column definition.
  function cell(col, row) {
    var v = row[col.key];
    if (col.render) return col.render(v, row);
    if (col.type === "status") return h(window.ArcLab.StatusBadge, { status: v, size: "compact", label: col.statusLabels ? col.statusLabels[v] : undefined });
    if (col.format) return col.format(v, row);
    return v;
  }
  function tdClass(col) {
    return cx("al-td", (col.type === "id" || col.type === "number") && "al-mono", (col.type === "number" || col.align === "right") && "al-right", col.align === "center" && "al-center");
  }
  function thClass(col) {
    return cx("al-th", (col.type === "number" || col.align === "right") && "al-right", col.align === "center" && "al-center");
  }
  function caret(open) {
    return h("svg", { className: "al-caret" + (open ? " al-caret--open" : ""), viewBox: "0 0 16 16", "aria-hidden": "true" }, h("path", { d: "M6 4l4 4-4 4", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }));
  }

  /* A. DataTable — select, sort, bulk actions */
  function DataTable(p) {
    var React = R();
    var cols = p.columns || [], rows = p.rows || [];
    var idOf = p.getRowId || function (r) { return r.id; };
    var su = React.useState(p.defaultSelected || []), selU = su[0], setSelU = su[1];
    var sel = p.selected || selU;
    function setSel(n) { if (!p.selected) setSelU(n); if (p.onSelectionChange) p.onSelectionChange(n); }
    var so = React.useState(p.defaultSort || null), sort = so[0], setSort = so[1];
    var list = rows.slice();
    if (sort) list.sort(function (a, b) { return cmp(a[sort.key], b[sort.key]) * (sort.dir === "desc" ? -1 : 1); });
    function toggle(id) { setSel(sel.indexOf(id) >= 0 ? sel.filter(function (x) { return x !== id; }) : sel.concat([id])); }
    function sortBy(col) {
      if (col.sortable === false) return;
      setSort(sort && sort.key === col.key ? { key: col.key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: col.key, dir: "asc" });
    }
    var bar = p.selectable && sel.length > 0 ? h("div", { className: "al-bulkbar", role: "toolbar", "aria-label": "Bulk actions" },
      h("span", { className: "al-bulkbar__count" }, sel.length + " selected"),
      h("span", { className: "al-bulkbar__actions" }, (p.bulkActions || []).map(function (a, i) {
        return h(React.Fragment, { key: i }, i > 0 ? h("span", { "aria-hidden": "true" }, " · ") : null,
          h("button", { type: "button", className: "al-bulkbar__btn", onClick: function () { a.onClick(sel.slice()); } }, a.label));
      })),
      h("button", { type: "button", className: "al-bulkbar__btn al-bulkbar__clear", onClick: function () { setSel([]); } }, "Clear")) : null;
    return h("div", { className: cx("al-table-wrap", p.className) },
      bar,
      h("div", { className: "al-table-scroll" }, h("table", { className: "al-table" },
        p.caption ? h("caption", { className: "al-sr" }, p.caption) : null,
        h("thead", null, h("tr", null, cols.map(function (c) {
          var active = sort && sort.key === c.key;
          return h("th", { key: c.key, scope: "col", className: thClass(c), style: c.width ? { width: c.width } : null, "aria-sort": active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined },
            c.sortable === false ? c.label : h("button", { type: "button", className: "al-th__sort", onClick: function () { sortBy(c); } }, c.label,
              h("span", { className: "al-th__arrow", "aria-hidden": "true" }, active ? (sort.dir === "asc" ? "▲" : "▼") : "")));
        }))),
        h("tbody", null, list.map(function (row) {
          var id = idOf(row), on = sel.indexOf(id) >= 0;
          return h("tr", {
            key: id, className: cx("al-tr", p.selectable && "al-tr--selectable", on && "al-tr--selected", row.removed && "al-row--removed"),
            onClick: p.selectable ? function (e) { if (e.target.tagName !== "INPUT") toggle(id); } : undefined
          }, cols.map(function (c, ci) {
            return h("td", { key: c.key, className: tdClass(c) },
              ci === 0 && p.selectable ? h("input", { type: "checkbox", className: "al-sr", checked: on, onChange: function () { toggle(id); }, "aria-label": "Select " + (row[c.key] != null ? row[c.key] : id) }) : null,
              cell(c, row));
          }));
        }))
      )));
  }

  /* B. GroupedTable — rows grouped by week, project or phase */
  function GroupedTable(p) {
    var React = R();
    var cols = p.columns || [], groups = p.groups || [];
    var idOf = p.getRowId || function (r) { return r.id; };
    var init = p.defaultExpanded || (groups[0] ? [groups[0].id] : []);
    var st = React.useState(init), open = st[0], setOpen = st[1];
    function flip(id) { setOpen(open.indexOf(id) >= 0 ? open.filter(function (x) { return x !== id; }) : open.concat([id])); }
    var body = [];
    groups.forEach(function (g) {
      var isOpen = open.indexOf(g.id) >= 0, n = g.count != null ? g.count : (g.rows || []).length;
      body.push(h("tr", { key: "g-" + g.id, className: "al-group" },
        h("th", { scope: "rowgroup", colSpan: cols.length, className: "al-group__cell" },
          h("button", { type: "button", className: "al-group__btn", "aria-expanded": isOpen, onClick: function () { flip(g.id); } },
            caret(isOpen), h("span", { className: "al-group__label" }, g.label),
            h("span", { className: "al-group__count" }, n + (n === 1 ? " item" : " items"))))));
      if (isOpen) (g.rows || []).forEach(function (row) {
        body.push(h("tr", { key: g.id + "-" + idOf(row), className: cx("al-tr", "al-tr--child", row.removed && "al-row--removed") },
          cols.map(function (c) { return h("td", { key: c.key, className: tdClass(c) }, cell(c, row)); })));
      });
    });
    return h("div", { className: cx("al-table-wrap", "al-table-wrap--grouped", p.className) },
      h("div", { className: "al-table-scroll" }, h("table", { className: "al-table" },
        p.caption ? h("caption", { className: "al-sr" }, p.caption) : null,
        h("thead", null, h("tr", null, cols.map(function (c) { return h("th", { key: c.key, scope: "col", className: thClass(c), style: c.width ? { width: c.width } : null }, c.label); }))),
        h("tbody", null, body))));
  }

  /* C. EditableGrid — inline edits, frozen first column */
  function pct(v) { return v == null || v === "" ? "–" : Math.round(v * 100) + "%"; }
  function parsePct(s) { var n = parseFloat(String(s).replace(/[%\s,]/g, "")); return isNaN(n) ? null : n / 100; }
  function defaultTone(v) { return v == null ? "neutral" : v > 1.15 ? "strong" : v >= 0.9 ? "accent" : "neutral"; }
  function EditableGrid(p) {
    var React = R();
    var fmt = p.format || pct, parse = p.parse || parsePct, tone = p.toneFor || defaultTone;
    var vs = React.useState(function () { var m = {}; (p.rows || []).forEach(function (r) { m[r.id] = Object.assign({}, r.values); }); return m; });
    var vals = vs[0], setVals = vs[1];
    var es = React.useState(null), edit = es[0], setEdit = es[1];
    var ds = React.useState(""), draft = ds[0], setDraft = ds[1];
    function start(rid, ck) { if (p.readOnly) return; setEdit({ r: rid, c: ck }); setDraft(vals[rid][ck] == null ? "" : String(Math.round(vals[rid][ck] * 100))); }
    function commit() {
      if (!edit) return;
      var v = parse(draft), next = Object.assign({}, vals); next[edit.r] = Object.assign({}, next[edit.r]); next[edit.r][edit.c] = v;
      setVals(next); setEdit(null); if (p.onChange) p.onChange(edit.r, edit.c, v);
    }
    var cols = p.columns || [];
    return h("div", { className: cx("al-table-wrap", "al-grid-wrap", p.className) },
      h("div", { className: "al-table-scroll" }, h("table", { className: "al-table al-grid" },
        p.caption ? h("caption", { className: "al-sr" }, p.caption) : null,
        h("thead", null, h("tr", null,
          h("th", { scope: "col", className: "al-th al-grid__frozen" }, p.rowHeaderLabel || ""),
          cols.map(function (c) { return h("th", { key: c.key, scope: "col", className: "al-th al-center" }, c.label); }))),
        h("tbody", null, (p.rows || []).map(function (r) {
          return h("tr", { key: r.id, className: "al-tr" },
            h("th", { scope: "row", className: "al-grid__frozen al-grid__rowhead" }, r.label),
            cols.map(function (c) {
              var v = vals[r.id][c.key], isEdit = edit && edit.r === r.id && edit.c === c.key;
              return h("td", { key: c.key, className: "al-td al-center" }, isEdit
                ? h("input", { className: "al-cell al-cell--editing", autoFocus: true, inputMode: "decimal", value: draft, "aria-label": r.label + ", " + c.label,
                    onChange: function (e) { setDraft(e.target.value); }, onBlur: commit,
                    onKeyDown: function (e) { if (e.key === "Enter") commit(); else if (e.key === "Escape") setEdit(null); } })
                : h("button", { type: "button", className: "al-cell al-cell--" + tone(v, r, c), "aria-label": r.label + ", " + c.label + ": " + fmt(v), disabled: p.readOnly, onClick: function () { start(r.id, c.key); } }, fmt(v)));
            }));
        })))));
  }

  /* Elevated card */
  function Card(p) {
    var rest = {}; for (var k in p) if (!/^(elevated|className|children|as)$/.test(k)) rest[k] = p[k];
    return h(p.as || "div", Object.assign({ className: cx("al-card", p.elevated !== false && "al-card--elevated", p.className) }, rest), p.children);
  }
  function StatCard(p) {
    return h(Card, { className: cx("al-stat", p.className), elevated: p.elevated },
      h("div", { className: "al-stat__label" }, p.label),
      h("div", { className: "al-stat__value" }, p.value, p.unit ? h("span", { className: "al-stat__unit" }, " " + p.unit) : null),
      p.source ? h("div", { className: "al-stat__source" }, p.source) : null);
  }

  window.ArcLab = Object.assign(window.ArcLab || {}, {
    DataTable: DataTable, GroupedTable: GroupedTable, EditableGrid: EditableGrid,
    Card: Card, StatCard: StatCard, formatPercent: pct
  });
})();
