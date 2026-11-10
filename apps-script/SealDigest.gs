// =============================================================================
// LaunchPad tamper seals -> daily CCM digest email (ARC-323)
//
// Add this as its own file in the project's Apps Script (next to the main
// Code.gs). Once a day, at the time set in LaunchPad (Tamper Seal Settings ->
// Notifications), it emails the CCM recipients set there:
//   - new Break Requests since the last digest
//   - seals marked Ready for Reseal since the last digest
//   - every Break Request still waiting for a CCM decision
// Nothing is sent on a day with nothing in any of the three.
//
// Reads Supabase with the public anon key; never writes to it. What it has
// already sent is kept in this script's own Script Properties.
//
// Setup (once, from the Apps Script editor):
//   1. Run sync/seal_digest.sql in Supabase (once for all projects).
//   2. Project Settings -> Script Properties, add:
//        LP_SUPABASE_URL       https://rcnxetcomdrlxvlarqoc.supabase.co
//        LP_SUPABASE_ANON_KEY  the public anon key (same one index.html uses)
//        LP_PROJECT_KEY        CASB
//        LP_TABLE_PREFIX       optional; defaults to LP_PROJECT_KEY
//        LP_PROJECT_NAME       optional; used in the subject line
//        LP_APP_URL            optional; adds an "Open LaunchPad" link
//   3. Run previewSealDigest() and approve the permissions. It only logs the
//      email it would send (View -> Logs); nothing is emailed.
//   4. Run setupSealDigest(). It adds a 15-minute trigger for
//      sendSealDigestIfDue(). Re-running it is safe.
// =============================================================================

const LP_SEAL_DIGEST = {
  defaultTime: '07:00',
  defaultTimeZone: 'America/New_York',
  firstRunLookbackHours: 24, // the very first digest covers the last day
  lastDayProp: 'LP_SEAL_DIGEST_LAST_DAY',
  lastAtProp: 'LP_SEAL_DIGEST_LAST_AT'
};

function setupSealDigest() {
  lpSealProp_('LP_SUPABASE_URL');
  lpSealProp_('LP_SUPABASE_ANON_KEY');
  lpSealProp_('LP_PROJECT_KEY');
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sendSealDigestIfDue')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendSealDigestIfDue').timeBased().everyMinutes(15).create();
  const cfg = lpSealConfig_();
  Logger.log(`Seal digest scheduled daily at ${cfg.time} (${cfg.timeZone}) to: ${cfg.recipients.join(', ') || '(no recipients set yet)'}`);
}

// Runs every 15 minutes; sends at most once per day, on the first run at or
// after the chosen time. Anything added since the last digest is included,
// so a missed run or a changed time never drops anything.
function sendSealDigestIfDue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  try {
    const cfg = lpSealConfig_();
    if (!cfg.recipients.length) return;
    const now = new Date();
    const today = Utilities.formatDate(now, cfg.timeZone, 'yyyy-MM-dd');
    const clock = Utilities.formatDate(now, cfg.timeZone, 'HH:mm');
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(LP_SEAL_DIGEST.lastDayProp) === today || clock < cfg.time) return;

    const digest = lpSealBuildDigest_(cfg, now);
    if (digest) {
      MailApp.sendEmail({ to: cfg.recipients.join(','), subject: digest.subject, body: digest.text, htmlBody: digest.html });
    }
    props.setProperty(LP_SEAL_DIGEST.lastDayProp, today);
    props.setProperty(LP_SEAL_DIGEST.lastAtProp, now.toISOString());
  } finally {
    lock.releaseLock();
  }
}

// Logs what would be sent right now, without sending or marking anything.
function previewSealDigest() {
  const cfg = lpSealConfig_();
  const digest = lpSealBuildDigest_(cfg, new Date());
  Logger.log(`To: ${cfg.recipients.join(', ') || '(no recipients set)'} at ${cfg.time} ${cfg.timeZone}`);
  Logger.log(digest ? `${digest.subject}\n\n${digest.text}` : 'Nothing to report; no email would be sent.');
}

// --- Building the email ------------------------------------------------------

