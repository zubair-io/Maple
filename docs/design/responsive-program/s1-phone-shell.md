# Responsive Program — S1: Phone Tab Shell

Second sub-project of the responsive program (epic [#577](https://github.com/zubair-io/Maple/issues/577)). Builds the phone-tier shell — bottom tab bar (Library / Search / Settings), per-tab NavigationStack, source-picker drawer (Library-tab-scoped), and a bottom-sheet primitive consumed by S4/S5/S6. Depends on S0a's `MapleLayout` / `MapleShellKind` signal (PR [#586](https://github.com/zubair-io/Maple/pull/586)).

This doc is the contract for three sub-tickets — **S1a Tab shell**, **S1b Source-picker drawer**, **S1c Bottom-sheet primitive** — each one PR.

The phone-tier UX is grounded in `/Users/riabuz/Projects/_Maple/mobile/maple-mobile-editor.html` mockup frames (Library / Folder menu / Search / Full image), with deliberate deviations documented in §6.

---

## 1. Overview & deliverable map

| Ticket  | What ships                                                                                                                                                                                                                                                                                                                                                                                                                                        | Files touched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Blocks             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **S1a** | `PhoneTabShell` (Apple TabView with 3 tabs; web custom bottom-nav). Per-tab NavigationStack preserving push depth. Routed via `MapleShellKind.current == .phoneTab` on Apple / `LayoutService.layout() === 'phone'` on web; pane shell stays for tablet/desktop. Stubs in each tab — S2/S7/S8 fill real content. Tab bar hides during Loupe/Editor push via `.toolbar(.hidden, for: .tabBar)` (Apple) and `TabBarVisibilityService` signal (web). | `src/apple/Maple/Views/{PhoneTabShell,PhoneLibraryStub,PhoneSearchStub}.swift` (new), `src/apple/Maple/Views/AppShell.swift`, `src/apple/Maple/Views/AppShellIPhoneShell.swift` (rewire), `src/web/projects/maple-common/src/lib/shells/{phone-tab-shell,root-shell,tab-bar-visibility.service}.{ts,html,scss,spec.ts}`, `src/web/projects/maple/src/app/app.routes.ts`, `src/web/projects/maple-syrup/src/app/app.routes.ts`, `src/web/projects/{maple,maple-syrup}/src/app/app.component.ts`, `docs/spec/07-ui-architecture.md` | S2, S4, S5, S7, S8 |
| **S1b** | Source-picker drawer rewired from phone-shell-level to Library-tab-scoped. 326pt width, HTML-frame-01 content (LIBRARY eyebrow + connection identity + search pill + Folders / Photos Library / Albums tree). Web equivalent in `maple-common`.                                                                                                                                                                                                   | `src/apple/Maple/Views/AppShellIPhoneDrawer.swift` (rewire), `src/apple/Maple/Views/PhoneLibraryStub.swift`, `src/web/projects/maple-common/src/lib/shells/source-picker-drawer.component.{ts,html,scss,spec.ts}`                                                                                                                                                                                                                                                                                                                 | S2                 |
| **S1c** | Bottom-sheet primitive. Apple = `.sheet` + `.presentationDetents([.fraction(0.74)])` extension (`mapleBottomSheet`). Web = hand-rolled component with PointerEvents drag-to-dismiss matching spec exactly (35% scrim, 38×4pt grab handle, 25%/1000 px/s dismiss threshold).                                                                                                                                                                       | `src/apple/Maple/Views/BottomSheet.swift` (new), `src/web/projects/maple-common/src/lib/shells/bottom-sheet.component.{ts,html,scss,spec.ts}`                                                                                                                                                                                                                                                                                                                                                                                     | S4, S5, S6         |

S1a depends on S0a (`MapleLayout`/`MapleShellKind`). S1b builds on S1a's `PhoneLibraryStub` host. S1c is independent of S1a/S1b. S1a unblocks S2/S4/S5/S7/S8.

**Not in S1:** Library grid (S2), Search results (S7), Settings tab content (new S8 — to be filed when S1 lands), Loupe (S4), Editor (S5), tablet/desktop pane changes (S6 — phone uses S1c's primitive).

---

## 2. S1a — PhoneTabShell

### 2.1 Apple

New `src/apple/Maple/Views/PhoneTabShell.swift`:

```swift
struct PhoneTabShell: View {
    @AppStorage("cm.tab") private var activeTab: String = "library"
    // Plus @State / @Binding params threaded from AppShell.

    var body: some View {
        TabView(selection: $activeTab) {
            NavigationStack { PhoneLibraryStub(/* ... */) }
                .tabItem { Label("Library", systemImage: "photo.on.rectangle.angled") }
                .tag("library")

            NavigationStack { PhoneSearchStub() }
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag("search")

            NavigationStack { SettingsView() }   // existing TabView; S8 will replace with iOS Settings-style List
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag("settings")
        }
    }
}
```

`AppShell.body` updates (replaces the current `adaptiveShell` branch):

```swift
#if os(iOS)
if MapleShellKind.current == .phoneTab {
    PhoneTabShell(/* params */)
        .environment(\.mapleLayout, .phone)
} else {
    paneShellWithLayout
}
#else
paneShellWithLayout
#endif
```

**Tab-bar hide on push** — pattern that S4/S5 follow:

```swift
NavigationStack {
    PhoneLibraryStub()
        .navigationDestination(for: AssetRef.self) { asset in
            LoupeView(asset)
                .toolbar(.hidden, for: .tabBar)
        }
}
```

`AppShellIPhoneShell.swift` becomes the body of `PhoneLibraryStub` (drop Settings sheet wiring — Settings is now a tab). `AppShellIPhoneToolbar.swift` likely deleted — verify at PR time via grep.

### 2.2 Web

New `src/web/projects/maple-common/src/lib/shells/phone-tab-shell.component.{ts,html,scss}` — standalone Angular component, signals, separate template/scss per CLAUDE.md.

```ts
@Component({
  selector: 'app-phone-tab-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MapleIconComponent],
  templateUrl: './phone-tab-shell.component.html',
  styleUrl: './phone-tab-shell.component.scss',
})
export class PhoneTabShellComponent {
  private tabBarVisibility = inject(TabBarVisibilityService);
  protected readonly tabBarHidden = this.tabBarVisibility.hidden;
}
```

Template (`phone-tab-shell.component.html`):

```html
<div class="content"><router-outlet /></div>
<nav class="bottom-tabs" [class.hidden]="tabBarHidden()">
  <a routerLink="/library" routerLinkActive="active">
    <maple-icon name="photo-stack" />
    <span>Library</span>
  </a>
  <a routerLink="/search" routerLinkActive="active">
    <maple-icon name="magnifying-glass" />
    <span>Search</span>
  </a>
  <a routerLink="/settings" routerLinkActive="active">
    <maple-icon name="gear" />
    <span>Settings</span>
  </a>
</nav>
```

New `TabBarVisibilityService` (`shells/tab-bar-visibility.service.ts`):

```ts
@Injectable({ providedIn: 'root' })
export class TabBarVisibilityService {
  readonly hidden = signal<boolean>(false);
}
```

S4/S5 route components call `hidden.set(true)` on init, `.set(false)` on destroy.

**Routes** (`projects/maple/src/app/app.routes.ts` and `projects/maple-syrup/src/app/app.routes.ts`):

```ts
[
  { path: '', redirectTo: 'library', pathMatch: 'full' },
  { path: 'library', loadComponent: () => import('./phone-library-stub.component') },
  { path: 'library/loupe/:id', loadComponent: () => import('...future S4 component') },
  { path: 'library/editor/:id', loadComponent: () => import('...future S5 component') },
  { path: 'search', loadComponent: () => import('...future S7 component') },
  { path: 'settings', loadComponent: () => import('...future S8 component') },
];
```

**Shell selection at top level** — new `RootShellComponent` in `maple-common/shells/`:

```ts
@Component({
  selector: 'app-root-shell',
  standalone: true,
  imports: [PhoneTabShellComponent /* existing pane shell component */],
  template: `
    @if (layout() === 'phone') {
      <app-phone-tab-shell />
    } @else {
      <app-pane-shell />
    }
  `,
})
export class RootShellComponent {
  private layoutService = inject(LayoutService);
  protected readonly layout = this.layoutService.layout;
}
```

Each app (`maple`, `maple-syrup`) updates `app.component.ts` to render `<app-root-shell>` instead of the current `<router-outlet>`-only template. If `maple-syrup`'s existing shell is structurally different, ship `maple` first and file a follow-up for `maple-syrup` (Risk §6.5).

### 2.3 Persistence

| Key      | Type                                               | Used by        | Status                                                                                                                                                                     |
| -------- | -------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cm.tab` | string (`"library"` \| `"search"` \| `"settings"`) | both platforms | reuse existing — **audit at PR time** for collision with Detail-panel tab (Risk §6.1; if collision, introduce `cm.tab.shell` for phone and keep `cm.tab` for Detail panel) |

### 2.4 Spec doc edits — `docs/spec/07-ui-architecture.md`

1. **Line 13** (iPhone shell) — Updated already by S0a to say tab bar; S1a confirms the three tabs (Library / Search / Settings) and the swipe-up-sheet retraction (Loupe/Editor are full-screen pushes; Info is a modal sheet only).
2. **New "Phone navigation" section** below "Shells, in one sentence each": tabs, per-tab NavStack, tab-bar hide on push, source-picker drawer Library-tab-scoped.

---

## 3. S1b — Source-picker drawer

### 3.1 Apple — rewire existing `AppShellIPhoneDrawer.swift`

| Change                     | Was                                              | After S1b                                                                                    |
| -------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Scope                      | phone-shell-level (overlays entire iPhone shell) | Library-tab-scoped (overlays Library tab content only)                                       |
| Width                      | 280pt                                            | **326pt** (HTML spec; ~81% of viewport)                                                      |
| Pan-left dismiss threshold | (existing impl varies)                           | **≥ 30% of drawer width**                                                                    |
| Trailing edge              | (existing)                                       | `borderTopRightRadius / borderBottomRightRadius: 18pt`; shadow `12px 0 40px rgba(0,0,0,0.5)` |
| Open transition            | (existing)                                       | `MapleTokens.Motion.drawer` (240ms, S0a token)                                               |
| Scrim                      | (existing)                                       | 45% black over Library tab grid; tap-anywhere dismisses                                      |

**Content** — reuses existing `LibrarySidebar` for source-tree rendering (no duplicate source-tree code). Drawer adds only the chrome frame and the search pill above the tree:

| Region      | Contents                                                                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header      | `LIBRARY` eyebrow (Lato 10pt/700, 0.14em, uppercase) + close X (top-right). Connection identity (e.g. `maple.lawrence.io`) + chevron (stub for v0.1 — Maple-instance switcher is out of scope). Tertiary line: total photos + last sync. |
| Search pill | Pill input. **Tap → `activeTab = "search"`, dismiss drawer, post `.focusSearch` event so S7's search field auto-focuses on mount.** Not a no-op text input.                                                                              |
| Source tree | Existing `LibrarySidebar` view, scoped to source tree only (no detail panel chrome). FOLDERS / PHOTOS LIBRARY / ALBUMS sections per HTML frame 01.                                                                                       |

**Interactions:**

- Hamburger ☰ in Library tab header → `isDrawerOpen = true`. Animation = `MapleTokens.Motion.drawer`.
- Tap source row → `isDrawerOpen = false`, `librarySelection = newSelection`, `cm.source = newSource.id`. Library tab grid title + content update via existing `BrowseViewModel.reload`.
- Close X / scrim tap → `isDrawerOpen = false`.
- Pan-left ≥ 30% drawer width → `isDrawerOpen = false`.
- Tap search pill → `activeTab = "search"`, `isDrawerOpen = false`, focus event posted to S7.

`PhoneLibraryStub.swift` (from S1a) hosts the drawer:

```swift
struct PhoneLibraryStub: View {
    @State private var isDrawerOpen = false
    // ... params from PhoneTabShell

    var body: some View {
        ZStack {
            VStack {
                PhoneLibraryHeader(onHamburger: { isDrawerOpen = true })
                Text("Grid placeholder — S2")
            }
            AppShellIPhoneDrawer(
                isOpen: $isDrawerOpen,
                onSourceSelected: { src in /* updates librarySelection */ },
                onSearchPillTap: { /* switch tab + dismiss */ }
            )
        }
    }
}
```

### 3.2 Web — new Angular component

New `src/web/projects/maple-common/src/lib/shells/source-picker-drawer.component.{ts,html,scss,spec.ts}`.

```ts
@Component({
  selector: 'app-source-picker-drawer',
  standalone: true,
  templateUrl: './source-picker-drawer.component.html',
  styleUrl: './source-picker-drawer.component.scss',
})
export class SourcePickerDrawerComponent {
  readonly isOpen = model<boolean>(false);
  readonly sourceTree = input.required<SourceNode[]>();
  readonly sourceSelected = output<string>();
  readonly searchPillTap = output<void>();
  // PointerEvents pan-left dismiss inline.
}
```

SCSS:

```scss
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 90;
}
.drawer {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  width: min(326px, 81vw);
  background: var(--color-surface);
  border-top-right-radius: 18px;
  border-bottom-right-radius: 18px;
  box-shadow: 12px 0 40px rgba(0, 0, 0, 0.5);
  transform: translateX(0);
  transition: transform var(--motion-drawer-ms) var(--motion-drawer-ease);
  z-index: 91;
}
.drawer.dragging {
  transition: none;
}
```

`PhoneLibraryStub` (Angular) hosts the drawer + a header with hamburger; consumes `LibraryStateService` for source data.

### 3.3 Files touched (S1b PR)

| File                                                                                                 | Change                                                              |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `src/apple/Maple/Views/AppShellIPhoneDrawer.swift`                                                   | rewire (width, dismiss, motion, search-pill callback)               |
| `src/apple/Maple/Views/PhoneLibraryStub.swift`                                                       | expand header + drawer host                                         |
| `src/apple/Maple/Views/LibrarySidebar.swift`                                                         | extract source-tree sub-view if needed for reuse — audit at PR time |
| `src/web/projects/maple-common/src/lib/shells/source-picker-drawer.component.{ts,html,scss,spec.ts}` | **new**                                                             |
| `src/web/projects/maple-common/src/public-api.ts`                                                    | export                                                              |

---

## 4. S1c — Bottom-sheet primitive

### 4.1 Apple — `View` extension wrapping `.sheet`

`src/apple/Maple/Views/BottomSheet.swift` (new):

```swift
extension View {
    /// Phone Info bottom sheet per responsive-program prompt §5.7.
    /// 74% viewport height, 18pt top corners, grab handle, native gesture dismiss.
    func mapleBottomSheet<Content: View>(
        isPresented: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        self.sheet(isPresented: isPresented) {
            content()
                .presentationDetents([.fraction(0.74)])
                .presentationDragIndicator(.visible)
                .presentationBackground(MapleTokens.surface)
                .presentationCornerRadius(18)
        }
    }
}
```

Consumers (S4 Loupe, S5 Editor):

```swift
content
    .mapleBottomSheet(isPresented: $isInfoOpen) {
        InfoSheetContent(/* asset, vm, ... */)
    }
```

**Deviations from spec** (acceptable — visible-but-minor, noted in PR description):

| Spec wants                           | Native gives          | Mitigation                                                             |
| ------------------------------------ | --------------------- | ---------------------------------------------------------------------- |
| Scrim 35% dim                        | System ~50% dim       | None via public API                                                    |
| Grab handle 38×4pt, `borderHi` color | System default        | Hide native + draw custom inside content view if visual review demands |
| Dismiss at 25% height OR 1000 px/s   | Native ~50% threshold | Hand-rolled sheet required for exact match (~150 LOC)                  |

If design review pushes back, file follow-up KTLO to hand-roll. v1 ships native.

### 4.2 Web — `BottomSheetComponent`

New `src/web/projects/maple-common/src/lib/shells/bottom-sheet.component.{ts,html,scss,spec.ts}` — full spec compliance (35% scrim, 38×4pt grab handle, 25%/1000 px/s dismiss).

```ts
@Component({
  selector: 'app-bottom-sheet',
  standalone: true,
  templateUrl: './bottom-sheet.component.html',
  styleUrl: './bottom-sheet.component.scss',
})
export class BottomSheetComponent {
  readonly isOpen = model<boolean>(false);
  // Content via <ng-content>.
}
```

Template (`bottom-sheet.component.html`):

```html
@if (isOpen()) {
<div class="scrim" (click)="isOpen.set(false)" role="presentation"></div>
<div
  class="sheet"
  role="dialog"
  aria-modal="true"
  [class.dragging]="isDragging()"
  (pointerdown)="onPointerDown($event)"
  (pointermove)="onPointerMove($event)"
  (pointerup)="onPointerUp($event)"
>
  <div class="grab-handle" aria-hidden="true"></div>
  <ng-content />
</div>
}
```

SCSS:

```scss
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 100;
}
.sheet {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 74vh;
  background: var(--color-surface);
  border-top-left-radius: 18px;
  border-top-right-radius: 18px;
  box-shadow: 0 -8px 30px rgba(0, 0, 0, 0.6);
  z-index: 101;
  transform: translateY(0);
  transition: transform var(--motion-sheet-present-ms) var(--motion-sheet-present-ease);
}
.sheet.dragging {
  transition: none;
}
.grab-handle {
  width: 38px;
  height: 4px;
  background: var(--color-border-hi);
  border-radius: 2px;
  margin: 8px auto 4px;
}
```

Pan-to-dismiss: `pointerdown/move/up` handlers inline — at `pointerup`, dismiss if drag-down ≥ 25% sheet height OR velocity ≥ 1000 px/s.

### 4.3 Files touched (S1c PR)

| File                                                                                         | Change                                              |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `src/apple/Maple/Views/BottomSheet.swift`                                                    | **new** — `mapleBottomSheet` extension + `#Preview` |
| `src/web/projects/maple-common/src/lib/shells/bottom-sheet.component.{ts,html,scss,spec.ts}` | **new**                                             |
| `src/web/projects/maple-common/src/public-api.ts`                                            | export                                              |

---

## 5. Testing strategy

### 5.1 S1a PhoneTabShell

- **Apple**: `#Preview` blocks on `PhoneTabShell`, `PhoneLibraryStub`, `PhoneSearchStub`. Smoke test on iPhone 17 Pro sim: tab bar visible, switching preserves NavStack depth per tab, `cm.tab` persists across cold restart. No XCTest (TabView structural testing is awkward in SwiftUI).
- **Web**: `phone-tab-shell.component.spec.ts` — 3 nav links with correct routerLinks/labels/icons; `RouterLinkActive` highlights active tab; tab bar gets `.hidden` class when `TabBarVisibilityService.hidden.set(true)`.
- **`TabBarVisibilityService`**: TDD — `tab-bar-visibility.service.spec.ts` asserting `hidden.set(true)` flips signal, before service implementation.
- **`RootShellComponent`**: stub `LayoutService.layout()` returning `'phone'` → asserts `<app-phone-tab-shell>` renders; `'desktop'` → asserts pane shell renders.

### 5.2 S1b Source-picker drawer

- **Apple**: extend `AppShellIPhoneDrawer`'s `#Preview` (or add) showing 326pt width + scrim + sample source tree. Smoke test on sim — drag-left, scrim tap, source row tap.
- **Web**: `source-picker-drawer.component.spec.ts` — renders source tree from input; tap source row emits `sourceSelected(id)`; tap search pill emits `searchPillTap`; scrim click sets `isOpen.set(false)`; close X same. Pan-to-dismiss → Playwright e2e in `src/web/e2e/source-picker-drawer.spec.ts`.

### 5.3 S1c Bottom-sheet primitive

- **Apple**: `#Preview` with sample modal content. No XCTest — `.sheet` is system-tested.
- **Web**: `bottom-sheet.component.spec.ts` — `isOpen.set(true)` renders scrim+sheet DOM; scrim click sets `isOpen` to false; `<ng-content>` projection renders. Drag-to-dismiss → Playwright e2e.

### 5.4 Visual verification (preview tools)

S1 is the first sub-project where the change is observable in the browser preview, so the verification workflow applies (S0a was non-behavioral; S0c didn't render anything new).

1. `preview_start name="maple"` (existing `launch.json` entry).
2. `preview_resize` preset `mobile` (375×812) — verify `<app-phone-tab-shell>` renders, tab bar at bottom, 3 tabs labeled correctly, active tab highlighted, tap each tab switches content.
3. `preview_resize` preset `desktop` — verify pane shell renders (not phone), no tab bar.
4. `preview_resize` width 800 — verify pane shell renders (tablet tier).
5. `preview_screenshot` at each breakpoint — attach to PR description.

Apple: manual smoke test on iPhone 17 Pro sim + Mac + iPad sim.

### 5.5 CI gates (per sub-ticket)

- `bun run test` / `ng test Maple-common` — depends on KTLO PRs [#592](https://github.com/zubair-io/Maple/pull/592) and [#593](https://github.com/zubair-io/Maple/pull/593) merging first for clean baseline.
- `swift test` from `Packages/MapleCore` — same dependency on [#593](https://github.com/zubair-io/Maple/pull/593).
- `xcodebuild` macOS + iPhone 17 Pro sim — `BUILD SUCCEEDED`.
- Prettier clean on changed files.
- File-size budget per `CONTRIBUTING.md`.

### 5.6 TDD discipline

- `TabBarVisibilityService` (signal toggle test before service code)
- `RootShellComponent` layout-switch test (with stubbed `LayoutService`) before component code
- `source-picker-drawer.component` event-emission tests before component code
- `bottom-sheet.component` open/close + content projection tests before component code

`PhoneTabShell` (Apple) and Apple drawer/sheet are mostly composition — rely on previews + manual sim.

---

## 6. Risks & open questions

### Risks

1. **`cm.tab` key collision.** Existing `cm.tab` may already store the desktop Detail-panel tab (Browse / Color / Meta / Scopes). PhoneTabShell wants to reuse it for shell tab. Mitigation: audit at PR time; if collision, introduce `cm.tab.shell` for phone and keep `cm.tab` for Detail panel.
2. **TabView + per-tab NavStack quirks on iOS 17.** `.toolbar(.hidden, for: .tabBar)` has had bugs around reappearing on dismiss. Test on iPhone 17 Pro sim during S1a; fallback (manual `@State` tab bar visibility wrapper) ready.
3. **Existing `AppShellIPhoneShell` / `AppShellIPhoneToolbar` references** elsewhere may break compile when S1a rewires. Grep before deleting; expect zero hits outside files being edited.
4. **iPhone landscape.** Tab bar text collapses in landscape on iOS — acceptable per spec (landscape Editor is out of scope; landscape Library still works).
5. **`maple-syrup` shell wrap shape.** S1a wraps both Angular apps in `RootShellComponent`. If `maple-syrup` has a non-standard root composition, ship `maple` first and file a follow-up.
6. **PWA service-worker (`ngsw-config.json`) routes.** New `/library/loupe/:id` and `/library/editor/:id` patterns may need entries. Update during S1a PR.

### Open questions (resolve during PR work, not blocking the spec)

1. **Tab icons.** Proposed Apple SF Symbols: `photo.on.rectangle.angled` / `magnifyingglass` / `gearshape`; web equivalents via S0c parity table. Designer eyeball at PR time.
2. **`maple-syrup` shell wrap shape** (per Risk 5).
3. **`PhoneLibraryStub` chrome content.** S1a/S1b ship enough Library header to integrate the hamburger + drawer end-to-end (header + filter chips). Real grid = S2.
4. **Search-pill-tap → Search-tab handoff event bus.** S1b's drawer emits "switch to Search tab and focus its field"; S7 receives. Use a `TabSwitchEventService` (signal-based, `maple-common`) or just `router.navigate(['/search'], { queryParams: { autoFocus: 1 } })`? Decide during S1b when S7's surface is concrete.
5. **`cm.tab` collision** (per Risk 1).
