# ArcLab Design System, phase 2: shell and Schedule (ARC-455)

Source: the shared ArcLab "Design System" artifact (version 1795034104-ab1c).
Its tokens are unchanged since phase 1 (ARC-189). Phase 2 applies the
components and rules, one module per PR. This PR covers the Schedule and the
shell around every module: header, sidebar, filter panel, loading screen, and
the Schedule's modals.

## Files
- `css/arclab-components.css` and `arclab-components.js` are the design
  system's component bundle, copied unchanged. LaunchPad uses
  `ArcLab.createStatusBadge()`, which needs no React.
- `css/launchpad-ds.css` is LaunchPad's design-system layer. It loads after
  index.html's `<style>` block and before the phone layout. The older rules
  use a lot of `!important`, so this layer does too.
- `index.html` adds an icon sprite at the top of `<body>`
  (`<svg class="lp-icon"><use href="#i-NAME">`).

## What changed
- **Status.** Only Status and Result show status, as a compact StatusBadge
  (icon and word). Every other cell is plain text, and no cell or row is
  tinted. Before this change, keyword rules tinted any cell, so "Level 2"
  turned yellow because of the " 2" keyword.
- **Status rules.** Settings → "Status badges" now picks one of the eight
  design-system states per rule, or "No badge". The colour pickers are gone.
  - Rules saved earlier have only colours. Their state is picked from the
    colour (green → Success, yellow → In progress, red → Failure, blue →
    Partial, grey → Not started) until an admin saves them.
  - The saved `bg`/`fg` values are kept on each rule unchanged.
  - "Default" (anything no rule matches) shows plain text.
- **Tables.**
  - The column header is a DataTable overline (11px, 600, Textsecondary)
    on Subtle.
  - Weeks are GroupedTable groups: Page fill, 16px 600, caret on the left.
  - Lines have 1px Border dividers.
  - A selected line gets the Arc-Green-tint fill and 3px marker, plus the
    charcoal "n selected" bar.
- **Buttons.**
  - Toolbar buttons are secondary buttons: Surface, Borderstrong, 14px 600.
    Before, they were blue, purple, red, orange and yellow outlines.
  - Done and Save are primary buttons in the LaunchPad action colour.
- **Icons.** Emoji in the shell and Schedule are replaced by one outline icon
  set. This covers nav, filters, refresh, PDF, critical path and dark mode.
  The ☐/☑ toggles are drawn as checkboxes.
- **Copy.** Sentence case in the shell, toolbar, Schedule settings and
  Reschedule.
- **Calendar mode.** Events are flat Surface cards: no coloured left border
  and no hover shadow. Selection uses the Arc Green marker. Today is Page,
  not the selection tint.
- **Shadows.** The only shadow is `shadow-elevated`, used on modals and
  popovers. The header, sidebars and column header have none.
- **Dark mode** uses `neutrals-darkmode-Page/Surface/Border`.
- **Phone.** Touch targets are 48px. Cards drop the `background-clip: text`
  workaround, which isn't needed now that cells have no inline fills.

## Deviations (flag to Arc Lab)
- **Status cells.** The badge is drawn by CSS on the cell itself (a 7px
  transparent border, then the fill). The cell's text and HTML are saved to
  the database as they are, so the badge element can't go inside them. The
  pill fills the column width instead of shrinking to its word. Draft's edge
  is solid, not dotted.
- **Dark mode.** Text colours have no dark tokens, so they reuse Page
  (#f3f2ee) and Borderstrong (#b2aea4). The selected-line fill in dark mode
  is #1d2e1f, which is not a token. Badges keep their light fills.
- **Action colour.** It stays green (`--lp-action`, ARC-191), not Petrol.
- **Danger and warning.** There is no danger or warning token. The
  milestone-slip box uses the Failure badge colours.

## Not in this PR
- **Project picker, sign-in and help screens.** They still have gradients,
  emoji and the old blue and purple accents.
- **Other modules.** Equipment Tracker, The Bridge, Tamper Seals and the
  Dashboard each get their own PR.
- **Saved Notes.** The 🔥 critical-path marker written into Notes is saved
  data, so it is unchanged.
- **Phrase matching.** Keyword rules still match on substrings, so "Not
  ready" matches "ready". That is a behaviour change for a separate ticket.
