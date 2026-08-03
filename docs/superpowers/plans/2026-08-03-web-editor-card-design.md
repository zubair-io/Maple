# Web Editor Apple Card-Layout Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the web editor's dock, control surface and sliders to visual and structural parity with the Apple `FlyoutSliderPanel` + `ToolDock` Card layout, without stranding any shipped tool.

**Architecture:** Five independent slices over `projects/maple-common`. The dock collapses to nine entries with circle-and-label buttons; the control surface moves from a bottom-anchored bar to a fixed 300px column floating beside the dock; the three tools that lose dock buttons (HSL, B&W, Grade) get a chip row inside that column, which also absorbs their panel bodies; sliders restack; the phone gets the two-card `MobileControlBar` shape.

**Tech Stack:** Angular 21 standalone components, signals, `input()`/`output()`; SCSS with `pro-tokens.scss` custom properties; Vitest + `TestBed` for specs.

## Global Constraints

- Scope is `src/web/projects/maple-common` only. No Swift, no Rust, no colour-pipeline stage changes, so `src/scripts/test_color_pipeline.sh` and `tools/codegen.sh` are not run.
- `editor-shell.component.ts` is at **594 lines** against a 600 hard limit and a **570 headroom gate**. It must not gain a single line. `tools/check-budget-headroom.sh` fails any PR that grows a file already past 570. Template and stylesheet edits are unrestricted — `tools/check-file-budget.sh:104` scopes the budget to `*.rs *.swift *.ts *.tsx *.js *.py` only.
- All colours come from `pro-tokens.scss` custom properties. Never introduce a new hex literal; accent tints use only `--pro-accent-1f/22/28/30`.
- Every interactive element keeps an `aria-label`, and disabled placeholders stay out of the accessibility tree.
- Run tests with `cd src/web && bun x ng test` (Vitest). Format with `cd src/web && bun run format` — never hand-roll Prettier output.
- Prettier binary in a fresh worktree: this worktree has no `node_modules`. Use `/Users/riabuz/Projects/_Maple/src/web/node_modules/.bin/prettier` or run `bun install` in `src/web` first.

---

### Task 1: Stacked living slider

Self-contained and touched by no other task. Do it first so later screenshots show the right slider.

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/components/develop/living-slider.component.html`
- Modify: `src/web/projects/maple-common/src/lib/components/develop/living-slider.component.scss`
- Test: `src/web/projects/maple-common/src/lib/components/develop/living-slider.component.spec.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: no API change. `LivingSliderComponent`'s inputs (`label`, `value`, `min`, `max`, `step`, `gradient`, `bipolar`, `defaultValue`) and outputs (`dragStart`, `valueChange`, `resetRequest`) are unchanged. Only the DOM order and class layout change: `.slider-row` gains a child `.slider-head` wrapping `.slider-label` + `.value-chip`, with `.track-wrap` as a sibling beneath.

- [ ] **Step 1: Write the failing test**

Append to `living-slider.component.spec.ts`:

```typescript
describe("stacked layout (Apple LivingSlider parity)", () => {
  it("puts label and value in a head row above the track", () => {
    const fixture = render({ label: "Exposure", value: 0, min: -5, max: 5 });
    const el = fixture.nativeElement as HTMLElement;

    const head = el.querySelector(".slider-head");
    expect(head).toBeTruthy();
    expect(head!.querySelector(".slider-label")?.textContent?.trim()).toBe(
      "Exposure",
    );
    expect(head!.querySelector(".value-chip")).toBeTruthy();

    // Track is a SIBLING of the head, not inside it — that is what makes it
    // span the full card width rather than share a row with the label.
    const row = el.querySelector(".slider-row")!;
    const children = Array.from(row.children);
    expect(children.indexOf(head!)).toBeLessThan(
      children.indexOf(row.querySelector(".track-wrap")!),
    );
    expect(head!.querySelector(".track-wrap")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/web && bun x ng test --project maple-common -t "stacked layout"`
Expected: FAIL — `.slider-head` is null, because the current template has no such element.

- [ ] **Step 3: Restructure the template**

Replace the whole of `living-slider.component.html` with:

```html
<!-- LivingSlider — label + value above a full-width gradient track (Apple
     LivingSlider.swift:161 parity: VStack of an HStack head over the track). -->
<div class="slider-row">
  <div class="slider-head">
    <span class="slider-label" [title]="label()">{{ label() }}</span>
    <span class="value-chip" [class.value-chip--modified]="isModified()"
      >{{ valueLabel() }}</span
    >
  </div>

  <div
    #trackEl
    class="track-wrap"
    role="slider"
    tabindex="0"
    [attr.aria-label]="label()"
    [attr.aria-valuemin]="min()"
    [attr.aria-valuemax]="max()"
    [attr.aria-valuenow]="value()"
    [attr.aria-valuetext]="valueLabel()"
    (pointerdown)="onTrackPointerDown($event)"
    (keydown)="onTrackKeyDown($event)"
    (keyup)="onTrackKeyUp($event)"
  >
    <div class="track" [style.background]="gradient()">
      @if (bipolar()) {
      <div class="zero-notch"></div>
      }
      <div
        class="thumb"
        [class.thumb--modified]="isModified()"
        [style.left.%]="thumbPct()"
      ></div>
    </div>
  </div>
</div>
```