function lpSealBuildDigest_(cfg, now) {
  const props = PropertiesService.getScriptProperties();
  const since = props.getProperty(LP_SEAL_DIGEST.lastAtProp) ||
    new Date(now.getTime() - LP_SEAL_DIGEST.firstRunLookbackHours * 3600 * 1000).toISOString();
  const events = lpSealFetch_('launchpad_seal_notifications',
    `select=*&project_key=eq.${encodeURIComponent(cfg.projectKey)}` +
    `&created_at=gt.${encodeURIComponent(since)}&created_at=lte.${encodeURIComponent(now.toISOString())}&order=created_at`);
  let pending = [];
  try {
    pending = lpSealFetch_(lpSealPrefix_() + 'BreakRequests', 'select=*&ccm_decision=eq.Pending');
  } catch (e) {
    Logger.log('Pending requests not included: ' + e.message);
  }
  const requests = events.filter(e => e.event === 'break_request');
  const reseals = events.filter(e => e.event === 'ready_for_reseal');
  if (!requests.length && !reseals.length && !pending.length) return null;

  const project = PropertiesService.getScriptProperties().getProperty('LP_PROJECT_NAME') || cfg.projectKey;
  const when = iso => iso ? Utilities.formatDate(new Date(iso), cfg.timeZone, 'MMM d, h:mm a') : '';
  const sections = [
    {
      title: `New Break Requests (${requests.length})`,
      empty: 'None since the last summary.',
      rows: requests.map(r => [r.asset_name, `Seals ${r.seal_numbers || '-'}`, r.reason,
        [r.requestor_name, r.requestor_company].filter(Boolean).join(', '), r.requestor_email, when(r.created_at)])
    },
    {
      title: `Ready for Reseal (${reseals.length})`,
      empty: 'None since the last summary.',
      rows: reseals.map(r => [r.asset_name, `Seals ${r.seal_numbers || '-'}`, r.location, when(r.created_at)])
    },
    {
      title: `Waiting for your decision (${pending.length})`,
      empty: 'No requests waiting.',
      rows: pending.map(r => [r.asset_name, `Seals ${r.requested_seal_numbers || '-'}`, r.reason,
        [r.requestor_name, r.requestor_company].filter(Boolean).join(', ')])
    }
  ];

  const appUrl = PropertiesService.getScriptProperties().getProperty('LP_APP_URL');
  const subject = `${project} tamper seals: ${requests.length} new request(s), ${reseals.length} ready for reseal, ${pending.length} waiting`;
  const clean = row => row.filter(v => v && String(v).trim()).map(v => String(v).trim());
  const text = sections.map(s => `${s.title}\n` +
    (s.rows.length ? s.rows.map(r => '  - ' + clean(r).join(' | ')).join('\n') : '  ' + s.empty)).join('\n\n') +
    (appUrl ? `\n\nOpen LaunchPad: ${appUrl}` : '');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#141718;">` +
    sections.map(s => `<h3 style="margin:18px 0 6px;font-size:15px;">${lpSealEsc_(s.title)}</h3>` +
      (s.rows.length
        ? `<ul style="margin:0;padding-left:18px;">${s.rows.map(r => `<li style="margin:4px 0;">${clean(r).map(lpSealEsc_).join(' &middot; ')}</li>`).join('')}</ul>`
        : `<p style="margin:0;color:#6a675f;">${lpSealEsc_(s.empty)}</p>`)).join('') +
    (appUrl ? `<p style="margin-top:18px;"><a href="${lpSealEsc_(appUrl)}">Open LaunchPad</a></p>` : '') +
    `<p style="margin-top:18px;color:#6a675f;font-size:12px;">Daily summary from LaunchPad. Change the recipients or time in Tamper Seal Settings &rarr; Notifications.</p></div>`;
  return { subject, text, html };
}

// --- Supabase (read-only) ------------------------------------------------------

function lpSealConfig_() {
  const projectKey = lpSealProp_('LP_PROJECT_KEY');
  const rows = lpSealFetch_('launchpad_tamperseal_config', `select=config&project_key=eq.${encodeURIComponent(projectKey)}`);
  const d = (rows[0] && rows[0].config && rows[0].config.ccmDigest) || {};
  return {
    projectKey: projectKey,
    recipients: (Array.isArray(d.recipients) ? d.recipients : []).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)),
    time: /^\d{2}:\d{2}$/.test(d.time || '') ? d.time : LP_SEAL_DIGEST.defaultTime,
    timeZone: d.timeZone || LP_SEAL_DIGEST.defaultTimeZone
  };
}

function lpSealFetch_(table, query) {
  const base = lpSealProp_('LP_SUPABASE_URL');
  const key = lpSealProp_('LP_SUPABASE_ANON_KEY');
  const rows = [];
  const pageSize = 1000;
  for (let start = 0; ; start += pageSize) {
    const res = UrlFetchApp.fetch(`${base}/rest/v1/${encodeURIComponent(table)}?${query}`, {
      headers: { apikey: key, Authorization: 'Bearer ' + key, Range: `${start}-${start + pageSize - 1}` },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) throw new Error(`Supabase read of ${table} failed: ${res.getContentText()}`);
    const page = JSON.parse(res.getContentText());
    rows.push.apply(rows, page);
    if (page.length < pageSize) return rows;
  }
}

function lpSealPrefix_() {
  return PropertiesService.getScriptProperties().getProperty('LP_TABLE_PREFIX') || lpSealProp_('LP_PROJECT_KEY');
}

function lpSealProp_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error(`Script Property ${name} is not set. See the setup notes at the top of SealDigest.gs.`);
  return v;
}

function lpSealEsc_(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
