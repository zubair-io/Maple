# Image

**Tier:** Atom

## Purpose

A raster leaf for a locally-available image (already-resolved URL, blob URL, or data URI) — the
plain building block that Avatar and higher-level thumbnail/preview surfaces compose on top of.
Distinct from Remote Image, which owns the network/cache/tiered-load lifecycle; Image just draws
whatever `src` it's given and handles the fit/broken/loading presentation around it.

## Variants

- **Fill** — `object-fit: cover`; the image fills its box edge-to-edge, cropping whichever axis
  overflows. The default — matches how thumbnails and grid cells behave today.
- **Fit** — `object-fit: contain`; the whole image stays visible, letterboxed on the tighter axis.

## States

- **Loading** — the box renders on `color.surface_alt` while the image decodes; the `<img>` itself
  fades in (`opacity 0 → 1`) once it loads rather than popping in, so a slow network load doesn't
  flash unstyled content.
- **Loaded** — full opacity, normal display.
- **Broken** — a failed load swaps to a placeholder glyph on the same `color.surface_alt`
  background, instead of the browser's default broken-image icon — the visual language stays
  consistent with the rest of the design system even when the source 404s.

## Tokens used

- Color: `color.surface_alt` (backdrop + placeholder background), `color.text_muted` (placeholder
  glyph color).
- Radius: `radius.none` through `radius.full` — Image is a leaf that gets cropped into whatever
  shape its container calls for (square thumbnail, rounded card, circular avatar backing), so all
  five radius tiers are valid, caller-selected.

## Props

- `src`: string (required).
- `alt`: string (required) — every Image needs real alt text; there's no silent "decorative"
  escape hatch the way Icon has one, because a raster photo is content, not chrome.
- `fit`: `fill | fit` (default `fill`).
- `radius`: `none | sm | md | lg | full` (default `md`).
- `aspectRatio`: optional `width / height` number — when omitted, the image sizes to whatever box
  its container gives it.

## Accessibility

- `alt` is mandatory and forwarded straight to the native `<img>` — no icon-only-button-style
  opt-out, since a photo conveys information a screen reader user needs a text equivalent for.
- The broken-image placeholder keeps the same `alt` text as an `aria-label` on its `role="img"`
  container, so a failed load doesn't silently drop the accessible name.
