# Windows Maple UI Adoption — Execution Plan (MN2–MN4)

> Run this on a WINDOWS machine. Spec (read first):
> `docs/superpowers/specs/2026-08-27-windows-maple-ui-adoption-spec.md`.
> Repo: github.com/zubair-io/Maple. One PR per wave, sequenced MN2 → MN3 → MN4,
> each rebased on current `main` and green before the next starts. Merges only
> on Zubair's explicit approval.

## Phase 0 — environment (once)

Prerequisites: Windows 10/11 x64, git, .NET 8 SDK, Rust stable with the
`x86_64-pc-windows-msvc` target, VS Build Tools (MSVC + Windows App SDK /
WinUI 3 workloads). CI (`.github/workflows/windows.yml`) is the authority on
the exact commands — mirror it locally:

```powershell
git clone https://github.com/zubair-io/Maple && cd Maple

# Rust native core consumed by the app
cargo build --manifest-path src/windows/Cargo.toml --release

# App build (also what CI's windows-x64 gate runs)
dotnet build src/windows/Maple.WinUI/Maple.WinUI.csproj -c Release -r win-x64

# Unit tests (Logic/Math classes linked via explicit <Compile Include>)
dotnet test src/windows/Maple.WinUI.Tests/Maple.WinUI.Tests.csproj -c Release
```

Launch the built app, open a test image/folder (any RAW you have; repo
fixtures are gitignored and may be absent — the color-parity scripts
skip-pass without them, which is expected). Open the Maple UI gallery with
**Ctrl+Shift+G** and confirm every tier renders. This is your working
baseline — capture screenshots of: the edit rail with an image open, the
Color panel (wheel), Tone Curve panel, Crop mode, and the gallery's
ColorWheel/CurvePlot/CropOverlay pages. Store them locally as the
before-references for Phase 1.

Git hygiene for every wave: branch from `origin/main`
(`git fetch origin main && git switch -c feature/<wave> origin/main`), stage
explicit paths only (never `git add -A`/`git add .`), conventional-commit
messages (`feat(windows): …`), push, open the PR ready-for-review with
`Closes #<ticket>` and the Claude Code footer, then keep it green: rebase +
`git push --force-with-lease` when `main` moves, and address every Copilot/
Jules review thread (reply with the fixing commit, resolve when addressed;
Jules re-reviews each push — fix the whole class of a finding in one pass).

## Phase 1 — MN2: editor controls (ticket #3051, branch `feature/maple-ui-mn2-editor-controls`)

Order the three swaps smallest-blast-radius first; commit each as its own
reviewable commit.

1. **ToneCurvePlot → MuiCurvePlot/MuiToneCurvePanel.**
   - Read `MapleUI/…/MuiCurvePlot*` and `MuiToneCurvePanel*` source fully;
     map `ToneCurvePlotControl`'s public surface (points, channel, change
     events) onto it, extending the Mui control where the app needs more
     (per-channel point sets, point add/remove gestures).
   - `Controls/ToneCurveMath.cs` is shared math — keep one copy (move under
     `MapleUI/` if the Mui control should own it) and update the test
     project's `<Compile Include>` accordingly.
   - Rewire `MainWindow.Panels.cs`/`MainWindow.xaml`; delete
     `ToneCurvePlotControl.cs` once `git grep -n ToneCurvePlotControl src/windows`
     is empty.
2. **ColorWheel → MuiColorWheel.** Same procedure; hue/sat events must feed
   the identical view-model path. `MuiColorWheelMath` is the geometry truth.
3. **CropOverlay → MuiCropOverlay + MuiCropToolbar.** Preserve every gesture
   (handle drag, move, aspect lock, grid display) and the commit flow in
   `MainWindow.Crop.cs`. Extend MuiCropToolbar with a preset-list input if the
   app's aspect presets differ from the control's defaults.

**On-device verification protocol (per control, before → after):**

