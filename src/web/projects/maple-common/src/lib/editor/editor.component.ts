// editor.component.ts — responsive-program S5a (#625).
//
// Top-level full-screen editor. Composes the 7 regions per spec §2.
// Wires keyboard shortcuts (desktop), hides the bottom tab bar on init,
// flushes pending XMP writes on destroy.

import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  output,
} from '@angular/core';

import { ImageCanvasComponent } from '../components/image-canvas/image-canvas.component';
import { LayoutService } from '../layout-service';
import { LibraryStateService } from '../state/library-state.service';
import { TabBarVisibilityService } from '../shells/tab-bar-visibility.service';

import { DragBarComponent } from './drag-bar.component';
import { EditorHeaderComponent } from './editor-header.component';
import { EditorStateService } from './editor-state.service';
import { GroupTabsComponent } from './group-tabs.component';
import { ToolPillRowComponent } from './tool-pill-row.component';
import { ValueChipComponent } from './value-chip.component';
import { TOOLS_IN_GROUP, type ToolGroup, type ToolId, groupOf } from './tool-model';

@Component({
  selector: 'app-editor',
  standalone: true,
  imports: [
    DragBarComponent,
    EditorHeaderComponent,
    GroupTabsComponent,
    ImageCanvasComponent,
    ToolPillRowComponent,
    ValueChipComponent,
  ],
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditorComponent implements OnInit, OnDestroy {
  protected readonly state = inject(EditorStateService);
  protected readonly library = inject(LibraryStateService);
  protected readonly layout = inject(LayoutService);
  private readonly tabBar = inject(TabBarVisibilityService);

  readonly assetId = input.required<string>();
  readonly filename = input<string>('');
  readonly dismiss = output<void>();
  readonly info = output<void>();
  readonly share = output<void>();

  protected readonly currentFilename = computed(() => this.filename() || this.assetId());

  ngOnInit(): void {
    this.tabBar.hidden.set(true);
    const id = this.assetId();
    this.state.bind(id);
    // Sync LibraryStateService focus so the ImageCanvas (which observes
    // `state.focusedAsset()`) renders the bound asset. `selectAsset` is
    // unconditional — if the id isn't in `assets()` yet (direct URL load
    // without hydration), the canvas falls back to its gradient placeholder
    // until the asset hydrates. Cold-load hydration is editor-shell's job
    // today; mirroring it under /library/editor/:id is a follow-up.
    this.library.selectAsset(id);
  }

  ngOnDestroy(): void {
    this.tabBar.hidden.set(false);
    void this.library.flushPendingXmpWrites();
  }

  @HostListener('window:beforeunload')
  onBeforeUnload(): void {
    void this.library.flushPendingXmpWrites();
  }

  // ── Keyboard shortcuts (desktop only) ────────────────────────────────────
  @HostListener('window:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    if (this.layout.layout() !== 'desktop') return;
    const target = ev.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (target?.isContentEditable) return;

    const meta = ev.metaKey || ev.ctrlKey;

    if (meta && ev.key === 's') {
      ev.preventDefault();
      void this.library.flushPendingXmpWrites();
      return;
    }
    if (meta && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault();
      if (ev.shiftKey) this.state.redo();
      else this.state.undo();
      return;
    }
    if (ev.key === '0') {
      this.state.resetArmedTool();
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.dismiss.emit();
      return;
    }
    if (ev.key === '[' || ev.key === ']') {
      ev.preventDefault();
      this._nudgeTool(ev.key === ']' ? 1 : -1, ev.shiftKey);
    }
  }

  /** Cycle the armed tool within its group; shift cycles the group. */
  private _nudgeTool(direction: 1 | -1, byGroup: boolean): void {
    if (byGroup) {
      const groups: readonly ToolGroup[] = ['light', 'color', 'effects', 'detail'];
      const i = groups.indexOf(this.state.armedGroup());
      const next = groups[(i + direction + groups.length) % groups.length];
      this.state.armGroup(next);
      return;
    }
    const tools: readonly ToolId[] = TOOLS_IN_GROUP[groupOf(this.state.armedTool())];
    const i = tools.indexOf(this.state.armedTool());
    const next = tools[(i + direction + tools.length) % tools.length];
    this.state.armTool(next);
  }
}
