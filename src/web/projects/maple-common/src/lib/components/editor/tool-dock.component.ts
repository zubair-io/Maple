// ToolDockComponent — glass circle-and-label dock, vertical on tablet/desktop,
// horizontal (scrolling) on phone (#1535, phone dock: #1807).
// Nine Apple-parity entries: Light · Color · Effects · Detail · Crop ·
// Tone Curve · Presets · Mask · Heal. Same set in both orientations
// (MobileControlBar.swift:124) — a divider separates the four group buttons
// from the special tools (ToolDock.swift:34).
// Light / Color / Effects / Detail switch the active ToolGroup.
// HSL, B&W and Grade no longer have dock buttons of their own — Apple's dock
// carries none either. They're reached from the group-parameterised sub-tool
// chip row inside the flyout panel instead (`control-card.component.ts`'s
// `SUBTOOLS` map: Colour shows Basic·HSL·B&W, Effects shows Basic·Grade).
// Their modified state still needs to surface somewhere, so it rolls up into
// their owning group's dot (`isModified` below, via `TOOLS_IN_GROUP`).
// Curve opens the tone-curve panel (M2 #1540).
// Crop arms the Crop tool directly (#1813 — canvas-first crop port; reuses
// CropSessionService/CropOverlayComponent/CropToolbarComponent from the S5
// editor, #638).
// Presets opens the presets panel (#1815 — canvas-first presets port; reuses
// PresetsPanelComponent/PresetsService verbatim from the S5 editor, #1115).
// Optics is dropped entirely: Apple has no such button, and Mask/Heal already
// signal that more tools are coming.
// Mask / Heal are visibly disabled with a tooltip + code comment referencing
// the milestone ticket — NOT fake panels (CLAUDE.md #6) — and kept out of the
// accessibility tree entirely (`aria-hidden`, `tabindex="-1"`, no
// `aria-label`), mirroring Apple's `DisabledDockPlaceholder.accessibilityHidden(true)`.

import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import {
  TOOLS_IN_GROUP,
  defaultDisplayValue,
  fieldFor,
  isWired,
  type ToolGroup,
  type ToolId,
} from '../../editor/tool-model';
import { subParamsFor } from '../../editor/tool-sub-param';
import { LibraryStateService } from '../../state/library-state.service';
import {
  defaultGeneratedAdjustmentModel,
  isIdentityCrop,
  type AdjustmentModel,
} from '../../models/adjustment-model';

/** Canonical field defaults, read once so the modified-dot check can't
 *  drift from the generated schema (same rule `tool-model.ts`'s own
 *  `defaultDisplayValue` follows). */
const GENERATED_DEFAULTS = defaultGeneratedAdjustmentModel();

// Not exported: nothing outside this file imports `DockOrientation` (fallow
// dead-code finding) — it's still used internally as the `orientation`
// input's type below.
type DockOrientation = 'vertical' | 'horizontal';

export interface DockEntry {
  id: string;
  /** Icon name in the MapleIcon registry. */
  icon: string;
  /** Tooltip label. */
  label: string;
  /** If set, clicking this entry switches the active group. */
  group?: ToolGroup;
  /** If set, clicking this entry arms this specific tool (rather than the
   *  first tool of a group) — used for stub tools with their own affordance,
   *  e.g. Crop, which is driven by the canvas overlay + crop toolbar rather
   *  than a group's living-slider stack. */
  tool?: ToolId;
  /** If true, entry is shown but non-interactive (coming in a later milestone). */
  disabled?: boolean;
  /** Code comment indicating the milestone ticket for disabled items. */
  ticket?: string;
  /** If true, clicking this entry opens a floating panel rather than switching a group. */
  panel?: boolean;
  /** Draw a horizontal rule above this entry — separates the four group
   *  entries from the special tools (ToolDock.swift:34). */
  divideBefore?: boolean;
}

