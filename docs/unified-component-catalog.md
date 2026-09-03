# Unified Component Catalog

Maple UI is one design system implemented three times: as Angular components in `src/web/projects/maple-common/src/lib/ui/`, as SwiftUI views in `src/apple/Packages/MapleUI/Sources/MapleUI/`, and as WinUI controls in `src/windows/Maple.WinUI/MapleUI/`. Every element appears once here, under a design name, grouped by **what it is** rather than which product it came from. The three implementations are near-identical in coverage: 166 elements are implemented somewhere and 165 of those exist on all three platforms, so the useful content of this page is the inventory plus the two gaps (§ Gaps).

Elements are grouped in dependency order: **atoms** depend on nothing, **molecules L1** are built only from atoms, **molecules L2** add earlier molecules, **templates** are regions with no content, **organisms** are built from molecules, and **pages** are a template plus organisms. The directory layout on all three platforms mirrors those tiers, and so do the gallery apps.

Colour, spacing, radius, and type tokens are not authored per platform. They live in `src/raw-pipeline/raw-core/src/ui_tokens.rs` and `tools/codegen.sh` emits them to SCSS, TypeScript, two Swift copies, and `src/windows/Maple.WinUI/Themes/Tokens.xaml`; the `codegen-drift` job in `.github/workflows/cross.yml` fails on any divergence.

---

## Contracts

