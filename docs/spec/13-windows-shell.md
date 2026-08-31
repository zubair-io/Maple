# 13 — Windows Shell Alignment

What the WinUI 3 shell (`src/windows/Maple.WinUI`) must render, derived from
the macOS implementation — `LibrarySidebar.swift`, `BrowseGrid.swift`,
`BrowseViewModel.swift` — and the shell contract in
[`07-ui-architecture.md`](./07-ui-architecture.md). Where this document and
the Mac code disagree, the Mac code wins; fix this document.

The one-sentence version: **Windows is the Mac shell without the
Apple-only sources.** Same sidebar order, same Finder-style browse grid,
same split between browsing (flat, name-sorted, folders inline) and the
Timeline (date-grouped). Nothing in the Windows shell invents a surface the
Mac app doesn't have.

---

## Sidebar

Mac renders, top to bottom (`LibrarySidebar.body`):

| Row / section    | Mac source                | Windows |
| ---------------- | ------------------------- | ------- |
| TIMELINE row     | `timelineRow`             | ✅ same position, first |
| MAP row          | `mapRow`                  | ❌ omitted — no map view on Windows yet |
| MAPLE CLOUD      | `cloudServersSection`     | ✅ folder tree over `/api/fs/dir` |
| FOLDERS          | `foldersSection`          | ✅ local library tree |
| Photos Library   | `photosSection` (PhotoKit)| ❌ omitted — PhotoKit is Apple-only |
| CONNECTIONS      | `connectionsSection` (SMB)| ❌ omitted — no SMB client on Windows yet |

Rules carried over:

- **No LIBRARY section.** The Mac sidebar has no "All Photos / Picks /
  Rejected / 4+ Stars" rows and neither does Windows. Flag and rating
  narrowing are toolbar filters over whatever source is being browsed, not
  sidebar sources. (The Windows toolbar's existing Format / Ratings combos
  stay; they are filters, not navigation.)
- **Sections with nothing connected are omitted entirely** (#2925),
  separators included — an empty section is not an affordance, Settings is
  where sources get registered.
- **A section that exists on Mac but not Windows is omitted, not stubbed.**
  When Windows grows a map view or an SMB client, the row comes back in the
  Mac position.

## Browse mode — the Finder contract

`BrowseGrid.swift` renders one flat grid: "Sub-folders first — Finder-style
— then images." `BrowseViewModel.sortOrder` defaults to `.nameAscending`.
Windows matches:

- **One flat grid per browsed directory.** Subfolder tiles first, then that
  directory's own images, both sorted name-ascending. No date-group
  headers, no sections.
- **Applies identically to local folders and cloud directories.** Local
  browse lists the folder's immediate subdirectories (the same enumeration
  the sidebar tree uses); cloud browse lists the `/api/fs/dir` `dirs[]`.
- **A folder tile navigates on single click** — the grid reloads into that
  directory, exactly as clicking the same node in the sidebar tree.
- **Empty state** appears only when the directory has neither subfolders
  nor images (`vm.assets.isEmpty && vm.subfolders.isEmpty` on Mac).
- **Multi-select is images-only.** Mac hides folder cells while selecting;
  Windows folder tiles are not selectable grid items.

## Timeline — the date-grouped surface

Date grouping (day headers, newest first) is the Timeline's presentation,
not Browse's. On Windows:

- Selecting a TIMELINE node applies its date range and the grid switches to
  date-grouped presentation (day headers, capture order within the day).
- Clearing the timeline filter — or navigating any folder — returns the
  grid to the flat Finder contract above.

## Out of scope, deliberately

- **Merged all-sources timeline** (Mac's `AllSourcesTimelineView`): the
  Windows TIMELINE section currently scopes to the browsed source. Parity
  with the merged view is its own ticket; the sidebar position is already
  correct.
- **Map, PhotoKit, SMB**: see the sidebar table.
