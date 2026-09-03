# Vectorscope

**Tier:** Molecules-L1

## Purpose

A chroma scatter/density plot on a circular broadcast-graticule background — the tool colorists
use to judge hue and saturation independent of luma. Every RGB sample (or histogram bin) converts
to a Cb/Cr chroma pair and plots at the corresponding position on the circle: distance from center
is saturation, angle around the circle is hue. The skin-tone vectorscope workflow (#3268) is this
component's primary consumer — it drags a skin-tone selection's Hue control until the plotted skin
cloud lands on the graticule's skin-tone line.

## Variants

- **Dot-scatter** (`samples`, the original shape) — each RGB sample plots as an individual dot.
  Cheap for a bounded sample count (a few hundred pixels); not meant for a full-frame histogram.
- **Density** (`bins`, added #3276) — a row-major `n × n` grid of per-cell counts renders as a
  heatmap instead of individual dots, log-scaled so a single dominant bin (the near-neutral cluster
  most real photos have) doesn't crush every other bin to invisible. This is the shape the GPU/CPU
  scope pass (raw-core's `scope::vectorscope`) actually produces — a 128×128 histogram, not a
  sample list — and is mutually exclusive with dot-scatter: when `bins` is present it replaces the
  scatter draw entirely rather than compositing with it.

Both variants always draw the same chrome: the outer circle, six 60°-spaced spokes, and six
broadcast target markers (Red/Yellow/Green/Cyan/Blue/Magenta) at their true Rec.709-derived
positions — target markers are NOT evenly spaced at 60° (a common misconception); the real
broadcast-standard positions alternate between roughly 54° and 72° gaps, a property of how the eye's
hue sensitivity is baked into the Rec.709 matrix coefficients, reproduced here rather than
approximated with a uniform hexagon.

## States

- **Default** — chrome + targets + the active variant's dots/cells. No skin-tone line, no rotation.
- **With skin-tone line** (`showSkinToneLine: true`) — an additional graticule line at the
  broadcast-convention skin-tone angle (123°, a fixed graticule constant — independent of, though
  coincidentally close in spirit to, the core's Oklab-based `RangeRefinement.skinTone` preset hue),
  flanked by a fainter ±10° wedge marking the acceptable tolerance band.
- **Red-at-3-o'clock** (`redAt3OClock: true`) — rotates the entire plot (targets, skin-tone line,
  and whichever dots/cells are showing) so the Red target sits at exactly 0°/3-o'clock instead of
  its native ~103°. Some broadcast scopes use this convention; the skin-tone HUD (#3277) uses it so
  the skin-tone line reads as a stable, easy-to-eyeball diagonal regardless of a shot's white
  balance.

## Tokens used

- Color: `color.border` (outer circle + spokes), `color.text_muted` (the six target markers),
  `color.image_canvas` (circular background fill), plus `dotColor` (default `color.primary`) for
  the scatter dots / density cells.
- The skin-tone line is drawn at a fixed yellow (not a design token) — matching the literal
  broadcast-scope convention of a yellow skin-tone reference line, not a themeable UI accent.
- No spacing or radius tokens — the component is a single circular canvas sized entirely by `size`.

## Props

- `samples`: `[MuiVectorscopeSample]` / `readonly MuiVectorscopeSample[]` — RGB triples, each
  channel `0...1`. Required; pass `[]` when using the `bins` variant.
- `size`: number, default `96` (Apple) / `64` (web) — the canvas's width and height (it's always
  square).
- `dotColor`: color, default `color.primary` — the scatter dot / density cell color.
- `bins`: optional row-major `n × n` grid of per-cell counts (`nil`/`undefined` by default). When
  present, replaces the dot-scatter draw with the density heatmap.
- `showSkinToneLine`: boolean, default `false`.
- `redAt3OClock`: boolean, default `false`.

All four parameters added in #3276 (`bins`, `showSkinToneLine`, `redAt3OClock`, plus `dotColor`
which already existed) default to their pre-#3276 values or `false`/`nil`, so every existing
scatter-plot call site keeps compiling and keeps its dot-scatter behavior unchanged. The one
visible change to every existing call site is additive, not opt-in: the six broadcast target
markers now always draw (previously the graticule was just the circle and spokes) — a deliberate
choice, since target markers are a standard, always-useful reference on any vectorscope rather than
a v2-only feature, not an oversight in the "additive" framing above.

## Accessibility

- The whole plot is a single accessibility element with the label "Vectorscope" (SwiftUI
  `accessibilityLabel` / web `role="img" aria-label="Vectorscope"`) — the canvas conveys no
  information a screen reader can usefully decompose further (individual dot positions, bin
  counts, and the skin-tone line's exact angle are not exposed as separate elements), matching the
  Histogram/Waveform/Parade family's existing contract-free precedent for canvas-drawn data plots.
  This is the first written contract in that family; Histogram/Waveform/Parade remain uncontracted.
- Not independently focusable or interactive — the vectorscope is read-only visual feedback for a
  drag happening on a DIFFERENT control (a mask's Hue slider); it never receives keyboard focus
  itself.
