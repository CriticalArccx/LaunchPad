# ARC-192: Phone layout, phase 1 (shell + Schedule)

`css/launchpad-mobile.css` is loaded only below 768px wide
(`<link media="(max-width: 768px)">`), so desktop and iPad keep their
current layout. The small amount of supporting JS sits next to the
Calendar edit panel in `index.html` (`isMobileLayout`,
`openScheduleRowEditor`, `toggleMobileFilters`).

- **Header.** Logo and title on the first row. The view tabs and dark mode
  sit on a second row that scrolls sideways.
- **Bottom nav.** The left sidebar becomes a bottom bar that scrolls
  sideways, with labels. The active item is marked in Arc Green.
- **Filters.** The right Filter bar becomes a full-screen sheet, opened from
  "🔍 Filters" in the toolbar and closed with Done.
- **Toolbar.** One row that scrolls sideways, with 40px or taller targets.
  Presence avatars and the Calendar toggle are hidden: the 7-day grid needs
  a wide screen.
- **Schedule lines become cards.** They show Time, Activity and Status on
  the first line, and Asset and Place on the second.
  - Tapping a card opens the line in the Calendar edit panel, shown full
    screen, with every field. Saving, lookups and autofill are unchanged.
  - "+ Add Line" opens the new line in the editor straight away.
  - Status Colour tints stay on the Status pill only. Other fields use
    `-webkit-text-fill-color` and `background-clip: text`, because
    applyCellColor() sets the tints inline with `!important`.
- **iPhone safe areas.** `viewport-fit=cover`, with
  `env(safe-area-inset-*)` padding at the top and bottom.

## Later phases
- Phone layouts for Bridge, Equipment Tracker, Tamper Seals, Dashboard,
  Settings and the larger modals (Batch Add).
- Bulk select on phones.
