# Fast Preview + Phone Card Editor — Design

**Date:** 2026-07-06
**Status:** Approved for planning
**Platforms:** Web (Angular) and Apple (SwiftUI), built in parallel with pixel/behaviour parity as a merge gate.

## Summary

Insert a fast, lightweight **Preview** surface in front of the full editor, so opening a
photo is near-instant. Today, tapping a photo in the grid drops the user straight into the
heavy canvas editor (live GPU/WASM pipeline, zoom controller, edit session) on both Web and
Apple. This design puts a static-image Preview between the grid and the editor:

```
grid ──tap──▶ Preview (fast, static JPEG) ──Edit──▶ Editor (live pipeline)
   ◀──back──                              ◀──back──
```

Three coordinated changes, all on both platforms:

1. **Preview view** — a new full-screen surface that shows a cached JPEG (never boots the
   edit pipeline), with a **Flag · Edit · Info** bottom bar, a filmstrip, and prev/next image
   navigation (swipe on touch, ←/→ on desktop). It becomes the default target of a grid tap
   on every viewport; the editor is reachable **only** via the Edit button.
2. **Phone editor "CARD" UI** — on phone/compact, replace the chips-in-a-card editor chrome
   with a bottom **tool dock** (icon menu) plus a **flyout slider card** above it that can be
   closed.
3. **Header max-width** — cap the header/filename on both the Preview and Editor surfaces so
   a long filename can never push the header off-screen.

## Goals

- Opening a photo paints something on screen in ~1 frame and never blocks on the RAW pipeline.
- The Preview reflects the photo's current edit state (a photo the user has edited looks
  edited in Preview).
- One consistent navigation model across phone, tablet, and desktop.
- Phone editor matches the `Flyout / dock / slider panel` mockup; Preview matches the
  `Preview / flag / edit / info` mockup.
- No header can overflow its viewport at any filename length.

## Non-goals

- No change to the editor's color pipeline, parity harness, or render math.
- No change to the VLM `preview` stage's embedded 1280 px artifact (the vision model must keep
  seeing the *undeveloped* embedded preview).