- [ ] **Step 4: Restack the styles**

In `living-slider.component.scss`, change `.slider-row` from a horizontal flex row to a column, and add the head row. Replace the `.slider-row`, `.slider-label` and `.value-chip` rules with:

```scss
.slider-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.slider-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.slider-label {
  font-size: 12px;
  color: var(--pro-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.value-chip {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--pro-text-muted);
  flex-shrink: 0;

  &.value-chip--modified {
    color: var(--pro-accent);
  }
}

.track-wrap {
  width: 100%;
}
```

Delete any fixed `width`/`flex-basis` on `.slider-label` and `.value-chip` left over from the three-column layout — they will pin the head row at the old widths if kept.

- [ ] **Step 5: Run the full slider suite**

Run: `cd src/web && bun x ng test --project maple-common -t "LivingSlider"`
Expected: PASS, including the pre-existing drag, keyboard and ARIA tests — none of that logic moved.

- [ ] **Step 6: Format and commit**

```bash
cd src/web && bun run format
git add src/web/projects/maple-common/src/lib/components/develop/living-slider.component.html \
        src/web/projects/maple-common/src/lib/components/develop/living-slider.component.scss \
        src/web/projects/maple-common/src/lib/components/develop/living-slider.component.spec.ts
git commit -m "feat(web): stack living-slider label and value above a full-width track"
```

---

### Task 2: Nine-entry tool dock with circle-and-label buttons

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/components/editor/tool-dock.component.ts:55-188`
- Modify: `src/web/projects/maple-common/src/lib/components/editor/tool-dock.component.html`
- Modify: `src/web/projects/maple-common/src/lib/components/editor/tool-dock.component.scss`
- Test: `src/web/projects/maple-common/src/lib/components/editor/tool-dock.component.spec.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: `DockEntry` loses its `orientations` field and gains `divideBefore?: boolean`. `ToolDockComponent` keeps every existing input and output unchanged, and gains one private injected dependency (`LibraryStateService`) plus a public `isModified(entry: DockEntry): boolean`. The `hsl`, `bwMix`, `colorGrade` and `optics` entries are removed from `DOCK_ENTRIES` — Task 4 provides their replacement route, so **Task 4 must land before this branch merges**.

- [ ] **Step 1: Write the failing tests**

Append to `tool-dock.component.spec.ts`:

```typescript
describe("Apple 9-entry parity", () => {
  it("renders exactly the nine Apple entries in order, both orientations", () => {
    const expected = [
      "Light",
      "Color",
      "Effects",
      "Detail",
      "Crop",
      "Tone Curve",
      "Presets",
      "Mask",
      "Heal",
    ];
    for (const orientation of ["vertical", "horizontal"] as const) {
      const fixture = render({ orientation });
      const labels = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll(
          ".dock-btn .dock-label",
        ),
      ).map((n) => n.textContent!.trim());
      expect(labels, orientation).toEqual(expected);
    }
  });

  it("no longer offers HSL, B&W, Grade or Optics buttons", () => {
    const fixture = render({});
    const labels = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll(".dock-btn"),
    ).map((n) => n.getAttribute("aria-label"));
    for (const gone of ["HSL", "B&W", "Grade", "Optics"]) {
      expect(labels).not.toContain(gone);
    }
  });

  it("draws a divider before Crop", () => {
    const fixture = render({});
    const el = fixture.nativeElement as HTMLElement;
    const nodes = Array.from(el.querySelectorAll(".dock-divider, .dock-btn"));
    const dividerIndex = nodes.findIndex((n) =>
      n.classList.contains("dock-divider"),
    );
    const cropIndex = nodes.findIndex(
      (n) => n.getAttribute("aria-label") === "Crop",
    );
    expect(dividerIndex).toBeGreaterThan(-1);
    expect(dividerIndex).toBe(cropIndex - 1);
  });

  it("keeps disabled placeholders out of the accessibility tree", () => {
    const fixture = render({});
    const mask = (fixture.nativeElement as HTMLElement).querySelector(
      '[aria-label="Mask"]',
    );
    expect(mask).toBeNull();
    const placeholders = (
      fixture.nativeElement as HTMLElement
    ).querySelectorAll('.dock-btn--disabled[aria-hidden="true"]');
    expect(placeholders.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/web && bun x ng test --project maple-common -t "Apple 9-entry parity"`
Expected: FAIL — `.dock-label` does not exist and the entry list still contains thirteen items.

- [ ] **Step 3: Rewrite the entry list**

In `tool-dock.component.ts`, delete the `orientations` field from the `DockEntry` interface and the `BOTH_ORIENTATIONS` constant, and replace them with a divider flag:

```typescript
  /** Draw a horizontal rule above this entry — separates the four group
   *  entries from the special tools below (ToolDock.swift:34). */
  divideBefore?: boolean;
```

