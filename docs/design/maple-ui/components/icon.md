# Icon

**Tier:** Atom

## Purpose

A single glyph rendered at a fixed size scale, `currentColor`-tinted by default.
Apple's shared MapleUI component bundles Google Material Symbols Rounded, available
on macOS, iOS and iPadOS offline. New Apple callers use Google's canonical names.
Web currently uses a stroke-SVG registry and Windows uses Segoe Fluent glyphs.

The Apple migration is tracked by #3686: the bundled-library slice is #3898 and
caller migration is #3899. The [baseline inventory](../apple-icon-inventory.json)
records direct SF Symbol uses and MuiIcon callers, including dynamic inputs.
The inventory records the completed caller migration in #3899 and its explicit
native exceptions. Legacy public model inputs resolve through `MuiIconLegacyNames`
to Material outlines, preserving compatibility for sibling apps. New callers use
canonical names. Unknown inputs from external consumers retain the legacy SF
fallback; Maple app callers are covered by the shared library and alias registry.

## Variants

None — Icon has no variants in the Button/Badge sense. It varies by which glyph and size are
requested, not by a stylistic branch.

## States

Icon is typically non-interactive on its own (wrapped by Button/IconButton for interactivity).
No hover/pressed/focused/disabled state belongs to the Icon atom itself — those belong to whatever
interactive atom wraps it.

## Tokens used

- Color: `currentColor` by default (inherits the surrounding text/button color) — `color.text_main`
  or `color.text_muted` at call sites that don't already establish a color context.
- Size: the unified guide's five-step scale — xs 14px, sm 16px, md 24px, lg 30px, xl 36px. **These
  are not yet tokenized** in `ui_tokens.rs` (no `ICON_SIZE_TOKENS` table exists) — a follow-up
  foundation task should add one before multiple platforms start implementing Icon in parallel, to
  avoid a fourth silently-drifting value set. Flagging this explicitly rather than having each
  atom-implementation plan invent its own five numbers independently.

## Props

- `name`: on Apple, a canonical Google Material Symbols Rounded name from the
  bundled `glyphs.json`, such as `lan`, `public`, `photo_camera`, or `tune`.
  The component draws bundled vector outlines at weight 400, optical size 24,
  grade 0. The `filled` prop selects the filled outline for selected states. Legacy SF model identifiers resolve to Material outlines through the compatibility table.
  `cloud` and `calendar` intentionally retain the custom 16×16 outlines shared
  with Web/Windows (#3024); migrating their custom path treatment requires
  coordinated changes to those platforms. Native-system exceptions are
  recorded with the caller migration, rather than silently falling back.
  [Attribution and update instructions](../../../licenses/google-material-symbols.md)
  cover adding names and updating the bundled library.
- `size`: `xs | sm | md | lg | xl` (default `md`).
- `filled`: Boolean (default false), selects the filled Material outline; legacy
  `.fill` inputs preserve their selected appearance.
- `color`: optional override; defaults to `currentColor`.

## Accessibility

- Decorative icons (most icons paired with visible text, e.g. inside a labeled Button) must be
  hidden from assistive technology (`aria-hidden`, `.accessibilityHidden(true)`,
  `AccessibilityView="Raw"`) so they aren't announced redundantly alongside their label.
- Icon-only usages (no adjacent visible text) are not self-sufficient — the _wrapping_ component
  (IconButton, etc.) is responsible for supplying an accessible label; a bare Icon atom is never
  used standalone as an interactive, unlabeled control.

## Native Apple exceptions

The inventory lists every direct SF call and its reason. Apple's Settings tab
metadata and menu/navigation/toolbar metadata retain system symbols because the
OS owns their rendering. Image-producing placeholder APIs (`MuiRemoteImage`,
`AtomsGalleryView`, `PreviewZoomController`) retain native images where the public
API requires `Image` or `UIImage` instead of a View. The vectorscope's Canvas
person legend stays a data-rendering glyph. These are separate from Maple chrome,
which uses MuiIcon. The Apple gate runs `tools/check-apple-icons.py` to reject new
untracked SF calls and stale exceptions. Controls keep their existing accessible
labels; decorative MuiIcon content is hidden from assistive technology.
