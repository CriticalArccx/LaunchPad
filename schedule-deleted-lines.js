// Deleted lines (ARC-298). Deleting a Schedule line keeps it in the
// project's BackEndData table with line_status = 'deleted' (see
// sync/schedule_line_status.sql). This dialog lists those lines and puts
// one back on its day: its old row if still free, otherwise the first free
// row. Reads and restores go through database functions that run with the
// signed-in user's own rights.
(function () {
    'use strict';

    const C = {
        text: 'var(--neutrals-lightmode-light-mode-Textprimary, #141718)',
        muted: 'var(--neutrals-lightmode-light-mode-Textsecondary, #6a675f)',
        border: 'var(--neutrals-lightmode-light-mode-Border, #d6d3cb)',
        strong: 'var(--neutrals-lightmode-light-mode-Borderstrong, #b2aea4)',
        page: 'var(--neutrals-lightmode-light-mode-Page, #f3f2ee)',
        action: 'var(--lp-action, #2f7a31)',
        error: '#b3261e'
    };
    const LIMIT = 500;
    const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function friendly(error) {
        const msg = (error && error.message) || String(error || 'Unknown error');
        if ((error && (error.code === 'PGRST202' || error.code === '42883')) || /Could not find the function/i.test(msg)) {
            return 'Deleted lines aren\'t set up yet. Run sync/schedule_line_status.sql in Supabase.';
        }
        return msg;
    }

    function fmtDay(day) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return day || 'No date';
        const d = new Date(day + 'T00:00:00');
        return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    }

    function fmtWhen(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        return isNaN(d) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    function modal(title) {
        const back = document.createElement('div');
        back.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:20000; display:flex; align-items:flex-start; justify-content:center; overflow-y:auto; padding:24px 16px; box-sizing:border-box;';
        back.innerHTML = `
            <div role="dialog" aria-modal="true" aria-label="${esc(title)}" style="background:white; color:${C.text}; border-radius:12px; width:100%; max-width:720px; box-shadow:0 10px 30px rgba(0,0,0,0.25); text-align:left;">
                <div style="display:flex; justify-content:space-between; align-items:center; padding:16px 20px; border-bottom:1px solid ${C.border};">
                    <h2 style="margin:0; font-size:18px;">${esc(title)}</h2>
                    <button data-close style="background:none; border:none; font-size:24px; line-height:1; cursor:pointer; color:${C.muted};" aria-label="Close">&times;</button>
                </div>
                <div data-body style="padding:16px 20px 20px;"></div>
            </div>`;
        document.body.appendChild(back);
        const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = e => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        back.querySelector('[data-close]').onclick = close;
        back.addEventListener('click', e => { if (e.target === back) close(); });
        return { el: back, body: back.querySelector('[data-body]'), close };
    }

    function lineHtml(r) {
        const title = [r.activity, r.asset].filter(Boolean).join(' — ') || '(blank line)';
        const details = [r.time, r.place, r.trade_partners, r.notes].filter(v => v && String(v).trim()).join(' · ');
        const who = r.deleted_by ? ` by ${esc(r.deleted_by)}` : '';
        return `
            <div role="listitem" data-line="${esc(r.id)}" style="display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; justify-content:space-between; padding:12px 0; border-top:1px solid ${C.border};">
                <div style="flex:1 1 320px; min-width:0;">
                    <div style="font-size:12px; font-weight:600; color:${C.muted};">${esc(fmtDay(r.day_label))}</div>
                    <div style="font-size:14px; font-weight:600; overflow-wrap:anywhere;">${esc(title)}</div>
                    ${details ? `<div style="font-size:13px; color:${C.muted}; overflow-wrap:anywhere;">${esc(details)}</div>` : ''}
                    <div style="font-size:12px; color:${C.muted}; margin-top:2px;">Deleted ${esc(fmtWhen(r.deleted_at))}${who}</div>
                    <div data-msg style="font-size:13px; margin-top:4px;"></div>
                </div>
                <button type="button" data-restore style="background:white; color:${C.action}; border:1px solid ${C.action}; border-radius:6px; padding:8px 14px; font-weight:600; cursor:pointer; white-space:nowrap;">Restore</button>
            </div>`;
    }

    async function open(sb, table, opts) {
        opts = opts || {};
        const m = modal('Deleted lines');
        m.body.innerHTML = `<p style="margin:0; color:${C.muted};">Loading…</p>`;

        let rows;
        try {
            const { data, error } = await sb.rpc('lp_schedule_deleted_lines', { p_table: table });
            if (error) throw error;
            rows = data || [];
        } catch (e) {
            m.body.innerHTML = `<p role="alert" style="margin:0; color:${C.error};">${esc(friendly(e))}</p>`;
            return m;
        }

        if (!rows.length) {
            m.body.innerHTML = `<p style="margin:0; color:${C.muted};">No deleted lines. When a line is deleted from the Schedule it's kept, and shows up here so it can be restored.</p>`;
            return m;
        }

        m.body.innerHTML = `
            <p style="margin:0 0 10px; font-size:13px; color:${C.muted};">Deleted lines are kept, newest first. Restore puts a line back on its day, in its old row if that's still free.${rows.length >= LIMIT ? ` Showing the newest ${LIMIT}.` : ''}</p>
            <input type="search" data-filter placeholder="Filter by date, activity, asset, place, notes…" aria-label="Filter deleted lines" style="width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid ${C.strong}; border-radius:6px; font-size:14px; margin-bottom:6px;">
            <div data-count style="font-size:12px; color:${C.muted}; margin-bottom:4px;"></div>
            <div role="list" data-list>${rows.map(lineHtml).join('')}</div>`;

        const byId = new Map(rows.map(r => [String(r.id), r]));
        const items = [...m.body.querySelectorAll('[data-line]')];
        const count = m.body.querySelector('[data-count]');
        const haystack = r => [r.day_label, fmtDay(r.day_label), r.time, r.place, r.activity, r.asset, r.trade_partners, r.notes, r.deleted_by].join(' ').toLowerCase();
        const applyFilter = () => {
            const q = m.body.querySelector('[data-filter]').value.trim().toLowerCase();
            let shown = 0;
            items.forEach(li => {
                const hit = !q || haystack(byId.get(li.dataset.line)).includes(q);
                li.style.display = hit ? 'flex' : 'none';
                if (hit) shown++;
            });
            count.textContent = q ? `${shown} of ${rows.length} line(s)` : `${rows.length} line(s)`;
        };
        m.body.querySelector('[data-filter]').oninput = applyFilter;
        applyFilter();

        items.forEach(li => {
            const btn = li.querySelector('[data-restore]');
            const msg = li.querySelector('[data-msg]');
            btn.onclick = async () => {
                btn.disabled = true;
                btn.textContent = 'Restoring…';
                msg.textContent = '';
                try {
                    const { data, error } = await sb.rpc('lp_schedule_restore_line', { p_table: table, p_id: Number(li.dataset.line) });
                    if (error) throw error;
                    const newId = Number(data);
                    btn.remove();
                    msg.style.color = C.action;
                    msg.textContent = `Restored to ${fmtDay(byId.get(li.dataset.line).day_label)}, row ${(newId % 100) + 1}.`;
                    if (typeof opts.onRestored === 'function') {
                        try { await opts.onRestored(newId); } catch (e) { console.error('Deleted lines: refresh after restore failed', e); }
                    }
                } catch (e) {
                    btn.disabled = false;
                    btn.textContent = 'Restore';
                    msg.style.color = C.error;
                    msg.textContent = friendly(e);
                }
            };
        });
        return m;
    }

    window.LPDeletedLines = { open };
})();
