# 0005: Tell the CCM about seal requests in one daily email

Date: 2026-11-10   Status: Accepted

## Context

The field seal form (`seal-form-view.js`) called the project's Apps Script
(`?action=notifyCCM`) on every Break Request and Work Completed submit, and waited for the
answer before showing the success screen. People saw the form sit on "Submitting…" for
around ten seconds. In the Apps Script in this repo there is no `notifyCCM` handler: the call
falls through to the default branch of `doGet`, which reads seven whole sheets, and no email
is sent. There was also no setting for who the CCM is.

## Decision

- The form adds a row to `launchpad_seal_notifications` (`sync/seal_digest.sql`, one table
  for every project, insert-only) instead of calling the Apps Script.
- Tamper Seal Settings → Notifications sets the CCM recipients (any number) and the time of
  day and time zone for the digest. They're saved with the rest of the tamper seal settings
  in `launchpad_tamperseal_config.config.ccmDigest`.
- `apps-script/SealDigest.gs`, added to each project's Apps Script, runs every 15 minutes. On
  the first run at or after the chosen time each day it emails the recipients: new Break
  Requests and Ready for Reseal since the last digest, and every Break Request still
  `Pending`. Nothing is sent on a day with nothing to report. It reads with the anon key and
  keeps what it has sent in its own Script Properties, so it never writes to Supabase.

## Alternatives rejected

- **Keep the per-submit call, but don't wait for it.** Fixes the wait, but the CCM still gets
  nothing on projects without a `notifyCCM` handler, and asked for one email a day.
- **Send the digest from a GitHub Action.** It has no way to send email without adding a mail
  provider and its secret; every project's Apps Script can already send mail.
- **Build the digest from `{prefix}BreakRequests` alone.** Work Completed isn't logged
  anywhere, and that table's columns differ between projects.

## Consequences

- Each project's Apps Script needs `SealDigest.gs` added and `setupSealDigest()` run once;
  until then no digest is sent for that project.
- The CCM hears about a request the next morning, not straight away.
- Copying tamper seal settings to another project (ADR 0003) copies the recipients too.
- `launchpad_seal_notifications` is readable with the anon key, the same as
  `{prefix}BreakRequests`; tightening that belongs with ARC-248.

Jira: ARC-323
