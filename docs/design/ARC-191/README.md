# ARC-191: Arc Green as LaunchPad's action colour

This is a LaunchPad-level departure from the ArcLab Design System, at the
product owner's request: LaunchPad reads green, not Petrol.

- `css/launchpad-theme.css` defines `--lp-action`, `--lp-action-hover` and
  `--lp-action-tint`, and every page loads it after `arclab-tokens.css`. All
  former Petrol uses now point at these aliases, so going back to Petrol
  means editing only that file.
- `--lp-action` is #2f7a31, which is Arc-Green-ink (#358537) darkened just
  enough for AA text on Arc-Green-tint: 4.8:1 on the tint, 5.3:1 on white,
  and 5.3:1 for white text on it. Arc-Green-ink itself is 4.1:1 on the tint.
- Bright Arc Green (#4ebd4f) stays for edges, markers, today and selection
  (ARC-190).
- These values aren't design-system tokens: #2f7a31, its hover #276629, and
  the action role moving from Petrol to green. They're flagged to Arc Lab.
