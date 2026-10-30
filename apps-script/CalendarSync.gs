// =============================================================================
// LaunchPad Schedule -> shared Google Calendar (ARC-178, docs/adr/0001)
//
// Add this as its own file in the project's Apps Script (next to the main
// Code.gs). One-way: the Schedule (Supabase "{prefix}BackEndData") is the
// source of truth; this only creates, updates and removes events it tagged
// itself on one calendar. It never writes to Supabase.
//
// Mapping per Schedule line:
//   title       = "Project - Asset - Activity" (project = LP_PROJECT_NAME, else the prefix)
//   start       = day_label + time (24h "HHMM"/"HMM"); no time -> all-day
//   length      = duration ("2.5 hrs"); blank -> 1 hr
//   guests      = people (" | "-joined emails), added WITHOUT invite emails
//   description = notes
//
// Setup (once, from the Apps Script editor):
//   1. Project Settings -> Script Properties, add:
//        LP_SUPABASE_URL       https://rcnxetcomdrlxvlarqoc.supabase.co
//        LP_SUPABASE_ANON_KEY  the public anon key (same one index.html uses)
//        LP_TABLE_PREFIX       CASB
//        LP_PROJECT_NAME       optional; first part of each title (defaults to the prefix)
//   2. Run setupScheduleCalendar() and approve the Calendar permission.
//      It creates the calendar, saves its id (LP_CALENDAR_ID) and adds a
//      10-minute trigger for syncScheduleToCalendar().
//   3. Share the new calendar with the team in Google Calendar.
// =============================================================================

const LP_CAL_SYNC = {
  daysBack: 30,          // lines older than this are left alone
  daysAhead: 180,        // lines further out than this are left alone
  maxChangesPerRun: 100, // stay under Calendar's rate limit; the rest go next run
  maxRunMs: 270000,      // stop after 4.5 min; Apps Script kills a run at 6 min
  pauseMs: 400,          // gap between Calendar writes (bursts get throttled)
  defaultHours: 1,
  rowTag: 'lpRowId',
  hashTag: 'lpHash'
};

function setupScheduleCalendar() {
  const props = PropertiesService.getScriptProperties();
  const prefix = lpCalProp_('LP_TABLE_PREFIX');
  let calId = props.getProperty('LP_CALENDAR_ID');
  if (!calId || !CalendarApp.getCalendarById(calId)) {
    const cal = CalendarApp.createCalendar(`LaunchPad Schedule (${prefix})`, {
      summary: `Synced every 10 minutes from the LaunchPad ${prefix} Schedule. Edit the Schedule, not these events.`,
      timeZone: Session.getScriptTimeZone()
    });
    calId = cal.getId();
    props.setProperty('LP_CALENDAR_ID', calId);
  }

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncScheduleToCalendar')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncScheduleToCalendar').timeBased().everyMinutes(10).create();

  Logger.log('Calendar ready: ' + calId);
  syncScheduleToCalendar();
}