Then replace `DOCK_ENTRIES` (currently lines 64-132) with:

```typescript
const DOCK_ENTRIES: DockEntry[] = [
  { id: "light", icon: "tool-exposure", label: "Light", group: "light" },
  { id: "color", icon: "tool-tint", label: "Color", group: "color" },
  { id: "effects", icon: "tool-vignette", label: "Effects", group: "effects" },
  { id: "detail", icon: "tool-sharpen", label: "Detail", group: "detail" },
  // Divider: groups above, special tools below — mirrors ToolDock.swift:34.
  {
    id: "crop",
    icon: "tool-crop",
    label: "Crop",
    tool: "crop",
    divideBefore: true,
  },
  { id: "curve", icon: "tool-contrast", label: "Tone Curve", panel: true },
  { id: "presets", icon: "tool-presets", label: "Presets", panel: true },
  // HSL, B&W and Grade are reached from the Colour sub-tool row inside the
  // flyout panel (see control-card.component.ts), not from the dock — Apple's
  // dock carries no button for them either. Optics is dropped: Apple has no
  // such button and Mask/Heal already signal that more tools are coming.
  {
    id: "mask",
    icon: "tool-dehaze",
    label: "Mask",
    disabled: true,
    ticket: "#1541",
  },
  {
    id: "heal",
    icon: "tool-texture",
    label: "Heal",
    disabled: true,
    ticket: "#1472",
  },
];
```

- [ ] **Step 4: Simplify the entries computed and add the modified predicate**

`blackWhiteOn` no longer hides anything (the HSL entry is gone), but keep the input — Task 4's chip row still needs the shell to pass it, and removing an input would force a shell template edit for no gain. Replace the `entries` computed (lines 182-188) with:

```typescript
  /** The nine dock entries. No longer orientation-dependent: the phone bar
   *  and the desktop column show the same set (MobileControlBar.swift:124). */
  readonly entries = computed<DockEntry[]>(() => DOCK_ENTRIES);
```

Add the injected state and the dot predicate to the class body:

```typescript
  private libraryState = inject(LibraryStateService);

  /** Adjustment model for the focused asset, or null when none is focused. */
  private readonly currentAdj = computed<AdjustmentModel | null>(() => {
    const id = this.libraryState.focusedAssetId();
    return id ? this.libraryState.adjustmentFor(id)() : null;
  });

  /** Accent dot: true when any tool this entry covers holds a non-default
   *  value. For a GROUP entry that means every tool in the group — including
   *  HSL, B&W and Grade, which no longer have buttons of their own, so their
   *  modified state has to surface on Color's dot. */
  isModified(entry: DockEntry): boolean {
    const adj = this.currentAdj();
    if (!adj || entry.disabled) return false;
    const tools = entry.group
      ? TOOLS_IN_GROUP[entry.group]
      : entry.tool
        ? [entry.tool]
        : ([] as readonly ToolId[]);
    return tools.some((tool) => {
      if (!isWired(tool)) return false;
      const field = fieldFor(tool);
      if (!field) return false;
      return Math.abs((adj[field] as number) - defaultDisplayValue(tool)) > 1e-6;
    });
  }
```

Extend the existing import from `../../editor/tool-model` with `TOOLS_IN_GROUP`, `isWired`, `fieldFor` and `defaultDisplayValue`, add `inject` to the `@angular/core` import, and add:

```typescript
import { LibraryStateService } from "../../state/library-state.service";
import type { AdjustmentModel } from "../../models/adjustment-model";
```

- [ ] **Step 5: Rewrite the template**

Replace the whole of `tool-dock.component.html` with:

```html
<!-- ToolDock — glass column (vertical) or bar (horizontal, phone).
     Nine entries, circle glyph + label + modified dot (ToolDock.swift). -->
<nav
  class="dock"
  [class.dock--horizontal]="orientation() === 'horizontal'"
  role="navigation"
  aria-label="Editor tools"
>
  @for (entry of entries(); track entry.id) { @if (entry.divideBefore) {
  <div class="dock-divider"></div>
  }
  <button
    class="dock-btn"
    [class.dock-btn--active]="isActive(entry)"
    [class.dock-btn--disabled]="entry.disabled"
    [disabled]="entry.disabled"
    [title]="entry.disabled ? entry.label + ' — coming in ' + entry.ticket : entry.label"
    [attr.aria-hidden]="entry.disabled ? 'true' : null"
    [attr.tabindex]="entry.disabled ? -1 : null"
    [attr.aria-label]="entry.disabled ? null : entry.label"
    [attr.aria-current]="!entry.panel && isActive(entry) ? 'page' : null"
    [attr.aria-pressed]="entry.panel ? isActive(entry) : null"
    (click)="onEntryClick(entry)"
  >
    <span class="dock-circle">
      <maple-icon
        [name]="$any(entry.icon)"
        [size]="16"
        [color]="
            isActive(entry)
              ? 'var(--pro-accent)'
              : entry.disabled
                ? 'var(--pro-text-dim)'
                : 'var(--pro-text)'
          "
      />
      @if (isModified(entry)) {
      <span class="dock-dot"></span>
      }
    </span>
    <span class="dock-label">{{ entry.label }}</span>
  </button>
  }
</nav>
```

