# Preview entry on Web, and a docked Info pane at tablet+

Date: 2026-07-30

Two independent changes to how a photo is opened and how its metadata is shown, bringing the Web
grid in line with Apple's tap-to-open model and giving both platforms a real docked Info pane in
the Preview surface at tablet width and above.

## Problem

Clicking a thumbnail in the Web grid only selects it. Opening the photo requires a double-click,
which no other Maple surface asks for — on Apple a single tap on a grid cell goes straight to
Preview (`BrowseGrid.swift`, the `onTap` handler, which calls `onOpenEditor` and lands in
`AppShell+FolderActions.openEditor`). A user moving between the Mac app and the browser learns two
different gestures for the same intent.

Separately, the Preview surface shows metadata differently on each platform. Web already docks a
right-hand pane at tablet+ (`preview-shell.component.html`, the `isTabletPlus()` branch), but it is
absolutely positioned and floats over the right edge of the photo, and it starts closed every time.
Apple's Preview at the regular size class shows Info as a floating 320×480 popover anchored to the
action bar (`PreviewView.swift`, `InfoPresentation`) — despite the comment describing it as a side
panel, it is not one, and it covers the image it is describing. The editor already has the pattern
this should follow: `AppShellMacLayout` presents `DetailPanel` through `.inspector` with
`.inspectorColumnWidth(min: 240, ideal: 280, max: 360)`.

## Part 1 — Web: a single click opens Preview

### Click semantics

The grid keeps one navigating gesture and two selecting ones. A plain click selects the asset and
navigates to its `/view/…` route. A Cmd/Ctrl-click toggles that asset in the selection and does not
navigate. A Shift-click extends the range and does not navigate. While Select mode (below) is
active, every click toggles the checkbox and none of them navigate.

Both grid surfaces change together, so Folder mode and Timeline mode behave identically:
`AssetGridComponent.onThumbClick` and the `photoClick` handler in `TimelineViewComponent`. The
underlying `LibraryStateService.selectAsset(id, additive, range)` already takes the additive and
range flags, so only the branch that decides whether to navigate is new.

Double-click-to-open goes away. With a plain click navigating, the component is torn down before a
second click can land, so `onThumbDblClick`, the `photoDblClick` output on `timeline-month`, and the
`(dblclick)` binding on `asset-thumb` become dead paths and are removed rather than left as
misleading no-ops. Apple has no double-click-to-open either, so nothing is lost in parity terms.

### Select mode

Removing plain-click selection would leave a keyboard-less tablet with no way to build a selection
for the batch-metadata, pano-merge and copy/paste-settings actions. Apple solves this with an
explicit selecting mode (`BrowseVM.isSelecting`, which flips `BrowseGrid` into checkbox behaviour),
and Web gets the same affordance.

A `Select` toggle joins the existing action pills in `app-toolbar-actions`, so it is present in both
Folder and Timeline mode and collapses into the kebab menu below the desktop breakpoint exactly as
the other pills do. The mode lives as a signal on `LibraryStateService` — session state, not a
stored preference, matching Apple, where `isSelecting` is view-model state.

While the mode is on, each tile renders a check affordance (`asset-thumb` already owns the
`selected` class and a badge slot in the same corner as the edited badge) and clicks toggle
membership. Escape exits the mode. Leaving the mode keeps whatever was selected, because the action
pills are enabled off `selectedCount()` and clearing on exit would make the mode useless for the
thing it exists to serve.

## Part 2 — A docked Info pane at tablet+

### Apple

`InfoPresentation`'s regular branch stops using `.popover` and uses `.inspector(isPresented:)` with
`.inspectorColumnWidth(min: 240, ideal: 280, max: 360)` — the same modifier and the same clamps
`AppShellMacLayout` already applies to the editor's `DetailPanel`, so Preview's pane and the
editor's pane are visually one thing. The panel content stays `InfoPanelView` with
`isInsideSheet: false`. The compact branch keeps its `.sheet` with `[.medium, .large]` detents
unchanged; a docked column has no meaning on an iPhone.

