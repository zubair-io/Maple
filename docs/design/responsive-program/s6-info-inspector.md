# Responsive Program — S6: Info Sheet ↔ Inspector Pane

Sixth sub-project of the responsive program (epic [#577](https://github.com/zubair-io/Maple/issues/577)). One `InfoPanelView` component renders inside two slots: the phone bottom sheet (from S1c) and the tablet/desktop right inspector pane. Same content, different shell.

Visual reference: `/Users/riabuz/Projects/_Maple/mobile/maple-mobile-editor.html` — **Info sheet (tap i in header)** frame plus prompt §5.7.

One ticket — **S6** — shipped as one PR.

---

## 1. Overview & deliverable map

| Ticket | What ships                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Files touched                                                                                                                                                                                                                                                                                                                          | Blocks |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **S6** | `InfoPanelView` (Apple) / `InfoPanelComponent` (web) — single component, two slots. Renders: rating + flags row, server-rendered histogram (SVG), camera + location grid, keyword chips. Phone consumes via S1c's `mapleBottomSheet`. Tablet/desktop renders directly inside the existing pane shell's Inspector column (replaces the existing Info-tab content). `cm.detailHidden` persistence (existing) controls inspector visibility on tablet/desktop. | New `src/apple/Maple/Views/InfoPanelView.swift`, edits to `src/apple/Maple/Views/DetailPanel.swift` (Info tab uses InfoPanelView), new `src/web/projects/maple-common/src/lib/info/info-panel.component.{ts,html,scss,spec.ts}` + sibling `histogram.component.ts`, `src/web/projects/maple/src/app/detail-pane.component.ts` consumes | —      |

S6 depends on S1c (`mapleBottomSheet`), reuses existing `DetailPanel` Info tab on Apple desktop.

---

## 2. Visual reference & behavior

### Phone (bottom sheet via S1c)

Triggered by `i` icon in Loupe (S4) or Editor (S5) header. Sheet height 74% viewport.

Top → bottom inside sheet:

1. **Grab handle** 38×4pt centered, 8pt below sheet edge (from S1c primitive).
2. **Header**: "Info" (Merriweather 17pt/700 — `MapleTokens.Typography.sheetTitle`) left, close X right.
3. **Rating & flags row**:
   - 3 pill circles (24pt): Pick (green P) · Unflagged (—) · Reject (✕). Active state visible on selected one.
   - Right: 5-star row, gold filled vs muted outline based on `cullingState.stars` (the rating field on `CullingState` — see `AdjustmentModel.swift`). Tap a star to set rating (1–5).
4. **Histogram** — 56pt block. Server-rendered RGB curves SVG/PNG. Top-left aligned. 0.5pt border, 6pt radius, `surface` bg.
5. **Camera / Location** — 2-col grid (label left muted, value right mono). 0.5pt rule between rows. Fields: Body (camera + model), Lens, Aperture, Shutter, ISO, Focal · Coords (lat/lon), City (reverse-geocode if available).
6. **Keywords** — wrap of 11pt rounded chips on `surfaceAlt`. Trailing `+` add chip is dashed-outline; tap opens keyboard with a single-line input docked above.

### Tablet / Desktop (inspector pane)

Same content, rendered as the body of the right pane (existing Inspector). Header omitted ("Info" is implied by the tab — existing `DetailPanel` has 4 tabs: Info / Color / Meta / Scopes; S6 fills the Info tab specifically). Grab handle hidden.

Toggle visibility via `i` icon → flips `cm.detailHidden`. Pane animates open/closed.

---

## 3. Apple implementation

### `InfoPanelView.swift` (new)

```swift
struct InfoPanelView: View {
    let asset: AssetRef
    @Bindable var cullingState: CullingState
    let isInsideSheet: Bool   // true on phone bottom sheet; affects header / handle visibility

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if isInsideSheet {
                    InfoSheetHeader(onClose: { /* dismiss */ })
                }
                RatingFlagsRow(cullingState: $cullingState)
                HistogramBlock(asset: asset)   // server-rendered SVG
                CameraLocationGrid(asset: asset)
                KeywordChipsRow(asset: asset)
            }
            .padding(MapleTokens.Spacing.panelInset)
        }
    }
}
```

### Consumers

**Phone (S4 Loupe / S5 Editor)** — already wired via S1c:

```swift
content.mapleBottomSheet(isPresented: $isInfoOpen) {
    InfoPanelView(asset: asset, cullingState: ..., isInsideSheet: true)
}
```

**Tablet/Desktop (existing `DetailPanel` Info tab)** — replace existing Info-tab body:

```swift
case .info:
    InfoPanelView(asset: asset, cullingState: ..., isInsideSheet: false)
```

Existing `DetailPanel.swift` is large (per the file-budget warning we noted in S1b); replacing the Info-tab body may require an extract — handle inline if it stays under budget, else file a small refactor follow-up.

### Histogram (server-rendered)

Per spec §5.7, the histogram is server-rendered (PNG or SVG) for v0.1. Pull from existing API surface in `src/api` if available; otherwise add an endpoint. Apple: `AsyncImage` with cache. Web: `<img>` with `loading="lazy"`.

---

## 4. Web implementation

### `info-panel.component.ts` (new)

```ts
@Component({
  selector: 'app-info-panel',
  standalone: true,
  templateUrl: './info-panel.component.html',
  styleUrl: './info-panel.component.scss',
})
export class InfoPanelComponent {
  readonly asset = input.required<AssetRef>();
  readonly insideSheet = input<boolean>(false);
}
```

### Sibling components

- `rating-flags-row.component.ts` — three pill circles + 5-star row
- `histogram.component.ts` — server-rendered `<img>` with skeleton placeholder
- `camera-location-grid.component.ts` — 2-column grid layout
- `keyword-chips-row.component.ts` — chip list with `+ add` affordance opening a docked input

### Consumers

**Phone**: S4 Loupe / S5 Editor render `<app-bottom-sheet>` containing `<app-info-panel [insideSheet]="true">`.

**Tablet/Desktop**: existing right-pane `<app-detail-pane>` Info tab renders `<app-info-panel [insideSheet]="false">`. Inspector visibility driven by `cm.detailHidden` localStorage key (existing).

### Dismissal mapping

- Phone: X click → `bottomSheet.isOpen.set(false)`; scrim/grab also dismiss (from S1c).
- Tablet/Desktop: X is replaced by the Inspector toggle (no X within the panel); flipping `cm.detailHidden` collapses the pane.

---

## 5. Testing strategy

### Apple

- `XCTest`:
  - `RatingFlagsRowTests` — tap each pill flips `cullingState.flag` correctly; tap a star sets `cullingState.stars`; tap same star clears (toggles).
  - `KeywordChipsRowTests` — renders existing keywords from `AssetRef.metadata` (read-only in v0.1; editing affordance is a stub pending the keyword-model follow-up — see §6 Risks). When the chip-editing scope is taken on (option (b) in §6), this test gains add/remove cases that go through `EditSession.setKeywords(_:)`.
- `#Preview` for `InfoPanelView` in both modes (`isInsideSheet: true` / `false`).

### Web

- `info-panel.component.spec.ts` — renders all 4 sections when given a stub asset; `insideSheet=true` shows header, `false` hides.
- `rating-flags-row.component.spec.ts` — tap pill emits `flagChange`; tap star emits `ratingChange`.
- `keyword-chips-row.component.spec.ts` — typing in `+ add` input + Enter adds chip; tap chip removes (or shows menu).
- Playwright e2e — open Loupe → tap info → sheet appears with content → tap close X → sheet dismisses.

### CI gates

Same as S0/S1 baseline.

---

## 6. Risks & open questions

### Risks

1. **Existing `DetailPanel.swift`** is the largest View file in the project (per CLAUDE.md mentions of file-size budget; mentioned at 594 lines in S1b agent's report). Replacing the Info tab body may push it further over soft budget. Mitigation: extract the Info-tab section into its own file (`DetailPanelInfoTab.swift`) as part of S6 — small refactor.
2. **Histogram endpoint** may not exist server-side yet. Audit `src/api` for `/histogram/:assetId` or equivalent; if missing, file a follow-up ticket to add the endpoint, and S6 ships with a placeholder rectangle until then.
3. **Keyword editing — NEW model + sidecar work.** `EditSession` does **not** currently expose `addKeyword`/`removeKeyword` (verified against `EditSession.swift` and `+Hydration.swift`), and `AdjustmentModel` / the XMP serializer don't carry a keyword field today. S6 has two options: (a) defer the chip-editing UX to a follow-up ticket and ship S6 with the keyword row as read-only (rendering whatever's already in `AssetRef.metadata`); or (b) include the new model field + serializer round-trip + `EditSession` mutators (`setKeywords(_:)` is the cleaner shape, routed through the existing 750ms `XMPSidecarStore.update` debounce) inside S6's scope. Default plan: **(a) — defer.** Treat the chip-editing affordance as a stub for v0.1 and file the model work as a follow-up. Do NOT bypass the existing debounced save when (b) is picked up.
4. **Rating star tap semantics** — single-tap to set, tap-same-star to clear? Existing desktop behavior should be mirrored. Confirm at PR time.
5. **Camera/location field mapping** — existing `AssetRef.metadata` may not have all 8 fields. Use `?? "—"` fallback for missing ones; don't crash on absent EXIF.

### Open questions

1. **Reverse-geocode** for City field — does Maple already do this server-side? If not, S6 shows raw coords only and a follow-up ticket adds geocoding.
2. **Keyword autocomplete** — should `+ add` suggest existing keywords? Likely yes; defer detail to follow-up.
3. **Keywords on Maple Cloud sources** — read-only or editable? Probably editable; needs API check.
