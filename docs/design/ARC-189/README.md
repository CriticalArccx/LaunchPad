# ARC-189: ArcLab Design System, phase 1 (foundations)

Source: the shared ArcLab "Design System" artifact (version 1793400003-ef96).
Its tokens are copied unchanged into `css/arclab-tokens.css`. Every page loads
that file and Roboto from Google Fonts.

## Applied in phase 1
- **Type.** Roboto everywhere; the header title uses `type.display`.
- **Action colour.** Petrol replaces Material green `#2e7d32`/`#1b5e20`, and
  `Petrol-tint` replaces the light green fills. Decorative gradients are now
  flat colour.
- **Neutrals.** The old greys map to the warm tokens: Page, Subtle, Border,
  Borderstrong, Textprimary and Textsecondary.
- **Focus.** A 2px Arc Green focus ring (`:focus-visible`).
- **Fallbacks.** Every `var()` carries its hex fallback, so a page still draws
  if the tokens file fails to load.

## Deliberately not changed (later phases)
- **Status colours.** The user-editable Status Colour rules and
  Equipment/Tamper Seal status colours are saved data. Moving them to
  StatusBadge is phase 2.
- **Dark mode.** The dark-mode rules are unchanged.
- **Dashboard palette.** The Dashboard keeps its own dark palette
  (font only for now).
- **Print and export windows.** These are separate documents, so they keep
  plain hex.
- **Other colours.** The blue and purple help buttons, red danger actions,
  and per-element radius and spacing in inline styles.
