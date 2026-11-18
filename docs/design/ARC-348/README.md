# ARC-348: Bridge Milestone Tracking

Design: the "Bridge — Milestones" Claude Design canvas (ARC-350). Built in
`bridge-milestones.js`, shown as a **Milestones** view next to **Schedule**
inside The Bridge. The view is off on every project until an admin turns on
**Milestones** in Settings → The Bridge. Data: `sync/milestones.sql`.

## Matches the design
- Schedule | Milestones switch at the top of Bridge.
- Controls: end milestone (axis = 0), 1–4 weeks per column, "Required for X" or
  "All lines", data date, and an activity legend that shows or hides lanes.
- Left column: milestone list with readiness bars, the add form ("Add and set as
  end"), and the selected line with what it waits on and what it unlocks.
- Readiness card, a timeline counting back from X-0 with TODAY and other
  milestones marked, and a "Required for X" table.
- Picking a line dims everything outside its chain.

## Deviations
- **A milestone has one name**, e.g. "FR1", used on the axis. The design has a
  separate short code and long name.
- **Its date is picked, or based on another milestone** (N weeks before or
  after it), and then moves with that milestone. Not in the design.
- **The lines it needs** are everything due on or before it (as in the design's
  "auto scope"), or chosen in the add/edit dialog: whole areas ("All lines in
  Hall A", which also takes in lines added to that area later) and/or single
  lines. Chosen lines are stored as asset + activity. Predecessors are always
  included. A line's area is its Area, else its Place (lines added in Schedule
  fill Place), else its asset's Place in the dropdown options. Milestones saved
  while the picker grouped by zone keep their zone choice.
- **Adding and editing happen in a dialog** opened by "+ Add milestone", not
  the inline form in the design's left column, to make room for the line
  picker.
- **Lanes are Bridge activities**, in Bridge's own activity colours, rather than
  fixed workstreams.
- **Statuses:** Done (Schedule result is Pass or Complete), Late, At risk (a
  predecessor is late or at risk) and Planned. There is no TBD, because every
  Bridge line has a date. There are no per-line risk notes.
- **Filters and search** use Bridge's own toolbar. The Report menu is hidden in
  Milestones because it reports the Gantt.
- **Older weeks fold into one "X-n and earlier" column**, so one old line can't
  stretch the axis. The timeline starts a week before today.
- **Edit and Remove** were added to each milestone, for editors and admins.
  Both add a new version of the row.
