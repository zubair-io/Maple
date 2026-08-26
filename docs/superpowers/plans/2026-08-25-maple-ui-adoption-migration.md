# Maple UI Adoption & Legacy Removal — Migration Plan

> Executed wave-by-wave via agent dispatch, one surface per wave, per-wave PRs. The Maple UI
> component library (all 168 elements, PRs #3001/#3013/#3014) is the replacement target;
> `docs/unified-component-catalog.md` maps legacy elements to their `mui-`/`Mui` successors.

**Goal:** Migrate every real app screen on Web, Apple, and Windows from hand-rolled/legacy UI
elements onto the Maple UI components, deleting each legacy element in the same PR that removes
its last consumer — ending with zero duplicated UI implementations per platform.

## Global rules (bind every wave)

- **Replace-then-delete, same PR.** A legacy component/style is deleted in the PR that migrates
  its last consumer, never before (no dead-but-present period) and never after (no lingering
  duplicates). "Last consumer" is proven by grep + the platform's dead-code gate (fallow on web),
  not assumed.
- **Behavior-preserving migrations.** A wave swaps rendering/structure, not features. Any behavior
  change discovered mid-wave is ticketed separately, not smuggled in.
- **The showcase components are the product components now.** Where a `mui-` element was built as a
  "presentational reference" (organisms/templates/pages) and the real screen needs wiring the
  reference lacks (services, routing, live data), the wave EXTENDS the mui component with the
  needed inputs/outputs — it does not fork it and does not keep the legacy organism.
- **Performance gates are absolute.** Editor-surface waves (sliders, color wheel, canvas chrome)
  must hold the 16ms slider-tick budget and pass `src/scripts/test_color_pipeline.sh` +
  the SliderMatrix/XCUITest harnesses where applicable. If a mui control can't hold the budget,
  the wave hardens the mui control (it's the survivor) rather than keeping the legacy one.
- **What is NOT legacy (do not remove):** the web `maple-icon` stroke registry (mui-icon's backing
  store); `pro-tokens.scss` (editor canvas tokens, #1535); the generated token files; platform
  template shells that mui templates now wrap rather than replace (judged per wave).
- **Verification per platform:** Web — full vitest suites + fallow + `ng build` both apps + live
  dev-server visual pass per migrated screen. Apple — `swift test` + macOS AND iOS xcodebuild +
  the UITest visual harness where the surface has goldens. Windows — CI `windows-x64` +
  gallery-window smoke via the migrated surface.
- **Per-wave PRs, rebase-clean, ticketed, user merges.** Fresh `main` between waves.

## Phase MW — Web

Legacy inventory (from the 2026-08-22 audit; unchanged by the build-out): `maple-collapsible`,
`error-banner`, `loading-banner`, `confirm-dialog`, `save-status` in maple-common; the develop/
editor family (`living-slider`, `color-wheel`, `drag-bar`, histogram et al.); `settings-row` +
`settings-chrome.scss`'s `btn-primary`/`btn-ghost` (93 raw `<button>`s across 18 of 19 settings
templates, CSS duplicated in 3 files); assorted raw markup in `develop/`, `info/`, `editor/`.

| Wave | Surface                                        | Replaces → With                                                                                                                                                                 | Deletes when done                                                                                                     |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| MW1  | Settings (all ~12 sections, both apps' routes) | raw `<button>`/`<input>`/ad-hoc rows → mui-button/mui-input/mui-form-field/mui-list-row/mui-settings-row-family; per-section shells → mui-settings-shell + mui-settings-section | `settings-row.component`, `btn-primary`/`btn-ghost` CSS (all 3 copies), settings-chrome duplication                   |
| MW2  | Shared feedback chrome (both apps)             | error-banner/loading-banner → mui-banner; confirm-dialog → mui-dialog; save-status → mui-status-text; maple-collapsible → mui-collapsible                                       | all five legacy components                                                                                            |
| MW3  | Info panel + enrichment                        | info/\* rows, keyword chips, rating rows → mui-info-panel/mui-enrichment-panel compositions (extended with live service wiring)                                                 | superseded info/\* row components                                                                                     |
| MW4  | Browse shell                                   | folder tree rows, grid cells, toolbar chrome → mui-sidebar/mui-collection-grid/mui-toolbar (extended for virtual scroll + DnD parity)                                           | superseded browse chrome components                                                                                   |
| MW5  | Editor chrome (HIGH RISK — perf gates)         | develop/living-slider, color-wheel, drag-bar, panel chrome → mui equivalents hardened to the 16ms budget; scopes → mui plots fed by the real pipeline taps                      | develop/\* duplicated controls                                                                                        |
| MW6  | Legacy-zero sweep                              | —                                                                                                                                                                               | fallow `--gate all` clean on `lib/ui`-overlapping duplicates; grep proves no `btn-`, `maple-collapsible`, etc. remain |

Enforcement ratchet: after MW1, extend the fallow config/a CI grep so raw `<button>`/`btn-*`
cannot re-enter migrated directories (the spec's original enforcement mechanism, now activated
surface-by-surface).

## Phase MA — Apple

Legacy inventory: `DesignTokens.swift`'s `StarView`/`FlagBadge` + `mapleSettingsBackground`;
`LivingSlider.swift` (+ editor control family); `PhoneSettingsView.SettingsMenuRow` (file-private);
per-feature hand-rolled rows across Settings/ServerAdmin; `CloudFolderTreeRow`, grid cell chrome,
`PanoMergeView` form chrome, etc. App imports `MapleUI` already (gallery).

| Wave | Surface                                    | Replaces → With                                                                                                              | Deletes when done                             |
| ---- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| MA1  | Settings + ServerAdmin screens             | Form/row hand-rolls, SettingsMenuRow → MuiListRow/MuiFormField/MuiSettingsSection; actionStateLabel pattern → MuiStatusText  | SettingsMenuRow, per-file row duplicates      |
| MA2  | Shared chrome                              | StarView/FlagBadge → MuiRatingFlags/MuiBadge; banners/toasts → MuiBanner/MuiToast; dialogs → MuiDialog                       | StarView, FlagBadge, ad-hoc banner code       |
| MA3  | Info panel family                          | InfoPanel rows, KeywordChipsRow, RatingFlagsRow → Mui panel compositions                                                     | superseded InfoPanel subviews                 |
| MA4  | Browse (grid, tree, toolbar)               | PhotoThumbnailCell chrome, CloudFolderTreeRow → MuiMediaCell/MuiTreeRow/MuiToolbar (hardened for PhotoKit/cloud data + perf) | superseded chrome views                       |
| MA5  | Editor chrome (HIGH RISK)                  | LivingSlider.swift + control card family → MuiLivingSlider et al., budget-verified via SliderMatrix + UITest goldens         | app LivingSlider + duplicated editor controls |
| MA6  | Legacy-zero sweep + Maple TV adoption pass | TV screens onto MuiPageTV\* compositions where they fit                                                                      | remaining duplicates                          |

All-three-targets rule applies every wave (macOS + iOS builds always; Maple TV whenever a touched
file is in its target).

## Phase MN — Windows

Legacy inventory: `MainWindow.xaml`'s locally-scoped `FloatingPill`/`PillButton` styles (~25 uses)

- ~10 raw `FontIcon`s; `Themes/Styles.xaml`'s `MapleEyebrow`/`MapleRowLabel`/`MapleValueChip`/
  `MapleToolButton`; `Controls/ColorWheelControl`, `CropOverlayControl`, `ToneCurvePlotControl`
  (`MapleIconControl` stays — it backs MuiIcon).

| Wave | Surface               | Replaces → With                                                                                                                                                                          | Deletes when done                                             |
| ---- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| MN1  | MainWindow chrome     | FloatingPill/PillButton uses → MuiButton/MuiActionButton/MuiValueChip; raw FontIcons → MuiIcon; Eyebrow/RowLabel/ValueChip styles → MuiText variants                                     | the two local styles; the four Styles.xaml styles once unused |
| MN2  | Editor surfaces       | ColorWheelControl → MuiColorWheel; CropOverlayControl → MuiCropOverlay(+Toolbar); ToneCurvePlotControl → MuiCurvePlot/MuiToneCurvePanel — wired to the real render pipeline, CI-verified | the three legacy controls                                     |
| MN3  | Settings (greenfield) | Build the app's first Settings surface directly on MuiPageSettings/MuiSettingsSection (the spec's greenfield pilot — nothing to delete)                                                  | —                                                             |
| MN4  | Legacy-zero sweep     | —                                                                                                                                                                                        | Styles.xaml reduced to zero legacy styles or deleted          |

## Sequencing

MW1 first (worst offender, proves the loop), then waves may interleave across platforms —
each platform's waves are internally ordered, but MW/MA/MN advance independently in parallel
worktrees exactly like the build-out. Editor waves (MW5/MA5/MN2) go last on each platform:
highest risk, and by then the mui controls have survived every other surface.

## Exit criteria

- Zero legacy UI components/styles remain (per-platform sweeps green).
- Every migrated surface passes its platform gates + the perf/parity harnesses.
- The enforcement ratchets are on for all migrated directories.
- `docs/unified-component-catalog.md` gains a "Adopted in production" column marking each element
  that now backs a real screen.