Twenty-five components have a written behavioural contract under `docs/design/maple-ui/components/` — every atom, plus List Row and Select. Each contract states the tier and then the sections `tools/check-maple-ui-contracts.sh` requires: **Purpose**, **Variants**, **States**, **Tokens used**, **Props**, **Accessibility**. A missing or empty section fails the `maple-ui-contracts` job in `.github/workflows/cross.yml` (which also runs the checker's own self-test, `tools/check-maple-ui-contracts.test.sh`).

```bash
bash tools/check-maple-ui-contracts.sh
```

The contract is authoritative over this catalog when the two disagree. `mui-button.component.ts` documents one such case in a header comment: the catalog historically listed five button variants, the contract defines four (its "secondary" already reads as an outlined button), and the implementation follows the contract.

Contracts are also served to readers. `src/web/scripts/sync-maple-ui-docs.mjs` copies them into `maple-syrup`'s public assets — as a gitignored build artifact, refreshed by the `prestart:syrup` / `prebuild:syrup` hooks — where `MapleUiDocsService` fetches them and renders them beside the live components.

## Galleries

Each platform ships a developer-facing specimen gallery that renders every tier:

| Platform | Where                                                                         | How to open                                |
| -------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| Web      | `src/web/projects/maple-syrup/src/app/maple-ui-page/`                         | route `/maple-ui` in the `maple-syrup` app |
| Apple    | `src/apple/Packages/MapleUI/Sources/MapleUI/Gallery/MapleUIGalleryView.swift` | the "Maple UI" tab in Settings             |
| Windows  | `src/windows/Maple.WinUI/MapleUI/Gallery/MuiGalleryWindow.*`                  | Ctrl+Shift+G from the main window          |

These are design tools, not product surfaces.

## Gaps

Only two rows in the whole catalog are not implemented everywhere.

- **Toggle** — an atom, contract written, implemented only on Apple (`Atoms/MuiToggle.swift`). No `mui-toggle` component on web and no `MuiToggle.cs` on Windows. The contract draws the line against Checkbox precisely: Toggle is for a preference that takes effect the instant it flips; a control whose change waits for a separate Save is a Checkbox.
- **Select** — an atom with a written contract and no implementation on any platform. The contract describes a single-choice dropdown for short, fixed option sets, distinct from the searchable Command Menu molecule.

Web additionally carries five internal sub-components that the other platforms fold into their parent: `mui-export-options-fields`, `mui-kanban-card-tile`, `mui-rating-flags-display`, `mui-rating-flags-selector`, and `mui-tree-row-chevron`. They are implementation detail, not catalog entries.

## Tests

Coverage exists on all three platforms but tests different things. Web has 170 spec files under `lib/ui/` running in `ng test`. Apple has 97 test files in `src/apple/Packages/MapleUI/Tests/MapleUITests/`. Windows has 93 in `src/windows/Maple.WinUI.Tests/`, run by `dotnet test` in `.github/workflows/windows.yml` — and note the shape: because a WinUI control can't be exercised headlessly, the Windows implementation splits pure logic into sibling `*Math`, `*Logic`, and `*Reducer` files (`MuiSliderMath.cs`, `MuiInlineEditLogic.cs`, `MuiBrowsePageReducer.cs`) and the tests target those. Apple uses the same trick for its geometry helpers under `Internal/`.

---

## 1. Atoms

Nothing depends on anything else. Every atom has a contract.

| Component        | Web | Apple | Windows | Contract                                                              |
| ---------------- | :-: | :---: | :-----: | --------------------------------------------------------------------- |
| Action Button    |  ✓  |   ✓   |    ✓    | [action-button.md](design/maple-ui/components/action-button.md)       |
| Avatar           |  ✓  |   ✓   |    ✓    | [avatar.md](design/maple-ui/components/avatar.md)                     |
| Badge            |  ✓  |   ✓   |    ✓    | [badge.md](design/maple-ui/components/badge.md)                       |
| Button           |  ✓  |   ✓   |    ✓    | [button.md](design/maple-ui/components/button.md)                     |
| Canvas Surface   |  ✓  |   ✓   |    ✓    | [canvas-surface.md](design/maple-ui/components/canvas-surface.md)     |
| Checkbox         |  ✓  |   ✓   |    ✓    | [checkbox.md](design/maple-ui/components/checkbox.md)                 |
| Divider          |  ✓  |   ✓   |    ✓    | [divider.md](design/maple-ui/components/divider.md)                   |
| Icon             |  ✓  |   ✓   |    ✓    | [icon.md](design/maple-ui/components/icon.md)                         |
| Image            |  ✓  |   ✓   |    ✓    | [image.md](design/maple-ui/components/image.md)                       |
| Input            |  ✓  |   ✓   |    ✓    | [input.md](design/maple-ui/components/input.md)                       |
| Link             |  ✓  |   ✓   |    ✓    | [link.md](design/maple-ui/components/link.md)                         |
| List             |  ✓  |   ✓   |    ✓    | [list.md](design/maple-ui/components/list.md)                         |
| Progress         |  ✓  |   ✓   |    ✓    | [progress.md](design/maple-ui/components/progress.md)                 |
| QR Code          |  ✓  |   ✓   |    ✓    | [qr-code.md](design/maple-ui/components/qr-code.md)                   |
| Remote Image     |  ✓  |   ✓   |    ✓    | [remote-image.md](design/maple-ui/components/remote-image.md)         |
| Segmented Toggle |  ✓  |   ✓   |    ✓    | [segmented-toggle.md](design/maple-ui/components/segmented-toggle.md) |
| Select           |  —  |   —   |    —    | [select.md](design/maple-ui/components/select.md)                     |
| Spinner          |  ✓  |   ✓   |    ✓    | [spinner.md](design/maple-ui/components/spinner.md)                   |
| Stat             |  ✓  |   ✓   |    ✓    | [stat.md](design/maple-ui/components/stat.md)                         |
| Status Text      |  ✓  |   ✓   |    ✓    | [status-text.md](design/maple-ui/components/status-text.md)           |
| Text             |  ✓  |   ✓   |    ✓    | [text.md](design/maple-ui/components/text.md)                         |
| Timestamp        |  ✓  |   ✓   |    ✓    | [timestamp.md](design/maple-ui/components/timestamp.md)               |
| Toast            |  ✓  |   ✓   |    ✓    | [toast.md](design/maple-ui/components/toast.md)                       |
| Toggle           |  —  |   ✓   |    —    | [toggle.md](design/maple-ui/components/toggle.md)                     |

23 implemented (Apple), 22 on web and Windows; 24 contracted.

## 2. Molecules — Level 1

Built only from atoms. Web: `lib/ui/<name>/`, re-exported through `molecules1-lane-a.ts` and `molecules1-lane-b.ts`. Apple: `Molecules/`. Windows: `MapleUI/Molecules/`.

| Component           | Web | Apple | Windows | Contract                                              |
| ------------------- | :-: | :---: | :-----: | ----------------------------------------------------- |
| 2-D Pad             |  ✓  |   ✓   |    ✓    | —                                                     |
| Audio Player        |  ✓  |   ✓   |    ✓    | —                                                     |
| Avatar Group        |  ✓  |   ✓   |    ✓    | —                                                     |
| Banner              |  ✓  |   ✓   |    ✓    | —                                                     |
| Bubble Menu         |  ✓  |   ✓   |    ✓    | —                                                     |
| Chip Row            |  ✓  |   ✓   |    ✓    | —                                                     |
| Code Block          |  ✓  |   ✓   |    ✓    | —                                                     |
| Collapsible         |  ✓  |   ✓   |    ✓    | —                                                     |
| Color Wheel         |  ✓  |   ✓   |    ✓    | —                                                     |
| Command Menu        |  ✓  |   ✓   |    ✓    | —                                                     |
| Connection Graph    |  ✓  |   ✓   |    ✓    | —                                                     |
| Context Menu        |  ✓  |   ✓   |    ✓    | —                                                     |
| Curve Plot          |  ✓  |   ✓   |    ✓    | —                                                     |
| Drag Bar            |  ✓  |   ✓   |    ✓    | —                                                     |
| Drag Preview        |  ✓  |   ✓   |    ✓    | —                                                     |
| Empty State         |  ✓  |   ✓   |    ✓    | —                                                     |
| Form Field          |  ✓  |   ✓   |    ✓    | —                                                     |
| Frame-time HUD      |  ✓  |   ✓   |    ✓    | —                                                     |
| Heatmap Layer       |  ✓  |   ✓   |    ✓    | —                                                     |
| Histogram           |  ✓  |   ✓   |    ✓    | —                                                     |
| Inline Rename Field |  ✓  |   ✓   |    ✓    | —                                                     |
| Label-Value Grid    |  ✓  |   ✓   |    ✓    | —                                                     |
| List Row            |  ✓  |   ✓   |    ✓    | [list-row.md](design/maple-ui/components/list-row.md) |
| Living Slider       |  ✓  |   ✓   |    ✓    | —                                                     |
| Map Annotation      |  ✓  |   ✓   |    ✓    | —                                                     |
| Page Header         |  ✓  |   ✓   |    ✓    | —                                                     |
| Parade              |  ✓  |   ✓   |    ✓    | —                                                     |
| Popover             |  ✓  |   ✓   |    ✓    | —                                                     |
| Preview Image       |  ✓  |   ✓   |    ✓    | —                                                     |
| Rating & Flags      |  ✓  |   ✓   |    ✓    | —                                                     |
| Search Bar          |  ✓  |   ✓   |    ✓    | —                                                     |
| Slider              |  ✓  |   ✓   |    ✓    | —                                                     |
| Suggestion Menu     |  ✓  |   ✓   |    ✓    | —                                                     |
| Tabs                |  ✓  |   ✓   |    ✓    | —                                                     |
| Toast Container     |  ✓  |   ✓   |    ✓    | —                                                     |
| Toolbar             |  ✓  |   ✓   |    ✓    | —                                                     |
| Tree Row            |  ✓  |   ✓   |    ✓    | —                                                     |
| Value Chip          |  ✓  |   ✓   |    ✓    | —                                                     |
| Value HUD           |  ✓  |   ✓   |    ✓    | —                                                     |
| Vectorscope         |  ✓  |   ✓   |    ✓    | —                                                     |
| Video Player        |  ✓  |   ✓   |    ✓    | —                                                     |
| Waveform            |  ✓  |   ✓   |    ✓    | —                                                     |

42 elements, complete on all three platforms.

## 3. Molecules — Level 2

Atoms plus Level 1 molecules. Apple: `MoleculesL2/`. Windows: `MapleUI/MoleculesL2/`.

| Component          | Web | Apple | Windows | Contract |
| ------------------ | :-: | :---: | :-----: | -------- |
| Bot Output         |  ✓  |   ✓   |    ✓    | —        |
| Card               |  ✓  |   ✓   |    ✓    | —        |
| Chat Message       |  ✓  |   ✓   |    ✓    | —        |
| Description Field  |  ✓  |   ✓   |    ✓    | —        |
| Dialog             |  ✓  |   ✓   |    ✓    | —        |
| Embed Shell        |  ✓  |   ✓   |    ✓    | —        |
| Endpoint Form      |  ✓  |   ✓   |    ✓    | —        |
| Event Popover      |  ✓  |   ✓   |    ✓    | —        |
| Faces Row          |  ✓  |   ✓   |    ✓    | —        |
| Filmstrip Rail     |  ✓  |   ✓   |    ✓    | —        |
| Filmstrip Row      |  ✓  |   ✓   |    ✓    | —        |
| Keyword Row        |  ✓  |   ✓   |    ✓    | —        |
| Media Cell         |  ✓  |   ✓   |    ✓    | —        |
| Place Row          |  ✓  |   ✓   |    ✓    | —        |
| Preview List       |  ✓  |   ✓   |    ✓    | —        |
| Progress Step      |  ✓  |   ✓   |    ✓    | —        |
| QR Scanner         |  ✓  |   ✓   |    ✓    | —        |
| Response Viewer    |  ✓  |   ✓   |    ✓    | —        |
| Settings Row       |  ✓  |   ✓   |    ✓    | —        |
| Suggestion Preview |  ✓  |   ✓   |    ✓    | —        |
| To-do Popover      |  ✓  |   ✓   |    ✓    | —        |
| Transcript Block   |  ✓  |   ✓   |    ✓    | —        |
| Typing Indicator   |  ✓  |   ✓   |    ✓    | —        |
| Vision Row         |  ✓  |   ✓   |    ✓    | —        |

24 elements, complete on all three platforms. 66 molecules in total.

## 4. Templates

Regions only, no content. Apple: `Templates/`. Windows: `MapleUI/Templates/`. Every modal organism sits on Overlay Shell, so templates are built before organisms.

| Component      | Regions                        | Web | Apple | Windows |
| -------------- | ------------------------------ | :-: | :---: | :-----: |
| App Shell      | navigation · content · overlay |  ✓  |   ✓   |    ✓    |
| Drawer Shell   | scrim · panel                  |  ✓  |   ✓   |    ✓    |
| Overlay Shell  | scrim · header · body · footer |  ✓  |   ✓   |    ✓    |
| Settings Shell | section nav · pane             |  ✓  |   ✓   |    ✓    |
| Sheet Shell    | scrim · grab handle · body     |  ✓  |   ✓   |    ✓    |
| Split Layout   | sidebar · center · detail      |  ✓  |   ✓   |    ✓    |
| Tab Shell      | tab bar · content              |  ✓  |   ✓   |    ✓    |

## 5. Organisms

Built from molecules. Apple splits these across `Organisms/` and `OrganismsB/`; web across `organisms-lane-a.ts` and `organisms-lane-b.ts`; Windows keeps one `MapleUI/Organisms/` directory.

| Component              | Web | Apple | Windows |
| ---------------------- | :-: | :---: | :-----: |
| Add Server Modal       |  ✓  |   ✓   |    ✓    |
| Adjustments Panel      |  ✓  |   ✓   |    ✓    |
| Backlinks Panel        |  ✓  |   ✓   |    ✓    |
| Backup Monitor         |  ✓  |   ✓   |    ✓    |
| Batch Metadata Modal   |  ✓  |   ✓   |    ✓    |
| Batch Rename Modal     |  ✓  |   ✓   |    ✓    |
| Card Detail Modal      |  ✓  |   ✓   |    ✓    |
| Chat                   |  ✓  |   ✓   |    ✓    |
| Collection Grid        |  ✓  |   ✓   |    ✓    |
| Color Grading Panel    |  ✓  |   ✓   |    ✓    |
| Control Surface        |  ✓  |   ✓   |    ✓    |
| Crop Overlay           |  ✓  |   ✓   |    ✓    |
| Crop Toolbar           |  ✓  |   ✓   |    ✓    |
| Device List            |  ✓  |   ✓   |    ✓    |
| Diagnostics            |  ✓  |   ✓   |    ✓    |
| Enrichment Panel       |  ✓  |   ✓   |    ✓    |
| Export Modal           |  ✓  |   ✓   |    ✓    |
| Film Panel             |  ✓  |   ✓   |    ✓    |
| Filmstrip              |  ✓  |   ✓   |    ✓    |
| Filter Panel           |  ✓  |   ✓   |    ✓    |
| HSL Panel              |  ✓  |   ✓   |    ✓    |
| Image Canvas           |  ✓  |   ✓   |    ✓    |
| Info Panel             |  ✓  |   ✓   |    ✓    |
| Inspector Panel        |  ✓  |   ✓   |    ✓    |
| Kanban Board           |  ✓  |   ✓   |    ✓    |
| Library Picker Modal   |  ✓  |   ✓   |    ✓    |
| List View              |  ✓  |   ✓   |    ✓    |
| Map Surface            |  ✓  |   ✓   |    ✓    |
| Mask Overlay           |  ✓  |   —   |    —    |
| Mask Panel             |  ✓  |   —   |    —    |
| Mobile Control Bar     |  ✓  |   ✓   |    ✓    |
| Move To Modal          |  ✓  |   ✓   |    ✓    |
| Notification Feed      |  ✓  |   ✓   |    ✓    |
| Pair Device Modal      |  ✓  |   ✓   |    ✓    |
| Panorama Merge Modal   |  ✓  |   ✓   |    ✓    |
| Pipeline Monitor       |  ✓  |   ✓   |    ✓    |
| Presets Panel          |  ✓  |   ✓   |    ✓    |
| Preview Surface        |  ✓  |   ✓   |    ✓    |
| Result Report Modal    |  ✓  |   ✓   |    ✓    |
| Rich Text Editor       |  ✓  |   ✓   |    ✓    |
| Scopes Panel           |  ✓  |   ✓   |    ✓    |
| Search                 |  ✓  |   ✓   |    ✓    |
| Search Results         |  ✓  |   ✓   |    ✓    |
| Selective Paste Modal  |  ✓  |   ✓   |    ✓    |
| Settings Section       |  ✓  |   ✓   |    ✓    |
| Setup Wizard           |  ✓  |   ✓   |    ✓    |
| Share Modal            |  ✓  |   ✓   |    ✓    |
| Sidebar                |  ✓  |   ✓   |    ✓    |
| Structured Data Editor |  ✓  |   ✓   |    ✓    |
| Template Gallery Modal |  ✓  |   ✓   |    ✓    |
| Thread Panel           |  ✓  |   ✓   |    ✓    |
| Timeline               |  ✓  |   ✓   |    ✓    |
| Tone Curve Panel       |  ✓  |   ✓   |    ✓    |
| Tool Dock              |  ✓  |   ✓   |    ✓    |
| User Management        |  ✓  |   ✓   |    ✓    |
| Version History Panel  |  ✓  |   ✓   |    ✓    |
| Whiteboard Canvas      |  ✓  |   ✓   |    ✓    |

57 elements; 55 complete on all three platforms. Mask Overlay and Mask Panel (the local-adjustment surfaces, `docs/design/maple-ui/components/mask-overlay.md` / `mask-panel.md`) shipped on the web first (#1541); the Apple twins land with #3291 (#3275) and Windows has no masking UI in M3 (`docs/strategy/milestones/m3-local-adjustments.md` § 7).

## 6. Pages

A template plus organisms. Apple: `Pages/MuiPage*.swift`. Windows: `MapleUI/Pages/MuiPage*.cs`, each paired with a pure `Mui*PageReducer.cs` that holds the page's state transitions so they can be unit-tested. Web: `lib/ui/pages/<name>/`.

| Page          | Web | Apple | Windows |
| ------------- | :-: | :---: | :-----: |
| Admin         |  ✓  |   ✓   |    ✓    |
| Board         |  ✓  |   ✓   |    ✓    |
| Browse        |  ✓  |   ✓   |    ✓    |
| Chat          |  ✓  |   ✓   |    ✓    |
| Document      |  ✓  |   ✓   |    ✓    |
| Editor        |  ✓  |   ✓   |    ✓    |
| Notifications |  ✓  |   ✓   |    ✓    |
| Pairing       |  ✓  |   ✓   |    ✓    |
| Preview       |  ✓  |   ✓   |    ✓    |
| Search        |  ✓  |   ✓   |    ✓    |
| Settings      |  ✓  |   ✓   |    ✓    |
| Sign In       |  ✓  |   ✓   |    ✓    |
| TV Map        |  ✓  |   ✓   |    ✓    |
| TV Timeline   |  ✓  |   ✓   |    ✓    |
| TV Viewer     |  ✓  |   ✓   |    ✓    |

15 page types, complete on all three platforms.

---

## Totals

| Tier         |     Web |   Apple | Windows |
| ------------ | ------: | ------: | ------: |
| Atoms        |      22 |      23 |      22 |
| Molecules L1 |      42 |      42 |      42 |
| Molecules L2 |      24 |      24 |      24 |
| Organisms    |      55 |      55 |      55 |
| Templates    |       7 |       7 |       7 |
| Pages        |      15 |      15 |      15 |
| **Total**    | **165** | **166** | **165** |

## Using the catalog

New product UI composes these components rather than hand-rolling markup. On web that is enforced: `src/web/scripts/check-maple-ui-adoption.mjs` freezes already-migrated directories and files, so a raw `<button>` or a `btn-primary`-style class re-entering one fails `bun run maple-ui:adoption-check` in `.github/workflows/web.yml`. Apple and Windows have no equivalent ratchet — the discipline there is review.

Apple consumers import the `MapleUI` package, which is deliberately dependency-free (no MapleCore, no third-party SPM packages) so sibling apps can consume it directly. It targets macOS 14 and iOS 17; the tvOS app does not link it.

What to specify when adding or changing an element:

- **Atoms** — every variant × size × state as a matrix, token references only, minimum hit area, focus-ring treatment. Then write the contract doc; the CI job requires all six sections.
- **Molecules** — internal spacing, overflow behaviour, which atom variants are permitted inside (a Banner uses ghost Buttons, not primary), empty and loading appearance.
- **Organisms** — layout per breakpoint, the loading/empty/error/partial data states, scroll and virtualization, keyboard traversal order.
- **Templates** — region min/max sizes, collapse and reflow order, overlay stacking.
- **Pages** — which organisms occupy which regions, and what changes per breakpoint.

See [best-practices](best-practices.md) for the Angular component rules and the Tailwind conversion recipe these components follow.
