# 0004: Keep deleted Schedule lines in the Schedule table, off their slot

Date: 2026-11-10   Status: Accepted

## Context

LaunchPad is append-only, but deleting a Schedule line removed its row from the project's
`{prefix}BackEndData` table. A trigger (`sync/deletion_audit.sql`) copied each deleted row
into `launchpad_deleted_activities`, so nothing was lost outright, but the line was gone from
the Schedule's own table and couldn't be seen or restored from the app.

A Schedule row's id is its slot: `date * 100 + row number` (2026-04-20 row 5 is
`2026042005`). Scheduler draws each day as numbered rows, and Bridge picks a new line's id
by finding a free number on that day. Many code paths delete rows: Schedule's Delete and
bulk Delete, its Move (copy to the new row, delete the old), Bridge's Accept, Reconcile, and
the day-change move functions.

## Decision

- `sync/schedule_line_status.sql` adds `line_status` (`live`, `deleted`, `moved`,
  `restored`) and `original_id`, `deleted_at`, `deleted_by`, `restored_at`, `restored_by`,
  `restored_to_id` to every BackEndData table.
- A `BEFORE DELETE` trigger copies the row to a new negative id with
  `line_status = 'deleted'`, then lets the delete go ahead. The slot is free for a new line;
  the line is kept. Moves set `launchpad.line_removal = 'moved'` first, so their old copy is
  kept as `moved` and isn't offered for restore.
- A restrictive read policy shows only `live` rows to the app's roles. Every existing read
  (Schedule, Bridge, Power Flow, the calendar feed) keeps working unchanged. The two
  service-key sync jobs filter on `line_status` themselves.
- Kept rows can't be changed through the app's roles or deleted by anyone (the trigger
  refuses).
- Schedule → Deleted lines lists `deleted` rows and restores one to its old row if free,
  otherwise the first free row on that day. The kept copy becomes `restored` and stays.

## Alternatives rejected

- **A flag on the row, left on its id.** It blocks the slot, and the next line typed into it
  would overwrite the deleted one.
- **A flag on the row, with a filter added to every read.** Over a dozen reads across five
  files and two sync jobs; any one missed shows deleted lines again.
- **Only the existing deletion log, with a restore screen.** The user asked for the status
  to live in the Schedule table itself.

## Consequences

- Run `sync/schedule_line_status.sql` before merging the app change. It stops without
  changing anything if a BackEndData table doesn't use row level security.
- A restored line gets a new id when its old row was taken. Bridge links and predecessors
  that pointed at the old id aren't moved over.
- `launchpad_deleted_activities` still records every delete, including moves.
- Deletes in Bridge's old-style `schedule_items` tables are unchanged (still logged only).

Jira: ARC-298
