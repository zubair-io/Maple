# Web Responsive (One Tree, No Shell Fork) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web app a single responsive component tree that reflows from desktop down to phone width, retiring the 768px phone-tab shell fork.

**Architecture:** `RootShellComponent` stops switching shells and always renders `<router-outlet>`. The pane shells (Browse/Search/Settings/Editor/Preview) become fluid via CSS `@media` (visual reflow) and `LayoutService` (structural drawer/sheet switches). Phone navigation is the collapsed desktop chrome (sidebar→drawer, toolbar→overflow), not a bottom-nav.

**Tech Stack:** Angular 21 standalone components, signals, RxJS at the service layer; SCSS with `@media`; Tailwind utility classes in some templates; Vitest (`ng test`) + Playwright; Prettier as the only style gate.

## Global Constraints

- Breakpoints are single-sourced in `layout-service.ts`: `<768` phone, `768–1024` tablet, `>1024` desktop. Do NOT introduce new thresholds; `@media` cutoffs must be `max-width: 767px` and `max-width: 1023px` to match.
- Components must not read `window.innerWidth` directly — use `LayoutService.layout()` (the one exception being code being deleted).
- Standalone components, `input()`/`output()`, separate `.ts`/`.html`/`.scss`, OnPush. Observables at the service layer, view models in components (`docs/best-practices.md` § Angular).
- Prefer `const`/immutable style; early-return guards over mutation.
- Prettier: run pinned `./src/web/node_modules/.bin/prettier` over the full diff (`main...HEAD`), including new files.
- No `git add -A` in the worktree — stage explicit paths. Check `git status` before every commit.
- File-size budget (`CONTRIBUTING.md`) is a hard gate — if a change pushes a file over, split it in the same task.
- Every PR closes a GitHub ticket (`Closes #N`). Open PRs ready-for-review, not draft. Rebase-clean branches.
- Web tests: `cd src/web && bun run test` runs `ng test maple`. Sync raw-wasm first only if WASM changed (it does not here).
- Do NOT pipe long `bun`/`ng` output through `tail` (watchdog kills piped long-compiles).

---

## Task 1: Foundation — drop the shell fork

**Closes:** epic child "Foundation: retire phone-tab fork, consolidate routes, unify Editor breakpoint".

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/shells/root-shell.component.ts`
- Modify: `src/web/projects/maple-common/src/lib/shells/root-shell.component.spec.ts`
- Modify: `src/web/projects/maple/src/app/app.routes.ts`
- Modify: `src/web/projects/maple-syrup/src/app/app.routes.ts`
- Modify: `src/web/projects/maple-common/src/lib/shells/editor-shell/editor-shell-chrome.ts`
- Modify: `src/web/projects/maple-common/src/lib/shells/editor-shell/editor-shell.component.ts` (breakpoint wiring)
- Modify: `src/web/projects/maple-common/src/public-api.ts` (remove dead exports at 113-115)
- Delete: `phone-tab-shell.component.{ts,html,scss,spec.ts}`, `phone-library-stub.component.ts`, `phone-search-stub.component.ts`, `phone-settings-stub.component.ts`, `tab-bar-visibility.service.{ts,spec.ts}` (all under `maple-common/src/lib/shells/`)

**Interfaces:**

- Produces: `RootShellComponent` renders only `<router-outlet />` + `<maple-update-toast />` + `<maple-lan-switch-banner />`.
- Produces: `EditorShellComponent` keeps its `isTabletPlus`/`isDesktop` writable signals but they are now driven by `LayoutService.layout()` (`isTabletPlus = layout() !== 'phone'`, `isDesktop = layout() === 'desktop'`).
- Removes: `PhoneTabShellComponent`, `PhoneLibraryStubComponent`, `PhoneSearchStubComponent`, `PhoneSettingsStubComponent`, `TabBarVisibilityService` from the public API.

- [ ] **Step 1: Rewrite the RootShell spec to the new contract (failing first)**

Replace `root-shell.component.spec.ts` body so it asserts the fork is gone:

```typescript
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RootShellComponent } from './root-shell.component';