const DOCK_ENTRIES: DockEntry[] = [
  { id: 'light', icon: 'tool-exposure', label: 'Light', group: 'light' },
  { id: 'color', icon: 'tool-tint', label: 'Color', group: 'color' },
  { id: 'effects', icon: 'tool-vignette', label: 'Effects', group: 'effects' },
  { id: 'detail', icon: 'tool-sharpen', label: 'Detail', group: 'detail' },
  // Divider: groups above, special tools below — mirrors ToolDock.swift:34.
  {
    id: 'crop',
    icon: 'tool-crop',
    label: 'Crop',
    tool: 'crop',
    divideBefore: true,
  },
  { id: 'curve', icon: 'tool-contrast', label: 'Tone Curve', panel: true },
  { id: 'presets', icon: 'tool-presets', label: 'Presets', panel: true },
  // HSL, B&W and Grade are reached from the Colour sub-tool row inside the
  // flyout panel (see control-card.component.ts), not from the dock — Apple's
  // dock carries no button for them either. Optics is dropped: Apple has no
  // such button and Mask/Heal already signal that more tools are coming.
  {
    id: 'mask',
    icon: 'tool-dehaze',
    label: 'Mask',
    disabled: true,
    ticket: '#1541',
  },
  {
    id: 'heal',
    icon: 'tool-texture',
    label: 'Heal',
    disabled: true,
    ticket: '#1472',
  },
];

/** Tools that have their own dock entry (Crop) — a group entry must NOT show
 *  active while one of these is armed, even though the tool lives inside
 *  that group (Crop is in `detail`). */
const DOCK_TOOL_IDS = new Set<ToolId>(
  DOCK_ENTRIES.map((e) => e.tool).filter((t): t is ToolId => t != null),
);

@Component({
  selector: 'pro-tool-dock',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './tool-dock.component.html',
  styleUrl: './tool-dock.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.dock-host--horizontal]': "orientation() === 'horizontal'",
  },
})
export class ToolDockComponent {
  /** Currently active tool group. */
  activeGroup = input.required<ToolGroup>();
  /** Currently armed tool — only consulted for `tool`-entries (e.g. Crop), so
   *  a specific-tool entry highlights only while ITS tool is armed, not
   *  merely while its group is active (Detail must not also show active
   *  while Crop, which lives in the `detail` group, is armed). */
  activeTool = input<ToolId | null>(null);
  /** True when the curve panel is open. */
  curveOpen = input<boolean>(false);
  /** Layout axis: vertical column (tablet/desktop) or horizontal bar (phone). */
  orientation = input<DockOrientation>('vertical');
  /** True when the presets panel is open (#1815). */
  presetsOpen = input<boolean>(false);
  /** Fired when the user taps an enabled group entry. */
  groupChange = output<ToolGroup>();
  /** Fired when the user taps a specific-tool entry (e.g. Crop). */
  toolChange = output<ToolId>();
  /** Fired when user taps the Curve entry (toggle). */
  curvePanelToggle = output<void>();
  /** Fired when user taps the Presets entry (toggle, #1815). */
  presetsPanelToggle = output<void>();

  private libraryState = inject(LibraryStateService);

  /** Adjustment model for the focused asset, or null when none is focused. */
  private readonly currentAdj = computed<AdjustmentModel | null>(() => {
    const id = this.libraryState.focusedAssetId();
    return id ? this.libraryState.adjustmentFor(id)() : null;
  });

  /** The nine dock entries. No longer orientation-dependent: the phone bar
   *  and the desktop column show the same set (MobileControlBar.swift:124).
   *  A plain reference to the module constant, not a computed — nothing it
   *  could recompute from ever changes. */
  readonly entries = DOCK_ENTRIES;