- With the same image open and the same starting state, perform a scripted
  gesture (e.g. drag the wheel puck to a corner; drag the curve midpoint up;
  drag a crop handle inward) and screenshot the full window.
- The preview must respond LIVE during the drag (not only on release), and
  the after-swap screenshots must match the before-swap references for the
  same gestures — pixel-compare the preview region (any image-diff tool;
  exact tolerance: preview region differences should be nil for identical
  gesture endpoints since the same values reach the same pipeline).
- Also exercise: channel switching on the curve (Luma/R/G/B), reset actions,
  and rapid drag scrubbing (no visible lag regression vs the legacy control —
  the app's slider-tick budget philosophy applies to wheel/curve drags too).
- Record the evidence (before/after screenshot pairs + notes) in the PR body.

Gates before PR: `dotnet build` + `dotnet test` green locally; grep-proof of
deletions in the PR body; gallery still renders (Ctrl+Shift+G smoke).

## Phase 2 — MN3: Settings surface (ticket #3052, branch `feature/maple-ui-mn3-settings`)

1. Inventory real, existing configuration: read `Services/`, `ViewModels/`,
   `Models/`, `Program.cs`, `App.xaml.cs` for persisted state or hardcoded
   values a user should see (server/pairing state, library roots, cache
   directory, app version). List what you found in the PR body — this
   inventory IS part of the deliverable.
2. Build the surface on `MuiPageSettings`/`MuiSettingsSection`/`MuiListRow` +
   form atoms (read their gallery usage for the intended composition). Wire a
   menu entry in the existing MainWindow menu chrome to open it.
3. Only surface settings that already exist in code (spec: no invented
   config). Persist edits through whatever mechanism each setting already
   uses.
4. Verify on-device: open Settings, change a value, restart the app, confirm
   persistence; screenshots in the PR body.

## Phase 3 — MN4: sweep + QR (ticket #3053, branch `feature/maple-ui-mn4-sweep-qr`)

1. Sweep: `git grep -n` for raw `new Button(`, local Style definitions, bare
   `FontIcon` outside the documented MenuFlyoutItem keeps, and any
   `Controls/`-style hand-rolled chrome in dialogs/pano/rename/qualify
   windows. Migrate stragglers onto Mui atoms or document keeps with reasons
   in the PR body.
2. QR: add a small vetted QR NuGet dependency (QRCoder or equivalent),
   generate the module matrix behind a `*Logic`-testable seam, render through
   the existing Mui QR chrome, delete `MuiQrPlaceholder`'s placeholder path,
   and verify by scanning the rendered code with a phone (evidence: photo or
   decoded-payload note in the PR). New dependency = call it out prominently
   in the PR body for review.
3. Final zero-check: `git grep -n "FloatingPill\|PillButton\|MapleEyebrow\|MapleRowLabel\|MapleValueChip\|MapleToolButton\|ColorWheelControl\|CropOverlayControl\|ToneCurvePlotControl" src/windows`
   returns nothing; `MapleIconControl`/`MapleIconShapes` remain (they back
   MuiIcon); build + tests + gallery green.

## Reporting

After each wave: PR link, local build/test output summary, the verification
evidence described above, deletions with grep proof, any Mui extensions made,
anything deferred with reasons. Do not merge — Zubair merges after review.

## Reference index

- Spec: `docs/superpowers/specs/2026-08-27-windows-maple-ui-adoption-spec.md`
- Overall migration plan: `docs/superpowers/plans/2026-08-25-maple-ui-adoption-migration.md`
- Component inventory: `docs/unified-component-catalog.md`
- Atom contracts: `docs/design/maple-ui/components/`
- Windows CI gate: `.github/workflows/windows.yml` (job `windows-x64`)
- Prior-art PRs (patterns to follow): #3013 (library build-out), #3025 (MN1
  chrome adoption), #3040 (extend-don't-fork + ARIA passthrough examples,
  web-side but the same philosophy)
