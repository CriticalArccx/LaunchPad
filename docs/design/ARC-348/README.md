# ARC-348: Bridge Milestone Tracking

Design: the "Bridge — Milestones" Claude Design canvas (ARC-350). Built in
`bridge-milestones.js`, shown as a **Milestones** view next to **Schedule**
inside The Bridge. The view is off on every project until an admin turns on
**Milestones** in Settings → The Bridge. Data: `sync/milestones.sql`.

## Matches the design
- Schedule | Milestones switch at the top of Bridge.
- Controls: end milestone (axis = 0), 1–4 weeks per column, "Required for X" or
  "All lines", data date, and an activity legend that shows or hides lanes.
- Left column: milestone list with readiness bars and the add form ("Add and set as
  end").
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
- **The timeline runs from the current week to X-0**, however many weeks that
  is (ARC-451). Older weeks fold into one "X-n and earlier" column, so one old
  line can't stretch the axis. Once today is past X, the last few weeks before
  it show instead.
- **A picked line opens Bridge's detail panel on the right** (ARC-451), the same
  one the Schedule view uses, with the milestones it's needed for and the
  asset + activity's history (runs, fails and repeats, moves, removals). The
  design's left-column "selected line" box is gone; waits-on and unlocks are
  the panel's Constraints and Successors.
- **The readiness numbers are coloured by status and filter the view**
  (ARC-451): clicking Ready, Planned, At risk or Late (or its part of the bar)
  shows only those lines in the timeline and table; more than one can be
  picked. A short line under them says what each status means.
- **Milestones also show in the Schedule view** (ARC-451) as a diamond row on
  their date, with dashed links from the last lines they need (at most 25,
  latest-finishing first) and from a milestone they're based on. Clicking one
  opens it in Milestones. The links can't be edited.
- **Schedule's Reschedule dialog** (ARC-451) lists, in a red box under the
  activities it pushes, any milestone whose needed lines would now finish
  after its date.
- **Edit and Remove** were added to each milestone, for editors and admins.
  Both add a new version of the row.