function syncScheduleToCalendar() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return; // a previous run is still going
  try {
    const cal = CalendarApp.getCalendarById(lpCalProp_('LP_CALENDAR_ID'));
    if (!cal) throw new Error('LP_CALENDAR_ID calendar not found. Run setupScheduleCalendar().');

    const tz = Session.getScriptTimeZone();
    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - LP_CAL_SYNC.daysBack);
    const to = new Date(today.getFullYear(), today.getMonth(), today.getDate() + LP_CAL_SYNC.daysAhead + 1);
    const fromLabel = Utilities.formatDate(from, tz, 'yyyy-MM-dd');
    const toLabel = Utilities.formatDate(to, tz, 'yyyy-MM-dd');

    const project = PropertiesService.getScriptProperties().getProperty('LP_PROJECT_NAME') ||
      lpCalProp_('LP_TABLE_PREFIX');
    const wanted = {};
    lpCalFetchRows_(fromLabel, toLabel).forEach(row => {
      const ev = lpCalEventFor_(row, project);
      if (ev) wanted[String(row.id)] = ev;
    });

    // Each line is synced on its own (ARC-187): a Batch Add can land dozens of
    // lines at once, and one throttled or failed Calendar call used to abort
    // the whole run, so nothing after it was scheduled. Now a failed line is
    // logged and skipped, and throttling or the run-time limit ends the run
    // cleanly; whatever is left goes in the next run.
    const started = Date.now();
    let changes = 0, stopReason = '';
    const failures = [];
    const canContinue = () => {
      if (stopReason) return false;
      if (changes >= LP_CAL_SYNC.maxChangesPerRun) stopReason = 'change limit reached';
      else if (Date.now() - started > LP_CAL_SYNC.maxRunMs) stopReason = 'time limit reached';
      return !stopReason;
    };
    const attempt = (id, what, fn) => {
      try {
        fn();
        changes++;
        Utilities.sleep(LP_CAL_SYNC.pauseMs);
      } catch (err) {
        const msg = String(err && err.message || err);
        if (/too many|rate limit|quota|try again later/i.test(msg)) {
          stopReason = 'Google Calendar is throttling (' + msg + ')';
        } else {
          failures.push(`line ${id} (${what}): ${msg}`);
        }
      }
    };

    // Our events only (tagged with a row id); anything else on the calendar is left alone.
    const existing = {};
    cal.getEvents(from, to).forEach(e => {
      const id = e.getTag(LP_CAL_SYNC.rowTag);
      if (!id) return;
      if (!existing[id]) existing[id] = e;
      else if (canContinue()) attempt(id, 'remove duplicate', () => e.deleteEvent());
    });

    Object.keys(existing).forEach(id => {
      if (!wanted[id] && canContinue()) attempt(id, 'remove', () => existing[id].deleteEvent());
    });

    Object.keys(wanted).forEach(id => {
      const ev = wanted[id];
      const current = existing[id];
      if (current && current.getTag(LP_CAL_SYNC.hashTag) === ev.hash) return;
      if (!canContinue()) return;
      if (current && current.isAllDayEvent() === ev.allDay) {
        attempt(id, 'update', () => lpCalUpdate_(current, ev));
      } else {
        attempt(id, current ? 'replace' : 'create', () => {
          if (current) current.deleteEvent();
          lpCalCreate_(cal, id, ev);
        });
      }
    });

    Logger.log(`Calendar sync: ${Object.keys(wanted).length} lines, ${changes} change(s)` +
      (stopReason ? ` (stopped early: ${stopReason}; the rest go next run).` : '.'));
    if (failures.length) {
      // Thrown last so every other line still synced; the run shows as Failed
      // under Executions with the lines that need a look.
      throw new Error(`Calendar sync: ${failures.length} line(s) failed:\n` + failures.join('\n'));
    }
  } finally {
    lock.releaseLock();
  }
}

// --- Supabase (read-only) ----------------------------------------------------