The environment re-injection that modifier already performs for `cloudAssetDetailClient` and
`cloudHistogramClient` stays. An inspector's content is part of the view tree rather than a separate
presentation, so it would inherit those values anyway, but keeping the explicit injection costs
nothing and means the compact and regular branches do not diverge in a way a later reader has to
re-derive.

### Web

`.preview-shell` becomes a flex row: a `.preview-main` child that takes the remaining width and a
`.info-pane` sibling with a fixed `min(340px, 30vw)` width and `flex-shrink: 0`. The pane loses its
absolute positioning, so the photo occupies only the space beside it.

The consequence to get right is that `.top-bar`, `.preview-image-wrap`, `.filmstrip-anchor` and
`.action-bar` are all absolutely positioned against `.preview-shell` today. They move inside
`.preview-main`, which becomes the new positioning context, so the floating header and action bar
centre over the visible photo rather than over the full window with a pane on top of their right
half. The phone branch is unaffected: below the tablet breakpoint Info still renders in
`<app-bottom-sheet>` and `.preview-main` is simply the whole shell.

### Persisted open state

The pane's open state persists under the key `cm.preview.infoOpen`, defaulting to open, via
`@AppStorage` on Apple and `TypedStorage` with a new `STORAGE_KEYS.PREVIEW_INFO_OPEN` entry on Web.

The preference is read and written only at tablet+. The phone bottom sheet keeps its own
always-starts-closed state, because a sheet covering the photo on every Preview open would be the
wrong default for the surface whose whole purpose is showing the photo. On Web this means the
`infoOpen` signal initialises from the stored value when `isTabletPlus()` and from `false`
otherwise, and the toggle writes through only in the former case. On Apple the regular branch binds
to the `@AppStorage` property while the compact sheet keeps its existing `@State`.

The Info button in both action bars becomes a toggle rather than a one-way open, reflecting its
state through `aria-pressed` on Web and an active tint on Apple.

### Session priming on Apple

Apple's Preview deliberately never creates an `EditSession` during `body`; it primes one in the Info
button's tap handler (`ensureFlagSession`) so that merely looking at a photo costs nothing. With the
pane open by default, nobody taps that button, and the pane would render against a `nil` session —
visibly empty on first open.

Priming therefore moves to a task attached to the view that runs when the pane is open, and re-runs
on `asset.id` change while it stays open. That keeps the write out of `body` — the hazard the
existing comments call out — while preserving the original intent: a closed pane still primes
nothing, so a user who turns the pane off pays exactly what they pay today. The existing
`onChange(of: asset.id)` handler that drops `flagInfoSession` stays as the invalidation half of the
same mechanism.

## Testing

Web unit tests cover the click matrix in `asset-grid.component.spec.ts` and the timeline equivalent:
a plain click navigates and a Cmd-click and a Shift-click each mutate selection without navigating,
asserted against a spy router. Select mode gets its own cases — a click toggles rather than
navigates while on, selection survives turning the mode off, Escape exits.

`preview-shell.component.spec.ts` gains cases for the pane defaulting to open at tablet+, honouring
a stored `false`, ignoring the stored value at phone width, and still rendering the bottom sheet
there.

On Apple the presentation branch is view code, so the testable seam is the decision itself: whether
the pane should be open for a given size class and stored preference, and whether a session needs
priming. That predicate moves into `PreviewViewVM` alongside the existing `nextID`/`thumbnailSource`
helpers and is covered in `PreviewViewVMTests`. Both changes are UI-only and touch no pipeline
stage, so no color-parity gate applies.

## Out of scope

The editor's own Info panel and the three-column `DetailPanel` are unchanged, as is all phone
behaviour on both platforms. The Preview surface remains render-free — no canvas, no pipeline — on
both platforms; nothing here introduces a decode.

## Delivery

The two parts share no code and ship as two tickets and two pull requests.
