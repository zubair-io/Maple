# Windows Maple UI Adoption — Spec (MN2–MN4)

> Audience: an agent running ON A WINDOWS MACHINE with the full toolchain, so it can
> build, launch, and interactively test Maple.WinUI locally — capabilities the
> earlier (Mac-driven) waves never had. Companion plan:
> `docs/superpowers/plans/2026-08-27-windows-maple-ui-adoption.md`.

## What this is

Maple's cross-platform design system ("Maple UI") is fully built on Windows:
all 168 catalog elements (`docs/unified-component-catalog.md`) exist as pure-C#
controls under `src/windows/Maple.WinUI/MapleUI/` (namespace `Maple.UI`,
tiers Atoms → Pages), with a gallery window on **Ctrl+Shift+G** and WinUI-free
`*Logic`/`*Math` classes unit-tested in `src/windows/Maple.WinUI.Tests/`.

Adoption — making the real app screens USE those elements and deleting the
hand-rolled legacy they replace — is complete for the main window chrome
(wave MN1, PR #3025: MuiButton/MuiActionButton/MuiIcon/MuiText everywhere,
legacy `Themes/Styles.xaml` deleted). Three waves remain, and each benefits
from on-device verification:

| Wave | Ticket | Scope |
| ---- | ------ | ----- |
| MN2 | #3051 | Editor controls: `Controls/ColorWheelControl.cs`, `Controls/CropOverlayControl.cs`, `Controls/ToneCurvePlotControl.cs` → `MuiColorWheel`, `MuiCropOverlay` (+`MuiCropToolbar`), `MuiCurvePlot`/`MuiToneCurvePanel` |
| MN3 | #3052 | Greenfield Settings surface on `MuiPageSettings`/`MuiSettingsSection` |
| MN4 | #3053 | Legacy-zero sweep + real QR dependency (replaces `MuiQrPlaceholder`, see the #3012 note) |

## Invariants (binding)

1. **Replace-then-delete, same PR.** A legacy control is deleted in the PR that
   migrates its last consumer — proven by `grep -rn <ClassName> src/windows`,
   never assumed. `Controls/MapleIconControl.cs` + `MapleIconShapes.cs` are NOT
   legacy — they back `MuiIcon`.
2. **Behavior-preserving.** Same gestures, same pipeline calls, same rendered
   output. Editor-control swaps (MN2) must not change what reaches the render
   pipeline: verify by driving the control on-device and confirming the preview
   responds identically (see the plan's verification protocol). Color output is
   judged by objective evidence only — never "looks right".
3. **Extend, don't fork.** If a Mui control lacks something the real screen
   needs, extend the Mui control (plus its `*Logic` test coverage when logic
   changes, linked via explicit `<Compile Include>` in
   `Maple.WinUI.Tests.csproj`). Never fork it, never keep the legacy control.
4. **Pure-C# controls, no XAML pairs** — the repo's established Maple.UI
   convention. XAML usage sites declare `xmlns:mui="using:Maple.UI.Atoms"`
   (see `MainWindow.xaml`).
5. **Read the ACTUAL Mui control source before using any member.** Phantom
   properties were the top CI-failure class in the build-out. Known WinUI
   pitfalls (all hit before): property names shadowing base events (CS0019);
   bare `Colors.` (qualify `Microsoft.UI.Colors`); ambiguous `Path` (qualify
   `Microsoft.UI.Xaml.Shapes.Path` only on actual Path elements, never
   PathFigure/PathGeometry); `Grid.SetRow/SetColumn` take FrameworkElement;
   `??` operands need a common type; **`PathIcon` is fill-only** — the stroke
   icon registry's zero-area line data renders invisible in it, and
   `MenuFlyoutItem.Icon` requires an `IconElement` (MuiIcon is a
   ContentControl and cannot satisfy it) — keep `FontIcon` glyphs there.
6. **No real personal data** in any sample/demo content — fictional
   placeholders only.
7. **Merges only on Zubair's explicit approval.** Open PRs ready-for-review
   (never draft), body ends `Closes #<ticket>` +
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`, branch
   rebase-clean on current `main` ("Rebase and merge" repo). Reply to and
   resolve review-bot threads (Copilot/Jules) before a merge is requested;
   Jules re-reviews every push — sweep the whole class of any finding, not
   just the flagged instance.

## MN2 — editor controls (the substantive wave)

Current consumers: `MainWindow.xaml` and `MainWindow.Panels.cs` (the edit-rail
panels host all three controls; `MainWindow.Crop.cs` owns crop interactions).

Per control:

- **ColorWheelControl → MuiColorWheel.** The Mui wheel's geometry/puck math
  lives in `MuiColorWheelMath` (unit-tested; its web sibling had a
  puck-drawn-50%-too-high bug found during the parity build — the math files
  are the source of truth, not the legacy control). Wire the same
  hue/saturation change events into the existing view-model paths so the
  pipeline receives identical values.
- **CropOverlayControl → MuiCropOverlay + MuiCropToolbar.** Preserve drag
  handles, rule-of-thirds grid, aspect locking, and the crop-commit flow in
  `MainWindow.Crop.cs`. If MuiCropToolbar's aspect presets don't match the
  app's, extend the control with a configurable preset input.
- **ToneCurvePlotControl → MuiCurvePlot / MuiToneCurvePanel.** `ToneCurveMath`
  stays (it is control-agnostic math; move/share it rather than duplicating).
  Curve channel switching (Luma/R/G/B) already runs on MuiActionButton tabs
  from MN1 — the plot swap must keep the same per-channel point editing and
  the same curve data reaching the pipeline.

On-device gates (why this wave wants a Windows agent): with the app running on
a real image, each migrated control must demonstrably drive the render — drag
the wheel/curve/crop and watch the preview respond live, before AND after the
swap, with screenshots captured at fixed app states for comparison. The
plan's verification protocol makes this concrete.

## MN3 — Settings surface (greenfield)

The Windows app has NO settings UI today. Inventory `Services/`, `ViewModels/`,
and `Models/` for configuration the app already persists or hardcodes (server
connection/pairing, library roots, cache locations, developer toggles), then
build the first Settings surface directly on `MuiPageSettings` /
`MuiSettingsSection` / `MuiListRow` / form atoms. Scope discipline: expose
only settings that already exist in code — do NOT invent new configuration
(YAGNI; new tunables belong in the DB-backed settings system per
`CLAUDE.md`). Nothing to delete. Entry point: a Settings item in the existing
menu chrome. If genuinely nothing user-configurable exists yet, the wave
delivers the page scaffold with whatever real entries exist (e.g. pairing +
about/version) and documents what was found — an empty fake page is not
acceptable.

## MN4 — sweep + QR

1. Grep + visual sweep for remaining hand-rolled chrome anywhere in
   `src/windows/Maple.WinUI/` outside `MapleUI/` (dialogs, context menus,
   pano/rename/qualify windows) — migrate stragglers or document keeps with
   reasons (FontIcon-in-MenuFlyoutItem is a documented keep).
2. Replace `MuiQrPlaceholder` with a real QR implementation. Preference
   order: a small vetted NuGet package (e.g. QRCoder) generating the module
   matrix, rendered through the existing Mui chrome. This was deferred
   because no Mac-side compile could verify a new dependency — a Windows agent
   can. Add `*Logic`-level tests for the payload→matrix step.
3. Confirm the app builds + tests green, the gallery still renders every
   element, and no legacy control/style remains (`MapleIconControl` stays).

## Out of scope

- Web/Apple icon mirroring (#3024) — Windows already has its icons.
- Any change to the Rust core or render pipeline behavior.
- Apple waves (MA2+).