  /** Accent dot: true when any tool this entry covers holds a non-default
   *  value. For a GROUP entry that means every tool in the group — including
   *  HSL, B&W and Grade, which no longer have buttons of their own, so their
   *  modified state has to surface on Color's/Effects' dot. */
  isModified(entry: DockEntry): boolean {
    const adj = this.currentAdj();
    if (!adj || entry.disabled) return false;
    const tools = entry.group
      ? TOOLS_IN_GROUP[entry.group]
      : entry.tool
        ? [entry.tool]
        : ([] as readonly ToolId[]);
    return tools.some((tool) => this.isToolModified(adj, tool));
  }

  /** Whether a single tool's model state differs from default. HSL, bwMix
   *  and colorGrade have no single primary drag-bar field (`fieldFor`
   *  returns null for HSL/bwMix; colorGrade's primary, `splitToneBalance`,
   *  is only ONE of its thirteen fields) — for any tool with sub-params
   *  (`tool-sub-param.ts`), check every sub-param field the chip row can
   *  write, not just the drag-bar's primary. bwMix additionally has the
   *  Black & White toggle itself, which carries no numeric field of its
   *  own (#276) but still counts as "modified" the moment it's On. */
  private isToolModified(adj: AdjustmentModel, tool: ToolId): boolean {
    // Crop is a STUB_TOOLS entry — it rejects drag-bar writes and is edited
    // through the canvas overlay/crop toolbar instead — so the `isWired`
    // guard below would always report it unmodified. It is a genuine
    // non-destructive edit stored in `AdjustmentModel.crop`, so it must be
    // special-cased ahead of that guard (Apple parity: ToolDock.swift:174
    // checks `crop.isIdentity` before its own `isWired` guard).
    if (tool === 'crop') return !isIdentityCrop(adj.crop);
    if (!isWired(tool)) return false;
    const subParams = subParamsFor(tool);
    if (subParams.length > 0) {
      const anySubParamModified = subParams.some((sub) => {
        const v = adj[sub.field] as number;
        const d = GENERATED_DEFAULTS[sub.field] as number;
        return Math.abs(v - d) > 1e-6;
      });
      return tool === 'bwMix'
        ? anySubParamModified || adj.blackWhite !== GENERATED_DEFAULTS.blackWhite
        : anySubParamModified;
    }
    const field = fieldFor(tool);
    if (!field) return false;
    return Math.abs((adj[field] as number) - defaultDisplayValue(tool)) > 1e-6;
  }

  /** Whether a given `panel: true` entry's panel is currently open — keyed
   *  by entry id so a second panel entry (Presets, #1815) doesn't need its
   *  own branch in `isActive`/`onEntryClick`. */
  private panelOpenFor(entry: DockEntry): boolean {
    switch (entry.id) {
      case 'curve':
        return this.curveOpen();
      case 'presets':
        return this.presetsOpen();
      default:
        return false;
    }
  }

  /** Fires the toggle output for a given `panel: true` entry — keyed by
   *  entry id, same as `panelOpenFor` above. Explicit per-id dispatch (not
   *  an `if (id === 'presets') … else …` fallthrough) so a THIRD panel entry
   *  can't silently fire `curvePanelToggle` by omission — an unrecognized
   *  panel id is a no-op rather than a wrong toggle (#1816 review). */
  private firePanelToggle(entry: DockEntry): void {
    switch (entry.id) {
      case 'curve':
        this.curvePanelToggle.emit();
        return;
      case 'presets':
        this.presetsPanelToggle.emit();
        return;
    }
  }

  isActive(entry: DockEntry): boolean {
    if (entry.panel) return this.panelOpenFor(entry);
    if (entry.tool) return entry.tool === this.activeTool();
    const armed = this.activeTool();
    if (armed != null && DOCK_TOOL_IDS.has(armed)) return false;
    return !!entry.group && entry.group === this.activeGroup();
  }

  onEntryClick(entry: DockEntry): void {
    if (entry.disabled) return;
    if (entry.panel) {
      this.firePanelToggle(entry);
      return;
    }
    if (entry.tool) {
      this.toolChange.emit(entry.tool);
      return;
    }
    if (entry.group) {
      this.groupChange.emit(entry.group);
    }
  }
}
