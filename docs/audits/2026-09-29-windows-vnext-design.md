# Windows vNext design delivery

Tracking: #3889; implementation PR #3890; design #3887, inspector #3886,
comparison #3884, visual/performance qualification #3875. Confirmed screenshot regressions: #3892; raster export limitation: #3891.

The baseline source audit used `ea110d622e3e48c35b6f3348f62581fb09e17203`.
The user supplied `Windows-editor.png`, `Windows-browse-list.png`, and the
shared Preview boards from `Maple-vNext-Platforms-Previews`. These references
are not repository assets. Their approximate pixel measurements are recorded
in #3887; they are not universal DIP constraints.

## Implemented behavior

| Area             | Delivery                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browse           | List/detail presentation alongside the existing grid; folder tiles remain above photos. Filename, dimensions when available, format, size and culling state accompany the preview. Editor, Preview and Info/rating use existing navigation; Share offers original files or edited JPEG output.                                                                                                   |
| Navigation       | Sources toggle, folder ancestor menu, search, name/capture/rating sort, and three grid densities. View, sort and density preferences persist. Selection and a visible-item anchor are restored when the presentation changes. Filmstrip traversal uses the same sorted photo collection.                                                                                                         |
| Sort semantics   | Capture ordering falls back to file modified time when capture metadata is absent. Date sections use oldest/newest order when a date sort is selected; name and rating are global, ungrouped sorts. Paths break equal-name ties.                                                                                                                                                                 |
| Preview          | Back, filename, Edit and Info in one floating bar. The pane-header toggle switches expanded metadata rows and a compact left rail. It preserves selection and Info state and does not navigate to Browse. Info starts closed and retains its state for the session.                                                                                                                              |
| Editor           | Photo behind the centered, bounded header and floating left rail; upper-right inspector and labeled tool dock. Light opens first, with Profile above tone controls. Color retains white balance. Lens, Geometry and Brightness remain reachable. Diagnostics are absent from normal chrome.                                                                                                      |
| Header           | Filename/edited status, histogram, true Undo, comparison and Export. Auto/reset/revert remain in the overflow menu. Immediate Undo also captures the pending edit boundary; stale timer callbacks cannot append it after Undo/navigation.                                                                                                                                                        |
| Adjustments      | Native Slider input/RangeValue accessibility with a thin neutral track, default-origin red changed segment and white/red thumb. The value button opens a bounded numeric editor. Existing keyboard, wheel and deferred commit handlers remain attached.                                                                                                                                          |
| Comparison       | Click or B/backslash tap latches; a hold of at least 300 ms peeks. Before is the opening adjustment state, rendered off the UI thread and cached at a 1600px long edge. Current crop/zoom transforms apply to both presentations. Asset/mode changes cancel stale work; a late cloud sidecar invalidates the temporary opening baseline. No live model, undo or XMP mutation is used to compare. |
| Info             | Rating/Clear and Unflagged/Pick/Reject precede capture/file fields. Full paths and long values are selectable and wrap. Standard XMP title, caption, creator, copyright, keywords and location/GPS are projected read-only. Existing authenticated asset-detail API supplies available caption, tags, OCR, named people and location/GPS.                                                        |
| Metadata loading | Selection or closing Info cancels prior hydration. Late results cannot replace the new selection. Local reads are bounded to 4 MiB; XML DTD/entity resolution is disabled. No RAW decoder is started by metadata hydration. Missing sidecar values and unavailable server enrichment have distinct text.                                                                                         |

## Windows adaptive rules

- Below 800 DIPs, Sources and Info use dismissible side overlays. Resizing
  retains the wide-window Sources preference and the selected document.
- The editor header is centered at 720 DIPs, shrinking to preserve 16-DIP side margins. This follows the updated user direction rather than the original full-width mock. The header histogram collapses below 760 DIPs. Undo, Compare, overflow and
  Export remain in the header. Preview filenames truncate inside a bounded bar.
- Inspector, tool dock and filmstrip heights follow available height and scroll.
  Editor controls stay desktop controls at narrow sizes.
