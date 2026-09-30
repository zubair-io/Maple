# Windows vNext design delivery

Tracking: #3889; implementation PR #3890; design #3887, inspector #3886,
comparison #3884, visual/performance qualification #3875.

The baseline source audit used `ea110d622e3e48c35b6f3348f62581fb09e17203`.
The user supplied `Windows-editor.png`, `Windows-browse-list.png`, and the
shared Preview boards from `Maple-vNext-Platforms-Previews`. These references
are not repository assets. Their approximate pixel measurements are recorded
in #3887; they are not universal DIP constraints.

## Implemented behavior

| Area             | Delivery                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browse           | List/detail presentation alongside the existing grid; folder tiles remain above photos. Filename, dimensions when available, format, size and culling state accompany the preview. Editor, Preview, Info/rating and Export actions use existing commands.                                                                                                                                        |
| Navigation       | Sources toggle, folder ancestor menu, search, name/capture/rating sort, and three grid densities. View, sort and density preferences persist. Selection and a visible-item anchor are restored when the presentation changes. Filmstrip traversal uses the same sorted photo collection.                                                                                                         |
| Sort semantics   | Capture ordering falls back to file modified time when capture metadata is absent. Date sections use oldest/newest order when a date sort is selected; name and rating are global, ungrouped sorts. Paths break equal-name ties.                                                                                                                                                                 |
| Preview          | Back, filename, Edit and Info in one floating bar. The pane-header toggle switches expanded metadata rows and a compact left rail. It preserves selection and Info state and does not navigate to Browse. Info starts closed and retains its state for the session.                                                                                                                              |
| Editor           | Photo behind the full-width header and floating left rail; upper-right inspector and labeled tool dock. Light opens first, with Profile above tone controls. Color retains white balance. Lens, Geometry and Brightness remain reachable. Diagnostics are absent from normal chrome.                                                                                                             |
| Header           | Filename/edited status, histogram, true Undo, comparison and Export. Auto/reset/revert remain in the overflow menu. Immediate Undo also captures the pending edit boundary; stale timer callbacks cannot append it after Undo/navigation.                                                                                                                                                        |
| Adjustments      | Native Slider input/RangeValue accessibility with a thin neutral track, default-origin red changed segment and white/red thumb. The value button opens a bounded numeric editor. Existing keyboard, wheel and deferred commit handlers remain attached.                                                                                                                                          |
| Comparison       | Click or B/backslash tap latches; a hold of at least 300 ms peeks. Before is the opening adjustment state, rendered off the UI thread and cached at a 1600px long edge. Current crop/zoom transforms apply to both presentations. Asset/mode changes cancel stale work; a late cloud sidecar invalidates the temporary opening baseline. No live model, undo or XMP mutation is used to compare. |
| Info             | Rating/Clear and Unflagged/Pick/Reject precede capture/file fields. Full paths and long values are selectable and wrap. Standard XMP title, caption, creator, copyright, keywords and location/GPS are projected read-only. Existing authenticated asset-detail API supplies available caption, tags, OCR, named people and location/GPS.                                                        |
| Metadata loading | Selection or closing Info cancels prior hydration. Late results cannot replace the new selection. Local reads are bounded to 4 MiB; XML DTD/entity resolution is disabled. No RAW decoder is started by metadata hydration. Missing sidecar values and unavailable server enrichment have distinct text.                                                                                         |

## Windows adaptive rules

- Below 800 DIPs, Sources and Info use dismissible side overlays. Resizing
  retains the wide-window Sources preference and the selected document.
- The header histogram collapses below 760 DIPs. Undo, Compare, overflow and
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
Post-change screenshot fidelity is still unverified; the capture helper maps
worktree windows to the installed app and rejects their ownership.

Responsive smoke uses root layout sizes 1440×900, 1024×768, 960×600, 683×512,
720×450 and 512×384 DIPs. These approximate the requested physical-size/scaling
combinations, but **are not screenshots or actual monitor-DPI qualification**.
The fixture is a disposable copy of the repository's synthetic DNG. Comparison
checks original and sidecar bytes, model serialization and undo depth.

The Windows Computer Use helper prevented fixed-state capture of the new build.
After refreshing window selection, it returned:

> window id 985800 no longer belongs to C:\Users\zubai\AppData\Local\Programs\Maple\Maple.WinUI.exe; current owner is C:\Users\zubai\AppData\Local\Programs\Maple\Maple.WinUI.exe

The enumerated HWND was the running worktree build; the helper associated it
with the installed app path and rejected capture. This is a tooling limitation,
not evidence that the new UI matches the mockups. PR #3890 is ready for review
per the repository policy; leave the parent issues open and do not merge until
these remaining gates are fulfilled:

1. Fixed-state current-build Browse, Preview expanded/compact/Info, and Editor
   screenshots at 1024×768 and 1440×900 on actual 100/150/200% DPI; review spacing,
   typography, shadows, focus indicators and OS-accent independence.
2. Live keyboard/pointer/Narrator review, including numeric editing, slider key
   ownership, focus restoration and long metadata. RangeValue support alone is
   not a complete accessibility sign-off.
3. Local, cloud, offline/unindexed and read-only inspector evidence. API mapping
   tests do not qualify a live server or every filesystem permission case.
4. Metadata authoring integration remains owned by #3878; this inspector adds
   no second writer. Performance and 100MP behavior remain under #3875. A small
   synthetic smoke fixture cannot qualify those budgets.

Once capture tooling is working, use the same worktree build and disposable
fixtures for those gates. Do not replace missing evidence with screenshots of
an older installed executable or mark the broad issues complete from unit tests.