- [ ] **Step 6: Restyle the dock**

In `tool-dock.component.scss`, replace the `.dock-btn` rule (lines 54-93) with the circle-and-label form, and add the divider and dot. Keep the existing `.dock` and `.dock--horizontal` glass rules, but change the horizontal `.dock-btn` sizing:

```scss
.dock-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 52px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
  outline: none;

  &.dock-btn--disabled {
    cursor: default;
    opacity: 0.4;
  }

  &:focus-visible .dock-circle {
    outline: 2px solid var(--pro-accent);
    outline-offset: 2px;
  }
}

.dock-circle {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--pro-panel);
  border: 0.5px solid var(--pro-border);
  transition:
    background 120ms ease-out,
    border-color 120ms ease-out;

  .dock-btn--active & {
    background: var(--pro-accent-28);
    border-color: var(--pro-accent);
  }

  .dock-btn:hover:not(.dock-btn--disabled):not(.dock-btn--active) & {
    background: rgba(255, 255, 255, 0.06);
    border-color: var(--pro-border-hi);
  }
}

.dock-dot {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--pro-accent);
}

.dock-label {
  font-size: 9px;
  line-height: 1.1;
  color: var(--pro-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;

  .dock-btn--active & {
    color: var(--pro-accent);
    font-weight: 600;
  }

  .dock-btn--disabled & {
    color: var(--pro-text-dim);
  }
}

.dock-divider {
  width: 34px;
  height: 1px;
  background: var(--pro-border);
  margin: 5px 0;

  .dock--horizontal & {
    width: 1px;
    height: 34px;
    margin: 0 5px;
  }
}
```

In the existing `.dock.dock--horizontal` block, replace the `.dock-btn { width: 44px; height: 44px; flex: 1 1 0; max-width: 52px; }` override with `.dock-btn { flex: 0 0 auto; }` and add `overflow-x: auto; justify-content: flex-start;` to the horizontal `.dock` rule — nine labelled buttons no longer fit a 375px viewport, and Apple's bar scrolls horizontally too (`MobileControlBar.swift:122`).

- [ ] **Step 7: Fix the pre-existing specs**

The suite's `render()` helper still passes `orientation`, which is fine. Delete or rewrite any existing test asserting the old thirteen-entry list, the `orientations` filter, the Optics/HSL/B&W/Grade entries, or the `blackWhiteOn` HSL-hiding behaviour — that last one is now vacuous, since there is no HSL entry to hide. Keep the group/panel/tool click-wiring tests: `isActive` and `onEntryClick` are unchanged.

- [ ] **Step 8: Run the dock suite**

Run: `cd src/web && bun x ng test --project maple-common -t "ToolDock"`
Expected: PASS, all green.

- [ ] **Step 9: Format and commit**

```bash
cd src/web && bun run format
git add src/web/projects/maple-common/src/lib/components/editor/tool-dock.component.ts \
        src/web/projects/maple-common/src/lib/components/editor/tool-dock.component.html \
        src/web/projects/maple-common/src/lib/components/editor/tool-dock.component.scss \
        src/web/projects/maple-common/src/lib/components/editor/tool-dock.component.spec.ts
git commit -m "feat(web): collapse the tool dock to Apple's nine circle-and-label entries"
```

---

