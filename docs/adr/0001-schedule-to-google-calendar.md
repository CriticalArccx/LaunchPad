# 0001: Sync the Schedule to Google Calendar from the project's Apps Script

Date: 2026-10-30   Status: Accepted

## Context

The Sandbox (CASB) project wants its Schedule on a shared Google Calendar: one
event per Schedule line, titled "Project - Asset - Activity", lasting its Duration,
with the line's People as guests and its Notes as the description. The
Schedule (Supabase `{prefix}BackEndData`) is the system of record and must
stay that way. Each project already has a Google Sheet with an Apps Script
that LaunchPad calls for lookups and emails.

## Decision

A new file, `apps-script/CalendarSync.gs`, is added to the CASB project's Apps
Script. Every 10 minutes it reads that project's BackEndData with the public
anon key (read-only) and makes one calendar, owned by the script's Google
account, match it: create, update, or remove events it tagged with the row
id. One-way only; calendar edits are overwritten. People are added as guests
with `sendInvites: false`. Lines with no Time become all-day events. Only
lines from 30 days back to 180 days ahead are synced.

## Alternatives rejected

- GitHub Actions job with a Google service account: needs new Google Cloud
  credentials and domain-wide delegation to add guests; more to secure.
- Calling the Apps Script from LaunchPad on every save: misses Bridge and
  bulk edits unless every write path calls it; the timed sync catches all.
- Two-way sync: would make the calendar a second owner of schedule data.

## Consequences

- Calendar changes appear up to ~10 minutes after a Schedule change.
- No Supabase schema change and no writes from the script.
- Calendar quotas apply; each run makes at most 100 changes and continues
  on the next run.
- Other projects can opt in by adding the same file and Script Properties.

Jira: ARC-178