- Browse keeps its list/detail composition with a clamped 180–340 DIP list.
  Detail actions scroll horizontally when required; filters/density live in
  Options. Existing grid and inline rename remain available in both presentations.

## Component choices

Filmstrip/media cells, buttons, labels and value grids reuse Maple.UI. Native
Slider is intentionally retained inside `MuiAdjustmentSlider` for its input,
capture, RangeValue automation and deferred commit behavior. Native selectable
TextBlock values support wrapping/copying metadata. NumberBox supplies bounded
numeric input. The existing histogram renderer remains in place; replacing
rendering math is outside this design change. No color pipeline/schema changes
are made.

## Verification and remaining qualification

Local delivery results (2026-09-29): Release build succeeded with 0 errors
and 28 existing warnings; all 1,176 unit tests passed. Both CPU and GPU smoke
runs passed navigation, comparison immutability, visible responsive inspector,
native RangeValue accessibility, Browse selection/sorting, immediate Undo and
shutdown checks. Original fixture SHA-256 remained
`C5B7B3324E55D5DD84693ED9384A6C9B464794AFBDF969E5EB8CC64452F35276`.

Release WinUI builds and the pure Windows suite are run for the delivery. The
suite covers comparison tap/hold/cancellation, stable sort, real-file read-only
XMP projection, absent/invalid XML, and cloud field/route mapping. The app's
`--lifecycle-smoke RAW OUT cpu|gpu` exercises a real HWND, renderer, panel and
shutdown, Preview/Info navigation, comparison immutability, native slider
template/RangeValue support, Browse multi-selection/order, and responsive layout.

The lifecycle harness also resizes the native AppWindow to 1440×900 and
1024×768 physical pixels. `native-window-layout.jsonl` records requested and
actual window dimensions, logical content dimensions and the current XAML
rasterization scale. It checks the centered header's action bounds and document
and active-tool preservation. This supplements the six logical-root layout
cases; it does not simulate another monitor DPI or replace screenshot/Narrator
qualification at 100%, 150% and 200%.

Run `src/windows/scripts/test-window-lifecycle.ps1 -AppPath <built-exe>` to
exercise a specifically named local build through the same GPU, CPU and empty
window checks used by CI. The GPU shutdown probe queues its real present after
the close-save dialog finishes and before the renderer is disposed; queuing it
before the asynchronous save preflight would let that dialog drain the present
and miss the intended shutdown race. Both the app report and runner require a
rejected closing present, a stopped renderer and exactly one panel release.

The initial Browse smoke used only two photos and did not test overflow. After
the user reported broken grid scrolling, a 120-photo real WinUI regression
reproduced a zero vertical scroll range. The grid now explicitly wraps across
rows and enables vertical scrolling. The regression checks grid and list
overflow, scrolling down, reaching the last photo, and returning to the top.
These programmatic checks do not replace mouse-wheel or screenshot review.

The user's subsequent Preview/Editor captures exposed oversized thumbnail
cards and adjustment rows. The correction removes padding from thumbnail-only
media cells, gives the rail a single rounded surface, sizes the editor rail for
complete rows, widens the Preview bar, and compacts adjustment rows to a 22-DIP
value row plus a 24-DIP native slider. The seven primary tools use lighter
labels and corrected icons; Lens and Geometry remain in the editing overflow.
Floating panels now use ThemeShadow rather than strong outlines, comparison
uses the split icon, and histogram layout changes replay the latest real bins.
Release build, all 1,176 unit tests, and GPU lifecycle smoke pass, including
compact slider height, seven primary tools, overflow access and Browse scrolling.
The subsequent hands-on audit worked around capture identity confusion by
building the same project with a diagnostic assembly name. This permits
current-worktree window capture, rather than inspecting the installed app.

## Element audit from live screenshots

The first audit was insufficient: its scrolling fixture was too small and its
layout assertions did not detect a clipped GPU canvas. The following findings
come from the user's four actual captures, the supplied reference boards, a
354-photo library, native accessibility trees, and current-build screenshots.

