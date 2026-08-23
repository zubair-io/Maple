# Remote Image

**Tier:** Atom

## Purpose

Loads an image whose bytes aren't available yet — a thumbnail that has to be fetched, decoded, and
cached before anything can be painted. Unlike Image (which just draws a `src` it's handed), Remote
Image owns the whole tiered-load lifecycle: show whatever's cheapest to get first, then replace it
with something sharper as better data arrives, without ever regressing to a blurrier tier once a
sharper one has loaded.

## Variants

There is one visual variant; what varies is how many tiers the caller supplies (`thumb`,
`preview`, `full` — any subset, in that priority order). A caller with only a `full` URL still gets
the same loading/error chrome, just with a single-tier sequence.

## States

- **Loading (no tier yet)** — a centered spinner over the `color.image_canvas` backdrop; nothing to
  show at all.
- **Thumb / Preview / Full** — once a tier resolves it's displayed immediately, blurred
  proportional to how coarse that tier is; the blur eases toward zero as a sharper tier lands
  (the "blur-up" transition). A later tier replacing an earlier one never causes a flash back to
  the loading spinner.
- **Error** — every configured tier failed to load; shows a short message plus a Retry button that
  re-runs the whole sequence from the top.

## Tokens used

- Color: `color.image_canvas` (backdrop behind the loupe — the same token the full-resolution
  editor canvas uses, since a remote thumbnail is conceptually the same "image not painted yet"
  surface), `color.border` / `color.primary` (spinner ring), `color.text_muted` (error copy),
  `color.surface` / `color.surface_hover` (retry button).
- Radius: `radius.sm` (retry button) — the caller controls the outer box's own radius/crop the same
  way it would for a plain Image.

## Props

- `tiers`: `{ thumb?, preview?, full? }` — at least one URL; loaded in `thumb → preview → full`
  order.
- `alt`: string (required), same rule as Image.
- `fit`: `fill | fit` (default `fill`).

## Accessibility

- Same `alt`-is-mandatory rule as Image — the tier that's currently displayed still needs a text
  equivalent throughout the load sequence, not just once the final tier lands.
- The Retry button is a real, keyboard-reachable `<button>` with a visible label, not an icon-only
  tap target.
- The loading state's spinner is `aria-hidden` (decorative) rather than announced on every tier
  transition, which would otherwise chatter at screen reader users as thumb → preview → full each
  resolve.