- No new masking/optics/heal tools — disabled dock entries stay disabled per existing
  convention (CLAUDE.md #6).
- Zoom/pan inside Preview is out of scope; zoom lives in the editor. Preview is a fit-to-screen
  still.

## Current state (baseline)

**Web** — grid tap / Enter / filmstrip select route via `editRouteCommands` →
`/edit/:slug/**` → `EditorShellComponent` (canvas-first, full-bleed live canvas + chrome).
Phone editor shows only `ControlCardComponent` (group text-chips + `LivingSlider` grid +
grab-handle peek); `ToolDockComponent` is tablet+ only. Editor header `.top-bar` already has
`max-width: calc(100vw - 96px)` and `.top-name` `max-width: 200px`, but the phone case can
still crowd. Self-hosted already serves `GET /api/preview/:slug/*` (1280 px JPEG) and
`GET /api/image/:slug/*` (original bytes). Info surface: `InfoPanelComponent` (bottom sheet on
phone via `insideSheet`, side panel on desktop). Flag surface: `RatingFlagsRowComponent`.

**Apple** — `BrowseGrid` tap fires `onOpenEditor`; iPhone pushes `EditorDestination` →
`EditorView` (S5 canvas-first); Mac/iPad flips `Mode.editing` →`EditorSessionHost` →
`EditorView`. `FullImageView` is a legacy zoom-only viewer (fallback, no controls). Phone
(compact) editor shows only `ControlCard` (group chips + `LivingSliderGrid`); `ToolDock` /
`FilmstripRail` are regular-size-class only. `FlyoutSliderPanel` + `MobileControlBar` exist as
control-variant scaffolding. `EditorHeader` filename is `.lineLimit(1)
.truncationMode(.middle)` with `Spacer(minLength: 0)` on both sides — no max-width. Info/flag:
`InfoPanelView` / `RatingFlagsRow` (iPhone sheet, Mac/iPad right column). Layout: `MapleShellKind`
(phoneTab vs pane, by idiom); `MapleLayout` (phone <768 / tablet ≤1024 / desktop, by width);
`horizontalSizeClass` compact/regular inside `EditorView`. **No swipe/arrow prev-next image
navigation exists on either platform** (arrow keys in the editor switch tool *groups*).

On **both** platforms, opening a photo goes straight to the live editor — there is no preview
step, the phone editor has no bottom tool dock and its card does not collapse, and there is no
prev/next image gesture.

## Design

### 1. Navigation model

Grid tap / Enter / filmstrip select → **Preview**, on every viewport. The editor is entered
only from Preview's **Edit** action (and its keyboard shortcut). Back stack:
`grid → Preview → Editor`; back from Editor returns to Preview, back from Preview returns to
the grid.

**Web** — add route `/view/:slug/**` → new `PreviewShellComponent` (mirrors the
`EditorShellComponent` address-resolution logic verbatim; only the chrome differs). Keep
`/edit/:slug/**` → `EditorShellComponent` unchanged. Add `viewRouteCommands(id)` alongside the
existing `editRouteCommands(id)` in `addressing/route-address.ts`. Repoint grid, filmstrip, and
the browse-shell `Enter` handler to `viewRouteCommands`; the Preview's Edit button uses
`editRouteCommands`. Legacy `/edit` deep links still resolve (a bookmarked editor URL opens the
editor directly).

**Apple** — add `PreviewView` (+ `PreviewView+VM` for pure derivations, per issue #192
convention). iPhone: `BrowseGrid` tap pushes `PreviewView`; Preview's Edit pushes `EditorView`
onto the same `NavigationStack`. Mac/iPad: add `Mode.preview`; `imageOpenMode` resolves to
`.preview` on all idioms; the center column renders `PreviewView`; Edit flips to `.editing`.
Legacy `FullImageView` is untouched (still the fallback zoom viewer).

### 2. What makes Preview fast

**Preview's display path renders a plain cached JPEG. It creates no `EditSession`, mounts no
interactive GPU/CPU canvas, and no zoom controller.** The heavy editing machinery mounts only
on Edit. Load sequence:

1. **Instant:** paint the grid **thumbnail** already in memory (Web: `subscribeThumbUrl`;
   Apple: the thumb the grid cell already holds).
2. **Swap to** the **display preview** (1280 px JPEG) when it resolves (§3).

The swap is a simple crossfade; the thumbnail stays as the backing image if the display
preview is slow, so there is never a blank canvas.

The one exception is the **rare lazy render** of §3: an edited photo whose developed preview is
not yet cached triggers a one-shot, off-screen JPEG render (not an interactive canvas) to
produce the still. "Eager on editor exit" makes this path uncommon, and the thumbnail is shown
the whole time it runs.

### 3. Display-preview data layer

The display preview is a **1280 px JPEG, distinct from the VLM `preview` artifact**. Reusing
1280 px keeps it fast to ship (unedited photos reuse the artifact we already generate + serve);
the editor still provides full resolution on Edit.

- **Unedited photo** → the embedded JPEG (Self-hosted: existing `/api/preview/:slug/*`;
  Hosted-web/Apple: embedded-preview extraction, same path thumbnails use).
- **Edited photo** → a **developed** 1280 px JPEG with the sidecar's adjustments applied,
  cached and keyed on the sidecar/adjustment version.

Regeneration policy: **eager on editor exit, lazy fallback on Preview open.** Leaving the
editor triggers a developed-preview render so the next Preview open is instant; if the cache is
ever cold/stale when Preview opens, render on demand (the thumbnail covers the gap).

Per-backend implementation:

- **Self-hosted (API).** New worker stage `display-preview` via `defineStage` (mirrors
  `preview`/`thumb`; entries in `workers/stages/manifest.ts` `stageManifest` + `ALL_STAGE_NAMES`,
  `orchestrator.ts` `STAGE_STARTERS`, and a `STAGE_META` label in the web `workers.vm.ts`). It
  renders the developed JPEG via FFI **only when a sidecar exists and its version changed**,
  writing `.maple/previews/<maple_id>_dev_<sidecarVer>.jpg`. Its stale-check keys on sidecar
  version, not source mtime (the gap the existing `preview` stage leaves). Serving: extend the
  preview route so that for an edited asset it returns the developed file (falling back to a
  synchronous render if the cache is cold), and for an unedited asset it returns the existing
  embedded preview. Writing a sidecar (editor exit) makes the asset eligible, so the stage
  re-renders without a bespoke trigger button.
- **Hosted-web (no server).** On editor exit, downscale the editor's own refine-phase output to
  1280 px, encode JPEG, and cache in IndexedDB keyed on `(assetId, sidecarVersion)`. Lazy path:
  if Preview opens and no fresh developed preview exists for an edited asset, render one from the
  sidecar via the existing WASM path.
- **Apple.** Same policy, cached to disk (alongside the existing thumbnail/preview disk caches),
  keyed on sidecar version. The native developed output must match Web within the parity budget
  (`docs/testing.md`).

Reuse `sidecar_mtime` / `adjustment_version` — the same keys the rendered-preview cache already
uses (`docs/caching.md`) — as the freshness signal, so no new versioning scheme is introduced.

### 4. Preview view UI

Matches the `Preview / flag / edit / info` mockup.

- **Header** — back · filename · histogram + `…` overflow, subject to §6 max-width.
- **Body** — the fit-to-screen display image (thumbnail → display preview).
- **Filmstrip** — reuse `FilmstripComponent` (Web) / `FilmstripView` (Apple); selecting a thumb
  navigates the preview and updates the strip.
- **Bottom bar — Flag · Edit · Info:**
  - **Flag** → reuse `RatingFlagsRowComponent` / `RatingFlagsRow` (pick/reject + stars) in a
    compact popover (desktop) or sheet (phone).
  - **Edit** → enter the editor for the current asset.
  - **Info** → reuse `InfoPanelComponent` / `InfoPanelView` — bottom sheet on phone, side panel
    on tablet/desktop.
- **Image navigation (new, both platforms):**
  - Touch: horizontal **swipe** left/right → next/previous asset within the current folder.
  - Desktop: **←/→** arrow keys → previous/next. (Existing Browse rating/flag shortcuts —
    `1–5`, `0`, `P`, `X`, `U` — remain available in Preview.)
  - Navigation wraps selection through `assetsInSelectedFolder()` and updates the URL
    (Web `/view/:slug/**`) / navigation state (Apple) so Preview is deep-linkable and the
    filmstrip tracks the current asset.

### 5. Phone editor "CARD" UI

Phone/compact only; tablet/desktop editor chrome is unchanged. Matches the
`Flyout / dock / slider panel` mockup.

- **Bottom horizontal tool dock** (icon menu): Light · Color · Effects · Detail · Curve · Crop
  — mirrors the enabled tablet `ToolDock`/`ToolDock.swift` entries. Disabled tools
  (Optics/Mask/Heal) follow the existing disabled-with-ticket convention or are omitted on
  phone; no fake panels.
- **Flyout slider card above the dock** — shows the active group's `LivingSlider`s. **Closeable:**
  a close/chevron affordance collapses the card to leave just the dock; tapping a dock icon
  reopens it (and switches group). This replaces today's phone group-text-chips-in-card.
- **Web** — reuse `ToolDockComponent` restyled to a horizontal bottom bar for the phone
  breakpoint, and repurpose `ControlCardComponent` as the collapsible flyout (extend its
  existing `full`/`peek` state to a fully-closed state driven by dock taps). Gate on the
  `<768px` breakpoint the shell already computes.
- **Apple** — wire the existing `FlyoutSliderPanel` + a horizontal `ToolDock` + `MobileControlBar`
  on the compact size class inside `EditorView`; the flyout's open/closed state is driven by the
  dock selection.

### 6. Header max-width

Applies to both the Preview and Editor headers, both platforms.

- **Web** — cap the filename at `min(200px, 40vw)` (ellipsis, unchanged truncation) and ensure
  the header pill's `max-width` keeps it within the viewport minus its horizontal insets at the
  phone breakpoint. Same rule in `PreviewShellComponent` and `EditorShellComponent`.
- **Apple** — give the `EditorHeader` filename a `.frame(maxWidth:)` cap plus layout priority so
  it truncates (`.truncationMode(.middle)` retained) instead of pushing the trailing controls
  off-screen; the same header is used by `PreviewView`.

## Decomposition & sequencing

Two tracks built **in parallel, slice by slice, with parity held as a merge gate**. Slices
within a track are ordered; the header fix and phone-card slice do not depend on the preview
data layer.

**Web track**
- W1 — display-preview data layer (self-hosted `display-preview` stage + serve route; Hosted-web
  IndexedDB developed-preview cache).
- W2 — `PreviewShellComponent` + `/view` route + `viewRouteCommands` repointing + Flag/Edit/Info
  bar + filmstrip + swipe/arrow navigation + header max-width.
- W3 — phone card editor (horizontal `ToolDock` + collapsible `ControlCard` flyout).

**Apple track**
- A1 — display-preview disk cache (developed render, sidecar-versioned, parity-gated).
- A2 — `PreviewView` (+VM) + navigation (iPhone push / Mac-iPad `Mode.preview`) + Flag/Edit/Info
  + filmstrip + swipe/arrow navigation + header max-width.
- A3 — phone card editor (`FlyoutSliderPanel` + horizontal `ToolDock` + `MobileControlBar` on
  compact).

Each slice is its own ticket + PR, on the right Project board (Files for the feature work),
with a `Closes #N` line. Parity between the W and A tracks is verified per the harnesses in
`docs/testing.md`.

## Testing

- **Web** — component/behaviour tests for `PreviewShellComponent` (route resolution, thumbnail→
  display-preview swap, Flag/Edit/Info wiring, swipe + arrow navigation) mirroring the existing
  `*-shell.component.spec.ts` pattern; a test that a grid tap now lands on `/view` and Edit lands
  on `/edit`. API integration test for the `display-preview` stage + serve route (developed vs
  embedded selection, sidecar-version freshness) against a real Mongo per
  `docs/` API test conventions; no mocks for the sidecar path.
- **Apple** — `PreviewView+VM` unit tests (no SwiftUI import); a UITest that opening a grid photo
  shows Preview (not the editor) and Edit reaches the editor; parity check that the developed
  display preview matches Web within budget.
- **Parity** — the developed 1280 px preview is diffed Web vs Apple with the CIEDE2000 harness;
  the display-preview data layer must not regress any existing color budget.

## Risks & mitigations

- **Developed-preview parity (Web WASM vs Apple native vs API FFI).** Mitigation: all three
  render through the shared `raw-core` pipeline; gate the developed preview with the existing
  parity harness before merge.
- **Editor-exit render cost on self-hosted.** The `display-preview` stage only runs for assets
  with a sidecar, so unedited libraries incur no new work; the stage inherits pause/resume/backoff
  from the generic worker machinery.
- **Extra hop feels slower for power users who want to edit immediately.** Mitigation: Edit is a
  single tap/shortcut and the editor session can begin warming (decode) as soon as Preview opens
  is a possible follow-up — not in v1 (YAGNI); revisit only if measured.
- **Cache growth from a second 1280 px artifact per edited asset.** Bounded to edited assets and
  keyed on sidecar version (old versions GC'd by the existing cache sweep).