### Task 3: Flyout panel geometry

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/components/editor/control-card.component.html`
- Modify: `src/web/projects/maple-common/src/lib/components/editor/control-card.component.scss`
- Modify: `src/web/projects/maple-common/src/lib/components/editor/control-card.component.ts:43,92-102`
- Modify: `src/web/projects/maple-common/src/lib/shells/editor-shell/editor-shell.component.scss:284-302`
- Test: `src/web/projects/maple-common/src/lib/components/editor/control-card.component.spec.ts`

**Interfaces:**

- Consumes: the restacked slider from Task 1.
- Produces: `ControlCardComponent` drops the `CardState` type, the `cardState` signal, `isPeek`, and `toggleCardState`. The `phone`, `closed` inputs and `closeRequest` output survive until Task 5 retires them. The header markup becomes `.card-header > .group-glyph + .group-title + .reset-btn`.

- [ ] **Step 1: Write the failing test**

Append to `control-card.component.spec.ts`:

```typescript
describe("flyout header (FlyoutSliderPanel parity)", () => {
  it("shows the accent group title and no group-chip row", () => {
    const fixture = render({ activeGroup: "color" });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector(".group-title")?.textContent?.trim()).toBe("COLOR");
    expect(el.querySelector(".group-chips")).toBeNull();
    expect(el.querySelector(".grab-handle")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/web && bun x ng test --project maple-common -t "flyout header"`
Expected: FAIL — `.group-title` is null and `.group-chips` still renders.

- [ ] **Step 3: Rewrite the header markup**

In `control-card.component.html`, delete the `.grab-handle` button entirely and replace the whole `.card-header` block with:

```html
<div class="card-header">
  <maple-icon
    [name]="$any(groupIcon(activeGroup()))"
    [size]="12"
    color="var(--pro-accent)"
  />
  <span class="group-title">{{ groupLabel(activeGroup()).toUpperCase() }}</span>

  <button
    class="reset-btn"
    title="Reset {{ groupLabel(activeGroup()) }}"
    aria-label="Reset {{ groupLabel(activeGroup()) }} adjustments"
    (click)="resetGroup()"
  >
    <maple-icon name="revert" [size]="11" color="var(--pro-text-muted)" />
  </button>

  @if (phone()) {
  <button
    class="close-btn"
    title="Close panel"
    aria-label="Close panel"
    (click)="onCloseClick()"
  >
    <maple-icon
      name="clear-circle-fill"
      [size]="16"
      color="var(--pro-text-muted)"
    />
  </button>
  }
</div>
```

Remove the `@if (!isPeek())` wrapper around `.slider-grid` so the grid always renders.

- [ ] **Step 4: Add the group glyph helper and drop peek state**

In `control-card.component.ts`, delete `export type CardState`, the `cardState` signal, `isPeek`, and `toggleCardState` (lines 43, 92-98). Add, mirroring `FlyoutSliderPanel.groupSymbol`:

```typescript
  /** Accent glyph beside the group title — same icon the dock's group button
   *  uses, so the panel header and the dock entry read as the same object. */
  groupIcon(group: ToolGroup): string {
    const icons: Record<ToolGroup, string> = {
      light: 'tool-exposure',
      color: 'tool-tint',
      effects: 'tool-vignette',
      detail: 'tool-sharpen',
    };
    return icons[group];
  }
```

- [ ] **Step 5: Restyle the panel**

In `control-card.component.scss`, delete the `.grab-handle`, `.grab-bar`, `.group-chips` and `.group-chip` rules. Change `.card` to a uniformly-rounded fixed-width panel and restyle the header:

```scss
.card {
  padding: 16px;
  background: var(--pro-glass-bg);
  backdrop-filter: var(--pro-glass-blur);
  -webkit-backdrop-filter: var(--pro-glass-blur);
  border: 0.5px solid var(--pro-glass-border);
  box-shadow: var(--pro-glass-shadow);
  border-radius: 18px;

  @media (min-width: 768px) {
    background: var(--pro-glass-bg-heavy);
    backdrop-filter: var(--pro-glass-blur-heavy);
    -webkit-backdrop-filter: var(--pro-glass-blur-heavy);
  }
}

.card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
}

.group-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.6px;
  color: var(--pro-accent);
}

.reset-btn {
  margin-left: auto;
}

.slider-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
```

The old `.slider-grid` was a two-column grid sized for an 860px card. At 300px it must be a single column — `FlyoutSliderPanel.swift:63` uses a single `VStack` for the same reason.

- [ ] **Step 6: Move the shell anchor**

In `editor-shell.component.scss`, replace the `.control-card-anchor` rule (lines 293-302) with:

```scss
// ── Flyout slider panel anchor (tablet/desktop) ───────────────────────────
// Fixed 300px column floating just left of the dock, vertically centred —
// FlyoutSliderPanel.swift:71 + EditorView.swift:205-210, where the 88px
// offset is 12px dock inset + 64px dock width + 12px gap.
.control-card-anchor {
  position: absolute;
  top: 50%;
  right: 88px;
  transform: translateY(-50%);
  width: 300px;
  pointer-events: auto;
}
```

- [ ] **Step 7: Run the control-card suite**

Run: `cd src/web && bun x ng test --project maple-common -t "ControlCard"`
Expected: PASS. Delete any pre-existing test asserting the grab handle, peek toggling or the group-chip row — those affordances are gone by design.

- [ ] **Step 8: Format and commit**

```bash
cd src/web && bun run format
git add src/web/projects/maple-common/src/lib/components/editor/control-card.component.html \
        src/web/projects/maple-common/src/lib/components/editor/control-card.component.scss \
        src/web/projects/maple-common/src/lib/components/editor/control-card.component.ts \
        src/web/projects/maple-common/src/lib/components/editor/control-card.component.spec.ts \
        src/web/projects/maple-common/src/lib/shells/editor-shell/editor-shell.component.scss
git commit -m "feat(web): float the control panel beside the dock at a fixed 300px"
```

---

### Task 4: Colour sub-tool row

This is what keeps HSL, B&W and Grade reachable after Task 2 removes their dock buttons. **It must land before the branch merges.** The three panels move inside the flyout, mirroring `FlyoutSliderPanel`'s `armedTool` branches, because the shell hides the flyout while they are armed today — leaving the chip row unreachable exactly when it is needed.

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/components/editor/control-card.component.ts`
- Modify: `src/web/projects/maple-common/src/lib/components/editor/control-card.component.html`
- Modify: `src/web/projects/maple-common/src/lib/components/editor/control-card.component.scss`
- Modify: `src/web/projects/maple-common/src/lib/shells/editor-shell/editor-shell.component.html:256-260, 181-242`
- Test: `src/web/projects/maple-common/src/lib/components/editor/control-card.component.spec.ts`

**Interfaces:**

- Consumes: the header from Task 3.
- Produces: `ControlCardComponent` gains `activeTool = input<ToolId | null>(null)` and `toolChange = output<ToolId>()`. The shell binds `[activeTool]="activeTool()"` and `(toolChange)="onToolChange($event)"` — both already exist on the shell class, so **no shell TypeScript changes**, which is what keeps `editor-shell.component.ts` at 594 lines.

- [ ] **Step 1: Write the failing tests**

Append to `control-card.component.spec.ts`:

```typescript
describe("colour sub-tool row", () => {
  it("renders Basic/HSL/B&W/Grade only for the colour group", () => {
    const colour = render({ activeGroup: "color" });
    const chips = Array.from(
      (colour.nativeElement as HTMLElement).querySelectorAll(".subtool-chip"),
    ).map((n) => n.textContent!.trim());
    expect(chips).toEqual(["Basic", "HSL", "B&W", "Grade"]);

    const light = render({ activeGroup: "light" });
    expect(
      (light.nativeElement as HTMLElement).querySelector(".subtool-row"),
    ).toBeNull();
  });

  it("emits the same tool a dock button used to arm", () => {
    const fixture = render({ activeGroup: "color" });
    const emitted: string[] = [];
    fixture.componentInstance.toolChange.subscribe((t: string) =>
      emitted.push(t),
    );

    const chips = (fixture.nativeElement as HTMLElement).querySelectorAll(
      ".subtool-chip",
    );
    (chips[1] as HTMLButtonElement).click(); // HSL
    (chips[2] as HTMLButtonElement).click(); // B&W
    (chips[3] as HTMLButtonElement).click(); // Grade
    expect(emitted).toEqual(["hsl", "bwMix", "colorGrade"]);
  });

  it("marks the chip matching the armed tool active, defaulting to Basic", () => {
    const hsl = render({ activeGroup: "color", activeTool: "hsl" });
    expect(
      (hsl.nativeElement as HTMLElement)
        .querySelector(".subtool-chip--active")
        ?.textContent?.trim(),
    ).toBe("HSL");

    const basic = render({ activeGroup: "color", activeTool: "temp" });
    expect(
      (basic.nativeElement as HTMLElement)
        .querySelector(".subtool-chip--active")
        ?.textContent?.trim(),
    ).toBe("Basic");
  });
});
```

Extend the suite's `render()` helper to accept and set an `activeTool` input.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/web && bun x ng test --project maple-common -t "colour sub-tool row"`
Expected: FAIL — `.subtool-chip` does not exist.

- [ ] **Step 3: Add the input, output and chip model**

In `control-card.component.ts`, add after the `activeGroup` input:

```typescript
/** Armed tool — drives which sub-tool chip reads active. */
activeTool = input<ToolId | null>(null);
```

Add beside `groupChange`:

```typescript
/** Fired when the user picks a sub-tool chip (HSL / B&W / Grade). */
toolChange = output<ToolId>();
```

Add above the class:

```typescript
/** Colour sub-tools that have no primary slider field, so they cannot appear
 *  in SLIDER_TOOLS and need their own route. `null` is Basic — the group's
 *  plain sliders. Mirrors the tools Apple's Card variant cannot reach at all
 *  (ToolDock.swift has no button for any of them). */
const COLOR_SUBTOOLS: readonly {
  readonly id: ToolId | null;
  readonly label: string;
}[] = [
  { id: null, label: "Basic" },
  { id: "hsl", label: "HSL" },
  { id: "bwMix", label: "B&W" },
  { id: "colorGrade", label: "Grade" },
];
```

And to the class body:

```typescript
  readonly colorSubtools = COLOR_SUBTOOLS;

  /** Sub-tool chips show for Colour only — the other three groups have no
   *  field-less tools. */
  readonly showSubtools = computed<boolean>(() => this.activeGroup() === 'color');

  isSubtoolActive(id: ToolId | null): boolean {
    const armed = this.activeTool();
    const armedSubtool = COLOR_SUBTOOLS.some((s) => s.id !== null && s.id === armed);
    return id === null ? !armedSubtool : id === armed;
  }

  onSubtoolClick(id: ToolId | null): void {
    // Basic re-arms the group, which arms its first slider tool; the others
    // arm directly, exactly as their former dock buttons did.
    if (id === null) this.groupChange.emit('color');
    else this.toolChange.emit(id);
  }
```

- [ ] **Step 4: Render the row and the borrowed panels**

In `control-card.component.html`, insert directly after `.card-header`:

```html
@if (showSubtools()) {
<div class="subtool-row" role="tablist" aria-label="Colour sub-tools">
  @for (sub of colorSubtools; track sub.label) {
  <button
    class="subtool-chip"
    [class.subtool-chip--active]="isSubtoolActive(sub.id)"
    role="tab"
    [attr.aria-selected]="isSubtoolActive(sub.id)"
    (click)="onSubtoolClick(sub.id)"
  >
    {{ sub.label }}
  </button>
  }
</div>
}
```

Then wrap the slider grid so an armed sub-tool replaces it, matching `FlyoutSliderPanel.swift:32-68`:

```html
@if (activeTool() === 'hsl' || activeTool() === 'bwMix') {
<ng-content select="[cardBodySubParam]" />
} @else if (activeTool() === 'colorGrade') {
<ng-content select="[cardBodyGrade]" />
} @else {
<div class="slider-grid">
  <!-- existing @for over slidersFor(activeGroup()) unchanged -->
</div>
}
```

Using content projection keeps `ControlCardComponent` from importing the HSL, B&W and Grade panel components directly, so its import list and file size stay small and the shell keeps owning panel composition.

- [ ] **Step 5: Project the panels from the shell**

In `editor-shell.component.html`, change the tablet/desktop control-card block (currently lines 256-260) so the flyout renders for these tools instead of being suppressed, and delete the now-duplicated `.hsl-panel`, `.bw-panel` and `.color-grade-panel` blocks from the dock anchor (lines 181-242):

```html
@if (!cropArmed()) {
<div class="control-card-anchor">
  <pro-control-card
    [activeGroup]="activeGroup()"
    [activeTool]="activeTool()"
    (groupChange)="onGroupChange($event)"
    (toolChange)="onToolChange($event)"
  >
    <div cardBodySubParam class="subparam-body">
      @if (bwMixArmed()) {
      <button
        class="bw-toggle"
        [class.bw-toggle--on]="blackWhiteOn()"
        role="switch"
        [attr.aria-checked]="blackWhiteOn()"
        aria-label="Black & White"
        data-testid="bw-toggle"
        (click)="onBlackWhiteToggle()"
      >
        <span class="bw-toggle-track"
          ><span class="bw-toggle-thumb"></span
        ></span>
        <span class="bw-toggle-label">Black &amp; White</span>
      </button>
      }
      <app-value-chip />
      <div class="hsl-panel-chips"><app-sub-param-row /></div>
      <app-drag-bar />
    </div>
    <div cardBodyGrade><pro-color-grading-panel /></div>
  </pro-control-card>
</div>
}
```

Crop keeps its own panel and still suppresses the flyout — its toolbar is a full replacement control surface with no group sliders behind it, matching `ControlCard.swift:40`.

- [ ] **Step 6: Style the chip row**

Append to `control-card.component.scss`:

```scss
.subtool-row {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}

.subtool-chip {
  flex-shrink: 0;
  padding: 3px 11px;
  border-radius: 20px;
  border: 0.5px solid var(--pro-border);
  background: transparent;
  font-size: 11px;
  color: var(--pro-text-muted);
  cursor: pointer;
  transition:
    background 120ms ease-out,
    border-color 120ms ease-out;

  &.subtool-chip--active {
    background: var(--pro-accent-28);
    border-color: var(--pro-accent);
    color: var(--pro-accent);
    font-weight: 600;
  }

  &:focus-visible {
    outline: 2px solid var(--pro-accent);
    outline-offset: 2px;
  }
}
```

- [ ] **Step 7: Confirm the shell TypeScript did not grow**

Run: `wc -l src/web/projects/maple-common/src/lib/shells/editor-shell/editor-shell.component.ts`
Expected: **594** — unchanged. If it grew, move the addition into a sibling module before continuing; `bash tools/check-budget-headroom.sh origin/main` is the gate that will otherwise fail the PR.

- [ ] **Step 8: Run the suite**

Run: `cd src/web && bun x ng test --project maple-common`
Expected: PASS. Update `editor-shell.component.spec.ts` and `editor-shell-hsl.spec.ts` where they assert the standalone `.hsl-panel` / `.bw-panel` / `.color-grade-panel` anchors — the elements now live inside the flyout.

- [ ] **Step 9: Format and commit**

```bash
cd src/web && bun run format
git add src/web/projects/maple-common/src/lib/components/editor/ \
        src/web/projects/maple-common/src/lib/shells/editor-shell/
git commit -m "feat(web): reach HSL, B&W and Grade from a colour sub-tool row"
```

---

### Task 5: Phone two-card layout

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/shells/editor-shell/editor-shell.component.html:261-376`
- Modify: `src/web/projects/maple-common/src/lib/shells/editor-shell/editor-shell.component.scss:304-333`
- Modify: `src/web/projects/maple-common/src/lib/components/editor/control-card.component.ts`
- Test: `src/web/projects/maple-common/src/lib/shells/editor-shell/editor-shell.component.spec.ts`

**Interfaces:**

- Consumes: everything from Tasks 2-4.
- Produces: `ControlCardComponent` loses the `phone` and `closed` inputs and the `closeRequest` output. `phoneCardOpen` and its four call sites in `editor-shell.component.ts` are deleted, which **shrinks** the file — always allowed by the headroom gate.

- [ ] **Step 1: Write the failing test**

Append to `editor-shell.component.spec.ts`:

```typescript
it("shows the phone slider panel without requiring a dock tap", () => {
  const fixture = renderShell({ layout: "phone" });
  const el = fixture.nativeElement as HTMLElement;
  expect(el.querySelector(".phone-card-anchor pro-control-card")).toBeTruthy();
  expect(el.querySelector(".close-btn")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/web && bun x ng test --project maple-common -t "without requiring a dock tap"`
Expected: FAIL — the card is gated behind `phoneCardOpen()`, which starts false.

- [ ] **Step 3: Simplify the phone branch**

In `editor-shell.component.html`, replace the phone `@else` branch's control-card block with the always-mounted form, dropping `[phone]`, `[closed]` and `(closeRequest)`, and delete the separate `.phone-hsl-panel`, `.phone-bw-panel` and `.phone-color-grade-panel` blocks — Task 4's projection covers them at every breakpoint:

```html
<div class="phone-card-anchor">
  <pro-control-card
    [activeGroup]="activeGroup()"
    [activeTool]="activeTool()"
    (groupChange)="onGroupChange($event)"
    (toolChange)="onToolChange($event)"
  >
    <div cardBodySubParam class="subparam-body">
      @if (bwMixArmed()) {
      <button
        class="bw-toggle"
        [class.bw-toggle--on]="blackWhiteOn()"
        role="switch"
        [attr.aria-checked]="blackWhiteOn()"
        aria-label="Black & White"
        data-testid="bw-toggle"
        (click)="onBlackWhiteToggle()"
      >
        <span class="bw-toggle-track"
          ><span class="bw-toggle-thumb"></span
        ></span>
        <span class="bw-toggle-label">Black &amp; White</span>
      </button>
      }
      <app-value-chip />
      <div class="hsl-panel-chips"><app-sub-param-row /></div>
      <app-drag-bar />
    </div>
    <div cardBodyGrade><pro-color-grading-panel /></div>
  </pro-control-card>
</div>
```

- [ ] **Step 4: Delete the closeable-flyout machinery**

In `control-card.component.ts`, delete the `phone` and `closed` inputs, the `closeRequest` output and `onCloseClick`. In `control-card.component.html`, delete the `@if (phone())` close button and the outer `@if (!phone() || !closed())` wrapper. In `editor-shell.component.ts`, delete the `phoneCardOpen` signal and its reads in `onPhoneDockGroupChange`, `onPhoneToolChange`, `onPhoneCurvePanelToggle` and `onPhonePresetsPanelToggle`; `closePhoneCard()` goes too.

- [ ] **Step 5: Stack the two phone cards**

In `editor-shell.component.scss`, set the card directly above the dock with an 8px gap, matching `MobileControlBar.swift:38-43`:

```scss
.phone-dock-anchor {
  position: absolute;
  bottom: calc(12px + var(--safe-area-inset-bottom));
  left: 12px;
  right: 12px;
  pointer-events: auto;
}

// Slider panel card, 8px above the dock — MobileControlBar's VStack(spacing: 8).
// 74px is the dock's 54px button row + 2 x 6px padding + the 8px gap.
.phone-card-anchor {
  position: absolute;
  bottom: calc(74px + 12px + var(--safe-area-inset-bottom));
  left: 12px;
  right: 12px;
  pointer-events: auto;
}
```

- [ ] **Step 6: Verify the shell TypeScript shrank**

Run: `wc -l src/web/projects/maple-common/src/lib/shells/editor-shell/editor-shell.component.ts`
Expected: **below 594**. Then run `bash tools/check-budget-headroom.sh origin/main` — expected PASS.

- [ ] **Step 7: Run the full web suite**

Run: `cd src/web && bun x ng test`
Expected: PASS across both projects.

- [ ] **Step 8: Format and commit**

```bash
cd src/web && bun run format
git add src/web/projects/maple-common/src/lib/
git commit -m "feat(web): give the phone editor MobileControlBar's two-card layout"
```

---

## Verification

Component-level checks run in Storybook on port 6006 without the API or the native dylib. Full-shell verification needs the real dev server with a loaded image, because the flyout's anchor geometry and the phone breakpoint only appear in the assembled layout — see the dev-login route with `MAPLE_DEV_AUTH=1`, and register a library before the worker stages run.

Check at desktop width that the flyout is 300px wide, vertically centred, and clears the dock; that all nine dock entries carry a label and the divider sits above Crop; that Color shows the four chips and each swaps the panel body. Check at 375px that both cards stack above the safe-area inset, the dock scrolls horizontally, and no control is clipped.

Confirm before opening the PR: `cd src/web && bun run format:check`, `bash tools/check-file-budget.sh`, and `bash tools/check-budget-headroom.sh origin/main`.

## Out of scope

The Swift Card variant's missing HSL, B&W and Grade route needs its own ticket against the Apple side. `IPhoneLegacyControlBar` is untouched. Masking and healing stay disabled placeholders on both platforms.
