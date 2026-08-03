# Web editor — Apple Card-layout fidelity

Date: 2026-08-03
Status: approved, ready for implementation planning

## Summary

The web editor's canvas-first shell already carries the Card architecture — a full-bleed canvas with a
floating tool dock and a floating control surface, themed from `pro-tokens.scss`, which mirrors the
Swift `ProTokens.swift` palette. What it does not carry is the Apple layout's visual and structural
detail. This spec covers closing that gap on the web side only.

The scope is `src/web/projects/maple-common`. No Swift, Rust, or colour-pipeline code is touched, so
the CIEDE2000 parity harness and `tools/codegen.sh` are both out of scope.

## What the Apple side actually mounts

Three findings from reading `EditorView.swift` reshaped this spec, and each contradicts a reasonable
first assumption.

`ControlCard.swift` is not mounted. The comment at `EditorView.swift:248-251` records that
`MobileControlBar` replaced it and that the file survives only because its preview and tests remain
valid. The desktop control surface is `FlyoutSliderPanel` — a fixed 300pt column at
`.padding(.trailing, 88)` (12pt dock inset + 64pt dock width + 12pt gap), vertically centred by
`alignment: .trailing` on a full-height frame. The bottom-anchored card that web renders today
corresponds to no mounted Apple view.

Apple's Card variant cannot reach HSL, Black & White, or Colour Grading. Neither `ToolDock` nor
`MobileControlBar` offers a button for them, and both `LivingSliderGrid.swift:29` and
`MobileControlBar.swift:169` filter on `displayRange(for:) != nil`, which excludes all three because
none has a primary field. Their `armedTool` branches are reachable only from the `.panel` variant or
the legacy `ToolPillRow`. Web, by contrast, promotes all three to dock buttons. Matching Apple's
9-entry dock without providing a replacement route would therefore strand three shipped tools, which
principle 6 in `CLAUDE.md` forbids.

Apple's iPhone does not run a card layout at all. `EditorView.swift:251` mounts
`IPhoneLegacyControlBar` whenever `isIPhone` — defined at `EditorView.swift:96-102` as
`UIDevice.userInterfaceIdiom == .phone`, not as a size class. That view is the restored S5 stack:
an opaque `MapleTokens.bg` bar composed of `ColorAccessoryRow`, `SubParamRow`, `DragBar`, a divider,
`GroupTabsView`, and `ToolPillRow`. `MobileControlBar`, the two-glass-card layout, renders only when
`!isIPhone && !isRegular` — compact-width iPad in Split View.

Because web retired the S5 editor deliberately in epic #1807, `MobileControlBar` is the phone target
rather than `IPhoneLegacyControlBar`. This is a decision to treat the compact-width iPad layout as
the canonical card design, accepting that web's phone and Apple's iPhone stay visually different.

## Design

### Tool dock

The dock collapses to a single nine-entry list shared by both orientations: Light, Color, Effects and
Detail, then a divider, then Crop, Tone Curve and Presets, then disabled Mask and Heal placeholders.
Because vertical and horizontal now present the same entries, the `orientations` field on `DockEntry`
is removed along with the duplicated Crop entry that existed only for per-orientation ordering.

Each button becomes a 36px circle holding the glyph, with a 10px label beneath it and an accent dot
badge in the lower-right when any tool the entry covers holds a non-default value. Since HSL, Black
& White and Grade no longer have their own buttons, their modified state rolls into the Color group's
dot, which is what "any tool the entry covers" has to mean for a group entry. The active state is an
accent fill with an accent border and an accent, semibold label. Disabled placeholders render
at 40% opacity and stay out of the accessibility tree, matching `DisabledDockPlaceholder`.

Nine labelled entries stack to roughly 515px, just inside the 520pt ceiling `ToolDock.swift:73`
imposes, so the column needs no scroll affordance. All thirteen of today's entries would have reached
roughly 735px and forced one.

The Optics placeholder is dropped. Apple has no equivalent button, and Mask and Heal already
communicate that more tools are coming.

HSL, Black & White and Grade lose their dock buttons and move to the sub-tool row described below.

