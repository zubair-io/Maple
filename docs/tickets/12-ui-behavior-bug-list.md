# Ticket 12 — UI / behavior bug list (2026-04-26)

## Status

Open. Filed 2026-04-26. Bug list captured from a single iPad/Mac
session. Each bug is independent; the ticket is a parking lot, not a
dependency tree. Pull items off the top as they get scheduled. Items
9 and 10 carry "review against `../Maple`" notes — the user has a
sibling reference Maple checkout to compare behavior against.

## Bugs

### 1 — iPad detail panel too wide

The right column in the `NavigationSplitView` (DetailPanel) takes
about half the screen on iPad. It should be just wide enough for the
slider rail. Today's `.navigationSplitViewColumnWidth(min: 240, ideal:
280, max: 360)` (`AppShell.swift:177`) is the right max for macOS but
iPad is honoring `ideal` at near-`max`. Tighten the iPad-specific
range or use `.adaptive` widths gated on `userInterfaceIdiom == .pad`.

### 2 — Only contrast slider works (Mac / iPad / Web)

Most sliders — `temperature`, `tint`, `exposure`, `highlights`,
`shadows`, `whites`, `blacks`, `clarity`, `texture`, `vibrance`,
`saturation`, `dehaze`, `sharpen_*`, `nr_*` — produce no visible change
when adjusted. Only `contrast` round-trips the develop chain to the
canvas. Suspect: `processSceneLinear`'s Metal-kernel chain reads a
stale model snapshot, or the WB-delta capture broke the live-vs-decoded
diff. Affects all three platforms, so the bug is in the shared
`ImageEditPipeline` chain (Apple) and the WebGL shader chain (Web)
in parallel — likely a single regression in either model wiring or
the new view-transform's interaction with the kernel inputs.

### 3 — First-open default sharpening

When opening an image with no sidecar, apply `sharpen = 45` and
`sharpen_radius = 5` instead of zeros. Mirrors ACR / Lightroom default
profiles for raw files (a small amount of Richardson-Lucy sharpen at
the lens-blur radius). Touchpoint: `EditSession.loadSidecar()` falls
back to `AdjustmentModel.default` when no sidecar exists; either
override at fall-back time, or change the default model itself if
non-RAW-aware sources won't suffer.

### 4 — Open should land on Develop tab

Double-clicking an image in Browse opens the editor on the Info tab
(see `DetailPanel`'s default selection). Should switch to Develop
when entering Full-image mode. Bind the tab-state to a `@State` that
flips on `mode = .fullImage` transition.

### 5 — Back-to-Browse should land on Info tab

Symmetric to #4. When returning from Full-image to Browse (back
button / ⌘B / Esc), the right-pane tab should flip to Info so the
user sees per-image metadata while culling. Today it stays on whatever
the user last selected (often Develop, which is irrelevant in browse).

### 6 — Info tab missing metadata

Currently shows only basic fields. Should include: pixel resolution,
date taken, camera make/model, lens, focal length, aperture, shutter,
ISO, GPS if present, white-balance reading, file size, file path, and
any other EXIF the file carries. Source: `ImageMetadataReader`
already parses some of this (it reads `as_shot` WB); extend to a full
EXIF dump. The `CGImageSourceCopyPropertiesAtIndex` call already
returns the property dictionary — surface it as a list view in the
Info tab.

### 7 — Single-click vs double-click for folders in Browse

Folder cells currently navigate on a single tap (`onTapGesture` at
`BrowseGrid.swift:54`). Image cells navigate on double-tap. Make
folders match images — single click selects/highlights, double-click
navigates. Consistent with macOS Finder behavior.

### 8 — Hide Develop tab on Browse

When the user is in Browse mode (no image selected, or selected but
not opened in the full-image editor), the Develop tab should be
hidden in the DetailPanel. Today both Info and Develop are always
visible.

### 9 — PhotoKit library doesn't work

Selecting "All Photos" / "Favorites" / etc. in the library sidebar
fails to load assets. The expected path goes through
`PhotoKitSource` → `PHFetchResult<PHAsset>` → asset list. **Review
against `../Maple`** for the working version of this code path; a
recent refactor likely broke the picker / authorization handshake.
Adjacent open work: Ticket 10 item J (sourceless metadata fallback)
will need to land alongside this so PhotoKit assets actually paint
once they DO load.

### 10 — SMB browse fails after connect

User can connect to a Self-Hosted SMB share (credentials authenticate),
but the asset list doesn't populate — folder browsing inside the share
returns nothing. **Review against `../Maple`**. Suspect: the
`AMSMB2`-backed listing call is gated on something that doesn't fire,
or the share's root path isn't being resolved into a session.

## Cross-links

- Ticket 09 (color harness)
- Ticket 10 items I, J (CanvasMath, PhotoKit metadata) — adjacent
- Ticket 11 (deep-zoom tile color parity, behind a flag)
- `../Maple` reference repo for items 9 and 10