function lpCalFetchRows_(fromLabel, toLabel) {
  const base = lpCalProp_('LP_SUPABASE_URL');
  const key = lpCalProp_('LP_SUPABASE_ANON_KEY');
  const table = lpCalProp_('LP_TABLE_PREFIX') + 'BackEndData';
  const query = `select=id,day_label,time,activity,asset,duration,people,notes` +
    `&day_label=gte.${fromLabel}&day_label=lt.${toLabel}&order=id`;
  const rows = [];
  const pageSize = 1000;
  for (let start = 0; ; start += pageSize) {
    const res = UrlFetchApp.fetch(`${base}/rest/v1/${encodeURIComponent(table)}?${query}`, {
      headers: { apikey: key, Authorization: 'Bearer ' + key, Range: `${start}-${start + pageSize - 1}` },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) throw new Error('Supabase read failed: ' + res.getContentText());
    const page = JSON.parse(res.getContentText());
    rows.push.apply(rows, page);
    if (page.length < pageSize) return rows;
  }
}

// --- Mapping -------------------------------------------------------------------

function lpCalEventFor_(row, project) {
  const asset = (row.asset || '').trim();
  const activity = (row.activity || '').trim();
  if (!asset && !activity) return null; // blank slot

  const [y, m, d] = String(row.day_label).split('-').map(Number);
  const startTime = lpCalParseTime_(row.time);
  const durationText = (row.duration || '').toString().trim();
  const hours = lpCalParseHours_(durationText);
  const notes = (row.notes || '').trim();
  const guests = lpCalSplit_(row.people).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

  const ev = {
    title: [project, asset, activity].filter(Boolean).join(' - '),
    allDay: !startTime,
    guests: guests
  };
  if (ev.allDay) {
    ev.start = new Date(y, m - 1, d);
    ev.description = [notes, durationText ? 'Duration: ' + durationText : ''].filter(Boolean).join('\n\n');
  } else {
    ev.start = new Date(y, m - 1, d, startTime.h, startTime.min);
    ev.end = new Date(ev.start.getTime() + hours * 3600 * 1000);
    ev.description = notes;
  }
  ev.description = [ev.description, 'From the LaunchPad Schedule. Edit it there; changes here are overwritten.']
    .filter(Boolean).join('\n\n');
  ev.hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(ev)));
  return ev;
}

// "0530", "930", "1030" (24h); also tolerates "7:30 AM".
function lpCalParseTime_(value) {
  const s = (value || '').toString().trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2}):?(\d{2})\s*([ap]m)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) {
    const pm = m[3].toLowerCase() === 'pm';
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return h < 24 && min < 60 ? { h, min } : null;
}

// "2.5 hrs", "1 hr", "90 min", "2"; blank or unreadable -> default.
function lpCalParseHours_(text) {
  const m = (text || '').match(/(\d+(?:\.\d+)?)\s*(m|min|mins|minutes)?\b/i);
  if (!m) return LP_CAL_SYNC.defaultHours;
  const n = Number(m[1]);
  const hours = m[2] ? n / 60 : n;
  return hours > 0 ? hours : LP_CAL_SYNC.defaultHours;
}

function lpCalSplit_(value) {
  const v = (value || '').toString().trim();
  if (!v) return [];
  return v.split(v.indexOf('|') >= 0 ? '|' : ',').map(x => x.trim()).filter(Boolean);
}

// --- Calendar writes (never send invitation emails) ---------------------------

function lpCalCreate_(cal, id, ev) {
  const opts = { description: ev.description, guests: ev.guests.join(','), sendInvites: false };
  const e = ev.allDay
    ? cal.createAllDayEvent(ev.title, ev.start, opts)
    : cal.createEvent(ev.title, ev.start, ev.end, opts);
  try {
    e.setTag(LP_CAL_SYNC.rowTag, id);
    e.setTag(LP_CAL_SYNC.hashTag, ev.hash);
  } catch (err) {
    // An untagged event is invisible to the sync and would be created again
    // next run as a duplicate, so take it back out.
    try { e.deleteEvent(); } catch (ignored) {}
    throw err;
  }
}

function lpCalUpdate_(e, ev) {
  e.setTitle(ev.title);
  e.setDescription(ev.description);
  if (ev.allDay) e.setAllDayDate(ev.start);
  else e.setTime(ev.start, ev.end);

  const want = ev.guests.map(g => g.toLowerCase());
  const have = e.getGuestList().map(g => g.getEmail().toLowerCase());
  have.filter(g => want.indexOf(g) < 0).forEach(g => e.removeGuest(g));
  want.filter(g => have.indexOf(g) < 0).forEach(g => e.addGuest(g));

  e.setTag(LP_CAL_SYNC.hashTag, ev.hash);
}

function lpCalProp_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error(`Script Property ${name} is not set. See the setup notes at the top of CalendarSync.gs.`);
  return v;
}