### Flyout panel

The control surface moves from a bottom-anchored bar to a floating fixed-width column. Its anchor
changes from `bottom: 0; left: 50%; width: min(860px, calc(100vw - 320px))` to `right: 88px;
top: 50%; transform: translateY(-50%); width: 300px`, and its radius from top-two-corners to a
uniform 18px, so it reads as a card floating beside the dock rather than a tray attached to the
viewport edge.

The header becomes an accent group glyph followed by the group name in accent, uppercase, 10px
semibold with 0.6px tracking, and a reset control on the trailing edge. The group-chip row is
removed, since the dock owns group switching on this breakpoint, as does the grab handle and its
peek mode.

The component keeps its `control-card` filename. "Card" no longer describes the shape precisely, but
renaming reaches both shells and three spec files while changing no behaviour.

### Colour sub-tool row

A chip row reading Basic, HSL, B&W and Grade renders inside the panel when Color is the active group.
Selecting a chip swaps the panel body for that tool's existing panel, driven by the same `armTool`
calls the dock buttons make today; no adjustment logic or field binding moves. Light, Effects and
Detail have no sub-tools and render no row.

The row renders on every breakpoint. Because the three tools leave the dock in both orientations,
this row is their only route on phone as well as on desktop, and it is what keeps the phone bar's
nine entries from stranding them.

This surface exists on web and not on Apple. A follow-up ticket should track the equivalent gap in
the Swift Card variant so the two do not drift again. No Swift changes land in this work.

### Living slider

The slider changes from a single row of label, track and value to a stacked form: label and
monospaced value share a top line, and the gradient track spans the full width beneath, matching
`LivingSlider.swift:161`. Modified values render in accent. This is a template and stylesheet change;
the drag mathematics, keyboard handling and ARIA attributes in the component class are untouched.

### Phone

The phone layout follows `MobileControlBar`: a slider panel card above a horizontally scrolling bar
of the same circle-and-label buttons, both in glass, separated by an 8px gap with a 12px inset. The
bar carries the same nine entries, dimmed Mask and Heal included.

The slider panel becomes always visible, matching Apple, which retires the closeable-flyout
behaviour — the `closed` input, the `phoneCardOpen` signal, and the close button. This was an
assumption stated and accepted during design rather than a constraint read off the Apple source, and
it is reversible if the reclaimed canvas space turns out to matter more than the parity.

## Constraints

`editor-shell.component.ts` stands at 594 lines against a 600-line hard limit and a 570-line headroom
gate, so it cannot grow at all — `tools/check-budget-headroom.sh` fails any PR that enlarges a file
already past 570. New logic belongs in the child components or in a new sibling module, following the
existing `-keyboard`, `-scrub`, `-chrome`, `-hud` and `-undo` split.

`tools/check-file-budget.sh:104` scopes the budget to `*.rs`, `*.swift`, `*.ts`, `*.tsx`, `*.js` and
`*.py`. Stylesheets and templates are ungated, so the 784-line `editor-shell.component.scss` may be
edited freely, though splitting it remains worthwhile on its own merits.

## Testing

Three existing suites assert the structure this spec changes and need updating in step:
`tool-dock.component.spec.ts` (366 lines), `control-card.component.spec.ts` (198) and
`living-slider.component.spec.ts` (290). New coverage is needed for the modified-dot predicate, the
divider and disabled placeholders in the dock, and the colour sub-tool row's arming behaviour —
particularly that each chip arms the same tool its former dock button did.

Storybook on port 6006 provides visual verification per component without standing up the dev server,
API and native dylib. Full-shell verification still wants the real dev server, since anchor geometry
and the phone breakpoint only manifest in the assembled layout.

No colour-pipeline stage changes, so `src/scripts/test_color_pipeline.sh` is unaffected.

## Out of scope

The Swift Card variant's missing HSL, Black & White and Grade route is a separate ticket. So is any
change to `IPhoneLegacyControlBar` or to Apple's editor generally. Masking and healing remain
unimplemented on both platforms and stay as disabled placeholders.
