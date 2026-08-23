# Link

**Tier:** Atom

## Purpose

An inline hyperlink — text that navigates, embedded inside a sentence or a metadata row (e.g. "View
details", a person's linked source folder). Distinct from Button: a Link never carries the visual
weight of a filled control, and it can sit mid-sentence.

## Variants

None — Link has a single visual family. It varies by **destination kind**:

- **Internal** — same-app navigation. Plain underlined text, no affordance icon.
- **External** — leaves the app (a different origin, or a `mailto:`/deep-link target). Gets a
  trailing affordance icon so the reader knows before they click, plus the safe
  `target="_blank"` + `rel="noopener noreferrer"` pair so the app never leaks a `window.opener`
  reference to the destination.

## States

- **Default** — `color.primary` text, underlined.
- **Hover** — text lightens slightly (a brightened tint of `color.primary`, not a second hardcoded
  hue).
- **Visited** — dims to `color.text_muted`, matching how a spent/already-read link should recede
  next to unread ones in a list.
- **Focused** — 2px ring at `color.primary` 20% opacity, offset 2px (same treatment as Button/Action
  Button for a consistent focus language across the Actions group).
- **Disabled** — 50% opacity, `not-allowed` cursor, `href` removed so it's inert even if a click
  handler is bypassed.

## Tokens used

- Color: `color.primary` (default/focus ring), `color.text_muted` (visited).
- Radius: `radius.xs` (4px — the focus-ring corner radius only; the link itself has no visible
  container).

## Props

- `href`: string — the navigation target. Required.
- `external`: boolean (default `false`) — when true, renders the trailing affordance icon and sets
  `target="_blank"` / `rel="noopener noreferrer"`.
- `disabled`: boolean.

## Accessibility

- The link's visible text is always the accessible name — never ship a Link whose only content is
  an icon.
- External links must announce their destination change to assistive technology beyond color alone
  — the trailing icon satisfies this visually; screen-reader users additionally get "opens in new
  tab" from the browser's own `target="_blank"` handling in most AT, but callers embedding a Link in
  a sentence should still consider phrasing that makes the external hop explicit in the surrounding
  text.
- Disabled links must be excluded from the tab/focus order (no `href` to land on), not merely
  visually dimmed.
