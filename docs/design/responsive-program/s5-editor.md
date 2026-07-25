# Responsive Program — S5: Editor

Fifth sub-project of the responsive program (epic [#577](https://github.com/zubair-io/Maple/issues/577)). The centerpiece: full-screen photo editor with **drag bar** (the unique UX primitive), value chip overlay, group tabs, tool pill row, undo ring, debounced XMP save, and keyboard shortcuts on desktop. Pushed from Loupe's "Edit" pill on phone/tablet/desktop. Depends on S0a/S0b/S0c primitives, S1a (tab-bar hide pattern), S1c (bottom-sheet for Info), S4 (Loupe push origin).

Visual reference: `/Users/riabuz/Projects/_Maple/mobile/maple-mobile-editor.html` frame **Editor — Pick (B Revised)**, plus prompt §5.5 / §5.6 / §5.7.

Three tickets — **S5a Editor shell + chrome**, **S5b Drag bar primitive**, **S5c Tool model + 22 glyphs (follow-up [#587](https://github.com/zubair-io/Maple/issues/587))** — each one PR.

---

## 1. Overview & deliverable map

| Ticket  | What ships                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Files touched                                                                                                                                                                                                                                                                                                                                                                                                                                | Blocks    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **S5a** | `EditorView` shell + chrome (header w/ back/undo/share/info + canvas region + filmstrip from S4 + group tabs + tool pill row stubs). Value chip overlay (top-center, sticky-glass). Tab-bar hide on push. Info modal via `mapleBottomSheet` (S1c). Undo ring buffer (32 entries). Debounced XMP save (750ms after last edit) — reuses the existing store-level debounce in `XMPSidecarStore.update` (Apple) and `CloudSidecarStore.update` / `LibraryFetchService.scheduleSidecarWrite` (web). Keyboard shortcuts on desktop. | New `src/apple/Maple/Views/EditorView.swift`, new `src/apple/Maple/Views/EditorHeader.swift`, new `src/apple/Maple/Views/ValueChipOverlay.swift`, new `src/apple/Maple/Views/GroupTabsView.swift`, new `src/apple/Maple/Views/ToolPillRow.swift`, new `src/web/projects/maple-common/src/lib/editor/editor.component.{ts,html,scss,spec.ts}` + sibling files, route `/library/editor/:id` in both web apps                                   | S5b / S5c |
| **S5b** | `DragBar` primitive — 21 ticks at 5% increments, 14pt center tick (`borderHi`), 6pt other ticks (`border`), 2pt × 22pt accent marker. Drag mappings: bar 1:1, canvas 0.5:1, fine mode (long-press marker) 0.25:1. Double-tap reset. Haptics (zero-cross/extreme/reset/switch). Wired into `ValueChipOverlay` and `EditorView` for the armed tool.                                                                                                                                                                             | New `src/apple/Maple/Views/DragBar.swift`, new `src/web/projects/maple-common/src/lib/editor/drag-bar.component.{ts,html,scss,spec.ts}`                                                                                                                                                                                                                                                                                                      | S5c       |
| **S5c** | Tool model state machine (`EditorState`: armed tool, values, undo/redo stacks, dirty flag, fineMode). 22 tool glyphs designed (closes [#587](https://github.com/zubair-io/Maple/issues/587)). Tool pill row populated per group (Light: 6 tools, Color: 5, Effects: 6, Detail: 5). Each tool wired to its `AdjustmentModel` field with the value range/mapping per spec.                                                                                                                                                      | `src/apple/Packages/MapleCore/Sources/MapleCore/Editor/EditorState.swift` (new — `Editor/` subdir is new; the file must land inside the `MapleCore` package source tree so it compiles), `src/apple/Maple/Views/ToolPillRow.swift` (populated), `src/apple/Maple/Resources/ToolGlyphs/` (new SVGs or SF Symbol mappings), `src/web/projects/maple-common/src/lib/editor/editor-state.service.ts` (new), web ToolGlyphs added to `maple-icon` | —         |

S5a depends on S0a/S0b/S0c, S1a, S1c, S4. S5b depends on S5a + S0a (motion). S5c depends on S5a + S5b.

---

## 2. Visual reference & behavior

### Phone (mockup frame Editor — Pick / B Revised)

Vertical stack top → bottom:

1. **Status bar** (54pt platform).
2. **Header** (44pt): `‹` back · filename (SF Mono 12pt, ellipsized) · `↺` undo (tap=undo, long-press=redo, 32-step ring) · `⇪` share (stub) · `ⓘ` info (opens S1c bottom-sheet with S6 content).
3. **Canvas region** (flex). Image at 88% width, capped 3:2 portrait, centered on `MapleTokens.bg` background.
   - **Value chip overlay** floats top-center, 14pt above canvas. Pill, `rgba(15,13,11,0.6)` fill, `backdrop-filter: blur(6px)`. Contents: SF-Mono-uppercase group ("LIGHT") in `textMuted` · 1pt vertical rule · uppercase tool ("EXPOSURE") in `textMuted` · signed value ("+25") in `primary`, tabular-nums. **Always rendered, even at value 0.**
4. **Filmstrip** (optional, 48pt; `cm.filmstrip`).
5. **Drag bar** (30pt; 24pt horizontal padding).
6. **Group tabs** (32pt). 4 equal-width: Light · Color · Effects · Detail. Selected = `primary` 600-weight label + 1.5pt accent underline. Tap = 120ms cross-fade (`Motion.groupSwap`).
7. **Tool pill row** (~60pt; 40pt circle + 10pt label). `flex: 1` per pill — row fills width.

### Tablet / Desktop

- Pane shell: editor occupies main column; sidebar + inspector visible. Inspector pane (S6) replaces the bottom-sheet for Info.
- Filmstrip always-on.
- Drag bar widens proportionally — tick math identical (21 ticks at 5% increments).
- Keyboard shortcuts (desktop only, per §5b.5):
  - `1`–`5` rating · `P` pick · `X` reject · `0` reset armed tool
  - `Esc` exit editor (discard confirm) · `Cmd/Ctrl+S` save · `Cmd/Ctrl+Z`/`Cmd/Ctrl+Shift+Z` undo/redo
  - `[`/`]` prev/next tool in current group · `Shift+[`/`Shift+]` prev/next group
  - `←`/`→` prev/next image
- Scroll wheel over bar/canvas nudges armed tool by ±1 per detent (±10 with shift, ±0.1 with option/alt).

### Groups & tools

| Group   | Tools                                                        |
| ------- | ------------------------------------------------------------ |
| Light   | Exposure · Contrast · Highlights · Shadows · Whites · Blacks |
| Color   | Temp · Tint · Vibrance · Saturation · HSL                    |
| Effects | Clarity · Texture · Dehaze · Vignette · Grain · Split tone   |
| Detail  | Sharpen · Noise · Color NR · Crop · Presets                  |

### Tool pill states

- **Default**: 40pt circle, `surfaceAlt` fill, 0.5pt border, glyph in `textMain`.
- **Selected (armed)**: fill `${primary}26`, accent border, glyph recolored to `primary`. Label `primary` + 600.
- **Modified indicator**: 6pt dot bottom-right of circle if `value ≠ 0`. Dot = `primary` for positive, `textMuted` for negative.

### Selection rules

- Tap a tool → arm it for the drag bar. Previous tool's value is **committed but not lost**.
- Switching tools never resets values.
- Switching groups preserves armed tool within the previous group; re-opening that group re-arms it.

---

## 3. Drag bar (centerpiece — S5b)

- **30pt tall, 24pt horizontal padding.**
- **1pt baseline rule running full width.**
- **21 tick marks at 5% increments.** Center tick (50%) = **14pt tall** in `MapleTokens.borderHi`. Others = **6pt** in `MapleTokens.border`.
- **2pt × 22pt accent marker** at `50 + value/2 %` of bar width (mapping `[-100, +100]` linearly).

**Drag behavior:**

- Drag anywhere on the **canvas** OR the bar — both hit-test active.
- Bar drag = **1:1**. Canvas drag = **0.5:1** (finer).
- Vertical drag is **ignored** (no axis-lock affordance).
- **Double-tap the bar** → reset to 0.
- **Long-press the marker** → fine mode: next drag is **0.25:1**. Releases out of fine mode on touch-up.

**Value ranges (internal `[-100, +100]`, display per tool):**

| Tool        | Display range | Step | Suffix |
| ----------- | ------------- | ---- | ------ |
| Exposure    | EV ±4.0       | 0.05 | EV     |
| Temp        | 2000–12000 K  | 50   | K      |
| Tint        | -100 to +100  | 1    |        |
| Other tools | -100 to +100  | 1    |        |

Display value computed from internal value at the call site (`ValueChipOverlay`); the drag bar itself only knows the internal `[-100, +100]` linear scale.

**Haptics:**

| Event              | iOS                | Web (Vibration API)     |
| ------------------ | ------------------ | ----------------------- |
| Cross zero         | `.impact(.light)`  | `navigator.vibrate(8)`  |
| Hit ±100           | `.impact(.medium)` | `navigator.vibrate(12)` |
| Reset (double-tap) | `.selection`       | `navigator.vibrate(4)`  |
| Switch tool/group  | `.selection`       | `navigator.vibrate(4)`  |

---

## 4. State & persistence

### `EditorState` (per image, S5c)

```ts
type EditorState = {
  imageId: string;
  armed: { group: GroupId; tool: ToolId };
  values: Record<ToolId, number>; // internal [-100, +100]
  undoStack: Snapshot[]; // ring buffer, cap 32
  redoStack: Snapshot[];
  isDirty: boolean;
  fineMode: boolean;
};
```

- **Undo commit boundaries**: slider release · keyboard shortcut (P/X/0–5) · WB preset · eyedropper · copy-paste · revert. **Not per-frame.**
- **Save**: piggy-backs on the existing **store-level 750ms debounce**. On Apple, `EditSession` already routes mutations through `XMPSidecarStore.update(...)` (debounceInterval = 750ms; resets the timer on each call; flushes on shutdown). On web, mutations route through `LibraryStateService` → `LibraryFetchService.scheduleSidecarWrite(id)` which holds its own debounce before the POST. S5 does **not** introduce a new `EditorState`-level debounce; it just calls the existing `EditSession` mutators on slider commit and lets the store coalesce the write. Synchronous flush on editor dismissal uses `XMPSidecarStore.flush()` (Apple) / the equivalent web flush.

### Persistence (`cm.*`)

- `cm.editor.armed`: JSON `Record<imageId, {group, tool}>` — last-armed tool per image (per S0a schema).
- `cm.filmstrip`: bool — show filmstrip preference (per S0a schema).

---

## 5. Apple implementation

### Files

- **New** `src/apple/Packages/MapleCore/Sources/MapleCore/Editor/EditorState.swift` — `@Observable` class with the type above; methods for `arm(tool:)`, `setValue(_:)`, `undo()`, `redo()`, `reset()`, `commit()`. Mirrors existing `EditSession` patterns. (`MapleCore` lives under `src/apple/Packages/MapleCore/`; the `Editor/` subdirectory is new and ships with this PR so the file is picked up by the SPM target.)
- **New** `src/apple/Maple/Views/EditorView.swift` — top-level `View` composing the seven regions.
- **New** `src/apple/Maple/Views/EditorHeader.swift` — back/filename/undo/share/info row.
- **New** `src/apple/Maple/Views/ValueChipOverlay.swift` — always-rendered overlay reading from `EditorState.armed` and `.values[armed.tool]`. Display formatting per tool (`Exposure +0.25 EV`, `Temp 5800 K`, etc.).
- **New** `src/apple/Maple/Views/DragBar.swift` (S5b) — `Canvas`-based custom view with 21 ticks + marker. Gesture handling for 1:1 / 0.5:1 / 0.25:1 mappings.
- **New** `src/apple/Maple/Views/GroupTabsView.swift` — 4-tab segmented row with `Motion.groupSwap` cross-fade.
- **New** `src/apple/Maple/Views/ToolPillRow.swift` — `flex: 1` per pill, scrolls horizontally if `tools.count > 6` (HSL is a sub-tool group).
- **Existing** `src/apple/Maple/Views/AppShellMacLayout.swift` — pane shell route Editor surface in main pane; reuses `EditorView`.
- **Existing** `src/apple/Maple/Views/PhoneLibraryView.swift` (S2) — add `.navigationDestination(for: EditorPushTarget.self) { ... EditorView($0.session) }`. Tab bar hides via `.toolbar(.hidden, for: .tabBar)`.

### Keyboard shortcuts (desktop only)

Wrap `EditorView` in `.keyboardShortcut` modifiers wrapped by `#if os(macOS)` or `layout == .desktop` checks. SwiftUI's `.keyboardShortcut("[", modifiers: [])` for unmodified keys requires `@FocusState` + a hidden focusable element OR using the `Commands` API at the scene level. Use scene-level `Commands` to avoid editor-internal complexity.

---

## 6. Web implementation

### Files

- **New** `src/web/projects/maple-common/src/lib/editor/editor-state.service.ts` — injectable `signal`-based store mirroring `EditorState`. Computed signals for armed tool's value, isDirty, etc.
- **New** `editor.component.{ts,html,scss}` — top-level component, signals, separate templates per CLAUDE.md.
- **New** `editor-header.component.ts`, `value-chip.component.ts`, `drag-bar.component.ts`, `group-tabs.component.ts`, `tool-pill-row.component.ts` — siblings.
- **New** `editor-page.component.ts` in `maple` and `maple-syrup` — route `/library/editor/:id` (and per-tab variants), fetches `EditSession` via `LibraryStateService`, renders `<app-editor>`. Sets `TabBarVisibilityService.hidden(true)` on init.

### Drag bar (S5b)

`<app-drag-bar>` — pure SVG (or `<canvas>`) for the 21 ticks + marker. `pointerdown`/`pointermove`/`pointerup` on a container that overlays both the canvas region (0.5:1 sensitivity) AND the bar itself (1:1). Long-press detection via `setTimeout` (500ms). Velocity tracking inline.

Haptic via `navigator.vibrate(ms)` with feature-detection fallback (no-op on browsers without Vibration API).

### Keyboard shortcuts

`@HostListener('window:keydown', ['$event'])` on `editor.component`; suppress when focus is in a text input. Only active when `LayoutService.layout() === 'desktop'`. Per-key handlers map to `EditorStateService` methods.

### Scroll-wheel value nudge (desktop)

`@HostListener('wheel', ['$event'])` on `drag-bar` and canvas — `event.preventDefault()`, compute delta from `deltaY`, modify value with shift/option modifiers.

---

## 7. Testing strategy

### EditorState (S5c)

- TDD: `editor-state.service.spec.ts` (web) and `EditorStateTests` (Swift) for:
  - `arm(tool)` updates `armed`, preserves other tools' values
  - `setValue(v)` updates only the armed tool's value
  - `undo()` pops the ring; `redo()` pushes back; ring caps at 32
  - `commit()` snapshots only on release (not per-frame)
  - `fineMode = true` makes drag deltas 0.25× the normal mapping

### Drag bar (S5b)

- **Pure-math tests** for value→pixel and pixel→value mapping at all three sensitivity modes. `value = 0 ⇒ marker at 50%`, `value = +100 ⇒ marker at 100%`, etc.
- **Tick layout test** — 21 ticks at 5% increments; tick 11 (center, index 10) is 14pt tall in `borderHi`.
- **Gesture math**: bar drag of 50pt on a 250pt-wide bar = `value += 20` (50/250 × 100 = 20). Canvas drag of 100pt = `value += 20` (0.5:1, so 100×0.5 = 50, then 50/250×100=20). Fine mode: 100pt = `value += 10` (0.25:1).
- **Haptic events fired** at zero-cross and extremes (mock the haptic interface).

### EditorView (S5a)

- Apple: `XCTest` for undo ring (cap 32, FIFO), store-level debounced save (the existing `XMPSidecarStore` 750ms debounce — assert via the existing test helpers in `XMPSidecarStoreTests`, not a new editor-side mock), keyboard shortcut routing.
- Web: `editor.component.spec.ts` — renders 7 regions; tap undo invokes `editorState.undo()`; long-press triggers redo; Info icon opens bottom-sheet.

### CI gates

Same as S0/S1 baseline plus:

- Slider tick performance: synthetic test renders 60Hz drag over 2 seconds; assert no frame drops above 25ms (per CLAUDE.md "16ms slider, 50ms hard limit"). Hard to automate fully on web; defer to manual smoke + perf budget reminder in PR.

### Visual verification

`preview_start name="maple"`, navigate to a test image's editor route, screenshot Phone + Desktop. Verify value chip overlay positioning, drag bar tick rendering, group tab underline, tool pill modified-indicator dot.

---

## 8. Risks & open questions

### Risks

1. **Drag-bar gesture conflict with horizontal swipe** — canvas drag horizontally for value changes vs swipe between images. Resolution: in Editor mode, the swipe-between gesture is DISABLED (per prompt §5.5; back-arrow is the navigation). Phone Loupe (S4) has swipe-between; Editor doesn't. Document explicitly.
2. **Tool glyphs** — _resolved._ S5c shipped SF Symbol / hand-rolled placeholders so the shell wasn't blocked on illustration; the final set was drawn in [#640](https://github.com/zubair-io/Maple/issues/640) to the stroke convention above (16×16, 1.6 stroke, round caps/joins, stroke-only). The artwork lives in `src/web/projects/maple-common/src/lib/icons/tool-glyph-shapes.ts` and, as the same path data, in `src/apple/Maple/Views/ToolGlyphShapes.swift`.
3. **`AdjustmentModel` field naming alignment** — `EditorState.values[ToolId]` keys must match `AdjustmentModel` fields. Audit: existing model has exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation, clarity, texture, dehaze. Detail (sharpen, noise) exists. HSL, vignette, grain, split-tone, color-NR, crop, presets — some may not exist on `AdjustmentModel` yet. File follow-up tickets for missing fields.
4. **Store-level debounce + undo ring race** — slider release fires both `commit()` (undo snapshot) and an `EditSession` mutator that resets the 750ms timer inside `XMPSidecarStore.update` (Apple) / `LibraryFetchService.scheduleSidecarWrite` (web). If the user undoes within 750ms the undo path itself is another `EditSession` mutation that flows through the same store, so the next-scheduled write is the post-undo value — the store coalesces on `(assetId)` and only the latest call's payload reaches disk. Two things to lock down at PR time: (a) the editor's `undo()`/`redo()` paths really do route through the same store-level mutator (not a side-channel write), and (b) the editor-dismissal flush calls `XMPSidecarStore.flush()` before the view tears down so an undo-then-leave sequence persists the right value. No new 500ms `EditSession.scheduleSidecarWrite` path is introduced.
5. **Keyboard shortcuts on iPad with hardware keyboard** — tablet-class device; per §5b.5 only `←/→`, `Esc`, `Cmd+S`, `Cmd+Z` are bound on tablet. Skip `1-5`/`P`/`X`/`E`/`I` because they conflict with hardware-keyboard text input. Test on iPad sim with attached keyboard.
6. **`Cmd+Z` undo via existing UndoManager** — Apple has a system `UndoManager`. EditorState's custom ring vs system manager: use the custom ring (per existing `EditSession` pattern); document.

### Open questions

1. **Long-press timing** — 500ms standard? Spec doesn't say; pick 500ms; tune at PR time if too long/short.
2. **HSL sub-controls** — HSL is one tool pill but expands into Hue/Saturation/Luminance × 8 colors = 24 sub-sliders. Where do those live? Probably a sheet/expanded mode triggered by tapping HSL pill. Defer detail to a follow-up "HSL UI" spec.
3. **Crop tool** — separate UI (rotation + aspect + free crop) vs in-line drag bar (rotation angle only)? Likely separate; defer to follow-up "Crop UI" spec.
4. **Presets** — same: opens a presets list, applies a preset value bundle. Defer.
5. **Background save vs interactive** — slider drag during a fast-pass render: per `07-ui-architecture.md`, fast pass runs at viewport-resolution every frame; refine pass at 150ms idle. S5 reuses existing `EditSession` pipeline — no new render policy needed.