| Element                           | Evidence and correction                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native menu/title/caption buttons | File/Edit/View/Photo and native window controls retained; platform affordances outside the floating reference chrome.                                                                                                                                                                                                                                    |
| Sources and breadcrumb            | Real source tree and ancestor navigation retained; breadcrumb now initialized from the current folder rather than waiting for another navigation event.                                                                                                                                                                                                  |
| Search/sort/options               | Wide windows use one control row; narrow layouts wrap. Search remains filename/camera/lens filtering; sort/filter/density handlers retained.                                                                                                                                                                                                             |
| Folder tiles                      | Height bounded so numerous child folders cannot consume the photo scrolling viewport.                                                                                                                                                                                                                                                                    |
| Grid scrolling                    | Mouse wheel moved visible rows in the real 354-photo library. Native overflow regression separately covers 120 items, end and return to top.                                                                                                                                                                                                             |
| List/detail initial state         | Toggling into list selects the first item when no selection exists. Persisted startup without selection gives explicit guidance rather than an unexplained blank detail region.                                                                                                                                                                          |
| List rows                         | 66×44 thumbnails, separators, red selection surface/indicator and selected thumbnail outline; accessibility exposes filenames instead of the PhotoItem class name.                                                                                                                                                                                       |
| Browse selection/collapse         | Explicit Select/Done supports checkbox selection; Collapse/Expand preserves detail and photo selection. These controls are separate from Preview navigation.                                                                                                                                                                                             |
| Detail image/summary              | Uniform image fit; real filename, dimensions, format, size and culling state. Example names, ratings and edited timestamps are not fabricated.                                                                                                                                                                                                           |
| Detail commands                   | Editor, Preview and Info use working navigation. Share copies originals to temporary storage or prepares edited JPEGs through the immutable export snapshot/native encoder, then invokes Windows Share. Original-file Share reached the native sheet; edited raster-source output is unsupported (#3891). Export remains in the application menu/editor. |
| Preview top bar                   | Bounded 480-DIP bar, regular filename weight, chevron/back, pencil and Info.                                                                                                                                                                                                                                                                             |
| Preview navigation                | Compact/expanded left strip preserves photo and open Info; verified by live interaction.                                                                                                                                                                                                                                                                 |
| GPU image fit                     | Live Info opening exposed cropping: a native-size swapchain exceeded the smaller viewport. Uniform parent scaling now fits it; crop/mask footprint and 1:1 zoom use the same fitted bounds.                                                                                                                                                              |
| Info metadata                     | Consistent label column, early dimensions, selectable wrapped values. Verbose calibration explanations moved into a working expander.                                                                                                                                                                                                                    |
| Rating and flag                   | Larger star icons; equal-width 44-DIP flag controls use selected tint/outline instead of a solid primary action. Existing persistence commands retained.                                                                                                                                                                                                 |
| Editor header                     | Working histogram observed after decode. Runtime comparison no longer restores text after XAML initializes the split icon.                                                                                                                                                                                                                               |
| Editor filmstrip                  | Height excludes the trailing inter-item gap, preventing a clipped sixth thumbnail in the five-row rail.                                                                                                                                                                                                                                                  |
| Light inspector                   | Profile and six reference tone controls remain visible. Brightness remains reachable via a real slider, reset and bounded numeric editing in overflow.                                                                                                                                                                                                   |
| Tool dock                         | Seven primary groups, 80-DIP width, 52-DIP targets and 24-DIP icons. Tool switching exposed stale icon brush colors; Tool icons and labels now receive the selected/unselected brush explicitly, including after WinUI template realization. Lens and Geometry remain in overflow.                                                                       |
| Other adjustment groups           | Source trace confirms Color Basic/HSL/B&W, Effects Basic/Grade, Detail, Curve, Mask, Crop, Lens and Geometry retain their existing bindings, reset paths and rendering hooks. This is not a claim of visual correspondence to unprovided group mockups.                                                                                                  |
| Keyboard ownership                | Text, numeric, combo and slider focus is excluded from root photo-navigation shortcuts.                                                                                                                                                                                                                                                                  |
| Dialog concurrency                | Numeric edits use the existing shared modal gate to reject duplicate opens. Apply uses Maple styling; Cancel was exercised without changing the photo.                                                                                                                                                                                                   |
| Narrow/minimized window           | Sources/Info widths clamp at zero instead of assigning negative dimensions.                                                                                                                                                                                                                                                                              |
| Async metadata errors             | Cancellation-aware local reads and error reporting prevent malformed server metadata from escaping an async-void handler.                                                                                                                                                                                                                                |
| Comparison buffer                 | Checked dimensions/byte count guard the allocation; opening-state model and sidecar remain immutable.                                                                                                                                                                                                                                                    |

Actual monitor-DPI combinations, Narrator behavior, all cloud/offline permission
combinations and 100MP performance require separate qualification. A screenshot
or passing unit suite does not certify those areas.

Responsive smoke uses root layout sizes 1440×900, 1024×768, 960×600, 683×512,
720×450 and 512×384 DIPs. These approximate the requested physical-size/scaling
combinations, but **are not screenshots or actual monitor-DPI qualification**.
The fixture is a disposable copy of the repository's synthetic DNG. Comparison
checks original and sidecar bytes, model serialization and undo depth.

## Captured evidence and limits

The initial capture-ownership error was resolved by building this worktree with
a unique diagnostic assembly name. The native Windows Computer Use API then
captured and operated that exact executable. Screenshots remain local under
`%TEMP%/maple-full-audit-evidence` because they contain the user's photographs.
They were not uploaded to GitHub.

The reference comparison covers each visible region in the supplied Windows
Browse/Editor mocks and shared Preview layouts: chrome, navigation, row/rail
geometry, image fit, selection, metadata, tool order, typography, values, sliders,
and commands. Current-build captures include Browse list/detail, compact Preview,
expanded Preview with Info, GPU Preview with Info, Light, Color, Effects, scrolled
Detail, Curve, Mask, Crop, Brightness and the native original-file Share sheet.
The editor's rendered photo and histogram were checked after RAW decoding.
Opening tools and cancelling numeric input did not apply adjustments to the
user's photo. The native smoke uses a disposable synthetic DNG for mutations.

This is a substantially broader audit than the original static pass, but not a
claim of pixel-identical rendering or exhaustive functional qualification. The
native menu bar, overflow access to existing tools, real metadata, and desktop
responsive layouts are intentional adaptations. Non-Light tool panels have no
supplied detailed reference art, so they were checked for visibility, scrolling,
existing command bindings and preservation, not claimed as visual matches to
unprovided designs.

Known functional limitation: edited JPEG export from a JPEG source fails in the
existing RAW-only recipe decoder. Original sharing does not substitute for edited
export. #3891 records the reproduction and required shared-core work; no resized
unadjusted image is silently substituted for an edited result. Native Share was
opened without choosing a destination or sending a file. Its separate-window
dismissal proved awkward in automation and the audit instance was restarted;
that is not end-to-end receiver-delivery qualification.

Actual 100/150/200% monitor scaling, full Narrator navigation, cloud/offline and
read-only permission combinations, and 100MP timing remain unqualified under
#3875. Metadata authoring remains #3878. The broad design/feature issues remain
open. GitHub project assignment was unavailable because the current token lacks
`read:project`; the new issues were created without changing account permissions.

Final regression result: the rebuilt diagnostic assembly passed the GPU native
lifecycle run, including the added drawn-icon color assertion. Release build:
0 errors (28 existing warnings). Repeated Windows unit suite: 1,176 passed,
0 failed. The copied synthetic DNG retains its original SHA-256. All changed
non-allowlisted C# files remain below 570 lines; `git diff --check` passes.

The final live check also caught WinUI's default-dialog accent overriding the
numeric Apply style. Dialog-local accent resources now keep its normal, hover
and pressed states in Maple colors. Build 9 was visually checked after that
correction: Light → Color → Light updates the icon/label colors, the decoded
image and histogram render, and numeric Apply is red. Cancel left Exposure at
0.00 EV. Evidence: `editor-color-final.jpg`, `editor-light-final.jpg`, and
`numeric-dialog-final.jpg` in the local evidence directory. The GPU regression
was run on build 8; build 9 adds only the dialog accent resource override.
