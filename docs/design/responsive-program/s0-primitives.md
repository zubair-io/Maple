# Responsive Program — S0: Primitives

First sub-project of the responsive program (epic [#577](https://github.com/zubair-io/Maple/issues/577)). Establishes the layout signal, token extensions, motion vocabulary, bundled typography, icon parity, and persistence schema that every other sub-project (S1–S7) builds on. Non-behavioral on rendered UI for S0a; S0b shifts existing typography to Lato + Merriweather, which is a visible diff on every screen.

This doc is the contract for three sub-tickets — **S0a Foundation**, **S0b Typography**, **S0c Icons** — each one PR.

---

## 1. Overview & deliverable map

| Ticket  | What ships                                                                                                                                                                                                                                                                                                                                                    | Files touched                                                                                                                                                                                                                                                                                                                                                          | Blocks |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **S0a** | `MapleLayout` env (Apple) + `LayoutService` signal (web) backed by size class + matchMedia. `MapleTokens` / `tokens.scss` / `tokens.ts` gain `borderHi`, `warn`. New `motion.{swift,scss,ts}` with the prompt §4 duration + easing table. `docs/spec/07-ui-architecture.md` updated (breakpoints 768/1024; persistence schema; tab-bar canonical for iPhone). | `src/apple/Packages/MapleCore/Sources/MapleCore/Layout/MapleLayout.swift` (new), `src/apple/Maple/Views/MapleLayoutEnvironment.swift` (new), `src/apple/Maple/Views/DesignTokens.swift`, `src/apple/Maple/Views/AppShell.swift`, `src/web/projects/maple-common/src/lib/{tokens.scss,tokens.ts,layout-service.ts,motion.{ts,scss}}`, `docs/spec/07-ui-architecture.md` | S1–S7  |
| **S0b** | Lato 400 / Lato 700 / Merriweather 700 bundled. Apple registers via `INFOPLIST_KEY_UIAppFonts`. Web `@font-face` with `font-display: swap`. `MapleTokens.Typography` and `tokens.scss` font families switch from SF-fallback to Lato / Merriweather / SF Mono / JetBrains Mono.                                                                               | `src/apple/Maple/Resources/Fonts/{Lato-Regular,Lato-Bold,Merriweather-Bold}.ttf` (new), `src/apple/Maple.xcodeproj/project.pbxproj` (INFOPLIST_KEY_UIAppFonts), `src/apple/Maple/Views/DesignTokens.swift` Typography, `src/web/projects/maple-common/src/assets/fonts/` (new), `src/web/projects/maple-common/src/lib/{fonts.scss,tokens.scss,tokens.ts}`             | none   |
| **S0c** | Parity table doc mapping each chrome glyph to (SF Symbol, web SVG primitive). Web `maple-icon` gains missing glyphs. Tool glyphs (22) deferred to S5.                                                                                                                                                                                                         | `docs/design/responsive-program/s0-icons.md` (new), `src/web/projects/maple-common/src/lib/icons/maple-icon.component.ts`                                                                                                                                                                                                                                              | none   |

S0a unblocks S1–S7. S0b and S0c are independent — can ship in parallel with S1.

**Not in S0:** shell rewrites, new icons not required by a sub-project, token codegen automation (separate KTLO ticket).

---

## 2. S0a — Foundation

### 2.1 Core types

Two concepts, not one:

- **`MapleShellKind`** — _which_ shell renders. `.phoneTab` (iPhone) or `.pane` (iPad, Mac, web ≥768pt).
- **`MapleLayout`** — _what density_ the pane renders at. `.phone` (<768pt), `.tablet` (768–1024pt), `.desktop` (>1024pt).

Apple distinguishes the two: iPhone is always `phoneTab` (regardless of width); iPad / Mac is always `pane`; the pane's density depends on width. A Mac window dragged below 768pt collapses sidebars but **stays pane** (idiom signal beats width signal for power-user resize). Web has no clean idiom signal — web uses `MapleLayout` only, meaning Mac browser <768pt would get the tab-bar shell. Acceptable edge case for v0.1.

### 2.2 Apple — `MapleCore/Layout/MapleLayout.swift`

```swift
public enum MapleShellKind: Equatable { case phoneTab, pane }

public enum MapleLayout: Equatable {
    case phone, tablet, desktop
    public static func from(width: CGFloat) -> MapleLayout {
        if width < 768 { return .phone }
        if width <= 1024 { return .tablet }
        return .desktop
    }
}

public extension MapleShellKind {
    // All idiom checks go through here. Direct UIDevice.userInterfaceIdiom
    // calls are forbidden elsewhere — grep should show zero hits outside this file.
    static var current: MapleShellKind {
        #if os(iOS)
        return UIDevice.current.userInterfaceIdiom == .phone ? .phoneTab : .pane
        #else
        return .pane
        #endif
    }
}

private struct MapleLayoutKey: EnvironmentKey {
    static let defaultValue: MapleLayout = .desktop
}

public extension EnvironmentValues {
    var mapleLayout: MapleLayout {
        get { self[MapleLayoutKey.self] }
        set { self[MapleLayoutKey.self] = newValue }
    }
}
```

Wired at AppShell root via `GeometryReader`:

```swift
struct AppShell: View {
    var body: some View {
        GeometryReader { proxy in
            content
                .environment(\.mapleLayout, MapleLayout.from(width: proxy.size.width))
        }
    }
}
```

`GeometryReader` re-evaluates body on resize. Cheap at root; do not move into hot loops.

Consumers:

```swift
@Environment(\.mapleLayout) var layout
```

### 2.3 Web — `maple-common/src/lib/layout-service.ts`

```ts
import { Injectable, signal, computed } from '@angular/core';

export type MapleLayout = 'phone' | 'tablet' | 'desktop';

@Injectable({ providedIn: 'root' })
export class LayoutService {
  private readonly _width = signal(window.innerWidth);

  readonly layout = computed<MapleLayout>(() => {
    const w = this._width();
    if (w < 768) return 'phone';
    if (w <= 1024) return 'tablet';
    return 'desktop';
  });

  constructor() {
    window.addEventListener('resize', () => this._width.set(window.innerWidth), { passive: true });
  }
}
```

Components consume:

```ts
private layoutService = inject(LayoutService);
protected readonly layout = this.layoutService.layout;
```

### 2.4 Token extensions

Added to all three of `DesignTokens.swift`, `tokens.scss`, `tokens.ts` (kept in lockstep manually, as today):

| Token      | Value     | Use                                                                                                                                                                             |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `borderHi` | `#5a5552` | Active ticks (drag-bar center tick), grab handles. Derived one tier up from existing `border = #44403c`. Provisional; designer eyeball during PR may push to a different shade. |
| `warn`     | `#fbbf24` | Low-confidence person detection chips, future warning states. Tailwind amber-400.                                                                                               |

No rename of existing tokens. No value re-tier of `bg`, `surface`, `primary`, etc.

### 2.5 Motion tokens

New `MapleTokens.Motion` (Swift) and `motion.scss` / `motion.ts` (web). Token names + values per prompt §4:

| Token          | Duration | Easing                                                              |
| -------------- | -------- | ------------------------------------------------------------------- |
| `drawer`       | 240ms    | `cubic-bezier(0.22, 1, 0.36, 1)` (already `--ease-default`)         |
| `push`         | 320ms    | iOS system: SwiftUI `.snappy`; web `cubic-bezier(0.32, 0.72, 0, 1)` |
| `sheetPresent` | 320ms    | iOS system                                                          |
| `sheetDismiss` | 280ms    | iOS system                                                          |
| `groupSwap`    | 120ms    | `ease-in-out`                                                       |
| `chromeHide`   | 180ms    | `ease-out`                                                          |
| `filterFade`   | 120ms    | `linear`                                                            |

Apple wires as `Animation` factories. Web exposes paired `--motion-X-ms` and `--motion-X-ease` CSS custom properties.

### 2.6 Persistence schema

Documented here; implementations land in S1+ as each consumer is built. No code in S0a.

| Key               | Type                                  | Used by        | Reuse / new    |
| ----------------- | ------------------------------------- | -------------- | -------------- |
| `cm.source`       | string (source id)                    | S2 (Library)   | **new**        |
| `cm.filter`       | string (chip id)                      | S2             | reuse existing |
| `cm.full.id`      | string (image id)                     | S4 (Loupe)     | **new**        |
| `cm.editor.armed` | JSON `Record<imageId, {group, tool}>` | S5 (Editor)    | **new**        |
| `cm.filmstrip`    | boolean                               | S5             | **new**        |
| `cm.detailHidden` | boolean (inspector visibility)        | S6 (Inspector) | reuse existing |
| `cm.leftHidden`   | boolean (sidebar visibility)          | S3 (Sidebar)   | reuse existing |

### 2.7 Spec doc edits — `docs/spec/07-ui-architecture.md`

1. **Line 13** (iPhone shell description) — no change. Already says tab bar + swipe-up detail sheet.
2. **Line 14** (Web shell description) — replace with: _"Web: single responsive shell. Phone tier (<768pt) renders the tab-bar shell; tablet (768–1024pt) and desktop (>1024pt) render the three-column pane shell. `LayoutService` (maple-common) is the single source of truth for breakpoint."_
3. **Line 64** (Resize rules) — replace with: _"Breakpoints: <768pt = phone (tab-bar shell); 768–1024pt = tablet (pane shell, sidebar + main + collapsible inspector); >1024pt = desktop (all three columns expanded). Layout signal: `MapleLayout` env (Apple) / `LayoutService.layout()` signal (web)."_
4. **New "Persistence keys" section** below state-ownership — the table in §2.6.

### 2.8 Files touched (S0a PR)

| File                                                                      | Change                                                                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Layout/MapleLayout.swift` | **new** — pure enums in §2.2 (no SwiftUI dependency)                                                                                     |
| `src/apple/Maple/Views/MapleLayoutEnvironment.swift`                      | **new** — SwiftUI `EnvironmentKey` + `EnvironmentValues.mapleLayout` extension (kept in the app target so MapleCore stays headless-safe) |
| `src/apple/Maple/Views/DesignTokens.swift`                                | add `borderHi`, `warn` to `MapleTokens`; add `MapleTokens.Motion`                                                                        |
| `src/apple/Maple/Views/AppShell.swift`                                    | wire `GeometryReader` + `.environment(\.mapleLayout, ...)`; no shell rewrite                                                             |
| `src/web/projects/maple-common/src/lib/tokens.scss`                       | add `--color-border-hi`, `--color-warn`, SCSS aliases                                                                                    |
| `src/web/projects/maple-common/src/lib/tokens.ts`                         | mirror additions                                                                                                                         |
| `src/web/projects/maple-common/src/lib/layout-service.ts`                 | **new**                                                                                                                                  |
| `src/web/projects/maple-common/src/lib/motion.ts` + `motion.scss`         | **new**                                                                                                                                  |
| `docs/spec/07-ui-architecture.md`                                         | edits 1–4 above                                                                                                                          |

S0a is non-behavioral on rendered UI. Env / signal exists; no view branches on it yet.

---

## 3. S0b — Typography

### 3.1 Fonts to bundle

| Face                   | Weight | License     | Apple                            | Web                                |
| ---------------------- | ------ | ----------- | -------------------------------- | ---------------------------------- |
| Lato-Regular           | 400    | SIL OFL 1.1 | bundle .ttf (~74KB)              | bundle .woff2 (~25KB Latin subset) |
| Lato-Bold              | 700    | SIL OFL 1.1 | bundle .ttf (~73KB)              | bundle .woff2 (~24KB Latin subset) |
| Merriweather-Bold      | 700    | SIL OFL 1.1 | bundle .ttf (~76KB)              | bundle .woff2 (~30KB Latin subset) |
| JetBrains Mono Regular | 400    | Apache 2.0  | not bundled (SF Mono via system) | bundle .woff2 (~30KB Latin subset) |

Apple bundle weight: ~223KB. Web first-paint critical: ~109KB woff2. Sources: Google Fonts (Lato, Merriweather) and the JetBrains Mono repo. Subset to Latin only via `pyftsubset` or equivalent.

### 3.2 Apple side

- Drop `.ttf` files into `src/apple/Maple/Resources/Fonts/`.
- Per CLAUDE.md ("do not create an Info.plist file; use `INFOPLIST_KEY_*`"), edit `project.pbxproj` build settings:
  ```
  INFOPLIST_KEY_UIAppFonts = (
      "Fonts/Lato-Regular.ttf",
      "Fonts/Lato-Bold.ttf",
      "Fonts/Merriweather-Bold.ttf",
  );
  ```
- Path syntax (relative to Resources root) verified at PR time; may need adjustment.
- `MapleTokens.Typography` enum migrated to prompt §4 mapping with `Font.custom(...)`. Existing names (`title`, `sectionHeader`, `groupHeader`, `row`) renamed to prompt vocabulary (`sourceTitle`, `eyebrow`, `sheetTitle`, `rowLabel`) **with call-site renames in the same PR**. Pre-PR `grep` confirms the count is small; if it explodes, fall back to one-cycle deprecation aliases.

### 3.3 Web side

- Drop `.woff2` files into `src/web/projects/maple-common/src/assets/fonts/`.
- New `src/web/projects/maple-common/src/lib/fonts.scss` with `@font-face` declarations.
- Imported once from `tokens.scss` so both `projects/maple` and `projects/maple-syrup` inherit via their existing `styles.scss` → `tokens.scss` chain.
- `font-display: swap` (W3C-recommended; overrides the prompt's "first paint never falls back" wording — see §6).
- `tokens.scss` font families updated:
  ```scss
  --font-sans:
    'Lato', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', sans-serif;
  --font-serif: 'Merriweather', Georgia, 'Times New Roman', serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace;
  ```
- Per-typography Tailwind theme tokens added so `text-source-title`, `text-eyebrow`, etc. become Tailwind utility classes (consistent with existing `@theme` pattern).

### 3.4 Typography enum mapping

Apple `MapleTokens.Typography` after S0b:

| Name          | Family            | Size | Weight | Notes                                            |
| ------------- | ----------------- | ---- | ------ | ------------------------------------------------ |
| `sourceTitle` | Merriweather-Bold | 28   | 700    | tracking -0.5 at call site via `.tracking(-0.5)` |
| `sheetTitle`  | Merriweather-Bold | 17   | 700    |                                                  |
| `body`        | Lato-Regular      | 13   | 400    |                                                  |
| `rowLabel`    | Lato-Regular      | 14   | 400    |                                                  |
| `toolLabel`   | Lato-Regular      | 10   | 400    |                                                  |
| `chipLabel`   | Lato-Bold         | 11   | 700    |                                                  |
| `eyebrow`     | Lato-Bold         | 10   | 700    | 0.14em tracking, uppercase at call site          |
| `valueChip`   | SF Mono           | 11   | 400    | `.monospacedDigit()`                             |
| `filename`    | SF Mono           | 12   | 400    |                                                  |

Web equivalents are Tailwind `--text-*` theme tokens with matching family/size/weight.

### 3.5 Rollout caveats

- Body text shifts SF Pro → Lato. Visible everywhere.
- Headers shift sans-serif → Merriweather serif. Loud visual change.
- Web mono shifts SF Mono → JetBrains Mono on non-Apple devices. Consistent across browsers.
- Existing UITest goldens (`MapleUITests`, `SliderMatrixUITests`) are canvas-only crops → no chrome → no golden changes expected. Run both after S0b lands.
- Ship S0b in its own PR (no other UI changes mixed in) so the visual diff is reviewable.

### 3.6 Files touched (S0b PR)

| File                                                                         | Change                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/apple/Maple/Resources/Fonts/Lato-Regular.ttf`                           | **new**                                                            |
| `src/apple/Maple/Resources/Fonts/Lato-Bold.ttf`                              | **new**                                                            |
| `src/apple/Maple/Resources/Fonts/Merriweather-Bold.ttf`                      | **new**                                                            |
| `src/apple/Maple.xcodeproj/project.pbxproj`                                  | `INFOPLIST_KEY_UIAppFonts` entries                                 |
| `src/apple/Maple/Views/DesignTokens.swift`                                   | Typography enum migrated per §3.4                                  |
| `src/web/projects/maple-common/src/assets/fonts/Lato-Regular.woff2`          | **new**                                                            |
| `src/web/projects/maple-common/src/assets/fonts/Lato-Bold.woff2`             | **new**                                                            |
| `src/web/projects/maple-common/src/assets/fonts/Merriweather-Bold.woff2`     | **new**                                                            |
| `src/web/projects/maple-common/src/assets/fonts/JetBrainsMono-Regular.woff2` | **new**                                                            |
| `src/web/projects/maple-common/src/lib/fonts.scss`                           | **new** — `@font-face` block                                       |
| `src/web/projects/maple-common/src/lib/tokens.scss`                          | font-family vars updated; import fonts.scss; new `--text-*` tokens |
| `src/web/projects/maple-common/src/lib/tokens.ts`                            | mirror updates                                                     |

---

## 4. S0c — Icons

### 4.1 Scope

Two icon categories in the program:

- **Chrome glyphs** (~14 unique): navigation chevrons, action icons, source-kind icons. Most map cleanly to SF Symbols on Apple. **S0c ships these.**
- **Tool glyphs** (~22): Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Temp, Tint, Vibrance, Saturation, HSL, Clarity, Texture, Dehaze, Vignette, Grain, Split tone, Sharpen, Noise, Color NR, Crop, Presets. SF Symbols has no Lightroom-style photo-editing glyphs — custom illustration required. **Deferred to S5 (Editor)** with a follow-up issue created by S0c.

### 4.2 Parity table

Lives at `docs/design/responsive-program/s0-icons.md` (created by S0c PR). Format:

| Spec name              | Used in                      | Apple (SF Symbol)            | Web (maple-icon name)            |
| ---------------------- | ---------------------------- | ---------------------------- | -------------------------------- |
| `back`                 | Editor / Loupe header        | `chevron.left`               | `chevron-left`                   |
| `overflow`             | Library header right         | `ellipsis`                   | `ellipsis-horizontal`            |
| `close-x`              | Sidebar collapse, Info sheet | `xmark`                      | `close-x`                        |
| `share`                | Loupe / Editor header (stub) | `square.and.arrow.up`        | `share-up-square`                |
| `undo`                 | Editor header                | `arrow.uturn.backward`       | `undo-uturn`                     |
| `redo`                 | Editor header (long-press)   | `arrow.uturn.forward`        | `redo-uturn`                     |
| `info`                 | Loupe / Editor header        | `info.circle`                | `info-circle`                    |
| `search`               | Sidebar pill                 | `magnifyingglass`            | `magnifying-glass`               |
| `clear-circle`         | Search field trailing        | `xmark.circle.fill`          | `clear-circle-fill`              |
| `plus`                 | Add album header             | `plus`                       | `plus`                           |
| `eyedropper`           | Color tab WB                 | `eyedropper`                 | `eyedropper`                     |
| `folder-source`        | Sidebar                      | `folder`                     | `folder-source`                  |
| `smart-source`         | Sidebar                      | `wand.and.stars`             | `smart-source-wand`              |
| `album`                | Sidebar                      | `rectangle.stack.fill`       | `album-stack`                    |
| `place`                | Search top hit               | `mappin.circle.fill`         | `place-pin`                      |
| `keyword`              | Search top hit, Info chip    | `number`                     | `keyword-hash`                   |
| `person`               | Search top hit               | `person.crop.circle.fill`    | `person-circle`                  |
| `pick-dot` (primitive) | Grid badge, Info pill        | drawn as `Circle`, no glyph  | drawn as `<div>`, no glyph       |
| `star` (existing)      | Grid badge, ratings          | `star.fill` (in `StarView`)  | (existing)                       |
| `flag-pick` (existing) | Info pill                    | `flag.fill` (in `FlagBadge`) | (existing or new web equivalent) |

`hamburger` (`line.3.horizontal`) is N/A: phone uses tab bar, tablet/desktop sidebar is always-on.

### 4.3 Web SVG conventions

For glyphs added to `maple-icon`: viewBox `"0 0 16 16"`, `stroke="currentColor"`, `stroke-width="1.6"`, `stroke-linecap="round"`, `stroke-linejoin="round"`. Naming convention audited against existing `maple-icon.component.ts` glyphs at PR time (kebab-case vs camelCase).

### 4.4 Follow-up issue

S0c PR creates GH issue: _"Design 22 photo-tool glyphs for editor pill row (Exposure, Contrast, Highlights, …)"_ — owned by S5 (Editor). S0c is not blocked on this.

### 4.5 Files touched (S0c PR)

| File                                                                  | Change                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `docs/design/responsive-program/s0-icons.md`                          | **new** — full parity table                                   |
| `src/web/projects/maple-common/src/lib/icons/maple-icon.component.ts` | add missing SVG paths (specific list audited when writing PR) |

---

## 5. Testing strategy

### 5.1 S0a — Foundation

- **`MapleLayout.from(width:)`** — TDD-friendly pure function. Swift XCTest in `Packages/MapleCore`: assert `767 → .phone`, `768 → .tablet`, `1024 → .tablet`, `1025 → .desktop`, plus boundary fuzz. Web: Angular `TestBed` test for `LayoutService.layout()` with a stubbed window-width signal, same cases.
- **`MapleShellKind.current`** — Swift test stubbing `UIUserInterfaceIdiom`; on macOS-only build, assert `.pane`.
- **Token additions** — no behavioral test. Extend `DesignTokens.swift` `#Preview` block with `borderHi` + `warn` swatches.
- **Motion tokens** — no behavioral test.
- **Persistence schema, spec doc** — no test.

S0a is non-behavioral on rendered UI. Skip preview-tool verification; unit tests + `bun run lint` + `xcodebuild build` are the gate.

### 5.2 S0b — Typography

- **Apple font registration** — `MapleCoreTests`: `XCTAssertNotNil(UIFont(name: "Lato-Regular", size: 14))`, same for `Lato-Bold`, `Merriweather-Bold`. Catches silent SwiftUI fallback when registration fails.
- **Web font registration** — Angular test: assert `document.fonts.check('400 14px Lato')` after `await document.fonts.ready`. If `document.fonts` is unavailable in jsdom, defer to a Playwright e2e in `src/web/e2e/`.
- **UITest goldens** — `MapleUITests` and `SliderMatrixUITests` are canvas-only crops; no expected changes. Run both after S0b lands; any failure means a stray chrome leak in the crop.
- **Visual diff** — run preview server, screenshot Library grid + Editor before/after, attach to PR description.

### 5.3 S0c — Icons

- **Web component tests** — one Angular test per added glyph: render `<maple-icon name="X">`, assert SVG path attribute matches expected string. Tiny, mechanical, catches typos in path data.
- **Apple side** — no test. SF Symbol references are compile-time-checked; wrong name shows a question mark at runtime, caught by smoke test or future chrome UITest.
- **Parity table doc** — no test. Reviewer reads.

### 5.4 CI gates (all three sub-tickets)

- `bun run lint` + `bun run test` in `src/web/`
- `xcodebuild build` for `Maple Exposure` scheme on `platform=macOS` and `platform=iOS Simulator,name=iPhone 17 Pro` (specific simulator, **not** `generic/platform=iOS Simulator` — the xcframework sim slice is arm64-only per CLAUDE.md)
- `swift test` in `src/apple/Packages/MapleCore`
- Color pipeline harness (`src/scripts/test_color_pipeline.sh`) — skip-passes without fixtures; must not regress on the CI runner that has fixtures
- File-size budget per `CONTRIBUTING.md` (per recent commits like #566 / #571)

### 5.5 TDD discipline

`MapleLayout.from(width:)`, `LayoutService.layout()`, and `maple-icon` new-glyph rendering tests are written **before** their implementations.

---

## 6. Risks & open questions

### Risks

1. **Web font weight (~109KB woff2) eats ~3.6% of the 3MB initial-bundle warning budget** (per `angular.json`). Tolerable; track if bundle creeps past warning.
2. **`font-display: swap` causes layout shift** when Lato/Merriweather swap in over SF fallback. Mitigation: a follow-up ticket adds `size-adjust`, `ascent-override`, `descent-override` to `@font-face` to match fallback metrics. Punted from S0b.
3. **`GeometryReader` at AppShell root re-evaluates body on resize.** Cheap at root; documented so future devs don't move it into a hot loop.
4. **Direct `UIDevice.userInterfaceIdiom` calls leak** if a developer forgets to go through `MapleShellKind.current`. Mitigation: post-rename grep should show zero references outside `MapleShellKind.swift`; comment in that file says so.
5. **Existing UITest goldens may surface a chrome leak** after S0b. Re-record per CLAUDE.md if so.
6. **Apple `INFOPLIST_KEY_UIAppFonts` path syntax** — Xcode docs are slightly ambiguous on whether the path is relative to Resources root. Verify at PR time; fall back to bare filename if needed.
7. **iOS simulator destination caveat** (CLAUDE.md) — PR author must pass `-destination 'platform=iOS Simulator,name=iPhone 17 Pro'`, not `generic/platform=iOS Simulator`.

### Open questions (resolved during PR work, not blocking the spec)

1. **`borderHi = #5a5552` exact value** — derived from `border + 0x14`. Designer eyeball during PR may push to a different shade.
2. **Apple `MapleTokens.Typography` rename atomicity** — proposed atomic in S0b PR. If pre-PR grep shows unexpectedly many call sites, fall back to one-cycle deprecation aliases.
3. **Tool icon (22 glyphs) ownership** — deferred to S5; tracked by S0c follow-up issue.
4. **iPad split-screen / Stage Manager** — `MapleShellKind.current == .pane` for any iPad, regardless of split-screen width. Acceptable for v0.1; future ticket for narrow-iPad pane optimization.
5. **Audit web `maple-icon` naming convention before adding glyphs** — kebab-case vs camelCase. Mechanical PR-time check.