describe('RootShellComponent', () => {
  let fixture: ComponentFixture<RootShellComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RootShellComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    fixture = TestBed.createComponent(RootShellComponent);
    fixture.detectChanges();
  });

  it('always renders the pane router-outlet (no phone-tab fork)', () => {
    expect(fixture.nativeElement.querySelector('router-outlet')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-phone-tab-shell')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd src/web && bunx vitest run projects/maple-common/src/lib/shells/root-shell.component.spec.ts`
Expected: FAIL (RootShell still imports/renders `app-phone-tab-shell`).

- [ ] **Step 3: Simplify RootShellComponent**

In `root-shell.component.ts` remove the `LayoutService`/`PhoneTabShellComponent` imports and the `@if` branch. New template + class body:

```typescript
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { UpdateToastComponent } from '../sw/update-toast.component';
import { LanSwitchBannerComponent } from '../network/lan-switch-banner.component';

@Component({
  selector: 'app-root-shell',
  standalone: true,
  imports: [RouterOutlet, UpdateToastComponent, LanSwitchBannerComponent],
  template: `
    <router-outlet />
    <maple-update-toast />
    <maple-lan-switch-banner />
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RootShellComponent {}
```

- [ ] **Step 4: Delete the phone-shell files and de-export**

```bash
cd src/web/projects/maple-common/src/lib/shells
git rm phone-tab-shell.component.ts phone-tab-shell.component.html phone-tab-shell.component.scss phone-tab-shell.component.spec.ts \
       phone-library-stub.component.ts phone-search-stub.component.ts phone-settings-stub.component.ts \
       tab-bar-visibility.service.ts tab-bar-visibility.service.spec.ts
```

Then remove lines 113-115 (the three `phone-*-stub` exports) and any `phone-tab-shell` / `tab-bar-visibility` export from `public-api.ts`. Grep to confirm none remain: `grep -rn "PhoneTabShell\|PhoneLibraryStub\|PhoneSearchStub\|PhoneSettingsStub\|TabBarVisibility\|tab-bar-visibility\|phone-tab-shell" projects/maple-common/src` returns nothing.

- [ ] **Step 5: Consolidate routes (maple)**

In `projects/maple/src/app/app.routes.ts`, replace the `library` route with a redirect and delete the phone-tab route comment block:

```typescript
  { path: 'library', redirectTo: 'browse', pathMatch: 'full' },
```

Keep `{ path: 'library/loupe/:id', redirectTo: 'view/:id' }`. Keep `/search`, `/settings`, `/browse`, `/edit`, `/view` as-is.

- [ ] **Step 6: Consolidate routes + drop the stub (maple-syrup)**

In `projects/maple-syrup/src/app/app.routes.ts`: remove the `PhoneSettingsStubComponent` import; change `{ path: 'library', component: LibraryPageComponent }` to `{ path: 'library', redirectTo: 'browse', pathMatch: 'full' }`; change `{ path: 'settings', component: PhoneSettingsStubComponent }` to `{ path: 'settings', redirectTo: 'browse', pathMatch: 'full' }` as a temporary target (Task 5 replaces this with a real Hosted settings page). Leave a comment: `// Hosted settings surface lands in the responsive-Hosted ticket; redirect until then.`

- [ ] **Step 7: Move EditorShell onto LayoutService**

In `editor-shell-chrome.ts` `setupResponsive`, stop reading `window.innerWidth`. Change its signature to take the layout getter and derive the two signals from it. Replace lines 81-109 body:

```typescript
export function setupResponsive(
  shell: EditorShellComponent,
  state: ChromeRecedeState,
  layout: () => 'phone' | 'tablet' | 'desktop',
): void {
  const update = () => {
    const wasDesktop = shell.isDesktop();
    const l = layout();
    shell.isTabletPlus.set(l !== 'phone');
    shell.isDesktop.set(l === 'desktop');
    if (l === 'desktop') {
      clearRecedeTimer(state);
      shell.chromeState.set('full');
    } else if (wasDesktop) {
      shell.chromeState.set('full');
      restartRecedeTimer(shell, state);
    }
  };
  // React to layout signal changes. The shell owns an effect that calls this.
  update();
  if (!shell.isDesktop()) {
    shell.chromeState.set('full');
    restartRecedeTimer(shell, state);
  }
}
```

In `editor-shell.component.ts`: inject `LayoutService`, and where `setupResponsive(this, this.chromeRecedeState)` was called, wrap the `update` in an Angular `effect(() => setupResponsive(this, this.chromeRecedeState, this.layout.layout))` (or call `setupResponsive` once and add a separate `effect` that re-runs the `isTabletPlus`/`isDesktop` derivation on `layout()` change). Remove the `resizeObserver` field usage in `setupResponsive` (the `ResizeObserver` on `documentElement` is replaced by the layout signal). Keep `resizeObserver` teardown code if the field is still used elsewhere; otherwise remove it from `ChromeRecedeState` and its teardown. Read `editor-shell.component.ts` to wire this correctly — the shell already injects services and uses `effect`.

- [ ] **Step 8: Run the RootShell spec + full maple-common shells specs**

Run: `cd src/web && bunx vitest run projects/maple-common/src/lib/shells`
Expected: PASS (RootShell new contract green; no references to deleted stubs). Fix any editor-shell spec that asserted the old 1100 desktop threshold — update expectations to the LayoutService thresholds (desktop = >1024).

- [ ] **Step 9: Typecheck + build both apps**

Run: `cd src/web && bunx ng build maple` then `bunx ng build maple-syrup`
Expected: both succeed. Fix any dangling imports of deleted symbols.

- [ ] **Step 10: Prettier + commit**

```bash
cd src/web && ./node_modules/.bin/prettier --check $(git diff --name-only main...HEAD -- '*.ts' '*.html' '*.scss')
git add -- projects/maple-common/src/lib/shells projects/maple-common/src/public-api.ts projects/maple/src/app/app.routes.ts projects/maple-syrup/src/app/app.routes.ts
git commit -m "feat(web): retire phone-tab shell fork; one responsive tree (Closes #<foundation>)"
```

---

## Task 2: BrowseShell fluid — sidebar drawer + toolbar overflow

**Closes:** epic child "BrowseShell: collapsible source sidebar + toolbar overflow".
**Depends on:** Task 1 (fork gone, so BrowseShell now renders at phone width).

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.{ts,html,scss}`
- Reuse: `src/web/projects/maple-common/src/lib/shells/source-picker-drawer/source-picker-drawer.component.ts`
- Test: `browse-shell.component.spec.ts` (create or extend)

**Interfaces:**

- Consumes: `LayoutService.layout()`; `SourcePickerDrawerComponent` (two-way `isOpen` model + source-row/search outputs — read its file for exact API).

- [ ] **Step 1: Failing spec — sidebar is a drawer at phone width**

Add to `browse-shell.component.spec.ts` a test that stubs `LayoutService.layout` to `'phone'` and asserts the always-on `220px` sidebar is NOT rendered inline and the hamburger toggle IS rendered; and at `'desktop'` the inline sidebar IS rendered. (Model the stub on `root-shell.component.spec.ts`'s `signal`-based `StubLayoutService`.) Assert via a data-testid you add to the sidebar container (`[attr.data-testid]="'source-sidebar'"`) and the hamburger button (`data-testid="source-drawer-toggle"`).

- [ ] **Step 2: Run, verify fail**

Run: `cd src/web && bunx vitest run projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.spec.ts`
Expected: FAIL (no `LayoutService` usage, no hamburger).

- [ ] **Step 3: Wire LayoutService + drawer state into the component**

In `browse-shell.component.ts`: inject `LayoutService`, expose `protected readonly layout = this.layoutService.layout;` and a `sourceDrawerOpen = signal(false)` with an `openSourceDrawer()`/`closeSourceDrawer()`. Import `SourcePickerDrawerComponent`.

- [ ] **Step 4: Template — conditional sidebar vs drawer**

In `browse-shell.component.html`: keep the inline sidebar (line ~206) but guard it with `@if (layout() === 'desktop' || layout() === 'tablet')`; its width becomes `@media`-driven (Step 6) rather than the inline `220px`/`0px` style — replace `[style.width]` with a class `.source-sidebar` (and keep the existing collapse toggle for desktop). Add, for phone, `@if (layout() === 'phone') { <button data-testid="source-drawer-toggle" class="hamburger" (click)="openSourceDrawer()" aria-label="Open sources">…</button> }` in the toolbar, and mount `<app-source-picker-drawer [(isOpen)]="sourceDrawerOpen" (…outputs…) />` (wire outputs to the same handlers the inline tree uses). Add `data-testid="source-sidebar"` to the sidebar container.

- [ ] **Step 5: Toolbar overflow menu**

In the toolbar, wrap the action pills (Edit Metadata, Merge to panorama, Copy/Paste/Sync Settings, Export) so that below `1024px` they collapse into a single kebab `<button>` that toggles a menu listing the same actions. Implement with a `signal` `overflowOpen` and an `@if (layout() === 'desktop') { …inline pills… } @else { …kebab + menu… }`. Reuse existing click handlers — do not duplicate logic. Give the search input a `.toolbar-search` class and drop `min-w-[220px]` (Step 6 handles its responsive width).

- [ ] **Step 6: SCSS — responsive widths**

In `browse-shell.component.scss` add:

```scss
.source-sidebar {
  width: 240px;
}
@media (max-width: 1023px) {
  .source-sidebar {
    width: 196px;
  }
}
.toolbar-search {
  min-width: 0;
  flex: 0 1 300px;
  max-width: 340px;
}
@media (max-width: 767px) {
  .toolbar-search {
    flex: 1 1 auto;
    max-width: none;
  }
}
```

Ensure the toolbar row can wrap or scroll rather than overflow: give the toolbar `min-width: 0` and `flex-wrap: wrap` (or `overflow-x: auto`) under `max-width: 767px`. Verify against `docs/ui-spec.md` tokens for spacing.

- [ ] **Step 7: Run spec, verify pass**

Run: `cd src/web && bunx vitest run projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.spec.ts`
Expected: PASS.

- [ ] **Step 8: Playwright visual check at 3 widths**

With the dev server running (see Task 6 Verification block), drive Browse at 375 / 900 / 1440px; assert `document.documentElement.scrollWidth <= clientWidth` (no horizontal overflow) at each, and that the source drawer opens on hamburger tap at 375px. Screenshot each.

- [ ] **Step 9: Prettier + build + commit**

Run: `cd src/web && bunx ng build maple` and prettier --check on the diff. Commit staging explicit browse-shell paths: `git commit -m "feat(web): make BrowseShell fluid — source drawer + toolbar overflow (Closes #<browse>)"`.

---

## Task 3: Search fluid — /search grid + /search/advanced collapse

**Closes:** epic child "Search: responsive /search grid + collapsible advanced filters".
**Depends on:** Task 1.

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/search/search.component.scss`
- Modify: `src/web/projects/maple-common/src/lib/search/photo-results-section.component.scss`
- Modify: `src/web/projects/maple/src/app/search/search.component.{html,scss}` (advanced page)
- Test: extend the nearest existing search spec, or add `search.component.spec.ts` in maple-common.

- [ ] **Step 1: `/search` grid + max-width (no test-first — pure CSS reflow)**

In `photo-results-section.component.scss:35` replace `grid-template-columns: repeat(3, 1fr);` with `grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));`. In `search.component.scss` `.search` add `max-width: 1100px; margin-inline: auto;` so the phone column doesn't stretch on wide monitors, and a `@media (max-width: 767px) { .search { max-width: none; padding: 12px; } }`.

- [ ] **Step 2: `/search/advanced` — collapsible sidebar + wrapping toolbar**

In `projects/maple/src/app/search/search.component.html`: change the fixed `<aside class="w-[260px] flex-shrink-0 …">` (line ~91) so below `1024px` it becomes an overlay/collapsible panel toggled by a "Filters" button; keep it inline at desktop. Make the top toolbar row (lines ~3-58) `flex-wrap` and give the search box `min-w-0`. Add a `layout()`-driven `@if` for the sidebar (inject `LayoutService`). Do not touch the stubbed scope-chip/top-hits logic.

- [ ] **Step 3: SCSS for advanced page**

Add `@media (max-width: 1023px)` rules so the aside is `position: absolute; inset-block: 0; left: 0; width: min(300px, 85vw);` with a scrim, and `.toolbar { flex-wrap: wrap; row-gap: 8px; }`.

- [ ] **Step 4: Build + Playwright check**

Run: `cd src/web && bunx ng build maple`. Drive `/search` and `/search/advanced` at 375/900/1440px; assert no horizontal overflow; the advanced filter panel toggles at narrow width. Screenshot.

- [ ] **Step 5: Prettier + commit**

Commit staging the explicit search paths: `git commit -m "feat(web): responsive search — fluid grid + collapsible advanced filters (Closes #<search>)"`.

---

## Task 4: Settings phone verify/fix

**Closes:** epic child "Settings: fix phone tab-bar overlaps (verify post-fork)".
**Depends on:** Task 1.

**Files:**

- Modify: `src/web/projects/maple/src/app/settings/settings-shell.component.scss` (`height:100vh` → `100%`)
- Modify: `src/web/projects/maple/src/app/settings/people/people.component.scss` (bulk toolbar offset)

- [ ] **Step 1: Fix the shell height**

In `settings-shell.component.scss:15-20` change `height: 100vh; min-height: 100vh;` to `height: 100%; min-height: 0;` so the shell fills its router-outlet container rather than the full viewport (the bottom tab bar is gone, but 100vh still over-extends inside the flex root). Verify `.page` still scrolls (`overflow-y: auto`).

- [ ] **Step 2: Verify People bulk toolbar**

Read `people.component.scss:763-777`. The mobile `bottom: 12px` was occluded by the 56px tab bar which no longer exists — confirm the toolbar is now visible at phone width. If it still overlaps the browser chrome, keep `bottom: 12px` + add `padding-bottom: env(safe-area-inset-bottom)`. No functional change if already correct — note that in the commit.

- [ ] **Step 3: Playwright check at phone width**

Drive `/settings/workers` and `/settings/people` at 375px; assert the last row of content is fully visible (not clipped) and the People bulk toolbar (select a face first) is not occluded. Screenshot.

- [ ] **Step 4: Build + prettier + commit**

Run: `cd src/web && bunx ng build maple`. Commit: `git commit -m "fix(web): settings fills container at phone width; people toolbar visible (Closes #<settings>)"`.

---

## Task 5: Hosted (maple-syrup) real settings + CI

**Closes:** epic child "Hosted: real /settings surface + maple-syrup in CI".
**Depends on:** Task 1.

**Files:**

- Modify: `src/web/projects/maple-syrup/src/app/app.routes.ts` (point `/settings` at a real page)
- Create/Modify: a Hosted settings entry (Account at minimum) — reuse `AccountComponent` if it is app-agnostic, else a thin `maple-syrup` settings component embedding the shared settings-shell.
- Modify: `.github/workflows/web.yml` (add `ng build maple-syrup`)

- [ ] **Step 1: Decide the Hosted settings target**

Read `projects/maple/src/app/settings/account/account.component.ts` and `settings-shell.component.ts`. If `AccountComponent`/`settings-shell` live in `maple` (not maple-common), the cleanest minimal real surface is a `maple-syrup` `settings/account` route lazy-loading a small Hosted account page that reuses the shared shell. Implement the smallest real page — no stub. If Account is Self-Hosted-only, scope Hosted settings to a real "Account" page showing the signed-in identity + sign-out.

- [ ] **Step 2: Wire the route**

Replace the temporary `{ path: 'settings', redirectTo: 'browse' }` (from Task 1 Step 6) with `{ path: 'settings', redirectTo: 'settings/account', pathMatch: 'full' }` and a lazy `settings/account` route to the real component.

- [ ] **Step 3: Add maple-syrup to CI**

In `.github/workflows/web.yml`, after the `ng build maple` step, add a `bunx ng build maple-syrup` step (same job, so a Hosted build break fails CI). Do not add a test step unless maple-syrup has specs.

- [ ] **Step 4: Build both + prettier + commit**

Run: `cd src/web && bunx ng build maple-syrup`. Commit staging explicit paths + the workflow file: `git commit -m "feat(web): real Hosted settings surface + maple-syrup CI build (Closes #<hosted>)"`.

---

## Verification (shared)

Dev-server + Playwright recipe (per project memory `verify_web_ui_setup_dev_auth`):

```bash
# API needs the native dylib once: ./src/api/scripts/build-raw-ffi.sh
cd src/web && HOME=/tmp/x bun install    # only in a fresh worktree
MAPLE_DEV_AUTH=1 bunx ng serve maple --port 4201   # background
# register a library, load an image, then drive with Playwright at 375/900/1440
```

Headless Chrome cannot decode AVIF — measure layout/overflow, not pixel-perfect thumbnails. Resize preview images before CIEDE-style checks (not needed here; this is layout-only).

## Self-Review notes

- Spec coverage: Task 1 ↔ target-architecture §1–3 + cleanup; Task 2 ↔ BrowseShell; Task 3 ↔ Search; Task 4 ↔ Settings bugs; Task 5 ↔ Hosted + CI. Navigation §4 is realized by Task 2 (drawer + overflow). Editor/Preview breakpoint unification is in Task 1 Step 7.
- No backend work (stubbed scopes) — matches non-goals.
- Thresholds consistent everywhere: phone `<768`, tablet `≤1024`, desktop `>1024`; `@media` cutoffs 767/1023.
